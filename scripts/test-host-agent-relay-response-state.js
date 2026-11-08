const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('apps/host-agent/agent.js', 'utf8');

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `missing source block: ${startMarker}`);
  return source.slice(start, end);
}

function loadRelayResponseHarness() {
  const context = {};
  vm.runInNewContext(`
    let lastCommandId = 0;
    let lastFetchedCommandId = 0;
    const deliveredCommandStates = new Map();
    const deferredCommandRetryIds = new Set();
    const explicitCommandLaneStates = new Map([
      ['normal', {
        lastCommandId: 0,
        lastFetchedCommandId: 0,
        deliveredCommandStates: new Map(),
        deferredCommandRetryIds: new Set(),
      }],
      ['control', {
        lastCommandId: 0,
        lastFetchedCommandId: 0,
        deliveredCommandStates: new Map(),
        deferredCommandRetryIds: new Set(),
      }],
    ]);
    const processedCommandStates = new Map();
    let relaySupportsCommandLanes = true;
    let relayInstanceId = 'epoch-a';
    let relayObservationGeneration = 1;
    let relayResponseRequestSequence = 0;
    let relayCommandLaneObservationSequence = 0;
    let relayLeaseObservationSequence = 0;
    let agentLeaseId = 'lease-a';
    ${sourceBlock('function rememberProcessedCommandState', 'function managedAgentProcessMetadata')}
    globalThis.harness = {
      captureRelayResponseContext,
      relayResponseIsStale,
      observeRelayResponse,
      rememberProcessedCommandState,
      state: () => ({
        relayInstanceId,
        relayObservationGeneration,
        relaySupportsCommandLanes,
        agentLeaseId,
        processed: Array.from(processedCommandStates.entries()),
      }),
    };
  `, context);
  return context.harness;
}

function verifyOldResponsesCannotOverwriteNewEpoch() {
  const harness = loadRelayResponseHarness();
  const oldRegister = harness.captureRelayResponseContext();
  const newHeartbeat = harness.captureRelayResponseContext();

  const adopted = harness.observeRelayResponse({
    relayInstanceId: 'epoch-b',
    commandLanesV1: true,
    agentLeaseId: 'lease-b',
  }, newHeartbeat, {
    observeCommandLanes: true,
    observeAgentLease: true,
  });
  assert.strictEqual(adopted.stale, false);
  assert.strictEqual(adopted.relayChanged, true);
  const adoptedState = harness.state();
  assert.strictEqual(adoptedState.relayInstanceId, 'epoch-b');
  assert.strictEqual(adoptedState.relayObservationGeneration, 2);
  assert.strictEqual(adoptedState.relaySupportsCommandLanes, true);
  assert.strictEqual(adoptedState.agentLeaseId, 'lease-b');
  assert.strictEqual(adoptedState.processed.length, 0);

  const stale = harness.observeRelayResponse({
    relayInstanceId: 'epoch-a',
    commandLanesV1: false,
    agentLeaseId: 'lease-from-late-register',
  }, oldRegister, {
    observeCommandLanes: true,
    observeAgentLease: true,
  });
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(harness.state().relayInstanceId, 'epoch-b');
  assert.strictEqual(harness.state().agentLeaseId, 'lease-b');
  assert.strictEqual(harness.state().relaySupportsCommandLanes, true);

  assert.strictEqual(
    harness.relayResponseIsStale({}, oldRegister),
    true,
    'an identity-less response from an older request generation must be ignored'
  );
}

function verifyOlderSameEpochFieldsCannotWin() {
  const harness = loadRelayResponseHarness();
  const olderHeartbeat = harness.captureRelayResponseContext();
  const newerCommandPoll = harness.captureRelayResponseContext();

  harness.observeRelayResponse({
    relayInstanceId: 'epoch-a',
    commandLanesV1: false,
    agentLeaseId: 'lease-newer',
  }, newerCommandPoll, {
    observeCommandLanes: true,
    observeAgentLease: true,
  });
  harness.observeRelayResponse({
    relayInstanceId: 'epoch-a',
    commandLanesV1: true,
    agentLeaseId: 'late-old-lease',
  }, olderHeartbeat, {
    observeCommandLanes: true,
    observeAgentLease: true,
  });

  const state = harness.state();
  assert.strictEqual(state.relaySupportsCommandLanes, false);
  assert.strictEqual(state.agentLeaseId, 'lease-newer');
}

function verifyEventsDoNotNegotiateLanesAndNewEpochInvalidatesLease() {
  const harness = loadRelayResponseHarness();
  const sameEpochEvent = harness.captureRelayResponseContext();
  harness.observeRelayResponse({ relayInstanceId: 'epoch-a' }, sameEpochEvent, {
    observeCommandLanes: false,
    observeAgentLease: false,
  });
  assert.strictEqual(harness.state().relaySupportsCommandLanes, true);

  harness.rememberProcessedCommandState(7, 'completed');
  const restartedRelayEvent = harness.captureRelayResponseContext();
  const observed = harness.observeRelayResponse({ relayInstanceId: 'epoch-b' }, restartedRelayEvent, {
    observeCommandLanes: false,
    observeAgentLease: false,
  });
  assert.strictEqual(observed.relayChanged, true);
  assert.strictEqual(harness.state().agentLeaseId, null);
  assert.strictEqual(harness.state().processed.length, 0);
}

async function verifyLaneDowngradeDoesNotReplayProcessedCommands() {
  let handleCalls = 0;
  const context = {
    handleCommand: async () => {
      handleCalls += 1;
      return null;
    },
    postCommandFailure: async () => {},
    logAgentTransient: () => {},
  };
  vm.runInNewContext(`
    let lastCommandId = 0;
    let lastFetchedCommandId = 0;
    const deliveredCommandStates = new Map();
    const deferredCommandRetryIds = new Set();
    const explicitCommandLaneStates = new Map([
      ['normal', {
        lastCommandId: 0,
        lastFetchedCommandId: 0,
        deliveredCommandStates: new Map(),
        deferredCommandRetryIds: new Set(),
      }],
      ['control', {
        lastCommandId: 0,
        lastFetchedCommandId: 0,
        deliveredCommandStates: new Map(),
        deferredCommandRetryIds: new Set(),
      }],
    ]);
    const processedCommandStates = new Map();
    let relaySupportsCommandLanes = true;
    let relayInstanceId = 'epoch-a';
    let relayObservationGeneration = 1;
    let relayResponseRequestSequence = 0;
    let relayCommandLaneObservationSequence = 0;
    let relayLeaseObservationSequence = 0;
    let agentLeaseId = 'lease-a';
    ${sourceBlock('function rememberProcessedCommandState', 'function managedAgentProcessMetadata')}
    ${sourceBlock('function explicitCommandLaneState', 'async function discoveryLoop')}
    globalThis.harness = {
      markProcessed: (id) => rememberProcessedCommandState(id, 'completed'),
      downgrade: () => {
        const request = captureRelayResponseContext();
        return observeRelayResponse({
          relayInstanceId: 'epoch-a',
          commandLanesV1: false,
        }, request, {
          observeCommandLanes: true,
          observeAgentLease: false,
        });
      },
      process: (command) => processPolledCommand(command, 'epoch-a', ''),
      state: () => ({ lastCommandId, relaySupportsCommandLanes }),
    };
  `, context);

  context.harness.markProcessed(12);
  context.harness.downgrade();
  assert.strictEqual(context.harness.state().relaySupportsCommandLanes, false);
  assert.strictEqual(await context.harness.process({ id: 12, type: 'session.input' }), true);
  assert.strictEqual(handleCalls, 0, 'a same-epoch lane fallback must not execute an already processed command again');
  assert.strictEqual(context.harness.state().lastCommandId, 12);
}

function verifyAgentWiring() {
  const eventBlock = sourceBlock('async function postAgentEventPayload', 'async function postEvent');
  assert(
    eventBlock.includes('if (observation.relayChanged)')
      && eventBlock.includes('await ensureHostRegistration()'),
    'an event response that discovers a new Relay epoch must re-register the Host'
  );

  const shutdownAckBlock = sourceBlock(
    'async function acknowledgeCommandsBeforeShutdown',
    'async function pollCommandsLoop'
  );
  assert(shutdownAckBlock.includes('captureRelayResponseContext()'));
  assert(shutdownAckBlock.includes('observeRelayResponse('));
  assert(!shutdownAckBlock.includes('observeRelayInstance(result.body)'));

  const heartbeatLoopBlock = sourceBlock('async function heartbeatLoop', 'function sleep');
  assert(
    /recoverAgentLeaseForRequest\(\s*error,\s*requestLeaseId,\s*error\?\.relayResponseContext/.test(heartbeatLoopBlock),
    'heartbeat recovery must pass the response context captured for that request'
  );
}

Promise.resolve()
  .then(verifyOldResponsesCannotOverwriteNewEpoch)
  .then(verifyOlderSameEpochFieldsCannotWin)
  .then(verifyEventsDoNotNegotiateLanesAndNewEpochInvalidatesLease)
  .then(verifyLaneDowngradeDoesNotReplayProcessedCommands)
  .then(verifyAgentWiring)
  .then(() => console.log('host-agent Relay response state assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
