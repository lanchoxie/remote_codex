const assert = require('assert');
const { deliverAgentEventBatch } = require('../shared/agent-event-batch');

function makeEvents(count) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'session.transcript',
    hostId: 'transport-test-host',
    sessionId: 'transport-test-session',
    text: `event ${index}`,
  }));
}

async function main() {
  const events = makeEvents(3);
  const batchCalls = [];
  const singleCalls = [];
  await deliverAgentEventBatch(events, {
    batchId: 'batch-success',
    sendBatch: async (batch, batchId) => {
      batchCalls.push({ batch, batchId });
      return { body: { count: batch.length } };
    },
    sendSingle: async (event) => singleCalls.push(event),
  });
  assert.deepStrictEqual(batchCalls, [{ batch: events, batchId: 'batch-success' }]);
  assert.deepStrictEqual(singleCalls, [], 'a supported Relay must receive one batch and no legacy events');

  const singleton = makeEvents(1);
  const singletonBatchCalls = [];
  const singletonCalls = [];
  await deliverAgentEventBatch(singleton, {
    batchId: 'batch-singleton-stable',
    sendBatch: async (batch, batchId) => {
      singletonBatchCalls.push({ batch, batchId });
      return { body: { count: batch.length } };
    },
    sendSingle: async (event) => singletonCalls.push(event),
  });
  assert.deepStrictEqual(
    singletonBatchCalls,
    [{ batch: singleton, batchId: 'batch-singleton-stable' }],
    'a singleton with a stable batch id must retain the idempotent batch envelope'
  );
  assert.deepStrictEqual(singletonCalls, []);

  const fallbackSingles = [];
  const unsupported = new Error('batch envelope is unsupported');
  unsupported.statusCode = 422;
  unsupported.body = { code: 'agent_event_batch_envelope_unsupported' };
  await deliverAgentEventBatch(events, {
    batchId: 'batch-old-relay',
    sendBatch: async () => {
      throw unsupported;
    },
    sendSingle: async (event) => fallbackSingles.push(event),
  });
  assert.deepStrictEqual(fallbackSingles, events, 'a 4xx response from an old Relay must fall back in event order');

  const bestEffortFallbackSingles = [];
  await deliverAgentEventBatch(events, {
    batchId: 'batch-old-relay-best-effort',
    bestEffort: true,
    sendBatch: async () => {
      throw unsupported;
    },
    sendSingle: async (event) => bestEffortFallbackSingles.push(event),
  });
  assert.deepStrictEqual(
    bestEffortFallbackSingles,
    events,
    'best-effort delivery must still use ordered singles after explicit legacy-envelope rejection'
  );

  for (const statusCode of [400, 422]) {
    const validationSingles = [];
    const validationError = new Error(`batch validation failed with ${statusCode}`);
    validationError.statusCode = statusCode;
    validationError.body = { code: 'agent_event_batch_apply_failed' };
    await assert.rejects(
      deliverAgentEventBatch(events, {
        batchId: `batch-validation-${statusCode}`,
        sendBatch: async () => {
          throw validationError;
        },
        sendSingle: async (event) => validationSingles.push(event),
      }),
      (error) => error === validationError,
      'new Relay validation/application errors must remain batch failures'
    );
    assert.deepStrictEqual(
      validationSingles,
      [],
      'a failed batch that may be partially applied must not replay the whole batch as singles'
    );
  }

  const partialApplySingles = [];
  const partialApplyError = new Error('second event failed after the first event was applied');
  partialApplyError.statusCode = 409;
  partialApplyError.body = {
    code: 'agent_event_batch_apply_failed',
    appliedCount: 1,
    failedEventIndex: 1,
  };
  await assert.rejects(
    deliverAgentEventBatch(events, {
      batchId: 'batch-partially-applied',
      sendBatch: async () => {
        throw partialApplyError;
      },
      sendSingle: async (event) => partialApplySingles.push(event),
    }),
    (error) => error === partialApplyError
  );
  assert.deepStrictEqual(partialApplySingles, []);

  const mismatchSingles = [];
  await assert.rejects(
    deliverAgentEventBatch(events, {
      batchId: 'batch-count-mismatch',
      sendBatch: async () => ({ body: { count: 0 } }),
      sendSingle: async (event) => mismatchSingles.push(event),
    }),
    (error) => error?.code === 'agent_event_batch_response_invalid',
    'an ambiguous success response must not replay a possibly applied batch as singles'
  );
  assert.deepStrictEqual(mismatchSingles, []);

  const transient = new Error('socket hang up');
  transient.code = 'ECONNRESET';
  await assert.rejects(
    deliverAgentEventBatch(events, {
      batchId: 'batch-transient-error',
      sendBatch: async () => {
        throw transient;
      },
      sendSingle: async () => {
        throw new Error('transient errors must not trigger legacy fallback');
      },
    }),
    (error) => error === transient,
    'a transient failure must remain retryable by the tailer'
  );

  console.log('agent event batch transport assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
