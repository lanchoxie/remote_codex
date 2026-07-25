const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  ensurePageOrigin,
  mergeRecoveredProfiles,
  normalizeSessionDefaults,
  normalizeStoredProfile,
  parseManagedOverlay,
  selectRecoverableTitles,
  selectRecoverableProfiles,
  summarizeProfiles,
} = require('./recover-web-api-profiles');

function candidate(overrides = {}) {
  return {
    profileId: 'api-new',
    label: 'Example API',
    provider: 'OpenAI',
    providerKind: 'openai',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'secret-new',
    sessionDefaults: {
      model: '',
      effortMode: 'auto',
      effort: '',
      allowUnverifiedEffort: false,
      summary: '',
    },
    modifiedAtMs: 200,
    ...overrides,
  };
}

const parsed = parseManagedOverlay({
  directoryName: '019f5ff2-cecb-7d52-b058-fe18a2a37ca0-api-new-0123456789abcdef',
  configToml: [
    '# BEGIN remote-codex-api-profile',
    '[model_providers.remote_codex_0123456789abcdef]',
    'name = "Example API"',
    'base_url = "https://example.invalid/v1/"',
    'env_key = "OPENAI_API_KEY"',
    '# END remote-codex-api-profile',
  ].join('\n'),
  authJson: JSON.stringify({ OPENAI_API_KEY: 'secret-new' }),
  modifiedAtMs: 200,
});

assert.deepStrictEqual(parsed, candidate());
assert.strictEqual(parseManagedOverlay({
  directoryName: '019f5ff2-cecb-7d52-b058-fe18a2a37ca0-host-env-host-env',
  configToml: '',
  authJson: JSON.stringify({ OPENAI_API_KEY: 'must-not-import' }),
  modifiedAtMs: 300,
}), null);

const selected = selectRecoverableProfiles([
  candidate({ profileId: 'api-old', label: 'Example_API', apiKey: 'secret-old', modifiedAtMs: 100 }),
  candidate(),
  candidate({
    profileId: 'api-second',
    label: 'Second account',
    provider: 'private-provider',
    providerKind: 'custom',
    apiKey: 'secret-second',
    sessionDefaults: {
      model: 'private-model',
      effortMode: 'manual',
      effort: 'vendor_high',
      allowUnverifiedEffort: true,
      summary: 'concise',
      ignoredNestedField: 'discard-me',
    },
    ignoredProfileField: 'discard-me',
    modifiedAtMs: 150,
  }),
  candidate({
    profileId: 'api-second',
    label: 'Second account',
    baseUrl: 'https://old.example.invalid/v1',
    apiKey: 'secret-second-old',
    modifiedAtMs: 50,
  }),
]);

assert.deepStrictEqual(selected.map((profile) => profile.profileId), ['api-new', 'api-second']);
assert.strictEqual(selected[0].apiKey, 'secret-new');

const merged = mergeRecoveredProfiles({
  locale: 'en',
  theme: 'dark-tech',
  apiProfiles: [{
    profileId: 'api-new',
    label: 'Existing API',
    provider: 'OpenAI',
    providerKind: 'anthropic',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'existing-secret',
    rememberApiKey: true,
    sessionDefaults: {
      model: 'existing-model',
      effortMode: 'manual',
      effort: 'high',
      allowUnverifiedEffort: false,
      summary: 'detailed',
    },
    ignoredProfileField: 'discard-me',
  }],
  selectedApiProfileId: 'api-new',
  defaultApiProfileId: 'api-new',
  hostApiProfiles: { local: 'api-new' },
}, selected);

assert.strictEqual(merged.locale, 'en');
assert.strictEqual(merged.theme, 'dark-tech');
assert.strictEqual(merged.apiProfiles.length, 2);
assert.strictEqual(merged.apiProfiles[0].apiKey, 'existing-secret');
assert.strictEqual(merged.apiProfiles[0].providerKind, 'anthropic');
assert.strictEqual(merged.apiProfiles[0].sessionDefaults.model, 'existing-model');
assert.strictEqual(Object.prototype.hasOwnProperty.call(merged.apiProfiles[0], 'ignoredProfileField'), false);
assert.strictEqual(merged.apiProfiles[1].apiKey, 'secret-second');
assert.strictEqual(merged.apiProfiles[1].providerKind, 'custom');
assert.deepStrictEqual(merged.apiProfiles[1].sessionDefaults, {
  model: 'private-model',
  effortMode: 'manual',
  effort: 'vendor_high',
  allowUnverifiedEffort: true,
  summary: 'concise',
});
assert.strictEqual(Object.prototype.hasOwnProperty.call(merged.apiProfiles[1], 'ignoredProfileField'), false);
assert.deepStrictEqual(merged.hostApiProfiles, { local: 'api-new' });

assert.deepStrictEqual(normalizeSessionDefaults({ effort: 'custom_high', unexpected: true }), {
  model: '',
  effortMode: 'manual',
  effort: 'custom_high',
  allowUnverifiedEffort: false,
  summary: '',
});
assert.deepStrictEqual(normalizeStoredProfile({
  profileId: 'legacy',
  label: 'Legacy Gemini',
  provider: 'Gemini',
  baseUrl: 'https://gemini.example.invalid/v1',
  extra: 'discard-me',
}), {
  profileId: 'legacy',
  label: 'Legacy Gemini',
  provider: 'Gemini',
  providerKind: 'gemini',
  baseUrl: 'https://gemini.example.invalid/v1',
  apiKey: '',
  rememberApiKey: true,
  sessionDefaults: {
    model: '',
    effortMode: 'auto',
    effort: '',
    allowUnverifiedEffort: false,
    summary: '',
  },
});

const summary = summarizeProfiles(selected);
assert.deepStrictEqual(summary[0], {
  profileId: 'api-new',
  label: 'Example API',
  provider: 'OpenAI',
  providerKind: 'openai',
  baseUrl: 'https://example.invalid/v1',
  sessionDefaults: {
    model: '',
    effortMode: 'auto',
    effort: '',
    allowUnverifiedEffort: false,
    summary: '',
  },
  hasKey: true,
  keyLength: 10,
});
assert.strictEqual(JSON.stringify(summary).includes('secret-new'), false);

assert.deepStrictEqual(selectRecoverableTitles([
  {
    hostId: 'host-a',
    identity: 'session-a',
    title: 'Older title',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    hostId: 'host-a',
    identity: 'session-a',
    title: 'Restored title',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  { hostId: '', identity: 'session-b', title: 'Ignored' },
]), {
  'host-a::session-a': 'Restored title',
});

async function testPageOriginPreparation() {
  const calls = [];
  const client = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            value: {
              origin: 'http://127.0.0.1:19228',
              readyState: 'complete',
            },
          },
        };
      }
      return {};
    },
  };

  await ensurePageOrigin(client, 'http://127.0.0.1:19228');
  assert.deepStrictEqual(calls.slice(0, 2), [
    { method: 'Page.enable', params: undefined },
    { method: 'Page.navigate', params: { url: 'http://127.0.0.1:19228/' } },
  ]);
  assert(calls.some((call) => call.method === 'Runtime.evaluate'));
}

testPageOriginPreparation()
  .then(() => {
    const recoveryPage = fs.readFileSync(
      path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'recover-api-profiles.html'),
      'utf8'
    );
    assert(recoveryPage.includes('mobile-codex-remote.ui-settings.v1'));
    assert(recoveryPage.includes('/profiles?token='));
    assert(recoveryPage.includes('/ack?token='));
    assert(recoveryPage.includes('window.localStorage.setItem'));
    assert(recoveryPage.includes('providerKind: normalizeProviderKind'));
    assert(recoveryPage.includes('sessionDefaults: normalizeSessionDefaults'));
    console.log('web API profile recovery assertions passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
