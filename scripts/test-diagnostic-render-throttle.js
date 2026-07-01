const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
  !thinkingPanel.includes('hasRecentDiagnostic'),
  'recent history diagnostics should not create or refresh live thinking UI'
);
assert(
  thinkingPanel.includes('replaceWith('),
  'renderThinkingPanel should patch the existing thinking card instead of adding a duplicate one'
);

assert(
  !html.includes('id="thinking-panel"'),
  'the page should not render a second standalone thinking panel'
);
assert(
  !styles.includes('.live-thinking-panel'),
  'there should be no standalone live thinking panel styles'
);

console.log('diagnostic render throttle checks passed');
