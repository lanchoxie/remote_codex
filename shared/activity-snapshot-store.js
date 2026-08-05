const crypto = require('crypto');
const { makeActivityKey } = require('./thinking-activity');

const DEFAULT_MAX_CONVERSATIONS = 256;
const DEFAULT_MAX_RECORDS_PER_CONVERSATION = 256;
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 64;
const DEFAULT_PAGE_BYTES = 512 * 1024;

function clone(value) {
  return structuredClone(value);
}

function boundedInteger(value, fallback, min, max) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function boundedText(value, maxLength) {
  const text = String(value == null ? '' : value);
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function boundedStructuredValueWithMeta(value, maxBytes) {
  if (value == null) return { value: null, truncated: false };
  let cloned;
  try {
    cloned = clone(value);
  } catch (_) {
    cloned = String(value);
  }
  let serialized;
  try {
    serialized = JSON.stringify(cloned);
  } catch (_) {
    serialized = JSON.stringify(String(cloned));
  }
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return { value: cloned, truncated: false };
  }
  const bounded = truncateUtf8(serialized, Math.max(256, maxBytes - 96));
  return {
    value: {
      truncated: true,
      preview: bounded.text,
    },
    truncated: true,
  };
}

function boundedStructuredValue(value, maxBytes) {
  return boundedStructuredValueWithMeta(value, maxBytes).value;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value == null ? '' : value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  const suffix = '\n...[activity truncated]';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let prefix = text.slice(0, low);
  if (prefix && /[\uD800-\uDBFF]/.test(prefix.at(-1))) {
    prefix = prefix.slice(0, -1);
  }
  return { text: `${prefix}${suffix}`, truncated: true };
}

function recordBytes(record) {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

function makeActivityRecoveryToken(activityKey) {
  return crypto.createHash('sha256')
    .update(String(activityKey || ''), 'utf8')
    .digest('base64url');
}

function compareScalar(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareSnapshots(left, right) {
  return compareScalar(left.turnId, right.turnId)
    || compareScalar(left.itemId, right.itemId)
    || (Number(left.summaryIndex || 0) - Number(right.summaryIndex || 0));
}

class ActivitySnapshotStore {
  constructor(options = {}) {
    this.maxConversations = boundedInteger(
      options.maxConversations,
      DEFAULT_MAX_CONVERSATIONS,
      1,
      4096
    );
    this.maxRecordsPerConversation = boundedInteger(
      options.maxRecordsPerConversation,
      DEFAULT_MAX_RECORDS_PER_CONVERSATION,
      1,
      4096
    );
    this.maxRecordBytes = boundedInteger(
      options.maxRecordBytes,
      DEFAULT_MAX_RECORD_BYTES,
      1024,
      1024 * 1024
    );
    this.maxTotalBytes = Math.max(
      this.maxRecordBytes,
      boundedInteger(
        options.maxTotalBytes,
        DEFAULT_MAX_TOTAL_BYTES,
        1024,
        256 * 1024 * 1024
      )
    );
    this.pageLimit = boundedInteger(options.pageLimit, DEFAULT_PAGE_LIMIT, 1, 256);
    this.pageBytes = boundedInteger(
      options.pageBytes,
      DEFAULT_PAGE_BYTES,
      this.maxRecordBytes,
      4 * 1024 * 1024
    );
    this.conversations = new Map();
    this.totalBytes = 0;
    this.nextRevision = 0;
  }

  createConversation(canonicalKey, epoch) {
    const key = String(canonicalKey || '');
    this.deleteConversation(key);
    const conversation = {
      epoch: String(epoch || ''),
      records: new Map(),
      bytesByKey: new Map(),
      totalBytes: 0,
      revision: ++this.nextRevision,
    };
    this.conversations.set(key, conversation);
    return conversation;
  }

  touchConversation(canonicalKey, conversation) {
    const key = String(canonicalKey || '');
    if (this.conversations.get(key) !== conversation) return;
    this.conversations.delete(key);
    this.conversations.set(key, conversation);
  }

  deleteConversation(canonicalKey) {
    const key = String(canonicalKey || '');
    const conversation = this.conversations.get(key);
    if (!conversation) return false;
    this.totalBytes = Math.max(0, this.totalBytes - conversation.totalBytes);
    this.conversations.delete(key);
    return true;
  }

  deleteRecord(conversation, activityKey) {
    if (!conversation?.records.has(activityKey)) return false;
    const bytes = conversation.bytesByKey.get(activityKey) || 0;
    conversation.records.delete(activityKey);
    conversation.bytesByKey.delete(activityKey);
    conversation.totalBytes = Math.max(0, conversation.totalBytes - bytes);
    this.totalBytes = Math.max(0, this.totalBytes - bytes);
    return true;
  }

  enforceBounds(preferredKey) {
    const preferred = this.conversations.get(preferredKey) || null;
    let preferredMembershipChanged = false;
    while (preferred && preferred.records.size > this.maxRecordsPerConversation) {
      preferredMembershipChanged = this.deleteRecord(
        preferred,
        preferred.records.keys().next().value
      ) || preferredMembershipChanged;
    }
    while (this.conversations.size > this.maxConversations) {
      const oldestKey = this.conversations.keys().next().value;
      this.deleteConversation(oldestKey);
    }
    while (this.totalBytes > this.maxTotalBytes && this.conversations.size) {
      const oldestKey = this.conversations.keys().next().value;
      const oldest = this.conversations.get(oldestKey);
      if (oldestKey !== preferredKey || this.conversations.size > 1) {
        this.deleteConversation(oldestKey);
        continue;
      }
      if (!oldest?.records.size) break;
      preferredMembershipChanged = this.deleteRecord(
        oldest,
        oldest.records.keys().next().value
      ) || preferredMembershipChanged;
    }
    return preferredMembershipChanged;
  }

  accept(epoch, canonicalKey, snapshot) {
    const key = String(canonicalKey || '');
    const streamEpoch = String(epoch || '');
    let conversation = this.conversations.get(key);
    if (!conversation || conversation.epoch !== streamEpoch) {
      conversation = this.createConversation(key, streamEpoch);
    }
    this.touchConversation(key, conversation);

    const normalized = this.normalize(key, snapshot);
    const current = conversation.records.get(normalized.activityKey);
    if (current && normalized.activityRevision <= current.activityRevision) {
      return null;
    }
    if (current?.startedAt) {
      normalized.startedAt = current.startedAt;
    }

    this.deleteRecord(conversation, normalized.activityKey);
    const bytes = recordBytes(normalized);
    conversation.records.set(normalized.activityKey, normalized);
    conversation.bytesByKey.set(normalized.activityKey, bytes);
    conversation.totalBytes += bytes;
    this.totalBytes += bytes;
    const boundsChanged = this.enforceBounds(key);
    const membershipChanged = !current || boundsChanged;
    if (membershipChanged && this.conversations.get(key) === conversation) {
      conversation.revision = ++this.nextRevision;
    }
    return clone(normalized);
  }

  reset(epoch, canonicalKey, snapshots = []) {
    const key = String(canonicalKey || '');
    this.createConversation(key, epoch);
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      this.accept(epoch, key, snapshot);
    }
    return this.snapshot(key);
  }

  summary(canonicalKey) {
    const key = String(canonicalKey || '');
    const conversation = this.conversations.get(key);
    return {
      epoch: conversation?.epoch || '',
      count: conversation?.records.size || 0,
      totalBytes: conversation?.totalBytes || 0,
      revision: conversation?.revision || 0,
    };
  }

  sortedRecords(canonicalKey) {
    const conversation = this.conversations.get(String(canonicalKey || ''));
    if (!conversation) return [];
    return [...conversation.records.values()].sort(compareSnapshots);
  }

  snapshotPage(canonicalKey, options = {}) {
    const key = String(canonicalKey || '');
    const conversation = this.conversations.get(key);
    const revision = conversation?.revision || 0;
    const expectedRevision = boundedInteger(
      options.expectedRevision,
      revision,
      0,
      Number.MAX_SAFE_INTEGER
    );
    if (expectedRevision !== revision) {
      return {
        activities: [],
        cursor: 0,
        nextCursor: null,
        hasMore: false,
        restartRequired: true,
        revision,
        totalCount: conversation?.records.size || 0,
        totalBytes: conversation?.totalBytes || 0,
        pageBytes: 0,
        epoch: conversation?.epoch || '',
      };
    }
    const records = conversation ? this.sortedRecords(key) : [];
    const offset = boundedInteger(options.cursor, 0, 0, records.length);
    const limit = boundedInteger(options.limit, this.pageLimit, 1, this.pageLimit);
    const maxBytes = boundedInteger(
      options.maxBytes,
      this.pageBytes,
      1024,
      this.pageBytes
    );
    const activities = [];
    let bytes = 0;
    let index = offset;
    while (index < records.length && activities.length < limit) {
      const record = records[index];
      const size = conversation.bytesByKey.get(record.activityKey) || recordBytes(record);
      if (activities.length && bytes + size > maxBytes) break;
      activities.push(clone(record));
      bytes += size;
      index += 1;
    }
    return {
      activities,
      cursor: offset,
      nextCursor: index < records.length ? String(index) : null,
      hasMore: index < records.length,
      restartRequired: false,
      revision,
      totalCount: records.length,
      totalBytes: conversation?.totalBytes || 0,
      pageBytes: bytes,
      epoch: conversation?.epoch || '',
    };
  }

  snapshot(canonicalKey) {
    return this.sortedRecords(canonicalKey).map((record) => clone(record));
  }

  activityByRecoveryToken(canonicalKey, recoveryToken) {
    const token = String(recoveryToken || '');
    const conversation = this.conversations.get(String(canonicalKey || ''));
    if (!token || !conversation) return null;
    for (const [activityKey, record] of conversation.records) {
      if (makeActivityRecoveryToken(activityKey) === token) {
        return clone(record);
      }
    }
    return null;
  }

  mergeCanonicalKey(epoch, loserKeyValue, winnerKeyValue, options = {}) {
    const loserKey = String(loserKeyValue || '');
    const winnerKey = String(winnerKeyValue || '');
    if (!loserKey || !winnerKey || loserKey === winnerKey) {
      return options.includeSnapshot === false ? [] : this.snapshot(winnerKey || loserKey);
    }
    const streamEpoch = String(epoch || '');
    const sources = [this.conversations.get(winnerKey), this.conversations.get(loserKey)]
      .filter((conversation) => conversation?.epoch === streamEpoch)
      .flatMap((conversation) => [...conversation.records.values()]);
    this.deleteConversation(winnerKey);
    this.deleteConversation(loserKey);
    this.createConversation(winnerKey, streamEpoch);
    for (const snapshot of sources) {
      this.accept(streamEpoch, winnerKey, snapshot);
    }
    return options.includeSnapshot === false ? [] : this.snapshot(winnerKey);
  }

  normalize(canonicalKey, snapshot = {}) {
    const activityRevision = Number(snapshot.activityRevision);
    if (!Number.isFinite(activityRevision)) {
      throw new TypeError('activityRevision must be a finite number');
    }
    const textBudget = Math.max(256, this.maxRecordBytes - 4096);
    const truncatedText = truncateUtf8(snapshot.text, textBudget);
    const truncatedOutput = truncateUtf8(snapshot.output, 96 * 1024);
    const truncatedStdout = truncateUtf8(snapshot.stdout, 64 * 1024);
    const truncatedStderr = truncateUtf8(snapshot.stderr, 64 * 1024);
    const truncatedProgress = truncateUtf8(snapshot.progress, 16 * 1024);
    const boundedArguments = boundedStructuredValueWithMeta(snapshot.arguments, 32 * 1024);
    const boundedResult = boundedStructuredValueWithMeta(snapshot.result, 32 * 1024);
    const boundedFileChanges = boundedStructuredValueWithMeta(
      snapshot.fileChanges || snapshot.changes,
      64 * 1024
    );
    const kind = boundedText(snapshot.kind, 64) || 'reasoning';
    const method = boundedText(snapshot.method, 256) || null;
    const callId = boundedText(snapshot.callId, 512) || null;
    const requestId = boundedText(snapshot.requestId, 512) || null;
    const itemId = boundedText(
      snapshot.itemId || callId || requestId || `${kind}:${method || 'activity'}`,
      512
    ) || null;
    const normalized = {
      canonicalConversationKey: canonicalKey,
      runId: boundedText(snapshot.runId, 512) || null,
      turnId: boundedText(snapshot.turnId, 512) || null,
      itemId,
      callId,
      requestId,
      summaryIndex: Number(snapshot.summaryIndex || 0),
      kind,
      itemType: boundedText(snapshot.itemType, 64) || null,
      method,
      status: boundedText(snapshot.status, 64) || null,
      text: truncatedText.text,
      textTruncated: truncatedText.truncated || snapshot.textTruncated === true,
      command: boundedText(snapshot.command, 16 * 1024) || null,
      cwd: boundedText(snapshot.cwd, 4096) || null,
      output: truncatedOutput.text || null,
      stdout: truncatedStdout.text || null,
      stderr: truncatedStderr.text || null,
      outputTruncated: snapshot.outputTruncated === true
        || truncatedOutput.truncated
        || truncatedStdout.truncated
        || truncatedStderr.truncated,
      exitCode: snapshot.exitCode != null && Number.isFinite(Number(snapshot.exitCode))
        ? Number(snapshot.exitCode)
        : null,
      durationMs: snapshot.durationMs != null && Number.isFinite(Number(snapshot.durationMs))
        ? Number(snapshot.durationMs)
        : null,
      processId: boundedText(snapshot.processId, 512) || null,
      source: boundedText(snapshot.source, 64) || null,
      stream: boundedText(snapshot.stream, 64) || null,
      server: boundedText(snapshot.server, 256) || null,
      tool: boundedText(snapshot.tool, 256) || null,
      namespace: boundedText(snapshot.namespace, 256) || null,
      resourceUri: boundedText(snapshot.resourceUri, 4096) || null,
      senderThreadId: boundedText(snapshot.senderThreadId, 512) || null,
      prompt: boundedText(snapshot.prompt, 16 * 1024) || null,
      model: boundedText(snapshot.model, 512) || null,
      reasoningEffort: boundedText(snapshot.reasoningEffort, 128) || null,
      query: boundedText(snapshot.query, 8192) || null,
      action: boundedText(snapshot.action, 4096) || null,
      receiverThreadIds: boundedStructuredValue(snapshot.receiverThreadIds, 16 * 1024),
      agentsStates: boundedStructuredValue(snapshot.agentsStates, 32 * 1024),
      actionData: boundedStructuredValue(snapshot.actionData, 16 * 1024),
      progress: truncatedProgress.text || null,
      progressTruncated: snapshot.progressTruncated === true || truncatedProgress.truncated,
      success: typeof snapshot.success === 'boolean' ? snapshot.success : null,
      error: boundedStructuredValue(snapshot.error, 24 * 1024),
      arguments: boundedArguments.value,
      argumentsTruncated: snapshot.argumentsTruncated === true || boundedArguments.truncated,
      result: boundedResult.value,
      resultTruncated: snapshot.resultTruncated === true || boundedResult.truncated,
      commandActions: boundedStructuredValue(snapshot.commandActions, 16 * 1024),
      fileChanges: boundedFileChanges.value,
      fileChangesTruncated: snapshot.fileChangesTruncated === true || boundedFileChanges.truncated,
      activityRevision,
      final: snapshot.final === true,
      startedAt: boundedText(
        snapshot.startedAt || snapshot.createdAt || snapshot.timestamp || snapshot.updatedAt,
        128
      ) || null,
      timestamp: boundedText(
        snapshot.timestamp || snapshot.updatedAt || snapshot.startedAt || snapshot.createdAt,
        128
      ) || null,
    };
    if (recordBytes(normalized) > this.maxRecordBytes) {
      const compactOutput = truncateUtf8(normalized.output, 16 * 1024);
      const compactStdout = truncateUtf8(normalized.stdout, 48 * 1024);
      const compactStderr = truncateUtf8(normalized.stderr, 48 * 1024);
      normalized.output = compactOutput.text || null;
      normalized.stdout = compactStdout.text || null;
      normalized.stderr = compactStderr.text || null;
      normalized.outputTruncated ||= compactOutput.truncated
        || compactStdout.truncated
        || compactStderr.truncated;
      const compactResult = boundedStructuredValueWithMeta(normalized.result, 8 * 1024);
      const compactArguments = boundedStructuredValueWithMeta(normalized.arguments, 8 * 1024);
      const compactFileChanges = boundedStructuredValueWithMeta(normalized.fileChanges, 16 * 1024);
      normalized.result = compactResult.value;
      normalized.resultTruncated ||= compactResult.truncated;
      normalized.arguments = compactArguments.value;
      normalized.argumentsTruncated ||= compactArguments.truncated;
      normalized.fileChanges = compactFileChanges.value;
      normalized.fileChangesTruncated ||= compactFileChanges.truncated;
      normalized.agentsStates = null;
      normalized.actionData = null;
    }
    if (recordBytes(normalized) > this.maxRecordBytes) {
      const discardedOutput = Boolean(normalized.output);
      const compactStdout = truncateUtf8(normalized.stdout, 24 * 1024);
      const compactStderr = truncateUtf8(normalized.stderr, 24 * 1024);
      normalized.output = null;
      normalized.stdout = compactStdout.text || null;
      normalized.stderr = compactStderr.text || null;
      normalized.outputTruncated ||= discardedOutput
        || compactStdout.truncated
        || compactStderr.truncated;
      normalized.resultTruncated ||= normalized.result != null;
      normalized.argumentsTruncated ||= normalized.arguments != null;
      normalized.fileChangesTruncated ||= normalized.fileChanges != null;
      normalized.result = null;
      normalized.arguments = null;
      normalized.fileChanges = null;
      normalized.receiverThreadIds = null;
      normalized.agentsStates = null;
      normalized.actionData = null;
      normalized.textTruncated = true;
    }
    normalized.activityKey = makeActivityKey(normalized);
    return normalized;
  }
}

module.exports = {
  ActivitySnapshotStore,
  makeActivityRecoveryToken,
};
