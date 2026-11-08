(function init(root, factory) {
  const managedLaunchApi = typeof module === 'object' && module.exports
    ? require('./managed-session-launch')
    : root.RemoteCodexManagedSessionLaunch;
  const api = factory(managedLaunchApi);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexManagedSessionLaunchCoordinator = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (managedLaunchApi) => {
  'use strict';

  const launchApi = managedLaunchApi || {};

  const RECEIPT_VERSION = Number(launchApi.RECEIPT_VERSION) || 1;
  const LEDGER_VERSION = 1;
  const DEFAULT_LEASE_MS = 10 * 60_000;
  const DEFAULT_INITIAL_BACKOFF_MS = 500;
  const DEFAULT_MAX_BACKOFF_MS = 10_000;
  const DEFAULT_BACKOFF_MULTIPLIER = 1.8;
  const DEFAULT_LEDGER_LOCK_NAME = 'remote-codex-managed-session-launch-ledger';
  const DEFAULT_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_RECEIPT_FUTURE_SKEW_MS = 5 * 60 * 1000;
  const DEFAULT_MAX_LEDGER_ENTRIES = 64;
  const OPTIONAL_TEXT_FIELDS = Array.isArray(launchApi.RECEIPT_TEXT_FIELD_LIMITS)
    ? launchApi.RECEIPT_TEXT_FIELD_LIMITS
    : [];

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function boundedText(value, maxLength) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) return null;
    return normalized;
  }

  function parseJson(input) {
    if (typeof input !== 'string') return { ok: true, value: input };
    try {
      return { ok: true, value: JSON.parse(input) };
    } catch (error) {
      return { ok: false, error: 'invalid-json', cause: error };
    }
  }

  function optionNow(options = {}) {
    const value = typeof options.now === 'function' ? options.now() : options.now;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : Date.now();
  }

  function nonNegativeNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function decodeLaunchReceipt(input, options = {}) {
    if (typeof launchApi.decodeLaunchReceipt !== 'function') {
      return { ok: false, error: 'launch-receipt-decoder-unavailable' };
    }
    return launchApi.decodeLaunchReceipt(input, options);
  }

  function requireLaunchReceipt(input, options = {}) {
    const decoded = decodeLaunchReceipt(input, options);
    if (decoded.ok) return decoded.value;
    const error = new TypeError(`Invalid managed launch receipt: ${decoded.error}`);
    error.code = decoded.error;
    throw error;
  }

  function receiptKey(input) {
    const receipt = requireLaunchReceipt(input, { validateAge: false });
    return JSON.stringify([receipt.hostId, receipt.sessionId, receipt.runId]);
  }

  function mergeSameReceipt(current, incoming) {
    const older = incoming.acceptedAtMs < current.acceptedAtMs ? incoming : current;
    const newer = older === current ? incoming : current;
    const merged = {
      version: RECEIPT_VERSION,
      hostId: older.hostId,
      sessionId: older.sessionId,
      runId: older.runId,
      acceptedAtMs: older.acceptedAtMs,
      acceptedAt: older.acceptedAt,
    };
    for (const [field] of OPTIONAL_TEXT_FIELDS) {
      const value = older[field] || newer[field];
      if (value) merged[field] = value;
    }
    if (older.idempotentReplay === true || newer.idempotentReplay === true) {
      merged.idempotentReplay = true;
    }
    return merged;
  }

  function mergeLaunchReceipts(...groups) {
    const merged = new Map();
    for (const group of groups) {
      const values = Array.isArray(group) ? group : group == null ? [] : [group];
      for (const input of values) {
        const receipt = requireLaunchReceipt(input, { validateAge: false });
        const key = receiptKey(receipt);
        const current = merged.get(key);
        merged.set(key, current ? mergeSameReceipt(current, receipt) : receipt);
      }
    }
    return [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, receipt]) => receipt);
  }

  function emptyLedgerResult() {
    return {
      ok: true,
      value: { version: LEDGER_VERSION, receipts: [] },
      ledger: { version: LEDGER_VERSION, receipts: [] },
      rejected: [],
    };
  }

  function sortAndLimitReceipts(receipts, maxEntries = DEFAULT_MAX_LEDGER_ENTRIES) {
    return mergeLaunchReceipts(receipts)
      .sort((left, right) => (
        right.acceptedAtMs - left.acceptedAtMs
        || receiptKey(left).localeCompare(receiptKey(right))
      ))
      .slice(0, maxEntries);
  }

  function decodeLaunchLedger(input, options = {}) {
    if (input == null || input === '') return emptyLedgerResult();
    const parsed = parseJson(input);
    if (!parsed.ok) return parsed;
    const legacyArray = Array.isArray(parsed.value);
    const source = legacyArray
      ? { version: LEDGER_VERSION, receipts: parsed.value }
      : parsed.value;
    if (!isRecord(source)) return { ok: false, error: 'ledger-record-required' };
    if (source.version !== LEDGER_VERSION) {
      return { ok: false, error: 'unsupported-ledger-version' };
    }
    if (!Array.isArray(source.receipts)) {
      return { ok: false, error: 'ledger-receipts-required' };
    }

    const now = optionNow(options);
    const maxEntries = Math.max(
      1,
      Math.floor(nonNegativeNumber(options.maxEntries, DEFAULT_MAX_LEDGER_ENTRIES))
    );
    const accepted = [];
    const rejected = [];
    for (let index = 0; index < source.receipts.length; index += 1) {
      const decoded = decodeLaunchReceipt(source.receipts[index], {
        now,
        maxAgeMs: options.maxAgeMs,
        futureSkewMs: options.futureSkewMs,
      });
      if (decoded.ok) accepted.push(decoded.value);
      else rejected.push({ index, error: decoded.error });
    }
    const merged = mergeLaunchReceipts(accepted);
    const receipts = sortAndLimitReceipts(merged, maxEntries);
    if (merged.length > receipts.length) {
      rejected.push({
        error: 'entry-cap-exceeded',
        count: merged.length - receipts.length,
      });
    }
    const ledger = { version: LEDGER_VERSION, receipts };
    const comparableSource = { version: LEDGER_VERSION, receipts: source.receipts };
    const changed = legacyArray
      || rejected.length > 0
      || JSON.stringify(comparableSource) !== JSON.stringify(ledger);
    return { ok: true, value: ledger, ledger, rejected, changed };
  }

  function requireLaunchLedger(input) {
    const decoded = decodeLaunchLedger(input);
    if (decoded.ok) return decoded.value;
    const error = new TypeError(`Invalid managed launch ledger: ${decoded.error}`);
    error.code = decoded.error;
    throw error;
  }

  function encodeLaunchLedger(receipts, options = {}) {
    const maxEntries = Math.max(
      1,
      Math.floor(nonNegativeNumber(options.maxEntries, DEFAULT_MAX_LEDGER_ENTRIES))
    );
    return JSON.stringify({
      version: LEDGER_VERSION,
      receipts: sortAndLimitReceipts(receipts, maxEntries),
    });
  }

  function mergeLaunchLedger(current, incoming, options = {}) {
    const currentLedger = requireLaunchLedger(current);
    const maxEntries = Math.max(
      1,
      Math.floor(nonNegativeNumber(options.maxEntries, DEFAULT_MAX_LEDGER_ENTRIES))
    );
    return {
      version: LEDGER_VERSION,
      receipts: sortAndLimitReceipts(
        mergeLaunchReceipts(currentLedger.receipts, incoming),
        maxEntries
      ),
    };
  }

  function positiveNumber(value, fallback, allowZero = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    if (allowZero ? number < 0 : number <= 0) return fallback;
    return number;
  }

  function normalizedStatus(result) {
    return typeof launchApi.normalizeLaunchObservationStatus === 'function'
      ? launchApi.normalizeLaunchObservationStatus(result?.status) || 'indeterminate'
      : boundedText(result?.status, 120)?.toLowerCase() || 'indeterminate';
  }

  function terminalObservation(result) {
    return typeof launchApi.isTerminalLaunchObservation === 'function'
      ? launchApi.isTerminalLaunchObservation(result)
      : result?.terminal === true;
  }

  function authenticationFailure(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    if (status === 401) return true;
    const code = String(error?.code || error?.body?.code || '').trim().toLowerCase();
    return error?.body?.authRequired === true
      || code === 'authentication_required'
      || code === 'auth_required'
      || code === 'unauthorized';
  }

  function createManagedSessionLaunchCoordinator(options = {}) {
    if (typeof options.readLedger !== 'function') {
      throw new TypeError('readLedger dependency is required');
    }
    if (typeof options.writeLedger !== 'function' && typeof options.mutateLedger !== 'function') {
      throw new TypeError('writeLedger or atomic mutateLedger dependency is required');
    }
    if (typeof options.observe !== 'function') {
      throw new TypeError('observe dependency is required');
    }

    const now = typeof options.now === 'function' ? options.now : Date.now;
    const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
    const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
    const withLedgerLock = typeof options.withLedgerLock === 'function'
      ? options.withLedgerLock
      : null;
    const ledgerLockName = boundedText(options.ledgerLockName, 512)
      || DEFAULT_LEDGER_LOCK_NAME;
    const leaseMs = positiveNumber(options.leaseMs, DEFAULT_LEASE_MS);
    const initialBackoffMs = positiveNumber(
      options.initialBackoffMs,
      DEFAULT_INITIAL_BACKOFF_MS,
      true
    );
    const maxBackoffMs = Math.max(
      initialBackoffMs,
      positiveNumber(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS, true)
    );
    const backoffMultiplier = positiveNumber(
      options.backoffMultiplier,
      DEFAULT_BACKOFF_MULTIPLIER
    );
    const maxWriteAttempts = Math.max(1, Math.floor(positiveNumber(options.maxWriteAttempts, 4)));
    const maxReceiptAgeMs = nonNegativeNumber(
      options.maxReceiptAgeMs,
      DEFAULT_RECEIPT_MAX_AGE_MS
    );
    const receiptFutureSkewMs = nonNegativeNumber(
      options.receiptFutureSkewMs,
      DEFAULT_RECEIPT_FUTURE_SKEW_MS
    );
    const maxLedgerEntries = Math.max(
      1,
      Math.floor(nonNegativeNumber(options.maxLedgerEntries, DEFAULT_MAX_LEDGER_ENTRIES))
    );
    const allowSingleContext = options.allowSingleContext === true;
    const trackers = new Map();
    const completed = new Map();
    const terminalHandled = new Set();
    let mutationQueue = Promise.resolve();
    let disposed = false;
    let unsubscribe = null;

    function safeNow() {
      const value = Number(now());
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    }

    function reportError(error, context) {
      if (typeof options.onError !== 'function') return;
      try {
        options.onError(error, context);
      } catch (_) {
        // Diagnostics must not change launch lifecycle behavior.
      }
    }

    async function readDecodedSnapshot() {
      const raw = await options.readLedger();
      const decoded = decodeLaunchLedger(raw, {
        now: safeNow(),
        maxAgeMs: maxReceiptAgeMs,
        futureSkewMs: receiptFutureSkewMs,
        maxEntries: maxLedgerEntries,
      });
      if (!decoded.ok) {
        const error = new Error(`Managed launch ledger decode failed: ${decoded.error}`);
        error.code = decoded.error;
        throw error;
      }
      return { raw, decoded };
    }

    async function readSnapshot() {
      return (await readDecodedSnapshot()).decoded.value;
    }

    function missingCrossTabLockError() {
      const error = new Error(
        'This browser cannot safely coordinate Session starts across tabs because Web Locks are unavailable.'
      );
      error.code = 'cross-tab-lock-unavailable';
      return error;
    }

    function serializeMutation(operation) {
      const run = () => {
        if (withLedgerLock) return withLedgerLock(ledgerLockName, operation);
        if (allowSingleContext) return operation();
        throw missingCrossTabLockError();
      };
      const result = mutationQueue.then(run, run);
      mutationQueue = result.catch(() => {});
      return result;
    }

    async function sanitizeLedger() {
      if (typeof options.mutateLedger === 'function') {
        return options.mutateLedger((raw) => {
          const decoded = decodeLaunchLedger(raw, { now: safeNow(), maxAgeMs: maxReceiptAgeMs, futureSkewMs: receiptFutureSkewMs, maxEntries: maxLedgerEntries });
          if (!decoded.ok) throw Object.assign(new Error(`Managed launch ledger decode failed: ${decoded.error}`), { code: decoded.error });
          return { raw: encodeLaunchLedger(decoded.value.receipts, { maxEntries: maxLedgerEntries }), result: decoded.value };
        });
      }
      return serializeMutation(async () => {
        const { decoded } = await readDecodedSnapshot();
        if (decoded.changed) {
          await options.writeLedger(encodeLaunchLedger(decoded.value.receipts, {
            maxEntries: maxLedgerEntries,
          }));
        }
        return decoded.value;
      });
    }

    async function mergeReceipts(receiptsInput) {
      const values = Array.isArray(receiptsInput) ? receiptsInput : [receiptsInput];
      const incoming = sortAndLimitReceipts(values.filter(Boolean).map((receipt) => (
        requireLaunchReceipt(receipt, {
          now: safeNow(),
          maxAgeMs: maxReceiptAgeMs,
          futureSkewMs: receiptFutureSkewMs,
        })
      )), maxLedgerEntries);
      if (!incoming.length) return readSnapshot();
      if (typeof options.mutateLedger === 'function') {
        return options.mutateLedger((raw) => {
          const decoded = decodeLaunchLedger(raw, { now: safeNow(), maxAgeMs: maxReceiptAgeMs, futureSkewMs: receiptFutureSkewMs, maxEntries: maxLedgerEntries });
          if (!decoded.ok) throw Object.assign(new Error(`Managed launch ledger decode failed: ${decoded.error}`), { code: decoded.error });
          const receipts = sortAndLimitReceipts(mergeLaunchReceipts(decoded.value.receipts, incoming), maxLedgerEntries);
          return { raw: encodeLaunchLedger(receipts, { maxEntries: maxLedgerEntries }), result: { version: LEDGER_VERSION, receipts } };
        });
      }
      return serializeMutation(async () => {
        let desired = sortAndLimitReceipts(
          mergeLaunchReceipts((await readSnapshot()).receipts, incoming),
          maxLedgerEntries
        );
        for (let attempt = 0; attempt < maxWriteAttempts; attempt += 1) {
          await options.writeLedger(encodeLaunchLedger(desired, { maxEntries: maxLedgerEntries }));
          const observed = await readSnapshot();
          const reconciled = sortAndLimitReceipts(
            mergeLaunchReceipts(observed.receipts, desired),
            maxLedgerEntries
          );
          const observedKeys = new Set(observed.receipts.map(receiptKey));
          const complete = reconciled.every((receipt) => observedKeys.has(receiptKey(receipt)));
          if (complete) return observed;
          desired = reconciled;
        }
        const error = new Error('Managed launch ledger merge could not be verified');
        error.code = 'ledger-merge-unverified';
        throw error;
      });
    }

    async function removeReceipt(receiptOrKey) {
      const key = typeof receiptOrKey === 'string' ? receiptOrKey : receiptKey(receiptOrKey);
      if (typeof options.mutateLedger === 'function') {
        return options.mutateLedger((raw) => {
          const decoded = decodeLaunchLedger(raw, { now: safeNow(), maxAgeMs: maxReceiptAgeMs, futureSkewMs: receiptFutureSkewMs, maxEntries: maxLedgerEntries });
          if (!decoded.ok) throw Object.assign(new Error(`Managed launch ledger decode failed: ${decoded.error}`), { code: decoded.error });
          const receipts = decoded.value.receipts.filter((receipt) => receiptKey(receipt) !== key);
          return {
            raw: encodeLaunchLedger(receipts, { maxEntries: maxLedgerEntries }),
            completedReceipts: decoded.value.receipts.filter((receipt) => receiptKey(receipt) === key),
            result: { version: LEDGER_VERSION, receipts, removed: receipts.length !== decoded.value.receipts.length },
          };
        });
      }
      return serializeMutation(async () => {
        const current = await readSnapshot();
        const retained = current.receipts.filter((receipt) => receiptKey(receipt) !== key);
        const removed = retained.length !== current.receipts.length;
        await options.writeLedger(encodeLaunchLedger(retained, { maxEntries: maxLedgerEntries }));
        return { version: LEDGER_VERSION, receipts: retained, removed };
      });
    }

    function notifyUpdate(result, tracker) {
      if (typeof options.onUpdate !== 'function') return;
      try {
        options.onUpdate(result, tracker.handle);
      } catch (error) {
        reportError(error, { phase: 'on-update', key: tracker.key });
      }
    }

    function clearTrackerTimer(tracker) {
      if (tracker.timer == null) return;
      clearTimer(tracker.timer);
      tracker.timer = null;
    }

    function unresolvedResult(tracker, reason, extra = {}) {
      return {
        status: 'unresolved',
        reason,
        terminal: false,
        key: tracker.key,
        receipt: tracker.receipt,
        attempts: tracker.attempt,
        ...extra,
      };
    }

    function settleUnresolved(tracker, reason, extra = {}) {
      if (tracker.settled) return;
      tracker.settled = true;
      clearTrackerTimer(tracker);
      trackers.delete(tracker.key);
      const result = unresolvedResult(tracker, reason, extra);
      tracker.result = result;
      notifyUpdate(result, tracker);
      tracker.resolveDone(result);
    }

    async function settleTerminal(tracker, observation) {
      if (tracker.settled) return;
      tracker.settled = true;
      clearTrackerTimer(tracker);
      trackers.delete(tracker.key);
      const result = {
        ...observation,
        status: normalizedStatus(observation),
        terminal: true,
        key: tracker.key,
        receipt: tracker.receipt,
        attempts: tracker.attempt,
      };
      tracker.result = result;
      completed.set(tracker.key, tracker.handle);
      let terminalClaimed = false;
      try {
        const removal = await removeReceipt(tracker.key);
        terminalClaimed = removal.removed === true;
      } catch (error) {
        result.persistenceError = error;
        reportError(error, { phase: 'remove-terminal-receipt', key: tracker.key });
      }
      result.receiptClaimed = terminalClaimed;
      notifyUpdate(result, tracker);
      if (!terminalHandled.has(tracker.key)) {
        terminalHandled.add(tracker.key);
        if (typeof options.onTerminal === 'function') {
          try {
            await options.onTerminal(result, tracker.handle);
          } catch (error) {
            reportError(error, { phase: 'on-terminal', key: tracker.key });
          }
        }
      }
      tracker.resolveDone(result);
    }

    function remainingLease(tracker) {
      return tracker.deadlineAtMs - safeNow();
    }

    function computedBackoff(tracker, observation) {
      const requested = Number(observation?.retryAfterMs);
      if (Number.isFinite(requested) && requested >= 0) {
        return Math.min(maxBackoffMs, requested);
      }
      const exponential = initialBackoffMs * (backoffMultiplier ** Math.max(0, tracker.attempt - 1));
      return Math.min(maxBackoffMs, Math.max(0, Math.round(exponential)));
    }

    function schedule(tracker, delayMs) {
      if (disposed || tracker.settled || tracker.paused || tracker.inFlight) return;
      clearTrackerTimer(tracker);
      const remaining = remainingLease(tracker);
      if (remaining <= 0) {
        settleUnresolved(tracker, 'observation-lease-expired');
        return;
      }
      const delay = Math.min(Math.max(0, Number(delayMs) || 0), remaining);
      tracker.timer = setTimer(() => {
        tracker.timer = null;
        void poll(tracker);
      }, delay);
    }

    async function poll(tracker) {
      if (disposed || tracker.settled || tracker.paused || tracker.inFlight) return;
      if (remainingLease(tracker) <= 0) {
        settleUnresolved(tracker, 'observation-lease-expired');
        return;
      }
      tracker.inFlight = true;
      tracker.attempt += 1;
      const generation = tracker.generation;
      let observation;
      try {
        observation = await options.observe(tracker.receipt, {
          key: tracker.key,
          attempt: tracker.attempt,
          leaseRemainingMs: Math.max(0, remainingLease(tracker)),
        });
      } catch (error) {
        const authRequired = authenticationFailure(error);
        observation = {
          status: 'indeterminate',
          reason: authRequired ? 'authentication-required' : 'observation-error',
          terminal: false,
          error,
        };
        reportError(error, { phase: 'observe', key: tracker.key, attempt: tracker.attempt });
        if (authRequired) {
          tracker.lastObservation = observation;
          notifyUpdate(observation, tracker);
          pauseTracker(tracker, 'authentication-required');
        }
      } finally {
        tracker.inFlight = false;
      }
      if (tracker.settled || disposed) return;
      if (tracker.paused || generation !== tracker.generation) {
        if (!tracker.paused) schedule(tracker, 0);
        return;
      }
      const normalized = isRecord(observation)
        ? { ...observation, status: normalizedStatus(observation) }
        : { status: 'indeterminate', reason: 'invalid-observation', terminal: false };
      tracker.lastObservation = normalized;
      notifyUpdate(normalized, tracker);
      if (terminalObservation(normalized)) {
        await settleTerminal(tracker, normalized);
        return;
      }
      schedule(tracker, computedBackoff(tracker, normalized));
    }

    function normalizedPauseReason(reason) {
      return boundedText(reason, 120) || 'manual';
    }

    function pauseTracker(tracker, reason = 'manual') {
      if (!tracker || tracker.settled) return false;
      const normalizedReason = normalizedPauseReason(reason);
      if (tracker.pauseReasons.has(normalizedReason)) return false;
      tracker.pauseReasons.add(normalizedReason);
      tracker.pauseReason = normalizedReason === 'authentication-required'
        ? normalizedReason
        : tracker.pauseReason || normalizedReason;
      if (tracker.paused) return true;
      tracker.paused = true;
      tracker.pauseStartedAtMs = safeNow();
      tracker.generation += 1;
      clearTrackerTimer(tracker);
      return true;
    }

    function resumeTracker(tracker, reason = 'manual') {
      if (!tracker || tracker.settled || !tracker.paused) return false;
      const normalizedReason = normalizedPauseReason(reason);
      if (!tracker.pauseReasons.delete(normalizedReason)) return false;
      if (tracker.pauseReasons.size > 0) {
        tracker.pauseReason = tracker.pauseReasons.has('authentication-required')
          ? 'authentication-required'
          : tracker.pauseReasons.values().next().value;
        return true;
      }
      const resumedAtMs = safeNow();
      tracker.deadlineAtMs += Math.max(0, resumedAtMs - tracker.pauseStartedAtMs);
      tracker.pauseStartedAtMs = null;
      tracker.paused = false;
      tracker.pauseReason = null;
      tracker.generation += 1;
      schedule(tracker, 0);
      return true;
    }

    function publicState(tracker) {
      if (!tracker) return null;
      return {
        key: tracker.key,
        receipt: tracker.receipt,
        attempt: tracker.attempt,
        paused: tracker.paused,
        pauseReason: tracker.pauseReason,
        pauseReasons: [...tracker.pauseReasons],
        settled: tracker.settled,
        inFlight: tracker.inFlight,
        lastObservation: tracker.lastObservation,
        result: tracker.result,
        persistenceError: tracker.persistenceError || null,
        leaseRemainingMs: tracker.settled ? 0 : Math.max(0, remainingLease(tracker)),
      };
    }

    function ensureTrack(receiptInput, trackOptions = {}) {
      if (disposed) throw new Error('Managed launch coordinator is disposed');
      const receipt = requireLaunchReceipt(receiptInput, {
        now: safeNow(),
        maxAgeMs: maxReceiptAgeMs,
        futureSkewMs: receiptFutureSkewMs,
      });
      const key = receiptKey(receipt);
      const activeTracker = trackers.get(key);
      const existing = activeTracker?.handle || completed.get(key);
      if (existing) return existing;

      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const tracker = {
        key,
        receipt,
        attempt: 0,
        deadlineAtMs: trackOptions.recheck === true
          ? safeNow() + leaseMs
          : receipt.acceptedAtMs + leaseMs,
        pauseStartedAtMs: null,
        paused: false,
        pauseReason: null,
        pauseReasons: new Set(),
        settled: false,
        inFlight: false,
        generation: 0,
        timer: null,
        lastObservation: null,
        result: null,
        persistenceError: null,
        resolveDone,
        handle: null,
      };
      const handle = {
        key,
        receipt,
        done,
        pause: (reason) => pauseTracker(tracker, reason),
        resume: (reason) => resumeTracker(tracker, reason),
        getState: () => publicState(tracker),
      };
      tracker.handle = handle;
      trackers.set(key, tracker);
      const persistReceipt = trackOptions.persist !== false;
      const ready = (persistReceipt ? mergeReceipts([receipt]) : Promise.resolve())
        .then(() => {
          schedule(tracker, 0);
          return handle;
        })
        .catch((error) => {
          reportError(error, { phase: 'persist-receipt', key });
          tracker.persistenceError = error;
          notifyUpdate({
            status: 'indeterminate',
            reason: 'receipt-persistence-failed',
            terminal: false,
            error,
          }, tracker);
          schedule(tracker, 0);
          return handle;
        });
      Object.defineProperty(handle, 'ready', {
        configurable: false,
        enumerable: true,
        value: ready,
        writable: false,
      });
      return Object.freeze(handle);
    }

    async function restore({ track = true } = {}) {
      const ledger = await sanitizeLedger();
      if (track) ledger.receipts.forEach((receipt) => ensureTrack(receipt, { persist: false }));
      return ledger;
    }

    function pause(key, reason = 'manual') {
      if (key != null) return pauseTracker(trackers.get(String(key)), reason);
      let changed = false;
      trackers.forEach((tracker) => {
        changed = pauseTracker(tracker, reason) || changed;
      });
      return changed;
    }

    function resume(key, reason = 'manual') {
      if (key != null) return resumeTracker(trackers.get(String(key)), reason);
      let changed = false;
      trackers.forEach((tracker) => {
        changed = resumeTracker(tracker, reason) || changed;
      });
      return changed;
    }

    function handleExternalLedgerChange(raw) {
      const decoded = decodeLaunchLedger(raw, {
        now: safeNow(),
        maxAgeMs: maxReceiptAgeMs,
        futureSkewMs: receiptFutureSkewMs,
        maxEntries: maxLedgerEntries,
      });
      if (!decoded.ok) {
        const error = new Error(`External managed launch ledger is invalid: ${decoded.error}`);
        error.code = decoded.error;
        reportError(error, { phase: 'external-ledger-change' });
        return decoded;
      }
      if (typeof options.onLedgerChange === 'function') {
        try {
          options.onLedgerChange(decoded.value);
        } catch (error) {
          reportError(error, { phase: 'on-ledger-change' });
        }
      }
      return decoded;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      trackers.forEach((tracker) => {
        tracker.generation += 1;
        clearTrackerTimer(tracker);
        settleUnresolved(tracker, 'coordinator-disposed');
      });
      trackers.clear();
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
        } catch (error) {
          reportError(error, { phase: 'unsubscribe-ledger-change' });
        }
      }
      unsubscribe = null;
    }

    if (typeof options.subscribeLedgerChange === 'function') {
      unsubscribe = options.subscribeLedgerChange(handleExternalLedgerChange);
    }

    return Object.freeze({
      crossTabLockEnabled: Boolean(withLedgerLock || options.mutateLedger),
      coordinationMode: options.mutateLedger ? 'atomic-storage' : withLedgerLock
        ? 'cross-tab-lock'
        : allowSingleContext
          ? 'single-context-test'
          : 'unavailable',
      ensureTrack,
      recheck: (receipt) => ensureTrack(receipt, { recheck: true }),
      restore,
      sanitizeLedger,
      readLedger: readSnapshot,
      mergeReceipts,
      removeReceipt,
      pause,
      resume,
      resumeAuthentication: () => resume(null, 'authentication-required'),
      getTracker: (key) => trackers.get(String(key))?.handle || completed.get(String(key)) || null,
      handleExternalLedgerChange,
      dispose,
    });
  }

  return Object.freeze({
    RECEIPT_VERSION,
    LEDGER_VERSION,
    DEFAULT_LEASE_MS,
    DEFAULT_RECEIPT_MAX_AGE_MS,
    DEFAULT_RECEIPT_FUTURE_SKEW_MS,
    DEFAULT_MAX_LEDGER_ENTRIES,
    decodeLaunchReceipt,
    requireLaunchReceipt,
    decodeLaunchLedger,
    encodeLaunchLedger,
    mergeLaunchLedger,
    mergeLaunchReceipts,
    receiptKey,
    createManagedSessionLaunchCoordinator,
  });
}));
