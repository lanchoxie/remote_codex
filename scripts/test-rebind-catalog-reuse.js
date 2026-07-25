const assert = require('assert');

const { RebindCatalogReuseStore } = require('../apps/relay/rebind-catalog-reuse');

let now = 1_000;
let sequence = 0;
const store = new RebindCatalogReuseStore({
  ttlMs: 100,
  maxEntries: 8,
  now: () => now,
  makeToken: () => `opaque-${++sequence}`,
});

const catalog = { models: [{ id: 'model-a' }] };
const scope = {
  hostId: 'host-a',
  sourceSessionId: 'session-a',
  targetSessionId: 'session-a',
  currentRunId: 'run-a',
  currentRunStatus: 'live',
  currentBindingFingerprint: 'binding-a',
  targetBindingFingerprint: 'binding-b',
  targetProfileId: 'profile-b',
  targetProviderKind: 'custom',
  targetApiConfigFingerprint: 'config-b',
  selectionFingerprint: '{"model":"model-a","effort":"high"}',
};

assert.strictEqual(store.issue({ ...scope, catalog: null }), null);
assert.strictEqual(store.consume('missing-token', scope), null);

for (const [field, replacement] of [
  ['hostId', 'host-b'],
  ['sourceSessionId', 'session-b'],
  ['targetSessionId', 'session-b'],
  ['currentRunId', 'run-b'],
  ['currentRunStatus', 'stopped'],
  ['currentBindingFingerprint', 'binding-other'],
  ['targetBindingFingerprint', 'binding-other'],
  ['targetProfileId', 'profile-other'],
  ['targetProviderKind', 'openai'],
  ['targetApiConfigFingerprint', 'config-other'],
  ['selectionFingerprint', '{"model":"model-b"}'],
]) {
  const token = store.issue({ ...scope, catalog });
  assert.strictEqual(
    store.consume(token, { ...scope, [field]: replacement }),
    null,
    `${field} must fence catalog reuse`
  );
  assert.strictEqual(
    store.consume(token, scope),
    catalog,
    `a mismatched ${field} attempt must leave the proof available to its owner`
  );
  assert.strictEqual(store.consume(token, scope), null, 'a proof must be one-shot');
}

const expiredToken = store.issue({ ...scope, catalog });
now += 100;
assert.strictEqual(store.consume(expiredToken, scope), null, 'an expired proof must not be reused');

let capacitySequence = 0;
const capacityStore = new RebindCatalogReuseStore({
  ttlMs: 1_000,
  maxEntries: 2,
  now: () => 5_000,
  makeToken: () => `capacity-${++capacitySequence}`,
});
const oldest = capacityStore.issue({ ...scope, catalog: { id: 'oldest' } });
const middle = capacityStore.issue({ ...scope, catalog: { id: 'middle' } });
const newest = capacityStore.issue({ ...scope, catalog: { id: 'newest' } });
assert.strictEqual(capacityStore.consume(oldest, scope), null, 'capacity pruning must evict the oldest proof');
assert.strictEqual(capacityStore.consume(middle, scope)?.id, 'middle');
assert.strictEqual(capacityStore.consume(newest, scope)?.id, 'newest');

console.log('Rebind catalog reuse tests passed');
