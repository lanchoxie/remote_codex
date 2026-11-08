(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexSessionReviewGuard = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const TERMINAL_PHASES = new Set([
    'idle',
    'completed',
    'error',
    'interrupted',
    'closed',
    'quota-exhausted',
  ]);
  const ACTIVE_PHASES = new Set([
    'initializing',
    'opening-thread',
    'starting',
    'queued-turn',
    'submitting-turn',
    'thinking',
    'planning',
    'reviewing',
    'waiting-approval',
    'waiting-user-input',
    'retrying',
    'reconnecting',
    'interrupting',
    'running-shell-command',
    'compacting',
    'terminal-settling',
    'ending',
    'stopping',
  ]);
  const ACTIVE_TURN_STATUSES = new Set([
    'queued',
    'submitting',
    'inprogress',
    'in_progress',
    'running',
    'started',
    'interrupting',
    'settling',
    'stopping',
  ]);
  const UNKNOWN_RUNTIME_PHASES = new Set(['runtime-unknown', 'unknown']);

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function text(value) {
    return String(value || '').trim();
  }

  function makeBlocker(code, reason, message, details = {}) {
    return {
      code,
      reason,
      message,
      retryAfterMs: 1000,
      ...details,
    };
  }

  function assessSessionReviewAvailability(input = {}) {
    if (input.live !== true) {
      return makeBlocker(
        'session_review_not_live',
        'session_not_live',
        'Select a live managed Session before starting a Review.',
        { retryAfterMs: null }
      );
    }

    const runtime = object(input.runtime);
    const submission = object(input.submission);
    const pendingInput = object(input.pendingInput);
    const phase = text(runtime?.phase).toLowerCase();
    const currentTurnStatus = text(runtime?.currentTurnStatus).toLowerCase();
    const inputOutcome = text(runtime?.inputOutcome || pendingInput?.outcome).toLowerCase();
    const pendingClientRequestId = text(
      pendingInput?.clientRequestId
      || runtime?.pendingClientRequestId
      || runtime?.preparingClientRequestId
    ) || null;

    if (
      inputOutcome === 'acceptance_unknown'
      || pendingInput?.acceptanceUnknown === true
      || submission?.confirmationDelayed === true
    ) {
      return makeBlocker(
        'session_review_input_acceptance_unknown',
        'input_acceptance_unknown',
        'Codex may already have accepted the current prompt. Review was not queued. Wait for that prompt to resolve, then retry.',
        {
          phase: phase || null,
          currentTurnStatus: currentTurnStatus || null,
          pendingClientRequestId,
          inputOutcome: 'acceptance_unknown',
        }
      );
    }

    if (submission || pendingInput?.present === true) {
      return makeBlocker(
        'session_review_busy',
        submission ? 'composer_submission_pending' : 'input_command_pending',
        'A prompt is still being queued or accepted. Review was not queued. Wait for the prompt state to settle, then retry.',
        {
          phase: phase || null,
          currentTurnStatus: currentTurnStatus || null,
          pendingClientRequestId: pendingClientRequestId || text(submission?.id) || null,
          queuedCommandId: pendingInput?.commandId || runtime?.queuedCommandId || null,
        }
      );
    }

    if (input.reviewQueued === true) {
      return makeBlocker(
        'session_review_busy',
        'review_already_queued',
        'A Review is already queued or running for this Session.',
        {
          phase: phase || null,
          currentTurnStatus: currentTurnStatus || null,
        }
      );
    }

    if (input.inputStateKnown === false) {
      return makeBlocker(
        'session_review_runtime_unknown',
        'input_state_unavailable',
        'The Relay cannot verify whether this Session still owns a pending prompt. Review was not queued. Wait for state recovery, then retry.',
        {
          phase: phase || null,
          currentTurnStatus: currentTurnStatus || null,
          pendingClientRequestId,
        }
      );
    }

    if (!runtime || UNKNOWN_RUNTIME_PHASES.has(phase) || currentTurnStatus === 'unknown') {
      return makeBlocker(
        'session_review_runtime_unknown',
        runtime ? 'runtime_state_unknown' : 'runtime_snapshot_missing',
        'The Session runtime cannot confirm that Codex is idle. Review was not queued. Wait for status recovery, then retry.',
        {
          phase: phase || null,
          currentTurnStatus: currentTurnStatus || null,
          activeTurnId: text(runtime?.activeTurnId) || null,
          pendingClientRequestId,
        }
      );
    }

    const active = Boolean(
      runtime.activeTurnId
      || runtime.pendingClientRequestId
      || runtime.preparingClientRequestId
      || runtime.waitingOnApproval === true
      || runtime.waitingOnUserInput === true
      || runtime.busy === true
      || ACTIVE_PHASES.has(phase)
      || ACTIVE_TURN_STATUSES.has(currentTurnStatus)
      || (runtime.queuedCommandId && !TERMINAL_PHASES.has(phase))
    );
    if (active) {
      return makeBlocker(
        'session_review_busy',
        runtime.waitingOnApproval === true || phase === 'waiting-approval'
          ? 'waiting_on_approval'
          : runtime.waitingOnUserInput === true || phase === 'waiting-user-input'
            ? 'waiting_on_user_input'
            : runtime.preparingClientRequestId
              ? 'input_preparing'
              : runtime.pendingClientRequestId || phase === 'submitting-turn'
                ? 'input_submitting'
                : runtime.activeTurnId
                  ? 'turn_active'
                  : 'runtime_busy',
        'Codex is still working in this Session. Review was not queued. Wait for the current work to finish or interrupt it, then retry.',
        {
          phase: phase || null,
          currentTurnStatus: currentTurnStatus || null,
          activeTurnId: text(runtime.activeTurnId) || null,
          pendingClientRequestId,
          queuedCommandId: runtime.queuedCommandId || null,
        }
      );
    }

    if (!TERMINAL_PHASES.has(phase)) {
      return makeBlocker(
        'session_review_runtime_unknown',
        'runtime_phase_unverified',
        'The Session runtime cannot confirm that Codex is idle. Review was not queued. Wait for status recovery, then retry.',
        {
          phase: phase || null,
          currentTurnStatus: currentTurnStatus || null,
        }
      );
    }

    return null;
  }

  function sessionReviewBlockerError(blocker) {
    const error = new Error(blocker?.message || 'Review is not available for this Session.');
    Object.assign(error, blocker || {});
    error.stage = 'validate-review';
    return error;
  }

  return Object.freeze({
    assessSessionReviewAvailability,
    sessionReviewBlockerError,
  });
}));
