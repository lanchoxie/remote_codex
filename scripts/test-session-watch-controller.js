const assert = require('assert');
const {
  createSelectedSessionWatchController,
} = require('../apps/mobile-web/public/session-watch-controller');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function session(sessionId, options = {}) {
  return {
    hostId: options.hostId || 'host-a',
    sessionId,
    nativeThreadId: options.nativeThreadId || sessionId,
    conversationKey: options.conversationKey || sessionId,
    live: options.live === true,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function main() {
  let now = 1_000;
  const watchRequests = [];
  const unwatchRequests = [];
  let blockedWatch = null;
  const controller = createSelectedSessionWatchController({
    clientId: 'browser-tab-a',
    viewId: 'primary',
    renewAfterMs: 20_000,
    now: () => now,
    sendWatch: async (request) => {
      watchRequests.push({ ...request });
      if (blockedWatch?.sessionId === request.sessionId) {
        await blockedWatch.gate.promise;
      }
    },
    sendUnwatch: async (request) => {
      unwatchRequests.push({ ...request });
    },
  });

  const historyA = session('history-a');
  await controller.select(historyA);
  assert.strictEqual(controller.confirmedKey, 'host-a::history-a');
  assert.strictEqual(watchRequests.length, 1, 'a selected history-only session must be watched');
  await controller.select({ ...historyA, nativeThreadId: 'history-a-canonical' });
  assert.strictEqual(
    watchRequests.length,
    2,
    'identity enrichment for the same session key must refresh the Host lease'
  );

  const historyB = session('history-b');
  const historyC = session('history-c');
  blockedWatch = { sessionId: historyB.sessionId, gate: deferred() };
  const selectingB = controller.select(historyB);
  await flushMicrotasks();
  assert.strictEqual(watchRequests.at(-1).sessionId, historyB.sessionId, 'B watch should be in flight');
  const selectingC = controller.select(historyC);
  blockedWatch.gate.resolve();
  await Promise.all([selectingB, selectingC]);
  assert.strictEqual(controller.confirmedKey, 'host-a::history-c', 'latest selection must win after a delayed B watch');
  assert.strictEqual(watchRequests.at(-1).sessionId, historyC.sessionId);
  assert.strictEqual(unwatchRequests.length, 0, 'switching selected sessions should use atomic owner replacement');
  assert(
    watchRequests.at(-1).watchRevision > watchRequests.at(-2).watchRevision,
    'watch revisions must be monotonic'
  );

  const watchCountBeforeRenewal = watchRequests.length;
  now += 19_000;
  await controller.renewIfDue(historyC);
  assert.strictEqual(watchRequests.length, watchCountBeforeRenewal, 'a fresh lease should not renew early');
  now += 1_001;
  await controller.renewIfDue(historyC);
  assert.strictEqual(watchRequests.length, watchCountBeforeRenewal + 1, 'the selected lease must renew before host TTL');

  await controller.clear();
  assert.strictEqual(controller.confirmedKey, '');
  assert.strictEqual(unwatchRequests.length, 1, 'clearing the selection should release exactly one owner lease');
  assert.strictEqual(unwatchRequests[0].sessionId, historyC.sessionId);

  await controller.select(historyA);
  blockedWatch = { sessionId: historyB.sessionId, gate: deferred() };
  const pendingSwitch = controller.select(historyB);
  await flushMicrotasks();
  const pendingRevision = watchRequests.at(-1).watchRevision;
  const release = controller.releaseNow({ keepalive: true });
  const releaseRequest = unwatchRequests.at(-1);
  assert.strictEqual(releaseRequest.keepalive, true, 'pagehide release should use keepalive transport');
  assert(
    releaseRequest.watchRevision > pendingRevision,
    'pagehide release must supersede an in-flight watch revision'
  );
  blockedWatch.gate.resolve();
  await Promise.all([pendingSwitch, release]);
  assert.strictEqual(controller.confirmedKey, '', 'an older in-flight watch must not revive after pagehide');

  await controller.releaseNow({ keepalive: true });
  assert.strictEqual(unwatchRequests.length, 2, 'repeated pagehide cleanup should be idempotent');

  const crossHostWatches = [];
  const crossHostUnwatches = [];
  const crossHostController = createSelectedSessionWatchController({
    clientId: 'browser-tab-cross-host',
    viewId: 'primary',
    sendWatch: async (request) => crossHostWatches.push({ ...request }),
    sendUnwatch: async (request) => crossHostUnwatches.push({ ...request }),
  });
  await crossHostController.select(session('host-a-history'));
  await crossHostController.select(session('host-b-history', { hostId: 'host-b' }));
  assert.strictEqual(crossHostController.confirmedKey, 'host-b::host-b-history');
  assert.deepStrictEqual(
    crossHostWatches.map((request) => request.hostId),
    ['host-a', 'host-b'],
    'the new host should receive its selected watch'
  );
  assert.deepStrictEqual(
    crossHostUnwatches.map((request) => request.hostId),
    ['host-a'],
    'switching hosts must release the old host lease because owner slots are host-local'
  );

  const legacyCalls = [];
  const legacyController = createSelectedSessionWatchController({
    clientId: 'browser-tab-legacy-host',
    viewId: 'primary',
    supportsAtomicReplace: () => false,
    sendWatch: async (request) => legacyCalls.push(`watch:${request.sessionId}`),
    sendUnwatch: async (request) => legacyCalls.push(`unwatch:${request.sessionId}`),
  });
  await legacyController.select(session('legacy-a'));
  await legacyController.select(session('legacy-b'));
  assert.deepStrictEqual(
    legacyCalls,
    ['watch:legacy-a', 'unwatch:legacy-a', 'watch:legacy-b'],
    'old Agents without sessionWatchV2 must keep explicit unwatch-before-watch behavior'
  );

  const watchErrors = [];
  const offlineController = createSelectedSessionWatchController({
    clientId: 'browser-tab-offline-host',
    sendWatch: async () => {
      throw new Error('host unavailable');
    },
    sendUnwatch: async () => {},
    onError: (error) => watchErrors.push(error.message),
  });
  await offlineController.select(session('cached-offline-history'));
  assert.deepStrictEqual(
    watchErrors,
    ['host unavailable'],
    'a failed watch should report the error but resolve so cached history detail can still load'
  );

  console.log('selected session watch controller assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
