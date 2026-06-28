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
  'session.input',
  'session.interrupt',
  'session.steer',
  'session.request.respond',
]) {
  assert(highPriorityBody.includes(commandType), `high-priority command set should include ${commandType}`);
}

const getCommandsStart = relay.indexOf('function getCommands(hostId');
const getCommandsEnd = relay.indexOf('function pruneCommandQueue', getCommandsStart);
assert(getCommandsStart >= 0 && getCommandsEnd > getCommandsStart, 'relay should define getCommands before pruneCommandQueue');
const getCommandsBody = relay.slice(getCommandsStart, getCommandsEnd);
assert(/sortCommandsForDelivery/.test(getCommandsBody), 'getCommands should sort queued commands for delivery');

const sortCommandsStart = relay.indexOf('function sortCommandsForDelivery');
const sortCommandsEnd = relay.indexOf('function pruneCommandQueue', sortCommandsStart);
assert(sortCommandsStart >= 0 && sortCommandsEnd > sortCommandsStart, 'relay should define sortCommandsForDelivery before pruneCommandQueue');
const sortCommandsBody = relay.slice(sortCommandsStart, sortCommandsEnd);
assert(!/priorityDelta/.test(sortCommandsBody), 'command delivery must not reorder by priority while host-agent acknowledges through a highest command id');
assert(/Number\(a\?\.id \|\| 0\) - Number\(b\?\.id \|\| 0\)/.test(sortCommandsBody), 'command delivery should remain id-ordered for monotonic ack safety');

console.log('command priority assertions passed');
