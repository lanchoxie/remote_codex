const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

const shouldRequestStart = relay.indexOf('function shouldRequestRemoteSessionDetail(');
const shouldRequestEnd = relay.indexOf('\n\nasync function requestRemoteSessionDetail', shouldRequestStart);
assert(shouldRequestStart >= 0 && shouldRequestEnd > shouldRequestStart, 'relay should define shouldRequestRemoteSessionDetail');
const shouldRequestBody = relay.slice(shouldRequestStart, shouldRequestEnd);

assertContains(
  relay,
  'function hasUsableLocalSessionTranscriptDetail(detail)',
  'relay should detect when local persisted history is enough to render immediately'
);
assertContains(
  shouldRequestBody,
  '!options.fullTranscript',
  'local-history fast path should only apply to ordinary non-full detail opens'
);
assertContains(
  shouldRequestBody,
  'hasUsableLocalSessionTranscriptDetail(detail)',
  'ordinary detail opens should not block on remote detail when local cached transcript is already usable'
);
assert(
  !/^\s*options\.fullTranscript\s*\n\s*&&\s*!options\.fullDiagnostics\s*\n\s*&&\s*!options\.forceRemoteDetail\s*\n\s*&&\s*hasUsableLocalSessionTranscriptDetail\(detail\)/m.test(shouldRequestBody),
  'full transcript requests must not be satisfied by a truncated local transcript preview'
);
assertContains(
  shouldRequestBody,
  '!options.fullDiagnostics',
  'full diagnostics requests should still be allowed to ask the host-agent for remote detail'
);
assertContains(
  shouldRequestBody,
  '!options.forceRemoteDetail',
  'explicit remote detail requests should bypass the local-history fast path'
);

console.log('session detail local history assertions passed');
