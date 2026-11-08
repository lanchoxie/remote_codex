const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {
  buildManagedStartDiscoverySession,
  createManagedSessionStartGate,
  createRetryableTerminalReceiptExecutor,
  runnerHasSessionStopRequest,
  stopRunnerOnce,
} = require('../apps/host-agent/managed-session-lifecycle');
const {
  CodexAppServerRunner,
  inspectManagedOverlayForRun,
} = require('../apps/host-agent/codex-app-server-runner');

async function verifyPendingStartLookup() {
  const gate = createManagedSessionStartGate();
  const start = gate.beginStart({
    type: 'session.start',
    sessionId: 'bridge-session',
    requestedSessionId: 'visible-session',
    runId: 'run-current',
  });
  assert.deepStrictEqual(
    gate.snapshotActiveStarts().map((record) => ({
      command: record.command,
      runner: record.runner,
    })),
    [{
      command: {
        type: 'session.start',
        sessionId: 'bridge-session',
        requestedSessionId: 'visible-session',
        runId: 'run-current',
      },
      runner: null,
    }],
    'the start gate must expose an immutable command snapshot before runner creation'
  );

  assert.strictEqual(
    gate.waitForRunner({ type: 'session.stop', sessionId: 'bridge-session', runId: 'run-stale' }),
    null,
    'a Stop for a stale run must not attach to a pending replacement run'
  );
  const waiting = gate.waitForRunner({
    type: 'session.stop',
    requestedSessionId: 'visible-session',
    runId: 'run-current',
  });
  assert(waiting && typeof waiting.then === 'function');

  const runner = {
    runId: 'run-current',
    runtime: {
      runId: 'run-current',
      phase: 'idle',
      busy: false,
      command: 'codex',
      args: ['--api-key', 'pending-discovery-secret'],
      apiConfig: { apiKey: 'pending-discovery-secret' },
    },
    stop: async () => {},
  };
  assert.strictEqual(start.setRunner(runner), true);
  assert.strictEqual(await waiting, runner);
  const activeStart = gate.snapshotActiveStarts()[0];
  assert.strictEqual(activeStart.runner, runner);
  const pendingDiscovery = buildManagedStartDiscoverySession(activeStart, {
    cwd: '/default-workspace',
    updatedAt: '2026-08-17T00:00:00.000Z',
  });
  assert.deepStrictEqual(
    {
      sessionId: pendingDiscovery.sessionId,
      runId: pendingDiscovery.runId,
      source: pendingDiscovery.source,
      live: pendingDiscovery.live,
      managedStartPending: pendingDiscovery.managedStartPending,
      runtimePhase: pendingDiscovery.runtime.phase,
      runtimeBusy: pendingDiscovery.runtime.busy,
    },
    {
      sessionId: 'bridge-session',
      runId: 'run-current',
      source: 'managed',
      live: false,
      managedStartPending: true,
      runtimePhase: 'initializing',
      runtimeBusy: true,
    },
    'pending discovery must attest the exact run without claiming that startup is live'
  );
  assert.strictEqual(
    JSON.stringify(pendingDiscovery).includes('pending-discovery-secret'),
    false,
    'pending discovery must serialize a public runtime DTO rather than runner command secrets'
  );
  assert.strictEqual(Object.hasOwn(pendingDiscovery.runtime, 'command'), false);
  assert.strictEqual(Object.hasOwn(pendingDiscovery.runtime, 'args'), false);

  assert.strictEqual(runnerHasSessionStopRequest(runner), false);
  await stopRunnerOnce(runner, { suppressTerminalEvent: true });
  assert.strictEqual(
    runnerHasSessionStopRequest(runner),
    false,
    'internal startup cleanup must not be mistaken for a user Stop command'
  );
  const userStopRunner = { stop: async () => {} };
  await stopRunnerOnce(userStopRunner, { stopCommandRequested: true });
  assert.strictEqual(runnerHasSessionStopRequest(userStopRunner), true);
  start.finish();
  assert.deepStrictEqual(gate.snapshotActiveStarts(), []);
  assert.strictEqual(
    gate.waitForRunner({ sessionId: 'bridge-session', runId: 'run-current' }),
    null,
    'a completed start must leave the pending-start index'
  );
}

async function verifyPendingStartStopWaitIsBounded() {
  const gate = createManagedSessionStartGate();
  const start = gate.beginStart({
    type: 'session.start',
    sessionId: 'pending-stop-session',
    runId: 'pending-stop-run',
  });
  const pending = gate.waitForRunner({
    type: 'session.stop',
    sessionId: 'pending-stop-session',
    runId: 'pending-stop-run',
  }, { timeoutMs: 10 });
  assert(pending && typeof pending.then === 'function');

  const outcome = await Promise.race([
    pending.then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'guard' }), 120)),
  ]);
  assert.notStrictEqual(
    outcome.kind,
    'guard',
    'a Stop waiter must not remain attached to a startup gate indefinitely'
  );
  assert.strictEqual(outcome.kind, 'rejected');
  assert.strictEqual(outcome.error.code, 'session_start_runner_wait_timeout');
  assert.strictEqual(outcome.error.retryCommand, true);
  assert.strictEqual(
    gate.activeStartCount(),
    1,
    'timing out the Stop waiter must not cancel or discard the still-running start'
  );
  start.finish();

  const secondStart = gate.beginStart({
    type: 'session.start',
    sessionId: 'pending-stop-resolves',
    runId: 'pending-stop-resolves-run',
  });
  const runner = { runId: 'pending-stop-resolves-run' };
  const resolved = gate.waitForRunner({
    type: 'session.stop',
    sessionId: 'pending-stop-resolves',
    runId: 'pending-stop-resolves-run',
  }, { timeoutMs: 100 });
  assert.strictEqual(secondStart.setRunner(runner), true);
  assert.strictEqual(await resolved, runner);
  secondStart.finish();
}

async function verifyTerminalReceiptRetryDoesNotRepeatExecution() {
  const executor = createRetryableTerminalReceiptExecutor();
  let executions = 0;
  let deliveries = 0;
  const execute = async () => {
    executions += 1;
    return [{ type: 'session.runtime_updated', timestamp: 'stable-timestamp' }];
  };
  const deliver = async (receipt) => {
    deliveries += 1;
    assert.strictEqual(receipt[0].timestamp, 'stable-timestamp');
    if (deliveries === 1) throw new Error('simulated receipt transport failure');
    return receipt;
  };

  await assert.rejects(executor.run('input-command-7', execute, deliver), /transport failure/);
  const delivered = await executor.run('input-command-7', execute, deliver);
  assert.strictEqual(executions, 1, 'retrying receipt delivery must not execute runner.sendInput twice');
  assert.strictEqual(deliveries, 2);
  assert.strictEqual(delivered[0].timestamp, 'stable-timestamp');
  assert.strictEqual(executor.forget('input-command-7'), true);
}

function loadRunnerCommandLaneHarness() {
  const source = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
  const enqueueStart = source.indexOf('function enqueueRunnerCommandEffect');
  const enqueueEnd = source.indexOf('async function executeSessionInputCommand', enqueueStart);
  assert(enqueueStart >= 0 && enqueueEnd > enqueueStart, 'runner command queue helper should be bounded');

  const context = {};
  vm.runInNewContext(`
    const runnerCommandEffectTails = new WeakMap();
    const runnerControlCommandEffectTails = new WeakMap();
    ${source.slice(enqueueStart, enqueueEnd)}
    globalThis.enqueueRunnerCommandEffect = enqueueRunnerCommandEffect;
    globalThis.enqueueRunnerControlEffect = enqueueRunnerControlEffect;
  `, context);
  return context;
}

async function verifyRunnerCommandEffectsArePrioritized() {
  const source = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
  const context = loadRunnerCommandLaneHarness();

  const runner = {};
  const order = [];
  let releaseInput;
  const inputGate = new Promise((resolve) => {
    releaseInput = resolve;
  });
  const input = context.enqueueRunnerCommandEffect(runner, async () => {
    order.push('input:start');
    await inputGate;
    order.push('input:end');
  });
  const review = context.enqueueRunnerCommandEffect(runner, async () => {
    order.push('review');
  });
  const interrupt = context.enqueueRunnerControlEffect(runner, async () => {
    order.push('interrupt');
  });
  const stop = context.enqueueRunnerControlEffect(runner, async () => {
    order.push('stop');
  });
  const response = context.enqueueRunnerControlEffect(runner, async () => {
    order.push('response');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(
    order,
    ['input:start', 'interrupt', 'stop', 'response'],
    'interrupt, stop, and approval responses must not wait behind a long-running normal runner effect'
  );
  releaseInput();
  await Promise.all([input, review, interrupt, stop, response]);
  assert.deepStrictEqual(
    order,
    ['input:start', 'interrupt', 'stop', 'response', 'input:end', 'review'],
    'normal effects remain FIFO while the independent control lane can preempt them'
  );

  const reviewStart = source.indexOf("if (command.type === 'session.review_start')");
  const reviewEnd = source.indexOf("if (command.type === 'session.shell_command')", reviewStart);
  const reviewBlock = source.slice(reviewStart, reviewEnd);
  assert(
    reviewBlock.includes('enqueueRunnerCommandEffect(runner, () => runner.startReview(')
      && reviewBlock.includes('deferAcknowledgement: reviewTask'),
    'Review must stay on the normal runner lane without blocking command polling'
  );

  const responseStart = source.indexOf("if (command.type === 'session.request.respond')");
  const responseEnd = source.indexOf("if (command.type === 'session.stop')", responseStart);
  const responseBlock = source.slice(responseStart, responseEnd);
  assert(
    responseBlock.includes('enqueueRunnerControlEffect(')
      && responseBlock.includes('runner.respondToRequest(command.requestId, command.response || null)'),
    'request responses must use the high-priority runner control lane'
  );

  const interruptBlock = source.slice(
    source.indexOf("if (command.type === 'session.interrupt')", source.indexOf('if (!runner)')),
    source.indexOf("if (command.type === 'session.steer')", source.indexOf("if (command.type === 'session.interrupt')", source.indexOf('if (!runner)')))
  );
  assert(
    interruptBlock.includes('enqueueRunnerControlEffect('),
    'interrupts must use the high-priority runner control lane'
  );
  const stopBlock = source.slice(
    source.indexOf("if (command.type === 'session.stop')", responseStart),
    source.indexOf("if (command.type === 'session.model_list')", responseStart)
  );
  assert(
    stopBlock.includes('enqueueRunnerControlEffect('),
    'active session stops must use the high-priority runner control lane'
  );

  const pollLoopStart = source.indexOf('async function pollCommandsLoop(');
  const pollLoopEnd = source.indexOf('async function commandPollingCoordinator()', pollLoopStart);
  const pollLoop = source.slice(pollLoopStart, pollLoopEnd);
  assert(
    /if \(!processed\) \{[\s\S]*?continue;[\s\S]*?\}/.test(pollLoop),
    'a retrying command must not starve later commands in the same polling lane'
  );
  assert(
    !/if \(!processed\) \{\s*break;\s*\}/.test(pollLoop),
    'a retrying command must retain its ACK gap without terminating the fetched batch'
  );
}

async function verifyApprovalResponsePreemptsPendingTurnStart() {
  const lanes = loadRunnerCommandLaneHarness();
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-control-lane-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  const order = [];
  let resolveTurnStart;
  let reportTurnStartPending;
  const turnStartPending = new Promise((resolve) => {
    reportTurnStartPending = resolve;
  });
  const turnStartResult = new Promise((resolve) => {
    resolveTurnStart = resolve;
  });
  const rpc = {
    request: async (method) => {
      assert.strictEqual(method, 'turn/start');
      order.push('turn/start:pending');
      reportTurnStartPending();
      return turnStartResult;
    },
    respond: async (requestId, payload) => {
      order.push('approval:responded');
      assert.strictEqual(requestId, 7001);
      assert.deepStrictEqual(payload, { decision: 'accept' });
    },
    respondError: () => {
      assert.fail('the current pending submission approval must not be rejected as stale');
    },
  };
  const runner = new CodexAppServerRunner({
    hostId: 'runner-control-lane-host',
    sessionId: 'runner-control-lane-session',
    bridgeSessionId: 'runner-control-lane-session',
    runId: 'runner-control-lane-run',
    title: 'Runner control lane',
    cwd: process.cwd(),
    launchMode: 'fresh',
    codexHome: baseHome,
    postEvent: async (event) => events.push(event),
  });
  runner.threadId = 'runner-control-lane-thread';
  runner.sessionId = runner.threadId;
  runner.nativeThreadId = runner.threadId;
  runner.rpc = rpc;

  try {
    const input = lanes.enqueueRunnerCommandEffect(runner, () => runner.sendInput(
      'run a command that needs approval',
      { clientRequestId: 'runner-control-lane-request' }
    ));
    await turnStartPending;
    const attempt = runner.activeSubmissionAttempt;
    assert(attempt, 'turn/start must expose a pending submission identity');
    const turnId = '019fcafe-0000-7000-8000-000000000001';
    let staleRpcRejections = 0;
    await runner.handleServerRequest({
      id: 7000,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: runner.threadId,
        turnId,
        itemId: 'stale-approval-item',
        command: 'echo stale',
        startedAtMs: attempt.submittedAtMs + 1,
      },
    }, {
      rpc: {
        respondError: () => {
          staleRpcRejections += 1;
        },
      },
    });
    assert.strictEqual(staleRpcRejections, 1, 'an approval from an old RPC must fail closed');
    assert.strictEqual(runner.pendingRequests.has('7000'), false);
    await runner.handleServerRequest({
      id: 7001,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: runner.threadId,
        turnId,
        itemId: 'approval-item-1',
        command: 'echo approved',
        startedAtMs: attempt.submittedAtMs + 1,
      },
    }, { rpc });
    assert(runner.pendingRequests.has('7001'));
    const queuedReview = lanes.enqueueRunnerCommandEffect(runner, async () => {
      order.push('review:normal-lane');
    });

    await lanes.enqueueRunnerControlEffect(
      runner,
      () => runner.respondToRequest('7001', { decision: 'accept' })
    );
    assert.deepStrictEqual(
      order,
      ['turn/start:pending', 'approval:responded'],
      'approval RPC must be written while turn/start is still unresolved'
    );

    order.push('turn/start:released');
    resolveTurnStart({ turn: { id: turnId, status: { type: 'inProgress' } } });
    assert.strictEqual(await input, turnId);
    await queuedReview;
    await runner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: turnId, status: { type: 'completed' } } },
    });
    assert.strictEqual(runner.runtime.busy, false);
    assert.strictEqual(runner.runtime.phase, 'idle');
    assert.deepStrictEqual(
      order,
      ['turn/start:pending', 'approval:responded', 'turn/start:released', 'review:normal-lane'],
      'the approval must escape both pending input and queued Review work'
    );
    assert(events.some((event) => (
      event.type === 'session.request.resolved' && event.requestId === '7001'
    )));
  } finally {
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyAgentIntegrationSource() {
  const source = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
  const handleStart = source.indexOf("if (command.type === 'session.start')");
  const handleStartEnd = source.indexOf("if (command.type === 'host.import')", handleStart);
  const startBlock = source.slice(handleStart, handleStartEnd);
  assert(
    startBlock.includes('deferAcknowledgement: startManagedSession(command)'),
    'session.start must release the poll loop while startup remains pending'
  );
  assert(
    source.includes('managedSessionStartGate.snapshotActiveStarts()')
      && source.includes('buildManagedStartDiscoverySession(activeStart'),
    'discovery must publish exact run presence for runners still owned by the start gate'
  );
  assert(
    source.includes('if (runnerHasSessionStopRequest(runner))')
      && !source.slice(
        source.indexOf('async function startManagedSession(command)'),
        source.indexOf('async function postCodexUpdateEvent')
      ).includes('if (runner?.stopRequested)'),
    'startup cleanup may set stopRequested; only an explicit Session Stop command may own the pending start'
  );
  assert(
    /stopRunnerOnce\(startedRunner, \{[\s\S]{0,180}stopCommandRequested: true/.test(source)
      && /if \(command\.type === 'session\.stop'\) \{[\s\S]{0,240}stopRunnerOnce\(runner, \{[\s\S]{0,180}stopCommandRequested: true/.test(source),
    'both pending and live Session Stop handlers must mark command ownership explicitly'
  );

  const noRunnerStart = source.indexOf('if (!runner) {');
  const missingStopStart = source.indexOf("if (command.type === 'session.stop')", noRunnerStart);
  const missingInputStart = source.indexOf("if (command.type === 'session.input')", missingStopStart);
  const genericErrorStart = source.indexOf("type: 'session.error'", missingInputStart);
  const missingStopBlock = source.slice(missingStopStart, missingInputStart);
  const missingInputBlock = source.slice(missingInputStart, genericErrorStart);
  assert(
    /managedSessionStartGate\.waitForRunner\(command,\s*\{\s*timeoutMs:\s*PENDING_START_STOP_WAIT_MS/.test(
      missingStopBlock
    ),
    'Stop must wait for the matching pending Start/Rebind runner before declaring history-only'
  );
  assert(
    missingStopBlock.includes('timeoutMs: PENDING_START_STOP_WAIT_MS'),
    'pending-start Stop must use a bounded waiter so the control poller cannot hang forever'
  );
  assert(
    source.includes('PENDING_START_STOP_WAIT_MS'),
    'pending-start Stop timeout must be explicitly configurable'
  );
  assert(
    missingInputBlock.includes('return {')
      && missingInputBlock.includes('deferAcknowledgement: startSessionInputCommand(command)'),
    'missing-runner input must return through its structured terminal receipt path'
  );

  const inputStart = source.indexOf('function startSessionInputCommand');
  const inputEnd = source.indexOf('async function failShutdownCancelledManagedSession', inputStart);
  const inputBlock = source.slice(inputStart, inputEnd);
  assert(inputBlock.includes('sessionInputReceiptExecutor.run('));
  assert(inputBlock.includes('deliverSessionInputReceipt(command, receipt)'));
  assert(
    source.includes('commandClientRequestId: command.clientRequestId || null'),
    'input terminal receipts must keep command identity separate from the active runtime turn identity'
  );
  assert(
    source.includes('retirementId: command.retirementId || null'),
    'runner-retirement Stop failures must preserve their durable cleanup identity'
  );
  assert(
    source.includes("type: 'session.command_succeeded'")
      && source.includes("await postSessionCommandSuccess(command, 'stop', runner)"),
    'successful runner retirement must emit an explicit durable cleanup receipt'
  );
  assert(
    missingStopBlock.includes("await postSessionCommandSuccess(command, 'stop', null)"),
    'a confirmed-missing exact retirement runner must be treated as an idempotent cleanup success'
  );
  assert(
    missingStopBlock.includes('inspectManagedOverlayForRun(CODEX_HOME, command.runId)')
      && missingStopBlock.includes('session_retirement_runner_unverified'),
    'a missing exact retirement runner must probe managed overlays before success'
  );
  assert(source.includes("inputOutcome: 'accepted'"));
  assert(source.includes("inputOutcome: 'acceptance_unknown'"));
  assert(
    source.includes('function currentRunnerActiveRuntime(runner)')
      && source.includes('!runner?.isTerminalTurnId?.(candidateTurnId)'),
    'input receipts must derive active runtime from the current non-terminal runner snapshot'
  );
  const inputExecutionStart = source.indexOf('async function executeSessionInputCommand');
  const inputExecutionEnd = source.indexOf('async function deliverSessionInputReceipt', inputExecutionStart);
  const inputExecutionBlock = source.slice(inputExecutionStart, inputExecutionEnd);
  assert(
    inputExecutionBlock.includes('const runnerRuntime = currentRunnerActiveRuntime(runner);')
      && !inputExecutionBlock.includes('activeTurnId: turnId || runner.activeTurnId || null'),
    'accepted input receipts must not use a historical turn/start response as active runtime state'
  );
  assert(
    inputExecutionBlock.includes('Boolean(runner?.pendingSubmissionReconciliation)')
      && inputExecutionBlock.includes("['submitting-turn', 'runtime-unknown', 'interrupting'].includes(unresolvedPhase)"),
    'acceptance-unknown receipts may report busy only while the same submission remains unresolved'
  );
  assert(
    inputExecutionBlock.includes('pendingClientRequestId: runnerRuntime.activeTurnId')
      && inputExecutionBlock.includes('submissionReconciliation: runnerRuntime.activeTurnId'),
    'an adopted Turn must clear pending submission projection fields from the command receipt'
  );
  const deliveryStart = source.indexOf('async function deliverSessionInputReceipt');
  const deliveryEnd = source.indexOf('function startSessionInputCommand', deliveryStart);
  const deliveryBlock = source.slice(deliveryStart, deliveryEnd);
  assert(deliveryBlock.includes('postEvents(receipt'));
  assert(deliveryBlock.includes('batchId: sessionInputReceiptBatchId(command)'));
  assert(!deliveryBlock.includes('bestEffort: true'));

  const pollStart = source.indexOf('async function processPolledCommand');
  const pollEnd = source.indexOf('async function discoveryLoop', pollStart);
  const pollBlock = source.slice(pollStart, pollEnd);
  assert(
    pollBlock.includes('result.deferAcknowledgement.then(completeDeferredCommand, retryDeferredCommand)'),
    'deferred rejection must not share the completed-ACK callback'
  );
  assert(pollBlock.includes('requestDeferredCommandRetry(commandId, error)'));
  assert(/nextCommandFetchAfter\(\)/.test(pollBlock));

  const interruptStart = source.indexOf("if (command.type === 'session.interrupt')", genericErrorStart);
  const interruptEnd = source.indexOf("if (command.type === 'session.steer')", interruptStart);
  const interruptBlock = source.slice(interruptStart, interruptEnd);
  assert(interruptBlock.includes('deliverSessionInterruptResult(command, runner, result)'));
  assert(interruptBlock.includes('expectedClientRequestId: command.expectedClientRequestId || null'));
  assert(interruptBlock.includes('expectedTurnId: command.expectedTurnId || null'));

  const retryHelpersStart = source.indexOf('function explicitCommandLaneState');
  const retryHelpersEnd = source.indexOf('async function processPolledCommand', retryHelpersStart);
  const advanceStart = source.indexOf('function advanceAcknowledgedCommandId');
  const advanceEnd = source.indexOf('async function acknowledgeCommandsBeforeShutdown', advanceStart);
  const context = {};
  vm.runInNewContext(`
    let lastCommandId = 0;
    let lastFetchedCommandId = 2;
    const deliveredCommandStates = new Map([[1, 'pending'], [2, 'completed']]);
    const deferredCommandRetryIds = new Set();
    const explicitCommandLaneStates = new Map();
    const processedCommandStates = new Map();
    const rememberProcessedCommandState = (id, state) => {
      if (state === 'completed' || state === 'pending') processedCommandStates.set(id, state);
      else processedCommandStates.delete(id);
    };
    const logAgentTransient = () => {};
    ${source.slice(retryHelpersStart, retryHelpersEnd)}
    ${source.slice(advanceStart, advanceEnd)}
    globalThis.retryHarness = {
      rejectFirst: () => requestDeferredCommandRetry(1, new Error('receipt failed')),
      fetchAfter: () => nextCommandFetchAfter(),
      completeRetry: () => {
        deferredCommandRetryIds.delete(1);
        deliveredCommandStates.set(1, 'completed');
        return advanceAcknowledgedCommandId();
      },
      ackWhileRetrying: () => advanceAcknowledgedCommandId(),
      state: (id) => deliveredCommandStates.get(id) || null,
    };
  `, context);
  context.retryHarness.rejectFirst();
  assert.strictEqual(context.retryHarness.state(1), 'retrying', 'rejected deferred work must remain an explicit ACK barrier');
  assert.strictEqual(context.retryHarness.state(2), 'completed', 'later completed work must remain cached, not rerun');
  assert.strictEqual(context.retryHarness.ackWhileRetrying(), 0, 'a later completion must not advance ACK across a retry gap');
  assert.strictEqual(context.retryHarness.fetchAfter(), 0, 'polling must rewind to the rejected command');
  assert.strictEqual(context.retryHarness.completeRetry(), 2, 'successful redelivery should release the contiguous ACK barrier');

  const receiptRuntimeStart = source.indexOf('function buildSessionInputRuntimeEvent');
  const receiptRuntimeEnd = source.indexOf('function normalizeSessionInterruptResult', receiptRuntimeStart);
  const executeInputStart = source.indexOf('async function executeSessionInputCommand');
  const executeInputEnd = source.indexOf('async function deliverSessionInputReceipt', executeInputStart);
  const receiptContext = {};
  vm.runInNewContext(`
    const HOST_ID = 'receipt-test-host';
    const nowIso = () => 'receipt-test-time';
    const normalizeApiConfig = (value) => value;
    ${source.slice(receiptRuntimeStart, receiptRuntimeEnd)}
    ${source.slice(executeInputStart, executeInputEnd)}
    globalThis.runInputReceipt = executeSessionInputCommand;
  `, receiptContext);
  const acceptedReceipt = await receiptContext.runInputReceipt({
    sessionId: 'receipt-session',
    runId: 'receipt-run',
    clientRequestId: 'receipt-request',
    text: 'terminal response',
  }, {
    activeTurnId: null,
    activeClientRequestId: null,
    runtime: { activeTurnId: 'terminal-history', busy: false, phase: 'idle' },
    isTerminalTurnId: (turnId) => turnId === 'terminal-history',
    reserveRuntimeRevision: () => 1,
    sendInput: async () => 'terminal-history',
  });
  assert.strictEqual(acceptedReceipt[0].inputOutcome, 'accepted');
  assert.strictEqual(acceptedReceipt[0].patch.activeTurnId, null);
  assert.strictEqual(acceptedReceipt[0].patch.busy, false);

  const unknownReceipt = await receiptContext.runInputReceipt({
    sessionId: 'receipt-session',
    runId: 'receipt-run',
    clientRequestId: 'unknown-request',
    text: 'unknown response',
  }, {
    activeTurnId: null,
    activeClientRequestId: null,
    runtime: { activeTurnId: 'terminal-history', busy: false, phase: 'idle' },
    isTerminalTurnId: (turnId) => turnId === 'terminal-history',
    reserveRuntimeRevision: () => 2,
    sendInput: async () => {
      const error = new Error('timed out');
      error.code = 'session_input_acceptance_unknown';
      throw error;
    },
  });
  assert.strictEqual(unknownReceipt[0].inputOutcome, 'acceptance_unknown');
  assert.strictEqual(unknownReceipt[0].patch.activeTurnId, null);
  assert.strictEqual(unknownReceipt[0].patch.busy, false);
}

async function verifyOrphanedOverlayProbe() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-overlay-probe-'));
  const profileHome = path.join(root, '.remote-codex-managed', 'rc-probe');
  fs.mkdirSync(profileHome, { recursive: true });
  fs.writeFileSync(path.join(profileHome, '.remote-codex-owner'), JSON.stringify({
    kind: 'remote-codex-managed-overlay',
    version: 1,
    ownerToken: '0123456789abcdef0123456789abcdef',
    ownerPid: 99999,
    childPid: 12345,
    childState: 'running',
    metadata: { run: { runId: 'orphan-run' } },
  }));
  const active = inspectManagedOverlayForRun(root, 'orphan-run', {
    isProcessAlive: (pid) => pid === 12345,
  });
  assert.strictEqual(active.status, 'active');
  const exitedMarker = JSON.parse(fs.readFileSync(path.join(profileHome, '.remote-codex-owner'), 'utf8'));
  exitedMarker.childPid = 54321;
  exitedMarker.childState = 'exited';
  fs.writeFileSync(path.join(profileHome, '.remote-codex-owner'), JSON.stringify(exitedMarker));
  const exited = inspectManagedOverlayForRun(root, 'orphan-run', {
    isProcessAlive: () => false,
  });
  assert.strictEqual(exited.status, 'absent');
  assert.strictEqual(exited.matched, true);
  const absent = inspectManagedOverlayForRun(root, 'gone-run', {
    isProcessAlive: () => false,
  });
  assert.strictEqual(absent.status, 'absent');
  assert.strictEqual(absent.matched, false);
  fs.rmSync(root, { recursive: true, force: true });
}

verifyPendingStartLookup()
  .then(verifyPendingStartStopWaitIsBounded)
  .then(verifyTerminalReceiptRetryDoesNotRepeatExecution)
  .then(verifyRunnerCommandEffectsArePrioritized)
  .then(verifyApprovalResponsePreemptsPendingTurnStart)
  .then(verifyAgentIntegrationSource)
  .then(verifyOrphanedOverlayProbe)
  .then(() => console.log('host-agent command lifecycle assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
