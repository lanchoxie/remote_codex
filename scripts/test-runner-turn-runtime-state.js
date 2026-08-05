const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CodexAppServerRunner } = require('../apps/host-agent/codex-app-server-runner');

const runner = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

function extractBlock(startNeedle, endNeedle, fromIndex = 0) {
  const start = runner.indexOf(startNeedle, fromIndex);
  const end = runner.indexOf(endNeedle, start);
  assert(start >= 0 && end > start, `expected to extract block from ${startNeedle}`);
  return runner.slice(start, end);
}

const notificationHandlerStart = runner.indexOf('async handleNotification(message)');
assert(notificationHandlerStart >= 0, 'runner should define handleNotification');
const releaseClientRequestIdStart = runner.indexOf('releaseClientRequestIdForTurn(turnId)');
const releaseClientRequestIdEnd = runner.indexOf('async applyPendingInterruptIntent', releaseClientRequestIdStart);
const releaseClientRequestIdBlock = runner.slice(releaseClientRequestIdStart, releaseClientRequestIdEnd);
assert(
  !releaseClientRequestIdBlock.includes('pendingInterruptIntent'),
  'releasing a client-request mapping must not silently discard an unsettled interrupt'
);
assertContains(
  runner,
  'async settlePendingInterrupt(intent, result = {})',
  'terminal paths must use a single interrupt settlement entry point'
);
const settlePendingInterruptBlock = extractBlock(
  'async settlePendingInterrupt(intent, result = {})',
  'async settlePendingInterruptForSubmissionFailure'
);
assertContains(
  settlePendingInterruptBlock,
  'intent.settled = false;',
  'a failed terminal-result delivery must remain retryable instead of losing the interrupt outcome'
);
const reasoningBlock = extractBlock(
  "if (method === 'item/reasoning/summaryTextDelta')",
  "if (method === 'item/plan/delta' || method === 'turn/plan/updated')",
  notificationHandlerStart
);
assertContains(
  reasoningBlock,
  'emitActiveTurnRecoveryIfNeeded',
  'reasoning recovery must remain behind the runner terminal-state guard'
);
assertContains(
  reasoningBlock,
  'this.appendThinkingDelta',
  'reasoning deltas must be represented by the activity stream'
);

const planBlock = extractBlock(
  "if (method === 'item/plan/delta' || method === 'turn/plan/updated')",
  "if (method === 'thread/tokenUsage/updated')",
  notificationHandlerStart
);
assertContains(
  planBlock,
  'emitActiveTurnRecoveryIfNeeded',
  'plan recovery must remain behind the runner terminal-state guard'
);
assertContains(
  planBlock,
  'this.appendActivityDelta',
  'plan deltas must be represented by the activity stream'
);

const resolveRequestBlock = extractBlock(
  'async respondToRequest',
  'async resolvePendingRequestsForClosedTurn'
);
assertContains(
  resolveRequestBlock,
  'busy: Boolean(this.activeTurnId),',
  'resolving a Codex request after a turn closes must explicitly clear busy state'
);

async function verifyRetryRecoveryAndTerminalErrorState() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-turn-runtime-state-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  let terminalInternalTurn = 'not-observed';
  let runner = null;
  runner = new CodexAppServerRunner({
    hostId: 'runner-turn-runtime-host',
    sessionId: 'runner-turn-runtime-session',
    bridgeSessionId: 'runner-turn-runtime-session',
    runId: 'runner-turn-runtime-run',
    title: 'Runner turn runtime state',
    cwd: process.cwd(),
    launchMode: 'fresh',
    codexHome: baseHome,
    postEvent: async (event) => {
      if (event.type === 'session.runtime_updated' && event.patch?.currentTurnStatus === 'failed') {
        terminalInternalTurn = runner.activeTurnId;
      }
      events.push(event);
    },
  });
  runner.threadId = 'runner-turn-runtime-thread';
  runner.sessionId = runner.threadId;
  runner.nativeThreadId = runner.threadId;

  const setActiveTurn = (turnId) => {
    runner.activeTurnId = turnId;
    runner.resetTurnBuffer(turnId);
    Object.assign(runner.runtime, {
      activeTurnId: turnId,
      busy: true,
      phase: 'thinking',
      currentTurnStatus: 'inProgress',
      waitingOnApproval: false,
      waitingOnUserInput: false,
      lastError: null,
      lastCodexError: null,
    });
  };
  const emitRetry = async (turnId, errorInfo = { responseStreamDisconnected: {} }) => {
    await runner.handleNotification({
      method: 'error',
      params: {
        turnId,
        willRetry: true,
        error: {
          message: 'temporary stream failure',
          codexErrorInfo: errorInfo,
        },
      },
    });
  };

  try {
    setActiveTurn('turn-retry');
    await emitRetry('turn-retry');
    assert.strictEqual(runner.activeTurnId, 'turn-retry', 'retryable errors must keep the internal active turn');
    assert.strictEqual(runner.runtime.activeTurnId, 'turn-retry', 'retryable errors must keep the projected active turn');
    assert.strictEqual(runner.runtime.busy, true, 'retryable errors must keep the turn busy');
    assert.strictEqual(runner.runtime.phase, 'reconnecting', 'stream disconnect retries must retain reconnecting semantics');
    assert.strictEqual(runner.runtime.lastCodexError, 'responseStreamDisconnected');
    const retryAlert = [...events].reverse().find((event) => event.type === 'session.alert');
    assert.strictEqual(retryAlert?.transient, true, 'retry warnings must be marked transient');
    assert.strictEqual(retryAlert?.turnId, 'turn-retry', 'retry warnings must identify their turn');

    await runner.handleNotification({
      method: 'item/commandExecution/outputDelta',
      params: {
        turnId: 'turn-retry',
        itemId: 'command-after-retry',
        delta: 'command resumed',
      },
    });
    assert.strictEqual(runner.runtime.lastError, null, 'same-turn command progress must clear a retry error');
    assert.strictEqual(runner.runtime.lastCodexError, null, 'same-turn command progress must clear Codex retry metadata');
    assert.strictEqual(runner.runtime.activeTurnId, 'turn-retry');
    assert.strictEqual(runner.runtime.currentTurnStatus, 'inProgress');

    await emitRetry('turn-retry', { responseTooManyFailedAttempts: {} });
    assert.strictEqual(runner.runtime.phase, 'retrying', 'non-stream retry errors must retain retrying semantics');
    await runner.handleNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        turnId: 'turn-retry',
        itemId: 'reasoning-after-retry',
        summaryIndex: 0,
        delta: 'reasoning resumed',
      },
    });
    assert.strictEqual(runner.runtime.phase, 'thinking');
    assert.strictEqual(runner.runtime.lastError, null, 'same-turn reasoning must prove recovery');
    assert.strictEqual(runner.runtime.lastCodexError, null, 'same-turn reasoning must clear retry metadata');

    await emitRetry('turn-retry');
    await runner.handleNotification({
      method: 'item/plan/delta',
      params: {
        turnId: 'turn-retry',
        itemId: 'plan-after-retry',
        delta: 'plan resumed',
      },
    });
    assert.strictEqual(runner.runtime.phase, 'planning');
    assert.strictEqual(runner.runtime.lastError, null, 'same-turn plan progress must prove recovery');
    assert.strictEqual(runner.runtime.lastCodexError, null, 'same-turn plan progress must clear retry metadata');

    await emitRetry('turn-retry');
    await runner.handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        turnId: 'turn-stale',
        itemId: 'assistant-stale-after-retry',
        delta: 'late assistant text from a different turn',
      },
    });
    assert.strictEqual(runner.runtime.phase, 'reconnecting', 'stale turn progress must not change retry state');
    assert.strictEqual(runner.runtime.lastError, 'temporary stream failure', 'stale turn progress must not clear the current retry error');
    assert.strictEqual(runner.runtime.lastCodexError, 'responseStreamDisconnected', 'stale turn progress must not clear retry metadata');
    await runner.handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        turnId: 'turn-retry',
        itemId: 'assistant-after-retry',
        delta: 'assistant response resumed',
      },
    });
    assert.strictEqual(runner.runtime.phase, 'thinking', 'same-turn assistant progress must leave reconnecting state');
    assert.strictEqual(runner.runtime.lastError, null, 'same-turn assistant progress must clear a retry error');
    assert.strictEqual(runner.runtime.lastCodexError, null, 'same-turn assistant progress must clear retry metadata');

    await runner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn-retry', status: { type: 'completed' } } },
    });
    await runner.flushPendingTurnCompletion('turn-retry');
    runner.activeClientRequestId = 'turn-phase-request';
    runner.runtime.phase = 'submitting-turn';
    runner.runtime.busy = true;

    const projectedOutputStart = events.length;
    await runner.handleNotification({
      method: 'turn/started',
      params: {
        turn: { id: 'turn-phase-projection', status: { type: 'inProgress' } },
      },
    });
    assert.strictEqual(runner.activeTurnId, 'turn-phase-projection');
    await runner.handleNotification({
      method: 'item/started',
      params: {
        turnId: 'turn-phase-projection',
        item: {
          id: 'commentary-without-delta-phase',
          type: 'agentMessage',
          phase: 'commentary',
        },
      },
    });
    await runner.handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        turnId: 'turn-phase-projection',
        itemId: 'commentary-without-delta-phase',
        delta: 'progress must stay out of the final transcript',
      },
    });
    await runner.handleNotification({
      method: 'item/started',
      params: {
        turnId: 'turn-phase-projection',
        item: {
          id: 'final-without-delta-phase',
          type: 'agentMessage',
          phase: 'final_answer',
        },
      },
    });
    await runner.handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        turnId: 'turn-phase-projection',
        itemId: 'final-without-delta-phase',
        delta: 'final answer only',
      },
    });
    assert.strictEqual(
      runner.turnBuffers.get('turn-phase-projection'),
      'final answer only',
      'the final assistant delta must remain buffered until turn completion'
    );
    await runner.handleNotification({
      method: 'turn/completed',
      params: {
        turn: { id: 'turn-phase-projection', status: { type: 'completed' } },
      },
    });
    assert.strictEqual(
      runner.pendingTurnCompletions.has('turn-phase-projection'),
      true,
      'turn completion should wait briefly for a potentially late identified assistant item'
    );
    await runner.flushPendingTurnCompletion('turn-phase-projection');
    const projectedOutputs = events.slice(projectedOutputStart)
      .filter((event) => event.type === 'session.transcript');
    assert.deepStrictEqual(
      projectedOutputs.map((event) => event.text),
      ['final answer only'],
      'a delta must inherit item/started phase so commentary cannot be concatenated into the final transcript'
    );

    setActiveTurn('turn-terminal-error');
    runner.runtime.waitingOnApproval = true;
    runner.runtime.waitingOnUserInput = true;
    await runner.handleNotification({
      method: 'error',
      params: {
        turnId: 'turn-terminal-error',
        willRetry: false,
        error: {
          message: 'terminal provider failure',
          codexErrorInfo: 'usageLimitExceeded',
        },
      },
    });
    assert.strictEqual(terminalInternalTurn, null, 'internal active turn must clear before publishing terminal runtime');
    assert.strictEqual(runner.activeTurnId, null);
    assert.strictEqual(runner.runtime.activeTurnId, null);
    assert.strictEqual(runner.runtime.busy, false);
    assert.strictEqual(runner.runtime.waitingOnApproval, false);
    assert.strictEqual(runner.runtime.waitingOnUserInput, false);
    assert.strictEqual(runner.runtime.currentTurnStatus, 'failed');
    assert.strictEqual(runner.runtime.phase, 'quota-exhausted');
    assert.strictEqual(runner.runtime.lastCodexError, 'usageLimitExceeded');
    assert(events.some((event) => (
      event.type === 'session.runtime_updated'
      && event.patch?.activeTurnId === null
      && event.patch?.currentTurnStatus === 'failed'
      && event.patch?.waitingOnApproval === false
      && event.patch?.waitingOnUserInput === false
    )), 'terminal error runtime must publish a complete inactive turn projection');

    setActiveTurn('turn-system-error');
    runner.runtime.waitingOnApproval = true;
    runner.runtime.waitingOnUserInput = true;
    runner.runtime.pendingInputSummary = 'input pending before system error';
    runner.runtime.queuedCommandId = 42;
    runner.pendingRequests.set('system-error-request', {
      method: 'item/tool/requestUserInput',
      summary: 'pending question',
    });
    runner.appendThinkingDelta({
      turnId: 'turn-system-error',
      itemId: 'system-error-reasoning',
      summaryIndex: 0,
    }, 'reasoning before system error');
    const systemErrorEventStart = events.length;
    await runner.handleNotification({
      method: 'thread/status/changed',
      params: {
        status: {
          type: 'systemError',
          message: 'thread runtime failed',
        },
      },
    });
    const systemErrorEvents = events.slice(systemErrorEventStart);
    assert.strictEqual(runner.activeTurnId, null, 'systemError must clear the internal active turn');
    assert.strictEqual(runner.runtime.activeTurnId, null);
    assert.strictEqual(runner.runtime.busy, false);
    assert.strictEqual(runner.runtime.waitingOnApproval, false);
    assert.strictEqual(runner.runtime.waitingOnUserInput, false);
    assert.strictEqual(runner.runtime.pendingInputSummary, null);
    assert.strictEqual(runner.runtime.queuedCommandId, null);
    assert.strictEqual(runner.runtime.currentTurnStatus, 'failed');
    assert.strictEqual(runner.runtime.phase, 'error');
    assert.strictEqual(runner.runtime.lastError, 'thread runtime failed');
    assert.strictEqual(runner.runtime.lastCodexError, 'systemError');
    assert.strictEqual(runner.pendingRequests.size, 0, 'systemError must resolve pending Codex requests');
    assert.strictEqual(
      [...runner.thinkingActivities.values()].some((tracked) => tracked.identity.turnId === 'turn-system-error'),
      false,
      'systemError must finalize and release Thinking activities for the failed turn'
    );
    assert.strictEqual(runner.turnBuffers.has('turn-system-error'), false);
    assert(systemErrorEvents.some((event) => (
      event.type === 'session.activity_snapshot'
      && event.turnId === 'turn-system-error'
      && event.final === true
    )), 'systemError must flush a final Thinking activity snapshot before terminal runtime');
    assert(systemErrorEvents.some((event) => (
      event.type === 'session.request.resolved'
      && event.requestId === 'system-error-request'
      && event.status === 'failed'
    )), 'systemError must publish failed resolution for pending requests');
    assert(systemErrorEvents.some((event) => (
      event.type === 'session.error'
      && event.message === 'thread runtime failed'
    )), 'systemError must publish a terminal session.error event');

    setActiveTurn('turn-process-exit');
    runner.runtime.pendingInputSummary = 'stale queued input';
    runner.suppressTerminalEvent = true;
    await runner.finalizeExit(1, null);
    assert.strictEqual(runner.runtime.phase, 'closed');
    assert.strictEqual(runner.runtime.connection, 'closed');
    assert.strictEqual(runner.runtime.activeTurnId, null);
    assert.strictEqual(runner.runtime.busy, false);
    assert.strictEqual(
      runner.runtime.currentTurnStatus,
      'closed',
      'a closed app-server must not retain an in-progress turn projection'
    );
    assert.strictEqual(runner.runtime.pendingInputSummary, null);
    assert(events.some((event) => (
      event.type === 'session.runtime_updated'
      && event.patch?.phase === 'closed'
      && event.patch?.currentTurnStatus === 'closed'
      && event.patch?.activeTurnId === null
    )), 'runner exit must publish an internally consistent closed runtime');
  } finally {
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyPendingAcceptanceInterruptAndRuntimeRevision() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-pending-interrupt-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  const interruptCalls = [];
  const pendingRunner = new CodexAppServerRunner({
    hostId: 'runner-pending-interrupt-host',
    sessionId: 'runner-pending-interrupt-session',
    bridgeSessionId: 'runner-pending-interrupt-session',
    runId: 'runner-pending-interrupt-run',
    title: 'Runner pending interrupt',
    cwd: process.cwd(),
    launchMode: 'fresh',
    codexHome: baseHome,
    postEvent: async (event) => events.push(event),
  });
  pendingRunner.threadId = 'runner-pending-interrupt-thread';
  pendingRunner.sessionId = pendingRunner.threadId;
  pendingRunner.nativeThreadId = pendingRunner.threadId;
  pendingRunner.activeClientRequestId = 'pending-client-request';
  pendingRunner.runtime.phase = 'submitting-turn';
  pendingRunner.runtime.busy = true;
  pendingRunner.rpc = {
    request: async (method, params) => {
      if (method === 'turn/interrupt') interruptCalls.push(params);
      return {};
    },
  };

  try {
    await assert.rejects(
      pendingRunner.sendInput('must not replace pending request identity', {
        clientRequestId: 'replacement-request',
      }),
      (error) => error?.code === 'session_input_preparing'
    );
    assert.strictEqual(pendingRunner.activeClientRequestId, 'pending-client-request');

    const pending = await pendingRunner.interruptTurn({
      interruptRequestId: 'interrupt-pending-1',
      expectedClientRequestId: 'pending-client-request',
    });
    assert.strictEqual(pending.status, 'pending');
    assert.strictEqual(pendingRunner.runtime.phase, 'interrupting');
    assert.strictEqual(interruptCalls.length, 0, 'turn/interrupt must wait until Codex supplies the turn ID');

    await pendingRunner.handleNotification({
      method: 'turn/started',
      params: { turn: { id: 'late-native-turn', status: { type: 'inProgress' } } },
    });
    assert.deepStrictEqual(interruptCalls, [{
      threadId: 'runner-pending-interrupt-thread',
      turnId: 'late-native-turn',
    }]);
    assert.strictEqual(pendingRunner.runtime.phase, 'interrupting');
    assert.strictEqual(pendingRunner.pendingInterruptIntent, null);
    assert(events.some((event) => (
      event.type === 'session.interrupt_result'
      && event.interruptRequestId === 'interrupt-pending-1'
      && event.status === 'accepted'
      && event.turnId === 'late-native-turn'
    )), 'the late turn must publish a matching accepted interrupt result');

    const revisions = events
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => event.patch?.runtimeRevision);
    assert(revisions.length >= 2);
    assert(revisions.every((revision, index) => (
      Number.isSafeInteger(revision)
      && revision > 0
      && (index === 0 || revision > revisions[index - 1])
    )), 'Runner runtime revisions must increase monotonically');

    const mismatch = await pendingRunner.interruptTurn({
      interruptRequestId: 'interrupt-stale-target',
      expectedTurnId: 'different-turn',
    });
    assert.strictEqual(mismatch.status, 'no_active');
    assert.strictEqual(mismatch.reason, 'active_turn_changed');
    assert.strictEqual(interruptCalls.length, 1, 'a stale interrupt target must not hit the active turn');

    await pendingRunner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'late-native-turn', status: { type: 'interrupted' } } },
    });
    pendingRunner.activeClientRequestId = 'terminal-before-start-request';
    pendingRunner.runtime.phase = 'submitting-turn';
    pendingRunner.runtime.busy = true;
    const terminalPending = await pendingRunner.interruptTurn({
      interruptRequestId: 'interrupt-terminal-before-start',
      expectedClientRequestId: 'terminal-before-start-request',
    });
    assert.strictEqual(terminalPending.status, 'pending');
    await pendingRunner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'terminal-without-start', status: { type: 'completed' } } },
    });
    assert.strictEqual(interruptCalls.length, 1, 'an already terminal turn must not receive a late interrupt RPC');
    assert.strictEqual(pendingRunner.pendingInterruptIntent, null);
    assert.strictEqual(pendingRunner.activeTurnId, null);
    assert.strictEqual(pendingRunner.activeClientRequestId, null);
    assert(events.some((event) => (
      event.type === 'session.interrupt_result'
      && event.interruptRequestId === 'interrupt-terminal-before-start'
      && event.status === 'no_active'
      && event.reason === 'turn_already_completed'
    )), 'terminal-before-start ordering must explicitly settle the pending interrupt');
  } finally {
    pendingRunner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyTerminalTurnMonotonicity() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-terminal-turn-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  let resolveStart;
  const runner = new CodexAppServerRunner({
    hostId: 'runner-terminal-turn-host',
    sessionId: 'runner-terminal-turn-session',
    bridgeSessionId: 'runner-terminal-turn-session',
    runId: 'runner-terminal-turn-run',
    title: 'Runner terminal turn monotonicity',
    cwd: process.cwd(),
    launchMode: 'fresh',
    codexHome: baseHome,
    postEvent: async (event) => events.push(event),
  });
  runner.threadId = 'runner-terminal-turn-thread';
  runner.sessionId = runner.threadId;
  runner.nativeThreadId = runner.threadId;
  runner.rpc = {
    request: (method) => {
      if (method === 'turn/start') {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };

  try {
    const startPromise = runner.sendInput('terminal response must stay terminal', {
      clientRequestId: 'terminal-response-request',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(typeof resolveStart, 'function', 'the test must hold an unresolved turn/start response');

    await runner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'terminal-before-response', status: { type: 'completed' } } },
    });
    resolveStart({ turn: { id: 'terminal-before-response' } });
    assert.strictEqual(await startPromise, 'terminal-before-response');
    assert.strictEqual(runner.isTerminalTurnId('terminal-before-response'), true);
    assert.strictEqual(runner.activeTurnId, null, 'a late turn/start response must not resurrect a terminal turn');
    assert.strictEqual(runner.runtime.activeTurnId, null);
    assert.strictEqual(runner.runtime.busy, false);

    const eventCountBeforeLateStart = events.length;
    await runner.handleNotification({
      method: 'turn/started',
      params: { turn: { id: 'terminal-before-response', status: { type: 'inProgress' } } },
    });
    assert.strictEqual(runner.activeTurnId, null, 'a late turn/started notification must not resurrect a terminal turn');
    assert.strictEqual(runner.runtime.busy, false);
    assert.strictEqual(
      events.slice(eventCountBeforeLateStart).some((event) => (
        event.type === 'session.runtime_updated' && event.patch?.busy === true
      )),
      false,
      'late terminal notifications must not publish an active runtime projection'
    );

    runner.activeClientRequestId = 'exit-interrupt-request';
    runner.activeTurnId = 'exit-interrupt-turn';
    runner.clientRequestIdsByTurn.set('exit-interrupt-turn', 'exit-interrupt-request');
    runner.pendingInterruptIntent = {
      interruptRequestId: 'exit-interrupt',
      expectedClientRequestId: 'exit-interrupt-request',
    };
    await runner.finalizeExit(1, null);
    const exitInterruptResults = events.filter((event) => (
      event.type === 'session.interrupt_result' && event.interruptRequestId === 'exit-interrupt'
    ));
    assert.strictEqual(exitInterruptResults.length, 1, 'process exit must settle a pending interrupt exactly once');
    assert.strictEqual(exitInterruptResults[0].reason, 'turn_already_exited');
    assert.strictEqual(runner.pendingInterruptIntent, null);
  } finally {
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

verifyRetryRecoveryAndTerminalErrorState()
  .then(verifyPendingAcceptanceInterruptAndRuntimeRevision)
  .then(verifyTerminalTurnMonotonicity)
  .then(() => console.log('runner turn runtime state assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
