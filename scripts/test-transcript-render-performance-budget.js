const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const app = fs.readFileSync(appPath, 'utf8');

function extractFunctionSource(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(app);
  assert(match, `${name} was not found`);
  const start = match.index;
  let index = start + match[0].length - 1;
  let parenDepth = 0;
  let bodyStarted = false;
  for (; index < app.length; index += 1) {
    const char = app[index];
    if (char === '(') parenDepth += 1;
    if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (char === '{' && parenDepth === 0) {
      bodyStarted = true;
      break;
    }
  }
  assert(bodyStarted, `${name} body was not found`);
  let depth = 0;
  for (; index < app.length; index += 1) {
    const char = app[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return app.slice(start, index + 1);
      }
    }
  }
  throw new Error(`${name} body did not terminate`);
}

const sandbox = {
  TRANSCRIPT_RENDER_MIN_WINDOW: 32,
  TRANSCRIPT_RENDER_CHAR_BUDGET: 90000,
  TRANSCRIPT_RENDER_LINE_BUDGET: 3000,
  TRANSCRIPT_RENDER_CODE_FENCE_BUDGET: 180,
};
vm.createContext(sandbox);
vm.runInContext([
  extractFunctionSource('estimateTranscriptEntryRenderCost'),
  extractFunctionSource('selectTranscriptRenderWindow'),
].join('\n'), sandbox);

const heavyEntries = Array.from({ length: 220 }, (_, index) => ({
  speaker: index % 2 ? 'agent' : 'user',
  timestamp: new Date(2026, 5, 1, 0, index).toISOString(),
  text: [
    `entry ${index}`,
    '```text',
    'x'.repeat(3000),
    '```',
  ].join('\n'),
}));
const heavyWindow = sandbox.selectTranscriptRenderWindow(heavyEntries, 160, { enforceBudget: true });
assert(
  heavyWindow.renderedTranscript.length < 160,
  'heavy histories should not render the full 160-message default window'
);
assert(
  heavyWindow.renderedTranscript.length >= sandbox.TRANSCRIPT_RENDER_MIN_WINDOW,
  'heavy histories should preserve a minimum useful recent window'
);
assert.strictEqual(
  heavyWindow.renderedTranscript.at(-1),
  heavyEntries.at(-1),
  'budgeted windows must keep the latest transcript entry'
);

const userExpandedWindow = sandbox.selectTranscriptRenderWindow(heavyEntries, 220, {
  enforceBudget: true,
  preserveRequestedLimit: true,
});
assert.strictEqual(
  userExpandedWindow.renderedTranscript.length,
  220,
  'Load older should honor the user-expanded transcript window instead of applying the performance budget again'
);
assert.strictEqual(
  userExpandedWindow.hiddenTranscriptCount,
  0,
  'Load older should reduce the hidden count when the requested window covers the conversation'
);

const lightEntries = Array.from({ length: 220 }, (_, index) => ({
  speaker: index % 2 ? 'agent' : 'user',
  timestamp: new Date(2026, 5, 1, 0, index).toISOString(),
  text: `short ${index}`,
}));
const lightWindow = sandbox.selectTranscriptRenderWindow(lightEntries, 160, { enforceBudget: true });
assert.strictEqual(
  lightWindow.renderedTranscript.length,
  160,
  'light histories should keep the normal 160-message default window'
);

const renderTranscriptSource = extractFunctionSource('renderTranscript');
assert(
  renderTranscriptSource.includes('selectTranscriptRenderWindow('),
  'renderTranscript should use the budgeted transcript window selector'
);
assert(
  renderTranscriptSource.includes('buildThinkingEntriesForSession(session, {')
    && renderTranscriptSource.includes('transcriptEntries: renderedTranscript'),
  'thinking records should be paired only for the transcript window that will be rendered'
);
const thinkingPairingSource = extractFunctionSource('buildThinkingEntriesForSession');
assert(
  thinkingPairingSource.includes('function lowerBoundTimestamp')
    && !thinkingPairingSource.includes('thinkingDiagnostics\n      .filter'),
  'thinking pairing should index timestamps instead of filtering every diagnostic for every user turn'
);
const longRunTranscript = Array.from({ length: 160 }, (_, index) => ({
  speaker: index % 2 === 0 ? 'user' : 'agent',
  timestamp: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
  text: `message ${index}`,
}));
const longRunDiagnostics = Array.from({ length: 10_000 }, (_, index) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1) + index * 950).toISOString(),
  kind: 'reasoning',
  message: `diagnostic ${index}`,
}));
const longRunContext = vm.createContext({
  getTranscriptForSession: () => longRunTranscript,
  getThinkingDiagnosticsForSession: () => longRunDiagnostics,
  getProjectedThinkingActivities: () => [],
  mergeProjectedThinkingEntries: (diagnostics, activities) => [...diagnostics, ...activities].slice(-160),
});
vm.runInContext(thinkingPairingSource, longRunContext);
const pairingStartedAt = process.hrtime.bigint();
let pairedSegments = [];
for (let iteration = 0; iteration < 20; iteration += 1) {
  pairedSegments = longRunContext.buildThinkingEntriesForSession({ sessionId: 'long-run' });
}
const pairingElapsedMs = Number(process.hrtime.bigint() - pairingStartedAt) / 1e6;
assert.strictEqual(pairedSegments.length, 80, 'every visible user turn should retain its Thinking segment');
assert(
  pairingElapsedMs < Number(process.env.TRANSCRIPT_LONG_RUN_PAIRING_MAX_MS || 1500),
  `20 long-run Thinking pairing passes took ${pairingElapsedMs.toFixed(1)}ms`
);

const diagnosticBudgetSandbox = {
  CLIENT_DIAGNOSTIC_ENTRY_LIMIT: 10000,
  CLIENT_DIAGNOSTIC_APPROX_BYTE_LIMIT: 8 * 1024 * 1024,
  CLIENT_DIAGNOSTIC_TRIM_TARGET_BYTES: 6 * 1024 * 1024,
};
vm.createContext(diagnosticBudgetSandbox);
vm.runInContext([
  extractFunctionSource('estimateSessionCacheValueBytes'),
  extractFunctionSource('trimDiagnosticsForClient'),
].join('\n'), diagnosticBudgetSandbox);
const oversizedDiagnostics = Array.from({ length: 500 }, (_, index) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  kind: 'tool-output',
  message: `diagnostic ${index}`,
  data: { output: 'z'.repeat(24_000) },
}));
const trimmedDiagnostics = diagnosticBudgetSandbox.trimDiagnosticsForClient(oversizedDiagnostics);
assert(
  trimmedDiagnostics.length < oversizedDiagnostics.length,
  'large diagnostic payloads should be trimmed by approximate bytes before reaching the entry-count limit'
);
assert.strictEqual(
  trimmedDiagnostics.at(-1).message,
  oversizedDiagnostics.at(-1).message,
  'diagnostic byte trimming must retain the latest event'
);
assert(
  diagnosticBudgetSandbox.estimateSessionCacheValueBytes(trimmedDiagnostics)
    <= diagnosticBudgetSandbox.CLIENT_DIAGNOSTIC_APPROX_BYTE_LIMIT,
  'the retained diagnostic window should stay within the client byte budget'
);
assert(
  renderTranscriptSource.includes('preserveRequestedLimit: explicitVisibleLimit > 0'),
  'renderTranscript should disable the performance budget after the user clicks Load older'
);

const statusWindowSource = extractFunctionSource('renderStatusWindow');
assert(
  !statusWindowSource.includes('buildThinkingEntriesForSession(session)'),
  'status window should not run full transcript/diagnostic thinking pairing just to show a count'
);
const sessionDetailsSource = extractFunctionSource('renderSessionDetails');
assert(
  !sessionDetailsSource.includes('renderLocaleLabels()'),
  'Session updates should not rescan the full document just to refresh static locale labels'
);
assert(
  app.includes('initializePersistentUiState();\napplyUiTheme();\nrenderLocaleLabels();\nboot();'),
  'static locale labels should be applied once during boot instead of every Session render'
);
const performRefreshSource = extractFunctionSource('performRefresh');
assert(
  performRefreshSource.includes('renderRefreshViews();'),
  'periodic refreshes should update the targeted visible views instead of rebuilding hidden dialogs'
);
assert(
  app.includes("state.navigatorCollapsed = !state.navigatorCollapsed;\n  writeLocalStorageJson(NAVIGATOR_COLLAPSED_STORAGE_KEY, state.navigatorCollapsed);\n  renderNavigatorLayout();"),
  'navigator collapse should update its layout without triggering a full render pass'
);

const localizationDom = new JSDOM(`<!doctype html><body>
  <main>
    <button title="Translate title">Translate label</button>
    <section id="session-log">
      ${Array.from({ length: 2500 }, (_, index) => `<p title="history ${index}">history ${index}</p>`).join('')}
    </section>
  </main>
</body>`);
let translatedStaticValues = 0;
const localizationSandbox = vm.createContext({
  document: localizationDom.window.document,
  NodeFilter: localizationDom.window.NodeFilter,
  translateStaticText: (value) => {
    translatedStaticValues += 1;
    return value;
  },
});
vm.runInContext([
  extractFunctionSource('shouldPruneLocalizationElement'),
  extractFunctionSource('applyStaticLocalization'),
].join('\n'), localizationSandbox);
localizationSandbox.applyStaticLocalization(localizationDom.window.document.body);
assert(
  translatedStaticValues < 10,
  `static localization inspected ${translatedStaticValues} values inside the transcript subtree`
);
const localizationSource = extractFunctionSource('applyStaticLocalization');
assert(
  localizationSource.includes('NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT')
    && localizationSource.includes('NodeFilter.FILTER_REJECT'),
  'static localization should prune transcript and Markdown element subtrees during traversal'
);
assert(
  !localizationSource.includes("root.querySelectorAll('[placeholder], [aria-label], [title]')"),
  'static localization should not rescan every transcript element for translatable attributes'
);

const cacheSandbox = {
  SESSION_CACHE_HISTORY_LIMIT: 3,
  SESSION_CACHE_APPROX_BYTE_LIMIT: 20_000,
  state: {
    selectedHostId: 'host',
    selectedSessionId: 'selected',
    eventSourceKey: null,
    sessions: [
      { hostId: 'host', sessionId: 'selected', live: false },
      { hostId: 'host', sessionId: 'live', live: true },
      ...Array.from({ length: 6 }, (_, index) => ({
        hostId: 'host',
        sessionId: `history-${index}`,
        live: false,
      })),
    ],
    transcripts: new Map(),
    diagnostics: new Map(),
    receivedFiles: new Map(),
    alerts: new Map(),
    dismissedAlerts: new Map(),
    requests: new Map(),
    runtime: new Map(),
    runtimeApplyGenerations: new Map(),
    runtimeStreamGenerations: new Map(),
    streamStatus: new Map(),
    transcriptTombstones: new Map(),
    transcriptVisibleLimits: new Map(),
    transcriptEntryCounts: new Map(),
    messageReadGates: new Map(),
    transcriptNotificationRenderVersions: new Map(),
    transcriptNotificationRenderedAssistantSeq: new Map(),
    transcriptUnread: new Set(),
    transcriptUserDetached: new Set(),
    thinkingPanels: new Map(),
    thinkingScrollPositions: new Map(),
    thinkingEntryCounts: new Map(),
    thinkingEntryVersions: new Map(),
    thinkingUnread: new Set(),
    fullTranscriptLoaded: new Set(),
    historyLoading: new Set(),
    messageReadRenderReady: new Set(),
    sessionCacheAccess: new Map(),
    sessionCacheWeights: new Map(),
    codexControls: {
      activeDraftsBySession: new Map(),
      composerSubmissionsBySession: new Map(),
      interruptOperationsBySession: new Map(),
      skillOptionsBySession: new Map(),
      skillOptionsRetryAfterBySession: new Map(),
      sessionOptionsByKey: new Map(),
      persistedSessionOptionKeys: new Set(),
      apiSwitchNoticesBySession: new Map(),
      steerQueue: [],
    },
  },
  makeSessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
  getSessionKey: (session) => session ? `${session.hostId}::${session.sessionId}` : null,
  runtimeIsActive: () => false,
  persistedComposerOptionWrites: 0,
  persistComposerSessionOptions: () => {
    cacheSandbox.persistedComposerOptionWrites += 1;
  },
};
vm.createContext(cacheSandbox);
vm.runInContext([
  extractFunctionSource('estimateSessionCacheValueBytes'),
  extractFunctionSource('touchSessionCacheKey'),
  extractFunctionSource('setSessionCacheWeightBytes'),
  extractFunctionSource('setSessionCacheWeightComponent'),
  extractFunctionSource('sessionCacheProtectedKeys'),
  extractFunctionSource('evictSessionCacheKey'),
  extractFunctionSource('pruneSessionCaches'),
].join('\n'), cacheSandbox);

const cacheKeys = ['selected', 'live', ...Array.from({ length: 6 }, (_, index) => `history-${index}`)]
  .map((sessionId) => `host::${sessionId}`);
for (const [index, key] of cacheKeys.entries()) {
  cacheSandbox.state.transcripts.set(key, [{ text: 'x'.repeat(1200 + index) }]);
  cacheSandbox.state.diagnostics.set(key, [{ message: 'y'.repeat(500 + index) }]);
  cacheSandbox.state.receivedFiles.set(key, [{ name: `${key}.txt` }]);
  cacheSandbox.state.alerts.set(key, [{ message: `${key} alert` }]);
  cacheSandbox.state.transcriptVisibleLimits.set(key, 160);
  cacheSandbox.state.fullTranscriptLoaded.add(key);
  cacheSandbox.touchSessionCacheKey(key, index + 1);
  cacheSandbox.setSessionCacheWeightComponent(key, 'transcript', cacheSandbox.state.transcripts.get(key));
  cacheSandbox.setSessionCacheWeightComponent(key, 'diagnostics', cacheSandbox.state.diagnostics.get(key));
}
cacheSandbox.pruneSessionCaches({ maxHistoryEntries: 3, maxApproxBytes: Infinity });
assert(cacheSandbox.state.transcripts.has('host::selected'), 'the selected Session cache must be protected');
assert(cacheSandbox.state.transcripts.has('host::live'), 'live Session caches must be protected');
assert(!cacheSandbox.state.transcripts.has('host::history-0'), 'the oldest history cache should be evicted first');
assert(!cacheSandbox.state.diagnostics.has('host::history-0'), 'history cache eviction must include diagnostics');
assert(!cacheSandbox.state.receivedFiles.has('host::history-0'), 'history cache eviction must include file metadata');
assert(!cacheSandbox.state.alerts.has('host::history-0'), 'history cache eviction must include alerts');
assert(
  !cacheSandbox.state.fullTranscriptLoaded.has('host::history-0'),
  'an evicted history Session must fetch detail again when reopened'
);
assert.strictEqual(
  [...cacheSandbox.state.transcripts.keys()].filter((key) => key.includes('history-')).length,
  3,
  'the history cache should retain only the configured number of recent Sessions'
);

for (let index = 0; index < 6; index += 1) {
  const key = `host::runtime-only-${index}`;
  cacheSandbox.state.runtime.set(key, { phase: 'closed', generation: index });
  cacheSandbox.state.runtimeApplyGenerations.set(key, index);
  cacheSandbox.state.runtimeStreamGenerations.set(key, index);
  cacheSandbox.state.streamStatus.set(key, { connection: 'closed' });
  cacheSandbox.state.codexControls.sessionOptionsByKey.set(key, { model: `model-${index}` });
  cacheSandbox.state.codexControls.persistedSessionOptionKeys.add(key);
  cacheSandbox.touchSessionCacheKey(key, 100 + index);
}
cacheSandbox.pruneSessionCaches({ maxHistoryEntries: 3, maxApproxBytes: Infinity });
assert.strictEqual(
  [...cacheSandbox.state.runtime.keys()].filter((key) => key.includes('runtime-only-')).length,
  3,
  'fresh Sessions with only runtime state must still participate in history cache eviction'
);
assert(
  !cacheSandbox.state.codexControls.sessionOptionsByKey.has('host::runtime-only-0'),
  'runtime-only eviction must remove stale persisted composer options'
);
assert(
  !cacheSandbox.state.codexControls.persistedSessionOptionKeys.has('host::runtime-only-0'),
  'runtime-only eviction must remove the persisted-options marker'
);
assert.strictEqual(
  cacheSandbox.persistedComposerOptionWrites,
  1,
  'one cache prune must compact persisted composer options with one storage write'
);

cacheSandbox.state.requests.set('host::history-0', [{ status: 'pending' }]);
cacheSandbox.state.transcripts.set('host::history-0', [{ text: 'pending request transcript' }]);
cacheSandbox.touchSessionCacheKey('host::history-0', 0);
cacheSandbox.setSessionCacheWeightComponent(
  'host::history-0',
  'transcript',
  cacheSandbox.state.transcripts.get('host::history-0')
);
cacheSandbox.pruneSessionCaches({ maxHistoryEntries: 0, maxApproxBytes: 0 });
assert(
  cacheSandbox.state.transcripts.has('host::history-0'),
  'Sessions with pending requests must remain protected even when the history budget is exhausted'
);

const exportDialogSource = extractFunctionSource('renderExportDialog');
assert(
  exportDialogSource.indexOf('if (!dialog.open)') >= 0
    && exportDialogSource.indexOf('if (!dialog.open)') < exportDialogSource.indexOf('getExportTranscriptEntries(session)'),
  'a closed export dialog must return before scanning transcript entries and files'
);

console.log(`transcript render performance budget checks passed (${pairingElapsedMs.toFixed(1)}ms for 20 long-run Thinking pairing passes)`);
