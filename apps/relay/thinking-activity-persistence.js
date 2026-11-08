const { stripSecrets } = require('../../shared/secret-redaction');
const { makeActivityKey } = require('../../shared/thinking-activity');
const {
  safeStructuredJson,
  structuredScalar,
  structuredText,
} = require('../../shared/structured-text');

const THINKING_HISTORY_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ACTIVITIES_PER_SESSION = 128;
const DEFAULT_MAX_ACTIVITY_BYTES = 128 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_THINKING_SESSIONS = 256;
const DEFAULT_MAX_TOTAL_THINKING_BYTES = 32 * 1024 * 1024;
const TRUNCATION_SUFFIX = '\n...[activity truncated]';

const TERMINAL_STATUSES = new Set([
  'cancelled',
  'canceled',
  'complete',
  'completed',
  'error',
  'failed',
  'interrupted',
  'rejected',
  'stopped',
  'succeeded',
  'success',
  'timed_out',
  'timeout',
]);

const SIMPLE_FIELDS = [
  ['clientRequestId', 512],
  ['callId', 512],
  ['requestId', 512],
  ['itemType', 64],
  ['method', 256],
  ['source', 64],
  ['stream', 64],
  ['server', 256],
  ['tool', 256],
  ['namespace', 256],
  ['resourceUri', 4096],
  ['senderThreadId', 512],
  ['model', 512],
  ['reasoningEffort', 128],
  ['processId', 512],
];

const CONTENT_FIELDS = [
  ['text', 0.40, 'textTruncated'],
  ['command', 0.16, 'commandTruncated'],
  ['cwd', 0.08, 'cwdTruncated'],
  ['arguments', 0.14, 'argumentsTruncated'],
  ['result', 0.14, 'resultTruncated'],
  ['fileChanges', 0.24, 'fileChangesTruncated'],
  ['commandActions', 0.12, 'commandActionsTruncated'],
  ['output', 0.24, 'outputTruncated'],
  ['stdout', 0.18, 'outputTruncated'],
  ['stderr', 0.18, 'outputTruncated'],
  ['progress', 0.12, 'progressTruncated'],
  ['prompt', 0.16, 'promptTruncated'],
  ['query', 0.12, 'queryTruncated'],
  ['action', 0.12, 'actionTruncated'],
  ['receiverThreadIds', 0.10, 'receiverThreadIdsTruncated'],
  ['agentsStates', 0.14, 'agentsStatesTruncated'],
  ['actionData', 0.12, 'actionDataTruncated'],
  ['error', 0.12, 'errorTruncated'],
];

class NoPersistableActivityError extends Error {
  constructor(skipped) {
    super('No completed Thinking activity in the batch can advance durable state.');
    this.name = 'NoPersistableActivityError';
    this.skipped = skipped;
  }
}

function safeSerialized(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') return serialized;
  } catch (_) {
    // Fall through to the bounded, cycle-safe representation below.
  }
  try {
    const serialized = safeStructuredJson(value);
    if (serialized) return serialized;
  } catch (_) {
    // Host objects may expose throwing getters; use a final text fallback.
  }
  try {
    return JSON.stringify(structuredText(value)) || 'null';
  } catch (_) {
    return 'null';
  }
}

function clone(value) {
  if (value == null) return value;
  if (typeof value !== 'object') {
    // JSON has no BigInt, Symbol, or Function representation.  Keep normal
    // scalar values as-is and make the other protocol values durable text.
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
      return structuredText(value);
    }
    return value;
  }
  try {
    // JSON.stringify is deliberately checked first: structuredClone preserves
    // cycles, while persisted Session Store values must remain acyclic.
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') return structuredClone(value);
  } catch (_) {
    // Use the bounded JSON clone for cycles, BigInt, and special host objects.
  }
  try {
    return JSON.parse(safeSerialized(value));
  } catch (_) {
    try {
      return structuredText(value);
    } catch (_) {
      return '[Unserializable value]';
    }
  }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function byteLength(value) {
  return Buffer.byteLength(safeSerialized(value), 'utf8');
}

function boundedText(value, maxLength) {
  const text = structuredText(value);
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function normalizedStatus(value) {
  return structuredScalar(value, '').trim().toLowerCase().replace(/[ -]+/g, '_');
}

function isTerminalActivity(snapshot) {
  return snapshot?.final === true || TERMINAL_STATUSES.has(normalizedStatus(snapshot?.status));
}

function activityIdentity(canonicalConversationKey, snapshot = {}) {
  const kind = boundedText(snapshot.kind, 64) || 'reasoning';
  const callId = boundedText(snapshot.callId, 512) || null;
  const requestId = boundedText(snapshot.requestId, 512) || null;
  const itemId = boundedText(
    snapshot.itemId || callId || requestId || `${kind}:${boundedText(snapshot.method, 256) || 'activity'}`,
    512
  ) || null;
  const summaryIndex = Number(snapshot.summaryIndex || 0);
  return {
    canonicalConversationKey: String(canonicalConversationKey || '').trim(),
    runId: boundedText(snapshot.runId, 512) || null,
    turnId: boundedText(snapshot.turnId, 512) || null,
    itemId,
    summaryIndex: Number.isSafeInteger(summaryIndex) ? summaryIndex : 0,
    kind,
    callId,
    requestId,
  };
}

function validateStructuredActivity(canonicalConversationKey, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, reason: 'invalid_activity' };
  }
  try {
    if (!isTerminalActivity(snapshot)) {
      return { ok: false, reason: 'not_terminal' };
    }
    const activityRevision = Number(snapshot.activityRevision);
    if (!Number.isSafeInteger(activityRevision) || activityRevision <= 0) {
      return { ok: false, reason: 'invalid_revision' };
    }
    const identity = activityIdentity(canonicalConversationKey, snapshot);
    if (
      !identity.canonicalConversationKey
      || !identity.runId
      || !identity.turnId
      || !identity.itemId
    ) {
      return { ok: false, reason: 'invalid_identity' };
    }
    return { ok: true, identity, activityRevision };
  } catch (_) {
    // Protocol objects may expose throwing getters or values that reject
    // numeric/string coercion. Treat them as invalid input, not a WAL failure.
    return { ok: false, reason: 'invalid_activity' };
  }
}

function truncateUtf8(value, maxBytes) {
  const text = structuredText(value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, 'utf8');
  const budget = Math.max(0, maxBytes - suffixBytes);
  const encoded = Buffer.from(text, 'utf8');
  let end = Math.min(encoded.length, budget);
  while (end > 0 && (encoded[end] & 0b11000000) === 0b10000000) end -= 1;
  return {
    text: `${encoded.subarray(0, end).toString('utf8')}${TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

function compactCandidate(value, budget) {
  if (typeof value === 'string') {
    return truncateUtf8(value, budget);
  }
  const serialized = safeSerialized(value);
  if (Buffer.byteLength(serialized, 'utf8') <= budget) {
    return { value: clone(value), truncated: false };
  }
  const preview = truncateUtf8(serialized, Math.max(0, budget - 40));
  return {
    value: { truncated: true, preview: preview.text },
    truncated: true,
  };
}

function fitStringField(target, field, value, maxBytes, truncationField) {
  const original = structuredText(value);
  target[field] = original;
  if (byteLength(target) <= maxBytes) return true;
  delete target[field];

  let low = 0;
  let high = original.length;
  let accepted = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const prefix = original.slice(0, middle);
    target[field] = `${prefix}${TRUNCATION_SUFFIX}`;
    target[truncationField] = true;
    if (byteLength(target) <= maxBytes) {
      accepted = target[field];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
    delete target[field];
    delete target[truncationField];
  }
  if (accepted !== null) {
    target[field] = accepted;
    target[truncationField] = true;
    return true;
  }
  target[truncationField] = true;
  if (byteLength(target) > maxBytes) delete target[truncationField];
  return false;
}

function addBoundedField(target, field, value, maxBytes, fieldBudget, truncationField) {
  if (value == null) return;
  const compacted = compactCandidate(value, Math.max(64, fieldBudget));
  const candidate = Object.prototype.hasOwnProperty.call(compacted, 'text')
    ? compacted.text
    : compacted.value;
  if (typeof candidate === 'string') {
    fitStringField(target, field, candidate, maxBytes, truncationField);
  } else {
    target[field] = candidate;
    if (byteLength(target) > maxBytes) {
      delete target[field];
      const serialized = safeSerialized(candidate);
      fitStringField(
        target,
        field,
        serialized,
        maxBytes,
        truncationField
      );
    }
  }
  if (compacted.truncated === true || value?.truncated === true) {
    target[truncationField] = true;
    if (byteLength(target) > maxBytes) delete target[truncationField];
  }
}

function normalizeTerminalActivity(canonicalConversationKey, snapshot, options = {}) {
  const validation = validateStructuredActivity(canonicalConversationKey, snapshot);
  if (!validation.ok) return validation;

  const maxActivityBytes = boundedInteger(
    options.maxActivityBytes,
    DEFAULT_MAX_ACTIVITY_BYTES,
    512,
    1024 * 1024
  );
  let safe;
  try {
    safe = stripSecrets(snapshot);
  } catch (_) {
    // A protocol adapter can hand us a cyclic or otherwise exotic object.
    // Convert it to a bounded acyclic value before applying secret redaction.
    try {
      safe = stripSecrets(clone(snapshot));
    } catch (error) {
      return {
        ok: false,
        reason: error?.message === 'Cannot persist cyclic Session metadata'
          ? 'cyclic_activity'
          : 'unserializable_activity',
      };
    }
  }
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
    return { ok: false, reason: 'invalid_activity' };
  }
  const identity = activityIdentity(canonicalConversationKey, safe);
  const startedAt = boundedText(
    options.startedAt
      || safe.startedAt
      || safe.createdAt
      || safe.timestamp
      || safe.updatedAt,
    128
  ) || null;
  const timestamp = boundedText(
    safe.timestamp || safe.updatedAt || safe.startedAt || safe.createdAt,
    128
  ) || startedAt;
  const activity = {
    ...identity,
    activityRevision: validation.activityRevision,
    final: true,
    status: boundedText(safe.status, 64) || (safe.final === true ? 'completed' : null),
    startedAt,
    timestamp,
    firstObservedOrdinal: boundedInteger(options.firstObservedOrdinal, 1, 1, Number.MAX_SAFE_INTEGER),
  };
  activity.activityKey = makeActivityKey(activity);

  if (typeof safe.success === 'boolean') activity.success = safe.success;
  for (const field of ['exitCode', 'durationMs']) {
    if (safe[field] != null && Number.isFinite(Number(safe[field]))) {
      activity[field] = Number(safe[field]);
    }
  }
  for (const [field, maxLength] of SIMPLE_FIELDS) {
    if (safe[field] != null) activity[field] = boundedText(safe[field], maxLength) || null;
  }
  if (byteLength(activity) > maxActivityBytes) {
    return { ok: false, reason: 'identity_too_large' };
  }

  for (const [field, fraction, truncationField] of CONTENT_FIELDS) {
    addBoundedField(
      activity,
      field,
      safe[field],
      maxActivityBytes,
      Math.max(64, Math.floor(maxActivityBytes * fraction)),
      truncationField
    );
    if (safe[truncationField] === true) {
      activity[truncationField] = true;
      if (byteLength(activity) > maxActivityBytes) delete activity[truncationField];
    }
  }

  if (byteLength(activity) > maxActivityBytes) {
    return { ok: false, reason: 'activity_too_large' };
  }
  return { ok: true, activity };
}

function configuredLimits(options = {}) {
  const maxActivityBytes = boundedInteger(
    options.maxActivityBytes,
    DEFAULT_MAX_ACTIVITY_BYTES,
    512,
    1024 * 1024
  );
  return {
    maxActivitiesPerSession: boundedInteger(
      options.maxActivitiesPerSession,
      DEFAULT_MAX_ACTIVITIES_PER_SESSION,
      1,
      4096
    ),
    maxActivityBytes,
    maxSessionBytes: Math.max(
      maxActivityBytes,
      boundedInteger(
        options.maxSessionBytes,
        DEFAULT_MAX_SESSION_BYTES,
        512,
        64 * 1024 * 1024
      )
    ),
    maxThinkingSessions: boundedInteger(
      options.maxThinkingSessions,
      DEFAULT_MAX_THINKING_SESSIONS,
      1,
      4096
    ),
    maxTotalThinkingBytes: boundedInteger(
      options.maxTotalThinkingBytes,
      DEFAULT_MAX_TOTAL_THINKING_BYTES,
      512,
      256 * 1024 * 1024
    ),
  };
}

function compareOrdinal(left, right) {
  return Number(left.firstObservedOrdinal || 0) - Number(right.firstObservedOrdinal || 0)
    || String(left.activityKey || '').localeCompare(String(right.activityKey || ''));
}

function historyBytes(activities) {
  return activities.reduce((total, activity) => total + byteLength(activity), 0);
}

function enforceHistoryBounds(history, limits, preferredActivityKey = null) {
  const activities = history.activities.sort(compareOrdinal);
  let evicted = 0;
  const removeOldest = () => {
    let index = activities.findIndex(
      (activity) => activity.activityKey !== preferredActivityKey
    );
    if (index < 0) index = 0;
    activities.splice(index, 1);
    evicted += 1;
  };
  while (activities.length > limits.maxActivitiesPerSession) removeOldest();
  let totalBytes = historyBytes(activities);
  while (activities.length > 1 && totalBytes > limits.maxSessionBytes) {
    removeOldest();
    totalBytes = historyBytes(activities);
  }
  history.totalBytes = totalBytes;
  const maxOrdinal = activities.reduce(
    (maximum, activity) => Math.max(maximum, Number(activity.firstObservedOrdinal || 0)),
    0
  );
  history.nextOrdinal = Math.max(Number(history.nextOrdinal || 1), maxOrdinal + 1);
  return evicted;
}

function normalizedHistory(value, canonicalConversationKey, options = {}) {
  const limits = configuredLimits(options);
  const rows = Array.isArray(value?.activities) ? value.activities : [];
  const activities = [];
  const byKey = new Map();
  let nextOrdinal = 1;
  for (const row of rows) {
    const requestedOrdinal = boundedInteger(
      row?.firstObservedOrdinal,
      nextOrdinal,
      1,
      Number.MAX_SAFE_INTEGER
    );
    const normalized = normalizeTerminalActivity(canonicalConversationKey, row, {
      ...limits,
      firstObservedOrdinal: requestedOrdinal,
    });
    if (!normalized.ok) continue;
    const current = byKey.get(normalized.activity.activityKey);
    if (current) {
      if (normalized.activity.activityRevision <= current.activityRevision) continue;
      const replacement = {
        ...normalized.activity,
        firstObservedOrdinal: current.firstObservedOrdinal,
        startedAt: current.startedAt || normalized.activity.startedAt,
      };
      activities[activities.indexOf(current)] = replacement;
      byKey.set(replacement.activityKey, replacement);
      continue;
    }
    activities.push(normalized.activity);
    byKey.set(normalized.activity.activityKey, normalized.activity);
    nextOrdinal = Math.max(nextOrdinal, requestedOrdinal + 1);
  }
  const history = {
    schemaVersion: THINKING_HISTORY_SCHEMA_VERSION,
    nextOrdinal: Math.max(nextOrdinal, Number(value?.nextOrdinal || 1)),
    activities,
    totalBytes: 0,
    updatedAt: boundedText(value?.updatedAt, 128) || null,
  };
  enforceHistoryBounds(history, limits);
  return history;
}

function mergeThinkingHistory(winnerValue, loserValue, options = {}) {
  const canonicalConversationKey = String(options.canonicalConversationKey || '').trim();
  if (!canonicalConversationKey) {
    throw new TypeError('canonicalConversationKey is required to merge Thinking history');
  }
  const limits = configuredLimits(options);
  const winner = normalizedHistory(winnerValue, canonicalConversationKey, limits);
  const loser = normalizedHistory(loserValue, canonicalConversationKey, limits);
  const merged = {
    schemaVersion: THINKING_HISTORY_SCHEMA_VERSION,
    nextOrdinal: winner.nextOrdinal,
    activities: winner.activities.map((activity) => clone(activity)),
    totalBytes: winner.totalBytes,
    updatedAt: [winner.updatedAt, loser.updatedAt].filter(Boolean).sort().at(-1) || null,
  };
  const byKey = new Map(merged.activities.map((activity) => [activity.activityKey, activity]));
  let nextOrdinal = Math.max(
    Number(merged.nextOrdinal || 1),
    ...merged.activities.map((activity) => Number(activity.firstObservedOrdinal || 0) + 1)
  );
  for (const candidate of loser.activities.sort(compareOrdinal)) {
    const current = byKey.get(candidate.activityKey);
    if (current) {
      if (candidate.activityRevision <= current.activityRevision) continue;
      const replacement = {
        ...clone(candidate),
        firstObservedOrdinal: current.firstObservedOrdinal,
        startedAt: current.startedAt || candidate.startedAt,
      };
      merged.activities[merged.activities.indexOf(current)] = replacement;
      byKey.set(replacement.activityKey, replacement);
      continue;
    }
    const appended = {
      ...clone(candidate),
      firstObservedOrdinal: nextOrdinal,
    };
    nextOrdinal += 1;
    merged.activities.push(appended);
    byKey.set(appended.activityKey, appended);
  }
  merged.nextOrdinal = Math.max(nextOrdinal, winner.nextOrdinal, loser.nextOrdinal);
  enforceHistoryBounds(merged, limits);
  return merged;
}

function canonicalSeed(canonicalConversationKey) {
  const separator = canonicalConversationKey.indexOf('::');
  return separator > 0
    ? {
        hostId: canonicalConversationKey.slice(0, separator),
        conversationKey: canonicalConversationKey.slice(separator + 2),
      }
    : { hostId: '', conversationKey: canonicalConversationKey };
}

function resolveCanonicalConversationKey(tx, canonicalConversationKeyValue) {
  const requestedKey = String(canonicalConversationKeyValue || '').trim();
  const seed = canonicalSeed(requestedKey);
  if (!seed.hostId || !seed.conversationKey) return requestedKey;

  let canonicalKey = tx.resolveCanonicalKey(seed);
  const seen = new Set();
  while (canonicalKey && !seen.has(canonicalKey)) {
    seen.add(canonicalKey);
    const target = tx.aliasTarget(canonicalKey);
    if (!target || target === canonicalKey) break;
    canonicalKey = target;
  }
  return canonicalKey || requestedKey;
}

function applyTerminalBatch(history, canonicalConversationKey, snapshots, limits) {
  const byKey = new Map(history.activities.map((activity) => [activity.activityKey, activity]));
  const persistedByKey = new Map();
  const skipped = [];
  let lastActivityKey = null;
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const validation = validateStructuredActivity(canonicalConversationKey, snapshot);
    if (!validation.ok) {
      skipped.push({ index, reason: validation.reason });
      continue;
    }
    const normalized = normalizeTerminalActivity(canonicalConversationKey, snapshot, {
      ...limits,
      firstObservedOrdinal: history.nextOrdinal,
    });
    if (!normalized.ok) {
      skipped.push({ index, reason: normalized.reason });
      continue;
    }
    let activity = normalized.activity;
    const prior = byKey.get(activity.activityKey);
    if (prior && activity.activityRevision <= prior.activityRevision) {
      skipped.push({ index, reason: 'stale_revision', activityKey: activity.activityKey });
      continue;
    }
    if (prior) {
      activity = {
        ...activity,
        firstObservedOrdinal: prior.firstObservedOrdinal,
        startedAt: prior.startedAt || activity.startedAt,
      };
      history.activities[history.activities.indexOf(prior)] = activity;
    } else {
      activity.firstObservedOrdinal = history.nextOrdinal;
      history.nextOrdinal += 1;
      history.activities.push(activity);
    }
    byKey.set(activity.activityKey, activity);
    persistedByKey.set(activity.activityKey, activity);
    lastActivityKey = activity.activityKey;
  }
  return {
    activities: [...persistedByKey.values()],
    skipped,
    lastActivityKey,
  };
}

function selectGlobalHistoryEvictions(tx, canonicalConversationKey, currentHistory, limits) {
  const records = tx?.projection?.records || {};
  const keys = new Set([...Object.keys(records), canonicalConversationKey]);
  const entries = [];
  for (const key of keys) {
    const thinking = key === canonicalConversationKey
      ? currentHistory
      : records[key]?.thinking;
    const activities = Array.isArray(thinking?.activities) ? thinking.activities : [];
    if (!activities.length) continue;
    entries.push({
      canonicalConversationKey: key,
      updatedAt: boundedText(thinking.updatedAt, 128) || '',
      totalBytes: historyBytes(activities),
    });
  }
  entries.sort((left, right) => {
    const leftIsCurrent = left.canonicalConversationKey === canonicalConversationKey;
    const rightIsCurrent = right.canonicalConversationKey === canonicalConversationKey;
    if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? 1 : -1;
    return left.updatedAt.localeCompare(right.updatedAt)
      || left.canonicalConversationKey.localeCompare(right.canonicalConversationKey);
  });
  let totalBytes = entries.reduce((total, entry) => total + entry.totalBytes, 0);
  const evictedCanonicalKeys = [];
  while (
    entries.length > limits.maxThinkingSessions
    || (entries.length && totalBytes > limits.maxTotalThinkingBytes)
  ) {
    const removed = entries.shift();
    evictedCanonicalKeys.push(removed.canonicalConversationKey);
    totalBytes = Math.max(0, totalBytes - removed.totalBytes);
  }
  return {
    evictedCanonicalKeys,
    retainedSessions: entries.length,
    totalBytes,
  };
}

class ThinkingActivityPersistence {
  constructor(options = {}) {
    if (!options.sessionRecordStore || typeof options.sessionRecordStore.transact !== 'function') {
      throw new TypeError('ThinkingActivityPersistence requires a SessionRecordStore');
    }
    this.sessionRecordStore = options.sessionRecordStore;
    this.limits = configuredLimits(options);
    this.now = typeof options.now === 'function'
      ? options.now
      : () => new Date().toISOString();
    this.queue = Promise.resolve();
  }

  persist(canonicalConversationKeyValue, snapshot) {
    const canonicalConversationKey = String(canonicalConversationKeyValue || '').trim();
    const validation = validateStructuredActivity(canonicalConversationKey, snapshot);
    if (!validation.ok) return Promise.resolve({ persisted: false, reason: validation.reason });
    return this.persistMany(canonicalConversationKey, [snapshot]).then((result) => {
      if (!result.persisted) {
        return {
          persisted: false,
          reason: result.reason || result.skipped?.[0]?.reason || 'no_persistable_activity',
        };
      }
      return {
        persisted: true,
        activity: result.activities[0] || null,
        evicted: result.evicted,
        totalBytes: result.totalBytes,
        count: result.count,
        historiesCleared: result.historiesCleared,
        retained: result.retained,
      };
    });
  }

  persistMany(canonicalConversationKeyValue, snapshotsValue) {
    const canonicalConversationKey = String(canonicalConversationKeyValue || '').trim();
    const snapshots = Array.isArray(snapshotsValue) ? snapshotsValue : [];
    const preliminary = snapshots.map(
      (snapshot, index) => ({ index, ...validateStructuredActivity(canonicalConversationKey, snapshot) })
    );
    if (!preliminary.some((entry) => entry.ok)) {
      const skipped = preliminary.map(({ index, reason }) => ({ index, reason }));
      return Promise.resolve({
        persisted: false,
        reason: skipped[0]?.reason || 'empty_batch',
        persistedCount: 0,
        activities: [],
        skipped,
      });
    }
    const operation = this.queue.then(
      () => this.persistManyNow(canonicalConversationKey, snapshots),
      () => this.persistManyNow(canonicalConversationKey, snapshots)
    );
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async persistManyNow(canonicalConversationKey, snapshots) {
    try {
      return await this.sessionRecordStore.transact('session.thinking.completed', (tx) => {
        const resolvedCanonicalKey = resolveCanonicalConversationKey(tx, canonicalConversationKey);
        const record = tx.ensureRecord(resolvedCanonicalKey, canonicalSeed(resolvedCanonicalKey));
        const current = normalizedHistory(record.thinking, resolvedCanonicalKey, this.limits);
        const applied = applyTerminalBatch(
          current,
          resolvedCanonicalKey,
          snapshots,
          this.limits
        );
        if (!applied.activities.length) {
          throw new NoPersistableActivityError(applied.skipped);
        }
        const evicted = enforceHistoryBounds(current, this.limits, applied.lastActivityKey);
        current.updatedAt = boundedText(this.now(), 128) || new Date().toISOString();
        record.thinking = current;
        tx.markDirty(resolvedCanonicalKey);
        const globalRetention = selectGlobalHistoryEvictions(
          tx,
          resolvedCanonicalKey,
          current,
          this.limits
        );
        for (const evictedCanonicalKey of globalRetention.evictedCanonicalKeys) {
          const evictedRecord = evictedCanonicalKey === resolvedCanonicalKey
            ? record
            : tx.getRecord(evictedCanonicalKey);
          if (!evictedRecord?.thinking) continue;
          delete evictedRecord.thinking;
          tx.markDirty(evictedCanonicalKey);
        }
        const retained = !globalRetention.evictedCanonicalKeys.includes(resolvedCanonicalKey);
        return {
          persisted: true,
          persistedCount: applied.activities.length,
          activities: applied.activities.map((activity) => clone(activity)),
          skipped: applied.skipped,
          evicted,
          totalBytes: retained ? current.totalBytes : 0,
          count: retained ? current.activities.length : 0,
          historiesCleared: globalRetention.evictedCanonicalKeys,
          retained,
          globalRetainedSessions: globalRetention.retainedSessions,
          globalTotalBytes: globalRetention.totalBytes,
        };
      });
    } catch (error) {
      if (error instanceof NoPersistableActivityError) {
        return {
          persisted: false,
          reason: error.skipped[0]?.reason || 'no_persistable_activity',
          persistedCount: 0,
          activities: [],
          skipped: error.skipped,
        };
      }
      throw error;
    }
  }

  flush() {
    return this.queue;
  }

  hydrate(activitySnapshotStore, options = {}) {
    if (!activitySnapshotStore || typeof activitySnapshotStore.reset !== 'function') {
      throw new TypeError('hydrate requires an ActivitySnapshotStore');
    }
    const epoch = String(options.epoch || '').trim();
    if (!epoch) throw new TypeError('hydrate requires a non-empty stream epoch');
    const projection = this.sessionRecordStore.readSnapshot();
    let conversations = 0;
    let accepted = 0;
    let skipped = 0;
    for (const [canonicalConversationKey, record] of Object.entries(projection.records || {})) {
      const rawCount = Array.isArray(record?.thinking?.activities)
        ? record.thinking.activities.length
        : 0;
      const history = normalizedHistory(record?.thinking, canonicalConversationKey, this.limits);
      skipped += Math.max(0, rawCount - history.activities.length);
      if (!history.activities.length) continue;
      const restored = activitySnapshotStore.reset(
        epoch,
        canonicalConversationKey,
        history.activities
      );
      conversations += 1;
      accepted += restored.length;
    }
    return { conversations, accepted, skipped };
  }
}

module.exports = {
  DEFAULT_MAX_ACTIVITIES_PER_SESSION,
  DEFAULT_MAX_ACTIVITY_BYTES,
  DEFAULT_MAX_SESSION_BYTES,
  DEFAULT_MAX_THINKING_SESSIONS,
  DEFAULT_MAX_TOTAL_THINKING_BYTES,
  THINKING_HISTORY_SCHEMA_VERSION,
  ThinkingActivityPersistence,
  isTerminalActivity,
  mergeThinkingHistory,
};
