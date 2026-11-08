const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MarkdownIt = require('markdown-it');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
const { createMarkdownRenderer } = require('../apps/mobile-web/public/markdown-renderer');
const structuredText = require('../apps/mobile-web/public/structured-text');

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
dom.window.RemoteCodexMarkdownRenderer = createMarkdownRenderer({
  markdownIt: MarkdownIt,
  sanitizer: createDOMPurify(dom.window),
  document: dom.window.document,
});
dom.window.RemoteCodexStructuredText = structuredText;
dom.window.MathJax = {
  typesetPromise: () => Promise.resolve(),
};
const context = {
  window: dom.window,
  document: dom.window.document,
  HTMLDetailsElement: dom.window.HTMLDetailsElement,
  state: { thinkingDisclosures: new Map(), ui: { locale: 'en' } },
  THINKING_EXPANDABLE_TEXT_CHAR_LIMIT: 420,
  THINKING_EXPANDABLE_TEXT_LINE_LIMIT: 8,
  THINKING_EXPANDABLE_CODE_CHAR_LIMIT: 720,
  THINKING_EXPANDABLE_CODE_LINE_LIMIT: 12,
  pendingMathTypesetContainers: new Set(),
  mathTypesetScheduled: false,
  normalizeFileChanges: () => [],
  getTranscriptForSession: () => [],
  getThinkingDiagnosticsForSession: () => [],
  getProjectedThinkingActivities: () => context.projectedActivities || [],
  mergeProjectedThinkingEntries: (diagnostics, activities) => [...diagnostics, ...activities],
  isThinkingActivityDiagnostic: () => true,
  LIVE_THINKING_ACTIVITY_ENTRY_LIMIT: 160,
  prettyStatusLabel: (value) => String(value || '').replace(/-/g, ' '),
  limitText: (value, maximum) => String(value || '').slice(0, maximum),
  formatTime: (value) => String(value || ''),
  captureTranscriptScrollSnapshot: () => null,
  restoreTranscriptScrollSnapshot: () => {},
  captureViewportElementOffset: () => null,
  restoreViewportElementOffset: () => {},
  renderFileCards: () => {},
  renderFileChangeDetails: () => dom.window.document.createElement('div'),
  structuredThinkingText: (value, options) => structuredText.toText(value, options),
  structuredThinkingScalar: (value, fallback) => structuredText.toScalar(value, fallback),
};
vm.createContext(context);
for (const name of [
  'joinThinkingTextParts',
  'formatThinkingValue',
  'normalizeThinkingMessage',
  'subagentActivityItem',
  'firstThinkingField',
  'isFileChangeDiagnostic',
  'isUserSuitableThinkingText',
  'normalizeThinkingActivityForModel',
  'aggregateThinkingActivityEntries',
  'thinkingTurnIdentity',
  'buildThinkingTurnOwnershipIndex',
  'thinkingTurnIdentityAliases',
  'thinkingEntryMatchesUserTurn',
  'buildLiveActivitySegment',
  'buildThinkingEntriesForSession',
  'normalizeTranscriptSpeaker',
  'normalizeTranscriptIdentity',
  'normalizeTranscriptTimestamp',
  'transcriptEntryStableTurnKey',
  'thinkingDisclosureStateKey',
  'bindThinkingDisclosure',
  'thinkingEntryStableIdentityKey',
  'thinkingEntryViewportKey',
  'thinkingEntryKey',
  'thinkingEntryActivityKeys',
  'applyThinkingEntryData',
  'isThinkingOperationEntry',
  'formatThinkingStructuredValue',
  'thinkingExpansionCopy',
  'thinkingSourceTruncationCopy',
  'thinkingRetainedPreviewCopy',
  'thinkingTextNeedsExpansion',
  'thinkingSourceWasTruncated',
  'thinkingStructuredValueWasTruncated',
  'scheduleMathTypeset',
  'renderMarkdown',
  'bindThinkingTextExpansion',
  'appendThinkingOperationField',
  'thinkingOperationTitle',
  'thinkingOperationStatus',
  'thinkingOperationStatusTone',
  'formatThinkingOperationMeta',
  'createThinkingOperationEntry',
  'createThinkingNarrativeEntry',
  'hashThinkingEntryVersion',
  'thinkingEntryRenderVersion',
  'thinkingEntriesRenderVersion',
  'captureThinkingDisclosureStates',
  'restoreThinkingDisclosureStates',
  'syncThinkingEntryAttributes',
  'captureThinkingEntryInnerState',
  'restoreThinkingEntryInnerState',
  'syncThinkingPatchAttributes',
  'patchThinkingSimpleElement',
  'patchThinkingExpansionAccessories',
  'patchThinkingOperationField',
  'thinkingOperationBodyChildKey',
  'patchThinkingOperationBody',
  'patchThinkingOperationSummary',
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

const fullCommentary = `complete commentary ${'detail '.repeat(100)}`.trim();
assert.strictEqual(
  context.normalizeThinkingMessage({
    kind: 'commentary',
    message: '300-character diagnostic preview',
    data: { text: fullCommentary },
  }),
  fullCommentary,
  'Thinking must prefer the complete structured text over the diagnostic preview'
);

const delayedCommentary = context.normalizeThinkingActivityForModel({
  activityKey: 'commentary-delayed-final',
  activityRevision: 2,
  turnId: 'turn-one',
  clientRequestId: 'request-one',
  itemId: 'message-one',
  kind: 'commentary',
  text: 'Checking the first turn',
  startedAt: '2026-07-27T10:00:02.000Z',
  timestamp: '2026-07-27T10:00:12.000Z',
  final: true,
}, 0);
assert.strictEqual(
  delayedCommentary.timestamp,
  '2026-07-27T10:00:02.000Z',
  'Thinking turn assignment must use the immutable activity start time'
);
assert.strictEqual(delayedCommentary.updatedAt, '2026-07-27T10:00:12.000Z');
assert.strictEqual(delayedCommentary.clientRequestId, 'request-one');

context.window.RemoteCodexThinkingEntryModel = {
  normalizeThinkingActivityEntry(value) {
    const { clientRequestId, ...withoutClientRequestId } = value;
    return withoutClientRequestId;
  },
  aggregateThinkingEntries(entries) {
    return entries.map(({ clientRequestId, ...withoutClientRequestId }) => withoutClientRequestId);
  },
};
const modelNormalizedCommentary = context.normalizeThinkingActivityForModel({
  activityKey: 'model-normalized-commentary',
  activityRevision: 1,
  turnId: 'turn-one',
  clientRequestId: 'request-one',
  itemId: 'model-normalized-commentary',
  kind: 'commentary',
  text: 'Model-normalized commentary',
  timestamp: '2026-07-27T10:00:03.000Z',
}, 0);
assert.strictEqual(
  modelNormalizedCommentary.clientRequestId,
  'request-one',
  'the app wrapper must preserve clientRequestId when the rendering model omits it'
);
assert.strictEqual(
  context.aggregateThinkingActivityEntries([modelNormalizedCommentary])[0].clientRequestId,
  'request-one',
  'the app wrapper must restore clientRequestId after rendering-model aggregation'
);
delete context.window.RemoteCodexThinkingEntryModel;

context.projectedActivities = [
  delayedCommentary,
  context.normalizeThinkingActivityForModel({
    activityKey: 'tool-first-turn',
    activityRevision: 1,
    turnId: 'turn-one',
    clientRequestId: 'request-one',
    itemId: 'tool-one',
    kind: 'command',
    command: 'node first.js',
    text: 'Ran first command',
    startedAt: '2026-07-27T10:00:04.000Z',
    updatedAt: '2026-07-27T10:00:05.000Z',
    timestamp: '2026-07-27T10:00:05.000Z',
  }, 1),
  context.normalizeThinkingActivityForModel({
    activityKey: 'commentary-second-turn',
    activityRevision: 2,
    turnId: 'turn-two',
    clientRequestId: 'request-two',
    itemId: 'message-two',
    kind: 'commentary',
    text: 'Checking the second turn',
    startedAt: '2026-07-27T10:01:02.000Z',
    updatedAt: '2026-07-27T10:01:13.000Z',
    timestamp: '2026-07-27T10:01:13.000Z',
    final: true,
  }, 2),
  context.normalizeThinkingActivityForModel({
    activityKey: 'tool-second-turn',
    activityRevision: 1,
    turnId: 'turn-two',
    clientRequestId: 'request-two',
    itemId: 'tool-two',
    kind: 'command',
    command: 'node second.js',
    text: 'Ran second command',
    startedAt: '2026-07-27T10:01:04.000Z',
    updatedAt: '2026-07-27T10:01:05.000Z',
    timestamp: '2026-07-27T10:01:05.000Z',
  }, 3),
];
const turnSegments = context.buildThinkingEntriesForSession({ sessionId: 'two-turns' }, {
  transcriptEntries: [{
    speaker: 'user',
    text: 'first',
    timestamp: '2026-07-27T10:00:30.000Z',
    clientRequestId: 'request-one',
  }, {
    speaker: 'assistant',
    text: 'first reply',
    timestamp: '2026-07-27T10:00:10.000Z',
  }, {
    speaker: 'user',
    text: 'second',
    timestamp: '2026-07-27T10:01:00.000Z',
    clientRequestId: 'request-two',
  }, {
    speaker: 'assistant',
    text: 'second reply',
    timestamp: '2026-07-27T10:01:10.000Z',
  }],
  diagnostics: [],
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(turnSegments.map((segment) => (
    segment.entries.map((entry) => entry.itemId)
  )))),
  [['message-one', 'tool-one'], ['message-two', 'tool-two']],
  'late final snapshots must retain commentary and tools in their own consecutive turns'
);
assert.strictEqual(
  turnSegments[0].userEntryKey,
  'user|request|request-one',
  'Thinking card identity must prefer clientRequestId over a reconciled transcript timestamp'
);

const reconciledTurnSegments = context.buildThinkingEntriesForSession({ sessionId: 'two-turns' }, {
  transcriptEntries: [{
    speaker: 'user',
    text: 'first',
    timestamp: '2026-07-27T09:59:00.000Z',
    clientRequestId: 'request-one',
  }, {
    speaker: 'assistant',
    text: 'first reply',
    timestamp: '2026-07-27T10:00:10.000Z',
  }, {
    speaker: 'user',
    text: 'second',
    timestamp: '2026-07-27T10:01:00.000Z',
    clientRequestId: 'request-two',
  }, {
    speaker: 'assistant',
    text: 'second reply',
    timestamp: '2026-07-27T10:01:10.000Z',
  }],
  diagnostics: [{
    kind: 'commentary',
    message: 'Late diagnostic for the first turn',
    timestamp: '2026-07-27T10:01:06.000Z',
    turnId: 'turn-one',
    clientRequestId: 'request-one',
    itemId: 'late-first-diagnostic',
    final: true,
  }],
});
assert.strictEqual(
  reconciledTurnSegments[0].userEntryKey,
  turnSegments[0].userEntryKey,
  'server timestamp reconciliation must not recreate a completed Thinking card'
);
assert(
  reconciledTurnSegments[0].entries.some((entry) => entry.itemId === 'late-first-diagnostic'),
  'a late final with explicit identity must remain attached to the original user turn'
);
assert(
  !reconciledTurnSegments[1].entries.some((entry) => entry.itemId === 'late-first-diagnostic'),
  'a late final must not move into the timestamp window of a later user turn'
);

const identityOnlySegments = context.buildThinkingEntriesForSession({ sessionId: 'identity-only' }, {
  transcriptEntries: [{
    speaker: 'user',
    text: 'identity only',
    timestamp: null,
    clientRequestId: 'request-one',
  }],
  diagnostics: [{
    kind: 'commentary',
    message: 'Identity survives without a usable timestamp',
    timestamp: '2026-07-27T11:00:00.000Z',
    turnId: 'turn-one',
    clientRequestId: 'request-one',
    itemId: 'identity-only-diagnostic',
  }],
});
assert.strictEqual(identityOnlySegments.length, 1);
assert.strictEqual(identityOnlySegments[0].entries[0].itemId, 'identity-only-diagnostic');

context.projectedActivities = [{
  turnId: 'turn-one',
  clientRequestId: 'request-one',
  itemId: 'late-previous-live-activity',
  timestamp: '2026-07-27T10:01:30.000Z',
}, {
  turnId: 'turn-two',
  clientRequestId: 'request-two',
  itemId: 'current-live-activity',
  timestamp: '2026-07-27T10:01:02.000Z',
}];
const liveTurnSegment = context.buildLiveActivitySegment(
  { sessionId: 'two-turns' },
  {
    speaker: 'user',
    text: 'second',
    timestamp: '2026-07-27T10:01:00.000Z',
    clientRequestId: 'request-two',
  },
  [{
    kind: 'commentary',
    message: 'Late previous diagnostic',
    timestamp: '2026-07-27T10:01:31.000Z',
    turnId: 'turn-one',
    clientRequestId: 'request-one',
    itemId: 'late-previous-live-diagnostic',
  }, {
    kind: 'commentary',
    message: 'Current diagnostic',
    timestamp: '2026-07-27T10:01:03.000Z',
    turnId: 'turn-two',
    clientRequestId: 'request-two',
    itemId: 'current-live-diagnostic',
  }]
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(liveTurnSegment.entries.map((entry) => entry.itemId).sort())),
  ['current-live-activity', 'current-live-diagnostic'].sort(),
  'live Thinking must reject late activity from a previous explicit user turn regardless of timestamp'
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

const startedCommand = context.normalizeThinkingActivityForModel({
  activityKey: 'command-started-no-output',
  activityRevision: 1,
  turnId: 'turn-command-started',
  itemId: 'command-started',
  kind: 'command',
  command: 'node started.js',
  text: 'node started.js',
  startedAt: '2026-07-27T10:02:00.000Z',
  timestamp: '2026-07-27T10:02:01.000Z',
}, 4);
const renderedStartedCommand = context.createThinkingOperationEntry(
  startedCommand,
  4,
  'session::started-command',
  {}
);
assert.strictEqual(
  renderedStartedCommand.querySelector('[data-thinking-field-key="Output"]'),
  null,
  'a projected command summary must not be duplicated as command output'
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
const originalOutputField = originalOutput.closest('[data-thinking-field-key]');
originalOutput.scrollTop = 17;
originalOutput.scrollLeft = 23;
const originalSummary = first.querySelector(':scope > summary');
originalSummary.tabIndex = 0;
originalSummary.focus();
const originalBody = first.querySelector('.thinking-operation-body');
const unchangedHistory = dom.window.document.createElement('div');
unchangedHistory.appendChild(context.createThinkingOperationEntry(baseEntry, 0, 'session::thinking', {}));
context.patchThinkingHistoryList(history, unchangedHistory, 'session::thinking');
assert.strictEqual(
  first.querySelector('.thinking-operation-body'),
  originalBody,
  'unchanged keyed Thinking rows should retain their DOM and reader-local state'
);
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
assert.strictEqual(
  first.querySelector(':scope > summary'),
  originalSummary,
  'changed Thinking rows must retain their summary DOM'
);
assert.strictEqual(
  first.querySelector('.thinking-operation-body'),
  originalBody,
  'changed Thinking rows must retain their body DOM'
);
assert.strictEqual(
  patchedOutput.closest('[data-thinking-field-key]'),
  originalOutputField,
  'changed Thinking rows must retain stable field DOM'
);
assert.strictEqual(
  patchedOutput,
  originalOutput,
  'changed Thinking rows must update preformatted output in place'
);
assert.strictEqual(patchedOutput.scrollTop, 17, 'narrow patches should preserve nested output scrollTop');
assert.strictEqual(patchedOutput.scrollLeft, 23, 'narrow patches should preserve nested output scrollLeft');
assert.strictEqual(
  dom.window.document.activeElement,
  first.querySelector(':scope > summary'),
  'narrow patches should restore keyboard focus inside an expanded operation'
);

const longOutput = Array.from({ length: 40 }, (_, index) => `output line ${index}`).join('\n');
const expandable = context.createThinkingOperationEntry({
  ...baseEntry,
  groupKey: 'command:expandable',
  activityKeys: ['activity-expandable'],
  output: longOutput,
  outputTruncated: true,
}, 0, 'session::expandable', {});
dom.window.document.body.appendChild(expandable);
const outputField = expandable.querySelector('[data-thinking-field-key="Output"]');
const outputContent = outputField.querySelector('.thinking-operation-code');
const outputToggle = outputField.querySelector('.thinking-expand-toggle');
assert(outputToggle, 'long tool output should expose an expand control');
assert.strictEqual(outputToggle.getAttribute('aria-expanded'), 'false');
assert.strictEqual(outputContent.textContent, longOutput, 'collapsed output must retain its complete text in the DOM');
assert(outputField.querySelector('.thinking-source-truncation-note'), 'upstream truncation must be disclosed');
outputToggle.click();
assert.strictEqual(outputToggle.getAttribute('aria-expanded'), 'true');
assert(outputContent.classList.contains('is-expanded'));

const structuredTruncation = context.createThinkingOperationEntry({
  ...baseEntry,
  groupKey: 'tool:structured-truncation',
  category: 'tool',
  output: null,
  arguments: {
    truncated: true,
    preview: 'retained request input',
  },
  progress: null,
  progressTruncated: true,
  stderr: 'retained stderr output',
  outputTruncated: true,
  result: null,
  resultTruncated: true,
  fileChangesTruncated: true,
}, 0, 'session::structured-truncation', {});
assert(
  structuredTruncation
    .querySelector('[data-thinking-field-key="Arguments"]')
    ?.querySelector('.thinking-source-truncation-note'),
  'structured retention markers must disclose that request input was truncated upstream'
);
assert(
  structuredTruncation
    .querySelector('[data-thinking-field-key="Stderr"]')
    ?.querySelector('.thinking-source-truncation-note'),
  'stderr-only output must disclose an upstream output truncation flag'
);
for (const label of ['Progress', 'Result', 'File changes retention']) {
  const retainedField = structuredTruncation.querySelector(`[data-thinking-field-key="${label}"]`);
  assert(retainedField, `${label} should remain visible when its retained value was fully discarded`);
  assert(
    retainedField.querySelector('.thinking-source-truncation-note'),
    `${label} should disclose that only retained content is available`
  );
}
const literalTruncationJson = context.createThinkingOperationEntry({
  ...baseEntry,
  groupKey: 'command:literal-truncation-json',
  output: '{"truncated": true, "meaning": "ordinary command output"}',
  outputTruncated: false,
}, 0, 'session::literal-truncation-json', {});
assert.strictEqual(
  literalTruncationJson.querySelector('.thinking-source-truncation-note'),
  null,
  'ordinary command output containing a truncated property must not trigger a false retention warning'
);

const expandableHistory = dom.window.document.createElement('div');
expandableHistory.appendChild(expandable);
const updatedExpandableHistory = dom.window.document.createElement('div');
const updatedLongOutput = `${longOutput}\nlate retained output`;
updatedExpandableHistory.appendChild(context.createThinkingOperationEntry({
  ...baseEntry,
  groupKey: 'command:expandable',
  activityKeys: ['activity-expandable'],
  output: updatedLongOutput,
  outputTruncated: true,
  activityRevision: 2,
}, 0, 'session::expandable', {}));
context.patchThinkingHistoryList(expandableHistory, updatedExpandableHistory, 'session::expandable');
const patchedExpandable = expandableHistory.firstElementChild;
assert.strictEqual(
  patchedExpandable.querySelector('.thinking-expand-toggle').getAttribute('aria-expanded'),
  'true',
  'expanded tool fields must stay expanded after a live keyed patch'
);
assert.strictEqual(
  patchedExpandable.querySelector('[data-thinking-field-key="Output"] pre').textContent,
  updatedLongOutput
);

const longNarrativeText = `commentary ${'full text '.repeat(80)}`.trim();
const narrative = context.createThinkingNarrativeEntry({
  groupKey: 'commentary:expandable',
  kind: 'commentary',
  text: longNarrativeText,
  textTruncated: false,
  timestamp: '2026-07-27T10:00:00.000Z',
}, 0, 'session::narrative', {});
assert.strictEqual(narrative.querySelector('.thinking-history-text').textContent.trim(), longNarrativeText);
assert(narrative.querySelector('.thinking-expand-toggle'), 'long Commentary should expose an expand control');

const mathNarrativeText = String.raw`The pooled result is:

\[
\Delta P_{\mathrm{pooled}}
\]`;
const mathNarrative = context.createThinkingNarrativeEntry({
  groupKey: 'commentary:math',
  kind: 'commentary',
  text: mathNarrativeText,
  timestamp: '2026-07-27T10:01:00.000Z',
}, 0, 'session::math-narrative', {});
const mathNarrativeBody = mathNarrative.querySelector('.thinking-history-text');
assert(mathNarrativeBody.classList.contains('markdown-body'));
assert.strictEqual(
  mathNarrativeBody.querySelectorAll('.markdown-math-block').length,
  1,
  'Thinking commentary must pass display math through the Markdown renderer'
);
assert.strictEqual(
  mathNarrativeBody.querySelector('.markdown-math-block').textContent,
  String.raw`\[
\Delta P_{\mathrm{pooled}}
\]`
);

const changedTextKey = context.thinkingEntryViewportKey({
  ...baseEntry,
  text: 'a completely different live payload',
}, 99);
assert.strictEqual(changedTextKey, 'thinking|command:stable', 'viewport identity must not depend on text or index');
assert.strictEqual(
  context.thinkingEntryKey({
    groupKey: 'generic-group-before-enrichment',
    callId: 'call-stable',
    category: 'activity',
  }, 0),
  context.thinkingEntryKey({
    groupKey: 'specific-group-after-enrichment',
    callId: 'call-stable',
    turnId: 'turn-late',
    category: 'tool',
  }, 0),
  'late context/category enrichment must not replace an existing entity row'
);
assert.strictEqual(
  context.thinkingEntryKey({
    activityKey: 'activity-stable',
    category: 'reasoning',
  }, 0),
  context.thinkingEntryKey({
    activityKey: 'activity-stable',
    itemId: 'item-arrived-later',
    category: 'reasoning',
  }, 0),
  'a late itemId must not replace an existing activity row'
);
assert.notStrictEqual(
  context.thinkingEntriesRenderVersion([{ ...baseEntry, text: 'first revision', activityRevision: 1 }]),
  context.thinkingEntriesRenderVersion([{ ...baseEntry, text: 'second revision', activityRevision: 2 }]),
  'same-row content growth must change the render version used for unread state'
);

const rawSubagent = context.normalizeThinkingActivityForModel({
  timestamp: '2026-07-25T08:32:06.887Z',
  kind: 'notification',
  method: 'item/completed',
  data: {
    item: {
      type: 'subAgentActivity',
      id: 'subagent-interacted',
      kind: 'interacted',
      agentThreadId: 'child-thread',
      agentPath: '/root/review_code',
    },
    threadId: 'parent-thread',
    turnId: 'turn-subagent',
  },
}, 0);
assert(rawSubagent, 'legacy notification-shaped sub-agent activity must remain visible in Thinking');
assert.strictEqual(rawSubagent.kind, 'collaboration');
assert.strictEqual(rawSubagent.status, 'interacted');
assert.strictEqual(rawSubagent.final, true);
assert.strictEqual(rawSubagent.agentThreadId, 'child-thread');
assert.strictEqual(rawSubagent.agentPath, '/root/review_code');
assert.strictEqual(rawSubagent.parentThreadId, 'parent-thread');
const renderedSubagent = context.createThinkingOperationEntry(rawSubagent, 0, 'session::subagent', {});
assert(renderedSubagent.textContent.includes('Sub-agent /root/review_code'));
assert(renderedSubagent.querySelector('.thinking-operation-status').classList.contains('completed'));

const interruptedSubagent = context.normalizeThinkingActivityForModel({
  kind: 'notification',
  method: 'item/completed',
  data: {
    item: {
      type: 'subAgentActivity',
      id: 'subagent-interrupted',
      kind: 'interrupted',
      agentThreadId: 'child-thread',
      agentPath: '/root/review_code',
    },
    threadId: 'parent-thread',
    turnId: 'turn-subagent',
  },
}, 1);
const renderedInterrupted = context.createThinkingOperationEntry(
  interruptedSubagent,
  1,
  'session::subagent',
  {}
);
assert(renderedInterrupted.querySelector('.thinking-operation-status').classList.contains('failed'));

console.log('thinking entry rendering assertions passed');
