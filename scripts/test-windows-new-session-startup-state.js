const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const runner = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert(start >= 0 && end > start, `expected to extract ${name}`);
  return source.slice(start, end);
}

function assertBridgeRuntimeMigrationKeepsNativeIdleState() {
  const source = extractFunction(relay, 'moveSessionArtifacts', 'migrateSessionIdentity');
  const state = {
    sessionLogs: new Map(),
    sessionAlerts: new Map(),
    sessionRuntime: new Map(),
    sessionDiagnostics: new Map(),
    sessionRequests: new Map(),
    subscribers: new Map(),
  };
  const sessionKey = (hostId, sessionId) => `${hostId}::${sessionId}`;
  const nowIso = () => '2026-06-28T00:00:00.000Z';
  const mergeByFingerprint = (entries) => entries;
  const transcriptFingerprint = (entry) => JSON.stringify(entry);
  const SESSION_LOG_ENTRY_LIMIT = 100;
  const SESSION_DIAGNOSTIC_ENTRY_LIMIT = 100;
  const scheduleSessionLogsSave = () => {};
  const scheduleSessionDiagnosticsSave = () => {};

  // eslint-disable-next-line no-new-func
  const moveSessionArtifacts = new Function(
    'state',
    'sessionKey',
    'nowIso',
    'mergeByFingerprint',
    'transcriptFingerprint',
    'SESSION_LOG_ENTRY_LIMIT',
    'SESSION_DIAGNOSTIC_ENTRY_LIMIT',
    'scheduleSessionLogsSave',
    'scheduleSessionDiagnosticsSave',
    `${source}\nreturn moveSessionArtifacts;`
  )(
    state,
    sessionKey,
    nowIso,
    mergeByFingerprint,
    transcriptFingerprint,
    SESSION_LOG_ENTRY_LIMIT,
    SESSION_DIAGNOSTIC_ENTRY_LIMIT,
    scheduleSessionLogsSave,
    scheduleSessionDiagnosticsSave
  );

  state.sessionRuntime.set(sessionKey('win', 'bridge-session'), {
    phase: 'starting-thread',
    startupStep: 'thread-start',
    busy: true,
    connection: 'ready',
    runId: 'run-1',
    codexHome: 'C:/isolated/.codex',
    updatedAt: '2026-06-28T00:00:01.000Z',
  });
  state.sessionRuntime.set(sessionKey('win', 'native-thread'), {
    phase: 'idle',
    startupStep: 'ready',
    busy: false,
    activeTurnId: null,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    threadId: 'native-thread',
    updatedAt: '2026-06-28T00:00:02.000Z',
  });

  moveSessionArtifacts('win', 'bridge-session', 'native-thread');
  const migrated = state.sessionRuntime.get(sessionKey('win', 'native-thread'));
  assert.strictEqual(migrated.phase, 'idle', 'bridge->native migration must not regress an idle native runtime back to starting-thread');
  assert.strictEqual(migrated.startupStep, 'ready', 'bridge->native migration must preserve the native ready startup step');
  assert.strictEqual(migrated.busy, false, 'bridge->native migration must not make the new thread look busy/queued again');
  assert.strictEqual(migrated.codexHome, 'C:/isolated/.codex', 'bridge metadata such as isolated CODEX_HOME should still be preserved');
  assert(!state.sessionRuntime.has(sessionKey('win', 'bridge-session')), 'bridge runtime should be removed after migration');
}

function assertThreadStartedNotificationClearsStartupBusyState() {
  const start = runner.indexOf("if (method === 'thread/started' && params.thread?.id)");
  const end = runner.indexOf("if (method === 'thread/status/changed')", start);
  assert(start >= 0 && end > start, 'runner should handle thread/started notifications before thread/status/changed');
  const block = runner.slice(start, end);
  assertContains(block, "phase: 'idle'", 'thread/started should mark the runtime idle');
  assertContains(block, "startupStep: 'ready'", 'thread/started should explicitly mark startup ready');
  assertContains(block, 'busy: false', 'thread/started should explicitly clear startup busy state');
}

function assertFreshLiveEmptyManagedSessionSkipsHistoryDetail() {
  assertContains(
    app,
    'function isFreshLiveManagedSessionWithoutHistory(session)',
    'UI should recognize a freshly created live managed session with no transcript yet'
  );
  assertContains(
    app,
    'function shouldFetchSessionDetailOnOpen(session, options = {})',
    'UI should centralize the decision to fetch full history when a session is opened'
  );

  const helperStart = app.indexOf('function shouldFetchSessionDetailOnOpen(session, options = {})');
  const helperEnd = app.indexOf('function isSessionStartTerminalState', helperStart);
  assert(helperStart >= 0 && helperEnd > helperStart, 'app should define shouldFetchSessionDetailOnOpen before isSessionStartTerminalState');
  const helper = app.slice(helperStart, helperEnd);
  assertContains(
    helper,
    '!isFreshLiveManagedSessionWithoutHistory(session)',
    'opening a fresh live empty managed session should not force /detail?full=1 before the first turn exists'
  );

  const showStart = app.indexOf('async function showSession(session = getSelectedSession(), options = {})');
  const showEnd = app.indexOf('function buildSessionExportUrl', showStart);
  assert(showStart >= 0 && showEnd > showStart, 'app should define showSession before buildSessionExportUrl');
  const showSession = app.slice(showStart, showEnd);
  assertContains(
    showSession,
    'const shouldFetchDetail = shouldFetchSessionDetailOnOpen(session, options);',
    'showSession should ask a helper whether history detail is needed'
  );
  assertContains(
    showSession,
    'if (!shouldFetchDetail)',
    'showSession should short-circuit detail loading for fresh live empty sessions'
  );
}

assertBridgeRuntimeMigrationKeepsNativeIdleState();
assertThreadStartedNotificationClearsStartupBusyState();
assertFreshLiveEmptyManagedSessionSkipsHistoryDetail();

console.log('windows new-session startup state assertions passed');
