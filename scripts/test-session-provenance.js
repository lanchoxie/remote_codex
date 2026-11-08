const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionRecordStore } = require('../apps/relay/session-record-store');
const {
  SessionContractError,
  SessionProvenanceService,
} = require('../apps/relay/session-provenance-service');
const {
  bindingsEqual,
  makeHostEnvironmentBinding,
  makeProfileBinding,
  makeUnknownBinding,
  normalizeBaseUrl,
  publicBinding,
  resumeBindingsCompatible,
} = require('../shared/api-binding');

async function main() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-provenance-'));
  let tick = 0;
  const clockBaseMs = Date.parse('2026-07-16T00:00:00.000Z');
  const now = () => new Date(clockBaseMs + (tick++ * 1000)).toISOString();
  const store = await SessionRecordStore.open({ rootDir, snapshotEvery: 2, now });
  const service = new SessionProvenanceService({ store, now });

  const asxs = makeProfileBinding({
    profileId: 'api-asxs',
    label: 'Asxs',
    provider: 'OpenAI',
    baseUrl: 'https://api.asxs.top/v1/',
    apiKey: 'secret-one',
  });
  const renamedAsxs = makeProfileBinding({
    profileId: 'api-asxs',
    label: 'Renamed label',
    provider: 'openai',
    baseUrl: 'https://API.ASXS.TOP/v1',
    apiKey: 'secret-two',
  });
  const other = makeProfileBinding({
    profileId: 'api-other',
    label: 'Other',
    provider: 'OpenAI',
    baseUrl: 'https://other.example/v1',
  });
  const asxsRotatedProfile = makeProfileBinding({
    profileId: 'api-asxs-rotated-profile',
    label: 'Asxs rotated profile',
    provider: 'OpenAI',
    baseUrl: 'https://api.asxs.top/v1',
  });
  const keyedGatewayA = makeProfileBinding({
    profileId: 'keyed-gateway-a',
    label: 'Gateway A',
    provider: 'Custom',
    providerKind: 'custom',
    baseUrl: 'https://gateway-a.example/v1',
    nativeResumeCompatibilityKey: 'shared-sub2api-gateway',
  });
  const keyedGatewayB = makeProfileBinding({
    profileId: 'keyed-gateway-b',
    label: 'Gateway B',
    provider: 'Custom',
    providerKind: 'custom',
    baseUrl: 'https://gateway-b.example/v1',
    nativeResumeCompatibilityKey: 'shared-sub2api-gateway',
  });
  const legacyOpenAiKeyOnlyBinding = {
    kind: 'profile',
    profileId: 'legacy-openai-key-only',
    label: 'Legacy OpenAI key-only',
    provider: 'OpenAI',
    providerKind: null,
    normalizedBaseUrl: null,
    bindingFingerprint: 'persisted-pre-canonicalization-fingerprint',
  };
  const canonicalOpenAiKeyOnlyBinding = makeProfileBinding({
    profileId: 'legacy-openai-key-only',
    label: 'Legacy OpenAI key-only',
    provider: 'OpenAI',
    providerKind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  });
  assert.strictEqual(
    publicBinding(legacyOpenAiKeyOnlyBinding).bindingFingerprint,
    canonicalOpenAiKeyOnlyBinding.bindingFingerprint,
    'publicBinding must recalculate legacy OpenAI null-base identity with the official endpoint'
  );
  assert.strictEqual(bindingsEqual(asxs, renamedAsxs), true, 'label/key rotation must not change API identity');
  assert.notStrictEqual(
    asxs.bindingFingerprint,
    asxsRotatedProfile.bindingFingerprint,
    'a distinct profile ID must remain a distinct durable binding identity'
  );
  assert.strictEqual(
    bindingsEqual(asxs, asxsRotatedProfile),
    false,
    'same-endpoint profile rotation must not collapse durable binding identities'
  );
  assert.strictEqual(
    resumeBindingsCompatible(asxs, asxsRotatedProfile),
    true,
    'same endpoint profiles must be compatible for native resume'
  );
  assert.strictEqual(
    resumeBindingsCompatible(asxs, other),
    false,
    'different endpoints must remain incompatible without an explicit key'
  );
  assert.notStrictEqual(
    keyedGatewayA.bindingFingerprint,
    keyedGatewayB.bindingFingerprint,
    'explicit compatibility keys must not weaken durable binding identity'
  );
  assert.strictEqual(
    resumeBindingsCompatible(keyedGatewayA, keyedGatewayB),
    true,
    'an explicit compatibility key may authorize a cross-endpoint native resume'
  );
  const providerOnlyA = makeProfileBinding({
    profileId: 'provider-only-a',
    provider: 'MineMine',
    providerKind: 'custom',
  });
  const providerOnlyB = makeProfileBinding({
    profileId: 'provider-only-b',
    provider: 'MineMine',
    providerKind: 'custom',
  });
  assert(providerOnlyA.bindingFingerprint, 'provider-only profiles retain strict identity');
  assert.strictEqual(
    providerOnlyA.nativeResumeCompatibilityFingerprint,
    null,
    'a custom provider label without an endpoint cannot attest native history compatibility'
  );
  assert.strictEqual(
    resumeBindingsCompatible(providerOnlyA, providerOnlyB),
    false,
    'two provider-only custom profiles must not collapse into one native compatibility group'
  );
  const providerOnlyLegacyHost = publicBinding({
    kind: 'host_environment',
    provider: 'MineMine',
    modelProviderHint: null,
    bindingFingerprint: 'c'.repeat(64),
    nativeResumeCompatibilityFingerprint: 'd'.repeat(64),
  });
  assert.strictEqual(
    providerOnlyLegacyHost.bindingFingerprint,
    null,
    'a provider-only Host must not reuse a persisted identity digest as current evidence'
  );
  assert.strictEqual(
    providerOnlyLegacyHost.nativeResumeCompatibilityFingerprint,
    null,
    'a provider-only Host must not reuse persisted native compatibility evidence'
  );
  const hintOnlyHost = makeHostEnvironmentBinding({ modelProviderHint: 'remote_codex_hint' });
  assert.strictEqual(
    hintOnlyHost.bindingFingerprint,
    null,
    'a model provider hint alone cannot attest Host API identity'
  );
  assert.strictEqual(hintOnlyHost.nativeResumeCompatibilityFingerprint, null);
  const hintOnlyLegacyHost = publicBinding({
    kind: 'host_environment',
    modelProviderHint: 'remote_codex_hint',
    bindingFingerprint: 'e'.repeat(64),
    nativeResumeCompatibilityFingerprint: 'f'.repeat(64),
  });
  assert.strictEqual(
    hintOnlyLegacyHost.bindingFingerprint,
    null,
    'a hint-only Host must not reuse a persisted identity digest'
  );
  assert.strictEqual(
    hintOnlyLegacyHost.nativeResumeCompatibilityFingerprint,
    null,
    'a hint-only Host must not reuse persisted native compatibility evidence'
  );
  const defaultOpenAiHost = makeHostEnvironmentBinding({
    provider: 'OpenAI',
    modelProviderHint: 'openai',
  });
  const explicitOpenAiHost = makeHostEnvironmentBinding({
    provider: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
  });
  assert.strictEqual(
    defaultOpenAiHost.normalizedBaseUrl,
    'https://api.openai.com/v1',
    'a Host using the official OpenAI default must receive the canonical endpoint'
  );
  assert.strictEqual(
    resumeBindingsCompatible(defaultOpenAiHost, explicitOpenAiHost),
    true,
    'default and explicit official OpenAI Host bindings must share native compatibility'
  );
  const persistedOnlyBinding = publicBinding({
    kind: 'profile',
    profileId: null,
    provider: null,
    normalizedBaseUrl: null,
    bindingFingerprint: 'a'.repeat(64),
    nativeResumeCompatibilityFingerprint: 'b'.repeat(64),
  });
  assert.strictEqual(
    persistedOnlyBinding.bindingFingerprint,
    'a'.repeat(64),
    'fingerprint-only legacy records retain their strict persisted evidence'
  );
  assert.strictEqual(
    persistedOnlyBinding.nativeResumeCompatibilityFingerprint,
    'b'.repeat(64),
    'fingerprint-only legacy records retain persisted native compatibility evidence'
  );
  assert.strictEqual(JSON.stringify(asxs).includes('secret-one'), false);
  assert.strictEqual(
    normalizeBaseUrl(
      'https://Tenant.OpenAI.Azure.com/openai/deployments/gpt-5/chat/completions/'
      + '?tenant=contoso&api-version=2026-07-01-preview#local-fragment'
    ),
    'https://tenant.openai.azure.com/openai/deployments/gpt-5/chat/completions'
      + '?api-version=2026-07-01-preview&tenant=contoso',
    'Azure endpoint identity must retain and canonically sort non-secret query parameters'
  );
  assert.strictEqual(
    normalizeBaseUrl('https://api.example.invalid/v1?tenant=tenant-a&organization=org-a'),
    normalizeBaseUrl('https://api.example.invalid/v1?organization=org-a&tenant=tenant-a#ignored'),
    'query order and fragments must not create false API identities'
  );
  assert.notStrictEqual(
    normalizeBaseUrl('https://api.example.invalid/v1?tenant=tenant-a'),
    normalizeBaseUrl('https://api.example.invalid/v1?tenant=tenant-b'),
    'tenant-scoped endpoints must remain distinct'
  );
  assert.throws(
    () => normalizeBaseUrl('https://api.example.invalid/v1?api_key=must-not-persist'),
    /must not contain credentials/,
    'secret query parameters must never become persisted binding identity'
  );
  assert.throws(
    () => normalizeBaseUrl('https://api.example.invalid/v1?credentials=opaque-value'),
    /must not contain credentials/,
    'generic credentials query parameters must never become persisted binding identity'
  );
  assert.throws(
    () => normalizeBaseUrl('https://api.example.invalid/v1?X-Amz-Signature=opaque-value'),
    /must not contain credentials/,
    'provider-prefixed signature query parameters must never become persisted binding identity'
  );

  await store.transact('test.seed.legacy-openai-key-only', (tx) => {
    const key = tx.resolveCanonicalKey({ hostId: 'host-legacy-openai', sessionId: 'legacy-openai-session' });
    const record = tx.ensureRecord(key, {
      hostId: 'host-legacy-openai',
      conversationKey: 'legacy-openai-session',
      source: 'managed',
    });
    record.runs['legacy-openai-run'] = {
      status: 'stopped',
      launchMode: 'fresh',
      parentRunId: null,
      nativeResumeReady: true,
      apiBinding: structuredClone(legacyOpenAiKeyOnlyBinding),
      requestedSelection: null,
      effectiveSelection: null,
      createdAt: now(),
      endedAt: now(),
    };
    record.latestSuccessfulRunId = 'legacy-openai-run';
    record.activeRunId = null;
    record.updatedAt = now();
    tx.markDirty(key);
  });
  const legacyOpenAiResume = await service.planRun({
    identity: { hostId: 'host-legacy-openai', sessionId: 'legacy-openai-session' },
    runId: 'legacy-openai-resume',
    launchMode: 'resume',
    submittedBinding: canonicalOpenAiKeyOnlyBinding,
    requireExpectedRun: true,
    expectedRunId: 'legacy-openai-run',
    expectedRunStatus: 'stopped',
    expectedRunStatusProvided: true,
    expectedBindingFingerprint: canonicalOpenAiKeyOnlyBinding.bindingFingerprint,
    expectedBindingProvided: true,
  });
  assert.strictEqual(
    legacyOpenAiResume.run.apiBinding.bindingFingerprint,
    canonicalOpenAiKeyOnlyBinding.bindingFingerprint,
    'a normal Resume must accept the canonicalized legacy OpenAI key-only binding'
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
  await store.transact('test.seed.legacy-custom-null-base', (tx) => {
    const key = tx.resolveCanonicalKey({ hostId: 'host-legacy-custom', sessionId: 'legacy-custom-session' });
    const record = tx.ensureRecord(key, {
      hostId: 'host-legacy-custom',
      conversationKey: 'legacy-custom-session',
      source: 'managed',
    });
    record.runs['legacy-custom-run'] = {
      status: 'stopped',
      launchMode: 'fresh',
      parentRunId: null,
      nativeResumeReady: true,
      apiBinding: structuredClone(legacyCustomNullBaseBinding),
      requestedSelection: null,
      effectiveSelection: null,
      createdAt: now(),
      endedAt: now(),
    };
    record.latestSuccessfulRunId = 'legacy-custom-run';
    record.activeRunId = null;
    record.updatedAt = now();
    tx.markDirty(key);
  });
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-legacy-custom', sessionId: 'legacy-custom-session' },
      runId: 'legacy-custom-resume',
      launchMode: 'resume',
      submittedBinding: makeProfileBinding({
        profileId: 'legacy-custom-null-base',
        provider: 'OpenAI',
        providerKind: 'custom',
        baseUrl: 'https://custom.example/v1',
      }),
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_api_binding_mismatch',
    'a Custom null-base legacy run must still require an explicit Rebind'
  );

  const first = await service.planRun({
    identity: { hostId: 'host-a', sessionId: 'bridge-a' },
    runId: 'run-1',
    launchMode: 'fresh',
    submittedBinding: asxs,
    requestedSelection: { model: 'gpt-5.6-sol', effort: 'ultra', source: 'user' },
  });
  assert.strictEqual(first.run.apiBinding.bindingFingerprint, asxs.bindingFingerprint);
  await service.confirmRun({
    identity: { hostId: 'host-a', sessionId: 'bridge-a' },
    runId: 'run-1',
    bridgeSessionId: 'bridge-a',
    nativeThreadId: 'native-a',
    effectiveBinding: renamedAsxs,
    effectiveSelection: { model: 'gpt-5.6-sol', effort: 'ultra' },
  });

  await service.planRun({
    identity: { hostId: 'host-a', sessionId: 'cas-session' },
    runId: 'cas-run-a',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: 'host-a', sessionId: 'cas-session' },
    runId: 'cas-run-a',
    effectiveBinding: asxs,
  });
  let stopGuardCalls = 0;
  const guardedStop = await service.stopRun({
    identity: { hostId: 'host-a', sessionId: 'cas-session' },
    runId: 'cas-run-a',
    commitGuard: ({ runId, run }) => {
      stopGuardCalls += 1;
      assert.strictEqual(runId, 'cas-run-a');
      assert.strictEqual(run.status, 'live');
      return false;
    },
  });
  assert.strictEqual(stopGuardCalls, 1, 'the stop commit guard must run inside the transaction');
  assert.strictEqual(guardedStop.guardRejected, true);
  assert.strictEqual(guardedStop.transitioned, false);
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'cas-session' }).activeRunId,
    'cas-run-a',
    'a rejected stop guard must preserve the durable live run'
  );
  const stopIntent = await service.requestStopRun({
    identity: { hostId: 'host-a', sessionId: 'cas-session' },
    requireExpectedRun: true,
    expectedRunId: 'cas-run-a',
    expectedBindingFingerprint: asxs.bindingFingerprint,
    expectedBindingProvided: true,
    expectedRunStatus: 'live',
    expectedRunStatusProvided: true,
    stopRequestId: 'stop-request-a',
  });
  assert.strictEqual(stopIntent.runId, 'cas-run-a');
  assert.strictEqual(stopIntent.record.runs['cas-run-a'].status, 'live');
  assert.strictEqual(stopIntent.record.runs['cas-run-a'].stopRequestId, 'stop-request-a');
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-a', sessionId: 'cas-session' },
      runId: 'cas-rebind-while-stopping',
      launchMode: 'resume',
      submittedBinding: other,
      explicitRebind: true,
      requireExpectedRun: true,
      expectedRunId: 'cas-run-a',
      expectedBindingFingerprint: asxs.bindingFingerprint,
      expectedBindingProvided: true,
      expectedRunStatus: 'live',
      expectedRunStatusProvided: true,
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_run_stopping',
    'a durable Stop intent must block a Rebind before its Host command is delivered'
  );
  const cancelledStop = await service.cancelStopRun({
    identity: { hostId: 'host-a', sessionId: 'cas-session' },
    runId: 'cas-run-a',
    stopRequestId: 'stop-request-a',
  });
  assert.strictEqual(cancelledStop.transitioned, true);
  assert.strictEqual(cancelledStop.record.runs['cas-run-a'].stopRequestId, undefined);
  await service.stopRun({
    identity: { hostId: 'host-a', sessionId: 'cas-session' },
    runId: 'cas-run-a',
  });
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-a', sessionId: 'cas-session' },
      runId: 'cas-stale-rebind',
      launchMode: 'resume',
      submittedBinding: other,
      explicitRebind: true,
      requireExpectedRun: true,
      expectedRunId: 'cas-run-a',
      expectedBindingFingerprint: asxs.bindingFingerprint,
      expectedBindingProvided: true,
      expectedRunStatus: 'live',
      expectedRunStatusProvided: true,
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_run_changed',
    'a Rebind observed before Stop must not revive the same run after its lifecycle state changes'
  );

  const resume = await service.planRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-2',
    launchMode: 'resume',
  });
  await assert.rejects(
    service.requestStopRun({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      requireExpectedRun: true,
      expectedRunId: 'run-not-the-parent',
      expectedBindingFingerprint: asxs.bindingFingerprint,
      expectedBindingProvided: true,
      expectedRunStatus: 'live',
      expectedRunStatusProvided: true,
      stopRequestId: 'stop-wrong-pending-parent',
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_run_changed',
    'a stale run must not redirect Stop to an unrelated pending child'
  );
  await assert.rejects(
    service.requestStopRun({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      requireExpectedRun: true,
      expectedRunId: 'run-1',
      expectedBindingFingerprint: other.bindingFingerprint,
      expectedBindingProvided: true,
      expectedRunStatus: 'live',
      expectedRunStatusProvided: true,
      stopRequestId: 'stop-wrong-parent-binding',
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_run_changed',
    'a parent binding mismatch must not redirect Stop to its pending child'
  );
  const redirectedPendingStop = await service.requestStopRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    requireExpectedRun: true,
    expectedRunId: 'run-1',
    expectedBindingFingerprint: asxs.bindingFingerprint,
    expectedBindingProvided: true,
    expectedRunStatus: 'live',
    expectedRunStatusProvided: true,
    stopRequestId: 'stop-redirected-pending-child',
  });
  assert.strictEqual(redirectedPendingStop.runId, 'run-2');
  assert.strictEqual(redirectedPendingStop.redirectedFromRunId, 'run-1');
  assert.strictEqual(
    redirectedPendingStop.record.runs['run-2'].stopRequestId,
    'stop-redirected-pending-child'
  );
  await service.cancelStopRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-2',
    stopRequestId: 'stop-redirected-pending-child',
  });
  await assert.rejects(
    service.requestStopRun({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      runId: 'run-1',
      stopRequestId: 'bulk-stop-during-pending-run',
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_run_state_conflict',
    'a bulk Stop must not target the live parent while its replacement run is pending'
  );
  assert.strictEqual(resume.run.apiBinding.bindingFingerprint, asxs.bindingFingerprint);
  assert.strictEqual(resume.record.runs['run-1'].status, 'live', 'planning alone must not stop the prior live run');
  const pendingStop = await service.requestStopRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    requireExpectedRun: true,
    expectedRunId: 'run-2',
    expectedBindingFingerprint: asxs.bindingFingerprint,
    expectedBindingProvided: true,
    expectedRunStatus: 'pending',
    expectedRunStatusProvided: true,
    stopRequestId: 'stop-pending-replacement',
  });
  assert.strictEqual(pendingStop.record.runs['run-2'].status, 'pending');
  assert.strictEqual(pendingStop.record.runs['run-2'].stopRequestId, 'stop-pending-replacement');
  await service.cancelStopRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-2',
    stopRequestId: 'stop-pending-replacement',
  });
  await service.confirmRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-2',
    nativeThreadId: 'native-a',
    effectiveBinding: asxs,
    effectiveSelection: { model: 'gpt-5.6-sol', effort: 'ultra' },
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' }).runs['run-1'].status,
    'stopped',
    'confirming a replacement run must close its prior live run'
  );

  const fork = await service.planRun({
    identity: { hostId: 'host-a', sessionId: 'fork-a' },
    sourceIdentity: { hostId: 'host-a', sessionId: 'native-a' },
    conversationKey: 'bridge-a',
    runId: 'run-fork',
    launchMode: 'fork',
  });
  assert.strictEqual(fork.run.apiBinding.bindingFingerprint, asxs.bindingFingerprint);
  assert.strictEqual(fork.record.originSessionId, 'native-a');
  assert.strictEqual(fork.record.conversationKey, 'bridge-a', 'fork must preserve conversation grouping without aliasing into the source record');
  await service.confirmRun({
    identity: { hostId: 'host-a', sessionId: 'fork-a', conversationKey: 'bridge-a' },
    runId: 'run-fork',
    bridgeSessionId: 'fork-a',
    nativeThreadId: 'native-fork-a',
    effectiveBinding: asxs,
    effectiveSelection: { model: 'gpt-5.6-sol', effort: 'ultra' },
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'bridge-a' }).latestSuccessfulRunId,
    'run-2',
    'fork confirmation must not steal the source conversation alias'
  );
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' }).latestSuccessfulRunId,
    'run-2',
    'fork lineage references must not become aliases that steal the source conversation identity'
  );

  const fallbackAliasHost = 'host-fallback-lock-alias';
  await service.planRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-source-a' },
    runId: 'fallback-source-run',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-source-a' },
    runId: 'fallback-source-run',
    nativeThreadId: 'fallback-source-a',
    effectiveBinding: asxs,
  });
  await service.planRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-winner-b' },
    runId: 'fallback-winner-b-run',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-winner-b' },
    runId: 'fallback-winner-b-run',
    nativeThreadId: 'fallback-winner-b',
    effectiveBinding: asxs,
  });
  await service.stopRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-winner-b' },
    runId: 'fallback-winner-b-run',
  });
  await service.planRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-target-fail' },
    sourceIdentity: { hostId: fallbackAliasHost, sessionId: 'fallback-source-a' },
    runId: 'fallback-child-fail',
    launchMode: 'transcript_fallback',
  });
  await service.mergeDiscovery({
    hostId: fallbackAliasHost,
    sessionId: 'fallback-winner-b',
    bridgeSessionId: 'fallback-source-a',
    source: 'managed',
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: fallbackAliasHost, sessionId: 'fallback-source-a' })
      .pendingTranscriptFallbackRunId,
    'fallback-child-fail'
  );
  await service.failRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-target-fail' },
    runId: 'fallback-child-fail',
    code: 'expected-fallback-failure',
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: fallbackAliasHost, sessionId: 'fallback-source-a' })
      .pendingTranscriptFallbackRunId,
    undefined,
    'failing a fallback must clear its source lock after the source canonical record is merged'
  );

  await service.planRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-target-confirm' },
    sourceIdentity: { hostId: fallbackAliasHost, sessionId: 'fallback-source-a' },
    runId: 'fallback-child-confirm',
    launchMode: 'transcript_fallback',
  });
  await service.planRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-winner-c' },
    runId: 'fallback-winner-c-run',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-winner-c' },
    runId: 'fallback-winner-c-run',
    nativeThreadId: 'fallback-winner-c',
    effectiveBinding: asxs,
  });
  await service.stopRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-winner-c' },
    runId: 'fallback-winner-c-run',
  });
  await service.mergeDiscovery({
    hostId: fallbackAliasHost,
    sessionId: 'fallback-winner-c',
    bridgeSessionId: 'fallback-source-a',
    source: 'managed',
  });
  await service.confirmRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-target-confirm' },
    runId: 'fallback-child-confirm',
    nativeThreadId: 'fallback-target-confirm-native',
    effectiveBinding: asxs,
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: fallbackAliasHost, sessionId: 'fallback-source-a' })
      .pendingTranscriptFallbackRunId,
    undefined,
    'confirming a fallback must clear its source lock through canonical alias chains'
  );
  const fallbackRetryAfterAliasMerge = await service.planRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-target-retry' },
    sourceIdentity: { hostId: fallbackAliasHost, sessionId: 'fallback-source-a' },
    runId: 'fallback-child-retry',
    launchMode: 'transcript_fallback',
  });
  assert.strictEqual(fallbackRetryAfterAliasMerge.run.status, 'pending');
  await service.failRun({
    identity: { hostId: fallbackAliasHost, sessionId: 'fallback-target-retry' },
    runId: 'fallback-child-retry',
    code: 'test-cleanup',
  });

  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      runId: 'run-mismatch',
      launchMode: 'resume',
      submittedBinding: other,
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_api_binding_mismatch'
      && error.statusCode === 409
      && error.canRebind === true
  );

  const rebound = await service.planRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-rebind',
    launchMode: 'resume',
    submittedBinding: asxs,
    explicitRebind: true,
  });
  assert.strictEqual(rebound.run.apiBinding.bindingFingerprint, asxs.bindingFingerprint);
  await service.stopRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-2',
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' }).runs['run-2'].status,
    'stopped',
    'explicitly stopping a live run must preserve it as historical provenance'
  );
  await service.failRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-rebind',
    code: 'session_spawn_failed',
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' }).latestSuccessfulRunId,
    'run-2',
    'failed rebind must not replace the last confirmed run'
  );

  const failedRebind = service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' })
    .runs['run-rebind'];
  await assert.rejects(
    service.confirmRun({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      runId: 'run-rebind',
      nativeThreadId: 'native-a',
      effectiveBinding: asxs,
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_state_conflict'
      && error.statusCode === 409
  );
  assert.deepStrictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' }).runs['run-rebind'],
    failedRebind,
    'a delayed start confirmation must not revive a failed run'
  );

  const redactedFailurePlan = await service.planRun({
    identity: { hostId: 'host-error-redaction', sessionId: 'error-redaction' },
    runId: 'run-error-redaction',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  const redactedFailure = await service.failRun({
    identity: { hostId: 'host-error-redaction', sessionId: 'error-redaction' },
    runId: redactedFailurePlan.record.activeRunId,
    code: 'provider_error',
    message: 'Authorization: Bearer runtime-error-secret-must-not-leak',
  });
  assert.strictEqual(JSON.stringify(redactedFailure).includes('runtime-error-secret-must-not-leak'), false);
  assert.strictEqual(
    JSON.stringify(service.getSessionRecord({ hostId: 'host-error-redaction', sessionId: 'error-redaction' }))
      .includes('runtime-error-secret-must-not-leak'),
    false
  );

  const ignoredLiveFailure = await service.failRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-1',
    code: 'delayed_start_failure',
  });
  assert.strictEqual(ignoredLiveFailure.transitioned, false);
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' }).runs['run-1'].status,
    'stopped',
    'a delayed failure must not rewrite a stopped run'
  );

  const ignoredFailedFailure = await service.failRun({
    identity: { hostId: 'host-a', sessionId: 'native-a' },
    runId: 'run-rebind',
    code: 'later_duplicate_failure',
  });
  assert.strictEqual(ignoredFailedFailure.transitioned, false);
  assert.deepStrictEqual(
    service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' }).runs['run-rebind'],
    failedRebind,
    'a duplicate failure must preserve the first terminal failure'
  );

  const readinessMergeHost = 'host-native-readiness-merge';
  for (const sessionId of ['readiness-strong', 'readiness-weak']) {
    await service.planRun({
      identity: { hostId: readinessMergeHost, sessionId },
      runId: 'shared-readiness-run',
      launchMode: 'fresh',
      submittedBinding: asxs,
    });
    await service.confirmRun({
      identity: { hostId: readinessMergeHost, sessionId },
      runId: 'shared-readiness-run',
      nativeThreadId: `${sessionId}-native`,
      effectiveBinding: asxs,
    });
  }
  await service.confirmNativeResumeReady({
    identity: { hostId: readinessMergeHost, sessionId: 'readiness-strong' },
    runId: 'shared-readiness-run',
  });
  for (const sessionId of ['readiness-strong', 'readiness-weak']) {
    await service.stopRun({
      identity: { hostId: readinessMergeHost, sessionId },
      runId: 'shared-readiness-run',
    });
  }
  await service.mergeDiscovery({
    hostId: readinessMergeHost,
    sessionId: 'readiness-weak',
    bridgeSessionId: 'readiness-strong',
    nativeThreadId: 'readiness-weak-native',
    source: 'managed',
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: readinessMergeHost, sessionId: 'readiness-weak' })
      .runs['shared-readiness-run'].nativeResumeReady,
    true,
    'canonical record merging must never regress native readiness from true to false'
  );

  const activeLive = await service.planRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-live-race',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: activeLive.record.activeRunId,
    nativeThreadId: 'live-race',
    effectiveBinding: asxs,
  });
  let liveRaceRecord = service.getSessionRecord({ hostId: 'host-live-race', sessionId: 'live-race' });
  assert.strictEqual(
    liveRaceRecord.runs['run-live-race'].nativeResumeReady,
    false,
    'a fresh run must remain explicitly non-resumable until its first native turn starts'
  );
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-live-race', sessionId: 'live-race' },
      runId: 'run-implicit-fresh-rebind',
      launchMode: 'fresh_rebind',
      submittedBinding: other,
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_run_state_conflict',
    'fresh_rebind must not be available outside an explicit same-Session Rebind'
  );
  const freshRebind = await service.planRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    sourceIdentity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-explicit-fresh-rebind',
    launchMode: 'fresh_rebind',
    submittedBinding: other,
    explicitRebind: true,
  });
  assert.strictEqual(freshRebind.canonicalKey, activeLive.canonicalKey);
  assert.strictEqual(freshRebind.run.parentRunId, 'run-live-race');
  assert.strictEqual(freshRebind.run.nativeResumeReady, false);
  assert.strictEqual(freshRebind.run.apiBinding.bindingFingerprint, other.bindingFingerprint);
  const readiness = await service.confirmNativeResumeReady({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-live-race',
  });
  assert.strictEqual(readiness.transitioned, true);
  assert.strictEqual(readiness.promotedRunId, undefined);
  liveRaceRecord = service.getSessionRecord({ hostId: 'host-live-race', sessionId: 'live-race' });
  assert.strictEqual(liveRaceRecord.runs['run-explicit-fresh-rebind'].launchMode, 'fresh_rebind');
  assert.strictEqual(liveRaceRecord.runs['run-explicit-fresh-rebind'].nativeResumeReady, false);
  await service.failRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-explicit-fresh-rebind',
    code: 'simulated_fresh_rebind_failure',
  });
  const compatibleProfileRebind = await service.planRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    sourceIdentity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-compatible-profile-rebind',
    launchMode: 'fresh_rebind',
    submittedBinding: asxsRotatedProfile,
    explicitRebind: true,
  });
  assert.strictEqual(
    compatibleProfileRebind.run.launchMode,
    'resume',
    'same-endpoint profiles must be allowed to use native resume'
  );
  assert.strictEqual(compatibleProfileRebind.run.parentRunId, 'run-live-race');
  assert.strictEqual(
    compatibleProfileRebind.run.apiBinding.profileId,
    asxsRotatedProfile.profileId
  );
  await service.failRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-compatible-profile-rebind',
    code: 'simulated_compatible_rebind_cleanup',
  });

  const keyedGatewayHost = 'host-keyed-gateway-rebind';
  await service.planRun({
    identity: { hostId: keyedGatewayHost, sessionId: 'keyed-gateway' },
    runId: 'keyed-parent',
    launchMode: 'fresh',
    submittedBinding: keyedGatewayA,
  });
  await service.confirmRun({
    identity: { hostId: keyedGatewayHost, sessionId: 'keyed-gateway' },
    runId: 'keyed-parent',
    nativeThreadId: 'keyed-gateway-native',
    effectiveBinding: keyedGatewayA,
  });
  await service.confirmNativeResumeReady({
    identity: { hostId: keyedGatewayHost, sessionId: 'keyed-gateway' },
    runId: 'keyed-parent',
  });
  const keyedGatewayRebind = await service.planRun({
    identity: { hostId: keyedGatewayHost, sessionId: 'keyed-gateway' },
    sourceIdentity: { hostId: keyedGatewayHost, sessionId: 'keyed-gateway' },
    runId: 'keyed-child',
    launchMode: 'fresh_rebind',
    submittedBinding: keyedGatewayB,
    explicitRebind: true,
  });
  assert.strictEqual(
    keyedGatewayRebind.run.launchMode,
    'resume',
    'an explicit compatibility key must authorize native resume across endpoints'
  );
  assert.strictEqual(keyedGatewayRebind.run.parentRunId, 'keyed-parent');
  assert.strictEqual(keyedGatewayRebind.run.apiBinding.profileId, keyedGatewayB.profileId);
  await service.failRun({
    identity: { hostId: keyedGatewayHost, sessionId: 'keyed-gateway' },
    runId: 'keyed-child',
    code: 'simulated_keyed_rebind_cleanup',
  });
  const duplicateReadiness = await service.confirmNativeResumeReady({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-live-race',
  });
  assert.strictEqual(duplicateReadiness.transitioned, false, 'native readiness confirmation must be idempotent');
  liveRaceRecord = service.getSessionRecord({ hostId: 'host-live-race', sessionId: 'live-race' });
  assert.strictEqual(liveRaceRecord.runs['run-live-race'].nativeResumeReady, true);
  const crossBindingNativeResume = await service.planRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    sourceIdentity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-cross-binding-native-resume',
    launchMode: 'fresh_rebind',
    submittedBinding: other,
    explicitRebind: true,
  });
  assert.strictEqual(crossBindingNativeResume.run.launchMode, 'resume');
  assert.strictEqual(crossBindingNativeResume.run.parentRunId, 'run-live-race');
  await service.failRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-cross-binding-native-resume',
    code: 'session_native_resume_failed',
  });
  liveRaceRecord = service.getSessionRecord({ hostId: 'host-live-race', sessionId: 'live-race' });
  assert.strictEqual(
    liveRaceRecord.activeRunId,
    'run-live-race',
    'a rejected cross-binding Rebind must leave the original native run active'
  );
  const forceFreshBefore = service.getSessionRecord({
    hostId: 'host-live-race',
    sessionId: 'live-race',
  });
  const forcedCrossBindingResume = await service.planRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    sourceIdentity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-cross-binding-force-fresh',
    launchMode: 'fresh_rebind',
    submittedBinding: other,
    explicitRebind: true,
    forceFreshRebind: true,
  });
  assert.strictEqual(forcedCrossBindingResume.run.launchMode, 'resume');
  await service.failRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-cross-binding-force-fresh',
    code: 'session_native_resume_failed',
  });
  const forceFreshAfter = service.getSessionRecord({
    hostId: 'host-live-race',
    sessionId: 'live-race',
  });
  assert.strictEqual(forceFreshAfter.activeRunId, forceFreshBefore.activeRunId);
  assert.strictEqual(forceFreshAfter.runs['run-cross-binding-force-fresh'].status, 'failed');
  const materializedResume = await service.planRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    sourceIdentity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-materialized-resume',
    launchMode: 'fresh_rebind',
    submittedBinding: asxs,
    explicitRebind: true,
  });
  assert.strictEqual(materializedResume.run.parentRunId, 'run-live-race');
  assert.strictEqual(
    materializedResume.run.launchMode,
    'resume',
    'same-binding Rebind may still upgrade to native resume when the parent is ready'
  );
  assert.strictEqual(materializedResume.run.nativeResumeReady, true);
  await service.failRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-materialized-resume',
    code: 'simulated_resume_failure',
  });

  const forcedTranscript = await service.planRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    sourceIdentity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-forced-cross-binding-transcript',
    launchMode: 'fresh_rebind',
    submittedBinding: other,
    explicitRebind: true,
    forceTranscriptFallback: true,
  });
  assert.strictEqual(forcedTranscript.run.launchMode, 'fresh_rebind');
  assert.strictEqual(forcedTranscript.run.transcriptFallback, true);
  assert.strictEqual(forcedTranscript.run.nativeResumeReady, false);
  await service.failRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-forced-cross-binding-transcript',
    code: 'simulated_transcript_rebind_failure',
  });

  const adaptiveHostId = 'host-adaptive-rebind-confirm';
  await service.planRun({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    runId: 'adaptive-parent',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    runId: 'adaptive-parent',
    nativeThreadId: 'adaptive-native',
    effectiveBinding: asxs,
  });
  const adaptiveFresh = await service.planRun({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    sourceIdentity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    runId: 'adaptive-child',
    launchMode: 'fresh_rebind',
    submittedBinding: asxs,
    explicitRebind: true,
  });
  assert.strictEqual(adaptiveFresh.run.launchMode, 'fresh_rebind');
  const adaptiveResumed = await service.confirmRun({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    runId: 'adaptive-child',
    nativeThreadId: 'adaptive-native',
    effectiveBinding: asxs,
    launchMode: 'resume',
    nativeResumeReady: true,
  });
  assert.strictEqual(adaptiveResumed.record.runs['adaptive-child'].launchMode, 'resume');
  assert.strictEqual(adaptiveResumed.record.runs['adaptive-child'].nativeResumeReady, true);
  assert.strictEqual(adaptiveResumed.record.runs['adaptive-parent'].status, 'stopped');
  const adaptiveRetirement = Object.values(adaptiveResumed.record.runnerRetirements || {})[0];
  assert(adaptiveRetirement, 'confirming a native replacement must persist parent runner cleanup');
  assert.strictEqual(adaptiveRetirement.runId, 'adaptive-parent');
  assert.strictEqual(adaptiveRetirement.replacementRunId, 'adaptive-child');
  assert.strictEqual(adaptiveRetirement.status, 'pending');
  const attemptedRetirement = await service.markRunnerRetirementAttempt({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    retirementId: adaptiveRetirement.retirementId,
    runId: 'adaptive-parent',
    commandId: 42,
    ackTimeoutMs: 1000,
  });
  assert.strictEqual(attemptedRetirement.retirement.attemptCount, 1);
  await assert.rejects(
    service.markRunnerRetirementFailed({
      identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
      retirementId: adaptiveRetirement.retirementId,
      runId: 'unrelated-run',
      code: 'test_stop_failure',
    }),
    (error) => error?.code === 'session_runner_retirement_run_mismatch',
    'a delayed cleanup receipt must not retire a different run'
  );
  const failedRetirement = await service.markRunnerRetirementFailed({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    retirementId: adaptiveRetirement.retirementId,
    runId: 'adaptive-parent',
    code: 'test_stop_failure',
    message: 'simulated cleanup failure',
  });
  assert.strictEqual(failedRetirement.retirement.status, 'pending');
  assert(failedRetirement.retirement.nextAttemptAt);
  const retryRetirement = await service.markRunnerRetirementAttempt({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    retirementId: adaptiveRetirement.retirementId,
    runId: 'adaptive-parent',
    commandId: 43,
    ackTimeoutMs: 1000,
  });
  assert.strictEqual(retryRetirement.retirement.attemptCount, 2);
  const staleFailureReceipt = await service.markRunnerRetirementFailed({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    retirementId: adaptiveRetirement.retirementId,
    runId: 'adaptive-parent',
    commandId: 42,
    code: 'delayed_old_failure',
  });
  assert.strictEqual(staleFailureReceipt.transitioned, false);
  assert.strictEqual(staleFailureReceipt.stale, true);
  assert.strictEqual(staleFailureReceipt.retirement.commandId, 43);
  assert.strictEqual(staleFailureReceipt.retirement.lastError, null);
  const completedRetirement = await service.markRunnerRetirementSucceeded({
    identity: { hostId: adaptiveHostId, sessionId: 'adaptive-rebind' },
    retirementId: adaptiveRetirement.retirementId,
    runId: 'adaptive-parent',
    commandId: 43,
  });
  assert.strictEqual(completedRetirement.retirement.status, 'succeeded');
  assert.strictEqual(
    service.listRunnerRetirements({ hostId: adaptiveHostId }).length,
    0,
    'successful cleanup receipts must remove the retirement from pending work'
  );
  const originalReadSnapshot = store.readSnapshot;
  store.readSnapshot = () => {
    throw new Error('runner retirement reconciliation must not clone the entire Store');
  };
  try {
    assert.deepStrictEqual(service.listRunnerRetirements({ hostId: adaptiveHostId }), []);
  } finally {
    store.readSnapshot = originalReadSnapshot;
  }

  const mergeTerminalHost = 'host-retirement-terminal-merge';
  await service.mergeDiscovery({
    hostId: mergeTerminalHost,
    sessionId: 'merge-success',
    nativeThreadId: 'merge-success',
    source: 'managed',
  });
  await service.mergeDiscovery({
    hostId: mergeTerminalHost,
    sessionId: 'merge-pending',
    nativeThreadId: 'merge-pending',
    source: 'rollout',
  });
  await store.transact('test.runner_retirement_merge_seed', (tx) => {
    const succeeded = tx.getRecord(`${mergeTerminalHost}::merge-success`);
    const pending = tx.getRecord(`${mergeTerminalHost}::merge-pending`);
    succeeded.runnerRetirements = {
      'merge-retirement': {
        retirementId: 'merge-retirement',
        runId: 'merge-parent',
        status: 'succeeded',
        attemptCount: 2,
        completedAt: '2026-07-16T00:00:05.000Z',
        lastError: null,
      },
    };
    pending.runnerRetirements = {
      'merge-retirement': {
        retirementId: 'merge-retirement',
        runId: 'merge-parent',
        status: 'pending',
        attemptCount: 1,
        lastAttemptAt: '2026-07-16T00:00:04.000Z',
        lastError: { code: 'stale_failure', message: 'old failure' },
      },
    };
    tx.markDirty(`${mergeTerminalHost}::merge-success`);
    tx.markDirty(`${mergeTerminalHost}::merge-pending`);
  });
  const mergedRetirementRecord = await service.mergeDiscovery({
    hostId: mergeTerminalHost,
    sessionId: 'merge-success',
    bridgeSessionId: 'merge-pending',
    source: 'managed',
  });
  assert.strictEqual(
    mergedRetirementRecord.record.runnerRetirements['merge-retirement'].status,
    'succeeded'
  );
  assert.strictEqual(
    mergedRetirementRecord.record.runnerRetirements['merge-retirement'].lastError,
    null,
    'a succeeded retirement must not retain a stale merged failure'
  );

  const malformedAttemptHost = 'host-retirement-malformed-attempt';
  await service.mergeDiscovery({
    hostId: malformedAttemptHost,
    sessionId: 'malformed-attempt',
    source: 'managed',
  });
  await store.transact('test.runner_retirement_malformed_attempt_seed', (tx) => {
    const record = tx.getRecord(`${malformedAttemptHost}::malformed-attempt`);
    record.runnerRetirements = {
      'malformed-retirement': {
        retirementId: 'malformed-retirement',
        runId: 'malformed-parent',
        status: 'pending',
        attemptCount: 'not-a-number',
        nextAttemptAt: '2026-07-16T00:30:00.000Z',
      },
    };
    tx.markDirty(`${malformedAttemptHost}::malformed-attempt`);
  });
  const blockedMalformedAttempt = await service.markRunnerRetirementAttempt({
    identity: { hostId: malformedAttemptHost, sessionId: 'malformed-attempt' },
    retirementId: 'malformed-retirement',
    runId: 'malformed-parent',
    commandId: 55,
  });
  assert.strictEqual(blockedMalformedAttempt.retirement.status, 'blocked');
  assert.strictEqual(blockedMalformedAttempt.retirement.attemptCount, 7);
  assert.strictEqual(
    blockedMalformedAttempt.retirement.nextAttemptAt,
    null,
    'a malformed attempt counter must block without advertising a retry deadline'
  );

  const legacyHostId = 'host-legacy-adaptive-rebind';
  await service.planRun({
    identity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    runId: 'legacy-parent',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    runId: 'legacy-parent',
    nativeThreadId: 'legacy-native',
    effectiveBinding: asxs,
  });
  await service.confirmNativeResumeReady({
    identity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    runId: 'legacy-parent',
  });
  const legacyBeforeRebind = service.getSessionRecord({
    hostId: legacyHostId,
    sessionId: 'legacy-adaptive',
  });
  const legacyNativeRebind = await service.planRun({
    identity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    sourceIdentity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    runId: 'legacy-child',
    launchMode: 'fresh_rebind',
    submittedBinding: other,
    explicitRebind: true,
  });
  assert.strictEqual(legacyNativeRebind.run.launchMode, 'resume');
  await service.failRun({
    identity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    runId: 'legacy-child',
    code: 'session_native_resume_failed',
  });
  const legacyAfterRejectedRebind = service.getSessionRecord({
    hostId: legacyHostId,
    sessionId: 'legacy-adaptive',
  });
  assert.strictEqual(legacyAfterRejectedRebind.activeRunId, legacyBeforeRebind.activeRunId);
  assert.strictEqual(legacyAfterRejectedRebind.runs['legacy-child'].status, 'failed');
  const legacyPlannedFallback = await service.planRun({
    identity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    sourceIdentity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    runId: 'legacy-fallback',
    launchMode: 'fresh_rebind',
    submittedBinding: other,
    explicitRebind: true,
    forceTranscriptFallback: true,
  });
  assert.strictEqual(legacyPlannedFallback.run.launchMode, 'fresh_rebind');
  assert.strictEqual(legacyPlannedFallback.run.transcriptFallback, true);
  const legacyFresh = await service.confirmRun({
    identity: { hostId: legacyHostId, sessionId: 'legacy-adaptive' },
    runId: 'legacy-fallback',
    nativeThreadId: 'legacy-new-native',
    effectiveBinding: other,
    launchMode: 'fresh_rebind',
    nativeResumeReady: false,
  });
  assert.strictEqual(legacyFresh.record.runs['legacy-fallback'].launchMode, 'fresh_rebind');
  assert.strictEqual(legacyFresh.record.runs['legacy-fallback'].nativeResumeReady, false);

  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-live-race', sessionId: 'live-race' },
      runId: 'run-live-target-fresh-collision',
      launchMode: 'fresh',
      submittedBinding: asxs,
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_state_conflict'
      && error.statusCode === 409,
    'Fresh must not replace an existing live target without a parent lifecycle'
  );
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-live-race', sessionId: 'live-race' },
      sourceIdentity: { hostId: 'host-a', sessionId: 'native-a' },
      runId: 'run-live-target-fork-collision',
      launchMode: 'fork',
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_state_conflict'
      && error.statusCode === 409,
    'a derived launch must not overwrite an unrelated live target record'
  );
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-live-race', sessionId: 'live-race' }).activeRunId,
    'run-live-race'
  );
  const ignoredActiveFailure = await service.failRun({
    identity: { hostId: 'host-live-race', sessionId: 'live-race' },
    runId: 'run-live-race',
    code: 'delayed_start_failure',
  });
  assert.strictEqual(ignoredActiveFailure.transitioned, false);
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-live-race', sessionId: 'live-race' }).runs['run-live-race'].status,
    'live',
    'a delayed start failure must not close an already confirmed live run'
  );

  await service.planRun({
    identity: { hostId: 'host-parent-restore', sessionId: 'parent-restore' },
    runId: 'run-parent-live',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: 'host-parent-restore', sessionId: 'parent-restore' },
    runId: 'run-parent-live',
    nativeThreadId: 'parent-restore',
    effectiveBinding: asxs,
  });
  await service.planRun({
    identity: { hostId: 'host-parent-restore', sessionId: 'parent-restore' },
    runId: 'run-child-pending',
    launchMode: 'resume',
  });
  await service.failRun({
    identity: { hostId: 'host-parent-restore', sessionId: 'parent-restore' },
    runId: 'run-child-pending',
    code: 'session_model_unavailable',
  });
  const restoredParent = service.getSessionRecord({
    hostId: 'host-parent-restore',
    sessionId: 'parent-restore',
  });
  assert.strictEqual(
    restoredParent.activeRunId,
    'run-parent-live',
    'a failed pending child must restore its still-live parent as the active run'
  );
  assert.strictEqual(restoredParent.runs['run-parent-live'].status, 'live');
  assert.strictEqual(restoredParent.runs['run-child-pending'].status, 'failed');
  await service.planRun({
    identity: { hostId: 'host-parent-restore', sessionId: 'parent-restore' },
    runId: 'run-child-stopped',
    launchMode: 'resume',
  });
  await service.stopRun({
    identity: { hostId: 'host-parent-restore', sessionId: 'parent-restore' },
    runId: 'run-child-stopped',
  });
  const parentAfterPendingChildStop = service.getSessionRecord({
    hostId: 'host-parent-restore',
    sessionId: 'parent-restore',
  });
  assert.strictEqual(
    parentAfterPendingChildStop.activeRunId,
    'run-parent-live',
    'stopping a pending child must restore its still-live parent for its queued Stop terminal event'
  );
  assert.strictEqual(parentAfterPendingChildStop.runs['run-child-stopped'].status, 'stopped');

  const firstPending = await service.planRun({
    identity: { hostId: 'host-superseded', sessionId: 'superseded' },
    runId: 'run-old-pending',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-superseded', sessionId: 'superseded' },
      runId: 'run-current-pending',
      launchMode: 'fresh',
      submittedBinding: asxs,
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_pending'
      && error.statusCode === 409,
    'a second launch for the same record must fail closed while its first run is pending'
  );
  const stillPending = service.getSessionRecord({ hostId: 'host-superseded', sessionId: 'superseded' });
  assert.strictEqual(stillPending.activeRunId, firstPending.record.activeRunId);
  assert.strictEqual(stillPending.runs['run-old-pending'].status, 'pending');
  assert.strictEqual(stillPending.runs['run-current-pending'], undefined, 'a rejected launch must not overwrite the active run');

  const idempotentFirst = await service.planRun({
    identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
    runId: 'stable-run',
    launchMode: 'fresh',
    clientRequestId: 'create-intent-1',
    requestFingerprint: 'same-payload-fingerprint',
    submittedBinding: asxs,
  });
  const idempotentReplay = await service.planRun({
    identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
    runId: 'stable-run',
    launchMode: 'fresh',
    clientRequestId: 'create-intent-1',
    requestFingerprint: 'same-payload-fingerprint',
    submittedBinding: asxs,
  });
  assert.strictEqual(idempotentReplay.idempotentReplay, true, 'an accepted client creation intent must be replayable');
  assert.deepStrictEqual(idempotentReplay.run, idempotentFirst.run, 'an idempotent replay must return the accepted run');
  assert.strictEqual(
    Object.keys(idempotentReplay.record.runs).length,
    1,
    'an idempotent replay must not create another pending run'
  );
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
      runId: 'different-run-under-same-intent',
      launchMode: 'fresh',
      clientRequestId: 'create-intent-1',
      requestFingerprint: 'same-payload-fingerprint',
      submittedBinding: asxs,
    }),
    (error) => error instanceof SessionContractError && error.code === 'session_request_conflict',
    'a client creation intent must remain bound to its first accepted run ID'
  );
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
      runId: 'stable-run',
      launchMode: 'fresh',
      clientRequestId: 'create-intent-1',
      requestFingerprint: 'changed-payload-fingerprint',
      submittedBinding: asxs,
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_request_conflict'
      && error.statusCode === 409,
    'reusing a creation intent with different settings must fail closed'
  );
  await service.confirmRun({
    identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
    runId: 'stable-run',
    nativeThreadId: 'stable-target',
    effectiveBinding: asxs,
  });
  const liveReplay = await service.planRun({
    identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
    runId: 'stable-run',
    launchMode: 'fresh',
    clientRequestId: 'create-intent-1',
    requestFingerprint: 'same-payload-fingerprint',
    submittedBinding: asxs,
  });
  assert.strictEqual(liveReplay.idempotentReplay, true);
  assert.strictEqual(liveReplay.run.status, 'live', 'a lost response retry must recover an already-live run');
  await service.stopRun({
    identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
    runId: 'stable-run',
  });
  const stoppedReplay = await service.planRun({
    identity: { hostId: 'host-idempotent', sessionId: 'stable-target' },
    runId: 'stable-run',
    launchMode: 'fresh',
    clientRequestId: 'create-intent-1',
    requestFingerprint: 'same-payload-fingerprint',
    submittedBinding: asxs,
  });
  assert.strictEqual(stoppedReplay.idempotentReplay, true);
  assert.strictEqual(stoppedReplay.run.status, 'stopped', 'a retry must not recreate an accepted stopped run');

  await service.planRun({
    identity: { hostId: 'host-idempotent-failed', sessionId: 'failed-target' },
    runId: 'failed-run',
    launchMode: 'fresh',
    clientRequestId: 'failed-create-intent',
    requestFingerprint: 'failed-payload-fingerprint',
    submittedBinding: asxs,
  });
  await service.failRun({
    identity: { hostId: 'host-idempotent-failed', sessionId: 'failed-target' },
    runId: 'failed-run',
    code: 'session_spawn_failed',
  });
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-idempotent-failed', sessionId: 'failed-target' },
      runId: 'failed-run',
      launchMode: 'fresh',
      clientRequestId: 'failed-create-intent',
      requestFingerprint: 'failed-payload-fingerprint',
      submittedBinding: asxs,
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_request_replay_unavailable'
      && error.statusCode === 409,
    'a failed Session creation request must not be replayed as an idempotent success'
  );

  await service.failRun({
    identity: { hostId: 'host-superseded', sessionId: 'superseded' },
    runId: 'run-old-pending',
    code: 'session_spawn_failed',
  });
  await service.planRun({
    identity: { hostId: 'host-superseded', sessionId: 'superseded' },
    runId: 'run-current-pending',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: 'host-superseded', sessionId: 'superseded' },
    runId: 'run-current-pending',
    nativeThreadId: 'superseded',
    effectiveBinding: asxs,
  });
  await service.stopRun({
    identity: { hostId: 'host-superseded', sessionId: 'superseded' },
    runId: 'run-current-pending',
  });
  const retryAfterStopped = await service.planRun({
    identity: { hostId: 'host-superseded', sessionId: 'superseded' },
    runId: 'run-after-stopped',
    launchMode: 'resume',
  });
  assert.strictEqual(retryAfterStopped.record.activeRunId, 'run-after-stopped');
  assert.strictEqual(retryAfterStopped.record.runs['run-old-pending'].status, 'failed');
  assert.strictEqual(retryAfterStopped.record.runs['run-current-pending'].status, 'stopped');

  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      runId: 'run-1',
      launchMode: 'resume',
      submittedBinding: other,
      explicitRebind: true,
    }),
    (error) => error.code === 'session_run_conflict'
  );

  const endedRunBeforeDelayedSelection = service.getSessionRecord({
    hostId: 'host-a',
    sessionId: 'native-a',
  }).runs['run-1'];
  await assert.rejects(
    service.recordRequestedSelection({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      runId: 'run-1',
      selection: { model: 'gpt-5.6-sol', effort: 'max', source: 'user' },
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_state_conflict'
      && error.statusCode === 409,
    'a delayed requested-selection event must not rewrite an ended run'
  );
  let record = service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' });
  assert.deepStrictEqual(record.runs['run-1'], endedRunBeforeDelayedSelection);
  assert.strictEqual(record.runs['run-1'].effectiveSelection.effort, 'ultra');
  await assert.rejects(
    service.confirmEffectiveSelection({
      identity: { hostId: 'host-a', sessionId: 'native-a' },
      runId: 'run-1',
      selection: { model: 'gpt-5.6-sol', effort: 'max' },
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_state_conflict'
      && error.statusCode === 409,
    'a delayed effective-selection event must not rewrite an ended run'
  );
  record = service.getSessionRecord({ hostId: 'host-a', sessionId: 'native-a' });
  assert.deepStrictEqual(record.runs['run-1'], endedRunBeforeDelayedSelection);

  await service.planRun({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-run',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await service.confirmRun({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-run',
    nativeThreadId: 'selection-session',
    effectiveBinding: asxs,
    effectiveSelection: { model: 'gpt-5.6-sol', effort: 'high' },
  });
  await service.recordRequestedSelection({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-run',
    selection: { model: 'gpt-5.6-sol', effort: 'max', source: 'user' },
  });
  await service.confirmEffectiveSelection({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-run',
    selection: { model: 'gpt-5.6-sol', effort: 'max' },
  });
  const selectedLive = service.getSessionRecord({
    hostId: 'host-selection',
    sessionId: 'selection-session',
  });
  assert.strictEqual(selectedLive.runs['selection-run'].requestedSelection.effort, 'max');
  assert.strictEqual(selectedLive.runs['selection-run'].effectiveSelection.effort, 'max');
  await service.planRun({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-pending-child',
    launchMode: 'resume',
  });
  await service.recordRequestedSelection({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-run',
    selection: { model: 'gpt-5.6-sol', effort: 'ultra', source: 'user' },
  });
  await service.confirmEffectiveSelection({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-run',
    selection: { model: 'gpt-5.6-sol', effort: 'ultra' },
  });
  const parentWhileChildPending = service.getSessionRecord({
    hostId: 'host-selection',
    sessionId: 'selection-session',
  });
  assert.strictEqual(parentWhileChildPending.activeRunId, 'selection-pending-child');
  assert.strictEqual(parentWhileChildPending.runs['selection-run'].status, 'live');
  assert.strictEqual(parentWhileChildPending.runs['selection-run'].effectiveSelection.effort, 'ultra');
  await service.failRun({
    identity: { hostId: 'host-selection', sessionId: 'selection-session' },
    runId: 'selection-pending-child',
    code: 'selection_child_cancelled',
  });

  await service.mergeDiscovery({
    hostId: 'host-a',
    sessionId: 'native-a',
    nativeThreadId: 'native-a',
    source: 'vscode',
    title: 'Weak rediscovery title',
    modelProviderHint: 'remote_codex_deadbeef',
  });
  record = service.getSessionRecord({ hostId: 'host-a', nativeThreadId: 'native-a' });
  assert.strictEqual(record.source, 'managed');
  assert.strictEqual(record.runs['run-1'].apiBinding.profileId, 'api-asxs');
  assert.strictEqual(record.runs['run-1'].apiBinding.apiKey, undefined);

  await service.mergeDiscovery({
    hostId: 'host-a',
    sessionId: 'legacy-a',
    source: 'vscode',
    title: 'Legacy session',
    modelProviderHint: 'remote_codex_hash',
  });
  const legacy = service.getSessionRecord({ hostId: 'host-a', sessionId: 'legacy-a' });
  assert.strictEqual(legacy.runs.legacy.apiBinding.kind, 'unknown');
  assert.strictEqual(legacy.runs.legacy.apiBinding.modelProviderHint, 'remote_codex_hash');
  await assert.rejects(
    service.planRun({
      identity: { hostId: 'host-a', sessionId: 'legacy-a' },
      runId: 'legacy-resume',
      launchMode: 'resume',
    }),
    (error) => error.code === 'session_api_binding_unavailable' && error.canRebind === true
  );

  const hostEnvironment = makeHostEnvironmentBinding({
    provider: 'OpenAI',
    baseUrl: 'https://host-environment.example/v1',
    modelProviderHint: 'host-provider',
  });
  assert(hostEnvironment.bindingFingerprint);
  assert.strictEqual(makeUnknownBinding('remote_codex_hash').bindingFingerprint, null);

  const verifiedBinding = makeProfileBinding({
    profileId: 'verified-profile',
    label: 'Verified profile',
    provider: 'OpenAI',
    baseUrl: 'https://verified.example/v1',
    apiKey: 'must-not-persist',
  });
  await assert.rejects(
    async () => service.importVerifiedLegacyRun({
      identity: { hostId: 'host-verified', sessionId: 'native-verified' },
      apiBinding: verifiedBinding,
      selection: { model: 'verified-model', effort: 'max' },
      evidenceSource: 'rollout_hint',
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_api_binding_unavailable'
  );
  await assert.rejects(
    async () => service.importVerifiedLegacyRun({
      identity: { hostId: 'host-verified', sessionId: 'native-with-secret' },
      apiBinding: { ...verifiedBinding, apiKey: 'must-not-be-accepted' },
      selection: { model: 'verified-model', effort: 'max' },
      evidenceSource: 'operator_verified',
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_api_binding_unavailable'
      && /does not accept API keys/.test(error.message)
  );
  await assert.rejects(
    async () => service.importVerifiedLegacyRun({
      identity: { hostId: 'host-live-race', sessionId: 'live-race' },
      apiBinding: verifiedBinding,
      selection: { model: 'verified-model', effort: 'max' },
      evidenceSource: 'operator_verified',
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_state_conflict',
    'verified legacy import must not replace an active managed run'
  );
  const verified = await service.importVerifiedLegacyRun({
    identity: { hostId: 'host-verified', sessionId: 'native-verified' },
    bridgeSessionId: 'bridge-verified',
    nativeThreadId: 'native-verified',
    conversationKey: 'conversation-verified',
    title: 'Verified legacy Session',
    cwd: '/verified/workspace',
    apiBinding: verifiedBinding,
    selection: { model: 'verified-model', effort: 'max', source: 'unverified-caller-value' },
    evidenceSource: 'operator_verified',
  });
  assert.strictEqual(verified.run.status, 'stopped');
  assert.strictEqual(verified.run.apiBinding.apiKey, undefined);
  assert.strictEqual(verified.run.effectiveSelection.model, 'verified-model');
  assert.strictEqual(verified.run.requestedSelection.source, 'operator_verified');
  assert.strictEqual(verified.record.latestSuccessfulRunId, verified.runId);
  assert.strictEqual(verified.record.activeRunId, null);
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-verified', sessionId: 'bridge-verified' }).nativeThreadId,
    'native-verified'
  );
  await assert.rejects(
    async () => service.importVerifiedLegacyRun({
      identity: { hostId: 'host-verified', sessionId: 'native-verified' },
      runId: 'second-verified-import',
      apiBinding: other,
      selection: { model: 'other-model', effort: 'low' },
      evidenceSource: 'operator_verified',
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_conflict',
    'verified legacy import must not replace existing verified provenance'
  );

  await service.mergeDiscovery({
    hostId: 'host-lineage-import',
    sessionId: 'existing-source',
    nativeThreadId: 'existing-source',
    source: 'rollout',
  });
  await assert.rejects(
    async () => service.importVerifiedLegacyRun({
      identity: { hostId: 'host-lineage-import', sessionId: 'alias-collision-target' },
      bridgeSessionId: 'existing-source',
      nativeThreadId: 'alias-collision-target',
      apiBinding: verifiedBinding,
      selection: { model: 'verified-model', effort: 'max' },
      evidenceSource: 'operator_verified',
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_run_conflict',
    'verified legacy import must not steal an existing bridge/native alias'
  );
  await service.importVerifiedLegacyRun({
    identity: { hostId: 'host-lineage-import', sessionId: 'repaired-child' },
    bridgeSessionId: 'repaired-bridge',
    nativeThreadId: 'repaired-child',
    originSessionId: 'existing-source',
    sourceSessionId: 'existing-source',
    apiBinding: verifiedBinding,
    selection: { model: 'verified-model', effort: 'max' },
    evidenceSource: 'operator_verified',
  });
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-lineage-import', sessionId: 'existing-source' }).nativeThreadId,
    'existing-source',
    'lineage references must not steal aliases from an existing source Session'
  );

  await service.mergeDiscovery({
    hostId: 'host-alias-owner',
    sessionId: 'owned-native',
    nativeThreadId: 'owned-native',
    source: 'rollout',
    title: 'Existing alias owner',
  });
  await service.planRun({
    identity: { hostId: 'host-alias-owner', sessionId: 'new-bridge' },
    runId: 'hijack-run',
    launchMode: 'fresh',
    submittedBinding: asxs,
  });
  await assert.rejects(
    service.confirmRun({
      identity: { hostId: 'host-alias-owner', sessionId: 'new-bridge' },
      runId: 'hijack-run',
      bridgeSessionId: 'new-bridge',
      nativeThreadId: 'owned-native',
      effectiveBinding: asxs,
    }),
    (error) => error instanceof SessionContractError
      && error.code === 'session_identity_conflict'
      && error.statusCode === 409,
    'run confirmation must fail closed instead of stealing another record alias'
  );
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-alias-owner', sessionId: 'owned-native' }).title,
    'Existing alias owner'
  );
  assert.strictEqual(
    service.getSessionRecord({ hostId: 'host-alias-owner', sessionId: 'new-bridge' })
      .runs['hijack-run'].status,
    'pending'
  );

  await service.importVerifiedLegacyRun({
    identity: { hostId: 'host-run-collision', sessionId: 'verified-record' },
    runId: 'legacy',
    nativeThreadId: 'verified-record',
    apiBinding: verifiedBinding,
    selection: { model: 'verified-model', effort: 'max' },
    evidenceSource: 'operator_verified',
  });
  await service.mergeDiscovery({
    hostId: 'host-run-collision',
    sessionId: 'unknown-record',
    nativeThreadId: 'unknown-record',
    source: 'managed',
    modelProviderHint: 'unverified-provider-hint',
  });
  const collisionMerge = await service.mergeDiscovery({
    hostId: 'host-run-collision',
    sessionId: 'unknown-record',
    bridgeSessionId: 'verified-record',
    source: 'managed',
  });
  assert.strictEqual(
    collisionMerge.record.runs.legacy.apiBinding.profileId,
    'verified-profile',
    'a stronger record with an unknown colliding legacy run must not erase verified binding evidence'
  );
  assert(collisionMerge.record.runs.legacy.apiBinding.bindingFingerprint);

  await service.mergeDiscovery({
    hostId: 'host-thinking-merge',
    sessionId: 'thinking-winner',
    nativeThreadId: 'thinking-winner',
    source: 'managed',
  });
  await service.mergeDiscovery({
    hostId: 'host-thinking-merge',
    sessionId: 'thinking-loser',
    nativeThreadId: 'thinking-loser',
    source: 'rollout',
  });
  await store.transact('test.thinking.provenance_merge_seed', (tx) => {
    const winnerKey = 'host-thinking-merge::thinking-winner';
    const loserKey = 'host-thinking-merge::thinking-loser';
    tx.getRecord(winnerKey).thinking = {
      schemaVersion: 1,
      nextOrdinal: 3,
      activities: [
        {
          runId: 'thinking-run',
          turnId: 'thinking-turn',
          itemId: 'winner-only',
          kind: 'reasoning',
          status: 'completed',
          activityRevision: 1,
          final: true,
          firstObservedOrdinal: 1,
          text: 'winner history',
        },
        {
          runId: 'thinking-run',
          turnId: 'thinking-turn',
          itemId: 'shared',
          kind: 'reasoning',
          status: 'completed',
          activityRevision: 1,
          final: true,
          firstObservedOrdinal: 2,
          text: 'winner old revision',
        },
      ],
    };
    tx.getRecord(loserKey).thinking = {
      schemaVersion: 1,
      nextOrdinal: 4,
      activities: [
        {
          runId: 'thinking-run',
          turnId: 'thinking-turn',
          itemId: 'loser-only',
          kind: 'reasoning',
          status: 'completed',
          activityRevision: 1,
          final: true,
          firstObservedOrdinal: 1,
          text: 'loser history',
        },
        {
          runId: 'thinking-run',
          turnId: 'thinking-turn',
          itemId: 'shared',
          kind: 'reasoning',
          status: 'completed',
          activityRevision: 2,
          final: true,
          firstObservedOrdinal: 3,
          text: 'loser newer revision',
        },
      ],
    };
    tx.markDirty(winnerKey);
    tx.markDirty(loserKey);
  });
  const thinkingMerge = await service.mergeDiscovery({
    hostId: 'host-thinking-merge',
    sessionId: 'thinking-winner',
    bridgeSessionId: 'thinking-loser',
    source: 'managed',
  });
  assert.deepStrictEqual(
    thinkingMerge.record.thinking.activities.map((activity) => activity.itemId),
    ['winner-only', 'shared', 'loser-only'],
    'provenance alias merge must preserve winner history and append loser-only Thinking entries'
  );
  const mergedSharedThinking = thinkingMerge.record.thinking.activities.find(
    (activity) => activity.itemId === 'shared'
  );
  assert.strictEqual(mergedSharedThinking.text, 'loser newer revision');
  assert.strictEqual(
    mergedSharedThinking.firstObservedOrdinal,
    2,
    'a newer loser revision must retain the winner history position'
  );
  const thinkingMergeSnapshot = store.readSnapshot();
  assert.strictEqual(
    thinkingMergeSnapshot.records['host-thinking-merge::thinking-loser'],
    undefined,
    'the merged loser record must remain deleted'
  );

  await store.close();
  console.log('session provenance tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
