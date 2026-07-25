const assert = require('assert');

const {
  createTranscriptActivityProjection,
} = require('../apps/mobile-web/public/transcript-state');

const projection = createTranscriptActivityProjection();
const canonicalKey = 'host-a::native-thread';
const base = {
  streamEpoch: 'epoch-a',
  activityKey: '["host-a::native-thread","run-1","turn-1","item-1",0]',
  runId: 'run-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  summaryIndex: 0,
};

assert.strictEqual(projection.applyActivity(canonicalKey, {
  ...base,
  canonicalConversationKey: 'host-a::bridge-alias',
  activityRevision: 2,
  text: 'two',
}), true);
assert.strictEqual(projection.applyActivity(canonicalKey, {
  ...base,
  activityRevision: 2,
  text: 'duplicate',
}), false);
assert.strictEqual(projection.applyActivity(canonicalKey, {
  ...base,
  activityRevision: 1,
  text: 'older',
}), false);
assert.strictEqual(projection.applyActivity(canonicalKey, {
  ...base,
  activityRevision: 3,
  text: 'three',
}), true);
assert.strictEqual(
  projection.activitiesFor(canonicalKey)[0].canonicalConversationKey,
  canonicalKey,
  'Relay-supplied canonical identity must replace bridge/native aliases'
);

const structuredKey = 'host-a::structured';
projection.applyReset(structuredKey, { streamEpoch: 'epoch-structured', activities: [] });
assert.strictEqual(projection.applyActivity(structuredKey, {
  streamEpoch: 'epoch-structured',
  activityKey: 'structured-activity',
  activityRevision: 1,
  runId: 'run-structured',
  turnId: 'turn-structured',
  itemId: 'item-structured',
  callId: 'call-structured',
  requestId: 'request-structured',
  kind: 'command-output',
  itemType: 'commandExecution',
  status: 'completed',
  text: 'done',
  command: 'npm test',
  cwd: 'D:/workspace',
  output: '<literal output>',
  outputTruncated: true,
  exitCode: 0,
  durationMs: 18,
  processId: 'process-structured',
  stream: 'stderr',
  success: false,
  arguments: { target: '<literal>' },
  result: { ok: true },
  commandActions: [{ type: 'read', path: 'package.json' }],
  fileChanges: [{ path: 'src/app.js', diff: '-old\n+new' }],
  final: true,
}), true);
const projectedStructured = projection.activitiesFor(structuredKey)[0];
for (const [field, expected] of Object.entries({
  callId: 'call-structured',
  requestId: 'request-structured',
  itemType: 'commandExecution',
  status: 'completed',
  command: 'npm test',
  cwd: 'D:/workspace',
  output: '<literal output>',
  exitCode: 0,
  durationMs: 18,
  processId: 'process-structured',
  stream: 'stderr',
})) {
  assert.deepStrictEqual(projectedStructured[field], expected, `${field} should survive browser projection`);
}
assert.deepStrictEqual(projectedStructured.arguments, { target: '<literal>' });
assert.deepStrictEqual(projectedStructured.result, { ok: true });
assert.deepStrictEqual(projectedStructured.commandActions, [{ type: 'read', path: 'package.json' }]);
assert.deepStrictEqual(projectedStructured.fileChanges, [{ path: 'src/app.js', diff: '-old\n+new' }]);
assert.strictEqual(projectedStructured.outputTruncated, true);
assert.strictEqual(projectedStructured.success, false);

assert.strictEqual(projection.applyActivity(canonicalKey, {
  ...base,
  streamEpoch: 'epoch-b',
  activityRevision: 99,
  text: 'incremental event from an unknown epoch',
}), false, 'an epoch change must arrive through an authoritative reset');

projection.applyReset(canonicalKey, {
  streamEpoch: 'epoch-b',
  activities: [{
    ...base,
    streamEpoch: 'stale-embedded-epoch',
    activityRevision: 1,
    text: 'rebuilt',
  }],
});
assert.deepStrictEqual(
  projection.activitiesFor(canonicalKey).map((entry) => [entry.streamEpoch, entry.activityRevision, entry.text]),
  [['epoch-b', 1, 'rebuilt']],
  'a new-epoch reset must replace a higher old-epoch revision'
);
assert.strictEqual(projection.applyActivity(canonicalKey, {
  ...base,
  streamEpoch: 'epoch-b',
  activityRevision: 2,
  text: 'after reset',
}), true);

const external = projection.activitiesFor(canonicalKey);
external[0].text = 'mutated';
assert.strictEqual(projection.activitiesFor(canonicalKey)[0].text, 'after reset');

const secondBase = {
  ...base,
  activityKey: '["host-a::native-thread","run-1","turn-1","item-2",0]',
  itemId: 'item-2',
};
assert.strictEqual(projection.applyActivity(canonicalKey, {
  ...secondBase,
  streamEpoch: 'epoch-b',
  activityRevision: 5,
  text: 'newer event received during paging',
}), true);
assert.strictEqual(projection.replaceSnapshot(canonicalKey, {
  streamEpoch: 'epoch-b',
  activities: [{
    ...secondBase,
    activityRevision: 4,
    text: 'older paged snapshot',
  }],
}), true);
assert.deepStrictEqual(
  projection.activitiesFor(canonicalKey).map((entry) => [entry.activityKey, entry.activityRevision, entry.text]),
  [[secondBase.activityKey, 5, 'newer event received during paging']],
  'an authoritative snapshot must remove missing records without overwriting a newer matching event'
);
const snapshotBaseline = projection.mutationGeneration(canonicalKey);
const concurrentBase = {
  ...base,
  activityKey: '["host-a::native-thread","run-1","turn-1","item-concurrent",0]',
  itemId: 'item-concurrent',
};
projection.applyActivity(canonicalKey, {
  ...concurrentBase,
  streamEpoch: 'epoch-b',
  activityRevision: 1,
  text: 'arrived after the final snapshot response',
});
projection.replaceSnapshot(canonicalKey, {
  streamEpoch: 'epoch-b',
  preserveAfterGeneration: snapshotBaseline,
  activities: [{
    ...secondBase,
    activityRevision: 5,
    text: 'newer event received during paging',
  }],
});
assert.deepStrictEqual(
  projection.activitiesFor(canonicalKey).map((entry) => entry.activityKey),
  [concurrentBase.activityKey, secondBase.activityKey].sort(),
  'a new activity received after snapshot paging began must survive authoritative replacement'
);

projection.clearConversation(canonicalKey);
assert.deepStrictEqual(projection.activitiesFor(canonicalKey), []);

const bounded = createTranscriptActivityProjection({
  maxConversations: 2,
  maxRecordsPerConversation: 2,
  maxRecordBytes: 1024,
  maxTotalBytes: 2048,
});
for (let conversationIndex = 0; conversationIndex < 3; conversationIndex += 1) {
  const conversationKey = `host::conversation-${conversationIndex}`;
  bounded.applyReset(conversationKey, { streamEpoch: 'bounded', activities: [] });
  for (let activityIndex = 0; activityIndex < 3; activityIndex += 1) {
    bounded.applyActivity(conversationKey, {
      streamEpoch: 'bounded',
      activityKey: `${conversationKey}::${activityIndex}`,
      activityRevision: 1,
      turnId: `turn-${activityIndex}`,
      itemId: `item-${activityIndex}`,
      text: 'x'.repeat(4000),
    });
  }
}
const boundedStats = bounded.debugStats();
assert(boundedStats.conversations <= 2, 'browser activity projection must bound conversations');
assert(boundedStats.activities <= 4, 'browser activity projection must bound records per conversation');
assert(boundedStats.totalBytes <= 2048, 'browser activity projection must enforce a global byte budget');
assert.strictEqual(bounded.hasConversation('host::conversation-0'), false, 'old conversations should be evicted');
assert(
  bounded.activitiesFor('host::conversation-2').every((entry) => entry.textTruncated === true),
  'oversized browser activity text should be truncated before retention'
);

const removedConversations = [];
const lifecycle = createTranscriptActivityProjection({
  maxConversations: 2,
  onConversationRemoved: (removedKey, reason) => {
    removedConversations.push([removedKey, reason]);
  },
});
lifecycle.applyReset('host::lifecycle-a', { streamEpoch: 'epoch', activities: [] });
lifecycle.applyReset('host::lifecycle-b', { streamEpoch: 'epoch', activities: [] });
lifecycle.replaceSnapshot('host::lifecycle-b', { streamEpoch: 'epoch', activities: [] });
assert.deepStrictEqual(
  removedConversations,
  [],
  'replacing one canonical conversation must not report a lifecycle eviction'
);
lifecycle.applyReset('host::lifecycle-c', { streamEpoch: 'epoch', activities: [] });
assert.deepStrictEqual(
  removedConversations,
  [['host::lifecycle-a', 'evicted']],
  'the conversation LRU should report the canonical key it evicts'
);
assert.deepStrictEqual(
  lifecycle.conversationKeys().sort(),
  ['host::lifecycle-b', 'host::lifecycle-c'],
  'conversationKeys should expose only retained projection conversations'
);
assert.strictEqual(lifecycle.clearConversation('host::lifecycle-b'), true);
assert.deepStrictEqual(
  removedConversations,
  [
    ['host::lifecycle-a', 'evicted'],
    ['host::lifecycle-b', 'cleared'],
  ],
  'explicit projection cleanup should report a cleared lifecycle reason'
);

console.log('transcript activity projection assertions passed');
