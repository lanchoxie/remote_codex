const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {
  createManagedSessionStartGate,
  createRetryableTerminalReceiptExecutor,
} = require('../apps/host-agent/managed-session-lifecycle');

async function verifyPendingStartLookup() {
  const gate = createManagedSessionStartGate();
  const start = gate.beginStart({
    type: 'session.start',
    sessionId: 'bridge-session',
    requestedSessionId: 'visible-session',
    runId: 'run-current',
  });

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

  const runner = { runId: 'run-current', stop: async () => {} };
  assert.strictEqual(start.setRunner(runner), true);
  assert.strictEqual(await waiting, runner);
  start.finish();
  assert.strictEqual(
    gate.waitForRunner({ sessionId: 'bridge-session', runId: 'run-current' }),
    null,
    'a completed start must leave the pending-start index'
  );
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

async function verifyAgentIntegrationSource() {
  const source = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
  const handleStart = source.indexOf("if (command.type === 'session.start')");
  const handleStartEnd = source.indexOf("if (command.type === 'host.import')", handleStart);
  const startBlock = source.slice(handleStart, handleStartEnd);
  assert(
    startBlock.includes('deferAcknowledgement: startManagedSession(command)'),
    'session.start must release the poll loop while startup remains pending'
  );

  const noRunnerStart = source.indexOf('if (!runner) {');
  const missingStopStart = source.indexOf("if (command.type === 'session.stop')", noRunnerStart);
  const missingInputStart = source.indexOf("if (command.type === 'session.input')", missingStopStart);
  const genericErrorStart = source.indexOf("type: 'session.error'", missingInputStart);
  const missingStopBlock = source.slice(missingStopStart, missingInputStart);
  const missingInputBlock = source.slice(missingInputStart, genericErrorStart);
  assert(
    missingStopBlock.includes('managedSessionStartGate.waitForRunner(command)'),
    'Stop must wait for the matching pending Start/Rebind runner before declaring history-only'
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
    inputExecutionBlock.includes("runner?.runtime?.phase === 'submitting-turn'"),
    'acceptance-unknown receipts may report busy only from a current submitting runtime snapshot'
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
  assert(pollBlock.includes('const fetchAfterId = nextCommandFetchAfter()'));

  const interruptStart = source.indexOf("if (command.type === 'session.interrupt')", genericErrorStart);
  const interruptEnd = source.indexOf("if (command.type === 'session.steer')", interruptStart);
  const interruptBlock = source.slice(interruptStart, interruptEnd);
  assert(interruptBlock.includes('deliverSessionInterruptResult(command, runner, result)'));
  assert(interruptBlock.includes('expectedClientRequestId: command.expectedClientRequestId || null'));
  assert(interruptBlock.includes('expectedTurnId: command.expectedTurnId || null'));

  const retryHelpersStart = source.indexOf('function requestDeferredCommandRetry');
  const retryHelpersEnd = source.indexOf('async function processPolledCommand', retryHelpersStart);
  const advanceStart = source.indexOf('function advanceAcknowledgedCommandId');
  const advanceEnd = source.indexOf('async function acknowledgeCommandsBeforeShutdown', advanceStart);
  const context = {};
  vm.runInNewContext(`
    let lastCommandId = 0;
    let lastFetchedCommandId = 2;
    const deliveredCommandStates = new Map([[1, 'pending'], [2, 'completed']]);
    const deferredCommandRetryIds = new Set();
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
      state: (id) => deliveredCommandStates.get(id) || null,
    };
  `, context);
  context.retryHarness.rejectFirst();
  assert.strictEqual(context.retryHarness.state(1), null, 'rejected deferred work must leave the completed ledger');
  assert.strictEqual(context.retryHarness.state(2), 'completed', 'later completed work must remain cached, not rerun');
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

verifyPendingStartLookup()
  .then(verifyTerminalReceiptRetryDoesNotRepeatExecution)
  .then(verifyAgentIntegrationSource)
  .then(() => console.log('host-agent command lifecycle assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
