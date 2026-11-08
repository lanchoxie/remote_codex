const assert = require('assert');
const {
  RECEIPT_VERSION,
  LEDGER_VERSION,
  decodeLaunchReceipt,
  decodeLaunchLedger,
  encodeLaunchLedger,
  mergeLaunchReceipts,
  receiptKey,
  createManagedSessionLaunchCoordinator,
} = require('../apps/mobile-web/public/managed-session-launch-coordinator');

const ACCEPTED_AT_MS = Date.parse('2026-08-16T12:00:00.000Z');

function decodeFixtureLedger(input, options = {}) {
  return decodeLaunchLedger(input, { now: ACCEPTED_AT_MS, ...options });
}

function receipt(suffix, overrides = {}) {
  return {
    version: RECEIPT_VERSION,
    hostId: `host-${suffix}`,
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    acceptedAtMs: ACCEPTED_AT_MS,
    acceptedAt: new Date(ACCEPTED_AT_MS).toISOString(),
    ...overrides,
  };
}

function createMutex() {
  let tail = Promise.resolve();
  return (_name, operation) => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
}

function createStorage(initial = null) {
  let raw = initial;
  return {
    read: async () => raw,
    write: async (value) => {
      await Promise.resolve();
      raw = value;
    },
    value: () => raw,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 6) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

class FakeClock {
  constructor(now = ACCEPTED_AT_MS) {
    this.nowMs = now;
    this.nextId = 1;
    this.tasks = new Map();
  }

  now = () => this.nowMs;

  setTimer = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.nowMs + Math.max(0, Number(delay) || 0), callback });
    return id;
  };

  clearTimer = (id) => {
    this.tasks.delete(id);
  };

  async advance(ms) {
    const target = this.nowMs + ms;
    while (true) {
      let selected = null;
      for (const [id, task] of this.tasks) {
        if (task.at > target) continue;
        if (!selected || task.at < selected.task.at || (task.at === selected.task.at && id < selected.id)) {
          selected = { id, task };
        }
      }
      if (!selected) break;
      this.tasks.delete(selected.id);
      this.nowMs = selected.task.at;
      selected.task.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.nowMs = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

function coordinatorOptions(storage, clock, overrides = {}) {
  return {
    readLedger: storage.read,
    writeLedger: storage.write,
    observe: async () => ({ status: 'pending', terminal: false }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    leaseMs: 100,
    initialBackoffMs: 10,
    maxBackoffMs: 40,
    backoffMultiplier: 2,
    allowSingleContext: true,
    ...overrides,
  };
}

async function testStrictReceiptDecode() {
  const old = receipt('old', {
    acceptedAtMs: Date.parse('2020-01-01T00:00:00.000Z'),
    acceptedAt: '2020-01-01T00:00:00.000Z',
    apiKey: 'must-not-survive',
    requestBody: { secret: true },
    rebindTargetKind: 'profile',
    rebindProfileId: 'profile-b',
    rebindProvider: 'MineMine',
    rebindProviderKind: 'custom',
    rebindBaseUrl: 'https://gateway.example/v1?region=x&token=must-not-survive#private',
  });
  const decodeOptions = { now: old.acceptedAtMs + 1_000 };
  const decoded = decodeLaunchReceipt(old, decodeOptions);
  assert.strictEqual(decoded.ok, true);
  assert.strictEqual(decoded.value.acceptedAtMs, Date.parse('2020-01-01T00:00:00.000Z'));
  assert.strictEqual(decoded.value.acceptedAt, '2020-01-01T00:00:00.000Z');
  assert(!JSON.stringify(decoded.value).includes('must-not-survive'));
  assert(!Object.prototype.hasOwnProperty.call(decoded.value, 'requestBody'));
  assert.strictEqual(decoded.value.rebindTargetKind, 'profile');
  assert.strictEqual(decoded.value.rebindProfileId, 'profile-b');
  assert.strictEqual(decoded.value.rebindProvider, 'MineMine');
  assert.strictEqual(decoded.value.rebindProviderKind, 'custom');
  assert.strictEqual(decoded.value.rebindBaseUrl, 'https://gateway.example/v1?region=x');
  assert(!JSON.stringify(decoded.value).includes('token='));
  const duplicateMerge = mergeLaunchReceipts([decoded.value], [decoded.value])[0];
  assert.strictEqual(duplicateMerge.rebindProvider, 'MineMine');
  assert.strictEqual(duplicateMerge.rebindBaseUrl, 'https://gateway.example/v1?region=x');
  const serializedDuplicate = encodeLaunchLedger([duplicateMerge]);
  assert(serializedDuplicate.includes('https://gateway.example/v1?region=x'));
  assert(!serializedDuplicate.includes('must-not-survive'));
  assert(!serializedDuplicate.includes('token='));

  for (const [name, value, expected] of [
    ['version', { ...old, version: 2 }, 'unsupported-receipt-version'],
    ['acceptedAt', { ...old, acceptedAtMs: undefined, acceptedAt: undefined }, 'accepted-at-required'],
    ['host', { ...old, hostId: '' }, 'host-id-required'],
    ['session', { ...old, sessionId: null }, 'session-id-required'],
    ['run', { ...old, runId: undefined }, 'run-id-required'],
  ]) {
    const invalid = decodeLaunchReceipt(value, decodeOptions);
    assert.strictEqual(invalid.ok, false, `${name} must be validated`);
    assert.strictEqual(invalid.error, expected);
  }

  const mismatch = decodeLaunchReceipt({
    ...old,
    acceptedAt: '2020-01-01T00:00:01.000Z',
  }, decodeOptions);
  assert.strictEqual(mismatch.ok, false);
  assert.strictEqual(mismatch.error, 'accepted-at-mismatch');
  assert.doesNotThrow(() => decodeLaunchReceipt({
    ...old,
    acceptedAtMs: Number.MAX_VALUE,
    acceptedAt: undefined,
  }, decodeOptions));
  assert.strictEqual(decodeLaunchReceipt({
    ...old,
    acceptedAtMs: Number.MAX_VALUE,
    acceptedAt: undefined,
  }, decodeOptions).ok, false);
  assert.strictEqual(decodeLaunchReceipt({ ...old, version: '1' }, decodeOptions).ok, false);
  assert.strictEqual(decodeLaunchReceipt({
    ...old,
    acceptedAtMs: old.acceptedAtMs + 10_000,
    acceptedAt: new Date(old.acceptedAtMs + 10_000).toISOString(),
  }, { now: old.acceptedAtMs, futureSkewMs: 1_000 }).error, 'accepted-at-in-future');
  assert.strictEqual(decodeLaunchReceipt(old, {
    now: old.acceptedAtMs + 10_000,
    maxAgeMs: 1_000,
  }).error, 'receipt-expired');
}

async function testLedgerStrictnessAndConcurrentMerge() {
  assert.strictEqual(decodeFixtureLedger(null).ok, true);
  assert.strictEqual(
    decodeFixtureLedger(JSON.stringify({ version: LEDGER_VERSION + 1, receipts: [] })).ok,
    false
  );
  const invalidReceiptLedger = decodeFixtureLedger(JSON.stringify({
    version: LEDGER_VERSION,
    receipts: [
      receipt('valid'),
      { ...receipt('invalid'), acceptedAt: undefined, acceptedAtMs: undefined },
    ],
  }));
  assert.strictEqual(invalidReceiptLedger.ok, true);
  assert.strictEqual(invalidReceiptLedger.value.receipts.length, 1);
  assert.strictEqual(invalidReceiptLedger.rejected[0].error, 'accepted-at-required');

  const storage = createStorage();
  const lock = createMutex();
  const clock = new FakeClock();
  const first = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    withLedgerLock: lock,
  }));
  const second = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    withLedgerLock: lock,
  }));
  await Promise.all([
    first.mergeReceipts([receipt('a')]),
    second.mergeReceipts([receipt('b')]),
  ]);
  const ledger = decodeFixtureLedger(storage.value());
  assert.strictEqual(ledger.ok, true);
  assert.deepStrictEqual(
    ledger.value.receipts.map((item) => item.sessionId).sort(),
    ['session-a', 'session-b'],
    'a merge-write under the injected cross-tab lock must retain the other tab receipt'
  );
  assert.strictEqual(first.crossTabLockEnabled, true);
  first.dispose();
  second.dispose();
}

async function testLeaseExpiryPreservesReceipt() {
  const storage = createStorage();
  const clock = new FakeClock();
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock));
  const handle = coordinator.ensureTrack(receipt('lease'));
  await handle.ready;
  await clock.advance(100);
  const result = await handle.done;
  assert.strictEqual(result.status, 'unresolved');
  assert.strictEqual(result.terminal, false);
  assert.strictEqual(result.reason, 'observation-lease-expired');
  const ledger = decodeFixtureLedger(storage.value());
  assert.strictEqual(ledger.value.receipts.length, 1);
  assert.strictEqual(receiptKey(ledger.value.receipts[0]), handle.key);
  coordinator.dispose();
}

async function testStaleReceiptDoesNotReceiveANewLeaseOrigin() {
  const storage = createStorage();
  const clock = new FakeClock();
  const stale = receipt('stale', {
    acceptedAtMs: ACCEPTED_AT_MS - 1_000,
    acceptedAt: new Date(ACCEPTED_AT_MS - 1_000).toISOString(),
  });
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock));
  const handle = coordinator.ensureTrack(stale);
  await handle.ready;
  const result = await handle.done;
  assert.strictEqual(result.status, 'unresolved');
  assert.strictEqual(result.reason, 'observation-lease-expired');
  const persisted = decodeFixtureLedger(storage.value()).value.receipts[0];
  assert.strictEqual(persisted.acceptedAtMs, stale.acceptedAtMs);
  coordinator.dispose();
}

async function testTrackerAndTerminalHandlerAreSingletons() {
  const storage = createStorage();
  const clock = new FakeClock();
  let observations = 0;
  let terminalCalls = 0;
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    observe: async () => {
      observations += 1;
      return { status: 'live', reason: 'exact-runtime-live' };
    },
    onTerminal: async () => {
      terminalCalls += 1;
    },
  }));
  const first = coordinator.ensureTrack(receipt('singleton'));
  const second = coordinator.ensureTrack(receipt('singleton'));
  assert.strictEqual(first, second, 'duplicate ensureTrack must return the existing tracker');
  await first.ready;
  await clock.advance(0);
  const result = await first.done;
  assert.strictEqual(result.status, 'live');
  assert.strictEqual(observations, 1);
  assert.strictEqual(terminalCalls, 1);
  assert.strictEqual(coordinator.ensureTrack(receipt('singleton')), first);
  await clock.advance(1_000);
  assert.strictEqual(observations, 1);
  assert.strictEqual(terminalCalls, 1, 'the terminal handler must be invoked at most once per key');
  assert.strictEqual(decodeFixtureLedger(storage.value()).value.receipts.length, 0);
  coordinator.dispose();
}

async function testTerminalHandlerClaimIsSingletonAcrossCoordinators() {
  const storage = createStorage(encodeLaunchLedger([receipt('cross-tab-terminal')]));
  const clock = new FakeClock();
  const lock = createMutex();
  const terminalResults = [];
  const shared = {
    withLedgerLock: lock,
    observe: async () => ({ status: 'live' }),
    onTerminal: async (result) => {
      terminalResults.push(result);
    },
  };
  const first = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, shared));
  const second = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, shared));
  const firstHandle = first.ensureTrack(receipt('cross-tab-terminal'));
  const secondHandle = second.ensureTrack(receipt('cross-tab-terminal'));
  await Promise.all([firstHandle.ready, secondHandle.ready]);
  await clock.advance(0);
  await Promise.all([firstHandle.done, secondHandle.done]);
  assert.strictEqual(
    terminalResults.length,
    2,
    'every tab must receive its own terminal projection callback'
  );
  assert.strictEqual(
    terminalResults.filter((result) => result.receiptClaimed === true).length,
    1,
    'only one tab may claim removal of the durable receipt'
  );
  first.dispose();
  second.dispose();
}

async function testPauseResumePreservesReceiptAndLease() {
  const storage = createStorage();
  const clock = new FakeClock();
  let observations = 0;
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    observe: async () => {
      observations += 1;
      return { status: 'pending', terminal: false };
    },
  }));
  const handle = coordinator.ensureTrack(receipt('paused'));
  await handle.ready;
  assert.strictEqual(handle.pause(), true);
  await clock.advance(1_000);
  assert.strictEqual(observations, 0);
  assert.strictEqual(handle.getState().settled, false);
  assert.strictEqual(decodeFixtureLedger(storage.value()).value.receipts.length, 1);
  assert.strictEqual(handle.resume(), true);
  await clock.advance(0);
  assert.strictEqual(observations, 1);
  await clock.advance(100);
  const result = await handle.done;
  assert.strictEqual(result.status, 'unresolved');
  assert.strictEqual(decodeFixtureLedger(storage.value()).value.receipts.length, 1);
  coordinator.dispose();
}

async function testAuthenticationFailurePausesAndResumesSameReceipt() {
  const storage = createStorage();
  const clock = new FakeClock();
  const firstObservation = deferred();
  let observations = 0;
  const updates = [];
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    observe: async () => {
      observations += 1;
      if (observations === 1) return firstObservation.promise;
      return { status: 'live', reason: 'exact-runtime-live' };
    },
    onUpdate: (update) => updates.push(update),
  }));
  const accepted = receipt('auth-recovery');
  const handle = coordinator.ensureTrack(accepted);
  await handle.ready;
  await clock.advance(0);
  assert.strictEqual(handle.getState().inFlight, true);

  const authError = new Error('Relay login is required');
  authError.status = 401;
  authError.body = { authRequired: true };
  firstObservation.reject(authError);
  await flushMicrotasks();
  assert.strictEqual(handle.getState().paused, true);
  assert.strictEqual(handle.getState().pauseReason, 'authentication-required');
  assert.deepStrictEqual(handle.getState().pauseReasons, ['authentication-required']);
  assert.strictEqual(updates.at(-1)?.reason, 'authentication-required');
  assert.strictEqual(
    decodeFixtureLedger(storage.value()).value.receipts.length,
    1,
    'authentication must preserve the accepted run receipt'
  );

  await clock.advance(1_000);
  assert.strictEqual(observations, 1, 'paused authentication must not consume observation retries');
  assert.strictEqual(coordinator.pause(), true, 'an independent page pause may coexist with auth');
  assert.strictEqual(
    handle.resume(),
    true,
    'the independent page pause may be cleared'
  );
  assert.strictEqual(
    handle.getState().paused,
    true,
    'an unrelated lifecycle resume must not clear authentication-required'
  );
  await clock.advance(1_000);
  assert.strictEqual(observations, 1);
  assert.strictEqual(coordinator.resumeAuthentication(), true);
  await clock.advance(0);
  const result = await handle.done;
  assert.strictEqual(result.status, 'live');
  assert.strictEqual(observations, 2);
  assert.strictEqual(decodeFixtureLedger(storage.value()).value.receipts.length, 0);
  coordinator.dispose();
}

async function testPersistenceFailureStillTracksInCurrentPage() {
  const clock = new FakeClock();
  let observations = 0;
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions({
    read: async () => null,
    write: async () => {
      throw new Error('storage unavailable');
    },
  }, clock, {
    observe: async () => {
      observations += 1;
      return { status: 'live' };
    },
  }));
  const handle = coordinator.ensureTrack(receipt('memory-only'));
  await handle.ready;
  await clock.advance(0);
  const result = await handle.done;
  assert.strictEqual(result.status, 'live');
  assert.strictEqual(observations, 1);
  assert(handle.getState().persistenceError instanceof Error);
  coordinator.dispose();
}

async function testExpiredReceiptCanBeExplicitlyRechecked() {
  const storage = createStorage();
  const clock = new FakeClock();
  let observations = 0;
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    observe: async () => {
      observations += 1;
      return { status: 'live' };
    },
  }));
  const stale = receipt('manual-recheck', {
    acceptedAtMs: ACCEPTED_AT_MS - 1_000,
    acceptedAt: new Date(ACCEPTED_AT_MS - 1_000).toISOString(),
  });
  const expired = coordinator.ensureTrack(stale);
  await expired.ready;
  assert.strictEqual((await expired.done).reason, 'observation-lease-expired');
  assert.strictEqual(observations, 0);

  const rechecked = coordinator.recheck(stale);
  await rechecked.ready;
  await clock.advance(0);
  assert.strictEqual((await rechecked.done).status, 'live');
  assert.strictEqual(observations, 1);
  coordinator.dispose();
}

async function testSanitizeIsLockedAndPreservesConcurrentReceipt() {
  const valid = receipt('sanitized-valid');
  const invalid = { ...receipt('invalid'), acceptedAtMs: null, acceptedAt: null };
  const storage = createStorage(JSON.stringify([valid, invalid]));
  const clock = new FakeClock();
  const lock = createMutex();
  const first = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    withLedgerLock: lock,
    allowSingleContext: false,
  }));
  const second = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    withLedgerLock: lock,
    allowSingleContext: false,
  }));
  await Promise.all([
    first.restore({ track: false }),
    second.mergeReceipts([receipt('concurrent-valid')]),
  ]);
  const ledger = decodeFixtureLedger(storage.value(), { now: clock.now() });
  assert.strictEqual(ledger.ok, true);
  assert.deepStrictEqual(
    ledger.value.receipts.map((item) => item.sessionId).sort(),
    ['session-concurrent-valid', 'session-sanitized-valid'],
    'locked sanitation must not overwrite a receipt written by another tab'
  );
  assert.strictEqual(ledger.rejected.length, 0);
  first.dispose();
  second.dispose();
}

async function testMutationFailsClosedWithoutCrossTabLock() {
  const storage = createStorage();
  const clock = new FakeClock();
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    allowSingleContext: false,
  }));
  await assert.rejects(
    coordinator.restore({ track: false }),
    (error) => error?.code === 'cross-tab-lock-unavailable'
  );
  await assert.rejects(
    coordinator.mergeReceipts([receipt('no-lock')]),
    (error) => error?.code === 'cross-tab-lock-unavailable'
  );
  assert.strictEqual(storage.value(), null);
  assert.strictEqual(coordinator.coordinationMode, 'unavailable');
  coordinator.dispose();
}

async function testRecoveredTrackerDoesNotReinsertRemovedReceipt() {
  const storage = createStorage();
  const clock = new FakeClock();
  const coordinator = createManagedSessionLaunchCoordinator(coordinatorOptions(storage, clock, {
    observe: async () => ({ status: 'live' }),
  }));
  const handle = coordinator.ensureTrack(receipt('external-recovery'), { persist: false });
  await handle.ready;
  assert.strictEqual(storage.value(), null, 'recovered tracking must not rewrite an externally removed receipt');
  await clock.advance(0);
  assert.strictEqual((await handle.done).status, 'live');
  coordinator.dispose();
}

async function main() {
  await testStrictReceiptDecode();
  await testLedgerStrictnessAndConcurrentMerge();
  await testLeaseExpiryPreservesReceipt();
  await testStaleReceiptDoesNotReceiveANewLeaseOrigin();
  await testTrackerAndTerminalHandlerAreSingletons();
  await testTerminalHandlerClaimIsSingletonAcrossCoordinators();
  await testPauseResumePreservesReceiptAndLease();
  await testAuthenticationFailurePausesAndResumesSameReceipt();
  await testPersistenceFailureStillTracksInCurrentPage();
  await testExpiredReceiptCanBeExplicitlyRechecked();
  await testSanitizeIsLockedAndPreservesConcurrentReceipt();
  await testMutationFailsClosedWithoutCrossTabLock();
  await testRecoveredTrackerDoesNotReinsertRemovedReceipt();
  console.log('managed Session launch coordinator tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
