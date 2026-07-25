const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { PassThrough } = require('stream');

const {
  assertRunBinding,
  attestHostEnvironmentBinding,
  buildProviderModelsUrl,
  classifyProviderModelResponse,
  classifyNativeThreadError,
  deriveRunBinding,
  modelCapabilitiesFromList,
  normalizeProviderModelPage,
  normalizeReasoningEffort,
  resumeStrategyForLaunchMode,
  validateModelSelection,
} = require('../apps/host-agent/session-api-runtime');
const {
  buildCodexStateDatabaseDiagnostic,
  CodexAppServerRunner,
  classifyCodexStateDatabaseStderr,
  cleanupApiProfileCodexHome,
  cleanupStaleApiProfileCodexHomes,
  isMissingNativeRolloutError,
  normalizeTurnStartParams,
  prepareApiProfileCodexHome,
  resolveDefaultCodexBin,
  startCodexAppServerSession,
  updateApiProfileCodexHomeOwnership,
} = require('../apps/host-agent/codex-app-server-runner');
const { startManagedRuntimeSession } = require('../apps/host-agent/runtime-adapters');
const {
  buildApiProcessEnvironment,
  normalizeApiConfig,
} = require('../apps/host-agent/runtime-utils');
let managedLifecycle = {};
try {
  managedLifecycle = require('../apps/host-agent/managed-session-lifecycle');
} catch {
  managedLifecycle = {};
}
const {
  bindingsEqual,
  makeHostEnvironmentBinding,
  makeProfileBinding,
  publicBinding,
} = require('../shared/api-binding');

const sqliteOpenFailureText = 'ERROR codex_app_server: failed to initialize SQLite state runtime: database error: (code: 14) unable to open database file';
const sqliteOpenFailure = buildCodexStateDatabaseDiagnostic(
  sqliteOpenFailureText,
  'C:\\Users\\acceptance\\.codex\\.remote-codex-managed\\rc-owner\\.codex'
);
assert.strictEqual(sqliteOpenFailure.classification, 'open-create');
assert.strictEqual(sqliteOpenFailure.quarantine, false);
assert.match(sqliteOpenFailure.message, /open or create SQLite state/);
assert.match(sqliteOpenFailure.detail, /not evidence that the database is corrupted/);
assert.match(sqliteOpenFailure.detail, /existing SQLite files were left untouched/);
assert.strictEqual(sqliteOpenFailure.data.rawStderr, sqliteOpenFailureText);
for (const unavailableText of [
  'failed to create SQLite state database: Access is denied',
  'SQLite state initialization failed: permission denied',
  'SQLITE_CANTOPEN while opening state_5.sqlite',
]) {
  const diagnostic = buildCodexStateDatabaseDiagnostic(unavailableText, 'C:\\Users\\acceptance\\.codex');
  assert.strictEqual(diagnostic.classification, 'open-create');
  assert.strictEqual(diagnostic.quarantine, false);
  assert.strictEqual(diagnostic.data.rawStderr, unavailableText);
}

const sqlitePathFailureText = 'failed to initialize sqlite state db: ENAMETOOLONG: filename or extension is too long';
const sqlitePathFailure = buildCodexStateDatabaseDiagnostic(sqlitePathFailureText, 'C:\\very-long\\.codex');
assert.strictEqual(sqlitePathFailure.classification, 'path-too-long');
assert.strictEqual(sqlitePathFailure.quarantine, false);
assert.match(sqlitePathFailure.detail, /filesystem path is too long/);
assert.match(sqlitePathFailure.detail, new RegExp(sqlitePathFailureText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

const sqliteGenericFailure = buildCodexStateDatabaseDiagnostic(
  'codex_app_server: failed to initialize sqlite state db',
  'C:\\Users\\acceptance\\.codex'
);
assert.strictEqual(sqliteGenericFailure.classification, 'initialization');
assert.strictEqual(sqliteGenericFailure.quarantine, false);
assert.match(sqliteGenericFailure.detail, /did not establish database corruption/);

for (const corruptionText of [
  'database error: (code: 26) file is not a database',
  'SQLite failure: database disk image is malformed',
  'SQLITE_CORRUPT while reading state_5.sqlite',
]) {
  const diagnostic = buildCodexStateDatabaseDiagnostic(corruptionText, 'C:\\Users\\acceptance\\.codex');
  assert.strictEqual(diagnostic.classification, 'corruption');
  assert.strictEqual(diagnostic.quarantine, true);
  assert.match(diagnostic.detail, /affected state_\*\.sqlite files may be moved aside/);
}
assert.strictEqual(
  classifyCodexStateDatabaseStderr('failed to create unrelated output file'),
  null,
  'non-SQLite stderr must not be classified as a state database failure'
);

const completePage = normalizeProviderModelPage({
  data: [{ id: 'model-a' }, { id: 'model-b' }],
  has_more: false,
}, { limit: 10 });
assert.deepStrictEqual(completePage, {
  authority: 'authoritative',
  complete: true,
  models: [{ id: 'model-a' }, { id: 'model-b' }],
  nextCursor: null,
  truncated: false,
});

assert.throws(
  () => normalizeProviderModelPage({ message: 'welcome' }),
  (error) => error?.code === 'provider_model_catalog_invalid' && /Base URL needs \/v1/.test(error.message),
  'HTTP JSON that is not a model list must not be accepted as an empty catalog'
);

assert.deepStrictEqual(
  classifyProviderModelResponse(200, '<html>provider console</html>'),
  {
    ok: false,
    reachable: true,
    catalogValid: false,
    modelPage: null,
    error: 'The API returned HTTP success but not a recognizable model catalog. Check whether the Base URL needs /v1.',
  }
);
assert.strictEqual(classifyProviderModelResponse(200, '{"message":"welcome"}').ok, false);
assert.strictEqual(classifyProviderModelResponse(200, '{"data":[{"name":"missing-id"}]}').ok, false);
const emptyCatalogResponse = classifyProviderModelResponse(200, '{"data":[]}');
assert.strictEqual(emptyCatalogResponse.ok, true);
assert.strictEqual(emptyCatalogResponse.catalogValid, true);
assert.deepStrictEqual(emptyCatalogResponse.modelPage.models, []);
assert.deepStrictEqual(
  classifyProviderModelResponse(401, '{"error":{"message":"bad key"}}'),
  {
    ok: false,
    reachable: false,
    catalogValid: false,
    modelPage: null,
    error: null,
  }
);

const truncatedPage = normalizeProviderModelPage({
  data: [{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }],
}, { limit: 2 });
assert.strictEqual(truncatedPage.complete, false);
assert.strictEqual(truncatedPage.truncated, true);
assert.strictEqual(truncatedPage.nextCursor, 'model-b');
assert.deepStrictEqual(truncatedPage.models, [{ id: 'model-a' }, { id: 'model-b' }]);

const pagedResponse = normalizeProviderModelPage({
  data: [{
    id: 'model-reasoning',
    supported_reasoning_efforts: ['low', 'ultra'],
    default_reasoning_effort: 'low',
  }],
  has_more: true,
  last_id: 'model-reasoning',
});
assert.strictEqual(pagedResponse.complete, false);
assert.strictEqual(pagedResponse.nextCursor, 'model-reasoning');
assert.deepStrictEqual(pagedResponse.models, [{
  id: 'model-reasoning',
  reasoningLevels: ['low', 'ultra'],
  defaultReasoningEffort: 'low',
}]);

const queryModelsUrl = new URL(buildProviderModelsUrl(
  'https://azure.example/openai?api-version=2025-04-01&deployment=primary',
  { cursor: 'model-a', limit: 37, includeLimit: true }
));
assert.strictEqual(queryModelsUrl.pathname, '/openai/models');
assert.strictEqual(queryModelsUrl.searchParams.get('api-version'), '2025-04-01');
assert.strictEqual(queryModelsUrl.searchParams.get('deployment'), 'primary');
assert.strictEqual(queryModelsUrl.searchParams.get('after'), 'model-a');
assert.strictEqual(queryModelsUrl.searchParams.get('limit'), '37');

const expectedHostBinding = makeHostEnvironmentBinding({
  provider: 'OpenAI',
  baseUrl: 'https://host-api.example/v1',
  modelProviderHint: 'host-provider',
});
const profile = makeProfileBinding({
  profileId: 'profile-a',
  provider: 'OpenAI',
  baseUrl: 'https://profile.example/v1',
});
const legacyOpenAiKeyOnlyBinding = {
  kind: 'profile',
  profileId: 'legacy-openai-key-only',
  label: 'Legacy OpenAI key-only',
  provider: 'OpenAI',
  providerKind: null,
  normalizedBaseUrl: null,
  bindingFingerprint: 'legacy-fingerprint-with-null-base',
};
const normalizedOpenAiKeyOnlyConfig = normalizeApiConfig({
  profileId: 'legacy-openai-key-only',
  label: 'Legacy OpenAI key-only',
  provider: 'OpenAI',
  apiKey: 'legacy-key',
});
assert.throws(
  () => normalizeApiConfig({
    profileId: 'missing-key',
    provider: 'OpenAI',
  }),
  (error) => error?.code === 'api_key_required' && error?.statusCode === 422,
  'an explicit API profile must fail closed when its key is missing'
);
const inheritedApiEnvironment = {
  PATH: 'test-path',
  OPENAI_API_KEY: 'host-key-must-not-leak',
  OpenAi_Base_Url: 'https://host-case-variant.example/v1',
  OPENAI_ORGANIZATION: 'host-org-must-not-leak',
  KEEP_ME: 'preserved',
};
assert.deepStrictEqual(
  buildApiProcessEnvironment(inheritedApiEnvironment, {
    profileId: 'isolated-profile',
    provider: 'OpenAI',
    baseUrl: 'https://isolated.example/v1',
    apiKey: 'isolated-key',
  }),
  {
    PATH: 'test-path',
    KEEP_ME: 'preserved',
    OPENAI_API_KEY: 'isolated-key',
    OPENAI_BASE_URL: 'https://isolated.example/v1',
    OPENAI_API_BASE: 'https://isolated.example/v1',
  },
  'an explicit profile child must scrub inherited OPENAI_* values before injecting its own credentials'
);
assert.deepStrictEqual(
  buildApiProcessEnvironment(inheritedApiEnvironment, null),
  inheritedApiEnvironment,
  'a host-environment child must preserve the inherited environment'
);
const canonicalOpenAiKeyOnlyBinding = makeProfileBinding(normalizedOpenAiKeyOnlyConfig);
assert.strictEqual(
  publicBinding(legacyOpenAiKeyOnlyBinding).normalizedBaseUrl,
  'https://api.openai.com/v1'
);
assert.strictEqual(bindingsEqual(legacyOpenAiKeyOnlyBinding, canonicalOpenAiKeyOnlyBinding), true);
assert.strictEqual(
  deriveRunBinding({
    apiBinding: legacyOpenAiKeyOnlyBinding,
    apiConfig: normalizedOpenAiKeyOnlyConfig,
  }).bindingFingerprint,
  canonicalOpenAiKeyOnlyBinding.bindingFingerprint,
  'Host binding verification must canonicalize a legacy OpenAI key-only run before comparison'
);
const legacyCustomNullBaseBinding = {
  kind: 'profile',
  profileId: 'legacy-custom-null-base',
  provider: 'OpenAI',
  providerKind: 'custom',
  normalizedBaseUrl: null,
  bindingFingerprint: 'legacy-custom-null-base-fingerprint',
};
assert.strictEqual(publicBinding(legacyCustomNullBaseBinding).normalizedBaseUrl, null);
for (const providerKind of ['custom', 'anthropic', 'gemini']) {
  assert.strictEqual(
    makeProfileBinding({
      profileId: `non-official-${providerKind}`,
      provider: 'OpenAI',
      providerKind,
    }).normalizedBaseUrl,
    null,
    `${providerKind} must not acquire the official OpenAI endpoint from its display label`
  );
}
assert.strictEqual(
  makeProfileBinding({
    profileId: 'explicit-official-kind',
    provider: 'Renamed official provider',
    providerKind: 'openai',
  }).normalizedBaseUrl,
  'https://api.openai.com/v1',
  'the explicit OpenAI provider kind must canonicalize an omitted Base URL'
);
assert.strictEqual(
  makeProfileBinding({
    profileId: 'compatible-label',
    provider: 'OpenAI-compatible',
  }).normalizedBaseUrl,
  null,
  'an OpenAI-compatible label must not acquire the official OpenAI endpoint'
);
assert.throws(
  () => deriveRunBinding({
    apiBinding: legacyCustomNullBaseBinding,
    apiConfig: {
      profileId: 'legacy-custom-null-base',
      provider: 'OpenAI',
      providerKind: 'custom',
      baseUrl: 'https://custom.example/v1',
      apiKey: 'custom-key',
    },
  }),
  (error) => error?.code === 'session_api_binding_mismatch',
  'a Custom null-base legacy binding must not be treated as official OpenAI'
);
const attested = attestHostEnvironmentBinding({
  env: {
    OPENAI_API_KEY: 'must-not-leak',
    OPENAI_BASE_URL: 'https://host-api.example/v1/',
    REMOTE_CODEX_API_PROVIDER: 'openai',
    CODEX_MODEL_PROVIDER: 'host-provider',
  },
  expectedBinding: expectedHostBinding,
});
assert.strictEqual(attested.ok, true);
assert.strictEqual(JSON.stringify(attested).includes('must-not-leak'), false);
assert.throws(
  () => attestHostEnvironmentBinding({
    env: { OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'https://other.example/v1' },
    expectedBinding: expectedHostBinding,
  }),
  (error) => error.code === 'session_api_binding_mismatch'
);

assert.throws(
  () => deriveRunBinding({
    apiBinding: profile,
    apiConfig: {
      profileId: 'other',
      provider: 'OpenAI',
      baseUrl: 'https://other.example/v1',
      apiKey: 'other-key',
    },
    allowUnavailable: true,
  }),
  (error) => error.code === 'session_api_binding_mismatch',
  'allowUnavailable must not hide an explicit binding/config mismatch'
);
assert.strictEqual(
  deriveRunBinding({
    apiBinding: profile,
    apiConfig: {
      profileId: 'profile-a',
      provider: 'openai',
      baseUrl: 'https://PROFILE.example/v1/',
      apiKey: 'profile-key',
    },
  }).bindingFingerprint,
  profile.bindingFingerprint,
  'matching explicit binding and API config should derive one verified identity'
);
const queryProfileConfig = {
  profileId: 'azure-profile',
  provider: 'Azure OpenAI',
  providerKind: 'custom',
  baseUrl: 'https://azure.example/openai/?api-version=2025-04-01&deployment=primary#ignored',
  apiKey: 'azure-key',
};
const normalizedQueryProfileConfig = normalizeApiConfig(queryProfileConfig);
assert.strictEqual(normalizedQueryProfileConfig.providerKind, 'custom');
assert.strictEqual(
  normalizedQueryProfileConfig.baseUrl,
  'https://azure.example/openai?api-version=2025-04-01&deployment=primary',
  'Host API normalization must preserve non-secret query parameters used by provider endpoints'
);
assert.strictEqual(
  deriveRunBinding({
    apiBinding: makeProfileBinding(queryProfileConfig),
    apiConfig: normalizedQueryProfileConfig,
  }).bindingFingerprint,
  makeProfileBinding(queryProfileConfig).bindingFingerprint,
  'Host API normalization must not change the Relay-attested profile identity'
);
assert.throws(
  () => deriveRunBinding({
    expectedBinding: expectedHostBinding,
    env: { OPENAI_API_KEY: 'x', OPENAI_BASE_URL: 'https://other.example/v1' },
    allowUnavailable: true,
  }),
  (error) => error.code === 'session_api_binding_mismatch',
  'allowUnavailable may tolerate unavailable identity, not a verified mismatch'
);
assert.strictEqual(
  deriveRunBinding({ env: {}, codexHome: path.join(os.tmpdir(), `missing-codex-home-${process.pid}`), allowUnavailable: true }),
  null,
  'allowUnavailable should still tolerate a genuinely unavailable Host identity'
);

const attestationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-attestation-'));
fs.writeFileSync(path.join(attestationHome, 'auth.json'), '{"OPENAI_API_KEY":"must-not-leak-from-file"}\n', 'utf8');
fs.writeFileSync(path.join(attestationHome, 'config.toml'), [
  'model_provider = "acme"',
  '[model_providers.acme]',
  'name = "Acme API"',
  'base_url = "https://codex-home.example/v1/"',
].join('\n'), 'utf8');
const fileAttested = attestHostEnvironmentBinding({ env: {}, codexHome: attestationHome });
assert.strictEqual(fileAttested.binding.provider, 'Acme API');
assert.strictEqual(fileAttested.binding.modelProviderHint, 'acme');
assert.strictEqual(fileAttested.binding.normalizedBaseUrl, 'https://codex-home.example/v1');
assert.strictEqual(JSON.stringify(fileAttested).includes('must-not-leak-from-file'), false);
fs.rmSync(attestationHome, { recursive: true, force: true });

const credentialIsolationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-credential-isolation-'));
const hostAuth = {
  OPENAI_API_KEY: 'host-auth-key-must-not-leak',
  tokens: { access_token: 'host-access-token-must-not-leak' },
  account_id: 'host-account-must-not-leak',
};
fs.writeFileSync(
  path.join(credentialIsolationHome, 'auth.json'),
  `${JSON.stringify(hostAuth)}\n`,
  'utf8'
);
let explicitCredentialOverlay = null;
let hostEnvironmentOverlay = null;
try {
  explicitCredentialOverlay = prepareApiProfileCodexHome(credentialIsolationHome, {
    profileId: 'credential-isolation',
    provider: 'OpenAI',
    apiKey: 'explicit-profile-key',
  });
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(explicitCredentialOverlay.codexHome, 'auth.json'), 'utf8')),
    { OPENAI_API_KEY: 'explicit-profile-key' },
    'an explicit profile overlay must not copy Host auth tokens or account metadata'
  );
  assert.strictEqual(cleanupApiProfileCodexHome(explicitCredentialOverlay.cleanupOwner), true);
  explicitCredentialOverlay = null;

  hostEnvironmentOverlay = prepareApiProfileCodexHome(credentialIsolationHome, null);
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(hostEnvironmentOverlay.codexHome, 'auth.json'), 'utf8')),
    hostAuth,
    'a host-environment overlay must preserve Host auth.json'
  );
  assert.strictEqual(cleanupApiProfileCodexHome(hostEnvironmentOverlay.cleanupOwner), true);
  hostEnvironmentOverlay = null;
} finally {
  if (explicitCredentialOverlay && fs.existsSync(explicitCredentialOverlay.profileHomeDir)) {
    cleanupApiProfileCodexHome(explicitCredentialOverlay.cleanupOwner);
  }
  if (hostEnvironmentOverlay && fs.existsSync(hostEnvironmentOverlay.profileHomeDir)) {
    cleanupApiProfileCodexHome(hostEnvironmentOverlay.cleanupOwner);
  }
  fs.rmSync(credentialIsolationHome, { recursive: true, force: true });
}

const rotated = makeProfileBinding({
  profileId: 'profile-a',
  provider: 'openai',
  baseUrl: 'https://PROFILE.example/v1/',
  apiKey: 'rotated',
});
assert.strictEqual(assertRunBinding(profile, rotated).bindingFingerprint, profile.bindingFingerprint);
assert.throws(
  () => assertRunBinding(profile, makeProfileBinding({ profileId: 'other', provider: 'OpenAI', baseUrl: 'https://other.example/v1' })),
  (error) => error.code === 'session_api_binding_mismatch'
);

assert.strictEqual(normalizeReasoningEffort('max'), 'max');
assert.strictEqual(normalizeReasoningEffort('ultra'), 'ultra');
assert.throws(() => normalizeReasoningEffort('high;drop'), /invalid reasoning effort/i);

const capabilities = modelCapabilitiesFromList([{
  id: 'gpt-5.6-sol',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low' },
    { reasoningEffort: 'xhigh' },
    { reasoningEffort: 'max' },
    { reasoningEffort: 'ultra' },
  ],
}]);
assert.strictEqual(validateModelSelection(capabilities, 'gpt-5.6-sol', 'ultra').effort, 'ultra');
assert.throws(
  () => validateModelSelection(capabilities, 'gpt-5.6-sol', 'impossible'),
  (error) => error.code === 'session_effort_unsupported'
);
assert.strictEqual(validateModelSelection(capabilities, 'unknown-model', 'ultra').effort, 'ultra');

const turnParams = normalizeTurnStartParams('thread-a', 'D:/work', 'hello', {
  model: 'gpt-5.6-sol',
  effort: 'ultra',
});
assert.strictEqual(turnParams.effort, 'ultra', 'Runner turn params must not silently drop advertised efforts');

const runner = Object.create(CodexAppServerRunner.prototype);
runner.apiBinding = profile;
runner.modelCapabilities = capabilities;
assert.strictEqual(runner.assertCommandBinding(rotated).bindingFingerprint, profile.bindingFingerprint);
assert.throws(
  () => runner.assertCommandBinding(makeProfileBinding({ profileId: 'other', baseUrl: 'https://other.example/v1' })),
  (error) => error.code === 'session_api_binding_mismatch'
);
assert.strictEqual(runner.validateModelSelection('gpt-5.6-sol', 'max').effort, 'max');

assert.strictEqual(classifyNativeThreadError('resume', new Error('not found')).code, 'session_native_resume_failed');
assert.strictEqual(classifyNativeThreadError('fork', new Error('not found')).code, 'session_native_fork_failed');
assert.strictEqual(isMissingNativeRolloutError(new Error('no rollout found for thread id thread-a')), true);
assert.strictEqual(isMissingNativeRolloutError(new Error('provider authentication failed')), false);
assert.strictEqual(isMissingNativeRolloutError(new Error('unknown thread id thread-a')), false);
assert.strictEqual(isMissingNativeRolloutError(new Error('thread thread-a not found')), false);
assert.strictEqual(isMissingNativeRolloutError(new Error('rollout thread-a not found')), false);
assert.strictEqual(resumeStrategyForLaunchMode('transcript_fallback'), 'transcript_fallback');
assert.strictEqual(resumeStrategyForLaunchMode('fresh'), 'fresh');
assert.strictEqual(resumeStrategyForLaunchMode('fresh_rebind'), 'fresh');

if (process.platform === 'win32') {
  const resolverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-codex-bin-resolver-'));
  const markdownDecoy = path.join(resolverHome, 'codex-network.md');
  const commandShim = path.join(resolverHome, 'codex.cmd');
  try {
    fs.writeFileSync(markdownDecoy, '# This is documentation, not an executable.\n', 'utf8');
    assert.notStrictEqual(
      resolveDefaultCodexBin(resolverHome),
      markdownDecoy,
      'Windows Codex discovery must not treat a codex-named Markdown file as executable'
    );
    fs.writeFileSync(commandShim, '@echo off\r\n', 'utf8');
    assert.strictEqual(
      resolveDefaultCodexBin(resolverHome),
      commandShim,
      'Windows Codex discovery must accept an actual command shim from the requested home'
    );
  } finally {
    fs.rmSync(resolverHome, { recursive: true, force: true });
  }
}

const agentSource = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
assert(agentSource.includes("command.type === 'host.api_catalog'"));
assert(agentSource.includes("command.type === 'host.binding_preflight'"));
assert(agentSource.includes("type: 'session.command_failed'"));
const missingRunnerStart = agentSource.indexOf('if (!runner) {');
const missingRunnerInputStart = agentSource.indexOf("if (command.type === 'session.input') {", missingRunnerStart);
const liveInputStart = agentSource.indexOf("if (command.type === 'session.input') {", missingRunnerInputStart + 1);
const liveInputEnd = agentSource.indexOf("if (command.type === 'session.model_list')", liveInputStart);
assert(liveInputStart >= 0 && liveInputEnd > liveInputStart, 'Host agent must have a live session.input handler');
const liveInputBlock = agentSource.slice(liveInputStart, liveInputEnd);
assert(
  liveInputBlock.includes('lastError: null') && liveInputBlock.includes('lastCodexError: null'),
  'accepting session.input must clear stale runtime errors before submitting the new turn'
);
assert(
  agentSource.includes('nativeResumeReadiness:'),
  'new Host agents must negotiate native readiness before Relay trusts an unmaterialized state'
);
const runnerSource = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');
assert(!runnerSource.includes("const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])"));
assert(!/catch \(error\) \{\s*thread = await startTranscriptFallbackThread\(error\);\s*\}/.test(runnerSource));
assert(
  runnerSource.includes('resolveLocalCodexBin({ pathEnv: process.env.PATH })'),
  'Codex runner fallback must resolve a concrete Windows command shim instead of spawning a bare extensionless codex command'
);
assert(
  /updateApiProfileCodexHomeOwnership\(this\.apiProfileCleanupOwner,[\s\S]*childState:\s*'spawning'/.test(runnerSource)
    && /childPid:\s*this\.child\.pid/.test(runnerSource),
  'Codex app-server spawn must transition the overlay marker from pre-spawn to its actual child PID'
);
assert(
  agentSource.includes('cleanupStaleApiProfileCodexHomes(CODEX_HOME)'),
  'Host startup must run the ownership-checked managed-overlay janitor'
);
assert(
  agentSource.includes('AGENT_CLEAN_LEGACY_MANAGED_OVERLAYS')
    && /cleanupStaleApiProfileCodexHomes\(CODEX_HOME,\s*\{[\s\S]{0,240}legacyOverlayIsInactive:/.test(agentSource),
  'legacy token cleanup must require an explicit Host operator attestation'
);
assert(
  /function handleShutdownSignal\(signal\)\s*\{[\s\S]*shutdownHostAgent\(signal\)/.test(agentSource),
  'SIGINT/SIGTERM must enter the asynchronous managed-runner shutdown controller'
);
assert(
  /command\.type === 'host\.shutdown'[\s\S]{0,240}shutdownHostAgent\('relay-command'\)/.test(agentSource),
  'Relay-managed shutdown must use the same graceful runner cleanup controller'
);

assert.strictEqual(typeof managedLifecycle.findRunnerForCommand, 'function');
assert.strictEqual(typeof managedLifecycle.abortUnconfirmedRunner, 'function');
assert.strictEqual(typeof managedLifecycle.retainRunnerForStartRetry, 'function');
assert.strictEqual(typeof managedLifecycle.replayManagedSessionStart, 'function');
assert.strictEqual(typeof managedLifecycle.shouldPublishMissingRunnerStop, 'function');
assert.strictEqual(
  typeof managedLifecycle.stopUniqueLiveRunners,
  'function',
  'Host shutdown must expose one deduplicated managed-runner stop operation'
);
assert.strictEqual(
  typeof managedLifecycle.createManagedSessionShutdown,
  'function',
  'Host signals must share one idempotent graceful-shutdown controller'
);
assert(
  /ownership-revoked[\s\S]*upgradeStopOptions\(\{ suppressTerminalEvent: true \}\)/.test(agentSource),
  'ownership revocation must upgrade suppression on an already-running Host shutdown'
);
assert.strictEqual(
  typeof managedLifecycle.createManagedSessionStartGate,
  'function',
  'Host startup and shutdown must share a gate that tracks in-flight runners'
);
assert.strictEqual(
  typeof cleanupStaleApiProfileCodexHomes,
  'function',
  'Host startup must expose an ownership-checked managed-overlay janitor'
);
assert.strictEqual(
  typeof updateApiProfileCodexHomeOwnership,
  'function',
  'managed app-server startup must persist its spawned child PID in the ownership marker'
);
assert.strictEqual(managedLifecycle.shouldPublishMissingRunnerStop({ type: 'session.stop' }), true);
assert.strictEqual(
  managedLifecycle.shouldPublishMissingRunnerStop({ type: 'session.stop', suppressTerminalEvent: true }),
  false
);
const currentRunner = {
  sessionId: 'session-reused',
  bridgeSessionId: 'bridge-reused',
  runId: 'run-current',
  currentSessionId: () => 'session-reused',
};
const runnerIndex = new Map([
  ['session-reused', currentRunner],
  ['bridge-reused', currentRunner],
  ['run-current', currentRunner],
]);
assert.strictEqual(
  managedLifecycle.findRunnerForCommand(runnerIndex, { sessionId: 'session-reused', runId: 'run-stale' }),
  null,
  'a stale runId must not resolve through a reused Session alias'
);
assert.strictEqual(
  managedLifecycle.findRunnerForCommand(runnerIndex, { sessionId: 'session-reused', runId: 'run-current' }),
  currentRunner
);
assert.strictEqual(
  managedLifecycle.findRunnerForCommand(runnerIndex, { sessionId: 'session-reused' }),
  currentRunner,
  'legacy commands without runId retain alias lookup compatibility'
);
assert(agentSource.includes('findRunnerForCommand(liveSessions, command)'), 'all managed commands should use strict lifecycle lookup');
assert(agentSource.includes('abortUnconfirmedRunner(runner)'), 'a runner rejected during start confirmation must be stopped');
assert(
  agentSource.includes('retainRunnerForStartRetry(liveSessions, runner'),
  'an unconfirmed startup child must remain indexed before its start command is retried'
);
assert(agentSource.includes('await replayManagedSessionStart('), 'start command replay must resend its attested confirmation');
assert(agentSource.includes('shouldPublishMissingRunnerStop(command)'), 'missing-runner stop must honor terminal suppression');
const managedStartSource = agentSource.slice(
  agentSource.indexOf('async function startManagedSession(command)'),
  agentSource.indexOf('async function handleCommand(command)')
);
const managedStartTryIndex = managedStartSource.indexOf('try {');
for (const preparationStep of [
  'replayManagedSessionStart({',
  'resolveManagedCwd(',
  'resolveManagedRuntime(',
  'deriveRunBinding({',
]) {
  assert(
    managedStartTryIndex >= 0 && managedStartTryIndex < managedStartSource.indexOf(preparationStep),
    `${preparationStep} must execute inside the managed-start failure boundary`
  );
}
assert(
  /catch \(error\)[\s\S]*postSessionCommandFailure\(command, error, 'start'\)[\s\S]*failManagedSession\(/.test(managedStartSource),
  'every managed-start preparation failure must report command_failed and a failed terminal state'
);
assert(
  /catch \(error\) \{[\s\S]*if \(error\?\.retryCommand\) throw error;[\s\S]*abortUnconfirmedRunner\(runner\)/.test(managedStartSource),
  'replay delivery failure must escape before an existing runner is stopped or failed'
);
assert(
  /if \(error\?\.code === 'host_agent_shutting_down' \|\| managedSessionStartGate\.isShuttingDown\(\)\) \{\s*return await cancelStartForShutdown\(\);/.test(managedStartSource)
    && managedStartSource.includes('failShutdownCancelledManagedSession('),
  'shutdown-owned startup cancellation must publish an explicit terminal failure'
);
assert(
  managedStartSource.includes('managedSessionStartGate.beginStart()')
    && managedStartSource.includes('startHandle.assertCanSpawn()')
    && managedStartSource.includes('onRunnerCreated:'),
  'managed starts must enter the shutdown gate before a runtime can be spawned'
);
assert(
  managedStartSource.includes('let startCompletionError = null')
    && /shutdownTerminalDelivery[\s\S]*startCompletionError = error/.test(managedStartSource)
    && managedStartSource.includes('startHandle?.finish(startCompletionError)'),
  'shutdown terminal delivery failure must reach the start gate owner completion'
);
const polledCommandSource = agentSource.slice(
  agentSource.indexOf('async function processPolledCommand(command'),
  agentSource.indexOf('async function pollCommandsLoop()')
);
assert(
  /catch \(error\) \{\s*if \(error\?\.retryCommand\) return false;/.test(polledCommandSource),
  'retryable replay delivery failure must not advance the command acknowledgement'
);

async function verifyPagedRunnerCapabilities() {
  const pagedRunner = Object.create(CodexAppServerRunner.prototype);
  pagedRunner.runId = 'run-paged';
  pagedRunner.apiBinding = profile;
  pagedRunner.modelCapabilities = new Map();
  pagedRunner.emitDiagnostic = async () => {};
  pagedRunner.rpc = {
    async request(_method, params) {
      if (!params.cursor) {
        return {
          data: [{ id: 'page-one-model', supportedReasoningEfforts: ['high'] }],
          nextCursor: 'page-2',
        };
      }
      return {
        data: [{ id: 'page-two-model', supportedReasoningEfforts: ['ultra'] }],
        nextCursor: null,
      };
    },
  };
  await pagedRunner.listModels({ limit: 1 });
  await pagedRunner.listModels({ cursor: 'page-2', limit: 1 });
  assert.strictEqual(pagedRunner.modelCapabilities.has('page-one-model'), true);
  assert.strictEqual(pagedRunner.modelCapabilities.has('page-two-model'), true);
  assert.strictEqual(pagedRunner.validateModelSelection('page-one-model', 'high').effort, 'high');
  assert.strictEqual(pagedRunner.validateModelSelection('page-two-model', 'ultra').effort, 'ultra');
}

async function verifyIntentionalCodexStopIsSingleTerminalOutcome() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-runner-stop-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  let terminated = 0;
  const lifecycleRunner = new CodexAppServerRunner({
    hostId: 'host-stop',
    sessionId: 'session-stop',
    runId: 'run-stop',
    title: 'Stop test',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'profile-stop', provider: 'OpenAI', baseUrl: 'https://stop.example/v1', apiKey: 'secret' },
    postEvent: async (event) => events.push(event),
    onTerminated: () => { terminated += 1; },
  });
  const overlayRoot = lifecycleRunner.profileHomeDir;
  const authPath = path.join(lifecycleRunner.codexHome, 'auth.json');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(authPath).mode & 0o077, 0, 'overlay auth.json must not be group/world accessible');
    assert.strictEqual(fs.statSync(lifecycleRunner.codexHome).mode & 0o077, 0, 'overlay CODEX_HOME must not be group/world accessible');
  }

  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  lifecycleRunner.child = child;
  lifecycleRunner.startCompleted = true;
  child.once('exit', (code, signal) => {
    lifecycleRunner.handleExit(code, signal).catch(() => {});
  });
  await lifecycleRunner.stop();
  assert.deepStrictEqual(
    events.filter((event) => event.type === 'session.state_changed').map((event) => event.state),
    ['history-only'],
    'stop must not resolve before its terminal outcome is published'
  );
  await lifecycleRunner.handleExit(null, 'SIGTERM');

  const terminalEvents = events.filter((event) => event.type === 'session.state_changed');
  assert.deepStrictEqual(terminalEvents.map((event) => event.state), ['history-only']);
  assert.strictEqual(terminated, 1, 'termination callback must run once');
  assert.strictEqual(fs.existsSync(overlayRoot), false, 'only this runner\'s managed overlay should be removed after termination');
  assert.strictEqual(fs.existsSync(baseHome), true, 'overlay cleanup must never remove the base CODEX_HOME');
  fs.rmSync(baseHome, { recursive: true, force: true });
}

async function verifyCodexStopSuppressionUpgradesMonotonically() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-stop-suppression-upgrade-'));
  const events = [];
  const runner = new CodexAppServerRunner({
    hostId: 'host-stop-suppression-upgrade',
    sessionId: 'session-stop-suppression-upgrade',
    runId: 'run-stop-suppression-upgrade',
    title: 'Stop suppression upgrade',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'stop-suppression-upgrade', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async (event) => events.push(event),
    stopGraceTimeoutMs: 1000,
    stopKillTimeoutMs: 1000,
  });
  const child = new EventEmitter();
  child.pid = 830104;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  runner.child = child;
  runner.startCompleted = true;
  child.once('exit', (code, signal) => runner.handleExit(code, signal).catch(() => {}));
  const keepAlive = setInterval(() => {}, 1000);
  try {
    runner.appendThinkingDelta({
      turnId: 'turn-stop-suppression-upgrade',
      itemId: 'reasoning-stop-suppression-upgrade',
    }, 'must not reach a revoked Relay');
    const ordinaryStop = runner.stop();
    const ownershipRevokedStop = runner.stop({ suppressTerminalEvent: true });
    assert.strictEqual(
      ownershipRevokedStop,
      ordinaryStop,
      'concurrent Codex stop callers must share one child termination operation'
    );
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    await Promise.all([ordinaryStop, ownershipRevokedStop]);
    assert.strictEqual(runner.suppressTerminalEvent, true);
    assert.deepStrictEqual(
      events.filter((event) => event.type === 'session.state_changed'),
      [],
      'ownership-revoked suppression must monotonically upgrade an ordinary stop in flight'
    );
    assert.deepStrictEqual(
      events.filter((event) => event.type === 'session.activity_snapshot'),
      [],
      'ownership-revoked suppression must discard queued activity instead of posting through a revoked lease'
    );
    assert.strictEqual(runner.thinkingActivities.size, 0);
  } finally {
    clearInterval(keepAlive);
    if (!runner.overlayCleaned) runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyOverlayCleanupDoesNotWaitForRelayDelivery() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-runner-offline-stop-'));
  let releasePost = null;
  const blockedPost = new Promise((resolve) => { releasePost = resolve; });
  const lifecycleRunner = new CodexAppServerRunner({
    hostId: 'host-offline-stop',
    sessionId: 'session-offline-stop',
    runId: 'run-offline-stop',
    title: 'Offline Stop test',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'offline-stop', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async () => blockedPost,
  });
  const overlayRoot = lifecycleRunner.profileHomeDir;
  const child = new EventEmitter();
  child.pid = 830001;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  lifecycleRunner.child = child;
  lifecycleRunner.startCompleted = true;
  child.once('exit', (code, signal) => {
    lifecycleRunner.handleExit(code, signal).catch(() => {});
  });

  const stopping = lifecycleRunner.stop({ suppressTerminalEvent: true });
  await new Promise((resolve) => setImmediate(resolve));
  const cleanedBeforeRelayDelivery = !fs.existsSync(overlayRoot);
  releasePost();
  await stopping;
  assert.strictEqual(
    cleanedBeforeRelayDelivery,
    true,
    'terminated runner auth overlay must be removed before a blocked Relay notification completes'
  );
  fs.rmSync(baseHome, { recursive: true, force: true });
}

async function verifyManagedOverlayCleanupRetriesAfterFailure() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-cleanup-retry-'));
  const runner = new CodexAppServerRunner({
    hostId: 'host-cleanup-retry',
    sessionId: 'session-cleanup-retry',
    runId: 'run-cleanup-retry',
    title: 'Cleanup retry',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'cleanup-retry', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async () => {},
  });
  const overlayRoot = runner.profileHomeDir;
  const originalRmSync = fs.rmSync;
  let attempts = 0;
  fs.rmSync = function failFirstOwnedOverlayRemoval(target, options) {
    if (path.resolve(String(target)) === path.resolve(overlayRoot) && attempts++ === 0) {
      const error = new Error('simulated owned overlay removal failure');
      error.code = 'EPERM';
      throw error;
    }
    return originalRmSync.call(fs, target, options);
  };
  try {
    assert.throws(() => runner.cleanupManagedOverlay(), /simulated owned overlay removal failure/);
    assert.strictEqual(runner.overlayCleaned, false, 'a failed removal must remain retryable');
    assert.strictEqual(fs.existsSync(path.join(runner.codexHome, 'auth.json')), true);
    assert.strictEqual(runner.cleanupManagedOverlay(), true, 'a later cleanup attempt must remove the owned overlay');
    assert.strictEqual(runner.overlayCleaned, true);
    assert.strictEqual(fs.existsSync(overlayRoot), false);
  } finally {
    fs.rmSync = originalRmSync;
    originalRmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyOwnerMarkerAtomicUpdatePreservesAuthoritativeMarker() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-marker-atomic-update-'));
  const overlay = prepareApiProfileCodexHome(baseHome, {
    profileId: 'marker-atomic-update',
    provider: 'OpenAI',
    apiKey: 'marker-atomic-secret',
  }, { sessionId: 'marker-atomic-update', runId: 'run-marker-atomic-update' });
  const markerPath = overlay.cleanupOwner.ownerMarkerPath;
  const originalMarker = fs.readFileSync(markerPath, 'utf8');
  const originalWriteSync = fs.writeSync;
  let injected = false;
  fs.writeSync = function partiallyWriteMarkerTemp(fd, buffer, offset, length, position) {
    if (!injected) {
      injected = true;
      const writeLength = Math.max(1, Math.floor(Number(length || buffer.length) / 2));
      originalWriteSync.call(fs, fd, buffer, Number(offset || 0), writeLength, position);
      const error = new Error('simulated partial owner-marker temp write failure');
      error.code = 'ENOSPC';
      throw error;
    }
    return originalWriteSync.call(fs, fd, buffer, offset, length, position);
  };
  try {
    assert.throws(
      () => updateApiProfileCodexHomeOwnership(overlay.cleanupOwner, {
        childPid: 870001,
        childState: 'running',
      }),
      /partial owner-marker temp write failure/
    );
    assert.strictEqual(injected, true);
    assert.strictEqual(
      fs.readFileSync(markerPath, 'utf8'),
      originalMarker,
      'failed temp write must not truncate or replace the authoritative owner marker'
    );
    assert.strictEqual(JSON.parse(originalMarker).childState, 'not-started');
    assert.deepStrictEqual(
      fs.readdirSync(overlay.profileHomeDir).filter((name) => /\.tmp$/i.test(name)),
      [],
      'failed owner-marker temp files must be cleaned best effort'
    );
  } finally {
    fs.writeSync = originalWriteSync;
    assert.strictEqual(cleanupApiProfileCodexHome(overlay.cleanupOwner), true);
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyOwnershipUpdateFailureStillFinalizesRunner() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-owner-update-failure-'));
  const events = [];
  let terminated = 0;
  const runner = new CodexAppServerRunner({
    hostId: 'host-owner-update-failure',
    sessionId: 'session-owner-update-failure',
    runId: 'run-owner-update-failure',
    title: 'Owner update failure',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'owner-update-failure', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async (event) => events.push(event),
    onTerminated: () => { terminated += 1; },
  });
  runner.child = { pid: 830101 };
  const overlayRoot = runner.profileHomeDir;
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function failOwnerMarkerUpdate(source, target) {
    if (path.resolve(String(target)) === path.resolve(runner.apiProfileCleanupOwner.ownerMarkerPath)) {
      const error = new Error('simulated owner marker update failure');
      error.code = 'ENOSPC';
      throw error;
    }
    return originalRenameSync.call(fs, source, target);
  };
  try {
    await assert.doesNotReject(() => runner.handleExit(1, null));
    assert.strictEqual(terminated, 1, 'ownership metadata failure must not skip onTerminated');
    assert.deepStrictEqual(
      events.filter((event) => event.type === 'session.state_changed').map((event) => event.state),
      ['exited:1:null'],
      'ownership metadata failure must not skip the authoritative terminal event'
    );
    assert.strictEqual(fs.existsSync(overlayRoot), false, 'owned credentials must still be removed');
  } finally {
    fs.renameSync = originalRenameSync;
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyCodexTerminalDeliveryFailureRequestsCommandRetry() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-codex-terminal-retry-'));
  const runner = new CodexAppServerRunner({
    hostId: 'host-codex-terminal-retry',
    sessionId: 'session-codex-terminal-retry',
    runId: 'run-codex-terminal-retry',
    title: 'Codex terminal retry',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'codex-terminal-retry', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async (event) => {
      if (event.type === 'session.activity_snapshot') {
        throw new Error('simulated activity snapshot delivery failure');
      }
      if (event.type === 'session.state_changed') {
        throw new Error('simulated terminal state delivery failure');
      }
    },
  });
  const child = new EventEmitter();
  child.pid = 830103;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    });
    return true;
  };
  runner.child = child;
  runner.startCompleted = true;
  child.once('exit', (code, signal) => runner.handleExit(code, signal).catch(() => {}));
  try {
    runner.appendThinkingDelta({
      turnId: 'turn-codex-terminal-retry',
      itemId: 'reasoning-codex-terminal-retry',
    }, 'cached delivery failure');
    await assert.rejects(
      runner.stop(),
      (error) => error?.retryCommand === true,
      'Codex stop must retry the command when final activity or terminal state delivery fails'
    );
    await assert.doesNotReject(
      () => runner.stop({ suppressTerminalEvent: true }),
      'ownership loss must ignore cached Agent-event delivery failures after child exit'
    );
    assert.strictEqual(runner.thinkingActivities.size, 0);
    assert.strictEqual(runner.activitySnapshotDeliveryErrors.size, 0);
    assert.strictEqual(runner.overlayCleaned, true);
  } finally {
    if (!runner.overlayCleaned) runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyCodexStopTimeoutPreservesLiveChildOverlay() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-runner-stop-timeout-'));
  const events = [];
  let terminated = 0;
  const runner = new CodexAppServerRunner({
    hostId: 'host-stop-timeout',
    sessionId: 'session-stop-timeout',
    runId: 'run-stop-timeout',
    title: 'Stop timeout',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'stop-timeout', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async (event) => events.push(event),
    onTerminated: () => { terminated += 1; },
    stopGraceTimeoutMs: 5,
    stopKillTimeoutMs: 5,
  });
  const child = new EventEmitter();
  child.pid = 830102;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  runner.child = child;
  runner.startCompleted = true;
  child.once('exit', (code, signal) => runner.handleExit(code, signal).catch(() => {}));
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      runner.stop(),
      (error) => error?.code === 'session_stop_timeout' && error.processTreeFallbackRequired === true,
      'an unconfirmed process exit must request process-tree fallback'
    );
    assert.strictEqual(terminated, 0, 'stop timeout must not claim that a live child terminated');
    assert.deepStrictEqual(events.filter((event) => event.type === 'session.state_changed'), []);
    assert.strictEqual(
      fs.existsSync(path.join(runner.codexHome, 'auth.json')),
      true,
      'stop timeout must preserve credentials still in use by the live child'
    );
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    await runner.handleExit(null, 'SIGKILL');
    assert.strictEqual(fs.existsSync(runner.profileHomeDir), false);
  } finally {
    clearInterval(keepAlive);
    if (!runner.overlayCleaned) runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyConstructorFailureRemovesOwnedOverlay() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-constructor-failure-'));
  const managedRoot = path.join(baseHome, '.remote-codex-managed');
  fs.mkdirSync(path.join(baseHome, 'installation_id'));
  try {
    await assert.rejects(
      startCodexAppServerSession({
        hostId: 'host-constructor-failure',
        sessionId: 'session-constructor-failure',
        runId: 'run-constructor-failure',
        title: 'Constructor failure',
        cwd: process.cwd(),
        codexHome: baseHome,
        apiConfig: {
          profileId: 'constructor-failure',
          provider: 'OpenAI',
          apiKey: 'constructor-secret-must-not-remain',
        },
        postEvent: async () => {},
      }),
      /directory|EISDIR|EPERM|invalid/i
    );
    const entries = fs.existsSync(managedRoot) ? fs.readdirSync(managedRoot) : [];
    assert.deepStrictEqual(entries, [], 'constructor failure must remove its newly owned overlay');
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyPostOverlayConstructorFailureRemovesCredentials() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-post-overlay-constructor-failure-'));
  const managedRoot = path.join(baseHome, '.remote-codex-managed');
  const badArg = {
    toString() {
      throw new Error('simulated post-overlay constructor failure');
    },
  };
  try {
    await assert.rejects(
      startCodexAppServerSession({
        hostId: 'host-post-overlay-constructor-failure',
        sessionId: 'session-post-overlay-constructor-failure',
        runId: 'run-post-overlay-constructor-failure',
        title: 'Post-overlay constructor failure',
        cwd: process.cwd(),
        codexHome: baseHome,
        codexArgs: [badArg],
        apiConfig: {
          profileId: 'post-overlay-constructor-failure',
          provider: 'OpenAI',
          apiKey: 'post-overlay-constructor-secret-must-not-remain',
        },
        postEvent: async () => {},
      }),
      /simulated post-overlay constructor failure/
    );
    const entries = fs.existsSync(managedRoot) ? fs.readdirSync(managedRoot) : [];
    assert.deepStrictEqual(
      entries,
      [],
      'constructor exceptions after overlay creation must remove the owned credential directory'
    );
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifySqliteOpenFailurePreservesFilesAndRawStartupError() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-sqlite-open-failure-'));
  const rawStderr = 'codex_app_server: failed to initialize SQLite state runtime: database error: (code: 14) unable to open database file';
  const originalError = new Error('codex app-server exited early: 1 / null');
  const runner = new CodexAppServerRunner({
    hostId: 'host-sqlite-open-failure',
    sessionId: 'session-sqlite-open-failure',
    runId: 'run-sqlite-open-failure',
    title: 'SQLite open failure',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'sqlite-open-failure', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async () => {},
  });
  const statePath = path.join(runner.codexHome, 'state_5.sqlite');
  fs.writeFileSync(statePath, 'valid state placeholder that must not be quarantined', 'utf8');
  let attempts = 0;
  runner.startOnce = async function simulateSqliteOpenFailure() {
    attempts += 1;
    this.startupStateDbDiagnostic = buildCodexStateDatabaseDiagnostic(rawStderr, this.codexHome);
    throw originalError;
  };
  try {
    await assert.rejects(
      runner.start(),
      (error) => (
        error?.code === 'session_sqlite_open_failed'
        && error?.cause === originalError
        && error?.rawStderr === rawStderr
        && error?.sqliteFailureKind === 'open-create'
        && /existing SQLite files were left untouched/.test(error?.message || '')
      ),
      'open/create failures must retain raw stderr and the original startup failure without claiming corruption'
    );
    assert.strictEqual(attempts, 1, 'a non-corruption SQLite failure must not trigger the quarantine retry');
    assert.strictEqual(fs.existsSync(statePath), true, 'a non-corruption SQLite failure must not move state files');
    assert.deepStrictEqual(
      fs.readdirSync(runner.codexHome).filter((entry) => entry.startsWith('broken-sqlite-backup-')),
      [],
      'a non-corruption SQLite failure must not create a quarantine directory'
    );
  } finally {
    if (!runner.overlayCleaned) runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifySqliteStartupRetryStopsFirstChildBeforeReuse() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-sqlite-retry-child-'));
  const runner = new CodexAppServerRunner({
    hostId: 'host-sqlite-retry-child',
    sessionId: 'session-sqlite-retry-child',
    runId: 'run-sqlite-retry-child',
    title: 'SQLite retry child',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'sqlite-retry-child', provider: 'OpenAI', apiKey: 'secret' },
    stopGraceTimeoutMs: 1000,
    stopKillTimeoutMs: 1000,
    postEvent: async () => {},
  });
  const firstChild = new EventEmitter();
  firstChild.pid = 830105;
  firstChild.exitCode = null;
  firstChild.signalCode = null;
  firstChild.killed = false;
  let firstChildExited = false;
  let killCalls = 0;
  firstChild.kill = () => {
    killCalls += 1;
    firstChild.killed = true;
    queueMicrotask(() => {
      firstChild.signalCode = 'SIGTERM';
      firstChild.emit('exit', null, 'SIGTERM');
    });
    return true;
  };
  firstChild.once('exit', (code, signal) => {
    firstChildExited = true;
    runner.handleExit(code, signal).catch(() => {});
  });
  fs.writeFileSync(path.join(runner.codexHome, 'state_1.sqlite'), 'corrupt sqlite fixture', 'utf8');
  let attempts = 0;
  runner.startOnce = async function simulateSqliteRetry() {
    attempts += 1;
    if (attempts === 1) {
      this.child = firstChild;
      this.rpc = { attempt: 1 };
      this.startupStateDbCorruption = true;
      throw new Error('simulated Codex SQLite startup failure');
    }
    assert.strictEqual(firstChildExited, true, 'SQLite retry must confirm the first child exit');
    assert(killCalls >= 1, 'SQLite retry must actively stop a still-live first child');
    assert.strictEqual(this.child, null);
    assert.strictEqual(this.rpc, null);
    assert.strictEqual(this.terminationPromise, null, 'retry must not reuse an overlay already finalized');
    assert.strictEqual(this.overlayCleaned, false);
    assert.strictEqual(fs.existsSync(path.join(this.codexHome, 'auth.json')), true);
  };
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await runner.start();
    assert.strictEqual(attempts, 2);
    assert.strictEqual(runner.startCompleted, true);
  } finally {
    clearInterval(keepAlive);
    if (!runner.overlayCleaned) runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifySqliteRetryTimeoutRequiresTrackedCommandRetry() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-sqlite-retry-timeout-'));
  const child = new EventEmitter();
  child.pid = 830107;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    child.killed = true;
    return true;
  };
  const command = {
    sessionId: 'session-sqlite-retry-timeout',
    runId: 'run-sqlite-retry-timeout',
  };
  let runner = null;
  let attempts = 0;
  let failure = null;
  const postedEvents = [];
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await startCodexAppServerSession({
      hostId: 'host-sqlite-retry-timeout',
      ...command,
      title: 'SQLite retry timeout',
      cwd: process.cwd(),
      codexHome: baseHome,
      apiConfig: { profileId: 'sqlite-retry-timeout', provider: 'OpenAI', apiKey: 'secret' },
      stopGraceTimeoutMs: 5,
      stopKillTimeoutMs: 5,
      postEvent: async (event) => postedEvents.push(event),
      onRunnerCreated(createdRunner) {
        runner = createdRunner;
        fs.writeFileSync(path.join(runner.codexHome, 'state_1.sqlite'), 'corrupt sqlite fixture', 'utf8');
        runner.startOnce = async function simulateUnkillableSqliteRetryChild() {
          attempts += 1;
          this.child = child;
          this.rpc = { attempt: attempts };
          this.startupStateDbCorruption = true;
          throw new Error('simulated Codex SQLite startup failure with live child');
        };
      },
    }).catch((error) => {
      failure = error;
    });

    assert(runner);
    assert(failure, 'an unconfirmed first child exit must reject startup');
    assert.strictEqual(failure.processTreeFallbackRequired, true);
    assert.strictEqual(
      failure.retryCommand,
      true,
      'SQLite retry stop timeout must leave the durable start command unacknowledged'
    );
    assert.strictEqual(attempts, 1, 'the credential overlay must not be reused for a second child');
    assert(killCalls >= 2, 'SQLite retry must attempt TERM and KILL before requiring tree fallback');
    assert.strictEqual(runner.startRetryPending, true);
    assert.strictEqual(runner.child, child);
    assert.strictEqual(runner.childExitConfirmed, false);
    assert.strictEqual(runner.overlayCleaned, false);
    assert.strictEqual(
      fs.existsSync(path.join(runner.codexHome, 'auth.json')),
      true,
      'credentials must remain owned and tracked while the old child may still be using them'
    );

    const liveSessions = new Map();
    assert.strictEqual(
      managedLifecycle.retainRunnerForStartRetry(liveSessions, runner, command, failure),
      true
    );
    assert.strictEqual(liveSessions.get(command.sessionId), runner);
    assert.strictEqual(liveSessions.get(command.runId), runner);
    const startedBeforeReplay = postedEvents.filter((event) => event.type === 'session.started').length;
    await assert.rejects(
      managedLifecycle.replayManagedSessionStart({
        liveSessions,
        command,
        hostId: 'host-sqlite-retry-timeout',
        postEvent: async (event) => postedEvents.push(event),
      }),
      (error) => error?.retryCommand === true && error?.processTreeFallbackRequired === true,
      'replayed start must remain pending instead of confirming an unstarted runner'
    );
    assert.strictEqual(
      postedEvents.filter((event) => event.type === 'session.started').length,
      startedBeforeReplay,
      'a tracked fallback runner must never publish session.started'
    );

    const exits = [];
    const shutdown = managedLifecycle.createManagedSessionShutdown({
      liveSessions,
      exit: (code) => exits.push(code),
      graceTimeoutMs: 1000,
    });
    const shutdownResult = await shutdown('SIGTERM');
    assert.strictEqual(shutdownResult.timedOut, false);
    assert.strictEqual(shutdownResult.errors.length, 1);
    assert.deepStrictEqual(
      exits,
      [],
      'the tracked live child must force Relay/launcher process-tree fallback instead of Host exit(0)'
    );
    assert.strictEqual(fs.existsSync(runner.profileHomeDir), true);
  } finally {
    clearInterval(keepAlive);
    if (runner && !runner.childExitConfirmed) {
      child.signalCode = 'SIGKILL';
      await runner.handleExit(null, 'SIGKILL').catch(() => {});
    }
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifySqliteRetryExitWaiterSurvivesConcurrentShutdown() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-sqlite-retry-shutdown-'));
  const runner = new CodexAppServerRunner({
    hostId: 'host-sqlite-retry-shutdown',
    sessionId: 'session-sqlite-retry-shutdown',
    runId: 'run-sqlite-retry-shutdown',
    title: 'SQLite retry shutdown',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'sqlite-retry-shutdown', provider: 'OpenAI', apiKey: 'secret' },
    stopGraceTimeoutMs: 20,
    stopKillTimeoutMs: 20,
    postEvent: async () => {},
  });
  const child = new EventEmitter();
  child.pid = 830106;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  let exitScheduled = false;
  child.kill = () => {
    child.killed = true;
    if (!exitScheduled) {
      exitScheduled = true;
      queueMicrotask(() => {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      });
    }
    return true;
  };
  runner.child = child;
  runner.startupStateDbCorruption = true;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const retryStop = runner.stopChildForStartupRetry();
    const shutdownStop = runner.stop({ suppressTerminalEvent: true });
    await assert.rejects(
      retryStop,
      (error) => error?.code === 'session_start_retry_overlay_finalized',
      'concurrent shutdown must wake the retry waiter and reject overlay reuse without timing out'
    );
    await shutdownStop;
    assert.strictEqual(runner.overlayCleaned, true);
  } finally {
    clearInterval(keepAlive);
    if (!runner.overlayCleaned && (!runner.child || runner.childExitConfirmed)) {
      runner.cleanupManagedOverlay();
    }
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyPreSpawnCodexCancellationPublishesTerminalFailure() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-pre-spawn-cancel-'));
  const events = [];
  let firstStop = null;
  let createdRunner = null;
  let terminated = 0;
  try {
    await assert.rejects(
      startCodexAppServerSession({
        hostId: 'host-pre-spawn-cancel',
        sessionId: 'session-pre-spawn-cancel',
        runId: 'run-pre-spawn-cancel',
        title: 'Pre-spawn cancellation',
        cwd: process.cwd(),
        codexHome: baseHome,
        apiConfig: { profileId: 'pre-spawn-cancel', provider: 'OpenAI', apiKey: 'secret' },
        postEvent: async (event) => events.push(event),
        onTerminated: () => { terminated += 1; },
        onRunnerCreated(runner) {
          createdRunner = runner;
          firstStop = runner.stop();
          const error = new Error('Host Agent began shutdown before spawn.');
          error.code = 'host_agent_shutting_down';
          throw error;
        },
      }),
      (error) => error?.code === 'host_agent_shutting_down'
    );
    assert.strictEqual(
      createdRunner.stopPromise,
      firstStop,
      'startup rejection cleanup must join the shutdown stop already in flight'
    );
    await firstStop;
    assert.deepStrictEqual(
      events.filter((event) => event.type === 'session.state_changed').map((event) => event.state),
      ['failed:start-cancelled'],
      'pre-spawn cancellation must publish one authoritative terminal failure'
    );
    assert.strictEqual(terminated, 1, 'pre-spawn cancellation must finalize the runner once');
    assert.strictEqual(createdRunner.overlayCleaned, true);
    assert.strictEqual(fs.existsSync(createdRunner.profileHomeDir), false);
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyIntentionalProcessStopIsSingleTerminalOutcome() {
  const events = [];
  let terminated = 0;
  const processRunner = await startManagedRuntimeSession({
    runtime: {
      kind: 'process',
      runtimeId: 'process:test-stop',
      label: 'Process stop test',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    },
    hostId: 'host-process-stop',
    sessionId: 'session-process-stop',
    runId: 'run-process-stop',
    cwd: process.cwd(),
    title: 'Process stop test',
    postEvent: async (event) => events.push(event),
    onTerminated: () => { terminated += 1; },
  });
  await processRunner.stop();
  assert.deepStrictEqual(
    events.filter((event) => event.type === 'session.state_changed').map((event) => event.state),
    ['history-only']
  );
  assert.strictEqual(terminated, 1);
}

async function verifyProcessStopSuppressionUpgradesMonotonically() {
  const child = makeFakeManagedChild(850004);
  const events = [];
  const runner = await startManagedRuntimeSession({
    runtime: {
      kind: 'process',
      runtimeId: 'process:suppression-upgrade',
      label: 'Process suppression upgrade',
      command: 'unused-test-command',
      args: [],
    },
    hostId: 'host-process-suppression-upgrade',
    sessionId: 'session-process-suppression-upgrade',
    runId: 'run-process-suppression-upgrade',
    cwd: process.cwd(),
    title: 'Process suppression upgrade',
    spawnProcess: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    stopGraceTimeoutMs: 1000,
    stopKillTimeoutMs: 1000,
    postEvent: async (event) => events.push(event),
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const ordinaryStop = runner.stop();
    await new Promise((resolve) => setImmediate(resolve));
    const ownershipRevokedStop = runner.stop({ suppressTerminalEvent: true });
    assert.strictEqual(
      ownershipRevokedStop,
      ordinaryStop,
      'concurrent process stop callers must share one child termination operation'
    );
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    await Promise.all([ordinaryStop, ownershipRevokedStop]);
    assert.strictEqual(runner.suppressTerminalEvent, true);
    assert.deepStrictEqual(
      events.filter((event) => event.type === 'session.state_changed'),
      []
    );
  } finally {
    clearInterval(keepAlive);
  }
}

async function verifyProcessSpawnHandshakeRejectsMissingExecutable() {
  const events = [];
  let createdRunner = null;
  const missingCommand = path.join(
    os.tmpdir(),
    `remote-codex-command-that-does-not-exist-${process.pid}-${Date.now()}`
  );
  await assert.rejects(
    startManagedRuntimeSession({
      runtime: {
        kind: 'process',
        runtimeId: 'process:missing',
        label: 'Missing process',
        command: missingCommand,
        args: [],
      },
      hostId: 'host-process-missing',
      sessionId: 'session-process-missing',
      runId: 'run-process-missing',
      cwd: process.cwd(),
      title: 'Missing process',
      postEvent: async (event) => events.push(event),
      onRunnerCreated: (runner) => { createdRunner = runner; },
    }),
    (error) => error?.code === 'ENOENT' || /spawn|not found/i.test(error?.message || ''),
    'managed process startup must reject before a dead runner can be announced as started'
  );
  assert(createdRunner, 'the shutdown gate must own the runner before spawn begins');
}

async function verifySynchronousProcessSpawnFailureDefersTerminalToCommandOwner() {
  const events = [];
  let createdRunner = null;
  const spawnError = new Error('simulated synchronous process spawn failure');
  spawnError.code = 'ENOENT';
  await assert.rejects(
    startManagedRuntimeSession({
      runtime: {
        kind: 'process',
        runtimeId: 'process:sync-spawn-failure',
        label: 'Synchronous spawn failure',
        command: 'unused-test-command',
        args: [],
      },
      hostId: 'host-process-sync-spawn-failure',
      sessionId: 'session-process-sync-spawn-failure',
      runId: 'run-process-sync-spawn-failure',
      cwd: process.cwd(),
      title: 'Synchronous spawn failure',
      spawnProcess: () => { throw spawnError; },
      postEvent: async (event) => events.push(event),
      onRunnerCreated: (runner) => { createdRunner = runner; },
    }),
    (error) => error === spawnError
  );
  assert(createdRunner);
  assert.deepStrictEqual(
    events.filter((event) => event.type === 'session.state_changed'),
    [],
    'synchronous spawn failure must leave the unique terminal state to the start command owner'
  );
}

function makeFakeManagedChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

async function verifyManagedProcessSpawnCredentialIsolation() {
  const inheritedValues = {
    OPENAI_API_KEY: 'inherited-key-must-not-leak',
    OPENAI_BASE_URL: 'https://inherited.example/v1',
    OPENAI_ORGANIZATION: 'inherited-org-must-not-leak',
    REMOTE_CODEX_ENV_SENTINEL: 'preserved',
  };
  const previousValues = new Map(Object.keys(inheritedValues).map((name) => [
    name,
    {
      present: Object.prototype.hasOwnProperty.call(process.env, name),
      value: process.env[name],
    },
  ]));
  Object.assign(process.env, inheritedValues);

  const captureSpawnEnvironment = async (apiConfig, pid) => {
    const child = makeFakeManagedChild(pid);
    let capturedEnvironment = null;
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true;
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      });
      return true;
    };
    const runner = await startManagedRuntimeSession({
      runtime: {
        kind: 'process',
        runtimeId: `process:credential-isolation-${pid}`,
        label: 'Credential isolation test',
        command: 'unused-test-command',
        args: [],
      },
      hostId: 'host-credential-isolation',
      sessionId: `session-credential-isolation-${pid}`,
      runId: `run-credential-isolation-${pid}`,
      cwd: process.cwd(),
      title: 'Credential isolation test',
      apiConfig,
      spawnProcess: (_command, _args, options) => {
        capturedEnvironment = options.env;
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      postEvent: async () => {},
    });
    await runner.stop();
    return capturedEnvironment;
  };

  try {
    const explicitEnvironment = await captureSpawnEnvironment({
      profileId: 'spawn-isolated-profile',
      provider: 'OpenAI',
      baseUrl: 'https://explicit.example/v1',
      apiKey: 'explicit-key',
    }, 850101);
    assert.strictEqual(explicitEnvironment.OPENAI_API_KEY, 'explicit-key');
    assert.strictEqual(explicitEnvironment.OPENAI_BASE_URL, 'https://explicit.example/v1');
    assert.strictEqual(explicitEnvironment.OPENAI_API_BASE, 'https://explicit.example/v1');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(explicitEnvironment, 'OPENAI_ORGANIZATION'), false);
    assert.strictEqual(explicitEnvironment.REMOTE_CODEX_ENV_SENTINEL, 'preserved');

    const hostEnvironment = await captureSpawnEnvironment(null, 850102);
    assert.strictEqual(hostEnvironment.OPENAI_API_KEY, inheritedValues.OPENAI_API_KEY);
    assert.strictEqual(hostEnvironment.OPENAI_BASE_URL, inheritedValues.OPENAI_BASE_URL);
    assert.strictEqual(hostEnvironment.OPENAI_ORGANIZATION, inheritedValues.OPENAI_ORGANIZATION);
    assert.strictEqual(hostEnvironment.REMOTE_CODEX_ENV_SENTINEL, 'preserved');
  } finally {
    for (const [name, previous] of previousValues) {
      if (previous.present) {
        process.env[name] = previous.value;
      } else {
        delete process.env[name];
      }
    }
  }
}

async function verifyRuntimeErrorDeliveryFailureDoesNotBlockTerminalState() {
  const child = makeFakeManagedChild(850001);
  const stateEvents = [];
  let errorAttempts = 0;
  let terminated = 0;
  const runnerPromise = startManagedRuntimeSession({
    runtime: {
      kind: 'process',
      runtimeId: 'process:error-delivery',
      label: 'Runtime error delivery',
      command: 'unused-test-command',
      args: [],
    },
    hostId: 'host-runtime-error-delivery',
    sessionId: 'session-runtime-error-delivery',
    runId: 'run-runtime-error-delivery',
    cwd: process.cwd(),
    title: 'Runtime error delivery',
    spawnProcess: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    postEvent: async (event) => {
      if (event.type === 'session.error') {
        errorAttempts += 1;
        throw new Error('simulated Relay error-delivery outage');
      }
      if (event.type === 'session.state_changed') stateEvents.push(event);
    },
    onTerminated: () => { terminated += 1; },
  });
  const runner = await runnerPromise;
  child.emit('error', new Error('simulated managed runtime failure'));
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(errorAttempts, 1);
  assert.deepStrictEqual(
    stateEvents.map((event) => event.state),
    ['failed:runtime-error'],
    'runtime error delivery failure must not block the authoritative terminal state'
  );
  assert.strictEqual(terminated, 1);
  await runner.stop();
}

async function verifyProcessTerminalDeliveryFailureRequestsCommandRetry() {
  const child = makeFakeManagedChild(850003);
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    });
    return true;
  };
  const runner = await startManagedRuntimeSession({
    runtime: {
      kind: 'process',
      runtimeId: 'process:terminal-retry',
      label: 'Process terminal retry',
      command: 'unused-test-command',
      args: [],
    },
    hostId: 'host-process-terminal-retry',
    sessionId: 'session-process-terminal-retry',
    runId: 'run-process-terminal-retry',
    cwd: process.cwd(),
    title: 'Process terminal retry',
    spawnProcess: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    postEvent: async (event) => {
      if (event.type === 'session.state_changed') {
        throw new Error('simulated process terminal delivery failure');
      }
    },
  });
  let unhandledRejection = null;
  const onUnhandledRejection = (error) => { unhandledRejection = error; };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(
      runner.stop(),
      (error) => error?.retryCommand === true && /process terminal delivery failure/.test(error.message),
      'process stop must reject with retryCommand when its terminal state is not delivered'
    );
    await assert.doesNotReject(
      () => runner.stop({ suppressTerminalEvent: true }),
      'ownership loss must recover a childless process runner from stale terminal delivery failure'
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(
      unhandledRejection,
      null,
      'child exit listener must observe terminalPromise rejection without hiding it from runner.stop'
    );
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
}

async function verifyProcessStopTimeoutDoesNotFabricateExit() {
  const child = makeFakeManagedChild(850002);
  const states = [];
  let terminated = 0;
  const runner = await startManagedRuntimeSession({
    runtime: {
      kind: 'process',
      runtimeId: 'process:stop-timeout',
      label: 'Process stop timeout',
      command: 'unused-test-command',
      args: [],
    },
    hostId: 'host-process-stop-timeout',
    sessionId: 'session-process-stop-timeout',
    runId: 'run-process-stop-timeout',
    cwd: process.cwd(),
    title: 'Process stop timeout',
    spawnProcess: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    stopGraceTimeoutMs: 5,
    stopKillTimeoutMs: 5,
    postEvent: async (event) => {
      if (event.type === 'session.state_changed') states.push(event.state);
    },
    onTerminated: () => { terminated += 1; },
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      runner.stop(),
      (error) => error?.code === 'session_stop_timeout' && error.processTreeFallbackRequired === true
    );
    assert.deepStrictEqual(states, [], 'stop timeout must not fabricate a terminal state');
    assert.strictEqual(terminated, 0, 'stop timeout must not claim the child exited');

    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(states, ['history-only']);
    assert.strictEqual(terminated, 1);
  } finally {
    clearInterval(keepAlive);
  }
}

async function verifyRejectedStartAbortsOrphanRunner() {
  const stopCalls = [];
  await managedLifecycle.abortUnconfirmedRunner({
    async stop(options) {
      stopCalls.push(options);
    },
  });
  assert.deepStrictEqual(stopCalls, [{ suppressTerminalEvent: true }]);
}

async function verifyUniqueRunnerShutdownIsParallel() {
  const calls = [];
  const releases = [];
  const makeRunner = (name) => ({
    async stop(options) {
      calls.push({ name, options });
      await new Promise((resolve) => releases.push(resolve));
    },
  });
  const first = makeRunner('first');
  const second = makeRunner('second');
  const indexedRunners = new Map([
    ['first-session', first],
    ['first-run', first],
    ['second-session', second],
    ['second-run', second],
  ]);

  const stopping = managedLifecycle.stopUniqueLiveRunners(indexedRunners, {
    suppressTerminalEvent: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(
    calls.map((entry) => entry.name).sort(),
    ['first', 'second'],
    'shutdown must start every unique runner stop without waiting for an earlier runner'
  );
  assert.deepStrictEqual(
    calls.map((entry) => entry.options),
    [{ suppressTerminalEvent: true }, { suppressTerminalEvent: true }]
  );
  releases.splice(0).forEach((resolve) => resolve());
  const result = await stopping;
  assert.strictEqual(result.runnerCount, 2);
  assert.deepStrictEqual(result.errors, []);
}

async function verifyManagedSessionShutdownWaitsBeforeExit() {
  const calls = [];
  const releases = [];
  const makeRunner = (name) => ({
    async stop(options) {
      calls.push({ name, options });
      await new Promise((resolve) => releases.push(resolve));
    },
  });
  const first = makeRunner('first');
  const second = makeRunner('second');
  const live = new Map([
    ['first-session', first],
    ['first-run', first],
    ['second-session', second],
  ]);
  let inventoryStops = 0;
  const exits = [];
  const shutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: live,
    stopInventory: () => { inventoryStops += 1; },
    exit: (code) => exits.push(code),
    graceTimeoutMs: 1000,
  });

  const firstSignal = shutdown('SIGTERM');
  const repeatedSignal = shutdown('SIGINT');
  assert.strictEqual(firstSignal, repeatedSignal, 'repeated signals must share the in-flight shutdown');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(inventoryStops, 1);
  assert.deepStrictEqual(calls.map((entry) => entry.name).sort(), ['first', 'second']);
  assert.deepStrictEqual(exits, [], 'Host must not exit while runner cleanup is still pending');
  releases.splice(0).forEach((resolve) => resolve());
  const result = await firstSignal;
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.runnerCount, 2);
  assert.deepStrictEqual(exits, [0]);

  const timeoutExits = [];
  let releaseTimedStop;
  let timedStopCalls = 0;
  const timedRunner = {
    async stop() {
      timedStopCalls += 1;
      await new Promise((resolve) => { releaseTimedStop = resolve; });
    },
  };
  const timedShutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map([['stuck', timedRunner]]),
    exit: (code) => timeoutExits.push(code),
    graceTimeoutMs: 10,
  });
  const timedResult = await timedShutdown('SIGTERM');
  assert.strictEqual(timedResult.timedOut, true, 'Host shutdown needs a bounded grace timeout');
  assert.deepStrictEqual(
    timeoutExits,
    [],
    'a timed-out shutdown must keep the Agent root alive for process-tree fallback'
  );
  assert.strictEqual(timedStopCalls, 1);
  const retryAfterTimeout = timedShutdown('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    timedStopCalls,
    1,
    'a retry after the grace timeout must wait for the original runner.stop instead of overlapping it'
  );
  releaseTimedStop();
  const retryAfterTimeoutResult = await retryAfterTimeout;
  assert.strictEqual(retryAfterTimeoutResult.timedOut, false);
  assert.deepStrictEqual(timeoutExits, [0]);

  const failedExits = [];
  const failedShutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map([['failed-stop', {
      async stop() {
        const error = new Error('runner did not confirm exit');
        error.code = 'session_stop_timeout';
        throw error;
      },
    }]]),
    exit: (code) => failedExits.push(code),
    graceTimeoutMs: 1000,
  });
  const failedResult = await failedShutdown('SIGTERM');
  assert.strictEqual(failedResult.timedOut, false);
  assert.strictEqual(failedResult.errors.length, 1);
  assert.deepStrictEqual(
    failedExits,
    [],
    'runner stop errors must keep the Agent root alive for Relay/launcher tree fallback'
  );

  let retryStopAttempts = 0;
  const retryExits = [];
  const retryShutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map([['retry-stop', {
      async stop() {
        retryStopAttempts += 1;
        if (retryStopAttempts === 1) {
          throw new Error('first runner stop attempt failed');
        }
      },
    }]]),
    exit: (code) => retryExits.push(code),
    graceTimeoutMs: 1000,
  });
  const firstRetryResult = await retryShutdown('relay-command');
  assert.strictEqual(firstRetryResult.errors.length, 1);
  assert.deepStrictEqual(retryExits, []);
  const secondRetryResult = await retryShutdown('relay-command');
  assert.deepStrictEqual(secondRetryResult.errors, []);
  assert.strictEqual(retryStopAttempts, 2, 'a failed Host shutdown command must retry runner cleanup');
  assert.deepStrictEqual(retryExits, [0]);
}

async function verifyShutdownSuppressionUpgradeRestopsTrackedRunner() {
  const calls = [];
  let releaseFirstStop;
  const firstStopBlocked = new Promise((resolve) => { releaseFirstStop = resolve; });
  const runner = {
    suppressTerminalEvent: false,
    agentEventsSuppressed: false,
    applyStopOptions(options = {}) {
      if (options.suppressTerminalEvent === true || options.deferStartupTerminalEvent === true) {
        this.suppressTerminalEvent = true;
        this.agentEventsSuppressed = true;
      }
    },
    async stop(options) {
      calls.push({ ...options });
      if (calls.length === 1) await firstStopBlocked;
    },
  };
  const exits = [];
  const shutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map([['session-upgrade-stop', runner]]),
    exit: (code) => exits.push(code),
    graceTimeoutMs: 1000,
  });
  const stopping = shutdown('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(calls, [{}]);
  assert.strictEqual(typeof shutdown.upgradeStopOptions, 'function');
  const upgraded = shutdown.upgradeStopOptions({ suppressTerminalEvent: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(
    calls,
    [{}],
    'suppression upgrade must not overlap the runner stop already in flight'
  );
  assert.strictEqual(
    runner.suppressTerminalEvent,
    true,
    'suppression upgrade must still update the runner while its stop is pending'
  );
  assert.strictEqual(
    runner.agentEventsSuppressed,
    true,
    'suppression upgrade must invoke the runner-level no-more-events mode'
  );
  releaseFirstStop();
  await upgraded;
  const result = await stopping;
  assert.strictEqual(result.timedOut, false);
  assert.deepStrictEqual(exits, [0]);
}

async function verifyManagedSessionShutdownOwnsInFlightStarts() {
  const gate = managedLifecycle.createManagedSessionStartGate();
  const start = gate.beginStart();
  const stopCalls = [];
  const exits = [];
  const shutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map(),
    startGate: gate,
    exit: (code) => exits.push(code),
    graceTimeoutMs: 1000,
  });

  const stopping = shutdown('SIGTERM');
  assert.strictEqual(gate.isShuttingDown(), true, 'shutdown must close the start gate synchronously');
  assert.throws(
    () => start.assertCanSpawn(),
    (error) => error?.code === 'host_agent_shutting_down',
    'an accepted start still waiting on preparation must not spawn after shutdown begins'
  );
  assert.throws(
    () => gate.beginStart(),
    (error) => error?.code === 'host_agent_shutting_down',
    'a concurrent command or startup auto-start must not spawn after shutdown begins'
  );

  await new Promise((resolve) => setImmediate(resolve));
  start.setRunner({
    async stop(options) {
      stopCalls.push(options);
    },
  });
  start.finish();

  const result = await stopping;
  assert.strictEqual(result.timedOut, false);
  assert.deepStrictEqual(
    stopCalls,
    [{ deferStartupTerminalEvent: true }],
    'shutdown must defer an in-flight start terminal to the command owner'
  );
  assert.deepStrictEqual(exits, [0], 'Host must exit only after the in-flight runner is stopped');
}

async function verifyShutdownDefersPendingRunnerTerminalToCommandOwner() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-shutdown-terminal-owner-'));
  const states = [];
  const gate = managedLifecycle.createManagedSessionStartGate();
  const start = gate.beginStart();
  const runner = new CodexAppServerRunner({
    hostId: 'host-shutdown-terminal-owner',
    sessionId: 'session-shutdown-terminal-owner',
    runId: 'run-shutdown-terminal-owner',
    title: 'Shutdown terminal owner',
    cwd: process.cwd(),
    codexHome: baseHome,
    apiConfig: { profileId: 'shutdown-terminal-owner', provider: 'OpenAI', apiKey: 'secret' },
    postEvent: async (event) => {
      if (event.type === 'session.state_changed') states.push(event.state);
    },
  });
  runner.startCompleted = true;
  start.setRunner(runner);
  const exits = [];
  try {
    const shutdown = managedLifecycle.createManagedSessionShutdown({
      liveSessions: new Map([
        ['session-shutdown-terminal-owner', runner],
        ['run-shutdown-terminal-owner', runner],
      ]),
      startGate: gate,
      exit: (code) => exits.push(code),
      graceTimeoutMs: 1000,
    });
    const stopping = shutdown('SIGTERM');
    start.finish();
    const result = await stopping;
    assert.strictEqual(result.timedOut, false);
    assert.deepStrictEqual(states, [], 'runner must defer the pending-start terminal to its command owner');
    states.push('failed:host-shutdown');
    assert.deepStrictEqual(states, ['failed:host-shutdown'], 'shutdown cancellation must have one terminal state');
    assert.deepStrictEqual(exits, [0]);
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyShutdownWaitsForPendingStartTerminalDelivery() {
  const gate = managedLifecycle.createManagedSessionStartGate();
  const start = gate.beginStart();
  let stopCalls = 0;
  start.setRunner({
    async stop() {
      stopCalls += 1;
    },
  });
  const exits = [];
  const shutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map(),
    startGate: gate,
    exit: (code) => exits.push(code),
    graceTimeoutMs: 1000,
  });
  let settled = false;
  const stopping = shutdown('SIGTERM').then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(stopCalls, 1);
  assert.strictEqual(settled, false, 'shutdown must wait while the start owner delivers its terminal state');
  assert.deepStrictEqual(exits, [], 'Agent must remain alive until pending-start terminal delivery finishes');

  start.finish();
  const result = await stopping;
  assert.strictEqual(result.timedOut, false);
  assert.deepStrictEqual(exits, [0]);
}

async function verifyShutdownObservesPendingStartTerminalFailure() {
  const gate = managedLifecycle.createManagedSessionStartGate();
  const start = gate.beginStart();
  start.setRunner({ stop: async () => {} });
  const exits = [];
  const shutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map(),
    startGate: gate,
    exit: (code) => exits.push(code),
    graceTimeoutMs: 1000,
  });
  const stopping = shutdown('SIGTERM');
  const terminalError = new Error('simulated shutdown terminal delivery failure');
  terminalError.retryCommand = true;
  terminalError.shutdownTerminalDelivery = true;
  start.finish(terminalError);
  const result = await stopping;
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(result.errors.length, 1);
  assert.match(result.errors[0], /shutdown terminal delivery failure/);
  assert.deepStrictEqual(
    exits,
    [],
    'shutdown terminal delivery failure must keep the Host Agent alive for command retry'
  );
  const upgraded = await shutdown.upgradeStopOptions({ suppressTerminalEvent: true });
  assert.deepStrictEqual(
    upgraded.errors,
    [],
    'ownership loss must ignore the cached command-owner delivery error'
  );
  const ownershipResult = await shutdown('ownership-revoked');
  assert.deepStrictEqual(ownershipResult.errors, []);
  assert.deepStrictEqual(exits, [0]);
}

async function verifyShutdownIgnoresUnrelatedStartRetryFailure() {
  const gate = managedLifecycle.createManagedSessionStartGate();
  const start = gate.beginStart();
  start.setRunner({ stop: async () => {} });
  const exits = [];
  const shutdown = managedLifecycle.createManagedSessionShutdown({
    liveSessions: new Map(),
    startGate: gate,
    exit: (code) => exits.push(code),
    graceTimeoutMs: 1000,
  });
  const stopping = shutdown('SIGTERM');
  const unrelatedRetry = new Error('ordinary start command delivery retry');
  unrelatedRetry.retryCommand = true;
  start.finish(unrelatedRetry);
  const result = await stopping;
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(
    exits,
    [0],
    'ordinary command retry errors must not be reclassified as shutdown terminal failures'
  );
}

async function verifyAgentShutdownRemovesRunnerAuthOverlays() {
  const homes = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-agent-shutdown-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-agent-shutdown-b-')),
  ];
  const runners = homes.map((baseHome, index) => {
    const runner = new CodexAppServerRunner({
      hostId: 'host-agent-shutdown',
      sessionId: `session-agent-shutdown-${index}`,
      runId: `run-agent-shutdown-${index}`,
      title: `Agent shutdown ${index}`,
      cwd: process.cwd(),
      codexHome: baseHome,
      apiConfig: { profileId: `shutdown-${index}`, provider: 'OpenAI', apiKey: `secret-${index}` },
      postEvent: async () => {},
    });
    const child = new EventEmitter();
    child.pid = 840000 + index;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    };
    runner.child = child;
    runner.startCompleted = true;
    child.once('exit', (code, signal) => runner.handleExit(code, signal).catch(() => {}));
    return runner;
  });
  const overlays = runners.map((runner) => runner.profileHomeDir);
  const authPaths = runners.map((runner) => path.join(runner.codexHome, 'auth.json'));
  const live = new Map([
    ['session-a', runners[0]],
    ['run-a', runners[0]],
    ['session-b', runners[1]],
    ['run-b', runners[1]],
  ]);
  const exits = [];
  try {
    const shutdown = managedLifecycle.createManagedSessionShutdown({
      liveSessions: live,
      exit: (code) => exits.push(code),
      graceTimeoutMs: 1000,
    });
    const result = await shutdown('SIGTERM');
    assert.strictEqual(result.runnerCount, 2);
    assert.deepStrictEqual(exits, [0]);
    assert.deepStrictEqual(
      overlays.map((overlay) => fs.existsSync(overlay)),
      [false, false],
      'agent shutdown must remove each unique runner overlay before exit'
    );
    assert.deepStrictEqual(
      authPaths.map((authPath) => fs.existsSync(authPath)),
      [false, false],
      'agent shutdown must not leave API auth.json files behind'
    );
  } finally {
    homes.forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  }
}

async function verifyManagedOverlayJanitorRejectsLinkedRoot() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-linked-root-'));
  const outsideHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-linked-outside-'));
  const outsideOverlay = prepareApiProfileCodexHome(outsideHome, {
    profileId: 'outside-profile',
    provider: 'OpenAI',
    apiKey: 'outside-secret-must-remain',
  }, { sessionId: 'outside-session', runId: 'outside-run' });
  const managedRoot = path.join(baseHome, '.remote-codex-managed');
  const outsideManagedRoot = path.join(outsideHome, '.remote-codex-managed');
  fs.symlinkSync(outsideManagedRoot, managedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const result = cleanupStaleApiProfileCodexHomes(baseHome, {
      isProcessAlive: () => false,
    });
    assert.strictEqual(
      fs.existsSync(outsideOverlay.profileHomeDir),
      true,
      'janitor must not follow a linked managed root and delete an external overlay'
    );
    assert.strictEqual(result.removed, 0);
    assert(
      result.errors.some((message) => /link|junction|real path|unsafe/i.test(message)),
      'linked managed roots must fail closed with an actionable error'
    );
  } finally {
    try {
      fs.unlinkSync(managedRoot);
    } catch {
      // The test still removes both isolated roots below.
    }
    cleanupApiProfileCodexHome(outsideOverlay.cleanupOwner);
    fs.rmSync(baseHome, { recursive: true, force: true });
    fs.rmSync(outsideHome, { recursive: true, force: true });
  }
}

async function verifyManagedOverlayCreationRejectsLinkedRoot() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-create-linked-root-'));
  const outsideHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-create-outside-'));
  const managedRoot = path.join(baseHome, '.remote-codex-managed');
  const outsideManagedRoot = path.join(outsideHome, 'external-managed-root');
  fs.mkdirSync(outsideManagedRoot);
  fs.symlinkSync(outsideManagedRoot, managedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(
      () => prepareApiProfileCodexHome(baseHome, {
        profileId: 'linked-create',
        provider: 'OpenAI',
        apiKey: 'must-never-be-written-outside-base-home',
      }, { sessionId: 'linked-create', runId: 'run-linked-create' }),
      /link|junction|real path|unsafe/i,
      'overlay creation must reject a linked managed root before writing credentials'
    );
    assert.deepStrictEqual(
      fs.readdirSync(outsideManagedRoot),
      [],
      'linked-root rejection must not create files or directories outside CODEX_HOME'
    );
  } finally {
    try {
      fs.unlinkSync(managedRoot);
    } catch {
      // Isolated fixture roots are removed below.
    }
    fs.rmSync(baseHome, { recursive: true, force: true });
    fs.rmSync(outsideHome, { recursive: true, force: true });
  }
}

async function verifyManagedOverlayCreationAllowsLinkedBaseHome() {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-real-base-'));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-base-alias-'));
  const linkedBaseHome = path.join(aliasParent, 'linked-codex-home');
  fs.symlinkSync(realHome, linkedBaseHome, process.platform === 'win32' ? 'junction' : 'dir');
  let overlay = null;
  const realpath = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;
  try {
    overlay = prepareApiProfileCodexHome(linkedBaseHome, {
      profileId: 'linked-base',
      provider: 'OpenAI',
      apiKey: 'linked-base-secret',
    }, { sessionId: 'linked-base', runId: 'run-linked-base' });
    assert.strictEqual(fs.existsSync(path.join(overlay.codexHome, 'auth.json')), true);
    assert.strictEqual(
      path.dirname(realpath(overlay.profileHomeDir)),
      realpath(path.join(realHome, '.remote-codex-managed')),
      'a linked CODEX_HOME must remain anchored to its real managed root'
    );
    assert.strictEqual(cleanupApiProfileCodexHome(overlay.cleanupOwner), true);
  } finally {
    if (overlay && fs.existsSync(overlay.profileHomeDir)) cleanupApiProfileCodexHome(overlay.cleanupOwner);
    try {
      fs.unlinkSync(linkedBaseHome);
    } catch {
      // Isolated fixture roots are removed below.
    }
    fs.rmSync(aliasParent, { recursive: true, force: true });
    fs.rmSync(realHome, { recursive: true, force: true });
  }
}

async function verifyFirstManagedOverlayPersistsRolloutsForResume() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-first-rollout-'));
  let overlay = null;
  try {
    assert.strictEqual(
      fs.existsSync(path.join(baseHome, 'sessions')),
      false,
      'fixture must model a brand-new CODEX_HOME'
    );
    overlay = prepareApiProfileCodexHome(baseHome, {
      profileId: 'first-rollout',
      provider: 'OpenAI',
      apiKey: 'first-rollout-secret',
    }, { sessionId: 'first-rollout', runId: 'run-first-rollout' });

    const overlaySessions = path.join(overlay.codexHome, 'sessions');
    const relativeRolloutPath = path.join(
      '2026',
      '07',
      '21',
      'rollout-2026-07-21T13-22-24-native-thread.jsonl'
    );
    const overlayRolloutPath = path.join(overlaySessions, relativeRolloutPath);
    fs.mkdirSync(path.dirname(overlayRolloutPath), { recursive: true });
    fs.writeFileSync(overlayRolloutPath, '{"type":"session_meta"}\n', 'utf8');

    const durableRolloutPath = path.join(baseHome, 'sessions', relativeRolloutPath);
    assert.strictEqual(
      fs.existsSync(durableRolloutPath),
      true,
      'the first managed runner must write rollouts into the durable base home'
    );
    assert.strictEqual(cleanupApiProfileCodexHome(overlay.cleanupOwner), true);
    overlay = null;
    assert.strictEqual(
      fs.existsSync(durableRolloutPath),
      true,
      'overlay cleanup must not delete the rollout required by native Resume'
    );
  } finally {
    if (overlay && fs.existsSync(overlay.profileHomeDir)) cleanupApiProfileCodexHome(overlay.cleanupOwner);
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyOwnedOverlayCleanupRejectsLinkedMarker() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-linked-marker-'));
  const overlay = prepareApiProfileCodexHome(baseHome, {
    profileId: 'linked-marker',
    provider: 'OpenAI',
    apiKey: 'linked-marker-secret',
  }, { sessionId: 'linked-marker', runId: 'run-linked-marker' });
  const markerPath = overlay.cleanupOwner.ownerMarkerPath;
  const originalLstatSync = fs.lstatSync;
  fs.lstatSync = function reportLinkedOwnerMarker(target, ...args) {
    const stats = originalLstatSync.call(fs, target, ...args);
    if (path.resolve(String(target)) !== path.resolve(markerPath)) return stats;
    return new Proxy(stats, {
      get(value, property) {
        if (property === 'isSymbolicLink') return () => true;
        return Reflect.get(value, property, value);
      },
    });
  };
  try {
    assert.strictEqual(
      cleanupApiProfileCodexHome(overlay.cleanupOwner),
      false,
      'owned cleanup must fail closed when its owner marker is a symlink'
    );
    assert.strictEqual(fs.existsSync(overlay.profileHomeDir), true);
  } finally {
    fs.lstatSync = originalLstatSync;
    cleanupApiProfileCodexHome(overlay.cleanupOwner);
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyManagedOverlayShortPathBudgetAndMetadata() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-path-budget-'));
  const targetBaseLength = 154;
  const fillerLength = Math.max(8, targetBaseLength - parent.length - 1);
  const baseHome = path.join(parent, 'b'.repeat(fillerLength));
  fs.mkdirSync(baseHome, { recursive: true });
  const apiConfig = {
    profileId: 'minemine-profile-with-a-production-length-identifier',
    label: 'MineMine acceptance profile',
    provider: 'MineMine OpenAI compatible API',
    providerKind: 'custom',
    baseUrl: 'https://hpc.example.invalid/v1',
    apiKey: 'path-budget-secret-must-not-appear-in-owner-marker',
  };
  const metadata = {
    hostId: 'windows-acceptance-host',
    sessionId: '019f7617-85ff-7eb2-85bd-7575191e4f46-session-metadata-suffix',
    bridgeSessionId: 'bridge-session-019f7617-85ff-7eb2-85bd-7575191e4f46',
    nativeThreadId: '019f7617-85ff-7eb2-85bd-7575191e4f46',
    sourceSessionId: 'source-session-019f7617-85ff-7eb2-85bd-7575191e4f46',
    originSessionId: 'origin-session-019f7617-85ff-7eb2-85bd-7575191e4f46',
    conversationKey: 'conversation-019f7617-85ff-7eb2-85bd-7575191e4f46',
    runId: 'run-019f7617-85ff-7eb2-85bd-7575191e4f46-production-suffix',
    launchMode: 'fresh_rebind',
  };
  let first = null;
  let second = null;
  try {
    first = prepareApiProfileCodexHome(baseHome, apiConfig, metadata);
    second = prepareApiProfileCodexHome(baseHome, {
      ...apiConfig,
      apiKey: 'rotated-path-budget-secret',
    }, metadata);
    const firstName = path.basename(first.profileHomeDir);
    const secondName = path.basename(second.profileHomeDir);
    assert.match(firstName, /^rc-[a-f0-9]{32}$/);
    assert.match(secondName, /^rc-[a-f0-9]{32}$/);
    assert.strictEqual(firstName.length, 35, 'managed overlay directory names must have fixed short length');
    assert.notStrictEqual(firstName, secondName, 'identical session metadata must still receive collision-free overlays');

    const statePath = path.join(first.codexHome, 'state_5.sqlite');
    assert(
      statePath.length <= 240,
      `production-like Windows SQLite path must stay within the 240-character budget (got ${statePath.length})`
    );
    assert(
      statePath.length - path.resolve(baseHome).length <= 80,
      'session/profile/run metadata must not increase the managed SQLite path length'
    );

    const markerText = fs.readFileSync(first.cleanupOwner.ownerMarkerPath, 'utf8');
    const marker = JSON.parse(markerText);
    const secondMarkerText = fs.readFileSync(second.cleanupOwner.ownerMarkerPath, 'utf8');
    const secondMarker = JSON.parse(secondMarkerText);
    assert.deepStrictEqual(marker.metadata.host, { hostId: metadata.hostId });
    assert.deepStrictEqual(marker.metadata.session, {
      sessionId: metadata.sessionId,
      bridgeSessionId: metadata.bridgeSessionId,
      nativeThreadId: metadata.nativeThreadId,
      sourceSessionId: metadata.sourceSessionId,
      originSessionId: metadata.originSessionId,
      conversationKey: metadata.conversationKey,
    });
    assert.deepStrictEqual(marker.metadata.run, {
      runId: metadata.runId,
      launchMode: metadata.launchMode,
    });
    assert.deepStrictEqual(marker.metadata.profile, {
      profileId: apiConfig.profileId,
      label: apiConfig.label,
      provider: apiConfig.provider,
      providerKind: apiConfig.providerKind,
      configHash: marker.metadata.profile.configHash,
      configuredBaseUrl: true,
      configuredApiKey: true,
    });
    assert.match(marker.metadata.profile.configHash, /^[a-f0-9]{16}$/);
    assert.strictEqual(markerText.includes(apiConfig.apiKey), false, 'owner metadata must never persist API keys');
    assert.strictEqual(
      secondMarker.metadata.profile.configHash,
      marker.metadata.profile.configHash,
      'overlay configHash must not be derived from the API key'
    );
    assert.strictEqual(
      second.providerKey,
      first.providerKey,
      'rotating a credential must not change the non-secret provider configuration identity'
    );
    assert.strictEqual(secondMarkerText.includes('rotated-path-budget-secret'), false);

    assert.strictEqual(cleanupApiProfileCodexHome(first.cleanupOwner), true);
    first = null;
    assert.strictEqual(cleanupApiProfileCodexHome(second.cleanupOwner), true);
    second = null;
  } finally {
    if (first && fs.existsSync(first.profileHomeDir)) cleanupApiProfileCodexHome(first.cleanupOwner);
    if (second && fs.existsSync(second.profileHomeDir)) cleanupApiProfileCodexHome(second.cleanupOwner);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

async function verifyManagedOverlayJanitorRequiresDeadOwnerAndChild() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-janitor-'));
  const managedRoot = path.join(baseHome, '.remote-codex-managed');
  const makeOverlay = (name) => prepareApiProfileCodexHome(baseHome, {
    profileId: name,
    provider: 'OpenAI',
    baseUrl: `https://${name}.example/v1`,
    apiKey: `${name}-secret`,
  }, { sessionId: name, runId: `run-${name}` });
  const readMarker = (overlay) => JSON.parse(fs.readFileSync(overlay.cleanupOwner.ownerMarkerPath, 'utf8'));
  const writeMarker = (overlay, marker) => {
    fs.writeFileSync(overlay.cleanupOwner.ownerMarkerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  };

  try {
    const active = makeOverlay('active-owner');
    const activeMarker = readMarker(active);
    assert.strictEqual(activeMarker.kind, 'remote-codex-managed-overlay');
    assert.strictEqual(activeMarker.version, 1);
    assert.strictEqual(activeMarker.ownerPid, process.pid);
    assert.strictEqual(activeMarker.childPid, null);
    assert.strictEqual(activeMarker.childState, 'not-started');
    assert.strictEqual(
      fs.existsSync(path.join(active.codexHome, 'auth.json')),
      true,
      'managed overlay fixture must contain its private auth.json before cleanup'
    );

    const trackedChild = makeOverlay('tracked-child');
    assert.strictEqual(updateApiProfileCodexHomeOwnership(trackedChild.cleanupOwner, {
      childPid: 820001,
      childState: 'running',
    }), true);
    assert.strictEqual(readMarker(trackedChild).childPid, 820001);
    assert.strictEqual(readMarker(trackedChild).childState, 'running');

    const stale = makeOverlay('stale-dead');
    writeMarker(stale, {
      ...readMarker(stale),
      ownerPid: 810001,
      childPid: 810002,
      childState: 'running',
    });

    const liveChild = makeOverlay('live-child');
    writeMarker(liveChild, {
      ...readMarker(liveChild),
      ownerPid: 810003,
      childPid: process.pid,
      childState: 'running',
    });

    const ambiguousSpawn = makeOverlay('ambiguous-spawn');
    writeMarker(ambiguousSpawn, {
      ...readMarker(ambiguousSpawn),
      ownerPid: 810004,
      childPid: null,
      childState: 'spawning',
    });

    const foreignRoot = path.join(managedRoot, 'foreign-overlay');
    fs.mkdirSync(path.join(foreignRoot, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(foreignRoot, '.remote-codex-owner'), JSON.stringify({
      kind: 'another-application',
      version: 1,
      ownerPid: 810005,
      childPid: 810006,
      childState: 'running',
    }), 'utf8');
    fs.writeFileSync(path.join(foreignRoot, '.codex', 'auth.json'), '{"foreign":true}\n', 'utf8');

    const result = cleanupStaleApiProfileCodexHomes(baseHome, {
      isProcessAlive: (pid) => pid === process.pid,
    });
    assert.strictEqual(fs.existsSync(stale.profileHomeDir), false, 'dead owned overlay must be removed');
    assert.strictEqual(fs.existsSync(path.join(stale.codexHome, 'auth.json')), false, 'stale auth.json must not remain');
    assert.strictEqual(fs.existsSync(active.profileHomeDir), true, 'live owner must preserve its overlay');
    assert.strictEqual(fs.existsSync(liveChild.profileHomeDir), true, 'live child must preserve its overlay');
    assert.strictEqual(
      fs.existsSync(ambiguousSpawn.profileHomeDir),
      true,
      'an unrecorded child PID during spawn is ambiguous and must fail closed'
    );
    assert.strictEqual(fs.existsSync(foreignRoot), true, 'foreign ownership markers must never be removed');
    assert.strictEqual(result.removed, 1);

    assert.strictEqual(cleanupApiProfileCodexHome(active.cleanupOwner), true);
    assert.strictEqual(cleanupApiProfileCodexHome(trackedChild.cleanupOwner), true);
    assert.strictEqual(cleanupApiProfileCodexHome(liveChild.cleanupOwner), true);
    assert.strictEqual(cleanupApiProfileCodexHome(ambiguousSpawn.cleanupOwner), true);
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyManagedOverlayJanitorRequiresAttestationForLegacyMarkers() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-overlay-legacy-'));
  const apiKey = 'legacy-overlay-api-key-must-not-leak';
  const legacy = prepareApiProfileCodexHome(baseHome, {
    profileId: 'legacy-profile',
    provider: 'OpenAI',
    baseUrl: 'https://legacy.example/v1',
    apiKey,
  }, { sessionId: 'legacy-session', runId: 'legacy-run' });
  const markerToken = legacy.cleanupOwner.ownerToken;
  fs.writeFileSync(legacy.cleanupOwner.ownerMarkerPath, `${markerToken}\n`, 'utf8');

  try {
    const preserved = cleanupStaleApiProfileCodexHomes(baseHome);
    assert.strictEqual(
      fs.existsSync(legacy.profileHomeDir),
      true,
      'token-only legacy overlays must fail closed without an explicit liveness attestation'
    );
    assert.strictEqual(preserved.legacyUnattributed, 1);
    assert.strictEqual(preserved.legacyRemoved, 0);
    assert.strictEqual(preserved.legacyPreserved, 1);
    assert(
      preserved.diagnostics.some((entry) => entry.code === 'legacy_overlay_preserved_unattributed'),
      'default preservation must produce an actionable aggregate diagnostic'
    );
    const serializedDiagnostic = JSON.stringify(preserved.diagnostics);
    assert.strictEqual(serializedDiagnostic.includes(apiKey), false, 'legacy diagnostics must not expose API keys');
    assert.strictEqual(serializedDiagnostic.includes(markerToken), false, 'legacy diagnostics must not expose owner tokens');
    assert.strictEqual(
      serializedDiagnostic.includes(legacy.profileHomeDir),
      false,
      'legacy diagnostics must not expose managed overlay paths'
    );

    let inspectedContext = null;
    const removed = cleanupStaleApiProfileCodexHomes(baseHome, {
      legacyOverlayIsInactive(context) {
        inspectedContext = context;
        return true;
      },
    });
    assert(inspectedContext, 'explicit legacy cleanup must require a liveness attestation callback');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(inspectedContext, 'ownerToken'),
      false,
      'the liveness callback must not receive the legacy owner token'
    );
    assert.strictEqual(fs.existsSync(legacy.profileHomeDir), false, 'attested inactive legacy overlay must be removed');
    assert.strictEqual(removed.legacyUnattributed, 1);
    assert.strictEqual(removed.legacyRemoved, 1);
    assert.strictEqual(removed.legacyPreserved, 0);
    assert(
      removed.diagnostics.some((entry) => entry.code === 'legacy_overlay_removed_by_attestation'),
      'attested cleanup must report an aggregate migration diagnostic'
    );
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyStartReplayResendsAttestedConfirmation() {
  const replayEvents = [];
  let dropFirstConfirmation = true;
  const replayRunner = {
    ...currentRunner,
    title: 'Replay runner',
    cwd: process.cwd(),
    nativeThreadId: 'native-replay',
    apiBinding: profile,
    runtime: { adapterId: 'codex-app-server', runId: 'run-current' },
    currentSessionId: () => 'native-replay',
  };
  const replayIndex = new Map([
    ['session-reused', replayRunner],
    ['native-replay', replayRunner],
    ['run-current', replayRunner],
  ]);
  const replayRequest = {
    liveSessions: replayIndex,
    command: { sessionId: 'session-reused', runId: 'run-current' },
    hostId: 'host-replay',
    postEvent: async (event) => {
      if (dropFirstConfirmation) {
        dropFirstConfirmation = false;
        throw new Error('simulated lost first confirmation');
      }
      replayEvents.push(event);
    },
  };
  await assert.rejects(managedLifecycle.replayManagedSessionStart(replayRequest), (error) => (
    /lost first confirmation/.test(error.message) && error.retryCommand === true
  ));
  const replayedSessionId = await managedLifecycle.replayManagedSessionStart(replayRequest);
  assert.strictEqual(replayedSessionId, 'native-replay');
  assert.strictEqual(replayEvents.length, 1);
  assert.strictEqual(replayEvents[0].type, 'session.started');
  assert.strictEqual(replayEvents[0].runId, 'run-current');
  assert.strictEqual(replayEvents[0].effectiveBinding.bindingFingerprint, profile.bindingFingerprint);
  assert.strictEqual(replayEvents[0].bridgeSessionId, 'bridge-reused');
}

async function verifyNativeResumeReadyAfterFirstTurnStart() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-native-resume-ready-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  let turnStartSucceeded = false;
  let failFirstTurnStart = true;
  const runner = new CodexAppServerRunner({
    hostId: 'host-native-resume-ready',
    sessionId: 'bridge-native-resume-ready',
    bridgeSessionId: 'bridge-native-resume-ready',
    runId: 'run-native-resume-ready',
    title: 'Native resume readiness',
    cwd: process.cwd(),
    launchMode: 'fresh_rebind',
    codexHome: baseHome,
    postEvent: async (event) => {
      if (event.type === 'session.runtime_updated' && event.patch?.nativeResumeReady === true) {
        assert.strictEqual(
          turnStartSucceeded,
          true,
          'native readiness must not be reported before turn/start RPC succeeds'
        );
      }
      events.push(event);
    },
  });
  runner.threadId = 'native-resume-ready-thread';
  runner.sessionId = runner.threadId;
  runner.nativeThreadId = runner.threadId;
  runner.runtime.nativeThreadId = runner.threadId;
  runner.rpc = {
    request: async (method) => {
      assert.strictEqual(method, 'turn/start');
      if (failFirstTurnStart) {
        failFirstTurnStart = false;
        throw new Error('simulated turn/start failure before rollout creation');
      }
      turnStartSucceeded = true;
      return { turn: { id: 'turn-native-resume-ready' } };
    },
  };
  try {
    assert.strictEqual(runner.runtime.nativeResumeReady, false);
    await assert.rejects(
      runner.sendInput('first attempt fails'),
      /simulated turn\/start failure/
    );
    assert.strictEqual(runner.runtime.nativeResumeReady, false);
    assert.strictEqual(
      events.some((event) => event.patch?.nativeResumeReady === true),
      false,
      'a rejected turn/start must leave the native thread explicitly non-resumable'
    );

    const turnId = await runner.sendInput('second attempt succeeds');
    assert.strictEqual(turnId, 'turn-native-resume-ready');
    assert.strictEqual(runner.runtime.nativeResumeReady, true);
    assert.strictEqual(
      events.filter((event) => event.type === 'session.runtime_updated' && event.patch?.nativeResumeReady === true).length,
      1,
      'the first successful native turn must publish readiness exactly once'
    );
  } finally {
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyRuntimeErrorsClearAfterTurnRecovery() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-runtime-error-recovery-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  const runner = new CodexAppServerRunner({
    hostId: 'host-runtime-error-recovery',
    sessionId: 'bridge-runtime-error-recovery',
    bridgeSessionId: 'bridge-runtime-error-recovery',
    runId: 'run-runtime-error-recovery',
    title: 'Runtime error recovery',
    cwd: process.cwd(),
    launchMode: 'fresh',
    codexHome: baseHome,
    postEvent: async (event) => events.push(event),
  });
  runner.threadId = 'thread-runtime-error-recovery';
  runner.sessionId = runner.threadId;
  runner.nativeThreadId = runner.threadId;
  runner.rpc = {
    request: async (method) => {
      assert.strictEqual(method, 'turn/start');
      return { turn: { id: 'turn-runtime-error-recovery' } };
    },
  };

  try {
    runner.runtime.lastError = 'stale input error';
    runner.runtime.lastCodexError = 'staleInputError';
    await runner.sendInput('retry after the session becomes live');
    assert.strictEqual(runner.runtime.lastError, null, 'successful turn submission must clear lastError');
    assert.strictEqual(runner.runtime.lastCodexError, null, 'successful turn submission must clear lastCodexError');

    runner.runtime.lastError = 'stale notification error';
    runner.runtime.lastCodexError = 'staleNotificationError';
    await runner.handleNotification({
      method: 'turn/started',
      params: {
        threadId: runner.threadId,
        turn: { id: 'turn-runtime-error-recovery', status: { type: 'inProgress' } },
      },
    });
    assert.strictEqual(runner.runtime.lastError, null, 'turn/started must clear lastError');
    assert.strictEqual(runner.runtime.lastCodexError, null, 'turn/started must clear lastCodexError');

    runner.runtime.lastError = 'stale retry warning';
    runner.runtime.lastCodexError = 'responseStreamDisconnected';
    await runner.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: runner.threadId,
        turn: { id: 'turn-runtime-error-recovery', status: { type: 'completed' } },
      },
    });
    assert.strictEqual(runner.runtime.lastError, null, 'successful turn completion must clear lastError');
    assert.strictEqual(runner.runtime.lastCodexError, null, 'successful turn completion must clear lastCodexError');

    runner.runtime.lastError = 'current terminal failure';
    runner.runtime.lastCodexError = 'usageLimitExceeded';
    runner.activeTurnId = 'turn-runtime-error-failed';
    runner.turnBuffers.set(runner.activeTurnId, '');
    await runner.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: runner.threadId,
        turn: { id: runner.activeTurnId, status: { type: 'failed' } },
      },
    });
    assert.strictEqual(runner.runtime.lastError, 'current terminal failure', 'failed completion must preserve lastError');
    assert.strictEqual(runner.runtime.lastCodexError, 'usageLimitExceeded', 'failed completion must preserve lastCodexError');
    assert(
      events.some((event) => (
        event.type === 'session.runtime_updated'
        && event.patch?.lastError === null
        && event.patch?.lastCodexError === null
      )),
      'runtime recovery must publish explicit nulls so Relay can clear its merged projection'
    );
  } finally {
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyAdaptiveFreshRebindThreadOpen() {
  const createRunner = (baseHome, postEvent = async () => {}) => new CodexAppServerRunner({
    hostId: 'host-adaptive-rebind',
    sessionId: 'bridge-adaptive-rebind',
    bridgeSessionId: 'bridge-adaptive-rebind',
    runId: 'run-adaptive-rebind',
    title: 'Adaptive Rebind',
    cwd: process.cwd(),
    launchMode: 'fresh_rebind',
    rebindNativeThreadId: 'native-rebind-source',
    explicitRebind: true,
    codexHome: baseHome,
    postEvent,
  });

  const missingHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-rebind-missing-rollout-'));
  const missingCalls = [];
  const missingEvents = [];
  const missingRunner = createRunner(missingHome, async (event) => missingEvents.push(event));
  missingRunner.rpc = {
    request: async (method, params) => {
      missingCalls.push({ method, params });
      if (method === 'thread/resume') {
        throw new Error('no rollout found for thread id native-rebind-source');
      }
      assert.strictEqual(method, 'thread/start');
      return { thread: { id: 'native-rebind-fresh' } };
    },
  };
  try {
    const opened = await missingRunner.openThread();
    assert.strictEqual(opened.thread.id, 'native-rebind-fresh');
    assert.deepStrictEqual(missingCalls.map((entry) => entry.method), ['thread/resume', 'thread/start']);
    assert.strictEqual(missingRunner.launchMode, 'fresh_rebind');
    assert.strictEqual(missingRunner.runtime.launchMode, 'fresh_rebind');
    assert.strictEqual(missingRunner.runtime.nativeResumeReady, false);
    assert.strictEqual(missingRunner.runtime.resumeStrategy, 'fresh');
    assert.strictEqual(
      JSON.stringify(missingEvents).includes('from transcript context'),
      false,
      'an empty Rebind fallback must not claim that transcript context was injected'
    );
  } finally {
    missingRunner.cleanupManagedOverlay();
    fs.rmSync(missingHome, { recursive: true, force: true });
  }

  const readyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-rebind-ready-rollout-'));
  const readyCalls = [];
  const readyRunner = createRunner(readyHome);
  readyRunner.rpc = {
    request: async (method, params) => {
      readyCalls.push({ method, params });
      assert.strictEqual(method, 'thread/resume');
      assert.strictEqual(params.threadId, 'native-rebind-source');
      return { thread: { id: 'native-rebind-source' } };
    },
  };
  try {
    const opened = await readyRunner.openThread();
    assert.strictEqual(opened.thread.id, 'native-rebind-source');
    assert.deepStrictEqual(readyCalls.map((entry) => entry.method), ['thread/resume']);
    assert.strictEqual(readyRunner.launchMode, 'resume');
    assert.strictEqual(readyRunner.nativeThreadId, 'native-rebind-source');
    assert.strictEqual(readyRunner.runtime.launchMode, 'resume');
    assert.strictEqual(readyRunner.runtime.nativeResumeReady, true);
    assert.strictEqual(readyRunner.runtime.resumeStrategy, 'native_resume');
  } finally {
    readyRunner.cleanupManagedOverlay();
    fs.rmSync(readyHome, { recursive: true, force: true });
  }

  for (const [label, message] of [
    ['unknown-thread', 'unknown thread id native-rebind-source'],
    ['thread-not-found', 'thread native-rebind-source not found'],
    ['database-error', 'thread database could not be opened'],
  ]) {
    const failureHome = fs.mkdtempSync(path.join(os.tmpdir(), `session-api-rebind-${label}-`));
    const failureCalls = [];
    const failureRunner = createRunner(failureHome);
    failureRunner.rpc = {
      request: async (method) => {
        failureCalls.push(method);
        throw new Error(message);
      },
    };
    try {
      await assert.rejects(
        failureRunner.openThread(),
        (error) => error?.code === 'session_native_resume_failed'
      );
      assert.deepStrictEqual(
        failureCalls,
        ['thread/resume'],
        `${label} must not downgrade an explicit Rebind to thread/start`
      );
    } finally {
      failureRunner.cleanupManagedOverlay();
      fs.rmSync(failureHome, { recursive: true, force: true });
    }
  }

  const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-legacy-rebind-'));
  const legacyRunner = new CodexAppServerRunner({
    hostId: 'host-legacy-rebind',
    sessionId: 'bridge-legacy-rebind',
    runId: 'run-legacy-rebind',
    title: 'Legacy Rebind',
    cwd: process.cwd(),
    launchMode: 'resume',
    nativeThreadId: 'native-legacy-rebind',
    explicitRebind: true,
    codexHome: legacyHome,
    postEvent: async () => {},
  });
  const legacyCalls = [];
  legacyRunner.rpc = {
    request: async (method) => {
      legacyCalls.push(method);
      if (method === 'thread/resume') {
        throw new Error('no rollout found for thread id native-legacy-rebind');
      }
      return { thread: { id: 'native-legacy-fresh' } };
    },
  };
  try {
    const opened = await legacyRunner.openThread();
    assert.strictEqual(opened.thread.id, 'native-legacy-fresh');
    assert.deepStrictEqual(legacyCalls, ['thread/resume', 'thread/start']);
    assert.strictEqual(legacyRunner.launchMode, 'fresh_rebind');
    assert.strictEqual(legacyRunner.runtime.launchMode, 'fresh_rebind');
    assert.strictEqual(legacyRunner.runtime.nativeResumeReady, false);
  } finally {
    legacyRunner.cleanupManagedOverlay();
    fs.rmSync(legacyHome, { recursive: true, force: true });
  }

  const strictHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-strict-resume-'));
  const strictRunner = new CodexAppServerRunner({
    hostId: 'host-strict-resume',
    sessionId: 'bridge-strict-resume',
    runId: 'run-strict-resume',
    title: 'Strict Resume',
    cwd: process.cwd(),
    launchMode: 'resume',
    nativeThreadId: 'native-strict-resume',
    explicitRebind: false,
    codexHome: strictHome,
    postEvent: async () => {},
  });
  const strictCalls = [];
  strictRunner.rpc = {
    request: async (method) => {
      strictCalls.push(method);
      throw new Error('no rollout found for thread id native-strict-resume');
    },
  };
  try {
    await assert.rejects(
      strictRunner.openThread(),
      (error) => error?.code === 'session_native_resume_failed'
    );
    assert.deepStrictEqual(strictCalls, ['thread/resume'], 'ordinary Resume must never downgrade to thread/start');
  } finally {
    strictRunner.cleanupManagedOverlay();
    fs.rmSync(strictHome, { recursive: true, force: true });
  }

  const strictForkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-strict-fork-'));
  const strictForkRunner = new CodexAppServerRunner({
    hostId: 'host-strict-fork',
    sessionId: 'bridge-strict-fork',
    runId: 'run-strict-fork',
    title: 'Strict Fork',
    cwd: process.cwd(),
    launchMode: 'fork',
    nativeThreadId: 'native-strict-fork',
    explicitRebind: false,
    codexHome: strictForkHome,
    postEvent: async () => {},
  });
  const strictForkCalls = [];
  strictForkRunner.rpc = {
    request: async (method) => {
      strictForkCalls.push(method);
      throw new Error('no rollout found for thread id native-strict-fork');
    },
  };
  try {
    await assert.rejects(
      strictForkRunner.openThread(),
      (error) => error?.code === 'session_native_fork_failed'
    );
    assert.deepStrictEqual(strictForkCalls, ['thread/fork'], 'ordinary Fork must never downgrade to thread/start');
  } finally {
    strictForkRunner.cleanupManagedOverlay();
    fs.rmSync(strictForkHome, { recursive: true, force: true });
  }
}

async function verifyRejectedRunnerStartupKillsSpawnedChild() {
  fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'session-api-start-reject-'));
  const baseHome = path.join(fixtureRoot, 'base-home');
  const pidPath = path.join(fixtureRoot, 'fake-child.pid');
  const serverPath = path.join(fixtureRoot, 'fake-app-server.js');
  fs.mkdirSync(baseHome, { recursive: true });
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  fs.writeFileSync(serverPath, [
    "const fs = require('fs');",
    "const readline = require('readline');",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    "const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "input.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') {",
    "    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: 'fake initialize rejection' } }) + '\\n');",
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
  ].join('\n'), 'utf8');
  const syntaxCheck = spawnSync(process.execPath, ['--check', serverPath], { encoding: 'utf8' });
  assert.strictEqual(syntaxCheck.status, 0, syntaxCheck.stderr || 'fake app-server syntax check failed');
  const originalCleanup = CodexAppServerRunner.prototype.cleanupManagedOverlay;
  let cleanupCalls = 0;
  let childPid = null;
  CodexAppServerRunner.prototype.cleanupManagedOverlay = function countedCleanup() {
    cleanupCalls += 1;
    return originalCleanup.call(this);
  };
  try {
    await assert.rejects(
      startCodexAppServerSession({
        hostId: 'host-start-reject',
        sessionId: 'session-start-reject',
        runId: 'run-start-reject',
        title: 'Rejected startup',
        cwd: process.cwd(),
        codexHome: baseHome,
        codexBin: process.execPath,
        codexArgs: [serverPath],
        apiConfig: { profileId: 'reject-profile', provider: 'OpenAI', baseUrl: 'https://reject.example/v1', apiKey: 'secret' },
        postEvent: async () => {},
      }),
      /fake initialize rejection/
    );
    for (let attempt = 0; attempt < 50 && !fs.existsSync(pidPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    childPid = Number(fs.readFileSync(pidPath, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    assert.strictEqual(alive, false, 'factory rejection must not leave the spawned app-server alive');
    assert.strictEqual(cleanupCalls, 1, 'failed startup must clean its owned overlay exactly once');
  } finally {
    CodexAppServerRunner.prototype.cleanupManagedOverlay = originalCleanup;
    if (childPid) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // The fixed factory already terminated it.
      }
    }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function verifySpawnMarkerFailureIsControlled() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-spawn-marker-failure-'));
  const child = makeFakeManagedChild(0);
  child.pid = undefined;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let spawnCalls = 0;
  let runner = null;
  let uncaughtException = null;
  const onUncaughtException = (error) => { uncaughtException = error; };
  const originalWriteSync = fs.writeSync;
  const keepAlive = setInterval(() => {}, 1000);
  fs.writeSync = function failSpawnOwnershipMarker(fd, contents, ...args) {
    if (
      spawnCalls > 0
      && /"childState"\s*:\s*"running"/.test(String(contents || ''))
    ) {
      const error = new Error('simulated spawned-child marker update failure');
      error.code = 'ENOSPC';
      throw error;
    }
    return originalWriteSync.call(fs, fd, contents, ...args);
  };
  process.on('uncaughtException', onUncaughtException);
  try {
    await assert.rejects(
      startCodexAppServerSession({
        hostId: 'host-spawn-marker-failure',
        sessionId: 'session-spawn-marker-failure',
        runId: 'run-spawn-marker-failure',
        title: 'Spawn marker failure',
        cwd: process.cwd(),
        codexHome: baseHome,
        codexBin: process.execPath,
        codexArgs: ['-e', 'setTimeout(() => process.exit(0), 20)'],
        spawnProcess: () => {
          spawnCalls += 1;
          queueMicrotask(() => {
            child.pid = 860002;
            child.emit('spawn');
          });
          return child;
        },
        apiConfig: { profileId: 'spawn-marker-failure', provider: 'OpenAI', apiKey: 'secret' },
        stopGraceTimeoutMs: 5,
        stopKillTimeoutMs: 5,
        postEvent: async () => {},
        onRunnerCreated: (createdRunner) => { runner = createdRunner; },
      }),
      (error) => (
        error?.processTreeFallbackRequired === true
        && error?.retryCommand === true
        && /spawned-child marker update failure/.test(error?.cause?.message || '')
      ),
      'spawn marker failure with an unconfirmed child must surface stop fallback and retain the startup cause'
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(spawnCalls, 1, 'the injected child must exercise the spawn event path');
    assert.strictEqual(uncaughtException, null, 'spawn listener exceptions must not escape EventEmitter');
    assert(runner);
    assert.strictEqual(runner.childExitConfirmed, false);
    assert.strictEqual(runner.overlayCleaned, false);
    assert.strictEqual(
      fs.existsSync(path.join(runner.codexHome, 'auth.json')),
      true,
      'spawn marker failure must preserve credentials until the child confirms exit'
    );
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    await runner.handleExit(null, 'SIGKILL');
    assert.strictEqual(runner.overlayCleaned, true);
  } finally {
    clearInterval(keepAlive);
    process.off('uncaughtException', onUncaughtException);
    fs.writeSync = originalWriteSync;
    if (runner && !runner.overlayCleaned && (!runner.child || runner.childExitConfirmed)) {
      runner.cleanupManagedOverlay();
    }
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyFactoryTimeoutPreservesLiveChildOverlay() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-factory-live-child-'));
  const originalStart = CodexAppServerRunner.prototype.start;
  let runner = null;
  const keepAlive = setInterval(() => {}, 1000);
  CodexAppServerRunner.prototype.start = async function simulateStartupFailureWithLiveChild() {
    const child = new EventEmitter();
    child.pid = 860001;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    this.child = child;
    throw new Error('simulated startup failure while child remains alive');
  };
  try {
    await assert.rejects(
      startCodexAppServerSession({
        hostId: 'host-factory-live-child',
        sessionId: 'session-factory-live-child',
        runId: 'run-factory-live-child',
        title: 'Factory live child',
        cwd: process.cwd(),
        codexHome: baseHome,
        apiConfig: { profileId: 'factory-live-child', provider: 'OpenAI', apiKey: 'secret' },
        stopGraceTimeoutMs: 5,
        stopKillTimeoutMs: 5,
        postEvent: async () => {},
        onRunnerCreated: (createdRunner) => { runner = createdRunner; },
      }),
      (error) => (
        error?.processTreeFallbackRequired === true
        && error?.retryCommand === true
        && /simulated startup failure/.test(error?.cause?.message || '')
      ),
      'factory cleanup must not hide an unconfirmed child stop behind the original startup error'
    );
    assert(runner);
    assert.strictEqual(runner.overlayCleaned, false);
    assert.strictEqual(
      fs.existsSync(path.join(runner.codexHome, 'auth.json')),
      true,
      'factory cleanup must preserve credentials while the child may still be using them'
    );
  } finally {
    clearInterval(keepAlive);
    CodexAppServerRunner.prototype.start = originalStart;
    if (runner && !runner.childExitConfirmed) {
      runner.child.signalCode = 'SIGKILL';
      await runner.handleExit(null, 'SIGKILL').catch(() => {});
    }
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

verifyPagedRunnerCapabilities()
  .then(verifyIntentionalCodexStopIsSingleTerminalOutcome)
  .then(verifyCodexStopSuppressionUpgradesMonotonically)
  .then(verifyOverlayCleanupDoesNotWaitForRelayDelivery)
  .then(verifyManagedOverlayCleanupRetriesAfterFailure)
  .then(verifyOwnerMarkerAtomicUpdatePreservesAuthoritativeMarker)
  .then(verifyOwnershipUpdateFailureStillFinalizesRunner)
  .then(verifyCodexTerminalDeliveryFailureRequestsCommandRetry)
  .then(verifyCodexStopTimeoutPreservesLiveChildOverlay)
  .then(verifyConstructorFailureRemovesOwnedOverlay)
  .then(verifyPostOverlayConstructorFailureRemovesCredentials)
  .then(verifySqliteOpenFailurePreservesFilesAndRawStartupError)
  .then(verifySqliteStartupRetryStopsFirstChildBeforeReuse)
  .then(verifySqliteRetryTimeoutRequiresTrackedCommandRetry)
  .then(verifySqliteRetryExitWaiterSurvivesConcurrentShutdown)
  .then(verifyPreSpawnCodexCancellationPublishesTerminalFailure)
  .then(verifyIntentionalProcessStopIsSingleTerminalOutcome)
  .then(verifyManagedProcessSpawnCredentialIsolation)
  .then(verifyProcessStopSuppressionUpgradesMonotonically)
  .then(verifyProcessSpawnHandshakeRejectsMissingExecutable)
  .then(verifySynchronousProcessSpawnFailureDefersTerminalToCommandOwner)
  .then(verifyRuntimeErrorDeliveryFailureDoesNotBlockTerminalState)
  .then(verifyProcessTerminalDeliveryFailureRequestsCommandRetry)
  .then(verifyProcessStopTimeoutDoesNotFabricateExit)
  .then(verifyRejectedStartAbortsOrphanRunner)
  .then(verifyUniqueRunnerShutdownIsParallel)
  .then(verifyManagedSessionShutdownWaitsBeforeExit)
  .then(verifyShutdownSuppressionUpgradeRestopsTrackedRunner)
  .then(verifyManagedSessionShutdownOwnsInFlightStarts)
  .then(verifyShutdownDefersPendingRunnerTerminalToCommandOwner)
  .then(verifyShutdownWaitsForPendingStartTerminalDelivery)
  .then(verifyShutdownObservesPendingStartTerminalFailure)
  .then(verifyShutdownIgnoresUnrelatedStartRetryFailure)
  .then(verifyAgentShutdownRemovesRunnerAuthOverlays)
  .then(verifyManagedOverlayJanitorRejectsLinkedRoot)
  .then(verifyManagedOverlayCreationRejectsLinkedRoot)
  .then(verifyManagedOverlayCreationAllowsLinkedBaseHome)
  .then(verifyFirstManagedOverlayPersistsRolloutsForResume)
  .then(verifyOwnedOverlayCleanupRejectsLinkedMarker)
  .then(verifyManagedOverlayShortPathBudgetAndMetadata)
  .then(verifyManagedOverlayJanitorRequiresDeadOwnerAndChild)
  .then(verifyManagedOverlayJanitorRequiresAttestationForLegacyMarkers)
  .then(verifyNativeResumeReadyAfterFirstTurnStart)
  .then(verifyRuntimeErrorsClearAfterTurnRecovery)
  .then(verifyAdaptiveFreshRebindThreadOpen)
  .then(verifyStartReplayResendsAttestedConfirmation)
  .then(verifyRejectedRunnerStartupKillsSpawnedChild)
  .then(verifySpawnMarkerFailureIsControlled)
  .then(verifyFactoryTimeoutPreservesLiveChildOverlay)
  .then(() => console.log('session API Host/Runner assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
