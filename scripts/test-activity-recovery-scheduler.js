const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const schedulerStart = app.indexOf('function discardStaleActivitySnapshotRecoveryTasks(');
const schedulerEnd = app.indexOf('\nfunction clearStreamDetailRecoveryRetry', schedulerStart);
assert(schedulerStart >= 0 && schedulerEnd > schedulerStart, 'activity recovery scheduler source is missing');

let nextTimerId = 0;
const timers = new Map();
const context = vm.createContext({
  ACTIVITY_SNAPSHOT_RECOVERY_DEBOUNCE_MS: 250,
  ACTIVITY_SNAPSHOT_RECOVERY_MAX_WAIT_MS: 2_000,
  ACTIVITY_SNAPSHOT_RECOVERY_MAX_TARGETS: 8,
  ACTIVITY_SNAPSHOT_RECOVERY_RETRY_MAX_MS: 30_000,
  Date,
  Map,
  Math,
  Number,
  String,
  Promise,
  selectedSession: { canonicalKey: 'host::a' },
  state: {
    activitySnapshotRecoveryTasks: new Map(),
    eventCursorByCanonical: new Map(),
    streamDetailRecoveryInFlight: false,
    streamDetailRecoveryPendingKey: null,
    streamActivityRecoveryPendingKeys: new Set(),
    streamDetailRecoveryRetryTimer: null,
    streamDetailRecoveryRetryKey: null,
    streamDetailRecoveryRetryAttempt: 0,
    streamDetailRecoveryCanonicalKeys: new Map(),
    fullTranscriptLoaded: new Set(),
  },
  window: {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  },
  getSelectedSession() {
    return context.selectedSession;
  },
  getActivityCanonicalKeyForSession(session) {
    return session?.canonicalKey || '';
  },
  getSessionKey(session) {
    return session?.hostId && session?.sessionId
      ? `${session.hostId}::${session.sessionId}`
      : '';
  },
  rememberSessionStreamEvent(session, event, payload) {
    const canonicalKey = payload?.canonicalConversationKey || session?.canonicalKey || '';
    if (canonicalKey && event?.lastEventId) {
      context.state.eventCursorByCanonical.set(canonicalKey, event.lastEventId);
    }
    return canonicalKey;
  },
  loadSessionActivitySnapshot: async () => ({}),
  loadSessionActivityRecords: async (_session, requested) => new Map(requested),
  withStreamRecoveryTimeout: async (operation) => operation(undefined),
  reportError(error) {
    context.reportedErrors.push(error);
  },
  reportedErrors: [],
  showSession: async () => {},
});
vm.runInContext(app.slice(schedulerStart, schedulerEnd), context);
const resetRecoveryStart = app.indexOf('function clearStreamDetailRecoveryRetry()');
const resetRecoveryEnd = app.indexOf('\nfunction updateSelectedViews', resetRecoveryStart);
assert(resetRecoveryStart >= 0 && resetRecoveryEnd > resetRecoveryStart, 'reset recovery source is missing');
vm.runInContext(app.slice(resetRecoveryStart, resetRecoveryEnd), context);

function schedule(revision = 1, recoveryToken = 'recovery-token') {
  return context.scheduleActivitySnapshotRecovery(
    context.selectedSession,
    { lastEventId: `epoch:${revision}` },
    {
      canonicalConversationKey: context.selectedSession.canonicalKey,
      activityRecoveryToken: recoveryToken,
      activityRevision: revision,
      activityTruncated: true,
    }
  );
}

async function runScheduledTask() {
  const task = context.state.activitySnapshotRecoveryTasks.get('host::a');
  assert(task, 'expected a scheduled recovery task');
  if (task.timer) context.window.clearTimeout(task.timer);
  task.timer = null;
  await context.runActivitySnapshotRecovery(task);
  return task;
}

async function main() {
  schedule(1);
  assert.strictEqual(context.state.eventCursorByCanonical.get('host::a'), 'epoch:1');
  context.selectedSession = { canonicalKey: 'host::b' };
  context.discardStaleActivitySnapshotRecoveryTasks();
  assert.strictEqual(context.state.activitySnapshotRecoveryTasks.has('host::a'), false);
  assert.strictEqual(
    context.state.eventCursorByCanonical.has('host::a'),
    false,
    'switching away must invalidate the cursor for an unrecovered compact event'
  );

  context.selectedSession = { canonicalKey: 'host::a' };
  context.loadSessionActivityRecords = async () => {
    throw new Error('temporary activity endpoint outage');
  };
  schedule(2);
  const failedTask = await runScheduledTask();
  assert.strictEqual(context.state.activitySnapshotRecoveryTasks.get('host::a'), failedTask);
  assert.strictEqual(failedTask.pendingActivities.get('recovery-token'), 2);
  assert.strictEqual(failedTask.retryAttempt, 1);
  assert(failedTask.timer, 'a failed recovery must schedule a retry');
  assert.strictEqual(context.reportedErrors.length, 1, 'one outage should report only its first error');

  context.state.activitySnapshotRecoveryTasks.clear();
  timers.clear();
  let resolveRecovery;
  context.loadSessionActivityRecords = () => new Promise((resolve) => {
    resolveRecovery = resolve;
  });
  schedule(3);
  const inFlightTask = context.state.activitySnapshotRecoveryTasks.get('host::a');
  if (inFlightTask.timer) context.window.clearTimeout(inFlightTask.timer);
  inFlightTask.timer = null;
  const recovery = context.runActivitySnapshotRecovery(inFlightTask);
  await Promise.resolve();
  schedule(4);
  assert.strictEqual(inFlightTask.pendingActivities.get('recovery-token'), 4);
  resolveRecovery(new Map([['recovery-token', 4]]));
  await recovery;
  assert.strictEqual(
    context.state.activitySnapshotRecoveryTasks.has('host::a'),
    false,
    'a response covering an in-flight invalidation should avoid a redundant full recovery'
  );

  let resolveBoundedRecovery;
  context.loadSessionActivityRecords = () => new Promise((resolve) => {
    resolveBoundedRecovery = resolve;
  });
  schedule(10, 'base-token');
  const boundedTask = context.state.activitySnapshotRecoveryTasks.get('host::a');
  if (boundedTask.timer) context.window.clearTimeout(boundedTask.timer);
  boundedTask.timer = null;
  const boundedRecovery = context.runActivitySnapshotRecovery(boundedTask);
  await Promise.resolve();
  for (let index = 0; index < 10; index += 1) {
    schedule(11 + index, `pending-token-${index}`);
  }
  assert.strictEqual(boundedTask.pendingActivities.size, 0);
  assert.strictEqual(
    boundedTask.fullSnapshotRequired,
    true,
    'too many tokens arriving during a hung request must collapse to one bounded full recovery'
  );
  resolveBoundedRecovery(new Map([['base-token', 10]]));
  await boundedRecovery;
  if (boundedTask.timer) context.window.clearTimeout(boundedTask.timer);
  context.state.activitySnapshotRecoveryTasks.clear();

  context.selectedSession = {
    hostId: 'host',
    sessionId: 'session-a',
    canonicalKey: 'host::a',
  };
  context.state.eventCursorByCanonical.set('host::a', 'epoch:reset');
  let activityLoads = 0;
  context.showSession = async () => {
    throw new Error('temporary detail outage');
  };
  context.loadSessionActivitySnapshot = async () => {
    activityLoads += 1;
  };
  await assert.rejects(
    context.reconcileSelectedSessionAfterStreamReset(context.selectedSession, { activities: true }),
    /temporary detail outage/
  );
  const selectedKey = context.getSessionKey(context.selectedSession);
  assert.strictEqual(activityLoads, 1, 'activity state should recover even when detail loading fails');
  assert.strictEqual(context.state.streamDetailRecoveryPendingKey, selectedKey);
  assert(context.state.streamDetailRecoveryRetryTimer, 'a failed reset recovery must remain scheduled');
  assert.strictEqual(context.state.eventCursorByCanonical.has('host::a'), false);

  context.state.eventCursorByCanonical.set('host::a', 'epoch:later-event');
  context.selectedSession = {
    hostId: 'host',
    sessionId: 'session-b',
    canonicalKey: 'host::b',
  };
  context.discardStaleStreamDetailRecovery();
  assert.strictEqual(
    context.state.eventCursorByCanonical.has('host::a'),
    false,
    'switching away must invalidate a reset cursor even after later events advanced it again'
  );

  context.selectedSession = {
    hostId: 'host',
    sessionId: 'session-a',
    canonicalKey: 'host::a',
  };
  context.showSession = async () => {};
  await context.reconcileSelectedSessionAfterStreamReset(context.selectedSession);
  assert.strictEqual(context.state.streamDetailRecoveryPendingKey, null);
  assert.strictEqual(context.state.streamDetailRecoveryRetryTimer, null);
  assert.strictEqual(context.state.streamDetailRecoveryRetryAttempt, 0);

  console.log('activity recovery scheduler assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
