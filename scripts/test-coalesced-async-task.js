const assert = require('assert');
const fs = require('fs');

const { createCoalescedAsyncTask } = require('../shared/coalesced-async-task');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForMicrotasks(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert(predicate(), message);
}

async function main() {
  const agentSource = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
  const relaySource = fs.readFileSync('apps/relay/server.js', 'utf8');
  assert(
    agentSource.includes('createCoalescedAsyncTask(performDiscovery)'),
    'Host discovery must use the tested coalescing primitive'
  );
  assert(
    relaySource.includes('HOST_SESSION_DISCOVERY_REQUEST_COOLDOWN_MS'),
    'legacy refresh clients must be throttled before enqueueing Host discovery'
  );

  const runs = [];
  let active = 0;
  let maxActive = 0;
  const runTask = createCoalescedAsyncTask(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const gate = deferred();
    runs.push(gate);
    await gate.promise;
    active -= 1;
  });

  const first = runTask();
  const second = runTask();
  const third = runTask();
  assert.strictEqual(second, first);
  assert.strictEqual(third, first);
  await waitForMicrotasks(
    () => runs.length === 1,
    'concurrent triggers must share the active task'
  );
  runs[0].resolve();
  await waitForMicrotasks(
    () => runs.length === 2,
    'concurrent triggers must coalesce into one follow-up pass'
  );
  const duringFollowUp = runTask();
  assert.strictEqual(duringFollowUp, first);
  runs[1].resolve();
  await waitForMicrotasks(
    () => runs.length === 3,
    'a trigger during the follow-up pass must schedule another pass'
  );
  runs[2].resolve();
  await Promise.all([first, second, third, duringFollowUp]);
  assert.strictEqual(runs.length, 3, 'no coalesced trigger may be silently discarded');
  assert.strictEqual(maxActive, 1, 'coalesced work must never overlap');
  assert.strictEqual(runTask.isRunning(), false);

  const afterSettled = runTask();
  await waitForMicrotasks(
    () => runs.length === 4,
    'a trigger after settlement must start a fresh chain'
  );
  runs[3].resolve();
  await afterSettled;

  const failedGate = deferred();
  let pendingFailureRuns = 0;
  const retryPending = createCoalescedAsyncTask(async () => {
    pendingFailureRuns += 1;
    if (pendingFailureRuns === 1) await failedGate.promise;
  });
  const pendingFailure = retryPending();
  const pendingRetry = retryPending();
  failedGate.reject(new Error('injected pending failure'));
  await Promise.all([pendingFailure, pendingRetry]);
  assert.strictEqual(pendingFailureRuns, 2, 'a queued trigger must receive one retry after an active failure');

  let failures = 0;
  const retryable = createCoalescedAsyncTask(async () => {
    failures += 1;
    if (failures === 1) throw new Error('injected task failure');
  });
  await assert.rejects(retryable(), /injected task failure/);
  await retryable();
  assert.strictEqual(failures, 2, 'a failed task must release the single-flight slot');

  let settlementRuns = 0;
  const settlementGate = deferred();
  const settlementTask = createCoalescedAsyncTask(async () => {
    settlementRuns += 1;
    if (settlementRuns === 1) await settlementGate.promise;
  });
  const settling = settlementTask();
  let settlementFollowUp = null;
  settlementGate.promise.then(() => {
    settlementFollowUp = settlementTask();
  });
  settlementGate.resolve();
  await settling;
  await settlementFollowUp;
  assert.strictEqual(settlementRuns, 2, 'a trigger in the settlement window must start a new task');

  let synchronousFailureRuns = 0;
  const synchronousFailureTask = createCoalescedAsyncTask(() => {
    synchronousFailureRuns += 1;
    throw new Error('injected synchronous failure');
  });
  const firstSynchronousFailure = synchronousFailureTask();
  await assert.rejects(firstSynchronousFailure, /injected synchronous failure/);
  assert.strictEqual(synchronousFailureRuns, 1);
  assert.strictEqual(
    synchronousFailureTask.isRunning(),
    false,
    'a synchronous throw must release the single-flight slot'
  );
  const synchronousRetry = synchronousFailureTask();
  assert.notStrictEqual(
    synchronousRetry,
    firstSynchronousFailure,
    'a retry after a synchronous throw must receive a fresh task promise'
  );
  await assert.rejects(synchronousRetry, /injected synchronous failure/);
  assert.strictEqual(synchronousFailureRuns, 2, 'a retry must invoke the task again');
  assert.strictEqual(synchronousFailureTask.isRunning(), false);

  console.log('coalesced async task assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
