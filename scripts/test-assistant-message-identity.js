const assert = require('assert');

const {
  assistantMessageIdFor,
  coalesceRolloutAssistantMirrorRows,
  describeRolloutAssistantRow,
  isRolloutAssistantMirrorPair,
  normalizeAssistantObservation,
  sourceFileIdentity,
} = require('../shared/assistant-message-identity');
const {
  makeCodexRowEvents,
  makeTranscriptEntry,
} = require('../shared/codex-discovery');

const mirroredEventRow = {
  timestamp: '2026-07-16T08:59:59.980Z',
  type: 'event_msg',
  payload: {
    type: 'agent_message',
    phase: 'final',
    message: 'one mirrored final answer',
  },
};
const mirroredResponseRow = {
  timestamp: '2026-07-16T09:00:00.000Z',
  type: 'response_item',
  payload: {
    id: 'msg-mirror-1',
    type: 'message',
    role: 'assistant',
    phase: 'final',
    content: [{ type: 'output_text', text: 'one mirrored final answer' }],
  },
};
assert.strictEqual(describeRolloutAssistantRow(mirroredEventRow)?.kind, 'event');
assert.strictEqual(describeRolloutAssistantRow(mirroredResponseRow)?.kind, 'response');
assert.strictEqual(isRolloutAssistantMirrorPair(mirroredEventRow, mirroredResponseRow), true);
assert.deepStrictEqual(
  coalesceRolloutAssistantMirrorRows([mirroredEventRow, mirroredResponseRow]),
  [mirroredResponseRow],
  'strict adjacent mirrors must retain only the protocol-identified response row'
);
for (const mismatchedResponse of [
  { ...mirroredResponseRow, payload: { ...mirroredResponseRow.payload, phase: 'commentary' } },
  { ...mirroredResponseRow, payload: { ...mirroredResponseRow.payload, content: [{ type: 'output_text', text: 'different' }] } },
  { ...mirroredResponseRow, timestamp: '2026-07-16T09:00:02.000Z' },
  { ...mirroredResponseRow, payload: { ...mirroredResponseRow.payload, id: null } },
]) {
  assert.strictEqual(isRolloutAssistantMirrorPair(mirroredEventRow, mismatchedResponse), false);
}
const sameTextDifferentItem = {
  ...mirroredResponseRow,
  payload: { ...mirroredResponseRow.payload, id: 'msg-mirror-2' },
};
assert.deepStrictEqual(
  coalesceRolloutAssistantMirrorRows([mirroredResponseRow, sameTextDifferentItem]),
  [mirroredResponseRow, sameTextDifferentItem],
  'two protocol items with identical text are distinct messages, not mirrors'
);

const common = {
  nativeThreadId: 'thread-1',
  streamId: 'rollout:thread-1:file-a',
  observedAt: '2026-07-16T09:00:01.000Z',
};

const live = normalizeAssistantObservation({
  ...common,
  representation: 'live',
  protocolTurnId: 'turn-1',
  protocolItemId: 'item-1',
  contentPartId: 'part-0',
  role: 'assistant',
  sourceTimestamp: '2026-07-16T09:00:00.000Z',
  finalized: true,
  text: 'final answer',
});
const rollout = normalizeAssistantObservation({
  ...common,
  representation: 'rollout',
  row: {
    timestamp: '2026-07-16T09:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      turn_id: 'turn-1',
      id: 'item-1',
      content: [{ id: 'part-0', type: 'output_text', text: 'final answer' }],
    },
  },
  finalized: true,
});
assert(live);
assert(rollout);
assert.strictEqual(
  live.assistantMessageId,
  rollout.assistantMessageId,
  'live and rollout forms of one protocol item must share identity'
);
const jsonRpcLive = normalizeAssistantObservation({
  nativeThreadId: 'thread-1',
  representation: 'live',
  row: {
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-1',
        type: 'agent_message',
        role: 'assistant',
        content: [{ id: 'part-0', type: 'output_text', text: 'final answer' }],
      },
    },
  },
  sourceTimestamp: '2026-07-16T09:00:00.000Z',
  observedAt: '2026-07-16T09:00:01.000Z',
  finalized: true,
});
assert.strictEqual(
  jsonRpcLive.assistantMessageId,
  rollout.assistantMessageId,
  'JSON-RPC params.item and rollout payload forms must normalize to one identity'
);

const protocolIdentity = {
  nativeThreadId: 'thread-1',
  protocolTurnId: 'turn-1',
  protocolItemId: 'item-1',
  contentPartId: 'part-0',
  role: 'assistant',
};
assert.strictEqual(
  assistantMessageIdFor({
    ...protocolIdentity,
    sourceOffset: 10,
    sourceTimestamp: '2026-07-16T09:00:00.000Z',
    text: 'old',
  }),
  assistantMessageIdFor({
    ...protocolIdentity,
    sourceOffset: 999,
    sourceTimestamp: '2026-07-17T09:00:00.000Z',
    text: 'new',
  }),
  'protocol identity must ignore source coordinates, timestamps, and text'
);
assert.strictEqual(
  assistantMessageIdFor(protocolIdentity),
  assistantMessageIdFor({ ...protocolIdentity, contentPartId: 'part-1' }),
  'later content-part enrichment must not split one protocol message identity'
);
assert.notStrictEqual(
  assistantMessageIdFor(protocolIdentity),
  assistantMessageIdFor({ ...protocolIdentity, protocolItemId: 'item-2' }),
  'distinct protocol items must retain distinct identities'
);

const partiallyIdentified = normalizeAssistantObservation({
  ...common,
  representation: 'live',
  protocolItemId: 'item-enriched',
  role: 'assistant',
  finalized: false,
  text: 'partial',
});
const enrichedFinal = normalizeAssistantObservation({
  ...common,
  representation: 'rollout',
  row: {
    timestamp: '2026-07-16T09:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      turn_id: 'turn-enriched',
      id: 'item-enriched',
      content: [{ id: 'part-enriched', type: 'output_text', text: 'settled' }],
    },
  },
  finalized: true,
});
assert.strictEqual(
  partiallyIdentified.assistantMessageId,
  enrichedFinal.assistantMessageId,
  'optional protocol metadata added at finalization must retain the streaming identity'
);

const coordinateA = normalizeAssistantObservation({
  ...common,
  representation: 'rollout',
  role: 'assistant',
  sourceOffset: 100,
  sourceOrdinal: 4,
  sourceTimestamp: '2026-07-16T09:00:00.000Z',
  finalized: true,
  text: 'A',
});
const coordinateB = normalizeAssistantObservation({
  ...common,
  representation: 'rollout',
  role: 'assistant',
  sourceOffset: 101,
  sourceOrdinal: 5,
  sourceTimestamp: '2026-07-16T09:00:00.000Z',
  finalized: true,
  text: 'A',
});
assert(coordinateA);
assert(coordinateB);
assert.notStrictEqual(coordinateA.assistantMessageId, coordinateB.assistantMessageId);
assert.strictEqual(
  assistantMessageIdFor(coordinateA.sourceIdentity),
  assistantMessageIdFor({ ...coordinateA.sourceIdentity, sourceOrdinal: 4000 }),
  'a byte offset is the authoritative coordinate when a tailer cannot know the full-file ordinal'
);

assert.strictEqual(
  normalizeAssistantObservation({
    ...common,
    representation: 'live',
    role: 'assistant',
    finalized: false,
    text: 'tok',
  }),
  null,
  'an unidentified token preview must not become a retained message'
);
assert.strictEqual(
  normalizeAssistantObservation({
    ...common,
    representation: 'rollout',
    role: 'assistant',
    finalized: true,
    sourceOffset: 12,
    sourceTimestamp: '2026-07-16T09:00:00.000Z',
    text: '   ',
  }),
  null,
  'fallback identity requires finalized content as well as immutable coordinates'
);

const identifiedStreaming = normalizeAssistantObservation({
  ...common,
  representation: 'live',
  protocolTurnId: 'turn-2',
  protocolItemId: 'item-streaming',
  role: 'assistant',
  finalized: false,
  text: 'partial',
});
assert(identifiedStreaming, 'a protocol-identified stream may retain its identity before finalization');
assert.strictEqual(identifiedStreaming.notifiableCandidate, false);
assert.strictEqual(identifiedStreaming.sourceIdentity.finalContentDigest, null);

const finalizedFallback = normalizeAssistantObservation({
  ...common,
  representation: 'live',
  role: 'assistant',
  finalized: true,
  sourceOrdinal: 8,
  sourceTimestamp: '2026-07-16T09:00:03.000Z',
  text: 'settled',
});
assert(finalizedFallback?.assistantMessageId);
assert.match(finalizedFallback.sourceIdentity.finalContentDigest, /^[a-f0-9]{64}$/);
assert.notStrictEqual(
  finalizedFallback.assistantMessageId,
  normalizeAssistantObservation({
    ...common,
    representation: 'live',
    role: 'assistant',
    finalized: true,
    sourceOrdinal: 8,
    sourceTimestamp: '2026-07-16T09:00:03.000Z',
    text: 'different finalized content',
  }).assistantMessageId,
  'the final-content digest may disambiguate only finalized fallback identities'
);

for (const input of [
  {
    ...common,
    representation: 'rollout',
    row: {
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'final answer' },
    },
    finalized: true,
  },
  {
    ...common,
    representation: 'live',
    method: 'event_msg/task_complete',
    role: 'assistant',
    finalized: true,
    text: 'final answer',
  },
]) {
  assert.strictEqual(
    normalizeAssistantObservation(input),
    null,
    'task_complete is completion metadata, not a second assistant item'
  );
}

for (const row of [
  {
    type: 'response_item',
    payload: {
      type: 'agent_message',
      content: [{ type: 'input_text', text: 'prior agent history' }],
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'progress update' }],
    },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'analysis',
      message: 'internal reasoning',
    },
  },
]) {
  assert.strictEqual(normalizeAssistantObservation({
    ...common,
    representation: 'rollout',
    row,
    sourceOffset: 44,
    sourceOrdinal: 3,
    sourceTimestamp: '2026-07-16T09:00:00.000Z',
    finalized: true,
  }), null, 'internal/history assistant payloads must not become retained messages');
}
assert.strictEqual(normalizeAssistantObservation({
  ...common,
  representation: 'live',
  protocolItemId: 'reasoning-item',
  role: 'assistant',
  phase: 'reasoning',
  text: 'private reasoning delta',
  finalized: true,
}), null, 'live reasoning/commentary items must not enter the assistant message ledger');

assert.strictEqual(normalizeAssistantObservation({
  ...common,
  role: 'user',
  finalized: true,
  sourceOffset: 1,
  sourceTimestamp: '2026-07-16T09:00:00.000Z',
  text: 'question',
}), null);

assert.strictEqual(
  sourceFileIdentity({
    nativeThreadId: 'thread-1',
    rolloutPath: 'C:\\Users\\Example\\.codex\\sessions\\Rollout-A.JSONL',
  }),
  'rollout:thread-1:rollout-a.jsonl'
);
assert.strictEqual(
  sourceFileIdentity({ nativeThreadId: 'thread-1', streamId: 'explicit-stream' }),
  'explicit-stream'
);

const fallbackRow = {
  timestamp: '2026-07-16T09:00:05.000Z',
  type: 'event_msg',
  payload: {
    type: 'agent_message',
    message: 'first line\n\n\n\nsecond line',
  },
};
const rowContext = {
  nativeThreadId: 'thread-1',
  rolloutPath: 'C:\\codex\\rollout-thread-1.jsonl',
  sourceOffset: 4812,
  sourceOrdinal: 7,
  observedAt: '2026-07-16T09:00:06.000Z',
};
const rowEvent = makeCodexRowEvents(fallbackRow, rowContext)
  .find((event) => event.type === 'session.transcript');
assert(rowEvent?.entry?.assistantObservation, 'rollout transcript events must carry one normalized assistant observation');
assert.strictEqual(rowEvent.entry.assistantObservation.sourceIdentity.sourceOffset, 4812);
assert.strictEqual(rowEvent.entry.assistantObservation.sourceIdentity.sourceOrdinal, 7);
assert.strictEqual(
  rowEvent.entry.assistantObservation.assistantMessageId,
  normalizeAssistantObservation({
    ...rowContext,
    representation: 'rollout',
    row: fallbackRow,
    finalized: true,
  }).assistantMessageId,
  'presentation cleanup must not change the immutable fallback identity'
);
const identifiedTranscript = makeTranscriptEntry(mirroredResponseRow, rowContext);
assert.strictEqual(
  identifiedTranscript.assistantMessageId,
  makeCodexRowEvents(mirroredResponseRow, rowContext)
    .find((event) => event.type === 'session.transcript')
    .entry.assistantObservation.assistantMessageId,
  'history extraction and live tailing must preserve the same protocol assistant identity'
);
assert.strictEqual(identifiedTranscript.source, 'codex-jsonl');

const taskComplete = {
  timestamp: '2026-07-16T09:00:07.000Z',
  type: 'event_msg',
  payload: { type: 'task_complete', last_agent_message: 'final answer' },
};
assert.strictEqual(makeTranscriptEntry(taskComplete), null);
assert.strictEqual(
  makeCodexRowEvents(taskComplete, rowContext).some((event) => event.type === 'session.transcript'),
  false,
  'task_complete may update runtime/diagnostics but must not duplicate transcript content'
);

const longPreview = normalizeAssistantObservation({
  ...common,
  protocolItemId: 'bounded-preview',
  role: 'assistant',
  finalized: true,
  text: 'x'.repeat(1500),
});
assert.strictEqual(longPreview.previewText.length, 1000);

console.log('assistant message identity assertions passed');
