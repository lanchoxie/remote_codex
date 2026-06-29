const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const html = fs.readFileSync('apps/mobile-web/public/index.html', 'utf8');
const styles = fs.readFileSync('apps/mobile-web/public/styles.css', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

assertContains(
  app,
  "const MESSAGE_READ_RECEIPTS_STORAGE_KEY = 'mobile-codex-remote.message-read-receipts.v1'",
  'message notifications should persist per-browser read receipts without touching relay session data'
);
assertContains(
  app,
  'messageReadReceipts: new Map()',
  'state should track message read receipts separately from thinking unread state'
);
assertContains(
  app,
  'messageNotificationOpen: false',
  'state should track whether the message notification panel is open'
);
assertContains(
  app,
  'function getLatestAssistantMessageMarker',
  'message unread logic should use formal assistant/agent transcript messages'
);
assertContains(
  app,
  "entry.speaker === 'agent' || entry.speaker === 'assistant'",
  'assistant marker logic should ignore user messages and thinking diagnostics'
);
assertContains(
  app,
  'function updateMessageUnreadForSession',
  'incoming transcript/session changes should update message unread state'
);
assertContains(
  app,
  'function markSessionMessagesRead',
  'selecting or opening a session should mark formal messages as read'
);
assertContains(
  app,
  'function markAllMessageNotificationsRead',
  'notification panel should support one-click mark-all-read'
);
assertContains(
  app,
  'function getUnreadMessageNotifications',
  'bell UI should be driven from computed unread message sessions'
);
assertContains(
  app,
  'if (state.messageReadReceipts.size > 0) {',
  'initialization should not auto-mark later sessions read once this browser already has read receipts'
);
assertContains(
  app,
  'function renderMessageNotificationBell',
  'UI should render the message bell from unread message state'
);
assertContains(
  app,
  'renderMessageNotificationBell();',
  'global rendering should refresh the message bell'
);
assertContains(
  app,
  "item.className = `conversation-card ${group.liveCount > 0 ? 'live' : 'history'} ${hasUnreadMessagesForGroup(group) ? 'message-unread' : ''}",
  'conversation cards should show a red unread dot when any grouped session has unread formal messages'
);
assertContains(
  app,
  'markSessionMessagesRead(session);',
  'session selection/open should clear unread formal message notifications'
);
assertContains(
  app,
  'markSessionMessageNotificationChanged(payload.hostId || session.hostId, payload.sessionId || session.sessionId);',
  'session transcript SSE should update formal message notifications'
);
assertContains(
  app,
  'markSessionMessageNotificationChanged(payload.hostId || session.hostId, payload.sessionId || session.sessionId);',
  'session transcript SSE should refresh both the bell and sidebar unread dot when assistant messages arrive'
);
assertContains(
  app,
  'markSessionMessageNotificationChanged(payload.hostId || session.hostId, payload.sessionId || session.sessionId);',
  'session snapshot/state events should update unread state from latest assistant summary messages'
);
assertContains(
  app,
  'queuedUiRenders.conversationNav = true',
  'queued UI flush should be able to redraw sidebar unread dots without rendering every selected view'
);
assertContains(
  app,
  'if (payload.speaker === \'agent\' || payload.speaker === \'assistant\')',
  'transcript SSE should only treat assistant/agent entries as formal message notification candidates'
);
assertContains(
  app,
  'persistMessageReadReceipts();',
  'read receipts should be saved in localStorage'
);

assertContains(
  html,
  'id="message-notification-button"',
  'header should expose a clickable message notification bell'
);
assertContains(
  html,
  'id="message-notification-panel"',
  'page should include a message notification panel'
);
assertContains(
  html,
  'id="mark-all-message-notifications-read-button"',
  'message notification panel should include mark-all-read'
);

assertContains(
  styles,
  '.conversation-card.message-unread::after',
  'conversation cards should draw a red unread message dot'
);
assertContains(
  styles,
  '.conversation-live-dot',
  'live conversation cards should show a small green live indicator instead of changing the whole card color'
);
assertContains(
  styles,
  'animation: live-session-pulse',
  'live indicator should softly pulse so live sessions are easy to spot'
);
assertContains(
  styles,
  '.message-notification-button.has-unread',
  'bell should become visually yellow when unread messages exist'
);
assertContains(
  styles,
  '.message-notification-panel',
  'bell should open a dedicated notification panel'
);

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
const storage = new Map();
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
  crypto: { randomUUID: () => 'test-uuid' },
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  },
  matchMedia: () => ({ matches: false }),
  setTimeout: sandbox.setTimeout,
  clearTimeout: sandbox.clearTimeout,
  setInterval: sandbox.setInterval,
  clearInterval: sandbox.clearInterval,
  requestAnimationFrame: (fn) => fn(),
  addEventListener() {},
  location: { origin: 'http://127.0.0.1:8797', search: '' },
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
window.__messageNotificationTest = {
  state,
  makeSessionKey,
  setTranscriptForSession,
  appendTranscriptEntry,
  updateMessageUnreadForSession,
  markSessionMessagesRead,
  getUnreadMessageNotifications,
};
`;

vm.createContext(sandbox);
vm.runInContext(`${app}\n${testHook}`, sandbox, {
  filename: path.join(process.cwd(), 'apps', 'mobile-web', 'public', 'app.js'),
});

const api = sandbox.window.__messageNotificationTest;
api.state.hosts = [{ hostId: 'win', label: 'Windows', platform: 'win32', online: true }];
api.state.sessions = [{
  hostId: 'win',
  sessionId: 's1',
  conversationKey: 'c1',
  title: 'Active work',
  live: true,
  lastUpdatedAt: '2026-06-29T01:00:00Z',
  latestAgentMessage: '',
}];

api.appendTranscriptEntry('win', 's1', { speaker: 'user', text: 'hello', timestamp: '2026-06-29T01:00:01Z' });
api.updateMessageUnreadForSession('win', 's1');
assert.strictEqual(api.getUnreadMessageNotifications().length, 0, 'user messages should not trigger message notifications');

api.state.diagnostics.set(api.makeSessionKey('win', 's1'), [{ kind: 'reasoning', message: 'thinking update' }]);
api.updateMessageUnreadForSession('win', 's1');
assert.strictEqual(api.getUnreadMessageNotifications().length, 0, 'thinking diagnostics should not trigger message notifications');

api.appendTranscriptEntry('win', 's1', { speaker: 'assistant', text: 'done', timestamp: '2026-06-29T01:00:02Z' });
api.updateMessageUnreadForSession('win', 's1');
assert.strictEqual(api.getUnreadMessageNotifications().length, 1, 'assistant messages should trigger unread message notifications');

api.markSessionMessagesRead(api.state.sessions[0]);
assert.strictEqual(api.getUnreadMessageNotifications().length, 0, 'marking the session read should remove it from the bell list');
assert(storage.has('mobile-codex-remote.message-read-receipts.v1'), 'read receipts should be persisted to localStorage');

console.log('session message notification assertions passed');
