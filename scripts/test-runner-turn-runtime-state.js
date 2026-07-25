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
const reasoningBlock = extractBlock(
  "if (method === 'item/reasoning/summaryTextDelta')",
  "if (method === 'item/plan/delta' || method === 'turn/plan/updated')",
  notificationHandlerStart
);
assertContains(
  reasoningBlock,
  'const isActiveTurn = turnId && turnId === this.activeTurnId;',
  'late reasoning deltas for a completed turn must not resurrect active runtime state'
);
assertContains(
  reasoningBlock,
  'if (isActiveTurn) {',
  'runner should only emit busy thinking runtime for the currently active turn'
);

const planBlock = extractBlock(
  "if (method === 'item/plan/delta' || method === 'turn/plan/updated')",
  "if (method === 'thread/tokenUsage/updated')",
  notificationHandlerStart
);
assertContains(
  planBlock,
  'const isActiveTurn = turnId && turnId === this.activeTurnId;',
  'late plan deltas for a completed turn must not resurrect active runtime state'
);
assertContains(
  planBlock,
  'if (isActiveTurn) {',
  'runner should only emit busy planning runtime for the currently active turn'
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
    assert.strictEqual(runner.reasoningBuffers.has('turn-system-error'), false);
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

verifyRetryRecoveryAndTerminalErrorState()
  .then(() => console.log('runner turn runtime state assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
