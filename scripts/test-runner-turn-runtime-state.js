const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CodexAppServerRunner } = require('../apps/host-agent/codex-app-server-runner');

const runner = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');

assert(
  /type: 'session\.review_started',[\s\S]{0,180}runId: this\.runId,/.test(runner),
  'Review started events must carry the owning runId so Relay can reject stale-run events'
);

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

assertContains(
  runner,
  'async annotateTurnStartRejection(error, inputItems, context = {})',
  'runner must classify synchronous turn/start capability rejections'
);
assertContains(
  runner,
  "error = await this.annotateTurnStartRejection(error, normalizedItems, { method: 'turn/start' })",
  'the direct turn/start rejection path must pass the submitted input types'
);
assertContains(
  runner,
  'fallbackError = await this.annotateTurnStartRejection(',
  'the Local Plan fallback rejection path must use the same classifier'
);

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
  'busy: Boolean(this.activeTurnId || unresolvedSubmission || waitingOnApproval || waitingOnUserInput),',
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

    runner.runtime.userFacingError = 'old friendly retry message';
    await runner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'turn-retry', status: { type: 'completed' } } },
    });
    await runner.flushPendingTurnCompletion('turn-retry');
    assert.strictEqual(runner.runtime.userFacingError, null, 'completion must clear the friendly error with other retry fields');
    runner.activeClientRequestId = 'turn-phase-request';
    runner.beginTurnLifecycle();
    const phaseSubmission = runner.createSubmissionAttempt({
      threadId: runner.threadId,
      input: [{ type: 'text', text: 'project item phases' }],
    });
    runner.runtime.phase = 'submitting-turn';
    runner.runtime.busy = true;

    const projectedOutputStart = events.length;
    runner.runtime.userFacingError = 'old error from the preceding turn';
    await runner.enqueueNotification({
      method: 'turn/started',
      params: {
        turn: {
          id: 'turn-phase-projection',
          status: { type: 'inProgress' },
          startedAt: (phaseSubmission.submittedAtMs + 10) / 1000,
          itemsView: 'full',
          items: [{
            id: 'turn-phase-projection-user',
            type: 'userMessage',
            content: phaseSubmission.input.map((item) => ({ ...item })),
          }],
        },
      },
    });
    assert.strictEqual(runner.activeTurnId, 'turn-phase-projection');
    assert.strictEqual(runner.runtime.userFacingError, null, 'turn/started must not revive an old friendly error');
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
    runner.activeClientRequestId = 'system-error-client-request';
    runner.clientRequestIdsByTurn.set('turn-system-error', 'system-error-client-request');
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
    await runner.enqueueNotification({
      method: 'thread/status/changed',
      params: {
        threadId: runner.threadId,
        status: {
          type: 'systemError',
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
    assert.strictEqual(runner.runtime.lastError, 'Codex thread entered a system error state.');
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
      && event.message === 'Codex thread entered a system error state.'
      && event.provisionalSystemError === true
    )), 'systemError must publish a terminal session.error event');

    const concreteErrorEventStart = events.length;
    await runner.handleNotification({
      method: 'error',
      params: {
        turnId: 'turn-system-error',
        willRetry: false,
        error: {
          message: 'Selected model is at capacity. Please try a different model.',
          codexErrorInfo: 'serverOverloaded',
        },
      },
    });
    const concreteErrorEvents = events.slice(concreteErrorEventStart);
    assert.strictEqual(runner.runtime.lastError, 'Selected model is at capacity. Please try a different model.');
    assert.strictEqual(runner.runtime.lastCodexError, 'serverOverloaded');
    assert(concreteErrorEvents.some((event) => (
      event.type === 'session.error'
      && event.supersedesProvisionalError === true
      && event.codexError === 'serverOverloaded'
      && event.clientRequestId === 'system-error-client-request'
    )), 'a concrete late Codex error must supersede the provisional systemError event');
    assert(!concreteErrorEvents.some((event) => (
      event.type === 'session.diagnostic'
      && /Ignored late error for inactive turn/.test(event.message || '')
    )), 'a concrete error that refines systemError must not be discarded as an inactive-turn error');

    setActiveTurn('turn-system-error-fenced');
    runner.activeClientRequestId = 'old-system-error-client';
    runner.clientRequestIdsByTurn.set('turn-system-error-fenced', 'old-system-error-client');
    await runner.enqueueNotification({
      method: 'thread/status/changed',
      params: {
        threadId: runner.threadId,
        status: { type: 'systemError' },
      },
    });
    runner.activeClientRequestId = 'new-turn-client';
    Object.assign(runner.runtime, {
      clientRequestId: 'new-turn-client',
      phase: 'submitting-turn',
      currentTurnStatus: 'submitting',
      lastError: null,
      lastCodexError: null,
    });
    const fencedErrorEventStart = events.length;
    await runner.handleNotification({
      method: 'error',
      params: {
        turnId: 'turn-system-error-fenced',
        willRetry: false,
        error: {
          message: 'late old-turn capacity error',
          codexErrorInfo: 'serverOverloaded',
        },
      },
    });
    const fencedErrorEvents = events.slice(fencedErrorEventStart);
    assert.strictEqual(runner.runtime.clientRequestId, 'new-turn-client');
    assert.strictEqual(runner.runtime.phase, 'submitting-turn');
    assert.strictEqual(runner.runtime.lastError, null);
    assert(!fencedErrorEvents.some((event) => (
      event.type === 'session.error'
      && event.message === 'late old-turn capacity error'
    )), 'a late old-turn error must not replace the runtime or alert for a newer submission');
    assert(fencedErrorEvents.some((event) => (
      event.type === 'session.diagnostic'
      && /Ignored late error for inactive turn/.test(event.message || '')
    )), 'a fenced old-turn error should retain the inactive-turn diagnostic');

    setActiveTurn('turn-concrete-error-first');
    await runner.handleNotification({
      method: 'error',
      params: {
        turnId: 'turn-concrete-error-first',
        willRetry: false,
        error: {
          message: 'specific provider failure arrived first',
          codexErrorInfo: 'serverOverloaded',
        },
      },
    });
    const lateSystemStatusEventStart = events.length;
    await runner.handleNotification({
      method: 'thread/status/changed',
      params: {
        threadId: runner.threadId,
        status: { type: 'systemError' },
      },
    });
    const lateSystemStatusEvents = events.slice(lateSystemStatusEventStart);
    assert.strictEqual(runner.runtime.lastError, 'specific provider failure arrived first');
    assert.strictEqual(runner.runtime.lastCodexError, 'serverOverloaded');
    assert(!lateSystemStatusEvents.some((event) => (
      event.type === 'session.error'
      && event.provisionalSystemError === true
    )), 'a late bare systemError status must not downgrade a concrete terminal error');
    assert(lateSystemStatusEvents.some((event) => (
      event.type === 'session.diagnostic'
      && /Ignored late systemError status/.test(event.message || '')
    )), 'the ignored reverse-order systemError should remain observable in diagnostics');

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
  pendingRunner.beginTurnLifecycle();
  const pendingSubmission = pendingRunner.createSubmissionAttempt({
    threadId: pendingRunner.threadId,
    input: [{ type: 'text', text: 'pending turn awaiting identity' }],
  });

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

    await pendingRunner.enqueueNotification({
      method: 'turn/started',
      params: {
        turn: {
          id: 'late-native-turn',
          status: { type: 'inProgress' },
          startedAt: (pendingSubmission.submittedAtMs + 10) / 1000,
          itemsView: 'full',
          items: [{
            id: 'late-native-turn-user',
            type: 'userMessage',
            content: pendingSubmission.input.map((item) => ({ ...item })),
          }],
        },
      },
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
    pendingRunner.beginTurnLifecycle();
    const terminalSubmission = pendingRunner.createSubmissionAttempt({
      threadId: pendingRunner.threadId,
      input: [{ type: 'text', text: 'terminal turn before start notification' }],
    });
    pendingRunner.runtime.phase = 'submitting-turn';
    pendingRunner.runtime.busy = true;
    const terminalPending = await pendingRunner.interruptTurn({
      interruptRequestId: 'interrupt-terminal-before-start',
      expectedClientRequestId: 'terminal-before-start-request',
    });
    assert.strictEqual(terminalPending.status, 'pending');
    await pendingRunner.enqueueNotification({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'terminal-without-start',
          status: { type: 'completed' },
          startedAt: (terminalSubmission.submittedAtMs + 10) / 1000,
          completedAt: (terminalSubmission.submittedAtMs + 20) / 1000,
          itemsView: 'full',
          items: [{
            id: 'terminal-without-start-user',
            type: 'userMessage',
            content: terminalSubmission.input.map((item) => ({ ...item })),
          }],
        },
      },
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

    const pendingAttempt = runner.activeSubmissionAttempt;
    assert(pendingAttempt, 'turn/start must retain submission evidence while its response is pending');
    await runner.enqueueNotification({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'terminal-before-response',
          status: { type: 'completed' },
          startedAt: (pendingAttempt.submittedAtMs + 10) / 1000,
          completedAt: (pendingAttempt.submittedAtMs + 20) / 1000,
          itemsView: 'full',
          items: [{
            id: 'terminal-before-response-user',
            type: 'userMessage',
            content: pendingAttempt.input.map((item) => ({ ...item })),
          }],
        },
      },
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

async function verifySubmissionAcceptanceReconciliationRaces() {
  const resources = [];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (predicate, message, timeoutMs = 750) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(5);
    }
    assert.fail(message);
  };
  const createRunner = (name, request) => {
    const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), `runner-submission-${name}-`));
    fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
    const events = [];
    const instance = new CodexAppServerRunner({
      hostId: `runner-submission-${name}-host`,
      sessionId: `runner-submission-${name}-session`,
      bridgeSessionId: `runner-submission-${name}-session`,
      runId: `runner-submission-${name}-run`,
      title: `Runner submission reconciliation ${name}`,
      cwd: process.cwd(),
      launchMode: 'fresh',
      codexHome: baseHome,
      submissionReconcileDelayMs: 10,
      submissionReconcileRetryMaxMs: 20,
      threadIdleProbeTimeoutMs: 25,
      postEvent: async (event) => events.push(event),
    });
    instance.threadId = `runner-submission-${name}-thread`;
    instance.sessionId = instance.threadId;
    instance.nativeThreadId = instance.threadId;
    instance.rpc = { request };
    resources.push({ runner: instance, baseHome });
    return { runner: instance, events };
  };
  const timeoutTurnStart = () => {
    const error = new Error('Timed out waiting for turn/start');
    error.code = 'codex_rpc_request_timeout';
    error.rpcMethod = 'turn/start';
    error.timeoutMs = 1;
    throw error;
  };
  const submissionTurn = (instance, turnId, status = 'inProgress') => {
    const submission = instance.pendingSubmissionReconciliation || instance.activeSubmissionAttempt;
    assert(submission, `submission evidence is required for ${turnId}`);
    return {
      id: turnId,
      status: { type: status },
      startedAt: (submission.submittedAtMs + 10) / 1000,
      completedAt: ['completed', 'interrupted', 'failed'].includes(status)
        ? (submission.submittedAtMs + 20) / 1000
        : null,
      itemsView: 'full',
      items: [{
        id: `${turnId}-user`,
        type: 'userMessage',
        content: submission.input.map((item) => ({ ...item })),
      }],
    };
  };
  const submitUnknown = async (instance, clientRequestId, options = {}) => {
    await assert.rejects(
      instance.sendInput('prompt accepted after a delayed response', {
        clientRequestId,
        ...options,
      }),
      (error) => error?.code === 'session_input_acceptance_unknown'
        && error?.nativeErrorCode === 'codex_rpc_request_timeout'
    );
    assert.strictEqual(instance.activeClientRequestId, clientRequestId);
    assert.strictEqual(instance.activeTurnId, null);
    assert.strictEqual(instance.runtime.busy, true);
    assert.strictEqual(instance.runtime.pendingClientRequestId, clientRequestId);
    assert(instance.pendingSubmissionReconciliation, 'acceptance-unknown must schedule reconciliation');
  };

  try {
    let retryReadCalls = 0;
    const retry = createRunner('retry', async (method, params) => {
      if (method === 'turn/start') return timeoutTurnStart();
      assert.strictEqual(method, 'thread/read');
      assert.strictEqual(params.threadId, retry.runner.threadId);
      retryReadCalls += 1;
      if (retryReadCalls === 1) throw new Error('temporary thread/read failure');
      return {
        thread: {
          id: retry.runner.threadId,
          status: { type: 'active' },
          turns: [submissionTurn(retry.runner, 'retry-late-turn')],
        },
      };
    });
    await submitUnknown(retry.runner, 'retry-request');
    await waitFor(
      () => retry.runner.runtime.phase === 'runtime-unknown',
      'a failed acceptance probe must publish runtime-unknown'
    );
    assert.strictEqual(retry.runner.activeClientRequestId, 'retry-request');
    assert.strictEqual(retry.runner.activeTurnId, null);
    await waitFor(
      () => retry.runner.activeTurnId === 'retry-late-turn',
      'acceptance reconciliation must retry thread/read and adopt the unique active Turn'
    );
    assert.strictEqual(retryReadCalls, 2);
    assert.strictEqual(retry.runner.clientRequestIdForTurn('retry-late-turn'), 'retry-request');
    assert.strictEqual(retry.runner.pendingSubmissionReconciliation, null);
    assert.strictEqual(
      retry.runner.activeSubmissionAttempt,
      null,
      'adopting a reconciled Turn must clear the matching pre-timeout submission attempt'
    );

    const mismatchedFingerprint = createRunner('fingerprint-mismatch', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      const turn = submissionTurn(mismatchedFingerprint.runner, 'wrong-input-turn');
      turn.items[0].content = [{ type: 'text', text: 'an older unrelated prompt' }];
      return {
        thread: {
          id: mismatchedFingerprint.runner.threadId,
          status: { type: 'active' },
          turns: [turn],
        },
      };
    });
    await submitUnknown(mismatchedFingerprint.runner, 'fingerprint-mismatch-request');
    await waitFor(
      () => mismatchedFingerprint.runner.runtime.phase === 'runtime-unknown',
      'a mismatched prompt fingerprint must remain fail-closed'
    );
    assert.strictEqual(mismatchedFingerprint.runner.activeTurnId, null);
    assert.strictEqual(mismatchedFingerprint.runner.activeClientRequestId, 'fingerprint-mismatch-request');
    mismatchedFingerprint.runner.cancelSubmissionReconciliation();

    const staleTimestamp = createRunner('timestamp-mismatch', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      const turn = submissionTurn(staleTimestamp.runner, 'stale-timestamp-turn');
      turn.startedAt = (staleTimestamp.runner.pendingSubmissionReconciliation.submittedAtMs - 5000) / 1000;
      return {
        thread: {
          id: staleTimestamp.runner.threadId,
          status: { type: 'active' },
          turns: [turn],
        },
      };
    });
    await submitUnknown(staleTimestamp.runner, 'timestamp-mismatch-request');
    await waitFor(
      () => staleTimestamp.runner.runtime.phase === 'runtime-unknown',
      'a Turn older than the submission must remain fail-closed'
    );
    assert.strictEqual(staleTimestamp.runner.activeTurnId, null);
    staleTimestamp.runner.cancelSubmissionReconciliation();

    const incompleteEvidence = createRunner('incomplete-evidence', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      return {
        thread: {
          id: incompleteEvidence.runner.threadId,
          status: { type: 'active' },
          turns: [{ id: 'summary-only-turn', status: { type: 'inProgress' }, itemsView: 'summary' }],
        },
      };
    });
    await submitUnknown(incompleteEvidence.runner, 'incomplete-evidence-request');
    await waitFor(
      () => incompleteEvidence.runner.runtime.phase === 'runtime-unknown',
      'a summary-only Turn must not prove submission acceptance'
    );
    assert.strictEqual(incompleteEvidence.runner.activeTurnId, null);
    incompleteEvidence.runner.cancelSubmissionReconciliation();

    let failClosedReadCalls = 0;
    const failClosed = createRunner('fail-closed', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      failClosedReadCalls += 1;
      if (failClosedReadCalls === 1) {
        return { thread: { status: { type: 'idle' }, turns: [] } };
      }
      return {
        thread: {
          status: { type: 'active' },
          turns: [
            { id: 'ambiguous-a', status: { type: 'inProgress' } },
            { id: 'ambiguous-b', status: { type: 'running' } },
          ],
        },
      };
    });
    await submitUnknown(failClosed.runner, 'fail-closed-request');
    await waitFor(() => failClosedReadCalls >= 2, 'idle and ambiguous probes must both retry');
    assert.strictEqual(failClosed.runner.activeTurnId, null);
    assert.strictEqual(failClosed.runner.activeClientRequestId, 'fail-closed-request');
    assert.strictEqual(failClosed.runner.runtime.busy, true);
    assert.strictEqual(failClosed.runner.runtime.phase, 'runtime-unknown');
    assert.strictEqual(
      failClosed.runner.runtime.submissionReconciliation?.reason,
      'active-turn-ambiguous'
    );
    failClosed.runner.cancelSubmissionReconciliation();

    let lateStartReadCalls = 0;
    let lateStartInterruptCalls = 0;
    const lateStart = createRunner('late-start', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      if (method === 'turn/read') throw new Error('unexpected turn/read');
      if (method === 'thread/read') {
        lateStartReadCalls += 1;
        return { thread: { status: { type: 'idle' }, turns: [] } };
      }
      assert.strictEqual(method, 'turn/interrupt');
      lateStartInterruptCalls += 1;
      return {};
    });
    await submitUnknown(lateStart.runner, 'late-start-request', {
      mode: 'plan',
      collaborationMode: { mode: 'plan', settings: { model: 'gpt-test' } },
      inputItems: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    });
    const pendingInterrupt = await lateStart.runner.interruptTurn({
      interruptRequestId: 'late-start-interrupt',
      expectedClientRequestId: 'late-start-request',
    });
    assert.strictEqual(pendingInterrupt.status, 'pending');
    await lateStart.runner.enqueueNotification({
      method: 'turn/started',
      params: { turn: submissionTurn(lateStart.runner, 'late-start-turn') },
    });
    assert.strictEqual(lateStart.runner.turnModes.get('late-start-turn'), 'plan');
    assert.deepStrictEqual(lateStart.runner.turnInputTypes.get('late-start-turn'), ['text', 'image']);
    assert.strictEqual(lateStart.runner.clientRequestIdForTurn('late-start-turn'), 'late-start-request');
    assert.strictEqual(lateStart.runner.pendingSubmissionReconciliation, null);
    assert.strictEqual(lateStartInterruptCalls, 1);
    await lateStart.runner.handleNotification({
      method: 'turn/started',
      params: { turn: { id: 'late-start-turn', status: { type: 'inProgress' } } },
    });
    await delay(35);
    assert.strictEqual(lateStartReadCalls, 0, 'turn/started must cancel the acceptance probe timer');
    assert.strictEqual(lateStartInterruptCalls, 1, 'a pending Interrupt must be sent exactly once');
    assert.strictEqual(
      lateStart.events.filter((event) => (
        event.type === 'session.interrupt_result'
        && event.interruptRequestId === 'late-start-interrupt'
      )).length,
      1,
      'a pending Interrupt must settle exactly once'
    );

    const terminalFirst = createRunner('terminal-first', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      throw new Error(`unexpected RPC: ${method}`);
    });
    await submitUnknown(terminalFirst.runner, 'terminal-first-request');
    await terminalFirst.runner.enqueueNotification({
      method: 'turn/completed',
      params: { turn: submissionTurn(terminalFirst.runner, 'terminal-first-turn', 'completed') },
    });
    assert.strictEqual(terminalFirst.runner.pendingSubmissionReconciliation, null);
    assert.strictEqual(terminalFirst.runner.activeTurnId, null);
    assert.strictEqual(terminalFirst.runner.activeClientRequestId, null);
    assert.strictEqual(terminalFirst.runner.runtime.busy, false);
    assert.strictEqual(terminalFirst.runner.runtime.phase, 'idle');
    assert.strictEqual(terminalFirst.runner.isTerminalTurnId('terminal-first-turn'), true);

    const retryEvent = createRunner('retry-event', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      if (method === 'thread/read') {
        return {
          thread: {
            id: retryEvent.runner.threadId,
            status: { type: 'active' },
            turns: [submissionTurn(retryEvent.runner, 'retry-event-turn')],
          },
        };
      }
      throw new Error(`unexpected RPC: ${method}`);
    });
    await submitUnknown(retryEvent.runner, 'retry-event-request');
    await retryEvent.runner.enqueueNotification({
      method: 'error',
      params: {
        turnId: 'retry-event-turn',
        willRetry: true,
        error: {
          message: 'temporary stream failure',
          codexErrorInfo: { responseStreamDisconnected: {} },
        },
      },
    });
    await waitFor(
      () => retryEvent.runner.activeTurnId === 'retry-event-turn',
      'an error-first event must wait for matching Turn evidence before adoption'
    );
    assert.strictEqual(retryEvent.runner.activeTurnId, 'retry-event-turn');
    assert.strictEqual(retryEvent.runner.clientRequestIdForTurn('retry-event-turn'), 'retry-event-request');
    assert.strictEqual(retryEvent.runner.activeClientRequestId, 'retry-event-request');
    assert.strictEqual(retryEvent.runner.pendingSubmissionReconciliation, null);
    assert.strictEqual(retryEvent.runner.runtime.busy, true);
    assert.strictEqual(retryEvent.runner.runtime.phase, 'reconnecting');

    let oldTerminalReadCalls = 0;
    const oldTerminal = createRunner('old-terminal', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      oldTerminalReadCalls += 1;
      return { thread: { status: { type: 'idle' }, turns: [] } };
    });
    oldTerminal.runner.rememberTerminalTurnId('old-terminal-turn');
    await submitUnknown(oldTerminal.runner, 'new-pending-request');
    const newPending = oldTerminal.runner.pendingSubmissionReconciliation;
    await oldTerminal.runner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'old-terminal-turn', status: { type: 'completed' } } },
    });
    assert.strictEqual(oldTerminal.runner.pendingSubmissionReconciliation, newPending);
    assert.strictEqual(oldTerminal.runner.activeClientRequestId, 'new-pending-request');
    assert.strictEqual(oldTerminal.runner.activeTurnId, null);
    await waitFor(() => oldTerminalReadCalls >= 1, 'the newer pending submission must keep probing');
    oldTerminal.runner.cancelSubmissionReconciliation();

    const reviewBlocked = createRunner('review-blocked', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      throw new Error(`unexpected RPC while Review is blocked: ${method}`);
    });
    await submitUnknown(reviewBlocked.runner, 'review-blocked-request');
    const reviewPending = reviewBlocked.runner.pendingSubmissionReconciliation;
    const reviewGeneration = reviewBlocked.runner.turnLifecycleGeneration;
    await assert.rejects(
      reviewBlocked.runner.startReview(),
      (error) => error?.code === 'session_input_preparing'
    );
    assert.strictEqual(reviewBlocked.runner.pendingSubmissionReconciliation, reviewPending);
    assert.strictEqual(reviewBlocked.runner.turnLifecycleGeneration, reviewGeneration);
    reviewBlocked.runner.cancelSubmissionReconciliation();

    const approvalDuringUnknown = createRunner('approval-unknown', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      return { thread: { status: { type: 'idle' }, turns: [] } };
    });
    approvalDuringUnknown.runner.rpc.respond = async () => {};
    await submitUnknown(approvalDuringUnknown.runner, 'approval-unknown-request');
    const approvalAttempt = approvalDuringUnknown.runner.pendingSubmissionReconciliation;
    const approvalTurnId = '019fcafe-0000-7000-8000-000000000002';
    await approvalDuringUnknown.runner.handleServerRequest({
      id: 7001,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: approvalDuringUnknown.runner.threadId,
        turnId: approvalTurnId,
        itemId: 'approval-unknown-command',
        command: 'echo approval-one',
        startedAtMs: approvalAttempt.submittedAtMs + 1,
      },
    });
    await approvalDuringUnknown.runner.handleServerRequest({
      id: 7002,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: approvalDuringUnknown.runner.threadId,
        turnId: approvalTurnId,
        itemId: 'approval-unknown-file-change',
        reason: 'approval two',
        startedAtMs: approvalAttempt.submittedAtMs + 2,
      },
    });
    await approvalDuringUnknown.runner.respondToRequest('7001', { decision: 'accept' });
    assert.strictEqual(approvalDuringUnknown.runner.runtime.waitingOnApproval, true);
    assert.strictEqual(approvalDuringUnknown.runner.runtime.busy, true);
    assert.strictEqual(approvalDuringUnknown.runner.runtime.phase, 'waiting-approval');
    await approvalDuringUnknown.runner.respondToRequest('7002', { decision: 'decline' });
    assert.strictEqual(approvalDuringUnknown.runner.runtime.waitingOnApproval, false);
    assert.strictEqual(approvalDuringUnknown.runner.runtime.busy, true);
    assert.strictEqual(approvalDuringUnknown.runner.runtime.phase, 'runtime-unknown');
    assert.strictEqual(
      approvalDuringUnknown.runner.runtime.pendingClientRequestId,
      'approval-unknown-request'
    );
    approvalDuringUnknown.runner.cancelSubmissionReconciliation();

    let lifecycleReadCalls = 0;
    const lifecycle = createRunner('lifecycle-cancel', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      lifecycleReadCalls += 1;
      return { thread: { status: { type: 'idle' }, turns: [] } };
    });
    await submitUnknown(lifecycle.runner, 'lifecycle-request');
    lifecycle.runner.beginTurnLifecycle();
    await delay(35);
    assert.strictEqual(lifecycleReadCalls, 0, 'beginTurnLifecycle must cancel the old acceptance timer');
    assert.strictEqual(lifecycle.runner.pendingSubmissionReconciliation, null);

    let stopReadCalls = 0;
    const stopped = createRunner('stop-cancel', async (method) => {
      if (method === 'turn/start') return timeoutTurnStart();
      stopReadCalls += 1;
      return { thread: { status: { type: 'idle' }, turns: [] } };
    });
    await submitUnknown(stopped.runner, 'stop-request');
    await stopped.runner.stop({ suppressTerminalEvent: true });
    await delay(35);
    assert.strictEqual(stopReadCalls, 0, 'Stop must cancel the old acceptance timer');
    assert.strictEqual(stopped.runner.pendingSubmissionReconciliation, null);
  } finally {
    for (const resource of resources) {
      resource.runner.cancelSubmissionReconciliation();
      resource.runner.cleanupManagedOverlay();
      fs.rmSync(resource.baseHome, { recursive: true, force: true });
    }
  }
}

async function verifyStaleIdleReconciliationAndInterruptRaces() {
  const resources = [];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (predicate, message, timeoutMs = 500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(5);
    }
    assert.fail(message);
  };
  const createRunner = (name, request, runnerOptions = {}) => {
    const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), `runner-stale-idle-${name}-`));
    fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
    const events = [];
    const instance = new CodexAppServerRunner({
      hostId: `runner-stale-idle-${name}-host`,
      sessionId: `runner-stale-idle-${name}-session`,
      bridgeSessionId: `runner-stale-idle-${name}-session`,
      runId: `runner-stale-idle-${name}-run`,
      title: `Runner stale idle ${name}`,
      cwd: process.cwd(),
      launchMode: 'fresh',
      codexHome: baseHome,
      threadIdleReconcileGraceMs: 10,
      threadIdleProbeTimeoutMs: 25,
      threadIdleRetryBaseMs: 10,
      threadIdleRetryMaxMs: 20,
      postEvent: async (event) => events.push(event),
      ...runnerOptions,
    });
    instance.threadId = `runner-stale-idle-${name}-thread`;
    instance.sessionId = instance.threadId;
    instance.nativeThreadId = instance.threadId;
    instance.rpc = { request };
    resources.push({ runner: instance, baseHome });
    return { runner: instance, events };
  };
  const activate = (instance, turnId, clientRequestId) => {
    instance.activeClientRequestId = clientRequestId;
    instance.activeTurnId = turnId;
    instance.beginTurnLifecycle(turnId);
    instance.bindClientRequestIdToTurn(turnId);
    instance.resetTurnBuffer(turnId);
    Object.assign(instance.runtime, {
      activeTurnId: turnId,
      clientRequestId,
      phase: 'thinking',
      busy: true,
      currentTurnStatus: 'inProgress',
      waitingOnApproval: false,
      waitingOnUserInput: false,
      terminalReconciliation: null,
    });
  };
  const idleNotification = (instance) => instance.handleNotification({
    method: 'thread/status/changed',
    params: {
      threadId: instance.threadId,
      status: { type: 'idle' },
    },
  });

  try {
    let idleReadCalls = 0;
    const recovered = createRunner('recovered', async (method, params) => {
      assert.strictEqual(method, 'thread/read');
      assert.strictEqual(params.includeTurns, true);
      idleReadCalls += 1;
      return {
        thread: {
          id: params.threadId,
          status: { type: 'idle' },
          turns: [{ id: 'stale-turn', status: { type: 'completed' } }],
        },
      };
    });
    activate(recovered.runner, 'stale-turn', 'stale-request');
    recovered.runner.pendingInterruptIntent = {
      interruptRequestId: 'stale-recovery-interrupt',
      expectedClientRequestId: 'stale-request',
    };
    await recovered.runner.handleNotification({
      method: 'item/completed',
      params: {
        threadId: recovered.runner.threadId,
        turnId: 'stale-turn',
        item: { id: 'stale-answer', type: 'agentMessage', text: 'one final answer' },
      },
    });
    await idleNotification(recovered.runner);
    assert.strictEqual(recovered.runner.runtime.phase, 'terminal-settling');
    assert.strictEqual(recovered.runner.runtime.activeTurnId, 'stale-turn');
    await waitFor(
      () => recovered.runner.runtime.activeTurnId === null,
      'thread/read idle should reconcile the stale active Turn'
    );
    assert.strictEqual(idleReadCalls, 1);
    assert.strictEqual(recovered.runner.runtime.busy, false);
    assert.strictEqual(recovered.runner.runtime.phase, 'idle');
    assert.strictEqual(recovered.runner.runtime.currentTurnStatus, 'completed');
    assert.strictEqual(recovered.runner.runtime.terminalReconciliation, null);
    assert.strictEqual(recovered.runner.pendingInterruptIntent, null);
    assert(recovered.events.some((event) => (
      event.type === 'session.interrupt_result'
      && event.interruptRequestId === 'stale-recovery-interrupt'
      && event.status === 'no_active'
      && event.reason === 'turn_already_completed'
    )), 'recovered completion must settle a pending Interrupt intent exactly once');
    await recovered.runner.handleNotification({
      method: 'item/completed',
      params: {
        threadId: recovered.runner.threadId,
        turnId: 'stale-turn',
        item: { id: 'stale-answer', type: 'agentMessage', text: 'one final answer' },
      },
    });
    await recovered.runner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'stale-turn', status: { type: 'completed' } } },
    });
    assert.strictEqual(
      recovered.events.filter((event) => event.type === 'session.transcript').length,
      1,
      'reconciliation and late terminal events must not duplicate the assistant reply'
    );

    let healthyProbeCalls = 0;
    const healthy = createRunner('healthy', async () => {
      healthyProbeCalls += 1;
      return { thread: { status: { type: 'idle' }, turns: [] } };
    });
    activate(healthy.runner, 'healthy-turn', 'healthy-request');
    await idleNotification(healthy.runner);
    await healthy.runner.handleNotification({
      method: 'turn/completed',
      params: { turn: { id: 'healthy-turn', status: { type: 'completed' } } },
    });
    await delay(35);
    assert.strictEqual(healthyProbeCalls, 0, 'normal turn/completed must cancel the idle probe');
    assert.strictEqual(healthy.runner.runtime.activeTurnId, null);
    assert.strictEqual(healthy.runner.runtime.terminalReconciliation, null);

    let progressProbeCalls = 0;
    const progressRecovery = createRunner('progress-recovery', async () => {
      progressProbeCalls += 1;
      return { thread: { status: { type: 'idle' }, turns: [] } };
    });
    activate(progressRecovery.runner, 'progress-turn', 'progress-request');
    await idleNotification(progressRecovery.runner);
    await progressRecovery.runner.handleNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: progressRecovery.runner.threadId,
        turnId: 'progress-turn',
        itemId: 'progress-reasoning',
        summaryIndex: 0,
        delta: 'the same Turn is visibly active again',
      },
    });
    await delay(35);
    assert.strictEqual(progressProbeCalls, 0, 'same-Turn progress must cancel the idle probe');
    assert.strictEqual(progressRecovery.runner.activeTurnId, 'progress-turn');
    assert.strictEqual(progressRecovery.runner.runtime.phase, 'thinking');
    assert.strictEqual(progressRecovery.runner.runtime.busy, true);
    assert.strictEqual(progressRecovery.runner.runtime.terminalReconciliation, null);

    const stillActive = createRunner('active', async () => ({
      thread: {
        status: { type: 'active' },
        turns: [{ id: 'active-turn', status: { type: 'inProgress' } }],
      },
    }));
    activate(stillActive.runner, 'active-turn', 'active-request');
    await idleNotification(stillActive.runner);
    await waitFor(
      () => stillActive.runner.runtime.phase === 'thinking',
      'thread/read active should restore the active projection'
    );
    assert.strictEqual(stillActive.runner.runtime.activeTurnId, 'active-turn');
    assert.strictEqual(stillActive.runner.runtime.busy, true);
    assert.strictEqual(stillActive.runner.runtime.terminalReconciliation, null);

    let resolveOldProbe;
    const fenced = createRunner('fenced', async () => new Promise((resolve) => {
      resolveOldProbe = resolve;
    }));
    activate(fenced.runner, 'old-turn', 'old-request');
    await idleNotification(fenced.runner);
    await waitFor(() => typeof resolveOldProbe === 'function', 'the old Turn probe should start');
    await fenced.runner.finalizeTurnCompletion({
      turn: { id: 'old-turn', status: { type: 'completed' } },
    }, 'old-turn');
    activate(fenced.runner, 'new-turn', 'new-request');
    resolveOldProbe({
      thread: {
        status: { type: 'idle' },
        turns: [{ id: 'old-turn', status: { type: 'completed' } }],
      },
    });
    await delay(20);
    assert.strictEqual(fenced.runner.activeTurnId, 'new-turn');
    assert.strictEqual(fenced.runner.runtime.activeTurnId, 'new-turn');
    assert.strictEqual(fenced.runner.runtime.busy, true);

    let queuedIdleProbeCalls = 0;
    const queuedIdle = createRunner('queued-idle', async () => {
      queuedIdleProbeCalls += 1;
      return { thread: { status: { type: 'idle' }, turns: [] } };
    });
    activate(queuedIdle.runner, 'queued-old-turn', 'queued-old-request');
    queuedIdle.runner.notificationQueueWorker = Promise.resolve();
    queuedIdle.runner.enqueueNotification({
      method: 'thread/status/changed',
      params: {
        threadId: queuedIdle.runner.threadId,
        status: { type: 'idle' },
      },
    });
    assert.strictEqual(queuedIdle.runner.notificationQueue.length, 1);
    assert.strictEqual(
      queuedIdle.runner.notificationQueue[0].priority,
      'critical-state',
      'idle with an observed active Turn must use terminal-reserved queue capacity'
    );
    activate(queuedIdle.runner, 'queued-new-turn', 'queued-new-request');
    queuedIdle.runner.notificationQueueWorker = null;
    await queuedIdle.runner.ensureNotificationQueueWorker();
    await delay(20);
    assert.strictEqual(queuedIdleProbeCalls, 0);
    assert.strictEqual(
      queuedIdle.runner.activeTurnId,
      'queued-new-turn',
      'an idle notification must retain the Turn ownership captured when it was queued'
    );
    assert.strictEqual(queuedIdle.runner.runtime.activeTurnId, 'queued-new-turn');
    assert.strictEqual(queuedIdle.runner.runtime.busy, true);

    let retryProbeCalls = 0;
    const retryRecovered = createRunner('retry-recovered', async () => {
      retryProbeCalls += 1;
      if (retryProbeCalls === 1) throw new Error('temporary thread/read failure');
      return {
        thread: {
          status: { type: 'idle' },
          turns: [{ id: 'retry-turn', status: { type: 'completed' } }],
        },
      };
    });
    activate(retryRecovered.runner, 'retry-turn', 'retry-request');
    await idleNotification(retryRecovered.runner);
    await waitFor(
      () => retryRecovered.runner.runtime.phase === 'runtime-unknown',
      'the first failed thread/read must remain fail-closed'
    );
    assert.strictEqual(retryRecovered.runner.activeTurnId, 'retry-turn');
    assert.strictEqual(retryRecovered.runner.runtime.busy, true);
    await waitFor(
      () => retryRecovered.runner.runtime.activeTurnId === null,
      'a later authoritative idle probe must recover the stale active Turn'
    );
    assert.strictEqual(retryProbeCalls, 2, 'runtime-unknown reconciliation should retry once before recovery');
    assert.strictEqual(retryRecovered.runner.runtime.phase, 'idle');
    assert.strictEqual(retryRecovered.runner.runtime.busy, false);
    assert.strictEqual(retryRecovered.runner.pendingThreadIdleReconciliation, null);

    const unknown = createRunner('unknown', async () => {
      throw new Error('thread/read unavailable');
    });
    activate(unknown.runner, 'unknown-turn', 'unknown-request');
    await idleNotification(unknown.runner);
    await waitFor(
      () => unknown.runner.runtime.phase === 'runtime-unknown',
      'failed thread/read must expose a fail-closed runtime-unknown state'
    );
    assert.strictEqual(unknown.runner.activeTurnId, 'unknown-turn');
    assert.strictEqual(unknown.runner.runtime.activeTurnId, 'unknown-turn');
    assert.strictEqual(unknown.runner.runtime.busy, true);
    assert.strictEqual(unknown.runner.runtime.terminalReconciliation.status, 'unknown');
    await unknown.runner.handleNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: unknown.runner.threadId,
        turnId: 'unknown-turn',
        itemId: 'unknown-recovered-reasoning',
        summaryIndex: 0,
        delta: 'new progress proves that the unknown Turn is active',
      },
    });
    assert.strictEqual(unknown.runner.activeTurnId, 'unknown-turn');
    assert.strictEqual(unknown.runner.runtime.activeTurnId, 'unknown-turn');
    assert.strictEqual(unknown.runner.runtime.phase, 'thinking');
    assert.strictEqual(unknown.runner.runtime.busy, true);
    assert.strictEqual(unknown.runner.runtime.terminalReconciliation, null);

    const noActive = createRunner('no-active-interrupt', async (method) => {
      assert.strictEqual(method, 'turn/interrupt');
      const error = new Error('no active turn to interrupt');
      error.rpcCode = -32602;
      error.rpcData = { code: 'no_active_turn' };
      throw error;
    });
    activate(noActive.runner, 'interrupt-stale-turn', 'interrupt-stale-request');
    const noActiveResult = await noActive.runner.interruptActiveTurn({
      interruptRequestId: 'interrupt-no-active',
    });
    assert.strictEqual(noActiveResult.status, 'no_active');
    assert.strictEqual(noActiveResult.reason, 'native_no_active_turn');
    assert.strictEqual(noActive.runner.activeTurnId, null);
    assert.strictEqual(noActive.runner.runtime.activeTurnId, null);
    assert.strictEqual(noActive.runner.runtime.phase, 'interrupted');
    assert.strictEqual(noActive.runner.runtime.terminalReconciliation, null);

    const genericFailure = createRunner('generic-interrupt', async () => {
      throw new Error('interrupt transport failed');
    });
    activate(genericFailure.runner, 'generic-turn', 'generic-request');
    await assert.rejects(
      genericFailure.runner.interruptActiveTurn({ interruptRequestId: 'generic-interrupt' }),
      /interrupt transport failed/
    );
    assert.strictEqual(genericFailure.runner.activeTurnId, 'generic-turn');
    assert.strictEqual(genericFailure.runner.runtime.phase, 'thinking');
    assert.strictEqual(genericFailure.runner.runtime.busy, true);

    let rejectPendingInterrupt;
    const interruptRace = createRunner('interrupt-race', async () => new Promise((resolve, reject) => {
      rejectPendingInterrupt = reject;
    }));
    activate(interruptRace.runner, 'race-turn', 'race-request');
    const interruptPromise = interruptRace.runner.interruptActiveTurn({
      interruptRequestId: 'race-interrupt',
    });
    await waitFor(
      () => typeof rejectPendingInterrupt === 'function',
      'the interrupt RPC should remain pending for the race test'
    );
    await interruptRace.runner.finalizeTurnCompletion({
      turn: { id: 'race-turn', status: { type: 'completed' } },
    }, 'race-turn');
    rejectPendingInterrupt(new Error('late interrupt failure'));
    await assert.rejects(interruptPromise, /late interrupt failure/);
    assert.strictEqual(interruptRace.runner.activeTurnId, null);
    assert.strictEqual(interruptRace.runner.runtime.activeTurnId, null);
    assert.strictEqual(interruptRace.runner.runtime.phase, 'idle');
    assert.strictEqual(interruptRace.runner.runtime.busy, false);
  } finally {
    for (const resource of resources) {
      resource.runner.cancelThreadIdleReconciliation();
      resource.runner.cleanupManagedOverlay();
      fs.rmSync(resource.baseHome, { recursive: true, force: true });
    }
  }
}

verifyRetryRecoveryAndTerminalErrorState()
  .then(verifyPendingAcceptanceInterruptAndRuntimeRevision)
  .then(verifySubmissionAcceptanceReconciliationRaces)
  .then(verifyTerminalTurnMonotonicity)
  .then(verifyStaleIdleReconciliationAndInterruptRaces)
  .then(() => console.log('runner turn runtime state assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
