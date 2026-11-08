'use strict';
const { createHash } = require('crypto');
const { createRetryableTerminalReceiptExecutor } = require('./managed-session-lifecycle');

function createSessionSteerCommandHandler({ hostId, enqueueControl, deliver }) {
  const executor = createRetryableTerminalReceiptExecutor();
  return function handle(command, runner) {
    const identity = JSON.stringify([hostId, command.id, command.requestId, command.sessionId, command.runId, command.expectedTurnId]);
    const batchId = `steer:${createHash('sha256').update(identity).digest('hex')}`;
    const execute = async () => {
      const receipt = {
        type: 'session.steer_result', hostId, sessionId: command.sessionId,
        requestId: command.requestId, commandId: command.id,
        runId: command.runId, expectedTurnId: command.expectedTurnId,
      };
      try {
        if (!command.requestId || !command.runId || !command.expectedTurnId || !runner || runner.runId !== command.runId) {
          throw Object.assign(new Error('The requested live Guide target is no longer available.'), { code: 'steer_target_changed' });
        }
        if (typeof runner.steerTurn !== 'function') {
          throw Object.assign(new Error('This Host runner does not support Guide.'), { code: 'steer_unsupported' });
        }
        let result;
        await enqueueControl(runner, () => {
          // Dispatch in order, but wait for the native result outside the control
          // lane so a slow acknowledgement cannot hold up approval/interrupt.
          result = (async () => runner.steerTurn(String(command.text || ''), {
            expectedRunId: command.runId, expectedTurnId: command.expectedTurnId,
          }))().then((value) => ({ value }), (error) => ({ error }));
        });
        const outcome = await result;
        if (outcome.error) throw outcome.error;
        if (outcome.value?.status !== 'accepted' || outcome.value?.turnId !== command.expectedTurnId) {
          throw Object.assign(new Error('Host returned no matching Guide acknowledgement.'), { steerAcceptanceUnknown: true, code: 'steer_acceptance_unknown' });
        }
        Object.assign(receipt, { status: 'accepted', turnId: outcome.value.turnId });
      } catch (error) {
        Object.assign(receipt, {
          status: error?.steerAcceptanceUnknown ? 'acceptance_unknown' : 'rejected',
          code: error?.code || (error?.rpcCode != null ? 'steer_native_rejected' : 'steer_rejected'),
          error: String(error?.message || error).slice(0, 2000),
        });
      }
      return { ...receipt, timestamp: new Date().toISOString() };
    };
    // Match the Relay bound; failing closed is preferable to forgetting an ID
    // and accidentally repeating its native effect during receipt retry.
    if (!executor.has(identity) && executor.size() >= 4096) {
      return deliver({
        type: 'session.steer_result', hostId, sessionId: command.sessionId,
        requestId: command.requestId, commandId: command.id, runId: command.runId,
        expectedTurnId: command.expectedTurnId, status: 'rejected', code: 'steer_capacity',
        error: 'Host Guide operation capacity reached; nothing was sent.', timestamp: new Date().toISOString(),
      }, batchId);
    }
    return executor.run(identity, execute, async (receipt) => {
      try { await deliver(receipt, batchId); }
      catch (error) { error.retryCommand = true; throw error; }
    });
  };
}
module.exports = { createSessionSteerCommandHandler };
