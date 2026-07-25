const assert = require('assert');
const fs = require('fs');

const agent = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');

function assertIncludes(source, needle, message) {
  assert(source.includes(needle), `${message}\nExpected to find: ${needle}`);
}

assertIncludes(
  agent,
  "process.platform !== 'win32'",
  'Linux/HPC discovery should keep transcript previews by default; Windows can use the fast no-preview path.'
);
assertIncludes(
  agent,
  'preview: CODEX_DISCOVERY_LIST_PREVIEW',
  'sendDiscovery should use a platform-aware preview flag instead of disabling previews for every host.'
);
assertIncludes(
  agent,
  'const includePreview = !(command.fullTranscript === true || command.full === true || command.preview === false);',
  'full session.detail should avoid reading a preview before reading the full transcript.'
);

assertIncludes(
  app,
  'await watchSelectedSession(session);',
  'Opening history should enqueue its watch before requesting the detail snapshot.'
);
const showSessionStart = app.indexOf('async function showSession(');
const showSessionEnd = app.indexOf('\nfunction buildSessionExportUrl', showSessionStart);
const showSessionSource = app.slice(showSessionStart, showSessionEnd);
assert(
  showSessionSource.indexOf('await watchSelectedSession(session);')
    < showSessionSource.indexOf('/detail?${detailParams.toString()}'),
  'watch registration must form a barrier before the full history snapshot to avoid an EOF handoff gap'
);
assertIncludes(
  showSessionSource,
  'state.fullTranscriptLoaded.delete(sessionKey)',
  'reselecting history must invalidate its prior full snapshot before watch/detail handoff'
);
const refreshStart = app.indexOf('async function performRefresh(');
const refreshEnd = app.indexOf('\nfunction addSessionIdentityValue', refreshStart);
const refreshSource = app.slice(refreshStart, refreshEnd);
assertIncludes(
  refreshSource,
  'state.shownSessionKey = null;',
  'temporarily losing the selected session must invalidate the next same-key history snapshot'
);
assertIncludes(
  app,
  'body: JSON.stringify({',
  'watchSelectedSession should send valid JSON, not a raw object body.'
);

console.log('linux history regression assertions passed');
