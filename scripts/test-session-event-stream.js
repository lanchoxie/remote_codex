const assert = require('assert');

const {
  SessionEventStream,
  parseCursor,
} = require('../apps/relay/session-event-stream');

assert.deepStrictEqual(parseCursor('epoch:with:colon:12'), {
  epoch: 'epoch:with:colon',
  counter: 12,
});
assert.strictEqual(parseCursor('epoch:not-a-number'), null);
assert.strictEqual(parseCursor('epoch:-1'), null);

const stream = new SessionEventStream({ epoch: 'epoch-a', ringSize: 3 });
const key = 'host::native';
const first = stream.publish(key, 'session.snapshot', { value: 1 });
const second = stream.publish(key, 'session.transcript', { value: 2 });
assert.strictEqual(first.id, 'epoch-a:1');
assert.strictEqual(second.id, 'epoch-a:2');
assert.deepStrictEqual(
  stream.replay(key, 'epoch-a:1').events.map((entry) => entry.payload.value),
  [2]
);
assert.strictEqual(stream.replay(key, 'other-epoch:1').reset, true);
assert.strictEqual(stream.replay(key, 'other-epoch:1').reason, 'epoch_mismatch');
assert.strictEqual(stream.replay(key, 'epoch-a:99').reset, true);

stream.publish(key, 'session.transcript', { value: 3 });
stream.publish(key, 'session.transcript', { value: 4 });
assert.strictEqual(stream.replay(key, 'epoch-a:0').reset, true, 'expired cursors need reset');
assert.deepStrictEqual(
  stream.replay(key, 'epoch-a:2').events.map((entry) => entry.payload.value),
  [3, 4]
);
assert.strictEqual(stream.replay('host::bridge-alias', 'epoch-a:2').reset, true);

const envelope = stream.resetEnvelope(key, {
  assistant: { latestAssistantSeq: 7 },
  activities: [{ activityKey: 'activity-1' }],
});
assert.strictEqual(envelope.streamEpoch, 'epoch-a');
assert.strictEqual(envelope.canonicalConversationKey, key);
assert.strictEqual(envelope.streamCounter, 4);
assert.strictEqual(envelope.assistant.latestAssistantSeq, 7);
envelope.activities[0].activityKey = 'mutated';
assert.strictEqual(
  stream.resetEnvelope(key, { activities: [{ activityKey: 'activity-1' }] }).activities[0].activityKey,
  'activity-1'
);

const subscribed = [];
const unsubscribe = stream.subscribe({
  canonicalKey: key,
  cursor: 'epoch-a:3',
  send: (event) => subscribed.push(event),
  makeReset: () => ({ assistantProjection: { latestAssistantSeq: 4 } }),
});
assert.deepStrictEqual(subscribed.map((event) => event.streamCounter), [4]);
stream.publish(key, 'session.transcript', { value: 5 });
assert.strictEqual(subscribed.at(-1).payload.value, 5);
unsubscribe();
stream.publish(key, 'session.transcript', { value: 6 });
assert.strictEqual(subscribed.at(-1).payload.value, 5, 'unsubscribe must remove the exact sender');

const aliasEvents = [];
stream.subscribe({
  canonicalKey: 'host::alias',
  cursor: '',
  send: (event) => aliasEvents.push(event),
  makeReset: (canonicalKey) => ({ session: { canonicalKey } }),
});
stream.mergeCanonicalKey('host::alias', key);
assert.strictEqual(aliasEvents.at(-1).eventName, 'stream.reset');
assert.strictEqual(aliasEvents.at(-1).payload.reason, 'canonical_key_changed');
assert.strictEqual(aliasEvents.at(-1).payload.canonicalConversationKey, key);

console.log('session event stream assertions passed');
