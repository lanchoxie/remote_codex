const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const streamApi = require('../apps/mobile-web/public/session-stream-client.js');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = app.indexOf(marker);
  assert(start >= 0, `${name} was not found in app.js`);
  const next = app.indexOf('\nfunction ', start + marker.length);
  return app.slice(start, next >= 0 ? next : app.length).trim();
}

const subscribeStart = app.indexOf('function subscribeSession(');
const subscribeEnd = app.indexOf('\nasync function showSession(', subscribeStart);
assert(subscribeStart >= 0 && subscribeEnd > subscribeStart, 'subscribeSession body is missing');
const subscribeSource = app.slice(subscribeStart, subscribeEnd);
assert(
  !subscribeSource.includes('for (const eventName of cursorEvents)'),
  'SSE must not advance the cursor in a generic listener before event application'
);
assert(subscribeSource.includes('guardStreamCallback'), 'raw SSE callbacks must be guarded');
assert(
  (subscribeSource.match(/guardStreamCallback\(/g) || []).length >= 4,
  'open, ready, ping, and error callbacks must all use the guard'
);
assert(!app.includes('const sessionStreamEventContexts = new WeakMap()'));
assert(app.includes('const eventSessionKey = makeSessionKey(eventHostId, eventSessionId);'));

const streamState = {
  eventCursorByCanonical: new Map(),
  eventCursorGenerationByCanonical: new Map(),
  sessionStreamGeneration: 0,
  eventSource: null,
  eventSourceKey: null,
  activityProjection: {
    applyActivity: () => false,
    epochFor: () => 'epoch-a',
    activitiesFor: () => [],
  },
};
const streamClient = streamApi.createSessionStreamClient({
  getCurrent: () => ({
    source: streamState.eventSource,
    streamKey: streamState.eventSourceKey,
    generation: streamState.sessionStreamGeneration,
  }),
  resolveCanonicalKey: () => 'host-a::session-a',
  cursorStore: streamState.eventCursorByCanonical,
  cursorGenerationStore: streamState.eventCursorGenerationByCanonical,
});
const context = vm.createContext({
  state: streamState,
  getSessionStreamClient: () => streamClient,
  rememberActivityCanonicalKey: (key) => String(key || '').trim(),
  getActivityCanonicalKeyForSession: () => 'host-a::session-a',
  rememberActivityClientRequestIds: () => {},
  patchProjectedThinkingActivity: () => false,
  getSelectedSession: () => null,
  scheduleTranscriptRender: () => {},
  reportError: () => {},
});

for (const name of [
  'sessionStreamEventCanonicalKey',
  'parseSessionStreamCursor',
  'commitSessionStreamEventDirect',
  'createSessionStreamCursorGate',
  'deferSessionStreamEvent',
  'failSessionStreamEvent',
  'commitSessionStreamEvent',
  'applyActivityEvent',
]) {
  vm.runInContext(extractFunction(name), context, { filename: `${name}.js` });
}

const resetRecoveryContext = vm.createContext({
  state: { fullTranscriptLoaded: new Set(['host-a::history']) },
  getSessionKey: (value) => `${value?.hostId || ''}::${value?.sessionId || ''}`,
});
vm.runInContext(extractFunction('sessionStreamResetNeedsDetailRecovery'), resetRecoveryContext);
assert.strictEqual(
  resetRecoveryContext.sessionStreamResetNeedsDetailRecovery({
    hostId: 'host-a',
    sessionId: 'history',
    live: false,
  }),
  false,
  'a fully loaded history Session must not trigger detail recovery after every reset'
);
assert.strictEqual(
  resetRecoveryContext.sessionStreamResetNeedsDetailRecovery({
    hostId: 'host-a',
    sessionId: 'live',
    live: true,
  }),
  true,
  'a live Session must still trigger authoritative detail recovery'
);
assert.strictEqual(
  resetRecoveryContext.sessionStreamResetNeedsDetailRecovery({
    hostId: 'host-a',
    sessionId: 'partial',
    live: false,
  }),
  true,
  'an incomplete history Session must still trigger detail recovery'
);

const session = { hostId: 'host-a', sessionId: 'session-a' };
const event = { lastEventId: 'epoch-a:1' };
const payload = {
  canonicalConversationKey: 'host-a::session-a',
  streamEpoch: 'epoch-a',
  activityKey: 'activity-a',
  activityRevision: 1,
};

assert.strictEqual(
  context.applyActivityEvent(session, event, payload),
  false,
  'a rejected activity must report failure'
);
assert.strictEqual(
  context.state.eventCursorByCanonical.has('host-a::session-a'),
  false,
  'a rejected activity must not consume its SSE cursor'
);

context.state.activityProjection.applyActivity = () => true;
assert.strictEqual(
  context.applyActivityEvent(session, event, payload),
  true,
  'an accepted activity must report success'
);
assert.strictEqual(
  context.state.eventCursorByCanonical.get('host-a::session-a'),
  'epoch-a:1',
  'an accepted activity must commit its SSE cursor'
);

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

// Relay replay can legitimately deliver the same activity revision, or an
// older revision, after the projection already contains a newer copy. The
// projection reports those no-op writes as false, but the SSE event was still
// consumed successfully: its cursor must advance and the gate must not enter
// its reconnect/failure path.
const replaySource = new FakeEventSource();
const replayCanonicalKey = 'host-a::session-replay';
context.state.sessionStreamGeneration = 1;
context.state.eventSource = replaySource;
context.state.eventSourceKey = 'host-a::session-a';
context.state.activityProjection.applyActivity = () => false;
context.state.activityProjection.activitiesFor = () => [{
  activityKey: 'activity-a',
  activityRevision: 2,
}];
let replayReconnects = 0;
const replayGate = context.createSessionStreamCursorGate(
  session,
  replaySource,
  'host-a::session-a',
  1,
  { onFailure: () => { replayReconnects += 1; } },
);
replayGate.listen('session.activity', (replayEvent) => (
  context.applyActivityEvent(session, replayEvent, JSON.parse(replayEvent.data))
));

replaySource.emit('session.activity', {
  lastEventId: 'epoch-a:2',
  data: JSON.stringify({
    ...payload,
    canonicalConversationKey: replayCanonicalKey,
    activityRevision: 2,
  }),
});
assert.strictEqual(replayReconnects, 0, 'a duplicate revision must not request an SSE reconnect');
assert.strictEqual(replayGate.blocked, false, 'a duplicate revision must not block the SSE gate');
assert.strictEqual(replayGate.pendingCount, 0, 'a duplicate revision must leave no pending gate record');
assert.strictEqual(
  context.state.eventCursorByCanonical.get(replayCanonicalKey),
  'epoch-a:2',
  'a duplicate revision must still advance the durable SSE cursor'
);

replaySource.emit('session.activity', {
  lastEventId: 'epoch-a:3',
  data: JSON.stringify({
    ...payload,
    canonicalConversationKey: replayCanonicalKey,
    activityRevision: 1,
  }),
});
assert.strictEqual(replayReconnects, 0, 'an older revision must not request an SSE reconnect');
assert.strictEqual(replayGate.blocked, false, 'an older revision must not block the SSE gate');
assert.strictEqual(replayGate.pendingCount, 0, 'an older revision must leave no pending gate record');
assert.strictEqual(
  context.state.eventCursorByCanonical.get(replayCanonicalKey),
  'epoch-a:3',
  'an older revision must still advance the durable SSE cursor'
);

const source = new FakeEventSource();
context.state.sessionStreamGeneration = 1;
context.state.eventSource = source;
context.state.eventSourceKey = 'host-a::session-a';

const gate = context.createSessionStreamCursorGate(
  session,
  source,
  'host-a::session-a',
  1,
  { onFailure: () => {} },
);

let releaseCurrent;
const currentPayload = {
  canonicalConversationKey: 'host-a::session-a',
  streamEpoch: 'epoch-a',
  activityKey: 'activity-current',
  activityRevision: 2,
};
gate.listen('async-current', (currentEvent) => {
  assert.strictEqual(
    context.deferSessionStreamEvent(currentEvent),
    true,
    'the current async event should be deferrable'
  );
  return {
    then(resolve) {
      releaseCurrent = () => {
        assert.strictEqual(
          context.commitSessionStreamEvent(session, currentEvent, currentPayload),
          true,
          'a current async event should commit successfully'
        );
        resolve(true);
      };
    },
  };
});
source.emit('async-current', { lastEventId: 'epoch-a:2' });
assert.strictEqual(gate.pendingCount, 1, 'deferred event should remain pending until recovery completes');
releaseCurrent();
assert.strictEqual(gate.pendingCount, 0, 'committed deferred event should leave the ordering queue');
assert.strictEqual(
  context.state.eventCursorByCanonical.get('host-a::session-a'),
  'epoch-a:2',
  'current async event should advance the cursor'
);

let releaseStale;
const stalePayload = {
  canonicalConversationKey: 'host-a::session-a',
  streamEpoch: 'epoch-a',
  activityKey: 'activity-stale',
  activityRevision: 3,
};
gate.listen('async-stale', (staleEvent) => {
  assert.strictEqual(context.deferSessionStreamEvent(staleEvent), true);
  return {
    then(resolve) {
      releaseStale = () => {
        assert.strictEqual(
          context.commitSessionStreamEvent(session, staleEvent, stalePayload),
          false,
          'a late callback from a replaced EventSource must be rejected'
        );
        resolve(true);
      };
    },
  };
});
source.emit('async-stale', { lastEventId: 'epoch-a:3' });
assert.strictEqual(gate.pendingCount, 1, 'stale async event should initially be pending');
context.state.sessionStreamGeneration = 2;
context.state.eventSource = new FakeEventSource();
context.state.eventSourceKey = 'host-a::session-a';
releaseStale();
assert.strictEqual(
  gate.pendingCount,
  0,
  'late async completion must release its stale ordering record'
);
assert.strictEqual(
  context.state.eventCursorByCanonical.get('host-a::session-a'),
  'epoch-a:2',
  'late async completion must not advance the new stream cursor'
);

// A recovery task may commit directly after the source was replaced rather
// than resolving a Promise owned by the SSE listener.
context.state.sessionStreamGeneration = 1;
context.state.eventSource = source;
context.state.eventSourceKey = 'host-a::session-a';
let deferredEvent;
gate.listen('deferred-recovery', (event) => {
  deferredEvent = event;
  assert.strictEqual(context.deferSessionStreamEvent(event), true);
  return true;
});
source.emit('deferred-recovery', { lastEventId: 'epoch-a:4' });
assert.strictEqual(gate.pendingCount, 1, 'deferred recovery event should be pending');
context.state.sessionStreamGeneration = 3;
context.state.eventSource = new FakeEventSource();
assert.strictEqual(
  context.commitSessionStreamEvent(session, deferredEvent, {
    canonicalConversationKey: 'host-a::session-a',
    streamEpoch: 'epoch-a',
    activityKey: 'activity-recovery',
    activityRevision: 4,
  }),
  false,
  'a recovery task from an old source must not commit'
);
assert.strictEqual(gate.pendingCount, 0, 'stale recovery completion must release its record');

console.log('session SSE cursor commit assertions passed');
