const assert = require('assert');
const {
  payloadBytes,
  planSessionDiscoveryPayloads,
} = require('../shared/session-discovery-payload');

const sessions = Array.from({ length: 4 }, (_, index) => ({
  sessionId: `session-${index}`,
  title: `Session ${index}`,
  source: index === 0 ? 'managed' : 'rollout',
  live: index === 0,
  runId: index === 0 ? 'live-run' : null,
  transcriptPreview: [{ speaker: 'agent', text: 'x'.repeat(800) }],
}));
const options = { hostId: 'test-host', discoveryId: 'test-discovery', sessions, maxBytes: 2500 };
const payloads = planSessionDiscoveryPayloads(options);
assert(payloads.length > 2, 'large previews should be separated into multiple payloads');
assert.strictEqual(payloads[0].event.type, 'session.discovery');
assert.deepStrictEqual(payloads[0].event.sessions.map((session) => session.sessionId), sessions.map((session) => session.sessionId));
assert.strictEqual(payloads[0].event.sessions[0].live, true);
assert.strictEqual(payloads[0].event.sessions[0].runId, 'live-run');
assert(payloads[0].event.sessions.every((session) => session.transcriptPreview.length === 0));
assert(payloads.slice(1).every(({ event }) => event.type === 'session.discovery.preview'));
assert.deepStrictEqual(
  payloads.slice(1).flatMap(({ event }) => event.sessions.map((session) => session.sessionId)),
  sessions.map((session) => session.sessionId)
);
for (const { batchId, event } of payloads) {
  assert(payloadBytes(batchId, event) <= options.maxBytes);
}
assert.deepStrictEqual(planSessionDiscoveryPayloads({ ...options, maxBytes: 10000 })[0].event.sessions, sessions);
assert.throws(
  () => planSessionDiscoveryPayloads({ ...options, maxBytes: 1024, sessions: [{ ...sessions[0], transcriptPreview: [{ text: 'x'.repeat(4000) }] }] }),
  (error) => error.code === 'discovery_preview_too_large'
);
assert.throws(
  () => planSessionDiscoveryPayloads({ ...options, maxBytes: 1024, sessions: [{ ...sessions[0], title: 'x'.repeat(4000), transcriptPreview: [] }] }),
  (error) => error.code === 'discovery_metadata_too_large'
);
assert.strictEqual(planSessionDiscoveryPayloads({ ...options, maxBytes: NaN }).length, 1);

const dmScaleSessions = Array.from({ length: 167 }, (_, index) => ({
  sessionId: `dm-scale-${index}`,
  title: `DM scale ${index}`,
  source: index === 0 ? 'managed' : 'rollout',
  live: index === 0,
  runId: index === 0 ? 'dm-scale-live-run' : null,
  transcriptPreview: [{ speaker: 'agent', text: 'p'.repeat(40 * 1024) }],
  assistantCursor: { observations: [{ text: 'c'.repeat(8 * 1024) }] },
}));
const dmScalePayloads = planSessionDiscoveryPayloads({
  hostId: 'dm-scale-dev-8897',
  discoveryId: 'dm-scale-test',
  sessions: dmScaleSessions,
});
assert(dmScalePayloads.length > 1, 'dm-scale discovery must split below the Relay limit');
assert.deepStrictEqual(
  dmScalePayloads[0].event.sessions.map((session) => session.sessionId),
  dmScaleSessions.map((session) => session.sessionId),
  'the authoritative metadata payload must retain every Session'
);
assert.strictEqual(dmScalePayloads[0].event.sessions[0].runId, 'dm-scale-live-run');
assert.deepStrictEqual(
  dmScalePayloads.slice(1).flatMap(({ event }) => event.sessions.map((session) => session.sessionId)),
  dmScaleSessions.map((session) => session.sessionId),
  'all previews and assistant cursors must follow the metadata payload'
);
assert(dmScalePayloads.every(({ batchId, event }) => payloadBytes(batchId, event) <= 6 * 1024 * 1024));
console.log('session discovery payload assertions passed');
