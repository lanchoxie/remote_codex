const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appPath = path.join(ROOT, 'apps', 'mobile-web', 'public', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');

class ElementStub {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.indeterminate = false;
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

  remove() {
    this.removed = true;
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
sandbox.fetch = async (url) => {
  if (url === '/api/auth/config') {
    return {
      ok: true,
      json: async () => ({ authRequired: false, authenticated: true }),
    };
  }
  if (url === '/api/hosts') {
    return {
      ok: true,
      json: async () => ({ hosts: [] }),
    };
  }
  return {
    ok: true,
    json: async () => ({}),
    text: async () => '',
  };
};

const testHook = `
window.__historyImportTest = {
  state,
  openHistoryImportDialog,
  getHistoryImportCandidateGroups,
  setHistoryImportSort,
  setHistoryImportSearch,
  toggleHistoryImportCollection,
};
`;

vm.createContext(sandbox);
vm.runInContext(`${source}\n${testHook}`, sandbox, { filename: appPath });

const api = sandbox.window.__historyImportTest;
const plainArray = (value) => Array.from(value || []);
api.state.hosts = [{ hostId: 'win', label: 'Windows', platform: 'win32', online: true }];
api.state.selectedHostId = 'win';
api.state.selectedCollectionId = 'alpha';
api.state.selectedConversationKey = 'current';
api.state.selectedSessionId = 'current';

api.state.sessions = [
  { hostId: 'win', sessionId: 'current', conversationKey: 'current', title: 'Current', createdAt: '2026-01-01T00:00:00Z', lastUpdatedAt: '2026-01-02T00:00:00Z', messageCount: 1 },
  { hostId: 'win', sessionId: 's1', conversationKey: 'c1', title: 'Alpha only', cwd: 'D:/a', createdAt: '2026-01-02T00:00:00Z', lastUpdatedAt: '2026-01-05T00:00:00Z', messageCount: 4 },
  { hostId: 'win', sessionId: 's2', conversationKey: 'c2', title: 'Shared project', cwd: 'D:/shared', createdAt: '2026-01-03T00:00:00Z', lastUpdatedAt: '2026-01-04T00:00:00Z', messageCount: 8 },
  { hostId: 'win', sessionId: 's3', conversationKey: 'c3', title: 'Beta large', cwd: 'D:/beta', createdAt: '2026-01-04T00:00:00Z', lastUpdatedAt: '2026-01-03T00:00:00Z', messageCount: 30 },
  { hostId: 'win', sessionId: 'trash1', conversationKey: 'trash1', title: 'Trash item', cwd: 'D:/trash', createdAt: '2026-01-05T00:00:00Z', lastUpdatedAt: '2026-01-06T00:00:00Z', messageCount: 99 },
];

api.state.sessionCollections = [
  { collectionId: 'default', name: 'Default', system: true, items: [] },
  { collectionId: 'alpha', name: 'Alpha', items: [
    { hostId: 'win', conversationKey: 'c1', sessionId: 's1' },
    { hostId: 'win', conversationKey: 'c2', sessionId: 's2' },
    { hostId: 'win', conversationKey: 'current', sessionId: 'current' },
  ] },
  { collectionId: 'beta', name: 'Beta', items: [
    { hostId: 'win', conversationKey: 'c2', sessionId: 's2' },
    { hostId: 'win', conversationKey: 'c3', sessionId: 's3' },
  ] },
  { collectionId: 'trash', name: 'Trash', items: [
    { hostId: 'win', conversationKey: 'trash1', sessionId: 'trash1' },
  ] },
];

api.openHistoryImportDialog();
let groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(plainArray(groups.map((group) => group.conversationKey)), ['c1', 'c2']);
assert.deepStrictEqual(plainArray(groups.find((group) => group.conversationKey === 'c2').collectionNames), ['Alpha']);

api.toggleHistoryImportCollection('beta', true);
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(plainArray(groups.map((group) => group.conversationKey)), ['c1', 'c2', 'c3']);
assert.deepStrictEqual(plainArray(groups.find((group) => group.conversationKey === 'c2').collectionNames), ['Alpha', 'Beta']);

api.setHistoryImportSort('messageCount');
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(plainArray(groups.map((group) => group.conversationKey)), ['c3', 'c2', 'c1']);

api.setHistoryImportSort('createdAt');
api.state.historyImportDialog.sortDir = 'asc';
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(plainArray(groups.map((group) => group.conversationKey)), ['c1', 'c2', 'c3']);

api.setHistoryImportSearch('shared');
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(plainArray(groups.map((group) => group.conversationKey)), ['c2']);

assert.ok(!api.state.historyImportDialog.selectedCollectionIds.has('trash'));

const latestSource = fs.readFileSync(appPath, 'utf8');
const stylesSource = fs.readFileSync(path.join(ROOT, 'apps', 'mobile-web', 'public', 'styles.css'), 'utf8');
assert.ok(latestSource.includes('history-import-search-input'), 'dialog should include search input');
assert.ok(latestSource.includes('history-import-sort-select'), 'dialog should include sort select');
assert.ok(latestSource.includes('history-import-sort-dir-button'), 'dialog should include sort direction button');
assert.ok(latestSource.includes('data-history-import-collection-id'), 'dialog should include collection checkboxes');
assert.ok(latestSource.includes('collectionNames'), 'dialog rows should render collection names');
assert.ok(!latestSource.includes('function getHistoryImportSessions'), 'dialog should not use the old global session candidate builder');
assert.ok(stylesSource.includes('.history-import-toolbar'), 'dialog should style the filtering toolbar');
assert.ok(stylesSource.includes('.history-import-meta'), 'dialog should style created/updated/message metadata');
console.log('history import filtering tests passed');
