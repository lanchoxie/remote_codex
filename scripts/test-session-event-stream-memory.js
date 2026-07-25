const assert = require('assert');

const { SessionEventStream } = require('../apps/relay/session-event-stream');

const sessionCount = 878;
const discoveryRounds = 1000;
const maxHeapGrowthBytes = 8 * 1024 * 1024;
const stream = new SessionEventStream({ epoch: 'memory-soak', ringSize: 512 });
const canonicalKeys = Array.from(
  { length: sessionCount },
  (_, index) => `history-host::session-${index}`
);
const payload = {
  state: 'imported',
  live: false,
  assistantProjection: {
    latestAssistantSeq: 20,
    previewText: 'x'.repeat(2048),
  },
};

global.gc?.();
const heapBefore = process.memoryUsage().heapUsed;
for (let round = 0; round < discoveryRounds; round += 1) {
  for (const canonicalKey of canonicalKeys) {
    assert.strictEqual(stream.publish(canonicalKey, 'session.snapshot', payload), null);
  }
}
global.gc?.();
const heapAfter = process.memoryUsage().heapUsed;
const heapDelta = heapAfter - heapBefore;

assert.strictEqual(stream.streams.size, 0, 'history discovery must not create event rings');
assert.strictEqual(stream.tombstones.size, 0, 'never-subscribed history must not create cursor tombstones');
assert.strictEqual(stream.totalRingBytes, 0, 'history discovery must not retain event payload bytes');
assert(
  heapDelta <= maxHeapGrowthBytes,
  `history discovery retained ${Math.round(heapDelta / 1024)} KiB; limit is ${maxHeapGrowthBytes / 1024} KiB`
);

console.log(
  `session event memory soak passed: ${sessionCount * discoveryRounds} publishes, `
  + `${Math.round(heapDelta / 1024)} KiB heap delta`
);
