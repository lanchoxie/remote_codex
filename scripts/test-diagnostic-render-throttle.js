const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const htmlPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'index.html');
const stylesPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'styles.css');
const app = fs.readFileSync(appPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const styles = fs.readFileSync(stylesPath, 'utf8');

function sliceBetween(startNeedle, endNeedle, label) {
  const start = app.indexOf(startNeedle);
  assert(start >= 0, `${label} start marker was not found`);
  const end = app.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${label} end marker was not found`);
  return app.slice(start, end);
}

const transcriptHandler = sliceBetween(
  "state.eventSource.addEventListener('session.transcript'",
  "state.eventSource.addEventListener('session.alert'",
  'session.transcript handler'
);
assert(
  transcriptHandler.includes('scheduleTranscriptRender('),
  'formal transcript events must still render the transcript'
);

const diagnosticHandler = sliceBetween(
  "state.eventSource.addEventListener('session.diagnostic'",
  "state.eventSource.addEventListener('session.request'",
  'session.diagnostic handler'
);
assert(
  diagnosticHandler.includes("payload.method === 'turn/completed'")
    && diagnosticHandler.includes('scheduleTranscriptRender({ preserveScroll: true })'),
  'terminal diagnostics must rebuild the final transcript once after the live Thinking card is removed'
);
assert(
  !diagnosticHandler.includes('!runtimeIsActive(runtime)'),
  'ordinary diagnostics received while idle must not rebuild the full transcript'
);
assert(
  diagnosticHandler.includes('queuedUiRenders.thinkingPanel = true'),
  'diagnostic events should refresh the lightweight live thinking panel'
);
assert(
  diagnosticHandler.includes('externalActivityWasActive !== externalActivityIsActive')
    && diagnosticHandler.includes('scheduleTranscriptRender({ preserveScroll: true })'),
  'external terminal lifecycle transitions must create or settle the inline Thinking card'
);
assert(
  diagnosticHandler.includes('const externalObservation = isExternalTerminalDiagnostic(payload)')
    && diagnosticHandler.includes('externalObservation\n      ? getExternalTerminalActivityForSession'),
  'ordinary managed diagnostics must not rescan the full external activity history'
);
assert(
  diagnosticHandler.indexOf('scheduleTranscriptRender({ preserveScroll: true })')
    > diagnosticHandler.indexOf("payload.method === 'turn/completed'"),
  'active diagnostic deltas must stay on the lightweight Thinking patch path'
);
assert(
  diagnosticHandler.includes('queuedUiRenders.statusWindow = true'),
  'diagnostic events should keep the status/details window fresh'
);

const thinkingPanel = sliceBetween(
  'function renderThinkingPanel()',
  'function renderAlertsWindow()',
  'renderThinkingPanel'
);
assert(
  thinkingPanel.includes("el('session-log')"),
  'renderThinkingPanel should update the existing transcript log, not a separate live panel'
);
assert(
  thinkingPanel.includes('buildThinkingMessageElement('),
  'renderThinkingPanel should reuse the existing thinking card renderer for the latest turn'
);
assert(
  thinkingPanel.includes('requestToThinkingDiagnostic'),
  'renderThinkingPanel should preserve approval/user-input request activity'
);
assert(
  thinkingPanel.includes('if (!showLivePlaceholder)'),
  'renderThinkingPanel should only update active live turns, not recently loaded history diagnostics'
);
assert(
  thinkingPanel.includes('runtimeIsActive(runtime)'),
  'renderThinkingPanel must keep retrying, reconnecting, and activeTurnId-only turns visible'
);
assert(
  thinkingPanel.includes('externalActivity.active'),
  'renderThinkingPanel must stay visible while a separately running terminal owns the native turn'
);
const composerSubmission = sliceBetween(
  'async function submitComposerPayload',
  'async function submitComposerInput',
  'composer submission'
);
assert(
  composerSubmission.includes('|| externalActivity.active'),
  'Remote prompts must queue behind an observed external terminal turn'
);
const queuedPrompt = sliceBetween(
  'async function sendQueuedPrompt',
  'function maybeScheduleQueuedPromptSend',
  'queued prompt sender'
);
assert(
  queuedPrompt.includes('getExternalTerminalActivityForSession(session).active'),
  'queued prompts must not send while the external terminal turn is still active'
);
assert(
  !thinkingPanel.includes('hasRecentDiagnostic'),
  'recent history diagnostics should not create or refresh live thinking UI'
);
assert(
  thinkingPanel.includes('patchThinkingMessageElement('),
  'renderThinkingPanel should patch the existing thinking card instead of adding a duplicate one'
);
assert(
  !thinkingPanel.includes('existingMessage.replaceWith('),
  'renderThinkingPanel should not replace the whole thinking message on each diagnostic update'
);

assert(
  !html.includes('id="thinking-panel"'),
  'the page should not render a second standalone thinking panel'
);
assert(
  !styles.includes('.live-thinking-panel'),
  'there should be no standalone live thinking panel styles'
);

const runtimeIssuePresentation = sliceBetween(
  'function runtimeIssuePresentation',
  'function runtimeIsActive',
  'runtimeIssuePresentation'
);
const runtimeIsActive = sliceBetween(
  'function runtimeIsActive',
  'function openStatusForActiveTurnBlocker',
  'runtimeIsActive'
);
const runtimeSemantics = vm.createContext({});
vm.runInContext(`${runtimeIssuePresentation}\n${runtimeIsActive}`, runtimeSemantics);

const externalActivityHelpers = sliceBetween(
  'function isExternalTerminalDiagnostic',
  'function describeRuntimeStatus',
  'external terminal activity helpers'
);
const externalActivitySemantics = vm.createContext({
  isThinkingActivityDiagnostic: (entry) => ['reasoning', 'command-output'].includes(entry?.kind),
});
vm.runInContext(externalActivityHelpers, externalActivitySemantics);
const externalDiagnostics = [
  {
    timestamp: '2026-07-30T06:00:00.000Z',
    kind: 'turn',
    method: 'event_msg/task_started',
    turnId: 'external-turn',
    data: { activityOwner: 'external-terminal' },
  },
  {
    timestamp: '2026-07-30T06:00:01.000Z',
    kind: 'reasoning',
    method: 'response_item/reasoning',
    data: { activityOwner: 'external-terminal' },
  },
];
const externalActive = externalActivitySemantics.resolveExternalTerminalActivity({}, externalDiagnostics);
assert.strictEqual(externalActive.active, true);
assert.strictEqual(externalActive.turnId, 'external-turn');
const externalCompleted = externalActivitySemantics.resolveExternalTerminalActivity({}, [
  ...externalDiagnostics,
  {
    timestamp: '2026-07-30T06:00:02.000Z',
    kind: 'turn',
    method: 'event_msg/task_complete',
    turnId: 'external-turn',
    data: { activityOwner: 'external-terminal' },
  },
]);
assert.strictEqual(externalCompleted.active, false);
const projectedExternalActive = externalActivitySemantics.resolveExternalTerminalActivity({
  externalActivity: {
    owner: 'external-terminal',
    active: true,
    turnId: 'projected-turn',
    updatedAt: '2026-07-30T06:01:00.000Z',
  },
}, []);
assert.strictEqual(projectedExternalActive.active, true);
assert.strictEqual(projectedExternalActive.turnId, 'projected-turn');

for (const runtime of [
  { activeTurnId: 'turn-active' },
  { phase: 'retrying' },
  { phase: 'reconnecting' },
]) {
  assert.strictEqual(
    runtimeSemantics.runtimeIsActive(runtime),
    true,
    `${runtime.activeTurnId || runtime.phase} must keep active-turn UI visible`
  );
}

for (const runtime of [
  { phase: 'retrying', lastCodexError: 'temporary provider failure' },
  { connection: 'reconnecting', lastCodexError: 'bridge reconnecting' },
]) {
  const issue = runtimeSemantics.runtimeIssuePresentation(runtime);
  assert.strictEqual(issue.label, 'Retry');
  assert.strictEqual(issue.tone, 'warning');
}
const terminalIssue = runtimeSemantics.runtimeIssuePresentation({
  phase: 'error',
  lastCodexError: 'request failed permanently',
});
assert.strictEqual(terminalIssue.label, 'Error');
assert.strictEqual(terminalIssue.tone, 'error');
for (const runtime of [
  { phase: 'error', connection: 'reconnecting', lastCodexError: 'terminal phase error' },
  { phase: 'quota-exhausted', connection: 'reconnecting', lastCodexError: 'quota exhausted' },
  { phase: 'thinking', currentTurnStatus: 'failed', connection: 'reconnecting', lastCodexError: 'failed turn' },
]) {
  const issue = runtimeSemantics.runtimeIssuePresentation(runtime);
  assert.strictEqual(issue.label, 'Error', 'terminal runtime state must outrank a reconnecting connection');
  assert.strictEqual(issue.tone, 'error', 'terminal runtime state must retain error styling while reconnecting');
}

const runtimePanel = sliceBetween(
  'function renderRuntimePanel()',
  'function renderThinkingPanel()',
  'renderRuntimePanel'
);
assert(
  runtimePanel.includes('runtimeIssuePresentation(runtime)'),
  'the runtime chip row must classify lastCodexError from the current runtime state'
);
assert(
  runtimePanel.includes('appendRuntimeChip(runtimeIssue.label, limitText(runtimeIssue.message, 96), runtimeIssue.tone)'),
  'retrying failures must render as warning Retry chips instead of unconditional Error chips'
);

const statusWindow = sliceBetween(
  'function renderStatusWindow()',
  'function renderPickerEntries(',
  'renderStatusWindow'
);
assert(
  statusWindow.includes('const activeTurn = Boolean(session.live && runtimeIsActive(runtime));'),
  'the Status interrupt control must use the same active-runtime predicate as the composer'
);
assert(
  statusWindow.includes('interruptButton.disabled = !activeTurn;'),
  'retrying or reconnecting turns must remain interruptible even without an activeTurnId snapshot'
);

const composerControls = sliceBetween(
  'function renderComposerControls(',
  'function getSelectedSteerQueue()',
  'renderComposerControls'
);
assert(
  composerControls.includes('const activeTurn = Boolean(session?.live && runtimeIsActive(runtime));'),
  'the composer interrupt control must use the shared active-runtime predicate'
);
assert(
  composerControls.includes("interruptButton.classList.toggle('hidden', !activeTurn)"),
  'the composer interrupt control must stay visible throughout retry and reconnect activity'
);

const transcript = sliceBetween(
  'function renderTranscript(',
  'function renderLocaleLabels',
  'renderTranscript'
);
assert(
  transcript.includes('runtimeIsActive(runtime)')
    && transcript.includes('getExternalTerminalActivityForSession(session, runtime).active'),
  'the latest-turn thinking placeholder must use the shared active-runtime predicate'
);
assert(
  !transcript.includes("runtime.busy || runtime.phase === 'thinking'"),
  'the transcript must not maintain a narrower duplicate list of active phases'
);

const periodicRefresh = sliceBetween(
  'async function performRefresh(',
  'function addSessionIdentityValue(',
  'periodic refresh'
);
assert(
  !periodicRefresh.includes('renderTranscript(selected)'),
  'periodic metadata refresh must not rebuild an unchanged transcript DOM'
);
assert(
  app.includes("if (document.visibilityState === 'hidden')")
    && app.includes('refresh().catch(reportError);'),
  'background tabs must skip periodic metadata refresh work'
);
assert(
  app.includes('const FULL_REFRESH_INTERVAL_MS = 60_000;')
    && app.includes('}, FULL_REFRESH_INTERVAL_MS);'),
  'the full Host, Session, and collection fallback refresh must run no more than once per minute'
);
const periodicStatusTickStart = app.indexOf('setInterval(() => {', app.indexOf("window.addEventListener('resize'"));
const periodicStatusTickEnd = app.indexOf('setInterval(() => {', periodicStatusTickStart + 1);
assert(periodicStatusTickStart >= 0 && periodicStatusTickEnd > periodicStatusTickStart, 'one-second status tick was not found');
const periodicStatusTick = app.slice(periodicStatusTickStart, periodicStatusTickEnd);
assert(
  periodicStatusTick.includes("document.visibilityState === 'hidden'")
    && periodicStatusTick.includes('!getSelectedSession()'),
  'the one-second status tick must stop when the page is hidden or no Session is selected'
);
assert(
  !periodicStatusTick.includes('renderThinkingPanel()'),
  'the one-second timer must not rebuild Thinking DOM without a new runtime event'
);
assert(
  !periodicStatusTick.includes('renderApprovalPopup()'),
  'approval UI must be event-driven instead of rebuilt every second'
);
assert(
  periodicStatusTick.includes('if (state.sessionDetailsOpen)')
    && periodicStatusTick.includes('renderStatusWindow()'),
  'the expensive Status view should refresh once per second only while it is open'
);
const realtimeResume = sliceBetween(
  'async function resumeSelectedSessionRealtime(',
  'async function withStreamRecoveryTimeout(',
  'selected Session realtime resume'
);
assert(
  realtimeResume.includes('selectedSessionRealtimeIsHealthy(selected)'),
  'focus/pageshow must reuse a healthy selected Session stream instead of fetching full detail again'
);

const runtimeStore = sliceBetween(
  'function setRuntimeForSession',
  'function getRuntimeForSession',
  'runtime state merge helpers'
);
const runtimeStoreState = { runtime: new Map() };
const runtimeStoreContext = vm.createContext({
  state: runtimeStoreState,
  makeSessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
});
vm.runInContext(runtimeStore, runtimeStoreContext);
runtimeStoreContext.setRuntimeForSession('host-a', 'session-a', {
  phase: 'thinking',
  activeTurnId: 'turn-a',
  busy: true,
  updatedAt: '2026-07-20T12:00:00.000Z',
});
const mergedRuntime = runtimeStoreContext.patchRuntimeForSession('host-a', 'session-a', {
  lastCodexError: 'temporary transport failure',
  updatedAt: '2026-07-20T12:00:01.000Z',
});
assert.strictEqual(mergedRuntime.phase, 'thinking');
assert.strictEqual(mergedRuntime.activeTurnId, 'turn-a');
assert.strictEqual(runtimeSemantics.runtimeIsActive(mergedRuntime), true);
const completedRuntime = runtimeStoreContext.patchRuntimeForSession('host-a', 'session-a', {
  phase: 'idle',
  activeTurnId: null,
  busy: false,
  currentTurnStatus: 'completed',
  updatedAt: '2026-07-20T12:00:02.000Z',
}, { source: 'stream' });
assert.strictEqual(runtimeStoreContext.getRuntimeStreamGeneration('host-a', 'session-a'), 1);
const rejectedStaleRuntime = runtimeStoreContext.patchRuntimeForSession('host-a', 'session-a', {
  phase: 'thinking',
  activeTurnId: 'turn-a',
  busy: true,
  currentTurnStatus: 'inProgress',
  updatedAt: '2026-07-20T12:00:01.500Z',
}, { source: 'stream' });
assert.strictEqual(rejectedStaleRuntime, completedRuntime, 'an older runtime projection must be ignored');
assert.strictEqual(rejectedStaleRuntime.phase, 'idle');
assert.strictEqual(runtimeStoreContext.getRuntimeStreamGeneration('host-a', 'session-a'), 1);

const revisionFive = runtimeStoreContext.patchRuntimeForSession('host-a', 'session-a', {
  runId: 'run-revision',
  runtimeRevision: 5,
  phase: 'idle',
  activeTurnId: null,
  busy: false,
  updatedAt: '2026-07-20T12:00:03.000Z',
}, { source: 'stream' });
const rejectedOlderRevision = runtimeStoreContext.patchRuntimeForSession('host-a', 'session-a', {
  runId: 'run-revision',
  runtimeRevision: 4,
  phase: 'thinking',
  activeTurnId: 'stale-turn',
  busy: true,
  updatedAt: '2026-07-20T12:00:04.000Z',
}, { source: 'stream' });
assert.strictEqual(rejectedOlderRevision, revisionFive, 'runtime revision must beat a newer wall-clock timestamp');
assert.strictEqual(rejectedOlderRevision.phase, 'idle');
const blockedRollback = runtimeStoreContext.restoreRuntimeSnapshotForSession('host-a', 'session-a', {
  runId: 'run-revision',
  runtimeRevision: 3,
  phase: 'ending',
  busy: false,
});
assert.strictEqual(blockedRollback, revisionFive, 'optimistic rollback must not overwrite a newer authoritative revision');

const rollbackSnapshot = { ...revisionFive };
runtimeStoreContext.patchRuntimeForSession('host-a', 'session-a', {
  phase: 'ending',
  connection: 'closing',
  busy: false,
  activeTurnId: null,
  updatedAt: '2026-07-20T12:00:03.100Z',
});
const rollbackExpectation = {
  expectedApplyGeneration: runtimeStoreContext.getRuntimeApplyGeneration('host-a', 'session-a'),
  expectedStreamGeneration: runtimeStoreContext.getRuntimeStreamGeneration('host-a', 'session-a'),
};
const authoritativeStop = runtimeStoreContext.patchRuntimeForSession('host-a', 'session-a', {
  runId: 'run-revision',
  phase: 'closed',
  connection: 'closed',
  busy: false,
  activeTurnId: null,
  updatedAt: '2026-07-20T12:00:03.200Z',
}, { source: 'stream' });
const blockedEqualRevisionRollback = runtimeStoreContext.restoreRuntimeSnapshotForSession(
  'host-a',
  'session-a',
  rollbackSnapshot,
  rollbackExpectation
);
assert.strictEqual(
  blockedEqualRevisionRollback,
  authoritativeStop,
  'stream generation CAS must block rollback when an authoritative update retains the same runtime revision'
);
assert.strictEqual(blockedEqualRevisionRollback.phase, 'closed');

const runtimeEventHandler = sliceBetween(
  'const handleRuntimePayload = (payload) => {',
  "state.eventSource.addEventListener('session.runtime_updated'",
  'runtime event handler'
);
assert(
  runtimeEventHandler.includes('const mergedRuntime = patchRuntimeForSession('),
  'runtime events must retain the merged Session state after applying a partial patch'
);
assert(
  runtimeEventHandler.includes('runtimeIsActive(mergedRuntime || runtimePayload)'),
  'partial token/error patches must not be mistaken for a stopped turn'
);
assert(
  runtimeEventHandler.includes("{ source: 'stream' }"),
  'SSE runtime updates must advance the per-Session stream generation'
);
assert(
  runtimeEventHandler.includes("mergedRuntime?.phase || runtimePayload.phase"),
  'ignored stale events must not drive lifecycle side effects from their old phase'
);
assert(
  runtimeEventHandler.includes('!runtimeWasActive && runtimeIsActive(mergedRuntime || runtimePayload)'),
  'the first active runtime projection must create the transcript Thinking placeholder even if transcript SSE is late'
);
assert(
  runtimeEventHandler.includes('runtimeWasActive && runtimeStopped'),
  'a terminal runtime projection must remove a stale live Thinking placeholder even if no final diagnostic arrives'
);
assert(
  runtimeEventHandler.includes('scheduleTranscriptRender({ preserveScroll: true })'),
  'active runtime transition must request a full transcript render without moving the reader'
);
assert(
  !app.includes("addEventListener('session.runtime',"),
  'the browser must consume one canonical runtime SSE event instead of maintaining two equivalent handlers'
);
const lifecycleHandlers = sliceBetween(
  "state.eventSource.addEventListener('session.started'",
  "state.eventSource.addEventListener('session.transcript'",
  'lifecycle event handlers'
);
assert(
  !lifecycleHandlers.includes('scheduleRenderAll()'),
  'Session lifecycle updates must not redraw unrelated application chrome'
);
assert(
  app.includes('getRuntimeStreamGeneration(detailHostId, detailSessionId) === detailRuntimeStreamGeneration'),
  'a detail response must not overwrite runtime when SSE advanced during the request'
);

console.log('diagnostic render throttle checks passed');
