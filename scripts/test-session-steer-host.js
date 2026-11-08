const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '../apps/host-agent/session-steer-command.js');
assert.ok(fs.existsSync(file), 'Host must deliver a correlated Steer receipt without repeating native execution');
const { createSessionSteerCommandHandler } = require(file);
async function main() {
  const receipts = [];
  let calls = 0;
  let failDelivery = true;
  let release;
  let inLane = false;
  const handle = createSessionSteerCommandHandler({
    hostId: 'host',
    enqueueControl: async (_runner, effect) => { inLane = true; const result = effect(); inLane = false; return result; },
    deliver: async (receipt) => { receipts.push(receipt); if (failDelivery) throw new Error('Relay unavailable'); },
  });
  const command = { id: 1, requestId: 'request', sessionId: 'session', runId: 'run', expectedTurnId: 'turn', text: 'guide' };
  const runner = { runId: 'run', steerTurn(text, options) {
    assert.equal(inLane, true);
    assert.equal(text, 'guide');
    assert.deepEqual(options, { expectedRunId: 'run', expectedTurnId: 'turn' });
    calls++;
    return new Promise((resolve) => { release = resolve; });
  } };
  const first = handle(command, runner);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inLane, false, 'native result wait must not hold the control lane');
  release({ status: 'accepted', turnId: 'turn' });
  await assert.rejects(first, (error) => error.retryCommand === true);
  failDelivery = false;
  await handle(command, runner);
  assert.equal(calls, 1, 'receipt retry must not repeat turn/steer');
  assert.deepEqual(receipts[0], receipts[1], 'receipt timestamps and identity must remain stable across delivery retries');
  assert.equal(receipts[1].status, 'accepted');
  assert.equal(receipts[1].commandId, 1);
  await handle({ ...command, id: 2, requestId: 'two' }, null);
  assert.equal(receipts.at(-1).status, 'rejected');
  assert.equal(receipts.at(-1).runId, 'run');
  await handle({ ...command, id: 3, requestId: 'three' }, { runId: 'new', steerTurn() { assert.fail('wrong runner'); } });
  assert.equal(receipts.at(-1).status, 'rejected');
  await handle({ ...command, id: 4, requestId: 'four' }, { runId: 'run', steerTurn() {
    throw Object.assign(new Error('RPC timeout'), { steerAcceptanceUnknown: true });
  } });
  assert.equal(receipts.at(-1).status, 'acceptance_unknown');
  const agent = fs.readFileSync(path.resolve(__dirname, '../apps/host-agent/agent.js'), 'utf8');
  assert.ok(agent.includes("require('./session-steer-command')"), 'Host must load the tested handler');
  assert.match(agent, /deferAcknowledgement: handleSessionSteerCommand\(command, runner\)/);
  assert.match(agent, /deferAcknowledgement: handleSessionSteerCommand\(command, null\)/);
  console.log('steer Host receipts, retry-safe execution, control lane and wiring tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
