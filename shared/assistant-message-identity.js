const crypto = require('crypto');
const path = require('path');
const { structuredText } = require('./structured-text');

const PREVIEW_TEXT_LIMIT = 1000;
const INTERNAL_ASSISTANT_CHANNELS = new Set([
  'analysis',
  'commentary',
  'reasoning',
  'thinking',
  'thought',
  'internal',
]);

const PROTOCOL_ID_KEYS = Object.freeze([
  'id',
  'value',
  'uuid',
  'threadId',
  'thread_id',
  'turnId',
  'turn_id',
  'itemId',
  'item_id',
  'partId',
  'part_id',
  'name',
  'text',
]);

function text(value) {
  return structuredText(value).trim();
}

function canonicalProtocolValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= 8) return '[Nested value omitted]';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 64).map((item) => canonicalProtocolValue(item, seen, depth + 1));
    }
    const result = {};
    let keys = [];
    try {
      keys = Object.keys(value).sort();
    } catch (_) {
      return '[Unserializable object]';
    }
    for (const key of keys.slice(0, 64)) {
      try {
        result[key] = canonicalProtocolValue(value[key], seen, depth + 1);
      } catch (_) {
        result[key] = '[Unserializable property]';
      }
    }
    if (keys.length > 64) result._truncatedKeys = true;
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalProtocolText(value) {
  try {
    const serialized = JSON.stringify(canonicalProtocolValue(value));
    return serialized && serialized !== 'null' ? serialized : '';
  } catch (_) {
    return '';
  }
}

function protocolScalar(value, preferredKeys = [], seen = new WeakSet()) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'object') return String(value).trim();
  if (seen.has(value)) return '';
  seen.add(value);
  try {
    if (Array.isArray(value) && value.length === 1) {
      return protocolScalar(value[0], preferredKeys, seen);
    }
    const keys = Array.from(new Set([...preferredKeys, 'value', 'name', 'text']));
    for (const key of keys) {
      let candidate;
      try {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        candidate = value[key];
      } catch (_) {
        continue;
      }
      if (candidate === value) continue;
      const normalized = protocolScalar(candidate, preferredKeys, seen);
      if (normalized) return normalized;
    }
    return canonicalProtocolText(value).trim();
  } finally {
    seen.delete(value);
  }
}

function protocolIdentity(value) {
  return protocolScalar(value, PROTOCOL_ID_KEYS);
}

function protocolToken(value, field) {
  return protocolScalar(value, [
    field,
    'type',
    'role',
    'kind',
    'status',
    'state',
    'phase',
    'channel',
    'method',
  ]);
}

function protocolTimestamp(value) {
  return protocolScalar(value, ['timestamp', 'time', 'at', 'value', 'text']);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function coordinate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function sourceFileIdentity(input = {}) {
  const explicit = protocolIdentity(input.streamId || input.sourceStreamId);
  if (explicit) {
    return explicit;
  }
  const normalizedPath = protocolIdentity(input.rolloutPath || input.sourcePath)
    .replace(/\\/g, '/')
    .toLowerCase();
  if (!normalizedPath) {
    return '';
  }
  const basename = path.posix.basename(normalizedPath);
  if (!basename) {
    return '';
  }
  const nativeThreadId = protocolIdentity(
    input.nativeThreadId || input.threadId || input.protocolThreadId
  );
  return `rollout:${nativeThreadId}:${basename}`;
}

function assistantMessageIdFor(identity = {}) {
  const nativeThreadId = protocolIdentity(
    identity.nativeThreadId || identity.threadId || identity.protocolThreadId
  );
  const protocolItemId = protocolIdentity(identity.protocolItemId || identity.itemId);
  if (nativeThreadId && protocolItemId) {
    const protocol = [
      'protocol',
      nativeThreadId,
      protocolItemId,
      'assistant',
    ];
    return `assistant:sha256:${sha256(JSON.stringify(protocol))}`;
  }

  const streamId = protocolIdentity(identity.streamId);
  const sourceOffset = coordinate(identity.sourceOffset);
  const sourceOrdinal = coordinate(identity.sourceOrdinal);
  const sourceTimestamp = protocolTimestamp(identity.sourceTimestamp);
  if (
    !nativeThreadId
    || !streamId
    || (sourceOffset === null && sourceOrdinal === null)
    || !sourceTimestamp
  ) {
    return '';
  }
  const source = [
    'source',
    nativeThreadId,
    streamId,
    sourceOffset,
    sourceOffset === null ? sourceOrdinal : null,
    'assistant',
    sourceTimestamp,
    protocolIdentity(identity.finalContentDigest),
  ];
  return `assistant:sha256:${sha256(JSON.stringify(source))}`;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object') || {};
}

function rowParts(row, input) {
  const payload = firstObject(row?.payload, row?.data);
  const params = firstObject(input.params, row?.params, payload.params);
  const item = firstObject(input.item, params.item, payload.item);
  return { payload, params, item };
}

function contentParts(input, payload, item) {
  for (const candidate of [input.content, item.content, payload.content]) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function protocolFields(input, row, payload, params, item, parts) {
  const firstPart = firstObject(parts[0]);
  return {
    nativeThreadId: protocolIdentity(
      input.nativeThreadId
      || input.threadId
      || input.protocolThreadId
      || params.threadId
      || params.thread_id
      || payload.thread_id
      || payload.threadId
      || row?.thread_id
      || row?.threadId
    ),
    protocolTurnId: protocolIdentity(
      input.protocolTurnId
      || input.turnId
      || item.turn_id
      || item.turnId
      || params.turn_id
      || params.turnId
      || payload.turn_id
      || payload.turnId
    ),
    protocolItemId: protocolIdentity(
      input.protocolItemId
      || input.itemId
      || item.id
      || item.item_id
      || item.itemId
      || payload.id
      || payload.item_id
      || payload.itemId
      || payload.message_id
      || payload.messageId
    ),
    contentPartId: protocolIdentity(
      input.contentPartId
      || input.partId
      || firstPart.id
      || firstPart.part_id
      || firstPart.partId
    ),
  };
}

function extractPartText(part) {
  if (part == null) {
    return '';
  }
  if (typeof part === 'string' || typeof part === 'number') {
    return text(part);
  }
  if (typeof part !== 'object') {
    return '';
  }
  for (const candidate of [part.text, part.output_text, part.outputText]) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return text(candidate);
    }
  }
  if (typeof part.content === 'string' || typeof part.content === 'number') {
    return text(part.content);
  }
  return '';
}

function extractContentText(content) {
  return (Array.isArray(content) ? content : [])
    .map(extractPartText)
    .filter(Boolean)
    .join('\n');
}

function normalizeRolloutMirrorText(value) {
  return text(value)
    .replace(/\r\n?/g, '\n')
    .trim();
}

function describeRolloutAssistantRow(row) {
  if (!row || typeof row !== 'object') return null;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const rowType = protocolToken(row.type, 'type').toLowerCase();
  const payloadType = protocolToken(payload.type, 'type').toLowerCase();
  if (rowType === 'event_msg' && payloadType === 'agent_message') {
    const value = normalizeRolloutMirrorText(payload.message);
    if (!value) return null;
    return {
      kind: 'event',
      text: value,
      phase: protocolToken(payload.phase || payload.channel, 'phase').toLowerCase(),
      timestamp: protocolTimestamp(row.timestamp || payload.timestamp),
      protocolItemId: '',
    };
  }
  if (
    rowType === 'response_item'
    && payloadType === 'message'
    && ['assistant', 'agent'].includes(protocolToken(payload.role, 'role').toLowerCase())
  ) {
    const value = normalizeRolloutMirrorText(
      payload.message || extractContentText(payload.content)
    );
    if (!value) return null;
    return {
      kind: 'response',
      text: value,
      phase: protocolToken(payload.phase || payload.channel, 'phase').toLowerCase(),
      timestamp: protocolTimestamp(row.timestamp || payload.timestamp),
      protocolItemId: protocolIdentity(payload.id || payload.item_id || payload.itemId),
    };
  }
  return null;
}

function isRolloutAssistantMirrorPair(leftRow, rightRow, options = {}) {
  const left = describeRolloutAssistantRow(leftRow);
  const right = describeRolloutAssistantRow(rightRow);
  if (!left || !right || left.text !== right.text) {
    return false;
  }
  const identifiedMirror = left.kind === 'event'
    && right.kind === 'response'
    && Boolean(right.protocolItemId);
  const fallbackMirror = left.kind === 'event'
    && right.kind === 'event'
    && !left.protocolItemId
    && !right.protocolItemId;
  if (!identifiedMirror && !fallbackMirror) {
    return false;
  }
  const phasesMatch = left.phase === right.phase;
  const responseSuppliesMissingEventPhase = identifiedMirror
    && !left.phase
    && Boolean(right.phase);
  if (!phasesMatch && !responseSuppliesMissingEventPhase) {
    return false;
  }
  const leftMs = Date.parse(left.timestamp);
  const rightMs = Date.parse(right.timestamp);
  const maxDeltaMs = Math.max(0, Number(options.maxDeltaMs ?? 1000) || 0);
  return !Number.isFinite(leftMs)
    || !Number.isFinite(rightMs)
    || Math.abs(rightMs - leftMs) <= maxDeltaMs;
}

function coalesceRolloutAssistantMirrorRows(rows, options = {}) {
  const values = Array.isArray(rows) ? rows : [];
  const coalesced = [];
  for (let index = 0; index < values.length; index += 1) {
    if (isRolloutAssistantMirrorPair(values[index], values[index + 1], options)) {
      coalesced.push(values[index + 1]);
      index += 1;
      continue;
    }
    coalesced.push(values[index]);
  }
  return coalesced;
}

function isTaskComplete(input, row, payload, item) {
  const markers = [
    input.type,
    input.eventType,
    input.method,
    row?.method,
    row?.type,
    payload.type,
    payload.eventType,
    item.type,
  ].map((value) => protocolToken(value, 'type').toLowerCase());
  return markers.some((marker) => (
    marker === 'task_complete'
    || marker.endsWith('/task_complete')
  ));
}

function assistantRole(input, row, payload, item) {
  let role = protocolToken(
    input.role
    || input.speaker
    || item.role
    || payload.role
    || row?.role,
    'role'
  ).toLowerCase();
  const type = protocolToken(item.type || payload.type, 'type').toLowerCase();
  if (!role && ['agent_message', 'assistant_message'].includes(type)) {
    role = 'assistant';
  }
  return role === 'agent' ? 'assistant' : role;
}

function isRetainedRolloutAssistant(input, row, payload) {
  if (protocolToken(input.representation, 'representation').toLowerCase() !== 'rollout' || !row) {
    return true;
  }
  const rowType = protocolToken(row.type, 'type').toLowerCase();
  const payloadType = protocolToken(payload.type, 'type').toLowerCase();
  const channel = protocolToken(payload.phase || payload.channel || payload.kind, 'phase').toLowerCase();
  if (INTERNAL_ASSISTANT_CHANNELS.has(channel)) {
    return false;
  }
  if (rowType === 'response_item') {
    const role = protocolToken(payload.role, 'role').toLowerCase();
    return payloadType === 'message' && (role === 'assistant' || role === 'agent');
  }
  if (rowType === 'event_msg') {
    return payloadType === 'agent_message' && Boolean(text(payload.message));
  }
  return Boolean(protocolToken(input.role || input.speaker, 'role'));
}

function isInternalAssistantObservation(input, payload, item) {
  const channel = protocolToken(
    input.phase
    || input.channel
    || item.phase
    || item.channel
    || payload.phase
    || payload.channel
    || payload.kind,
    'phase'
  ).toLowerCase();
  return INTERNAL_ASSISTANT_CHANNELS.has(channel);
}

function normalizeAssistantObservation(input = {}) {
  const row = input.row && typeof input.row === 'object' ? input.row : null;
  const { payload, params, item } = rowParts(row, input);
  if (isTaskComplete(input, row, payload, item)) {
    return null;
  }
  if (!isRetainedRolloutAssistant(input, row, payload)) {
    return null;
  }
  if (isInternalAssistantObservation(input, payload, item)) {
    return null;
  }

  const role = assistantRole(input, row, payload, item);
  if (role !== 'assistant') {
    return null;
  }

  const finalized = input.finalized === true;
  const parts = contentParts(input, payload, item);
  const sourceParts = Array.isArray(item.content)
    ? item.content
    : Array.isArray(payload.content)
      ? payload.content
      : [];
  const sourceValue = text(
    item.text
    || item.message
    || payload.message
    || extractContentText(sourceParts)
  );
  const value = text(
    input.text
    || input.message
    || item.text
    || item.message
    || payload.message
    || extractContentText(parts)
  );
  const identityValue = sourceValue || value;
  const protocol = protocolFields(input, row, payload, params, item, parts);
  const hasProtocolIdentity = Boolean(
    protocol.nativeThreadId && protocol.protocolItemId
  );
  if (!hasProtocolIdentity && (!finalized || !identityValue)) {
    return null;
  }

  const sourceIdentity = {
    nativeThreadId: protocol.nativeThreadId,
    streamId: sourceFileIdentity({
      ...input,
      nativeThreadId: protocol.nativeThreadId,
    }),
    protocolTurnId: protocol.protocolTurnId,
    protocolItemId: protocol.protocolItemId,
    contentPartId: protocol.contentPartId || (protocol.protocolItemId ? 'message' : ''),
    sourceOffset: coordinate(input.sourceOffset ?? row?.sourceOffset),
    sourceOrdinal: coordinate(input.sourceOrdinal ?? row?.sourceOrdinal),
    role: 'assistant',
    sourceTimestamp: protocolTimestamp(
      input.sourceTimestamp
      || item.timestamp
      || payload.timestamp
      || row?.timestamp
    ),
    finalContentDigest: !hasProtocolIdentity && finalized && identityValue
      ? sha256(identityValue)
      : null,
  };
  const assistantMessageId = assistantMessageIdFor(sourceIdentity);
  if (!assistantMessageId) {
    return null;
  }

  const observedAt = protocolTimestamp(input.observedAt || input.firstObservedAt);
  return {
    assistantMessageId,
    assistantAt: sourceIdentity.sourceTimestamp || observedAt,
    firstObservedAt: observedAt || new Date().toISOString(),
    finalized,
    notifiableCandidate: finalized,
    previewText: value.slice(0, PREVIEW_TEXT_LIMIT),
    sourceIdentity,
  };
}

module.exports = {
  assistantMessageIdFor,
  coalesceRolloutAssistantMirrorRows,
  describeRolloutAssistantRow,
  isRolloutAssistantMirrorPair,
  normalizeAssistantObservation,
  sourceFileIdentity,
};
