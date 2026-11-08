const assert = require('assert');

const streamApi = require('../apps/mobile-web/public/session-stream-client.js');

class FakeEventSource {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) || []) {
      listener(event);
    }
  }
}

function createHarness() {
  const state = {
    source: null,
    streamKey: null,
    generation: 0,
  };
  const cursorStore = new Map();
  const cursorGenerationStore = new Map();
  const failures = [];
  const errors = [];
  const client = streamApi.createSessionStreamClient({
    getCurrent: () => ({ ...state }),
    resolveCanonicalKey: () => 'host-a::session-a',
    cursorStore,
    cursorGenerationStore,
    onError: (error) => errors.push(error),
  });
  return { client, cursorStore, cursorGenerationStore, errors, failures, state };
}

function setCurrent(harness, source, streamKey, generation) {
  harness.state.source = source;
  harness.state.streamKey = streamKey;
  harness.state.generation = generation;
}

function testCursorParsingAndFencing() {
  assert.deepStrictEqual(streamApi.parseCursor('epoch-a:12'), {
    epoch: 'epoch-a',
    counter: 12,
  });
  assert.strictEqual(streamApi.parseCursor('epoch-a:-1'), null);
  assert.strictEqual(streamApi.parseCursor('epoch-a:not-a-number'), null);
  assert.strictEqual(streamApi.parseCursor(''), null);

  const harness = createHarness();
  const source = new FakeEventSource();
  const replacement = new FakeEventSource();
  setCurrent(harness, source, 'host-a::session-a', 1);
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  const payload = { canonicalConversationKey: 'host-a::session-a' };

  assert.strictEqual(
    harness.client.commitDirect(session, { lastEventId: 'epoch-a:10' }, payload, 'host-a::session-a', 1),
    'host-a::session-a'
  );
  setCurrent(harness, replacement, 'host-a::session-a', 2);
  harness.cursorGenerationStore.set('host-a::session-a', 2);
  assert.strictEqual(
    harness.client.commitDirect(session, { lastEventId: 'epoch-a:9' }, payload, 'host-a::session-a', 1),
    false,
    'a direct completion from an older generation must be rejected'
  );
  assert.strictEqual(harness.cursorStore.get('host-a::session-a'), 'epoch-a:10');

  assert.strictEqual(
    harness.client.commitDirect(session, { lastEventId: 'epoch-a:11' }, payload, 'host-a::session-a', 2),
    'host-a::session-a'
  );
  assert.strictEqual(
    harness.client.commitDirect(session, { lastEventId: 'epoch-a:8' }, payload, 'host-a::session-a', 2),
    'host-a::session-a',
    'a cursor must not move backward within one epoch'
  );
  assert.strictEqual(harness.cursorStore.get('host-a::session-a'), 'epoch-a:11');
}

function testOrderedDeferredCommit() {
  const harness = createHarness();
  const source = new FakeEventSource();
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  setCurrent(harness, source, 'host-a::session-a', 1);
  const gate = harness.client.createGate(session, source, 'host-a::session-a', 1, {
    onFailure: (error) => harness.failures.push(error),
  });

  let releaseFirst;
  gate.listen('first', (event) => {
    assert.strictEqual(harness.client.defer(event), true);
    return {
      then(resolve) {
        releaseFirst = () => {
          assert.strictEqual(
            harness.client.commit(session, event, { step: 1 }, 'host-a::session-a'),
            true
          );
          resolve(true);
        };
      },
    };
  });
  gate.listen('second', (event) => {
    assert.strictEqual(
      harness.client.commit(session, event, { step: 2 }, 'host-a::session-a'),
      true
    );
    return true;
  });

  source.emit('first', { lastEventId: 'epoch-a:1' });
  source.emit('second', { lastEventId: 'epoch-a:2' });
  assert.strictEqual(gate.pendingCount, 2, 'a deferred event must block later cursor advancement');
  assert.strictEqual(harness.cursorStore.has('host-a::session-a'), false);

  releaseFirst();
  assert.strictEqual(gate.pendingCount, 0);
  assert.strictEqual(harness.cursorStore.get('host-a::session-a'), 'epoch-a:2');
  assert.strictEqual(harness.failures.length, 0);
}

function testStaleAsyncCompletionAndCallbackGuards() {
  const harness = createHarness();
  const source = new FakeEventSource();
  const replacement = new FakeEventSource();
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  setCurrent(harness, source, 'host-a::session-a', 1);
  const gate = harness.client.createGate(session, source, 'host-a::session-a', 1);
  let release;
  let staleEvent;
  gate.listen('async', (event) => {
    staleEvent = event;
    assert.strictEqual(harness.client.defer(event), true);
    return {
      then(resolve) {
        release = () => {
          assert.strictEqual(
            harness.client.commit(session, event, { stale: true }, 'host-a::session-a'),
            false,
            'an old-generation async completion must be rejected'
          );
          resolve(true);
        };
      },
    };
  });
  source.emit('async', { lastEventId: 'epoch-a:3' });
  setCurrent(harness, replacement, 'host-a::session-a', 2);
  release();
  assert.strictEqual(gate.pendingCount, 0);
  assert.strictEqual(
    harness.client.commit(session, staleEvent, { stale: true }, 'host-a::session-a'),
    false,
    'the stale event context must not fall through to a direct commit'
  );

  const mutations = [];
  const callbacks = ['open', 'ready', 'ping', 'error'].map((name) => (
    harness.client.guardCallback(source, 'host-a::session-a', 1, () => mutations.push(name))
  ));
  for (const callback of callbacks) callback();
  assert.deepStrictEqual(mutations, [], 'callbacks from the replaced source must be fenced');

  const currentCallback = harness.client.guardCallback(
    replacement,
    'host-a::session-a',
    2,
    () => mutations.push('current')
  );
  currentCallback();
  assert.deepStrictEqual(mutations, ['current']);
}

function testThenableFailures() {
  const getterHarness = createHarness();
  const source = new FakeEventSource();
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  setCurrent(getterHarness, source, 'host-a::session-a', 1);
  const getterFailures = [];
  const getterGate = getterHarness.client.createGate(session, source, 'host-a::session-a', 1, {
    onFailure: (error) => getterFailures.push(error),
  });
  getterGate.listen('getter', () => {
    const result = {};
    Object.defineProperty(result, 'then', {
      get() {
        throw new Error('then getter failed');
      },
    });
    return result;
  });
  source.emit('getter', { lastEventId: 'epoch-a:1' });
  assert.strictEqual(getterFailures.length, 1);
  assert.strictEqual(getterHarness.errors.length, 1);
  assert.strictEqual(getterGate.blocked, true);

  const rejectionHarness = createHarness();
  const rejectionSource = new FakeEventSource();
  setCurrent(rejectionHarness, rejectionSource, 'host-a::session-a', 1);
  const rejectionFailures = [];
  const rejectionGate = rejectionHarness.client.createGate(
    session,
    rejectionSource,
    'host-a::session-a',
    1,
    { onFailure: (error) => rejectionFailures.push(error) }
  );
  rejectionGate.listen('rejection', () => ({
    then(_resolve, reject) {
      reject(new Error('thenable rejected'));
    },
  }));
  rejectionSource.emit('rejection', { lastEventId: 'epoch-a:1' });
  assert.strictEqual(rejectionFailures.length, 1);
  assert.strictEqual(rejectionHarness.errors.length, 1);
  assert.strictEqual(rejectionGate.blocked, true);
}

testCursorParsingAndFencing();
testOrderedDeferredCommit();
testStaleAsyncCompletionAndCallbackGuards();
testThenableFailures();
console.log('session stream client assertions passed');
