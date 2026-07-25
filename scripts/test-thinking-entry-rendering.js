const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `${name} was not found in app.js`);
  const nextFunction = source.indexOf('\nfunction ', start + marker.length);
  const block = source.slice(start, nextFunction >= 0 ? nextFunction : source.length).trim();
  assert(block.endsWith('}'), `${name} did not have a complete body`);
  return block;
}

const dom = new JSDOM('<!doctype html><body></body>');
const context = {
  window: dom.window,
  document: dom.window.document,
  HTMLDetailsElement: dom.window.HTMLDetailsElement,
  state: { thinkingDisclosures: new Map() },
  prettyStatusLabel: (value) => String(value || '').replace(/-/g, ' '),
  limitText: (value, maximum) => String(value || '').slice(0, maximum),
  formatTime: (value) => String(value || ''),
  renderFileCards: () => {},
  renderFileChangeDetails: () => dom.window.document.createElement('div'),
};
vm.createContext(context);
for (const name of [
  'joinThinkingTextParts',
  'thinkingDisclosureStateKey',
  'bindThinkingDisclosure',
  'thinkingEntryViewportKey',
  'thinkingEntryKey',
  'thinkingEntryActivityKeys',
  'applyThinkingEntryData',
  'isThinkingOperationEntry',
  'formatThinkingStructuredValue',
  'appendThinkingOperationField',
  'thinkingOperationTitle',
  'thinkingOperationStatus',
  'thinkingOperationStatusTone',
  'formatThinkingOperationMeta',
  'createThinkingOperationEntry',
  'hashThinkingEntryVersion',
  'thinkingEntriesRenderVersion',
  'captureThinkingDisclosureStates',
  'restoreThinkingDisclosureStates',
  'syncThinkingEntryAttributes',
  'captureThinkingEntryInnerState',
  'restoreThinkingEntryInnerState',
  'patchThinkingHistoryEntry',
  'patchThinkingHistoryList',
]) {
  vm.runInContext(extractFunction(name), context, { filename: `${name}.js` });
}

assert.strictEqual(
  context.joinThinkingTextParts(['Reviewing', 'the', 'runtime', 'state']),
  'Reviewing the runtime state'
);
assert.strictEqual(
  context.joinThinkingTextParts(['Review', 'ing', ' the', ' state', '.']),
  'Reviewing the state.'
);
assert.strictEqual(context.joinThinkingTextParts(['two', 'tokens']), 'two tokens');
assert.strictEqual(context.joinThinkingTextParts(['正在', '检查', '文件']), '正在检查文件');
assert.strictEqual(
  context.joinThinkingTextParts(['first line\nsecond line', 'third line']),
  'first line\nsecond line\nthird line'
);

const baseEntry = {
  groupKey: 'command:stable',
  activityKeys: ['activity-start', 'activity-output'],
  category: 'command',
  kind: 'command-output',
  command: 'node <unsafe>.js',
  cwd: 'D:/workspace',
  output: '<script>literal output</script>',
  status: 'running',
  timestamp: '2026-07-21T10:00:00.000Z',
};
const first = context.createThinkingOperationEntry(baseEntry, 0, 'session::thinking', {});
assert.strictEqual(first.tagName, 'DETAILS');
assert.strictEqual(first.open, false, 'tool and command details should default to collapsed');
assert.strictEqual(first.dataset.thinkingEntryKey, 'command:stable');
assert.strictEqual(first.dataset.thinkingViewportKey, 'thinking|command:stable');
assert.strictEqual(first.dataset.thinkingActivityKeys, 'activity-start\u001factivity-output');
assert.strictEqual(first.querySelector('script'), null, 'tool output HTML must remain inert text');
assert(first.textContent.includes('<script>literal output</script>'));
assert(first.querySelector('.thinking-operation-code').textContent.includes('node <unsafe>.js'));
assert.strictEqual(
  first.querySelector('[data-thinking-field-key="Output"]')?.dataset.thinkingFieldKey,
  'Output',
  'structured operation fields need stable keys for narrow live patches'
);

dom.window.document.body.appendChild(first);
first.open = true;
first.dispatchEvent(new dom.window.Event('toggle'));
assert.strictEqual(
  context.state.thinkingDisclosures.get('session::thinking::disclosure::command:stable'),
  true,
  'explicit disclosure state should be remembered'
);

const history = dom.window.document.createElement('div');
dom.window.document.body.appendChild(history);
history.appendChild(first);
const originalOutput = first.querySelector('[data-thinking-field-key="Output"] pre');
originalOutput.scrollTop = 17;
originalOutput.scrollLeft = 23;
const originalSummary = first.querySelector(':scope > summary');
originalSummary.tabIndex = 0;
originalSummary.focus();
const nextHistory = dom.window.document.createElement('div');
const next = context.createThinkingOperationEntry({
  ...baseEntry,
  output: 'updated output',
  status: 'completed',
  final: true,
}, 0, 'session::thinking', {});
nextHistory.appendChild(next);
context.patchThinkingHistoryList(history, nextHistory, 'session::thinking');
assert.strictEqual(history.firstElementChild, first, 'stable keyed updates should reuse the existing row');
assert.strictEqual(first.open, true, 'an open operation must stay open after live updates');
assert(first.textContent.includes('updated output'));
assert(!first.textContent.includes('<script>literal output</script>'));
const patchedOutput = first.querySelector('[data-thinking-field-key="Output"] pre');
assert.strictEqual(patchedOutput.scrollTop, 17, 'narrow patches should preserve nested output scrollTop');
assert.strictEqual(patchedOutput.scrollLeft, 23, 'narrow patches should preserve nested output scrollLeft');
assert.strictEqual(
  dom.window.document.activeElement,
  first.querySelector(':scope > summary'),
  'narrow patches should restore keyboard focus inside an expanded operation'
);

const changedTextKey = context.thinkingEntryViewportKey({
  ...baseEntry,
  text: 'a completely different live payload',
}, 99);
assert.strictEqual(changedTextKey, 'thinking|command:stable', 'viewport identity must not depend on text or index');
assert.notStrictEqual(
  context.thinkingEntriesRenderVersion([{ ...baseEntry, text: 'first revision', activityRevision: 1 }]),
  context.thinkingEntriesRenderVersion([{ ...baseEntry, text: 'second revision', activityRevision: 2 }]),
  'same-row content growth must change the render version used for unread state'
);

console.log('thinking entry rendering assertions passed');
