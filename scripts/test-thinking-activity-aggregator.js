const assert = require('assert');
const {
  ThinkingActivityAggregator,
  makeActivityKey,
} = require('../shared/thinking-activity');

async function main() {
  const emitted = [];
  const timers = [];
  const aggregator = new ThinkingActivityAggregator({
    canonicalConversationKey: 'host-a::conversation-a',
    runId: 'run-1',
    flushDelayMs: 75,
    emitSnapshot: async (snapshot) => emitted.push(snapshot),
    setTimer(fn, delay) {
      const timer = { fn, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cancelled = true;
    },
    now: () => '2026-07-16T00:00:00.000Z',
  });
  const item = {
    turnId: 'turn-1',
    itemId: 'reasoning-1',
    summaryIndex: 0,
    kind: 'reasoning',
  };

  assert.strictEqual(
    makeActivityKey({
      canonicalConversationKey: 'host-a::conversation-a',
      runId: 'run-1',
      ...item,
    }),
    '["host-a::conversation-a","run-1","turn-1","reasoning-1",0]'
  );

  aggregator.appendDelta(item, '  First');
  aggregator.appendDelta(item, ' word,');
  aggregator.appendDelta(item, ' then second.  ');
  assert.strictEqual(timers.length, 1, 'rapid deltas should share one timer');
  assert.strictEqual(timers[0].delay, 75, 'the coalescing window should be exactly 75 ms');

  await timers[0].fn();
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].text, '  First word, then second.  ');
  assert.strictEqual(emitted[0].activityRevision, 1);
  assert.strictEqual(emitted[0].final, false);
  assert.strictEqual(emitted[0].timestamp, '2026-07-16T00:00:00.000Z');
  assert.strictEqual(emitted[0].startedAt, '2026-07-16T00:00:00.000Z');

  await aggregator.flush(item);
  assert.strictEqual(emitted.length, 1, 'an unchanged non-final snapshot should be idempotent');

  aggregator.appendDelta(item, 'Next');
  assert.strictEqual(timers.length, 2);
  await aggregator.flush(item, { final: true });
  assert.strictEqual(timers[1].cancelled, true, 'a forced flush should cancel the pending timer');
  assert.strictEqual(emitted.length, 2);
  assert.strictEqual(emitted[1].text, '  First word, then second.  Next');
  assert.strictEqual(emitted[1].final, true);
  assert.strictEqual(emitted[1].activityRevision, 2);
  assert.strictEqual(aggregator.release(item), true);
  assert.strictEqual(aggregator.has(item), false, 'delivered final records should be releasable');

  const replacement = { ...item, itemId: 'reasoning-2', summaryIndex: 1 };
  aggregator.replaceSnapshot(replacement, ' replacement\ntext ');
  await aggregator.flushAll({ final: true });
  const replacementSnapshot = emitted.find((snapshot) => snapshot.itemId === 'reasoning-2');
  assert.strictEqual(replacementSnapshot.text, ' replacement\ntext ');
  assert.strictEqual(replacementSnapshot.activityRevision, 1);
  assert.strictEqual(replacementSnapshot.final, true);

  const metadataItem = {
    ...item,
    itemId: 'command-metadata',
    kind: 'command',
    itemType: 'commandExecution',
    status: 'inProgress',
    command: 'npm test',
  };
  aggregator.replaceSnapshot(metadataItem, 'same text');
  await aggregator.flush(metadataItem);
  aggregator.replaceSnapshot({ ...metadataItem, status: 'completed', exitCode: 0 }, 'same text');
  await aggregator.flush({ ...metadataItem, status: 'completed', exitCode: 0 });
  const metadataSnapshots = emitted.filter((snapshot) => snapshot.itemId === 'command-metadata');
  assert.strictEqual(metadataSnapshots.length, 2, 'metadata-only changes should emit a new activity revision');
  assert.strictEqual(metadataSnapshots[1].status, 'completed');
  assert.strictEqual(metadataSnapshots[1].exitCode, 0);
  assert.strictEqual(metadataSnapshots[1].activityRevision, 2);

  const clock = [
    '2026-07-16T00:01:00.000Z',
    '2026-07-16T00:01:01.000Z',
    '2026-07-16T00:01:05.000Z',
  ];
  const timedSnapshots = [];
  const timed = new ThinkingActivityAggregator({
    canonicalConversationKey: 'host-a::conversation-timed',
    runId: 'run-timed',
    emitSnapshot: async (snapshot) => timedSnapshots.push(snapshot),
    setTimer: () => ({ timed: true }),
    clearTimer: () => {},
    now: () => clock.shift(),
  });
  const timedItem = {
    turnId: 'turn-timed',
    itemId: 'commentary-timed',
    kind: 'commentary',
  };
  timed.appendDelta(timedItem, 'Inspecting');
  await timed.flush(timedItem);
  timed.appendDelta(timedItem, ' state');
  await timed.flush(timedItem, { final: true });
  assert.deepStrictEqual(
    timedSnapshots.map((snapshot) => ({
      startedAt: snapshot.startedAt,
      timestamp: snapshot.timestamp,
    })),
    [{
      startedAt: '2026-07-16T00:01:00.000Z',
      timestamp: '2026-07-16T00:01:01.000Z',
    }, {
      startedAt: '2026-07-16T00:01:00.000Z',
      timestamp: '2026-07-16T00:01:05.000Z',
    }],
    'an activity must retain its first-observed time while later revisions update independently'
  );

  const boundedEmitted = [];
  const evicted = [];
  const bounded = new ThinkingActivityAggregator({
    canonicalConversationKey: 'host-b::conversation-b',
    runId: 'run-bounded',
    emitSnapshot: async (snapshot) => boundedEmitted.push(snapshot),
    maxRecords: 2,
    maxTextBytes: 1024,
    maxTotalTextBytes: 2048,
    setTimer: () => ({ bounded: true }),
    clearTimer: () => {},
    onEvict: (record) => evicted.push(record.activityKey),
  });
  const boundedItems = Array.from({ length: 3 }, (_, index) => ({
    turnId: 'turn-bounded',
    itemId: `item-${index}`,
    summaryIndex: 0,
  }));
  for (const boundedItem of boundedItems) {
    bounded.replaceSnapshot(boundedItem, '推理'.repeat(2000));
  }
  assert.strictEqual(bounded.debugStats().records, 2);
  assert(bounded.debugStats().totalTextBytes <= 2048);
  assert.strictEqual(evicted.length, 1, 'old activity records should be evicted at the hard limit');
  await bounded.flush(boundedItems[2], { final: true });
  assert.strictEqual(boundedEmitted[0].textTruncated, true);
  assert(Buffer.byteLength(boundedEmitted[0].text, 'utf8') <= 1024);

  console.log('thinking activity aggregator assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
