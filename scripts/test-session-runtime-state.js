const assert = require('assert');
const runtime = require('../apps/mobile-web/public/session-runtime-state');

for (const phase of ['completed', 'closed', 'error', 'failed', 'quota-exhausted', 'interrupted']) {
  assert.strictEqual(runtime.isActive({ phase, busy: true, activeTurnId: 'stale' }), false, phase);
}
assert.strictEqual(runtime.isActive(null), false);
assert.strictEqual(runtime.isActive({ phase: 'running', currentTurnStatus: 'completed', busy: true, activeTurnId: 'stale' }), true);
for (const phase of ['reviewing', 'compacting', 'running-shell-command', 'submitting-turn', 'queued-turn', 'interrupting', 'terminal-settling', 'runtime-unknown']) {
  assert.strictEqual(runtime.isActive({ phase, currentTurnStatus: 'completed', busy: true }), true, phase);
}
assert.strictEqual(runtime.isActive({ phase: 'thinking', currentTurnStatus: 'completed', threadStatus: { type: 'active' }, busy: true }), true);
assert.strictEqual(runtime.isActive({ phase: 'idle', activeTurnId: 'unconfirmed-turn', busy: true }), true, 'idle alone is not terminal evidence');
assert.strictEqual(runtime.isActive({ phase: 'thinking', currentTurnStatus: 'inProgress', state: 'closed', status: 'completed' }), true, 'unrelated legacy fields cannot override runtime phase');
assert.strictEqual(runtime.isActive({ phase: 'idle', busy: false }), false);

assert.strictEqual(runtime.issue({ phase: 'closed', lastCodexError: 'old' }), null);
assert.strictEqual(runtime.issue({ phase: 'completed', userFacingError: 'old' }), null);
assert.strictEqual(runtime.issue({ phase: 'idle', busy: false, lastError: 'old' }), null);
assert.strictEqual(runtime.issue({ phase: 'error', lastError: 'review failed' }).message, 'review failed');
assert.strictEqual(runtime.issue({ phase: 'failed' }).tone, 'error', 'failed without a message still needs an error marker');
assert.strictEqual(runtime.issue({ phase: 'error', connection: 'reconnecting', userFacingError: 'failed' }).tone, 'error');
assert.strictEqual(runtime.issue({ phase: 'retrying', currentTurnStatus: 'completed', lastError: 'temporary' }).tone, 'warning');
assert.strictEqual(runtime.isActive({ connection: 'reconnecting' }), false, 'transport reconnect is not a running turn');
assert.strictEqual(runtime.issue({ connection: 'reconnecting', lastError: 'temporary connection failure' }).tone, 'warning');
assert.strictEqual(runtime.issue({ phase: 'idle', connection: 'reconnecting', lastError: 'old' }), null);
assert.strictEqual(runtime.issue({ phase: 'thinking', currentTurnStatus: 'failed', connection: 'reconnecting', lastError: 'failed turn' }).tone, 'error');
assert.strictEqual(runtime.isActive({ phase: 'thinking', currentTurnStatus: 'failed', busy: true }), false);
for (const phase of ['reviewing', 'compacting', 'running-shell-command', 'submitting-turn']) {
  assert.strictEqual(runtime.isActive({ phase, currentTurnStatus: 'failed', busy: true }), true, phase);
}
assert.strictEqual(runtime.displayPhase({ phase: 'running', currentTurnStatus: 'completed' }), 'running');

for (const phase of ['idle', 'completed', 'closed', 'error', 'interrupted']) {
  assert.strictEqual(runtime.confirmsInactivePatch({ phase, busy: false }), true, phase);
  assert.strictEqual(runtime.confirmsInactivePatch({ phase, busy: false, activeTurnId: 'explicit' }), false, phase);
  assert.strictEqual(runtime.confirmsInactivePatch({ phase, busy: false, waitingOnApproval: true }), false, phase);
}
assert.strictEqual(runtime.confirmsInactivePatch({ phase: 'idle' }), false);
assert.strictEqual(runtime.confirmsInactivePatch({ phase: 'idle', busy: false, currentTurnStatus: 'inProgress' }), false);
assert.strictEqual(runtime.confirmsInactivePatch({ phase: 'reviewing', busy: false, currentTurnStatus: 'completed' }), false);
const failedSession = { live: true, runId: 'run-a', runtime: { runId: 'run-a', phase: 'error', lastError: 'failed turn' } };
assert.strictEqual(runtime.conversationIssue({ sessions: [failedSession] }, () => null)?.issue.message, 'failed turn');
assert.strictEqual(runtime.conversationIssue({ sessions: [failedSession] }, () => ({ runId: 'old', phase: 'error' }))?.issue.message, 'failed turn', 'a stale cache must not hide the matching session runtime');
assert.strictEqual(runtime.conversationIssue({ sessions: [{ ...failedSession, runtime: { runId: 'old', phase: 'error' } }] }, () => ({ runId: 'old', phase: 'error' })), null, 'never use a mismatched runtime');
assert.strictEqual(runtime.conversationIssue({ sessions: [failedSession] }, () => ({ runId: 'run-a', phase: 'idle', busy: false })), null, 'a matching settled cache outranks an older session failure');
const startupFailed = { live: false, state: 'failed: launch error', resumeError: 'Codex failed to start', runtime: { phase: 'closed' } };
assert.strictEqual(runtime.conversationIssue({ sessions: [startupFailed] }, () => null)?.issue.message, 'Codex failed to start');
assert.strictEqual(runtime.conversationIssue({ sessions: [{ ...startupFailed, state: 'stopped' }] }, () => null), null, 'stale resumeError alone must not create an error badge');
assert.strictEqual(runtime.conversationIssue({ sessions: [startupFailed, { live: true, runtime: { phase: 'idle' } }] }, () => null), null, 'old startup failures cannot taint live replacements');
assert.strictEqual(runtime.conversationIssue({ sessions: [{ live: true, runtime: { phase: 'idle', busy: false } }, { ...failedSession, live: false }] }, () => null), null, 'old failed variant cannot taint its replacement');
assert.strictEqual(runtime.conversationIssue({ sessions: [{ ...failedSession, live: false }] }, () => null)?.issue.tone, 'error', 'history retains a known failed result');
assert.strictEqual(runtime.conversationIssue({ sessions: [{ live: true, runtime: { phase: 'retrying', lastError: 'retry' } }] }, () => null), null, 'retry is not a terminal error badge');
console.log('session runtime state assertions passed');
