const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeAssert = require('assert');

const ROOT = path.join(__dirname, '..');
const relayPath = path.join(ROOT, 'apps', 'relay', 'server.js');
const relay = fs.readFileSync(relayPath, 'utf8');
const agent = fs.readFileSync(path.join(ROOT, 'apps', 'host-agent', 'agent.js'), 'utf8');

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
assert(/reservedRunnerRetirementCommandId/.test(getCommandsBody), 'getCommands should honor an in-flight retirement reservation barrier');
assert(/retirementBarrierId/.test(getCommandsBody), 'getCommands should combine queued and in-flight retirement barriers');
assert(relay.includes('function queuedStaleSessionStopCommand') && relay.includes('queuedStaleSessionStopCommand(event.hostId, plannedSessionId, event.runId)'), 'stale session starts should deduplicate generic cleanup Stops');
assert(relay.includes('function observeHostCommandDeliveryCursor') && relay.includes('observedHostCommandAfter(normalizedHostId)'), 'retirement enqueue should repair an ID that lost a cursor race');
assert(relay.includes('reassignRunnerRetirementCommand'), 'retirement command cursor repair must update durable command identity without a new attempt');

const sortCommandsStart = relay.indexOf('function sortCommandsForDelivery');
const sortCommandsEnd = relay.indexOf('function pruneCommandQueue', sortCommandsStart);
assert(sortCommandsStart >= 0 && sortCommandsEnd > sortCommandsStart, 'relay should define sortCommandsForDelivery before pruneCommandQueue');
const sortCommandsBody = relay.slice(sortCommandsStart, sortCommandsEnd);
assert(!/priorityDelta/.test(sortCommandsBody), 'command delivery must not reorder by priority while host-agent acknowledges through a highest command id');
assert(/Number\(a\?\.id \|\| 0\) - Number\(b\?\.id \|\| 0\)/.test(sortCommandsBody), 'command delivery should remain id-ordered for monotonic ack safety');

const pruneCommandsStart = relay.indexOf('function pruneCommandQueue');
const pruneCommandsEnd = relay.indexOf('function purgeLegacySkillMutationCommands', pruneCommandsStart);
assert(pruneCommandsStart >= 0 && pruneCommandsEnd > pruneCommandsStart, 'relay should define bounded command pruning');

const controlTypesStart = relay.indexOf('const CONTROL_COMMAND_TYPES');
const controlTypesEnd = relay.indexOf(']);', controlTypesStart) + 3;
const normalizedCursorStart = relay.indexOf('function normalizedCommandCursor');
const normalizedCursorEnd = relay.indexOf('function commandDeliveryIdentity', normalizedCursorStart);
const laneHelpersStart = relay.indexOf('function commandDeliveryIdentity');
const laneHelpersEnd = relay.indexOf('function observedHostCommandAfter', laneHelpersStart);
const ackCommandsStart = relay.indexOf('function ackCommands');
const ackCommandsEnd = relay.indexOf('function removeQueuedCommandById', ackCommandsStart);
assert(controlTypesStart >= 0 && controlTypesEnd > controlTypesStart, 'relay should define control command types');
assert(normalizedCursorStart >= 0 && normalizedCursorEnd > normalizedCursorStart, 'relay should define normalized command cursor helper');
assert(laneHelpersStart >= 0 && laneHelpersEnd > laneHelpersStart, 'relay should define lane helpers');
assert(ackCommandsStart >= 0 && ackCommandsEnd > ackCommandsStart, 'relay should define lane-aware ACK handling');

const laneContext = {
  state: {
    commandQueues: new Map(),
    commandDeliveryCursors: new Map(),
    hosts: new Map([['host-a', { capabilities: { runApiBinding: true } }]]),
    inputCommandOutbox: {
      calls: [],
      ackThrough(hostId, commandId) { this.calls.push([hostId, commandId]); },
    },
  },
  pruneCommandQueue: (queue) => queue,
};
vm.runInNewContext(`
  ${relay.slice(controlTypesStart, controlTypesEnd)}
  ${relay.slice(normalizedCursorStart, normalizedCursorEnd)}
  ${relay.slice(laneHelpersStart, laneHelpersEnd)}
  ${relay.slice(ackCommandsStart, ackCommandsEnd)}
  globalThis.lanes = {
    ackCommands,
    commandBelongsToLane,
    recordHostCommandDelivery,
    commandDeliveryWatermark,
  };
`, laneContext);

const pruneContext = {
  COMMAND_QUEUE_TTL_MS: 10 * 60 * 1000,
  COMMAND_QUEUE_MAX_LENGTH: 4,
  COMMAND_PRIORITY: { high: 0, normal: 10 },
  HIGH_PRIORITY_COMMAND_TYPES: new Set(['session.input']),
  CONTROL_COMMAND_TYPES: new Set([
    'host.shutdown',
    'session.interrupt',
    'session.steer',
    'session.request.respond',
    'session.stop',
  ]),
};
vm.runInNewContext(`
  function normalizeCommandLane(lane) {
    const value = String(lane || '').trim().toLowerCase();
    if (value === 'normal' || value === 'control') return value;
    return null;
  }
  function commandBelongsToLane(command, lane = null) {
    const normalizedLane = normalizeCommandLane(lane);
    if (!normalizedLane) return true;
    const isControl = CONTROL_COMMAND_TYPES.has(String(command?.type || ''));
    return normalizedLane === 'control' ? isControl : !isControl;
  }
  function commandPriority(command) {
    return HIGH_PRIORITY_COMMAND_TYPES.has(String(command?.type || ''))
      ? COMMAND_PRIORITY.high
      : COMMAND_PRIORITY.normal;
  }
  ${relay.slice(pruneCommandsStart, pruneCommandsEnd)}
  globalThis.pruneHarness = { pruneCommandQueue };
`, pruneContext);

const overflowQueue = [
  { id: 1, type: 'session.stop', priority: 10 },
  { id: 2, type: 'session.detail', priority: 10 },
  { id: 3, type: 'session.interrupt', priority: 0 },
  { id: 4, type: 'session.detail', priority: 10 },
  { id: 5, type: 'session.input', priority: 0 },
  { id: 6, type: 'session.request.respond', priority: 0 },
  { id: 7, type: 'session.detail', priority: 10 },
];
nodeAssert.deepStrictEqual(
  Array.from(pruneContext.pruneHarness.pruneCommandQueue(overflowQueue), (command) => command.id),
  [1, 3, 5, 6],
  'overflow pruning must retain every control command and use remaining capacity for the highest-priority normal command'
);

pruneContext.COMMAND_QUEUE_MAX_LENGTH = 2;
nodeAssert.deepStrictEqual(
  Array.from(pruneContext.pruneHarness.pruneCommandQueue([
    { id: 10, type: 'session.stop', priority: 10 },
    { id: 11, type: 'session.interrupt', priority: 0 },
    { id: 12, type: 'session.request.respond', priority: 0 },
    { id: 13, type: 'session.detail', priority: 10 },
  ]), (command) => command.id),
  [10, 11, 12],
  'control commands must survive even when their count alone exceeds the normal queue capacity'
);

const queueFixture = () => [
  { id: 1, type: 'host.file_upload' },
  { id: 2, type: 'session.interrupt' },
  { id: 3, type: 'session.input', clientRequestId: 'input-3' },
  { id: 4, type: 'session.stop' },
  { id: 5, type: 'session.review_start' },
];
laneContext.state.commandQueues.set('host-a', queueFixture());
nodeAssert.strictEqual(laneContext.lanes.ackCommands('host-a', 4, 'control'), 2);
nodeAssert.deepStrictEqual(
  Array.from(laneContext.state.commandQueues.get('host-a'), (command) => command.id),
  [1, 3, 5],
  'control ACK must not remove skipped normal commands'
);
nodeAssert.deepStrictEqual(laneContext.state.inputCommandOutbox.calls, []);
nodeAssert.strictEqual(laneContext.lanes.ackCommands('host-a', 3, 'normal'), 2);
nodeAssert.deepStrictEqual(
  Array.from(laneContext.state.commandQueues.get('host-a'), (command) => command.id),
  [5],
  'normal ACK must remove only normal commands through its cursor'
);
nodeAssert.deepStrictEqual(laneContext.state.inputCommandOutbox.calls, [['host-a', 3]]);

laneContext.state.commandQueues.set('host-a', queueFixture());
nodeAssert.strictEqual(laneContext.lanes.ackCommands('host-a', 4), 4);
nodeAssert.deepStrictEqual(
  Array.from(laneContext.state.commandQueues.get('host-a'), (command) => command.id),
  [5],
  'legacy ACK must retain the original all-command FIFO semantics'
);

// A versioned Agent may only ACK commands returned to its own lease/lane.
const identity = { agentInstanceId: 'agent-a', leaseId: 'lease-a' };
laneContext.state.commandQueues.set('host-a', [
  { id: 10, type: 'host.file_upload' },
  { id: 11, type: 'session.interrupt' },
  { id: 12, type: 'host.file_upload' },
]);
laneContext.lanes.recordHostCommandDelivery(
  'host-a', identity.agentInstanceId, identity.leaseId, 'normal',
  [{ id: 10, type: 'host.file_upload' }]
);
nodeAssert.strictEqual(
  laneContext.lanes.commandDeliveryWatermark(
    'host-a', identity.agentInstanceId, identity.leaseId, 'normal'
  ),
  10,
  'delivery watermark must be based on returned command ids'
);
nodeAssert.strictEqual(
  laneContext.lanes.ackCommands('host-a', 999, 'normal', identity),
  1,
  'an oversized ACK should be clamped to the delivered watermark'
);
nodeAssert.deepStrictEqual(
  Array.from(laneContext.state.commandQueues.get('host-a'), (command) => command.id),
  [11, 12],
  'clamped normal ACK must not remove an undelivered command or control command'
);
nodeAssert.strictEqual(
  laneContext.lanes.ackCommands('host-a', Number.MAX_SAFE_INTEGER, 'normal', identity),
  0,
  'MAX_SAFE_INTEGER must never be accepted as a delivery watermark'
);
nodeAssert.strictEqual(
  laneContext.lanes.ackCommands('host-a', 12, 'normal', { agentInstanceId: 'agent-a', leaseId: 'rotated' }),
  0,
  'a previous lease must not ACK through a newer lease cursor'
);
nodeAssert.deepStrictEqual(
  Array.from(laneContext.state.commandQueues.get('host-a'), (command) => command.id),
  [11, 12],
  'lease-mismatched ACK must leave the queue unchanged'
);

assert(agent.includes("pollCommandsLoop('normal')") && agent.includes("pollCommandsLoop('control')"), 'Agent should run independent normal and control pollers');
assert(agent.includes('commandLanesV1: true'), 'Agent should advertise lane support');
assert(relay.includes('commandLanesV1: true'), 'Relay should advertise lane support');
assert(/ackCommands\(hostId, requestedAck, requestedLane, deliveryIdentity\)/.test(relay), 'Relay ACK routing should carry the requested lane and lease identity');
assert(relay.includes('getCommands(hostId, after, requestedLane)'), 'Relay delivery should carry the requested lane');

console.log('command priority assertions passed');
