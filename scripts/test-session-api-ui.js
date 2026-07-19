const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'apps/mobile-web/public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'apps/mobile-web/public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps/mobile-web/public/styles.css'), 'utf8');

function functionSource(name) {
  const marker = `function ${name}`;
  const start = app.indexOf(marker);
  assert(start >= 0, `${name} missing`);
  const parametersStart = app.indexOf('(', start + marker.length);
  let parameterDepth = 0;
  let parameterQuote = '';
  let parameterEscaped = false;
  let parametersEnd = -1;
  for (let index = parametersStart; index < app.length; index += 1) {
    const char = app[index];
    if (parameterQuote) {
      if (parameterEscaped) parameterEscaped = false;
      else if (char === '\\') parameterEscaped = true;
      else if (char === parameterQuote) parameterQuote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      parameterQuote = char;
      continue;
    }
    if (char === '(') parameterDepth += 1;
    if (char === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parametersEnd = index;
        break;
      }
    }
  }
  const open = app.indexOf('{', parametersEnd + 1);
  assert(open >= 0, `${name} body missing`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < app.length; index += 1) {
    const char = app[index];
    const next = app[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body is unbalanced`);
}

function loadHelpers(names, globals = {}) {
  const context = vm.createContext({
    console,
    Error,
    Map,
    Set,
    URL,
    ...globals,
  });
  const source = names.map(functionSource).join('\n');
  const exportsSource = names.map((name) => `${name}: typeof ${name} === 'function' ? ${name} : null`).join(',');
  return vm.runInContext(`${source}\n({${exportsSource}})`, context);
}

assert.strictEqual(
  /const DEFAULT_COMPOSER_OPTIONS = \{[\s\S]*?effort: ''/.test(app),
  true,
  'reasoning effort must default to Auto'
);
assert(!app.includes('const FALLBACK_REASONING_EFFORTS'), 'hard-coded reasoning fallback must be removed');

const launchBody = functionSource('startManagedSession');
const inputBody = functionSource('sendInputToSession');
const compactBody = functionSource('compactCurrentThread');
const endSessionBody = functionSource('endCurrentSession');
const stopManagedBody = functionSource('stopManagedSession');
const sessionDetailsBody = functionSource('renderSessionDetails');
const composerControlsBody = functionSource('renderComposerControls');
const modelLoadBody = functionSource('loadModelOptionsForSession');
const rebindModelLoadBody = functionSource('loadRebindProfileModelOptions');
const selectedModelLoadBody = functionSource('loadModelOptionsForSelectedSession');
const runtimeLoadBody = functionSource('loadSessionRuntimeConfigForSession');
const fetchBody = functionSource('fetchJson');
const rebindBody = functionSource('rebindSessionApi');
const fallbackBody = functionSource('startTranscriptFallback');
const controlsBody = functionSource('renderSessionApiControls');
const stateChangedHandler = app.slice(
  app.indexOf("state.eventSource.addEventListener('session.state_changed'"),
  app.indexOf("state.eventSource.addEventListener('session.transcript'")
);

assert(launchBody.includes('resolveLaunchApiConfig'), 'managed launch must resolve fresh versus inherited API ownership');
assert(!launchBody.includes('explicitProfileId'), 'ordinary launch must never perform an explicit API rebind');
assert(!launchBody.includes('if (!sessionApiBinding(currentSource))'), 'resume must fail closed when canonical runtime config cannot be loaded');
assert(!launchBody.includes('sourceSession = currentSource'), 'resume must not fall back to a list projection after runtime-config failure');
assert(!inputBody.includes('getApiRequestConfig'), 'live input must not resolve the Host default API');
assert(!inputBody.includes('body.apiConfig'), 'live input must not submit apiConfig');
assert(!compactBody.includes('getApiRequestConfig'), 'compact must not resolve the Host default API');
assert(!compactBody.includes('body.apiConfig'), 'compact must not submit apiConfig');
assert(runtimeLoadBody.includes('/runtime-config?'), 'selection must load Session runtime config');
assert(runtimeLoadBody.includes('requestSessionKey'), 'runtime config responses must retain the request Session key');
assert(
  stateChangedHandler.includes('loadSessionRuntimeConfigForSession'),
  'terminal Session state changes must proactively reload canonical runtime config'
);
assert(modelLoadBody.includes('/models/refresh'), 'explicit model refresh must use the refresh route');
assert(modelLoadBody.includes("method: 'POST'"), 'explicit model refresh must be POST');
assert(modelLoadBody.includes('applyModelCatalogResponse(request, response)'), 'model responses must be validated before caching');
assert(rebindModelLoadBody.includes('/api-test'), 'a Session must use the selected target API profile to preview models');
assert(rebindModelLoadBody.includes('explicitProfileId: profileId'), 'model preview must use only the explicitly selected Rebind profile');
assert(rebindModelLoadBody.includes('rebindModelPreviewKey(current) !== request.key'), 'stale Session or profile model responses must be ignored');
assert(rebindModelLoadBody.includes('request.profileIdentity'), 'profile configuration changes must invalidate in-flight model previews');
assert(rebindModelLoadBody.includes("cacheState: 'profile preview'"), 'profile model previews must be labeled separately from Session catalogs');
assert(selectedModelLoadBody.includes('canPreviewRebindModels(session)'), 'Models must support an explicit target Rebind profile');
assert(selectedModelLoadBody.includes('loadRebindProfileModelOptions(session)'), 'Models must load the target API catalog before Rebind');
assert(functionSource('modelCacheKey').includes("session?.sessionId || 'none'"), 'model catalogs must be isolated by Session id');
assert(/rebindTargetProfileBySession:\s*new Map\(\)/.test(app), 'Rebind target profiles must be remembered per Session');
const previewState = {
  codexControls: {
    rebindTargetProfileBySession: new Map([
      ['host-a::session-a', 'profile-b'],
      ['host-a::session-b', 'profile-c'],
    ]),
  },
  ui: {
    apiProfiles: [
      { profileId: 'profile-a', provider: 'OpenAI', baseUrl: 'https://a.example/v1', apiKey: 'key-a' },
      { profileId: 'profile-b', provider: 'OpenAI', baseUrl: 'https://b.example/v1', apiKey: 'key-b' },
      { profileId: 'profile-c', provider: 'OpenAI', baseUrl: 'https://c.example/v1', apiKey: 'key-c' },
    ],
  },
};
const previewGlobals = {
  state: previewState,
  getSessionKey: (session) => session ? `${session.hostId}::${session.sessionId}` : '',
  sessionApiBinding: (session) => session?.apiBinding || null,
  apiBindingMatchesProfileIdentity: (binding, profile) => (
    binding?.kind === 'profile' && binding.profileId === profile?.profileId
  ),
  apiProfileRequestConfig: (profile) => profile || null,
  normalizeApiIdentityBaseUrl: (value) => String(value || '').replace(/\/+$/, ''),
};
const rebindPreviewHelpers = loadHelpers([
  'localConfigRevision',
  'rebindProfilePreviewIdentity',
  'rebindTargetValue',
  'selectedRebindProfileId',
  'getSelectedRebindProfile',
  'canPreviewRebindModels',
  'rebindModelPreviewKey',
], previewGlobals);
const unboundPreviewSession = {
  hostId: 'host-a',
  sessionId: 'session-a',
  apiBinding: { kind: 'unknown', bindingFingerprint: null },
};
assert.strictEqual(
  rebindPreviewHelpers.canPreviewRebindModels(unboundPreviewSession),
  true,
  'an unbound Session with an explicit profile must be able to preview provider models'
);
previewState.codexControls.rebindTargetProfileBySession.set('host-a::session-a', '__host_environment__');
assert.strictEqual(
  rebindPreviewHelpers.canPreviewRebindModels(unboundPreviewSession),
  false,
  'an unattested Host environment must not be treated as a profile model preview'
);
previewState.codexControls.rebindTargetProfileBySession.set('host-a::session-a', 'profile-b');
assert.strictEqual(
  rebindPreviewHelpers.canPreviewRebindModels({
    ...unboundPreviewSession,
    apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'binding-a' },
  }),
  true,
  'a profile-to-profile Rebind must preview the target profile instead of the current run catalog'
);
assert.strictEqual(
  rebindPreviewHelpers.canPreviewRebindModels({
    ...unboundPreviewSession,
    apiBinding: { kind: 'profile', profileId: 'profile-b', bindingFingerprint: 'binding-b' },
  }),
  false,
  'the currently bound profile must keep using its richer run-scoped model catalog'
);
assert.strictEqual(
  rebindPreviewHelpers.selectedRebindProfileId({ hostId: 'host-a', sessionId: 'session-b' }),
  'profile-c',
  'switching Sessions must not carry another Session target profile through the shared DOM control'
);
const previewKeyA = rebindPreviewHelpers.rebindModelPreviewKey(unboundPreviewSession);
const previewSessionB = { hostId: 'host-a', sessionId: 'session-b', apiBinding: unboundPreviewSession.apiBinding };
const previewKeyB = rebindPreviewHelpers.rebindModelPreviewKey(previewSessionB);
assert.notStrictEqual(previewKeyA, previewKeyB, 'model preview caches must be isolated by Session');
previewState.ui.apiProfiles[1].apiKey = 'rotated-key-b';
const rotatedPreviewKey = rebindPreviewHelpers.rebindModelPreviewKey(unboundPreviewSession);
assert.notStrictEqual(previewKeyA, rotatedPreviewKey, 'API credential edits must invalidate model preview identity');
previewState.ui.apiProfiles[1].apiKey = 'key-b';
previewState.codexControls.rebindTargetProfileBySession.set('host-a::session-a', 'profile-c');
const otherProfileKey = rebindPreviewHelpers.rebindModelPreviewKey(unboundPreviewSession);
assert.notStrictEqual(previewKeyA, otherProfileKey, 'model preview caches must be isolated by target profile');
previewState.codexControls.rebindTargetProfileBySession.set('host-a::session-a', 'profile-b');
assert(
  sessionDetailsBody.includes('|| isSessionApiRebindBusy(session)'),
  'Rebind must disable the composer model and effort controls while the request is pending'
);
assert(fetchBody.includes('error.code'), 'fetchJson must preserve structured error codes');
for (const field of ['stage', 'sessionBinding', 'submittedBinding', 'canRebind', 'canTranscriptFallback']) {
  assert(fetchBody.includes(`error.${field}`), `fetchJson must preserve ${field}`);
}
assert(rebindBody.includes('/rebind'), 'explicit API changes must use the rebind route');
assert(rebindBody.includes('explicitProfileId'), 'rebind must resolve only the explicitly selected local profile');
assert(
  rebindBody.includes('allowRebindFallback: true'),
  'Rebind must allow canonical recovery for an unverified live projection'
);
assert(functionSource('applyRebindLaunchResponse').includes('sessionWithInvalidatedRuntimeConfig'), 'accepted rebinds must discard the previous run runtime config');
assert(rebindBody.includes('captureSessionLifecycleExpectation'), 'Rebind must capture canonical lifecycle state before its request');
assert(rebindBody.includes('applyRebindLaunchResponse'), 'Rebind responses must be guarded against newer SSE state');
assert(rebindBody.includes('selectionSnapshot'), 'Rebind must use the model selection captured at click time');
assert(rebindBody.includes('apiConfigSnapshot'), 'Rebind must use the API configuration captured at click time');
for (const field of ['expectedRunId', 'expectedRunStatus', 'expectedBindingFingerprint']) {
  assert(rebindBody.includes(field), `Rebind must submit canonical ${field}`);
  assert(endSessionBody.includes(field), `Stop must submit canonical ${field}`);
  assert(stopManagedBody.includes(field), `managed Stop must submit canonical ${field}`);
}
assert(endSessionBody.includes('isSessionApiRebindBusy(session)'), 'Stop must reject while the same Session is rebinding');
assert(stopManagedBody.includes('isSessionApiRebindBusy(session)'), 'managed Stop must reject while the same Session is rebinding');
assert((endSessionBody.match(/isSessionApiRebindBusy/g) || []).length >= 2, 'Stop must recheck Rebind busy state after loading canonical runtime config');
assert((stopManagedBody.match(/isSessionApiRebindBusy/g) || []).length >= 2, 'managed Stop must recheck Rebind busy state after loading canonical runtime config');
assert(sessionDetailsBody.includes('isSessionApiRebindBusy(session)'), 'the main Stop control must stay disabled during Rebind');
assert(composerControlsBody.includes('disabled || submitting'), 'Models must stay disabled with the rest of the composer during Rebind');
assert(/sessionApiRebindBusyKeys:\s*new Set\(\)/.test(app), 'Session Rebind busy state must survive re-renders');
assert(/sessionTranscriptFallbackBusyKeys:\s*new Set\(\)/.test(app), 'transcript fallback busy state must survive re-renders');
assert(controlsBody.includes('isSessionApiRebindBusy(session)'), 'Session API controls must derive disabled state from persistent busy state');
assert(controlsBody.includes('isSessionTranscriptFallbackBusy(session)'), 'Session API controls must preserve transcript fallback busy state');
assert(
  controlsBody.includes('rebindButton.disabled = !session || rebindBusy'),
  'rendering Session API controls must not re-enable an in-flight Rebind button'
);
const rebindClickHandler = app.slice(
  app.indexOf("el('session-api-rebind-button')?.addEventListener('click'"),
  app.indexOf("el('session-transcript-fallback-button')?.addEventListener('click'")
);
assert(rebindClickHandler.includes('isSessionApiRebindBusy(session)'), 'double Rebind clicks must be ignored locally');
assert(
  rebindClickHandler.indexOf('selectionSnapshot = sessionSelectionRequestBody(session)')
    < rebindClickHandler.indexOf('setSessionApiRebindBusy(session, true)'),
  'Rebind must snapshot and validate model selection before starting asynchronous runtime checks'
);
assert(rebindClickHandler.includes('targetProfile, selectionSnapshot'), 'Rebind must submit the captured profile and model selection together');
assert(rebindClickHandler.includes('selectionSnapshot, apiConfigSnapshot'), 'Rebind must submit one coherent model and API configuration snapshot');
assert(
  rebindClickHandler.indexOf('resolveLaunchApiConfig({')
    < rebindClickHandler.indexOf('setSessionApiRebindBusy(session, true)'),
  'Rebind must snapshot the target API configuration before asynchronous runtime checks'
);
assert(rebindClickHandler.includes('setSessionApiRebindBusy(session, true)'), 'Rebind busy state must be set before awaiting the request');
assert(rebindClickHandler.includes('setSessionApiRebindBusy(session, false)'), 'Rebind busy state must be cleared in finally');
const fallbackClickHandler = app.slice(
  app.indexOf("el('session-transcript-fallback-button')?.addEventListener('click'"),
  app.indexOf("el('codex-model-select').addEventListener('change'")
);
assert(fallbackClickHandler.includes('isSessionTranscriptFallbackBusy(session)'), 'double transcript fallback clicks must be ignored locally');
assert(fallbackClickHandler.includes('setSessionTranscriptFallbackBusy(session, true)'), 'transcript fallback busy state must be set before awaiting the request');
assert(fallbackClickHandler.includes('setSessionTranscriptFallbackBusy(session, false)'), 'transcript fallback busy state must be cleared in finally');
assert(fallbackBody.includes('canTranscriptFallback'), 'fallback must require server-provided eligibility');
assert(fallbackBody.includes('window.confirm'), 'transcript fallback must require confirmation');
assert(fallbackBody.includes('/transcript-fallback'), 'fallback must use its explicit route');
assert(fallbackBody.includes('loadCanonicalSessionForLifecycleMutation'), 'fallback must load canonical source lifecycle state');
assert(fallbackBody.includes('captureSessionLifecycleExpectation'), 'fallback must capture the canonical source run');
for (const field of ['expectedRunId', 'expectedRunStatus', 'expectedBindingFingerprint']) {
  assert(fallbackBody.includes(field), `fallback must submit canonical ${field}`);
}
assert(controlsBody.includes('cacheState'), 'catalog status must expose cache freshness');
assert(controlsBody.includes('catalog.sources'), 'catalog status must expose evidence sources');
assert(launchBody.includes('latest?.resumeError || structuredSessionError(error)'), 'launch failure must preserve the server resume error');
assert(
  launchBody.includes('sessionSelectionRequestBody(sourceSession)'),
  'ordinary resume/fork launches must submit the user-selected model and effort'
);

const state = {
  ui: {
    apiProfiles: [{
      profileId: 'profile-a',
      label: 'Profile A',
      provider: 'OpenAI',
      baseUrl: 'https://a.example/v1',
      apiKey: 'test-only-key',
    }],
  },
};
const rebindBusyState = { sessionApiRebindBusyKeys: new Set(['host-a::session-a']) };
const rebindBusyHelpers = loadHelpers([
  'sessionApiRebindBusyKey',
  'isSessionApiRebindBusy',
], {
  state: rebindBusyState,
  getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
});
assert.strictEqual(
  rebindBusyHelpers.isSessionApiRebindBusy({ hostId: 'host-a', sessionId: 'session-a' }),
  true
);
assert.strictEqual(
  rebindBusyHelpers.isSessionApiRebindBusy({ hostId: 'host-a', sessionId: 'session-b' }),
  false
);
const fallbackBusyState = { sessionTranscriptFallbackBusyKeys: new Set(['host-a::session-a']) };
const fallbackBusyHelpers = loadHelpers([
  'sessionTranscriptFallbackBusyKey',
  'isSessionTranscriptFallbackBusy',
], {
  state: fallbackBusyState,
  getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
});
assert.strictEqual(
  fallbackBusyHelpers.isSessionTranscriptFallbackBusy({ hostId: 'host-a', sessionId: 'session-a' }),
  true
);
assert.strictEqual(
  fallbackBusyHelpers.isSessionTranscriptFallbackBusy({ hostId: 'host-a', sessionId: 'session-b' }),
  false
);
const bindingHelpers = loadHelpers([
  'sessionContractError',
  'sessionApiBinding',
  'apiProfileRequestConfig',
  'normalizeApiIdentityBaseUrl',
  'apiBindingMatchesProfileIdentity',
  'resolveApiProfileRequestConfig',
  'resolveLaunchApiConfig',
  'modelCatalogRunId',
  'modelCacheKey',
  'skillCacheKey',
], {
  state,
  getApiRequestConfig: (hostId) => ({ profileId: `default-${hostId}` }),
  validateApiConfigForRequest: () => {},
  getSessionKey: (session) => `${session?.hostId || 'none'}::${session?.sessionId || 'none'}`,
});

const summaryHelpers = loadHelpers([
  'sessionApiBinding',
  'getSessionApiProfileSummary',
], {
  getApiProfileForHost: () => ({
    profileId: 'host-default',
    label: 'Current Host Default',
    provider: 'OpenAI',
    baseUrl: 'https://host-default.example/v1',
    apiKey: 'host-default-secret',
  }),
});
const canonicalSummary = summaryHelpers.getSessionApiProfileSummary({
  hostId: 'host-a',
  live: false,
  apiProfile: {
    profileId: 'stale-profile',
    label: 'Stale Projection',
    provider: 'OpenAI',
    baseUrl: 'https://stale.example/v1',
  },
  runtimeConfig: {
    apiBinding: {
      kind: 'profile',
      profileId: 'canonical-profile',
      label: 'Canonical Session API',
      provider: 'OpenAI',
      normalizedBaseUrl: 'https://canonical.example/v1',
      bindingFingerprint: 'canonical-binding',
    },
  },
});
assert(canonicalSummary.label.includes('Canonical Session API'), 'Session API summary must prefer the canonical run binding');
assert(!canonicalSummary.label.includes('Stale Projection'), 'stale Session projections must not override the canonical run binding');
assert(!canonicalSummary.label.includes('Current Host Default'), 'Host defaults must not be presented as the Session API');
assert(!/restart for/i.test(canonicalSummary.label), 'changing a Host default must not imply that an existing Session should restart');
assert.strictEqual(canonicalSummary.source, 'binding');

const hostEnvironmentSummary = summaryHelpers.getSessionApiProfileSummary({
  hostId: 'host-a',
  runtimeConfig: {
    apiBinding: {
      kind: 'host_environment',
      label: 'Host environment',
      provider: 'OpenAI',
      normalizedBaseUrl: 'https://host-environment.example/v1',
      bindingFingerprint: 'host-environment-binding',
    },
  },
});
assert(hostEnvironmentSummary.label.includes('Host environment'));
assert.strictEqual(hostEnvironmentSummary.source, 'binding');

assert(!app.includes('Restart sessions using changed API settings?'), 'saving a new-Session Host default must not offer to restart existing Sessions');
assert(!app.includes('getApiChangedLiveSessions'), 'Host-default settings must not drive existing Session lifecycle');
assert(!/'settings\.apiCopy': '.*starting or restarting Codex app-server sessions\.'/i.test(app), 'API profile copy must not imply Host defaults change resumed Sessions');
assert(!/'settings\.apiRestartTip': 'After changing an API key or Base URL/i.test(app), 'provider changes must use explicit Session rebind, not a generic restart');
assert(html.includes('Host mappings are defaults for new Sessions only.'), 'API settings must explain fresh-Session-only Host defaults');

const historical = {
  hostId: 'host-a',
  sessionId: 'session-a',
  activeRunId: 'candidate-run',
  apiBinding: { kind: 'profile', profileId: 'candidate', bindingFingerprint: 'candidate-binding' },
  runtimeConfig: {
    runId: 'successful-run',
    activeRunId: null,
    apiBinding: {
      kind: 'profile',
      profileId: 'profile-a',
      provider: 'OpenAI',
      normalizedBaseUrl: 'https://a.example/v1',
      bindingFingerprint: 'binding-a',
    },
  },
};
assert.strictEqual(bindingHelpers.sessionApiBinding(historical).profileId, 'profile-a', 'canonical runtime config must win over a failed candidate projection');
assert.strictEqual(
  bindingHelpers.sessionApiBinding({
    runtimeConfig: { apiBinding: null, sessionBinding: null },
    apiBinding: { kind: 'profile', profileId: 'stale-top-level' },
  }),
  null,
  'an explicit canonical null must clear a stale projected binding'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(bindingHelpers.resolveLaunchApiConfig({ hostId: 'host-a', sourceSession: null }))),
  { apiConfig: { profileId: 'default-host-a' }, explicitRebind: false },
  'fresh runs must use the browser Host default'
);
assert.strictEqual(bindingHelpers.resolveLaunchApiConfig({ hostId: 'host-a', sourceSession: historical }).apiConfig.profileId, 'profile-a');
assert.strictEqual(
  bindingHelpers.normalizeApiIdentityBaseUrl('https://tenant.example/v1/?tenant=alpha&api-version=2026-07-01#local'),
  bindingHelpers.normalizeApiIdentityBaseUrl('https://tenant.example/v1?api-version=2026-07-01&tenant=alpha'),
  'API identity query ordering must be canonical and fragments must be ignored'
);
assert.notStrictEqual(
  bindingHelpers.normalizeApiIdentityBaseUrl('https://tenant.example/v1?tenant=alpha&api-version=2026-07-01'),
  bindingHelpers.normalizeApiIdentityBaseUrl('https://tenant.example/v1?tenant=beta&api-version=2026-07-01'),
  'tenant and API-version query values are part of API identity'
);
const queryIdentityProfile = {
  profileId: 'query-profile',
  label: 'Query identity profile',
  provider: 'OpenAI',
  baseUrl: 'https://tenant.example/v1?tenant=alpha&api-version=2026-07-01',
  apiKey: 'query-identity-test-key',
};
state.ui.apiProfiles.push(queryIdentityProfile);
const queryBoundSession = {
  runtimeConfig: {
    apiBinding: {
      kind: 'profile',
      profileId: 'query-profile',
      provider: 'OpenAI',
      normalizedBaseUrl: 'https://tenant.example/v1?api-version=2026-07-01&tenant=alpha',
      bindingFingerprint: 'query-binding',
    },
  },
};
assert.doesNotThrow(
  () => bindingHelpers.resolveLaunchApiConfig({ hostId: 'host-a', sourceSession: queryBoundSession }),
  'query parameter order alone must not change API identity'
);
queryIdentityProfile.baseUrl = 'https://tenant.example/v1?tenant=beta&api-version=2026-07-01';
assert.throws(
  () => bindingHelpers.resolveLaunchApiConfig({ hostId: 'host-a', sourceSession: queryBoundSession }),
  (error) => error.code === 'session_api_binding_mismatch',
  'changing a tenant or API-version query must require explicit Session rebind'
);
assert.throws(
  () => bindingHelpers.resolveLaunchApiConfig({
    hostId: 'host-a',
    sourceSession: {
      runtimeConfig: {
        apiBinding: {
          kind: 'profile',
          profileId: 'profile-a',
          provider: 'OpenAI',
          normalizedBaseUrl: 'https://original.example/v1',
          bindingFingerprint: 'original-binding',
        },
      },
    },
  }),
  (error) => error.code === 'session_api_binding_mismatch' && error.canRebind === true,
  'editing provider identity under the same profileId must require explicit Session rebind'
);
assert.throws(
  () => bindingHelpers.resolveLaunchApiConfig({
    hostId: 'host-a',
    sourceSession: {
      runtimeConfig: {
        apiBinding: {
          kind: 'profile',
          profileId: 'profile-a',
          provider: null,
          normalizedBaseUrl: 'https://a.example/v1',
          bindingFingerprint: 'legacy-provider-null-binding',
        },
      },
    },
  }),
  (error) => error.code === 'session_api_binding_mismatch',
  'provider null and provider OpenAI are distinct binding identities'
);
state.ui.apiProfiles[0].apiKey = 'rotated-test-only-key';
assert.strictEqual(
  bindingHelpers.resolveLaunchApiConfig({
    hostId: 'host-a',
    sourceSession: {
      runtimeConfig: {
        apiBinding: {
          kind: 'profile',
          profileId: 'profile-a',
          provider: 'OpenAI',
          normalizedBaseUrl: 'https://a.example/v1/',
          bindingFingerprint: 'same-identity-new-secret',
        },
      },
    },
  }).apiConfig.apiKey,
  'rotated-test-only-key',
  'credential rotation must remain allowed when profile identity is unchanged'
);
assert.strictEqual(
  bindingHelpers.resolveLaunchApiConfig({
    hostId: 'host-a',
    sourceSession: { runtimeConfig: { apiBinding: { kind: 'host_environment', bindingFingerprint: 'host-env' } } },
  }).apiConfig,
  null,
  'Host-environment resume must omit apiConfig'
);
assert.throws(
  () => bindingHelpers.resolveLaunchApiConfig({
    hostId: 'host-a',
    sourceSession: { runtimeConfig: { apiBinding: { kind: 'unknown' } } },
  }),
  (error) => error.code === 'session_api_binding_unavailable'
);
assert.throws(
  () => bindingHelpers.resolveLaunchApiConfig({
    hostId: 'host-a',
    sourceSession: { runtimeConfig: { apiBinding: { kind: 'profile', profileId: 'deleted' } } },
  }),
  (error) => error.code === 'session_api_binding_unavailable'
);
state.ui.apiProfiles.push({
  profileId: 'empty-profile',
  label: 'Empty profile',
  provider: 'OpenAI',
  baseUrl: '',
  apiKey: '',
});
assert.throws(
  () => bindingHelpers.resolveLaunchApiConfig({
    hostId: 'host-a',
    sourceSession: { runtimeConfig: { apiBinding: { kind: 'profile', profileId: 'empty-profile' } } },
  }),
  (error) => error.code === 'session_api_binding_unavailable',
  'an empty local profile must not silently turn a profile-bound resume into Host-environment binding'
);

const runB = { ...historical, runtimeConfig: { ...historical.runtimeConfig, runId: 'run-b' } };
const bindingB = {
  ...historical,
  runtimeConfig: {
    ...historical.runtimeConfig,
    apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'binding-b' },
  },
};
assert.notStrictEqual(bindingHelpers.modelCacheKey(historical), bindingHelpers.modelCacheKey(runB));
assert.notStrictEqual(bindingHelpers.modelCacheKey(historical), bindingHelpers.modelCacheKey(bindingB));
assert.strictEqual(bindingHelpers.skillCacheKey(historical), bindingHelpers.skillCacheKey(runB), 'skill cache must not follow run changes');
assert.strictEqual(bindingHelpers.skillCacheKey(historical), bindingHelpers.skillCacheKey(bindingB), 'skill cache must not follow API changes');

const runtimeState = {
  sessions: [
    { hostId: 'host-a', sessionId: 'session-a', apiBinding: { kind: 'unknown' } },
    { hostId: 'host-a', sessionId: 'session-b', apiBinding: { kind: 'profile', profileId: 'b' } },
  ],
};
const runtimeHelpers = loadHelpers([
  'sessionRuntimeProjectionRunId',
  'runtimeConfigResponseRunId',
  'isTerminalSessionLifecycleState',
  'canApplyCanonicalRuntimeFallback',
  'applySessionRuntimeConfig',
], {
  state: runtimeState,
  getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
  mergeSession: (patch) => {
    const index = runtimeState.sessions.findIndex((session) => session.hostId === patch.hostId && session.sessionId === patch.sessionId);
    runtimeState.sessions[index] = { ...runtimeState.sessions[index], ...patch };
    return runtimeState.sessions[index];
  },
});
assert.strictEqual(
  runtimeHelpers.isTerminalSessionLifecycleState({ state: 'failed', live: false }),
  true,
  'an unqualified failed state must trigger canonical runtime recovery'
);
runtimeHelpers.applySessionRuntimeConfig('host-a::session-a', {
  runId: 'run-a',
  apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
});
assert.strictEqual(runtimeState.sessions[0].runtimeConfig.runId, 'run-a');
assert.strictEqual(runtimeState.sessions[0].apiBinding.profileId, 'a');
runtimeHelpers.applySessionRuntimeConfig('host-a::session-a', {
  runId: 'run-without-binding',
  apiBinding: null,
  sessionBinding: null,
});
assert.strictEqual(runtimeState.sessions[0].runtimeConfig.apiBinding, null, 'canonical null must not retain an older runtime binding');
assert.strictEqual(runtimeState.sessions[0].apiBinding, null, 'canonical null must clear the Session projection');
assert.strictEqual(runtimeState.sessions[1].runtimeConfig, undefined, 'a late response must not merge into the newly selected Session');
runtimeState.sessions[0] = {
  ...runtimeState.sessions[0],
  runId: 'run-b',
  activeRunId: 'run-b',
  runtimeConfig: null,
  apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
};
const pendingRunResponse = runtimeHelpers.applySessionRuntimeConfig('host-a::session-a', {
  runId: 'run-a',
  activeRunId: 'run-b',
  runStatus: 'live',
  apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
  pendingRun: { runId: 'run-b', status: 'pending' },
}, 'run-b');
assert.strictEqual(pendingRunResponse, null, 'successful run A must not repopulate runtime config while run B is pending');
assert.strictEqual(runtimeState.sessions[0].runtimeConfig, null);
assert.strictEqual(runtimeState.sessions[0].apiBinding.profileId, 'b');
runtimeState.sessions[0] = {
  ...runtimeState.sessions[0],
  state: 'failed:session_native_resume_failed',
  live: false,
  runId: 'run-b',
  activeRunId: 'run-b',
  runtimeConfig: null,
  resumeError: { code: 'session_native_resume_failed' },
  apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
};
const failedCandidateFallback = runtimeHelpers.applySessionRuntimeConfig('host-a::session-a', {
  runId: 'run-a',
  activeRunId: null,
  runStatus: 'stopped',
  apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
  pendingRun: null,
}, 'run-b');
assert(failedCandidateFallback, 'a terminal failed candidate must accept the canonical latest-successful run');
assert.strictEqual(runtimeState.sessions[0].runtimeConfig.runId, 'run-a');
assert.strictEqual(runtimeState.sessions[0].apiBinding.profileId, 'a');
assert.strictEqual(runtimeState.sessions[0].activeRunId, null, 'canonical null must clear the failed candidate activeRunId');
runtimeState.sessions[0] = {
  ...runtimeState.sessions[0],
  runId: 'run-c',
  activeRunId: 'run-c',
  runtimeConfig: null,
  apiBinding: { kind: 'profile', profileId: 'c', bindingFingerprint: 'binding-c' },
};
const staleRunResponse = runtimeHelpers.applySessionRuntimeConfig('host-a::session-a', {
  runId: 'run-b',
  apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
}, 'run-b');
assert.strictEqual(staleRunResponse, null, 'a runtime-config response for run B must be ignored after run C starts');
assert.strictEqual(runtimeState.sessions[0].runtimeConfig, null, 'a stale response must not repopulate the invalidated runtime cache');
assert.strictEqual(runtimeState.sessions[0].apiBinding.profileId, 'c', 'a stale response must not replace the newer run binding');

runtimeState.sessions[0] = {
  hostId: 'host-a',
  sessionId: 'session-a',
  state: 'running',
  live: true,
  runId: 'host-run-without-provenance',
  activeRunId: null,
  runtimeConfig: null,
  apiBinding: { kind: 'unknown', bindingFingerprint: null },
};
const legacyRuntimeConfig = {
  runId: 'legacy',
  activeRunId: null,
  runStatus: 'stopped',
  apiBinding: { kind: 'unknown', bindingFingerprint: null },
  sessionBinding: { kind: 'unknown', bindingFingerprint: null },
  pendingRun: null,
  canRebind: true,
};
const ordinaryUnknownLiveRefresh = runtimeHelpers.applySessionRuntimeConfig(
  'host-a::session-a',
  legacyRuntimeConfig,
  'host-run-without-provenance'
);
assert.strictEqual(
  ordinaryUnknownLiveRefresh,
  null,
  'ordinary runtime refresh must not replace a live projection with an older canonical run'
);
const rebindUnknownLiveRecovery = runtimeHelpers.applySessionRuntimeConfig(
  'host-a::session-a',
  legacyRuntimeConfig,
  'host-run-without-provenance',
  { allowRebindFallback: true }
);
assert(rebindUnknownLiveRecovery, 'Rebind must recover the canonical legacy run behind an unverified live projection');
assert.strictEqual(rebindUnknownLiveRecovery.runtimeConfig.runId, 'legacy');
assert.strictEqual(rebindUnknownLiveRecovery.runtimeConfig.runStatus, 'stopped');

runtimeState.sessions[0] = {
  hostId: 'host-a',
  sessionId: 'session-a',
  state: 'running',
  live: true,
  runId: 'verified-live-run',
  runtimeConfig: null,
  apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'verified-binding' },
};
const verifiedLiveFallback = runtimeHelpers.applySessionRuntimeConfig(
  'host-a::session-a',
  legacyRuntimeConfig,
  'verified-live-run',
  { allowRebindFallback: true }
);
assert.strictEqual(
  verifiedLiveFallback,
  null,
  'Rebind fallback must not replace a verified live run with a mismatched canonical response'
);

const modelCatalogSessionB = {
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-b',
  activeRunId: 'run-b',
  runtimeConfig: null,
  apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
};
const modelCatalogState = {
  sessions: [modelCatalogSessionB],
  codexControls: {
    modelCatalogByKey: new Map(),
    modelOptionsRetryAfterBySession: new Map(),
  },
};
const modelCatalogHelpers = loadHelpers([
  'sessionApiBinding',
  'modelCatalogRunId',
  'modelCacheKey',
  'captureModelCatalogRequest',
  'modelCatalogResponseMatchesRequest',
  'deferAutoLoadOptions',
  'applyModelCatalogResponse',
], {
  state: modelCatalogState,
  OPTION_AUTO_RETRY_COOLDOWN_MS: 60 * 1000,
  getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
});
const modelRequestB = modelCatalogHelpers.captureModelCatalogRequest(modelCatalogSessionB);
modelCatalogState.codexControls.modelOptionsRetryAfterBySession.set(modelRequestB.key, 12345);
const oldCatalogResponse = modelCatalogHelpers.applyModelCatalogResponse(modelRequestB, {
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-a',
  sessionBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
  models: [{ id: 'model-a' }],
  sources: [],
});
assert.strictEqual(oldCatalogResponse, null, 'an old run/catalog response must be discarded');
assert.strictEqual(modelCatalogState.codexControls.modelCatalogByKey.size, 0);
assert.strictEqual(
  modelCatalogState.codexControls.modelOptionsRetryAfterBySession.get(modelRequestB.key),
  12345,
  'discarded responses must not mutate retry state'
);
const wrongBindingResponse = modelCatalogHelpers.applyModelCatalogResponse(modelRequestB, {
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-b',
  sessionBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
  models: [{ id: 'model-a' }],
  sources: [],
});
assert.strictEqual(wrongBindingResponse, null, 'the response binding must match the request binding fingerprint');
assert.strictEqual(modelCatalogState.codexControls.modelCatalogByKey.size, 0);
modelCatalogState.codexControls.modelOptionsRetryAfterBySession.delete(modelRequestB.key);
modelCatalogHelpers.applyModelCatalogResponse(modelRequestB, {
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-a',
  sessionBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
  models: [{ id: 'model-a' }],
  sources: [],
});
assert(
  modelCatalogState.codexControls.modelOptionsRetryAfterBySession.get(modelRequestB.key) > Date.now(),
  'a discarded response for the still-current catalog key must defer auto-load instead of looping'
);
modelCatalogState.codexControls.modelOptionsRetryAfterBySession.set(modelRequestB.key, 12345);
modelCatalogState.sessions[0] = {
  ...modelCatalogSessionB,
  runId: 'run-c',
  activeRunId: 'run-c',
  apiBinding: { kind: 'profile', profileId: 'c', bindingFingerprint: 'binding-c' },
};
const lateCatalogResponse = modelCatalogHelpers.applyModelCatalogResponse(modelRequestB, {
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-b',
  sessionBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
  models: [{ id: 'model-b' }],
  sources: [],
});
assert.strictEqual(lateCatalogResponse, null, 'a response for B must be discarded after the Session advances to C');
assert.strictEqual(modelCatalogState.codexControls.modelCatalogByKey.size, 0);
assert.strictEqual(modelCatalogState.codexControls.modelOptionsRetryAfterBySession.get(modelRequestB.key), 12345);
modelCatalogState.sessions[0] = modelCatalogSessionB;
const currentCatalogResponse = modelCatalogHelpers.applyModelCatalogResponse(modelRequestB, {
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-b',
  sessionBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
  models: [{ id: 'model-b' }],
  sources: [{ source: 'provider' }],
});
assert.strictEqual(currentCatalogResponse.models[0].id, 'model-b');
assert.strictEqual(modelCatalogState.codexControls.modelCatalogByKey.get(modelRequestB.key), currentCatalogResponse);
assert.strictEqual(modelCatalogState.codexControls.modelOptionsRetryAfterBySession.has(modelRequestB.key), false);

const startedState = {
  sessions: [{
    hostId: 'host-a',
    sessionId: 'session-a',
    apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
    runtimeConfig: {
      runId: 'run-a',
      apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
    },
  }],
};
const runtimeReloads = [];
const startedHelpers = loadHelpers([
  'sessionApiBinding',
  'sessionWithInvalidatedRuntimeConfig',
  'applyConfirmedSessionStarted',
], {
  state: startedState,
  getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
  mergeSession: (patch) => {
    const index = startedState.sessions.findIndex((session) => session.hostId === patch.hostId && session.sessionId === patch.sessionId);
    startedState.sessions[index] = { ...startedState.sessions[index], ...patch };
    return startedState.sessions[index];
  },
  loadSessionRuntimeConfigForSession: (session) => {
    runtimeReloads.push(session);
    return Promise.resolve(session);
  },
});
const reboundStarted = startedHelpers.applyConfirmedSessionStarted({
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-b',
  apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
}, startedState.sessions[0]);
assert.strictEqual(reboundStarted.runtimeConfig, null, 'session.started must invalidate a prior run runtime config before reload');
assert.strictEqual(
  startedHelpers.sessionApiBinding(reboundStarted).profileId,
  'b',
  'the stale runtime config must not keep reporting API A after a confirmed API B start'
);
assert.strictEqual(runtimeReloads.length, 1, 'session.started must reload canonical runtime config');

const refreshBaselineRunA = {
  hostId: 'host-refresh',
  sessionId: 'session-refresh',
  state: 'running',
  live: true,
  runId: 'run-a',
  lastUpdatedAt: '2026-07-17T00:00:00.000Z',
};
const refreshSseRunB = {
  ...refreshBaselineRunA,
  runId: 'run-b',
  activeRunId: 'run-b',
  lastUpdatedAt: '2026-07-17T00:00:02.000Z',
};
const refreshState = {
  sessions: [refreshSseRunB, {
    hostId: 'host-refresh',
    sessionId: 'session-added-by-sse',
    state: 'running',
    live: true,
    runId: 'run-new',
    lastUpdatedAt: '2026-07-17T00:00:03.000Z',
  }],
};
const refreshHelpers = loadHelpers(['reconcileRefreshedSessions'], {
  state: refreshState,
  makeSessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
  applyManualSessionTitle: (session) => session,
  parseSessionTime: (session) => Date.parse(session?.lastUpdatedAt || session?.updatedAt || 0) || 0,
});
refreshHelpers.reconcileRefreshedSessions([
  refreshBaselineRunA,
], new Map([
  ['host-refresh::session-refresh', refreshBaselineRunA],
]));
assert.strictEqual(
  refreshState.sessions.find((session) => session.sessionId === 'session-refresh')?.runId,
  'run-b',
  'a slow refresh response must not overwrite a newer SSE-confirmed run'
);
assert(
  refreshState.sessions.some((session) => session.sessionId === 'session-added-by-sse'),
  'a Session added by SSE during refresh must not disappear when absent from the older list response'
);
assert(/refreshPromise:\s*null/.test(app), 'periodic refreshes must share one in-flight request');
assert(
  app.includes('function refresh() {\n  if (state.refreshPromise)'),
  'refresh must deduplicate overlapping timer/manual calls'
);

const rebindResponseState = {
  sessions: [{
    hostId: 'host-a',
    sessionId: 'session-a',
    state: 'history-only',
    live: false,
    runId: 'sidebar-candidate',
    activeRunId: 'sidebar-candidate',
    apiBinding: { kind: 'profile', profileId: 'sidebar', bindingFingerprint: 'sidebar-binding' },
    runtimeConfig: {
      runId: 'run-a',
      runStatus: 'stopped',
      apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
    },
  }],
};
const rebindResponseHelpers = loadHelpers([
  'sessionWithInvalidatedRuntimeConfig',
  'captureSessionLifecycleExpectation',
  'applyRebindLaunchResponse',
], {
  state: rebindResponseState,
  getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
  mergeSession: (patch) => {
    const index = rebindResponseState.sessions.findIndex((session) => (
      session.hostId === patch.hostId && session.sessionId === patch.sessionId
    ));
    rebindResponseState.sessions[index] = { ...rebindResponseState.sessions[index], ...patch };
    return rebindResponseState.sessions[index];
  },
});
const rebindExpectation = rebindResponseHelpers.captureSessionLifecycleExpectation(rebindResponseState.sessions[0]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(rebindExpectation)), {
  sessionKey: 'host-a::session-a',
  hostId: 'host-a',
  sessionId: 'session-a',
  expectedRunId: 'run-a',
  expectedRunStatus: 'stopped',
  expectedBindingFingerprint: 'binding-a',
});
rebindResponseState.sessions[0] = {
  ...rebindResponseState.sessions[0],
  state: 'running',
  live: true,
  runId: 'run-b',
  activeRunId: 'run-b',
  runtimeConfig: {
    runId: 'run-b',
    runStatus: 'live',
    apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
  },
  apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
};
const lateRebindResponse = rebindResponseHelpers.applyRebindLaunchResponse(rebindExpectation, {
  sessionId: 'session-a',
  runId: 'run-b',
  sessionBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
}, rebindResponseState.sessions[0]);
assert.strictEqual(lateRebindResponse.live, true, 'a late Rebind response must not downgrade an SSE-confirmed live run');
assert.strictEqual(lateRebindResponse.runtimeConfig.runId, 'run-b', 'a late Rebind response must preserve canonical runtime config');
rebindResponseState.sessions[0] = {
  ...rebindResponseState.sessions[0],
  runId: 'run-a',
  activeRunId: 'run-a',
  runtimeConfig: {
    runId: 'run-b',
    runStatus: 'live',
    apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
  },
};
const canonicalRunWins = rebindResponseHelpers.applyRebindLaunchResponse(rebindExpectation, {
  sessionId: 'session-a',
  runId: 'run-b',
  sessionBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
}, rebindResponseState.sessions[0]);
assert.strictEqual(canonicalRunWins.live, true, 'canonical runtime state must win over a stale top-level run projection');
assert.strictEqual(canonicalRunWins.runtimeConfig.runId, 'run-b');

let selectedComposerOptions = { model: 'new-model', effort: 'ultra' };
const selectionHelpers = loadHelpers(['sessionSelectionRequestBody'], {
  getComposerOptionsForSession: () => selectedComposerOptions,
  assertModelSelectionIsSelectable: () => {},
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(selectionHelpers.sessionSelectionRequestBody({}))),
  { model: 'new-model', effort: 'ultra' },
  'explicit non-empty model and effort values must be submitted unchanged'
);
selectedComposerOptions = { model: '', effort: '' };
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(selectionHelpers.sessionSelectionRequestBody({}))),
  {},
  'Auto/default selections must remain omitted rather than being silently replaced'
);

const reasoningHelpers = loadHelpers([
  'normalizeModelOption',
  'supportedEffortValues',
  'inferComposerOptionsFromText',
], {});
const advertised = reasoningHelpers.normalizeModelOption({
  id: 'gpt-test',
  reasoningLevels: ['low', 'max', 'ultra'],
  capabilityKnown: true,
  selectable: true,
  availability: 'available',
});
assert.deepStrictEqual(Array.from(reasoningHelpers.supportedEffortValues(advertised)), ['low', 'max', 'ultra']);
assert.strictEqual(reasoningHelpers.inferComposerOptionsFromText('reasoning effort: ultra').effort, 'ultra');
assert.strictEqual(reasoningHelpers.inferComposerOptionsFromText('effort=max').effort, 'max');
const unknownCapability = reasoningHelpers.normalizeModelOption({ id: 'unknown', capabilityKnown: false });
assert.deepStrictEqual(Array.from(reasoningHelpers.supportedEffortValues(unknownCapability)), [], 'unknown capability must expose only Auto');
assert(functionSource('assertModelSelectionIsSelectable').includes('selectable'), 'unselectable models must be rejected before submit');
assert(inputBody.includes('assertModelSelectionIsSelectable'), 'live input must validate model selectability');

const effortBlock = html.match(/<select id="codex-effort-select"[\s\S]*?<\/select>/)?.[0] || '';
assert(effortBlock, 'reasoning effort select missing');
assert(!/<option value="(?:minimal|low|medium|high|xhigh|max|ultra)"/.test(effortBlock), 'reasoning effort HTML must not hard-code levels');
assert(html.includes('New Session default (this browser)'));
for (const id of [
  'session-api-binding-label',
  'session-host-default-label',
  'session-catalog-status',
  'session-api-rebind-select',
  'session-api-rebind-button',
  'session-transcript-fallback-button',
]) {
  assert(html.includes(`id="${id}"`), `${id} missing`);
}
assert(css.includes('.session-api-context'));
assert(css.includes('@media (max-width: 720px)'));

console.log('session API UI assertions passed');
