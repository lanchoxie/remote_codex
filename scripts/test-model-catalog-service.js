const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { SessionRecordStore } = require('../apps/relay/session-record-store');
const {
  ModelCatalogError,
  ModelCatalogService,
  catalogKey,
  mergeCatalogSources,
  normalizeCatalogError,
  normalizeModel,
  providerModelsMayBypassLiveCatalog,
} = require('../apps/relay/model-catalog-service');
const {
  buildProviderModelsUrl,
  shouldDiagnoseProviderV1,
  suggestedProviderV1BaseUrl,
  testApiProfile,
} = require('../apps/host-agent/session-api-runtime');
const {
  OFFICIAL_OPENAI_BASE_URL,
  buildApiEnvironment,
  normalizeApiConfig,
} = require('../apps/host-agent/runtime-utils');

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

async function testApiBaseUrlDiagnostics() {
  assert.strictEqual(
    normalizeApiConfig({ provider: 'OpenAI', providerKind: 'openai', apiKey: 'key' }).baseUrl,
    OFFICIAL_OPENAI_BASE_URL,
    'an omitted official OpenAI Base URL must resolve consistently before binding and launch'
  );
  assert.strictEqual(
    buildApiEnvironment({ providerKind: 'openai', apiKey: 'key' }).OPENAI_BASE_URL,
    OFFICIAL_OPENAI_BASE_URL,
    'the resolved official Base URL must be explicit in the child process environment'
  );
  assert.strictEqual(
    normalizeApiConfig({
      providerKind: 'gemini',
      baseUrl: 'https://gemini.example/v1',
      apiKey: 'key',
    }).provider,
    'Gemini',
    'an omitted provider label must use the inferred provider canonical label'
  );
  for (const providerKind of ['anthropic', 'gemini', 'custom']) {
    assert.throws(
      () => normalizeApiConfig({ providerKind, apiKey: 'key' }),
      (error) => error?.code === 'api_base_url_required',
      `${providerKind} key-only profiles must not fall through to api.openai.com`
    );
  }
  assert.throws(
    () => normalizeApiConfig({ providerKind: 'custom', baseUrl: 'file:///tmp/provider', apiKey: 'key' }),
    (error) => error?.code === 'api_base_url_invalid' && error?.statusCode === 422,
    'invalid provider URLs must fail before probing or process launch'
  );

  assert.strictEqual(
    suggestedProviderV1BaseUrl('http://provider.example'),
    'http://provider.example/v1'
  );
  assert.strictEqual(suggestedProviderV1BaseUrl('http://provider.example/api'), null);
  assert.strictEqual(
    shouldDiagnoseProviderV1('http://provider.example', 404, { catalogValid: false }),
    true
  );
  for (const statusCode of [0, 400, 401, 403, 429, 500, 502]) {
    assert.strictEqual(
      shouldDiagnoseProviderV1('http://provider.example', statusCode, { catalogValid: false }),
      false,
      `HTTP ${statusCode} must not trigger a /v1 diagnostic request`
    );
  }

  const requests = [];
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const testCase = requestUrl.searchParams.get('case') || 'exact';
    requests.push({ testCase, pathname: requestUrl.pathname });
    res.setHeader('Content-Type', 'application/json');

    if (requestUrl.pathname === '/v1/models') {
      if (testCase === 'fallback-invalid') {
        res.end('{"message":"still not a catalog"}');
        return;
      }
      res.end('{"data":[{"id":"minemine-model"}]}');
      return;
    }
    if (requestUrl.pathname === '/api/models') {
      res.end('{"message":"nested invalid catalog"}');
      return;
    }
    if (testCase === 'exact') {
      res.end('{"data":[{"id":"exact-model"}]}');
      return;
    }
    if (testCase === 'html' || testCase === 'fallback-invalid') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>provider console</title>');
      return;
    }
    if (testCase === 'oversized') {
      res.end('x'.repeat(2048));
      return;
    }
    const statusByCase = {
      missing: 404,
      unauthorized: 401,
      forbidden: 403,
      limited: 429,
      server: 500,
    };
    res.statusCode = statusByCase[testCase] || 400;
    res.end(JSON.stringify({ error: { message: testCase } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;
    const profile = (testCase, basePath = '') => ({
      profileId: `profile-${testCase}`,
      provider: 'MineMine',
      providerKind: 'custom',
      baseUrl: `http://127.0.0.1:${port}${basePath}?case=${testCase}`,
      apiKey: 'test-key',
    });

    const exact = await testApiProfile(profile('exact'));
    assert.strictEqual(exact.ok, true);
    assert.deepStrictEqual(exact.modelPage.models, [{ id: 'exact-model' }]);
    assert.strictEqual(exact.suggestedBaseUrl, undefined);

    for (const testCase of ['html', 'missing']) {
      const submitted = profile(testCase);
      const originalBaseUrl = submitted.baseUrl;
      const result = await testApiProfile(submitted);
      assert.strictEqual(result.ok, false, 'diagnosis must not silently accept or apply /v1');
      assert.strictEqual(result.modelPage, null, 'the diagnostic catalog must not become binding data');
      assert.strictEqual(result.suggestionReason, 'validated_v1_models');
      assert.strictEqual(result.suggestedBaseUrl, `http://127.0.0.1:${port}/v1?case=${testCase}`);
      assert.strictEqual(submitted.baseUrl, originalBaseUrl, 'diagnosis must not mutate the submitted profile');
      assert.match(result.error, /valid model catalog was detected/i);
    }

    for (const testCase of ['unauthorized', 'forbidden', 'limited', 'server']) {
      const before = requests.length;
      const result = await testApiProfile(profile(testCase));
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.suggestedBaseUrl, undefined);
      assert.deepStrictEqual(
        requests.slice(before),
        [{ testCase, pathname: '/models' }],
        `${testCase} must perform only the exact Base URL request`
      );
    }

    const beforeOversized = requests.length;
    const oversized = await testApiProfile(profile('oversized'), { maxResponseBytes: 1024 });
    assert.strictEqual(oversized.ok, false);
    assert.match(oversized.error, /exceeded 1024 bytes/);
    assert.strictEqual(oversized.suggestedBaseUrl, undefined);
    assert.deepStrictEqual(
      requests.slice(beforeOversized),
      [{ testCase: 'oversized', pathname: '/models' }],
      'a local transport/size failure after HTTP headers must not trigger a /v1 diagnostic request'
    );

    const nested = await testApiProfile(profile('nested', '/api'));
    assert.strictEqual(nested.ok, false);
    assert.strictEqual(nested.suggestedBaseUrl, undefined);
    assert.strictEqual(
      requests.some((entry) => entry.testCase === 'nested' && entry.pathname.includes('/v1/')),
      false,
      'a non-root Base URL must not be rewritten during diagnosis'
    );

    const fallbackInvalid = await testApiProfile(profile('fallback-invalid'));
    assert.strictEqual(fallbackInvalid.ok, false);
    assert.strictEqual(fallbackInvalid.suggestedBaseUrl, undefined);
    assert.deepStrictEqual(
      requests.filter((entry) => entry.testCase === 'fallback-invalid').map((entry) => entry.pathname),
      ['/models', '/v1/models'],
      'an unvalidated fallback must be discarded after the single diagnostic request'
    );

    assert.strictEqual(
      new URL(buildProviderModelsUrl(`http://127.0.0.1:${port}`)).pathname,
      '/models'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  await testApiBaseUrlDiagnostics();
  assert.strictEqual(
    normalizeCatalogError('  '),
    'The model catalog request failed without a readable error.'
  );
  assert.strictEqual(
    normalizeCatalogError('<svg onload=alert(1)><foreignObject><div>provider console</div></foreignObject></svg>'),
    'The API returned an HTML page instead of a recognizable model catalog. Check whether the Base URL needs /v1.'
  );
  assert.strictEqual(normalizeCatalogError('x'.repeat(1000)).length, 400);
  assert.strictEqual(normalizeCatalogError('x'.repeat(1000)).endsWith('...'), true);

  const normalizedErrorSources = mergeCatalogSources([
    source({ source: 'provider', error: '   ' }),
    source({ source: 'live', error: 'x'.repeat(1000) }),
  ]).sources;
  assert.strictEqual(
    normalizedErrorSources.find((entry) => entry.source === 'provider')?.error,
    'The model catalog request failed without a readable error.'
  );
  assert.strictEqual(
    normalizedErrorSources.find((entry) => entry.source === 'live')?.error.length,
    400
  );

  const merged = mergeCatalogSources([
    source({
      source: 'live',
      models: [{
        id: 'gpt-5.6-sol',
        displayName: 'GPT 5.6 Sol',
        visible: true,
        isDefault: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningEffort: 'high',
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
      models: [
        { id: 'gpt-5.6-sol', reasoningLevels: ['low'], defaultReasoningEffort: 'low' },
        { id: 'provider-only', reasoningLevels: ['low'], defaultReasoningEffort: 'low' },
      ],
    }),
  ]);

  const sol = merged.lookup('gpt-5.6-sol');
  assert.deepStrictEqual(sol.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.strictEqual(sol.cliSupported, true);
  assert.strictEqual(sol.providerAdvertised, true);
  assert.strictEqual(sol.availability, 'available');
  assert.strictEqual(sol.isDefault, true);
  assert.strictEqual(sol.defaultReasoningEffort, 'high');
  assert.strictEqual(sol.capabilitySource, 'live', 'runtime metadata must override advisory defaults');
  assert.strictEqual(
    merged.validate({}),
    null,
    'an omitted selection must remain Auto instead of validating the catalog default model'
  );

  const providerOnly = merged.lookup('provider-only');
  assert.strictEqual(providerOnly.providerAdvertised, true);
  assert.strictEqual(providerOnly.cliSupported, false, 'complete live list proves CLI absence');
  assert.deepStrictEqual(providerOnly.reasoningLevels, ['low']);
  assert.strictEqual(providerOnly.defaultReasoningEffort, 'low');
  assert.strictEqual(providerOnly.selectable, false);

  const customMerged = mergeCatalogSources(merged.sources, {
    allowProviderModelsWithoutLive: true,
  });
  const customProviderOnly = customMerged.lookup('provider-only');
  assert.strictEqual(customProviderOnly.providerAdvertised, true);
  assert.strictEqual(customProviderOnly.cliSupported, 'unknown');
  assert.strictEqual(customProviderOnly.selectable, true);
  assert.doesNotThrow(
    () => customMerged.validate({ model: 'provider-only' }),
    'a Custom API may use a provider-advertised model even when the generic app-server list omits it'
  );
  assert.throws(
    () => customMerged.validate({ model: 'missing' }),
    (error) => error.code === 'session_model_unavailable',
    'Custom APIs must still reject models absent from a complete provider catalog'
  );
  const refreshedCompatibleCatalog = mergeCatalogSources([
    source({
      source: 'last-known-good',
      originSource: 'provider',
      authority: 'advisory',
      complete: false,
      stale: true,
      evidenceAuthority: 'authoritative',
      evidenceComplete: true,
      evidenceTruncated: false,
      models: [{ id: 'provider-from-bound-run' }],
    }),
    source({
      source: 'live',
      models: [{ id: 'runtime-default', isDefault: true }],
    }),
  ], { allowProviderModelsWithoutLive: true });
  assert.strictEqual(
    refreshedCompatibleCatalog.lookup('provider-from-bound-run').selectable,
    true,
    'Refresh must retain provider evidence persisted for the same compatible Session run'
  );
  assert.strictEqual(
    refreshedCompatibleCatalog.lookup('runtime-default').selectable,
    false,
    'generic runtime metadata must not add a model absent from the bound compatible provider account'
  );
  const refreshedOfficialCatalog = mergeCatalogSources(
    refreshedCompatibleCatalog.sources,
    { allowProviderModelsWithoutLive: false }
  );
  assert.strictEqual(
    refreshedOfficialCatalog.lookup('provider-from-bound-run').selectable,
    false,
    'official OpenAI still requires the model to appear in runtime metadata'
  );
  const apiAdvertisedModels = Array.from({ length: 19 }, (_, index) => ({ id: `api-model-${index + 1}` }));
  const runtimeAdvertisedModels = apiAdvertisedModels.slice(0, 6).map((model) => ({
    ...model,
    isDefault: model.id === 'api-model-1',
  }));
  const compatibleNineteen = mergeCatalogSources([
    source({
      source: 'last-known-good',
      originSource: 'provider',
      authority: 'advisory',
      complete: false,
      stale: true,
      evidenceAuthority: 'authoritative',
      evidenceComplete: true,
      models: apiAdvertisedModels,
    }),
    source({ source: 'live', models: runtimeAdvertisedModels }),
  ], { allowProviderModelsWithoutLive: true });
  assert.strictEqual(
    compatibleNineteen.models.filter((model) => model.selectable).length,
    19,
    'a bound compatible endpoint must expose all 19 provider models instead of collapsing to the six runtime entries'
  );
  assert.strictEqual(
    mergeCatalogSources(compatibleNineteen.sources).models.filter((model) => model.selectable).length,
    6,
    'the same complete runtime catalog remains six models under the official policy'
  );
  assert.strictEqual(
    providerModelsMayBypassLiveCatalog({ providerKind: 'openai' }),
    false,
    'official OpenAI catalogs must still require runtime model support'
  );
  assert.strictEqual(
    providerModelsMayBypassLiveCatalog({
      providerKind: 'openai',
      allowProviderModelsWithoutLive: true,
    }),
    true,
    'an OpenAI-compatible endpoint policy must be independent from reasoning capability metadata'
  );
  assert.strictEqual(
    providerModelsMayBypassLiveCatalog({ providerKind: 'custom' }),
    true,
    'Custom providers retain their existing provider-model policy'
  );

  assert.deepStrictEqual(
    normalizeModel({
      id: 'metadata-round-trip',
      supported_reasoning_efforts: ['LOW', 'XHIGH'],
      default_reasoning_effort: 'XHIGH',
    }),
    {
      id: 'metadata-round-trip',
      displayName: null,
      reasoningLevels: ['low', 'xhigh'],
      reasoningDeclared: true,
      defaultReasoningEffort: 'xhigh',
      defaultReasoningEffortDeclared: true,
      isDefault: false,
      visible: true,
    }
  );

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
  assert.throws(
    () => merged.validate({
      model: 'gpt-5.6-sol',
      effort: 'impossible',
      allowUnverifiedEffort: true,
    }),
    (error) => error.code === 'session_effort_unsupported'
      && error.model === 'gpt-5.6-sol'
      && error.effort === 'impossible'
      && error.reasoningLevels.includes('high'),
    'an explicit unknown-capability override must not bypass known capability metadata'
  );
  assert.doesNotThrow(
    () => merged.validate({ model: 'gpt-5.6-sol', effort: ' HIGH ' }),
    'submitted effort values should use the same normalized syntax as model metadata'
  );
  assert.doesNotThrow(
    () => merged.validate({ effort: 'HIGH' }),
    'an effort without an explicit model should validate against the catalog default model'
  );
  assert.throws(
    () => merged.validate({ effort: 'impossible', allowUnverifiedEffort: true }),
    (error) => error.code === 'session_effort_unsupported'
      && error.model === 'gpt-5.6-sol',
    'a default model with known capabilities must remain strict'
  );
  assert.throws(
    () => merged.validate({ model: 'gpt-5.6-sol', effort: 'not valid!' }),
    (error) => error.code === 'session_effort_invalid'
      && error.statusCode === 422
      && error.model === 'gpt-5.6-sol'
      && error.effort === 'not valid!'
      && Boolean(error.expectedPattern),
    'invalid effort syntax should return a structured input error'
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
    defaultReasoningEffort: null,
  });
  assert.throws(
    () => incomplete.validate({ model: 'missing', effort: 'high' }),
    (error) => error.code === 'session_effort_unverified'
      && error.model === 'missing'
      && error.effort === 'high'
      && error.capabilityUnknown === true
      && error.allowUnverifiedEffort === false
  );
  assert.doesNotThrow(
    () => incomplete.validate({
      model: 'missing',
      effort: 'high',
      allowUnverifiedEffort: true,
    })
  );
  assert.doesNotThrow(
    () => incomplete.validate(
      { model: 'missing', effort: 'high' },
      { allowUnverifiedEffort: true }
    ),
    'the service caller may supply the explicit override separately from the selection'
  );
  assert.throws(
    () => incomplete.validate({ effort: 'high' }),
    (error) => error.code === 'session_effort_unverified'
      && error.model === null
      && error.defaultModelUsed === false,
    'effort-only selection with no catalog default should remain explicitly unverified'
  );
  assert.doesNotThrow(
    () => incomplete.validate({ effort: 'high', allowUnverifiedEffort: true })
  );
  assert.doesNotThrow(() => incomplete.validate({ model: 'missing', effort: '' }));

  const policyValidationService = new ModelCatalogService({ store: {} });
  incomplete.providerKind = 'openai';
  assert.throws(
    () => policyValidationService.validateSelection(
      incomplete,
      { model: 'missing', effort: 'high' },
      { allowUnverifiedEffort: true }
    ),
    (error) => error.code === 'session_effort_unsupported'
      && error.providerKind === 'openai'
      && error.capabilityUnknown === true,
    'non-Custom providers must not bypass unknown effort validation through the Relay API'
  );
  incomplete.providerKind = 'custom';
  assert.doesNotThrow(
    () => policyValidationService.validateSelection(
      incomplete,
      { model: 'missing', effort: 'high' },
      { allowUnverifiedEffort: true }
    ),
    'Custom providers may accept an explicitly confirmed unknown effort value'
  );
  assert.throws(
    () => policyValidationService.validateSelection(
      incomplete,
      { model: 'missing', effort: 'high' }
    ),
    (error) => error.code === 'session_effort_unverified',
    'Custom providers still require explicit confirmation for unknown effort values'
  );

  const providerScopedOverrides = new ModelCatalogService({
    store: {},
    overrides: [{
      providerKind: 'openai',
      models: [{ id: 'gpt-provider-scope', reasoningLevels: ['low', 'high'] }],
    }],
  });
  assert.strictEqual(
    providerScopedOverrides.overrideSources({
      hostId: 'host-a',
      bindingFingerprint: 'binding-a',
      apiConfig: { providerKind: 'custom' },
    }).length,
    0,
    'OpenAI advisory capabilities must not leak into Custom profiles'
  );
  assert.deepStrictEqual(
    providerScopedOverrides.overrideSources({
      hostId: 'host-a',
      bindingFingerprint: 'binding-a',
      apiConfig: { providerKind: 'openai' },
    })[0].models[0].reasoningLevels,
    ['low', 'high']
  );

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
  assert.notStrictEqual(
    catalogKey({
      hostId: 'host-a',
      bindingFingerprint: 'binding-a',
      runId: 'run-a',
      providerKind: 'openai',
    }),
    catalogKey({
      hostId: 'host-a',
      bindingFingerprint: 'binding-a',
      runId: 'run-a',
      providerKind: 'custom',
    }),
    'provider capability identity must not reuse a cache key when the binding fingerprint is unchanged'
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

  const providerIsolationRequest = {
    identity: { hostId: 'host-a', sessionId: 'session-provider-isolation' },
    hostId: 'host-a',
    sessionId: 'session-provider-isolation',
    bindingFingerprint: 'binding-provider-isolation',
    runId: 'run-provider-isolation',
  };
  await store.transact('test.seed.provider-isolation', (tx) => {
    const key = tx.resolveCanonicalKey(providerIsolationRequest.identity);
    tx.ensureRecord(key, { hostId: 'host-a', conversationKey: 'session-provider-isolation' });
    tx.markDirty(key);
  });
  const releaseProviderIsolation = deferred();
  let providerIsolationFetches = 0;
  const providerIsolationOverrides = [{
    providerKind: 'openai',
    models: [{
      id: 'gpt-5.2',
      reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'none',
    }],
  }];
  const providerIsolationService = new ModelCatalogService({
    store,
    staleMs: 60_000,
    now: () => '2026-07-16T00:00:00.000Z',
    overrides: providerIsolationOverrides,
    fetchLivePage: async ({ providerKind }) => {
      providerIsolationFetches += 1;
      await releaseProviderIsolation.promise;
      return source({
        source: 'live',
        complete: false,
        providerKind,
        fetchedAt: '2026-07-16T00:00:00.000Z',
        models: [{ id: 'gpt-5.2' }],
      });
    },
  });
  const openAiIsolationInput = {
    ...providerIsolationRequest,
    providerKind: 'openai',
    force: true,
  };
  const customIsolationInput = {
    ...providerIsolationRequest,
    providerKind: 'custom',
    force: true,
  };
  const openAiIsolationRequest = providerIsolationService.get(openAiIsolationInput);
  const customIsolationRequest = providerIsolationService.get(customIsolationInput);
  assert.notStrictEqual(
    openAiIsolationRequest,
    customIsolationRequest,
    'OpenAI and Custom capability refreshes must not share an in-flight Promise'
  );
  releaseProviderIsolation.resolve();
  const [openAiIsolation, customIsolation] = await Promise.all([
    openAiIsolationRequest,
    customIsolationRequest,
  ]);
  assert.strictEqual(providerIsolationFetches, 2);
  assert.strictEqual(openAiIsolation.providerKind, 'openai');
  assert.strictEqual(openAiIsolation.lookup('gpt-5.2').capabilityKnown, true);
  assert.strictEqual(
    openAiIsolation.lookup('gpt-5.2').defaultReasoningEffort,
    'none',
    JSON.stringify(openAiIsolation.lookup('gpt-5.2'))
  );
  assert.strictEqual(customIsolation.providerKind, 'custom');
  assert.strictEqual(customIsolation.lookup('gpt-5.2').capabilityKnown, false);

  const providerIsolationCacheService = new ModelCatalogService({
    store,
    staleMs: 60_000,
    now: () => '2026-07-16T00:00:01.000Z',
    overrides: providerIsolationOverrides,
    fetchLivePage: async () => { throw new Error('fresh provider-scoped cache should avoid live fetch'); },
  });
  const cachedOpenAiIsolation = await providerIsolationCacheService.get({
    ...providerIsolationRequest,
    providerKind: 'openai',
  });
  const cachedCustomIsolation = await providerIsolationCacheService.get({
    ...providerIsolationRequest,
    providerKind: 'custom',
  });
  assert.strictEqual(cachedOpenAiIsolation.cacheState, 'fresh');
  assert.strictEqual(cachedOpenAiIsolation.lookup('gpt-5.2').capabilityKnown, true);
  assert.strictEqual(cachedCustomIsolation.cacheState, 'fresh');
  assert.strictEqual(cachedCustomIsolation.lookup('gpt-5.2').capabilityKnown, false);

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

  let cacheOnlyFetches = 0;
  const cacheOnlyService = new ModelCatalogService({
    store,
    staleMs: 0,
    now: () => '2026-07-18T00:00:00.000Z',
    fetchLivePage: async () => { cacheOnlyFetches += 1; },
    fetchProviderPage: async () => { cacheOnlyFetches += 1; },
  });
  const cacheOnlyCatalog = cacheOnlyService.getCached(request);
  assert(cacheOnlyCatalog, 'send-path validation should be able to reuse stale verified evidence');
  assert.strictEqual(cacheOnlyCatalog.cacheState, 'stale');
  assert.strictEqual(cacheOnlyCatalog.lookup('model-binding-a').availability, 'available');
  assert.strictEqual(cacheOnlyFetches, 0, 'cache-only validation must never contact the Host or provider');
  assert.strictEqual(
    cacheOnlyService.getCached({ ...request, runId: 'missing-cache-run' }),
    null,
    'a cache miss must return immediately instead of starting a catalog refresh'
  );

  let inheritedCatalogFetches = 0;
  const inheritedCatalogService = new ModelCatalogService({
    store,
    staleMs: 0,
    now: () => '2026-07-17T00:00:00.000Z',
    fetchLivePage: async () => { inheritedCatalogFetches += 1; },
    fetchProviderPage: async () => { inheritedCatalogFetches += 1; },
  });
  const inheritedRequest = {
    ...request,
    runId: 'run-auto-resume',
  };
  const inheritedCatalog = await inheritedCatalogService.inheritRunCatalog(inheritedRequest, 'run-a');
  assert(inheritedCatalog, 'same-binding parent catalog should be inherited for Auto Resume');
  assert.strictEqual(inheritedCatalog.cacheState, 'inherited');
  assert.strictEqual(inheritedCatalog.savedAt, firstCatalog.savedAt, 'inheritance must retain source freshness');
  assert.strictEqual(inheritedCatalog.lookup('model-binding-a').availability, 'available');
  assert.strictEqual(inheritedCatalogFetches, 0, 'catalog inheritance must never invoke live/provider fetchers');
  const inheritedCache = inheritedCatalogService.readCache(
    inheritedRequest,
    catalogKey(inheritedRequest)
  );
  assert(inheritedCache, 'inherited catalog should be persisted under the resumed run');
  assert.strictEqual(inheritedCache.savedAt, firstCatalog.savedAt);
  assert.strictEqual(
    await inheritedCatalogService.inheritRunCatalog({ ...inheritedRequest, runId: 'run-no-parent-cache' }, 'missing-run'),
    null,
    'Auto Resume without a parent cache should continue without blocking or fetching'
  );
  assert.strictEqual(inheritedCatalogFetches, 0);

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
      models: [{
        id: 'live-last-known-good',
        reasoningLevels: ['high'],
        defaultReasoningEffort: 'high',
      }],
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
  assert.strictEqual(partialRefresh.lookup('live-last-known-good').defaultReasoningEffort, 'high');
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
    persistedPartial.lookup('live-last-known-good').defaultReasoningEffort,
    'high',
    'default reasoning metadata must survive normalized cache persistence and reload'
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
