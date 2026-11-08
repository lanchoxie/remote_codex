const assert = require('assert');
const {
  assessSessionReviewAvailability,
  sessionReviewBlockerError,
} = require('../apps/mobile-web/public/session-review-guard');

function idleRuntime(patch = {}) {
  return {
    phase: 'idle',
    busy: false,
    activeTurnId: null,
    currentTurnStatus: 'idle',
    waitingOnApproval: false,
    waitingOnUserInput: false,
    ...patch,
  };
}

assert.strictEqual(
  assessSessionReviewAvailability({ live: true, runtime: idleRuntime() }),
  null,
  'an explicitly idle live Session must allow Review'
);

for (const runtime of [
  idleRuntime({ phase: 'thinking', busy: true, activeTurnId: 'turn-1', currentTurnStatus: 'inProgress' }),
  idleRuntime({ phase: 'submitting-turn', busy: true, pendingClientRequestId: 'request-1', currentTurnStatus: 'submitting' }),
  idleRuntime({ phase: 'waiting-approval', busy: true, waitingOnApproval: true, currentTurnStatus: 'inProgress' }),
  idleRuntime({ phase: 'waiting-user-input', busy: true, waitingOnUserInput: true, currentTurnStatus: 'inProgress' }),
]) {
  const blocker = assessSessionReviewAvailability({ live: true, runtime });
  assert.strictEqual(blocker?.code, 'session_review_busy');
  assert.match(blocker?.message || '', /not queued/i);
}

assert.strictEqual(
  assessSessionReviewAvailability({ live: true, runtime: null })?.code,
  'session_review_runtime_unknown',
  'missing runtime must fail closed'
);
assert.strictEqual(
  assessSessionReviewAvailability({
    live: true,
    runtime: idleRuntime({ phase: 'runtime-unknown', busy: true, currentTurnStatus: 'unknown' }),
  })?.code,
  'session_review_runtime_unknown',
  'an explicitly unknown runtime must fail closed'
);
assert.strictEqual(
  assessSessionReviewAvailability({
    live: true,
    runtime: idleRuntime(),
    pendingInput: { acceptanceUnknown: true, outcome: 'acceptance_unknown', clientRequestId: 'request-2' },
  })?.code,
  'session_review_input_acceptance_unknown'
);
assert.strictEqual(
  assessSessionReviewAvailability({
    live: true,
    runtime: idleRuntime(),
    pendingInput: { present: true, clientRequestId: 'request-3', commandId: 3 },
  })?.reason,
  'input_command_pending'
);
assert.strictEqual(
  assessSessionReviewAvailability({
    live: true,
    runtime: idleRuntime(),
    submission: { id: 'request-4', confirmationDelayed: true },
  })?.code,
  'session_review_input_acceptance_unknown'
);
assert.strictEqual(
  assessSessionReviewAvailability({ live: true, runtime: idleRuntime(), reviewQueued: true })?.reason,
  'review_already_queued'
);

const error = sessionReviewBlockerError(
  assessSessionReviewAvailability({ live: true, runtime: null })
);
assert.strictEqual(error.code, 'session_review_runtime_unknown');
assert.strictEqual(error.stage, 'validate-review');

console.log('session review guard tests passed');
