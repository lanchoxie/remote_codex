const assert = require('assert');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { SessionRecordStore } = require('../apps/relay/session-record-store');
const { SessionProvenanceService } = require('../apps/relay/session-provenance-service');

const store = new SessionRecordStore({ rootDir: path.join(os.tmpdir(), 'projection-query-test') });
const nowMs = Date.parse('2026-11-06T00:00:00Z');
store.projection.records = {
  'host-a::first': {
    hostId: 'host-a', source: 'managed', conversationKey: 'first',
    activeRunId: 'run-1', runs: { 'run-1': { status: 'live', apiBinding: { bindingFingerprint: 'original' } } },
    runnerRetirements: {
      due: { retirementId: 'due', runId: 'old-run', status: 'pending', nextAttemptAt: '2026-11-05T00:00:00Z' },
      later: { retirementId: 'later', runId: 'old-run', status: 'pending', nextAttemptAt: '2026-11-07T00:00:00Z' },
      done: { retirementId: 'done', runId: 'old-run', status: 'succeeded' },
    },
    payload: 'x'.repeat(12_000_000),
  },
  'host-b::second': {
    hostId: 'host-b', source: 'managed', nativeThreadId: 'alias-b',
    activeRunId: 'run-2', runs: { 'run-2': { status: 'live' } },
    runnerRetirements: { other: { retirementId: 'other', status: 'pending' } },
    payload: 'y'.repeat(12_000_000),
  },
  'host-a::legacy': { hostId: 'host-a', source: 'rollout', rolloutSessionIds: ['alias-legacy'], payload: 'z'.repeat(12_000_000) },
};
for (let index = 0; index < 2_000; index += 1) {
  store.projection.records[`host-a::history-${index}`] = {
    hostId: 'host-a', source: 'rollout', conversationKey: `history-${index}`,
  };
}
const provenance = new SessionProvenanceService({ store, now: () => new Date(nowMs).toISOString() });
store.readSnapshot = () => { throw new Error('projection queries must not clone the Store'); };

const started = performance.now();
const due = provenance.listRunnerRetirements({ hostId: 'host-a', dueOnly: true, nowMs });
assert.deepStrictEqual(due.map((retirement) => retirement.retirementId), ['due']);
assert.deepStrictEqual(provenance.listRunnerRetirements({ hostId: 'host-a' }).map((retirement) => retirement.retirementId), ['due', 'later']);
assert.deepStrictEqual(provenance.listRunnerRetirements({ hostId: 'host-b' }).map((retirement) => retirement.retirementId), ['other']);
due[0].status = 'succeeded';
assert.strictEqual(store.projection.records['host-a::first'].runnerRetirements.due.status, 'pending');

const active = store.readActiveManagedRunEntries('host-a');
assert.deepStrictEqual(active.map((entry) => entry.canonicalKey), ['host-a::first']);
active[0].record.runs['run-1'].apiBinding.bindingFingerprint = 'mutated';
assert.strictEqual(store.projection.records['host-a::first'].runs['run-1'].apiBinding.bindingFingerprint, 'original');
const legacy = store.readDiscoveryIdentityMatches('host-a', ['alias-legacy']);
assert.deepStrictEqual(legacy.map((entry) => entry.canonicalKey), ['host-a::legacy']);
legacy[0].record.rolloutSessionIds.push('mutated');
assert.deepStrictEqual(store.projection.records['host-a::legacy'].rolloutSessionIds, ['alias-legacy']);
assert.deepStrictEqual(store.readDiscoveryIdentityMatches('host-a', ['alias-b']), []);
assert.deepStrictEqual(store.readDiscoveryIdentityMatches('host-b', ['alias-b']).map((entry) => entry.canonicalKey), ['host-b::second']);
assert.deepStrictEqual(store.readDiscoveryIdentityMatches('host-a', []), []);
for (let index = 0; index < 50; index += 1) {
  assert.deepStrictEqual(store.readDiscoveryIdentityMatches('host-a', [`unknown-cursor-${index}`]), []);
}

const elapsedMs = performance.now() - started;
assert(elapsedMs < 500, `projection queries took ${Math.round(elapsedMs)}ms over 36MB and 2000 unrelated records`);
console.log(`Store projection queries passed (${Math.round(elapsedMs)}ms over 36MB and 2000 unrelated records)`);
