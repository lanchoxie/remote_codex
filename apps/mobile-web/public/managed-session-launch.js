(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexManagedSessionLaunch = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const RECEIPT_VERSION = 1;
  const DEFAULT_SOFT_TIMEOUT_MS = 60_000;
  const DEFAULT_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const RECEIPT_FUTURE_SKEW_MS = 5 * 60 * 1000;
  const MAX_DATE_MS = 8.64e15;
  const RECEIPT_TEXT_FIELD_LIMITS = Object.freeze([
    Object.freeze(['bridgeSessionId', 512]),
    Object.freeze(['nativeThreadId', 512]),
    Object.freeze(['originSessionId', 512]),
    Object.freeze(['sourceSessionId', 512]),
    Object.freeze(['conversationKey', 512]),
    Object.freeze(['launchMode', 120]),
    Object.freeze(['clientRequestId', 512]),
    Object.freeze(['intentKey', 2048]),
    Object.freeze(['cwd', 2048]),
    Object.freeze(['label', 512]),
    Object.freeze(['rebindTargetKind', 120]),
    Object.freeze(['rebindProfileId', 512]),
    Object.freeze(['rebindProvider', 120]),
    Object.freeze(['rebindProviderKind', 120]),
    Object.freeze(['rebindCompatibilityKey', 160]),
    Object.freeze(['rebindBaseUrl', 2048]),
  ]);
  const LIVE_STATUSES = new Set(['live', 'ready', 'running']);
  const PENDING_STATUSES = new Set([
    'accepted',
    'initializing',
    'launching',
    'pending',
    'queued',
    'starting',
    'stopping',
  ]);
  const TERMINAL_STATUSES = new Set([
    'cancelled',
    'canceled',
    'closed',
    'exited',
    'failed',
    'history-only',
    'stopped',
    'terminated',
  ]);
  const OBSERVATION_TERMINAL_STATUSES = new Set([
    'cancelled',
    'canceled',
    'conflict',
    'failed',
    'live',
    'stopped',
    'terminated',
  ]);

  function text(value, maxLength = 512) {
    return String(value == null ? '' : value).trim().slice(0, maxLength);
  }

  function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function parseJson(input) {
    if (typeof input !== 'string') return { ok: true, value: input };
    try {
      return { ok: true, value: JSON.parse(input) };
    } catch (error) {
      return { ok: false, error: 'invalid-json', cause: error };
    }
  }

  function boundedReceiptText(value, maxLength) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) return null;
    return normalized;
  }

  function timestampMs(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function optionNow(options = {}) {
    const value = typeof options.now === 'function' ? options.now() : options.now;
    const parsed = timestampMs(value);
    return parsed == null ? Date.now() : parsed;
  }

  function firstText(...values) {
    for (const value of values) {
      const normalized = text(value);
      if (normalized) return normalized;
    }
    return null;
  }

  function firstTimestamp(...values) {
    for (const value of values) {
      const normalized = timestampMs(value);
      if (normalized != null) return normalized;
    }
    return null;
  }

  function normalizedSecretQueryKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function isSecretQueryKey(value) {
    const key = normalizedSecretQueryKey(value);
    if (!key || key === 'tokenbudget') return false;
    return key === 'auth'
      || key === 'password'
      || key === 'passwd'
      || key === 'secret'
      || key === 'authorization'
      || key === 'proxyauthorization'
      || key === 'cookie'
      || key === 'setcookie'
      || key === 'accesskey'
      || key === 'secretkey'
      || key === 'accountkey'
      || key === 'storagekey'
      || key === 'encryptionkey'
      || key === 'connectionstring'
      || /^(?:aws)?(?:accesskeyid|secretaccesskey)$/.test(key)
      || /(?:apikey|token|password|passwd|secret|credential|credentials|authorization|privatekey|signingkey|cookie)$/.test(key)
      || key === 'key'
      || key === 'sig'
      || key === 'signature'
      || key === 'code'
      || /key$/.test(key)
      || /signature$/.test(key);
  }

  function safeRebindBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.username || url.password) return null;
      for (const key of [...url.searchParams.keys()]) {
        if (isSecretQueryKey(key)) url.searchParams.delete(key);
      }
      url.hash = '';
      return url.toString().slice(0, 2048) || null;
    } catch (_) {
      return null;
    }
  }

  // A launch receipt is intentionally a narrow capability-free record. Never add
  // API configuration, bindings, request bodies, or arbitrary command payloads here.
  function normalizeLaunchReceipt(input = {}, options = {}) {
    const source = record(input);
    const command = record(source.command);
    const acceptedAtMs = firstTimestamp(
      options.acceptedAtMs,
      source.acceptedAtMs,
      source.acceptedAt,
      source.plannedAt,
      source.createdAt,
      command.createdAt
    );
    const resolvedAcceptedAtMs = acceptedAtMs == null ? optionNow(options) : acceptedAtMs;

    return {
      version: RECEIPT_VERSION,
      hostId: firstText(options.hostId, source.hostId, command.hostId),
      sessionId: firstText(source.sessionId, command.sessionId),
      runId: firstText(source.runId, source.runtime?.runId, command.runId, command.runtime?.runId),
      bridgeSessionId: firstText(source.bridgeSessionId, command.bridgeSessionId),
      nativeThreadId: firstText(source.nativeThreadId, command.nativeThreadId),
      originSessionId: firstText(source.originSessionId, command.originSessionId),
      sourceSessionId: firstText(source.sourceSessionId, command.sourceSessionId),
      conversationKey: firstText(source.conversationKey, command.conversationKey),
      launchMode: firstText(source.launchMode, command.launchMode),
      clientRequestId: firstText(
        options.clientRequestId,
        source.clientRequestId,
        command.clientRequestId
      ),
      intentKey: text(options.intentKey || source.intentKey || command.intentKey, 2048) || null,
      cwd: text(options.cwd || source.cwd || command.cwd, 2048) || null,
      label: text(options.label || source.label || command.label, 512) || null,
      rebindTargetKind: text(options.rebindTargetKind || source.rebindTargetKind, 120) || null,
      rebindProfileId: text(options.rebindProfileId || source.rebindProfileId, 512) || null,
      rebindProvider: text(options.rebindProvider || source.rebindProvider, 120) || null,
      rebindProviderKind: text(options.rebindProviderKind || source.rebindProviderKind, 120) || null,
      rebindCompatibilityKey: text(options.rebindCompatibilityKey || source.rebindCompatibilityKey, 160).toLowerCase() || null,
      rebindBaseUrl: safeRebindBaseUrl(options.rebindBaseUrl || source.rebindBaseUrl),
      acceptedAtMs: resolvedAcceptedAtMs,
      acceptedAt: new Date(resolvedAcceptedAtMs).toISOString(),
      idempotentReplay: source.idempotentReplay === true,
    };
  }

  function parseAcceptedAt(source) {
    const numeric = source.acceptedAtMs;
    const numericValue = typeof numeric === 'number'
      && Number.isFinite(numeric)
      && numeric >= 0
      && numeric <= MAX_DATE_MS
      ? Math.floor(numeric)
      : null;
    const parsedText = typeof source.acceptedAt === 'string' && source.acceptedAt.trim()
      ? Date.parse(source.acceptedAt)
      : null;
    const textValue = Number.isFinite(parsedText) && parsedText >= 0 && parsedText <= MAX_DATE_MS
      ? Math.floor(parsedText)
      : null;
    if (numericValue == null && textValue == null) {
      return { ok: false, error: 'accepted-at-required' };
    }
    if (numeric != null && numericValue == null) {
      return { ok: false, error: 'invalid-accepted-at-ms' };
    }
    if (source.acceptedAt != null && textValue == null) {
      return { ok: false, error: 'invalid-accepted-at' };
    }
    if (numericValue != null && textValue != null && numericValue !== textValue) {
      return { ok: false, error: 'accepted-at-mismatch' };
    }
    return { ok: true, value: numericValue == null ? textValue : numericValue };
  }

  function nonNegativeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function decodeLaunchReceipt(input = {}, options = {}) {
    const parsed = parseJson(input);
    if (!parsed.ok) return parsed;
    const source = parsed.value;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return { ok: false, error: 'receipt-record-required' };
    }
    if (source.version !== RECEIPT_VERSION) {
      return { ok: false, error: 'unsupported-receipt-version' };
    }
    const hostId = boundedReceiptText(source.hostId, 512);
    const sessionId = boundedReceiptText(source.sessionId, 512);
    const runId = boundedReceiptText(source.runId, 512);
    if (!hostId) return { ok: false, error: 'host-id-required' };
    if (!sessionId) return { ok: false, error: 'session-id-required' };
    if (!runId) return { ok: false, error: 'run-id-required' };

    const acceptedAt = parseAcceptedAt(source);
    if (!acceptedAt.ok) return acceptedAt;
    if (options.validateAge !== false) {
      const now = optionNow(options);
      const maxAgeMs = nonNegativeNumber(options.maxAgeMs, DEFAULT_RECEIPT_MAX_AGE_MS);
      const futureSkewMs = nonNegativeNumber(options.futureSkewMs, RECEIPT_FUTURE_SKEW_MS);
      if (acceptedAt.value > now + futureSkewMs) {
        return { ok: false, error: 'accepted-at-in-future' };
      }
      if (now - acceptedAt.value > maxAgeMs) {
        return { ok: false, error: 'receipt-expired' };
      }
    }

    const receipt = {
      version: RECEIPT_VERSION,
      hostId,
      sessionId,
      runId,
      acceptedAtMs: acceptedAt.value,
      acceptedAt: new Date(acceptedAt.value).toISOString(),
    };
    for (const [field, maxLength] of RECEIPT_TEXT_FIELD_LIMITS) {
      if (field === 'rebindBaseUrl') continue;
      const value = boundedReceiptText(source[field], maxLength);
      if (value) receipt[field] = value;
    }
    const rebindBaseUrl = safeRebindBaseUrl(source.rebindBaseUrl);
    if (rebindBaseUrl) receipt.rebindBaseUrl = rebindBaseUrl;
    if (source.idempotentReplay === true) receipt.idempotentReplay = true;
    return { ok: true, value: receipt, receipt };
  }

  function decodePersistedLaunchReceipt(input = {}, options = {}) {
    const decoded = decodeLaunchReceipt(input, options);
    return decoded.ok ? decoded.value : null;
  }

  function receiptIdentityValues(receipt) {
    return new Set([
      receipt.sessionId,
      receipt.bridgeSessionId,
      receipt.nativeThreadId,
      receipt.originSessionId,
      receipt.sourceSessionId,
      receipt.conversationKey,
    ].map((value) => text(value)).filter(Boolean));
  }

  function sessionIdentityValues(session) {
    return [
      session.sessionId,
      session.bridgeSessionId,
      session.nativeThreadId,
      session.originSessionId,
      session.sourceSessionId,
      session.conversationKey,
    ].map((value) => text(value)).filter(Boolean);
  }

  function sessionMatchesReceiptIdentity(session, receipt, identities) {
    const hostId = text(session?.hostId);
    if (receipt.hostId && hostId && hostId !== receipt.hostId) return false;
    return sessionIdentityValues(record(session)).some((value) => identities.has(value));
  }

  function normalizedStatus(value) {
    const normalized = text(value, 120).toLowerCase();
    if (!normalized) return '';
    if (normalized.startsWith('failed')) return 'failed';
    if (normalized.startsWith('exited')) return 'exited';
    return normalized;
  }

  function statusKind(status) {
    const normalized = normalizedStatus(status);
    if (LIVE_STATUSES.has(normalized)) return 'live';
    if (PENDING_STATUSES.has(normalized)) return 'pending';
    if (TERMINAL_STATUSES.has(normalized)) return 'terminal';
    return 'unknown';
  }

  function isTerminalLaunchObservation(result) {
    if (result?.terminal === false) return false;
    if (result?.terminal === true) return true;
    return OBSERVATION_TERMINAL_STATUSES.has(normalizedStatus(result?.status));
  }

  function runtimeRunObservations(runtimeConfig) {
    const config = record(runtimeConfig);
    const pending = record(config.pendingRun);
    const nested = record(config.runtime);
    const observations = [];
    const push = (runId, status, source) => {
      const normalizedRunId = text(runId);
      if (!normalizedRunId) return;
      observations.push({
        runId: normalizedRunId,
        status: normalizedStatus(status),
        source,
      });
    };
    push(pending.runId, pending.status || pending.runStatus || pending.phase, 'runtime-config.pending-run');
    push(config.runId, config.runStatus || config.status || config.phase, 'runtime-config.run');
    push(nested.runId, nested.runStatus || nested.status || nested.phase, 'runtime-config.runtime');
    return observations;
  }

  function exactSessionRunId(session) {
    return firstText(session?.runId, session?.runtime?.runId, session?.runtimeConfig?.runId);
  }

  function exactSessionStatus(session) {
    if (session?.live === true) return 'live';
    const status = normalizedStatus(
      session?.runtimeConfig?.runStatus
      || session?.runtime?.runStatus
      || session?.state
    );
    if (statusKind(status) === 'terminal') return status;
    if (session?.resumeError && statusKind(status) !== 'pending') return 'failed';
    return status;
  }

  function elapsedSinceReceipt(receipt, now) {
    const nowMs = timestampMs(typeof now === 'function' ? now() : now);
    const effectiveNow = nowMs == null ? Date.now() : nowMs;
    return Math.max(0, effectiveNow - receipt.acceptedAtMs);
  }

  function observationResult(status, reason, receipt, elapsedMs, extra = {}) {
    return {
      status,
      reason,
      receipt,
      elapsedMs,
      ...extra,
    };
  }

  function waitingResult(reason, receipt, elapsedMs, softTimeoutMs, extra = {}) {
    const slow = elapsedMs >= softTimeoutMs;
    return observationResult(slow ? 'slow' : 'pending', reason, receipt, elapsedMs, {
      softTimeoutMs,
      ...extra,
    });
  }

  function classifyLaunchObservation(receiptInput, options = {}) {
    const nowMs = timestampMs(typeof options.now === 'function' ? options.now() : options.now);
    const effectiveNow = nowMs == null ? Date.now() : nowMs;
    const receipt = normalizeLaunchReceipt(receiptInput, { now: effectiveNow });
    const softTimeoutValue = Number(options.softTimeoutMs);
    const softTimeoutMs = Number.isFinite(softTimeoutValue) && softTimeoutValue >= 0
      ? softTimeoutValue
      : DEFAULT_SOFT_TIMEOUT_MS;
    const elapsedMs = elapsedSinceReceipt(receipt, effectiveNow);

    if (!receipt.sessionId || !receipt.runId) {
      return observationResult('indeterminate', 'invalid-receipt', receipt, elapsedMs, { softTimeoutMs });
    }

    const runtimeConfig = record(options.runtimeConfig);
    const runtimeHostId = text(runtimeConfig.hostId);
    const runtimeSessionId = text(runtimeConfig.sessionId);
    const identities = receiptIdentityValues(receipt);
    if (runtimeHostId && receipt.hostId && runtimeHostId !== receipt.hostId) {
      return observationResult('conflict', 'runtime-host-mismatch', receipt, elapsedMs, {
        softTimeoutMs,
        observedHostId: runtimeHostId,
      });
    }
    if (runtimeSessionId && !identities.has(runtimeSessionId)) {
      return observationResult('conflict', 'runtime-session-mismatch', receipt, elapsedMs, {
        softTimeoutMs,
        observedSessionId: runtimeSessionId,
      });
    }

    const runtimeObservations = runtimeRunObservations(runtimeConfig);
    const exactRuntime = runtimeObservations.find((item) => item.runId === receipt.runId);
    if (exactRuntime) {
      const kind = statusKind(exactRuntime.status);
      const observation = {
        source: exactRuntime.source,
        runId: exactRuntime.runId,
        runStatus: exactRuntime.status || null,
      };
      if (kind === 'live') {
        return observationResult('live', 'exact-runtime-live', receipt, elapsedMs, { observation });
      }
      if (kind === 'terminal') {
        return observationResult('failed', 'exact-runtime-terminal', receipt, elapsedMs, { observation });
      }
      if (kind === 'pending') {
        return waitingResult('exact-runtime-pending', receipt, elapsedMs, softTimeoutMs, { observation });
      }
      return observationResult('indeterminate', 'exact-runtime-status-unknown', receipt, elapsedMs, {
        softTimeoutMs,
        observation,
      });
    }

    const activeRunId = text(runtimeConfig.activeRunId);
    if (activeRunId && activeRunId !== receipt.runId) {
      const activeObservation = runtimeObservations.find((item) => item.runId === activeRunId);
      if (activeObservation || text(runtimeConfig.runId) === activeRunId) {
        return observationResult('conflict', 'authoritative-run-changed', receipt, elapsedMs, {
          softTimeoutMs,
          observedRunId: activeRunId,
          observedRunStatus: activeObservation?.status || normalizedStatus(runtimeConfig.runStatus) || null,
        });
      }
    }

    const matchingSessions = (Array.isArray(options.sessions) ? options.sessions : [])
      .filter((session) => sessionMatchesReceiptIdentity(session, receipt, identities));
    const exactRunSessions = matchingSessions.filter(
      (session) => exactSessionRunId(session) === receipt.runId
    );
    const exactLive = exactRunSessions.find((session) => statusKind(exactSessionStatus(session)) === 'live');
    if (exactLive) {
      return observationResult('live', 'exact-session-live', receipt, elapsedMs, {
        observation: {
          source: 'session-list',
          sessionId: text(exactLive.sessionId) || null,
          runId: receipt.runId,
          runStatus: exactSessionStatus(exactLive) || null,
        },
      });
    }
    const exactTerminal = exactRunSessions.find(
      (session) => statusKind(exactSessionStatus(session)) === 'terminal'
    );
    if (exactTerminal) {
      return observationResult('failed', 'exact-session-terminal', receipt, elapsedMs, {
        observation: {
          source: 'session-list',
          sessionId: text(exactTerminal.sessionId) || null,
          runId: receipt.runId,
          runStatus: exactSessionStatus(exactTerminal) || null,
        },
      });
    }
    const exactPending = exactRunSessions.find(
      (session) => statusKind(exactSessionStatus(session)) === 'pending'
    );
    if (exactPending) {
      return waitingResult('exact-session-pending', receipt, elapsedMs, softTimeoutMs, {
        observation: {
          source: 'session-list',
          sessionId: text(exactPending.sessionId) || null,
          runId: receipt.runId,
          runStatus: exactSessionStatus(exactPending) || null,
        },
      });
    }

    const identityStarting = matchingSessions.find((session) => (
      statusKind(exactSessionStatus(session)) === 'pending'
      && !exactSessionRunId(session)
    ));
    if (identityStarting) {
      return waitingResult('identity-session-pending', receipt, elapsedMs, softTimeoutMs, {
        observation: {
          source: 'session-list',
          sessionId: text(identityStarting.sessionId) || null,
          runId: null,
          runStatus: exactSessionStatus(identityStarting) || null,
        },
      });
    }

    if (elapsedMs < softTimeoutMs) {
      return waitingResult('awaiting-exact-observation', receipt, elapsedMs, softTimeoutMs);
    }
    return observationResult('indeterminate', 'exact-observation-missing', receipt, elapsedMs, {
      softTimeoutMs,
    });
  }

  return Object.freeze({
    RECEIPT_VERSION,
    DEFAULT_SOFT_TIMEOUT_MS,
    DEFAULT_RECEIPT_MAX_AGE_MS,
    RECEIPT_FUTURE_SKEW_MS,
    RECEIPT_TEXT_FIELD_LIMITS,
    sanitizeRebindBaseUrl: safeRebindBaseUrl,
    normalizeLaunchReceipt,
    decodeLaunchReceipt,
    decodePersistedLaunchReceipt,
    normalizeLaunchObservationStatus: normalizedStatus,
    isTerminalLaunchObservation,
    classifyLaunchObservation,
  });
}));
