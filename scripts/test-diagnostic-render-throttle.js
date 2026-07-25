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
  !diagnosticHandler.includes('scheduleTranscriptRender('),
  'diagnostic/thinking events should not trigger full transcript rerender'
);
assert(
  diagnosticHandler.includes('queuedUiRenders.thinkingPanel = true'),
  'diagnostic events should refresh the lightweight live thinking panel'
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
  transcript.includes('&& runtimeIsActive(runtime)'),
  'the latest-turn thinking placeholder must use the shared active-runtime predicate'
);
assert(
  !transcript.includes("runtime.busy || runtime.phase === 'thinking'"),
  'the transcript must not maintain a narrower duplicate list of active phases'
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

const runtimeEventHandler = sliceBetween(
  'const handleRuntimePayload = (payload) => {',
  "state.eventSource.addEventListener('session.runtime'",
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

console.log('diagnostic render throttle checks passed');
