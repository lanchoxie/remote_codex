const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
assert.strictEqual(stream.publish(key, 'session.snapshot', { value: 0 }), null);
assert.strictEqual(stream.has(key), false, 'publishing without subscribers must not retain a stream');
assert.strictEqual(stream.streams.size, 0);

const initial = [];
const unsubscribeInitial = stream.subscribe({
  canonicalKey: key,
  cursor: '',
  send: (event) => initial.push(event),
});
assert.strictEqual(initial[0].eventName, 'stream.reset');
assert.strictEqual(stream.has(key), true);
const keyCursorEpoch = stream.streams.get(key).cursorEpoch;
const first = stream.publish(key, 'session.snapshot', { value: 1 });
const second = stream.publish(key, 'session.transcript', { value: 2 });
assert.strictEqual(first.id, `${keyCursorEpoch}:1`);
assert.strictEqual(second.id, `${keyCursorEpoch}:2`);
assert.deepStrictEqual(
  stream.replay(key, `${keyCursorEpoch}:1`).events.map((entry) => entry.payload.value),
  [2]
);
assert.strictEqual(stream.replay(key, 'other-epoch:1').reset, true);
assert.strictEqual(stream.replay(key, 'other-epoch:1').reason, 'epoch_mismatch');
assert.strictEqual(stream.replay(key, `${keyCursorEpoch}:99`).reset, true);

stream.publish(key, 'session.transcript', { value: 3 });
stream.publish(key, 'session.transcript', { value: 4 });
assert.strictEqual(stream.replay(key, `${keyCursorEpoch}:0`).reset, true, 'expired cursors need reset');
assert.deepStrictEqual(
  stream.replay(key, `${keyCursorEpoch}:2`).events.map((entry) => entry.payload.value),
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
  cursor: `${keyCursorEpoch}:3`,
  send: (event) => subscribed.push(event),
  makeReset: () => ({ assistantProjection: { latestAssistantSeq: 4 } }),
});
assert.deepStrictEqual(subscribed.map((event) => event.streamCounter), [4]);
stream.publish(key, 'session.transcript', { value: 5 });
assert.strictEqual(subscribed.at(-1).payload.value, 5);
unsubscribe();
stream.publish(key, 'session.transcript', { value: 6 });
assert.strictEqual(subscribed.at(-1).payload.value, 5, 'unsubscribe must remove the exact sender');
unsubscribeInitial();
assert.strictEqual(stream.has(key), false, 'the final unsubscribe must release the stream');
assert.strictEqual(stream.streams.size, 0);
assert.strictEqual(stream.publish(key, 'session.transcript', { value: 7 }), null);
assert.throws(
  () => stream.publish('', 'session.transcript', {}),
  /canonical conversation key is required/
);

let failedDeliveryCount = 0;
stream.subscribe({
  canonicalKey: 'host::slow',
  cursor: '',
  send: () => {
    failedDeliveryCount += 1;
    return false;
  },
});
assert.strictEqual(failedDeliveryCount, 1);
assert.strictEqual(stream.has('host::slow'), false, 'a failed initial send must release the stream');
assert.strictEqual(stream.streams.size, 0);

const cleanGenerationEvents = [];
const unsubscribeCleanGeneration = stream.subscribe({
  canonicalKey: 'host::clean-generation',
  cursor: '',
  send: (event) => cleanGenerationEvents.push(event),
});
const cleanGenerationCursor = cleanGenerationEvents[0].id;
const cleanCursorEpoch = stream.streams.get('host::clean-generation').cursorEpoch;
unsubscribeCleanGeneration();
const cleanReconnectEvents = [];
const unsubscribeCleanReconnect = stream.subscribe({
  canonicalKey: 'host::clean-generation',
  cursor: cleanGenerationCursor,
  send: (event) => cleanReconnectEvents.push(event),
});
assert.deepStrictEqual(cleanReconnectEvents, [], 'a clean reconnect should not repeat a reset frame');
assert.strictEqual(stream.streams.get('host::clean-generation').cursorEpoch, cleanCursorEpoch);
unsubscribeCleanReconnect();
assert.deepStrictEqual(
  Object.keys(stream.tombstones.get('host::clean-generation')).sort(),
  ['counter', 'cursorEpoch', 'dirty', 'expiresAt'],
  'cursor tombstones must never retain event payloads'
);

const generationOneEvents = [];
const unsubscribeGenerationOne = stream.subscribe({
  canonicalKey: 'host::generation',
  cursor: '',
  send: (event) => generationOneEvents.push(event),
});
const staleGenerationCursor = generationOneEvents[0].id;
unsubscribeGenerationOne();
assert.strictEqual(stream.publish('host::generation', 'session.snapshot', { value: 'offline' }), null);
const generationTwoEvents = [];
const unsubscribeGenerationTwo = stream.subscribe({
  canonicalKey: 'host::generation',
  cursor: staleGenerationCursor,
  send: (event) => generationTwoEvents.push(event),
});
assert.strictEqual(generationTwoEvents[0].eventName, 'stream.reset');
assert.strictEqual(generationTwoEvents[0].payload.reason, 'epoch_mismatch');
assert.notStrictEqual(generationTwoEvents[0].id, staleGenerationCursor);
unsubscribeGenerationTwo();

let liveDeliveryCount = 0;
stream.subscribe({
  canonicalKey: 'host::backpressured',
  cursor: '',
  send: () => {
    liveDeliveryCount += 1;
    return liveDeliveryCount === 1;
  },
});
assert.strictEqual(stream.has('host::backpressured'), true);
stream.publish('host::backpressured', 'session.snapshot', { value: 1 });
assert.strictEqual(liveDeliveryCount, 2);
assert.strictEqual(stream.has('host::backpressured'), false, 'a failed live send must release the stream');
assert.strictEqual(stream.streams.size, 0);

const replayKeeper = stream.subscribe({
  canonicalKey: 'host::replay',
  cursor: '',
  send: () => true,
});
const replayCursorEpoch = stream.streams.get('host::replay').cursorEpoch;
stream.publish('host::replay', 'session.transcript', { value: 1 });
stream.publish('host::replay', 'session.transcript', { value: 2 });
let replayDeliveryCount = 0;
stream.subscribe({
  canonicalKey: 'host::replay',
  cursor: `${replayCursorEpoch}:0`,
  send: () => {
    replayDeliveryCount += 1;
    return false;
  },
});
assert.strictEqual(replayDeliveryCount, 1, 'replay must stop after the first failed send');
replayKeeper();
assert.strictEqual(stream.has('host::replay'), false);

const aliasEvents = [];
const unsubscribeAlias = stream.subscribe({
  canonicalKey: 'host::alias',
  cursor: '',
  send: (event) => aliasEvents.push(event),
  makeReset: (canonicalKey) => ({ session: { canonicalKey } }),
});
const winnerEvents = [];
const unsubscribeWinner = stream.subscribe({
  canonicalKey: key,
  cursor: '',
  send: (event) => winnerEvents.push(event),
});
stream.mergeCanonicalKey('host::alias', key);
assert.strictEqual(aliasEvents.at(-1).eventName, 'stream.reset');
assert.strictEqual(aliasEvents.at(-1).payload.reason, 'canonical_key_changed');
assert.strictEqual(aliasEvents.at(-1).payload.canonicalConversationKey, key);
assert.strictEqual(winnerEvents.at(-1).eventName, 'stream.reset');
assert.strictEqual(winnerEvents.at(-1).payload.reason, 'canonical_key_changed');
unsubscribeAlias();
unsubscribeWinner();
assert.strictEqual(stream.streams.size, 0);

let aliasSendCount = 0;
stream.subscribe({
  canonicalKey: 'host::failed-alias',
  cursor: '',
  send: () => {
    aliasSendCount += 1;
    return aliasSendCount === 1;
  },
});
stream.mergeCanonicalKey('host::failed-alias', 'host::empty-winner');
assert.strictEqual(aliasSendCount, 2);
assert.strictEqual(stream.has('host::empty-winner'), false, 'failed merge reset must not leave an empty winner');
assert.strictEqual(stream.streams.size, 0);

let firstMergeSendCount = 0;
const unsubscribeFirstMerge = stream.subscribe({
  canonicalKey: 'host::multi-alias',
  cursor: '',
  send: () => {
    firstMergeSendCount += 1;
    return firstMergeSendCount === 1;
  },
});
const secondMergeEvents = [];
const unsubscribeSecondMerge = stream.subscribe({
  canonicalKey: 'host::multi-alias',
  cursor: '',
  send: (event) => secondMergeEvents.push(event),
});
stream.mergeCanonicalKey('host::multi-alias', 'host::multi-winner');
assert.strictEqual(stream.has('host::multi-winner'), true);
stream.publish('host::multi-winner', 'session.transcript', { value: 'after-merge' });
assert.strictEqual(secondMergeEvents.at(-1).payload.value, 'after-merge');
assert.strictEqual(unsubscribeFirstMerge(), false);
unsubscribeSecondMerge();
assert.strictEqual(stream.has('host::multi-winner'), false);

assert.throws(() => stream.subscribe({
  canonicalKey: 'host::throwing-reset',
  cursor: '',
  send: () => true,
  makeReset: () => {
    throw new Error('reset projection failed');
  },
}), /reset projection failed/);
assert.strictEqual(stream.has('host::throwing-reset'), false);

let throwingMergeResetCount = 0;
stream.subscribe({
  canonicalKey: 'host::throwing-merge',
  cursor: '',
  send: () => true,
  makeReset: () => {
    throwingMergeResetCount += 1;
    if (throwingMergeResetCount > 1) throw new Error('merge reset projection failed');
    return {};
  },
});
const survivingMergeEvents = [];
const unsubscribeSurvivingMerge = stream.subscribe({
  canonicalKey: 'host::throwing-merge',
  cursor: '',
  send: (event) => survivingMergeEvents.push(event),
});
assert.throws(
  () => stream.mergeCanonicalKey('host::throwing-merge', 'host::throwing-winner'),
  /merge reset projection failed/
);
assert.strictEqual(stream.has('host::throwing-winner'), true);
stream.publish('host::throwing-winner', 'session.snapshot', { value: 'survived' });
assert.strictEqual(survivingMergeEvents.at(-1).payload.value, 'survived');
unsubscribeSurvivingMerge();
assert.strictEqual(stream.has('host::throwing-winner'), false);

const dormantWinnerEvents = [];
const unsubscribeDormantWinner = stream.subscribe({
  canonicalKey: 'host::dormant-winner',
  cursor: '',
  send: (event) => dormantWinnerEvents.push(event),
});
const dormantWinnerCursor = dormantWinnerEvents[0].id;
unsubscribeDormantWinner();
stream.mergeCanonicalKey('host::absent-loser', 'host::dormant-winner');
const dormantReconnectEvents = [];
const unsubscribeDormantReconnect = stream.subscribe({
  canonicalKey: 'host::dormant-winner',
  cursor: dormantWinnerCursor,
  send: (event) => dormantReconnectEvents.push(event),
});
assert.strictEqual(dormantReconnectEvents[0].eventName, 'stream.reset');
assert.strictEqual(dormantReconnectEvents[0].payload.reason, 'epoch_mismatch');
unsubscribeDormantReconnect();

const bounded = new SessionEventStream({
  epoch: 'bounded',
  tombstoneLimit: 2,
  tombstoneTtlMs: 60_000,
});
for (const boundedKey of ['one', 'two', 'three']) {
  const unsubscribeBounded = bounded.subscribe({
    canonicalKey: boundedKey,
    cursor: '',
    send: () => true,
  });
  unsubscribeBounded();
}
assert.strictEqual(bounded.streams.size, 0);
assert.strictEqual(bounded.tombstones.size, 2, 'cursor tombstones must have a global count bound');

const byteBounded = new SessionEventStream({
  epoch: 'byte-bounded',
  ringSize: 512,
  maxStreamBytes: 1024,
  maxTotalBytes: 1536,
});
const unsubscribeByteA = byteBounded.subscribe({
  canonicalKey: 'byte::a',
  cursor: '',
  send: () => true,
});
const unsubscribeByteB = byteBounded.subscribe({
  canonicalKey: 'byte::b',
  cursor: '',
  send: () => true,
});
byteBounded.publish('byte::a', 'session.activity', { text: 'a'.repeat(700) });
byteBounded.publish('byte::b', 'session.activity', { text: 'b'.repeat(700) });
assert(byteBounded.streams.get('byte::a').ringBytes <= byteBounded.maxStreamBytes);
assert(byteBounded.streams.get('byte::b').ringBytes <= byteBounded.maxStreamBytes);
assert(byteBounded.totalRingBytes <= byteBounded.maxTotalBytes, 'all active rings need a global byte budget');
unsubscribeByteA();
unsubscribeByteB();
assert.strictEqual(byteBounded.totalRingBytes, 0, 'unsubscribing must release retained ring bytes');

const server = fs.readFileSync(path.join(__dirname, '../apps/relay/server.js'), 'utf8');
const publishStart = server.indexOf('function publishCanonicalSessionEvent(');
const publishEnd = server.indexOf('\nfunction broadcastSessionEvent', publishStart);
const publishSource = server.slice(publishStart, publishEnd);
assert(publishStart >= 0 && publishEnd > publishStart);
assert(
  publishSource.indexOf('state.sessionEventStream.has(canonicalKey)')
    < publishSource.indexOf('sessionWithAssistantProjection(payload)'),
  'session projection must not be cloned when the canonical stream has no subscriber'
);
assert(
  publishSource.indexOf('state.sessionEventStream.markTombstoneDirty(canonicalKey)')
    < publishSource.indexOf('sessionWithAssistantProjection(payload)'),
  'offline production events must dirty a cursor tombstone before skipping projection work'
);
const resetPayloadStart = server.indexOf('function boundedSessionResetPayload(');
const resetPayloadEnd = server.indexOf('\nfunction boundedSessionActivityPayload', resetPayloadStart);
const resetPayloadSource = server.slice(resetPayloadStart, resetPayloadEnd);
assert(resetPayloadStart >= 0 && resetPayloadEnd > resetPayloadStart);
assert.strictEqual(
  (resetPayloadSource.match(
    /payload\.activitiesTruncated === true \|\| activities\.length > 0/g
  ) || []).length,
  3,
  'all bounded reset fallbacks must preserve an authoritative activity recovery marker'
);

console.log('session event stream assertions passed');
