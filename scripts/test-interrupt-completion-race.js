'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexAppServerRunner } = require('../apps/host-agent/codex-app-server-runner');

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interrupt-completion-race-'));
  fs.writeFileSync(path.join(home, 'auth.json'), '{}');
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  const events = [], nativeCalls = [];
  let releaseIdle, observeIdle;
  const idleObserved = new Promise(resolve => { observeIdle = resolve; });
  const idleGate = new Promise(resolve => { releaseIdle = resolve; });
  let holdIdle = true;
  const runner = new CodexAppServerRunner({
    hostId: 'test-host', sessionId: 'test-session', bridgeSessionId: 'test-session', runId: 'test-run',
    cwd: process.cwd(), launchMode: 'fresh', codexHome: home,
    postEvent: async event => {
      events.push(event);
      if (holdIdle && event.type === 'session.runtime_updated' && event.patch?.busy === false) {
        holdIdle = false; observeIdle(); await idleGate;
      }
    },
  });
  runner.threadId = 'test-thread';
  runner.rpc = { request: async (method, params) => { nativeCalls.push({ method, params }); return {}; } };
  runner.activeClientRequestId = 'finished-request';
  runner.beginTurnLifecycle('finished-turn');
  runner.activeTurnId = 'finished-turn';
  runner.bindClientRequestIdToTurn('finished-turn');
  Object.assign(runner.runtime, { phase: 'thinking', busy: true, activeTurnId: 'finished-turn', currentTurnStatus: 'inProgress' });
  let completion;
  try {
    completion = runner.handleNotification({ method: 'turn/completed', params: {
      threadId: runner.threadId, turn: { id: 'finished-turn', status: 'completed', items: [] },
    } });
    await idleObserved;
    assert.equal(runner.activeTurnId, null);
    assert.equal(runner.activeClientRequestId, 'finished-request', 'reproduce cleanup window before client ID release');
    // Even a still-unwinding turn/start must not make a terminal request pending.
    runner.inputSubmissionInFlight = true;
    for (const expectedTurnId of ['finished-turn', null]) {
      const result = await runner.interruptTurn({ interruptRequestId: 'late-interrupt', expectedTurnId,
        expectedClientRequestId: 'finished-request' });
      assert.equal(result.status, 'no_active', 'completed request must never become a pending submission interrupt');
      assert.equal(runner.pendingInterruptIntent, null);
      assert.equal(runner.runtime.busy, false, 'interrupt must not resurrect completed runtime');
    }
    runner.inputSubmissionInFlight = false;
    releaseIdle(); await completion;
    assert.equal(runner.activeClientRequestId, null);
    assert.equal(nativeCalls.length, 0);

    runner.activeClientRequestId = 'orphaned-client-id';
    const orphan = await runner.interruptTurn({ interruptRequestId: 'orphan' });
    assert.equal(orphan.status, 'no_active', 'client ID alone is not a pending submission');
    assert.equal(runner.pendingInterruptIntent, null);

    runner.activeClientRequestId = 'new-submission';
    runner.beginTurnLifecycle();
    runner.createSubmissionAttempt({ threadId: runner.threadId, input: [{ type: 'text', text: 'fixture' }] });
    const stale = await runner.interruptTurn({ interruptRequestId: 'old-target', expectedTurnId: 'finished-turn' });
    assert.equal(stale.status, 'no_active', 'old targeted interrupt must not attach to a new submission');
    assert.equal(runner.pendingInterruptIntent, null);
    const pending = await runner.interruptTurn({ interruptRequestId: 'new-pending', expectedClientRequestId: 'new-submission' });
    assert.equal(pending.status, 'pending', 'genuine unresolved submission remains interruptible');
    assert.equal(nativeCalls.length, 0);
    await runner.settlePendingInterruptForSubmissionFailure('new-submission', new Error('fixture failure'));
    runner.clearActiveSubmissionAttempt();

    runner.beginTurnLifecycle('next-turn'); runner.activeTurnId = 'next-turn';
    runner.activeClientRequestId = 'next-request'; runner.bindClientRequestIdToTurn('next-turn');
    const old = await runner.interruptTurn({ interruptRequestId: 'late', expectedTurnId: 'finished-turn' });
    assert.equal(old.reason, 'active_turn_changed'); assert.equal(nativeCalls.length, 0);
    runner.rememberTerminalTurnId('next-turn');
    const closing = await runner.interruptTurn({ interruptRequestId: 'closing', expectedTurnId: 'next-turn' });
    assert.equal(closing.status, 'no_active', 'terminal observed before cleanup must not get a native interrupt');
    assert.equal(nativeCalls.length, 0);
    console.log('interrupt completion race: terminal cleanup, stale targets, real pending submissions passed');
  } finally {
    releaseIdle(); await completion?.catch(() => {});
    runner.cancelThreadIdleReconciliation(); runner.cancelSubmissionReconciliation();
    runner.cleanupManagedOverlay(); fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
