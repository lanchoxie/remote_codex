const {
  bindingFingerprint,
  bindingsEqual,
  makeHostEnvironmentBinding,
  makeProfileBinding,
  makeUnknownBinding,
  publicBinding,
} = require('../../shared/api-binding');
const {
  containsSecretField,
  redactSecretText,
} = require('../../shared/secret-redaction');
const { mergeNotificationRecords } = require('./assistant-notification-ledger');

const SOURCE_STRENGTH = Object.freeze({
  managed: 100,
  manual: 90,
  metadata: 70,
  imported: 50,
  rollout: 40,
  vscode: 30,
});
const VERIFIED_LEGACY_EVIDENCE_SOURCES = new Set([
  'operator_verified',
  'persisted_managed_summary',
]);

class SessionContractError extends Error {
  constructor(code, message, details = {}) {
    super(redactSecretText(message));
    this.name = 'SessionContractError';
    this.code = code;
    this.statusCode = Number(details.statusCode || 409);
    Object.assign(this, details);
  }

  toJSON() {
    return {
      code: this.code,
      error: this.message,
      sessionBinding: this.sessionBinding || null,
      submittedBinding: this.submittedBinding || null,
      canRebind: Boolean(this.canRebind),
    };
  }
}

function identityValues(input = {}, options = {}) {
  const values = [
    input.conversationKey,
    input.sessionId,
    input.bridgeSessionId,
    input.nativeThreadId,
    input.rolloutSessionId,
    ...(Array.isArray(input.rolloutSessionIds) ? input.rolloutSessionIds : []),
  ];
  if (options.includeLineage) {
    values.push(input.originSessionId, input.sourceSessionId);
  }
  return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function normalizedIdentityList(values = []) {
  return [...new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function discoveredRolloutSessionIds(input = {}) {
  const explicit = [
    input.rolloutSessionId,
    ...(Array.isArray(input.rolloutSessionIds) ? input.rolloutSessionIds : []),
  ];
  const source = String(input.source || '').trim().toLowerCase();
  if (['rollout', 'vscode', 'subagent'].includes(source)) {
    explicit.push(input.nativeThreadId, input.sessionId);
  }
  return normalizedIdentityList(explicit);
}

function cloneSelection(selection, fallbackSource = 'inherit') {
  const effort = String(selection?.effort || '').trim() || null;
  return {
    model: String(selection?.model || '').trim() || null,
    effort,
    summary: String(selection?.summary || '').trim() || null,
    ...(effort && selection?.allowUnverifiedEffort === true ? { allowUnverifiedEffort: true } : {}),
    source: String(selection?.source || fallbackSource).trim() || fallbackSource,
  };
}

function sourceStrength(value) {
  return SOURCE_STRENGTH[String(value || '').toLowerCase()] || 0;
}

function isCurrentLiveRun(record, runId) {
  const run = record?.runs?.[runId];
  if (!run || run.status !== 'live' || run.stopRequestId) {
    return false;
  }
  if (record.activeRunId === runId) {
    return true;
  }
  const activeRun = record.runs?.[record.activeRunId];
  return activeRun?.status === 'pending' && activeRun.parentRunId === runId;
}

function assertRunMutationExpectation(record, input = {}) {
  if (input.requireExpectedRun !== true) {
    return null;
  }
  const expectedRunId = String(input.expectedRunId || '').trim();
  const expectedBindingProvided = input.expectedBindingProvided === true;
  const expectedRunStatus = String(input.expectedRunStatus || '').trim() || null;
  const expectedRunStatusProvided = input.expectedRunStatusProvided === true;
  if (!expectedRunId || !expectedBindingProvided || !expectedRunStatusProvided) {
    throw new SessionContractError(
      'session_run_precondition_required',
      'This Session operation requires the observed run identity and API binding.',
      { statusCode: 428 }
    );
  }

  const activeRunId = String(record?.activeRunId || '').trim() || null;
  const activeRun = activeRunId ? record?.runs?.[activeRunId] || null : null;
  const allowPendingExpectedRun = input.allowPendingExpectedRun === true;
  const expectedBindingFingerprint = String(input.expectedBindingFingerprint || '').trim() || null;
  if (
    activeRun?.status === 'pending'
    && input.redirectPendingChildFromExpectedParent === true
  ) {
    const parentRunId = String(activeRun.parentRunId || '').trim() || null;
    const parentRun = parentRunId ? record?.runs?.[parentRunId] || null : null;
    const parentRunStatus = parentRun?.stopRequestId
      ? 'stopping'
      : String(parentRun?.status || '').trim() || null;
    if (
      parentRunId
      && parentRunId === expectedRunId
      && bindingFingerprint(parentRun?.apiBinding) === expectedBindingFingerprint
      && parentRunStatus === expectedRunStatus
    ) {
      if (activeRun.stopRequestId) {
        throw new SessionContractError(
          'session_run_stopping',
          `Run ${activeRunId} already has a pending Stop request.`,
          {
            statusCode: 409,
            currentRunId: activeRunId,
            currentRunStatus: 'stopping',
            currentBindingFingerprint: bindingFingerprint(activeRun.apiBinding),
          }
        );
      }
      return {
        record,
        run: activeRun,
        runId: activeRunId,
        runStatus: activeRun.status,
        redirectedFromRunId: parentRunId,
      };
    }
  }
  if (activeRun?.status === 'pending' && !allowPendingExpectedRun) {
    throw new SessionContractError(
      'session_run_pending',
      `Run ${activeRunId} is still pending for this Session.`,
      { statusCode: 409, currentRunId: activeRunId }
    );
  }
  if (activeRun?.stopRequestId) {
    throw new SessionContractError(
      'session_run_stopping',
      `Run ${activeRunId} already has a pending Stop request.`,
      {
        statusCode: 409,
        currentRunId: activeRunId,
        currentRunStatus: 'stopping',
        currentBindingFingerprint: bindingFingerprint(activeRun.apiBinding),
      }
    );
  }
  const currentRunId = activeRun?.status === 'live' || (allowPendingExpectedRun && activeRun?.status === 'pending')
    ? activeRunId
    : String(record?.latestSuccessfulRunId || activeRunId || '').trim() || null;
  const currentRun = currentRunId ? record?.runs?.[currentRunId] || null : null;
  const currentBindingFingerprint = bindingFingerprint(currentRun?.apiBinding);
  const currentRunStatus = String(currentRun?.status || '').trim() || null;
  if (
    !currentRunId
    || currentRunId !== expectedRunId
    || currentBindingFingerprint !== expectedBindingFingerprint
    || currentRunStatus !== expectedRunStatus
  ) {
    throw new SessionContractError(
      'session_run_changed',
      'The Session run changed after it was loaded. Reload it before retrying this operation.',
      {
        statusCode: 409,
        currentRunId,
        currentRunStatus,
        currentBindingFingerprint,
        expectedRunId,
        expectedRunStatus,
        expectedBindingFingerprint,
      }
    );
  }
  return { record, run: currentRun, runId: currentRunId, runStatus: currentRunStatus };
}

function mergeRuns(strongerRuns = {}, weakerRuns = {}) {
  const merged = {
    ...weakerRuns,
    ...strongerRuns,
  };
  for (const runId of Object.keys(strongerRuns)) {
    const strongerRun = strongerRuns[runId];
    const weakerRun = weakerRuns[runId];
    if (!strongerRun || !weakerRun) {
      continue;
    }
    const strongerFingerprint = bindingFingerprint(strongerRun.apiBinding);
    const weakerFingerprint = bindingFingerprint(weakerRun.apiBinding);
    if (strongerFingerprint && weakerFingerprint && strongerFingerprint !== weakerFingerprint) {
      throw new SessionContractError(
        'session_run_conflict',
        `Run ${runId} has conflicting verified API provenance.`,
        { statusCode: 409 }
      );
    }
    if (!strongerFingerprint && weakerFingerprint) {
      merged[runId] = {
        ...weakerRun,
        ...strongerRun,
        apiBinding: weakerRun.apiBinding,
      };
    }
    if (
      typeof strongerRun.nativeResumeReady === 'boolean'
      || typeof weakerRun.nativeResumeReady === 'boolean'
    ) {
      merged[runId] = {
        ...merged[runId],
        nativeResumeReady: strongerRun.nativeResumeReady === true
          || weakerRun.nativeResumeReady === true,
      };
    }
    if (strongerRun.rebindFallbackAllowed === true || weakerRun.rebindFallbackAllowed === true) {
      merged[runId] = {
        ...merged[runId],
        rebindFallbackAllowed: true,
      };
    }
  }
  return merged;
}

function resolveStoredCanonicalKey(tx, canonicalKey) {
  const seen = new Set();
  let current = String(canonicalKey || '').trim();
  while (current && !seen.has(current)) {
    seen.add(current);
    const target = tx.aliasTarget(current);
    if (!target || target === current) {
      break;
    }
    current = target;
  }
  return current;
}

function clearTranscriptFallbackLock(tx, run, runId, now) {
  const sourceKey = resolveStoredCanonicalKey(tx, run?.sourceCanonicalKey);
  if (run?.launchMode !== 'transcript_fallback' || !sourceKey) {
    return;
  }
  const sourceRecord = tx.getRecord(sourceKey);
  if (sourceRecord?.pendingTranscriptFallbackRunId !== runId) {
    return;
  }
  delete sourceRecord.pendingTranscriptFallbackRunId;
  delete sourceRecord.pendingTranscriptFallbackTargetKey;
  sourceRecord.updatedAt = now;
  tx.markDirty(sourceKey);
}

function mergeRecords(winner, loser, context = {}) {
  const winnerIsStronger = sourceStrength(winner.source) >= sourceStrength(loser.source);
  const stronger = winnerIsStronger ? winner : loser;
  const weaker = winnerIsStronger ? loser : winner;
  const rolloutSessionIds = normalizedIdentityList([
    stronger.rolloutSessionId,
    ...(Array.isArray(stronger.rolloutSessionIds) ? stronger.rolloutSessionIds : []),
    weaker.rolloutSessionId,
    ...(Array.isArray(weaker.rolloutSessionIds) ? weaker.rolloutSessionIds : []),
  ]);
  const merged = {
    ...weaker,
    ...stronger,
    hostId: stronger.hostId || weaker.hostId,
    conversationKey: stronger.conversationKey || weaker.conversationKey,
    bridgeSessionId: stronger.bridgeSessionId || weaker.bridgeSessionId || null,
    nativeThreadId: stronger.nativeThreadId || weaker.nativeThreadId || null,
    rolloutSessionId: stronger.rolloutSessionId || weaker.rolloutSessionId || rolloutSessionIds[0] || null,
    rolloutSessionIds,
    originSessionId: stronger.originSessionId || weaker.originSessionId || null,
    sourceSessionId: stronger.sourceSessionId || weaker.sourceSessionId || null,
    cwd: stronger.cwd || weaker.cwd || null,
    title: stronger.title || weaker.title || '',
    runs: mergeRuns(stronger.runs, weaker.runs),
    catalog: {
      ...(weaker.catalog || {}),
      ...(stronger.catalog || {}),
    },
    notification: structuredClone(winner.notification || {}),
    activeRunId: stronger.activeRunId || weaker.activeRunId || null,
    latestSuccessfulRunId: stronger.latestSuccessfulRunId || weaker.latestSuccessfulRunId || null,
  };
  return mergeNotificationRecords(merged, loser, context);
}

class SessionProvenanceService {
  constructor({ store, now = () => new Date().toISOString() } = {}) {
    if (!store) {
      throw new TypeError('SessionProvenanceService requires a SessionRecordStore');
    }
    this.store = store;
    this.now = now;
  }

  getSessionRecord(identity) {
    return this.store.readRecord(identity);
  }

  planRun(input = {}) {
    const runId = String(input.runId || '').trim();
    const launchMode = String(input.launchMode || 'fresh').trim();
    const clientRequestId = String(input.clientRequestId || '').trim();
    const requestFingerprint = String(input.requestFingerprint || '').trim();
    if (!runId) {
      throw new TypeError('planRun requires runId');
    }
    if (clientRequestId && !requestFingerprint) {
      throw new TypeError('planRun requires requestFingerprint with clientRequestId');
    }
    return this.store.transact('session.run.planned', (tx) => {
      if (launchMode === 'fresh_rebind' && input.explicitRebind !== true) {
        throw new SessionContractError(
          'session_run_state_conflict',
          'fresh_rebind is reserved for an explicit Rebind of the same Session.',
          { statusCode: 409 }
        );
      }
      const targetKey = tx.resolveCanonicalKey(input.identity);
      const sourceKey = input.sourceIdentity
        ? tx.resolveCanonicalKey(input.sourceIdentity)
        : targetKey;
      const targetRecord = tx.getRecord(targetKey);
      const sourceRecord = tx.getRecord(sourceKey);
      const acceptedRequestEntry = clientRequestId
        ? Object.entries(targetRecord?.runs || {}).find(([, run]) => run?.clientRequestId === clientRequestId)
        : null;
      if (acceptedRequestEntry) {
        const [acceptedRunId, acceptedRun] = acceptedRequestEntry;
        const replaysAcceptedRequest = acceptedRunId === runId
          && acceptedRun.requestFingerprint === requestFingerprint;
        if (replaysAcceptedRequest) {
          if (acceptedRun.status === 'failed') {
            throw new SessionContractError(
              'session_request_replay_unavailable',
              'The original Session creation request failed and cannot be replayed. Start a new Session instead.',
              { statusCode: 409, currentRunId: acceptedRunId, currentRunStatus: acceptedRun.status }
            );
          }
          return {
            canonicalKey: targetKey,
            run: structuredClone(acceptedRun),
            record: structuredClone(targetRecord),
            idempotentReplay: true,
          };
        }
        throw new SessionContractError(
          'session_request_conflict',
          'This Session creation request ID was already used with different launch settings.',
          { statusCode: 409, currentRunId: acceptedRunId, currentRunStatus: acceptedRun.status || null }
        );
      }
      if (targetRecord?.runs?.[runId]) {
        throw new SessionContractError('session_run_conflict', `Run ${runId} already exists.`);
      }
      const pendingRunId = String(targetRecord?.activeRunId || '').trim();
      const pendingRun = pendingRunId ? targetRecord?.runs?.[pendingRunId] : null;
      if (pendingRun?.status === 'pending') {
        throw new SessionContractError(
          'session_run_pending',
          `Run ${pendingRunId} is still pending for this Session.`,
          { statusCode: 409 }
        );
      }
      if (pendingRun?.stopRequestId) {
        throw new SessionContractError(
          'session_run_stopping',
          `Run ${pendingRunId} already has a pending Stop request.`,
          { statusCode: 409, currentRunId: pendingRunId, currentRunStatus: 'stopping' }
        );
      }
      const replacesSameSession = targetKey === sourceKey && (
        launchMode === 'resume'
        || (launchMode === 'fresh_rebind' && input.explicitRebind === true)
      );
      if (pendingRun?.status === 'live' && !replacesSameSession) {
        throw new SessionContractError(
          'session_run_state_conflict',
          `Run ${pendingRunId} is already live for the target Session.`,
          {
            statusCode: 409,
            currentRunId: pendingRunId,
            currentRunStatus: 'live',
            currentBindingFingerprint: bindingFingerprint(pendingRun.apiBinding),
          }
        );
      }
      assertRunMutationExpectation(input.expectSourceRun === true ? sourceRecord : targetRecord, input);
      const locksTranscriptFallback = launchMode === 'transcript_fallback'
        && targetKey !== sourceKey;
      if (locksTranscriptFallback && sourceRecord?.pendingTranscriptFallbackRunId) {
        throw new SessionContractError(
          'session_run_pending',
          `Run ${sourceRecord.pendingTranscriptFallbackRunId} is still creating a transcript fallback for this Session.`,
          { statusCode: 409 }
        );
      }
      const inheritedRunId = launchMode === 'fresh'
        ? null
        : sourceRecord?.latestSuccessfulRunId || sourceRecord?.activeRunId || null;
      const inheritedRun = inheritedRunId ? sourceRecord?.runs?.[inheritedRunId] : null;
      const effectiveLaunchMode = (
        launchMode === 'fresh_rebind'
        && input.explicitRebind === true
        && inheritedRun?.nativeResumeReady === true
      ) ? 'resume' : launchMode;
      const submittedBinding = publicBinding(input.submittedBinding);

      if (
        inheritedRun
        && submittedBinding
        && !bindingsEqual(inheritedRun.apiBinding, submittedBinding)
        && !input.explicitRebind
      ) {
        throw new SessionContractError(
          'session_api_binding_mismatch',
          'Submitted API does not match the Session run binding.',
          {
            sessionBinding: inheritedRun.apiBinding,
            submittedBinding,
            canRebind: true,
          }
        );
      }

      const binding = input.explicitRebind
        ? submittedBinding
        : submittedBinding || publicBinding(inheritedRun?.apiBinding);
      if (!binding || binding.kind === 'unknown' || !binding.bindingFingerprint) {
        throw new SessionContractError(
          'session_api_binding_unavailable',
          'The Session API binding cannot be resolved.',
          {
            sessionBinding: binding || publicBinding(inheritedRun?.apiBinding) || makeUnknownBinding(),
            canRebind: true,
          }
        );
      }

      const record = tx.ensureRecord(targetKey, {
        hostId: input.identity.hostId,
        conversationKey: input.identity.conversationKey || input.identity.sessionId,
        source: 'managed',
      });
      const inheritedSelection = inheritedRun?.effectiveSelection || inheritedRun?.requestedSelection;
      record.runs[runId] = {
        status: 'pending',
        launchMode: effectiveLaunchMode,
        clientRequestId: clientRequestId || null,
        requestFingerprint: requestFingerprint || null,
        parentRunId: inheritedRunId,
        nativeResumeReady: effectiveLaunchMode === 'resume'
          ? inheritedRun?.nativeResumeReady !== false
          : false,
        rebindFallbackAllowed: input.explicitRebind === true,
        apiBinding: binding,
        requestedSelection: cloneSelection(input.requestedSelection || inheritedSelection),
        effectiveSelection: null,
        createdAt: this.now(),
        endedAt: null,
        sourceCanonicalKey: locksTranscriptFallback ? sourceKey : null,
      };
      record.source = record.source === 'managed' ? 'managed' : 'managed';
      if (input.conversationKey) {
        record.conversationKey = String(input.conversationKey);
      }
      record.activeRunId = runId;
      if (input.sourceIdentity && targetKey !== sourceKey) {
        const sourceIdentity = identityValues(input.sourceIdentity)[0] || null;
        record.originSessionId ||= sourceRecord?.nativeThreadId || sourceIdentity;
        record.sourceSessionId ||= sourceRecord?.nativeThreadId || sourceIdentity;
      }
      record.updatedAt = this.now();
      if (locksTranscriptFallback) {
        sourceRecord.pendingTranscriptFallbackRunId = runId;
        sourceRecord.pendingTranscriptFallbackTargetKey = targetKey;
        sourceRecord.updatedAt = this.now();
        tx.markDirty(sourceKey);
      }
      this.setAliases(tx, targetKey, {
        ...input.identity,
        ...record,
        conversationKey: targetKey === sourceKey
          ? record.conversationKey
          : input.identity.conversationKey || null,
      });
      tx.appendDomainEvent({
        type: 'session.run.planned',
        canonicalKey: targetKey,
        runId,
        launchMode: effectiveLaunchMode,
        bindingFingerprint: binding.bindingFingerprint,
      });
      tx.markDirty(targetKey);
      return {
        canonicalKey: targetKey,
        run: structuredClone(record.runs[runId]),
        record: structuredClone(record),
      };
    });
  }

  confirmRun(input = {}) {
    return this.store.transact('session.run.confirmed', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey({
        ...input.identity,
        conversationKey: null,
      });
      const record = tx.getRecord(canonicalKey);
      const run = record?.runs?.[input.runId];
      if (!run) {
        throw new SessionContractError('session_run_not_found', `Run ${input.runId} was not planned.`, { statusCode: 404 });
      }
      if (run.status !== 'pending' || record.activeRunId !== input.runId) {
        throw new SessionContractError(
          'session_run_state_conflict',
          `Run ${input.runId} cannot be confirmed from state ${run.status || 'unknown'}.`,
          { statusCode: 409 }
        );
      }
      const effectiveBinding = publicBinding(input.effectiveBinding || run.apiBinding);
      if (!bindingsEqual(run.apiBinding, effectiveBinding)) {
        throw new SessionContractError(
          'session_api_binding_mismatch',
          'Host API attestation does not match the planned run binding.',
          {
            sessionBinding: run.apiBinding,
            submittedBinding: effectiveBinding,
            canRebind: true,
          }
        );
      }
      const confirmedLaunchMode = String(input.launchMode || '').trim();
      if (confirmedLaunchMode && confirmedLaunchMode !== run.launchMode) {
        const isAdaptiveRebind = run.rebindFallbackAllowed === true && (
          (run.launchMode === 'fresh_rebind' && confirmedLaunchMode === 'resume')
          || (run.launchMode === 'resume' && confirmedLaunchMode === 'fresh_rebind')
        );
        if (!isAdaptiveRebind) {
          throw new SessionContractError(
            'session_run_state_conflict',
            `Run ${input.runId} started with unexpected launch mode ${confirmedLaunchMode}.`,
            { statusCode: 409 }
          );
        }
        run.launchMode = confirmedLaunchMode;
      }
      const parentRun = run.parentRunId ? record.runs?.[run.parentRunId] : null;
      if (parentRun?.status === 'live') {
        parentRun.status = 'stopped';
        parentRun.endedAt = this.now();
      }
      run.status = 'live';
      if (run.launchMode === 'resume' || run.launchMode === 'fork') {
        run.nativeResumeReady = true;
      } else if (typeof input.nativeResumeReady === 'boolean') {
        run.nativeResumeReady = input.nativeResumeReady;
      }
      run.effectiveSelection = {
        model: String(input.effectiveSelection?.model || '').trim() || null,
        effort: String(input.effectiveSelection?.effort || '').trim() || null,
        confirmedAt: this.now(),
      };
      run.endedAt = null;
      record.bridgeSessionId = input.bridgeSessionId || record.bridgeSessionId || input.identity.bridgeSessionId || null;
      record.nativeThreadId = input.nativeThreadId || record.nativeThreadId || input.identity.nativeThreadId || null;
      record.originSessionId = input.originSessionId || record.originSessionId || null;
      record.sourceSessionId = input.sourceSessionId || record.sourceSessionId || null;
      record.cwd = input.cwd || record.cwd || null;
      record.title = input.title || record.title || '';
      record.source = 'managed';
      record.activeRunId = input.runId;
      record.latestSuccessfulRunId = input.runId;
      record.updatedAt = this.now();
      clearTranscriptFallbackLock(tx, run, input.runId, record.updatedAt);
      this.setAliases(tx, canonicalKey, { ...input.identity, ...record });
      tx.appendDomainEvent({
        type: 'session.run.confirmed',
        canonicalKey,
        runId: input.runId,
        launchMode: run.launchMode,
      });
      tx.markDirty(canonicalKey);
      return { canonicalKey, record: structuredClone(record), transitioned: true };
    });
  }

  confirmNativeResumeReady(input = {}) {
    return this.store.transact('session.native_resume_ready', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.getRecord(canonicalKey);
      const runId = String(input.runId || record?.activeRunId || '').trim();
      const run = record?.runs?.[runId];
      if (!run) {
        throw new SessionContractError(
          'session_run_not_found',
          `Run ${runId || ''} was not found.`,
          { statusCode: 404 }
        );
      }
      if (run.status !== 'live') {
        throw new SessionContractError(
          'session_run_state_conflict',
          `Run ${runId} cannot become natively resumable from state ${run.status || 'unknown'}.`,
          { statusCode: 409 }
        );
      }
      let transitioned = false;
      if (run.nativeResumeReady !== true) {
        run.nativeResumeReady = true;
        transitioned = true;
      }
      if (!transitioned) {
        return { canonicalKey, runId, record: structuredClone(record), transitioned: false };
      }
      record.updatedAt = this.now();
      tx.appendDomainEvent({
        type: 'session.native_resume_ready',
        canonicalKey,
        runId,
      });
      tx.markDirty(canonicalKey);
      return {
        canonicalKey,
        runId,
        record: structuredClone(record),
        transitioned: true,
      };
    });
  }

  failRun(input = {}) {
    return this.store.transact('session.run.failed', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.getRecord(canonicalKey);
      const run = record?.runs?.[input.runId];
      if (!run) {
        throw new SessionContractError('session_run_not_found', `Run ${input.runId} was not planned.`, { statusCode: 404 });
      }
      if (run.status !== 'pending') {
        return {
          canonicalKey,
          record: structuredClone(record),
          transitioned: false,
        };
      }
      run.status = 'failed';
      run.endedAt = this.now();
      run.error = {
        code: String(input.code || 'session_run_failed'),
        message: redactSecretText(input.message || ''),
      };
      if (record.activeRunId === input.runId) {
        const parentRun = run.parentRunId ? record.runs?.[run.parentRunId] : null;
        record.activeRunId = parentRun?.status === 'live' ? run.parentRunId : null;
      }
      record.updatedAt = this.now();
      clearTranscriptFallbackLock(tx, run, input.runId, record.updatedAt);
      tx.appendDomainEvent({ type: 'session.run.failed', canonicalKey, runId: input.runId, code: run.error.code });
      tx.markDirty(canonicalKey);
      return { canonicalKey, record: structuredClone(record), transitioned: true };
    });
  }

  requestStopRun(input = {}) {
    return this.store.transact('session.run.stop_requested', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.getRecord(canonicalKey);
      const expectation = assertRunMutationExpectation(record, {
        ...input,
        allowPendingExpectedRun: true,
        redirectPendingChildFromExpectedParent: true,
      });
      const runId = String(expectation?.runId || input.runId || record?.activeRunId || '').trim();
      const run = record?.runs?.[runId];
      if (!run) {
        throw new SessionContractError(
          'session_run_not_found',
          `Run ${runId || ''} was not found.`,
          { statusCode: 404 }
        );
      }
      if (record.activeRunId !== runId) {
        throw new SessionContractError(
          'session_run_state_conflict',
          `Run ${runId} is no longer the active Session run.`,
          { statusCode: 409 }
        );
      }
      if (!['live', 'pending'].includes(run.status)) {
        throw new SessionContractError(
          'session_run_state_conflict',
          `Run ${runId} cannot stop from state ${run.status || 'unknown'}.`,
          { statusCode: 409 }
        );
      }
      const stopRequestId = String(input.stopRequestId || '').trim();
      if (!stopRequestId) {
        throw new TypeError('requestStopRun requires stopRequestId');
      }
      if (run.stopRequestId) {
        throw new SessionContractError(
          'session_run_stopping',
          `Run ${runId} already has a pending Stop request.`,
          { statusCode: 409, currentRunId: runId, currentRunStatus: 'stopping' }
        );
      }
      run.stopRequestId = stopRequestId;
      run.stopRequestedAt = this.now();
      record.updatedAt = this.now();
      tx.appendDomainEvent({
        type: 'session.run.stop_requested',
        canonicalKey,
        runId,
        stopRequestId,
      });
      tx.markDirty(canonicalKey);
      return {
        canonicalKey,
        runId,
        redirectedFromRunId: expectation?.redirectedFromRunId || null,
        stopRequestId,
        record: structuredClone(record),
      };
    });
  }

  cancelStopRun(input = {}) {
    return this.store.transact('session.run.stop_cancelled', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.getRecord(canonicalKey);
      const runId = String(input.runId || record?.activeRunId || '').trim();
      const run = record?.runs?.[runId];
      if (!run) {
        throw new SessionContractError(
          'session_run_not_found',
          `Run ${runId || ''} was not found.`,
          { statusCode: 404 }
        );
      }
      const stopRequestId = String(input.stopRequestId || '').trim();
      if (!run.stopRequestId || (stopRequestId && run.stopRequestId !== stopRequestId)) {
        return { canonicalKey, runId, record: structuredClone(record), transitioned: false };
      }
      delete run.stopRequestId;
      delete run.stopRequestedAt;
      record.updatedAt = this.now();
      tx.appendDomainEvent({
        type: 'session.run.stop_cancelled',
        canonicalKey,
        runId,
        stopRequestId: stopRequestId || null,
      });
      tx.markDirty(canonicalKey);
      return { canonicalKey, runId, record: structuredClone(record), transitioned: true };
    });
  }

  stopRun(input = {}) {
    return this.store.transact('session.run.stopped', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.getRecord(canonicalKey);
      const expectation = assertRunMutationExpectation(record, input);
      const runId = input.runId || expectation?.runId || record?.activeRunId;
      const run = record?.runs?.[runId];
      if (!run) {
        throw new SessionContractError('session_run_not_found', `Run ${runId || ''} was not found.`, { statusCode: 404 });
      }
      if (
        typeof input.commitGuard === 'function'
        && input.commitGuard({
          canonicalKey,
          runId,
          record: structuredClone(record),
          run: structuredClone(run),
        }) === false
      ) {
        return {
          canonicalKey,
          runId,
          record: structuredClone(record),
          transitioned: false,
          guardRejected: true,
        };
      }
      const transitioned = !['failed', 'stopped'].includes(run.status);
      if (transitioned) {
        run.status = 'stopped';
        run.endedAt = this.now();
      }
      delete run.stopRequestId;
      delete run.stopRequestedAt;
      if (record.activeRunId === runId) {
        const parentRun = run.parentRunId ? record.runs?.[run.parentRunId] : null;
        record.activeRunId = parentRun?.status === 'live' ? run.parentRunId : null;
      }
      record.updatedAt = this.now();
      clearTranscriptFallbackLock(tx, run, runId, record.updatedAt);
      tx.appendDomainEvent({ type: 'session.run.stopped', canonicalKey, runId });
      tx.markDirty(canonicalKey);
      return { canonicalKey, runId, record: structuredClone(record), transitioned };
    });
  }

  recordRequestedSelection(input = {}) {
    return this.store.transact('session.selection.requested', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.getRecord(canonicalKey);
      const runId = String(input.runId || record?.activeRunId || '').trim();
      const run = record?.runs?.[runId];
      if (!run) {
        throw new SessionContractError('session_run_not_found', 'Requested selection has no matching run.', { statusCode: 404 });
      }
      if (!isCurrentLiveRun(record, runId)) {
        throw new SessionContractError(
          'session_run_state_conflict',
          `Run ${runId} cannot accept a requested selection from state ${run.status || 'unknown'}.`,
          { statusCode: 409 }
        );
      }
      run.requestedSelection = cloneSelection(input.selection, 'user');
      record.updatedAt = this.now();
      tx.markDirty(canonicalKey);
      return { canonicalKey, selection: structuredClone(run.requestedSelection) };
    });
  }

  confirmEffectiveSelection(input = {}) {
    return this.store.transact('session.selection.confirmed', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.getRecord(canonicalKey);
      const runId = String(input.runId || record?.activeRunId || '').trim();
      const run = record?.runs?.[runId];
      if (!run) {
        throw new SessionContractError('session_run_not_found', 'Effective selection has no matching run.', { statusCode: 404 });
      }
      if (!isCurrentLiveRun(record, runId)) {
        throw new SessionContractError(
          'session_run_state_conflict',
          `Run ${runId} cannot confirm an effective selection from state ${run.status || 'unknown'}.`,
          { statusCode: 409 }
        );
      }
      run.effectiveSelection = {
        model: String(input.selection?.model || '').trim() || null,
        effort: String(input.selection?.effort || '').trim() || null,
        confirmedAt: this.now(),
      };
      record.updatedAt = this.now();
      tx.markDirty(canonicalKey);
      return { canonicalKey, selection: structuredClone(run.effectiveSelection) };
    });
  }

  importVerifiedLegacyRun(input = {}) {
    const evidenceSource = String(input.evidenceSource || '').trim();
    if (!VERIFIED_LEGACY_EVIDENCE_SOURCES.has(evidenceSource)) {
      throw new SessionContractError(
        'session_api_binding_unavailable',
        'Verified binding evidence is required.',
        { canRebind: true }
      );
    }
    if (containsSecretField(input.apiBinding)) {
      throw new SessionContractError(
        'session_api_binding_unavailable',
        'Verified legacy import does not accept API keys or credentials.',
        { canRebind: true }
      );
    }

    let binding;
    try {
      binding = publicBinding(input.apiBinding);
    } catch (error) {
      throw new SessionContractError(
        'session_api_binding_unavailable',
        `Verified binding identity is invalid: ${error.message}`,
        { canRebind: true }
      );
    }
    if (!binding?.bindingFingerprint || binding.kind === 'unknown') {
      throw new SessionContractError(
        'session_api_binding_unavailable',
        'Verified binding identity is incomplete.',
        { sessionBinding: binding || makeUnknownBinding(), canRebind: true }
      );
    }

    return this.store.transact('session.verified_legacy_run_imported', (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity);
      const record = tx.ensureRecord(canonicalKey, {
        hostId: input.identity.hostId,
        conversationKey: input.conversationKey || input.identity.sessionId,
        source: 'imported',
      });
      if (record.activeRunId) {
        throw new SessionContractError(
          'session_run_state_conflict',
          'Verified legacy import cannot replace an active Session run.',
          { statusCode: 409 }
        );
      }
      const existingVerifiedRun = Object.values(record.runs || {}).find(
        (run) => run?.apiBinding?.bindingFingerprint
      );
      if (existingVerifiedRun) {
        throw new SessionContractError(
          'session_run_conflict',
          'This Session already has verified run provenance.',
          { statusCode: 409 }
        );
      }
      for (const aliasValue of [input.bridgeSessionId, input.nativeThreadId]) {
        const normalizedAlias = String(aliasValue || '').trim();
        if (!normalizedAlias) {
          continue;
        }
        const existingTarget = tx.aliasTarget(`${record.hostId}::${normalizedAlias}`);
        if (existingTarget && existingTarget !== canonicalKey) {
          throw new SessionContractError(
            'session_run_conflict',
            `Session identity ${normalizedAlias} already belongs to another record.`,
            { statusCode: 409 }
          );
        }
      }
      const runId = String(input.runId || `legacy-${binding.bindingFingerprint.slice(0, 12)}`).trim();
      if (record.runs[runId]) {
        throw new SessionContractError(
          'session_run_conflict',
          `Run ${runId} already exists.`,
          { statusCode: 409 }
        );
      }

      const now = this.now();
      record.bridgeSessionId = input.bridgeSessionId || record.bridgeSessionId || null;
      record.nativeThreadId = input.nativeThreadId || record.nativeThreadId || input.identity.sessionId || null;
      record.originSessionId = input.originSessionId || record.originSessionId || input.identity.sessionId || null;
      record.sourceSessionId = input.sourceSessionId || record.sourceSessionId || input.identity.sessionId || null;
      record.conversationKey = input.conversationKey || record.conversationKey || input.identity.sessionId;
      record.source = record.source === 'managed' ? 'managed' : 'imported';
      record.cwd = input.cwd || record.cwd || null;
      record.title = input.title || record.title || input.identity.sessionId || '';
      record.runs[runId] = {
        status: 'stopped',
        launchMode: 'resume',
        parentRunId: null,
        nativeResumeReady: true,
        apiBinding: binding,
        requestedSelection: cloneSelection({ ...input.selection, source: evidenceSource }, evidenceSource),
        effectiveSelection: {
          model: String(input.selection?.model || '').trim() || null,
          effort: String(input.selection?.effort || '').trim() || null,
          confirmedAt: null,
        },
        createdAt: input.createdAt || now,
        endedAt: input.endedAt || now,
      };
      record.latestSuccessfulRunId = runId;
      record.activeRunId = null;
      record.updatedAt = now;
      this.setAliases(tx, canonicalKey, { ...input.identity, ...record });
      tx.appendDomainEvent({
        type: 'session.verified_legacy_run_imported',
        canonicalKey,
        runId,
        evidenceSource,
        bindingFingerprint: binding.bindingFingerprint,
      });
      tx.markDirty(canonicalKey);
      return {
        canonicalKey,
        runId,
        run: structuredClone(record.runs[runId]),
        record: structuredClone(record),
      };
    });
  }

  mergeDiscovery(input = {}) {
    const hostId = String(input.hostId || '').trim();
    const concreteIds = identityValues({ ...input, conversationKey: null });
    const ids = concreteIds.length ? concreteIds : identityValues(input);
    if (!hostId || !ids.length) {
      throw new TypeError('mergeDiscovery requires hostId and a Session identity');
    }
    return this.store.transact('session.discovery.merged', (tx) => {
      const keys = [...new Set(ids.map((id) => tx.resolveCanonicalKey({ hostId, sessionId: id })) )];
      const existingKeys = keys.filter((key) => tx.getRecord(key));
      let canonicalKey = existingKeys
        .sort((left, right) => sourceStrength(tx.getRecord(right)?.source) - sourceStrength(tx.getRecord(left)?.source))[0]
        || keys[0];
      for (const loserKey of existingKeys) {
        if (loserKey !== canonicalKey) {
          tx.mergeRecordInto(canonicalKey, loserKey, (winner, loser) => (
            mergeRecords(winner, loser, { winnerKey: canonicalKey, loserKey })
          ));
        }
      }
      const record = tx.ensureRecord(canonicalKey, {
        hostId,
        conversationKey: input.sessionId || input.nativeThreadId || input.conversationKey,
        source: input.source || 'imported',
      });
      const incomingStrength = sourceStrength(input.source);
      const existingStrength = sourceStrength(record.source);
      if (incomingStrength > existingStrength) {
        record.source = input.source;
      }
      if (
        input.conversationKey
        && (
          !record.conversationKey
          || record.conversationKey === input.sessionId
          || incomingStrength >= existingStrength
        )
      ) {
        record.conversationKey = input.conversationKey;
      }
      const rolloutSessionIds = discoveredRolloutSessionIds(input);
      if (rolloutSessionIds.length) {
        record.rolloutSessionId = rolloutSessionIds[0];
        record.rolloutSessionIds = normalizedIdentityList([
          ...rolloutSessionIds,
          ...(Array.isArray(record.rolloutSessionIds) ? record.rolloutSessionIds : []),
          record.rolloutSessionId,
        ]);
      } else {
        record.rolloutSessionIds = normalizedIdentityList([
          record.rolloutSessionId,
          ...(Array.isArray(record.rolloutSessionIds) ? record.rolloutSessionIds : []),
        ]);
      }
      record.nativeThreadId ||= input.nativeThreadId || input.sessionId || null;
      record.bridgeSessionId ||= input.bridgeSessionId || null;
      record.originSessionId ||= input.originSessionId || null;
      record.sourceSessionId ||= input.sourceSessionId || null;
      if (!record.title || incomingStrength >= existingStrength) {
        record.title = input.title || record.title || '';
      }
      if (!record.cwd || incomingStrength >= existingStrength) {
        record.cwd = input.cwd || record.cwd || null;
      }
      if (!Object.keys(record.runs || {}).length) {
        const binding = input.apiProfile
          ? makeProfileBinding(input.apiProfile)
          : input.hostEnvironmentAttestation
            ? makeHostEnvironmentBinding(input.hostEnvironmentAttestation)
            : makeUnknownBinding(input.modelProviderHint);
        record.runs.legacy = {
          status: 'stopped',
          launchMode: 'resume',
          parentRunId: null,
          nativeResumeReady: true,
          apiBinding: binding,
          requestedSelection: cloneSelection(input.selection, 'discovery'),
          effectiveSelection: {
            model: String(input.selection?.model || '').trim() || null,
            effort: String(input.selection?.effort || '').trim() || null,
            confirmedAt: null,
          },
          createdAt: input.createdAt || this.now(),
          endedAt: input.endedAt || this.now(),
        };
        record.latestSuccessfulRunId = 'legacy';
      }
      record.updatedAt = this.now();
      this.setAliases(tx, canonicalKey, { ...input, ...record });
      tx.appendDomainEvent({ type: 'session.discovery.merged', canonicalKey, source: input.source || null });
      tx.markDirty(canonicalKey);
      return { canonicalKey, record: structuredClone(record) };
    });
  }

  setAliases(tx, canonicalKey, identity, options = {}) {
    const hostId = String(identity.hostId || '').trim();
    const concreteValues = [
      identity.sessionId,
      identity.bridgeSessionId,
      identity.nativeThreadId,
      identity.rolloutSessionId,
      ...(Array.isArray(identity.rolloutSessionIds) ? identity.rolloutSessionIds : []),
      ...(options.includeLineage ? [identity.originSessionId, identity.sourceSessionId] : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const concreteAliases = [...new Set(concreteValues)].map((value) => `${hostId}::${value}`);
    for (const alias of concreteAliases) {
      const existingTarget = tx.aliasTarget(alias);
      if (existingTarget && existingTarget !== canonicalKey) {
        throw new SessionContractError(
          'session_identity_conflict',
          'Session identity already belongs to another record.',
          { statusCode: 409 }
        );
      }
    }
    for (const alias of concreteAliases) {
      tx.setAlias(alias, canonicalKey);
    }
    const conversationKey = String(identity.conversationKey || '').trim();
    if (conversationKey) {
      const existingTarget = tx.aliasTarget(`${hostId}::${conversationKey}`);
      if (!existingTarget || existingTarget === canonicalKey) {
        tx.setAlias(`${hostId}::${conversationKey}`, canonicalKey);
      }
    }
  }
}

module.exports = {
  SessionContractError,
  SessionProvenanceService,
};
