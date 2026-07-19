const assert = require('assert');
const { CodexAppServerRunner } = require('../apps/host-agent/codex-app-server-runner');

function createRunnerHarness(suffix) {
  const events = [];
  const timers = [];
  const runner = Object.create(CodexAppServerRunner.prototype);
  Object.assign(runner, {
    hostId: 'host-a',
    sessionId: `native-${suffix}`,
    bridgeSessionId: `bridge-${suffix}`,
    nativeThreadId: `native-${suffix}`,
    originSessionId: null,
    sourceSessionId: null,
    conversationKey: `conversation-${suffix}`,
    runId: `run-${suffix}`,
    activeTurnId: `turn-${suffix}`,
    threadId: `thread-${suffix}`,
    turnBuffers: new Map([[`turn-${suffix}`, '']]),
    turnModes: new Map(),
    planBuffers: new Map(),
    reasoningBuffers: new Map(),
    pendingRequests: new Map(),
    runtime: {},
    stopRequested: false,
    startCompleted: true,
    suppressTerminalEvent: false,
    overlayCleaned: false,
    apiProfileCleanupOwner: null,
    child: null,
    onTerminated: null,
    postEvent: async (event) => {
      events.push(JSON.parse(JSON.stringify(event)));
    },
  });
  runner.initializeThinkingActivity({
    setTimer(fn, delay) {
      const timer = { fn, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cancelled = true;
    },
    now: () => '2026-07-16T00:00:00.000Z',
  });
  runner.cleanupManagedOverlay = () => {
    runner.overlayCleaned = true;
    return true;
  };
  return { runner, events, timers };
}

async function feedReasoning(runner, suffix, chunks) {
  for (const delta of chunks) {
    await runner.handleNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: `thread-${suffix}`,
        turnId: `turn-${suffix}`,
        itemId: `reasoning-${suffix}`,
        summaryIndex: 0,
        delta,
      },
    });
  }
}

function enqueueReasoning(runner, suffix, chunks) {
  for (const delta of chunks) {
    runner.enqueueNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: `thread-${suffix}`,
        turnId: `turn-${suffix}`,
        itemId: `reasoning-${suffix}`,
        summaryIndex: 0,
        delta,
      },
    });
  }
}

function snapshots(events) {
  return events.filter((event) => event.type === 'session.activity_snapshot');
}

function assertFinalSnapshot(events, expectedText, label) {
  const activityEvents = snapshots(events);
  assert(activityEvents.length > 0, `${label} should emit an activity snapshot`);
  const final = activityEvents.at(-1);
  assert.strictEqual(final.text, expectedText, `${label} should preserve exact reasoning text`);
  assert.strictEqual(final.final, true, `${label} should force a final snapshot`);
  return final;
}

async function verifyExactItemCompletion() {
  const { runner, events, timers } = createRunnerHarness('item');
  const chunks = ['  One', ' two', ' three  '];
  const expected = chunks.join('');
  enqueueReasoning(runner, 'item', chunks);
  assert.strictEqual(timers.length, 1, 'rapid runner deltas should use one coalescing timer');
  assert.strictEqual(timers[0].delay, 75, 'runner coalescing must use exactly 75 ms');

  runner.enqueueNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-item',
      turnId: 'turn-item',
      completedAtMs: 1,
      item: {
        id: 'reasoning-item',
        type: 'reasoning',
        summary: [expected],
        content: [],
      },
    },
  });
  await runner.drainNotifications();

  assert.strictEqual(timers[0].cancelled, true, 'item completion should cancel the pending timer');
  assert.strictEqual(snapshots(events).length, 1, 'item completion should emit one coalesced full snapshot');
  const final = assertFinalSnapshot(events, expected, 'item completion');
  assert.strictEqual(final.activityRevision, 1);
  assert.strictEqual(final.canonicalConversationKey, 'host-a::conversation-item');
  assert.strictEqual(final.runId, 'run-item');
  assert.strictEqual(final.turnId, 'turn-item');
  assert.strictEqual(final.itemId, 'reasoning-item');
  assert.strictEqual(final.summaryIndex, 0);
  assert.strictEqual(final.kind, 'reasoning');

  const reasoningDiagnostics = events.filter(
    (event) => event.type === 'session.diagnostic' && event.kind === 'reasoning'
  );
  assert.deepStrictEqual(
    reasoningDiagnostics.map((event) => event.message),
    chunks,
    'compatibility diagnostics must retain each raw delta without trimming'
  );
  assert(
    reasoningDiagnostics.every((event) => !event.message.includes('\n')),
    'runner must not insert newlines between reasoning deltas'
  );
}

async function verifyTurnCompletion() {
  const { runner, events } = createRunnerHarness('turn');
  await feedReasoning(runner, 'turn', ['turn', ' complete']);
  await runner.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-turn',
      turn: { id: 'turn-turn', status: { type: 'completed' } },
    },
  });
  assertFinalSnapshot(events, 'turn complete', 'turn completion');
  const finalIndex = events.findIndex((event) => event.type === 'session.activity_snapshot' && event.final);
  const terminalIndex = events.findIndex(
    (event) => event.type === 'session.runtime_updated' && event.patch?.currentTurnStatus === 'completed'
  );
  assert(finalIndex >= 0 && terminalIndex > finalIndex, 'turn completion must flush Thinking before terminal runtime state');
}

async function verifyInterrupt() {
  const { runner, events } = createRunnerHarness('interrupt');
  runner.rpc = { request: async () => ({}) };
  await feedReasoning(runner, 'interrupt', ['interrupt', ' text']);
  assert.strictEqual(await runner.interruptTurn(), true);
  assertFinalSnapshot(events, 'interrupt text', 'interrupt');
  const finalIndex = events.findIndex((event) => event.type === 'session.activity_snapshot' && event.final);
  const terminalIndex = events.findIndex(
    (event) => event.type === 'session.runtime_updated' && event.patch?.phase === 'interrupted'
  );
  assert(finalIndex >= 0 && terminalIndex > finalIndex, 'interrupt must flush Thinking before interrupted state');
}

async function verifyTerminalError() {
  const { runner, events } = createRunnerHarness('error');
  await feedReasoning(runner, 'error', ['error', ' text']);
  await runner.handleNotification({
    method: 'error',
    params: {
      threadId: 'thread-error',
      turnId: 'turn-error',
      willRetry: false,
      error: { message: 'terminal failure' },
    },
  });
  assertFinalSnapshot(events, 'error text', 'terminal error');
  const finalIndex = events.findIndex((event) => event.type === 'session.activity_snapshot' && event.final);
  const errorIndex = events.findIndex((event) => event.type === 'session.error');
  assert(finalIndex >= 0 && errorIndex > finalIndex, 'terminal errors must flush Thinking before session.error');
}

async function verifyStop() {
  const { runner, events } = createRunnerHarness('stop');
  await feedReasoning(runner, 'stop', ['stop', ' text']);
  runner.terminationPromise = Promise.resolve();
  await runner.stop();
  assertFinalSnapshot(events, 'stop text', 'runner stop');
}

async function verifyProcessExit() {
  const { runner, events } = createRunnerHarness('exit');
  await feedReasoning(runner, 'exit', ['exit', ' text']);
  await runner.finalizeExit(7, null);
  assertFinalSnapshot(events, 'exit text', 'process exit');
  const finalIndex = events.findIndex((event) => event.type === 'session.activity_snapshot' && event.final);
  const stateIndex = events.findIndex((event) => event.type === 'session.state_changed');
  assert(finalIndex >= 0 && stateIndex > finalIndex, 'process exit must flush Thinking before terminal state');
}

async function main() {
  await verifyExactItemCompletion();
  await verifyTurnCompletion();
  await verifyInterrupt();
  await verifyTerminalError();
  await verifyStop();
  await verifyProcessExit();
  console.log('runner thinking snapshot assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
