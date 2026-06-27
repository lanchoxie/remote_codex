const assert = require('assert');
const fs = require('fs');

const agent = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');

function assertIncludes(source, needle, message) {
  assert(source.includes(needle), `${message}\nExpected to find: ${needle}`);
}

function assertNotIncludes(source, needle, message) {
  assert(!source.includes(needle), `${message}\nDid not expect to find: ${needle}`);
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
  'void watchSelectedSession(session);',
  'Opening a history session should not wait for the watch request before loading full history.'
);
assertNotIncludes(
  app,
  'await watchSelectedSession(session);',
  'watchSelectedSession must remain fire-and-forget so Linux/HPC history detail is not blocked by watch setup.'
);
assertIncludes(
  app,
  'body: JSON.stringify({',
  'watchSelectedSession should send valid JSON, not a raw object body.'
);

console.log('linux history regression assertions passed');
