const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(path.join(__dirname, '../apps/mobile-web/public/app.js'), 'utf8');
const start = app.indexOf('  if (focus) {', app.indexOf('  reconcileTranscriptChildren(log, descriptors'));
const end = app.indexOf('  } else if (shouldStickToBottom)', start);
assert(start >= 0 && end > start, 'exercise the actual renderTranscript delayed focus branch');
const branch = app.slice(start, end) + '\n  }';

function fixture() {
  const callbacks = [], calls = [];
  const focus = { hostId: 'host-a', sessionId: 'session-a', entryIndex: 4 };
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  const mark = { scrollIntoView: options => calls.push(['fallback', options]) };
  const target = { querySelector: () => mark };
  const owner = {};
  const machine = {
    beginTrustedInteraction: () => calls.push(['invalidate-old-restore']),
    withProgrammaticScroll: apply => { calls.push(['programmatic']); apply(); },
  };
  const context = vm.createContext({
    focus, key: 'host-a::session-a', selected: session, session, loading: false,
    state: { sessionSearchQuery: 'needle', pendingTranscriptFocus: focus },
    log: { dataset: { sessionKey: 'host-a::session-a' }, querySelector: () => target },
    getSelectedSession: () => context.selected,
    isHistoryLoading: () => context.loading,
    getSessionKey: value => value ? `${value.hostId}::${value.sessionId}` : '',
    getTranscriptScrollOwner: () => owner,
    getTranscriptScrollMachine: () => machine,
    setTranscriptUserDetached: (...args) => calls.push(['detach', ...args]),
    noteMessageReadProgrammaticScroll: () => calls.push(['read-scroll-guard']),
    window: {
      setTimeout: (callback, delay) => { assert.equal(delay, 80); callbacks.push(callback); },
      RemoteCodexSessionSearch: { centerHighlight: (node, scrollOwner) => {
        assert.strictEqual(node, target); assert.strictEqual(scrollOwner, owner);
        calls.push(['center']); return true;
      } },
    },
  });
  const schedule = () => vm.runInContext(branch, context);
  schedule();
  return { callbacks, calls, context, schedule, focus };
}

for (const [name, invalidate] of [
  ['selected session', c => { c.selected = { hostId: 'host-a', sessionId: 'session-b' }; }],
  ['selected host', c => { c.selected = { hostId: 'host-b', sessionId: 'session-a' }; }],
  ['closed selection', c => { c.selected = null; }],
  ['rendered session', c => { c.log.dataset.sessionKey = 'host-a::session-b'; }],
  ['query changed', c => { c.state.sessionSearchQuery = 'different'; }],
  ['new match clicked', c => { c.state.pendingTranscriptFocus = { ...c.focus }; }],
  ['search cleared', c => { c.state.pendingTranscriptFocus = null; }],
]) {
  const f = fixture(); invalidate(f.context); f.callbacks[0]();
  assert.deepEqual(f.calls, [], `${name} must fence a stale timer`);
}
{
  const f = fixture(); f.context.loading = true; f.callbacks[0]();
  assert.deepEqual(f.calls, [], 'cached preview must wait for pending full history before consuming focus');
  assert.strictEqual(f.context.state.pendingTranscriptFocus, f.focus);
  f.context.loading = false; f.schedule(); f.callbacks[1]();
  assert.equal(f.calls.filter(call => call[0] === 'center').length, 1, 'detail render consumes the retained focus exactly once');
}
{
  const f = fixture(); f.schedule();
  f.callbacks.forEach(callback => callback());
  assert.deepEqual(f.calls.map(call => call[0]), ['detach', 'invalidate-old-restore', 'read-scroll-guard', 'programmatic', 'center']);
  assert.strictEqual(f.context.state.pendingTranscriptFocus, null);
  assert.equal(f.calls.filter(call => call[0] === 'center').length, 1, 'a render during the delay cannot focus twice');
}
{
  const f = fixture(); f.context.log.querySelector = () => null; f.callbacks[0]();
  assert.deepEqual(f.calls, []);
  assert.strictEqual(f.context.state.pendingTranscriptFocus, f.focus, 'unloaded target remains pending for its next render');
}
{
  const f = fixture(); f.context.window.RemoteCodexSessionSearch = null; f.callbacks[0]();
  assert.equal(f.calls.at(-1)[0], 'fallback', 'mixed-cache module loading still has a safe word-based fallback');
}
async function testDelayedShowSessionDetail() {
  const f = fixture(), c = f.context;
  f.callbacks.length = 0;
  let resolveDetail;
  const detailPromise = new Promise(resolve => { resolveDetail = resolve; });
  const noops = ['assertSessionAsyncFenceCurrent', 'renderSessionDetails', 'renderRuntimePanel',
    'renderThinkingPanel', 'touchSessionCacheKey', 'subscribeSession', 'setAlertsForSession',
    'setRuntimeForSession', 'mergeDiagnosticsForSession', 'setRequestsForSession',
    'renderAlertsWindow', 'renderStatusWindow', 'renderApprovalPopup'];
  for (const name of noops) c[name] = () => {};
  Object.assign(c, {
    URLSearchParams,
    createSessionAsyncFence: () => ({ allowSession() {}, isCurrent: () => true }),
    shouldLoadSessionRuntimeConfigOnOpen: () => false,
    setHistoryLoading: (_session, loading) => { c.loading = loading; },
    watchSelectedSession: async () => {},
    shouldFetchSessionDetailOnOpen: () => true,
    getRequestApplyGeneration: () => 0, getRuntimeStreamGeneration: () => 0,
    getRuntimeApplyGeneration: () => 0,
    fetchSharedSessionDetail: () => detailPromise,
    mergeSession: session => session,
    makeSessionKey: (host, session) => `${host}::${session}`,
    getTranscriptForSession: () => [], dedupeTranscript: entries => entries,
    reconcileDetailTranscriptForSession: (_host, _session, entries) => entries,
    setTranscriptForSession: (_host, _session, entries) => { c.layoutSize = entries.length; },
    getRuntimeForSession: () => null, getDiagnosticsForSession: () => [],
    loadReceivedFilesForSession: async () => [],
    isStaleStreamRecoveryError: () => false,
    reportError: error => { throw error; },
    appendAlertForSession: (_host, _session, alert) => { throw new Error(alert.message); },
    layoutSize: 2,
  });
  Object.assign(c.state, { fullTranscriptLoaded: new Set(), messageReadRenderReady: new Set(),
    runtime: new Map(), requests: new Map(), sessionStreamGeneration: 1 });
  const focusStart = app.indexOf('  const focus =', app.indexOf('function renderTranscript('));
  const focusEnd = app.indexOf('\n  const searchMatches', focusStart);
  const focusSource = app.slice(focusStart, focusEnd);
  // Run the actual showSession function, its actual focus selection and delayed
  // render branch. Unrelated domain/rendering helpers use synthetic state only.
  vm.runInContext(`function renderTranscript(session, options = {}) {
    ${focusSource}
    ${branch}
  }`, c);
  const showStart = app.indexOf('async function showSession(');
  const showEnd = app.indexOf('\n}\n', showStart) + 2;
  vm.runInContext(app.slice(showStart, showEnd), c);
  const centeredLayouts = [];
  c.window.RemoteCodexSessionSearch.centerHighlight = () => { centeredLayouts.push(c.layoutSize); return true; };
  const opening = c.showSession(c.session, { full: true, focus: f.focus, throwOnError: true });
  assert.equal(c.loading, true);
  assert.equal(f.callbacks.length, 1, 'preview render should queue one guarded callback');
  f.callbacks.shift()(); // Simulate a detail response that takes longer than 80ms.
  assert.deepEqual(centeredLayouts, [], 'preview indices must not consume the target');
  assert.strictEqual(c.state.pendingTranscriptFocus, f.focus);
  resolveDetail({ session: { ...c.session, messageCount: 120 }, transcript: Array.from({length:120},()=>({})), remoteDetail: { fullTranscript: true } });
  await opening;
  assert.equal(c.loading, false);
  f.callbacks.splice(0).forEach(callback => callback());
  assert.deepEqual(centeredLayouts, [120], 'final geometry is centered exactly once after full history is installed');
  c.renderTranscript(c.session, { focus: f.focus });
  assert.equal(f.callbacks.length, 0, 'consumed options.focus must not suppress normal scroll restoration');
}
testDelayedShowSessionDetail().then(() => {
  console.log('search focus: delayed showSession detail, stale Session/Host/query/match fencing, one-shot centering and scroll/read guards passed');
}).catch(error => { console.error(error); process.exitCode = 1; });
