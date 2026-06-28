# History Import Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `Others` history import dialog searchable, sortable, and scoped by one or more collections while keeping imports as attachments only.

**Architecture:** Add pure candidate-building helpers in `apps/mobile-web/public/app.js`, then render those candidates in the existing import modal. The dialog keeps its own filter/sort state and the import action continues to call `attachSessionHistory()` on selected preferred sessions.

**Tech Stack:** Plain browser JavaScript, existing DOM helpers, Node-based regression scripts.

## Global Constraints

- Default import scope is the currently selected collection.
- Trash is excluded from import collection choices.
- Duplicate conversations across selected collections appear once.
- The dialog supports sorting by `updatedAt`, `createdAt`, and `messageCount`.
- Import remains an attachment action and must not call `sendInput()` or enqueue session runtime work.

---

### Task 1: Candidate Builder And Regression Test

**Files:**
- Modify: `apps/mobile-web/public/app.js`
- Create: `scripts/test-history-import-filtering.js`

**Interfaces:**
- Produces: `getHistoryImportCandidateGroups(dialog = state.historyImportDialog): Array<object>`
- Produces: `setHistoryImportSort(sortBy: string): void`
- Produces: `setHistoryImportSearch(query: string): void`
- Produces: `toggleHistoryImportCollection(collectionId: string, checked: boolean): void`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-history-import-filtering.js` with a VM harness that loads `app.js`, seeds `state.sessions`, `state.sessionCollections`, and asserts:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');

const documentStub = {
  addEventListener() {},
  body: { appendChild() {} },
  createElement() {
    return {
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      appendChild() {},
      append() {},
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      style: {},
      dataset: {},
      children: [],
      innerHTML: '',
      textContent: '',
    };
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById() { return null; },
};

const context = {
  console,
  document: documentStub,
  window: {
    addEventListener() {},
    location: { search: '' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    alert() {},
    confirm() { return true; },
  },
  navigator: { userAgent: 'node' },
  EventSource: function EventSource() {},
  Blob,
  File: typeof File === 'function' ? File : undefined,
  URL,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
context.globalThis = context;

vm.createContext(context);
vm.runInContext(`${source}
globalThis.__historyImportApi = {
  state,
  openHistoryImportDialog,
  getHistoryImportCandidateGroups,
  setHistoryImportSort,
  setHistoryImportSearch,
  toggleHistoryImportCollection,
};
`, context, { filename: appPath });

const api = context.__historyImportApi;
api.state.hosts = [{ hostId: 'win', label: 'Windows', platform: 'win32', online: true }];
api.state.selectedHostId = 'win';
api.state.selectedCollectionId = 'alpha';
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
assert.deepStrictEqual(groups.map((group) => group.conversationKey), ['c1', 'c2']);
assert.deepStrictEqual(groups.find((group) => group.conversationKey === 'c2').collectionNames, ['Alpha']);

api.toggleHistoryImportCollection('beta', true);
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(groups.map((group) => group.conversationKey), ['c1', 'c2', 'c3']);
assert.deepStrictEqual(groups.find((group) => group.conversationKey === 'c2').collectionNames, ['Alpha', 'Beta']);

api.setHistoryImportSort('messageCount');
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(groups.map((group) => group.conversationKey), ['c3', 'c2', 'c1']);

api.setHistoryImportSort('createdAt');
api.state.historyImportDialog.sortDir = 'asc';
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(groups.map((group) => group.conversationKey), ['c1', 'c2', 'c3']);

api.setHistoryImportSearch('shared');
groups = api.getHistoryImportCandidateGroups();
assert.deepStrictEqual(groups.map((group) => group.conversationKey), ['c2']);

assert.ok(!api.state.historyImportDialog.selectedCollectionIds.has('trash'));
console.log('history import filtering tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts\test-history-import-filtering.js`

Expected: FAIL because `getHistoryImportCandidateGroups` is not defined.

- [ ] **Step 3: Implement minimal helper state and candidate builder**

Modify `state.historyImportDialog` in `apps/mobile-web/public/app.js` to include:

```js
selectedCollectionIds: new Set(),
searchQuery: '',
sortBy: 'updatedAt',
sortDir: 'desc',
```

Add helpers near the existing history import functions:

```js
function getHistoryImportCollections() {
  return state.sessionCollections.filter((collection) => collection.collectionId !== TRASH_COLLECTION_ID);
}

function getHistoryImportCollectionIds() {
  const dialog = state.historyImportDialog;
  const available = new Set(getHistoryImportCollections().map((collection) => collection.collectionId));
  return Array.from(dialog.selectedCollectionIds || []).filter((collectionId) => available.has(collectionId));
}

function getHistoryImportSearchText(group) {
  return getConversationSearchText(group);
}

function compareHistoryImportGroups(a, b) {
  const dialog = state.historyImportDialog;
  const direction = dialog.sortDir === 'asc' ? 1 : -1;
  const sortableTime = (value) => {
    const time = Date.parse(value || '');
    if (Number.isFinite(time)) {
      return time;
    }
    return direction === 1 ? Infinity : -Infinity;
  };
  let delta = 0;
  if (dialog.sortBy === 'createdAt') {
    delta = sortableTime(a.createdAt) - sortableTime(b.createdAt);
  } else if (dialog.sortBy === 'messageCount') {
    delta = Number(a.messageCount || 0) - Number(b.messageCount || 0);
  } else {
    delta = sortableTime(a.lastUpdatedAt) - sortableTime(b.lastUpdatedAt);
  }
  if (delta !== 0) {
    return delta * direction;
  }
  return String(a.title || a.conversationKey).localeCompare(String(b.title || b.conversationKey));
}

function getHistoryImportCandidateGroups(dialog = state.historyImportDialog) {
  const selectedConversationKey = getSessionConversationKey(getSelectedSession());
  const selectedHostId = getSelectedSession()?.hostId || '';
  const selectedCollectionIds = getHistoryImportCollectionIds();
  const collections = getHistoryImportCollections().filter((collection) => selectedCollectionIds.includes(collection.collectionId));
  const byKey = new Map();
  for (const collection of collections) {
    for (const group of getConversationGroupsForCollection(collection)) {
      if (group.hostId === selectedHostId && group.conversationKey === selectedConversationKey) {
        continue;
      }
      const key = `${group.hostId}::${group.conversationKey}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.collectionNames.push(collection.name || 'Collection');
        continue;
      }
      byKey.set(key, {
        ...group,
        collectionNames: [collection.name || 'Collection'],
      });
    }
  }
  const query = String(dialog.searchQuery || '').trim().toLowerCase();
  const groups = Array.from(byKey.values()).filter((group) => {
    if (!query) {
      return true;
    }
    const terms = query.split(/\s+/).filter(Boolean);
    const haystack = getHistoryImportSearchText(group);
    return terms.every((term) => haystack.includes(term));
  });
  return groups.sort(compareHistoryImportGroups);
}

function setHistoryImportSort(sortBy) {
  const next = ['updatedAt', 'createdAt', 'messageCount'].includes(sortBy) ? sortBy : 'updatedAt';
  state.historyImportDialog.sortBy = next;
}

function setHistoryImportSearch(query) {
  state.historyImportDialog.searchQuery = String(query || '');
}

function toggleHistoryImportCollection(collectionId, checked) {
  const dialog = state.historyImportDialog;
  if (!(dialog.selectedCollectionIds instanceof Set)) {
    dialog.selectedCollectionIds = new Set(dialog.selectedCollectionIds || []);
  }
  if (checked) {
    if (collectionId !== TRASH_COLLECTION_ID) {
      dialog.selectedCollectionIds.add(collectionId);
    }
  } else {
    dialog.selectedCollectionIds.delete(collectionId);
  }
}
```

Update `openHistoryImportDialog()` to initialize `selectedCollectionIds` to the current non-trash collection, or the first non-trash collection if the current one is Trash.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts\test-history-import-filtering.js`

Expected: PASS with `history import filtering tests passed`.

- [ ] **Step 5: Commit**

Commit only the files from this task:

```powershell
git -c safe.directory=D:/project/cursor_english_dev/remote_codex add apps/mobile-web/public/app.js scripts/test-history-import-filtering.js
git -c safe.directory=D:/project/cursor_english_dev/remote_codex commit -m "Add history import filtering candidates"
```

### Task 2: Dialog Rendering And Events

**Files:**
- Modify: `apps/mobile-web/public/app.js`
- Modify: `scripts/test-history-import-filtering.js`

**Interfaces:**
- Consumes: `getHistoryImportCandidateGroups(dialog)`
- Produces: rendered controls with ids `history-import-search-input`, `history-import-sort-select`, `history-import-sort-dir-button`, and collection checkboxes using `data-history-import-collection-id`.

- [ ] **Step 1: Extend the failing test**

Extend `scripts/test-history-import-filtering.js` to assert source-level DOM hooks:

```js
const latestSource = fs.readFileSync(appPath, 'utf8');
assert.ok(latestSource.includes('history-import-search-input'), 'dialog should include search input');
assert.ok(latestSource.includes('history-import-sort-select'), 'dialog should include sort select');
assert.ok(latestSource.includes('history-import-sort-dir-button'), 'dialog should include sort direction button');
assert.ok(latestSource.includes('data-history-import-collection-id'), 'dialog should include collection checkboxes');
assert.ok(latestSource.includes('collectionNames'), 'dialog rows should render collection names');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts\test-history-import-filtering.js`

Expected: FAIL because the dialog does not render the new controls yet.

- [ ] **Step 3: Render toolbar and wire events**

Modify `ensureHistoryImportUi()` to insert a toolbar above select-all:

```html
<div class="history-import-toolbar">
  <div id="history-import-collection-filter" class="history-import-collection-filter"></div>
  <input id="history-import-search-input" type="search" placeholder="Search conversations" />
  <select id="history-import-sort-select">
    <option value="updatedAt">Updated time</option>
    <option value="createdAt">Created time</option>
    <option value="messageCount">Message count</option>
  </select>
  <button id="history-import-sort-dir-button" type="button" class="secondary-button">Desc</button>
</div>
```

Modify `renderHistoryImportDialog()` to:

- call `const sessions = getHistoryImportCandidateGroups();`
- render collection filter checkboxes from `getHistoryImportCollections()`
- set search/sort control values from `state.historyImportDialog`
- show `collectionNames`, created/updated/message count in each row
- make select-all operate on currently visible candidates only

Add event listeners:

```js
el('history-import-search-input')?.addEventListener('input', (event) => {
  setHistoryImportSearch(event.target.value);
  renderHistoryImportDialog();
});

el('history-import-sort-select')?.addEventListener('change', (event) => {
  setHistoryImportSort(event.target.value);
  renderHistoryImportDialog();
});

el('history-import-sort-dir-button')?.addEventListener('click', () => {
  state.historyImportDialog.sortDir = state.historyImportDialog.sortDir === 'asc' ? 'desc' : 'asc';
  renderHistoryImportDialog();
});

el('history-import-collection-filter')?.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-history-import-collection-id]');
  if (!checkbox) {
    return;
  }
  toggleHistoryImportCollection(checkbox.dataset.historyImportCollectionId, checkbox.checked);
  renderHistoryImportDialog();
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts\test-history-import-filtering.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git -c safe.directory=D:/project/cursor_english_dev/remote_codex add apps/mobile-web/public/app.js scripts/test-history-import-filtering.js
git -c safe.directory=D:/project/cursor_english_dev/remote_codex commit -m "Render filtered history import dialog"
```

### Task 3: Full Regression Verification

**Files:**
- Modify only if tests expose a regression.

**Interfaces:**
- Consumes all prior task outputs.

- [ ] **Step 1: Run syntax and focused tests**

Run:

```powershell
node --check apps\mobile-web\public\app.js
node scripts\test-history-import-filtering.js
npm run test:export-dialog
node scripts\test-mobile-realtime-resume.js
```

Expected: all pass.

- [ ] **Step 2: Run broader session tests**

Run:

```powershell
npm run test:managed
node scripts\test-session-watch-fast-path.js
node scripts\test-session-watch-routing.js
node scripts\test-linux-history-regression.js
node scripts\test-session-trash.js
```

Expected: all pass.

- [ ] **Step 3: Inspect diff**

Run:

```powershell
git -c safe.directory=D:/project/cursor_english_dev/remote_codex diff -- apps/mobile-web/public/app.js scripts/test-history-import-filtering.js
git -c safe.directory=D:/project/cursor_english_dev/remote_codex status --short
```

Expected: only intended files are modified, plus previously existing unrelated/uncommitted files.

- [ ] **Step 4: Commit verification adjustments if needed**

If Step 1 or Step 2 required small corrections, commit only those corrections:

```powershell
git -c safe.directory=D:/project/cursor_english_dev/remote_codex add apps/mobile-web/public/app.js scripts/test-history-import-filtering.js
git -c safe.directory=D:/project/cursor_english_dev/remote_codex commit -m "Verify history import filtering"
```

