const assert = require('assert');
const {
  TerminalSessionBroker,
} = require('../apps/relay/terminal-session-broker');

let now = 1000;
const closeRequests = [];
const broker = new TerminalSessionBroker({
  now: () => now,
  makeId: () => 'terminal-1',
  maxSessions: 2,
  maxSessionsPerHost: 1,
  noSubscriberGraceMs: 1000,
  idleTimeoutMs: 60 * 1000,
  requestHostClose: (record, reason) => closeRequests.push({ record, reason }),
});

const created = broker.create({
  hostId: 'host-1',
  sessionId: 'session-1',
  cwd: '/work',
  cols: 80,
  rows: 24,
});
assert.strictEqual(created.terminalId, 'terminal-1');
assert.strictEqual(created.status, 'opening');
assert.throws(
  () => broker.create({ hostId: 'host-1', sessionId: 'session-2', cwd: '/other' }),
  (error) => error.code === 'terminal_host_limit'
);

assert.strictEqual(broker.acceptHostEvent({
  type: 'host.terminal.opened',
  hostId: 'host-1',
  sessionId: 'session-1',
  terminalId: 'terminal-1',
  platform: 'linux',
  shell: 'bash',
  pid: 123,
}).accepted, true);

const delivered = [];
const subscription = broker.subscribe({ terminalId: 'terminal-1', after: 0 }, (event) => delivered.push(event));
assert(subscription.replay.some((event) => event.type === 'opened'));
assert.strictEqual(broker.acceptHostEvent({
  type: 'host.terminal.output',
  hostId: 'host-1',
  sessionId: 'session-1',
  terminalId: 'terminal-1',
  sequence: 1,
  data: 'hello',
}).accepted, true);
assert.strictEqual(delivered.at(-1).type, 'output');
assert.strictEqual(delivered.at(-1).payload.data, 'hello');
assert.strictEqual(broker.acceptHostEvent({
  type: 'host.terminal.output',
  hostId: 'host-1',
  sessionId: 'session-1',
  terminalId: 'terminal-1',
  sequence: 1,
  data: 'duplicate',
}).reason, 'duplicate');
assert.strictEqual(broker.acceptHostEvent({
  type: 'host.terminal.output',
  hostId: 'wrong-host',
  sessionId: 'session-1',
  terminalId: 'terminal-1',
  sequence: 2,
  data: 'wrong',
}).reason, 'identity_mismatch');

const resized = broker.resize({ terminalId: 'terminal-1', cols: 140, rows: 50 });
assert.strictEqual(resized.cols, 140);
assert.strictEqual(resized.rows, 50);
subscription.unsubscribe();
now += 1100;
assert.strictEqual(broker.sweep({ isHostOnline: () => true }), 1);
assert.strictEqual(closeRequests.length, 1);
assert.strictEqual(closeRequests[0].reason, 'client-disconnected');

assert.strictEqual(broker.acceptHostEvent({
  type: 'host.terminal.closed',
  hostId: 'host-1',
  sessionId: 'session-1',
  terminalId: 'terminal-1',
  reason: 'process-exit',
  exitCode: 0,
}).accepted, true);
assert.strictEqual(broker.get('terminal-1').status, 'closed');

console.log('terminal session broker assertions passed');
