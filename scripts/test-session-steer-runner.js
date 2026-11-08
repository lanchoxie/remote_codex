const assert = require('assert/strict');
const { CodexAppServerRunner } = require('../apps/host-agent/codex-app-server-runner');
function runner(rpc) {
  const instance = Object.create(CodexAppServerRunner.prototype);
  Object.assign(instance, { threadId: 'thread-a', runId: 'run-a', activeTurnId: 'turn-a', runtime: { phase: 'waiting-approval' }, rpc: { request: rpc }, stopRequested: false });
  instance.emitRuntime = async () => { instance.activeTurnId = 'turn-b'; };
  instance.emitDiagnostic = async () => { instance.activeTurnId = 'turn-b'; };
  instance.isTerminalTurnId = () => false;
  return instance;
}
async function main() {
  const calls = [];
  const target = runner(async (method, params) => { calls.push({ method, params }); return { turnId: params.expectedTurnId }; });
  const result = await target.steerTurn('guide A', { expectedRunId: 'run-a', expectedTurnId: 'turn-a' });
  assert.equal(calls[0].params.expectedTurnId, 'turn-a', 'a click on A must never steer B after async runtime/diagnostics');
  assert.equal(result.turnId, 'turn-a', 'return native accepted identity, not mutable runtime');
  assert.equal(target.runtime.phase, 'waiting-approval', 'steer must not rewrite runtime phase');
  assert.deepEqual(Object.keys(calls[0].params).sort(), ['expectedTurnId', 'input', 'threadId']);
  assert.equal(calls[0].method, 'turn/steer');
  assert.deepEqual(calls[0].params.input, [{ type: 'text', text: 'guide A' }]);
  const rejects = runner(async () => assert.fail('stale or missing identity must not invoke native RPC'));
  await assert.rejects(rejects.steerTurn('text', { expectedRunId: 'old', expectedTurnId: 'turn-a' }), { code: 'steer_target_changed' });
  await assert.rejects(rejects.steerTurn('text', { expectedRunId: 'run-a', expectedTurnId: 'old' }), { code: 'steer_target_changed' });
  await assert.rejects(rejects.steerTurn('text'), { code: 'steer_target_required' });
  rejects.stopRequested = true;
  await assert.rejects(rejects.steerTurn('text', { expectedRunId: 'run-a', expectedTurnId: 'turn-a' }), { code: 'steer_target_changed' });
  for (const value of [{}, { turnId: 'other' }]) {
    const invalid = runner(async () => value);
    await assert.rejects(invalid.steerTurn('text', { expectedRunId: 'run-a', expectedTurnId: 'turn-a' }), (e) => e.steerAcceptanceUnknown === true);
  }
  const timeout = runner(async () => { throw new Error('RPC timeout'); });
  await assert.rejects(timeout.steerTurn('text', { expectedRunId: 'run-a', expectedTurnId: 'turn-a' }), (e) => e.steerAcceptanceUnknown === true);
  const nativeReject = runner(async () => { const e = new Error('No active turn'); e.rpcCode = -32602; throw e; });
  await assert.rejects(nativeReject.steerTurn('text', { expectedRunId: 'run-a', expectedTurnId: 'turn-a' }), (e) => e.rpcCode === -32602 && !e.steerAcceptanceUnknown);
  let finish;
  const late = runner(() => new Promise((resolve) => { finish = resolve; }));
  const pending = late.steerTurn('text', { expectedRunId: 'run-a', expectedTurnId: 'turn-a' });
  late.activeTurnId = 'turn-b';
  finish({ turnId: 'turn-a' });
  assert.equal((await pending).turnId, 'turn-a');
  assert.equal(late.activeTurnId, 'turn-b');
  console.log('steer native target fencing, actual acknowledgement and ambiguity tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
