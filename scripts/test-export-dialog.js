const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appPath = path.join(ROOT, 'apps', 'mobile-web', 'public', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

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
  setTimeout() {
    return 0;
  },
  clearTimeout() {},
  setInterval() {
    return 0;
  },
  clearInterval() {},
};

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

  remove() {
    this.removed = true;
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  closest() {
    return null;
  }
}

const elementIds = [
  'export-dialog',
  'export-format-select',
  'export-start-date-input',
  'export-end-date-input',
  'export-include-thinking-checkbox',
  'export-include-images-checkbox',
  'export-include-files-checkbox',
  'export-include-all-files-checkbox',
  'export-dialog-summary',
  'export-session-time-summary',
  'export-day-list',
  'export-dates-select-all-button',
  'export-dates-clear-button',
  'export-files-select-all-button',
  'export-files-select-none-button',
  'export-extension-list',
  'export-file-list',
];
const elements = new Map(elementIds.map((id) => [id, new ElementStub(id)]));
const clickedLinks = [];

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
    const element = new ElementStub(tag);
    if (tag === 'a') {
      element.click = () => {
        clickedLinks.push({
          href: element.href,
          download: element.download,
        });
      };
    }
    return element;
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
  location: { origin: 'http://127.0.0.1:8797' },
  alert: () => {},
  confirm: () => true,
  prompt: () => '',
};
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
window.__exportDialogTest = {
  state,
  buildSessionExportUrl,
  exportSelectedDaysToRanges,
  getExportSelectableDays,
  exportSelectedSessionHistory,
  exportFromDialog,
};
`;
vm.createContext(sandbox);
vm.runInContext(`${source}\n${testHook}`, sandbox, { filename: appPath });

const {
  state,
  buildSessionExportUrl,
  exportSelectedDaysToRanges,
  getExportSelectableDays,
  exportSelectedSessionHistory,
  exportFromDialog,
} = sandbox.window.__exportDialogTest;

const session = {
  hostId: 'managed-test-host',
  sessionId: 'session-123',
  conversationKey: 'session-123',
  title: 'Export test',
  cwd: ROOT,
  createdAt: '2026-06-24T09:00:00.000Z',
  lastUpdatedAt: '2026-06-26T11:00:00.000Z',
};
state.hosts = [{ hostId: session.hostId, online: true }];
state.sessions = [session];
state.selectedHostId = session.hostId;
state.selectedConversationKey = session.conversationKey;
state.selectedSessionId = session.sessionId;
state.receivedFiles.set(`${session.hostId}::${session.sessionId}`, [
  {
    fileId: 'file-1',
    name: 'analysis.py',
    path: `${ROOT}\\analysis.py`,
    size: 512,
    receivedAt: '2026-06-25T10:00:00.000Z',
  },
]);
state.exportDialog.timeline = {
  session: {
    createdAt: session.createdAt,
    updatedAt: session.lastUpdatedAt,
    firstMessageAt: '2026-06-24T09:00:00.000Z',
    lastMessageAt: '2026-06-26T11:00:00.000Z',
  },
  days: [
    { date: '2026-06-24', messageCount: 2 },
    { date: '2026-06-25', messageCount: 3 },
    { date: '2026-06-26', messageCount: 4 },
  ],
};
state.exportDialog.timelineKey = `${session.hostId}::${session.sessionId}`;

const zipUrl = buildSessionExportUrl(session, 'zip', {
  includeThinking: true,
  dates: ['2026-06-24..2026-06-26'],
});
assert(zipUrl.includes('format=zip'), 'zip export URL should include format=zip');
assert(zipUrl.includes('dates=2026-06-24..2026-06-26'), 'zip export URL should include selected date ranges');

assert(
  JSON.stringify(getExportSelectableDays()) === JSON.stringify(['2026-06-24', '2026-06-25', '2026-06-26']),
  `selectable days should be date strings, got ${JSON.stringify(getExportSelectableDays())}`
);

const selectAllDates = elements.get('export-dates-select-all-button').listeners.get('click');
assert(typeof selectAllDates === 'function', 'select-all dates button should have a click handler');
state.exportDialog.selectedDays = new Set(['2026-06-24', '2026-06-25', '2026-06-26']);
sandbox.window.__exportDialogTest.state.exportDialog.open = true;
sandbox.window.__exportDialogTest.state.exportDialog.includeAllFiles = true;
sandbox.window.__exportDialogTest.state.exportDialog.includeImages = true;
sandbox.window.__exportDialogTest.state.exportDialog.includeFiles = true;
sandbox.window.__exportDialogTest.state.exportDialog.selectedExtensions = new Set();
sandbox.window.__exportDialogTest.state.exportDialog.selectedFileIds = new Set();
sandbox.window.__exportDialogTest.state.exportDialog.timelineLoading = false;
sandbox.window.__exportDialogTest.state.exportDialog.timelineError = '';
sandbox.window.__exportDialogTest.state.exportDialog.fromDate = '';
sandbox.window.__exportDialogTest.state.exportDialog.toDate = '';
sandbox.window.__exportDialogTest.state.exportDialog.format = 'markdown';
sandbox.window.__exportDialogTest.state.exportDialog.timelineKey = `${session.hostId}::${session.sessionId}`;
sandbox.window.__exportDialogTest.state.exportDialog.timeline = state.exportDialog.timeline;
sandbox.window.__exportDialogTest.state.sessions = [session];
sandbox.window.__exportDialogTest.state.selectedConversationKey = session.conversationKey;
sandbox.window.__exportDialogTest.state.selectedSessionId = session.sessionId;
sandbox.window.__exportDialogTest.state.selectedHostId = session.hostId;
vm.runInContext('renderExportDialog()', sandbox, { filename: appPath });
assert(
  elements.get('export-dates-select-all-button').disabled === true,
  'select-all dates button should be disabled when all date strings are already selected'
);
state.exportDialog.selectedDays = new Set();
selectAllDates();
const selectedDays = state.exportDialog.selectedDays;
const ranges = exportSelectedDaysToRanges(selectedDays);
assert(
  ranges.length === 1 && ranges[0] === '2026-06-24..2026-06-26',
  `select-all dates should produce one full date range, got ${JSON.stringify(ranges)}`
);

state.exportDialog.format = 'zip';
state.exportDialog.includeThinking = false;
state.exportDialog.includeImages = true;
state.exportDialog.includeFiles = true;
state.exportDialog.includeAllFiles = true;
state.exportDialog.selectedDays = new Set(['2026-06-24', '2026-06-25', '2026-06-26']);
elements.get('export-start-date-input').value = '';
elements.get('export-end-date-input').value = '';
exportFromDialog();
const dialogClick = clickedLinks.pop();
assert(dialogClick, 'export dialog should create and click a download link');
assert(dialogClick.href.includes('format=zip'), `dialog export should request zip, got ${dialogClick.href}`);
assert(dialogClick.href.includes('dates=2026-06-24..2026-06-26'), `dialog export should pass date range, got ${dialogClick.href}`);
assert(dialogClick.download.endsWith('.zip'), `zip dialog export should set a .zip download name, got ${dialogClick.download}`);

state.exportDialog.format = 'markdown';
vm.runInContext('renderExportDialog()', sandbox, { filename: appPath });
const formatChange = elements.get('export-format-select').listeners.get('change');
assert(typeof formatChange === 'function', 'export format select should have a change handler');
formatChange({ target: { value: 'zip' } });
assert(state.exportDialog.format === 'zip', `format change should update dialog state to zip, got ${state.exportDialog.format}`);
const confirmClick = elements.get('export-dialog-confirm-button').listeners.get('click');
assert(typeof confirmClick === 'function', 'export dialog confirm should have a click handler');
confirmClick();
const changedFormatClick = clickedLinks.pop();
assert(changedFormatClick, 'export dialog confirm should click a download link after changing the format select');
assert(changedFormatClick.href.includes('format=zip'), `format select change should export zip, got ${changedFormatClick.href}`);
assert(changedFormatClick.download.endsWith('.zip'), `format select change should download .zip, got ${changedFormatClick.download}`);

clickedLinks.length = 0;
state.exportDialog.format = 'markdown';
state.exportDialog.includeThinking = false;
state.exportDialog.includeImages = true;
state.exportDialog.includeFiles = true;
state.exportDialog.includeAllFiles = true;
state.exportDialog.selectedExtensions = new Set(['py']);
state.exportDialog.selectedFileIds = new Set(['file-1']);
state.exportDialog.selectedDays = new Set();
elements.get('export-start-date-input').value = '';
elements.get('export-end-date-input').value = '';
exportFromDialog();
assert(clickedLinks.length === 2, `markdown export with selected files should trigger md and zip downloads, got ${clickedLinks.length}`);
assert(clickedLinks[0].href.includes('format=markdown'), `first download should be markdown, got ${clickedLinks[0].href}`);
assert(clickedLinks[0].download.endsWith('.md'), `first download should be .md, got ${clickedLinks[0].download}`);
assert(clickedLinks[1].href.includes('format=zip'), `second download should be zip, got ${clickedLinks[1].href}`);
assert(clickedLinks[1].download.endsWith('.zip'), `second download should be .zip, got ${clickedLinks[1].download}`);

exportSelectedSessionHistory('markdown');
const markdownClick = clickedLinks.pop();
assert(markdownClick.download.endsWith('.md'), `markdown export should set a .md download name, got ${markdownClick.download}`);

console.log('export dialog assertions passed');
