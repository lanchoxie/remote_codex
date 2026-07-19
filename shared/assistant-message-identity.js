const crypto = require('crypto');
const path = require('path');

const PREVIEW_TEXT_LIMIT = 1000;
const INTERNAL_ASSISTANT_CHANNELS = new Set([
  'analysis',
  'commentary',
  'reasoning',
  'thinking',
  'thought',
  'internal',
]);

function text(value) {
  return String(value == null ? '' : value).trim();
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
  const explicit = text(input.streamId || input.sourceStreamId);
  if (explicit) {
    return explicit;
  }
  const normalizedPath = text(input.rolloutPath || input.sourcePath)
    .replace(/\\/g, '/')
    .toLowerCase();
  if (!normalizedPath) {
    return '';
  }
  const basename = path.posix.basename(normalizedPath);
  if (!basename) {
    return '';
  }
  const nativeThreadId = text(
    input.nativeThreadId || input.threadId || input.protocolThreadId
  );
  return `rollout:${nativeThreadId}:${basename}`;
}

function assistantMessageIdFor(identity = {}) {
  const nativeThreadId = text(
    identity.nativeThreadId || identity.threadId || identity.protocolThreadId
  );
  const protocolItemId = text(identity.protocolItemId || identity.itemId);
  if (nativeThreadId && protocolItemId) {
    const protocol = [
      'protocol',
      nativeThreadId,
      protocolItemId,
      'assistant',
    ];
    return `assistant:sha256:${sha256(JSON.stringify(protocol))}`;
  }

  const streamId = text(identity.streamId);
  const sourceOffset = coordinate(identity.sourceOffset);
  const sourceOrdinal = coordinate(identity.sourceOrdinal);
  const sourceTimestamp = text(identity.sourceTimestamp);
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
    text(identity.finalContentDigest),
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
    nativeThreadId: text(
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
    protocolTurnId: text(
      input.protocolTurnId
      || input.turnId
      || item.turn_id
      || item.turnId
      || params.turn_id
      || params.turnId
      || payload.turn_id
      || payload.turnId
    ),
    protocolItemId: text(
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
    contentPartId: text(
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
  ].map((value) => text(value).toLowerCase());
  return markers.some((marker) => (
    marker === 'task_complete'
    || marker.endsWith('/task_complete')
  ));
}

function assistantRole(input, row, payload, item) {
  let role = text(
    input.role
    || input.speaker
    || item.role
    || payload.role
    || row?.role
  ).toLowerCase();
  const type = text(item.type || payload.type).toLowerCase();
  if (!role && ['agent_message', 'assistant_message'].includes(type)) {
    role = 'assistant';
  }
  return role === 'agent' ? 'assistant' : role;
}

function isRetainedRolloutAssistant(input, row, payload) {
  if (text(input.representation).toLowerCase() !== 'rollout' || !row) {
    return true;
  }
  const rowType = text(row.type).toLowerCase();
  const payloadType = text(payload.type).toLowerCase();
  const channel = text(payload.phase || payload.channel || payload.kind).toLowerCase();
  if (INTERNAL_ASSISTANT_CHANNELS.has(channel)) {
    return false;
  }
  if (rowType === 'response_item') {
    const role = text(payload.role).toLowerCase();
    return payloadType === 'message' && (role === 'assistant' || role === 'agent');
  }
  if (rowType === 'event_msg') {
    return payloadType === 'agent_message' && Boolean(text(payload.message));
  }
  return Boolean(text(input.role || input.speaker));
}

function isInternalAssistantObservation(input, payload, item) {
  const channel = text(
    input.phase
    || input.channel
    || item.phase
    || item.channel
    || payload.phase
    || payload.channel
    || payload.kind
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
    sourceTimestamp: text(
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

  const observedAt = text(input.observedAt || input.firstObservedAt);
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
  normalizeAssistantObservation,
  sourceFileIdentity,
};
