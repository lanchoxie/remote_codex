const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const relayPath = path.join(ROOT, 'apps', 'relay', 'server.js');
const relay = fs.readFileSync(relayPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(/COMMAND_PRIORITY/.test(relay), 'relay should define command priority levels');
assert(/HIGH_PRIORITY_COMMAND_TYPES/.test(relay), 'relay should define high-priority command types');
assert(/function commandPriority\(command\)/.test(relay), 'relay should compute command priority');
assert(/priority:\s*commandPriority\(command\)/.test(relay), 'enqueueCommand should stamp each command with computed priority');

for (const commandType of [
  'session.input',
  'session.interrupt',
  'session.steer',
  'session.request.respond',
]) {
  assert(relay.includes(commandType), `high-priority command set should include ${commandType}`);
}

const getCommandsStart = relay.indexOf('function getCommands(hostId');
const getCommandsEnd = relay.indexOf('function pruneCommandQueue', getCommandsStart);
assert(getCommandsStart >= 0 && getCommandsEnd > getCommandsStart, 'relay should define getCommands before pruneCommandQueue');
const getCommandsBody = relay.slice(getCommandsStart, getCommandsEnd);
assert(/sortCommandsForDelivery/.test(getCommandsBody), 'getCommands should sort queued commands for delivery');
assert(/priority/.test(getCommandsBody), 'getCommands delivery sorting should use command priority');

console.log('command priority assertions passed');
