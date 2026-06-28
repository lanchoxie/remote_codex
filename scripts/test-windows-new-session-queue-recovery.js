const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const agent = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
const runner = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

const highPriorityStart = relay.indexOf('const HIGH_PRIORITY_COMMAND_TYPES');
const highPriorityEnd = relay.indexOf(']);', highPriorityStart);
assert(highPriorityStart >= 0 && highPriorityEnd > highPriorityStart, 'relay should define HIGH_PRIORITY_COMMAND_TYPES as a set literal');
const highPriorityBody = relay.slice(highPriorityStart, highPriorityEnd);

for (const commandType of [
  'session.start',
  'host.file_upload',
  'host.file_upload_begin',
  'host.file_upload_chunk',
  'host.file_upload_complete',
  'host.file_upload_abort',
]) {
  assertContains(highPriorityBody, `'${commandType}'`, `${commandType} should not wait behind history/detail work on Windows`);
}

assertContains(
  agent,
  "command.type === 'session.input'",
  'host-agent should explicitly handle session.input commands that arrive before a live runner is ready'
);
assertContains(
  agent,
  "type: 'session.runtime_updated'",
  'host-agent should report runtime state when an early session.input cannot be delivered'
);

const noRunnerStart = agent.indexOf('if (!runner) {');
const earlyInputStart = agent.indexOf("if (command.type === 'session.input')", noRunnerStart);
const earlyInputEnd = agent.indexOf("message: `no live session for command ${command.type}`", earlyInputStart);
assert(noRunnerStart >= 0 && earlyInputStart > noRunnerStart && earlyInputEnd > earlyInputStart, 'host-agent should have a no-runner session.input recovery block');
const earlyInputBlock = agent.slice(earlyInputStart, earlyInputEnd);

assertContains(
  earlyInputBlock,
  'sessionId: command.requestedSessionId || command.sessionId',
  'host-agent should clear the queued runtime state on the same UI session id that relay marked queued'
);
assertContains(earlyInputBlock, 'queuedCommandId: null', 'host-agent should clear the queued command marker after an undeliverable input');
assertContains(earlyInputBlock, 'pendingInputSummary: null', 'host-agent should clear the pending input summary after an undeliverable input');

assertContains(
  runner,
  'codexHome: this.codexHome',
  'managed app-server runtime metadata should expose its isolated CODEX_HOME so history can be found after startup'
);
assertContains(
  relay,
  'session.runtime?.codexHome',
  'relay history detail should look in the managed runtime isolated CODEX_HOME before falling back to the default CODEX_HOME'
);
assertContains(
  relay,
  'codexHome: session.runtime?.codexHome || session.codexHome || null',
  'relay should pass the isolated CODEX_HOME to host-agent session.detail commands'
);
assertContains(
  agent,
  'function commandCodexHomeCandidates(input = {})',
  'host-agent should resolve session.detail and session.watch against command/live-runner isolated CODEX_HOME candidates'
);

assertContains(
  app,
  'function isManagedSessionStarting(session)',
  'UI should identify managed sessions that are still starting'
);
assertContains(
  app,
  'function isEmptyManagedSessionShell(session)',
  'UI should identify empty closed managed session shells that have no live runner and no history transcript'
);
assertContains(
  app,
  'function canActivateSessionHistory(session)',
  'UI should use a shared history activation guard'
);

const activateStart = app.indexOf('function canActivateSessionHistory(session)');
const activateEnd = app.indexOf('function canForkSession', activateStart);
assert(activateStart >= 0 && activateEnd > activateStart, 'app should define canActivateSessionHistory before canForkSession');
const activateBody = app.slice(activateStart, activateEnd);
assertContains(
  activateBody,
  '!isManagedSessionStarting(session)',
  'starting managed sessions must not be treated as resumable history sessions'
);
assertContains(
  activateBody,
  '!isEmptyManagedSessionShell(session)',
  'empty managed session shells must not be treated as resumable history sessions'
);

const sendInputStart = app.indexOf('async function sendInput(session, text, options = {})');
const sendInputEnd = app.indexOf('async function submitComposerPayload', sendInputStart);
assert(sendInputStart >= 0 && sendInputEnd > sendInputStart, 'app should define sendInput before submitComposerPayload');
const sendInputBody = app.slice(sendInputStart, sendInputEnd);
assertContains(
  sendInputBody,
  'isManagedSessionStarting(session)',
  'sendInput should refuse to auto-resume a managed session that is still starting'
);
assertContains(
  sendInputBody,
  'isEmptyManagedSessionShell(session)',
  'sendInput should refuse to queue files/imported history into an empty managed session shell'
);

console.log('windows new-session queue recovery assertions passed');
