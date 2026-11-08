const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { resolveLocalCodexBin } = require('../../shared/codex-preflight');
const { normalizeAssistantObservation } = require('../../shared/assistant-message-identity');
const { readJsonLines } = require('../../shared/jsonl');
const { structuredScalar, structuredText } = require('../../shared/structured-text');
const { nowIso } = require('../../shared/protocol');
const {
  ThinkingActivityAggregator,
  makeActivityKey,
  truncateActivityText,
} = require('../../shared/thinking-activity');
const {
  buildApiProcessEnvironment,
  describeApiConfig,
  normalizeApiConfig,
} = require('./runtime-utils');
const {
  assertRunBinding,
  classifyNativeThreadError,
  classifyThreadStartError,
  deriveRunBinding,
  modelCapabilitiesFromList,
  normalizeReasoningEffort,
  resumeStrategyForLaunchMode,
  validateModelSelection: validateRuntimeModelSelection,
} = require('./session-api-runtime');
const {
  initializeTimeoutForLaunchMode,
  threadOpenTimeoutForLaunchMode,
} = require('./managed-codex-launch-policy');
const { prepareManagedCodexSessionStore } = require('./managed-codex-session-store');
const { classifyCodexInputCompatibilityError } = require('../../shared/codex-input-errors');

const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_REQUEST_TIMEOUT_MS || 15000);
const LIST_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_LIST_REQUEST_TIMEOUT_MS || 30000);
const TURN_START_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_TURN_START_TIMEOUT_MS || 120000);
const MANAGED_OVERLAY_MARKER_KIND = 'remote-codex-managed-overlay';
const MANAGED_OVERLAY_MARKER_VERSION = 1;
const MANAGED_OVERLAY_MARKER_NAME = '.remote-codex-owner';
const MANAGED_OVERLAY_REMOVE_MAX_RETRIES = 5;
const MANAGED_OVERLAY_REMOVE_RETRY_DELAY_MS = 100;
const MANAGED_OVERLAY_BACKGROUND_RETRY_ATTEMPTS = 3;
const MANAGED_OVERLAY_BACKGROUND_RETRY_DELAY_MS = 500;
const NOTIFICATION_QUEUE_MAX_ITEMS = 256;
const NOTIFICATION_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const NOTIFICATION_QUEUE_MAX_ITEM_BYTES = 64 * 1024;
const NOTIFICATION_QUEUE_TERMINAL_RESERVED_ITEMS = 16;
const NOTIFICATION_QUEUE_TERMINAL_RESERVED_BYTES = 256 * 1024;
const TURN_BUFFER_MAX_BYTES = 512 * 1024;
const TURN_COMPLETION_FALLBACK_GRACE_MS = Math.max(
  25,
  Number(process.env.CODEX_TURN_COMPLETION_FALLBACK_GRACE_MS || 250) || 250
);
const THREAD_IDLE_RECONCILE_GRACE_MS = Math.max(
  500,
  Number(process.env.CODEX_THREAD_IDLE_RECONCILE_GRACE_MS || 3000) || 3000
);
const THREAD_IDLE_PROBE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.CODEX_THREAD_IDLE_PROBE_TIMEOUT_MS || 5000) || 5000
);
const THREAD_IDLE_RETRY_BASE_MS = Math.max(
  1000,
  Number(process.env.CODEX_THREAD_IDLE_RETRY_BASE_MS || 5000) || 5000
);
const THREAD_IDLE_RETRY_MAX_MS = Math.max(
  THREAD_IDLE_RETRY_BASE_MS,
  Number(process.env.CODEX_THREAD_IDLE_RETRY_MAX_MS || 60000) || 60000
);
const SUBMISSION_RECONCILE_DELAY_MS = Math.max(
  100,
  Number(process.env.CODEX_SUBMISSION_RECONCILE_DELAY_MS || 500) || 500
);
const SUBMISSION_RECONCILE_RETRY_MAX_MS = Math.max(
  SUBMISSION_RECONCILE_DELAY_MS,
  Number(process.env.CODEX_SUBMISSION_RECONCILE_RETRY_MAX_MS || 10000) || 10000
);
const NOTIFICATION_TRUNCATION_SUFFIX = '\n...[notification truncated]';
const TURN_BUFFER_TRUNCATION_SUFFIX = '\n...[assistant output truncated]';
const ACTIVITY_COMMAND_MAX_BYTES = 16 * 1024;
const ACTIVITY_OUTPUT_MAX_BYTES = 128 * 1024;
const ACTIVITY_PROGRESS_MAX_BYTES = 64 * 1024;
const ACTIVITY_DIFF_MAX_BYTES = 32 * 1024;
const ACTIVITY_FILE_CHANGES_MAX_BYTES = 128 * 1024;
const ACTIVITY_STRUCTURED_VALUE_MAX_BYTES = 64 * 1024;
const ACTIVITY_STRUCTURED_STRING_MAX_BYTES = 8 * 1024;
const ACTIVITY_MAX_FILE_CHANGES = 128;
const NOTIFICATION_TURN_OWNERSHIP = Symbol('notificationTurnOwnership');
const NOTIFICATION_SUBMISSION_OWNERSHIP = Symbol('notificationSubmissionOwnership');

function normalizedSubmissionInput(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const type = String(item?.type || '').trim();
    if (type === 'text') return { type, text: String(item?.text || '') };
    if (type === 'image') return { type, url: String(item?.url || '') };
    if (type === 'localImage') return { type, path: String(item?.path || '') };
    if (type === 'skill' || type === 'mention') {
      return {
        type,
        name: String(item?.name || ''),
        path: String(item?.path || ''),
      };
    }
    return { type };
  }).filter((item) => item.type);
}

function submissionInputFingerprint(items = []) {
  const normalized = normalizedSubmissionInput(items);
  if (!normalized.length) return null;
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function turnUserInputFingerprint(turn = {}) {
  const itemsView = String(turn?.itemsView || '').trim();
  // A summary/not-loaded Turn can omit the user input.  It is not evidence
  // that this submission created the Turn, even when the id happens to be
  // unique in the current thread snapshot.
  if (itemsView && itemsView !== 'full') return null;
  const userItems = (Array.isArray(turn?.items) ? turn.items : [])
    .filter((item) => String(item?.type || '').trim() === 'userMessage');
  if (!userItems.length) return null;
  return submissionInputFingerprint(userItems.flatMap((item) => (
    Array.isArray(item?.content) ? item.content : []
  )));
}

function turnStartedAtMs(turn = {}) {
  const raw = turn?.startedAt;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uuidV7TimestampMs(value) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .exec(String(value || '').trim());
  if (!match) return null;
  const timestamp = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isAppServerAssistantMessageItem(item = {}) {
  const type = String(item.type || '').replace(/[-_\s]/g, '').toLowerCase();
  const role = String(item.role || '').trim().toLowerCase();
  return ['agentmessage', 'assistantmessage'].includes(type)
    || (type === 'message' && ['agent', 'assistant'].includes(role));
}

function appServerAssistantMessageText(item = {}, fallback = '') {
  const direct = structuredText(item.text ?? item.message).trim();
  if (direct) return direct;
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content.map((part) => structuredText(part)).filter(Boolean);
  return (parts.join('\n') || structuredText(fallback)).trim();
}

function normalizedStatusType(value) {
  return structuredScalar(value, '').trim();
}

function forceKillChildProcessTree(child) {
  if (!child) return false;
  if (process.platform === 'win32' && child.pid && child.spawnfile) {
    try {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
      killer.unref?.();
    } catch {
      // The direct SIGKILL request below remains the fallback.
    }
  }
  try {
    child.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function truncateUtf8(value, maxBytes, suffix = '') {
  const text = structuredText(value);
  const byteLimit = Math.max(0, Number(maxBytes) || 0);
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return text;
  const suffixText = String(suffix || '');
  const suffixBytes = Math.min(Buffer.byteLength(suffixText, 'utf8'), byteLimit);
  const budget = Math.max(0, byteLimit - suffixBytes);
  const encoded = Buffer.from(text, 'utf8');
  let end = Math.min(encoded.length, budget);
  while (end > 0 && (encoded[end] & 0b11000000) === 0b10000000) end -= 1;
  return `${encoded.subarray(0, end).toString('utf8')}${truncateUtf8Suffix(suffixText, suffixBytes)}`;
}

function truncateUtf8Suffix(value, maxBytes) {
  const encoded = Buffer.from(String(value || ''), 'utf8');
  if (encoded.length <= maxBytes) return encoded.toString('utf8');
  let end = Math.min(encoded.length, Math.max(0, maxBytes));
  while (end > 0 && (encoded[end] & 0b11000000) === 0b10000000) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

function notificationSerializedBytes(message) {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function compactCodexErrorControl(errorInfo) {
  if (!errorInfo) return null;
  if (typeof errorInfo === 'string') return truncateUtf8(errorInfo, 256, NOTIFICATION_TRUNCATION_SUFFIX);
  if (typeof errorInfo !== 'object') return truncateUtf8(String(errorInfo), 128);
  const knownKeys = [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
    'activeTurnNotSteerable',
  ];
  for (const key of knownKeys) {
    if (!errorInfo[key]) continue;
    const detail = errorInfo[key];
    if (!detail || typeof detail !== 'object') return { [key]: true };
    return {
      [key]: {
        ...(detail.httpStatusCode != null
          ? {
            httpStatusCode: typeof detail.httpStatusCode === 'number'
              ? detail.httpStatusCode
              : truncateUtf8(detail.httpStatusCode, 32),
          }
          : {}),
        ...(detail.turnKind != null ? { turnKind: truncateUtf8(detail.turnKind, 128) } : {}),
      },
    };
  }
  return truncateUtf8(summarizeValue(errorInfo), 256, NOTIFICATION_TRUNCATION_SUFFIX);
}

function compactErrorNotification(params, identity, maxBytes) {
  const originalMessage = String(params.error?.message || 'codex error');
  const compact = {
    method: 'error',
    params: {
      threadId: truncateUtf8(identity.threadId || '', 256),
      turnId: truncateUtf8(identity.turnId || '', 256),
      willRetry: params.willRetry === true,
      error: {
        message: '',
        codexErrorInfo: compactCodexErrorControl(params.error?.codexErrorInfo || params.error?.codexError),
        ...(params.error?.codexError != null
          ? { codexError: truncateUtf8(summarizeValue(params.error.codexError), 128) }
          : {}),
        truncated: true,
      },
    },
  };
  const emptyBytes = notificationSerializedBytes(compact);
  let messageBudget = Math.max(64, maxBytes - emptyBytes - 16);
  compact.params.error.message = truncateUtf8(
    originalMessage,
    messageBudget,
    NOTIFICATION_TRUNCATION_SUFFIX
  );
  while (notificationSerializedBytes(compact) > maxBytes && messageBudget > 64) {
    messageBudget = Math.max(64, Math.floor(messageBudget / 2));
    compact.params.error.message = truncateUtf8(
      originalMessage,
      messageBudget,
      NOTIFICATION_TRUNCATION_SUFFIX
    );
  }
  if (notificationSerializedBytes(compact) > maxBytes) {
    compact.params.error.message = truncateUtf8(originalMessage, 64);
  }
  return compact;
}

function compactOversizedNotification(message, maxBytes) {
  const method = String(message?.method || 'notification');
  const params = message?.params && typeof message.params === 'object' ? message.params : {};
  const identity = {
    threadId: params.threadId || params.thread?.id || null,
    turnId: params.turnId || params.turn?.id || null,
    itemId: params.itemId || params.item?.id || null,
    summaryIndex: params.summaryIndex ?? null,
    processId: params.processId || null,
    processHandle: params.processHandle || null,
  };
  const textBudget = Math.max(1024, maxBytes - 4096);
  let compactParams;

  if (method === 'thread/started') {
    compactParams = { thread: { id: identity.threadId } };
  } else if (method === 'thread/status/changed') {
    compactParams = {
      threadId: identity.threadId,
      status: {
        type: params.status?.type || null,
        activeFlags: Array.isArray(params.status?.activeFlags)
          ? params.status.activeFlags.slice(0, 32).map((value) => truncateUtf8(value, 256))
          : [],
        truncated: true,
      },
    };
  } else if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
    compactParams = {
      threadId: identity.threadId,
      goal: method.endsWith('/cleared') ? null : {
        status: params.goal?.status || null,
        objective: truncateUtf8(params.goal?.objective || '', textBudget, NOTIFICATION_TRUNCATION_SUFFIX),
        truncated: true,
      },
    };
  } else if (method === 'turn/started' || method === 'turn/completed') {
    compactParams = {
      threadId: identity.threadId,
      turnId: identity.turnId,
      turn: {
        id: identity.turnId,
        status: params.turn?.status || null,
        truncated: true,
      },
    };
  } else if (method === 'item/started' || method === 'item/completed') {
    compactParams = {
      threadId: identity.threadId,
      turnId: identity.turnId,
      itemId: identity.itemId,
      startedAtMs: params.startedAtMs ?? null,
      completedAtMs: params.completedAtMs ?? null,
      item: compactAppServerThreadItem(params.item, textBudget),
    };
  } else if (method === 'item/agentMessage/delta') {
    compactParams = {
      ...identity,
      phase: params.phase || params.item?.phase || null,
      delta: truncateUtf8(params.delta || '', textBudget, NOTIFICATION_TRUNCATION_SUFFIX),
    };
  } else if (method === 'item/reasoning/summaryTextDelta') {
    compactParams = {
      ...identity,
      delta: truncateUtf8(params.delta || '', textBudget, NOTIFICATION_TRUNCATION_SUFFIX),
    };
  } else if (method === 'item/plan/delta' || method === 'turn/plan/updated') {
    compactParams = {
      ...identity,
      delta: truncateUtf8(params.delta || '', Math.floor(textBudget / 2), NOTIFICATION_TRUNCATION_SUFFIX),
      plan: truncateUtf8(params.plan || '', Math.floor(textBudget / 2), NOTIFICATION_TRUNCATION_SUFFIX),
    };
  } else if (
    method === 'item/commandExecution/outputDelta'
    || method === 'process/outputDelta'
    || method === 'command/exec/outputDelta'
  ) {
    compactParams = {
      ...identity,
      stream: params.stream || null,
      capReached: typeof params.capReached === 'boolean' ? params.capReached : null,
      truncated: typeof params.truncated === 'boolean' ? params.truncated : null,
      delta: truncateUtf8(params.delta || '', Math.floor(textBudget / 2), NOTIFICATION_TRUNCATION_SUFFIX),
      deltaBase64: truncateUtf8(params.deltaBase64 || '', Math.floor(textBudget / 2), NOTIFICATION_TRUNCATION_SUFFIX),
    };
  } else if (method === 'item/fileChange/patchUpdated') {
    compactParams = {
      ...identity,
      changes: normalizeAppServerFileChanges(
        params.changes || params.fileChanges || params.file_changes,
        textBudget
      ),
    };
  } else if (method === 'item/mcpToolCall/progress') {
    compactParams = {
      ...identity,
      callId: params.callId || null,
      requestId: params.requestId || null,
      message: truncateUtf8(params.message || '', textBudget, NOTIFICATION_TRUNCATION_SUFFIX),
    };
  } else if (method === 'warning') {
    compactParams = {
      message: truncateUtf8(params.message || '', textBudget, NOTIFICATION_TRUNCATION_SUFFIX),
      truncated: true,
    };
  } else if (method === 'error') {
    compactParams = {
      threadId: identity.threadId,
      turnId: identity.turnId,
      willRetry: Boolean(params.willRetry),
      error: {
        message: truncateUtf8(params.error?.message || '', Math.floor(textBudget / 2), NOTIFICATION_TRUNCATION_SUFFIX),
        additionalDetails: truncateUtf8(
          params.error?.additionalDetails || '',
          Math.floor(textBudget / 2),
          NOTIFICATION_TRUNCATION_SUFFIX
        ),
        codexErrorInfo: compactCodexErrorControl(params.error?.codexErrorInfo || params.error?.codexError),
        truncated: true,
      },
    };
  } else if (method === 'thread/tokenUsage/updated') {
    compactParams = {
      threadId: identity.threadId,
      tokenUsage: { total: params.tokenUsage?.total || null, truncated: true },
    };
  } else if (method === 'account/rateLimits/updated') {
    compactParams = {
      accountId: params.accountId || null,
      rateLimits: {
        rateLimitReachedType: params.rateLimits?.rateLimitReachedType || null,
        truncated: true,
      },
    };
  } else {
    compactParams = {
      ...identity,
      truncated: true,
      summary: truncateUtf8(summarizeValue(params), textBudget, NOTIFICATION_TRUNCATION_SUFFIX),
    };
  }

  let compact = { method, params: compactParams };
  if (notificationSerializedBytes(compact) > maxBytes) {
    compact = method === 'error'
      ? compactErrorNotification(params, identity, maxBytes)
      : {
        method,
        params: {
          ...identity,
          truncated: true,
          summary: truncateUtf8(summarizeValue(compactParams), Math.max(0, maxBytes - 2048)),
        },
      };
  }
  return compact;
}

function retryableTerminalDeliveryError(error) {
  const result = error instanceof Error
    ? error
    : new Error(String(error || 'Session terminal state delivery failed.'));
  result.retryCommand = true;
  result.terminalDeliveryFailure = true;
  return result;
}

function errorWithoutSuppressedTerminalDelivery(error, suppressDelivery) {
  if (!error || !suppressDelivery) return error;
  if (error.terminalDeliveryFailure === true) return null;
  if (!(error instanceof AggregateError) || !Array.isArray(error.errors)) return error;
  const remaining = error.errors
    .map((nested) => errorWithoutSuppressedTerminalDelivery(nested, true))
    .filter(Boolean);
  if (!remaining.length) return null;
  if (remaining.length === 1) return remaining[0];
  const aggregate = new AggregateError(remaining, error.message);
  if (remaining.some((nested) => nested?.retryCommand === true)) aggregate.retryCommand = true;
  if (remaining.some((nested) => nested?.processTreeFallbackRequired === true)) {
    aggregate.processTreeFallbackRequired = true;
  }
  return aggregate;
}

function throwTerminalErrors(errors, message) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const aggregate = new AggregateError(errors, message);
    if (errors.some((error) => error?.retryCommand === true)) aggregate.retryCommand = true;
    if (errors.some((error) => error?.processTreeFallbackRequired === true)) {
      aggregate.processTreeFallbackRequired = true;
    }
    throw aggregate;
  }
}

function stripAnsi(value) {
  return structuredText(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function countTextLines(value) {
  const text = structuredText(value);
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).filter((line, index, lines) => line || index < lines.length - 1).length;
}

function countDiffLines(diffText) {
  let additions = 0;
  let deletions = 0;
  for (const line of structuredText(diffText).split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function normalizeAppServerFileChangeStatus(value) {
  const text = structuredScalar(value, '').toLowerCase();
  if (text === 'add') {
    return 'added';
  }
  if (text === 'delete') {
    return 'deleted';
  }
  if (text === 'update') {
    return 'modified';
  }
  return text || 'modified';
}

function normalizeAppServerFileChanges(fileChanges, maxBytes = ACTIVITY_FILE_CHANGES_MAX_BYTES) {
  if (!fileChanges || typeof fileChanges !== 'object') {
    return [];
  }
  const entries = Array.isArray(fileChanges)
    ? fileChanges.map((change, index) => [
      structuredText(change?.path ?? change?.file) || String(index),
      change,
    ])
    : Object.entries(fileChanges);
  const normalized = entries
    .slice(0, ACTIVITY_MAX_FILE_CHANGES)
    .map(([pathValue, change]) => {
      if (!change || typeof change !== 'object') {
        return null;
      }
      const rawKind = change.kind ?? change.type ?? change.status;
      const status = normalizeAppServerFileChangeStatus(rawKind);
      const diff = truncateUtf8(
        structuredText(change.unified_diff ?? change.unifiedDiff ?? change.diff ?? change.patch).trim(),
        ACTIVITY_DIFF_MAX_BYTES,
        NOTIFICATION_TRUNCATION_SUFFIX
      );
      const diffCounts = countDiffLines(diff);
      const contentLines = countTextLines(structuredText(change.content));
      return {
        path: truncateUtf8(
          structuredText(
            change.path
              ?? change.file
              ?? change.file_path
              ?? pathValue
              ?? 'workspace change'
          ),
          4096,
          NOTIFICATION_TRUNCATION_SUFFIX
        ),
        status,
        kind: truncateUtf8(structuredScalar(rawKind, status), 64),
        additions: status === 'added' && !diff ? contentLines : diff ? diffCounts.additions : null,
        deletions: status === 'deleted' && !diff ? contentLines : diff ? diffCounts.deletions : null,
        diff,
        movePath: change.movePath != null || change.move_path != null
          ? truncateUtf8(structuredText(change.movePath ?? change.move_path), 4096, NOTIFICATION_TRUNCATION_SUFFIX)
          : null,
      };
    })
    .filter(Boolean);
  const result = [];
  let bytes = 2;
  for (const change of normalized) {
    const changeBytes = notificationSerializedBytes(change) + (result.length ? 1 : 0);
    if (bytes + changeBytes > Math.max(1024, Number(maxBytes) || ACTIVITY_FILE_CHANGES_MAX_BYTES)) break;
    result.push(change);
    bytes += changeBytes;
  }
  return result;
}

function sanitizeActivityValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return truncateUtf8(value, ACTIVITY_STRUCTURED_STRING_MAX_BYTES, NOTIFICATION_TRUNCATION_SUFFIX);
  }
  if (depth >= 6) {
    return truncateUtf8(summarizeValue(value), 1024, NOTIFICATION_TRUNCATION_SUFFIX);
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const result = value.slice(0, 64).map((entry) => sanitizeActivityValue(entry, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(value)
      .slice(0, 64)
      .map(([key, entry]) => [
        truncateUtf8(key, 256, NOTIFICATION_TRUNCATION_SUFFIX),
        sanitizeActivityValue(entry, depth + 1, seen),
      ]));
    seen.delete(value);
    return result;
  }
  return truncateUtf8(String(value), 1024, NOTIFICATION_TRUNCATION_SUFFIX);
}

function boundedActivityValue(value, maxBytes = ACTIVITY_STRUCTURED_VALUE_MAX_BYTES) {
  if (value == null) return null;
  const sanitized = sanitizeActivityValue(value);
  if (notificationSerializedBytes(sanitized) <= maxBytes) return sanitized;
  return {
    truncated: true,
    summary: truncateUtf8(
      summarizeValue(value),
      Math.max(256, maxBytes - 128),
      NOTIFICATION_TRUNCATION_SUFFIX
    ),
  };
}

function boundedActivityNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function activityKindForItemType(itemType) {
  return ({
    commandExecution: 'command',
    fileChange: 'file-change',
    mcpToolCall: 'mcp-tool',
    dynamicToolCall: 'tool-call',
    collabAgentToolCall: 'collaboration',
    subAgentActivity: 'collaboration',
    webSearch: 'web-search',
    imageView: 'image',
    imageGeneration: 'image-generation',
    plan: 'plan',
    contextCompaction: 'context',
    enteredReviewMode: 'review',
    exitedReviewMode: 'review',
  })[itemType] || null;
}

function normalizeAppServerActivityItem(item, params = {}, lifecycle = 'progress') {
  if (!item || typeof item !== 'object') return null;
  const itemType = structuredScalar(item.type, '').trim();
  const kind = activityKindForItemType(itemType);
  if (!kind) return null;
  const itemId = structuredScalar(item.id ?? params.itemId, '').trim();
  const turnId = structuredScalar(params.turnId, '').trim();
  if (!itemId || !turnId) return null;
  const toolLike = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch']
    .includes(itemType);
  const status = structuredScalar(item.status ?? (itemType === 'subAgentActivity'
    ? item.kind ?? (lifecycle === 'completed' ? 'completed' : 'inProgress')
    : (lifecycle === 'completed' ? 'completed' : 'inProgress')), lifecycle === 'completed' ? 'completed' : 'inProgress');
  const identity = {
    turnId,
    itemId,
    summaryIndex: 0,
    kind,
    itemType,
    method: lifecycle === 'completed' ? 'item/completed' : 'item/started',
    callId: structuredScalar(item.callId ?? item.call_id ?? params.callId ?? (toolLike ? itemId : ''), '').trim() || null,
    status,
  };
  const requestId = structuredScalar(item.requestId ?? item.request_id ?? params.requestId, '').trim();
  if (requestId) identity.requestId = requestId;
  if (item.truncated === true || item.textTruncated === true) {
    identity.textTruncated = true;
  }
  if (params.startedAtMs != null) identity.startedAtMs = boundedActivityNumber(params.startedAtMs);
  if (params.completedAtMs != null) identity.completedAtMs = boundedActivityNumber(params.completedAtMs);
  if (item.durationMs != null || item.duration_ms != null) {
    identity.durationMs = boundedActivityNumber(item.durationMs ?? item.duration_ms);
  }
  let text = '';

  if (itemType === 'commandExecution') {
    const command = truncateUtf8(structuredText(item.command), ACTIVITY_COMMAND_MAX_BYTES, NOTIFICATION_TRUNCATION_SUFFIX);
    const outputValue = item.aggregatedOutput ?? item.output;
    const output = truncateUtf8(structuredText(outputValue), ACTIVITY_OUTPUT_MAX_BYTES, NOTIFICATION_TRUNCATION_SUFFIX);
    Object.assign(identity, {
      command,
      cwd: truncateUtf8(structuredText(item.cwd), 4096, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      source: structuredScalar(item.source, '').trim() || null,
      ...(lifecycle === 'completed' ? { stream: null } : {}),
      commandActions: boundedActivityValue(item.commandActions || item.command_actions || []),
    });
    const processId = structuredScalar(item.processId ?? item.process_id, '').trim();
    if (processId) identity.processId = processId;
    if (item.aggregatedOutput != null || item.output != null) {
      identity.output = output;
      identity.outputTruncated = item.truncated === true
        || item.outputTruncated === true
        || Buffer.byteLength(structuredText(outputValue), 'utf8') > ACTIVITY_OUTPUT_MAX_BYTES;
    }
    if (item.exitCode != null || item.exit_code != null) {
      identity.exitCode = boundedActivityNumber(item.exitCode ?? item.exit_code);
    }
    text = command || 'Command execution';
  } else if (itemType === 'fileChange') {
    const fileChanges = normalizeAppServerFileChanges(item.changes || item.fileChanges || item.file_changes);
    if (item.changes != null || item.fileChanges != null || item.file_changes != null) {
      Object.assign(identity, { fileChanges, changes: fileChanges });
    }
    text = fileChanges.length
      ? `${status === 'inProgress' ? 'Updating' : 'Updated'} ${fileChanges.length} file(s)`
      : 'File change';
  } else if (itemType === 'mcpToolCall') {
    Object.assign(identity, {
      server: truncateUtf8(structuredText(item.server), 512, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      tool: truncateUtf8(structuredText(item.tool), 512, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      arguments: boundedActivityValue(item.arguments),
      resourceUri: truncateUtf8(structuredText(item.mcpAppResourceUri), 4096, NOTIFICATION_TRUNCATION_SUFFIX) || null,
    });
    if (item.result != null) identity.result = boundedActivityValue(item.result);
    if (item.error != null) identity.error = boundedActivityValue(item.error, 16 * 1024);
    text = structuredText(identity.error?.message) || `${identity.server || 'MCP'} / ${identity.tool || 'tool'}`;
  } else if (itemType === 'dynamicToolCall') {
    Object.assign(identity, {
      namespace: truncateUtf8(structuredText(item.namespace), 512, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      tool: truncateUtf8(structuredText(item.tool), 512, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      arguments: boundedActivityValue(item.arguments),
      result: boundedActivityValue(item.contentItems || item.content_items),
      success: typeof item.success === 'boolean' ? item.success : null,
    });
    text = `${identity.namespace ? `${identity.namespace} / ` : ''}${identity.tool || 'Dynamic tool'}`;
  } else if (itemType === 'collabAgentToolCall') {
    Object.assign(identity, {
      tool: boundedActivityValue(item.tool, 8 * 1024),
      senderThreadId: structuredScalar(item.senderThreadId, '').trim() || null,
      receiverThreadIds: boundedActivityValue(item.receiverThreadIds || []),
      prompt: truncateUtf8(structuredText(item.prompt), ACTIVITY_PROGRESS_MAX_BYTES, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      agentsStates: boundedActivityValue(item.agentsStates || {}),
      model: truncateUtf8(structuredText(item.model), 512, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      reasoningEffort: truncateUtf8(structuredText(item.reasoningEffort ?? item.reasoning_effort), 128, NOTIFICATION_TRUNCATION_SUFFIX) || null,
    });
    text = structuredText(item.tool) || 'Collaboration';
  } else if (itemType === 'subAgentActivity') {
    const agentThreadId = structuredScalar(item.agentThreadId ?? item.agent_thread_id, '').trim() || null;
    const agentPath = truncateUtf8(
      structuredText(item.agentPath ?? item.agent_path),
      4096,
      NOTIFICATION_TRUNCATION_SUFFIX
    ) || null;
    const agentNickname = truncateUtf8(
      structuredText(item.agentNickname ?? item.agent_nickname),
      512,
      NOTIFICATION_TRUNCATION_SUFFIX
    ) || null;
    const agentRole = truncateUtf8(
      structuredText(item.agentRole ?? item.agent_role),
      512,
      NOTIFICATION_TRUNCATION_SUFFIX
    ) || null;
    const parentThreadId = structuredScalar(
      item.parentThreadId ?? item.parent_thread_id ?? params.threadId,
      ''
    ).trim() || null;
    const subagentKind = truncateUtf8(
      item.kind ?? item.status ?? lifecycle,
      128,
      NOTIFICATION_TRUNCATION_SUFFIX
    );
    Object.assign(identity, {
      agentThreadId,
      agentPath,
      agentNickname,
      agentRole,
      parentThreadId,
      subagentKind,
      senderThreadId: parentThreadId,
      receiverThreadIds: agentThreadId ? [agentThreadId] : [],
      tool: 'Sub-agent',
      agentsStates: {
        status: subagentKind,
        agentThreadId,
        agentPath,
        agentNickname,
        agentRole,
      },
    });
    const label = agentPath || agentNickname || agentThreadId || 'sub-agent';
    text = `Sub-agent ${label}: ${subagentKind}`;
  } else if (itemType === 'webSearch') {
    Object.assign(identity, {
      query: truncateUtf8(structuredText(item.query), ACTIVITY_PROGRESS_MAX_BYTES, NOTIFICATION_TRUNCATION_SUFFIX),
      action: truncateUtf8(
        structuredScalar(item.action, ''),
        4096,
        NOTIFICATION_TRUNCATION_SUFFIX
      ) || null,
      actionData: boundedActivityValue(item.action, 16 * 1024),
    });
    text = identity.query || 'Web search';
  } else if (itemType === 'plan') {
    text = truncateUtf8(structuredText(item.text), ACTIVITY_PROGRESS_MAX_BYTES, NOTIFICATION_TRUNCATION_SUFFIX) || 'Plan';
  } else {
    Object.assign(identity, {
      path: truncateUtf8(structuredText(item.path ?? item.savedPath), 4096, NOTIFICATION_TRUNCATION_SUFFIX) || null,
      result: boundedActivityValue(item.result),
      review: truncateUtf8(structuredText(item.review), ACTIVITY_PROGRESS_MAX_BYTES, NOTIFICATION_TRUNCATION_SUFFIX) || null,
    });
    text = identity.path || identity.review || itemType;
  }

  return { identity, text };
}

function compactAppServerThreadItem(item, maxBytes) {
  if (!item || typeof item !== 'object') return null;
  const itemType = structuredScalar(item.type, '').trim();
  const fieldBudget = Math.max(256, Math.floor(Math.max(1024, maxBytes) / 4));
  const compact = {
    id: truncateUtf8(structuredScalar(item.id, ''), 512, NOTIFICATION_TRUNCATION_SUFFIX),
    type: itemType || null,
    status: structuredScalar(item.status, '') || null,
    durationMs: boundedActivityNumber(item.durationMs ?? item.duration_ms),
    truncated: true,
  };
  if (itemType === 'reasoning') {
    const summaries = Array.isArray(item.summary) ? item.summary : [];
    const perSummaryBudget = Math.max(256, Math.floor(maxBytes / Math.max(1, Math.min(16, summaries.length))));
    return {
      ...compact,
      summary: summaries.slice(0, 16).map((value) => truncateUtf8(
        persistedReasoningSummaryText(value),
        perSummaryBudget,
        NOTIFICATION_TRUNCATION_SUFFIX
      )),
      content: [],
    };
  }
  if (itemType === 'commandExecution') {
    return {
      ...compact,
      command: truncateUtf8(structuredText(item.command), Math.min(fieldBudget, ACTIVITY_COMMAND_MAX_BYTES), NOTIFICATION_TRUNCATION_SUFFIX),
      cwd: truncateUtf8(structuredText(item.cwd), 4096, NOTIFICATION_TRUNCATION_SUFFIX),
      processId: structuredScalar(item.processId ?? item.process_id, '') || null,
      source: structuredScalar(item.source, '') || null,
      commandActions: boundedActivityValue(item.commandActions || item.command_actions || [], fieldBudget),
      aggregatedOutput: truncateUtf8(
        structuredText(item.aggregatedOutput ?? item.output),
        Math.min(fieldBudget, ACTIVITY_OUTPUT_MAX_BYTES),
        NOTIFICATION_TRUNCATION_SUFFIX
      ),
      exitCode: boundedActivityNumber(item.exitCode ?? item.exit_code),
    };
  }
  if (itemType === 'fileChange') {
    return {
      ...compact,
      changes: normalizeAppServerFileChanges(
        item.changes || item.fileChanges || item.file_changes,
        fieldBudget
      ),
    };
  }
  if (itemType === 'mcpToolCall') {
    return {
      ...compact,
      server: truncateUtf8(structuredText(item.server), 512, NOTIFICATION_TRUNCATION_SUFFIX),
      tool: truncateUtf8(structuredText(item.tool), 512, NOTIFICATION_TRUNCATION_SUFFIX),
      arguments: boundedActivityValue(item.arguments, fieldBudget),
      result: boundedActivityValue(item.result, fieldBudget),
      error: boundedActivityValue(item.error, Math.min(fieldBudget, 16 * 1024)),
      mcpAppResourceUri: truncateUtf8(structuredText(item.mcpAppResourceUri), 4096, NOTIFICATION_TRUNCATION_SUFFIX),
    };
  }
  if (itemType === 'dynamicToolCall') {
    return {
      ...compact,
      namespace: truncateUtf8(structuredText(item.namespace), 512, NOTIFICATION_TRUNCATION_SUFFIX),
      tool: truncateUtf8(structuredText(item.tool), 512, NOTIFICATION_TRUNCATION_SUFFIX),
      arguments: boundedActivityValue(item.arguments, fieldBudget),
      contentItems: boundedActivityValue(item.contentItems || item.content_items, fieldBudget),
      success: typeof item.success === 'boolean' ? item.success : null,
    };
  }
  if (itemType === 'webSearch') {
    return {
      ...compact,
      query: truncateUtf8(structuredText(item.query), Math.min(fieldBudget, ACTIVITY_PROGRESS_MAX_BYTES), NOTIFICATION_TRUNCATION_SUFFIX),
      action: boundedActivityValue(item.action, fieldBudget),
    };
  }
  return {
    ...compact,
    summary: truncateUtf8(summarizeValue(item), Math.max(256, maxBytes - 1024), NOTIFICATION_TRUNCATION_SUFFIX),
  };
}

function shouldSurfaceStderrLine(text) {
  if (!text) {
    return false;
  }

  if (/^Updating files:\s+\d+%/.test(text)) {
    return false;
  }

  if (/^\s*</.test(text)) {
    return false;
  }

  if (/^\s*[A-Za-z0-9_-]+\s*=/.test(text)) {
    return false;
  }

  if (/^\s*[/>]\s*$/.test(text)) {
    return false;
  }

  if (/\bWARN\s+codex_core::shell_snapshot\b/.test(text) && /PowerShell|snapshot not supported/i.test(text)) {
    return false;
  }

  if (/\bWARN\s+codex_core_plugins::/.test(text)
    && /(remote plugin|plugin bundle|featured plugin|chatgpt authentication|Unauthorized|api key auth is not supported)/i.test(text)) {
    return false;
  }

  if (/^error: unable to write file plugins\//.test(text)) {
    return false;
  }

  if (/^fatal: cannot create directory at 'plugins\//.test(text)) {
    return false;
  }

  if (/^warning: Clone succeeded, but checkout failed\./.test(text)) {
    return false;
  }

  if (/^You can inspect what was checked out/.test(text)) {
    return false;
  }

  if (/^and retry with /.test(text)) {
    return false;
  }

  return true;
}

function isRuntimeDiagnosticStderrLine(text) {
  return /Codex could not find bubblewrap on PATH/i.test(text)
    || /sandbox prerequisites/i.test(text)
    || /concepts\/sandboxing#prerequisites/i.test(text);
}

function classifyCodexStateDatabaseStderr(value) {
  const text = stripAnsi(value).trim();
  if (!text) return null;

  const corruption = /\bSQLITE_(?:CORRUPT|NOTADB)\b/i.test(text)
    || /file is not a database/i.test(text)
    || /database disk image is malformed/i.test(text)
    || /malformed database schema/i.test(text)
    || /database (?:is |appears )?(?:corrupt|corrupted|malformed)/i.test(text)
    || /(?:corrupt|corrupted|malformed) (?:sqlite )?database/i.test(text);
  if (corruption) {
    return { kind: 'corruption', quarantine: true };
  }

  const hasDatabaseContext = /sqlite|database(?: file)?|state_\d+\.sqlite/i.test(text);
  if (!hasDatabaseContext) return null;

  const pathTooLong = /ENAMETOOLONG|path too long|filename or extension is too long/i.test(text);
  if (pathTooLong) {
    return { kind: 'path-too-long', quarantine: false };
  }

  const unavailable = /\bSQLITE_CANTOPEN\b/i.test(text)
    || /\(code:\s*14\)/i.test(text)
    || /unable to open database file/i.test(text)
    || /(?:failed|unable|cannot|can't) to (?:open|create).*(?:sqlite|database)/i.test(text)
    || /(?:sqlite|database).*(?:failed|unable|cannot|can't) to (?:open|create)/i.test(text)
    || /permission denied|access (?:is )?denied|read-only database|readonly database/i.test(text);
  if (unavailable) {
    return { kind: 'open-create', quarantine: false };
  }

  if (
    /codex_app_server: failed to initialize sqlite state db/i.test(text)
    || /failed to initialize sqlite state runtime/i.test(text)
    || /failed to initialize.*sqlite/i.test(text)
  ) {
    return { kind: 'initialization', quarantine: false };
  }
  return null;
}

function codexStateDatabaseHint(classification, text, codexHome = null) {
  const location = codexHome
    ? ` CODEX_HOME: ${limitText(codexHome, 360)}.`
    : '';
  const raw = ` Raw stderr: ${limitText(text, 1200)}`;
  if (classification?.kind === 'corruption') {
    return [
      'Codex reported that its SQLite state is corrupted or is not a database.',
      'Only the affected state_*.sqlite files may be moved aside automatically; the whole CODEX_HOME is not removed.',
      location,
      raw,
    ].join(' ').replace(/\s+/g, ' ').trim();
  }
  if (classification?.kind === 'path-too-long') {
    return [
      'Codex could not create or open its SQLite state because the filesystem path is too long.',
      'Shorten CODEX_HOME or the managed overlay path; existing SQLite files were left untouched.',
      location,
      raw,
    ].join(' ').replace(/\s+/g, ' ').trim();
  }
  if (classification?.kind === 'open-create') {
    return [
      'Codex could not create or open its SQLite state. This is not evidence that the database is corrupted.',
      'Check the CODEX_HOME path length, directory existence, write permissions, and file locks; existing SQLite files were left untouched.',
      location,
      raw,
    ].join(' ').replace(/\s+/g, ' ').trim();
  }
  return [
    'Codex reported a SQLite initialization failure, but stderr did not establish database corruption.',
    'Existing SQLite files were left untouched; inspect the raw error before retrying.',
    location,
    raw,
  ].join(' ').replace(/\s+/g, ' ').trim();
}

function buildCodexStateDatabaseDiagnostic(value, codexHome = null) {
  const text = stripAnsi(value).trim();
  const classification = classifyCodexStateDatabaseStderr(text);
  if (!classification) return null;
  const messages = {
    corruption: 'Codex reported corrupted SQLite state.',
    'path-too-long': 'Codex SQLite state path is too long.',
    'open-create': 'Codex could not open or create SQLite state.',
    initialization: 'Codex could not initialize SQLite state.',
  };
  return {
    classification: classification.kind,
    quarantine: classification.quarantine,
    message: messages[classification.kind] || 'Codex SQLite state initialization failed.',
    detail: codexStateDatabaseHint(classification, text, codexHome),
    data: {
      classification: classification.kind,
      quarantine: classification.quarantine,
      codexHome,
      rawStderr: limitText(text, 1200),
    },
  };
}

function preferCodexStateDatabaseDiagnostic(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  const priorities = {
    initialization: 1,
    'open-create': 2,
    'path-too-long': 3,
    corruption: 4,
  };
  return (priorities[candidate.classification] || 0) >= (priorities[current.classification] || 0)
    ? candidate
    : current;
}

function codexStateDatabaseStartupError(error, diagnostic) {
  if (!diagnostic) return error;
  const codes = {
    corruption: 'session_sqlite_corrupt',
    'path-too-long': 'session_sqlite_path_too_long',
    'open-create': 'session_sqlite_open_failed',
    initialization: 'session_sqlite_initialization_failed',
  };
  const failure = new Error(`${diagnostic.message} ${diagnostic.detail}`);
  failure.code = codes[diagnostic.classification] || 'session_sqlite_initialization_failed';
  failure.cause = error;
  failure.sqliteFailureKind = diagnostic.classification;
  failure.rawStderr = diagnostic.data?.rawStderr || null;
  for (const property of ['failureState', 'retryCommand', 'processTreeFallbackRequired']) {
    if (Object.prototype.hasOwnProperty.call(error || {}, property)) {
      failure[property] = error[property];
    }
  }
  return failure;
}

const CODEX_SCAN_SKIP_DIRS = new Set([
  '.cache',
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  'cache',
  'history',
  'logs',
  'node_modules',
  'projects',
  'sessions',
  'tmp',
  'temp',
]);

function isExecutableFile(filePath, platform = process.platform) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (platform === 'win32') {
      return ['.exe', '.cmd', '.bat', '.com'].includes(path.extname(filePath).toLowerCase());
    }
    return Boolean(stats.mode & 0o111);
  } catch {
    return false;
  }
}

function elfHeaderMatchesArchitecture(header, arch = process.arch) {
  if (
    !Buffer.isBuffer(header)
    || header.length < 20
    || header[0] !== 0x7f
    || header.toString('ascii', 1, 4) !== 'ELF'
  ) {
    return true;
  }
  const littleEndian = header[5] === 1;
  const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
  if (arch === 'arm64') return machine === 183;
  if (arch === 'x64') return machine === 62;
  return true;
}

function isExecutableCompatibleWithHost(filePath, platform = process.platform, arch = process.arch) {
  if (!isExecutableFile(filePath, platform)) return false;
  const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  if (arch === 'arm64' && /(?:x86_64|linux-x64|windows-x86_64|darwin-x64)/.test(normalized)) {
    return false;
  }
  if (arch === 'x64' && /(?:aarch64|linux-arm64|windows-arm64|darwin-arm64)/.test(normalized)) {
    return false;
  }
  if (platform !== 'linux') return true;
  let handle = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(20);
    const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
    return bytesRead < 20 || elfHeaderMatchesArchitecture(header, arch);
  } catch {
    return false;
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

function shouldSpawnCodexThroughShell(codexBin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(codexBin || ''));
}

function pushUnique(list, seen, value) {
  if (!value || seen.has(value)) {
    return;
  }
  seen.add(value);
  list.push(value);
}

function isCodexExecutableName(name) {
  const lower = String(name || '').toLowerCase();
  if (
    lower.startsWith('codex-command-runner')
    || lower.startsWith('codex-windows-sandbox')
    || lower.startsWith('codex-sandbox')
  ) {
    return false;
  }
  return lower === 'codex' || lower === 'codex.exe' || /^codex[-_.]/.test(lower);
}

function collectCodexExecutables(rootDir, options = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const maxDepth = options.maxDepth ?? 4;
  const maxEntries = options.maxEntries ?? 600;
  const found = [];
  const seen = new Set();
  let visitedEntries = 0;

  function visit(dir, depth) {
    if (depth > maxDepth || visitedEntries >= maxEntries) {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visitedEntries >= maxEntries) {
        return;
      }
      visitedEntries += 1;

      const fullPath = path.join(dir, entry.name);
      if (isCodexExecutableName(entry.name) && isExecutableFile(fullPath)) {
        pushUnique(found, seen, fullPath);
        continue;
      }

      if (!entry.isDirectory() || depth >= maxDepth) {
        continue;
      }

      if (CODEX_SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) {
        continue;
      }

      visit(fullPath, depth + 1);
    }
  }

  visit(rootDir, 0);
  return found;
}

function bundledCodexRelativeCandidates(platform = process.platform, arch = process.arch) {
  const binName = platform === 'win32' ? 'codex.exe' : 'codex';
  const platformDirs = [];
  if (platform === 'linux') {
    if (arch === 'arm64') {
      platformDirs.push('linux-arm64', 'aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl');
    } else if (arch === 'x64') {
      platformDirs.push('linux-x86_64', 'linux-x64', 'x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl');
    }
  } else if (platform === 'darwin') {
    platformDirs.push(arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64');
  } else if (platform === 'win32') {
    platformDirs.push(arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64');
  }
  return [
    ...platformDirs.flatMap((platformDir) => [
      path.join('.runtime', 'codex', 'bin', platformDir, binName),
      path.join('.runtime', 'codex', platformDir, binName),
    ]),
    path.join('.runtime', 'codex', binName),
  ];
}

function codexHomeRelativeCandidates(platform = process.platform, arch = process.arch) {
  const candidates = [];
  if (platform === 'linux' && arch === 'arm64') {
    candidates.push(
      path.join('bin', 'codex-aarch64-unknown-linux-musl'),
      path.join('bin', 'codex-aarch64-unknown-linux-gnu')
    );
  } else if (platform === 'linux' && arch === 'x64') {
    candidates.push(
      path.join('bin', 'codex-x86_64-unknown-linux-musl'),
      path.join('bin', 'codex-x86_64-unknown-linux-gnu')
    );
  }
  candidates.push(
    path.join('bin', 'codex'),
    'codex',
    path.join('codex', 'bin', 'codex'),
    path.join('cli', 'codex'),
    path.join('node_modules', '.bin', 'codex'),
    path.join('npm', 'bin', 'codex')
  );
  return candidates;
}

function cursorCodexPlatformDirs(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') return [arch === 'arm64' ? 'linux-arm64' : 'linux-x64'];
  if (platform === 'darwin') return [arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'];
  if (platform === 'win32') return [arch === 'arm64' ? 'windows-arm64' : 'windows-x86_64'];
  return [];
}

function resolveDefaultCodexBin(codexHomeOverride = null) {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }

  const candidates = [];
  const seen = new Set();
  const home = os.homedir();
  const agentRoot = path.resolve(__dirname, '..', '..');

  for (const relativePath of bundledCodexRelativeCandidates()) {
    pushUnique(candidates, seen, path.join(agentRoot, relativePath));
  }

  const codexRoots = [
    codexHomeOverride,
    process.env.CODEX_HOME,
    path.join(home, '.codex'),
  ].filter(Boolean);

  for (const absolutePath of [
    path.join(home, 'bin', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.cargo', 'bin', 'codex'),
    process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'bin', 'codex') : null,
    process.env.NPM_CONFIG_PREFIX ? path.join(process.env.NPM_CONFIG_PREFIX, 'bin', 'codex') : null,
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'codex') : null,
  ]) {
    pushUnique(candidates, seen, absolutePath);
  }

  for (const root of codexRoots) {
    for (const relativePath of codexHomeRelativeCandidates()) {
      pushUnique(candidates, seen, path.join(root, relativePath));
    }

    for (const binPath of collectCodexExecutables(root)) {
      pushUnique(candidates, seen, binPath);
    }
  }

  for (const root of [
    path.join(home, '.conda', 'envs'),
    path.join(home, '.nvm', 'versions', 'node'),
  ]) {
    for (const binPath of collectCodexExecutables(root, { maxDepth: 3, maxEntries: 4000 })) {
      pushUnique(candidates, seen, binPath);
    }
  }

  const cursorExtensions = path.join(home, '.cursor', 'extensions');
  pushUnique(candidates, seen, resolveLocalCodexBin({
    pathEnv: process.env.PATH,
    cursorExtensionsDir: path.join(agentRoot, '.missing-cursor-extensions'),
  }));
  if (fs.existsSync(cursorExtensions)) {
    const extensionDirs = fs.readdirSync(cursorExtensions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const entry of extensionDirs) {
      for (const platformDir of cursorCodexPlatformDirs()) {
        const binName = platformDir.startsWith('windows-') ? 'codex.exe' : 'codex';
        pushUnique(candidates, seen, path.join(cursorExtensions, entry, 'bin', platformDir, binName));
      }
    }
  }

  const bundledOrExtensionBin = candidates.find((candidate) => isExecutableCompatibleWithHost(candidate));
  if (bundledOrExtensionBin) {
    return bundledOrExtensionBin;
  }
  const pathBin = resolveLocalCodexBin({ pathEnv: process.env.PATH });
  return isExecutableCompatibleWithHost(pathBin) ? pathBin : 'codex';
}

function buildCodexProcessPath(codexBin) {
  const entries = [];
  const seen = new Set();

  function pushPath(value) {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    entries.push(value);
  }

  const binDir = path.dirname(codexBin || '');
  for (const candidate of [
    path.join(binDir, 'codex-resources'),
    path.join(path.dirname(binDir), 'codex-resources'),
  ]) {
    if (candidate && fs.existsSync(candidate)) {
      pushPath(candidate);
    }
  }

  pushPath(process.env.PATH || '');
  return entries.filter(Boolean).join(path.delimiter);
}

function buildResumePrelude(bootstrap) {
  const historyPreview = Array.isArray(bootstrap?.historyPreview) ? bootstrap.historyPreview : [];
  if (!historyPreview.length) {
    return null;
  }

  const lines = historyPreview
    .map((entry) => {
      const speaker = entry.speaker === 'user' ? 'User' : entry.speaker === 'assistant' ? 'Codex' : 'System';
      return `${speaker}: ${structuredText(entry.text).trim()}`;
    })
    .filter(Boolean);

  if (!lines.length) {
    return null;
  }

  return [
    'Continue this conversation with the following prior context in mind:',
    ...lines,
  ].join('\n');
}

function isMissingNativeRolloutError(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    messages.push(String(current?.message || current));
    current = current?.cause;
  }
  const text = messages.join('\n');
  return /\bno rollout found for thread id\b/i.test(text);
}

function limitText(value, max = 240) {
  const text = structuredText(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function codexCliInstallHint() {
  return [
    'Codex CLI was not found on this host.',
    'Install options:',
    'conda create -n codex-node -c conda-forge nodejs=20 -y && conda activate codex-node && npm install -g @openai/codex',
    'or: curl -fsSL https://fnm.vercel.app/install | bash && source ~/.bashrc && fnm install 20 && fnm use 20 && npm install -g @openai/codex',
    'Then restart this host-agent.',
  ].join(' ');
}

function formatCodexStartError(error) {
  const message = error?.message || String(error || 'unknown error');
  if (error?.code === 'ENOENT' || /not found|enoent|spawn codex/i.test(message)) {
    return `${message}. ${codexCliInstallHint()}`;
  }
  return message;
}

function safeProfileSegment(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'profile';
}

function hashApiConfig(config) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      provider: config.provider || '',
      providerKind: config.providerKind || '',
      baseUrl: config.baseUrl || '',
      profileId: config.profileId || '',
    }))
    .digest('hex')
    .slice(0, 16);
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function copyFileIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
}

function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
}

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
}

function writeManagedOverlayOwnerMarker(ownerMarkerPath, contents) {
  const directory = path.dirname(ownerMarkerPath);
  const tempPath = path.join(
    directory,
    `${MANAGED_OVERLAY_MARKER_NAME}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  const data = Buffer.from(String(contents), 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    let offset = 0;
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error('owner marker temp write made no progress');
      }
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, ownerMarkerPath);
    try {
      fs.chmodSync(ownerMarkerPath, 0o600);
    } catch {
      // Windows only exposes a subset of POSIX mode semantics.
    }
    let directoryFd = null;
    try {
      directoryFd = fs.openSync(directory, 'r');
      fs.fsyncSync(directoryFd);
    } catch {
      // Directory fsync is unsupported on some Windows/filesystem combinations.
    } finally {
      if (directoryFd !== null) {
        try {
          fs.closeSync(directoryFd);
        } catch {
          // The marker file was already atomically replaced and flushed.
        }
      }
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort before removing the incomplete temp file.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The authoritative marker is unchanged even if temp cleanup must be retried later.
    }
    throw error;
  }
}

function managedOverlayPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function readManagedOverlayOwnerMarker(markerPath) {
  try {
    const stats = fs.lstatSync(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (
      !marker
      || marker.kind !== MANAGED_OVERLAY_MARKER_KIND
      || marker.version !== MANAGED_OVERLAY_MARKER_VERSION
      || !/^[a-f0-9]{32}$/i.test(String(marker.ownerToken || ''))
      || !managedOverlayPid(marker.ownerPid)
    ) {
      return null;
    }
    return {
      ...marker,
      ownerPid: managedOverlayPid(marker.ownerPid),
      childPid: managedOverlayPid(marker.childPid),
      childState: String(marker.childState || '').trim() || 'unknown',
    };
  } catch {
    return null;
  }
}

function readLegacyManagedOverlayOwnerToken(markerPath) {
  try {
    const stats = fs.lstatSync(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128) return null;
    const markerText = fs.readFileSync(markerPath, 'utf8').trim();
    return /^[a-f0-9]{32}$/i.test(markerText) ? markerText : null;
  } catch {
    return null;
  }
}

function updateApiProfileCodexHomeOwnership(cleanupOwner, patch = {}) {
  if (!cleanupOwner || typeof cleanupOwner !== 'object') return false;
  const profileHomeDir = path.resolve(String(cleanupOwner.profileHomeDir || ''));
  const ownerMarkerPath = path.resolve(String(cleanupOwner.ownerMarkerPath || ''));
  if (ownerMarkerPath !== path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME)) return false;
  const marker = readManagedOverlayOwnerMarker(ownerMarkerPath);
  if (!marker || marker.ownerToken !== cleanupOwner.ownerToken) return false;
  const childState = Object.prototype.hasOwnProperty.call(patch, 'childState')
    ? String(patch.childState || '').trim()
    : marker.childState;
  if (!['not-started', 'spawning', 'running', 'exited', 'spawn-failed'].includes(childState)) {
    return false;
  }
  let childPid = marker.childPid;
  if (Object.prototype.hasOwnProperty.call(patch, 'childPid')) {
    childPid = patch.childPid == null ? null : managedOverlayPid(patch.childPid);
    if (patch.childPid != null && !childPid) return false;
  }
  writeManagedOverlayOwnerMarker(ownerMarkerPath, `${JSON.stringify({
    ...marker,
    childPid,
    childState,
    updatedAt: nowIso(),
  }, null, 2)}\n`);
  return true;
}

function isProcessAlive(pid) {
  const normalizedPid = managedOverlayPid(pid);
  if (!normalizedPid) return false;
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// Inspect an orphaned managed overlay without mutating it. This lets the Host
// Agent distinguish a genuinely cleaned-up exact run from an app-server child
// that survived an Agent restart and is no longer in liveSessions.
function inspectManagedOverlayForRun(baseHome, runId, options = {}) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) return { status: 'unknown', reason: 'missing_run_id' };
  const normalizedBaseHome = String(baseHome || '').trim();
  if (!normalizedBaseHome) return { status: 'unknown', reason: 'missing_codex_home' };
  const processIsAlive = typeof options.isProcessAlive === 'function'
    ? options.isProcessAlive
    : isProcessAlive;
  const managedRoot = path.join(path.resolve(normalizedBaseHome), '.remote-codex-managed');
  let entries;
  try {
    const rootStats = fs.lstatSync(managedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return { status: 'unknown', reason: 'unsafe_managed_root' };
    }
    entries = fs.readdirSync(managedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', matched: false };
    return { status: 'unknown', reason: error?.code || 'managed_root_unreadable' };
  }

  let matched = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const profileHomeDir = path.join(managedRoot, entry.name);
    const marker = readManagedOverlayOwnerMarker(path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME));
    const markerRunId = String(marker?.metadata?.run?.runId || '').trim();
    if (!marker || markerRunId !== normalizedRunId) continue;
    matched = true;

    const childPid = managedOverlayPid(marker.childPid);
    if (childPid && processIsAlive(childPid)) {
      return {
        status: 'active',
        matched: true,
        profileHomeDir,
        childPid,
        childState: marker.childState,
      };
    }
    if (['not-started', 'exited', 'spawn-failed'].includes(marker.childState)) {
      continue;
    }
    // A running/spawning marker without a readable live child is ambiguous:
    // permissions or a transient process transition can hide the PID.
    return {
      status: 'unknown',
      matched: true,
      profileHomeDir,
      childPid,
      childState: marker.childState,
      reason: 'child_liveness_unverified',
    };
  }
  return matched
    ? { status: 'absent', matched: true }
    : { status: 'absent', matched: false };
}

function managedOverlayPathIdentity(value) {
  const normalized = path.normalize(String(value || ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function managedOverlayRealPath(value) {
  const resolver = typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native
    : fs.realpathSync;
  return resolver(value);
}

function managedOverlayCleanupError(error, target) {
  if (error?.code === 'session_overlay_cleanup_failed') return error;
  const cause = error instanceof Error
    ? error
    : new Error(String(error || 'managed Codex overlay cleanup failed'));
  const failure = new Error(`Owned Codex overlay cleanup failed: ${cause.message}`);
  failure.code = 'session_overlay_cleanup_failed';
  failure.path = String(cause.path || target || '');
  failure.cleanupErrorCode = cause.code || null;
  failure.cause = cause;
  return failure;
}

function removeManagedOverlayDirectory(directory) {
  try {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: MANAGED_OVERLAY_REMOVE_MAX_RETRIES,
      retryDelay: MANAGED_OVERLAY_REMOVE_RETRY_DELAY_MS,
    });
  } catch (error) {
    throw managedOverlayCleanupError(error, directory);
  }
}

function inspectManagedOverlayDirectory(managedRootReal, directory) {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('managed Codex overlay directory is a link or is not a directory');
  }
  const real = managedOverlayRealPath(directory);
  if (
    managedOverlayPathIdentity(path.dirname(real))
    !== managedOverlayPathIdentity(managedRootReal)
  ) {
    throw new Error('managed Codex overlay real path escapes its managed root');
  }
  return real;
}

function ensureManagedOverlayRoot(baseHome, managedRoot) {
  const resolvedBaseHome = path.resolve(baseHome);
  if (!fs.existsSync(resolvedBaseHome)) {
    fs.mkdirSync(resolvedBaseHome, { recursive: true, mode: 0o700 });
  }
  const baseHomeStats = fs.statSync(resolvedBaseHome);
  if (!baseHomeStats.isDirectory()) {
    throw new Error('base Codex home is not a directory');
  }
  const baseHomeReal = managedOverlayRealPath(resolvedBaseHome);
  try {
    fs.mkdirSync(managedRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const managedRootStats = fs.lstatSync(managedRoot);
  if (!managedRootStats.isDirectory() || managedRootStats.isSymbolicLink()) {
    throw new Error('managed Codex overlay root is a link or is not a directory');
  }
  const managedRootReal = managedOverlayRealPath(managedRoot);
  if (
    managedOverlayPathIdentity(managedRootReal)
    !== managedOverlayPathIdentity(path.join(baseHomeReal, '.remote-codex-managed'))
  ) {
    throw new Error('managed Codex overlay root real path is unsafe');
  }
  try {
    fs.chmodSync(managedRoot, 0o700);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
  return managedRootReal;
}

function linkSharedCodexHomeEntry(baseHome, overlayHome, name) {
  const source = path.join(baseHome, name);
  const target = path.join(overlayHome, name);
  if (!fs.existsSync(source) || fs.existsSync(target)) {
    return;
  }
  const stats = fs.statSync(source);
  try {
    const linkType = stats.isDirectory()
      ? (process.platform === 'win32' ? 'junction' : 'dir')
      : 'file';
    fs.symlinkSync(source, target, linkType);
    return;
  } catch {
    // Symlinks can be disabled on Windows/HPC; fall back to copying only small files.
  }
  if (stats.isFile() && stats.size <= 1024 * 1024) {
    fs.copyFileSync(source, target);
  }
}

function nativeRolloutProviderAlias(store, nativeThreadId) {
  if (!nativeThreadId || !store?.seedResult?.rolloutPath) return null;
  const meta = readJsonLines(store.seedResult.rolloutPath, 5)
    .find((row) => row?.type === 'session_meta' && row.payload?.id === nativeThreadId);
  const provider = String(meta?.payload?.model_provider || '').trim();
  return /^remote_codex_[a-f0-9]{16}$/.test(provider) ? provider : null;
}

function rewriteConfigTomlForApiProfile(baseConfig, config, providerKey, providerAliases = []) {
  const begin = '# BEGIN remote-codex-api-profile';
  const end = '# END remote-codex-api-profile';
  const blockPattern = new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`, 'g');
  let next = String(baseConfig || '').replace(blockPattern, '\n').trim();
  const providerName = config.label || config.provider || 'API profile';
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const aliases = providerAliases.filter((key) => (
    /^remote_codex_[a-f0-9]{16}$/.test(key) && key !== providerKey
  ));
  for (const key of aliases) {
    if (new RegExp(`^\\s*\\[\\s*model_providers\\.${key}\\s*\\]`, 'm').test(next)) {
      const error = new Error(`Historical provider ${key} already exists in the base Codex configuration; cannot safely redirect it to the selected API.`);
      error.code = 'session_native_provider_alias_conflict';
      throw error;
    }
  }
  const keys = [providerKey, ...aliases];
  const profileBlock = [
    begin,
    ...keys.flatMap((key) => [
      `[model_providers.${key}]`,
      `name = ${tomlString(providerName)}`,
      `base_url = ${tomlString(baseUrl)}`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
      'requires_openai_auth = false',
    ]),
    end,
  ].join('\n');

  const activeProviderKey = aliases[0] || providerKey;
  if (/^model_provider\s*=.*$/m.test(next)) {
    next = next.replace(/^model_provider\s*=.*$/m, `model_provider = ${tomlString(activeProviderKey)}`);
  } else {
    next = `model_provider = ${tomlString(activeProviderKey)}\n${next}`;
  }
  return `${next.trim()}\n${profileBlock}`;
}

function managedOverlayMarkerMetadata(config, configHash, options = {}) {
  const textOrNull = (value) => {
    if (value == null) return null;
    const text = String(value).trim();
    return text || null;
  };
  return {
    host: {
      hostId: textOrNull(options.hostId),
    },
    session: {
      sessionId: textOrNull(options.sessionId),
      bridgeSessionId: textOrNull(options.bridgeSessionId),
      nativeThreadId: textOrNull(options.nativeThreadId),
      sourceSessionId: textOrNull(options.sourceSessionId),
      originSessionId: textOrNull(options.originSessionId),
      conversationKey: textOrNull(options.conversationKey),
    },
    profile: {
      profileId: textOrNull(config?.profileId),
      label: textOrNull(config?.label),
      provider: textOrNull(config?.provider),
      providerKind: textOrNull(config?.providerKind),
      configHash,
      configuredBaseUrl: Boolean(config?.baseUrl),
      configuredApiKey: Boolean(config?.apiKey),
    },
    run: {
      runId: textOrNull(options.runId),
      launchMode: textOrNull(options.launchMode),
    },
  };
}

function prepareApiProfileCodexHome(baseHome, apiConfig, options = {}) {
  const config = normalizeApiConfig(apiConfig);
  const hash = config ? hashApiConfig(config) : 'host-env';
  const managedRoot = path.join(baseHome, '.remote-codex-managed');
  // Keep every managed session in its own HOME. This prevents our app-server
  // from sharing Codex SQLite state with an interactive Codex running on HPC.
  // Human-readable session/profile/run metadata belongs in the owner marker,
  // not in this path: long Windows paths can prevent SQLite from creating state.
  let ownerToken = null;
  let profileHomeDir = null;
  let overlayHome = null;
  let ownerMarkerPath = null;
  let profileHomeCreated = false;
  let managedRootReal = null;
  try {
    managedRootReal = ensureManagedOverlayRoot(baseHome, managedRoot);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      ownerToken = crypto.randomBytes(16).toString('hex');
      profileHomeDir = path.join(managedRoot, `rc-${ownerToken}`);
      try {
        fs.mkdirSync(profileHomeDir, { recursive: false, mode: 0o700 });
        profileHomeCreated = true;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (!profileHomeCreated) {
      const error = new Error('Could not allocate a unique managed Codex overlay directory.');
      error.code = 'session_overlay_name_collision';
      throw error;
    }
    overlayHome = path.join(profileHomeDir, '.codex');
    ownerMarkerPath = path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME);
    inspectManagedOverlayDirectory(managedRootReal, profileHomeDir);
    ensurePrivateDirectory(overlayHome);
    writeManagedOverlayOwnerMarker(ownerMarkerPath, `${JSON.stringify({
      kind: MANAGED_OVERLAY_MARKER_KIND,
      version: MANAGED_OVERLAY_MARKER_VERSION,
      ownerToken,
      ownerPid: process.pid,
      childPid: null,
      childState: 'not-started',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: managedOverlayMarkerMetadata(config, hash, options),
    }, null, 2)}\n`);

    const overlayAuthPath = path.join(overlayHome, 'auth.json');
    let auth = {};
    if (config) {
      auth = { OPENAI_API_KEY: config.apiKey };
    } else {
      try {
        auth = JSON.parse(fs.readFileSync(path.join(baseHome, 'auth.json'), 'utf8'));
      } catch {
        auth = {};
      }
    }
    writePrivateFile(overlayAuthPath, `${JSON.stringify(auth, null, 2)}\n`);

    const baseConfigPath = path.join(baseHome, 'config.toml');
    const overlayConfigPath = path.join(overlayHome, 'config.toml');
    let baseConfig = '';
    try {
      baseConfig = fs.readFileSync(baseConfigPath, 'utf8');
    } catch {
      baseConfig = '';
    }
    const providerKey = config ? `remote_codex_${hash}` : null;

    const managedSessionStore = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: options.hostId,
      logicalSessionId: options.managedSessionId || options.bridgeSessionId || options.sessionId,
      sessionId: options.sessionId,
      bridgeSessionId: options.bridgeSessionId,
      nativeThreadId: options.nativeThreadId,
      rebindNativeThreadId: options.rebindNativeThreadId,
      sourceSessionId: options.sourceSessionId,
      originSessionId: options.originSessionId,
      conversationKey: options.conversationKey,
      targetNativeThreadId: options.nativeThreadId || options.rebindNativeThreadId,
      launchMode: options.launchMode,
    });
    const nativeThreadId = options.nativeThreadId || options.rebindNativeThreadId;
    const legacyProvider = config && ['resume', 'fresh_rebind', 'fork'].includes(options.launchMode)
      ? nativeRolloutProviderAlias(managedSessionStore, nativeThreadId)
      : null;
    writePrivateFile(
      overlayConfigPath,
      config
        ? rewriteConfigTomlForApiProfile(baseConfig, config, providerKey, legacyProvider ? [legacyProvider] : [])
        : baseConfig
    );
    managedSessionStore.attachToOverlay(overlayHome);
    for (const name of ['installation_id', 'cap_sid', '.personality_migration']) {
      copyFileIfExists(path.join(baseHome, name), path.join(overlayHome, name));
    }
    for (const name of ['skills', 'rules', 'memories', 'generated_images']) {
      linkSharedCodexHomeEntry(baseHome, overlayHome, name);
    }

    return {
      codexHome: overlayHome,
      profileHome: Boolean(config),
      isolatedHome: true,
      profileHomeDir,
      providerKey,
      nativeResumeProviderKey: legacyProvider,
      managedSessionStore,
      cleanupOwner: { baseHome, managedRoot, profileHomeDir, ownerMarkerPath, ownerToken },
    };
  } catch (error) {
    if (profileHomeCreated) {
      try {
        if (
          managedRootReal
          && managedOverlayPathIdentity(inspectManagedOverlayDirectory(managedRootReal, profileHomeDir))
            === managedOverlayPathIdentity(managedOverlayRealPath(profileHomeDir))
        ) {
          removeManagedOverlayDirectory(profileHomeDir);
        }
      } catch {
        // Preserve the constructor failure; the startup janitor can retry owned cleanup.
      }
    }
    throw error;
  }
}

function cleanupApiProfileCodexHome(cleanupOwner) {
  if (!cleanupOwner || typeof cleanupOwner !== 'object') return false;
  const baseHome = path.resolve(String(cleanupOwner.baseHome || ''));
  const managedRoot = path.resolve(String(cleanupOwner.managedRoot || ''));
  const profileHomeDir = path.resolve(String(cleanupOwner.profileHomeDir || ''));
  const ownerMarkerPath = path.resolve(String(cleanupOwner.ownerMarkerPath || ''));
  const expectedManagedRoot = path.join(baseHome, '.remote-codex-managed');
  const expectedOwnerMarkerPath = path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME);
  if (
    managedRoot !== expectedManagedRoot
    || path.dirname(profileHomeDir) !== managedRoot
    || ownerMarkerPath !== expectedOwnerMarkerPath
    || profileHomeDir === managedRoot
    || managedRoot === baseHome
  ) {
    return false;
  }
  try {
    const profileStats = fs.lstatSync(profileHomeDir);
    if (!profileStats.isDirectory() || profileStats.isSymbolicLink()) {
      return false;
    }
  } catch (error) {
    // An already-absent owned directory is a completed cleanup, not an
    // unverifiable ownership result.
    return error?.code === 'ENOENT';
  }
  try {
    const managedRootStats = fs.lstatSync(managedRoot);
    const markerStats = fs.lstatSync(ownerMarkerPath);
    if (
      !managedRootStats.isDirectory()
      || managedRootStats.isSymbolicLink()
      || !markerStats.isFile()
      || markerStats.isSymbolicLink()
    ) {
      return false;
    }
    const baseHomeReal = managedOverlayRealPath(baseHome);
    const managedRootReal = managedOverlayRealPath(managedRoot);
    if (
      managedOverlayPathIdentity(managedRootReal)
      !== managedOverlayPathIdentity(path.join(baseHomeReal, '.remote-codex-managed'))
    ) {
      return false;
    }
    inspectManagedOverlayDirectory(managedRootReal, profileHomeDir);
  } catch {
    return false;
  }
  let markerToken = '';
  try {
    const markerText = fs.readFileSync(ownerMarkerPath, 'utf8').trim();
    try {
      const marker = JSON.parse(markerText);
      if (
        marker?.kind !== MANAGED_OVERLAY_MARKER_KIND
        || marker?.version !== MANAGED_OVERLAY_MARKER_VERSION
      ) {
        return false;
      }
      markerToken = String(marker.ownerToken || '').trim();
    } catch {
      // Runners created by the immediately previous version used the token as the marker body.
      markerToken = markerText;
    }
  } catch {
    return false;
  }
  if (!markerToken || markerToken !== cleanupOwner.ownerToken) return false;
  removeManagedOverlayDirectory(profileHomeDir);
  return true;
}

function cleanupStaleApiProfileCodexHomes(baseHome, options = {}) {
  const normalizedBaseHome = String(baseHome || '').trim();
  const result = {
    scanned: 0,
    removed: 0,
    preserved: 0,
    legacyUnattributed: 0,
    legacyRemoved: 0,
    legacyPreserved: 0,
    diagnostics: [],
    errors: [],
  };
  if (!normalizedBaseHome) return result;
  const resolvedBaseHome = path.resolve(normalizedBaseHome);
  const managedRoot = path.join(resolvedBaseHome, '.remote-codex-managed');
  let managedRootReal = null;
  let entries = [];
  try {
    const managedRootStats = fs.lstatSync(managedRoot);
    if (!managedRootStats.isDirectory() || managedRootStats.isSymbolicLink()) {
      result.errors.push('managed Codex overlay root is a link or is not a directory; cleanup was skipped');
      return result;
    }
    const baseHomeReal = managedOverlayRealPath(resolvedBaseHome);
    managedRootReal = managedOverlayRealPath(managedRoot);
    if (
      managedOverlayPathIdentity(managedRootReal)
      !== managedOverlayPathIdentity(path.join(baseHomeReal, '.remote-codex-managed'))
    ) {
      result.errors.push('managed Codex overlay root real path is unsafe; cleanup was skipped');
      return result;
    }
    entries = fs.readdirSync(managedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') result.errors.push(String(error.message || error));
    return result;
  }
  const processIsAlive = typeof options.isProcessAlive === 'function'
    ? options.isProcessAlive
    : isProcessAlive;
  const legacyOverlayIsInactive = typeof options.legacyOverlayIsInactive === 'function'
    ? options.legacyOverlayIsInactive
    : null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    result.scanned += 1;
    const profileHomeDir = path.join(managedRoot, entry.name);
    let profileHomeReal = null;
    try {
      profileHomeReal = inspectManagedOverlayDirectory(managedRootReal, profileHomeDir);
    } catch {
      result.preserved += 1;
      result.errors.push('managed Codex overlay entry has an unsafe link or real path; cleanup was skipped');
      continue;
    }
    const ownerMarkerPath = path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME);
    const marker = readManagedOverlayOwnerMarker(ownerMarkerPath);
    if (!marker) {
      const legacyOwnerToken = readLegacyManagedOverlayOwnerToken(ownerMarkerPath);
      if (!legacyOwnerToken) {
        result.preserved += 1;
        continue;
      }

      result.legacyUnattributed += 1;
      let inactiveAttested = false;
      if (legacyOverlayIsInactive) {
        try {
          inactiveAttested = legacyOverlayIsInactive(Object.freeze({
            baseHome: path.resolve(normalizedBaseHome),
            managedRoot,
            profileHomeDir,
            codexHome: path.join(profileHomeDir, '.codex'),
          })) === true;
        } catch {
          result.errors.push('legacy managed Codex overlay liveness attestation failed');
        }
      }
      if (!inactiveAttested) {
        result.preserved += 1;
        result.legacyPreserved += 1;
        continue;
      }

      // Re-read the token immediately before removal so a concurrent marker
      // replacement cannot turn an operator attestation into foreign cleanup.
      if (readLegacyManagedOverlayOwnerToken(ownerMarkerPath) !== legacyOwnerToken) {
        result.preserved += 1;
        result.legacyPreserved += 1;
        result.errors.push('legacy managed Codex overlay ownership changed during cleanup');
        continue;
      }
      try {
        if (
          managedOverlayPathIdentity(inspectManagedOverlayDirectory(managedRootReal, profileHomeDir))
          !== managedOverlayPathIdentity(profileHomeReal)
        ) {
          throw new Error('managed Codex overlay ownership path changed during cleanup');
        }
        removeManagedOverlayDirectory(profileHomeDir);
        result.removed += 1;
        result.legacyRemoved += 1;
      } catch {
        result.preserved += 1;
        result.legacyPreserved += 1;
        result.errors.push('legacy managed Codex overlay cleanup failed after liveness attestation');
      }
      continue;
    }
    if (processIsAlive(marker.ownerPid)) {
      result.preserved += 1;
      continue;
    }
    let childIsConfirmedDead = false;
    if (marker.childPid) {
      childIsConfirmedDead = !processIsAlive(marker.childPid);
    } else if (['not-started', 'exited', 'spawn-failed'].includes(marker.childState)) {
      childIsConfirmedDead = true;
    }
    if (!childIsConfirmedDead) {
      result.preserved += 1;
      continue;
    }
    try {
      if (
        managedOverlayPathIdentity(inspectManagedOverlayDirectory(managedRootReal, profileHomeDir))
        !== managedOverlayPathIdentity(profileHomeReal)
      ) {
        throw new Error('managed Codex overlay ownership path changed during cleanup');
      }
      removeManagedOverlayDirectory(profileHomeDir);
      result.removed += 1;
    } catch (error) {
      result.preserved += 1;
      result.errors.push(`${entry.name}: ${String(error.message || error)}`);
    }
  }
  if (result.legacyPreserved > 0) {
    result.diagnostics.push({
      severity: 'warning',
      code: 'legacy_overlay_preserved_unattributed',
      count: result.legacyPreserved,
      message: `Preserved ${result.legacyPreserved} unattributed legacy managed Codex overlay(s). Confirm that no old Host Agent or app-server uses this CODEX_HOME before enabling the one-time legacy cleanup attestation.`,
    });
  }
  if (result.legacyRemoved > 0) {
    result.diagnostics.push({
      severity: 'info',
      code: 'legacy_overlay_removed_by_attestation',
      count: result.legacyRemoved,
      message: `Removed ${result.legacyRemoved} legacy managed Codex overlay(s) after explicit operator liveness attestation.`,
    });
  }
  return result;
}

function quarantineCodexStateDatabases(codexHome, reason = 'startup') {
  if (!codexHome || !fs.existsSync(codexHome)) {
    return { backupDir: null, moved: [] };
  }
  const backupDir = path.join(codexHome, `broken-sqlite-backup-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${safeProfileSegment(reason)}`);
  const moved = [];
  fs.mkdirSync(backupDir, { recursive: true });

  for (const entry of fs.readdirSync(codexHome)) {
    if (!/^(logs|state)_\d+\.sqlite(?:-(?:wal|shm))?$/.test(entry)) {
      continue;
    }
    const source = path.join(codexHome, entry);
    const target = path.join(backupDir, entry);
    try {
      fs.renameSync(source, target);
      moved.push(entry);
    } catch {
      // Best effort: another Codex process may still hold the file.
    }
  }

  return { backupDir, moved };
}

function summarizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'undefined') {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(limitText(value, depth === 0 ? 240 : 120));
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const items = value.slice(0, 4).map((item) => summarizeValue(item, depth + 1, seen));
    seen.delete(value);
    return `[${items.join(', ')}${value.length > 4 ? ', ...' : ''}]`;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const entries = Object.entries(value).slice(0, 6).map(([key, item]) => `${key}: ${summarizeValue(item, depth + 1, seen)}`);
    seen.delete(value);
    return `{ ${entries.join(', ')}${Object.keys(value).length > 6 ? ', ...' : ''} }`;
  }

  return JSON.stringify(value);
}

function normalizeThinkingText(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const text = value
      .map((item) => normalizeThinkingText(item, depth + 1, seen))
      .filter(Boolean)
      .join('\n')
      .trim();
    seen.delete(value);
    return text;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (typeof value.step === 'string' && value.step.trim()) {
      const status = typeof value.status === 'string' && value.status.trim()
        ? `[${value.status.trim()}] `
        : '';
      const extra = typeof value.summary === 'string' && value.summary.trim() && value.summary.trim() !== value.step.trim()
        ? ` - ${value.summary.trim()}`
        : '';
      seen.delete(value);
      return `${status}${value.step.trim()}${extra}`.trim();
    }

    for (const key of ['text', 'content', 'summary', 'description', 'title', 'label']) {
      if (value[key] != null) {
        const text = normalizeThinkingText(value[key], depth + 1, seen).trim();
        if (text) {
          seen.delete(value);
          return text;
        }
      }
    }

    if (depth > 1) {
      const text = summarizeValue(value, depth, seen);
      seen.delete(value);
      return text;
    }

    const text = Object.entries(value)
      .map(([key, item]) => {
        const normalized = normalizeThinkingText(item, depth + 1, seen);
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    seen.delete(value);
    return text;
  }

  return String(value).trim();
}

function persistedReasoningSummaryText(value) {
  return structuredText(value);
}

function notificationPhase(params = {}) {
  return structuredScalar(
    params.phase
      || params.item?.phase
      || params.message?.phase
      || params.payload?.phase
      || '',
    ''
  ).trim().toLowerCase();
}

function notificationDeltaText(params = {}) {
  return normalizeThinkingText(
    params.delta
      || params.text
      || params.message
      || params.item?.text
      || params.item?.message
      || ''
  );
}

const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);
const APPROVAL_POLICIES = new Set(['untrusted', 'on-failure', 'on-request', 'never']);
const APPROVAL_REVIEWERS = new Set(['user', 'auto_review', 'guardian_subagent']);
const SANDBOX_MODES = new Set(['workspaceWrite', 'workspace-write', 'readOnly', 'read-only', 'dangerFullAccess', 'danger-full-access', 'externalSandbox', 'external-sandbox']);
const PERSONALITIES = new Set(['none', 'friendly', 'pragmatic']);

function pickAllowedString(value, allowedValues) {
  const text = String(value || '').trim();
  return text && allowedValues.has(text) ? text : null;
}

function normalizeSandboxMode(value) {
  const mode = pickAllowedString(value, SANDBOX_MODES) || 'workspaceWrite';
  return {
    'workspace-write': 'workspaceWrite',
    'read-only': 'readOnly',
    'danger-full-access': 'dangerFullAccess',
    'external-sandbox': 'externalSandbox',
  }[mode] || mode;
}

function buildSandboxPolicy(cwd, options = {}) {
  const mode = normalizeSandboxMode(options.sandboxMode);
  const networkAccess = options.networkAccess === true;

  if (mode === 'dangerFullAccess') {
    return { type: 'dangerFullAccess' };
  }

  if (mode === 'readOnly') {
    return {
      type: 'readOnly',
      networkAccess,
    };
  }

  if (mode === 'externalSandbox') {
    return {
      type: 'externalSandbox',
      networkAccess: networkAccess ? 'enabled' : 'restricted',
    };
  }

  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess,
  };
}

function normalizeInputItems(text, options = {}) {
  const items = [];
  const prompt = String(text || '').trim();
  if (prompt) {
    items.push({
      type: 'text',
      text: prompt,
    });
  }

  const rawItems = [
    ...(Array.isArray(options.inputItems) ? options.inputItems : []),
    ...(Array.isArray(options.attachments) ? options.attachments : []),
  ];

  for (const rawItem of rawItems.slice(0, 8)) {
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }
    const type = String(rawItem.type || '').trim();

    if (type === 'image') {
      const url = String(rawItem.url || rawItem.dataUrl || '').trim();
      if (url) {
        items.push({ type: 'image', url });
      }
      continue;
    }

    if (type === 'localImage') {
      const imagePath = String(rawItem.path || '').trim();
      if (imagePath) {
        items.push({ type: 'localImage', path: imagePath });
      }
      continue;
    }

    if (type === 'mention' || type === 'skill') {
      const name = String(rawItem.name || '').trim();
      const itemPath = String(rawItem.path || '').trim();
      if (name && itemPath) {
        items.push({ type, name, path: itemPath });
      }
    }
  }

  return items;
}

function normalizeTurnStartParams(threadId, cwd, text, options = {}) {
  const input = normalizeInputItems(text, options);
  const params = {
    threadId,
    cwd,
    approvalPolicy: typeof options.approvalPolicy === 'object'
      ? options.approvalPolicy
      : pickAllowedString(options.approvalPolicy, APPROVAL_POLICIES) || 'on-request',
    sandboxPolicy: buildSandboxPolicy(cwd, options),
    input,
  };

  if (options.collaborationMode && typeof options.collaborationMode === 'object') {
    params.collaborationMode = options.collaborationMode;
  }

  const model = String(options.model || '').trim();
  if (model) {
    params.model = model;
  }

  const effort = normalizeReasoningEffort(options.effort);
  if (effort) {
    params.effort = effort;
  }

  const summary = pickAllowedString(options.summary, REASONING_SUMMARIES);
  if (summary) {
    params.summary = summary;
  }

  const approvalsReviewer = pickAllowedString(options.approvalsReviewer, APPROVAL_REVIEWERS);
  if (approvalsReviewer) {
    params.approvalsReviewer = approvalsReviewer;
  }

  const personality = pickAllowedString(options.personality, PERSONALITIES);
  if (personality) {
    params.personality = personality;
  }

  const serviceTier = String(options.serviceTier || '').trim();
  if (serviceTier) {
    params.serviceTier = serviceTier;
  }

  return params;
}

function normalizeOfficialCollaborationMode(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const mode = String(value.mode || '').trim();
  if (mode !== 'plan' && mode !== 'default') {
    return null;
  }
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : {};
  return {
    mode,
    settings: {
      model: String(settings.model || '').trim(),
      reasoning_effort: settings.reasoning_effort || settings.reasoningEffort || null,
      developer_instructions: settings.developer_instructions ?? settings.developerInstructions ?? null,
    },
  };
}

function shouldUseLocalPlanFallback(error) {
  const message = String(error?.message || error || '');
  return /collaborationMode\/list/i.test(message)
    || /collaboration mode/i.test(message)
    || /method not found/i.test(message)
    || /unknown method/i.test(message)
    || /unknown field/i.test(message)
    || /invalid params/i.test(message)
    || /did not return an official plan/i.test(message);
}

function buildLocalPlanPrompt(text, hasAttachments) {
  const request = String(text || '').trim()
    || (hasAttachments ? 'Please inspect the attached file or image inputs and propose a safe next-step plan.' : '');
  return [
    'Local Plan fallback: do not modify files, do not run destructive commands, and do not make irreversible changes.',
    'Analyze the request, list the concrete steps you would take, and call out risks or decisions that need confirmation.',
    '',
    'User request:',
    request,
  ].join('\n').trim();
}

function normalizeReviewTarget(input = {}) {
  const target = input.target && typeof input.target === 'object' ? input.target : input;
  const type = String(target.type || 'uncommittedChanges').trim();

  if (type === 'baseBranch') {
    const branch = String(target.branch || '').trim();
    if (!branch) {
      throw new Error('baseBranch review requires branch');
    }
    return { type, branch };
  }

  if (type === 'commit') {
    const sha = String(target.sha || '').trim();
    if (!sha) {
      throw new Error('commit review requires sha');
    }
    return {
      type,
      sha,
      title: String(target.title || '').trim() || null,
    };
  }

  if (type === 'custom') {
    const instructions = String(target.instructions || '').trim();
    if (!instructions) {
      throw new Error('custom review requires instructions');
    }
    return { type, instructions };
  }

  return { type: 'uncommittedChanges' };
}

function describeThreadStatus(status) {
  if (!status || typeof status !== 'object') {
    return 'unknown';
  }

  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags.join(', ') : '';
    return flags ? `active (${flags})` : 'active';
  }

  return String(status.type || 'unknown');
}

function describeCodexError(errorInfo) {
  if (!errorInfo) {
    return null;
  }

  if (typeof errorInfo === 'string') {
    return errorInfo;
  }

  if (errorInfo.httpConnectionFailed) {
    return `httpConnectionFailed${errorInfo.httpConnectionFailed.httpStatusCode ? ` (${errorInfo.httpConnectionFailed.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseStreamConnectionFailed) {
    return `responseStreamConnectionFailed${errorInfo.responseStreamConnectionFailed.httpStatusCode ? ` (${errorInfo.responseStreamConnectionFailed.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseStreamDisconnected) {
    return `responseStreamDisconnected${errorInfo.responseStreamDisconnected.httpStatusCode ? ` (${errorInfo.responseStreamDisconnected.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseTooManyFailedAttempts) {
    return `responseTooManyFailedAttempts${errorInfo.responseTooManyFailedAttempts.httpStatusCode ? ` (${errorInfo.responseTooManyFailedAttempts.httpStatusCode})` : ''}`;
  }

  if (errorInfo.activeTurnNotSteerable) {
    return `activeTurnNotSteerable (${errorInfo.activeTurnNotSteerable.turnKind || 'unknown'})`;
  }

  return summarizeValue(errorInfo);
}

class JsonRpcSession {
  constructor(child, handlers = {}) {
    this.child = child;
    this.handlers = handlers;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closedError = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.on('error', (error) => {
      this.rejectPending(error);
      if (typeof this.handlers.onError === 'function') {
        this.handlers.onError(error);
      }
    });
    child.on('exit', (code, signal) => {
      this.rejectPending(new Error(`codex app-server exited early: ${code ?? 'null'} / ${signal ?? 'null'}`));
      if (typeof this.handlers.onExit === 'function') {
        this.handlers.onExit(code, signal);
      }
    });
  }

  rejectPending(error) {
    this.closedError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }

    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Timed out waiting for ${method}`);
        error.code = 'codex_rpc_request_timeout';
        error.rpcMethod = method;
        error.timeoutMs = timeoutMs;
        reject(error);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  respond(id, result) {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  respondError(id, code, message) {
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    })}\n`, 'utf8');
  }

  onStdout(chunk) {
    this.buffer += chunk;

    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n');
      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!rawLine) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(rawLine);
      } catch (error) {
        if (typeof this.handlers.onRawStdout === 'function') {
          this.handlers.onRawStdout(rawLine);
        }
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'result')) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'error')) {
      const pending = this.pending.get(message.id);
      const error = new Error(message.error?.message || `JSON-RPC error for ${message.id}`);
      if (message.error && typeof message.error === 'object') {
        error.rpcCode = message.error.code ?? null;
        error.rpcData = message.error.data ?? null;
      }
      if (pending) {
        this.pending.delete(message.id);
        pending.reject(error);
        return;
      }

      if (typeof this.handlers.onNotification === 'function') {
        this.handlers.onNotification({
          method: 'jsonrpc.error',
          params: message.error || {},
        });
      }
      return;
    }

    if (!message.method) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      Promise.resolve()
        .then(() => this.handlers.onServerRequest && this.handlers.onServerRequest(message))
        .catch((error) => {
          this.respondError(message.id, -32000, error.message || 'server request failed');
        });
      return;
    }

    if (typeof this.handlers.onNotification === 'function') {
      this.handlers.onNotification(message);
    }
  }
}

class CodexAppServerRunner {
  constructor(options) {
    this.hostId = options.hostId;
    this.sessionId = options.sessionId;
    this.bridgeSessionId = options.bridgeSessionId || options.sessionId;
    this.runId = options.runId || null;
    this.title = options.title;
    this.cwd = options.cwd;
    this.launchMode = options.launchMode || 'fresh';
    this.originSessionId = options.originSessionId || null;
    this.sourceSessionId = options.sourceSessionId || null;
    this.conversationKey = options.conversationKey || this.originSessionId || this.bridgeSessionId;
    this.bootstrap = options.bootstrap || null;
    this.rebindNativeThreadId = options.rebindNativeThreadId || null;
    this.forceTranscriptFallback = options.forceTranscriptFallback === true;
    this.explicitRebind = options.explicitRebind === true;
    this.postEvent = options.postEvent;
    this.onTerminated = options.onTerminated || null;
    this.apiConfig = normalizeApiConfig(options.apiConfig);
    this.apiBinding = deriveRunBinding({
      apiBinding: options.apiBinding,
      apiConfig: this.apiConfig,
      env: options.env || process.env,
      codexHome: options.codexHome,
      allowUnavailable: true,
    });
    this.baseCodexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const preparedCodexHome = prepareApiProfileCodexHome(this.baseCodexHome, this.apiConfig, {
      hostId: this.hostId,
      sessionId: this.sessionId,
      bridgeSessionId: this.bridgeSessionId,
      nativeThreadId: options.nativeThreadId || null,
      sourceSessionId: this.sourceSessionId,
      originSessionId: this.originSessionId,
      conversationKey: this.conversationKey,
      runId: this.runId,
      launchMode: this.launchMode,
      rebindNativeThreadId: this.rebindNativeThreadId,
    });
    try {
      this.codexHome = preparedCodexHome.codexHome;
      this.apiProfileHome = preparedCodexHome.profileHome;
      this.isolatedCodexHome = preparedCodexHome.isolatedHome;
      this.profileHomeDir = preparedCodexHome.profileHomeDir || null;
      this.apiProfileCleanupOwner = preparedCodexHome.cleanupOwner || null;
      this.apiProviderKey = preparedCodexHome.providerKey || null;
      this.nativeResumeProviderKey = preparedCodexHome.nativeResumeProviderKey || null;
      this.managedSessionStore = preparedCodexHome.managedSessionStore || null;
      const configuredInitializeTimeout = Number(options.initializeRequestTimeoutMs);
      this.initializeRequestTimeoutMs = Number.isFinite(configuredInitializeTimeout)
        && configuredInitializeTimeout > 0
        ? Math.floor(configuredInitializeTimeout)
        : initializeTimeoutForLaunchMode(this.launchMode);
      this.spawnProcess = typeof options.spawnProcess === 'function' ? options.spawnProcess : spawn;
      this.codexBin = options.codexBin || resolveDefaultCodexBin(this.baseCodexHome);
      this.codexArgs = Array.isArray(options.codexArgs) && options.codexArgs.length
        ? options.codexArgs.map((value) => String(value))
        : ['app-server'];
      this.child = null;
      this.rpc = null;
      this.stopRequested = false;
      this.stopCommandRequested = false;
      this.stopPromise = null;
      this.stopGraceTimeoutMs = Math.max(1, Number(options.stopGraceTimeoutMs || 5000) || 5000);
      this.stopKillTimeoutMs = Math.max(1, Number(options.stopKillTimeoutMs || 1000) || 1000);
      this.suppressTerminalEvent = false;
      this.agentEventsSuppressed = false;
      this.terminationPromise = null;
      this.startCompleted = false;
      this.threadOpenConfirmed = false;
      this.startupStateDbCorruption = false;
      this.startupStateDbDiagnostic = null;
      this.childExitConfirmed = false;
      this.startupRetryExit = null;
      this.startupRetryExitResolver = null;
      this.startRetryPending = false;
      this.startRetryFailure = null;
      this.processTreeFallbackRequired = false;
      this.overlayCleaned = false;
      this.overlayCleanupRetryTimer = null;
      this.overlayCleanupRetryAttempt = 0;
      const configuredOverlayCleanupRetries = Number(options.overlayCleanupRetryMaxAttempts);
      this.overlayCleanupRetryMaxAttempts = Number.isFinite(configuredOverlayCleanupRetries)
        ? Math.max(0, Math.floor(configuredOverlayCleanupRetries))
        : MANAGED_OVERLAY_BACKGROUND_RETRY_ATTEMPTS;
      const configuredOverlayCleanupDelay = Number(options.overlayCleanupRetryDelayMs);
      this.overlayCleanupRetryDelayMs = Number.isFinite(configuredOverlayCleanupDelay)
        ? Math.max(1, Math.floor(configuredOverlayCleanupDelay))
        : MANAGED_OVERLAY_BACKGROUND_RETRY_DELAY_MS;
      this.overlayCleanupDiagnosticReported = false;
      this.overlayCleanupLastError = null;
      this.threadId = null;
      this.nativeThreadId = options.nativeThreadId || null;
      this.nativeResumeReady = !this.forceTranscriptFallback
        && ['resume', 'fork'].includes(this.launchMode);
      this.activeTurnId = null;
      this.activeClientRequestId = null;
      this.clientRequestIdsByTurn = new Map();
      this.subagentParentTurns = new Map();
      this.pendingInterruptIntent = null;
      this.runtimeRevision = 0;
      this.inputSubmissionInFlight = false;
      this.turnBuffers = new Map();
      this.turnAssistantTranscriptEmitted = new Set();
      this.terminalTurnIds = new Set();
      this.systemErrorsByTurn = new Map();
      this.pendingTurnCompletions = new Map();
      this.pendingThreadIdleReconciliation = null;
      this.pendingSubmissionReconciliation = null;
      this.activeSubmissionAttempt = null;
      this.submissionAttemptsByTurn = new Map();
      this.pendingRuntimeProjectionRetry = null;
      this.turnLifecycleGeneration = 0;
      this.activeTurnLifecycleId = null;
      this.turnCompletionFallbackGraceMs = TURN_COMPLETION_FALLBACK_GRACE_MS;
      this.threadIdleReconcileGraceMs = Math.max(
        10,
        Number(options.threadIdleReconcileGraceMs || 0) || THREAD_IDLE_RECONCILE_GRACE_MS
      );
      this.threadIdleProbeTimeoutMs = Math.max(
        25,
        Number(options.threadIdleProbeTimeoutMs || 0) || THREAD_IDLE_PROBE_TIMEOUT_MS
      );
      this.threadIdleRetryBaseMs = Math.max(
        10,
        Number(options.threadIdleRetryBaseMs || 0) || THREAD_IDLE_RETRY_BASE_MS
      );
      this.threadIdleRetryMaxMs = Math.max(
        this.threadIdleRetryBaseMs,
        Number(options.threadIdleRetryMaxMs || 0) || THREAD_IDLE_RETRY_MAX_MS
      );
      this.submissionReconcileDelayMs = Math.max(
        10,
        Number(options.submissionReconcileDelayMs || 0) || SUBMISSION_RECONCILE_DELAY_MS
      );
      this.submissionReconcileRetryMaxMs = Math.max(
        this.submissionReconcileDelayMs,
        Number(options.submissionReconcileRetryMaxMs || 0) || SUBMISSION_RECONCILE_RETRY_MAX_MS
      );
      this.threadOpenRequestTimeoutMs = Math.max(
        1,
        Number(options.threadOpenRequestTimeoutMs || 0)
          || threadOpenTimeoutForLaunchMode(this.launchMode)
      );
      this.turnBufferTruncated = new Set();
      this.itemPhases = new Map();
      this.maxTurnBufferBytes = TURN_BUFFER_MAX_BYTES;
      this.turnModes = new Map();
      this.turnInputTypes = new Map();
      this.initializeNotificationQueue();
      this.initializeThinkingActivity();
      this.pendingRequests = new Map();
      this.resolvedRequests = new Map();
      this.reviewInFlight = false;
      this.modelCapabilities = new Map();
      this.resumePrelude = (this.forceTranscriptFallback || this.launchMode === 'transcript_fallback')
        ? buildResumePrelude(this.bootstrap)
        : null;
      this.resumePreludeUsed = !this.resumePrelude;
      this.runtime = {
        kind: 'codex_app_server',
        adapterId: 'codex-app-server',
        runtimeId: 'codex-app-server',
        runId: this.runId,
        runtimeLabel: 'Codex app-server',
        command: this.codexBin,
        args: this.codexArgs,
        cwd: this.cwd,
        codexHome: this.codexHome,
        nativeThreadId: this.nativeThreadId || null,
        nativeResumeReady: this.nativeResumeReady,
        launchMode: this.launchMode,
        forceTranscriptFallback: this.forceTranscriptFallback,
        codexHomeProfile: this.apiProfileHome ? 'api-profile-isolated' : 'managed-isolated',
        managedSessionStoreKey: this.managedSessionStore?.storeKey || null,
        initializeRequestTimeoutMs: this.initializeRequestTimeoutMs,
        apiProfileId: this.apiConfig?.profileId || null,
        apiProfileLabel: this.apiConfig?.label || null,
        apiProvider: this.apiConfig?.provider || null,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey,
        apiBinding: this.apiBinding,
        resumeStrategy: this.forceTranscriptFallback ? 'transcript_fallback' : 'fresh',
        connection: 'starting',
        phase: 'starting',
        startupStep: 'starting',
        busy: false,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        runtimeRevision: this.runtimeRevision,
        updatedAt: nowIso(),
      };
    } catch (error) {
      try {
        cleanupApiProfileCodexHome(preparedCodexHome.cleanupOwner);
      } catch {
        // Preserve the constructor error; the startup janitor can retry owned cleanup.
      }
      throw error;
    }
  }

  assertCommandBinding(explicitBinding) {
    if (!this.apiBinding && !explicitBinding) {
      return null;
    }
    return assertRunBinding(this.apiBinding, explicitBinding);
  }

  validateModelSelection(model, effort) {
    return validateRuntimeModelSelection(this.modelCapabilities, model, effort);
  }

  hasUnconfirmedSubmission() {
    return Boolean(
      this.inputSubmissionInFlight
      || this.pendingSubmissionReconciliation
      || this.activeSubmissionAttempt
      || (this.activeClientRequestId && !this.activeTurnId)
    );
  }

  settledThreadStartupStatusPatch(threadStatus = this.runtime.threadStatus) {
    return this.runtime.currentTurnStatus === 'starting'
      && !this.activeTurnId
      && !this.hasUnconfirmedSubmission()
      && !this.hasPendingApprovalOrInputRequest()
      && String(threadStatus?.type || '').toLowerCase() === 'idle'
      ? { currentTurnStatus: 'idle' }
      : {};
  }

  confirmedThreadOpenRuntimePatch() {
    const hasActiveWork = Boolean(
      this.activeTurnId
      || this.hasUnconfirmedSubmission()
      || this.hasPendingApprovalOrInputRequest()
      || String(this.runtime.threadStatus?.type || '').toLowerCase() === 'active'
    );
    return {
      phase: hasActiveWork ? this.runtime.phase : 'idle',
      startupStep: 'ready',
      busy: hasActiveWork,
      ...this.settledThreadStartupStatusPatch(),
    };
  }

  hasPendingApprovalOrInputRequest() {
    for (const pending of this.pendingRequests.values()) {
      if (!this.serverRequestOwnershipMatchesCurrent(pending?.ownership)) continue;
      if (pending?.method === 'item/tool/requestUserInput') return true;
      if (String(pending?.method || '').includes('requestApproval')) return true;
    }
    return false;
  }

  runtimePhaseForResolvedRequest() {
    const pending = this.pendingRequestFlags();
    if (pending.waitingOnApproval) return 'waiting-approval';
    if (pending.waitingOnUserInput) return 'waiting-user-input';
    if (this.activeTurnId) {
      const current = String(this.runtime.phase || '').trim();
      return ['reviewing', 'running-shell-command', 'compacting', 'interrupting'].includes(current)
        ? current
        : 'thinking';
    }
    if (this.hasUnconfirmedSubmission()) {
      const current = String(this.runtime.phase || '').trim();
      return ['submitting-turn', 'runtime-unknown', 'interrupting'].includes(current)
        ? current
        : 'runtime-unknown';
    }
    return 'idle';
  }

  pendingRequestFlags() {
    let waitingOnApproval = false;
    let waitingOnUserInput = false;
    for (const pending of this.pendingRequests.values()) {
      if (!this.serverRequestOwnershipMatchesCurrent(pending?.ownership)) continue;
      if (pending?.method === 'item/tool/requestUserInput') waitingOnUserInput = true;
      if (String(pending?.method || '').includes('requestApproval')) waitingOnApproval = true;
    }
    return { waitingOnApproval, waitingOnUserInput };
  }

  async publishManagedSessionRollout(reason, options = {}) {
    if (!this.managedSessionStore || !this.nativeThreadId) {
      return {
        published: false,
        reason: 'native-thread-missing',
        becameNativeResumeReady: false,
      };
    }
    try {
      const result = this.managedSessionStore.publishNativeThread(this.nativeThreadId);
      const becameNativeResumeReady = result.published === true
        && this.runtime.nativeResumeReady !== true;
      if (result.published) {
        this.managedSessionRolloutPublishError = null;
        this.nativeResumeReady = true;
        this.runtime.nativeResumeReady = true;
      }
      return { ...result, becameNativeResumeReady };
    } catch (error) {
      const signature = `${error?.code || 'error'}:${error?.message || error}`;
      const firstObservation = signature !== this.managedSessionRolloutPublishError;
      this.managedSessionRolloutPublishError = signature;
      if (firstObservation && options.silent !== true) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'runtime',
          kind: 'session-store',
          method: 'rollout/publish',
          message: 'The managed Session rollout could not be published to base Codex history.',
          detail: String(error?.message || error),
          data: {
            code: error?.code || null,
            reason: reason || null,
            nativeThreadId: this.nativeThreadId,
            storeKey: this.managedSessionStore.storeKey,
          },
        }).catch(() => {});
      }
      return {
        published: false,
        reason: 'publish-failed',
        error,
        becameNativeResumeReady: false,
      };
    }
  }

  initializeNotificationQueue(options = {}) {
    this.notificationQueue = [];
    this.notificationQueueBytes = 0;
    this.notificationQueueWorker = null;
    this.notificationInFlight = null;
    this.notificationCoalescedEntries = new Map();
    this.notificationCoalescingEpoch = 0;
    this.notificationOverflow = null;
    this.notificationDroppedCount = 0;
    this.notificationCoalescedCount = 0;
    this.notificationLastError = null;
    this.maxNotificationQueueItems = Math.max(
      8,
      Number(options.maxItems || NOTIFICATION_QUEUE_MAX_ITEMS) || NOTIFICATION_QUEUE_MAX_ITEMS
    );
    this.maxNotificationQueueBytes = Math.max(
      16 * 1024,
      Number(options.maxBytes || NOTIFICATION_QUEUE_MAX_BYTES) || NOTIFICATION_QUEUE_MAX_BYTES
    );
    this.maxNotificationItemBytes = Math.max(
      1024,
      Math.min(
        Number(options.maxItemBytes || NOTIFICATION_QUEUE_MAX_ITEM_BYTES) || NOTIFICATION_QUEUE_MAX_ITEM_BYTES,
        this.maxNotificationQueueBytes
      )
    );
    this.notificationTerminalReservedItems = Math.max(
      1,
      Math.min(
        Number(options.terminalReservedItems || NOTIFICATION_QUEUE_TERMINAL_RESERVED_ITEMS)
          || NOTIFICATION_QUEUE_TERMINAL_RESERVED_ITEMS,
        this.maxNotificationQueueItems - 1
      )
    );
    this.notificationTerminalReservedBytes = Math.max(
      this.maxNotificationItemBytes,
      Math.min(
        Number(options.terminalReservedBytes || NOTIFICATION_QUEUE_TERMINAL_RESERVED_BYTES)
          || NOTIFICATION_QUEUE_TERMINAL_RESERVED_BYTES,
        this.maxNotificationQueueBytes - 1024
      )
    );
  }

  ensureNotificationQueue() {
    if (!Array.isArray(this.notificationQueue)) this.initializeNotificationQueue();
  }

  notificationItemKey(params = {}) {
    const turnId = String(params.turnId || params.turn?.id || this.activeTurnId || '').trim();
    const itemId = String(params.itemId || params.item?.id || '').trim();
    return turnId && itemId ? `${turnId}\u0000${itemId}` : '';
  }

  rememberNotificationItemPhase(params = {}) {
    if (!(this.itemPhases instanceof Map)) this.itemPhases = new Map();
    const key = this.notificationItemKey(params);
    const phase = notificationPhase(params);
    if (key && phase) this.itemPhases.set(key, phase);
    return phase;
  }

  resolvedNotificationPhase(params = {}) {
    return notificationPhase(params)
      || this.itemPhases?.get(this.notificationItemKey(params))
      || '';
  }

  releaseTurnItemPhases(turnId) {
    if (!(this.itemPhases instanceof Map)) return;
    const prefix = `${String(turnId || '').trim()}\u0000`;
    if (prefix === '\u0000') return;
    for (const key of this.itemPhases.keys()) {
      if (key.startsWith(prefix)) this.itemPhases.delete(key);
    }
  }

  notificationPriority(message) {
    const method = String(message?.method || '');
    const threadStatus = method === 'thread/status/changed'
      ? normalizedStatusType(message?.params?.status)
      : '';
    if (threadStatus === 'idle' && this.activeTurnId) {
      return 'critical-state';
    }
    if (
      method === 'turn/completed'
      || (method === 'error' && message?.params?.willRetry !== true)
    ) {
      return 'critical-terminal';
    }
    if (method === 'item/completed') {
      return 'item-terminal';
    }
    if (method === 'thread/started' || method === 'turn/started') return 'barrier';
    if (method === 'item/agentMessage/delta' && this.resolvedNotificationPhase(message?.params) !== 'commentary') {
      return 'ordered';
    }
    return 'best-effort';
  }

  notificationCoalesceKey(message, priority) {
    if (priority === 'critical-terminal' || priority === 'item-terminal' || priority === 'barrier') {
      return null;
    }
    const method = String(message?.method || '');
    const params = message?.params || {};
    const threadId = truncateUtf8(
      params.threadId || params.thread?.id || this.threadId || this.currentSessionId() || 'thread',
      256
    );
    const turnId = truncateUtf8(params.turnId || params.turn?.id || this.activeTurnId || 'turn', 256);
    const itemId = truncateUtf8(params.itemId || params.item?.id || 'item', 256);
    const epoch = this.notificationCoalescingEpoch;
    if (method === 'thread/status/changed') return `${epoch}:thread-status:${threadId}`;
    if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') {
      return `${epoch}:goal:${threadId}`;
    }
    if (method === 'thread/tokenUsage/updated') return `${epoch}:tokens:${threadId}`;
    if (method === 'account/rateLimits/updated') {
      return `${epoch}:rate-limits:${truncateUtf8(params.accountId || 'account', 256)}`;
    }
    if (method === 'item/agentMessage/delta') {
      return `${epoch}:agent:${turnId}:${itemId}:${this.resolvedNotificationPhase(params) || 'final'}`;
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      return `${epoch}:reasoning:${turnId}:${itemId}:${Number(params.summaryIndex ?? 0)}`;
    }
    if (method === 'item/plan/delta' || method === 'turn/plan/updated') {
      return `${epoch}:plan:${method}:${turnId}:${itemId}`;
    }
    if (method === 'item/fileChange/patchUpdated') {
      return `${epoch}:file-change:${turnId}:${itemId}`;
    }
    if (method === 'item/mcpToolCall/progress') {
      return `${epoch}:mcp-progress:${turnId}:${itemId}`;
    }
    if (
      method === 'item/commandExecution/outputDelta'
      || method === 'process/outputDelta'
      || method === 'command/exec/outputDelta'
    ) {
      return `${epoch}:command:${method}:${turnId}:${truncateUtf8(
        params.processId || params.processHandle || itemId,
        256
      )}:${truncateUtf8(params.stream || '', 32)}`;
    }
    return null;
  }

  mergeNotificationMessages(previous, incoming) {
    const method = String(incoming?.method || '');
    if (method !== previous?.method) return incoming;
    if (
      method === 'thread/status/changed'
      || method === 'thread/tokenUsage/updated'
      || method === 'account/rateLimits/updated'
      || method === 'turn/plan/updated'
      || method === 'item/fileChange/patchUpdated'
    ) {
      return incoming;
    }
    if (method === 'thread/goal/updated' || method === 'thread/goal/cleared') return incoming;

    const previousParams = previous?.params || {};
    const incomingParams = incoming?.params || {};
    const mergedParams = { ...previousParams, ...incomingParams };
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
      mergedParams.delta = `${previousParams.delta || ''}${incomingParams.delta || ''}`;
      if (previousParams.text || incomingParams.text) {
        mergedParams.text = `${previousParams.text || ''}${incomingParams.text || ''}`;
      }
    } else if (method === 'item/plan/delta') {
      mergedParams.delta = `${previousParams.delta || ''}${incomingParams.delta || ''}`;
      if (previousParams.plan || incomingParams.plan) {
        mergedParams.plan = `${previousParams.plan || ''}${incomingParams.plan || ''}`;
      }
    } else if (
      method === 'item/commandExecution/outputDelta'
      || method === 'process/outputDelta'
      || method === 'command/exec/outputDelta'
    ) {
      mergedParams.delta = `${previousParams.delta || ''}${incomingParams.delta || ''}`;
      mergedParams.deltaBase64 = `${previousParams.deltaBase64 || ''}${incomingParams.deltaBase64 || ''}`;
      if (previousParams.capReached === true || incomingParams.capReached === true) {
        mergedParams.capReached = true;
      }
      if (previousParams.truncated === true || incomingParams.truncated === true) {
        mergedParams.truncated = true;
      }
    } else if (method === 'item/mcpToolCall/progress') {
      mergedParams.message = [previousParams.message, incomingParams.message]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join('\n');
    } else {
      return incoming;
    }
    return { ...incoming, params: mergedParams };
  }

  removeNotificationQueueEntry(entry, options = {}) {
    const index = this.notificationQueue.indexOf(entry);
    if (index < 0) return false;
    this.notificationQueue.splice(index, 1);
    this.notificationQueueBytes = Math.max(0, this.notificationQueueBytes - entry.bytes);
    if (
      entry.coalesceKey
      && this.notificationCoalescedEntries.get(entry.coalesceKey) === entry
    ) {
      this.notificationCoalescedEntries.delete(entry.coalesceKey);
    }
    if (options.dropped) this.recordNotificationDrop(entry.message, entry.bytes);
    return true;
  }

  recordNotificationDrop(message, bytes = 0) {
    this.notificationDroppedCount += 1;
    if (!this.notificationOverflow) {
      this.notificationOverflow = {
        count: 0,
        bytes: 0,
        methods: new Set(),
      };
    }
    this.notificationOverflow.count += 1;
    this.notificationOverflow.bytes += Math.max(0, Number(bytes) || 0);
    if (this.notificationOverflow.methods.size < 8) {
      this.notificationOverflow.methods.add(truncateUtf8(message?.method || 'notification', 128));
    }
  }

  ensureNotificationQueueRoom(extraItems, extraBytes, priority, protectedEntry = null) {
    const isCriticalTerminal = priority === 'critical-terminal';
    const isCriticalState = priority === 'critical-state';
    const usesTerminalCapacity = isCriticalTerminal || isCriticalState || priority === 'item-terminal';
    const itemLimit = usesTerminalCapacity
      ? this.maxNotificationQueueItems
      : this.maxNotificationQueueItems - this.notificationTerminalReservedItems;
    const byteLimit = usesTerminalCapacity
      ? this.maxNotificationQueueBytes
      : this.maxNotificationQueueBytes - this.notificationTerminalReservedBytes;
    const inFlightItems = this.notificationInFlight ? 1 : 0;
    const inFlightBytes = this.notificationInFlight?.bytes || 0;
    const fits = () => (
      this.notificationQueue.length + inFlightItems + extraItems <= itemLimit
      && this.notificationQueueBytes + inFlightBytes + extraBytes <= byteLimit
    );
    while (!fits()) {
      let evicted = this.notificationQueue.find(
        (entry) => entry !== protectedEntry && entry.priority === 'best-effort'
      );
      if (!evicted && (isCriticalTerminal || isCriticalState)) {
        evicted = this.notificationQueue.find(
          (entry) => entry !== protectedEntry && entry.priority === 'item-terminal'
        );
      }
      if (!evicted && isCriticalTerminal) {
        evicted = this.notificationQueue.find(
          (entry) => entry !== protectedEntry && entry.priority !== 'critical-terminal'
        );
      }
      if (!evicted) return false;
      this.removeNotificationQueueEntry(evicted, { dropped: true });
    }
    return true;
  }

  enqueueNotification(message) {
    this.ensureNotificationQueue();
    if (message?.method === 'item/started' || message?.method === 'item/completed') {
      this.rememberNotificationItemPhase(message.params || {});
    }
    let queuedMessage = message;
    let bytes = notificationSerializedBytes(queuedMessage);
    if (bytes > this.maxNotificationItemBytes) {
      queuedMessage = compactOversizedNotification(queuedMessage, this.maxNotificationItemBytes);
      bytes = notificationSerializedBytes(queuedMessage);
    }
    if (!Number.isFinite(bytes) || bytes > this.maxNotificationItemBytes) {
      this.recordNotificationDrop(message, Number.isFinite(bytes) ? bytes : 0);
      return this.ensureNotificationQueueWorker();
    }

    const priority = this.notificationPriority(queuedMessage);
    const turnOwnership = [
      'thread/status/changed',
      'turn/started',
      'turn/completed',
      'error',
    ].includes(String(queuedMessage?.method || ''))
      ? this.captureActiveTurnOwnership()
      : null;
    const submissionOwnership = [
      'turn/started',
      'turn/completed',
      'error',
      'thread/status/changed',
    ].includes(String(queuedMessage?.method || ''))
      ? this.captureSubmissionOwnership()
      : null;
    const coalesceKey = this.notificationCoalesceKey(queuedMessage, priority);
    const previousEntry = coalesceKey ? this.notificationCoalescedEntries.get(coalesceKey) : null;
    if (previousEntry) {
      const mergedMessage = this.mergeNotificationMessages(previousEntry.message, queuedMessage);
      const mergedBytes = notificationSerializedBytes(mergedMessage);
      if (mergedBytes <= this.maxNotificationItemBytes) {
        const byteDelta = mergedBytes - previousEntry.bytes;
        if (byteDelta <= 0 || this.ensureNotificationQueueRoom(0, byteDelta, priority, previousEntry)) {
          this.notificationQueueBytes += byteDelta;
          previousEntry.message = mergedMessage;
          previousEntry.bytes = mergedBytes;
          previousEntry.turnOwnership = turnOwnership;
          previousEntry.submissionOwnership = submissionOwnership;
          this.notificationCoalescedCount += 1;
          return this.ensureNotificationQueueWorker();
        }
      }
      previousEntry.coalesceKey = null;
      this.notificationCoalescedEntries.delete(coalesceKey);
    }

    if (!this.ensureNotificationQueueRoom(1, bytes, priority)) {
      this.recordNotificationDrop(queuedMessage, bytes);
      return this.ensureNotificationQueueWorker();
    }
    const entry = {
      message: queuedMessage,
      bytes,
      priority,
      coalesceKey,
      turnOwnership,
      submissionOwnership,
    };
    this.notificationQueue.push(entry);
    this.notificationQueueBytes += bytes;
    if (coalesceKey) this.notificationCoalescedEntries.set(coalesceKey, entry);
    if (priority === 'critical-terminal' || priority === 'item-terminal' || priority === 'barrier') {
      this.notificationCoalescingEpoch += 1;
    }
    return this.ensureNotificationQueueWorker();
  }

  ensureNotificationQueueWorker() {
    this.ensureNotificationQueue();
    if (this.notificationQueueWorker || (!this.notificationQueue.length && !this.notificationOverflow)) {
      return this.notificationQueueWorker || Promise.resolve();
    }
    const worker = (async () => {
      for (;;) {
        while (this.notificationQueue.length) {
          const entry = this.notificationQueue.shift();
          this.notificationQueueBytes = Math.max(0, this.notificationQueueBytes - entry.bytes);
          if (
            entry.coalesceKey
            && this.notificationCoalescedEntries.get(entry.coalesceKey) === entry
          ) {
            this.notificationCoalescedEntries.delete(entry.coalesceKey);
          }
          this.notificationInFlight = {
            method: String(entry.message?.method || 'notification'),
            bytes: entry.bytes,
            priority: entry.priority,
          };
          try {
            Object.defineProperty(entry.message, NOTIFICATION_TURN_OWNERSHIP, {
              configurable: true,
              enumerable: false,
              value: entry.turnOwnership || null,
            });
            Object.defineProperty(entry.message, NOTIFICATION_SUBMISSION_OWNERSHIP, {
              configurable: true,
              enumerable: false,
              value: entry.submissionOwnership || null,
            });
            await this.handleNotification(entry.message);
          } catch (error) {
            this.notificationLastError = error;
            console.error(`[codex-runner] notification failed: ${error.message || error}`);
          } finally {
            this.notificationInFlight = null;
          }
        }
        if (!this.notificationOverflow) break;
        const overflow = this.notificationOverflow;
        this.notificationOverflow = null;
        try {
          await this.emitDiagnostic({
            severity: 'warning',
            source: 'runtime',
            kind: 'notification-overflow',
            message: `Dropped ${overflow.count} queued Codex notifications to stay within memory limits.`,
            data: {
              droppedCount: overflow.count,
              droppedBytes: overflow.bytes,
              methods: Array.from(overflow.methods),
            },
          });
        } catch (error) {
          this.notificationLastError = error;
          console.error(`[codex-runner] notification overflow diagnostic failed: ${error.message || error}`);
        }
      }
    })();
    const delivery = worker.finally(() => {
      if (this.notificationQueueWorker === delivery) this.notificationQueueWorker = null;
      if (this.notificationQueue.length || this.notificationOverflow) {
        this.ensureNotificationQueueWorker();
      }
    });
    this.notificationQueueWorker = delivery;
    return delivery;
  }

  notificationQueueStats() {
    this.ensureNotificationQueue();
    const inFlightItems = this.notificationInFlight ? 1 : 0;
    const inFlightBytes = this.notificationInFlight?.bytes || 0;
    return {
      pendingItems: this.notificationQueue.length,
      pendingBytes: this.notificationQueueBytes,
      inFlightItems,
      inFlightBytes,
      totalItems: this.notificationQueue.length + inFlightItems,
      totalBytes: this.notificationQueueBytes + inFlightBytes,
      maxItems: this.maxNotificationQueueItems,
      maxBytes: this.maxNotificationQueueBytes,
      maxItemBytes: this.maxNotificationItemBytes,
      dropped: this.notificationDroppedCount,
      coalesced: this.notificationCoalescedCount,
    };
  }

  async drainNotifications() {
    this.ensureNotificationQueue();
    while (this.notificationQueueWorker || this.notificationQueue.length || this.notificationOverflow) {
      await this.ensureNotificationQueueWorker();
    }
  }

  resetTurnBuffer(turnId) {
    const key = String(turnId || '');
    if (!key) return;
    if (!this.turnBufferTruncated) this.turnBufferTruncated = new Set();
    this.releaseTurnItemPhases(key);
    this.turnBuffers.set(key, '');
    this.turnBufferTruncated.delete(key);
  }

  appendTurnBuffer(turnId, delta) {
    const key = String(turnId || '');
    if (!key) return '';
    if (!this.turnBufferTruncated) this.turnBufferTruncated = new Set();
    const previous = this.turnBuffers.get(key) || '';
    if (this.turnBufferTruncated.has(key)) return previous;
    const maxBytes = Math.max(1024, Number(this.maxTurnBufferBytes || TURN_BUFFER_MAX_BYTES));
    const next = `${previous}${String(delta ?? '')}`;
    if (Buffer.byteLength(next, 'utf8') <= maxBytes) {
      this.turnBuffers.set(key, next);
      return next;
    }
    const bounded = truncateUtf8(next, maxBytes, TURN_BUFFER_TRUNCATION_SUFFIX);
    this.turnBuffers.set(key, bounded);
    this.turnBufferTruncated.add(key);
    return bounded;
  }

  releaseTurnBuffer(turnId) {
    const key = String(turnId || '');
    if (!key) return;
    this.turnBuffers.delete(key);
    this.turnBufferTruncated?.delete(key);
    this.turnInputTypes?.delete?.(key);
  }

  clearTurnBuffers() {
    this.turnBuffers.clear();
    this.turnBufferTruncated?.clear();
    this.itemPhases?.clear();
    this.turnInputTypes?.clear();
    this.turnAssistantTranscriptEmitted?.clear();
    this.clearPendingTurnCompletions();
  }

  takePendingTurnCompletion(turnId) {
    const key = String(turnId || '');
    const pending = key ? this.pendingTurnCompletions?.get(key) || null : null;
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pendingTurnCompletions.delete(key);
    return pending;
  }

  clearPendingTurnCompletions() {
    for (const pending of this.pendingTurnCompletions?.values?.() || []) {
      clearTimeout(pending.timer);
    }
    this.pendingTurnCompletions?.clear?.();
  }

  deferTurnCompletion(turnId, params) {
    const key = String(turnId || '');
    if (!key) return false;
    const previous = this.takePendingTurnCompletion(key);
    const pending = {
      params: previous ? { ...previous.params, ...params } : params,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (this.pendingTurnCompletions?.get(key) !== pending) return;
      this.pendingTurnCompletions.delete(key);
      void this.finalizeTurnCompletion(pending.params, key).catch((error) => {
        this.notificationLastError = error;
        console.error(`[codex-runner] deferred turn completion failed: ${error.message || error}`);
      });
    }, Math.max(25, Number(this.turnCompletionFallbackGraceMs || TURN_COMPLETION_FALLBACK_GRACE_MS)));
    pending.timer.unref?.();
    this.pendingTurnCompletions.set(key, pending);
    return true;
  }

  async flushPendingTurnCompletion(turnId) {
    const pending = this.takePendingTurnCompletion(turnId);
    if (!pending) return false;
    await this.finalizeTurnCompletion(pending.params, turnId);
    return true;
  }

  async flushAllPendingTurnCompletions() {
    const keys = Array.from(this.pendingTurnCompletions?.keys?.() || []);
    for (const turnId of keys) {
      await this.flushPendingTurnCompletion(turnId);
    }
  }

  activityCanonicalConversationKey() {
    const hostId = String(this.hostId || '').trim();
    const conversationKey = String(
      this.conversationKey
        || this.originSessionId
        || this.nativeThreadId
        || this.bridgeSessionId
        || this.sessionId
        || ''
    ).trim();
    if (!hostId) return conversationKey;
    return conversationKey.startsWith(`${hostId}::`)
      ? conversationKey
      : `${hostId}::${conversationKey}`;
  }

  initializeThinkingActivity(options = {}) {
    this.thinkingActivities = new Map();
    this.activitySnapshotDelivery = Promise.resolve();
    this.activitySnapshotDeliveryInFlight = null;
    this.pendingActivitySnapshots = new Map();
    this.maxPendingActivitySnapshots = 64;
    this.activitySnapshotDeliveryErrors = new Map();
    this.thinkingActivityAggregator = new ThinkingActivityAggregator({
      canonicalConversationKey: this.activityCanonicalConversationKey(),
      runId: this.runId,
      flushDelayMs: 75,
      emitSnapshot: (snapshot) => this.emitActivitySnapshot(snapshot),
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      now: options.now,
      maxRecords: 64,
      maxTextBytes: 256 * 1024,
      maxTotalTextBytes: 8 * 1024 * 1024,
      onEvict: (record) => {
        this.thinkingActivities.delete(record.activityKey);
        this.pendingActivitySnapshots.delete(record.activityKey);
        this.activitySnapshotDeliveryErrors.delete(record.activityKey);
      },
    });
  }

  ensureThinkingActivityAggregator() {
    if (!this.thinkingActivityAggregator) {
      this.initializeThinkingActivity();
    }
    return this.thinkingActivityAggregator;
  }

  normalizeActivityIdentity(identity = {}) {
    const turnId = truncateUtf8(String(identity.turnId || '').trim(), 512);
    const itemId = truncateUtf8(String(
      identity.itemId || identity.callId || identity.requestId || identity.processId || ''
    ).trim(), 512);
    if (!turnId || !itemId) return null;
    const summaryIndex = Number(identity.summaryIndex ?? 0);
    const normalized = {
      turnId,
      itemId,
      summaryIndex: Number.isFinite(summaryIndex) ? summaryIndex : 0,
      kind: truncateUtf8(identity.kind || 'activity', 64),
      itemType: truncateUtf8(identity.itemType || identity.kind || 'activity', 64),
    };
    const clientRequestId = String(
      this.clientRequestIdForTurn(turnId) || identity.clientRequestId || ''
    ).trim();
    if (clientRequestId) {
      normalized.clientRequestId = truncateUtf8(clientRequestId, 512);
    }
    for (const field of [
      'method', 'callId', 'requestId', 'status', 'startedAtMs', 'completedAtMs', 'durationMs',
      'command', 'cwd', 'processId', 'source', 'stream', 'commandActions', 'output', 'outputTruncated',
      'exitCode', 'fileChanges', 'changes', 'server', 'tool', 'arguments', 'result', 'error',
      'progress', 'progressTruncated', 'resourceUri', 'namespace', 'success', 'senderThreadId',
      'receiverThreadIds', 'prompt', 'agentsStates', 'query', 'action', 'actionData', 'path', 'review',
      'model', 'reasoningEffort', 'agentThreadId', 'agentPath', 'agentNickname', 'agentRole',
      'parentThreadId', 'subagentKind',
    ]) {
      if (Object.prototype.hasOwnProperty.call(identity, field)) normalized[field] = identity[field];
    }
    for (const [field, maxBytes] of Object.entries({
      method: 256,
      callId: 512,
      requestId: 512,
      status: 64,
      cwd: 4096,
      processId: 512,
      source: 128,
      stream: 64,
      server: 512,
      namespace: 512,
      senderThreadId: 512,
      agentThreadId: 512,
      agentPath: 4096,
      agentNickname: 512,
      agentRole: 512,
      parentThreadId: 512,
      subagentKind: 128,
      path: 4096,
      resourceUri: 4096,
      model: 512,
      reasoningEffort: 128,
    })) {
      if (normalized[field] != null) {
        normalized[field] = truncateUtf8(normalized[field], maxBytes, NOTIFICATION_TRUNCATION_SUFFIX);
      }
    }
    return normalized;
  }

  trackActivity(identity) {
    const normalized = this.normalizeActivityIdentity(identity);
    if (!normalized) return null;
    const activityKey = makeActivityKey({
      canonicalConversationKey: this.activityCanonicalConversationKey(),
      runId: this.runId,
      ...normalized,
    });
    let tracked = this.thinkingActivities.get(activityKey);
    if (!tracked) {
      tracked = { activityKey, identity: normalized, finalized: false };
      this.thinkingActivities.set(activityKey, tracked);
    } else {
      const previousIdentity = tracked.identity;
      tracked.identity = { ...previousIdentity, ...normalized };
      for (const field of new Set([
        ...Object.keys(previousIdentity),
        ...Object.keys(normalized),
      ])) {
        if (
          field.endsWith('Truncated')
          && (previousIdentity[field] === true || normalized[field] === true)
        ) {
          tracked.identity[field] = true;
        }
      }
    }
    return tracked;
  }

  trackThinkingActivity(identity) {
    return this.trackActivity({ ...identity, kind: 'reasoning', itemType: 'reasoning' });
  }

  appendActivityDelta(identity, delta, options = {}) {
    const tracked = this.trackActivity(identity);
    if (!tracked) return null;
    tracked.finalized = false;
    this.ensureThinkingActivityAggregator().appendDelta(
      tracked.identity,
      String(delta ?? ''),
      options
    );
    return tracked;
  }

  replaceActivitySnapshot(identity, text, options = {}) {
    const tracked = this.trackActivity(identity);
    if (!tracked) return null;
    tracked.finalized = false;
    this.ensureThinkingActivityAggregator().replaceSnapshot(
      tracked.identity,
      String(text ?? ''),
      options
    );
    return tracked;
  }

  appendActivityFieldDelta(identity, field, delta, options = {}) {
    const tracked = this.trackActivity(identity);
    if (!tracked) return null;
    const aggregator = this.ensureThinkingActivityAggregator();
    const current = aggregator.record(tracked.identity);
    const previous = String(current?.[field] || '');
    const separator = previous && options.separator ? String(options.separator) : '';
    const bounded = truncateActivityText(
      `${previous}${separator}${String(delta ?? '')}`,
      options.maxTextBytes || ACTIVITY_PROGRESS_MAX_BYTES
    );
    const truncatedField = `${field}Truncated`;
    tracked.identity = {
      ...tracked.identity,
      [field]: bounded.text,
      [truncatedField]: tracked.identity[truncatedField] === true
        || current?.[truncatedField] === true
        || options.truncated === true
        || bounded.truncated,
    };
    tracked.finalized = false;
    aggregator.replaceSnapshot(tracked.identity, current?.text || '', {
      force: true,
      maxTextBytes: options.maxTextBytes,
    });
    return tracked;
  }

  appendThinkingDelta(identity, delta) {
    return this.appendActivityDelta(
      { ...identity, kind: 'reasoning', itemType: 'reasoning' },
      delta
    );
  }

  replaceThinkingSnapshot(identity, text) {
    return this.replaceActivitySnapshot(
      { ...identity, kind: 'reasoning', itemType: 'reasoning' },
      text
    );
  }

  emitActivitySnapshot(snapshot) {
    const clientRequestId = String(
      this.clientRequestIdForTurn(snapshot.turnId) || snapshot.clientRequestId || ''
    ).trim() || null;
    const event = {
      type: 'session.activity_snapshot',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      conversationKey: this.conversationKey || null,
      bridgeSessionId: this.bridgeSessionId || null,
      nativeThreadId: this.nativeThreadId || null,
      originSessionId: this.originSessionId || null,
      sourceSessionId: this.sourceSessionId || null,
      ...snapshot,
      clientRequestId,
    };
    const activityKey = String(snapshot.activityKey || '');
    if (this.pendingActivitySnapshots.has(activityKey)) {
      this.pendingActivitySnapshots.delete(activityKey);
    } else if (this.pendingActivitySnapshots.size >= this.maxPendingActivitySnapshots) {
      const pendingEntries = [...this.pendingActivitySnapshots.entries()];
      const evicted = pendingEntries.find(([, pending]) => pending.final !== true)
        || pendingEntries[0];
      if (evicted) this.pendingActivitySnapshots.delete(evicted[0]);
    }
    this.pendingActivitySnapshots.set(activityKey, event);
    return this.ensureActivitySnapshotDelivery();
  }

  ensureActivitySnapshotDelivery() {
    if (this.activitySnapshotDeliveryInFlight) {
      return this.activitySnapshotDeliveryInFlight;
    }
    const worker = (async () => {
      while (this.pendingActivitySnapshots.size) {
        const [activityKey, event] = this.pendingActivitySnapshots.entries().next().value;
        this.pendingActivitySnapshots.delete(activityKey);
        try {
          await this.postEvent(event);
          this.activitySnapshotDeliveryErrors.delete(activityKey);
        } catch (error) {
          const deliveryError = retryableTerminalDeliveryError(error);
          if (
            !this.activitySnapshotDeliveryErrors.has(activityKey)
            && this.activitySnapshotDeliveryErrors.size >= this.maxPendingActivitySnapshots
          ) {
            this.activitySnapshotDeliveryErrors.delete(
              this.activitySnapshotDeliveryErrors.keys().next().value
            );
          }
          this.activitySnapshotDeliveryErrors.set(activityKey, deliveryError);
        }
      }
    })();
    const delivery = worker.finally(() => {
      if (this.activitySnapshotDeliveryInFlight === delivery) {
        this.activitySnapshotDeliveryInFlight = null;
      }
      if (this.pendingActivitySnapshots.size) {
        return this.ensureActivitySnapshotDelivery();
      }
      return null;
    });
    this.activitySnapshotDeliveryInFlight = delivery;
    this.activitySnapshotDelivery = delivery;
    return delivery;
  }

  async waitForActivitySnapshotDelivery() {
    while (this.pendingActivitySnapshots.size || this.activitySnapshotDeliveryInFlight) {
      await this.ensureActivitySnapshotDelivery();
    }
  }

  async finalizeThinkingActivities(filter = {}) {
    if (!this.thinkingActivityAggregator) return [];
    const selected = Array.from(this.thinkingActivities.values()).filter((tracked) => {
      if (tracked.finalized) return false;
      if (filter.turnId != null && tracked.identity.turnId !== String(filter.turnId)) return false;
      if (filter.itemId != null && tracked.identity.itemId !== String(filter.itemId)) return false;
      return true;
    });
    for (const tracked of selected) tracked.finalized = true;

    const snapshots = [];
    for (const tracked of selected) {
      snapshots.push(await this.thinkingActivityAggregator.flush(tracked.identity, { final: true }));
    }
    await this.waitForActivitySnapshotDelivery();

    const failures = selected
      .map((tracked) => this.activitySnapshotDeliveryErrors.get(tracked.activityKey))
      .filter(Boolean);
    if (failures.length) {
      for (const tracked of selected) tracked.finalized = false;
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Thinking activity snapshot delivery failed.');
    }
    for (const tracked of selected) {
      this.thinkingActivityAggregator.release(tracked.identity);
      this.thinkingActivities.delete(tracked.activityKey);
      this.activitySnapshotDeliveryErrors.delete(tracked.activityKey);
    }
    return snapshots;
  }

  async discardThinkingActivities() {
    if (!this.thinkingActivityAggregator) return;
    this.pendingActivitySnapshots.clear();
    const inFlight = this.activitySnapshotDeliveryInFlight;
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    this.pendingActivitySnapshots.clear();
    for (const tracked of this.thinkingActivities.values()) {
      this.thinkingActivityAggregator.release(tracked.identity);
    }
    this.thinkingActivities.clear();
    this.activitySnapshotDeliveryErrors.clear();
  }

  async start() {
    if (this.stopRequested) {
      const error = new Error('Managed Codex startup was cancelled before spawn.');
      error.code = 'session_start_cancelled';
      error.failureState = 'failed:start-cancelled';
      throw error;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.startupStateDbCorruption = false;
      this.startupStateDbDiagnostic = null;
      try {
        await this.startOnce();
        if (this.stopRequested) {
          const error = new Error('Managed Codex startup was cancelled before confirmation.');
          error.code = 'session_start_cancelled';
          error.failureState = 'failed:start-cancelled';
          throw error;
        }
        this.startCompleted = true;
        return;
      } catch (error) {
        const startupError = codexStateDatabaseStartupError(error, this.startupStateDbDiagnostic);
        if (attempt === 0 && this.startupStateDbCorruption) {
          try {
            await this.stopChildForStartupRetry();
          } catch (stopError) {
            this.startupStateDbCorruption = false;
            stopError.cause = stopError.cause || startupError;
            throw stopError;
          }
          const repair = quarantineCodexStateDatabases(this.codexHome, 'startup');
          await this.emitDiagnostic({
            severity: repair.moved.length ? 'warning' : 'error',
            source: 'runtime',
            kind: 'sqlite-repair',
            message: repair.moved.length
              ? 'Moved corrupted Codex SQLite state files and retrying app-server startup.'
              : 'Codex SQLite state looked corrupted, but no state files could be moved automatically.',
            data: repair,
          }).catch(() => {});
          if (repair.moved.length) {
            continue;
          }
        }
        this.startupStateDbCorruption = false;
        throw startupError;
      }
    }
  }

  async stopChildForStartupRetry() {
    if (this.terminationPromise || this.overlayCleaned) {
      const error = new Error('Codex startup retry cannot reuse a finalized managed overlay.');
      error.code = 'session_start_retry_overlay_finalized';
      throw error;
    }
    const child = this.child;
    if (!child) {
      this.rpc = null;
      return;
    }

    let resolveExitConfirmation;
    const exitConfirmation = new Promise((resolve) => {
      resolveExitConfirmation = resolve;
    });
    const onExit = (code, signal) => {
      resolveExitConfirmation();
      this.handleExit(code, signal).catch(() => {});
    };
    child.once('exit', onExit);
    this.startupRetryExitResolver = resolveExitConfirmation;
    if (
      this.startupRetryExit
      || child.exitCode !== null
      || child.signalCode !== null
    ) {
      resolveExitConfirmation();
    }
    const waitForExit = async (timeoutMs) => {
      let timer = null;
      const confirmed = await Promise.race([
        exitConfirmation.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      return confirmed;
    };

    try {
      let confirmed = Boolean(
        this.startupRetryExit
        || child.exitCode !== null
        || child.signalCode !== null
      );
      if (!confirmed) {
        try {
          child.kill();
        } catch {
          // The exit confirmation below remains authoritative.
        }
        confirmed = await waitForExit(this.stopGraceTimeoutMs);
      }
      if (!confirmed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The bounded confirmation below decides whether retry is safe.
        }
        confirmed = await waitForExit(this.stopKillTimeoutMs);
      }
      if (!confirmed) {
        const error = new Error(
          `Codex app-server did not confirm exit before SQLite retry after ${this.stopGraceTimeoutMs + this.stopKillTimeoutMs}ms.`
        );
        error.code = 'session_stop_timeout';
        error.processTreeFallbackRequired = true;
        throw error;
      }
    } finally {
      child.off('exit', onExit);
      this.startupRetryExitResolver = null;
    }

    if (this.terminationPromise || this.overlayCleaned) {
      const error = new Error('Codex startup retry overlay was finalized while stopping the first child.');
      error.code = 'session_start_retry_overlay_finalized';
      throw error;
    }
    if (!updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
      childPid: child.pid || null,
      childState: 'exited',
    })) {
      const error = new Error('Managed Codex overlay ownership could not confirm the first retry child exit.');
      error.code = 'session_overlay_ownership_update_failed';
      throw error;
    }
    this.child = null;
    this.rpc = null;
    this.childExitConfirmed = false;
    this.startupRetryExit = null;
  }

  threadOpenApiParams() {
    const profileProvider = String(this.apiProviderKey || '').trim();
    if (profileProvider) return { modelProvider: profileProvider };
    const hostProvider = this.apiBinding?.kind === 'host_environment'
      ? String(this.apiBinding.modelProviderHint || '').trim()
      : '';
    return hostProvider ? { modelProvider: hostProvider } : {};
  }

  async openThread(threadApiParams = {}) {
    const startFreshThread = async (reason = null) => {
      const usesTranscript = this.forceTranscriptFallback || this.launchMode === 'transcript_fallback';
      if (reason) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'native-thread-fallback',
          message: usesTranscript
            ? 'Native Codex thread was not available; started a live session from transcript context instead.'
            : 'The previous Codex thread has no resumable rollout; starting a new thread for Rebind.',
          detail: String(reason.message || reason).slice(0, 500),
        }).catch(() => {});
      }
      await this.emitRuntime({
        connection: 'ready',
        phase: 'starting-thread',
        startupStep: reason ? 'thread-start-fallback' : 'thread-start',
        busy: true,
      });
      await this.emitDiagnostic({
        severity: reason ? 'warning' : 'info',
        source: 'codex',
        kind: 'lifecycle',
        method: 'thread/start',
        message: reason
          ? usesTranscript
            ? 'Starting a fallback Codex thread from transcript context.'
            : 'Starting a new Codex thread because the Rebind source has no rollout.'
          : 'Starting a new Codex thread.',
        detail: reason ? String(reason.message || reason).slice(0, 500) : undefined,
        data: {
          launchMode: this.launchMode,
          nativeThreadId: this.nativeThreadId || null,
        },
      }).catch(() => {});
      let thread;
      try {
        thread = await this.rpc.request('thread/start', {
          cwd: this.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          personality: 'friendly',
          ...threadApiParams,
        }, this.threadOpenRequestTimeoutMs);
      } catch (error) {
        throw classifyThreadStartError(error);
      }
      this.runtime.resumeStrategy = usesTranscript
        ? 'transcript_fallback'
        : resumeStrategyForLaunchMode(this.launchMode);
      return thread;
    };

    const resumeNativeThread = async (nativeThreadId) => {
      await this.emitRuntime({
        connection: 'ready',
        phase: 'resuming-thread',
        startupStep: 'thread-resume',
        busy: true,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'lifecycle',
        method: 'thread/resume',
        message: `Resuming Codex thread ${limitText(nativeThreadId, 64)}.`,
        data: {
          launchMode: this.launchMode,
          nativeThreadId,
        },
      }).catch(() => {});
      const thread = await this.rpc.request('thread/resume', {
        threadId: nativeThreadId,
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        personality: 'friendly',
        ...threadApiParams,
        ...(this.nativeResumeProviderKey ? { modelProvider: this.nativeResumeProviderKey } : {}),
      }, this.threadOpenRequestTimeoutMs);
      this.runtime.resumeStrategy = 'native_resume';
      return thread;
    };

    // A cross-binding Rebind is intentionally never allowed to enter a
    // native resume/fork path, even when an older queued command still says
    // "resume".  The durable flag is authoritative over legacy launch mode.
    if (
      this.forceTranscriptFallback
      && ['resume', 'fresh_rebind', 'fork'].includes(this.launchMode)
    ) {
      this.launchMode = 'fresh_rebind';
      this.nativeThreadId = null;
      this.rebindNativeThreadId = null;
      this.nativeResumeReady = false;
      this.runtime.launchMode = 'fresh_rebind';
      this.runtime.nativeThreadId = null;
      this.runtime.nativeResumeReady = false;
      return startFreshThread(new Error('Cross-API Rebind requires transcript fallback.'));
    }

    if (this.launchMode === 'resume') {
      if (!this.nativeThreadId) {
        throw classifyNativeThreadError('resume', new Error('native thread id is missing'));
      }
      try {
        return await resumeNativeThread(this.nativeThreadId);
      } catch (error) {
        // An explicit Rebind still targets the original native rollout.
        // Starting a blank thread here would preserve the Session id while
        // silently discarding hidden history, tool state, and reasoning.
        // The caller must choose the separate transcript-fallback action.
        this.nativeResumeReady = false;
        this.runtime.nativeResumeReady = false;
        throw classifyNativeThreadError('resume', error);
      }
    }

    if (this.launchMode === 'fork') {
      if (!this.nativeThreadId) {
        throw classifyNativeThreadError('fork', new Error('native thread id is missing'));
      }
      try {
        await this.emitRuntime({
          connection: 'ready',
          phase: 'forking-thread',
          startupStep: 'thread-fork',
          busy: true,
        });
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: 'lifecycle',
          method: 'thread/fork',
          message: `Forking Codex thread ${limitText(this.nativeThreadId, 64)}.`,
          data: {
            launchMode: this.launchMode,
            nativeThreadId: this.nativeThreadId,
          },
        }).catch(() => {});
        const thread = await this.rpc.request('thread/fork', {
          threadId: this.nativeThreadId,
          cwd: this.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          ephemeral: false,
          threadSource: 'user',
          ...threadApiParams,
          ...(this.nativeResumeProviderKey ? { modelProvider: this.nativeResumeProviderKey } : {}),
        }, this.threadOpenRequestTimeoutMs);
        this.runtime.resumeStrategy = 'native_fork';
        return thread;
      } catch (error) {
        throw classifyNativeThreadError('fork', error);
      }
    }

    if (this.launchMode === 'transcript_fallback') {
      if (!this.resumePrelude) {
        const error = new Error('Transcript fallback requires non-empty bounded history.');
        error.code = 'session_history_unavailable';
        throw error;
      }
      return startFreshThread(new Error('Explicit transcript fallback requested.'));
    }

    if (
      this.launchMode === 'fresh_rebind'
      && this.explicitRebind
      && this.rebindNativeThreadId
      && !this.forceTranscriptFallback
    ) {
      try {
        const thread = await resumeNativeThread(this.rebindNativeThreadId);
        this.launchMode = 'resume';
        this.nativeThreadId = this.rebindNativeThreadId;
        this.nativeResumeReady = true;
        this.runtime.launchMode = 'resume';
        this.runtime.nativeResumeReady = true;
        return thread;
      } catch (error) {
        // A missing rollout is a native resume failure, not permission to
        // create an empty replacement under the same Rebind identity.
        this.nativeResumeReady = false;
        this.runtime.nativeResumeReady = false;
        throw classifyNativeThreadError('resume', error);
      }
    }

    return startFreshThread();
  }

  async startOnce() {
    const processHome = this.profileHomeDir || path.dirname(this.baseCodexHome);
    const threadApiParams = this.threadOpenApiParams();
    if (!updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
      childPid: null,
      childState: 'spawning',
    })) {
      const error = new Error('Managed Codex overlay ownership could not enter spawning state.');
      error.code = 'session_overlay_ownership_update_failed';
      throw error;
    }
    try {
      this.child = this.spawnProcess(this.codexBin, this.codexArgs, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: shouldSpawnCodexThroughShell(this.codexBin),
        windowsHide: true,
        env: {
          ...buildApiProcessEnvironment(process.env, this.apiConfig),
          CODEX_HOME: this.codexHome,
          PATH: buildCodexProcessPath(this.codexBin),
          HOME: processHome,
          USERPROFILE: processHome,
          HOMEDRIVE: (path.parse(processHome).root || process.env.HOMEDRIVE || '').replace(/\\$/, ''),
          HOMEPATH: processHome.replace(/^[A-Za-z]:/, '') || process.env.HOMEPATH || '',
        },
      });
    } catch (error) {
      updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
        childPid: null,
        childState: 'spawn-failed',
      });
      throw error;
    }
    let spawnError = null;
    let earlyExitError = null;
    let spawnHandshakeSettled = false;
    let resolveSpawnHandshake;
    let rejectSpawnHandshake;
    const spawnHandshake = new Promise((resolve, reject) => {
      resolveSpawnHandshake = resolve;
      rejectSpawnHandshake = reject;
    });
    const settleSpawnHandshake = (settle, value) => {
      if (spawnHandshakeSettled) return;
      spawnHandshakeSettled = true;
      settle(value);
    };
    const onEarlyError = (error) => {
      spawnError = error;
      this.emitAlert({
        severity: 'error',
        source: 'runtime',
        message: `codex app-server failed to start: ${formatCodexStartError(error)}`,
      }).catch(() => {});
      settleSpawnHandshake(rejectSpawnHandshake, error);
    };
    const onEarlyExit = (code, signal) => {
      earlyExitError = new Error(`codex app-server exited early: ${code ?? 'null'} / ${signal ?? 'null'}`);
      settleSpawnHandshake(rejectSpawnHandshake, earlyExitError);
      this.handleExit(code, signal).catch(() => {});
    };
    const onSpawned = () => {
      try {
        if (!this.child.pid) {
          const error = new Error('Codex app-server spawn did not provide a child PID.');
          error.code = 'session_spawn_pid_missing';
          throw error;
        }
        if (!updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
          childPid: this.child.pid,
          childState: 'running',
        })) {
          const error = new Error('Managed Codex overlay ownership could not record the spawned child.');
          error.code = 'session_overlay_ownership_update_failed';
          throw error;
        }
        settleSpawnHandshake(resolveSpawnHandshake);
      } catch (error) {
        settleSpawnHandshake(rejectSpawnHandshake, error);
      }
    };
    this.child.once('error', onEarlyError);
    this.child.once('exit', onEarlyExit);
    this.child.once('spawn', onSpawned);

    try {
      await spawnHandshake;
    } catch (error) {
      if (error === spawnError) throw new Error(formatCodexStartError(error));
      throw error;
    }

    await this.emitRuntime({
      connection: 'connecting',
      phase: 'booting',
      startupStep: 'spawned-app-server',
      busy: true,
    });
    if (spawnError) throw new Error(formatCodexStartError(spawnError));
    if (earlyExitError) throw earlyExitError;

    const stderr = readline.createInterface({
      input: this.child.stderr,
      crlfDelay: Infinity,
    });

    stderr.on('line', async (line) => {
      const text = stripAnsi(line);
      const summary = text.length > 420 ? `${text.slice(0, 417)}...` : text;
      const stateDbDiagnostic = buildCodexStateDatabaseDiagnostic(text, this.codexHome);
      if (stateDbDiagnostic) {
        this.startupStateDbDiagnostic = preferCodexStateDatabaseDiagnostic(
          this.startupStateDbDiagnostic,
          stateDbDiagnostic
        );
        if (stateDbDiagnostic.quarantine) {
          this.startupStateDbCorruption = true;
        }
        await this.emitDiagnostic({
          severity: 'error',
          source: 'stderr',
          kind: 'runtime-startup',
          message: stateDbDiagnostic.message,
          detail: stateDbDiagnostic.detail,
          data: stateDbDiagnostic.data,
        }).catch(() => {});
        await this.emitAlert({
          severity: 'error',
          source: 'runtime',
          message: stateDbDiagnostic.detail,
        }).catch(() => {});
        return;
      }
      if (isRuntimeDiagnosticStderrLine(text)) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'stderr',
          kind: 'runtime-startup',
          message: summary,
        }).catch(() => {});
        return;
      }
      if (!shouldSurfaceStderrLine(text)) {
        return;
      }
      await this.emitAlert({
        severity: 'warning',
        source: 'stderr',
        message: summary,
      }).catch(() => {});
    });

    const rpc = new JsonRpcSession(this.child, {
      onNotification: (message) => {
        this.enqueueNotification(message);
      },
      onServerRequest: (message) => this.handleServerRequest(message, { rpc }),
      onRawStdout: () => {},
      onError: (error) => {
        this.emitAlert({
          severity: 'error',
          source: 'runtime',
          message: `codex app-server failed to start: ${formatCodexStartError(error)}`,
        }).catch(() => {});
      },
      onExit: (code, signal) => {
        this.handleExit(code, signal).catch(() => {});
      },
    });
    this.rpc = rpc;
    this.child.off('error', onEarlyError);
    this.child.off('exit', onEarlyExit);
    if (spawnError) throw new Error(formatCodexStartError(spawnError));
    if (earlyExitError) throw earlyExitError;

    await this.emitRuntime({
      connection: 'connecting',
      phase: 'initializing',
      startupStep: 'initialize-app-server',
      busy: true,
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'lifecycle',
      method: 'app-server/initialize',
      message: 'Initializing Codex app-server.',
      data: {
        launchMode: this.launchMode,
        nativeThreadId: this.nativeThreadId || null,
        codexHome: this.codexHome,
        processHome,
      },
    }).catch(() => {});
    await this.rpc.request('initialize', {
      clientInfo: {
        name: 'mobile-codex-remote',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }, this.initializeRequestTimeoutMs);

    await this.emitRuntime({
      connection: 'ready',
      phase: 'opening-thread',
      startupStep: 'opening-thread',
      busy: true,
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'api-profile',
      message: this.apiConfig
        ? `Using API profile ${describeApiConfig(this.apiConfig)}.`
        : 'Using host environment API configuration.',
      data: {
        apiProfileId: this.apiConfig?.profileId || null,
        apiProfileLabel: this.apiConfig?.label || null,
        apiProvider: this.apiConfig?.provider || null,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey || null,
        baseCodexHome: this.baseCodexHome,
        codexHome: this.codexHome,
        isolatedCodexHome: this.isolatedCodexHome,
        processHome,
      },
    });

    this.threadOpenConfirmed = false;
    const expectedResumeThreadId = this.launchMode === 'resume'
      ? String(this.nativeThreadId || '').trim()
      : this.launchMode === 'fresh_rebind' && this.explicitRebind
        ? String(this.rebindNativeThreadId || '').trim()
        : '';
    const thread = await this.openThread(threadApiParams);

    this.threadId = thread?.thread?.id || null;
    if (!this.threadId) {
      throw new Error('app-server did not return thread.id');
    }
    if (
      expectedResumeThreadId
      && this.launchMode === 'resume'
      && this.threadId !== expectedResumeThreadId
    ) {
      const error = new Error(
        `app-server resumed unexpected thread ${this.threadId}; expected ${expectedResumeThreadId}`
      );
      error.code = 'session_native_resume_identity_mismatch';
      error.failureState = 'failed:native-resume';
      throw error;
    }
    this.threadOpenConfirmed = true;
    this.sessionId = this.threadId;
    this.nativeThreadId = this.threadId;
    this.runtime.nativeThreadId = this.threadId;
    await this.publishManagedSessionRollout('thread-opened');
    await this.emitRuntime({
      connection: 'ready',
      threadId: this.threadId,
      nativeResumeReady: this.runtime.nativeResumeReady === true,
      ...this.confirmedThreadOpenRuntimePatch(),
    });
  }

  async annotateTurnStartRejection(error, inputItems, context = {}) {
    const originalError = error instanceof Error
      ? error
      : new Error(String(error || 'Codex turn/start failed.'));
    const rawMessage = [
      originalError.message,
      originalError.additionalDetails,
    ].filter(Boolean).join('\n').trim();
    const inputTypes = (Array.isArray(inputItems) ? inputItems : [])
      .map((item) => String(item?.type || '').trim())
      .filter(Boolean);
    const inputCapabilityError = classifyCodexInputCompatibilityError(rawMessage, inputTypes);
    if (!inputCapabilityError) {
      return originalError;
    }

    // Keep the provider response available to diagnostics while making the
    // command failure safe and actionable for the user-facing path.
    originalError.rawMessage = rawMessage;
    originalError.inputCapabilityError = inputCapabilityError;
    originalError.userFacingMessage = inputCapabilityError.userMessage;
    originalError.code = inputCapabilityError.code;
    originalError.message = inputCapabilityError.userMessage;

    try {
      await this.emitDiagnostic({
        severity: 'error',
        source: 'codex',
        kind: 'input-capability',
        method: context.method || 'turn/start',
        message: inputCapabilityError.userMessage,
        detail: rawMessage,
        data: {
          code: inputCapabilityError.code,
          kind: inputCapabilityError.kind,
          inputTypes: inputCapabilityError.inputTypes,
          rawMessage,
          ...(context.fallback === true ? { fallback: true } : {}),
        },
        clientRequestId: this.activeClientRequestId,
      });
    } catch {
      // Diagnostic delivery must never hide the original turn/start rejection.
    }
    return originalError;
  }

  classifyTurnStartAcceptanceError(error) {
    const candidate = error instanceof Error
      ? error
      : new Error(String(error || 'Codex turn/start failed.'));
    const rpcMethod = String(candidate.rpcMethod || '').trim();
    const isTurnStartTimeout = candidate.code === 'codex_rpc_request_timeout'
      && (!rpcMethod || rpcMethod === 'turn/start');
    if (!isTurnStartTimeout) {
      return candidate;
    }

    // JsonRpcSession removes a timed-out request from its pending map. The
    // native app-server may nevertheless have accepted the turn and emit its
    // notifications later, so retain the client identity and fail closed
    // instead of allowing a retry with a second request id.
    candidate.nativeErrorCode ||= candidate.code;
    candidate.acceptanceUnknown = true;
    candidate.code = 'session_input_acceptance_unknown';
    return candidate;
  }

  async sendInput(text, options = {}) {
    if (this.inputSubmissionInFlight || (this.activeClientRequestId && !this.activeTurnId)) {
      const error = new Error('Codex is still accepting the previous prompt.');
      error.code = 'session_input_preparing';
      throw error;
    }
    if (this.activeTurnId) {
      const error = new Error('Codex is still working on the previous turn.');
      error.code = 'session_turn_active';
      throw error;
    }
    this.inputSubmissionInFlight = true;
    this.activeClientRequestId = String(options.clientRequestId || '').trim() || null;
    this.beginTurnLifecycle();
    try {
      const turnId = await this.sendInputUnchecked(text, options);
      if (!turnId) {
        this.activeClientRequestId = null;
        this.activeSubmissionAttempt = null;
      }
      return turnId;
    } catch (error) {
      const failedClientRequestId = this.activeClientRequestId;
      if (error?.code === 'session_input_acceptance_unknown') {
        const observedTurnId = String(this.activeTurnId || '').trim();
        const attempt = this.activeSubmissionAttempt
          || this.submissionAttemptForTurn(observedTurnId);
        const reconciliationMetadata = {
          ...(attempt || {}),
          ...(error.submissionReconciliation || {}),
          clientRequestId: failedClientRequestId,
        };
        if (
          observedTurnId
          && failedClientRequestId
          && this.clientRequestIdForTurn(observedTurnId) === failedClientRequestId
        ) {
          this.turnModes.set(
            observedTurnId,
            String(reconciliationMetadata.mode || '').trim() || 'default'
          );
          this.turnInputTypes.set(
            observedTurnId,
            Array.isArray(reconciliationMetadata.inputTypes)
              ? reconciliationMetadata.inputTypes.slice(0, 8)
              : []
          );
          if (
            reconciliationMetadata.mode === 'plan'
            && String(this.runtime.phase || '').trim().toLowerCase() === 'thinking'
          ) {
            await this.emitRuntime({ phase: 'planning' });
          }
        } else {
          this.scheduleSubmissionReconciliation(reconciliationMetadata);
        }
      } else {
        await this.settlePendingInterruptForSubmissionFailure(failedClientRequestId, error);
        if (
          !this.activeSubmissionAttempt
          || !failedClientRequestId
          || this.activeSubmissionAttempt.clientRequestId === failedClientRequestId
        ) {
          this.activeSubmissionAttempt = null;
        }
        if (this.activeClientRequestId === failedClientRequestId) {
          this.activeClientRequestId = null;
        }
      }
      throw error;
    } finally {
      this.inputSubmissionInFlight = false;
    }
  }

  async sendInputUnchecked(text, options = {}) {
    if (!this.threadId) {
      throw new Error('codex thread is not ready yet');
    }

    const explicitBinding = options.apiBinding || (options.apiConfig
      ? deriveRunBinding({ apiConfig: options.apiConfig, allowUnavailable: true })
      : null);
    this.assertCommandBinding(explicitBinding);
    this.validateModelSelection(options.model, options.effort);

    if (this.activeTurnId) {
      const error = new Error('Codex is still working on the previous turn.');
      error.code = 'session_turn_active';
      throw error;
    }

    const normalizedItems = normalizeInputItems(text, options);
    if (!normalizedItems.length) {
      return null;
    }

    let prompt = String(text || '').trim();
    if (!this.resumePreludeUsed && this.resumePrelude) {
      prompt = `${this.resumePrelude}\n\nNew user request:\n${prompt}`;
      this.resumePreludeUsed = true;
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'lifecycle',
        method: 'thread/resume-prelude',
        message: 'Continuing from imported history context.',
      });
    }

    let collaborationMode = normalizeOfficialCollaborationMode(options.collaborationMode);
    const mode = String(options.mode || '').trim();
    if (!collaborationMode && mode === 'plan') {
      try {
        collaborationMode = await this.getOfficialCollaborationMode('plan');
      } catch (error) {
        if (String(options.planFallback || '').trim() !== 'local' || !shouldUseLocalPlanFallback(error)) {
          throw error;
        }
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'control',
          method: 'collaborationMode/list',
          message: `Native Codex Plan is unavailable; using Local Plan fallback: ${error.message}`,
          data: { error: error.message },
        });
      }
    }

    const localPlanFallback = mode === 'plan' && !collaborationMode && String(options.planFallback || '').trim() === 'local';
    const effectivePrompt = localPlanFallback
      ? buildLocalPlanPrompt(prompt, normalizedItems.some((item) => item.type === 'image' || item.type === 'localImage'))
      : prompt;
    const effectiveOptions = localPlanFallback
      ? {
        ...options,
        collaborationMode: null,
        approvalPolicy: 'never',
        sandboxMode: 'readOnly',
      }
      : options;

    const params = normalizeTurnStartParams(this.threadId, this.cwd, effectivePrompt, effectiveOptions);
    if (collaborationMode) {
      params.collaborationMode = collaborationMode;
    }
    this.activeSubmissionAttempt = this.createSubmissionAttempt(params, {
      mode: collaborationMode?.mode || mode || 'default',
    });
    await this.emitRuntime({
      activeTurnId: null,
      busy: true,
      phase: 'submitting-turn',
      currentTurnStatus: 'submitting',
      pendingClientRequestId: this.activeClientRequestId || null,
      pendingInputSummary: limitText(effectivePrompt, 240),
      terminalReconciliation: null,
      lastError: null,
      lastCodexError: null,
      userFacingError: null,
      model: params.model || null,
      effort: params.effort || null,
      summary: params.summary || null,
      collaborationMode: params.collaborationMode || null,
      approvalPolicy: params.approvalPolicy || null,
      approvalsReviewer: params.approvalsReviewer || null,
      sandboxPolicy: params.sandboxPolicy || null,
    });
    let turn = null;
    try {
      turn = await this.rpc.request('turn/start', params, TURN_START_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (
        mode === 'plan'
        && collaborationMode
        && String(options.planFallback || '').trim() === 'local'
        && shouldUseLocalPlanFallback(error)
      ) {
        this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'control',
          method: 'turn/start',
          message: `Native Codex Plan turn failed; retrying with Local Plan fallback: ${error.message}`,
          data: { error: error.message, collaborationMode },
        }).catch(() => {});
        const fallbackParams = normalizeTurnStartParams(
          this.threadId,
          this.cwd,
          buildLocalPlanPrompt(prompt, normalizedItems.some((item) => item.type === 'image' || item.type === 'localImage')),
          {
            ...options,
            collaborationMode: null,
            approvalPolicy: 'never',
            sandboxMode: 'readOnly',
          }
        );
        try {
          this.activeSubmissionAttempt = this.createSubmissionAttempt(fallbackParams, {
            mode: 'default',
          });
          turn = await this.rpc.request('turn/start', fallbackParams, TURN_START_REQUEST_TIMEOUT_MS);
        } catch (fallbackError) {
          const rolloutPublication = await this.publishManagedSessionRollout('turn-rejected');
          if (rolloutPublication.becameNativeResumeReady) {
            await this.emitRuntime({ nativeResumeReady: true }).catch(() => {});
          }
          fallbackError = await this.annotateTurnStartRejection(
            fallbackError,
            normalizedItems,
            { method: 'turn/start', fallback: true }
          );
          fallbackError = this.classifyTurnStartAcceptanceError(fallbackError);
          fallbackError.code ||= /^Timed out waiting for turn\/start/i.test(String(fallbackError.message || ''))
            ? 'session_input_acceptance_unknown'
            : 'session_turn_start_failed';
          if (fallbackError.code === 'session_input_acceptance_unknown') {
            fallbackError.submissionReconciliation = this.submissionAttemptMetadata(
              this.activeSubmissionAttempt,
              fallbackError.submissionReconciliation
            );
          }
          throw fallbackError;
        }
        Object.keys(params).forEach((key) => delete params[key]);
        Object.assign(params, fallbackParams);
        collaborationMode = null;
      } else {
        const rolloutPublication = await this.publishManagedSessionRollout('turn-rejected');
        if (rolloutPublication.becameNativeResumeReady) {
          await this.emitRuntime({ nativeResumeReady: true }).catch(() => {});
        }
        error = await this.annotateTurnStartRejection(error, normalizedItems, { method: 'turn/start' });
        error = this.classifyTurnStartAcceptanceError(error);
        error.code ||= /^Timed out waiting for turn\/start/i.test(String(error.message || ''))
          ? 'session_input_acceptance_unknown'
          : 'session_turn_start_failed';
        if (error.code === 'session_input_acceptance_unknown') {
          error.submissionReconciliation = this.submissionAttemptMetadata(
            this.activeSubmissionAttempt,
            error.submissionReconciliation
          );
        }
        throw error;
      }
    }

    const turnId = turn?.turn?.id || null;
    const rolloutPublication = await this.publishManagedSessionRollout('turn-accepted');
    const becameNativeResumeReady = rolloutPublication.becameNativeResumeReady === true;
    const turnAlreadyTerminal = this.isTerminalTurnId(turnId);
    let pendingInterruptApplied = false;
    if (turnId && !turnAlreadyTerminal) {
      this.cancelSubmissionReconciliation();
      this.rememberSubmissionAttemptTurn(turnId, this.activeSubmissionAttempt);
      this.activeSubmissionAttempt = null;
      this.activeTurnId = turnId;
      this.adoptTurnLifecycle(turnId);
      if (this.activeClientRequestId) {
        this.clientRequestIdsByTurn.set(turnId, this.activeClientRequestId);
      }
      this.resetTurnBuffer(turnId);
      this.turnModes.set(turnId, collaborationMode?.mode || mode || 'default');
      this.turnInputTypes.set(
        turnId,
        params.input.map((item) => String(item?.type || '').trim()).filter(Boolean).slice(0, 8)
      );
      pendingInterruptApplied = await this.applyPendingInterruptIntent(turnId);
      if (!pendingInterruptApplied) {
        void this.emitActiveTurnRuntimeWithRetry(turnId, {
          ...(becameNativeResumeReady ? { nativeResumeReady: true } : {}),
          clientRequestId: this.activeClientRequestId,
          activeTurnId: turnId,
          pendingClientRequestId: null,
          busy: true,
          phase: (collaborationMode?.mode === 'plan' || mode === 'plan') ? 'planning' : 'thinking',
          currentTurnStatus: 'inProgress',
          lastError: null,
          lastCodexError: null,
          userFacingError: null,
          model: params.model || null,
          effort: params.effort || null,
          summary: params.summary || null,
          collaborationMode: params.collaborationMode || null,
          approvalPolicy: params.approvalPolicy || null,
          approvalsReviewer: params.approvalsReviewer || null,
          sandboxPolicy: params.sandboxPolicy || null,
          reasoningSummary: null,
          planSummary: null,
        });
      } else if (becameNativeResumeReady) {
        this.emitRuntime({ nativeResumeReady: true }).catch(() => {});
      }
    } else if (becameNativeResumeReady) {
      this.emitRuntime({ nativeResumeReady: true }).catch(() => {});
    }
    if (turnId && turnAlreadyTerminal) {
      this.rememberSubmissionAttemptTurn(turnId, this.activeSubmissionAttempt);
      this.activeSubmissionAttempt = null;
    }
    this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'turn/start',
      message: collaborationMode?.mode === 'plan'
        ? 'Started a plan-mode turn.'
        : localPlanFallback
          ? 'Started a Local Plan fallback turn.'
          : 'Started a Codex turn.',
      data: {
        turnId,
        model: params.model || null,
        effort: params.effort || null,
        summary: params.summary || null,
        collaborationMode: params.collaborationMode || null,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey || null,
        codexHomeProfile: this.runtime.codexHomeProfile || null,
        approvalPolicy: params.approvalPolicy || null,
        approvalsReviewer: params.approvalsReviewer || null,
        sandboxPolicy: params.sandboxPolicy || null,
        localPlanFallback,
        inputTypes: params.input.map((item) => item.type),
      },
    }).catch(() => {});
    this.postEvent({
      type: 'session.selection_confirmed',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      model: params.model || null,
      effort: params.effort || null,
      effectiveBinding: this.apiBinding,
      timestamp: nowIso(),
    }).catch(() => {});
    return turnId;
  }

  async getOfficialCollaborationMode(modeName) {
    const response = await this.rpc.request('collaborationMode/list', {});
    const modes = Array.isArray(response?.data) ? response.data : [];
    const match = modes.find((entry) => String(entry?.mode || '').trim() === modeName)
      || modes.find((entry) => String(entry?.name || '').trim().toLowerCase() === modeName);
    if (!match) {
      throw new Error(`Codex app-server did not return an official ${modeName} collaboration mode.`);
    }
    const model = String(match.model || '').trim();
    if (!model) {
      throw new Error(`Official ${modeName} collaboration mode is missing required settings.model.`);
    }
    return {
      mode: modeName,
      settings: {
        model,
        reasoning_effort: match.reasoning_effort || match.reasoningEffort || null,
        developer_instructions: null,
      },
    };
  }

  async listModels(options = {}) {
    const response = await this.rpc.request('model/list', {
      cursor: options.cursor || null,
      includeHidden: options.includeHidden === true ? true : null,
      limit: Number(options.limit || 80) || 80,
    }, LIST_REQUEST_TIMEOUT_MS);
    const pageCapabilities = modelCapabilitiesFromList(response?.data || []);
    if (!options.cursor) {
      this.modelCapabilities.clear();
    }
    for (const [model, metadata] of pageCapabilities) {
      this.modelCapabilities.set(model, metadata);
    }
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'model/list',
      message: `Loaded ${Array.isArray(response?.data) ? response.data.length : 0} models.`,
      data: {
        nextCursor: response?.nextCursor || null,
      },
    });
    return {
      ...(response || { data: [], nextCursor: null }),
      bindingFingerprint: this.apiBinding?.bindingFingerprint || null,
      runId: this.runId,
    };
  }

  async listSkills(options = {}) {
    const cwd = String(options.cwd || this.cwd || '').trim();
    const response = await this.rpc.request('skills/list', {
      cwds: cwd ? [cwd] : undefined,
      forceReload: options.forceReload === true,
    }, LIST_REQUEST_TIMEOUT_MS);
    const entries = Array.isArray(response?.data) ? response.data : [];
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'skills/list',
      message: `Loaded ${entries.reduce((sum, entry) => sum + (Array.isArray(entry?.skills) ? entry.skills.length : 0), 0)} skills.`,
      data: {
        cwd: cwd || null,
        entries: entries.length,
      },
    });
    return response || { data: [] };
  }

  async startReview(options = {}) {
    if (!this.threadId) {
      throw new Error('No thread is available for review.');
    }

    if (
      this.activeTurnId
      || this.reviewInFlight
      || this.pendingInterruptIntent
      || this.hasPendingApprovalOrInputRequest()
    ) {
      const error = new Error('Codex is still working on the previous turn.');
      error.code = 'session_turn_active';
      throw error;
    }
    if (this.hasUnconfirmedSubmission()) {
      const error = new Error('Codex is still accepting the previous prompt.');
      error.code = 'session_input_preparing';
      throw error;
    }
    this.reviewInFlight = true;
    this.beginTurnLifecycle();

    const target = normalizeReviewTarget(options);
    const delivery = String(options.delivery || 'inline').trim() === 'detached' ? 'detached' : 'inline';
    await this.emitRuntime({
      busy: true,
      phase: 'reviewing',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'review/start',
      message: `Review requested: ${target.type}`,
      data: {
        target,
        delivery,
      },
    });

    try {
      const response = await this.rpc.request('review/start', {
        threadId: this.threadId,
        target,
        delivery,
      });
      const turnId = response?.turn?.id || null;
      if (turnId) {
        this.activeTurnId = turnId;
        this.adoptTurnLifecycle(turnId);
        this.resetTurnBuffer(turnId);
        await this.emitRuntime({
          activeTurnId: turnId,
          busy: true,
          phase: 'reviewing',
          currentTurnStatus: response?.turn?.status?.type || 'inProgress',
        });
      } else {
        await this.emitRuntime({
          busy: false,
          phase: 'idle',
          currentTurnStatus: 'completed',
        });
      }
      await this.postEvent({
        type: 'session.review_started',
        hostId: this.hostId,
        sessionId: this.currentSessionId(),
        runId: this.runId,
        reviewThreadId: response?.reviewThreadId || null,
        turnId,
        target,
        delivery,
        timestamp: nowIso(),
      });
      return response;
    } catch (error) {
      await this.emitRuntime({
        activeTurnId: null,
        busy: false,
        phase: 'error',
        currentTurnStatus: 'failed',
        lastError: error?.message || String(error),
      }).catch(() => {});
      error.code ||= 'session_review_start_failed';
      throw error;
    } finally {
      this.reviewInFlight = false;
    }
  }

  cleanupManagedOverlay() {
    if (this.overlayCleaned) return false;
    const cleanupOwner = this.apiProfileCleanupOwner;
    if (!cleanupOwner) return false;
    const cleaned = cleanupApiProfileCodexHome(cleanupOwner);
    if (cleaned) {
      this.overlayCleaned = true;
      this.overlayCleanupRetryAttempt = 0;
      this.overlayCleanupLastError = null;
      if (this.overlayCleanupRetryTimer) {
        clearTimeout(this.overlayCleanupRetryTimer);
        this.overlayCleanupRetryTimer = null;
      }
    }
    return cleaned;
  }

  scheduleManagedOverlayCleanupRetry(context) {
    if (
      this.overlayCleaned
      || !this.apiProfileCleanupOwner
      || this.overlayCleanupRetryTimer
    ) {
      return Boolean(this.overlayCleanupRetryTimer);
    }
    if (this.overlayCleanupRetryAttempt >= this.overlayCleanupRetryMaxAttempts) {
      return false;
    }
    const nextAttempt = this.overlayCleanupRetryAttempt + 1;
    const delayMs = this.overlayCleanupRetryDelayMs * nextAttempt;
    this.overlayCleanupRetryTimer = setTimeout(() => {
      this.overlayCleanupRetryTimer = null;
      if (this.overlayCleaned || !this.apiProfileCleanupOwner) return;
      this.overlayCleanupRetryAttempt = nextAttempt;
      try {
        if (this.cleanupManagedOverlay()) return;
        const error = new Error('Owned Codex overlay ownership could not be verified during retry.');
        error.code = 'session_overlay_cleanup_unverified';
        throw error;
      } catch (error) {
        const failure = managedOverlayCleanupError(
          error,
          this.apiProfileCleanupOwner.profileHomeDir
        );
        failure.cleanupContext = context;
        this.overlayCleanupLastError = failure;
        if (!this.scheduleManagedOverlayCleanupRetry(context)) {
          console.error(
            '[codex-runner] managed overlay cleanup retries exhausted'
            + ' (' + context + '): '
            + (failure.cause?.message || failure.message)
          );
        }
      }
    }, delayMs);
    this.overlayCleanupRetryTimer.unref?.();
    return true;
  }

  deferManagedOverlayCleanup(error, context) {
    const target = this.apiProfileCleanupOwner?.profileHomeDir || this.profileHomeDir;
    const failure = managedOverlayCleanupError(error, target);
    failure.cleanupContext = context;
    this.overlayCleanupLastError = failure;
    const retryScheduled = this.scheduleManagedOverlayCleanupRetry(context);
    if (!this.overlayCleanupDiagnosticReported) {
      this.overlayCleanupDiagnosticReported = true;
      void this.emitDiagnostic({
        severity: 'warning',
        source: 'runtime',
        kind: 'managed-overlay-cleanup',
        message: retryScheduled
          ? 'Managed Codex session files could not be removed immediately; cleanup will retry in the background.'
          : 'Managed Codex session files could not be removed; startup recovery will retry later.',
        detail: failure.cause?.message || failure.message,
        data: {
          code: failure.cleanupErrorCode || failure.cause?.code || null,
          path: failure.path || target || null,
          context,
          retryScheduled,
        },
      }).catch((diagnosticError) => {
        console.error(
          '[codex-runner] managed overlay cleanup diagnostic failed: '
          + (diagnosticError?.message || diagnosticError)
        );
      });
    }
    if (!retryScheduled) {
      console.error(
        '[codex-runner] managed overlay cleanup deferred to startup recovery'
        + ' (' + context + '): '
        + (failure.cause?.message || failure.message)
      );
    }
    return failure;
  }

  cleanupManagedOverlayAfterExit(context) {
    if (this.overlayCleaned || !this.apiProfileCleanupOwner) return true;
    try {
      if (this.cleanupManagedOverlay()) return true;
      const error = new Error('Owned Codex overlay ownership could not be verified after process exit.');
      error.code = 'session_overlay_cleanup_unverified';
      throw error;
    } catch (error) {
      this.deferManagedOverlayCleanup(error, context);
      return false;
    }
  }

  applyStopOptions(options = {}) {
    if (options.stopCommandRequested === true) {
      this.stopCommandRequested = true;
    }
    if (options.suppressTerminalEvent === true || options.deferStartupTerminalEvent === true) {
      this.suppressTerminalEvent = true;
      if (!this.agentEventsSuppressed) {
        this.agentEventsSuppressed = true;
        // Ownership loss is terminal for this Agent instance. Prevent queued
        // notifications, activity snapshots, and exit cleanup from posting any
        // more events through a revoked lease.
        this.postEvent = async () => null;
      }
    }
  }

  stop(options = {}) {
    this.applyStopOptions(options);
    this.stopRequested = true;
    this.cancelThreadIdleReconciliation();
    this.cancelSubmissionReconciliation();
    this.cancelRuntimeProjectionRetry();
    this.clearActiveSubmissionAttempt();
    if (this.stopPromise) {
      return this.stopPromise;
    }
    let attemptPromise = null;
    attemptPromise = this.performStop().catch((error) => {
      if (this.stopPromise === attemptPromise) {
        this.stopPromise = null;
      }
      throw error;
    });
    this.stopPromise = attemptPromise;
    return attemptPromise;
  }

  async performStop() {
    const terminalErrors = [];
    const captureTerminalError = (error) => {
      const remaining = errorWithoutSuppressedTerminalDelivery(
        error,
        this.agentEventsSuppressed
      );
      if (remaining) terminalErrors.push(remaining);
    };
    if (
      this.agentEventsSuppressed
      && (this.thinkingActivities.size || this.activitySnapshotDeliveryErrors?.size)
    ) {
      await this.discardThinkingActivities();
    }
    const finishStop = () => {
      throwTerminalErrors(terminalErrors, 'Codex runner stop did not complete cleanly.');
    };
    try {
      const stoppingTurnId = String(this.activeTurnId || '').trim();
      if (stoppingTurnId) this.rememberTerminalTurnId(stoppingTurnId);
      await this.resolvePendingInterruptForTerminalTurn(stoppingTurnId, 'stopped');
    } catch (error) {
      captureTerminalError(error);
    }
    const child = this.child;
    if (!child) {
      if (!this.terminationPromise) {
        this.terminationPromise = this.finalizePreSpawnCancellation();
      }
      try {
        await this.terminationPromise;
      } catch (error) {
        captureTerminalError(error);
      }
      finishStop();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      try {
        if (this.terminationPromise) {
          await this.terminationPromise;
        } else {
          await this.handleExit(child.exitCode, child.signalCode);
        }
      } catch (error) {
        captureTerminalError(error);
      }
      finishStop();
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off('exit', finish);
        child.off('error', finish);
        resolve();
      };
      const timer = setTimeout(finish, this.stopGraceTimeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      child.once('exit', finish);
      child.once('error', finish);
      if (!child.killed) {
        child.kill();
      }
    });
    if (
      !this.terminationPromise
      && child.exitCode === null
      && child.signalCode === null
    ) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off('exit', finish);
          child.off('error', finish);
          resolve();
        };
        const timer = setTimeout(finish, this.stopKillTimeoutMs);
        timer.unref?.();
        child.once('exit', finish);
        child.once('error', finish);
        forceKillChildProcessTree(child);
      });
    }
    if (this.terminationPromise) {
      try {
        await this.terminationPromise;
      } catch (error) {
        captureTerminalError(error);
      }
    } else if (child.exitCode !== null || child.signalCode !== null) {
      try {
        await this.handleExit(child.exitCode, child.signalCode);
      } catch (error) {
        captureTerminalError(error);
      }
    } else {
      const error = new Error(
        `Codex app-server did not confirm exit after ${this.stopGraceTimeoutMs + this.stopKillTimeoutMs}ms.`
      );
      error.code = 'session_stop_timeout';
      error.processTreeFallbackRequired = true;
      terminalErrors.push(error);
    }
    finishStop();
  }

  async interruptActiveTurn(options = {}) {
    const interruptedTurnId = String(this.activeTurnId || '').trim();
    if (!this.threadId || !interruptedTurnId) {
      return {
        status: 'no_active',
        interruptRequestId: options.interruptRequestId || null,
        turnId: null,
        clientRequestId: this.activeClientRequestId || null,
      };
    }
    const ownership = this.captureActiveTurnOwnership();
    const interruptedClientRequestId = this.clientRequestIdForTurn(interruptedTurnId);
    const interruptingPatch = {
      clientRequestId: interruptedClientRequestId,
      busy: true,
      phase: 'interrupting',
      currentTurnStatus: 'inProgress',
    };
    try {
      await this.rpc.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: interruptedTurnId,
      });
    } catch (error) {
      if (this.isNoActiveTurnInterruptError(error) && this.activeTurnOwnershipMatches(ownership)) {
        await this.reconcileObservedInactiveTurn(ownership, {
          status: 'interrupted',
          reason: 'interrupt-confirmed-no-active-turn',
          method: 'turn/interrupt',
        });
        return {
          status: 'no_active',
          reason: 'native_no_active_turn',
          interruptRequestId: options.interruptRequestId || null,
          turnId: interruptedTurnId,
          clientRequestId: interruptedClientRequestId,
        };
      }
      throw error;
    }
    if (this.activeTurnOwnershipMatches(ownership)) {
      await this.emitActiveTurnRuntimeWithRetry(interruptedTurnId, interruptingPatch);
    }
    this.emitDiagnostic({
      severity: 'warning',
      source: 'codex',
      kind: 'control',
      method: 'turn/interrupt',
      message: 'Interrupt accepted; waiting for the matching turn terminal event.',
    }).catch(() => {});
    return {
      status: 'accepted',
      interruptRequestId: options.interruptRequestId || null,
      turnId: interruptedTurnId,
      clientRequestId: interruptedClientRequestId,
    };
  }

  async interruptTurn(options = {}) {
    const expectedTurnId = String(options.expectedTurnId || '').trim();
    const expectedClientRequestId = String(options.expectedClientRequestId || '').trim();
    const activeTurnId = String(this.activeTurnId || '').trim();
    const activeClientRequestId = activeTurnId
      ? String(this.clientRequestIdForTurn(activeTurnId) || '').trim()
      : String(this.activeClientRequestId || '').trim();

    if (
      (expectedTurnId && activeTurnId && expectedTurnId !== activeTurnId)
      || (expectedClientRequestId && activeClientRequestId && expectedClientRequestId !== activeClientRequestId)
    ) {
      return {
        status: 'no_active',
        interruptRequestId: options.interruptRequestId || null,
        turnId: activeTurnId || null,
        clientRequestId: activeClientRequestId || null,
        reason: 'active_turn_changed',
      };
    }

    // Completion clears activeTurnId before its asynchronous event delivery
    // releases the client ID. That residual ID is not an unstarted submission.
    // Also fence a late targeted interrupt from attaching to the next request.
    const terminalTurnId = [expectedTurnId, activeTurnId,
      ...Array.from(this.clientRequestIdsByTurn || [])
        .filter(([, clientId]) => clientId === activeClientRequestId)
        .map(([turnId]) => turnId),
    ].find((turnId) => turnId && this.isTerminalTurnId(turnId));
    if (terminalTurnId || (expectedTurnId && !activeTurnId)) {
      return {
        status: 'no_active',
        interruptRequestId: options.interruptRequestId || null,
        turnId: terminalTurnId || expectedTurnId,
        clientRequestId: this.clientRequestIdForTurn(terminalTurnId || expectedTurnId) || activeClientRequestId || null,
        reason: terminalTurnId ? 'turn_already_completed' : 'target_not_active',
      };
    }

    if (activeTurnId) {
      return this.interruptActiveTurn(options);
    }

    const submission = this.submissionCandidate();
    const submitting = this.inputSubmissionInFlight
      || (submission && this.submissionAttemptIdentityMatchesCurrent(submission));
    if (this.threadId && activeClientRequestId && submitting) {
      this.pendingInterruptIntent = {
        interruptRequestId: options.interruptRequestId || null,
        expectedClientRequestId: expectedClientRequestId || activeClientRequestId,
        requestedAt: nowIso(),
      };
      await this.emitRuntime({
        clientRequestId: activeClientRequestId,
        activeTurnId: null,
        busy: true,
        phase: 'interrupting',
        currentTurnStatus: 'submitting',
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'codex',
        kind: 'control',
        method: 'turn/interrupt',
        message: 'Interrupt is pending until Codex identifies the submitted turn.',
      });
      return {
        status: 'pending',
        interruptRequestId: options.interruptRequestId || null,
        turnId: null,
        clientRequestId: activeClientRequestId,
      };
    }

    return {
      status: 'no_active',
      interruptRequestId: options.interruptRequestId || null,
      turnId: null,
      clientRequestId: activeClientRequestId || null,
    };
  }

  async steerTurn(text, options = {}) {
    const expectedRunId = String(options.expectedRunId || '').trim();
    const expectedTurnId = String(options.expectedTurnId || '').trim();
    if (!expectedRunId || !expectedTurnId) {
      throw Object.assign(new Error('Steer requires the observed run and active turn.'), { code: 'steer_target_required' });
    }
    const threadId = this.threadId;
    const rpc = this.rpc;
    if (!threadId || !rpc || this.stopRequested || this.runId !== expectedRunId
      || this.activeTurnId !== expectedTurnId || this.isTerminalTurnId(expectedTurnId)) {
      throw Object.assign(new Error('The selected run or active turn changed before Guide could be sent.'), { code: 'steer_target_changed' });
    }
    const prompt = String(text || '').trim();
    if (!prompt) {
      throw Object.assign(new Error('Guide text is required.'), { code: 'steer_text_required' });
    }
    // No awaited publication before dispatch: the click targets this exact turn.
    // Steer does not start a turn or change its approval/interruption/runtime state.
    let result;
    try {
      result = await rpc.request('turn/steer', {
        threadId,
        expectedTurnId,
        input: [{ type: 'text', text: prompt }],
      });
    } catch (error) {
      if (error?.rpcCode == null) error.steerAcceptanceUnknown = true;
      throw error;
    }
    if (result?.turnId !== expectedTurnId) {
      throw Object.assign(new Error('Codex did not return a matching Guide acknowledgement. Delivery is unknown; do not resend automatically.'), {
        code: 'steer_acceptance_unknown', steerAcceptanceUnknown: true,
      });
    }
    return { status: 'accepted', turnId: result.turnId };
  }

  async compactThread(options = {}) {
    if (!this.threadId) {
      throw new Error('No thread is available to compact.');
    }

    const explicitBinding = options.apiBinding || (options.apiConfig
      ? deriveRunBinding({ apiConfig: options.apiConfig, allowUnavailable: true })
      : null);
    this.assertCommandBinding(explicitBinding);

    await this.emitRuntime({
      busy: true,
      phase: 'compacting',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'thread/compact/start',
      message: 'Thread compaction requested.',
      data: {
        threadId: this.threadId,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey || null,
        codexHomeProfile: this.runtime.codexHomeProfile || null,
      },
    });

    await this.rpc.request('thread/compact/start', {
      threadId: this.threadId,
    });
    return true;
  }

  async getGoal() {
    if (!this.threadId) {
      throw new Error('No thread is available for goal state.');
    }
    const response = await this.rpc.request('thread/goal/get', {
      threadId: this.threadId,
    });
    const goal = response?.goal || null;
    await this.emitRuntime({ goal });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'goal',
      method: 'thread/goal/get',
      message: goal ? `Goal loaded: ${goal.status || 'active'}` : 'No active goal.',
      data: { goal },
    });
    return goal;
  }

  async setGoal(options = {}) {
    if (!this.threadId) {
      throw new Error('No thread is available for goal state.');
    }
    const params = { threadId: this.threadId };
    if (Object.prototype.hasOwnProperty.call(options, 'objective')) {
      params.objective = String(options.objective || '').trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'status')) {
      params.status = String(options.status || '').trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'tokenBudget')) {
      const tokenBudget = Number(options.tokenBudget);
      params.tokenBudget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.floor(tokenBudget) : null;
    }
    const response = await this.rpc.request('thread/goal/set', params);
    const goal = response?.goal || null;
    await this.emitRuntime({ goal });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'goal',
      method: 'thread/goal/set',
      message: goal ? `Goal updated: ${goal.status || 'active'}` : 'Goal updated.',
      data: { goal, params },
    });
    return goal;
  }

  async clearGoal() {
    if (!this.threadId) {
      throw new Error('No thread is available for goal state.');
    }
    const response = await this.rpc.request('thread/goal/clear', {
      threadId: this.threadId,
    });
    await this.emitRuntime({ goal: null });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'goal',
      method: 'thread/goal/clear',
      message: response?.cleared === false ? 'Goal was already clear.' : 'Goal cleared.',
      data: response || null,
    });
    return response || { cleared: true };
  }

  async runShellCommand(command) {
    if (!this.threadId) {
      throw new Error('No thread is available for shell command execution.');
    }

    const shellCommand = String(command || '').trim();
    if (!shellCommand) {
      return null;
    }

    await this.emitRuntime({
      busy: true,
      phase: 'running-shell-command',
    });
    await this.emitDiagnostic({
      severity: 'warning',
      source: 'codex',
      kind: 'control',
      method: 'thread/shellCommand',
      message: `Shell command requested: ${limitText(shellCommand, 220)}`,
      data: {
        threadId: this.threadId,
        command: limitText(shellCommand, 400),
      },
    });

    await this.rpc.request('thread/shellCommand', {
      threadId: this.threadId,
      command: shellCommand,
    });
    return true;
  }

  async respondToRequest(requestId, response) {
    const key = String(requestId || '');
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      if (this.resolvedRequests.has(key)) {
        return {
          ok: true,
          duplicate: true,
          requestId: key,
        };
      }
      throw new Error(`No pending Codex request found for ${key}`);
    }

    if (!this.serverRequestOwnershipMatchesCurrent(pending.ownership)) {
      const error = new Error('This Codex request belongs to an inactive Run or Turn.');
      error.code = 'session_request_stale_runtime';
      throw error;
    }
    const owningRpc = pending.ownership?.rpc;

    if (pending.method === 'item/tool/requestUserInput') {
      await owningRpc.respond(pending.message.id, {
        answers: response?.answers || {},
      });
    } else if (pending.method === 'item/commandExecution/requestApproval') {
      await owningRpc.respond(pending.message.id, {
        decision: response?.decision || 'decline',
      });
    } else if (pending.method === 'item/fileChange/requestApproval') {
      await owningRpc.respond(pending.message.id, {
        decision: response?.decision || 'decline',
      });
    } else if (pending.method === 'item/permissions/requestApproval') {
      await owningRpc.respond(pending.message.id, response || {
        permissions: {
          fileSystem: null,
          network: {
            enabled: false,
          },
        },
        scope: 'turn',
        strictAutoReview: false,
      });
    } else {
      throw new Error(`Unsupported pending request method: ${pending.method}`);
    }

    this.pendingRequests.delete(key);
    this.resolvedRequests.set(key, {
      method: pending.method,
      resolvedAt: Date.now(),
    });
    while (this.resolvedRequests.size > 64) {
      this.resolvedRequests.delete(this.resolvedRequests.keys().next().value);
    }

    await this.emitRequestResolved({
      requestId: key,
      method: pending.method,
      summary: pending.summary,
      response: response ? {
        ...response,
        autoApproved: Boolean(response?.autoApproved),
      } : null,
    });

    const ownershipStillCurrent = this.serverRequestOwnershipMatchesCurrent(pending.ownership);
    const { waitingOnApproval, waitingOnUserInput } = this.pendingRequestFlags();
    const unresolvedSubmission = this.hasUnconfirmedSubmission();
    const nextPhase = this.runtimePhaseForResolvedRequest();
    if (ownershipStillCurrent) {
      await this.emitRuntime({
        waitingOnApproval,
        waitingOnUserInput,
        busy: Boolean(this.activeTurnId || unresolvedSubmission || waitingOnApproval || waitingOnUserInput),
        phase: nextPhase,
        ...(unresolvedSubmission && !this.activeTurnId
          ? {
            pendingClientRequestId: this.activeClientRequestId || null,
            currentTurnStatus: 'submitting',
          }
          : {}),
      });
    }
    return true;
  }

  async resolvePendingRequestsForClosedTurn(status, message) {
    if (!this.pendingRequests.size) {
      return;
    }

    const pendingEntries = Array.from(this.pendingRequests.entries());
    this.pendingRequests.clear();
    for (const [requestId, pending] of pendingEntries) {
      this.resolvedRequests.set(requestId, {
        method: pending.method,
        resolvedAt: Date.now(),
      });
      await this.emitRequestResolved({
        requestId,
        status: status || 'expired',
        method: pending.method,
        summary: pending.summary,
        message: message || 'Request closed because the Codex turn is no longer active.',
        response: {
          status: status || 'expired',
          reason: message || 'Request closed because the Codex turn is no longer active.',
        },
      });
    }
  }

  activeTurnRecoveryPatch(turnId, patch = {}) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!normalizedTurnId || normalizedTurnId !== String(this.activeTurnId || '').trim()) {
      return null;
    }
    return {
      activeTurnId: normalizedTurnId,
      busy: true,
      currentTurnStatus: 'inProgress',
      lastError: null,
      lastCodexError: null,
      userFacingError: null,
      ...patch,
    };
  }

  clientRequestIdForTurn(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!normalizedTurnId) return null;
    return (this.clientRequestIdsByTurn instanceof Map
      ? this.clientRequestIdsByTurn.get(normalizedTurnId)
      : null)
      || (normalizedTurnId === String(this.activeTurnId || '').trim()
        ? this.activeClientRequestId
        : null)
      || null;
  }

  bindClientRequestIdToTurn(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    const clientRequestId = String(this.activeClientRequestId || '').trim();
    const activeTurnId = String(this.activeTurnId || '').trim();
    const existingClientRequestId = this.clientRequestIdsByTurn instanceof Map
      ? String(this.clientRequestIdsByTurn.get(normalizedTurnId) || '').trim()
      : '';
    if (existingClientRequestId) return existingClientRequestId;
    if (this.isTerminalTurnId(normalizedTurnId)) return null;
    if (
      normalizedTurnId
      && clientRequestId
      && (!activeTurnId || activeTurnId === normalizedTurnId)
    ) {
      if (!(this.clientRequestIdsByTurn instanceof Map)) {
        this.clientRequestIdsByTurn = new Map();
      }
      this.clientRequestIdsByTurn.set(normalizedTurnId, clientRequestId);
      return clientRequestId;
    }
    return null;
  }

  adoptPendingTurnIdentity(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    if (
      !normalizedTurnId
      || this.isTerminalTurnId(normalizedTurnId)
      || this.activeTurnId
      || !this.activeClientRequestId
    ) return false;
    this.activeTurnId = normalizedTurnId;
    this.adoptTurnLifecycle(normalizedTurnId);
    this.bindClientRequestIdToTurn(normalizedTurnId);
    if (!this.turnBuffers.has(normalizedTurnId)) this.resetTurnBuffer(normalizedTurnId);
    return true;
  }

  rememberTerminalTurnId(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!normalizedTurnId) return false;
    if (!(this.terminalTurnIds instanceof Set)) this.terminalTurnIds = new Set();
    this.terminalTurnIds.delete(normalizedTurnId);
    this.terminalTurnIds.add(normalizedTurnId);
    while (this.terminalTurnIds.size > 128) {
      const oldestTurnId = this.terminalTurnIds.values().next().value;
      this.terminalTurnIds.delete(oldestTurnId);
      this.turnAssistantTranscriptEmitted?.delete?.(oldestTurnId);
    }
    return true;
  }

  isTerminalTurnId(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    return Boolean(normalizedTurnId && this.terminalTurnIds?.has?.(normalizedTurnId));
  }

  beginTurnLifecycle(turnId = null) {
    this.cancelThreadIdleReconciliation();
    this.cancelSubmissionReconciliation();
    this.cancelRuntimeProjectionRetry();
    this.activeSubmissionAttempt = null;
    this.turnLifecycleGeneration = Math.max(0, Number(this.turnLifecycleGeneration || 0)) + 1;
    this.activeTurnLifecycleId = String(turnId || '').trim() || null;
    return this.turnLifecycleGeneration;
  }

  adoptTurnLifecycle(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!normalizedTurnId) return this.turnLifecycleGeneration;
    if (this.activeTurnLifecycleId === normalizedTurnId) return this.turnLifecycleGeneration;
    if (!this.activeTurnLifecycleId && (this.activeClientRequestId || this.inputSubmissionInFlight)) {
      this.activeTurnLifecycleId = normalizedTurnId;
      return this.turnLifecycleGeneration;
    }
    return this.beginTurnLifecycle(normalizedTurnId);
  }

  captureActiveTurnOwnership() {
    const turnId = String(this.activeTurnId || '').trim();
    if (!turnId) return null;
    return {
      runId: String(this.runId || '').trim(),
      threadId: String(this.threadId || '').trim(),
      turnId,
      clientRequestId: String(this.clientRequestIdForTurn(turnId) || '').trim(),
      lifecycleGeneration: Math.max(0, Number(this.turnLifecycleGeneration || 0)),
    };
  }

  captureServerRequestOwnership(params = {}, ingress = {}) {
    const turnId = String(params.turnId || this.activeTurnId || '').trim();
    const rpc = ingress.rpc || this.rpc;
    const pendingSubmission = !this.activeTurnId ? this.submissionCandidate() : null;
    const requestStartedAtMs = Number(params.startedAtMs) > 0
      ? Number(params.startedAtMs)
      : uuidV7TimestampMs(turnId);
    const pendingSubmissionMatches = Boolean(
      turnId
      && pendingSubmission
      && rpc === this.rpc
      && this.submissionAttemptIdentityMatchesCurrent(pendingSubmission)
      && String(params.threadId || this.threadId || '').trim() === pendingSubmission.threadId
      && Number(requestStartedAtMs || 0) >= Number(pendingSubmission.submittedAtMs || 0) - 2000
    );
    return {
      rpc,
      runId: String(this.runId || '').trim(),
      threadId: String(params.threadId || this.threadId || '').trim(),
      turnId: turnId || null,
      clientRequestId: String(
        this.clientRequestIdForTurn(turnId)
        || (pendingSubmissionMatches ? pendingSubmission.clientRequestId : '')
        || this.activeClientRequestId
        || ''
      ).trim(),
      lifecycleGeneration: Math.max(0, Number(this.turnLifecycleGeneration || 0)),
      requestStartedAtMs: Number(requestStartedAtMs || 0) || null,
      submissionAttemptId: pendingSubmissionMatches
        ? String(pendingSubmission.attemptId || '').trim() || null
        : null,
    };
  }

  serverRequestOwnershipMatchesCurrent(observation) {
    if (!observation || this.stopRequested || observation.rpc !== this.rpc) return false;
    if (String(observation.runId || '').trim() !== String(this.runId || '').trim()) return false;
    if (String(observation.threadId || '').trim() !== String(this.threadId || '').trim()) return false;
    if (
      Math.max(0, Number(observation.lifecycleGeneration || 0))
      !== Math.max(0, Number(this.turnLifecycleGeneration || 0))
    ) return false;
    const turnId = String(observation.turnId || '').trim();
    if (turnId) {
      if (turnId === String(this.activeTurnId || '').trim()) {
        return String(observation.clientRequestId || '').trim()
          === String(this.clientRequestIdForTurn(turnId) || '').trim();
      }
      const pendingSubmission = !this.activeTurnId ? this.submissionCandidate() : null;
      return Boolean(
        pendingSubmission
        && observation.submissionAttemptId
        && this.submissionAttemptIdentityMatchesCurrent(pendingSubmission)
        && String(observation.submissionAttemptId) === String(pendingSubmission.attemptId || '')
        && String(observation.clientRequestId || '').trim() === pendingSubmission.clientRequestId
        && Number(observation.requestStartedAtMs || 0)
          >= Number(pendingSubmission.submittedAtMs || 0) - 2000
      );
    }
    return !this.activeTurnId
      && String(observation.clientRequestId || '').trim()
        === String(this.activeClientRequestId || '').trim();
  }

  activeTurnOwnershipMatches(observation) {
    if (!observation || this.stopRequested) return false;
    return String(this.runId || '').trim() === String(observation.runId || '').trim()
      && String(this.threadId || '').trim() === String(observation.threadId || '').trim()
      && String(this.activeTurnId || '').trim() === String(observation.turnId || '').trim()
      && String(this.clientRequestIdForTurn(observation.turnId) || '').trim()
        === String(observation.clientRequestId || '').trim()
      && Math.max(0, Number(this.turnLifecycleGeneration || 0))
        === Math.max(0, Number(observation.lifecycleGeneration || 0));
  }

  submissionOwnershipMatches(observation) {
    if (!observation || this.stopRequested || this.activeTurnId) return false;
    return this.rpc === observation.rpc
      && String(this.runId || '').trim() === String(observation.runId || '').trim()
      && String(this.threadId || '').trim() === String(observation.threadId || '').trim()
      && String(this.activeClientRequestId || '').trim()
        === String(observation.clientRequestId || '').trim()
      && Math.max(0, Number(this.turnLifecycleGeneration || 0))
        === Math.max(0, Number(observation.lifecycleGeneration || 0))
      && Number(observation.submittedAtMs || 0) > 0
      && Boolean(String(observation.inputFingerprint || '').trim());
  }

  captureSubmissionOwnership() {
    const submission = this.pendingSubmissionReconciliation || this.activeSubmissionAttempt;
    if (!submission || !this.submissionAttemptIdentityMatchesCurrent(submission)) return null;
    return {
      attemptId: submission.attemptId || null,
      runId: submission.runId,
      threadId: submission.threadId,
      clientRequestId: submission.clientRequestId,
      lifecycleGeneration: submission.lifecycleGeneration,
      rpc: submission.rpc,
      submittedAtMs: submission.submittedAtMs,
      inputFingerprint: submission.inputFingerprint,
      mode: submission.mode || 'default',
      inputTypes: Array.isArray(submission.inputTypes) ? submission.inputTypes.slice(0, 8) : [],
    };
  }

  submissionAttemptIdentityMatchesCurrent(attempt) {
    if (!attempt || this.stopRequested) return false;
    return attempt.rpc === this.rpc
      && String(this.runId || '').trim() === String(attempt.runId || '').trim()
      && String(this.threadId || '').trim() === String(attempt.threadId || '').trim()
      && String(this.activeClientRequestId || '').trim()
        === String(attempt.clientRequestId || '').trim()
      && Math.max(0, Number(this.turnLifecycleGeneration || 0))
        === Math.max(0, Number(attempt.lifecycleGeneration || 0))
      && Number(attempt.submittedAtMs || 0) > 0
      && Boolean(String(attempt.inputFingerprint || '').trim());
  }

  createSubmissionAttempt(params, metadata = {}) {
    const input = Array.isArray(params?.input) ? params.input : [];
    const mode = String(metadata.mode || '').trim() || 'default';
    const attempt = {
      attemptId: crypto.randomUUID(),
      runId: String(this.runId || '').trim(),
      threadId: String(this.threadId || '').trim(),
      clientRequestId: String(this.activeClientRequestId || '').trim(),
      lifecycleGeneration: Math.max(0, Number(this.turnLifecycleGeneration || 0)),
      rpc: this.rpc,
      submittedAtMs: Date.now(),
      inputFingerprint: submissionInputFingerprint(input),
      mode,
      inputTypes: input
        .map((item) => String(item?.type || '').trim())
        .filter(Boolean)
        .slice(0, 8),
      input,
    };
    this.activeSubmissionAttempt = attempt;
    return attempt;
  }

  submissionAttemptMetadata(attempt, overrides = {}) {
    if (!attempt) return { ...(overrides || {}) };
    return {
      attemptId: attempt.attemptId || null,
      runId: attempt.runId || null,
      threadId: attempt.threadId || null,
      lifecycleGeneration: attempt.lifecycleGeneration,
      submittedAtMs: attempt.submittedAtMs,
      inputFingerprint: attempt.inputFingerprint || null,
      mode: attempt.mode || 'default',
      inputTypes: Array.isArray(attempt.inputTypes) ? attempt.inputTypes.slice(0, 8) : [],
      ...(overrides || {}),
    };
  }

  rememberSubmissionAttemptTurn(turnId, attempt) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!normalizedTurnId || !attempt) return false;
    if (!(this.submissionAttemptsByTurn instanceof Map)) this.submissionAttemptsByTurn = new Map();
    this.submissionAttemptsByTurn.delete(normalizedTurnId);
    this.submissionAttemptsByTurn.set(normalizedTurnId, {
      ...attempt,
      turnId: normalizedTurnId,
    });
    while (this.submissionAttemptsByTurn.size > 128) {
      this.submissionAttemptsByTurn.delete(this.submissionAttemptsByTurn.keys().next().value);
    }
    return true;
  }

  submissionAttemptForTurn(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    return normalizedTurnId
      ? this.submissionAttemptsByTurn?.get?.(normalizedTurnId) || null
      : null;
  }

  submissionCandidate() {
    return this.pendingSubmissionReconciliation || this.activeSubmissionAttempt || null;
  }

  clearActiveSubmissionAttempt(expected = null) {
    const active = this.activeSubmissionAttempt;
    if (!active) return false;
    if (expected) {
      const expectedId = String(expected.attemptId || '').trim();
      const activeId = String(active.attemptId || '').trim();
      if (expectedId && activeId) {
        if (expectedId !== activeId) return false;
      } else if (active !== expected) {
        return false;
      }
    }
    this.activeSubmissionAttempt = null;
    return true;
  }

  submissionObservationForMessage(message) {
    return message?.[NOTIFICATION_SUBMISSION_OWNERSHIP] || null;
  }

  submissionNotificationMatches(message, submission = this.submissionCandidate()) {
    const observation = this.submissionObservationForMessage(message);
    return Boolean(
      observation
      && submission
      && this.submissionObservationMatches(observation, submission)
    );
  }

  adoptPendingSubmissionFromNotification(params = {}, message, options = {}) {
    const submission = this.submissionCandidate();
    const observation = this.submissionObservationForMessage(message);
    const turn = params.turn && typeof params.turn === 'object'
      ? params.turn
      : null;
    if (
      !submission
      || !observation
      || !this.submissionObservationMatches(observation, submission)
      || !turn
      || !this.turnMatchesSubmissionEvidence(turn, submission)
    ) return null;
    return this.adoptPendingSubmissionTurn(turn, {
      observation,
      requireEvidence: options.requireEvidence !== false,
    });
  }

  async ignoreMismatchedSubmissionNotification(method, params, reason = 'submission-ownership-mismatch') {
    await this.emitDiagnostic({
      severity: 'info',
      source: 'runtime',
      kind: 'submission-reconciliation',
      method,
      message: `Ignored ${method} notification that did not match the pending submission (${reason}).`,
      data: {
        turnId: params?.turnId || params?.turn?.id || null,
        threadId: params?.threadId || params?.thread?.id || null,
        reason,
      },
    }).catch(() => {});
    return false;
  }

  submissionObservationMatches(observation, submission) {
    if (!observation || !submission) return false;
    return observation.rpc === submission.rpc
      && (!submission.attemptId || String(observation.attemptId || '').trim() === String(submission.attemptId || '').trim())
      && String(observation.runId || '').trim() === String(submission.runId || '').trim()
      && String(observation.threadId || '').trim() === String(submission.threadId || '').trim()
      && String(observation.clientRequestId || '').trim()
        === String(submission.clientRequestId || '').trim()
      && Math.max(0, Number(observation.lifecycleGeneration || 0))
        === Math.max(0, Number(submission.lifecycleGeneration || 0))
      && Number(observation.submittedAtMs || 0) === Number(submission.submittedAtMs || 0)
      && Boolean(observation.inputFingerprint)
      && String(observation.inputFingerprint || '') === String(submission.inputFingerprint || '');
  }

  turnMatchesSubmissionEvidence(turn, submission) {
    if (!turn || !submission?.inputFingerprint || !submission?.submittedAtMs) return false;
    if (turnUserInputFingerprint(turn) !== submission.inputFingerprint) return false;
    const startedAtMs = turnStartedAtMs(turn);
    if (!startedAtMs) return false;
    if (startedAtMs < Number(submission.submittedAtMs) - 2000) return false;
    if (startedAtMs > Date.now() + 5 * 60 * 1000) return false;
    const idTimestampMs = uuidV7TimestampMs(turn.id);
    if (idTimestampMs != null && idTimestampMs < Number(submission.submittedAtMs) - 250) {
      return false;
    }
    return true;
  }

  cancelSubmissionReconciliation() {
    const pending = this.pendingSubmissionReconciliation;
    if (!pending) return false;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    pending.probing = false;
    this.pendingSubmissionReconciliation = null;
    return true;
  }

  cancelRuntimeProjectionRetry(turnId = null) {
    const pending = this.pendingRuntimeProjectionRetry;
    if (!pending) return false;
    if (turnId && String(pending.turnId || '').trim() !== String(turnId || '').trim()) {
      return false;
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingRuntimeProjectionRetry = null;
    return true;
  }

  scheduleRuntimeProjectionRetry(turnId, patch, attempt = 0) {
    const ownership = this.captureActiveTurnOwnership();
    if (!ownership || ownership.turnId !== String(turnId || '').trim()) return false;
    this.cancelRuntimeProjectionRetry();
    const pending = {
      ...ownership,
      turnId: ownership.turnId,
      patch: { ...patch },
      attempt: Math.max(0, Number(attempt || 0)),
      expectedRuntimeRevision: Math.max(0, Number(this.runtimeRevision || 0)),
      timer: null,
    };
    const ownsPendingProjection = () => Boolean(
      this.pendingRuntimeProjectionRetry === pending
      && this.activeTurnOwnershipMatches(pending)
      && Math.max(0, Number(this.runtimeRevision || 0)) === pending.expectedRuntimeRevision
    );
    const abandon = () => {
      if (this.pendingRuntimeProjectionRetry === pending) {
        this.pendingRuntimeProjectionRetry = null;
      }
      return false;
    };
    const schedule = () => {
      if (!ownsPendingProjection()) return abandon();
      const delayMs = Math.min(10000, 250 * (2 ** Math.min(pending.attempt, 6)));
      pending.attempt += 1;
      pending.timer = setTimeout(() => {
        pending.timer = null;
        if (!ownsPendingProjection()) {
          abandon();
          return;
        }
        const beforeRevision = Math.max(0, Number(this.runtimeRevision || 0));
        void this.emitRuntime(pending.patch).then(() => {
          if (this.pendingRuntimeProjectionRetry === pending) {
            this.pendingRuntimeProjectionRetry = null;
          }
        }).catch(() => {
          if (
            this.pendingRuntimeProjectionRetry !== pending
            || !this.activeTurnOwnershipMatches(pending)
            || Math.max(0, Number(this.runtimeRevision || 0)) !== beforeRevision + 1
          ) {
            abandon();
            return;
          }
          pending.expectedRuntimeRevision = Math.max(0, Number(this.runtimeRevision || 0));
          schedule();
        });
      }, delayMs);
      pending.timer.unref?.();
      return true;
    };
    this.pendingRuntimeProjectionRetry = pending;
    return schedule();
  }

  async emitActiveTurnRuntimeWithRetry(turnId, patch) {
    const normalizedTurnId = String(turnId || '').trim();
    try {
      await this.emitRuntime(patch);
      this.cancelRuntimeProjectionRetry(normalizedTurnId);
      return true;
    } catch (error) {
      this.notificationLastError = error;
      this.scheduleRuntimeProjectionRetry(normalizedTurnId, patch);
      this.emitDiagnostic({
        severity: 'warning',
        source: 'runtime',
        kind: 'runtime-projection-retry',
        method: 'session.runtime_updated',
        message: `Runtime projection for Turn ${normalizedTurnId || '(unknown)'} failed and will be retried.`,
        turnId: normalizedTurnId || null,
        detail: error?.message || String(error),
      }).catch(() => {});
      return false;
    }
  }

  scheduleSubmissionReconciliation(metadata = {}) {
    const clientRequestId = String(
      metadata.clientRequestId || this.activeClientRequestId || ''
    ).trim();
    if (
      this.stopRequested
      || this.activeTurnId
      || !this.rpc
      || !this.threadId
      || !clientRequestId
      || clientRequestId !== String(this.activeClientRequestId || '').trim()
    ) return false;
    this.cancelSubmissionReconciliation();
    const pending = {
      attemptId: String(metadata.attemptId || '').trim() || null,
      runId: String(this.runId || '').trim(),
      threadId: String(this.threadId || '').trim(),
      clientRequestId,
      lifecycleGeneration: Math.max(0, Number(this.turnLifecycleGeneration || 0)),
      rpc: this.rpc,
      submittedAtMs: Number(metadata.submittedAtMs) > 0
        ? Number(metadata.submittedAtMs)
        : Date.now(),
      inputFingerprint: String(metadata.inputFingerprint || '').trim() || null,
      mode: String(metadata.mode || '').trim() || 'default',
      inputTypes: Array.isArray(metadata.inputTypes)
        ? metadata.inputTypes.map((value) => String(value || '').trim()).filter(Boolean).slice(0, 8)
        : [],
      input: normalizedSubmissionInput(metadata.input),
      candidateTurnId: String(metadata.candidateTurnId || '').trim() || null,
      candidateError: metadata.candidateError || null,
      candidateSystemError: metadata.candidateSystemError || null,
      startedAt: nowIso(),
      timer: null,
      probing: false,
      retryAttempt: 0,
      lastUnknownReason: null,
    };
    this.pendingSubmissionReconciliation = pending;
    return this.scheduleSubmissionReconciliationRetry(pending);
  }

  adoptPendingSubmissionTurn(turnOrId, options = {}) {
    const turn = turnOrId && typeof turnOrId === 'object'
      ? turnOrId
      : (options.turn && typeof options.turn === 'object' ? options.turn : null);
    const normalizedTurnId = String(
      turn?.id || turnOrId || options.turnId || ''
    ).trim();
    const pending = this.pendingSubmissionReconciliation || this.activeSubmissionAttempt;
    const observation = options.observation || null;
    const requireEvidence = options.requireEvidence === true;
    if (
      !normalizedTurnId
      || this.isTerminalTurnId(normalizedTurnId)
      || !pending
      || !this.submissionAttemptIdentityMatchesCurrent(pending)
      || (observation && !this.submissionObservationMatches(observation, pending))
      || (requireEvidence && !this.turnMatchesSubmissionEvidence(turn, pending))
      || !this.adoptPendingTurnIdentity(normalizedTurnId)
    ) return null;
    this.rememberSubmissionAttemptTurn(normalizedTurnId, pending);
    this.turnModes.set(normalizedTurnId, pending.mode);
    this.turnInputTypes.set(normalizedTurnId, pending.inputTypes);
    this.cancelSubmissionReconciliation();
    this.clearActiveSubmissionAttempt(pending);
    return pending;
  }

  scheduleSubmissionReconciliationRetry(pending) {
    if (
      this.pendingSubmissionReconciliation !== pending
      || pending.timer
      || pending.probing
      || !this.submissionOwnershipMatches(pending)
    ) return false;
    const attempt = Math.max(0, Number(pending.retryAttempt || 0));
    const delayMs = Math.min(
      this.submissionReconcileRetryMaxMs,
      this.submissionReconcileDelayMs * (2 ** Math.min(attempt, 10))
    );
    pending.retryAttempt = attempt + 1;
    pending.timer = setTimeout(() => {
      if (this.pendingSubmissionReconciliation !== pending) return;
      pending.timer = null;
      void this.probeSubmissionReconciliation(pending).catch((error) => {
        this.notificationLastError = error;
        console.error(`[codex-runner] submission reconciliation failed: ${error.message || error}`);
      });
    }, delayMs);
    pending.timer.unref?.();
    return true;
  }

  async publishUnknownSubmissionReconciliation(pending, details = {}) {
    if (
      this.pendingSubmissionReconciliation !== pending
      || !this.submissionOwnershipMatches(pending)
    ) return false;
    if (details.preserveSchedule !== true) pending.probing = false;
    const reason = details.reason || 'thread-read-unavailable';
    const firstUnknown = String(this.runtime.phase || '').trim().toLowerCase() !== 'runtime-unknown'
      || String(this.runtime.submissionReconciliation?.clientRequestId || '').trim()
        !== pending.clientRequestId;
    let publicationError = null;
    if (firstUnknown || pending.lastUnknownReason !== reason) {
      try {
        await this.emitRuntime({
          clientRequestId: pending.clientRequestId,
          activeTurnId: null,
          pendingClientRequestId: pending.clientRequestId,
          phase: 'runtime-unknown',
          busy: true,
          currentTurnStatus: 'unknown',
          terminalReconciliation: null,
          submissionReconciliation: {
            status: 'unknown',
            reason,
            clientRequestId: pending.clientRequestId,
            startedAt: pending.startedAt,
            checkedAt: nowIso(),
          },
        });
      } catch (error) {
        publicationError = error;
      }
      try {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'runtime',
          kind: 'submission-reconciliation',
          method: 'thread/read',
          message: details.message || 'Unable to confirm whether Codex accepted the submitted prompt; retrying without resending it.',
          detail: details.error || null,
          data: {
            reason,
            clientRequestId: pending.clientRequestId,
          },
        });
      } catch (error) {
        publicationError ||= error;
      }
      pending.lastUnknownReason = reason;
    }
    const scheduled = details.preserveSchedule === true
      ? true
      : this.scheduleSubmissionReconciliationRetry(pending);
    if (publicationError) throw publicationError;
    return scheduled;
  }

  async probeSubmissionReconciliation(pending) {
    if (
      this.pendingSubmissionReconciliation !== pending
      || pending.probing
      || !this.submissionOwnershipMatches(pending)
    ) return false;
    pending.probing = true;
    let response;
    try {
      response = await this.rpc.request('thread/read', {
        threadId: pending.threadId,
        includeTurns: true,
      }, this.threadIdleProbeTimeoutMs);
    } catch (error) {
      if (this.pendingSubmissionReconciliation !== pending) return false;
      return this.publishUnknownSubmissionReconciliation(pending, {
        reason: 'thread-read-failed',
        message: `Unable to confirm whether Codex accepted the submitted prompt: ${error.message || error}`,
        error: error.message || String(error),
      });
    }
    if (
      this.pendingSubmissionReconciliation !== pending
      || !this.submissionOwnershipMatches(pending)
    ) return false;
    const thread = response?.thread || null;
    const responseThreadId = String(thread?.id || '').trim();
    const threadStatus = normalizedStatusType(thread?.status);
    const threadStatusKey = threadStatus.replace(/[-_\s]/g, '').toLowerCase();
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const activeTurns = turns.filter((turn) => {
      const status = normalizedStatusType(turn?.status).replace(/[-_\s]/g, '').toLowerCase();
      return ['active', 'inprogress', 'running'].includes(status);
    });
    if (
      (!responseThreadId || responseThreadId === pending.threadId)
      && threadStatusKey === 'active'
      && activeTurns.length === 1
    ) {
      const matchingTurn = activeTurns[0];
      const turnId = String(matchingTurn?.id || '').trim();
      if (
        turnId
        && this.turnMatchesSubmissionEvidence(matchingTurn, pending)
        && this.adoptPendingSubmissionTurn(matchingTurn, { requireEvidence: true })
      ) {
        await this.emitActiveTurnRuntimeWithRetry(turnId, {
          clientRequestId: pending.clientRequestId,
          threadStatus: thread.status || null,
          activeTurnId: turnId,
          pendingClientRequestId: null,
          busy: true,
          phase: pending.mode === 'plan' ? 'planning' : 'thinking',
          currentTurnStatus: normalizedStatusType(activeTurns[0]?.status) || 'inProgress',
          waitingOnApproval: false,
          waitingOnUserInput: false,
          terminalReconciliation: null,
          submissionReconciliation: null,
          lastError: null,
          lastCodexError: null,
          userFacingError: null,
        });
        if (
          pending.candidateError?.params?.willRetry === true
          && (!pending.candidateTurnId || pending.candidateTurnId === turnId)
        ) {
          await this.handleNotification({
            method: 'error',
            params: {
              ...pending.candidateError.params,
              turnId,
            },
          });
        }
        try {
          await this.applyPendingInterruptIntent(turnId);
        } catch (error) {
          await this.emitDiagnostic({
            severity: 'warning',
            source: 'runtime',
            kind: 'submission-reconciliation',
            method: 'turn/interrupt',
            message: `Recovered turn ${turnId}, but pending interrupt delivery failed: ${error.message || error}`,
            turnId,
          }).catch(() => {});
        }
        await this.emitDiagnostic({
          severity: 'info',
          source: 'runtime',
          kind: 'submission-reconciliation',
          method: 'thread/read',
          message: `Recovered accepted Codex turn ${turnId} after the turn/start response timed out.`,
          turnId,
          clientRequestId: pending.clientRequestId,
          data: { recovered: true, threadStatus },
        });
        return true;
      }
    }
    const candidateTurnId = String(pending.candidateTurnId || '').trim();
    const terminalTurns = turns.filter((turn) => {
      const status = normalizedStatusType(turn?.status).replace(/[-_\s]/g, '').toLowerCase();
      return ['completed', 'interrupted', 'failed'].includes(status);
    });
    const matchingTerminalTurn = terminalTurns.find((turn) => (
      (!candidateTurnId || String(turn?.id || '').trim() === candidateTurnId)
      && this.turnMatchesSubmissionEvidence(turn, pending)
    )) || null;
    if (matchingTerminalTurn) {
      const terminalTurnId = String(matchingTerminalTurn.id || '').trim();
      const adopted = this.adoptPendingSubmissionTurn(matchingTerminalTurn, {
        requireEvidence: true,
      });
      if (adopted) {
        const status = normalizedStatusType(matchingTerminalTurn.status) || 'completed';
        if (
          status === 'failed'
          && pending.candidateError?.params
          && (!pending.candidateTurnId || pending.candidateTurnId === terminalTurnId)
        ) {
          await this.handleNotification({
            method: 'error',
            params: {
              ...pending.candidateError.params,
              turnId: terminalTurnId,
              willRetry: false,
            },
          });
          return true;
        }
        this.rememberTerminalTurnId(terminalTurnId);
        if (status === 'failed' && matchingTerminalTurn.error?.message) {
          await this.emitDiagnostic({
            severity: 'error',
            source: 'runtime',
            kind: 'submission-reconciliation',
            method: 'thread/read',
            message: matchingTerminalTurn.error.message,
            turnId: terminalTurnId,
            clientRequestId: pending.clientRequestId,
          }).catch(() => {});
        }
        await this.finalizeTurnCompletion({
          turn: matchingTerminalTurn,
        }, terminalTurnId);
        return true;
      }
    }
    const reason = responseThreadId && responseThreadId !== pending.threadId
      ? 'thread-identity-mismatch'
      : threadStatusKey !== 'active'
        ? `thread-status-${threadStatusKey || 'missing'}`
        : activeTurns.length === 0
          ? 'active-turn-missing'
          : 'active-turn-ambiguous';
    return this.publishUnknownSubmissionReconciliation(pending, {
      reason,
      message: 'Codex has not exposed one authoritative active Turn for the submitted prompt; retrying without resending it.',
    });
  }

  cancelThreadIdleReconciliation() {
    const pending = this.pendingThreadIdleReconciliation;
    if (!pending) return false;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingThreadIdleReconciliation = null;
    return true;
  }

  isNoActiveTurnInterruptError(error) {
    const rpcData = error?.rpcData;
    const structuredCode = String(
      rpcData?.code || rpcData?.kind || rpcData?.reason || ''
    ).replace(/[-_\s]/g, '').toLowerCase();
    if (structuredCode === 'noactiveturn' || structuredCode === 'turnnotactive') return true;
    return /\bno active turn to interrupt\b/i.test(String(error?.message || ''));
  }

  async scheduleThreadIdleReconciliation(threadStatus, observedOwnership = null) {
    const observation = observedOwnership || this.captureActiveTurnOwnership();
    if (!this.activeTurnOwnershipMatches(observation)) return false;
    this.cancelThreadIdleReconciliation();
    const pending = {
      ...observation,
      threadStatus: threadStatus || { type: 'idle' },
      previousPhase: String(this.runtime.phase || '').trim() || 'thinking',
      startedAt: nowIso(),
      timer: null,
      probing: false,
      retryAttempt: 0,
      lastUnknownReason: null,
    };
    this.pendingThreadIdleReconciliation = pending;
    await this.emitRuntime({
      clientRequestId: observation.clientRequestId || null,
      threadStatus: threadStatus || { type: 'idle' },
      activeTurnId: observation.turnId,
      phase: 'terminal-settling',
      busy: true,
      currentTurnStatus: 'settling',
      terminalReconciliation: {
        status: 'settling',
        reason: 'thread-idle-with-active-turn',
        turnId: observation.turnId,
        startedAt: pending.startedAt,
      },
    });
    if (this.pendingThreadIdleReconciliation !== pending) return true;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      void this.probeThreadIdleReconciliation(pending).catch((error) => {
        this.notificationLastError = error;
        console.error(`[codex-runner] idle turn reconciliation failed: ${error.message || error}`);
      });
    }, Math.max(10, Number(this.threadIdleReconcileGraceMs || THREAD_IDLE_RECONCILE_GRACE_MS)));
    pending.timer.unref?.();
    return true;
  }

  async reconcileObservedInactiveTurn(observation, details = {}) {
    if (!this.activeTurnOwnershipMatches(observation)) return false;
    this.cancelThreadIdleReconciliation();
    const status = ['completed', 'interrupted', 'failed'].includes(details.status)
      ? details.status
      : 'completed';
    await this.resolvePendingInterruptForTerminalTurn(observation.turnId, status);
    await this.finalizeTurnCompletion({
      turn: {
        id: observation.turnId,
        status: { type: status },
        recovered: true,
        recoveredFrom: details.reason || 'native-idle',
      },
    }, observation.turnId);
    await this.emitDiagnostic({
      severity: status === 'failed' ? 'error' : 'info',
      source: 'runtime',
      kind: 'turn-reconciliation',
      method: details.method || 'thread/read',
      message: `Recovered stale active turn ${observation.turnId} after ${details.reason || 'native idle confirmation'}.`,
      turnId: observation.turnId,
      data: {
        recovered: true,
        reason: details.reason || 'native-idle',
        threadStatus: details.threadStatus || null,
        probedTurnStatus: details.probedTurnStatus || null,
      },
    });
    return true;
  }

  async publishUnknownThreadIdleReconciliation(pending, details = {}) {
    if (!this.activeTurnOwnershipMatches(pending)) return false;
    if (this.pendingThreadIdleReconciliation !== pending) return false;
    pending.probing = false;
    const reason = details.reason || 'thread-read-unavailable';
    const firstUnknown = String(this.runtime.phase || '').trim().toLowerCase() !== 'runtime-unknown'
      || String(this.runtime.terminalReconciliation?.turnId || '').trim() !== pending.turnId;
    if (firstUnknown || pending.lastUnknownReason !== reason) {
      await this.emitRuntime({
        clientRequestId: pending.clientRequestId || null,
        activeTurnId: pending.turnId,
        phase: 'runtime-unknown',
        busy: true,
        currentTurnStatus: 'unknown',
        terminalReconciliation: {
          status: 'unknown',
          reason,
          turnId: pending.turnId,
          startedAt: pending.startedAt,
          checkedAt: nowIso(),
        },
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'runtime',
        kind: 'turn-reconciliation',
        method: 'thread/read',
        message: details.message || 'Unable to confirm whether the settling Codex turn is still active; retrying.',
        detail: details.error || null,
        turnId: pending.turnId,
      });
      pending.lastUnknownReason = reason;
    }
    this.scheduleThreadIdleReconciliationRetry(pending);
    return true;
  }

  scheduleThreadIdleReconciliationRetry(pending) {
    if (
      this.pendingThreadIdleReconciliation !== pending
      || pending.timer
      || pending.probing
      || !this.activeTurnOwnershipMatches(pending)
    ) return false;
    const attempt = Math.max(0, Number(pending.retryAttempt || 0));
    const delayMs = Math.min(
      this.threadIdleRetryMaxMs,
      this.threadIdleRetryBaseMs * (2 ** Math.min(attempt, 10))
    );
    pending.retryAttempt = attempt + 1;
    pending.timer = setTimeout(() => {
      if (this.pendingThreadIdleReconciliation !== pending) return;
      pending.timer = null;
      void this.probeThreadIdleReconciliation(pending).catch((error) => {
        this.notificationLastError = error;
        console.error(`[codex-runner] idle turn reconciliation retry failed: ${error.message || error}`);
      });
    }, delayMs);
    pending.timer.unref?.();
    return true;
  }

  async probeThreadIdleReconciliation(pending) {
    if (
      this.pendingThreadIdleReconciliation !== pending
      || pending.probing
      || !this.activeTurnOwnershipMatches(pending)
    ) return false;
    pending.probing = true;
    let response;
    try {
      response = await this.rpc.request('thread/read', {
        threadId: pending.threadId,
        includeTurns: true,
      }, this.threadIdleProbeTimeoutMs);
    } catch (error) {
      if (this.pendingThreadIdleReconciliation !== pending) return false;
      return this.publishUnknownThreadIdleReconciliation(pending, {
        reason: 'thread-read-failed',
        message: `Unable to confirm the settling Codex turn: ${error.message || error}`,
        error: error.message || String(error),
      });
    }
    if (
      this.pendingThreadIdleReconciliation !== pending
      || !this.activeTurnOwnershipMatches(pending)
    ) return false;
    const thread = response?.thread || null;
    const threadStatus = normalizedStatusType(thread?.status);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const matchingTurn = turns.find((turn) => String(turn?.id || '').trim() === pending.turnId) || null;
    const turnStatus = normalizedStatusType(matchingTurn?.status);
    if (threadStatus === 'active') {
      this.pendingThreadIdleReconciliation = null;
      pending.probing = false;
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
      await this.emitRuntime({
        ...this.activeTurnRecoveryPatch(pending.turnId, {
          clientRequestId: pending.clientRequestId || null,
          threadStatus: thread.status,
          phase: ['terminal-settling', 'runtime-unknown', 'idle'].includes(pending.previousPhase)
            ? 'thinking'
            : pending.previousPhase,
          currentTurnStatus: turnStatus === 'inProgress' ? turnStatus : 'inProgress',
          terminalReconciliation: null,
        }),
      });
      return true;
    }
    if (threadStatus === 'idle' || threadStatus === 'systemError') {
      const status = ['completed', 'interrupted', 'failed'].includes(turnStatus)
        ? turnStatus
        : threadStatus === 'systemError'
          ? 'failed'
          : pending.previousPhase === 'interrupting'
            ? 'interrupted'
            : 'completed';
      return this.reconcileObservedInactiveTurn(pending, {
        status,
        reason: 'thread-read-confirmed-inactive',
        threadStatus,
        probedTurnStatus: turnStatus || null,
      });
    }
    return this.publishUnknownThreadIdleReconciliation(pending, {
      reason: `thread-status-${threadStatus || 'missing'}`,
      message: `Codex thread/read returned ${threadStatus || 'no thread status'} while reconciling turn ${pending.turnId}.`,
    });
  }

  rememberSystemErrorTurn(turnId, metadata = {}) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!normalizedTurnId) return false;
    if (!(this.systemErrorsByTurn instanceof Map)) this.systemErrorsByTurn = new Map();
    this.systemErrorsByTurn.delete(normalizedTurnId);
    this.systemErrorsByTurn.set(normalizedTurnId, { ...metadata });
    while (this.systemErrorsByTurn.size > 128) {
      this.systemErrorsByTurn.delete(this.systemErrorsByTurn.keys().next().value);
    }
    return true;
  }

  takeSystemErrorTurn(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    const metadata = normalizedTurnId
      ? this.systemErrorsByTurn?.get?.(normalizedTurnId) || null
      : null;
    if (metadata) this.systemErrorsByTurn.delete(normalizedTurnId);
    return metadata;
  }

  async settlePendingInterrupt(intent, result = {}) {
    if (!intent || intent.settled || this.pendingInterruptIntent !== intent) return false;
    intent.settled = true;
    try {
      await this.postEvent({
        type: 'session.interrupt_result',
        hostId: this.hostId,
        sessionId: this.currentSessionId(),
        runId: this.runId,
        interruptRequestId: intent.interruptRequestId || null,
        ...result,
        timestamp: nowIso(),
      });
      if (this.pendingInterruptIntent === intent) {
        this.pendingInterruptIntent = null;
      }
      return true;
    } catch (error) {
      intent.settled = false;
      throw error;
    }
  }

  async settlePendingInterruptForSubmissionFailure(clientRequestId, error) {
    const intent = this.pendingInterruptIntent;
    const normalizedClientRequestId = String(clientRequestId || '').trim();
    if (!intent) return false;
    if (
      intent.expectedClientRequestId
      && normalizedClientRequestId
      && intent.expectedClientRequestId !== normalizedClientRequestId
    ) {
      return false;
    }
    return this.settlePendingInterrupt(intent, {
      status: 'no_active',
      reason: this.stopRequested ? 'session_stopped' : 'turn_start_failed',
      error: error?.message || null,
      turnId: null,
      clientRequestId: normalizedClientRequestId || null,
    });
  }

  async resolvePendingInterruptForTerminalTurn(turnId, status = 'completed') {
    const intent = this.pendingInterruptIntent;
    if (!intent) return false;
    const clientRequestId = this.clientRequestIdForTurn(turnId);
    if (
      intent.expectedClientRequestId
      && clientRequestId
      && intent.expectedClientRequestId !== clientRequestId
    ) {
      return false;
    }
    return this.settlePendingInterrupt(intent, {
      status: 'no_active',
      reason: `turn_already_${String(status || 'completed')}`,
      turnId: turnId || null,
      clientRequestId: clientRequestId || null,
    });
  }

  releaseClientRequestIdForTurn(turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!normalizedTurnId) return null;
    const clientRequestId = this.clientRequestIdForTurn(normalizedTurnId);
    this.clientRequestIdsByTurn?.delete?.(normalizedTurnId);
    if (
      normalizedTurnId === String(this.activeTurnId || '').trim()
      || (clientRequestId && clientRequestId === this.activeClientRequestId)
    ) {
      this.activeClientRequestId = null;
    }
    return clientRequestId;
  }

  async applyPendingInterruptIntent(turnId) {
    const intent = this.pendingInterruptIntent;
    if (!intent) return false;
    const clientRequestId = this.clientRequestIdForTurn(turnId);
    if (
      intent.expectedClientRequestId
      && intent.expectedClientRequestId !== clientRequestId
    ) {
      await this.settlePendingInterrupt(intent, {
        status: 'no_active',
        reason: 'active_turn_changed',
        turnId: turnId || null,
        clientRequestId: clientRequestId || null,
      });
      return false;
    }

    try {
      const result = await this.interruptActiveTurn(intent);
      await this.settlePendingInterrupt(intent, result);
      return result.status === 'accepted';
    } catch (error) {
      await this.emitRuntime({
        clientRequestId: clientRequestId || null,
        activeTurnId: turnId || null,
        busy: Boolean(turnId),
        phase: turnId ? 'thinking' : 'idle',
        currentTurnStatus: turnId ? 'inProgress' : 'idle',
      }).catch(() => {});
      await this.settlePendingInterrupt(intent, {
        status: 'failed',
        error: error?.message || String(error),
        turnId: turnId || null,
        clientRequestId: clientRequestId || null,
      });
      return false;
    }
  }

  activeTurnRecoveryNeeded(turnId) {
    if (this.runtime.lastError || this.runtime.lastCodexError) return true;
    const normalizedTurnId = String(turnId || '').trim();
    const pendingReconciliation = this.pendingThreadIdleReconciliation;
    if (
      pendingReconciliation
      && pendingReconciliation.turnId === normalizedTurnId
      && this.activeTurnOwnershipMatches(pendingReconciliation)
    ) {
      return true;
    }
    return String(this.runtime.phase || '').trim().toLowerCase() === 'runtime-unknown'
      && String(this.runtime.terminalReconciliation?.turnId || '').trim() === normalizedTurnId;
  }

  async emitActiveTurnRecoveryIfNeeded(turnId, patch = {}) {
    const normalizedTurnId = String(turnId || '').trim();
    if (!this.activeTurnRecoveryNeeded(normalizedTurnId)) return false;
    const pendingReconciliation = this.pendingThreadIdleReconciliation
      && this.activeTurnOwnershipMatches(this.pendingThreadIdleReconciliation)
      && this.pendingThreadIdleReconciliation.turnId === normalizedTurnId
      ? this.pendingThreadIdleReconciliation
      : null;
    const unknownReconciliation = !pendingReconciliation
      && String(this.runtime.phase || '').trim().toLowerCase() === 'runtime-unknown'
      && String(this.runtime.terminalReconciliation?.turnId || '').trim() === normalizedTurnId;
    const previousPhase = String(pendingReconciliation?.previousPhase || '').trim().toLowerCase();
    const restoredPhase = previousPhase
      && !['idle', 'terminal-settling', 'runtime-unknown'].includes(previousPhase)
      ? pendingReconciliation.previousPhase
      : 'thinking';
    if (pendingReconciliation) this.cancelThreadIdleReconciliation();
    const recoveryPatch = this.activeTurnRecoveryPatch(normalizedTurnId, {
      ...((pendingReconciliation || unknownReconciliation)
        ? { phase: restoredPhase, terminalReconciliation: null }
        : {}),
      ...patch,
    });
    if (!recoveryPatch) {
      return false;
    }
    await this.emitRuntime(recoveryPatch);
    return true;
  }

  foreignNotificationSource(method, params = {}, message = null) {
    const ownerThreadId = String(this.threadId || this.nativeThreadId || '').trim();
    if (!ownerThreadId) return null;
    const turnId = String(params.turnId || params.turn?.id || '').trim();
    const ownsTurn = turnId === String(this.activeTurnId || '').trim()
      || this.clientRequestIdsByTurn?.has?.(turnId)
      || this.turnBuffers?.has?.(turnId)
      || this.turnModes?.has?.(turnId)
      || this.pendingTurnCompletions?.has?.(turnId)
      || this.systemErrorsByTurn?.has?.(turnId);
    const notificationThreadId = String(
      params.threadId
      || params.thread?.id
      || ''
    ).trim();
    if (notificationThreadId && notificationThreadId !== ownerThreadId) {
      return notificationThreadId;
    }
    if (!turnId || ownsTurn) return null;
    const pendingTurnMayBelongToRunner = !this.activeTurnId
      && Boolean(this.activeClientRequestId)
      && ['turn/started', 'turn/completed', 'error'].includes(method)
      && this.submissionNotificationMatches(message);
    return ownsTurn || pendingTurnMayBelongToRunner ? null : `turn:${turnId}`;
  }

  rememberSubagentParentTurn(activity) {
    const identity = activity?.identity || {};
    const parentTurnId = String(identity.turnId || '').trim();
    if (!parentTurnId) return false;
    const threadIds = [
      identity.agentThreadId,
      ...(Array.isArray(identity.receiverThreadIds) ? identity.receiverThreadIds : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    if (!threadIds.length) return false;
    if (!(this.subagentParentTurns instanceof Map)) this.subagentParentTurns = new Map();
    for (const threadId of threadIds) {
      this.subagentParentTurns.delete(threadId);
      this.subagentParentTurns.set(threadId, parentTurnId);
    }
    while (this.subagentParentTurns.size > 128) {
      this.subagentParentTurns.delete(this.subagentParentTurns.keys().next().value);
    }
    return true;
  }

  async handleForeignThreadNotification(method, params, sourceThreadId) {
    if (String(sourceThreadId || '').startsWith('turn:')) {
      await this.emitDiagnostic({
        severity: 'info',
        source: 'runtime',
        kind: 'turn-reconciliation',
        method,
        message: `Ignored notification for an inactive Turn ${String(sourceThreadId).slice(5)}.`,
        turnId: params.turnId || params.turn?.id || null,
      }).catch(() => {});
      return true;
    }
    if (method === 'item/completed' && isAppServerAssistantMessageItem(params.item)) {
      const text = appServerAssistantMessageText(params.item);
      const parentTurnId = this.subagentParentTurns?.get?.(sourceThreadId)
        || String(this.activeTurnId || '').trim();
      const nativeItemId = String(params.item?.id || params.itemId || '').trim();
      if (text && parentTurnId && nativeItemId) {
        const itemId = `subagent-message:${sourceThreadId}:${nativeItemId}`;
        this.replaceActivitySnapshot({
          turnId: parentTurnId,
          itemId,
          summaryIndex: 0,
          kind: 'collaboration',
          itemType: 'subAgentMessage',
          method,
          callId: nativeItemId,
          status: 'completed',
          agentThreadId: sourceThreadId,
          parentThreadId: this.threadId || this.nativeThreadId || null,
          senderThreadId: sourceThreadId,
          receiverThreadIds: [this.threadId || this.nativeThreadId].filter(Boolean),
          tool: 'Sub-agent response',
        }, text, {
          force: true,
          maxTextBytes: ACTIVITY_PROGRESS_MAX_BYTES,
        });
        await this.finalizeThinkingActivities({ turnId: parentTurnId, itemId });
      }
    } else if (method === 'error' || method === 'warning') {
      await this.emitDiagnostic({
        severity: method === 'error' ? 'warning' : 'info',
        source: 'codex',
        kind: 'collaboration',
        method: `foreign-thread/${method}`,
        message: limitText(
          params.error?.message || params.message || `${method} from sub-agent thread`,
          300
        ),
        data: {
          threadId: sourceThreadId,
          turnId: params.turnId || params.turn?.id || null,
        },
      });
    }
    return true;
  }

  async handleNotification(message) {
    const method = message.method;
    const params = message.params || {};
    const observedTurnOwnership = message?.[NOTIFICATION_TURN_OWNERSHIP] || null;
    const observedSubmissionOwnership = message?.[NOTIFICATION_SUBMISSION_OWNERSHIP] || null;
    const foreignThread = this.foreignNotificationSource(method, params, message);
    if (foreignThread) {
      await this.handleForeignThreadNotification(method, params, foreignThread);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const itemTurnId = String(params.turnId || '').trim();
      if (
        itemTurnId
        && this.isTerminalTurnId(itemTurnId)
        && itemTurnId !== String(this.activeTurnId || '').trim()
      ) {
        await this.emitDiagnostic({
          severity: 'info',
          source: 'runtime',
          kind: 'turn-reconciliation',
          method,
          message: `Ignored late item notification for terminal Turn ${itemTurnId}.`,
          turnId: itemTurnId,
        }).catch(() => {});
        return;
      }
      this.rememberNotificationItemPhase(params);
    }

    const notificationTurnId = String(params.turnId || '').trim();
    if (
      method.startsWith('item/')
      && notificationTurnId
      && this.activeTurnId
      && notificationTurnId !== String(this.activeTurnId || '').trim()
      && !this.subagentParentTurns?.has?.(String(params.threadId || '').trim())
    ) {
      await this.emitDiagnostic({
        severity: 'info',
        source: 'runtime',
        kind: 'turn-reconciliation',
        method,
        message: `Ignored item notification for inactive Turn ${notificationTurnId}.`,
        turnId: notificationTurnId,
      }).catch(() => {});
      return;
    }

    if (method === 'thread/started' && params.thread?.id) {
      const pendingSubmission = this.pendingSubmissionReconciliation;
      const preservesPendingSubmission = Boolean(
        pendingSubmission
        && this.submissionOwnershipMatches(pendingSubmission)
        && pendingSubmission.threadId === String(params.thread.id || '').trim()
      );
      if (pendingSubmission && !preservesPendingSubmission) {
        this.cancelSubmissionReconciliation();
      }
      this.threadId = params.thread.id;
      this.nativeThreadId = params.thread.id;
      this.runtime.nativeThreadId = params.thread.id;
      if (this.threadOpenConfirmed) {
        this.sessionId = params.thread.id;
      }
      await this.emitRuntime({
        threadId: params.thread.id,
        ...(preservesPendingSubmission
          ? {
            phase: this.runtime.phase || 'submitting-turn',
            busy: true,
            currentTurnStatus: this.runtime.currentTurnStatus || 'submitting',
          }
          : this.threadOpenConfirmed
          ? this.confirmedThreadOpenRuntimePatch()
          : {
            phase: ['idle', 'error'].includes(String(this.runtime.phase || ''))
              ? 'opening-thread'
              : this.runtime.phase || 'opening-thread',
            startupStep: this.runtime.startupStep || 'opening-thread',
            busy: true,
            currentTurnStatus: 'starting',
          }),
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'thread',
        method,
        message: `Thread started: ${params.thread.id}`,
        data: params.thread || null,
      });
      return;
    }

    if (method === 'thread/status/changed') {
      const status = params.status || null;
      const type = status?.type || 'unknown';
      if (type === 'systemError') {
        this.cancelThreadIdleReconciliation();
        const pendingSubmission = this.submissionCandidate();
        const matchesPendingSubmission = Boolean(
          pendingSubmission
          && observedSubmissionOwnership
          && this.submissionObservationMatches(
            observedSubmissionOwnership,
            pendingSubmission
          )
        );
        if (pendingSubmission && !this.activeTurnId) {
          if (!matchesPendingSubmission) {
            await this.ignoreMismatchedSubmissionNotification(method, params);
          } else {
            pendingSubmission.candidateSystemError = {
              params,
              observedAt: nowIso(),
            };
          }
          await this.publishUnknownSubmissionReconciliation(pendingSubmission, {
            reason: matchesPendingSubmission
              ? 'system-error-awaiting-turn-evidence'
              : 'system-error-unverified',
            message: 'Codex reported a system error without enough evidence to bind it to the submitted prompt; continuing read-only reconciliation.',
          });
          return;
        }
        if (this.activeTurnId && !this.activeTurnOwnershipMatches(observedTurnOwnership)) {
          await this.emitDiagnostic({
            severity: 'info',
            source: 'runtime',
            kind: 'turn-reconciliation',
            method,
            message: 'Ignored stale systemError status because active Turn ownership changed before delivery.',
            turnId: this.activeTurnId,
            data: { observedTurnId: observedTurnOwnership?.turnId || null },
          }).catch(() => {});
          return;
        }
        const turnId = params.turnId || this.activeTurnId;
        if (!turnId && !matchesPendingSubmission && !this.activeTurnId) {
          this.cancelSubmissionReconciliation();
        }
        const clientRequestId = this.clientRequestIdForTurn(turnId)
          || pendingSubmission?.clientRequestId
          || this.activeClientRequestId
          || null;
        const concreteTerminalErrorAlreadyPublished = Boolean(
          !this.activeTurnId
          && this.runtime.lastCodexError
          && this.runtime.lastCodexError !== 'systemError'
          && ['error', 'quota-exhausted'].includes(String(this.runtime.phase || '').toLowerCase())
          && ['failed', 'error'].includes(String(this.runtime.currentTurnStatus || '').toLowerCase())
        );
        if (concreteTerminalErrorAlreadyPublished) {
          if (clientRequestId && this.activeClientRequestId === clientRequestId) {
            this.activeClientRequestId = null;
          }
          await this.emitDiagnostic({
            severity: 'info',
            source: 'codex',
            kind: 'thread-status',
            method,
            message: 'Ignored late systemError status after a concrete terminal Codex error.',
            data: status,
          });
          return;
        }
        this.rememberTerminalTurnId(turnId);
        const errorText = String(
          params.error?.message
          || status?.message
          || 'Codex thread entered a system error state.'
        );
        const codexError = describeCodexError(
          params.error?.codexErrorInfo || status?.codexErrorInfo || null
        ) || 'systemError';
        const inputCapabilityError = classifyCodexInputCompatibilityError(
          errorText,
          this.turnInputTypes.get(String(turnId || '')) || pendingSubmission?.inputTypes || []
        );
        this.rememberSystemErrorTurn(turnId, { clientRequestId });
        let activityFlushError = null;
        try {
          await this.finalizeThinkingActivities({ turnId });
        } catch (error) {
          activityFlushError = error;
        }
        if (turnId) {
          await this.resolvePendingInterruptForTerminalTurn(turnId, 'failed');
        } else if (this.pendingInterruptIntent) {
          await this.settlePendingInterrupt(this.pendingInterruptIntent, {
            status: 'no_active',
            reason: 'turn_already_failed',
            turnId: null,
            clientRequestId,
          });
        }
        this.activeTurnId = null;
        this.activeTurnLifecycleId = null;
        await this.resolvePendingRequestsForClosedTurn(
          'failed',
          'Request closed because the Codex thread entered a system error state.'
        );
        await this.emitRuntime({
          clientRequestId,
          threadStatus: status,
          phase: 'error',
          activeTurnId: null,
          busy: false,
          waitingOnApproval: false,
          waitingOnUserInput: false,
          currentTurnStatus: 'failed',
          pendingInputSummary: null,
          pendingClientRequestId: null,
          queuedCommandId: null,
          queuedInputAt: null,
          terminalReconciliation: null,
          submissionReconciliation: null,
          lastError: errorText,
          lastCodexError: inputCapabilityError?.code || codexError,
          userFacingError: inputCapabilityError?.userMessage || null,
        });
        if (turnId) {
          this.releaseClientRequestIdForTurn(turnId);
        } else if (clientRequestId && this.activeClientRequestId === clientRequestId) {
          this.activeClientRequestId = null;
        }
        await this.postEvent({
          type: 'session.error',
          hostId: this.hostId,
          sessionId: this.currentSessionId(),
          runId: this.runId,
          turnId: turnId || null,
          clientRequestId,
          message: errorText,
          codexError,
          inputCapabilityError,
          provisionalSystemError: true,
          timestamp: nowIso(),
        });
        await this.emitDiagnostic({
          severity: 'error',
          source: 'codex',
          kind: 'thread-status',
          method,
          message: errorText,
          detail: codexError,
          data: status,
          turnId,
        });
        if (turnId) {
          this.releaseTurnBuffer(turnId);
          this.turnModes.delete(turnId);
        }
        if (activityFlushError) throw activityFlushError;
        return;
      }
      const pendingSubmission = this.submissionCandidate();
      if (
        pendingSubmission
        && this.submissionAttemptIdentityMatchesCurrent(pendingSubmission)
      ) {
        if (!this.submissionObservationMatches(observedSubmissionOwnership, pendingSubmission)) {
          await this.ignoreMismatchedSubmissionNotification(method, params);
          return;
        }
        if (this.pendingSubmissionReconciliation === pendingSubmission) {
          await this.publishUnknownSubmissionReconciliation(pendingSubmission, {
            reason: `thread-status-${String(type || 'unknown').replace(/[-_\s]/g, '').toLowerCase()}`,
            message: 'Codex changed thread state before identifying the accepted Turn; continuing read-only reconciliation.',
            preserveSchedule: true,
          });
        }
        return;
      }
      if (type === 'idle' && this.activeTurnId) {
        const scheduled = await this.scheduleThreadIdleReconciliation(
          status,
          observedTurnOwnership
        );
        if (scheduled) {
          await this.emitDiagnostic({
            severity: 'info',
            source: 'runtime',
            kind: 'turn-reconciliation',
            method,
            message: 'Codex reported idle before the active Turn emitted a terminal event; awaiting confirmation.',
            turnId: observedTurnOwnership?.turnId || this.activeTurnId,
          });
          return;
        }
        await this.emitDiagnostic({
          severity: 'info',
          source: 'runtime',
          kind: 'turn-reconciliation',
          method,
          message: 'Ignored stale idle status because the active Turn ownership changed before delivery.',
          turnId: this.activeTurnId,
          data: { observedTurnId: observedTurnOwnership?.turnId || null },
        });
        return;
      }
      if (type === 'active') this.cancelThreadIdleReconciliation();
      const waitingOnApproval = Array.isArray(status?.activeFlags) && status.activeFlags.includes('waitingOnApproval');
      const waitingOnUserInput = Array.isArray(status?.activeFlags) && status.activeFlags.includes('waitingOnUserInput');
      if (!this.threadOpenConfirmed) {
        await this.emitRuntime({
          threadStatus: status || null,
          phase: ['idle', 'error'].includes(String(this.runtime.phase || ''))
            ? 'opening-thread'
            : this.runtime.phase || 'opening-thread',
          startupStep: this.runtime.startupStep || 'opening-thread',
          busy: true,
          waitingOnApproval: false,
          waitingOnUserInput: false,
          currentTurnStatus: 'starting',
          terminalReconciliation: null,
        });
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: 'thread-open-progress',
          method,
          message: describeThreadStatus(status),
          data: status,
        });
        return;
      }
      const unresolvedWork = this.hasUnconfirmedSubmission() || this.hasPendingApprovalOrInputRequest();
      await this.emitRuntime({
        ...(type === 'active' ? this.activeTurnRecoveryPatch(this.activeTurnId) || {} : {}),
        threadStatus: status || null,
        phase: waitingOnApproval
          ? 'waiting-approval'
          : waitingOnUserInput
            ? 'waiting-user-input'
            : type === 'active'
              ? 'thinking'
              : type === 'systemError'
                ? 'error'
                : unresolvedWork ? this.runtimePhaseForResolvedRequest() : 'idle',
        busy: type === 'active' || unresolvedWork,
        waitingOnApproval,
        waitingOnUserInput,
        terminalReconciliation: null,
        ...(type === 'idle' ? this.settledThreadStartupStatusPatch(status) : {}),
      });
      await this.emitDiagnostic({
        severity: type === 'systemError' ? 'error' : 'info',
        source: 'codex',
        kind: 'thread-status',
        method,
        message: describeThreadStatus(status),
        data: status,
      });
      return;
    }

    if (method === 'thread/goal/updated') {
      await this.emitRuntime({
        goal: params.goal || null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'goal',
        method,
        message: params.goal
          ? `Goal ${params.goal.status || 'active'}: ${limitText(params.goal.objective || '', 180)}`
          : 'Goal updated.',
        data: params || null,
      });
      return;
    }

    if (method === 'thread/goal/cleared') {
      await this.emitRuntime({
        goal: null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'goal',
        method,
        message: 'Goal cleared.',
        data: params || null,
      });
      return;
    }

    if (method === 'turn/started') {
      const startedTurnId = params.turn?.id || params.turnId || this.activeTurnId;
      if (this.isTerminalTurnId(startedTurnId)) {
        await this.resolvePendingInterruptForTerminalTurn(
          startedTurnId,
          params.turn?.status?.type || 'completed'
        );
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: 'turn',
          method,
          message: `Ignored late start for terminal turn ${startedTurnId || '(unknown)'}.`,
          data: params.turn || null,
        });
        return;
      }
      if (
        this.activeTurnId
        && String(startedTurnId || '').trim() !== String(this.activeTurnId || '').trim()
      ) {
        await this.emitDiagnostic({
          severity: 'info',
          source: 'runtime',
          kind: 'turn-reconciliation',
          method,
          message: `Ignored late start for inactive turn ${startedTurnId || '(unknown)'}.`,
          turnId: startedTurnId || null,
          data: { activeTurnId: this.activeTurnId },
        }).catch(() => {});
        return;
      }
      this.cancelThreadIdleReconciliation();
      const pendingBeforeStart = this.submissionCandidate();
      if (pendingBeforeStart && !this.activeTurnId) {
        const adopted = this.adoptPendingSubmissionFromNotification(params, message);
        if (!adopted) {
          await this.ignoreMismatchedSubmissionNotification(method, params);
          return;
        }
      }
      this.activeTurnId = startedTurnId;
      this.adoptTurnLifecycle(startedTurnId);
      this.bindClientRequestIdToTurn(this.activeTurnId);
      if (this.activeTurnId && !this.turnBuffers.has(this.activeTurnId)) {
        this.resetTurnBuffer(this.activeTurnId);
      }
      const turnMode = this.activeTurnId ? this.turnModes.get(this.activeTurnId) : '';
      if (await this.applyPendingInterruptIntent(this.activeTurnId)) {
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: 'turn',
          method,
          message: `Turn started and pending interrupt was applied${this.activeTurnId ? `: ${this.activeTurnId}` : ''}`,
          data: params.turn || null,
        });
        return;
      }
      await this.emitActiveTurnRuntimeWithRetry(this.activeTurnId, {
        clientRequestId: this.clientRequestIdForTurn(this.activeTurnId),
        activeTurnId: this.activeTurnId,
        pendingClientRequestId: null,
        submissionReconciliation: null,
        busy: true,
        phase: turnMode === 'plan' ? 'planning' : 'thinking',
        currentTurnStatus: params.turn?.status?.type || 'inProgress',
        lastError: null,
        lastCodexError: null,
        userFacingError: null,
        terminalReconciliation: null,
        reasoningSummary: null,
        planSummary: null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'turn',
        method,
        message: `Turn started${this.activeTurnId ? `: ${this.activeTurnId}` : ''}`,
        data: params.turn || null,
      });
      return;
    }

    if (method === 'item/started') {
      const activity = normalizeAppServerActivityItem(params.item, params, 'started');
      if (activity) {
        if (
          activity.identity.turnId
          && this.activeTurnId
          && String(activity.identity.turnId) !== String(this.activeTurnId)
        ) {
          await this.emitDiagnostic({
            severity: 'info',
            source: 'runtime',
            kind: 'turn-reconciliation',
            method,
            message: `Ignored item start for inactive Turn ${activity.identity.turnId}.`,
            turnId: activity.identity.turnId,
          }).catch(() => {});
          return;
        }
        this.rememberSubagentParentTurn(activity);
        await this.emitActiveTurnRecoveryIfNeeded(activity.identity.turnId);
        this.replaceActivitySnapshot(activity.identity, activity.text, {
          force: true,
          maxTextBytes: activity.identity.kind === 'command'
            ? ACTIVITY_OUTPUT_MAX_BYTES
            : ACTIVITY_PROGRESS_MAX_BYTES,
        });
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: activity.identity.kind,
          method,
          message: limitText(activity.text, 300),
          turnId: activity.identity.turnId,
          data: activity.identity,
        });
        return;
      }
    }

    if (method === 'item/agentMessage/delta') {
      const turnId = params.turnId || this.activeTurnId;
      if (!turnId) {
        return;
      }
      const text = notificationDeltaText(params);
      if (text) {
        await this.emitActiveTurnRecoveryIfNeeded(turnId, { phase: 'thinking' });
      }
      if (this.resolvedNotificationPhase(params) === 'commentary') {
        if (text) {
          this.appendActivityDelta({
            turnId,
            itemId: params.itemId || null,
            kind: 'commentary',
            itemType: 'agentMessage',
            method,
            status: 'inProgress',
          }, text, { maxTextBytes: ACTIVITY_PROGRESS_MAX_BYTES });
        }
        return;
      }
      this.appendTurnBuffer(turnId, params.delta || '');
      return;
    }

    if (method === 'item/commandExecution/outputDelta' || method === 'process/outputDelta' || method === 'command/exec/outputDelta') {
      const turnId = params.turnId || this.activeTurnId;
      const outputDelta = structuredText(params.delta ?? params.deltaBase64);
      const outputTruncated = params.capReached === true || params.truncated === true;
      if (outputDelta || outputTruncated) {
        await this.emitActiveTurnRecoveryIfNeeded(turnId);
        const commandActivityIdentity = {
          turnId,
          itemId: params.itemId || params.processId || params.processHandle,
          callId: params.callId || params.itemId || null,
          ...(params.requestId ? { requestId: params.requestId } : {}),
          kind: 'command',
          itemType: 'commandExecution',
          method,
          status: 'inProgress',
          ...(params.processId || params.processHandle
            ? { processId: params.processId || params.processHandle }
            : {}),
          ...(params.source ? { source: params.source } : {}),
          ...(outputTruncated ? { outputTruncated: true } : {}),
        };
        this.appendActivityFieldDelta(
          commandActivityIdentity,
          'output',
          outputDelta,
          { maxTextBytes: ACTIVITY_OUTPUT_MAX_BYTES, truncated: outputTruncated }
        );
        const outputStream = String(params.stream || '').toLowerCase();
        if (outputStream === 'stdout' || outputStream === 'stderr') {
          this.appendActivityFieldDelta(
            commandActivityIdentity,
            outputStream,
            outputDelta,
            { maxTextBytes: ACTIVITY_OUTPUT_MAX_BYTES }
          );
        }
      }
      return;
    }

    if (method === 'item/fileChange/patchUpdated') {
      const turnId = params.turnId || this.activeTurnId;
      const itemId = params.itemId || params.callId || params.requestId;
      const fileChanges = normalizeAppServerFileChanges(
        params.changes || params.fileChanges || params.file_changes
      );
      const message = fileChanges.length
        ? `Updated patch for ${fileChanges.length} file(s)`
        : 'File patch updated';
      await this.emitActiveTurnRecoveryIfNeeded(turnId);
      this.replaceActivitySnapshot({
        turnId,
        itemId,
        callId: params.callId || itemId || null,
        ...(params.requestId ? { requestId: params.requestId } : {}),
        kind: 'file-change',
        itemType: 'fileChange',
        method,
        status: 'inProgress',
        fileChanges,
        changes: fileChanges,
      }, message, { force: true, maxTextBytes: ACTIVITY_PROGRESS_MAX_BYTES });
      return;
    }

    if (method === 'item/mcpToolCall/progress') {
      const turnId = params.turnId || this.activeTurnId;
      const itemId = params.itemId || params.callId || params.requestId;
      const progress = truncateUtf8(
        params.message || params.progress || '',
        ACTIVITY_PROGRESS_MAX_BYTES,
        NOTIFICATION_TRUNCATION_SUFFIX
      );
      if (progress) {
        await this.emitActiveTurnRecoveryIfNeeded(turnId);
        this.appendActivityFieldDelta({
          turnId,
          itemId,
          callId: params.callId || itemId || null,
          ...(params.requestId ? { requestId: params.requestId } : {}),
          kind: 'mcp-tool',
          itemType: 'mcpToolCall',
          method,
          status: 'inProgress',
        }, 'progress', progress, {
          maxTextBytes: ACTIVITY_PROGRESS_MAX_BYTES,
          separator: '\n',
        });
      }
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta') {
      const turnId = params.turnId || this.activeTurnId;
      const reasoningChunk = structuredText(params.delta);
      if (reasoningChunk && this.activeTurnRecoveryNeeded(turnId)) {
        await this.emitActiveTurnRecoveryIfNeeded(turnId, { phase: 'thinking' });
      }
      this.appendThinkingDelta({
        turnId,
        itemId: params.itemId,
        summaryIndex: params.summaryIndex ?? 0,
      }, reasoningChunk);
      return;
    }

    if (method === 'item/plan/delta' || method === 'turn/plan/updated') {
      const turnId = params.turnId || this.activeTurnId;
      const planChunk = normalizeThinkingText(params.delta || params.plan || '');
      if (planChunk && this.activeTurnRecoveryNeeded(turnId)) {
        await this.emitActiveTurnRecoveryIfNeeded(turnId, { phase: 'planning' });
      }
      const identity = {
        turnId,
        itemId: params.itemId
          || (method === 'turn/plan/updated' && turnId ? `turn-plan:${turnId}` : null),
        kind: 'plan',
        itemType: 'plan',
        method,
        status: 'inProgress',
      };
      if (method === 'turn/plan/updated') {
        this.replaceActivitySnapshot(identity, planChunk, {
          maxTextBytes: ACTIVITY_PROGRESS_MAX_BYTES,
        });
      } else {
        this.appendActivityDelta(identity, planChunk, {
          maxTextBytes: ACTIVITY_PROGRESS_MAX_BYTES,
        });
      }
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      await this.emitRuntime({
        tokenUsage: params.tokenUsage || null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'token-usage',
        method,
        message: `Token usage updated${params.tokenUsage?.total?.totalTokens != null ? `: ${params.tokenUsage.total.totalTokens}` : ''}`,
        data: params.tokenUsage || null,
      });
      return;
    }

    if (method === 'account/rateLimits/updated') {
      await this.emitRuntime({
        rateLimits: params.rateLimits || null,
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'codex',
        kind: 'rate-limits',
        method,
        message: `Rate limits updated${params.rateLimits?.rateLimitReachedType ? `: ${params.rateLimits.rateLimitReachedType}` : ''}`,
        data: params.rateLimits || null,
      });
      return;
    }

    if (method === 'item/commandExecution/terminalInteraction') {
      await this.emitActiveTurnRecoveryIfNeeded(params.turnId || this.activeTurnId);
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'terminal',
        method,
        message: `Terminal input for process ${params.processId || 'unknown'}`,
        data: {
          itemId: params.itemId || null,
          processId: params.processId || null,
          stdin: limitText(params.stdin || '', 240),
        },
      });
      return;
    }

    if (method === 'item/completed') {
      const turnId = params.turnId || this.activeTurnId;
      const itemId = params.item?.id || params.itemId;
      if (isAppServerAssistantMessageItem(params.item)) {
        const phase = this.resolvedNotificationPhase({ ...params, itemId });
        const text = appServerAssistantMessageText(
          params.item,
          turnId ? this.turnBuffers.get(turnId) : ''
        );
        if (phase !== 'commentary' && text && itemId) {
          await this.emitAssistantTranscript(text, {
            turnId,
            itemId,
            phase: phase || 'final',
            sourceTimestamp: params.item?.timestamp,
          });
        }
        await this.flushPendingTurnCompletion(turnId);
        return;
      }
      if (params.item?.type === 'reasoning') {
        await this.emitActiveTurnRecoveryIfNeeded(turnId);
        const summaries = Array.isArray(params.item.summary) ? params.item.summary : [];
        summaries.forEach((summary, summaryIndex) => {
          this.replaceThinkingSnapshot({
            turnId,
            itemId,
            summaryIndex,
            method,
            status: 'completed',
            completedAtMs: boundedActivityNumber(params.completedAtMs),
          }, persistedReasoningSummaryText(summary));
        });
        await this.finalizeThinkingActivities({ turnId, itemId });
        return;
      }
      const activity = normalizeAppServerActivityItem(params.item, { ...params, turnId }, 'completed');
      if (activity) {
        this.rememberSubagentParentTurn(activity);
        await this.emitActiveTurnRecoveryIfNeeded(turnId);
        this.replaceActivitySnapshot(activity.identity, activity.text, {
          force: true,
          maxTextBytes: activity.identity.kind === 'command'
            ? ACTIVITY_OUTPUT_MAX_BYTES
            : ACTIVITY_PROGRESS_MAX_BYTES,
        });
        await this.finalizeThinkingActivities({ turnId, itemId });
        await this.emitDiagnostic({
          severity: ['failed', 'declined'].includes(String(activity.identity.status || '').toLowerCase())
            ? 'error'
            : 'info',
          source: 'codex',
          kind: activity.identity.kind,
          method,
          message: limitText(activity.text, 300),
          turnId,
          data: activity.identity,
        });
        return;
      }
    }

    if (method === 'turn/completed') {
      const turnId = params.turn?.id || params.turnId || this.activeTurnId;
      const pendingBeforeCompletion = this.submissionCandidate();
      if (pendingBeforeCompletion && !this.activeTurnId) {
        const adopted = this.adoptPendingSubmissionFromNotification(params, message);
        if (!adopted) {
          await this.ignoreMismatchedSubmissionNotification(method, params);
          return;
        }
      }
      if (String(turnId || '').trim() === String(this.activeTurnId || '').trim()) this.cancelThreadIdleReconciliation();
      this.bindClientRequestIdToTurn(turnId);
      this.rememberTerminalTurnId(turnId);
      await this.resolvePendingInterruptForTerminalTurn(turnId, params.turn?.status?.type || 'completed');
      const text = turnId ? (this.turnBuffers.get(turnId) || '').trim() : '';
      if (text && !this.turnAssistantTranscriptEmitted?.has(turnId)) {
        this.deferTurnCompletion(turnId, params);
        return;
      }
      await this.finalizeTurnCompletion(params, turnId);
      return;
    }

    if (method === 'warning') {
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: params.message || 'warning',
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'codex',
        kind: 'warning',
        method,
        message: params.message || 'warning',
        data: params || null,
      });
      return;
    }

    if (method === 'error') {
      const pendingSubmission = this.submissionCandidate();
      const turnId = params.turnId || this.activeTurnId;
      if (pendingSubmission && !this.activeTurnId) {
        const ownershipMatches = this.submissionObservationMatches(
          observedSubmissionOwnership,
          pendingSubmission
        );
        if (!ownershipMatches) {
          await this.ignoreMismatchedSubmissionNotification(method, params);
          return;
        }
        pendingSubmission.candidateTurnId = String(turnId || '').trim() || null;
        pendingSubmission.candidateError = {
          params,
          observedAt: nowIso(),
        };
        await this.publishUnknownSubmissionReconciliation(pendingSubmission, {
          reason: turnId ? 'error-turn-unverified' : 'error-without-turn',
          message: 'Codex reported an error before the submitted Turn could be verified; continuing read-only reconciliation.',
        });
        return;
      }
      if (
        this.activeTurnId
        && !params.turnId
        && !this.activeTurnOwnershipMatches(observedTurnOwnership)
      ) {
        await this.emitDiagnostic({
          severity: 'info',
          source: 'runtime',
          kind: 'turn-reconciliation',
          method,
          message: 'Ignored an unscoped error because active Turn ownership changed before delivery.',
          turnId: this.activeTurnId,
        }).catch(() => {});
        return;
      }
      this.bindClientRequestIdToTurn(turnId);
      if (!params.willRetry) {
        if (!turnId && pendingSubmission) this.cancelSubmissionReconciliation();
        if (String(turnId || '').trim() === String(this.activeTurnId || '').trim()) this.cancelThreadIdleReconciliation();
        this.rememberTerminalTurnId(turnId);
        if (turnId) {
          await this.resolvePendingInterruptForTerminalTurn(turnId, 'failed');
        } else if (pendingSubmission && this.pendingInterruptIntent) {
          await this.settlePendingInterrupt(this.pendingInterruptIntent, {
            status: 'no_active',
            reason: 'turn_already_failed',
            turnId: null,
            clientRequestId: pendingSubmission.clientRequestId,
          });
        }
      }
      const affectsActiveTurn = Boolean(
        (turnId && String(turnId) === String(this.activeTurnId || ''))
        || (!turnId && !params.willRetry && pendingSubmission)
      );
      const clientRequestId = this.clientRequestIdForTurn(turnId)
        || pendingSubmission?.clientRequestId
        || null;
      const pieces = [params.error?.message || 'codex error'];
      if (params.error?.additionalDetails) {
        pieces.push(params.error.additionalDetails);
      }
      const text = pieces.filter(Boolean).join('\n');
      const codexError = describeCodexError(params.error?.codexErrorInfo || null);
      const inputCapabilityError = classifyCodexInputCompatibilityError(
        text,
        this.turnInputTypes.get(String(turnId || '')) || pendingSubmission?.inputTypes || []
      );
      const pendingSystemError = !params.willRetry
        ? this.takeSystemErrorTurn(turnId)
        : null;
      const refinesCurrentSystemError = Boolean(
        pendingSystemError
        && !this.activeTurnId
        && this.runtime.lastCodexError === 'systemError'
        && (
          !this.activeClientRequestId
          || this.activeClientRequestId === pendingSystemError.clientRequestId
        )
      );
      let activityFlushError = null;
      if (!affectsActiveTurn) {
        if (refinesCurrentSystemError) {
          await this.emitRuntime({
            clientRequestId: pendingSystemError.clientRequestId || null,
            phase: codexError === 'usageLimitExceeded' || codexError === 'contextWindowExceeded'
              ? 'quota-exhausted'
              : 'error',
            activeTurnId: null,
            busy: false,
            waitingOnApproval: false,
            waitingOnUserInput: false,
            currentTurnStatus: 'failed',
            pendingInputSummary: null,
            pendingClientRequestId: null,
            queuedCommandId: null,
            queuedInputAt: null,
            terminalReconciliation: null,
            lastError: text,
            lastCodexError: inputCapabilityError?.code || codexError,
            userFacingError: inputCapabilityError?.userMessage || null,
          });
          await this.postEvent({
            type: 'session.error',
            hostId: this.hostId,
            sessionId: this.currentSessionId(),
            runId: this.runId,
            turnId: turnId || null,
            clientRequestId: pendingSystemError.clientRequestId || null,
            message: text,
            codexError,
            inputCapabilityError,
            supersedesProvisionalError: true,
            timestamp: nowIso(),
          });
          await this.emitDiagnostic({
            severity: 'error',
            source: 'codex',
            kind: 'error',
            method,
            message: text,
            detail: codexError || null,
            data: params.error || null,
            turnId: turnId || null,
          });
          this.releaseTurnBuffer(turnId);
          this.releaseTurnItemPhases(turnId);
          this.turnModes.delete(turnId);
          return;
        }
        await this.finalizeThinkingActivities({ turnId }).catch(() => {});
        this.releaseTurnBuffer(turnId);
        this.releaseTurnItemPhases(turnId);
        this.turnModes.delete(turnId);
        this.releaseClientRequestIdForTurn(turnId);
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: 'error',
          method,
          message: `Ignored late error for inactive turn ${turnId || '(unknown)'}: ${text}`,
          detail: codexError || null,
          data: params.error || null,
          turnId: turnId || null,
        });
        return;
      }
      if (params.willRetry) {
        this.cancelThreadIdleReconciliation();
        await this.emitRuntime({
          clientRequestId,
          phase: String(codexError || '').startsWith('responseStreamDisconnected') ? 'reconnecting' : 'retrying',
          terminalReconciliation: null,
          lastError: text,
          lastCodexError: inputCapabilityError?.code || codexError,
          userFacingError: inputCapabilityError?.userMessage || null,
        });
        await this.emitAlert({
          severity: 'warning',
          source: 'codex',
          message: inputCapabilityError?.userMessage || text,
          inputCapabilityError,
          transient: true,
          turnId: turnId || null,
        });
      } else {
        try {
          await this.finalizeThinkingActivities({ turnId });
        } catch (error) {
          activityFlushError = error;
        }
        this.activeTurnId = null;
        this.activeTurnLifecycleId = null;
        await this.resolvePendingRequestsForClosedTurn(
          'failed',
          'Request closed because the Codex turn failed.'
        );
        await this.emitRuntime({
          clientRequestId,
          phase: codexError === 'usageLimitExceeded' || codexError === 'contextWindowExceeded' ? 'quota-exhausted' : 'error',
          activeTurnId: null,
          busy: false,
          waitingOnApproval: false,
          waitingOnUserInput: false,
          currentTurnStatus: 'failed',
          pendingInputSummary: null,
          pendingClientRequestId: null,
          queuedCommandId: null,
          queuedInputAt: null,
          terminalReconciliation: null,
          submissionReconciliation: null,
          lastError: text,
          lastCodexError: inputCapabilityError?.code || codexError,
          userFacingError: inputCapabilityError?.userMessage || null,
        });
        if (turnId) {
          this.releaseClientRequestIdForTurn(turnId);
        } else if (clientRequestId && this.activeClientRequestId === clientRequestId) {
          this.activeClientRequestId = null;
        }
        await this.postEvent({
          type: 'session.error',
          hostId: this.hostId,
          sessionId: this.currentSessionId(),
          runId: this.runId,
          turnId: turnId || null,
          clientRequestId,
          message: text,
          codexError,
          inputCapabilityError,
          timestamp: nowIso(),
        });
      }
      await this.emitDiagnostic({
        severity: params.willRetry ? 'warning' : 'error',
        source: 'codex',
        kind: 'error',
        method,
        message: text,
        detail: codexError || null,
        data: params.error || null,
        turnId: turnId || null,
        clientRequestId,
      });
      if (turnId && !params.willRetry) {
        this.turnAssistantTranscriptEmitted?.delete(turnId);
        this.releaseTurnBuffer(turnId);
        this.turnModes.delete(turnId);
      }
      if (activityFlushError) throw activityFlushError;
      return;
    }

    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'notification',
      method,
      message: limitText(summarizeValue(params), 320),
      data: params,
    });
  }

  async finalizeTurnCompletion(params, turnId) {
    const normalizedTurnId = String(turnId || '').trim();
    const rolloutPublication = await this.publishManagedSessionRollout('turn-completed');
    if (normalizedTurnId === String(this.activeTurnId || '').trim()) {
      this.cancelThreadIdleReconciliation();
    }
    this.rememberTerminalTurnId(normalizedTurnId);
    const completedClientRequestId = this.clientRequestIdForTurn(normalizedTurnId);
    const completesActiveTurn = Boolean(
      normalizedTurnId
      && (
        normalizedTurnId === String(this.activeTurnId || '').trim()
        || (
          !this.activeTurnId
          && completedClientRequestId
          && completedClientRequestId === this.activeClientRequestId
        )
      )
    );
    let activityFlushError = null;
    try {
      await this.finalizeThinkingActivities({ turnId });
    } catch (error) {
      activityFlushError = error;
    }
    const text = turnId ? (this.turnBuffers.get(turnId) || '').trim() : '';
    if (text && !this.turnAssistantTranscriptEmitted?.has(turnId)) {
      await this.emitAssistantTranscript(text, {
        turnId,
        itemId: `fallback:${normalizedTurnId || 'unknown'}`,
      });
    }
    if (turnId) {
      this.releaseTurnBuffer(turnId);
      this.releaseTurnItemPhases(turnId);
      this.turnModes.delete(turnId);
    }
    if (completesActiveTurn) {
      this.activeTurnId = null;
      this.activeTurnLifecycleId = null;
    }
    if (completesActiveTurn) {
      await this.resolvePendingRequestsForClosedTurn(
        params.turn?.status?.type === 'failed' ? 'failed' : 'expired',
        `Request closed because the turn completed as ${params.turn?.status?.type || 'completed'}.`
      );
      await this.emitRuntime({
        clientRequestId: completedClientRequestId,
        ...(rolloutPublication.becameNativeResumeReady
          ? { nativeResumeReady: true }
          : {}),
        activeTurnId: null,
        busy: false,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        phase: params.turn?.status?.type === 'interrupted'
          ? 'interrupted'
          : params.turn?.status?.type === 'failed'
            ? 'error'
            : 'idle',
        currentTurnStatus: params.turn?.status?.type || 'completed',
        pendingInputSummary: null,
        pendingClientRequestId: null,
        queuedCommandId: null,
        queuedInputAt: null,
        terminalReconciliation: null,
        ...(params.turn?.status?.type === 'failed'
          ? {}
          : { lastError: null, lastCodexError: null, userFacingError: null }),
      });
    } else if (rolloutPublication.becameNativeResumeReady) {
      await this.emitRuntime({ nativeResumeReady: true });
    }
    this.releaseClientRequestIdForTurn(normalizedTurnId);
    await this.emitDiagnostic({
      severity: params.turn?.status?.type === 'failed' && completesActiveTurn ? 'error' : 'info',
      source: 'codex',
      kind: 'turn',
      method: 'turn/completed',
      message: completesActiveTurn
        ? `Turn completed: ${params.turn?.status?.type || 'completed'}`
        : `Ignored late completion for inactive turn ${normalizedTurnId || '(unknown)'}.`,
      data: {
        ...(params.turn || {}),
        activeRuntimeChanged: completesActiveTurn,
      },
      turnId: normalizedTurnId || null,
      clientRequestId: completedClientRequestId,
    });
    if (activityFlushError) throw activityFlushError;
  }

  async handleServerRequest(message, ingress = {}) {
    const method = message.method;
    const params = message.params || {};
    const ownership = this.captureServerRequestOwnership(params, ingress);
    const requiresTurnOwnership = [
      'item/tool/requestUserInput',
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
    ].includes(method);
    const hasExplicitTurnOwnership = Boolean(
      String(params.threadId || '').trim()
      && String(params.turnId || '').trim()
    );
    if (
      (requiresTurnOwnership && !hasExplicitTurnOwnership)
      || !this.serverRequestOwnershipMatchesCurrent(ownership)
    ) {
      ownership.rpc?.respondError?.(
        message.id,
        -32000,
        'Request no longer belongs to the active Codex Run or Turn.'
      );
      await this.emitDiagnostic({
        severity: 'info',
        source: 'runtime',
        kind: 'request-routing',
        method,
        message: 'Ignored a stale Codex server request after its Run or Turn ownership changed.',
        turnId: params.turnId || null,
        data: {
          requestId: String(message.id ?? ''),
          threadId: params.threadId || null,
        },
      }).catch(() => {});
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      const labels = Array.isArray(params.questions)
        ? params.questions.map((question) => question.header || question.id || 'question').join(', ')
        : 'question';
      const requestId = String(message.id);
      this.resolvedRequests.delete(requestId);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: labels,
        ownership,
      });
      await this.emitRuntime({
        waitingOnUserInput: true,
        busy: true,
        phase: 'waiting-user-input',
      });
      await this.emitRequest({
        requestId,
        kind: 'user-input',
        method,
        title: 'User input required',
        message: labels,
        summary: labels,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: `User input required: ${labels}`,
      });
      return;
    }

    if (method === 'item/commandExecution/requestApproval') {
      const requestId = String(message.id);
      this.resolvedRequests.delete(requestId);
      const command = String(params.command || '').trim();
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: command || params.reason || 'Command approval requested',
        ownership,
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'approval',
        method,
        title: 'Command approval required',
        message: params.reason || command || 'Command approval required',
        summary: command || params.reason || null,
        payload: params,
        availableDecisions: params.availableDecisions || [],
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'Command execution approval was requested.',
      });
      return;
    }

    if (method === 'item/fileChange/requestApproval') {
      const requestId = String(message.id);
      this.resolvedRequests.delete(requestId);
      const fileChanges = normalizeAppServerFileChanges(params.fileChanges);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: params.reason || params.grantRoot || 'File change approval requested',
        ownership,
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'approval',
        method,
        title: 'File change approval required',
        message: params.reason || params.grantRoot || 'File change approval required',
        summary: params.reason || params.grantRoot || null,
        payload: params,
        availableDecisions: params.availableDecisions || [],
      });
      if (fileChanges.length) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'file-change',
          method,
          message: `File change approval requested: ${fileChanges.length} file(s)`,
          data: {
            requestId,
            fileChanges,
            reason: params.reason || null,
            grantRoot: params.grantRoot || null,
          },
        });
      }
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'File change approval was requested.',
      });
      return;
    }

    if (method === 'item/permissions/requestApproval') {
      const requestId = String(message.id);
      this.resolvedRequests.delete(requestId);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: params.reason || 'Permissions approval requested',
        ownership,
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'permissions',
        method,
        title: 'Permissions approval required',
        message: params.reason || 'Permissions approval required',
        summary: params.reason || null,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'Additional permissions were requested.',
      });
      return;
    }

    this.rpc.respondError(message.id, -32601, `Unsupported server request: ${method}`);
  }

  async handleExit(code, signal) {
    this.cancelThreadIdleReconciliation();
    this.cancelSubmissionReconciliation();
    this.cancelRuntimeProjectionRetry();
    this.clearActiveSubmissionAttempt();
    this.childExitConfirmed = true;
    if (
      this.startupStateDbCorruption
      && !this.startCompleted
      && !this.stopRequested
      && !this.terminationPromise
    ) {
      this.startupRetryExit = { code, signal };
      if (typeof this.startupRetryExitResolver === 'function') {
        this.startupRetryExitResolver();
      }
      return;
    }
    if (!this.terminationPromise) {
      this.terminationPromise = this.finalizeExit(code, signal);
    }
    return this.terminationPromise;
  }

  async finalizeExit(code, signal) {
    const terminalErrors = [];
    try {
      await this.drainNotifications();
      await this.flushAllPendingTurnCompletions();
      if (this.agentEventsSuppressed) {
        await this.discardThinkingActivities();
      } else {
        await this.finalizeThinkingActivities();
      }
    } catch (error) {
      const remaining = errorWithoutSuppressedTerminalDelivery(
        error,
        this.agentEventsSuppressed
      );
      if (remaining) terminalErrors.push(remaining);
    }
    if (this.agentEventsSuppressed && this.thinkingActivities.size) {
      await this.discardThinkingActivities();
    }
    await this.publishManagedSessionRollout('process-exit', { silent: true });
    try {
      updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
        childPid: this.child?.pid || null,
        childState: 'exited',
      });
    } catch {
      // Ownership metadata is advisory once the child has confirmed exit.
      // Cleanup still verifies the original owner token before removal.
    }
    const exitingTurnId = String(this.activeTurnId || '').trim();
    if (exitingTurnId) this.rememberTerminalTurnId(exitingTurnId);
    try {
      await this.resolvePendingInterruptForTerminalTurn(
        exitingTurnId,
        this.stopRequested ? 'stopped' : 'exited'
      );
    } catch (error) {
      terminalErrors.push(retryableTerminalDeliveryError(error));
    }
    this.activeTurnId = null;
    this.activeTurnLifecycleId = null;
    this.activeClientRequestId = null;
    this.clientRequestIdsByTurn?.clear?.();
    this.systemErrorsByTurn?.clear?.();
    this.pendingInterruptIntent = null;
    this.clearTurnBuffers();
    this.turnModes.clear();
    try {
      await this.resolvePendingRequestsForClosedTurn(
        'cancelled',
        'Request closed because the Codex app-server exited.'
      );
    } catch (error) {
      terminalErrors.push(retryableTerminalDeliveryError(error));
    }
    try {
      await this.emitRuntime({
        connection: 'closed',
        nativeResumeReady: this.runtime.nativeResumeReady === true,
        busy: false,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        activeTurnId: null,
        phase: 'closed',
        currentTurnStatus: 'closed',
        pendingInputSummary: null,
        pendingClientRequestId: null,
        queuedCommandId: null,
        queuedInputAt: null,
        terminalReconciliation: null,
        submissionReconciliation: null,
        clientRequestId: null,
      }).catch(() => {});
      if (typeof this.onTerminated === 'function') {
        try {
          this.onTerminated(code, signal);
        } catch (error) {
          terminalErrors.push(error);
        }
      }
      if (!this.suppressTerminalEvent) {
        try {
          await this.postEvent({
            type: 'session.state_changed',
            hostId: this.hostId,
            sessionId: this.currentSessionId(),
            runId: this.runId,
            state: this.stopRequested
              ? (this.startCompleted ? 'history-only' : 'failed:start-cancelled')
              : `exited:${code ?? 'null'}:${signal ?? 'null'}`,
            live: false,
            timestamp: nowIso(),
          });
        } catch (error) {
          terminalErrors.push(retryableTerminalDeliveryError(error));
        }
      }
    } finally {
      this.cleanupManagedOverlayAfterExit('process-exit');
    }
    throwTerminalErrors(terminalErrors, 'Codex runner termination did not complete cleanly.');
  }

  async finalizePreSpawnCancellation() {
    const terminalErrors = [];
    try {
      await this.settlePendingInterrupt(this.pendingInterruptIntent, {
        status: 'no_active',
        reason: 'session_stopped',
        turnId: null,
        clientRequestId: this.activeClientRequestId || null,
      });
    } catch (error) {
      terminalErrors.push(retryableTerminalDeliveryError(error));
    }
    if (typeof this.onTerminated === 'function') {
      try {
        this.onTerminated(null, null);
      } catch (error) {
        terminalErrors.push(error);
      }
    }
    if (!this.suppressTerminalEvent) {
      try {
        await this.postEvent({
          type: 'session.state_changed',
          hostId: this.hostId,
          sessionId: this.currentSessionId(),
          runId: this.runId,
          state: 'failed:start-cancelled',
          live: false,
          timestamp: nowIso(),
        });
      } catch (error) {
        terminalErrors.push(retryableTerminalDeliveryError(error));
      }
    }
    this.cleanupManagedOverlayAfterExit('startup-cancellation');
    throwTerminalErrors(terminalErrors, 'Codex startup cancellation did not complete cleanly.');
  }

  async emitAssistantTranscript(text, options = {}) {
    const value = String(text || '').trim();
    const turnId = String(options.turnId || '').trim();
    if (!value || (turnId && this.turnAssistantTranscriptEmitted?.has?.(turnId))) {
      return false;
    }
    const timestamp = nowIso();
    const nativeThreadId = this.nativeThreadId || this.threadId || this.currentSessionId();
    const assistantObservation = normalizeAssistantObservation({
      representation: 'live',
      nativeThreadId,
      protocolTurnId: turnId,
      protocolItemId: options.itemId || null,
      role: 'assistant',
      phase: options.phase || 'final',
      text: value,
      finalized: true,
      sourceTimestamp: options.sourceTimestamp || timestamp,
      observedAt: timestamp,
    });
    if (!assistantObservation) {
      return false;
    }
    await this.postEvent({
      type: 'session.transcript',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      nativeThreadId,
      runId: this.runId,
      clientRequestId: this.clientRequestIdForTurn(turnId),
      source: 'codex-app-server',
      speaker: 'agent',
      text: value,
      assistantObservation,
      timestamp,
    });
    if (turnId) {
      if (!(this.turnAssistantTranscriptEmitted instanceof Set)) {
        this.turnAssistantTranscriptEmitted = new Set();
      }
      this.turnAssistantTranscriptEmitted.add(turnId);
    }
    return true;
  }

  currentSessionId() {
    return this.sessionId || this.nativeThreadId || this.bridgeSessionId;
  }

  async emitAlert(entry) {
    await this.postEvent({
      type: 'session.alert',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      severity: entry.severity || 'warning',
      source: entry.source || 'runtime',
      message: entry.message || '',
      ...(Object.prototype.hasOwnProperty.call(entry, 'transient')
        ? { transient: entry.transient }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(entry, 'turnId')
        ? { turnId: entry.turnId }
        : {}),
      ...(entry.inputCapabilityError
        ? { inputCapabilityError: entry.inputCapabilityError }
        : {}),
      timestamp: nowIso(),
    });
  }

  reserveRuntimeRevision() {
    this.runtimeRevision = Math.max(0, Number(this.runtimeRevision || 0)) + 1;
    return this.runtimeRevision;
  }

  async emitRuntime(patch) {
    const runtimeRevision = this.reserveRuntimeRevision();
    const runtimePatch = this.activeClientRequestId && !Object.prototype.hasOwnProperty.call(patch, 'clientRequestId')
      ? { ...patch, clientRequestId: this.activeClientRequestId, runtimeRevision }
      : { ...patch, runtimeRevision };
    const timestamp = nowIso();
    this.runtime = {
      ...this.runtime,
      ...runtimePatch,
      updatedAt: timestamp,
    };
    await this.postEvent({
      type: 'session.runtime_updated',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      runtimeRevision,
      patch: runtimePatch,
      timestamp,
    });
  }

  async emitDiagnostic(entry) {
    const turnId = entry.turnId || entry.data?.turnId || null;
    const clientRequestId = String(
      entry.clientRequestId
      || entry.data?.clientRequestId
      || this.clientRequestIdForTurn(turnId)
      || ''
    ).trim() || null;
    await this.postEvent({
      type: 'session.diagnostic',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      severity: structuredScalar(entry.severity, 'info'),
      source: structuredScalar(entry.source, 'codex'),
      kind: structuredScalar(entry.kind, 'event'),
      method: structuredText(entry.method) || null,
      message: structuredText(entry.message),
      detail: entry.detail == null ? null : entry.detail,
      data: entry.data || null,
      turnId,
      clientRequestId,
      timestamp: nowIso(),
    });
  }

  async emitRequest(entry) {
    await this.postEvent({
      type: 'session.request',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      requestId: String(entry.requestId || ''),
      kind: structuredScalar(entry.kind, 'request'),
      method: structuredText(entry.method) || null,
      title: structuredText(entry.title) || null,
      message: structuredText(entry.message),
      summary: structuredText(entry.summary) || null,
      payload: entry.payload || null,
      availableDecisions: entry.availableDecisions || entry.payload?.availableDecisions || [],
      response: entry.response || null,
      timestamp: nowIso(),
    });
  }

  async emitRequestResolved(entry) {
    await this.postEvent({
      type: 'session.request.resolved',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      requestId: String(entry.requestId || ''),
      status: structuredScalar(entry.status, 'resolved'),
      method: structuredText(entry.method) || null,
      summary: structuredText(entry.summary) || null,
      response: entry.response || null,
      message: structuredText(entry.message) || null,
      timestamp: nowIso(),
    });
  }
}

async function startCodexAppServerSession(options) {
  const runner = new CodexAppServerRunner(options);
  try {
    if (typeof options.onRunnerCreated === 'function') options.onRunnerCreated(runner);
    await runner.start();
    return runner;
  } catch (error) {
    let failure = error;
    try {
      await runner.stop(runner.stopRequested ? {} : { suppressTerminalEvent: true });
    } catch (stopError) {
      stopError.cause = stopError.cause || error;
      failure = stopError;
    }
    if (error?.processTreeFallbackRequired === true) {
      failure.processTreeFallbackRequired = true;
    }
    if (
      runner.overlayCleanupLastError
      && failure
      && typeof failure === 'object'
    ) {
      const cleanupFailure = runner.overlayCleanupLastError;
      failure.overlayCleanupFailure = {
        code: cleanupFailure.code,
        cleanupErrorCode: cleanupFailure.cleanupErrorCode || cleanupFailure.cause?.code || null,
        path: cleanupFailure.path || null,
        context: cleanupFailure.cleanupContext || 'startup-cancellation',
        retryScheduled: Boolean(runner.overlayCleanupRetryTimer),
      };
    }
    if (
      failure?.processTreeFallbackRequired === true
      && runner.child
      && !runner.childExitConfirmed
      && !runner.overlayCleaned
    ) {
      failure.retryCommand = true;
      runner.startRetryPending = true;
      runner.processTreeFallbackRequired = true;
      runner.startRetryFailure = {
        code: failure.code || 'session_stop_timeout',
        message: failure.message || 'Managed Codex startup could not confirm that its child exited.',
        processTreeFallbackRequired: true,
      };
    }
    throw failure;
  }
}

module.exports = {
  bundledCodexRelativeCandidates,
  codexHomeRelativeCandidates,
  cursorCodexPlatformDirs,
  elfHeaderMatchesArchitecture,
  buildCodexStateDatabaseDiagnostic,
  CodexAppServerRunner,
  classifyCodexStateDatabaseStderr,
  cleanupApiProfileCodexHome,
  cleanupStaleApiProfileCodexHomes,
  inspectManagedOverlayForRun,
  isMissingNativeRolloutError,
  isExecutableCompatibleWithHost,
  normalizeAppServerFileChanges,
  normalizeTurnStartParams,
  prepareApiProfileCodexHome,
  resolveDefaultCodexBin,
  startCodexAppServerSession,
  updateApiProfileCodexHomeOwnership,
};
