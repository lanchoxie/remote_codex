(function initSessionRuntimeState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexSessionRuntimeState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const ERROR_STATES = new Set(['error', 'failed', 'quota-exhausted']);
  const TERMINAL_STATES = new Set([
    ...ERROR_STATES, 'closed', 'complete', 'completed', 'cancelled', 'canceled',
    'interrupted', 'stopped', 'success', 'succeeded',
  ]);
  // These operations may legitimately retain the previous turn's status.
  const OPERATION_PHASES = new Set([
    'starting', 'opening-thread', 'stopping', 'ending', 'submitting-turn',
    'queued-turn', 'reviewing', 'running-shell-command', 'compacting', 'interrupting',
    'terminal-settling', 'runtime-unknown', 'retrying', 'reconnecting',
  ]);
  const ACTIVE_STATES = new Set([
    ...OPERATION_PHASES, 'thinking', 'planning', 'reviewing', 'waiting-approval',
    'waiting-user-input', 'running', 'inprogress', 'in_progress', 'started',
    'submitting', 'settling',
  ]);
  const statusName = (value) => String(value?.type || value || '').trim().toLowerCase();

  function terminalState(runtime = {}) {
    const phase = statusName(runtime?.phase);
    const status = statusName(runtime?.currentTurnStatus);
    if (TERMINAL_STATES.has(phase)) return phase;
    // A late thread-active observation is not proof that a failed turn resumed.
    // Explicit operations can still run after that failure without a new turn.
    if (ERROR_STATES.has(status) && !OPERATION_PHASES.has(phase)) return status;
    if (ACTIVE_STATES.has(phase)) return '';
    return TERMINAL_STATES.has(status) ? status : '';
  }

  function isActive(runtime = {}) {
    if (!runtime || terminalState(runtime)) return false;
    // idle + an active turn is ambiguous, not proof of completion. Keep the
    // controls guarded until the Runner reconciles it with the app-server.
    return Boolean(runtime.activeTurnId || runtime.busy || runtime.waitingOnApproval
      || runtime.waitingOnUserInput || ACTIVE_STATES.has(statusName(runtime.phase))
      || ACTIVE_STATES.has(statusName(runtime.currentTurnStatus)));
  }

  function issue(runtime = {}) {
    if (!runtime) return null;
    const terminal = terminalState(runtime);
    const message = String(runtime.userFacingError || runtime.lastError || runtime.lastCodexError || '').trim();
    if (ERROR_STATES.has(terminal)) {
      return { label: 'Error', tone: 'error', message: message || 'The current operation failed. Open Alerts for details.' };
    }
    if (terminal || (statusName(runtime.phase) === 'idle' && !isActive(runtime))) return null;
    const retrying = [runtime.phase, runtime.currentTurnStatus, runtime.connection]
      .some((value) => ['retrying', 'reconnecting'].includes(statusName(value)));
    if (!message) return null;
    return { label: retrying ? 'Retry' : 'Error', tone: retrying ? 'warning' : 'error', message };
  }

  function confirmsInactivePatch(runtime = {}) {
    if (!runtime || runtime.busy !== false || runtime.activeTurnId
      || runtime.waitingOnApproval === true || runtime.waitingOnUserInput === true) return false;
    const phase = statusName(runtime.phase);
    const status = statusName(runtime.currentTurnStatus);
    if (ACTIVE_STATES.has(status) || OPERATION_PHASES.has(phase)) return false;
    return phase === 'idle' || Boolean(terminalState(runtime));
  }

  function displayPhase(runtime = {}, fallback = 'unknown') {
    return runtime?.phase || terminalState(runtime) || fallback;
  }

  function conversationIssue(group, getRuntime) {
    const sessions = group?.sessions || [];
    const live = sessions.filter((session) => session?.live === true);
    // Do not resurrect an older failed variant when a replacement is live.
    const candidates = live.length ? live : [group?.preferredSession || sessions[0]].filter(Boolean);
    for (const session of candidates) {
      const runId = session.runId || session.runtimeConfig?.runId || session.runtime?.runId || '';
      const runtime = [getRuntime(session), session.runtime].find((candidate) => (
        candidate && (!(runId || candidate.runId) || runId === candidate.runId)
      ));
      const currentIssue = issue(runtime || {});
      if (currentIssue?.tone === 'error') return { session, issue: currentIssue };
      // Launch failures may close the runtime before there is a turn to fail.
      // Only the current candidate's explicit failure may use this fallback.
      if (/^failed(?::|$)/i.test(String(session.state || '')) && session.resumeError) {
        return { session, issue: { label: 'Error', tone: 'error', message: String(session.resumeError) } };
      }
    }
    return null;
  }

  return Object.freeze({ isActive, issue, confirmsInactivePatch, displayPhase, terminalState, conversationIssue });
}));
