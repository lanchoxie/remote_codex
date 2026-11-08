const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appPath = path.join(ROOT, 'apps', 'mobile-web', 'public', 'app.js');
const stylesPath = path.join(ROOT, 'apps', 'mobile-web', 'public', 'styles.css');
const source = fs.readFileSync(appPath, 'utf8');
const styles = fs.readFileSync(stylesPath, 'utf8');

class ElementStub {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.innerHTML = '';
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.classList = {
      toggle: () => {},
      add: () => {},
      remove: () => {},
      contains: () => false,
    };
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  remove() {
    this.removed = true;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }
}

const elements = new Map();
const sandbox = {
  console,
  URL,
  URLSearchParams,
  Date,
  Map,
  Set,
  Array,
  Number,
  String,
  Boolean,
  RegExp,
  Buffer,
  Blob,
  File: typeof File === 'function' ? File : undefined,
  setTimeout() {
    return 0;
  },
  clearTimeout() {},
  setInterval() {
    return 0;
  },
  clearInterval() {},
};

sandbox.document = {
  body: new ElementStub('body'),
  documentElement: new ElementStub('html'),
  activeElement: null,
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, new ElementStub(id));
    }
    return elements.get(id);
  },
  createElement(tag) {
    return new ElementStub(tag);
  },
  createTextNode(text) {
    return { textContent: text };
  },
  createDocumentFragment() {
    return new ElementStub('fragment');
  },
  createTreeWalker() {
    return { nextNode: () => null };
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener() {},
};
sandbox.document.body.appendChild = (child) => child;
sandbox.NodeFilter = { SHOW_TEXT: 4 };
sandbox.window = {
  RemoteCodexSessionModal: require('../apps/mobile-web/public/session-modal-controller'),
  RemoteCodexSessionRuntimeState: require('../apps/mobile-web/public/session-runtime-state'),
  crypto: { randomUUID: () => 'test-uuid' },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
  matchMedia: () => ({ matches: false }),
  setTimeout: sandbox.setTimeout,
  clearTimeout: sandbox.clearTimeout,
  setInterval: sandbox.setInterval,
  clearInterval: sandbox.clearInterval,
  requestAnimationFrame: (fn) => fn(),
  addEventListener() {},
  location: { origin: 'http://127.0.0.1:8897', search: '' },
  alert: () => {},
  confirm: () => true,
  prompt: () => '',
};
sandbox.navigator = { userAgent: 'node' };
sandbox.fetch = async () => ({
  ok: true,
  json: async () => ({}),
  text: async () => '',
});

const testHook = `
window.__sidebarLiveTest = {
  state,
  getConversationGroups,
  sortConversationGroups,
  deriveConversationRuntimeIndicator,
  runtimeIsActive,
  runtimeIssuePresentation,
  setRuntimeForSession,
};
`;

vm.createContext(sandbox);
vm.runInContext(`${source}\n${testHook}`, sandbox, { filename: appPath });

const api = sandbox.window.__sidebarLiveTest;
api.state.hosts = [{ hostId: 'win', label: 'Windows', platform: 'win32', online: true }];
api.state.selectedHostId = 'win';
api.state.sessionSortBy = 'updatedAt';
api.state.sessionSortDir = 'desc';
api.state.sessionCollections = [{ collectionId: 'default', name: 'Default', items: [] }];
api.state.sessions = [
  {
    hostId: 'win',
    sessionId: 'history-newer',
    conversationKey: 'history-newer',
    title: 'Newer history',
    live: false,
    createdAt: '2026-06-28T00:00:00Z',
    lastUpdatedAt: '2026-06-29T03:00:00Z',
    messageCount: 5,
  },
  {
    hostId: 'win',
    sessionId: 'live-older',
    conversationKey: 'live-older',
    title: 'Older live',
    live: true,
    createdAt: '2026-06-27T00:00:00Z',
    lastUpdatedAt: '2026-06-27T03:00:00Z',
    messageCount: 2,
  },
  {
    hostId: 'win',
    sessionId: 'history-older',
    conversationKey: 'history-older',
    title: 'Older history',
    live: false,
    createdAt: '2026-06-26T00:00:00Z',
    lastUpdatedAt: '2026-06-27T01:00:00Z',
    messageCount: 1,
  },
];

const sorted = api.sortConversationGroups(api.getConversationGroups('win'));
assert.deepStrictEqual(
  Array.from(sorted.map((group) => group.conversationKey)),
  ['live-older', 'history-newer', 'history-older'],
  'live conversations should be grouped before non-live conversations, then keep the selected sort order'
);

api.state.sessions = [
  {
    hostId: 'win',
    sessionId: 'replacement-live',
    conversationKey: 'shared-conversation',
    source: 'managed',
    state: 'running',
    live: true,
    messageCount: 0,
  },
  {
    hostId: 'win',
    sessionId: 'stale-starting-shell',
    conversationKey: 'shared-conversation',
    source: 'managed',
    state: 'starting',
    live: false,
    messageCount: 0,
    transcriptPreview: [],
  },
  {
    hostId: 'win',
    sessionId: 'empty-history',
    conversationKey: 'shared-conversation',
    source: 'managed',
    state: 'history-only',
    live: false,
    messageCount: 0,
  },
  {
    hostId: 'win',
    sessionId: 'starting-with-message',
    conversationKey: 'shared-conversation',
    source: 'managed',
    state: 'starting',
    live: false,
    messageCount: 1,
  },
  {
    hostId: 'win',
    sessionId: 'starting-without-live-peer',
    conversationKey: 'standalone-starting',
    source: 'managed',
    state: 'starting',
    live: false,
    messageCount: 0,
  },
];

const variantGroups = api.getConversationGroups('win');
const sharedGroup = variantGroups.find((group) => group.conversationKey === 'shared-conversation');
assert(sharedGroup, 'shared managed conversation should remain visible');
assert.deepStrictEqual(
  Array.from(sharedGroup.sessions.map((session) => session.sessionId).sort()),
  ['empty-history', 'replacement-live', 'starting-with-message'],
  'a live managed replacement should hide only its empty non-live starting shell'
);
assert.strictEqual(sharedGroup.totalCount, 3, 'hidden starting shells must not inflate the visible variant count');
assert.strictEqual(sharedGroup.messageCount, 1, 'visible variant messages should still contribute to the group count');

const standaloneStarting = variantGroups.find((group) => group.conversationKey === 'standalone-starting');
assert.strictEqual(
  standaloneStarting?.sessions?.[0]?.sessionId,
  'starting-without-live-peer',
  'an empty starting Session without a live managed peer must stay visible'
);

assert.ok(
  source.includes('const runtimeIndicator = deriveConversationRuntimeIndicator(group);'),
  'conversation cards should derive an explicit runtime indicator'
);
assert.ok(
  styles.includes('.conversation-card.live-idle'),
  'styles should distinguish idle live conversation cards'
);
assert.ok(
  styles.includes('.conversation-runtime-dot.runtime-active'),
  'active live conversations should expose a yellow runtime indicator'
);
assert.ok(
  styles.includes('live-session-pulse'),
  'only active runtime indicators should pulse subtly'
);
assert.ok(
  styles.includes('.conversation-unread-button::before'),
  'unread replies should remain a separate clickable indicator'
);
assert.ok(
  /\.conversation-unread-button\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s.test(styles),
  'the unread indicator button should center a rendered dot'
);
assert.ok(
  /\.conversation-unread-button::before\s*\{[^}]*display:\s*block;[^}]*width:\s*9px;[^}]*height:\s*9px;/s.test(styles),
  'the unread pseudo-element should occupy visible space'
);
assert.ok(
  styles.includes('@media (prefers-reduced-motion: reduce)'),
  'the active runtime pulse should respect reduced-motion preferences'
);
assert.ok(
  source.includes("runtimeDot.setAttribute('aria-label', runtimeIndicator.label)"),
  'runtime indicators should expose their state to assistive technology'
);
assert.ok(
  /queuedUiRenders\.conversationNav = true;\s*scheduleRuntimeStatusRender\(\);/.test(source),
  'runtime SSE updates should refresh the sidebar indicator in the same render batch'
);

const historyIndicator = api.deriveConversationRuntimeIndicator({ sessions: [{
  hostId: 'win', sessionId: 'indicator-history', live: false, state: 'history-only',
}] });
assert.deepStrictEqual(
  { ...historyIndicator },
  { tone: 'history', label: 'History or offline' }
);

const idleLive = {
  hostId: 'win', sessionId: 'indicator-live', live: true, runId: 'run-live', state: 'running',
};
api.state.runtime.set('win::indicator-live', {
  runId: 'run-live', phase: 'idle', busy: false, activeTurnId: null,
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [idleLive] }) },
  { tone: 'live-idle', label: 'Live session idle' }
);

api.state.runtime.set('win::indicator-live', {
  runId: 'run-live', phase: 'thinking', busy: true, activeTurnId: 'turn-live',
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [idleLive] }) },
  { tone: 'runtime-active', label: 'Session running' }
);

api.state.runtime.set('win::indicator-live', {
  runId: 'stale-run', phase: 'thinking', busy: true, activeTurnId: 'stale-turn',
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [idleLive] }) },
  { tone: 'live-idle', label: 'Live session idle' },
  'runtime state from a superseded run must not turn the live indicator yellow'
);

api.state.runtime.set('win::indicator-live', {
  phase: 'thinking', busy: true, activeTurnId: 'runless-stale-turn',
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [idleLive] }) },
  { tone: 'live-idle', label: 'Live session idle' },
  'a runless runtime snapshot must not turn a known live Run yellow'
);

const runlessLive = {
  hostId: 'win', sessionId: 'indicator-runless-live', live: true, state: 'running',
};
api.state.runtime.set('win::indicator-runless-live', {
  runId: 'unbound-runtime-run', phase: 'thinking', busy: true, activeTurnId: 'unbound-turn',
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [runlessLive] }) },
  { tone: 'live-idle', label: 'Live session idle' },
  'a runtime Run must not claim a live Session whose current Run identity is unknown'
);

api.state.runtime.set('win::indicator-runless-live', {
  phase: 'thinking', busy: true, activeTurnId: 'legacy-turn',
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [runlessLive] }) },
  { tone: 'runtime-active', label: 'Session running' },
  'legacy runless live/runtime projections should remain compatible when neither side has a Run identity'
);

const pendingReplacementLive = {
  hostId: 'win',
  sessionId: 'indicator-pending-replacement',
  live: true,
  runId: 'run-live-parent',
  activeRunId: 'run-pending-child',
  runtimeConfig: { runId: 'run-live-parent', activeRunId: 'run-pending-child' },
};
api.state.runtime.set('win::indicator-pending-replacement', {
  runId: 'run-live-parent', phase: 'thinking', busy: true, activeTurnId: 'turn-live-parent',
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [pendingReplacementLive] }) },
  { tone: 'runtime-active', label: 'Session running' },
  'a pending child Run must not hide active runtime state from the still-live parent Run'
);
api.state.runtime.set('win::indicator-pending-replacement', {
  phase: 'thinking', busy: true, activeTurnId: 'unscoped-stale-turn',
});
assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [pendingReplacementLive] }) },
  { tone: 'live-idle', label: 'Live session idle' },
  'a Session with a known live Run must reject active runtime state that has no Run identity'
);

assert.deepStrictEqual(
  { ...api.deriveConversationRuntimeIndicator({ sessions: [{
    hostId: 'win', sessionId: 'indicator-starting', live: false, state: 'starting',
  }] }) },
  { tone: 'history', label: 'History or offline' }
);

api.state.sessionLaunchBusy.set('pending-start', {
  hostId: 'win', sessionId: 'indicator-starting', sessionKey: 'win::indicator-starting',
});
assert.strictEqual(api.deriveConversationRuntimeIndicator({ sessions: [{
  hostId: 'win', sessionId: 'indicator-starting', live: false, state: 'starting',
}] }).tone, 'runtime-active', 'a real launch receipt must remain visible');
api.state.sessionLaunchBusy.clear();

for (const runtime of [
  { phase: 'completed', busy: true, activeTurnId: 'stale' },
  { phase: 'closed', busy: true, activeTurnId: 'stale' },
  { phase: 'error', currentTurnStatus: 'failed', busy: true, activeTurnId: 'stale' },
]) {
  api.state.runtime.set('win::indicator-live', { ...runtime, runId: 'run-live' });
  assert.strictEqual(api.deriveConversationRuntimeIndicator({ sessions: [idleLive] }).tone, 'live-idle');
}
api.state.runtime.set('win::indicator-live', { phase: 'running', currentTurnStatus: 'completed', busy: true, activeTurnId: 'stale', runId: 'run-live' });
assert.strictEqual(api.deriveConversationRuntimeIndicator({ sessions: [idleLive] }).tone, 'runtime-active');
for (const phase of ['reviewing', 'compacting', 'running-shell-command', 'submitting-turn', 'terminal-settling', 'runtime-unknown']) {
  const runtime = { phase, currentTurnStatus: 'completed', busy: true, runId: 'run-live' };
  api.state.runtime.set('win::indicator-live', runtime);
  assert.strictEqual(api.deriveConversationRuntimeIndicator({ sessions: [idleLive] }).tone, 'runtime-active', phase);
}
api.setRuntimeForSession('win', 'merge-test', {
  runId: 'merge-run', runtimeRevision: 1, phase: 'thinking', busy: true,
  activeTurnId: 'turn-1', waitingOnApproval: true,
});
const completed = api.setRuntimeForSession('win', 'merge-test', {
  runId: 'merge-run', runtimeRevision: 2, phase: 'completed', busy: false,
});
assert.strictEqual(completed.activeTurnId, null);
assert.strictEqual(completed.waitingOnApproval, false);
assert.strictEqual(api.runtimeIsActive(completed), false);
assert.strictEqual(api.setRuntimeForSession('win', 'merge-test', {
  runId: 'merge-run', runtimeRevision: 1, phase: 'thinking', busy: true,
}).runtimeRevision, 2, 'late active patches must not reopen a completed runtime');

console.log('session sidebar live assertions passed');
