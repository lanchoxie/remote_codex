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
window.__sidebarLiveTest = {
  state,
  getConversationGroups,
  sortConversationGroups,
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

assert.ok(
  source.includes("group.liveCount > 0 ? 'live' : 'history'"),
  'conversation card class should distinguish live and history groups'
);
assert.ok(
  styles.includes('.conversation-card.live'),
  'styles should give live conversation cards a distinct class'
);
assert.ok(
  styles.includes('.conversation-live-dot'),
  'live conversation card should show a small green live indicator'
);
assert.ok(
  styles.includes('live-session-pulse'),
  'live conversation indicator should pulse subtly'
);

console.log('session sidebar live assertions passed');
