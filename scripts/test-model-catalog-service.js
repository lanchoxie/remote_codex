const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionRecordStore } = require('../apps/relay/session-record-store');
const {
  ModelCatalogError,
  ModelCatalogService,
  catalogKey,
  mergeCatalogSources,
} = require('../apps/relay/model-catalog-service');

function source(overrides) {
  return {
    source: 'provider',
    authority: 'authoritative',
    complete: true,
    truncated: false,
    nextCursor: null,
    stale: false,
    error: null,
    models: [],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function main() {
  const merged = mergeCatalogSources([
    source({
      source: 'live',
      models: [{
        id: 'gpt-5.6-sol',
        displayName: 'GPT 5.6 Sol',
        visible: true,
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      }],
    }),
    source({
      source: 'provider',
      models: [{ id: 'gpt-5.6-sol' }, { id: 'provider-only' }],
    }),
    source({
      source: 'override',
      authority: 'capability-only',
      complete: false,
      models: [{ id: 'provider-only', reasoningLevels: ['low'] }],
    }),
  ]);

  const sol = merged.lookup('gpt-5.6-sol');
  assert.deepStrictEqual(sol.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.strictEqual(sol.cliSupported, true);
  assert.strictEqual(sol.providerAdvertised, true);
  assert.strictEqual(sol.availability, 'available');
  assert.strictEqual(sol.isDefault, true);

  const providerOnly = merged.lookup('provider-only');
  assert.strictEqual(providerOnly.providerAdvertised, true);
  assert.strictEqual(providerOnly.cliSupported, false, 'complete live list proves CLI absence');
  assert.deepStrictEqual(providerOnly.reasoningLevels, ['low']);
  assert.strictEqual(providerOnly.selectable, false);

  const missing = merged.lookup('missing');
  assert.strictEqual(missing.providerAdvertised, false);
  assert.strictEqual(missing.availability, 'unavailable');
  assert.strictEqual(missing.cliSupported, false);
  assert.throws(
    () => merged.validate({ model: 'missing', effort: 'low' }),
    (error) => error instanceof ModelCatalogError && error.code === 'session_model_unavailable'
  );
  assert.throws(
    () => merged.validate({ model: 'gpt-5.6-sol', effort: 'impossible' }),
    (error) => error.code === 'session_effort_unsupported'
  );

  const incomplete = mergeCatalogSources([source({
    complete: false,
    truncated: true,
    nextCursor: 'page-2',
    models: [{ id: 'known' }],
  })]);
  assert.strictEqual(incomplete.lookup('missing').availability, 'unknown');
  assert.strictEqual(incomplete.lookup('missing').cliSupported, 'unknown');
  assert.deepStrictEqual(incomplete.controlsFor('missing'), {
    allowAuto: true,
    capabilityKnown: false,
    reasoningLevels: [],
  });
  assert.throws(
    () => incomplete.validate({ model: 'missing', effort: 'high' }),
    (error) => error.code === 'session_effort_unsupported' && error.capabilityUnknown === true
  );
  assert.doesNotThrow(() => incomplete.validate({ model: 'missing', effort: '' }));

  const stale = mergeCatalogSources([source({
    source: 'last-known-good',
    authority: 'advisory',
    stale: true,
    complete: true,
    models: [{ id: 'old-model', reasoningLevels: ['high'] }],
  })]);
  assert.strictEqual(stale.lookup('old-model').availability, 'unknown');
  assert.strictEqual(stale.lookup('old-model').previouslyAdvertised, true);
  assert.strictEqual(stale.lookup('missing').availability, 'unknown');

  assert.notStrictEqual(
    catalogKey({ hostId: 'host-a', bindingFingerprint: 'binding-a', runId: 'run-a' }),
    catalogKey({ hostId: 'host-a', bindingFingerprint: 'binding-b', runId: 'run-a' })
  );
  assert.notStrictEqual(
    catalogKey({ hostId: 'host-a', bindingFingerprint: 'binding-a', runId: 'run-a' }),
    catalogKey({ hostId: 'host-a', bindingFingerprint: 'binding-a', runId: 'run-b' })
  );

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-model-catalog-'));
  const store = await SessionRecordStore.open({ rootDir, snapshotEvery: 2 });
  await store.transact('test.seed', (tx) => {
    const key = tx.resolveCanonicalKey({ hostId: 'host-a', sessionId: 'session-a' });
    tx.ensureRecord(key, { hostId: 'host-a', conversationKey: 'session-a' });
    tx.markDirty(key);
  });

  let providerCalls = 0;
  let releaseProvider;
  const providerBarrier = new Promise((resolve) => { releaseProvider = resolve; });
  const service = new ModelCatalogService({
    store,
    staleMs: 60_000,
    now: () => '2026-07-16T00:00:00.000Z',
    fetchProviderPage: async ({ bindingFingerprint }) => {
      providerCalls += 1;
      await providerBarrier;
      return source({
        source: 'provider',
        fetchedAt: '2026-07-16T00:00:00.000Z',
        models: [{ id: `model-${bindingFingerprint}` }],
      });
    },
  });
  const request = {
    identity: { hostId: 'host-a', sessionId: 'session-a' },
    hostId: 'host-a',
    bindingFingerprint: 'binding-a',
    runId: 'run-a',
  };
  const firstRequest = service.get(request);
  const duplicateRequest = service.get(request);
  assert.strictEqual(firstRequest, duplicateRequest, 'same binding/run must share one in-flight Promise');
  releaseProvider();
  const [firstCatalog, duplicateCatalog] = await Promise.all([firstRequest, duplicateRequest]);
  assert.strictEqual(providerCalls, 1);
  assert.strictEqual(firstCatalog.lookup('model-binding-a').availability, 'available');
  assert.strictEqual(duplicateCatalog.lookup('model-binding-a').availability, 'available');

  let capabilityProviderCalls = 0;
  const capabilityRequest = {
    identity: { hostId: 'host-a', sessionId: 'session-capability' },
    hostId: 'host-a',
    sessionId: 'session-capability',
    bindingFingerprint: 'binding-capability',
    runId: 'run-capability',
  };
  await store.transact('test.seed.capability', (tx) => {
    const key = tx.resolveCanonicalKey(capabilityRequest.identity);
    tx.ensureRecord(key, { hostId: 'host-a', conversationKey: 'session-capability' });
    tx.markDirty(key);
  });
  const uncredentialedStarted = deferred();
  const releaseUncredentialed = deferred();
  const releaseCredentialed = deferred();
  const capabilityService = new ModelCatalogService({
    store,
    staleMs: 60_000,
    now: () => '2026-07-16T00:00:00.500Z',
    fetchProviderPage: async ({ apiConfig }) => {
      capabilityProviderCalls += 1;
      if (!apiConfig) {
        uncredentialedStarted.resolve();
        await releaseUncredentialed.promise;
        throw new Error('provider refresh requires credentials');
      }
      await releaseCredentialed.promise;
      return source({
        source: 'provider',
        fetchedAt: '2026-07-16T00:00:00.500Z',
        models: [{ id: 'credentialed-provider-model' }],
      });
    },
  });
  const uncredentialedRequest = capabilityService.get({ ...capabilityRequest, force: true });
  await uncredentialedStarted.promise;
  const credentialedInput = {
    ...capabilityRequest,
    force: true,
    apiConfig: {
      profileId: 'profile-a',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'test-only-key',
    },
  };
  const credentialedRequest = capabilityService.get(credentialedInput);
  const duplicateCredentialedRequest = capabilityService.get(credentialedInput);
  releaseUncredentialed.resolve();
  releaseCredentialed.resolve();
  const [, credentialedCatalog, duplicateCredentialedCatalog] = await Promise.all([
    uncredentialedRequest,
    credentialedRequest,
    duplicateCredentialedRequest,
  ]);
  assert.notStrictEqual(
    credentialedRequest,
    uncredentialedRequest,
    'a credentialed provider refresh must not reuse an uncredentialed in-flight request'
  );
  assert.strictEqual(
    duplicateCredentialedRequest,
    credentialedRequest,
    'equivalent credentialed refreshes must still share one in-flight Promise'
  );
  assert.strictEqual(capabilityProviderCalls, 2);
  assert.strictEqual(credentialedCatalog.lookup('credentialed-provider-model').availability, 'available');
  assert.strictEqual(
    duplicateCredentialedCatalog.lookup('credentialed-provider-model').availability,
    'available'
  );

  const cachedService = new ModelCatalogService({
    store,
    staleMs: 60_000,
    now: () => '2026-07-16T00:00:01.000Z',
    fetchProviderPage: async () => { throw new Error('fresh cache should avoid provider fetch'); },
  });
  const cached = await cachedService.get(request);
  assert.strictEqual(cached.lookup('model-binding-a').availability, 'available');
  assert.strictEqual(cached.cacheState, 'fresh');

  const partialRequest = {
    identity: { hostId: 'host-a', sessionId: 'session-partial' },
    hostId: 'host-a',
    sessionId: 'session-partial',
    bindingFingerprint: 'binding-partial',
    runId: 'run-partial',
  };
  await store.transact('test.seed.partial', (tx) => {
    const key = tx.resolveCanonicalKey(partialRequest.identity);
    tx.ensureRecord(key, { hostId: 'host-a', conversationKey: 'session-partial' });
    tx.markDirty(key);
  });
  const initialPartialService = new ModelCatalogService({
    store,
    staleMs: 0,
    now: () => '2026-07-16T00:01:00.000Z',
    fetchLivePage: async () => source({
      source: 'live',
      fetchedAt: '2026-07-16T00:01:00.000Z',
      models: [{ id: 'live-last-known-good', reasoningLevels: ['high'] }],
    }),
    fetchProviderPage: async () => source({
      source: 'provider',
      fetchedAt: '2026-07-16T00:01:00.000Z',
      models: [{ id: 'provider-last-known-good' }],
    }),
  });
  await initialPartialService.get({ ...partialRequest, force: true });

  const partialRefreshService = new ModelCatalogService({
    store,
    staleMs: 0,
    now: () => '2026-07-16T00:02:00.000Z',
    fetchLivePage: async () => source({
      source: 'live',
      complete: false,
      truncated: true,
      nextCursor: 'page-2',
      fetchedAt: '2026-07-16T00:02:00.000Z',
      models: [{ id: 'live-partial' }],
    }),
    fetchProviderPage: async () => { throw new Error('provider refresh failed'); },
  });
  const partialRefresh = await partialRefreshService.get({ ...partialRequest, force: true });
  assert.strictEqual(
    partialRefresh.lookup('live-last-known-good').previouslyAdvertised,
    true,
    'an incomplete live refresh must retain the previous complete live catalog as last-known-good'
  );
  assert.strictEqual(
    partialRefresh.lookup('provider-last-known-good').previouslyAdvertised,
    true,
    'a failed provider refresh must retain the corresponding provider last-known-good catalog'
  );
  assert.strictEqual(partialRefresh.lookup('provider-last-known-good').availability, 'unknown');
  assert.strictEqual(partialRefresh.lookup('provider-last-known-good').selectable, true);

  const persistedPartialService = new ModelCatalogService({
    store,
    staleMs: 60_000,
    now: () => '2026-07-16T00:02:01.000Z',
    fetchLivePage: async () => { throw new Error('fresh partial cache should avoid live fetch'); },
    fetchProviderPage: async () => { throw new Error('fresh partial cache should avoid provider fetch'); },
  });
  const persistedPartial = await persistedPartialService.get(partialRequest);
  assert.strictEqual(
    persistedPartial.lookup('live-last-known-good').previouslyAdvertised,
    true,
    'live last-known-good evidence must survive persistence after an incomplete refresh'
  );
  assert.strictEqual(
    persistedPartial.lookup('provider-last-known-good').previouslyAdvertised,
    true,
    'provider last-known-good evidence must survive persistence after another source succeeds'
  );
  const fallbackOrigins = persistedPartial.sources
    .filter((entry) => entry.source === 'last-known-good')
    .map((entry) => entry.originSource)
    .sort();
  assert.deepStrictEqual(fallbackOrigins, ['live', 'provider']);

  await store.close();
  console.log('model catalog service tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
