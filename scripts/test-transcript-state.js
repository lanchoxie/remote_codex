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

projection.clearConversation(canonicalKey);
assert.deepStrictEqual(projection.activitiesFor(canonicalKey), []);

console.log('transcript activity projection assertions passed');
