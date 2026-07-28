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
    turnAssistantTranscriptEmitted: new Set(),
    pendingTurnCompletions: new Map(),
    turnCompletionFallbackGraceMs: 25,
    turnBufferTruncated: new Set(),
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
    [reasoningDiagnostics.map((event) => event.message).join('')],
    [expected],
    'coalesced compatibility diagnostics must retain the exact delta stream'
  );
  assert(
    reasoningDiagnostics.every((event) => !event.message.includes('\n')),
    'runner must not insert newlines between reasoning deltas'
  );
  assert.strictEqual(runner.thinkingActivities.size, 0, 'successful final delivery should release runner tracking');
  assert.strictEqual(runner.thinkingActivityAggregator.debugStats().records, 0);
}

function installBlockingDelivery(runner, events) {
  let releaseFirst = null;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  runner.postEvent = async (event) => {
    events.push(JSON.parse(JSON.stringify(event)));
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (calls === 1) {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    } finally {
      inFlight -= 1;
    }
  };
  return {
    release() {
      assert(releaseFirst, 'the first Relay delivery should be blocked');
      releaseFirst();
    },
    maxInFlight: () => maxInFlight,
  };
}

async function verifyBoundedNotificationQueue() {
  const { runner, events } = createRunnerHarness('bounded-queue');
  const delivery = installBlockingDelivery(runner, events);
  const chunkCount = 10_000;
  const expected = 'x'.repeat(chunkCount);
  enqueueReasoning(runner, 'bounded-queue', Array(chunkCount).fill('x'));
  runner.enqueueNotification({
    method: 'item/commandExecution/outputDelta',
    params: {
      threadId: 'thread-bounded-queue',
      turnId: 'turn-bounded-queue',
      itemId: 'command-bounded-queue',
      processId: 'process-bounded-queue',
      delta: 'z'.repeat(200_000),
    },
  });

  const blockedStats = runner.notificationQueueStats();
  assert.strictEqual(blockedStats.inFlightItems, 1, 'only one notification handler may be in flight');
  assert(blockedStats.totalItems <= blockedStats.maxItems, 'notification count must stay bounded');
  assert(blockedStats.totalBytes <= blockedStats.maxBytes, 'notification bytes must stay bounded');
  assert(
    runner.notificationQueue.every((entry) => entry.bytes <= blockedStats.maxItemBytes),
    'every retained notification must obey the per-item byte cap'
  );
  assert(
    blockedStats.pendingItems <= 3,
    '10,000 reasoning deltas should collapse into one pending keyed entry'
  );
  assert.strictEqual(runner.notificationHandlers, undefined, 'the runner must not retain an unbounded Promise Set');

  runner.enqueueNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-bounded-queue',
      turnId: 'turn-bounded-queue',
      item: {
        id: 'command-bounded-queue',
        type: 'commandExecution',
        command: 'large output fixture',
        cwd: process.cwd(),
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'z'.repeat(200_000),
        exitCode: 0,
        durationMs: 1,
      },
    },
  });
  runner.enqueueNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-bounded-queue',
      turnId: 'turn-bounded-queue',
      item: {
        id: 'reasoning-bounded-queue',
        type: 'reasoning',
        summary: [expected],
        content: [],
      },
    },
  });
  delivery.release();
  await runner.drainNotifications();

  assert.strictEqual(delivery.maxInFlight(), 1, 'slow Relay delivery must remain single-flight');
  assertFinalSnapshot(events, expected, 'bounded notification queue');
  assert.strictEqual(runner.notificationQueueStats().pendingItems, 0);
  assert.strictEqual(runner.notificationQueueStats().pendingBytes, 0);
  assert.strictEqual(runner.thinkingActivityAggregator.debugStats().records, 0);
}

async function verifyKeyedStateCoalescing() {
  const { runner, events } = createRunnerHarness('state-coalescing');
  const delivery = installBlockingDelivery(runner, events);
  runner.enqueueNotification({
    method: 'thread/status/changed',
    params: { threadId: 'thread-state-coalescing', status: { type: 'idle', activeFlags: [] } },
  });
  for (let index = 1; index <= 100; index += 1) {
    runner.enqueueNotification({
      method: 'thread/status/changed',
      params: {
        threadId: 'thread-state-coalescing',
        status: { type: index === 100 ? 'active' : 'idle', activeFlags: [], revision: index },
      },
    });
    runner.enqueueNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-state-coalescing',
        tokenUsage: { total: { totalTokens: index } },
      },
    });
    runner.enqueueNotification({
      method: 'account/rateLimits/updated',
      params: {
        accountId: 'account-a',
        rateLimits: { rateLimitReachedType: `limit-${index}` },
      },
    });
  }
  assert(
    runner.notificationQueueStats().pendingItems <= 3,
    'status, token, and rate-limit updates should each retain only their latest pending value'
  );
  delivery.release();
  await runner.drainNotifications();

  const runtimeEvents = events.filter((event) => event.type === 'session.runtime_updated');
  assert.strictEqual(runtimeEvents.filter((event) => event.patch?.threadStatus).at(-1).patch.threadStatus.revision, 100);
  assert.strictEqual(runtimeEvents.filter((event) => event.patch?.tokenUsage).at(-1).patch.tokenUsage.total.totalTokens, 100);
  assert.strictEqual(
    runtimeEvents.filter((event) => event.patch?.rateLimits).at(-1).patch.rateLimits.rateLimitReachedType,
    'limit-100'
  );
}

async function verifyTerminalBarrierAndOutputOrder() {
  const { runner, events } = createRunnerHarness('terminal-order');
  const delivery = installBlockingDelivery(runner, events);
  enqueueReasoning(runner, 'terminal-order', ['reasoning ', 'before terminal']);
  for (const delta of ['exact ', 'assistant ', 'output']) {
    runner.enqueueNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-terminal-order',
        turnId: 'turn-terminal-order',
        itemId: 'assistant-terminal-order',
        delta,
      },
    });
  }
  runner.enqueueNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-terminal-order',
      turn: { id: 'turn-terminal-order', status: { type: 'completed' } },
    },
  });
  delivery.release();
  await runner.drainNotifications();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const finalActivityIndex = events.findIndex(
    (event) => event.type === 'session.activity_snapshot' && event.final === true
  );
  const outputIndex = events.findIndex(
    (event) => event.type === 'session.output' && event.chunk === 'exact assistant output'
  );
  const terminalRuntimeIndex = events.findIndex(
    (event) => event.type === 'session.runtime_updated' && event.patch?.currentTurnStatus === 'completed'
  );
  assert(finalActivityIndex >= 0, 'terminal completion should flush the final activity');
  assert(outputIndex > finalActivityIndex, 'exact assistant output should follow the final activity');
  assert(terminalRuntimeIndex > outputIndex, 'terminal runtime state should follow exact assistant output');
  assert.strictEqual(delivery.maxInFlight(), 1);
}

async function verifyTerminalSurvivesOverflow() {
  const { runner, events } = createRunnerHarness('terminal-overflow');
  runner.initializeNotificationQueue({
    maxItems: 12,
    maxBytes: 32 * 1024,
    maxItemBytes: 4 * 1024,
    terminalReservedItems: 2,
    terminalReservedBytes: 4 * 1024,
  });
  const delivery = installBlockingDelivery(runner, events);
  enqueueReasoning(runner, 'terminal-overflow', ['terminal reasoning']);
  for (let index = 0; index < 100; index += 1) {
    runner.enqueueNotification({
      method: 'warning',
      params: { message: `best-effort-${index}` },
    });
  }
  runner.enqueueNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-terminal-overflow',
      turn: { id: 'turn-terminal-overflow', status: { type: 'completed' } },
    },
  });
  const blockedStats = runner.notificationQueueStats();
  assert(blockedStats.dropped > 0, 'best-effort telemetry should be evicted at the queue limit');
  assert(blockedStats.totalItems <= blockedStats.maxItems);
  assert(blockedStats.totalBytes <= blockedStats.maxBytes);
  assert(
    runner.notificationQueue.some((entry) => entry.message.method === 'turn/completed'),
    'terminal completion must survive best-effort overflow'
  );
  delivery.release();
  await runner.drainNotifications();

  const finalIndex = events.findIndex(
    (event) => event.type === 'session.activity_snapshot' && event.final === true
  );
  const terminalIndex = events.findIndex(
    (event) => event.type === 'session.runtime_updated' && event.patch?.currentTurnStatus === 'completed'
  );
  assert(finalIndex >= 0 && terminalIndex > finalIndex, 'overflow must not reorder final activity and terminal state');
  const overflowDiagnostics = events.filter(
    (event) => event.type === 'session.diagnostic' && event.kind === 'notification-overflow'
  );
  assert.strictEqual(overflowDiagnostics.length, 1, 'all overflow drops should produce one bounded diagnostic');
}

async function verifyCriticalTerminalEvictsItemTerminals() {
  const { runner, events } = createRunnerHarness('critical-terminal');
  runner.appendTurnBuffer('turn-critical-terminal', 'buffered assistant output');
  const delivery = installBlockingDelivery(runner, events);
  runner.enqueueNotification({
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-critical-terminal',
      status: { type: 'active', activeFlags: [] },
    },
  });
  for (let index = 0; index < 256; index += 1) {
    runner.enqueueNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-critical-terminal',
        turnId: 'turn-critical-terminal',
        item: {
          id: `reasoning-critical-terminal-${index}`,
          type: 'reasoning',
          summary: [],
          content: [],
        },
      },
    });
  }
  assert.strictEqual(
    runner.notificationQueueStats().totalItems,
    runner.notificationQueueStats().maxItems,
    'lower-priority item terminals should be able to fill the bounded queue'
  );
  runner.enqueueNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-critical-terminal',
      turn: { id: 'turn-critical-terminal', status: { type: 'completed' } },
    },
  });
  const criticalEntry = runner.notificationQueue.find(
    (entry) => entry.message.method === 'turn/completed'
  );
  assert(criticalEntry, 'turn/completed must displace a lower-priority item terminal');
  assert.strictEqual(criticalEntry.priority, 'critical-terminal');
  assert(runner.notificationQueueStats().totalItems <= runner.notificationQueueStats().maxItems);
  assert(
    runner.notificationQueueStats().dropped >= 2,
    'one overflowing item terminal and one displaced item terminal should be accounted for'
  );

  delivery.release();
  await runner.drainNotifications();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.strictEqual(
    runner.turnBuffers.has('turn-critical-terminal'),
    false,
    'critical turn completion must run and release the assistant turn buffer'
  );
  assert(
    events.some(
      (event) => event.type === 'session.runtime_updated' && event.patch?.currentTurnStatus === 'completed'
    ),
    'critical turn completion must deliver terminal runtime state'
  );
}

async function verifyOversizedRetryableErrorControlFields() {
  const { runner, events } = createRunnerHarness('retryable-error');
  runner.initializeNotificationQueue({
    maxItems: 32,
    maxBytes: 32 * 1024,
    maxItemBytes: 1024,
    terminalReservedItems: 2,
    terminalReservedBytes: 2 * 1024,
  });
  runner.appendTurnBuffer('turn-retryable-error', 'keep this turn buffer');
  const delivery = installBlockingDelivery(runner, events);
  runner.enqueueNotification({
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-retryable-error',
      status: { type: 'active', activeFlags: [] },
    },
  });
  runner.enqueueNotification({
    method: 'error',
    params: {
      threadId: `thread-retryable-error-${'t'.repeat(10_000)}`,
      turnId: 'turn-retryable-error',
      willRetry: true,
      error: {
        message: `retryable stream failure ${'m'.repeat(100_000)}`,
        additionalDetails: 'd'.repeat(100_000),
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: 503,
            detail: 'e'.repeat(100_000),
          },
        },
      },
    },
  });
  const queuedError = runner.notificationQueue.find((entry) => entry.message.method === 'error');
  assert(queuedError, 'oversized retryable error should remain queued after compaction');
  assert(queuedError.bytes <= runner.maxNotificationItemBytes);
  assert.strictEqual(queuedError.message.params.willRetry, true, 'compaction must preserve willRetry');
  assert.strictEqual(queuedError.message.params.turnId, 'turn-retryable-error', 'compaction must preserve turnId');
  assert(queuedError.message.params.error.message, 'compaction must preserve a minimal error message');
  assert.deepStrictEqual(
    queuedError.message.params.error.codexErrorInfo,
    { responseStreamDisconnected: { httpStatusCode: 503 } },
    'compaction must preserve recognized Codex error control fields'
  );
  assert.strictEqual(queuedError.message.params.error.additionalDetails, undefined, 'the second fallback should be used');
  assert.strictEqual(queuedError.priority, 'best-effort', 'retryable errors must not become terminal after compaction');

  delivery.release();
  await runner.drainNotifications();
  assert.strictEqual(
    runner.turnBuffers.get('turn-retryable-error'),
    'keep this turn buffer',
    'retryable errors must not clear the live turn buffer'
  );
  assert.strictEqual(runner.activeTurnId, 'turn-retryable-error');
  assert.strictEqual(
    events.filter((event) => event.type === 'session.runtime_updated').at(-1).patch.phase,
    'reconnecting'
  );
  assert.strictEqual(
    events.some((event) => event.type === 'session.error'),
    false,
    'retryable errors must not emit terminal session.error events'
  );
}

async function verifyTurnBufferByteLimit() {
  const { runner } = createRunnerHarness('turn-buffer-limit');
  runner.maxTurnBufferBytes = 1024;
  for (let index = 0; index < 1000; index += 1) {
    await runner.handleNotification({
      method: 'item/agentMessage/delta',
      params: {
        turnId: 'turn-turn-buffer-limit',
        itemId: 'assistant-turn-buffer-limit',
        delta: '\u4f60\u597d',
      },
    });
  }
  const buffered = runner.turnBuffers.get('turn-turn-buffer-limit');
  assert(Buffer.byteLength(buffered, 'utf8') <= 1024, 'assistant output buffer must obey its UTF-8 byte cap');
  assert(buffered.endsWith('...[assistant output truncated]'), 'bounded output should disclose truncation');
  assert(runner.turnBufferTruncated.has('turn-turn-buffer-limit'));
}

async function verifySlowDeliveryCoalescing() {
  const { runner } = createRunnerHarness('slow-delivery');
  const delivered = [];
  let releaseFirst = null;
  runner.postEvent = (event) => {
    delivered.push(JSON.parse(JSON.stringify(event)));
    if (delivered.length === 1) {
      return new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    return Promise.resolve();
  };
  const base = {
    canonicalConversationKey: 'host-a::conversation-slow-delivery',
    activityKey: 'slow-activity',
    runId: 'run-slow-delivery',
    turnId: 'turn-slow-delivery',
    itemId: 'item-slow-delivery',
    summaryIndex: 0,
    kind: 'reasoning',
    final: false,
    timestamp: '2026-07-16T00:00:00.000Z',
  };
  runner.emitActivitySnapshot({ ...base, activityRevision: 1, text: 'one' });
  await Promise.resolve();
  for (let revision = 2; revision <= 100; revision += 1) {
    runner.emitActivitySnapshot({
      ...base,
      activityRevision: revision,
      text: `revision-${revision}`,
    });
  }
  assert.strictEqual(
    runner.pendingActivitySnapshots.size,
    1,
    'a slow Relay should retain only the latest pending snapshot for one activity'
  );
  assert.strictEqual(runner.pendingActivitySnapshots.get(base.activityKey).activityRevision, 100);
  releaseFirst();
  await runner.waitForActivitySnapshotDelivery();
  assert.deepStrictEqual(
    delivered.map((event) => event.activityRevision),
    [1, 100],
    'delivery should preserve the in-flight snapshot and coalesce all later revisions'
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
  assert.strictEqual((await runner.interruptTurn()).status, 'accepted');
  assert.strictEqual(
    snapshots(events).some((event) => event.final),
    false,
    'an interrupt RPC acknowledgement must not finalize Thinking before the turn terminal event'
  );
  assert(events.some(
    (event) => event.type === 'session.runtime_updated' && event.patch?.phase === 'interrupting'
  ), 'an accepted interrupt should keep the active turn projected as interrupting');
  await runner.handleNotification({
    method: 'turn/completed',
    params: {
      threadId: 'thread-interrupt',
      turn: { id: 'turn-interrupt', status: { type: 'interrupted' } },
    },
  });
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
  assert.strictEqual(runner.turnBuffers.size, 0);
  assert.strictEqual(runner.turnModes.size, 0);
  assert.strictEqual(runner.planBuffers.size, 0);
  assert.strictEqual(runner.reasoningBuffers.size, 0, 'terminal errors must release all turn-scoped buffers');
}

async function verifyStop() {
  const { runner, events } = createRunnerHarness('stop');
  await feedReasoning(runner, 'stop', ['stop', ' text']);
  runner.terminationPromise = runner.finalizeExit(0, null);
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

async function verifyStructuredCommandActivity() {
  const { runner, events } = createRunnerHarness('structured-command');
  const base = {
    threadId: 'thread-structured-command',
    turnId: 'turn-structured-command',
  };
  await runner.handleNotification({
    method: 'item/started',
    params: {
      ...base,
      startedAtMs: 1000,
      item: {
        type: 'commandExecution',
        id: 'command-1',
        command: 'npm test',
        cwd: 'D:/workspace',
        processId: 'process-1',
        source: 'agent',
        status: 'inProgress',
        commandActions: [{ type: 'run', command: 'npm test' }],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    },
  });
  await runner.handleNotification({
    method: 'item/commandExecution/outputDelta',
    params: { ...base, itemId: 'command-1', delta: 'tests running\n' },
  });
  await runner.handleNotification({
    method: 'item/completed',
    params: {
      ...base,
      completedAtMs: 1450,
      item: {
        type: 'commandExecution',
        id: 'command-1',
        command: 'npm test',
        cwd: 'D:/workspace',
        processId: 'process-1',
        source: 'agent',
        status: 'completed',
        commandActions: [{ type: 'run', command: 'npm test' }],
        aggregatedOutput: 'tests running\npassed',
        exitCode: 0,
        durationMs: 450,
      },
    },
  });
  const final = events.filter((event) => (
    event.type === 'session.activity_snapshot'
    && event.itemId === 'command-1'
  )).at(-1);
  assert(final, 'command lifecycle should emit a structured activity');
  assert.strictEqual(final.final, true);
  assert.strictEqual(final.runId, 'run-structured-command');
  assert.strictEqual(final.turnId, 'turn-structured-command');
  assert.strictEqual(final.callId, 'command-1');
  assert.strictEqual(final.kind, 'command');
  assert.strictEqual(final.itemType, 'commandExecution');
  assert.strictEqual(final.command, 'npm test');
  assert.strictEqual(final.cwd, 'D:/workspace');
  assert.strictEqual(final.processId, 'process-1');
  assert.strictEqual(final.source, 'agent');
  assert.strictEqual(final.status, 'completed');
  assert.strictEqual(final.output, 'tests running\npassed');
  assert.strictEqual(final.exitCode, 0);
  assert.strictEqual(final.durationMs, 450);
  assert.strictEqual(final.startedAtMs, 1000);
  assert.strictEqual(final.completedAtMs, 1450);
}

async function verifyNativeCommandOutputTruncationIsSticky() {
  const { runner, events } = createRunnerHarness('native-output-truncation');
  const base = {
    threadId: 'thread-native-output-truncation',
    turnId: 'turn-native-output-truncation',
    itemId: 'command-native-output-truncation',
  };
  const method = 'item/commandExecution/outputDelta';
  const merged = runner.mergeNotificationMessages({
    method,
    params: { ...base, delta: 'partial ', capReached: true },
  }, {
    method,
    params: { ...base, delta: 'output', capReached: false },
  });
  assert.strictEqual(
    merged.params.capReached,
    true,
    'coalescing a later uncapped delta must retain an earlier native capReached marker'
  );
  await runner.handleNotification(merged);
  await runner.handleNotification({
    method,
    params: { ...base, delta: ' after cap' },
  });
  await runner.handleNotification({
    method: 'item/completed',
    params: {
      ...base,
      item: {
        type: 'commandExecution',
        id: base.itemId,
        command: 'emit capped output',
        status: 'completed',
        aggregatedOutput: 'partial output after cap',
        exitCode: 0,
      },
    },
  });
  const cappedFinal = events.filter((event) => (
    event.type === 'session.activity_snapshot' && event.itemId === base.itemId
  )).at(-1);
  assert(cappedFinal, 'native capReached output should emit a final command activity');
  assert.strictEqual(cappedFinal.output, 'partial output after cap');
  assert.strictEqual(
    cappedFinal.outputTruncated,
    true,
    'later deltas and an unflagged completion must not clear native capReached truncation'
  );

  const second = createRunnerHarness('native-output-truncated');
  const truncatedBase = {
    threadId: 'thread-native-output-truncated',
    turnId: 'turn-native-output-truncated',
    itemId: 'command-native-output-truncated',
  };
  await second.runner.handleNotification({
    method,
    params: { ...truncatedBase, delta: '', truncated: true },
  });
  await second.runner.handleNotification({
    method,
    params: { ...truncatedBase, delta: 'retained tail', truncated: false },
  });
  await second.runner.handleNotification({
    method: 'item/completed',
    params: {
      ...truncatedBase,
      item: {
        type: 'commandExecution',
        id: truncatedBase.itemId,
        command: 'emit truncated output',
        status: 'completed',
        aggregatedOutput: 'retained tail',
        exitCode: 0,
      },
    },
  });
  const truncatedFinal = second.events.filter((event) => (
    event.type === 'session.activity_snapshot' && event.itemId === truncatedBase.itemId
  )).at(-1);
  assert(truncatedFinal, 'native truncated output should emit a final command activity');
  assert.strictEqual(
    truncatedFinal.outputTruncated,
    true,
    'an empty native truncated delta must form a sticky outputTruncated marker'
  );
}

async function verifyStructuredFileAndMcpActivities() {
  const { runner, events } = createRunnerHarness('structured-tools');
  const base = {
    threadId: 'thread-structured-tools',
    turnId: 'turn-structured-tools',
  };
  const changes = [
    { path: 'src/new.js', kind: 'add', diff: '+const answer = 42;' },
    { path: 'src/old.js', kind: 'delete', diff: '-legacy();' },
  ];
  await runner.handleNotification({
    method: 'item/started',
    params: {
      ...base,
      item: { type: 'fileChange', id: 'patch-1', changes: [], status: 'inProgress' },
    },
  });
  await runner.handleNotification({
    method: 'item/fileChange/patchUpdated',
    params: { ...base, itemId: 'patch-1', changes },
  });
  await runner.handleNotification({
    method: 'item/completed',
    params: {
      ...base,
      item: { type: 'fileChange', id: 'patch-1', changes, status: 'completed' },
    },
  });
  const patch = events.filter((event) => (
    event.type === 'session.activity_snapshot'
    && event.itemId === 'patch-1'
  )).at(-1);
  assert.strictEqual(patch.itemType, 'fileChange');
  assert.strictEqual(patch.kind, 'file-change');
  assert.strictEqual(patch.fileChanges.length, 2);
  assert.strictEqual(patch.fileChanges[0].path, 'src/new.js');
  assert.strictEqual(patch.fileChanges[0].status, 'added');
  assert.strictEqual(patch.fileChanges[1].status, 'deleted');
  assert.deepStrictEqual(patch.changes, patch.fileChanges, 'changes should remain as a compatibility alias');

  await runner.handleNotification({
    method: 'item/started',
    params: {
      ...base,
      item: {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'docs',
        tool: 'search',
        status: 'inProgress',
        arguments: { query: 'activity schema' },
        result: null,
        error: null,
        durationMs: null,
      },
    },
  });
  for (const message of ['Searching index', 'Reading result']) {
    await runner.handleNotification({
      method: 'item/mcpToolCall/progress',
      params: { ...base, itemId: 'mcp-1', message },
    });
  }
  await runner.handleNotification({
    method: 'item/completed',
    params: {
      ...base,
      item: {
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'docs',
        tool: 'search',
        status: 'completed',
        arguments: { query: 'activity schema' },
        result: { content: [{ type: 'text', text: 'found' }] },
        error: null,
        durationMs: 90,
      },
    },
  });
  const mcp = events.filter((event) => (
    event.type === 'session.activity_snapshot'
    && event.itemId === 'mcp-1'
  )).at(-1);
  assert.strictEqual(mcp.itemType, 'mcpToolCall');
  assert.strictEqual(mcp.kind, 'mcp-tool');
  assert.strictEqual(mcp.callId, 'mcp-1');
  assert.strictEqual(mcp.server, 'docs');
  assert.strictEqual(mcp.tool, 'search');
  assert.deepStrictEqual(mcp.arguments, { query: 'activity schema' });
  assert.deepStrictEqual(mcp.result, { content: [{ type: 'text', text: 'found' }] });
  assert.strictEqual(mcp.progress, 'Searching index\nReading result');
  assert.strictEqual(mcp.durationMs, 90);
}

async function verifySubagentActivityProjection() {
  const { runner, events } = createRunnerHarness('subagent');
  const base = {
    threadId: 'thread-subagent',
    turnId: 'turn-subagent',
  };
  const item = {
    type: 'subAgentActivity',
    id: 'subagent-1',
    kind: 'interacted',
    status: 'interacted',
    agentThreadId: 'child-1',
    agentPath: '/root/review_code',
    agentNickname: 'Tesla',
    agentRole: 'reviewer',
    parentThreadId: 'thread-subagent',
  };
  await runner.handleNotification({
    method: 'item/started',
    params: { ...base, item: { ...item, kind: 'spawned', status: 'spawned' } },
  });
  await runner.handleNotification({
    method: 'item/completed',
    params: { ...base, completedAtMs: 1500, item },
  });

  const final = events.filter((event) => (
    event.type === 'session.activity_snapshot' && event.itemId === 'subagent-1'
  )).at(-1);
  assert(final, 'sub-agent lifecycle should emit an activity snapshot');
  assert.strictEqual(final.final, true);
  assert.strictEqual(final.kind, 'collaboration');
  assert.strictEqual(final.itemType, 'subAgentActivity');
  assert.strictEqual(final.subagentKind, 'interacted');
  assert.strictEqual(final.agentThreadId, 'child-1');
  assert.strictEqual(final.agentPath, '/root/review_code');
  assert.strictEqual(final.parentThreadId, 'thread-subagent');
  assert.strictEqual(final.senderThreadId, 'thread-subagent');
  assert.deepStrictEqual(final.receiverThreadIds, ['child-1']);
}

async function verifyStructuredActivityBoundsAndOversizedCompaction() {
  const { runner, events } = createRunnerHarness('structured-bounds');
  runner.initializeNotificationQueue({
    maxItems: 16,
    maxBytes: 64 * 1024,
    maxItemBytes: 4 * 1024,
    terminalReservedItems: 2,
    terminalReservedBytes: 8 * 1024,
  });
  runner.enqueueNotification({
    method: 'item/completed',
    params: {
      threadId: 'thread-structured-bounds',
      turnId: 'turn-structured-bounds',
      completedAtMs: 2000,
      item: {
        type: 'commandExecution',
        id: 'command-bounded',
        command: 'generate output',
        cwd: 'D:/workspace',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'x'.repeat(256 * 1024),
        exitCode: 0,
        durationMs: 10,
      },
    },
  });
  await runner.drainNotifications();
  const final = events.find((event) => (
    event.type === 'session.activity_snapshot'
    && event.itemId === 'command-bounded'
  ));
  assert(final, 'oversized item completion should survive notification compaction');
  assert.strictEqual(final.itemType, 'commandExecution');
  assert(Buffer.byteLength(final.output, 'utf8') <= 128 * 1024);
  assert.strictEqual(
    final.outputTruncated,
    true,
    'notification compaction must disclose that command output is only partially retained'
  );
  assert(Buffer.byteLength(JSON.stringify(final.arguments || null), 'utf8') <= 64 * 1024);
}

async function main() {
  await verifyExactItemCompletion();
  await verifyBoundedNotificationQueue();
  await verifyKeyedStateCoalescing();
  await verifyTerminalBarrierAndOutputOrder();
  await verifyTerminalSurvivesOverflow();
  await verifyCriticalTerminalEvictsItemTerminals();
  await verifyOversizedRetryableErrorControlFields();
  await verifyTurnBufferByteLimit();
  await verifySlowDeliveryCoalescing();
  await verifyTurnCompletion();
  await verifyInterrupt();
  await verifyTerminalError();
  await verifyStop();
  await verifyProcessExit();
  await verifyStructuredCommandActivity();
  await verifyNativeCommandOutputTruncationIsSticky();
  await verifyStructuredFileAndMcpActivities();
  await verifySubagentActivityProjection();
  await verifyStructuredActivityBoundsAndOversizedCompaction();
  console.log('runner thinking snapshot assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
