const fs = require('fs');
const path = require('path');
const { publicBinding } = require('../../shared/api-binding');
const { isSecretKey } = require('../../shared/secret-redaction');
const {
  recoverMissingFileFromBackup,
  replaceFileWithBackup,
} = require('./atomic-file-replace');

const RECORD_VERSION = 1;
const DEFAULT_COMMAND_QUEUE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEDUPE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_ENTRY_LIMIT = 10_000;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_BYTES = 512 * 1024 * 1024;

const QUEUED_RECORD_KEYS = new Set([
  'version',
  'op',
  'at',
  'hostId',
  'scopeKey',
  'clientRequestId',
  'fingerprint',
  'originalCommandId',
  'command',
  'transcriptProjection',
]);
const ACK_RECORD_KEYS = new Set([
  'version',
  'op',
  'at',
  'hostId',
  'throughCommandId',
]);
const COMPLETE_RECORD_KEYS = new Set([
  'version',
  'op',
  'at',
  'hostId',
  'commandId',
  'clientRequestId',
  'sessionId',
  'outcome',
]);
const INPUT_OUTCOMES = new Set(['accepted', 'acceptance_unknown', 'rejected']);
const PROJECTION_OUTCOMES = new Set(['pending', ...INPUT_OUTCOMES]);
const PROJECTION_APPLIED_RECORD_KEYS = new Set([
  'version',
  'op',
  'at',
  'hostId',
  'commandId',
  'clientRequestId',
  'outcome',
]);
const MIGRATE_SCOPE_RECORD_KEYS = new Set([
  'version',
  'op',
  'at',
  'hostId',
  'fromScopeKey',
  'toScopeKey',
]);
const WATERMARK_RECORD_KEYS = new Set([
  'version',
  'op',
  'at',
  'maxCommandId',
]);
const COMMAND_KEYS = new Set([
  'type',
  'id',
  'createdAt',
  'priority',
  'clientRequestId',
  'sessionId',
  'requestedSessionId',
  'bridgeSessionId',
  'nativeThreadId',
  'originSessionId',
  'sourceSessionId',
  'conversationKey',
  'runId',
  'apiBinding',
  'expectedBinding',
  'text',
  'inputItems',
  'attachments',
  'mode',
  'model',
  'effort',
  'summary',
  'approvalPolicy',
  'approvalsReviewer',
  'sandboxMode',
  'planFallback',
  'serviceTier',
  'personality',
]);
const BINDING_KEYS = new Set([
  'kind',
  'profileId',
  'label',
  'provider',
  'providerKind',
  'baseUrl',
  'normalizedBaseUrl',
  'modelProviderHint',
  'bindingFingerprint',
]);
const INPUT_ITEM_KEYS = Object.freeze({
  image: new Set(['type', 'url', 'dataUrl', 'name']),
  localImage: new Set(['type', 'path', 'name']),
  mention: new Set(['type', 'name', 'path']),
  skill: new Set(['type', 'name', 'path']),
});
const TRANSCRIPT_PROJECTION_KEYS = new Set([
  'sessionId',
  'text',
  'files',
  'timestamp',
  'clientRequestId',
  'deliveryStatus',
]);
const TRANSCRIPT_FILE_KEYS = new Set([
  'fileId',
  'name',
  'path',
  'size',
  'mime',
  'isImage',
  'cached',
  'uploadedAt',
]);

function outboxError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizedClientRequestId(value) {
  const text = String(value || '').trim();
  return text.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}

function requiredText(value, label, limit = 4096) {
  const text = String(value || '').trim();
  if (!text) throw outboxError('input_command_outbox_validation_failed', `${label} is required`);
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw outboxError('input_command_outbox_validation_failed', `${label} is too long`);
  }
  return text;
}

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw outboxError('input_command_outbox_validation_failed', `${label} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw outboxError('input_command_outbox_validation_failed', `${label} must be a non-negative safe integer`);
  }
  return number;
}

function finiteTimestamp(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw outboxError('input_command_outbox_validation_failed', `${label} must be a finite timestamp`);
  }
  return number;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw outboxError('input_command_outbox_validation_failed', `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw outboxError('input_command_outbox_validation_failed', `${label} must be a plain object`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        `${label} contains unsupported field ${key}`
      );
    }
  }
}

function assertSecretFree(value, label = 'input command', seen = new WeakSet()) {
  // Prompt text, paths, and image/data URLs are Session business data. Their
  // contents may legitimately discuss or resemble credentials, so persistence
  // safety is enforced by strict schemas and sensitive field names instead of
  // heuristic string redaction.
  if (typeof value === 'string') return;
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) {
    throw outboxError('input_command_outbox_validation_failed', `${label} contains a cycle`);
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (String(key).toLowerCase().replace(/[^a-z0-9]+/g, '') === 'credentials' || isSecretKey(key)) {
      throw outboxError(
        'input_command_outbox_sensitive_data',
        `${label} contains sensitive field ${key}`
      );
    }
    assertSecretFree(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function cloneJsonValue(value, label, depth = 0) {
  if (depth > 12) {
    throw outboxError('input_command_outbox_validation_failed', `${label} is nested too deeply`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw outboxError('input_command_outbox_validation_failed', `${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw outboxError('input_command_outbox_validation_failed', `${label} contains too many items`);
    }
    return value.map((item, index) => cloneJsonValue(item, `${label}[${index}]`, depth + 1));
  }
  assertPlainObject(value, label);
  const keys = Object.keys(value);
  if (keys.length > 100) {
    throw outboxError('input_command_outbox_validation_failed', `${label} contains too many fields`);
  }
  const clone = {};
  for (const key of keys) {
    const child = value[key];
    if (child === undefined || typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
      throw outboxError('input_command_outbox_validation_failed', `${label}.${key} is not JSON-safe`);
    }
    clone[key] = cloneJsonValue(child, `${label}.${key}`, depth + 1);
  }
  return clone;
}

function normalizeBinding(value, label) {
  if (value == null) return null;
  assertAllowedKeys(value, BINDING_KEYS, label);
  try {
    return publicBinding(value);
  } catch (cause) {
    throw outboxError(
      'input_command_outbox_validation_failed',
      `${label} is invalid: ${cause.message || cause}`,
      { cause }
    );
  }
}

function normalizeInputItems(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw outboxError('input_command_outbox_validation_failed', `${label} must contain at most 8 items`);
  }
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    assertPlainObject(item, itemLabel);
    const type = String(item.type || '').trim();
    const allowed = INPUT_ITEM_KEYS[type];
    if (!allowed) {
      throw outboxError('input_command_outbox_validation_failed', `${itemLabel} has unsupported type ${type}`);
    }
    assertAllowedKeys(item, allowed, itemLabel);
    if (type === 'image') {
      const url = String(item.url || item.dataUrl || '').trim();
      if (!url) throw outboxError('input_command_outbox_validation_failed', `${itemLabel}.url is required`);
      return {
        type,
        url,
        ...(item.name == null ? {} : { name: String(item.name) }),
      };
    }
    if (type === 'localImage') {
      const imagePath = String(item.path || '').trim();
      if (!imagePath) throw outboxError('input_command_outbox_validation_failed', `${itemLabel}.path is required`);
      return {
        type,
        path: imagePath,
        ...(item.name == null ? {} : { name: String(item.name) }),
      };
    }
    const name = String(item.name || '').trim();
    const itemPath = String(item.path || '').trim();
    if (!name || !itemPath) {
      throw outboxError('input_command_outbox_validation_failed', `${itemLabel}.name and path are required`);
    }
    return { type, name, path: itemPath };
  });
}

function normalizeCommandString(value, label, limit = 16 * 1024 * 1024) {
  if (value == null) return null;
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw outboxError('input_command_outbox_validation_failed', `${label} is too large`);
  }
  return text;
}

function normalizeIsoTimestamp(value, label) {
  const text = String(value || '').trim();
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw outboxError('input_command_outbox_validation_failed', `${label} is invalid`);
  }
  if (Buffer.byteLength(text, 'utf8') > 128) {
    throw outboxError('input_command_outbox_validation_failed', `${label} is too long`);
  }
  return text;
}

function normalizeTranscriptFiles(value, label) {
  if (!Array.isArray(value) || value.length > 16) {
    throw outboxError('input_command_outbox_validation_failed', `${label} must contain at most 16 files`);
  }
  return value.map((file, index) => {
    const fileLabel = `${label}[${index}]`;
    assertAllowedKeys(file, TRANSCRIPT_FILE_KEYS, fileLabel);
    if (typeof file.isImage !== 'boolean' || typeof file.cached !== 'boolean') {
      throw outboxError(
        'input_command_outbox_validation_failed',
        `${fileLabel}.isImage and cached must be booleans`
      );
    }
    return {
      fileId: requiredText(file.fileId, `${fileLabel}.fileId`, 512),
      name: requiredText(file.name, `${fileLabel}.name`, 1024),
      path: requiredText(file.path, `${fileLabel}.path`, 16 * 1024),
      size: nonNegativeSafeInteger(file.size, `${fileLabel}.size`),
      mime: requiredText(file.mime, `${fileLabel}.mime`, 512),
      isImage: file.isImage,
      cached: file.cached,
      uploadedAt: normalizeIsoTimestamp(file.uploadedAt, `${fileLabel}.uploadedAt`),
    };
  });
}

function normalizeTranscriptProjection(value, command, clientRequestId) {
  const fallback = value == null
    ? {
      sessionId: command.requestedSessionId
        || command.sessionId
        || command.nativeThreadId
        || command.bridgeSessionId,
      text: command.text || '',
      files: [],
      timestamp: command.createdAt,
      clientRequestId,
      deliveryStatus: 'pending',
    }
    : value;
  assertAllowedKeys(fallback, TRANSCRIPT_PROJECTION_KEYS, 'input transcript projection');
  const projectionRequestId = normalizedClientRequestId(fallback.clientRequestId);
  if (!projectionRequestId || projectionRequestId !== clientRequestId) {
    throw outboxError(
      'input_command_outbox_validation_failed',
      'input transcript projection.clientRequestId does not match the queued command'
    );
  }
  if (fallback.deliveryStatus !== 'pending') {
    throw outboxError(
      'input_command_outbox_validation_failed',
      'input transcript projection.deliveryStatus must be pending'
    );
  }
  const normalized = {
    sessionId: requiredText(fallback.sessionId, 'input transcript projection.sessionId', 16 * 1024),
    text: normalizeCommandString(fallback.text, 'input transcript projection.text') || '',
    files: normalizeTranscriptFiles(fallback.files, 'input transcript projection.files'),
    timestamp: normalizeIsoTimestamp(fallback.timestamp, 'input transcript projection.timestamp'),
    clientRequestId: projectionRequestId,
    deliveryStatus: 'pending',
  };
  assertSecretFree(normalized, 'normalized input transcript projection');
  return normalized;
}

function normalizePersistedCommand(command, originalCommandId, clientRequestId) {
  assertSecretFree(command);
  assertAllowedKeys(command, COMMAND_KEYS, 'input command');
  if (command.type !== 'session.input') {
    throw outboxError('input_command_outbox_validation_failed', 'only session.input commands can be persisted');
  }
  const commandId = positiveSafeInteger(command.id, 'input command.id');
  if (commandId !== originalCommandId) {
    throw outboxError('input_command_outbox_validation_failed', 'original command ID does not match command.id');
  }
  const commandRequestId = normalizedClientRequestId(command.clientRequestId);
  if (!commandRequestId || commandRequestId !== clientRequestId) {
    throw outboxError('input_command_outbox_validation_failed', 'clientRequestId does not match the queued command');
  }
  const createdAt = String(command.createdAt || '').trim();
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw outboxError('input_command_outbox_validation_failed', 'input command.createdAt is invalid');
  }

  const normalized = {
    type: 'session.input',
    id: commandId,
    createdAt,
    priority: nonNegativeSafeInteger(command.priority ?? 0, 'input command.priority'),
    clientRequestId: commandRequestId,
  };
  for (const field of [
    'sessionId',
    'requestedSessionId',
    'bridgeSessionId',
    'nativeThreadId',
    'originSessionId',
    'sourceSessionId',
    'conversationKey',
    'runId',
  ]) {
    if (Object.prototype.hasOwnProperty.call(command, field)) {
      normalized[field] = normalizeCommandString(command[field], `input command.${field}`, 8192);
    }
  }
  if (Object.prototype.hasOwnProperty.call(command, 'apiBinding')) {
    normalized.apiBinding = normalizeBinding(command.apiBinding, 'input command.apiBinding');
  }
  if (Object.prototype.hasOwnProperty.call(command, 'expectedBinding')) {
    normalized.expectedBinding = normalizeBinding(command.expectedBinding, 'input command.expectedBinding');
  }
  if (Object.prototype.hasOwnProperty.call(command, 'text')) {
    normalized.text = normalizeCommandString(command.text, 'input command.text');
  }
  if (Object.prototype.hasOwnProperty.call(command, 'inputItems')) {
    normalized.inputItems = normalizeInputItems(command.inputItems, 'input command.inputItems');
  }
  if (Object.prototype.hasOwnProperty.call(command, 'attachments')) {
    normalized.attachments = normalizeInputItems(command.attachments, 'input command.attachments');
  }
  for (const field of [
    'mode',
    'model',
    'effort',
    'summary',
    'approvalsReviewer',
    'sandboxMode',
    'planFallback',
    'serviceTier',
    'personality',
  ]) {
    if (Object.prototype.hasOwnProperty.call(command, field)) {
      normalized[field] = normalizeCommandString(command[field], `input command.${field}`, 16 * 1024);
    }
  }
  if (Object.prototype.hasOwnProperty.call(command, 'approvalPolicy')) {
    normalized.approvalPolicy = cloneJsonValue(command.approvalPolicy, 'input command.approvalPolicy');
  }
  assertSecretFree(normalized, 'normalized input command');
  return normalized;
}

function isPersistableInputCommand(command) {
  return Boolean(
    command
    && command.type === 'session.input'
    && normalizedClientRequestId(command.clientRequestId)
  );
}

function identityKey(hostId, scopeKey, clientRequestId) {
  return JSON.stringify([hostId, scopeKey, clientRequestId]);
}

function cloneCommand(command) {
  return JSON.parse(JSON.stringify(command));
}

function cloneTranscriptProjection(projection) {
  return JSON.parse(JSON.stringify(projection));
}

function desiredProjectionOutcome(entry) {
  return entry.completedOutcome || 'pending';
}

function projectionIsApplied(entry) {
  return Boolean(
    entry.projectionAppliedAtMs
    && entry.projectionAppliedOutcome === desiredProjectionOutcome(entry)
  );
}

function completionOutcomeCanRefine(currentOutcome, nextOutcome) {
  return currentOutcome === 'acceptance_unknown'
    && (nextOutcome === 'accepted' || nextOutcome === 'rejected');
}

class InputCommandOutbox {
  constructor(options = {}) {
    if (!options.filePath) throw new TypeError('InputCommandOutbox filePath is required');
    this.filePath = path.resolve(String(options.filePath));
    this.fileSystem = options.fileSystem || fs;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.commandQueueTtlMs = Math.max(1, Number(
      options.commandQueueTtlMs ?? DEFAULT_COMMAND_QUEUE_TTL_MS
    ) || DEFAULT_COMMAND_QUEUE_TTL_MS);
    this.dedupeTtlMs = Math.max(1, Number(
      options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS
    ) || DEFAULT_DEDUPE_TTL_MS);
    this.entryLimit = Math.max(1, Math.trunc(Number(options.entryLimit ?? DEFAULT_ENTRY_LIMIT)) || DEFAULT_ENTRY_LIMIT);
    this.maxRecordBytes = Math.max(1024, Number(
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
    ) || DEFAULT_MAX_RECORD_BYTES);
    this.maxJournalBytes = Math.max(this.maxRecordBytes, Number(
      options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES
    ) || DEFAULT_MAX_JOURNAL_BYTES);
    this.compactOperationThreshold = Math.max(1, Math.trunc(Number(
      options.compactOperationThreshold ?? Math.max(64, this.entryLimit * 2)
    )) || Math.max(64, this.entryLimit * 2));
    this.entries = new Map();
    this.commandIds = new Map();
    this.ackedThroughByHost = new Map();
    this.maxCommandId = 0;
    this.operationCount = 0;
    this.appendRecoveryRequired = false;
    if (options.autoLoad !== false) this.load();
  }

  reset() {
    this.entries.clear();
    this.commandIds.clear();
    this.ackedThroughByHost.clear();
    this.maxCommandId = 0;
    this.operationCount = 0;
  }

  applyQueuedRecord(record) {
    assertAllowedKeys(record, QUEUED_RECORD_KEYS, 'queued outbox record');
    const at = finiteTimestamp(record.at, 'queued outbox record.at');
    const hostId = requiredText(record.hostId, 'queued outbox record.hostId');
    const scopeKey = requiredText(record.scopeKey, 'queued outbox record.scopeKey', 16 * 1024);
    const clientRequestId = normalizedClientRequestId(record.clientRequestId);
    if (!clientRequestId) {
      throw outboxError('input_command_outbox_validation_failed', 'queued outbox clientRequestId is invalid');
    }
    const fingerprint = requiredText(record.fingerprint, 'queued outbox record.fingerprint', 512);
    const originalCommandId = positiveSafeInteger(
      record.originalCommandId,
      'queued outbox record.originalCommandId'
    );
    const command = normalizePersistedCommand(record.command, originalCommandId, clientRequestId);
    const transcriptProjection = normalizeTranscriptProjection(
      record.transcriptProjection,
      command,
      clientRequestId
    );
    const key = identityKey(hostId, scopeKey, clientRequestId);
    const serializedCommand = JSON.stringify(command);
    const serializedTranscriptProjection = JSON.stringify(transcriptProjection);
    const existing = this.entries.get(key);
    if (existing) {
      if (
        existing.fingerprint !== fingerprint
        || existing.originalCommandId !== originalCommandId
        || existing.serializedCommand !== serializedCommand
        || existing.serializedTranscriptProjection !== serializedTranscriptProjection
      ) {
        throw outboxError(
          'input_command_outbox_conflict',
          'clientRequestId was reused with conflicting input command data'
        );
      }
      return existing;
    }
    const commandOwner = this.commandIds.get(originalCommandId);
    if (commandOwner && commandOwner !== key) {
      throw outboxError(
        'input_command_outbox_conflict',
        `command ID ${originalCommandId} belongs to another persisted input`
      );
    }
    const entry = {
      hostId,
      scopeKey,
      clientRequestId,
      fingerprint,
      originalCommandId,
      command,
      serializedCommand,
      transcriptProjection,
      serializedTranscriptProjection,
      queuedAtMs: at,
    };
    this.entries.set(key, entry);
    this.commandIds.set(originalCommandId, key);
    this.maxCommandId = Math.max(this.maxCommandId, originalCommandId);
    return entry;
  }

  applyAckRecord(record) {
    assertAllowedKeys(record, ACK_RECORD_KEYS, 'ack outbox record');
    finiteTimestamp(record.at, 'ack outbox record.at');
    const hostId = requiredText(record.hostId, 'ack outbox record.hostId');
    const throughCommandId = positiveSafeInteger(
      record.throughCommandId,
      'ack outbox record.throughCommandId'
    );
    this.ackedThroughByHost.set(
      hostId,
      Math.max(Number(this.ackedThroughByHost.get(hostId) || 0), throughCommandId)
    );
    this.maxCommandId = Math.max(this.maxCommandId, throughCommandId);
  }

  applyCompleteRecord(record) {
    assertAllowedKeys(record, COMPLETE_RECORD_KEYS, 'complete outbox record');
    const at = finiteTimestamp(record.at, 'complete outbox record.at');
    const hostId = requiredText(record.hostId, 'complete outbox record.hostId');
    const commandId = positiveSafeInteger(record.commandId, 'complete outbox record.commandId');
    const clientRequestId = normalizedClientRequestId(record.clientRequestId);
    if (!clientRequestId) {
      throw outboxError('input_command_outbox_validation_failed', 'complete outbox clientRequestId is invalid');
    }
    const key = this.commandIds.get(commandId);
    const entry = key ? this.entries.get(key) : null;
    if (!entry) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        `completion references unknown input command ${commandId}`
      );
    }
    if (entry.hostId !== hostId || entry.clientRequestId !== clientRequestId) {
      throw outboxError(
        'input_command_outbox_conflict',
        `completion identity does not match input command ${commandId}`
      );
    }
    const sessionId = String(record.sessionId || '').trim();
    const outcome = String(record.outcome || '').trim();
    if (outcome && !INPUT_OUTCOMES.has(outcome)) {
      throw outboxError('input_command_outbox_validation_failed', `unsupported input outcome ${outcome}`);
    }
    if (
      entry.completedOutcome
      && outcome
      && entry.completedOutcome !== outcome
      && !completionOutcomeCanRefine(entry.completedOutcome, outcome)
    ) {
      throw outboxError(
        'input_command_outbox_conflict',
        `input command ${commandId} has conflicting completion outcomes`
      );
    }
    entry.completedAtMs = Math.max(Number(entry.completedAtMs || 0), at);
    if (sessionId) entry.completedSessionId = sessionId;
    if (outcome) entry.completedOutcome = outcome;
    this.maxCommandId = Math.max(this.maxCommandId, commandId);
    return entry;
  }

  applyProjectionAppliedRecord(record) {
    assertAllowedKeys(record, PROJECTION_APPLIED_RECORD_KEYS, 'projection-applied outbox record');
    const at = finiteTimestamp(record.at, 'projection-applied outbox record.at');
    const hostId = requiredText(record.hostId, 'projection-applied outbox record.hostId');
    const commandId = positiveSafeInteger(
      record.commandId,
      'projection-applied outbox record.commandId'
    );
    const clientRequestId = normalizedClientRequestId(record.clientRequestId);
    if (!clientRequestId) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        'projection-applied outbox clientRequestId is invalid'
      );
    }
    const outcome = String(record.outcome || '').trim();
    if (!PROJECTION_OUTCOMES.has(outcome)) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        `unsupported projection outcome ${outcome || '(missing)'}`
      );
    }
    const key = this.commandIds.get(commandId);
    const entry = key ? this.entries.get(key) : null;
    if (!entry) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        `projection checkpoint references unknown input command ${commandId}`
      );
    }
    if (entry.hostId !== hostId || entry.clientRequestId !== clientRequestId) {
      throw outboxError(
        'input_command_outbox_conflict',
        `projection checkpoint identity does not match input command ${commandId}`
      );
    }
    const desiredOutcome = desiredProjectionOutcome(entry);
    if (outcome !== desiredOutcome) {
      throw outboxError(
        'input_command_outbox_conflict',
        `projection checkpoint ${outcome} does not match current outcome ${desiredOutcome}`
      );
    }
    entry.projectionAppliedAtMs = Math.max(Number(entry.projectionAppliedAtMs || 0), at);
    entry.projectionAppliedOutcome = outcome;
    return entry;
  }

  scopeMigrationPlan(hostId, fromScopeKey, toScopeKey) {
    const moves = [];
    for (const [oldKey, entry] of this.entries.entries()) {
      if (entry.hostId !== hostId || entry.scopeKey !== fromScopeKey) continue;
      const newKey = identityKey(hostId, toScopeKey, entry.clientRequestId);
      const collision = this.entries.get(newKey);
      if (collision && collision !== entry) {
        const fingerprintMatches = collision.fingerprint === entry.fingerprint;
        const commandIdMatches = collision.originalCommandId === entry.originalCommandId;
        throw outboxError(
          'input_command_outbox_conflict',
          `scope migration collides with input ${entry.clientRequestId}`,
          {
            hostId,
            fromScopeKey,
            toScopeKey,
            clientRequestId: entry.clientRequestId,
            fingerprintMatches,
            commandIdMatches,
          }
        );
      }
      moves.push({ oldKey, newKey, entry });
    }
    return moves;
  }

  applyMigrateScopeRecord(record) {
    assertAllowedKeys(record, MIGRATE_SCOPE_RECORD_KEYS, 'migrate-scope outbox record');
    finiteTimestamp(record.at, 'migrate-scope outbox record.at');
    const hostId = requiredText(record.hostId, 'migrate-scope outbox record.hostId');
    const fromScopeKey = requiredText(
      record.fromScopeKey,
      'migrate-scope outbox record.fromScopeKey',
      16 * 1024
    );
    const toScopeKey = requiredText(
      record.toScopeKey,
      'migrate-scope outbox record.toScopeKey',
      16 * 1024
    );
    if (fromScopeKey === toScopeKey) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        'migrate-scope source and destination must differ'
      );
    }
    const moves = this.scopeMigrationPlan(hostId, fromScopeKey, toScopeKey);
    for (const { oldKey } of moves) this.entries.delete(oldKey);
    for (const { newKey, entry } of moves) {
      entry.scopeKey = toScopeKey;
      this.entries.set(newKey, entry);
      this.commandIds.set(entry.originalCommandId, newKey);
    }
    return moves.length;
  }

  applyWatermarkRecord(record) {
    assertAllowedKeys(record, WATERMARK_RECORD_KEYS, 'watermark outbox record');
    finiteTimestamp(record.at, 'watermark outbox record.at');
    this.maxCommandId = Math.max(
      this.maxCommandId,
      nonNegativeSafeInteger(record.maxCommandId, 'watermark outbox record.maxCommandId')
    );
  }

  applyRecord(record) {
    assertSecretFree(record, 'outbox record');
    assertPlainObject(record, 'outbox record');
    if (Number(record.version) !== RECORD_VERSION) {
      throw outboxError('input_command_outbox_validation_failed', 'unsupported input outbox record version');
    }
    if (record.op === 'queued') return this.applyQueuedRecord(record);
    if (record.op === 'ack') return this.applyAckRecord(record);
    if (record.op === 'complete') return this.applyCompleteRecord(record);
    if (record.op === 'projection_applied') return this.applyProjectionAppliedRecord(record);
    if (record.op === 'migrate_scope') return this.applyMigrateScopeRecord(record);
    if (record.op === 'watermark') return this.applyWatermarkRecord(record);
    throw outboxError(
      'input_command_outbox_validation_failed',
      `unsupported input outbox operation ${record.op || '(missing)'}`
    );
  }

  load() {
    this.reset();
    let raw = '';
    try {
      raw = this.fileSystem.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const recovered = recoverMissingFileFromBackup(this.filePath, { fileSystem: this.fileSystem });
      if (!recovered.recovered) {
        this.appendRecoveryRequired = false;
        return this.getRecoveryState();
      }
      raw = this.fileSystem.readFileSync(this.filePath, 'utf8');
    }

    const terminated = /\r?\n$/.test(raw);
    const unterminatedTail = Boolean(raw && !terminated);
    const lines = raw.split(/\r?\n/);
    let truncatedTail = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (cause) {
        if (index === lines.length - 1 && !terminated) {
          truncatedTail = true;
          break;
        }
        throw outboxError(
          'input_command_outbox_corrupt',
          `invalid input command outbox line ${index + 1}: ${cause.message || cause}`,
          { cause, lineNumber: index + 1 }
        );
      }
      try {
        this.applyRecord(record);
        this.operationCount += 1;
      } catch (cause) {
        throw outboxError(
          'input_command_outbox_corrupt',
          `invalid input command outbox line ${index + 1}: ${cause.message || cause}`,
          { cause, lineNumber: index + 1 }
        );
      }
    }

    const pruned = this.pruneExpiredEntries();
    this.assertCapacity();
    if (
      truncatedTail
      || unterminatedTail
      || pruned
      || this.operationCount > this.compactOperationThreshold
      || this.currentFileBytes() > this.maxJournalBytes
    ) {
      this.compact();
    }
    this.appendRecoveryRequired = false;
    return this.getRecoveryState();
  }

  entryFreshness(entry, at = Number(this.now())) {
    const retainedAt = Math.max(Number(entry.queuedAtMs || 0), Number(entry.completedAtMs || 0));
    const age = Math.max(0, at - retainedAt);
    const acknowledgedThrough = Number(this.ackedThroughByHost.get(entry.hostId) || 0);
    return {
      pending: !entry.completedAtMs
        && entry.originalCommandId > acknowledgedThrough
        && age <= this.commandQueueTtlMs,
      cache: age <= this.dedupeTtlMs,
      projectionPending: Boolean(entry.completedAtMs && !projectionIsApplied(entry)),
    };
  }

  pruneExpiredEntries() {
    const at = Number(this.now());
    let pruned = false;
    for (const [key, entry] of this.entries.entries()) {
      const freshness = this.entryFreshness(entry, at);
      if (freshness.pending || freshness.cache || freshness.projectionPending) continue;
      this.entries.delete(key);
      if (this.commandIds.get(entry.originalCommandId) === key) {
        this.commandIds.delete(entry.originalCommandId);
      }
      pruned = true;
    }
    return pruned;
  }

  assertCapacity(additionalEntries = 0) {
    if (this.entries.size + additionalEntries > this.entryLimit) {
      throw outboxError(
        'input_command_outbox_capacity_exceeded',
        `input command outbox contains ${this.entries.size} retained entries; limit is ${this.entryLimit}`,
        { retainedEntries: this.entries.size, entryLimit: this.entryLimit }
      );
    }
  }

  currentFileBytes() {
    try {
      return Number(this.fileSystem.statSync(this.filePath).size || 0);
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  }

  appendRecord(record, options = {}) {
    if (this.appendRecoveryRequired) {
      this.load();
      this.appendRecoveryRequired = false;
    }
    const serialized = `${JSON.stringify(record)}\n`;
    const recordBytes = Buffer.byteLength(serialized, 'utf8');
    if (recordBytes > this.maxRecordBytes && options.allowJournalOverflow !== true) {
      throw outboxError(
        'input_command_outbox_capacity_exceeded',
        `input outbox record is ${recordBytes} bytes; limit is ${this.maxRecordBytes}`
      );
    }
    if (
      options.allowJournalOverflow !== true
      && this.currentFileBytes() + recordBytes > this.maxJournalBytes
    ) {
      this.compact();
      if (this.currentFileBytes() + recordBytes > this.maxJournalBytes) {
        throw outboxError(
          'input_command_outbox_capacity_exceeded',
          'input command outbox journal is full; retained pending commands were not discarded'
        );
      }
    }

    this.fileSystem.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let descriptor = null;
    let appendError = null;
    try {
      descriptor = this.fileSystem.openSync(this.filePath, 'a');
      this.fileSystem.writeFileSync(descriptor, serialized, 'utf8');
      this.fileSystem.fsyncSync(descriptor);
    } catch (error) {
      appendError = error;
      this.appendRecoveryRequired = true;
    }
    if (descriptor != null) {
      try {
        this.fileSystem.closeSync(descriptor);
      } catch (error) {
        appendError ||= error;
        this.appendRecoveryRequired = true;
      }
    }
    if (appendError) throw appendError;
    this.operationCount += 1;
  }

  recordQueued(input = {}) {
    const command = input.command;
    if (!isPersistableInputCommand(command)) {
      return { recorded: false, reason: 'ineligible', entry: null };
    }
    assertSecretFree(input, 'queued input');
    assertAllowedKeys(
      input,
      new Set([
        'hostId',
        'scopeKey',
        'clientRequestId',
        'fingerprint',
        'command',
        'transcriptProjection',
      ]),
      'queued input'
    );
    const hostId = requiredText(input.hostId, 'queued input.hostId');
    const scopeKey = requiredText(input.scopeKey, 'queued input.scopeKey', 16 * 1024);
    const clientRequestId = normalizedClientRequestId(input.clientRequestId || command.clientRequestId);
    if (!clientRequestId) {
      throw outboxError('input_command_outbox_validation_failed', 'queued input clientRequestId is invalid');
    }
    const fingerprint = requiredText(input.fingerprint, 'queued input.fingerprint', 512);
    const originalCommandId = positiveSafeInteger(command.id, 'queued input command ID');
    const safeCommand = normalizePersistedCommand(command, originalCommandId, clientRequestId);
    const safeTranscriptProjection = normalizeTranscriptProjection(
      input.transcriptProjection,
      safeCommand,
      clientRequestId
    );
    const key = identityKey(hostId, scopeKey, clientRequestId);
    if (this.pruneExpiredEntries()) {
      // Remove expired identity records before reusing a clientRequestId. If
      // the old queued row remained in the WAL, a restart would replay both
      // generations and correctly classify them as a conflict.
      this.compact();
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (
        existing.fingerprint !== fingerprint
        || existing.originalCommandId !== originalCommandId
        || existing.serializedCommand !== JSON.stringify(safeCommand)
        || existing.serializedTranscriptProjection !== JSON.stringify(safeTranscriptProjection)
      ) {
        throw outboxError(
          'input_command_outbox_conflict',
          'clientRequestId was reused with conflicting input command data'
        );
      }
      return { recorded: false, reason: 'duplicate', entry: this.publicEntry(existing) };
    }
    const owner = this.commandIds.get(originalCommandId);
    if (owner && owner !== key) {
      throw outboxError(
        'input_command_outbox_conflict',
        `command ID ${originalCommandId} belongs to another persisted input`
      );
    }
    if (originalCommandId <= Number(this.ackedThroughByHost.get(hostId) || 0)) {
      throw outboxError(
        'input_command_outbox_conflict',
        `command ID ${originalCommandId} was already acknowledged for host ${hostId}`
      );
    }

    this.assertCapacity(1);
    const record = {
      version: RECORD_VERSION,
      op: 'queued',
      at: finiteTimestamp(this.now(), 'queued input timestamp'),
      hostId,
      scopeKey,
      clientRequestId,
      fingerprint,
      originalCommandId,
      command: safeCommand,
      transcriptProjection: safeTranscriptProjection,
    };
    this.appendRecord(record);
    const entry = this.applyQueuedRecord(record);
    this.compactIfNeeded();
    return { recorded: true, reason: null, entry: this.publicEntry(entry) };
  }

  ackThrough(hostIdInput, throughCommandIdInput) {
    const hostId = requiredText(hostIdInput, 'ack hostId');
    const throughCommandId = positiveSafeInteger(throughCommandIdInput, 'ack throughCommandId');
    const current = Number(this.ackedThroughByHost.get(hostId) || 0);
    if (throughCommandId <= current) {
      return { recorded: false, hostId, throughCommandId: current, acknowledgedInputs: 0 };
    }
    const before = this.getRecoveryState().pendingCommands
      .filter((entry) => entry.hostId === hostId && entry.originalCommandId <= throughCommandId)
      .length;
    const record = {
      version: RECORD_VERSION,
      op: 'ack',
      at: finiteTimestamp(this.now(), 'ack timestamp'),
      hostId,
      throughCommandId,
    };

    // The durable tombstone must precede both the in-memory ACK watermark and
    // Relay command-queue removal. A failed append therefore leaves pending
    // recovery state untouched and makes the caller retry the ACK.
    this.appendRecord(record, { allowJournalOverflow: true });
    this.applyAckRecord(record);
    if (this.pruneExpiredEntries()) this.compact();
    else this.compactIfNeeded();
    return { recorded: true, hostId, throughCommandId, acknowledgedInputs: before };
  }

  markCompleted(hostIdInput, commandIdInput, clientRequestIdInput, options = {}) {
    const hostId = requiredText(hostIdInput, 'complete hostId');
    const commandId = positiveSafeInteger(commandIdInput, 'complete commandId');
    const clientRequestId = normalizedClientRequestId(clientRequestIdInput);
    if (!clientRequestId) {
      throw outboxError('input_command_outbox_validation_failed', 'complete clientRequestId is invalid');
    }
    const key = this.commandIds.get(commandId);
    const entry = key ? this.entries.get(key) : null;
    if (!entry) {
      return { recorded: false, reason: 'missing', hostId, commandId, clientRequestId };
    }
    if (entry.hostId !== hostId || entry.clientRequestId !== clientRequestId) {
      throw outboxError(
        'input_command_outbox_conflict',
        `completion identity does not match input command ${commandId}`
      );
    }
    const sessionId = String(options.sessionId || entry.command?.requestedSessionId || entry.command?.sessionId || '').trim();
    const outcome = String(options.outcome || '').trim();
    if (outcome && !INPUT_OUTCOMES.has(outcome)) {
      throw outboxError('input_command_outbox_validation_failed', `unsupported input outcome ${outcome}`);
    }
    const wasCompleted = Boolean(entry.completedAtMs);
    if (wasCompleted) {
      const refinesOutcome = Boolean(
        outcome
        && outcome !== entry.completedOutcome
        && (
          !entry.completedOutcome
          || completionOutcomeCanRefine(entry.completedOutcome, outcome)
        )
      );
      if (outcome && entry.completedOutcome && outcome !== entry.completedOutcome && !refinesOutcome) {
        throw outboxError(
          'input_command_outbox_conflict',
          `input command ${commandId} already completed as ${entry.completedOutcome}`
        );
      }
      if (!refinesOutcome) return {
        recorded: false,
        reason: 'duplicate',
        hostId,
        commandId,
        clientRequestId,
        entry: this.publicEntry(entry),
      };
    }
    const record = {
      version: RECORD_VERSION,
      op: 'complete',
      at: finiteTimestamp(this.now(), 'complete timestamp'),
      hostId,
      commandId,
      clientRequestId,
      sessionId: sessionId || null,
      outcome: outcome || null,
    };
    this.appendRecord(record, { allowJournalOverflow: true });
    this.applyCompleteRecord(record);
    this.compactIfNeeded();
    return {
      recorded: true,
      reason: wasCompleted ? 'refined' : null,
      hostId,
      commandId,
      clientRequestId,
      entry: this.publicEntry(entry),
    };
  }

  markProjectionApplied(hostIdInput, commandIdInput, clientRequestIdInput, outcomeInput = '') {
    if (this.appendRecoveryRequired) this.load();
    const hostId = requiredText(hostIdInput, 'projection-applied hostId');
    const commandId = positiveSafeInteger(commandIdInput, 'projection-applied commandId');
    const clientRequestId = normalizedClientRequestId(clientRequestIdInput);
    if (!clientRequestId) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        'projection-applied clientRequestId is invalid'
      );
    }
    const key = this.commandIds.get(commandId);
    const entry = key ? this.entries.get(key) : null;
    if (!entry) {
      return { recorded: false, reason: 'missing', hostId, commandId, clientRequestId };
    }
    if (entry.hostId !== hostId || entry.clientRequestId !== clientRequestId) {
      throw outboxError(
        'input_command_outbox_conflict',
        `projection checkpoint identity does not match input command ${commandId}`
      );
    }
    const desiredOutcome = desiredProjectionOutcome(entry);
    const outcome = String(outcomeInput || desiredOutcome).trim();
    if (!PROJECTION_OUTCOMES.has(outcome)) {
      throw outboxError(
        'input_command_outbox_validation_failed',
        `unsupported projection outcome ${outcome || '(missing)'}`
      );
    }
    if (outcome !== desiredOutcome) {
      throw outboxError(
        'input_command_outbox_conflict',
        `projection checkpoint ${outcome} does not match current outcome ${desiredOutcome}`
      );
    }
    if (projectionIsApplied(entry)) {
      return {
        recorded: false,
        reason: 'duplicate',
        hostId,
        commandId,
        clientRequestId,
        outcome,
        entry: this.publicEntry(entry),
      };
    }
    const record = {
      version: RECORD_VERSION,
      op: 'projection_applied',
      at: finiteTimestamp(this.now(), 'projection-applied timestamp'),
      hostId,
      commandId,
      clientRequestId,
      outcome,
    };
    this.appendRecord(record, { allowJournalOverflow: true });
    this.applyProjectionAppliedRecord(record);
    const publicEntry = this.publicEntry(entry);
    if (this.pruneExpiredEntries()) this.compact();
    else this.compactIfNeeded();
    return {
      recorded: true,
      reason: null,
      hostId,
      commandId,
      clientRequestId,
      outcome,
      entry: publicEntry,
    };
  }

  migrateScope(hostIdInput, fromScopeKeyInput, toScopeKeyInput) {
    if (this.appendRecoveryRequired) this.load();
    const hostId = requiredText(hostIdInput, 'migrate-scope hostId');
    const fromScopeKey = requiredText(fromScopeKeyInput, 'migrate-scope fromScopeKey', 16 * 1024);
    const toScopeKey = requiredText(toScopeKeyInput, 'migrate-scope toScopeKey', 16 * 1024);
    if (fromScopeKey === toScopeKey) {
      return {
        recorded: false,
        reason: 'same_scope',
        hostId,
        fromScopeKey,
        toScopeKey,
        migratedEntries: 0,
      };
    }
    if (this.pruneExpiredEntries()) this.compact();
    const moves = this.scopeMigrationPlan(hostId, fromScopeKey, toScopeKey);
    if (!moves.length) {
      return {
        recorded: false,
        reason: 'missing',
        hostId,
        fromScopeKey,
        toScopeKey,
        migratedEntries: 0,
      };
    }
    const record = {
      version: RECORD_VERSION,
      op: 'migrate_scope',
      at: finiteTimestamp(this.now(), 'migrate-scope timestamp'),
      hostId,
      fromScopeKey,
      toScopeKey,
    };
    this.appendRecord(record, { allowJournalOverflow: true });
    const migratedEntries = this.applyMigrateScopeRecord(record);
    this.compactIfNeeded();
    return {
      recorded: true,
      reason: null,
      hostId,
      fromScopeKey,
      toScopeKey,
      migratedEntries,
    };
  }

  publicEntry(entry) {
    const projectionOutcome = desiredProjectionOutcome(entry);
    return {
      hostId: entry.hostId,
      scopeKey: entry.scopeKey,
      clientRequestId: entry.clientRequestId,
      fingerprint: entry.fingerprint,
      originalCommandId: entry.originalCommandId,
      queuedAtMs: entry.queuedAtMs,
      completedAtMs: entry.completedAtMs || null,
      completedSessionId: entry.completedSessionId || null,
      completedOutcome: entry.completedOutcome || null,
      transcriptProjection: cloneTranscriptProjection(entry.transcriptProjection),
      projectionOutcome,
      projectionAppliedAtMs: entry.projectionAppliedAtMs || null,
      projectionAppliedOutcome: entry.projectionAppliedOutcome || null,
      projectionApplied: projectionIsApplied(entry),
      command: cloneCommand(entry.command),
    };
  }

  getRecoveryState() {
    const at = Number(this.now());
    const pendingCommands = [];
    const cacheRecords = [];
    const completedCommands = [];
    const projectionWork = [];
    for (const entry of this.entries.values()) {
      const freshness = this.entryFreshness(entry, at);
      if (freshness.pending) pendingCommands.push(this.publicEntry(entry));
      if (entry.completedAtMs && (freshness.cache || freshness.projectionPending)) {
        completedCommands.push(this.publicEntry(entry));
      }
      if (
        !projectionIsApplied(entry)
        && (freshness.pending || freshness.projectionPending)
      ) {
        projectionWork.push(this.publicEntry(entry));
      }
      if (freshness.cache) {
        const command = cloneCommand(entry.command);
        cacheRecords.push({
          cacheKey: `${entry.hostId}::${entry.scopeKey}::${entry.clientRequestId}`,
          createdAtMs: Math.max(Number(entry.queuedAtMs || 0), Number(entry.completedAtMs || 0)),
          fingerprint: entry.fingerprint,
          hostId: entry.hostId,
          scopeKey: entry.scopeKey,
          clientRequestId: entry.clientRequestId,
          payload: {
            ok: true,
            clientRequestId: entry.clientRequestId,
            command,
          },
        });
      }
    }
    pendingCommands.sort((left, right) => left.originalCommandId - right.originalCommandId);
    cacheRecords.sort((left, right) => (
      left.createdAtMs - right.createdAtMs
      || left.cacheKey.localeCompare(right.cacheKey)
    ));
    completedCommands.sort((left, right) => left.originalCommandId - right.originalCommandId);
    projectionWork.sort((left, right) => left.originalCommandId - right.originalCommandId);
    return {
      pendingCommands,
      cacheRecords,
      completedCommands,
      projectionWork,
      maxCommandId: this.maxCommandId,
    };
  }

  compactIfNeeded() {
    if (
      this.operationCount > this.compactOperationThreshold
      || this.currentFileBytes() > this.maxJournalBytes
    ) {
      this.compact();
    }
  }

  compact() {
    this.pruneExpiredEntries();
    this.assertCapacity();
    const at = finiteTimestamp(this.now(), 'compaction timestamp');
    const records = [];
    if (this.maxCommandId > 0) {
      records.push({
        version: RECORD_VERSION,
        op: 'watermark',
        at,
        maxCommandId: this.maxCommandId,
      });
    }
    for (const [hostId, throughCommandId] of Array.from(this.ackedThroughByHost.entries())
      .sort(([left], [right]) => left.localeCompare(right))) {
      records.push({
        version: RECORD_VERSION,
        op: 'ack',
        at,
        hostId,
        throughCommandId,
      });
    }
    for (const entry of Array.from(this.entries.values())
      .sort((left, right) => left.originalCommandId - right.originalCommandId)) {
      records.push({
        version: RECORD_VERSION,
        op: 'queued',
        at: entry.queuedAtMs,
        hostId: entry.hostId,
        scopeKey: entry.scopeKey,
        clientRequestId: entry.clientRequestId,
        fingerprint: entry.fingerprint,
        originalCommandId: entry.originalCommandId,
        command: entry.command,
        transcriptProjection: entry.transcriptProjection,
      });
      if (entry.completedAtMs) {
        records.push({
          version: RECORD_VERSION,
          op: 'complete',
          at: entry.completedAtMs,
          hostId: entry.hostId,
          commandId: entry.originalCommandId,
          clientRequestId: entry.clientRequestId,
          sessionId: entry.completedSessionId || null,
          outcome: entry.completedOutcome || null,
        });
      }
      if (projectionIsApplied(entry)) {
        records.push({
          version: RECORD_VERSION,
          op: 'projection_applied',
          at: entry.projectionAppliedAtMs,
          hostId: entry.hostId,
          commandId: entry.originalCommandId,
          clientRequestId: entry.clientRequestId,
          outcome: entry.projectionAppliedOutcome,
        });
      }
    }
    const serialized = records.length
      ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
      : '';
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxJournalBytes) {
      throw outboxError(
        'input_command_outbox_capacity_exceeded',
        'input command outbox cannot be compacted within its byte limit without dropping retained entries'
      );
    }

    this.fileSystem.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    let descriptor = null;
    try {
      descriptor = this.fileSystem.openSync(tempPath, 'wx');
      this.fileSystem.writeFileSync(descriptor, serialized, 'utf8');
      this.fileSystem.fsyncSync(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = null;
      replaceFileWithBackup(tempPath, this.filePath, { fileSystem: this.fileSystem });
      this.operationCount = records.length;
    } finally {
      if (descriptor != null) this.fileSystem.closeSync(descriptor);
      try {
        this.fileSystem.unlinkSync(tempPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return this.getRecoveryState();
  }
}

module.exports = {
  InputCommandOutbox,
  isPersistableInputCommand,
  normalizedClientRequestId,
};
