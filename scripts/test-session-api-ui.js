const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

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
  const source = names.map((name) => {
    const extracted = functionSource(name);
    return app.includes(`async function ${name}`) ? `async ${extracted}` : extracted;
  }).join('\n');
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
const launchRetryBody = functionSource('fetchManagedLaunchWithRetry');
const newSessionLaunchStateBody = functionSource('renderNewSessionLaunchState');
const newSessionErrorBody = functionSource('setNewSessionLaunchError');
const inputBody = functionSource('sendInputToSession');
const compactBody = functionSource('compactCurrentThread');
const interruptBody = functionSource('interruptActiveTurn');
const restoreSentDraftAfterInterruptBody = functionSource('restoreSentDraftAfterInterrupt');
const endSessionBody = functionSource('endCurrentSession');
const stopManagedBody = functionSource('stopManagedSession');
const sessionDetailsBody = functionSource('renderSessionDetails');
const composerControlsBody = functionSource('renderComposerControls');
const modelLoadBody = functionSource('loadModelOptionsForSession');
const currentModelRefreshBody = functionSource('refreshCurrentModelOptionsForSelectedSession');
const visibleModelRefreshBody = functionSource('refreshVisibleModelOptionsForSelectedSession');
const runtimeLoadBody = functionSource('loadSessionRuntimeConfigForSession');
const runtimeLoadOnOpenBody = functionSource('shouldLoadSessionRuntimeConfigOnOpen');
const showSessionBody = functionSource('showSession');
const fetchBody = functionSource('fetchJson');
const rebindBody = functionSource('rebindSessionApi');
const composerApiSwitchBody = functionSource('switchSessionApiFromComposer');
const queueScheduleBody = functionSource('maybeScheduleQueuedPromptSend');
const moveComposerSessionBody = functionSource('moveComposerDraftSessionKey');
const submitComposerPayloadBody = functionSource('submitComposerPayload');
const sendQueuedPromptBody = functionSource('sendQueuedPrompt');
const guideQueuedPromptBody = functionSource('guideQueuedPrompt');
const forceQueuedPromptBody = functionSource('interruptAndSendQueuedPrompt');
const fallbackBody = functionSource('startTranscriptFallback');
const controlsBody = functionSource('renderSessionApiControls');
const stateChangedHandler = app.slice(
  app.indexOf("state.eventSource.addEventListener('session.state_changed'"),
  app.indexOf("state.eventSource.addEventListener('session.transcript'")
);

assert(launchBody.includes('resolveLaunchApiConfig'), 'managed launch must resolve fresh versus inherited API ownership');
assert(launchBody.includes('sessionLaunchIntentKey'), 'managed launch must lock by Host, workspace, mode, and source intent');
assert(launchBody.includes('getSessionLaunchBusyForIntent'), 'duplicate UI launches must reuse the existing busy intent');
assert(launchBody.includes('clientRequestId: launchBusyId'), 'managed launch must send its stable client creation intent');
assert(launchBody.includes('fetchManagedLaunchWithRetry'), 'managed launch must recover when an accepted HTTP response is lost');
assert(launchRetryBody.includes('JSON.stringify(body)'), 'launch retry must resend the exact accepted request payload');
assert(launchRetryBody.includes('managedLaunchFailureMayHaveLostAcceptedResponse'), 'only an ambiguous transport or server failure may retry creation');
assert(newSessionLaunchStateBody.includes('submitButton.disabled = disabled'), 'New Session submit must disable immediately while its intent is busy');
assert(newSessionLaunchStateBody.includes('Creating Session...'), 'New Session submit must expose an explicit creating state');
assert(newSessionLaunchStateBody.includes('state.newSessionLaunchError'), 'New Session launch failures must remain scoped to the creation form');
assert(newSessionErrorBody.includes('No existing Session history was changed'), 'binding preflight failures must explain that existing history was not modified');
assert(/newSessionLaunchError:\s*null/.test(app), 'New Session launch error state must not be stored on a selected Session');
assert(/sessionLaunchBusy:\s*new Map\(\)/.test(app), 'concurrent launch locks must stay isolated by intent');
assert(!launchBody.includes('explicitProfileId'), 'ordinary launch must never perform an explicit API rebind');
assert(!launchBody.includes('if (!sessionApiBinding(currentSource))'), 'resume must fail closed when canonical runtime config cannot be loaded');
assert(!launchBody.includes('sourceSession = currentSource'), 'resume must not fall back to a list projection after runtime-config failure');
assert(!inputBody.includes('getApiRequestConfig'), 'live input must not resolve the Host default API');
assert(!inputBody.includes('body.apiConfig'), 'live input must not submit apiConfig');
assert(!inputBody.includes('verifyHostAvailable'), 'live input must not wait for an active Host probe before Relay queueing');
assert(inputBody.includes('timeoutMs: 30_000'), 'live input transport must have a bounded browser wait');
assert(/queueAutoSendTimersBySession:\s*new Map\(\)/.test(app), 'queued prompt timers must be isolated by Session');
assert(queueScheduleBody.includes('queueTimers.has(sessionKey)'), 'queue scheduling must deduplicate only within the same Session');
assert(moveComposerSessionBody.includes('item.sessionKey = nextKey'), 'canonical Session migration must retain queued prompts');
assert(moveComposerSessionBody.includes('queueAutoSendTimersBySession'), 'canonical Session migration must retain queued prompt scheduling');
assert(moveComposerSessionBody.includes('window.clearTimeout(previousQueueTimer)'), 'canonical Session migration must cancel a timer whose closure contains the old key');
assert(
  /activeDraft\?\.clientRequestId\s*&&\s*activeDraft\.clientRequestId !== payload\.clientRequestId/.test(submitComposerPayloadBody),
  'a retained direct-send draft must queue the next prompt instead of being overwritten'
);
assert(
  submitComposerPayloadBody.includes("error?.code === 'session_turn_active'"),
  'an authoritative active-turn rejection must fall back to the visible Queue instead of losing the prompt'
);
for (const [name, source] of [
  ['auto send', sendQueuedPromptBody],
  ['Guide', guideQueuedPromptBody],
  ['Interrupt & Send', forceQueuedPromptBody],
]) {
  assert(
    source.includes('item.sending || item.forceSending'),
    `${name} must share the Queue item in-flight guard`
  );
}
assert(
  queueScheduleBody.includes('maybeScheduleQueuedPromptSend(current)'),
  'a Queue timer that observes a Session switch must schedule the newly selected Session'
);
assert(!compactBody.includes('getApiRequestConfig'), 'compact must not resolve the Host default API');
assert(!compactBody.includes('body.apiConfig'), 'compact must not submit apiConfig');
assert(
  interruptBody.includes('const interruptRequestId = makeClientId()')
    && interruptBody.includes('interruptRequestId,'),
  'Interrupt must create and reuse one stable request identity'
);
assert(interruptBody.includes('expectedRunId:'), 'Interrupt must target the observed Session run');
assert(interruptBody.includes('expectedTurnId:'), 'Interrupt must target the observed turn when known');
assert(interruptBody.includes('expectedClientRequestId:'), 'Interrupt must target acceptance-unknown input identity');
assert(
  restoreSentDraftAfterInterruptBody.includes('await waitForActiveTurnToClear(session)'),
  'draft restoration must wait for terminal turn state'
);
assert(app.includes("state.eventSource.addEventListener('session.transcript_removed'"));
assert(app.includes("'session.transcript_removed',"), 'transcript removals must participate in SSE cursor replay');
assert(runtimeLoadBody.includes('/runtime-config?'), 'selection must load Session runtime config');
assert(runtimeLoadBody.includes('requestSessionKey'), 'runtime config responses must retain the request Session key');
assert(runtimeLoadBody.includes('sessionRuntimeConfigRequests'), 'runtime config reads must share one in-flight request per Session run');
assert(runtimeLoadBody.includes('isTransientFreshRuntimeConfigFailure'), 'fresh runtime config races must retry without becoming saved-history errors');
assert(showSessionBody.includes('shouldLoadSessionRuntimeConfigOnOpen(session)'), 'opening a starting Session must defer runtime config until startup is confirmed');
assert(runtimeLoadOnOpenBody.includes('!isManagedSessionStarting(session)'));
assert(/sessionRuntimeConfigRequests:\s*new Map\(\)/.test(app), 'runtime config request deduplication must be isolated in state');
assert(
  stateChangedHandler.includes('loadSessionRuntimeConfigForSession'),
  'terminal Session state changes must proactively reload canonical runtime config'
);
assert(modelLoadBody.includes('/models/refresh'), 'explicit model refresh must use the refresh route');
assert(modelLoadBody.includes("method: 'POST'"), 'explicit model refresh must be POST');
assert(!modelLoadBody.includes('resolveLaunchApiConfig'), 'live model refresh must not reuse a browser credential that may have rotated');
assert(!modelLoadBody.includes('body.apiConfig'), 'live model refresh must query the running app-server only');
assert(modelLoadBody.includes('applyModelCatalogResponse(request, response)'), 'model responses must be validated before caching');
assert(currentModelRefreshBody.includes('loadModelOptionsForSession'), 'the active-model helper must still refresh the running Session catalog');
assert(!currentModelRefreshBody.includes('loadRebindProfileModelOptions'), 'the active-model helper must remain isolated from Rebind targets');
assert(visibleModelRefreshBody.includes('refreshCurrentModelOptionsForSelectedSession'), 'the composer refresh button must use the active Session catalog');
assert(!visibleModelRefreshBody.includes('loadRebindProfileModelOptions'), 'the composer refresh button must never switch to a staged API catalog');
assert(!functionSource('activeModelCatalogKey').includes('rebindModelPreviewKey'), 'ordinary Session model controls must never switch to a Rebind target catalog');
assert(!functionSource('getSessionControlModelCatalog').includes('state.settingsOpen'), 'opening Settings must not replace the active Session catalog');
assert(!functionSource('getSessionControlModelCatalog').includes('getRebindTargetModelCatalog'), 'composer controls must always use the active Session catalog');
assert(!functionSource('providerInputForModelCatalog').includes('state.settingsOpen'), 'thinking metadata must always follow the actual Session binding');
assert(!composerControlsBody.includes('requestRebindModelOptionsForSession'), 'rendering composer controls must not stage a target API catalog');
assert(functionSource('modelCacheKey').includes("session?.sessionId || 'none'"), 'model catalogs must be isolated by Session id');
assert(
  sessionDetailsBody.includes('|| isSessionApiRebindBusy(session)'),
  'Rebind must disable the composer model and effort controls while the request is pending'
);
assert(fetchBody.includes('error.code'), 'fetchJson must preserve structured error codes');
assert(fetchBody.includes('AbortController'), 'fetchJson must support bounded request cancellation');
for (const field of ['stage', 'sessionBinding', 'submittedBinding', 'canRebind', 'canTranscriptFallback']) {
  assert(fetchBody.includes(`error.${field}`), `fetchJson must preserve ${field}`);
}
assert(rebindBody.includes('/rebind'), 'explicit API changes must use the rebind route');
assert(rebindBody.includes('explicitProfileId'), 'rebind must resolve only the explicitly selected local profile');
assert(
  rebindBody.includes('loadStableCanonicalSessionForRebind'),
  'Rebind must obtain a bounded-retry canonical runtime snapshot'
);
assert(functionSource('loadStableCanonicalSessionForRebind').includes('allowRebindFallback: true'));
assert(functionSource('loadStableCanonicalSessionForRebind').includes('maxAttempts'));
assert(functionSource('applyRebindLaunchResponse').includes('sessionWithInvalidatedRuntimeConfig'), 'accepted rebinds must discard the previous run runtime config');
assert(rebindBody.includes('captureSessionLifecycleExpectation'), 'Rebind must capture canonical lifecycle state before its request');
assert(rebindBody.includes('applyRebindLaunchResponse'), 'Rebind responses must be guarded against newer SSE state');
assert(rebindBody.includes('selectionSnapshot'), 'Rebind must use the model selection captured at click time');
assert(rebindBody.includes('apiConfigSnapshot'), 'Rebind must use the API configuration captured at click time');
assert(rebindBody.indexOf('loadStableCanonicalSessionForRebind') < rebindBody.indexOf('rebindSelectionRequestBody(canonicalSession'), 'selection must be resolved after canonical runtime');
assert(rebindBody.indexOf('loadStableCanonicalSessionForRebind') < rebindBody.indexOf('resolveLaunchApiConfig({'), 'API target must be captured after canonical runtime');
assert(rebindBody.includes('formatSessionRebindConfirmation'), 'Rebind confirmation must show the captured transition');
assert(functionSource('formatSessionRebindConfirmation').includes("formatUiText('session.rebindConfirmEndpoint'"));
assert(rebindBody.includes('waitForExplicitRebindCompletion'), 'single Rebind must wait for the accepted run to become live');
assert(rebindBody.includes('reconcileAcceptedRebind'), 'accepted Rebind must reconcile transient completion failures');
assert(rebindBody.includes('rebindResponseWasAccepted'), 'single Rebind must recover when its accepted HTTP response is lost');
assert(rebindBody.includes('rebindResponseWithClientSelection'), 'every accepted Rebind response must retain the submitted selection snapshot');
assert(rebindBody.includes('rebindFailureMayHaveLostAcceptedResponse(error)'), 'definitive HTTP failures must not be mistaken for lost accepted responses');
assert(rebindBody.includes('normalizeRebindSelectionSnapshot(rawSelection)'), 'partial Rebind selections must be materialized before submission');
assert(rebindBody.includes('recordSessionRebindFailure'), 'confirmed Rebind failures must be remembered');
assert(!functionSource('recordSessionRebindFailure').includes('apiKey'), 'persisted Rebind failure state must never include API keys');
for (const field of ['expectedRunId', 'expectedRunStatus', 'expectedBindingFingerprint']) {
  assert(rebindBody.includes(field), `Rebind must submit canonical ${field}`);
  assert(endSessionBody.includes(field), `Stop must submit canonical ${field}`);
  assert(stopManagedBody.includes(field), `managed Stop must submit canonical ${field}`);
}
assert(!endSessionBody.includes('isSessionApiRebindBusy(session)'), 'Stop must remain available while a pending Rebind is starting');
assert(!stopManagedBody.includes('isSessionApiRebindBusy(session)'), 'batch Stop must remain available while a pending Rebind is starting');
assert(
  sessionDetailsBody.includes('resumeButton.disabled = isEnding || Boolean(launchBusy);'),
  'the main Stop control must remain available during a pending Rebind'
);
assert(composerControlsBody.includes('disabled || submitting'), 'Models must stay disabled with the rest of the composer during Rebind');
assert(
  composerControlsBody.indexOf('applyComposerOptionsToControls(session)') < composerControlsBody.indexOf('renderComposerModelOptions(session)'),
  'stored Session values must populate the hidden model input before a new Rebind catalog is rendered'
);
assert(/sessionApiRebindBusyKeys:\s*new Set\(\)/.test(app), 'Session Rebind busy state must survive re-renders');
assert(/sessionTranscriptFallbackBusyKeys:\s*new Set\(\)/.test(app), 'transcript fallback busy state must survive re-renders');
assert(controlsBody.includes('isSessionApiRebindBusy(session)'), 'Session API controls must derive disabled state from persistent busy state');
assert(controlsBody.includes('isSessionTranscriptFallbackBusy(session)'), 'Session API controls must preserve transcript fallback busy state');
assert(
  controlsBody.includes('rebindBusy || activeTurn || !supportsTurnSelection'),
  'rendering Session API controls must not re-enable an in-flight or active-turn API switch'
);
const rebindClickHandler = app.slice(
  app.indexOf("el('session-api-rebind-button')?.addEventListener('click'"),
  app.indexOf("el('session-transcript-fallback-button')?.addEventListener('click'")
);
const rebindSelectChangeHandler = app.slice(
  app.indexOf("el('session-api-rebind-select')?.addEventListener('change'"),
  app.indexOf("el('session-transcript-fallback-button')?.addEventListener('click'")
);
assert(rebindClickHandler.includes('isSessionApiRebindBusy(session)'), 'double Rebind clicks must be ignored locally');
assert(rebindClickHandler.includes('switchSessionApiFromComposer'), 'the restart icon must use the canonical composer API switch path');
assert(rebindSelectChangeHandler.includes('switchSessionApiFromComposer'), 'changing API must enter the confirmed switch path');
assert(!rebindSelectChangeHandler.includes('rememberRebindTarget'), 'an unconfirmed API choice must never become persistent state');
assert(composerApiSwitchBody.includes('runtimeIsActive(runtime)'), 'API switching must stop at an active-turn guard');
assert(composerApiSwitchBody.includes('requireIdle: true'), 'API switching must reject a turn that becomes busy during preflight');
assert(composerApiSwitchBody.includes('setSessionApiRebindBusy(current, true)'), 'API switch busy state must be set before awaiting the request');
assert(composerApiSwitchBody.includes('setSessionApiRebindBusy(current, false)'), 'API switch busy state must be cleared in finally');
assert(composerApiSwitchBody.includes('if (!response)'), 'canceling the confirmation must keep the actual API');
assert(composerApiSwitchBody.includes("model: ''"), 'API switching must not submit the previous API model');
assert(composerApiSwitchBody.includes("effort: ''"), 'API switching must reset thinking to Auto');
assert(composerApiSwitchBody.includes('preferredModelForApiSwitch(catalog, {'), 'API switching must select a model from the rebound Session catalog');
assert(composerApiSwitchBody.includes('response?.modelCatalog'), 'API switching must use the target catalog returned by Rebind before a racing live refresh');
assert(composerApiSwitchBody.includes('requireFreshProvider: Boolean(profile)'), 'profile switching must not choose a fallback runtime model when provider evidence is unavailable');
assert(composerApiSwitchBody.includes('apiConfigSnapshot'), 'API switching must submit the profile configuration captured at click time');
assert(composerApiSwitchBody.includes('applySessionSelectionToSessionOptions(reboundSession, nextSelection)'), 'a successful switch must save the target API selection on the canonical Session');
assert(composerApiSwitchBody.includes('recordSessionRebindFailure'), 'preparation failures must also be remembered locally');
assert(composerApiSwitchBody.includes('reportError(error)'), 'API switch failures must remain visible');
assert(!composerApiSwitchBody.includes('rememberRebindTarget'), 'API switching must not persist a staged dropdown target');
assert(functionSource('resumeFromHistory').includes('confirmResumeAfterFailedRebind'), 'ordinary Resume must warn after a failed explicit Rebind');
assert(/sessionRebindFailures:\s*new Map\(\)/.test(app), 'failed Rebind warnings must survive re-renders');
assert(app.includes('SESSION_REBIND_FAILURES_STORAGE_KEY'), 'failed Rebind warnings must survive page reloads');
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
assert(controlsBody.includes('selectableCatalogModels(catalog).length'), 'catalog status must report actual selectable membership');
assert(controlsBody.includes('unavailable hidden'), 'catalog status must explain hidden unavailable references');
assert(controlsBody.includes('modelOptionsErrorsByKey'), 'catalog failures must remain visible inline');
assert(controlsBody.includes('sessionApiControlValue(session)'), 'API controls must always render from the actual Session binding');
assert(controlsBody.includes('runtimeIsActive(runtime)'), 'the API selector must be disabled while a turn is active');
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
      providerKind: 'openai',
      baseUrl: 'https://a.example/v1',
      apiKey: 'test-only-key',
    }],
  },
};

const profileNormalizationHelpers = loadHelpers([
  'normalizeSessionDefaults',
  'normalizeApiProfile',
], {
  REASONING_EFFORT_PATTERN: /^[a-z][a-z0-9_-]{0,31}$/,
  DEFAULT_UI_SETTINGS: {
    apiProfiles: [{ profileId: 'default', label: 'OpenAI', provider: 'OpenAI', providerKind: 'openai' }],
  },
  makeApiProfileId: () => 'generated-profile',
  inferApiProviderKind: (input = {}) => {
    const explicit = String(input.providerKind || '').toLowerCase();
    if (explicit) return explicit;
    const provider = String(input.provider || '').toLowerCase();
    if (provider === 'openai') return 'openai';
    if (provider.includes('claude') || provider.includes('anthropic')) return 'anthropic';
    if (provider.includes('gemini')) return 'gemini';
    return 'custom';
  },
  canonicalProviderLabel: (kind) => ({ openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', custom: 'Custom' }[kind]),
});
const migratedClaude = profileNormalizationHelpers.normalizeApiProfile({
  profileId: 'legacy-claude',
  label: 'Legacy Claude',
  provider: 'Claude',
  baseUrl: 'https://legacy.example/v1',
});
assert.strictEqual(migratedClaude.providerKind, 'anthropic');
assert.strictEqual(migratedClaude.provider, 'Claude', 'providerKind migration must not change API binding identity text');
const normalizedDefaultProfile = profileNormalizationHelpers.normalizeApiProfile();
assert.strictEqual(normalizedDefaultProfile.providerKind, 'openai');
assert.strictEqual(normalizedDefaultProfile.provider, 'OpenAI');

const unsavedProfile = {
  profileId: 'draft',
  label: 'Before',
  providerKind: 'openai',
  provider: 'OpenAI',
  baseUrl: 'https://before.example/v1',
  apiKey: 'before-key',
  sessionDefaults: { model: 'before-model' },
};
const profileFormValues = {
  'settings-api-profile-label': { value: 'After' },
  'settings-api-provider-kind': { value: 'custom' },
  'settings-api-provider': { value: 'After Provider' },
  'settings-api-base-url': { value: 'https://after.example/v1' },
  'settings-api-key': { value: 'after-key' },
};
const atomicSaveHelpers = loadHelpers(['saveActiveApiProfileFromSettingsForm'], {
  getSelectedApiProfile: () => unsavedProfile,
  el: (id) => profileFormValues[id],
  canonicalProviderLabel: (_kind, label) => label,
});
const legacyDefaultsBeforeProfileSave = JSON.stringify(unsavedProfile.sessionDefaults);
atomicSaveHelpers.saveActiveApiProfileFromSettingsForm({ validate: true });
assert.strictEqual(unsavedProfile.label, 'After');
assert.strictEqual(unsavedProfile.providerKind, 'custom');
assert.strictEqual(unsavedProfile.provider, 'After Provider');
assert.strictEqual(unsavedProfile.baseUrl, 'https://after.example/v1');
assert.strictEqual(unsavedProfile.apiKey, 'after-key');
assert.strictEqual(
  JSON.stringify(unsavedProfile.sessionDefaults),
  legacyDefaultsBeforeProfileSave,
  'saving API identity and credentials must not read or mutate retired run defaults'
);
assert(!app.includes('function saveSelectedSessionSettingsAsApiDefault'), 'the retired copy-to-API-default action must be removed');

const legacyProfileInEditor = { ...migratedClaude, sessionDefaults: {} };
profileFormValues['settings-api-profile-label'].value = legacyProfileInEditor.label;
profileFormValues['settings-api-provider-kind'].value = 'anthropic';
profileFormValues['settings-api-provider'].value = 'Claude';
profileFormValues['settings-api-base-url'].value = legacyProfileInEditor.baseUrl;
profileFormValues['settings-api-key'].value = '';
const legacySaveHelpers = loadHelpers(['saveActiveApiProfileFromSettingsForm'], {
  getSelectedApiProfile: () => legacyProfileInEditor,
  el: (id) => profileFormValues[id],
  canonicalProviderLabel: (kind, label) => label || ({ anthropic: 'Anthropic' }[kind]),
  readApiProfileDefaultsFromSettingsForm: () => ({}),
});
legacySaveHelpers.saveActiveApiProfileFromSettingsForm();
assert.strictEqual(legacyProfileInEditor.provider, 'Claude', 'switching profiles must not silently rewrite a legacy binding provider label');
const rebindBusyState = { sessionApiRebindBusyKeys: new Set(['host-a::session-a']) };
const rebindBusyHelpers = loadHelpers([
  'sessionApiRebindBusyKey',
  'isSessionApiRebindBusy',
], {
  state: rebindBusyState,
  getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
  resolveComposerSessionKey: (key) => key,
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
  resolveComposerSessionKey: (key) => key,
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
  'getBoundApiProfileForSession',
  'sessionApiControlValue',
  'apiProfileRequestConfig',
  'normalizeApiIdentityBaseUrl',
  'effectiveApiBaseUrl',
  'apiBindingMatchesProfileIdentity',
  'resolveApiProfileRequestConfig',
  'resolveLaunchApiConfig',
  'modelCatalogRunId',
  'sessionApiProviderKind',
  'modelCacheKey',
  'skillCacheKey',
], {
  state,
  getApiRequestConfig: (hostId) => ({ profileId: `default-${hostId}` }),
  validateApiConfigForRequest: () => {},
  getSessionKey: (session) => `${session?.hostId || 'none'}::${session?.sessionId || 'none'}`,
  inferApiProviderKind: (input = {}) => String(input.providerKind || input.provider || '').toLowerCase() === 'openai' ? 'openai' : 'custom',
  OPENAI_OFFICIAL_BASE_URL: 'https://api.openai.com/v1',
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
assert(app.includes('data-copy-session-dir="${escapeHtml(session.cwd)}"'), 'the Session header must expose the full working directory for Copy Dir');
assert.strictEqual(
  (app.match(/\[data-copy-session-id\], \[data-copy-session-dir\]/g) || []).length,
  2,
  'both Session metadata click surfaces must accept Copy ID and Copy Dir'
);
assert(app.includes('copySessionButton.dataset.copySessionDir'), 'Copy Dir must copy the Session cwd rather than the visible truncated path');
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
assert.strictEqual(bindingHelpers.sessionApiControlValue(historical), 'profile-a', 'the composer API selector must reflect the canonical binding');
assert.strictEqual(
  bindingHelpers.sessionApiControlValue({ runtimeConfig: { apiBinding: { kind: 'host_environment' } } }),
  '__host_environment__'
);
assert.strictEqual(
  bindingHelpers.sessionApiControlValue({ runtimeConfig: { apiBinding: null } }),
  '__unknown_binding__'
);
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
assert.strictEqual(
  bindingHelpers.apiBindingMatchesProfileIdentity({
    kind: 'profile',
    profileId: 'official-openai',
    provider: 'OpenAI',
    providerKind: 'openai',
    normalizedBaseUrl: 'https://api.openai.com/v1',
  }, {
    profileId: 'official-openai',
    provider: 'OpenAI',
    providerKind: 'openai',
    baseUrl: '',
  }),
  true,
  'an empty OpenAI Base URL must match the canonical official endpoint recorded by the backend'
);
const apiValidationHelpers = loadHelpers(['validateApiConfigForRequest'], {
  state: { selectedHostId: 'host-a' },
  getHost: () => ({ label: 'Host A' }),
  inferApiProviderKind: (input) => input?.providerKind || 'custom',
});
assert.doesNotThrow(() => apiValidationHelpers.validateApiConfigForRequest({
  providerKind: 'openai',
  provider: 'OpenAI',
  apiKey: 'official-key',
}, 'host-a'));
assert.throws(
  () => apiValidationHelpers.validateApiConfigForRequest({
    providerKind: 'custom',
    provider: 'MineMine',
    apiKey: 'custom-key',
  }, 'host-a'),
  /explicit Base URL/,
  'non-OpenAI profiles must fail locally instead of silently using api.openai.com'
);
const customPolicyBindingSession = {
  runtimeConfig: {
    apiBinding: {
      kind: 'profile',
      profileId: 'profile-a',
      provider: 'OpenAI',
      providerKind: 'custom',
      normalizedBaseUrl: 'https://a.example/v1',
      bindingFingerprint: 'custom-policy-binding',
    },
  },
};
assert.strictEqual(
  bindingHelpers.sessionApiProviderKind(customPolicyBindingSession),
  'custom',
  'run binding providerKind must outrank a mutable local Profile and provider label'
);
assert.strictEqual(
  bindingHelpers.apiBindingMatchesProfileIdentity(
    customPolicyBindingSession.runtimeConfig.apiBinding,
    state.ui.apiProfiles[0]
  ),
  false,
  'changing only providerKind must require an explicit Rebind'
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
const openAiCatalogKey = bindingHelpers.modelCacheKey(historical);
state.ui.apiProfiles[0].providerKind = 'custom';
assert.notStrictEqual(
  bindingHelpers.modelCacheKey(historical),
  openAiCatalogKey,
  'capability catalogs must be isolated when providerKind changes without changing binding identity'
);
state.ui.apiProfiles[0].providerKind = 'openai';
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
  runId: 'run-a',
  activeRunId: 'run-a',
  runtimeConfig: null,
  apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
};
const authoritativeRunChange = runtimeHelpers.applySessionRuntimeConfig('host-a::session-a', {
  runId: 'run-b',
  activeRunId: 'run-b',
  runStatus: 'live',
  apiBinding: { kind: 'profile', profileId: 'b', bindingFingerprint: 'binding-b' },
}, 'run-a', { acceptCanonicalRunChange: true });
assert(authoritativeRunChange, 'an explicitly authoritative runtime response may advance the projected run');
assert.strictEqual(authoritativeRunChange.runtimeConfig.runId, 'run-b');
assert.strictEqual(authoritativeRunChange.apiBinding.profileId, 'b');

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
  sessionApiProviderKind: () => 'custom',
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
  sessionRebindFailures: new Map([
    ['host-a::session-a', {
      target: { kind: 'profile', profileId: 'b' },
    }],
  ]),
};
const runtimeReloads = [];
const clearedRebindFailures = [];
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
  rebindTargetMatchesBinding: (binding, target) => (
    binding?.kind === target?.kind && binding?.profileId === target?.profileId
  ),
  clearSessionRebindFailure: (session) => {
    const key = `${session?.hostId || ''}::${session?.sessionId || ''}`;
    clearedRebindFailures.push(key);
    startedState.sessionRebindFailures.delete(key);
    return true;
  },
});
startedHelpers.applyConfirmedSessionStarted({
  hostId: 'host-a',
  sessionId: 'session-a',
  runId: 'run-stale',
  apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
}, startedState.sessions[0]);
assert.strictEqual(clearedRebindFailures.length, 0, 'a stale session.started binding must not clear a failed Rebind warning');
assert.strictEqual(startedState.sessionRebindFailures.has('host-a::session-a'), true);
startedState.sessions[0] = {
  hostId: 'host-a',
  sessionId: 'session-a',
  apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
  runtimeConfig: {
    runId: 'run-a',
    apiBinding: { kind: 'profile', profileId: 'a', bindingFingerprint: 'binding-a' },
  },
};
runtimeReloads.length = 0;
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
assert.strictEqual(clearedRebindFailures.length, 1, 'the intended Rebind target may clear its warning after session.started');

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
  assertEffortSelectionIsValid: () => {},
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
selectedComposerOptions = {
  model: 'private-model',
  effort: 'ultra',
  allowUnverifiedEffort: true,
  summary: 'concise',
};
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(selectionHelpers.sessionSelectionRequestBody({}))),
  {
    model: 'private-model',
    effort: 'ultra',
    allowUnverifiedEffort: true,
    summary: 'concise',
  },
  'Rebind selection snapshots must preserve explicit unverified effort approval and summary'
);

let currentRebindSelection = {};
const rebindSelectionHelpers = loadHelpers(['rebindSelectionRequestBody'], {
  sessionSelectionRequestBody: () => currentRebindSelection,
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(rebindSelectionHelpers.rebindSelectionRequestBody({}, '__host_environment__', 'current-session'))),
  { model: '', effort: '', summary: '' },
  'Current Session Auto settings must be sent explicitly instead of inheriting the previous run'
);
currentRebindSelection = { model: 'session-model', effort: 'high' };
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(rebindSelectionHelpers.rebindSelectionRequestBody({}, 'profile-b', 'current-session'))),
  { model: 'session-model', effort: 'high', summary: '' },
  'Current Session settings must preserve explicit values while materializing Auto fields'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(rebindSelectionHelpers.rebindSelectionRequestBody({}, 'profile-b', 'profile-defaults'))),
  { model: 'session-model', effort: 'high', summary: '' },
  'retired Profile defaults must never override the current Session selection'
);

const selectionSyncState = {
  codexControls: {
    sessionOptionsByKey: new Map(),
    persistedSessionOptionKeys: new Set(),
  },
};
const selectionSyncSession = { hostId: 'host-a', sessionId: 'session-a' };
const selectionSyncKey = 'host-a::session-a';
selectionSyncState.codexControls.sessionOptionsByKey.set(selectionSyncKey, {
  model: 'old-model',
  effort: 'low',
  effortMode: 'manual',
  allowUnverifiedEffort: false,
  summary: 'concise',
  mode: 'plan',
  approvalPolicy: 'never',
  approvalsReviewer: 'user',
  sandboxMode: 'read-only',
  personality: 'friendly',
});
let selectionSyncPersistCount = 0;
const selectionSyncHelpers = loadHelpers([
  'normalizeComposerOptionValues',
  'applySessionSelectionToSessionOptions',
  'normalizeRebindSelectionSnapshot',
  'rebindResponseWithClientSelection',
  'rebindFailureMayHaveLostAcceptedResponse',
], {
  state: selectionSyncState,
  REASONING_EFFORT_PATTERN: /^[a-z][a-z0-9_-]{0,31}$/,
  DEFAULT_COMPOSER_OPTIONS: {
    model: '',
    effort: '',
    effortMode: 'auto',
    allowUnverifiedEffort: false,
    summary: '',
    mode: 'default',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandboxMode: 'workspaceWrite',
    personality: '',
  },
  getSessionKey: (session) => session ? `${session.hostId}::${session.sessionId}` : '',
  resolveComposerSessionKey: (key) => key,
  getComposerOptionsForSession: () => selectionSyncState.codexControls.sessionOptionsByKey.get(selectionSyncKey),
  persistComposerSessionOptions: () => { selectionSyncPersistCount += 1; },
});
selectionSyncHelpers.applySessionSelectionToSessionOptions(selectionSyncSession, {
  model: 'submitted-model',
  effort: 'ultra',
  allowUnverifiedEffort: true,
  summary: '',
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(selectionSyncState.codexControls.sessionOptionsByKey.get(selectionSyncKey))),
  {
    model: 'submitted-model',
    effort: 'ultra',
    effortMode: 'manual',
    allowUnverifiedEffort: true,
    summary: '',
    mode: 'plan',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxMode: 'read-only',
    personality: 'friendly',
  },
  'Rebind completion must apply the submitted run settings without changing unrelated Session controls'
);
const originalSelectionSnapshot = { model: 'snapshot-model', effort: 'high', summary: '' };
const decoratedRebindResponse = selectionSyncHelpers.rebindResponseWithClientSelection(
  { runId: 'run-b' },
  originalSelectionSnapshot
);
originalSelectionSnapshot.model = 'mutated-after-submit';
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(decoratedRebindResponse.clientSelection)),
  { model: 'snapshot-model', effort: 'high', summary: '' },
  'accepted Rebind responses must own an immutable-by-reference copy of the submitted selection'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(selectionSyncHelpers.normalizeRebindSelectionSnapshot({ model: 'partial-model' }))),
  { model: 'partial-model', effort: '', summary: '' },
  'partial snapshots must match Relay semantics by explicitly clearing omitted run settings'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(selectionSyncHelpers.normalizeRebindSelectionSnapshot({
    effort: '',
    allowUnverifiedEffort: true,
  }))),
  { model: '', effort: '', summary: '' },
  'unverified-effort approval must not survive an Auto effort selection'
);
assert.strictEqual(selectionSyncHelpers.rebindFailureMayHaveLostAcceptedResponse(new TypeError('connection closed')), true);
assert.strictEqual(
  selectionSyncHelpers.rebindFailureMayHaveLostAcceptedResponse(Object.assign(new Error('conflict'), { status: 409 })),
  false,
  'an explicit HTTP conflict is a definitive failed request'
);
assert.strictEqual(selectionSyncPersistCount, 1);

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
const effortLabelHelpers = loadHelpers(['reasoningEffortLabel'], {
  currentLocale: () => 'zh-CN',
});
assert.strictEqual(effortLabelHelpers.reasoningEffortLabel('low'), '轻度');
assert.strictEqual(effortLabelHelpers.reasoningEffortLabel('xhigh'), '很高');
assert.strictEqual(effortLabelHelpers.reasoningEffortLabel('max'), '极高');
assert.strictEqual(effortLabelHelpers.reasoningEffortLabel('ultra'), '极致 / 自动委派');
assert.strictEqual(effortLabelHelpers.reasoningEffortLabel('vendor-level'), 'vendor-level');
assert(functionSource('assertModelSelectionIsSelectable').includes('selectable'), 'unselectable models must be rejected before submit');
assert(inputBody.includes('assertModelSelectionIsSelectable'), 'live input must validate model selectability');

const effortBlock = html.match(/<select id="codex-effort-select"[\s\S]*?<\/select>/)?.[0] || '';
assert(effortBlock, 'reasoning effort select missing');
assert(!/<option value="(?:minimal|low|medium|high|xhigh|max|ultra)"/.test(effortBlock), 'reasoning effort HTML must not hard-code levels');
assert(!html.includes('New Session default (this browser)'), 'the duplicated Host default summary must be removed');
assert(html.includes('id="new-session-submit-button"'), 'New Session submit must be addressable for busy state rendering');
assert(html.includes('id="new-session-status"'), 'New Session form must expose an aria-live creation status');
assert(css.includes('#new-session-status.error'), 'New Session launch failures must have a visible local error state');
const newSessionSubmitStart = app.indexOf("el('new-session-form').addEventListener('submit'");
const newSessionSubmitEnd = app.indexOf("el('toggle-overview-button')", newSessionSubmitStart);
assert(newSessionSubmitStart >= 0 && newSessionSubmitEnd > newSessionSubmitStart, 'New Session submit handler missing');
const newSessionSubmitHandler = app.slice(newSessionSubmitStart, newSessionSubmitEnd);
assert(newSessionSubmitHandler.includes('setNewSessionLaunchError(error)'), 'New Session submit failures must stay on the creation form');
assert(!newSessionSubmitHandler.includes('reportError(error)'), 'New Session submit failures must not be appended to the selected Session');
for (const id of [
  'session-api-binding-label',
  'session-catalog-label',
  'session-catalog-status',
  'session-api-rebind-select',
  'session-rebind-settings-summary',
  'session-api-rebind-button',
  'session-transcript-fallback-button',
  'apply-current-session-to-live-button',
]) {
  assert(html.includes(`id="${id}"`), `${id} missing`);
}
const pageDocument = new JSDOM(html).window.document;
const composerRuntimeControlIds = [
  'session-api-rebind-select',
  'session-api-rebind-button',
  'codex-model-input',
  'codex-model-options',
  'codex-model-select',
  'codex-model-refresh-button',
  'codex-effort-select',
  'codex-effort-manual-input',
  'codex-effort-unverified-checkbox',
];
for (const id of composerRuntimeControlIds) {
  const matches = pageDocument.querySelectorAll(`#${id}`);
  assert.strictEqual(matches.length, 1, `${id} must have exactly one canonical DOM control`);
  assert(pageDocument.querySelector('#input-form').contains(matches[0]), `${id} must live in the composer`);
  assert(!pageDocument.querySelector('#settings-form').contains(matches[0]), `${id} must not be duplicated in Settings`);
}
for (const removedId of ['session-host-default-label', 'session-rebind-settings-source', 'session-target-model-refresh-button']) {
  assert(!html.includes(`id="${removedId}"`), `${removedId} must be removed`);
}
const modelRefreshClickHandlers = app.slice(
  app.indexOf("el('codex-model-refresh-button').addEventListener('click'"),
  app.indexOf("el('session-api-rebind-button')?.addEventListener('click'")
);
assert(modelRefreshClickHandlers.includes('refreshVisibleModelOptionsForSelectedSession'));
const applyCurrentSessionClickHandler = app.slice(
  app.indexOf("el('apply-current-session-to-live-button')?.addEventListener('click'"),
  app.indexOf("el('settings-theme-select').addEventListener('change'")
);
assert(applyCurrentSessionClickHandler.includes('openApplyCurrentSessionSettingsDialog(getSelectedSession())'));
assert(!applyCurrentSessionClickHandler.includes('saveActiveApiProfileFromSettingsForm'));
assert(!applyCurrentSessionClickHandler.includes('persistUiSettings'));
assert(css.includes('.session-api-context'));
assert(css.includes('.composer-session-toolbar'));
assert(css.includes('.composer-session-control-fields'));
assert(css.includes('@media (max-width: 720px)'));

for (const id of [
  'settings-api-provider-kind',
  'settings-api-custom-provider-row',
  'settings-api-model-catalog-status',
  'settings-api-apply-suggested-base-url-button',
  'apply-current-session-to-live-button',
  'codex-effort-manual-input',
  'codex-effort-unverified-checkbox',
  'session-action-dialog-preflight-button',
]) {
  assert(html.includes(`id="${id}"`), `${id} missing`);
}
for (const removedId of [
  'settings-api-default-model',
  'settings-api-default-model-select',
  'settings-api-model-host',
  'settings-api-fetch-models-button',
  'settings-api-default-effort-mode',
  'settings-api-default-summary',
  'save-session-config-as-api-default-button',
  'apply-api-defaults-to-live-button',
]) {
  assert(!html.includes(`id="${removedId}"`), `${removedId} must be removed with API run defaults`);
}
assert(html.indexOf('/provider-capabilities.js') < html.indexOf('/app.js'), 'provider registry must load before app.js');
assert(functionSource('readEffortControlValue').includes('allowUnverifiedEffort'));
assert(functionSource('assertEffortSelectionIsValid').includes('session_effort_unverified'));
assert(functionSource('assertEffortSelectionIsValid').includes('providerAllowsManualEffortWhenUnknown'));
assert(functionSource('renderReasoningEffortOptions').includes('providerAllowsManualEffortWhenUnknown'));
assert(functionSource('renderComposerModelOptions').includes('syncSelectOptions'), 'runtime model options must be reconciled without destructive redraws');
assert(functionSource('renderComposerModelOptions').includes('models.autoRuntimeAvailable'), 'Auto must remain explicit after a catalog loads without declaring a default model');
assert(functionSource('renderComposerModelOptions').includes('visibleCurrentModel'), 'the visible Session model must survive a temporarily empty Rebind preview catalog');
assert(functionSource('renderReasoningEffortOptions').includes('syncSelectOptions'), 'runtime effort options must be reconciled without destructive redraws');
assert(functionSource('renderComposerModelOptions').includes("label: 'Current selection'"), 'a current model missing from the catalog must remain visible');
assert(functionSource('renderComposerModelOptions').includes("' | unavailable'"), 'an unavailable current model must be labeled explicitly');
assert(functionSource('renderReasoningEffortOptions').includes("'unsupported'"), 'an unsupported current effort must remain visible');
assert(functionSource('renderReasoningEffortOptions').includes('!supportedCurrent && !manualUnknownAllowed'), 'an unknown non-Custom effort must remain visible instead of falling back to Auto');
assert(functionSource('renderReasoningEffortOptions').includes("'unverified'"), 'an unknown non-Custom effort must be labeled as unverified');
assert(functionSource('applyComposerOptionsToControls').includes('options.effort && hasSupportedValue'), 'applying composer options must preserve an existing visible effort option');
assert(functionSource('applyComposerOptionsToControls').includes("hasManualOption"), 'Custom unknown efforts must still use the explicit manual control');
assert(functionSource('renderSessionApiControls').includes('syncSelectOptions'), 'actual API options must be reconciled without destructive redraws');
const sessionModelControlHandlers = app.slice(
  app.indexOf("el('codex-model-select').addEventListener('change'"),
  app.indexOf("el('codex-file-picker-button').addEventListener('click'")
);
assert(sessionModelControlHandlers.includes('saveComposerOptionsFromControls'), 'model and thinking changes must save the next-turn Session selection');
assert(sessionModelControlHandlers.includes('renderSessionApiControls(session)'), 'model changes must immediately update the next-turn summary');
assert(sessionModelControlHandlers.includes('renderSessionApiControls(getSelectedSession())'), 'thinking and summary changes must immediately update the next-turn summary');
assert(!sessionModelControlHandlers.includes('rebindSessionApi'), 'model and thinking changes must not restart the Session');
assert(
  functionSource('buildComposerPayload').includes('...(composerDraft.options || getComposerOptionsForSession(session))'),
  'the next composer payload must use the originating Session draft model and thinking snapshot'
);
assert(inputBody.includes('model: options.model || null'), 'the next input must submit the selected model');
assert(inputBody.includes('effort: options.effort || null'), 'the next input must submit the selected thinking effort');
assert(!functionSource('renderApiProviderEditorState').includes('sessionDefaults'), 'the API editor must not expose retired run defaults');
assert(functionSource('rebindSelectionRequestBody').includes("model: ''"), 'Rebind must explicitly clear inherited Auto fields');
assert(functionSource('rebindSessionApi').includes('rebindSelectionRequestBody'), 'single Session Rebind must resolve the chosen settings source after canonical load');
assert(functionSource('formatSessionRebindConfirmation').includes('rebindSelectionDisplayValue'), 'Rebind confirmation must show model, thinking, and summary');

const optionDom = new JSDOM('<!doctype html><select id="stable"></select><datalist id="suggestions"></datalist>');
const optionHelpers = loadHelpers([
  'optionTreeSignature',
  'createOptionTreeNode',
  'syncOptionTree',
  'syncSelectOptions',
], {
  document: optionDom.window.document,
});
const stableSelect = optionDom.window.document.getElementById('stable');
const stableSpecs = [
  { value: '', text: 'Auto' },
  { label: 'Models', options: [
    { value: 'gpt-a', text: 'GPT A' },
    { value: 'gpt-b', text: 'GPT B' },
  ] },
];
optionHelpers.syncSelectOptions(stableSelect, stableSpecs, 'gpt-b');
const stableOptionNode = Array.from(stableSelect.options).find((option) => option.value === 'gpt-b');
stableSelect.focus();
optionHelpers.syncSelectOptions(stableSelect, stableSpecs, 'gpt-b');
assert.strictEqual(
  Array.from(stableSelect.options).find((option) => option.value === 'gpt-b'),
  stableOptionNode,
  'an unchanged render must preserve option node identity'
);
assert.strictEqual(stableSelect.value, 'gpt-b');
assert.strictEqual(optionDom.window.document.activeElement, stableSelect, 'an unchanged render must preserve focus');
optionHelpers.syncSelectOptions(stableSelect, [
  ...stableSpecs,
  { value: 'gpt-c', text: 'GPT C' },
], 'gpt-b');
assert.notStrictEqual(
  Array.from(stableSelect.options).find((option) => option.value === 'gpt-b'),
  stableOptionNode,
  'a changed catalog must replace the option tree once'
);
const catalogMembershipHelpers = loadHelpers(['modelIsSelectableCatalogMember', 'selectableCatalogModels']);
const profileCatalogModels = Array.from({ length: 7 }, (_, index) => ({
  id: `api-model-${index + 1}`,
  capabilityKnown: true,
  reasoningLevels: ['low', 'high'],
  selectable: true,
}));
const mixedCatalog = {
  models: [
    ...profileCatalogModels,
    ...Array.from({ length: 24 }, (_, index) => ({
      id: `advisory-${index + 1}`,
      availability: 'unavailable',
      selectable: false,
    })),
  ],
};
assert.strictEqual(
  catalogMembershipHelpers.selectableCatalogModels(mixedCatalog).length,
  7,
  'unavailable capability references must not inflate the visible model count'
);
const storedCatalogHelpers = loadHelpers([
  'localConfigRevision',
  'apiProfileModelForStorage',
  'apiProfileModelCatalogStorageKey',
  'apiProfileModelCatalogStorageKeyFromRevision',
  'normalizeStoredApiProfileModelCatalogs',
]);
const restoredCatalogs = storedCatalogHelpers.normalizeStoredApiProfileModelCatalogs([{
  key: 'host-a::profile-a:https://api.example.test/v1?signature=must-not-persist',
  profileId: 'profile-a',
  hostId: 'host-a',
  models: [{ id: 'api-model-1', vendorPayload: 'must-not-persist' }],
  complete: true,
  fetchedAt: '2026-07-20T00:00:00.000Z',
}]);
const restoredCatalog = [...restoredCatalogs.values()][0];
assert.strictEqual(restoredCatalog?.models?.[0]?.id, 'api-model-1');
assert.strictEqual(restoredCatalog?.models?.[0]?.vendorPayload, undefined);
assert.strictEqual(restoredCatalog?.restored, true);
assert(![...restoredCatalogs.keys()][0].includes('must-not-persist'));
const oversizedRestoredCatalog = [...storedCatalogHelpers.normalizeStoredApiProfileModelCatalogs([{
  key: 'oversized-sensitive-key',
  profileId: 'profile-a',
  hostId: 'host-a',
  models: Array.from({ length: 501 }, (_, index) => ({ id: `model-${index}` })),
  complete: true,
}]).values()][0];
assert.strictEqual(oversizedRestoredCatalog.complete, false, 'a persistence-truncated catalog must not claim completeness');
assert.strictEqual(oversizedRestoredCatalog.truncated, true);
let persistedCatalogPayload = null;
const persistCatalogState = {
  ui: { apiProfiles: [{ profileId: 'profile-a' }] },
  apiProfileModelCatalogPersistenceError: '',
  apiProfileModelCatalogs: new Map([['sensitive', {
    key: 'host-a::profile-a:https://api.example.test/v1?signature=must-not-persist',
    profileId: 'profile-a',
    hostId: 'host-a',
    models: [{ id: 'api-model-1' }],
    complete: true,
  }]]),
};
const persistCatalogHelpers = loadHelpers([
  'localConfigRevision',
  'apiProfileModelForStorage',
  'apiProfileModelCatalogForStorage',
  'persistApiProfileModelCatalogs',
], {
  state: persistCatalogState,
  API_PROFILE_MODEL_CATALOGS_STORAGE_KEY: 'test-catalogs',
  writeLocalStorageJson: (_key, value) => { persistedCatalogPayload = value; return true; },
});
persistCatalogHelpers.persistApiProfileModelCatalogs();
assert(!JSON.stringify(persistedCatalogPayload).includes('must-not-persist'), 'persisted catalog identity must not retain raw Base URLs or query credentials');
assert.strictEqual(persistedCatalogPayload.length, 1);
persistCatalogState.apiProfileModelCatalogs = new Map();
for (let index = 0; index < 13; index += 1) {
  persistCatalogState.apiProfileModelCatalogs.set(`scope-${index}`, {
    key: `scope-${index}`,
    profileId: 'profile-a',
    hostId: `host-${index}`,
    models: [{ id: `model-${index}` }],
  });
}
persistCatalogState.apiProfileModelCatalogs.set('scope-0-refreshed', {
  key: 'scope-0-refreshed',
  profileId: 'profile-a',
  hostId: 'host-0',
  models: [{ id: 'model-0-new' }],
});
persistCatalogHelpers.persistApiProfileModelCatalogs();
assert(persistedCatalogPayload.some((entry) => entry.hostId === 'host-0'), 'the most recently refreshed scope must survive persistence eviction');
assert(!persistedCatalogPayload.some((entry) => entry.hostId === 'host-1'), 'the oldest unrefreshed scope should be evicted first');
assert(functionSource('initializePersistentUiState').includes('API_PROFILE_MODEL_CATALOGS_STORAGE_KEY'));
assert(!functionSource('renderApiProviderEditorState').includes('listAdvisoryModelCapabilities'), 'capability advisories must not be presented as available Profile models');
assert(functionSource('getModelOptions').includes('decorateModelOptionForProvider'));
assert(functionSource('providerInputForModelCatalog').includes('modelProviderHint'));
assert(!functionSource('resolveFreshSessionSelection').includes('sessionDefaults'), 'new Sessions must start with runtime Auto settings');
const profileFetchBody = functionSource('fetchApiProfileModels');
const profilePageFetchBody = functionSource('fetchApiProfileModelPages');
const profilePingBody = functionSource('pingHostApiProfile');
assert(profilePageFetchBody.includes('/api-test'), 'Profile model fetch must request the selected API through a Host');
assert(profilePageFetchBody.includes('result?.modelPage'), 'Profile model fetch must require a recognizable model catalog');
assert(profilePageFetchBody.includes('suggestedBaseUrl'), 'validated /v1 suggestions must survive the API-test error path');
assert(profilePageFetchBody.includes('suggestionReason'), 'only a validated suggestion reason may reach UI state');
assert(profilePageFetchBody.includes('nextCursor'), 'Profile model fetch must follow paginated model catalogs');
assert(profileFetchBody.includes('fetchApiProfileModelPages'), 'Profile model fetch must collect all available model pages');
assert(profileFetchBody.includes('decorateModels'), 'Profile model fetch must merge runtime and advisory capability metadata');
assert(profileFetchBody.includes('apiConfig.providerKind'), 'Profile model responses must use the provider kind captured with the request');
assert(profileFetchBody.includes('apiProfileModelRequestIsCurrent'), 'stale Profile model responses must not redraw a different editor');
assert(profileFetchBody.includes('operationId'), 'newer same-profile model requests must supersede stale responses');
assert(profileFetchBody.includes('apiProfileModelCatalogKeyForConfig(apiConfig, hostId)'), 'Profile fetches must store under the exact submitted API identity');
assert(profileFetchBody.includes('persistApiProfileModelCatalogs'), 'verified Profile catalogs must survive a page reload');
assert(!profileFetchBody.includes('renderComposerModelOptions'), 'Profile Fetch results must not replace the selected Session model catalog');
assert(profilePingBody.includes('const requestKey = apiProfileModelCatalogKeyForConfig(apiConfig, hostId)'), 'API ping must capture the submitted profile identity');
assert(profilePingBody.includes('apiProfileModelCatalogKey(profile, hostId) === requestKey'), 'API ping must reject a suggestion after the profile changes');
assert(profilePingBody.includes('activeCatalogRequest?.busy !== true'), 'API Ping must not supersede an in-flight Fetch models request');
assert(/apiProfileModelCatalogRequests:\s*new Map\(\)/.test(app), 'Profile model request state must be isolated per profile identity');
assert(!functionSource('renderApiProviderEditorState').includes('getApiProfileModelCatalog'), 'API Profile editing must not expose a second model selector');
assert(functionSource('apiProfileModelCatalogKeyForConfig').includes('rebindProfilePreviewIdentity'), 'Profile model caches must include provider identity and key revision');
assert(functionSource('apiProfileModelCatalogKey').includes('apiProfileEditorDraft'), 'unsaved API identity edits must invalidate fetched model caches');
assert(html.includes('id="settings-api-apply-suggested-base-url-button"'), 'API settings must expose an explicit detected-/v1 action');
assert(html.includes('data-i18n-key="settings.useDetectedV1"'), 'the detected-/v1 action must follow the active locale');
assert(functionSource('renderApiProfileModelCatalogControls').includes("t('settings.useDetectedV1')"));
const applySuggestedBaseUrlBody = functionSource('applySuggestedApiProfileBaseUrl');
assert(applySuggestedBaseUrlBody.includes('profile.baseUrl = suggestedBaseUrl'), 'detected /v1 must change the profile only after the user clicks');
assert(applySuggestedBaseUrlBody.includes('clearApiProfileModelState'), 'applying /v1 must invalidate old profile catalogs and requests');
assert(applySuggestedBaseUrlBody.includes('persistUiSettings'), 'applying /v1 must persist the corrected profile');
assert(applySuggestedBaseUrlBody.includes('fetchApiProfileModels'), 'applying /v1 must validate the corrected profile again');
assert(functionSource('providerInputForModelCatalog').includes('binding?.providerKind'), 'live Sessions must preserve the provider policy stored on their run binding');
assert(functionSource('providerInputForModelCatalog').includes('apiBindingMatchesProfileIdentity'), 'legacy bindings may use only an identity-matching local Profile');
assert(functionSource('sessionApiProviderKind').includes('binding?.providerKind'), 'run binding provider policy must outrank mutable local Profiles');
const freshSelectionHelpers = loadHelpers([
  'resolveFreshSessionSelection',
], {
  getApiRequestConfig: () => null,
  normalizeComposerOptionValues: (value) => value,
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(freshSelectionHelpers.resolveFreshSessionSelection('host-a', {}, null))),
  {},
  'a Host-environment launch must not inherit defaults from an unused empty API profile'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(freshSelectionHelpers.resolveFreshSessionSelection('host-a', {
    selection: { model: 'explicit-model', effort: 'low' },
  }, null))),
  { model: 'explicit-model', effort: 'low' },
  'an explicit fresh-Session selection must still override Auto for Host environment launches'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(freshSelectionHelpers.resolveFreshSessionSelection('host-a', {}, { profileId: 'configured' }))),
  {},
  'a Host API mapping must choose credentials without injecting hidden model defaults'
);

const batchSourceSession = {
  hostId: 'host-a',
  sessionId: 'source-session',
  apiBinding: {
    kind: 'profile',
    profileId: 'profile-a',
    provider: 'OpenAI',
    baseUrl: 'https://a.example/v1',
  },
};
const batchOtherSessions = [
  batchSourceSession,
  { hostId: 'host-a', sessionId: 'other-a' },
  { hostId: 'host-b', sessionId: 'other-b' },
];
let openedBatchDialog = null;
let batchSettingsClosed = 0;
const batchOpenState = {
  ui: { apiProfiles: [
    { profileId: 'profile-a', label: 'Actual API', provider: 'OpenAI', baseUrl: 'https://a.example/v1' },
    { profileId: 'profile-b', label: 'Stale target', provider: 'OpenAI', baseUrl: 'https://b.example/v1' },
  ] },
};
const batchOpenHelpers = loadHelpers([
  'sessionApiBinding',
  'getBoundApiProfileForSession',
  'normalizeRebindSelectionSnapshot',
  'openApplyCurrentSessionSettingsDialog',
], {
  state: batchOpenState,
  getSelectedSession: () => batchSourceSession,
  el: (id) => id === 'session-api-rebind-select' ? { value: 'profile-b' } : null,
  apiBindingMatchesProfileIdentity: (binding, profile) => binding?.profileId === profile?.profileId,
  getComposerOptionsForSession: () => ({
    model: 'provider-model-19',
    effort: 'high',
    summary: 'concise',
    allowUnverifiedEffort: true,
  }),
  getSessionKey: (session) => session ? `${session.hostId}::${session.sessionId}` : '',
  getRelayManagedLiveSessions: () => batchOtherSessions,
  closeSettingsDialog: () => { batchSettingsClosed += 1; },
  openSessionActionDialog: (options) => { openedBatchDialog = options; },
});
batchOpenHelpers.openApplyCurrentSessionSettingsDialog(batchSourceSession);
assert.strictEqual(batchSettingsClosed, 1);
assert.strictEqual(openedBatchDialog.profileId, 'profile-a', 'batch apply must use the actual Session binding, not a stale dropdown target');
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(openedBatchDialog.selection)),
  {
    model: 'provider-model-19',
    effort: 'high',
    summary: 'concise',
    allowUnverifiedEffort: true,
  },
  'batch apply must capture one immutable current-Session run selection'
);
assert.deepStrictEqual(
  openedBatchDialog.sessions.map((session) => session.sessionId),
  ['other-a', 'other-b'],
  'the source Session must not be restarted by the apply-to-other-Sessions action'
);
assert(functionSource('openApplyCurrentSessionSettingsDialog').includes('getBoundApiProfileForSession(session)'));
assert(!functionSource('openApplyCurrentSessionSettingsDialog').includes("el('session-api-rebind-select')"));
assert(!functionSource('openApplyCurrentSessionSettingsDialog').includes('rebindTargetValue(session)'));
assert(functionSource('validateProfileRebindForSession').includes('/rebind/validate'));
assert(functionSource('validateProfileRebindForSession').includes('normalizeRebindSelectionSnapshot(selectionSnapshot)'));
assert(functionSource('preflightSessionActionDialog').includes('validation,'), 'batch preflight must retain the full validated request snapshot');
assert(functionSource('applyProfileRebindSessionActionDialog').includes('rebindSessionApi'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('previousValidation?.response?.modelCatalogReuseToken'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('modelCatalogReuseToken: latestValidation.response?.modelCatalogReuseToken'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('rebindFailureMayHaveLostAcceptedResponse(error)'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('rebindAttempted &&'), 'batch recovery must run only after a Rebind request was attempted');
assert(functionSource('applyProfileRebindSessionActionDialog').includes('applySessionSelectionToSessionOptions'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('requireIdle: true'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('waitForProfileRebindCompletion'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('latestValidation?.response?.currentRunId'));
assert(functionSource('rebindResponseWasAccepted').includes('rebindSelectionMatchesRuntime'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('latestValidation?.selection'));
assert(functionSource('waitForProfileRebindCompletion').includes("runtime?.runStatus !== 'live'"));
assert(!functionSource('applyProfileRebindSessionActionDialog').includes('restartManagedSession'));
assert(
  !functionSource('restartManagedSession').includes("catch(() => ({"),
  'Restart must never fabricate a stopped Session after the Stop confirmation times out'
);
assert(functionSource('runHostGroupedSessionTasks').includes('Math.min(concurrency'));
assert(functionSource('closeSessionActionDialog').includes('state.sessionActionDialog.busy'));
assert(functionSource('renderSessionActionDialog').includes('closeButton.disabled = dialog.busy'));
assert(functionSource('preflightSessionActionDialog').includes('sessionActionOperationIsCurrent'));
assert(functionSource('applyProfileRebindSessionActionDialog').includes('sessionActionOperationIsCurrent'));
assert(css.includes('.choice-host-group'));
assert(css.includes('.choice-session-row[data-result-status="success"]'));
assert(html.includes('data-i18n-key="settings.applyCurrentSessionToLive"'), 'the current Session batch action must be explicit');
assert(functionSource('applyProfileRebindSessionActionDialog').includes('session.batchApplySuccess'), 'successful batch Rebind must show a completion prompt');
assert(functionSource('renderSessionActionRow').includes("session.sessionId || ''"), 'batch actions must render the complete Session id');
assert(!functionSource('renderSessionActionRow').includes('shortId(session.sessionId)'), 'batch actions must not abbreviate the Session id');
assert(css.includes('#session-action-dialog .choice-host-heading input'), 'batch Host checkboxes need dialog-scoped sizing');
assert(/#session-action-dialog \.choice-host-heading input,[\s\S]*?width:\s*16px/.test(css), 'batch Host checkboxes must not inherit the global 100% input width');
assert(/#session-action-dialog \.choice-session-copy strong,[\s\S]*?overflow-wrap:\s*anywhere/.test(css), 'batch Session identity and path text must wrap instead of disappearing');
assert(/@media \(max-width: 560px\)[\s\S]*?\.choice-dialog-actions[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/.test(css), 'narrow batch action buttons must stay inside the dialog');
assert(css.includes('body.modal-open .transcript-scroll-controls'), 'transcript jump controls must not overlap modal content');

const rebindRecoverySelectionHelpers = loadHelpers([
  'normalizeRebindSelectionSnapshot',
  'rebindSelectionMatchesRuntime',
]);
assert.strictEqual(
  rebindRecoverySelectionHelpers.rebindSelectionMatchesRuntime(
    { model: 'model-b', effort: 'HIGH', summary: 'concise' },
    { model: 'model-b', effort: 'high', summary: 'concise' }
  ),
  true,
  'lost-response recovery must accept the exact submitted model, effort, and summary'
);
assert.strictEqual(
  rebindRecoverySelectionHelpers.rebindSelectionMatchesRuntime(
    { model: 'different-model', effort: 'high', summary: 'concise' },
    { model: 'model-b', effort: 'high' }
  ),
  false,
  'lost-response recovery must reject another same-profile Rebind with a different model'
);
assert.strictEqual(
  rebindRecoverySelectionHelpers.rebindSelectionMatchesRuntime(
    { model: 'model-b', effort: 'low', summary: 'concise' },
    { model: 'model-b', effort: 'high' }
  ),
  false,
  'lost-response recovery must reject another same-profile Rebind with a different effort'
);
assert.strictEqual(
  rebindRecoverySelectionHelpers.rebindSelectionMatchesRuntime(
    { model: 'model-b', effort: 'high', summary: 'detailed' },
    { model: 'model-b', effort: 'high', summary: 'concise' }
  ),
  false,
  'lost-response recovery must reject another same-profile Rebind with a different summary'
);
assert.strictEqual(
  rebindRecoverySelectionHelpers.rebindSelectionMatchesRuntime(
    { model: 'model-b', effort: 'high', summary: 'concise', allowUnverifiedEffort: true },
    { model: 'model-b', effort: 'high', summary: 'concise' }
  ),
  false,
  'lost-response recovery must reject a different unverified-effort policy'
);

async function verifyBatchApplyReusesPreflightCatalog() {
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  const profile = { profileId: 'profile-b', label: 'Profile B' };
  const selection = { model: 'model-b', effort: 'high', summary: 'concise' };
  const validation = {
    response: {
      modelCatalogReuseToken: 'opaque-proof',
      requiresInterrupt: false,
      currentRunId: 'run-a',
    },
    selection,
    apiConfig: { profileId: 'profile-b', apiKey: 'secret' },
    expectation: {
      sessionKey: 'host-a::session-a',
      expectedRunId: 'run-a',
      expectedRunStatus: 'live',
      expectedBindingFingerprint: 'binding-a',
    },
    canonical: session,
  };
  const dialog = {
    profileId: profile.profileId,
    busy: false,
    phase: 'preflighted',
    operationId: 'operation-a',
    sessions: [session],
    selectedKeys: new Set(['host-a::session-a']),
    resultsByKey: new Map([['host-a::session-a', {
      status: 'ready',
      validation,
    }]]),
    selection,
  };
  let duplicateValidations = 0;
  let submitted = null;
  const helpers = loadHelpers(['applyProfileRebindSessionActionDialog'], {
    state: { sessionActionDialog: dialog },
    getApiProfile: () => profile,
    getSessionKey: (candidate) => `${candidate.hostId}::${candidate.sessionId}`,
    sessionActionOperationIsCurrent: () => true,
    renderSessionActionDialog: () => {},
    runHostGroupedSessionTasks: async (sessions, task) => {
      for (const candidate of sessions) await task(candidate);
    },
    setSessionApiRebindBusy: () => {},
    validateProfileRebindForSession: async () => {
      duplicateValidations += 1;
      return validation;
    },
    rebindSessionApi: async (...args) => {
      submitted = args;
      return { sessionId: 'session-a', runId: 'run-b', clientSelection: selection };
    },
    waitForProfileRebindCompletion: async () => ({ live: true }),
    clearSessionRebindFailure: () => {},
    applySessionSelectionToSessionOptions: () => {},
    refresh: async () => {},
    window: { alert: () => {} },
    formatUiText: (key) => key,
  });
  await helpers.applyProfileRebindSessionActionDialog();
  assert.strictEqual(duplicateValidations, 0, 'Apply must not repeat a successful preflight');
  assert.strictEqual(submitted?.[4]?.modelCatalogReuseToken, 'opaque-proof');
  assert.strictEqual(submitted?.[4]?.requireIdle, true);
  assert.strictEqual(submitted?.[4]?.expectation, validation.expectation);
  assert.strictEqual(dialog.resultsByKey.get('host-a::session-a')?.status, 'success');
}

const nativeReadinessSource = functionSource('sessionNativeResumeReadiness');
assert(nativeReadinessSource.includes("'nativeResumeReady'"));
assert(nativeReadinessSource.includes('nativeResumeReadyKnown === false'));
assert(functionSource('canActivateSessionHistory').includes('sessionNativeResumeReadiness(session) !== false'));
assert(functionSource('canForkSession').includes('sessionNativeResumeReadiness(session) !== false'));
assert(functionSource('canForkSession').includes('isFreshLiveManagedSessionWithoutHistory(session)'));
assert(functionSource('formatSessionRebindConfirmation').includes('session.rebindRestartWarning'));

async function verifyEmptyManagedSessionCannotResume() {
  const state = { transcripts: new Map() };
  let resumeStarts = 0;
  let confirmations = 0;
  const helpers = loadHelpers([
    'sessionNativeResumeReadiness',
    'isManagedSessionStarting',
    'isEmptyManagedSessionShell',
    'shouldLoadSessionRuntimeConfigOnOpen',
    'resumeFromHistory',
  ], {
    state,
    makeSessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
    getRuntimeForSession: () => null,
    getSelectedSession: () => null,
    confirmResumeAfterFailedRebind: () => {
      confirmations += 1;
      return true;
    },
    startManagedSession: async () => {
      resumeStarts += 1;
      return null;
    },
  });
  const emptyStopped = {
    hostId: 'host-a',
    sessionId: 'empty-stopped',
    source: 'managed',
    state: 'stopped',
    live: false,
    cwd: 'C:/workspace',
    messageCount: 0,
    transcriptPreview: [],
  };
  assert.strictEqual(
    helpers.isEmptyManagedSessionShell(emptyStopped),
    true,
    'an empty stopped managed Session with unknown readiness must be treated as non-resumable'
  );
  assert.strictEqual(
    helpers.shouldLoadSessionRuntimeConfigOnOpen({
      ...emptyStopped,
      state: 'starting',
    }),
    false,
    'a starting fresh Session must not request saved runtime history before startup is confirmed'
  );
  assert.strictEqual(
    helpers.shouldLoadSessionRuntimeConfigOnOpen(emptyStopped),
    false,
    'an empty stopped shell must not request runtime history that does not exist'
  );
  assert.strictEqual(
    helpers.shouldLoadSessionRuntimeConfigOnOpen({
      ...emptyStopped,
      sessionId: 'saved-history',
      state: 'history-only',
      messageCount: 1,
    }),
    true,
    'a real history Session must still load its canonical runtime configuration'
  );
  assert.strictEqual(
    helpers.isEmptyManagedSessionShell({ ...emptyStopped, rolloutPath: 'C:/codex/sessions/thread.jsonl' }),
    false,
    'a discovered rollout is resume evidence when an older Host did not report native readiness'
  );
  await assert.rejects(
    helpers.resumeFromHistory({ session: emptyStopped }),
    /closed before its first turn was saved/i
  );
  assert.strictEqual(confirmations, 0, 'empty-shell Resume must fail before unrelated Rebind confirmation');
  assert.strictEqual(resumeStarts, 0, 'empty-shell Resume must never submit a native resume request');
}

async function verifyFreshRuntimeConfigRaceIsTransientAndDeduplicated() {
  const session = {
    hostId: 'host-a',
    sessionId: 'fresh-live',
    source: 'managed',
    state: 'running',
    live: true,
    runId: 'fresh-run',
    messageCount: 0,
    transcriptPreview: [],
    runtimeConfigError: null,
  };
  const state = {
    sessions: [session],
    transcripts: new Map(),
    sessionRuntimeConfigRequests: new Map(),
  };
  let fetches = 0;
  let controlRenders = 0;
  const helpers = loadHelpers([
    'isTransientFreshRuntimeConfigFailure',
    'loadSessionRuntimeConfigForSession',
  ], {
    state,
    getSessionKey: (candidate) => candidate ? `${candidate.hostId}::${candidate.sessionId}` : null,
    sessionRuntimeProjectionRunId: (candidate) => candidate?.runId || null,
    fetchJson: async () => {
      fetches += 1;
      if (fetches < 3) {
        throw Object.assign(new Error('Saved Session history is unavailable.'), {
          status: 404,
          code: 'session_history_unavailable',
        });
      }
      return {
        runId: 'fresh-run',
        apiBinding: { kind: 'host_environment', bindingFingerprint: 'fresh-binding' },
      };
    },
    applySessionRuntimeConfig: (requestKey, response) => {
      state.sessions[0] = {
        ...state.sessions[0],
        runtimeConfig: response,
        runtimeConfigError: null,
        apiBinding: response.apiBinding,
      };
      return state.sessions[0];
    },
    getSelectedSession: () => state.sessions[0],
    renderSessionDetails: () => {},
    renderSessionApiControls: () => { controlRenders += 1; },
    mergeSession: (patch) => {
      state.sessions[0] = { ...state.sessions[0], ...patch };
      return state.sessions[0];
    },
    structuredSessionError: (error) => ({ code: error.code, error: error.message }),
    isManagedSessionStarting: () => false,
    isEmptyManagedSessionShell: () => false,
    isFreshLiveManagedSessionWithoutHistory: () => true,
    delay: async () => {},
  });

  const [first, duplicate] = await Promise.all([
    helpers.loadSessionRuntimeConfigForSession(session),
    helpers.loadSessionRuntimeConfigForSession(session),
  ]);
  assert.strictEqual(fetches, 3, 'concurrent fresh runtime reads must share one bounded retry sequence');
  assert.strictEqual(first.runtimeConfig.apiBinding.bindingFingerprint, 'fresh-binding');
  assert.strictEqual(duplicate.runtimeConfig.apiBinding.bindingFingerprint, 'fresh-binding');
  assert.strictEqual(state.sessions[0].runtimeConfigError, null, 'a recovered fresh race must not leave a history error');
  assert.strictEqual(state.sessionRuntimeConfigRequests.size, 0, 'the shared runtime request must be released after settlement');
  assert.strictEqual(controlRenders, 1, 'deduplicated callers must not render duplicate API control updates');
}

function verifyNewSessionErrorsStayOnCreationForm() {
  const state = { newSessionLaunchError: null };
  let renders = 0;
  const helpers = loadHelpers(['setNewSessionLaunchError'], {
    state,
    structuredSessionError: (error) => ({
      code: error.code || 'session_spawn_failed',
      error: error.message,
      stage: error.stage || null,
    }),
    renderNewSessionLaunchState: () => { renders += 1; },
  });
  helpers.setNewSessionLaunchError(Object.assign(
    new Error('Host API binding preflight timed out while waiting for host-agent'),
    { stage: 'resolve-binding' }
  ));
  assert.match(state.newSessionLaunchError.error, /No existing Session history was changed/);
  helpers.setNewSessionLaunchError(Object.assign(
    new Error('Saved Session history is unavailable.'),
    { code: 'session_history_unavailable' }
  ));
  assert.match(state.newSessionLaunchError.error, /new Session was not created/i);
  helpers.setNewSessionLaunchError(null);
  assert.strictEqual(state.newSessionLaunchError, null);
  assert.strictEqual(renders, 3);
}

async function verifyUnknownApiHistoryUsesExplicitRebind() {
  const state = { sessions: [] };
  let configuredApi = { profileId: 'profile-b' };
  let supportsRebind = true;
  let cancelRebind = false;
  let ordinaryResumeStarts = 0;
  const rebindCalls = [];
  const sentInputs = [];
  const canonicalByRequestKey = new Map();
  const helpers = loadHelpers([
    'sessionApiBinding',
    'sessionApiControlValue',
    'preferredHistoryRebindTarget',
    'resumeFromHistory',
  ], {
    state,
    getApiRequestConfig: () => configuredApi,
    getSessionKey: (session) => session ? `${session.hostId}::${session.sessionId}` : '',
    getSelectedSession: () => null,
    isEmptyManagedSessionShell: () => false,
    hostSupportsSessionApiRebind: () => supportsRebind,
    switchSessionApiFromComposer: async (session, targetProfileId, options) => {
      rebindCalls.push({ session, targetProfileId, options });
      if (cancelRebind) return null;
      const requestKey = `${session.hostId}::${session.sessionId}`;
      const canonical = {
        ...session,
        sessionId: `${session.sessionId}-canonical`,
        live: true,
        state: 'live',
      };
      canonicalByRequestKey.set(requestKey, canonical);
      state.sessions.push(canonical);
      return { sessionId: canonical.sessionId, runId: 'rebound-run' };
    },
    findSessionForResolvedComposerKey: (key) => canonicalByRequestKey.get(key) || null,
    getComposerOptionsForSession: () => ({
      model: 'target-api-model',
      effort: 'low',
      summary: 'target-summary',
    }),
    sendInputToSession: async (session, text, options) => {
      sentInputs.push({ session, text, options });
    },
    confirmResumeAfterFailedRebind: () => true,
    startManagedSession: async (options) => {
      ordinaryResumeStarts += 1;
      return options.session;
    },
    sessionContractError: (code, message, details = {}) => Object.assign(new Error(message), { code, ...details }),
    t: (key) => key,
  });

  const legacyNullBinding = {
    hostId: 'host-a',
    sessionId: 'legacy-null',
    source: 'managed',
    state: 'stopped',
    live: false,
    apiBinding: null,
  };
  const initialInputItems = [{ type: 'localFile', path: 'C:/workspace/legacy.txt' }];
  const resumedProfileSession = await helpers.resumeFromHistory({
    session: legacyNullBinding,
    initialText: 'resume this legacy prompt',
    initialInputOptions: {
      inputItems: initialInputItems,
      clientRequestId: 'legacy-request-id',
      model: 'old-api-model',
      effort: 'xhigh',
      summary: 'old-summary',
    },
  });
  assert.strictEqual(resumedProfileSession.sessionId, 'legacy-null-canonical');
  assert.strictEqual(rebindCalls.length, 1, 'null binding history must enter exactly one explicit Rebind');
  assert.strictEqual(rebindCalls[0].targetProfileId, 'profile-b', 'Host/default API mapping must choose its saved profile');
  assert.strictEqual(rebindCalls[0].options.force, true, 'history recovery must force Rebind even before a profile is bound');
  assert.strictEqual(ordinaryResumeStarts, 0, 'unknown history must never fall through to ordinary native Resume');
  assert.strictEqual(sentInputs.length, 1, 'the first prompt must be sent exactly once after Rebind completes');
  assert.strictEqual(sentInputs[0].text, 'resume this legacy prompt');
  assert.strictEqual(sentInputs[0].options.inputItems, initialInputItems, 'attachments must survive the Rebind transaction');
  assert.strictEqual(sentInputs[0].options.clientRequestId, 'legacy-request-id', 'the original request identity must survive Rebind');
  assert.strictEqual(sentInputs[0].options.model, 'target-api-model', 'the old API model must not leak into the rebound turn');
  assert.strictEqual(sentInputs[0].options.effort, 'low', 'the old API thinking effort must not leak into the rebound turn');
  assert.strictEqual(sentInputs[0].options.summary, 'target-summary');

  configuredApi = null;
  const legacyUnknownBinding = {
    ...legacyNullBinding,
    sessionId: 'legacy-unknown',
    apiBinding: { kind: 'unknown' },
  };
  await helpers.resumeFromHistory({ session: legacyUnknownBinding });
  assert.strictEqual(
    rebindCalls.at(-1).targetProfileId,
    '__host_environment__',
    'unknown history without a saved profile must explicitly choose the Host environment'
  );

  cancelRebind = true;
  const sendsBeforeCancel = sentInputs.length;
  const canceled = await helpers.resumeFromHistory({
    session: { ...legacyNullBinding, sessionId: 'legacy-canceled' },
    initialText: 'must not send after cancel',
    initialInputOptions: { clientRequestId: 'canceled-request', inputItems: [{ type: 'text' }] },
  });
  assert.strictEqual(canceled, null, 'canceling explicit Rebind must leave history stopped');
  assert.strictEqual(sentInputs.length, sendsBeforeCancel, 'canceling Rebind must not send the pending first prompt');
  assert.strictEqual(ordinaryResumeStarts, 0, 'canceling Rebind must not silently fall back to ordinary Resume');

  cancelRebind = false;
  supportsRebind = false;
  const rebindsBeforeCapabilityFailure = rebindCalls.length;
  await assert.rejects(
    helpers.resumeFromHistory({ session: { ...legacyNullBinding, sessionId: 'legacy-old-agent' } }),
    (error) => error?.code === 'session_api_rebind_capability_unavailable'
  );
  assert.strictEqual(
    rebindCalls.length,
    rebindsBeforeCapabilityFailure,
    'an old Agent without the Rebind contract must be rejected before any Rebind request'
  );
  assert.strictEqual(ordinaryResumeStarts, 0, 'an old Agent must not receive an unsafe ordinary Resume fallback');

  supportsRebind = true;
  const knownBinding = {
    ...legacyNullBinding,
    sessionId: 'known-profile',
    apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'binding-a' },
  };
  const rebindsBeforeKnownResume = rebindCalls.length;
  await helpers.resumeFromHistory({ session: knownBinding });
  assert.strictEqual(rebindCalls.length, rebindsBeforeKnownResume, 'known bindings must retain the ordinary Resume path');
  assert.strictEqual(ordinaryResumeStarts, 1);
}

function verifyAlertHtmlIsRenderedAsText() {
  const dom = new JSDOM('<!doctype html><body></body>');
  const maliciousMessage = [
    'The selected API profile could not list models: <!doctype html>',
    '<img src="invalid" onerror="globalThis.alertHtmlExecuted = true">',
    '<script>globalThis.alertHtmlExecuted = true</script>',
  ].join('\n');
  const maliciousDetail = '<img src="detail" onerror="globalThis.alertHtmlExecuted = true">';
  const helpers = loadHelpers([
    'normalizeAlertSeverity',
    'appendTextElement',
    'createAlertListItem',
    'createStatusAlertItem',
    'createStatusDiagnosticItem',
    'createStatusRequestItem',
    'createRuntimeChip',
    'normalizeModelCatalogError',
  ], {
    document: dom.window.document,
    formatTime: (value) => String(value || ''),
    limitText: (value, maxLength) => String(value || '').slice(0, maxLength),
    summarizeData: (value) => JSON.stringify(value),
  });

  const alert = {
    severity: 'error"><img src=x onerror="globalThis.alertHtmlExecuted = true',
    timestamp: '<img src="time" onerror="globalThis.alertHtmlExecuted = true">',
    source: '<script>globalThis.alertHtmlExecuted = true</script>',
    message: maliciousMessage,
  };
  const alertItem = helpers.createAlertListItem(alert);
  const statusAlertItem = helpers.createStatusAlertItem(alert);
  const diagnosticItem = helpers.createStatusDiagnosticItem({
    severity: 'error"><img src=x onerror="globalThis.alertHtmlExecuted = true',
    kind: '<img src="kind" onerror="globalThis.alertHtmlExecuted = true">',
    timestamp: '<script>globalThis.alertHtmlExecuted = true</script>',
    method: '<img src="method" onerror="globalThis.alertHtmlExecuted = true">',
    message: maliciousMessage,
    detail: maliciousDetail,
    data: { html: '<script>globalThis.alertHtmlExecuted = true</script>' },
  });
  const requestItem = helpers.createStatusRequestItem({
    status: 'pending',
    title: '<img src="request-title" onerror="globalThis.alertHtmlExecuted = true">',
    summary: maliciousMessage,
    method: '<script>globalThis.alertHtmlExecuted = true</script>',
    updatedAt: '<img src="request-time" onerror="globalThis.alertHtmlExecuted = true">',
  });
  const chipContainer = dom.window.document.createElement('div');
  const runtimeChip = helpers.createRuntimeChip(
    chipContainer,
    '<img src="chip-label" onerror="globalThis.alertHtmlExecuted = true">',
    maliciousMessage,
    'error'
  );
  dom.window.document.body.append(alertItem, statusAlertItem, diagnosticItem, requestItem, chipContainer);

  assert.strictEqual(alertItem.querySelector('.alert-message').textContent, maliciousMessage);
  assert.strictEqual(statusAlertItem.querySelector('.status-alert-message').textContent, maliciousMessage);
  assert.strictEqual(diagnosticItem.querySelector('.status-diagnostic-message').textContent, maliciousMessage);
  assert.strictEqual(diagnosticItem.querySelector('.status-diagnostic-detail').textContent, maliciousDetail);
  assert.strictEqual(requestItem.querySelector('.status-request-copy').textContent, maliciousMessage);
  assert.strictEqual(runtimeChip.textContent.includes(maliciousMessage), true);
  assert.strictEqual(dom.window.document.querySelector('img, script'), null, 'alert HTML must never create executable elements');
  assert.strictEqual(dom.window.alertHtmlExecuted, undefined, 'alert HTML must not execute');
  assert(alertItem.textContent.includes('<!doctype html>'), 'historical HTML errors must remain visible as text');
  assert(alertItem.classList.contains('warning'), 'unknown severity values must fall back to a safe class');
  assert(diagnosticItem.classList.contains('info'), 'unknown diagnostic severity values must fall back to a safe class');

  for (const name of ['createAlertListItem', 'createStatusAlertItem', 'createStatusDiagnosticItem', 'createStatusRequestItem', 'createRuntimeChip']) {
    const source = functionSource(name);
    assert(!source.includes('innerHTML'), `${name} must not render data through innerHTML`);
    assert(source.includes('appendTextElement'), `${name} must render data through textContent-backed DOM nodes`);
  }
  assert(functionSource('renderAlertsWindow').includes('createAlertListItem'));
  assert(functionSource('renderStatusWindow').includes('createStatusAlertItem'));
  assert(functionSource('renderStatusWindow').includes('createStatusDiagnosticItem'));
  assert(functionSource('renderStatusWindow').includes('createStatusRequestItem'));
  assert.strictEqual(helpers.normalizeModelCatalogError('  '), 'The API returned HTTP success but not a recognizable model catalog. Check whether the Base URL needs /v1.');
  assert.strictEqual(helpers.normalizeModelCatalogError('<iframe srcdoc="bad"></iframe>').includes('<'), false);
  assert.strictEqual(helpers.normalizeModelCatalogError('x'.repeat(1000)).length, 400);
}

verifyAlertHtmlIsRenderedAsText();

async function verifyApiProfileModelPagination() {
  const requests = [];
  const responses = [{
    result: {
      ok: true,
      modelPage: {
        models: [{ id: 'model-a' }, { id: 'model-b' }],
        complete: false,
        truncated: false,
        nextCursor: 'model-b',
      },
    },
    timestamp: '2026-07-19T00:00:00.000Z',
  }, {
    result: {
      ok: true,
      modelPage: {
        models: [{ id: 'model-b' }, { id: 'model-c' }],
        complete: true,
        truncated: false,
        nextCursor: null,
      },
    },
    timestamp: '2026-07-19T00:00:01.000Z',
  }];
  const helpers = loadHelpers(['fetchApiProfileModelPages'], {
    fetchJson: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return responses.shift();
    },
  });
  const catalog = await helpers.fetchApiProfileModelPages('host/a', { profileId: 'profile-a' });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(catalog.models.map((model) => model.id))),
    ['model-a', 'model-b', 'model-c']
  );
  assert.strictEqual(catalog.complete, true);
  assert.strictEqual(catalog.truncated, false);
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].url, '/api/hosts/host%2Fa/api-test');
  assert.strictEqual(requests[0].body.includeLimit, true);
  assert.strictEqual(requests[1].body.cursor, 'model-b');
}

async function verifyValidatedV1Suggestion() {
  const failure = {
    result: {
      ok: false,
      error: 'The root models endpoint returned HTML.',
      suggestedBaseUrl: 'http://gateway.example:8080/v1',
      suggestionReason: 'validated_v1_models',
    },
  };
  const helpers = loadHelpers([
    'normalizeModelCatalogError',
    'validatedApiBaseUrlSuggestion',
    'fetchApiProfileModelPages',
  ], {
    fetchJson: async () => failure,
  });
  assert.strictEqual(
    helpers.validatedApiBaseUrlSuggestion(failure.result, 'http://gateway.example:8080'),
    'http://gateway.example:8080/v1'
  );
  assert.strictEqual(
    helpers.validatedApiBaseUrlSuggestion({
      ...failure.result,
      suggestedBaseUrl: 'https://other.example/v1',
    }, 'http://gateway.example:8080'),
    '',
    'cross-origin suggestions must never be offered'
  );
  assert.strictEqual(
    helpers.validatedApiBaseUrlSuggestion({
      ...failure.result,
      suggestedBaseUrl: 'http://gateway.example:8080/v1?tenant=b',
    }, 'http://gateway.example:8080?tenant=a'),
    '',
    '/v1 suggestions must preserve the exact normalized query parameters'
  );
  let caught = null;
  try {
    await helpers.fetchApiProfileModelPages('host-a', {
      profileId: 'profile-a',
      baseUrl: 'http://gateway.example:8080',
    });
  } catch (error) {
    caught = error;
  }
  assert(caught, 'a failed exact endpoint must remain a failed request');
  assert.strictEqual(caught.suggestedBaseUrl, 'http://gateway.example:8080/v1');
  assert.strictEqual(caught.suggestionReason, 'validated_v1_models');
}

async function verifyStableCanonicalRebindRetry() {
  const original = { hostId: 'host-a', sessionId: 'session-a', runId: 'run-a' };
  const retryState = { sessions: [original] };
  let attempts = 0;
  let delays = 0;
  const helpers = loadHelpers(['loadStableCanonicalSessionForRebind'], {
    state: retryState,
    getSessionKey: (session) => `${session?.hostId || ''}::${session?.sessionId || ''}`,
    loadSessionRuntimeConfigForSession: async (candidate) => {
      attempts += 1;
      if (attempts === 1) {
        retryState.sessions[0] = { ...candidate, runId: 'run-b' };
        return null;
      }
      return {
        ...retryState.sessions[0],
        runtimeConfig: { runId: 'run-b', runStatus: 'live' },
      };
    },
    delay: async () => { delays += 1; },
    sessionContractError: (code, message) => Object.assign(new Error(message), { code }),
  });
  const canonical = await helpers.loadStableCanonicalSessionForRebind(original);
  assert.strictEqual(canonical.runtimeConfig.runId, 'run-b');
  assert.strictEqual(attempts, 2, 'Rebind must retry using the newest projection after a stale GET result');
  assert.strictEqual(delays, 1);
}

async function verifyLostRebindResponseRecovery() {
  const session = {
    hostId: 'host-a',
    sessionId: 'session-a',
    runId: 'run-a',
    apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'binding-a' },
  };
  const expectation = {
    sessionKey: 'host-a::session-a',
    expectedRunId: 'run-a',
    expectedRunStatus: 'live',
    expectedBindingFingerprint: 'binding-a',
  };
  let observedRequests = 0;
  let clearedFailures = 0;
  let recordedFailures = 0;
  const helpers = loadHelpers([
    'normalizeRebindSelectionSnapshot',
    'rebindResponseWithClientSelection',
    'rebindFailureMayHaveLostAcceptedResponse',
    'rebindSessionApi',
  ], {
    state: { sessions: [session] },
    getSessionKey: (candidate) => `${candidate?.hostId || ''}::${candidate?.sessionId || ''}`,
    captureSessionLifecycleExpectation: () => expectation,
    sessionContractError: (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra }),
    validateApiConfigForRequest: () => {},
    sessionApiBinding: (candidate) => candidate?.apiBinding || null,
    rebindTargetSummary: (profileId) => ({ kind: 'profile', profileId, label: profileId }),
    verifyHostAvailable: async () => {},
    fetchJson: async () => { throw new Error('connection closed after request upload'); },
    applyRebindLaunchResponse: () => { throw new Error('a missing response cannot be applied'); },
    renderAll: () => {},
    rebindResponseWasAccepted: async (candidate, target, previousRunId, expectedSelection) => {
      observedRequests += 1;
      assert.strictEqual(candidate.sessionId, 'session-a');
      assert.strictEqual(target.profileId, 'profile-b');
      assert.strictEqual(previousRunId, 'run-a');
      assert.deepStrictEqual(
        JSON.parse(JSON.stringify(expectedSelection)),
        { model: 'model-b', effort: '', summary: '' }
      );
      return {
        hostId: 'host-a',
        sessionId: 'session-a',
        runId: 'run-b',
        sessionBinding: { kind: 'profile', profileId: 'profile-b', bindingFingerprint: 'binding-b' },
      };
    },
    clearSessionRebindFailure: () => { clearedFailures += 1; },
    recordSessionRebindFailure: () => { recordedFailures += 1; },
  });
  const recovered = await helpers.rebindSessionApi(
    session,
    'profile-b',
    { model: 'model-b' },
    { profileId: 'profile-b', providerKind: 'custom', baseUrl: 'https://gateway.example/v1', apiKey: 'secret' },
    { canonicalSession: session, confirm: false, waitForReady: false }
  );
  assert.strictEqual(recovered.runId, 'run-b');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(recovered.clientSelection)),
    { model: 'model-b', effort: '', summary: '' },
    'a canonically recovered accepted Rebind must retain the originally submitted selection'
  );
  assert.strictEqual(observedRequests, 1, 'a failed HTTP response must trigger canonical acceptance discovery');
  assert.strictEqual(clearedFailures, 1, 'a discovered accepted Rebind must clear the old failure warning');
  assert.strictEqual(recordedFailures, 0, 'a discovered accepted Rebind must not be recorded as failed');
}

async function verifyDefinitiveRebindConflictDoesNotRecover() {
  const session = {
    hostId: 'host-a',
    sessionId: 'session-a',
    runId: 'run-a',
    apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'binding-a' },
  };
  const expectation = {
    sessionKey: 'host-a::session-a',
    expectedRunId: 'run-a',
    expectedRunStatus: 'live',
    expectedBindingFingerprint: 'binding-a',
  };
  const conflict = Object.assign(new Error('run changed'), {
    status: 409,
    code: 'session_run_state_conflict',
  });
  let observedRequests = 0;
  let recordedFailures = 0;
  const helpers = loadHelpers([
    'normalizeRebindSelectionSnapshot',
    'rebindResponseWithClientSelection',
    'rebindFailureMayHaveLostAcceptedResponse',
    'rebindSessionApi',
  ], {
    state: { sessions: [session] },
    getSessionKey: (candidate) => `${candidate?.hostId || ''}::${candidate?.sessionId || ''}`,
    captureSessionLifecycleExpectation: () => expectation,
    sessionContractError: (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra }),
    validateApiConfigForRequest: () => {},
    sessionApiBinding: (candidate) => candidate?.apiBinding || null,
    rebindTargetSummary: (profileId) => ({ kind: 'profile', profileId, label: profileId }),
    verifyHostAvailable: async () => {},
    fetchJson: async () => { throw conflict; },
    applyRebindLaunchResponse: () => { throw new Error('a rejected request cannot be applied'); },
    renderAll: () => {},
    rebindResponseWasAccepted: async () => {
      observedRequests += 1;
      return { runId: 'other-client-run' };
    },
    recordSessionRebindFailure: () => { recordedFailures += 1; },
    structuredSessionError: (error) => ({ code: error.code, error: error.message }),
    mergeSession: () => {},
  });
  await assert.rejects(
    helpers.rebindSessionApi(
      session,
      'profile-b',
      { model: 'model-b', effort: '', summary: '' },
      { profileId: 'profile-b', providerKind: 'custom', baseUrl: 'https://gateway.example/v1', apiKey: 'secret' },
      { canonicalSession: session, confirm: false, waitForReady: false }
    ),
    (error) => error === conflict
  );
  assert.strictEqual(observedRequests, 0, 'HTTP 409 must not recover another client\'s same-target Rebind');
  assert.strictEqual(recordedFailures, 1);
}

async function verifyCurrentSelectionSnapshotSurvivesMutation() {
  const session = {
    hostId: 'host-a',
    sessionId: 'session-a',
    runId: 'run-a',
    apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'binding-a' },
  };
  const expectation = {
    sessionKey: 'host-a::session-a',
    expectedRunId: 'run-a',
    expectedRunStatus: 'live',
    expectedBindingFingerprint: 'binding-a',
  };
  const profile = {
    profileId: 'profile-b',
  };
  const sourceSelection = { model: 'submitted-model', effort: 'high', summary: 'concise' };
  const requestState = {
    sessions: [session],
    ui: { apiProfiles: [profile] },
  };
  let submittedBody = null;
  const helpers = loadHelpers([
    'normalizeRebindSelectionSnapshot',
    'rebindResponseWithClientSelection',
    'rebindFailureMayHaveLostAcceptedResponse',
    'rebindSessionApi',
  ], {
    state: requestState,
    REASONING_EFFORT_PATTERN: /^[a-z][a-z0-9_-]{0,31}$/,
    getSessionKey: (candidate) => `${candidate?.hostId || ''}::${candidate?.sessionId || ''}`,
    captureSessionLifecycleExpectation: () => expectation,
    sessionContractError: (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra }),
    validateApiConfigForRequest: () => {},
    sessionApiBinding: (candidate) => candidate?.apiBinding || null,
    rebindTargetSummary: (profileId) => ({ kind: 'profile', profileId, label: profileId }),
    verifyHostAvailable: async () => {},
    fetchJson: async (_url, options) => {
      submittedBody = JSON.parse(options.body);
      sourceSelection.model = 'changed-while-request-was-pending';
      sourceSelection.effort = 'low';
      return {
        hostId: 'host-a',
        sessionId: 'session-a',
        runId: 'run-b',
        sessionBinding: { kind: 'profile', profileId: 'profile-b', bindingFingerprint: 'binding-b' },
      };
    },
    applyRebindLaunchResponse: () => {},
    renderAll: () => {},
  });
  const response = await helpers.rebindSessionApi(
    session,
    'profile-b',
    sourceSelection,
    { profileId: 'profile-b', providerKind: 'custom', baseUrl: 'https://gateway.example/v1', apiKey: 'secret' },
    {
      canonicalSession: session,
      confirm: false,
      waitForReady: false,
      selectionSource: 'current-session',
      modelCatalogReuseToken: 'opaque-proof',
    }
  );
  assert.deepStrictEqual(
    {
      model: submittedBody.model,
      effort: submittedBody.effort,
      summary: submittedBody.summary,
    },
    { model: 'submitted-model', effort: 'high', summary: 'concise' }
  );
  assert.strictEqual(submittedBody.modelCatalogReuseToken, 'opaque-proof');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(response.clientSelection)),
    { model: 'submitted-model', effort: 'high', summary: 'concise' },
    'Rebind completion must expose the current Session snapshot captured before the request started'
  );
}

function verifySecretlessRebindBrowserState() {
  const formattedKeys = [];
  const translations = {
    'session.rebindConfirmTitle': 'Rebind this Session?',
    'session.rebindConfirmFrom': 'From: {binding}',
    'session.rebindConfirmTo': 'To: {binding}',
    'session.rebindConfirmEndpoint': 'Final /responses endpoint: {endpoint}',
    'session.endpointUnavailable': 'Unavailable',
    'session.hostEnvironment': 'Host environment',
    'session.unknownApiBinding': 'Unknown API binding',
    'session.rebindFailed': 'Rebind to {target} failed.',
    'session.rebindResumePrevious': 'Resume with the last successful binding: {binding}',
    'session.rebindContinue': 'Continue?',
  };
  const helpers = loadHelpers([
    'normalizedBrowserSecretKey',
    'isBrowserSecretQueryKey',
    'browserSafeUrl',
    'browserSafeApiBinding',
    'browserSafeRebindTarget',
    'normalizeSessionRebindFailures',
    'normalizeApiIdentityBaseUrl',
    'effectiveApiBaseUrl',
    'apiResponsesEndpoint',
    'rebindTargetSummary',
    'rebindTargetDisplayLabel',
    'apiBindingConfirmationLabel',
    'rebindSelectionDisplayValue',
    'formatSessionRebindConfirmation',
  ], {
    inferApiProviderKind: (input) => input?.providerKind || (String(input?.provider || '').toLowerCase() === 'openai' ? 'openai' : 'custom'),
    OPENAI_OFFICIAL_BASE_URL: 'https://api.openai.com/v1',
    t: (key) => translations[key] || key,
    formatUiText: (key, values = {}) => {
      formattedKeys.push(key);
      return (translations[key] || key).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
      ));
    },
  });
  const safeUrl = new URL(helpers.browserSafeUrl(
    'https://gateway.example/v1?tenant=a&sig=sig-secret&code=code-secret&key=key-secret&AWSAccessKeyId=aws-secret'
  ));
  assert.strictEqual(safeUrl.searchParams.get('tenant'), 'a');
  for (const key of ['sig', 'code', 'key', 'AWSAccessKeyId']) {
    assert.strictEqual(safeUrl.searchParams.has(key), false, `${key} must be removed from browser-persisted URLs`);
  }
  const target = helpers.rebindTargetSummary('profile-a', {
    profileId: 'profile-a',
    label: 'MineMine',
    provider: 'MineMine',
    providerKind: 'custom',
    baseUrl: 'https://gateway.example/v1?tenant=a&api_key=query-secret',
    apiKey: 'body-secret',
  });
  const message = helpers.formatSessionRebindConfirmation({
    kind: 'profile',
    profileId: 'old-profile',
    label: 'Old profile',
    provider: 'OpenAI',
    providerKind: 'openai',
    normalizedBaseUrl: 'https://old.example/v1',
    apiKey: 'old-secret',
  }, target);
  const serialized = JSON.stringify({ target, message });
  assert(!serialized.includes('body-secret'));
  assert(!serialized.includes('old-secret'));
  assert(!serialized.includes('query-secret'));
  assert(message.includes('From:'));
  assert(message.includes('To: MineMine'));
  assert(message.includes('Final /responses endpoint:'));
  assert(formattedKeys.includes('session.rebindConfirmEndpoint'), 'the endpoint label must use its i18n key');

  const restored = helpers.normalizeSessionRebindFailures({
    'host-a::session-a': {
      hostId: 'host-a',
      sessionId: 'session-a',
      apiKey: 'top-level-secret',
      previousBinding: {
        kind: 'profile',
        provider: 'OpenAI',
        normalizedBaseUrl: 'https://old.example/v1',
        apiKey: 'binding-secret',
      },
      target: {
        kind: 'profile',
        label: 'MineMine',
        baseUrl: 'https://gateway.example/v1',
        responsesEndpoint: 'https://gateway.example/v1/responses',
        apiKey: 'target-secret',
      },
    },
  });
  assert.strictEqual(restored.size, 1);
  assert(!JSON.stringify([...restored.values()]).includes('secret'));

  let prompt = '';
  let cleared = 0;
  const resumeHelpers = loadHelpers(['confirmResumeAfterFailedRebind'], {
    state: { sessionRebindFailures: restored },
    getSessionKey: (session) => `${session.hostId}::${session.sessionId}`,
    rebindTargetDisplayLabel: () => 'MineMine',
    apiBindingConfirmationLabel: () => 'Old profile (https://old.example/v1/responses)',
    t: (key) => translations[key] || key,
    formatUiText: (key, values = {}) => (translations[key] || key).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
    )),
    clearSessionRebindFailure: () => { cleared += 1; },
    window: { confirm: (value) => { prompt = value; return true; } },
  });
  assert.strictEqual(resumeHelpers.confirmResumeAfterFailedRebind({ hostId: 'host-a', sessionId: 'session-a' }), true);
  assert(prompt.includes('last successful binding'));
  assert.strictEqual(cleared, 1, 'confirming ordinary Resume must consume the warning');
}

verifySecretlessRebindBrowserState();

async function verifyApiProfileModelRequestIsolation() {
  function deferred() {
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    return { promise, resolve };
  }
  function page(id) {
    return {
      models: [{ id }],
      complete: true,
      truncated: false,
      nextCursor: null,
      fetchedAt: '2026-07-19T00:00:00.000Z',
    };
  }

  const profileA = { profileId: 'profile-a', providerKind: 'openai', provider: 'OpenAI' };
  const profileB = { profileId: 'profile-b', providerKind: 'custom', provider: 'Custom' };
  const profileC = { profileId: 'profile-c', providerKind: 'openai', provider: 'OpenAI' };
  let currentProfile = profileA;
  let operationSequence = 0;
  const firstPage = deferred();
  const secondPage = deferred();
  const olderSameKeyPage = deferred();
  const newerSameKeyPage = deferred();
  const pageQueue = [firstPage, secondPage, olderSameKeyPage, newerSameKeyPage];
  const requestState = {
    apiProfileModelCatalogs: new Map(),
    apiProfileModelCatalogRequests: new Map(),
  };
  const renders = [];
  const helpers = loadHelpers(['apiProfileModelRequestIsCurrent', 'fetchApiProfileModels'], {
    state: requestState,
    saveActiveApiProfileFromSettingsForm: () => currentProfile,
    selectedApiProfileModelHostId: () => 'host-a',
    apiProfileRequestConfig: (profile) => ({ ...profile, apiKey: `${profile.profileId}-key` }),
    validateApiConfigForRequest: () => {},
    apiProfileModelCatalogKey: (profile) => profile?.profileId || '',
    apiProfileModelCatalogKeyForConfig: (profile) => profile?.profileId || '',
    apiProfileModelCatalogStorageKey: (key) => `stored::${key}`,
    makeClientId: () => `operation-${++operationSequence}`,
    renderApiProviderEditorState: (profile) => renders.push(profile?.profileId || null),
    verifyHostAvailable: async () => {},
    fetchApiProfileModelPages: async () => pageQueue.shift().promise,
    providerCapabilitiesRegistry: () => ({
      decorateModels: (providerKind, models) => models.map((model) => ({
        ...model,
        decoratedWith: providerKind,
      })),
    }),
    inferApiProviderKind: (profile) => profile?.providerKind || 'custom',
    getSelectedApiProfile: () => currentProfile,
    persistApiProfileModelCatalogs: () => {},
    rebindProfilePreviewIdentity: (profile) => profile?.profileId || '',
    normalizeModelCatalogError: (value) => String(value || 'catalog error'),
  });

  const firstProfileRequest = helpers.fetchApiProfileModels();
  currentProfile = profileB;
  const secondProfileRequest = helpers.fetchApiProfileModels();
  const renderCountBeforeStaleResult = renders.length;
  profileA.providerKind = 'custom';
  firstPage.resolve(page('model-a'));
  await firstProfileRequest;
  assert.strictEqual(
    requestState.apiProfileModelCatalogRequests.get('profile-b')?.busy,
    true,
    'an older Profile response must not clear another Profile request state'
  );
  assert.strictEqual(renders.length, renderCountBeforeStaleResult, 'an older Profile response must not redraw the current editor');
  assert.strictEqual(
    requestState.apiProfileModelCatalogs.get('profile-a')?.models?.[0]?.decoratedWith,
    'openai',
    'model responses must use the provider kind captured when the request started'
  );
  secondPage.resolve(page('model-b'));
  await secondProfileRequest;
  assert.strictEqual(requestState.apiProfileModelCatalogs.get('profile-b')?.models?.[0]?.id, 'model-b');

  currentProfile = profileC;
  const olderSameKeyRequest = helpers.fetchApiProfileModels();
  const newerSameKeyRequest = helpers.fetchApiProfileModels();
  newerSameKeyPage.resolve(page('model-c-new'));
  await newerSameKeyRequest;
  olderSameKeyPage.resolve(page('model-c-old'));
  await olderSameKeyRequest;
  assert.strictEqual(
    requestState.apiProfileModelCatalogs.get('profile-c')?.models?.[0]?.id,
    'model-c-new',
    'a stale same-identity response must not overwrite a newer model catalog'
  );
}

async function verifyLostManagedLaunchResponseRecovery() {
  const attempts = [];
  const accepted = { ok: true, sessionId: 'session-stable', runId: 'run-stable', idempotentReplay: true };
  const helpers = loadHelpers([
    'managedLaunchFailureMayHaveLostAcceptedResponse',
    'fetchManagedLaunchWithRetry',
  ], {
    delay: async () => {},
    fetchJson: async (url, options) => {
      attempts.push({ url, body: options.body });
      if (attempts.length === 1) {
        throw new Error('connection closed after Relay accepted the request');
      }
      return accepted;
    },
  });
  const body = {
    clientRequestId: 'stable-client-intent',
    cwd: '/workspace/novel',
    label: 'Novel',
  };
  assert.strictEqual(helpers.managedLaunchFailureMayHaveLostAcceptedResponse({ status: 503 }), true);
  assert.strictEqual(helpers.managedLaunchFailureMayHaveLostAcceptedResponse({ status: 409 }), false);
  const response = await helpers.fetchManagedLaunchWithRetry('pi5', body);
  assert.deepStrictEqual(response, accepted);
  assert.strictEqual(attempts.length, 2, 'an ambiguous lost response must retry exactly once');
  assert.strictEqual(attempts[0].url, attempts[1].url);
  assert.strictEqual(attempts[0].body, attempts[1].body, 'the retry must preserve the exact client intent payload');

  let conflictAttempts = 0;
  const conflictHelpers = loadHelpers([
    'managedLaunchFailureMayHaveLostAcceptedResponse',
    'fetchManagedLaunchWithRetry',
  ], {
    delay: async () => {},
    fetchJson: async () => {
      conflictAttempts += 1;
      const error = new Error('request conflict');
      error.status = 409;
      throw error;
    },
  });
  await assert.rejects(
    conflictHelpers.fetchManagedLaunchWithRetry('pi5', body),
    /request conflict/
  );
  assert.strictEqual(conflictAttempts, 1, 'a definitive server conflict must not retry Session creation');
}

async function verifyStopFailureRestoresCompleteRuntimeSnapshot() {
  const session = {
    hostId: 'host-stop',
    sessionId: 'session-stop',
    live: true,
    runId: 'run-stop',
  };
  const sessionKey = `${session.hostId}::${session.sessionId}`;
  const originalRuntime = {
    phase: 'thinking',
    connection: 'ready',
    busy: true,
    activeTurnId: 'turn-stop',
    currentTurnStatus: 'inProgress',
    waitingOnApproval: false,
    waitingOnUserInput: false,
    pendingInputSummary: 'keep the pending input summary',
    queuedCommandId: 'queued-command-stop',
    lastError: null,
    lastCodexError: null,
    customRuntimeField: 'must survive rollback',
    updatedAt: '2026-07-20T10:00:00.000Z',
  };
  const runtimeState = new Map();
  const runtimeApplyGenerations = new Map();
  const runtimeStreamGenerations = new Map();
  const expectation = {
    expectedRunId: session.runId,
    expectedRunStatus: 'live',
    expectedBindingFingerprint: 'binding-stop',
  };
  const stopFailure = new Error('Relay Stop request failed');
  let renderCount = 0;
  const helpers = loadHelpers([
    'restoreRuntimeSnapshotForSession',
    'endCurrentSession',
    'stopManagedSession',
  ], {
    state: {
      runtime: runtimeState,
      runtimeApplyGenerations,
      runtimeStreamGenerations,
    },
    makeSessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
    getRuntimeApplyGeneration: (hostId, sessionId) => (
      runtimeApplyGenerations.get(`${hostId}::${sessionId}`) || 0
    ),
    getRuntimeStreamGeneration: (hostId, sessionId) => (
      runtimeStreamGenerations.get(`${hostId}::${sessionId}`) || 0
    ),
    getSelectedSession: () => session,
    isSessionApiRebindBusy: () => false,
    sessionContractError: (_code, message) => new Error(message),
    t: (key) => key,
    window: { confirm: () => true },
    loadCanonicalSessionForLifecycleMutation: async () => session,
    captureSessionLifecycleExpectation: () => expectation,
    getRuntimeForSession: () => runtimeState.get(sessionKey) || null,
    patchRuntimeForSession: (hostId, sessionId, patch) => {
      const key = `${hostId}::${sessionId}`;
      const next = { ...(runtimeState.get(key) || {}), ...patch };
      runtimeState.set(key, next);
      runtimeApplyGenerations.set(key, (runtimeApplyGenerations.get(key) || 0) + 1);
      return next;
    },
    renderAll: () => { renderCount += 1; },
    fetchJson: async () => { throw stopFailure; },
    delay: async () => {},
    refresh: async () => {},
  });

  const assertRuntimeRestored = (label) => {
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(runtimeState.get(sessionKey))),
      originalRuntime,
      `${label} must restore the exact browser runtime snapshot`
    );
    assert.notStrictEqual(runtimeState.get(sessionKey)?.phase, 'ending');
    assert.notStrictEqual(runtimeState.get(sessionKey)?.phase, 'error');
  };

  runtimeState.set(sessionKey, { ...originalRuntime });
  await assert.rejects(helpers.endCurrentSession(), (error) => error === stopFailure);
  assertRuntimeRestored('single Stop failure');

  runtimeState.set(sessionKey, { ...originalRuntime });
  await assert.rejects(helpers.stopManagedSession(session), (error) => error === stopFailure);
  assertRuntimeRestored('bulk Stop failure');
  assert(renderCount >= 3, 'both failed Stop paths must redraw after restoring runtime state');
}

async function verifyComposerApiSwitchTransaction() {
  const session = {
    hostId: 'host-a',
    sessionId: 'session-a',
    live: true,
    apiBinding: { kind: 'profile', profileId: 'profile-a', bindingFingerprint: 'binding-a' },
  };
  let runtime = {};
  let rebindResult = null;
  let rebindCalls = 0;
  let submittedSelection = null;
  let submittedApiConfig = null;
  let appliedSelection = null;
  let catalogFailure = null;
  let reportedErrors = 0;
  let restoredDraft = null;
  let submittedTargetProfileId = null;
  const busyTransitions = [];
  const notices = [];
  const helpers = loadHelpers(['switchSessionApiFromComposer'], {
    state: {
      sessions: [session],
      ui: { apiProfiles: [{ profileId: 'profile-b', label: 'Profile B' }] },
    },
    getSessionKey: (candidate) => `${candidate.hostId}::${candidate.sessionId}`,
    getSelectedSession: () => session,
    syncMountedComposerDraftSession: () => {},
    el: () => ({ value: 'draft survives API switch' }),
    snapshotComposerDraft: (text) => ({ text, attachments: [], localImagePath: '' }),
    setComposerDraftForSessionKey: (_key, draft) => { restoredDraft = draft; },
    getComposerDraftForSessionKey: () => restoredDraft || { text: '', attachments: [], localImagePath: '' },
    composerDraftHasTemporaryContent: (draft) => Boolean(draft?.text || draft?.attachments?.length || draft?.localImagePath),
    resolveComposerSessionKey: (key) => key,
    findSessionForResolvedComposerKey: (_key, fallback) => fallback,
    applyMountedComposerDraft: (_key, draft) => { restoredDraft = draft; },
    isSessionApiRebindBusy: () => false,
    sessionApiControlValue: () => 'profile-a',
    getRuntimeForSession: () => runtime,
    runtimeIsActive: (value) => value.busy === true,
    sessionSupportsTurnSelectionControls: () => true,
    hostSupportsSessionApiRebind: () => true,
    setSessionApiSwitchNotice: (_session, message = '', tone = '') => notices.push({ message, tone }),
    renderSessionApiControls: () => {},
    setSessionApiRebindBusy: (_session, busy) => busyTransitions.push(busy),
    renderSessionDetails: () => {},
    getComposerOptionsForSession: () => ({ model: 'model-a', effort: 'high', summary: 'concise' }),
    normalizeRebindSelectionSnapshot: (selection) => ({
      model: String(selection.model || ''),
      effort: String(selection.effort || ''),
      summary: String(selection.summary || ''),
    }),
    rebindSessionApi: async (_session, profileId, selection, apiConfig) => {
      rebindCalls += 1;
      submittedTargetProfileId = profileId;
      submittedSelection = selection;
      submittedApiConfig = apiConfig;
      if (rebindResult instanceof Error) throw rebindResult;
      return rebindResult;
    },
    captureModelCatalogRequest: () => ({}),
    applyModelCatalogResponse: (_request, catalog) => catalog,
    loadModelOptionsForSession: async () => {
      if (catalogFailure) throw catalogFailure;
      return { models: [{ id: 'model-latest', isDefault: true }] };
    },
    preferredModelForApiSwitch: (catalog) => catalog.models[0].id,
    applySessionSelectionToSessionOptions: (_session, selection) => { appliedSelection = selection; },
    rebindResponseWithClientSelection: (response, selection) => ({ ...response, clientSelection: selection }),
    rebindTargetSummary: (profileId) => ({ kind: 'profile', profileId, label: profileId }),
    apiProfileRequestConfig: (profile) => profile,
    rebindTargetDisplayLabel: (target) => target.label,
    recordSessionRebindFailure: () => {},
    sessionApiBinding: (candidate) => candidate.apiBinding,
    reportError: () => { reportedErrors += 1; },
    t: (key) => key,
    formatUiText: (key, values) => `${key}:${values.target}`,
  });

  runtime = { busy: true };
  await helpers.switchSessionApiFromComposer(session, 'profile-b');
  assert.strictEqual(rebindCalls, 0, 'an active turn must not be interrupted by an API switch');
  assert.strictEqual(notices.at(-1)?.message, 'session.apiSwitchWaitIdle');

  runtime = {};
  rebindResult = null;
  await helpers.switchSessionApiFromComposer(session, 'profile-b');
  assert.strictEqual(rebindCalls, 1, 'an idle API choice must enter the confirmed Rebind path');
  assert.deepStrictEqual(
    submittedSelection,
    { model: '', effort: '', summary: 'concise' },
    'API switching must clear the previous model and effort before Rebind'
  );
  assert.strictEqual(submittedApiConfig.profileId, 'profile-b');
  assert.strictEqual(submittedTargetProfileId, 'profile-b');
  assert.deepStrictEqual(busyTransitions.slice(-2), [true, false]);
  assert.strictEqual(notices.at(-1)?.message, 'session.apiSwitchCanceled');
  assert.strictEqual(appliedSelection, null, 'canceling must not change next-turn settings');
  assert.strictEqual(restoredDraft?.text, 'draft survives API switch', 'canceling an API switch must restore the composer draft');

  rebindResult = {
    clientSelection: { model: 'model-b', effort: 'high' },
    modelCatalog: {
      models: [{ id: 'model-latest', isDefault: true }],
      sources: [{ source: 'provider', stale: false, models: [{ id: 'model-latest' }] }],
    },
  };
  const switched = await helpers.switchSessionApiFromComposer(session, 'profile-b');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(appliedSelection)),
    { model: 'model-latest', effort: '', summary: 'concise' },
    'a successful API switch must use the target catalog model and Auto thinking'
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(switched.clientSelection)),
    JSON.parse(JSON.stringify(appliedSelection))
  );
  assert.strictEqual(notices.at(-1)?.tone, 'success');

  rebindResult = {
    modelCatalog: {
      models: [{ id: 'host-model', isDefault: true }],
      sources: [{ source: 'runtime', stale: false, models: [{ id: 'host-model' }] }],
    },
  };
  submittedApiConfig = { stale: true };
  await helpers.switchSessionApiFromComposer(session, '__host_environment__');
  assert.strictEqual(submittedTargetProfileId, '__host_environment__');
  assert.strictEqual(submittedApiConfig, undefined, 'Host environment Rebind must not submit a saved profile snapshot');

  catalogFailure = new Error('catalog refresh delayed');
  rebindResult = { clientSelection: { model: '', effort: '' } };
  appliedSelection = null;
  await helpers.switchSessionApiFromComposer(session, 'profile-b');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(appliedSelection)),
    { model: '', effort: '', summary: 'concise' },
    'a successful switch must remain on safe Auto settings when the refreshed catalog is unavailable'
  );

  catalogFailure = null;
  rebindResult = new Error('preflight rejected');
  await helpers.switchSessionApiFromComposer(session, 'profile-b');
  assert.strictEqual(reportedErrors, 1, 'a failed API switch must remain visible');
  assert.strictEqual(notices.at(-1)?.tone, 'error');
}

function verifyPreferredApiSwitchModel() {
  const helpers = loadHelpers(['preferredModelForApiSwitch'], {
    modelIsSelectableCatalogMember: (model) => model?.selectable !== false,
  });
  const catalog = {
    defaultModel: 'old-default',
    models: [
      { id: 'old-default', isDefault: true },
      { id: 'latest-unavailable', selectable: false },
      { id: 'latest-available' },
    ],
    sources: [{
      source: 'last-known-good',
      originSource: 'provider',
      authority: 'advisory',
      stale: true,
      models: [
        { id: 'latest-unavailable' },
        { id: 'latest-available' },
        { id: 'old-default' },
      ],
    }],
  };
  assert.strictEqual(
    helpers.preferredModelForApiSwitch(catalog),
    'latest-available',
    'API switching must choose the first target-advertised model that is actually selectable'
  );
  assert.strictEqual(
    helpers.preferredModelForApiSwitch(catalog, { requireFreshProvider: true }),
    '',
    'a profile switch must not treat stale provider evidence as the new API selection'
  );
  assert.strictEqual(
    helpers.preferredModelForApiSwitch({
      ...catalog,
      sources: [{
        source: 'provider',
        authority: 'authoritative',
        stale: false,
        models: catalog.sources[0].models,
      }],
    }, { requireFreshProvider: true }),
    'latest-available',
    'a profile switch must select from the fresh provider catalog returned by Rebind'
  );
  assert.strictEqual(
    helpers.preferredModelForApiSwitch({
      defaultModel: 'catalog-default',
      models: [{ id: 'catalog-default', isDefault: true }],
      sources: [],
    }),
    'catalog-default',
    'a live catalog default must be used when the provider response has no ordered model list'
  );
  assert.strictEqual(
    helpers.preferredModelForApiSwitch({
      defaultModel: 'catalog-default',
      models: [{ id: 'catalog-default', isDefault: true }],
      sources: [],
    }, { requireFreshProvider: true }),
    '',
    'a profile switch must remain Auto when no fresh provider model is available'
  );
}

Promise.resolve()
  .then(verifyBatchApplyReusesPreflightCatalog)
  .then(verifyEmptyManagedSessionCannotResume)
  .then(verifyFreshRuntimeConfigRaceIsTransientAndDeduplicated)
  .then(verifyNewSessionErrorsStayOnCreationForm)
  .then(verifyUnknownApiHistoryUsesExplicitRebind)
  .then(verifyApiProfileModelPagination)
  .then(verifyValidatedV1Suggestion)
  .then(verifyStableCanonicalRebindRetry)
  .then(verifyLostRebindResponseRecovery)
  .then(verifyDefinitiveRebindConflictDoesNotRecover)
  .then(verifyCurrentSelectionSnapshotSurvivesMutation)
  .then(verifyApiProfileModelRequestIsolation)
  .then(verifyLostManagedLaunchResponseRecovery)
  .then(verifyStopFailureRestoresCompleteRuntimeSnapshot)
  .then(verifyComposerApiSwitchTransaction)
  .then(verifyPreferredApiSwitchModel)
  .then(() => {
  console.log('session API UI assertions passed');
  }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  });
