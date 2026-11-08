const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MessageNotificationClient = require('../apps/mobile-web/public/message-notification-client');
const RelayApi = require('../apps/mobile-web/public/relay-api');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const html = fs.readFileSync('apps/mobile-web/public/index.html', 'utf8');
const styles = fs.readFileSync('apps/mobile-web/public/styles.css', 'utf8');

function assertContains(source, needle, message) {
  assert(source.includes(needle), `${message}\nExpected to find: ${needle}`);
}

assertContains(
  app,
  "const MESSAGE_READ_RECEIPTS_STORAGE_KEY = 'mobile-codex-remote.message-read-receipts.v2'",
  'browser receipts must use the sequence-based v2 schema'
);
assert(!app.includes('simpleMessageHash'), 'mutable transcript text hashes must not identify assistant messages');
assert(!app.includes('getLatestAssistantMessageMarker'), 'transcript summary markers must not drive unread state');
assert(!app.includes('lastReadMessageKey'), 'legacy marker fields must stay inside the migration client');
assertContains(app, '/assistant-messages?', 'browser catch-up must page the authoritative Relay projection');
assertContains(app, "'session.assistant_projection'", 'browser SSE must consume assistant projection events');
assertContains(app, 'payload.assistantProjection', 'stream reset must restore the assistant projection');
assertContains(app, 'assistantAfter', 'SSE reconnect must send the durable notified cursor');
assertContains(app, 'ReadEligibilityGate', 'read advancement must use the strict eligibility gate');
const maybeAdvanceReadReceiptSource = app.slice(
  app.indexOf('async function maybeAdvanceReadReceipt('),
  app.indexOf('function completeTranscriptNotificationRender(', app.indexOf('async function maybeAdvanceReadReceipt('))
);
assertContains(
  maybeAdvanceReadReceiptSource,
  'requireCoverageAfterSeq: readCursor',
  'automatic read advancement must request canonical coverage at the current read cursor'
);
assertContains(
  maybeAdvanceReadReceiptSource,
  'authoritativeAfterSeq: coverage.afterSeq',
  'automatic read advancement must pass the proven coverage boundary to the receipt client'
);
assert(
  !maybeAdvanceReadReceiptSource.includes('latestAssistantSeq || 0) > renderedAssistantSeq'),
  'a compact projection high-water must not block reading DOM-rendered assistant identities'
);
assertContains(app, 'drainOutboxWithElection', 'notification presentation must use one elected tab');
assertContains(
  app,
  "navigator.locks.request(key, { mode: 'exclusive' }, callback)",
  'receipt and outbox read/merge/write transactions must use an exclusive Web Lock'
);
assert(
  !app.includes('MESSAGE_RECEIPT_WRITE_LEASE_STORAGE_KEY')
    && !app.includes('MESSAGE_OUTBOX_WRITE_LEASE_STORAGE_KEY'),
  'notification persistence must not use a non-exclusive localStorage lease'
);
assertContains(app, 'tag: item.alertId', 'system notifications must use the deterministic alert ID');
assert(
  !app.includes("sessionListQuery({ refresh: '1' })"),
  'periodic browser refresh must not force a full Host discovery scan'
);

const performRefreshSource = app.slice(
  app.indexOf('async function performRefresh('),
  app.indexOf('function addSessionIdentityValue', app.indexOf('async function performRefresh('))
);
assert(!performRefreshSource.includes('await syncAssistantProjectionsForSessions'));
assert(
  performRefreshSource.indexOf('renderAll();') < performRefreshSource.indexOf('scheduleAssistantProjectionSync'),
  'initial session UI must render before background notification catch-up is scheduled'
);

const selectSessionSource = app.slice(
  app.indexOf('async function selectSession('),
  app.indexOf('function reconcileRefreshedSessions', app.indexOf('async function selectSession('))
);
assert(!selectSessionSource.includes('markSessionMessagesRead'), 'selection must not mark content read before rendering');
assertContains(selectSessionSource, 'establishMessageReadFollow', 'selection should only establish a trusted follow candidate');

const selectConversationSource = app.slice(
  app.indexOf('async function selectConversation('),
  app.indexOf('async function selectSession(', app.indexOf('async function selectConversation('))
);
assertContains(
  selectConversationSource,
  'const targetSession = conversation.preferredSession || null;',
  'ordinary card selection must keep routing to the preferred variant'
);
assert(
  !selectConversationSource.includes('getUnreadTargetForGroup'),
  'unread routing must not hijack an ordinary conversation-card click'
);
assertContains(app, "unreadButton.className = 'conversation-unread-button'", 'unread state should expose a real button');
assertContains(app, 'selectSession(unreadTarget.session', 'the unread button must open the resolved unread variant');

assertContains(html, '<script src="/message-notification-client.js?', 'notification client must load before app.js');
assert(
  html.indexOf('/message-notification-client.js') < html.indexOf('/app.js'),
  'notification client must be available while app.js initializes'
);
assertContains(html, 'id="message-notification-button"', 'header should expose the notification bell');
assertContains(html, 'aria-label="No unread Codex messages"', 'notification bell should have an initial accessible label');
assertContains(html, 'id="mark-all-message-notifications-read-button"', 'panel should expose explicit mark-all-read');
assertContains(styles, '.conversation-unread-button::before', 'sidebar should render an unread indicator');
assertContains(styles, '.message-notification-button.has-unread', 'bell should expose unread state');
assertContains(app, "button.setAttribute('aria-label', button.title)", 'notification bell should announce changing unread state');

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
    this.options = [];
    this.listeners = new Map();
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.classList = {
      toggle: () => {},
      add: () => {},
      remove: () => {},
      contains: () => false,
    };
  }

  addEventListener(type, handler) { this.listeners.set(type, handler); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] || null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
}

async function main() {
  const elements = new Map();
  const storage = new Map();
  let receiptStorageWrites = 0;
  let outboxStorageWrites = 0;
  let receiptStorageReads = 0;
  let outboxStorageReads = 0;
  let receiptQuotaFailuresRemaining = 0;
  let outboxQuotaFailuresRemaining = 0;
  let messageChannelListener = null;
  const notificationBroadcasts = [];
  const immediate = (fn) => { fn(); return 0; };
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
    TextEncoder,
    setTimeout: immediate,
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
  };

  sandbox.document = {
    body: new ElementStub('body'),
    documentElement: new ElementStub('html'),
    scrollingElement: new ElementStub('scrolling'),
    activeElement: null,
    visibilityState: 'visible',
    hasFocus: () => true,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new ElementStub(id));
      return elements.get(id);
    },
    createElement: (tag) => new ElementStub(tag),
    createTextNode: (text) => ({ textContent: text }),
    createDocumentFragment: () => new ElementStub('fragment'),
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  sandbox.document.body.appendChild = (child) => child;
  sandbox.NodeFilter = { SHOW_TEXT: 4 };
  sandbox.navigator = {
    userAgent: 'node',
    locks: {
      request: async (_name, _options, callback) => callback({ name: 'test-lock' }),
    },
  };
  sandbox.window = {
    MessageNotificationClient,
    RemoteCodexRelayApi: RelayApi,
    RemoteCodexSessionModal: require('../apps/mobile-web/public/session-modal-controller'),
    RemoteCodexSessionRuntimeState: require('../apps/mobile-web/public/session-runtime-state'),
    RemoteCodexStructuredText: require('../apps/mobile-web/public/structured-text'),
    crypto: { randomUUID: () => 'notification-test-tab' },
    localStorage: {
      getItem: (key) => {
        if (key === 'mobile-codex-remote.message-read-receipts.v2') receiptStorageReads += 1;
        if (key === 'mobile-codex-remote.message-notification-outbox.v1') outboxStorageReads += 1;
        return storage.get(key) || null;
      },
      setItem: (key, value) => {
        if (key === 'mobile-codex-remote.message-read-receipts.v2') {
          receiptStorageWrites += 1;
          if (receiptQuotaFailuresRemaining > 0) {
            receiptQuotaFailuresRemaining -= 1;
            throw Object.assign(
              new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota."),
              { name: 'QuotaExceededError' }
            );
          }
        }
        if (key === 'mobile-codex-remote.message-notification-outbox.v1') {
          outboxStorageWrites += 1;
          if (outboxQuotaFailuresRemaining > 0) {
            outboxQuotaFailuresRemaining -= 1;
            throw Object.assign(
              new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota."),
              { name: 'QuotaExceededError' }
            );
          }
        }
        storage.set(key, value);
      },
      removeItem: (key) => storage.delete(key),
    },
    navigator: sandbox.navigator,
    matchMedia: () => ({ matches: false }),
    setTimeout: immediate,
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame: immediate,
    fetch: (...args) => sandbox.fetch(...args),
    BroadcastChannel: class BroadcastChannelStub {
      addEventListener(_type, listener) { messageChannelListener = listener; }
      postMessage(message) { notificationBroadcasts.push(message); }
    },
    addEventListener() {},
    location: { origin: 'http://127.0.0.1:8897', search: '' },
    alert() {},
    confirm: () => true,
    prompt: () => '',
    getComputedStyle: () => ({ overflowY: 'visible' }),
  };
  sandbox.fetch = async () => ({
    ok: true,
    json: async () => ({}),
    text: async () => '',
  });

  const testHook = `
window.__messageNotificationTest = {
  state,
  makeSessionKey,
  dedupeTranscript,
  mergeAssistantProjection,
  applyAssistantProjectionForSession,
  getUnreadMessageNotifications,
  getUnreadTargetForGroup,
  hasUnreadMessagesForSession,
  markSessionMessagesRead,
  refreshMessageUnreadState,
  notificationOutboxPresenters,
  dedupeAlerts,
  getAlertsForSession,
  evictSessionCacheKey,
  catchUpAssistantProjection,
  assistantProjectionCoverageFor,
  completeTranscriptNotificationRender,
  drainMessageNotificationOutbox,
  scheduleMessageNotificationBroadcastFlush,
  settleWithConcurrency,
  syncAssistantProjectionsForSessions,
};
`;
  vm.createContext(sandbox);
  vm.runInContext(`${app}\n${testHook}`, sandbox, {
    filename: path.join(process.cwd(), 'apps', 'mobile-web', 'public', 'app.js'),
  });

  const api = sandbox.window.__messageNotificationTest;

  const metadataMerge = api.dedupeTranscript([
    {
      speaker: 'assistant',
      text: 'durable assistant metadata must survive detail hydration',
      timestamp: '2026-08-30T00:00:01.000Z',
      assistantMessageId: 'assistant-metadata-1',
      assistantSeq: 42,
      notifiable: true,
      turnId: 'turn-metadata-1',
      source: 'codex-app-server',
    },
    {
      speaker: 'assistant',
      text: 'durable assistant metadata must survive detail hydration',
      timestamp: '2026-08-30T00:00:00.000Z',
      assistantMessageId: 'assistant-metadata-1',
      assistantSeq: 0,
      notifiable: false,
      source: 'codex-jsonl',
    },
  ]);
  assert.strictEqual(metadataMerge.length, 1);
  assert.strictEqual(metadataMerge[0].assistantSeq, 42, 'older JSONL detail must not demote assistantSeq');
  assert.strictEqual(metadataMerge[0].notifiable, true, 'older JSONL detail must not demote notifiable');

  const repeatedAcrossTurns = api.dedupeTranscript([
    {
      speaker: 'assistant',
      text: 'The same valid answer can be sent in two different turns.',
      timestamp: '2026-08-30T00:01:00.000Z',
    },
    {
      speaker: 'assistant',
      text: 'The same valid answer can be sent in two different turns.',
      timestamp: '2026-08-30T00:02:00.000Z',
    },
  ]);
  assert.strictEqual(
    repeatedAcrossTurns.length,
    2,
    'unidentified messages at different event coordinates must not collapse only because their text matches'
  );

  const incompleteProjection = {
    canonicalConversationKey: 'win::cursor',
    latestAssistantSeq: 4,
    latestAssistantId: 'cursor-4',
    projectionRevision: 4,
    cursorUnknown: true,
    messages: [{ assistantMessageId: 'cursor-4', assistantSeq: 4 }],
  };
  const completedProjection = api.mergeAssistantProjection(incompleteProjection, {
    canonicalConversationKey: 'win::cursor',
    latestAssistantSeq: 4,
    latestAssistantId: 'cursor-4',
    projectionRevision: 5,
    cursorUnknown: false,
    messages: [],
  });
  assert.strictEqual(completedProjection.cursorUnknown, false, 'a newer complete cursor must clear unknown state');
  assert.deepStrictEqual(completedProjection.messages, [], 'a newer projection revision must replace stale cached pages');
  const ignoredOlderProjection = api.mergeAssistantProjection(completedProjection, incompleteProjection);
  assert.strictEqual(ignoredOlderProjection.projectionRevision, 5);
  assert.strictEqual(ignoredOlderProjection.cursorUnknown, false, 'an older incomplete cursor must be ignored');
  const completedPage = api.mergeAssistantProjection(completedProjection, {
    ...completedProjection,
    cursorUnknown: true,
    messages: [{ assistantMessageId: 'cursor-4', assistantSeq: 4 }],
  });
  assert.strictEqual(completedPage.cursorUnknown, false, 'complete state wins contradictory same-revision pages');
  assert.strictEqual(completedPage.messages.length, 1, 'same-revision catch-up pages should merge messages');
  const monotonicMessageMetadata = api.mergeAssistantProjection({
    canonicalConversationKey: 'win::metadata',
    projectionRevision: 8,
    messages: [{ assistantMessageId: 'metadata-8', assistantSeq: 8, notifiable: true }],
  }, {
    canonicalConversationKey: 'win::metadata',
    projectionRevision: 8,
    messages: [{ assistantMessageId: 'metadata-8', assistantSeq: 0, notifiable: false }],
  });
  assert.strictEqual(monotonicMessageMetadata.messages[0].assistantSeq, 8);
  assert.strictEqual(monotonicMessageMetadata.messages[0].notifiable, true);

  const originalFetch = sandbox.fetch;
  const pagedSession = {
    hostId: 'win',
    sessionId: 'revision-paging',
    assistantProjection: {
      canonicalConversationKey: 'win::revision-paging',
      latestAssistantSeq: 201,
      projectionRevision: 9,
      cursorUnknown: true,
      hasMore: true,
      messages: [],
    },
  };
  const pageMessages = (start, end) => Array.from({ length: end - start + 1 }, (_, offset) => ({
    assistantMessageId: `revision-message-${start + offset}`,
    assistantSeq: start + offset,
    notifiable: true,
  }));
  const pagedResponses = [
    {
      canonicalConversationKey: 'win::revision-paging', projectionRevision: 10,
      latestAssistantSeq: 201, messages: pageMessages(1, 100), hasMore: true, nextAfterSeq: 100,
    },
    {
      canonicalConversationKey: 'win::revision-paging', projectionRevision: 11,
      latestAssistantSeq: 201, messages: pageMessages(101, 200), hasMore: true, nextAfterSeq: 200,
    },
    {
      canonicalConversationKey: 'win::revision-paging', projectionRevision: 11,
      latestAssistantSeq: 201, messages: pageMessages(1, 100), hasMore: true, nextAfterSeq: 100,
    },
    {
      canonicalConversationKey: 'win::revision-paging', projectionRevision: 11,
      latestAssistantSeq: 201, messages: pageMessages(101, 200), hasMore: true, nextAfterSeq: 200,
    },
    {
      canonicalConversationKey: 'win::revision-paging', projectionRevision: 11,
      latestAssistantSeq: 201, messages: pageMessages(201, 201), hasMore: false, nextAfterSeq: 201,
    },
  ];
  const requestedAfterSeqs = [];
  sandbox.fetch = async (url) => {
    if (!String(url).includes('/assistant-messages?')) return originalFetch(url);
    const parsed = new URL(url, 'http://127.0.0.1:8797');
    requestedAfterSeqs.push(Number(parsed.searchParams.get('afterSeq')));
    const body = pagedResponses.shift();
    assert(body, `unexpected assistant projection request: ${url}; cursors=${requestedAfterSeqs.join(',')}`);
    return { ok: true, status: 200, json: async () => body };
  };
  const stablePaging = await api.catchUpAssistantProjection(
    pagedSession,
    pagedSession.assistantProjection,
    { deferApply: true, force: true }
  );
  assert.deepStrictEqual(
    requestedAfterSeqs,
    [0, 100, 0, 100, 200],
    'a revision change must restart pagination from the original receipt cursor'
  );
  assert.strictEqual(stablePaging.projection.projectionRevision, 11);
  assert.strictEqual(stablePaging.projection.messages.length, 201);
  assert.strictEqual(new Set(stablePaging.projection.messages.map((message) => message.assistantMessageId)).size, 201);

  const compactCoverageSession = {
    hostId: 'win',
    sessionId: 'compact-coverage',
    conversationKey: 'compact-coverage',
    assistantProjection: {
      canonicalConversationKey: 'win::compact-coverage',
      latestAssistantSeq: 7,
      latestAssistantId: 'compact-b-7',
      projectionRevision: 20,
      cursorUnknown: false,
      hasMore: false,
      messages: [
        { assistantMessageId: 'compact-stale-6', assistantSeq: 6, notifiable: true },
        { assistantMessageId: 'compact-b-7', assistantSeq: 7, notifiable: true },
      ],
    },
  };
  api.state.messageReceiptStore.set({
    ...MessageNotificationClient.emptyReceipt('win::compact-coverage'),
    readThroughAssistantSeq: 5,
    notifiedThroughAssistantSeq: 5,
  });
  const compactCoverageAfterSeqs = [];
  sandbox.fetch = async (url) => {
    if (!String(url).includes('/assistant-messages?')) return originalFetch(url);
    const parsed = new URL(url, 'http://127.0.0.1:8797');
    compactCoverageAfterSeqs.push(Number(parsed.searchParams.get('afterSeq')));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...compactCoverageSession.assistantProjection,
        messages: [
          {
            assistantMessageId: 'compact-a-6', assistantSeq: 6, notifiable: true,
            previewText: 'compact answer A',
          },
          {
            assistantMessageId: 'compact-b-7', assistantSeq: 7, notifiable: true,
            previewText: 'compact answer B',
          },
        ],
        hasMore: false,
        nextAfterSeq: 7,
      }),
    };
  };
  const compactCoverageCatchUp = await api.catchUpAssistantProjection(
    compactCoverageSession,
    compactCoverageSession.assistantProjection,
    { deferApply: true, requireCoverageAfterSeq: 5 }
  );
  assert.deepStrictEqual(
    compactCoverageAfterSeqs,
    [5],
    'a compact cache with latestAssistantSeq present must still page when read advancement needs coverage'
  );
  assert.strictEqual(compactCoverageCatchUp.authoritativeAfterSeq, 5);
  assert.deepStrictEqual(
    Array.from(compactCoverageCatchUp.projection.messages, (message) => message.assistantMessageId),
    ['compact-a-6', 'compact-b-7'],
    'an authoritative page must replace stale cached identities inside its covered suffix'
  );
  const compactCoverage = api.assistantProjectionCoverageFor(compactCoverageCatchUp.projection, 5);
  assert.strictEqual(compactCoverage?.projectionRevision, 20);
  assert.strictEqual(compactCoverage?.afterSeq, 5);
  await api.catchUpAssistantProjection(
    compactCoverageSession,
    compactCoverageCatchUp.projection,
    { deferApply: true, requireCoverageAfterSeq: 5 }
  );
  assert.deepStrictEqual(
    compactCoverageAfterSeqs,
    [5],
    'stable canonical coverage should avoid redundant pagination'
  );
  api.applyAssistantProjectionForSession(compactCoverageSession, compactCoverageCatchUp.projection, {
    authoritativeAfterSeq: compactCoverageCatchUp.authoritativeAfterSeq,
  });
  api.markSessionMessagesRead(compactCoverageSession, null, {
    readAssistantIds: ['compact-b-7'],
    authoritativeAfterSeq: compactCoverageCatchUp.authoritativeAfterSeq,
  });
  assert.strictEqual(
    api.state.messageReceiptStore.get('win::compact-coverage').readThroughAssistantSeq,
    5,
    'the App must preserve a lower unread sibling when forwarding the coverage boundary'
  );
  const previousSessions = api.state.sessions;
  api.state.sessions = [compactCoverageSession];
  api.refreshMessageUnreadState();
  const compactUnreadTarget = api.getUnreadTargetForGroup({
    hostId: 'win',
    conversationKey: 'compact-coverage',
    preferredSession: compactCoverageSession,
    sessions: [compactCoverageSession],
  });
  assert.strictEqual(
    compactUnreadTarget?.message?.assistantMessageId,
    'compact-a-6',
    'the unread resolver must not resurrect a newer tombstoned message above the read cursor'
  );
  assert.strictEqual(
    api.getUnreadMessageNotifications()[0]?.text,
    'compact answer A',
    'the notification bell must route to the active unread identity instead of a read tombstone'
  );
  api.state.sessions = previousSessions;
  api.refreshMessageUnreadState();

  const tombstoneOnlySession = {
    hostId: 'win',
    sessionId: 'tombstone-only',
    conversationKey: 'tombstone-only',
    assistantProjection: {
      canonicalConversationKey: 'win::tombstone-only',
      latestAssistantSeq: 7,
      latestAssistantId: 'tombstone-only-b-7',
      projectionRevision: 1,
      cursorUnknown: false,
      hasMore: false,
      messages: [{
        assistantMessageId: 'tombstone-only-b-7',
        assistantSeq: 7,
        notifiable: true,
        previewText: 'already read answer',
      }],
    },
  };
  api.state.messageReceiptStore.set({
    ...MessageNotificationClient.emptyReceipt('win::tombstone-only'),
    readThroughAssistantSeq: 5,
    unreadAssistantStates: {
      'tombstone-only-b-7': {
        active: false,
        assistantSeq: 7,
        updatedAt: '2026-07-16T10:00:00.000Z',
      },
    },
  });
  api.state.sessions = [tombstoneOnlySession];
  api.refreshMessageUnreadState();
  assert.strictEqual(
    api.hasUnreadMessagesForSession(tombstoneOnlySession),
    true,
    'a cursor gap may remain internally unresolved until authoritative coverage arrives'
  );
  assert.strictEqual(
    api.getUnreadTargetForGroup({ sessions: [tombstoneOnlySession] }),
    null,
    'a cursor gap without an active retained identity must not render a red unread target'
  );
  assert.strictEqual(
    api.getUnreadMessageNotifications().length,
    0,
    'the notification bell must not guess a preview from a tombstoned message'
  );
  api.state.sessions = previousSessions;
  api.refreshMessageUnreadState();

  const readBeforeDrainSession = {
    hostId: 'win',
    sessionId: 'read-before-drain',
    conversationKey: 'read-before-drain',
    assistantProjection: {
      canonicalConversationKey: 'win::read-before-drain',
      latestAssistantSeq: 1,
      latestAssistantId: 'read-before-drain-1',
      projectionRevision: 1,
      cursorUnknown: false,
      hasMore: false,
      messages: [{
        assistantMessageId: 'read-before-drain-1',
        assistantSeq: 1,
        notifiable: true,
        previewText: 'read before notification presentation',
      }],
    },
  };
  api.state.messageReceiptStore.set({
    ...MessageNotificationClient.emptyReceipt('win::read-before-drain'),
    unreadAssistantIds: ['read-before-drain-1'],
    unreadAssistantStates: {
      'read-before-drain-1': {
        active: true,
        assistantSeq: 1,
        updatedAt: '2026-07-16T10:00:00.000Z',
      },
    },
    unnotifiedAssistantIds: ['read-before-drain-1'],
    unnotifiedAssistantStates: {
      'read-before-drain-1': {
        active: true,
        assistantSeq: 1,
        updatedAt: '2026-07-16T10:00:00.000Z',
      },
    },
  });
  const readBeforeDrainItem = api.state.messageNotificationOutbox.enqueue({
    canonicalConversationKey: 'win::read-before-drain',
    assistantMessageId: 'read-before-drain-1',
    assistantSeq: 1,
    previewText: 'read before notification presentation',
    hostId: readBeforeDrainSession.hostId,
    sessionId: readBeforeDrainSession.sessionId,
  });
  api.state.sessions = [readBeforeDrainSession];
  api.markSessionMessagesRead(readBeforeDrainSession, null, {
    readAssistantIds: ['read-before-drain-1'],
    authoritativeAfterSeq: 0,
  });
  assert.strictEqual(
    api.state.messageNotificationOutbox.get(readBeforeDrainItem.alertId),
    null,
    'reading a rendered reply must cancel its pending notification before outbox drain'
  );
  api.state.sessions = previousSessions;
  api.refreshMessageUnreadState();

  api.markSessionMessagesRead(compactCoverageSession, null, {
    readAssistantIds: ['compact-a-6'],
    authoritativeAfterSeq: compactCoverageCatchUp.authoritativeAfterSeq,
  });
  assert.strictEqual(
    api.state.messageReceiptStore.get('win::compact-coverage').readThroughAssistantSeq,
    7,
    'the App may advance after every covered identity is read'
  );
  const sessionLog = sandbox.document.getElementById('session-log');
  sessionLog.querySelectorAll = () => [{ dataset: { assistantMessageId: 'compact-a-6' } }];
  api.completeTranscriptNotificationRender(compactCoverageSession);
  assert.strictEqual(
    api.state.transcriptNotificationRenderedAssistantSeq.get(api.makeSessionKey(
      compactCoverageSession.hostId,
      compactCoverageSession.sessionId
    )),
    6,
    'rendered sequence bookkeeping must reflect DOM assistant identities rather than projection latest'
  );

  const aliasedPagingSession = {
    hostId: 'win',
    sessionId: 'aliased-revision-paging',
    assistantProjection: {
      canonicalConversationKey: 'win::aliased-revision-paging',
      latestAssistantSeq: 200,
      projectionRevision: 10,
      cursorUnknown: false,
      hasMore: true,
      messages: [],
    },
  };
  api.state.messageReceiptStore.set({
    ...MessageNotificationClient.emptyReceipt('win::aliased-revision-paging'),
    readThroughAssistantSeq: 100,
    notifiedThroughAssistantSeq: 100,
  });
  const aliasedResponses = [
    {
      canonicalConversationKey: 'win::aliased-revision-paging', projectionRevision: 10,
      latestAssistantSeq: 200, messages: pageMessages(101, 150), hasMore: true, nextAfterSeq: 150,
    },
    {
      canonicalConversationKey: 'win::aliased-revision-paging', projectionRevision: 11,
      latestAssistantSeq: 200, sequenceAliases: { 100: 50 },
      messages: pageMessages(151, 200), hasMore: false, nextAfterSeq: 200,
    },
    {
      canonicalConversationKey: 'win::aliased-revision-paging', projectionRevision: 11,
      latestAssistantSeq: 200, sequenceAliases: { 100: 50 },
      messages: pageMessages(1, 100), hasMore: true, nextAfterSeq: 100,
    },
    {
      canonicalConversationKey: 'win::aliased-revision-paging', projectionRevision: 11,
      latestAssistantSeq: 200, sequenceAliases: { 100: 50 },
      messages: pageMessages(101, 200), hasMore: false, nextAfterSeq: 200,
    },
  ];
  const aliasedAfterSeqs = [];
  sandbox.fetch = async (url) => {
    if (!String(url).includes('/assistant-messages?')) return originalFetch(url);
    const parsed = new URL(url, 'http://127.0.0.1:8797');
    aliasedAfterSeqs.push(Number(parsed.searchParams.get('afterSeq')));
    return { ok: true, status: 200, json: async () => aliasedResponses.shift() };
  };
  const aliasedPaging = await api.catchUpAssistantProjection(
    aliasedPagingSession,
    aliasedPagingSession.assistantProjection,
    { deferApply: true, force: true }
  );
  assert.deepStrictEqual(
    aliasedAfterSeqs,
    [100, 150, 0, 100],
    'a new revision must restart from zero because sequence aliases can lower the receipt cursor'
  );
  assert.strictEqual(aliasedPaging.projection.messages.length, 200);
  assert.strictEqual(
    aliasedPaging.authoritativeAfterSeq,
    0,
    'revision churn must record the stronger coverage created by restarting pagination from zero'
  );

  const stalledSession = {
    hostId: 'win',
    sessionId: 'stalled-paging',
    assistantProjection: {
      canonicalConversationKey: 'win::stalled-paging',
      latestAssistantSeq: 2,
      projectionRevision: 1,
      cursorUnknown: true,
      hasMore: true,
      messages: [],
    },
  };
  sandbox.fetch = async (url) => String(url).includes('/assistant-messages?') ? ({
    ok: true,
    status: 200,
    json: async () => ({
      canonicalConversationKey: 'win::stalled-paging',
      projectionRevision: 1,
      latestAssistantSeq: 2,
      messages: [{ assistantMessageId: 'stalled-1', assistantSeq: 1 }],
      hasMore: true,
      nextAfterSeq: 0,
    }),
  }) : originalFetch(url);
  await assert.rejects(
    api.catchUpAssistantProjection(stalledSession, stalledSession.assistantProjection, {
      deferApply: true,
      force: true,
    }),
    (error) => error?.code === 'assistant_projection_cursor_stalled'
  );
  assert.strictEqual(
    api.state.messageProjectionRequests.has(api.makeSessionKey(stalledSession)),
    false,
    'a failed pagination request must release its in-flight slot'
  );

  const orphanSession = {
    hostId: 'win',
    sessionId: 'orphan-reconciliation',
    conversationKey: 'orphan-reconciliation',
    assistantProjection: {
      canonicalConversationKey: 'win::orphan-reconciliation',
      latestAssistantSeq: 0,
      projectionRevision: 2,
      cursorUnknown: false,
      hasMore: false,
      messages: [],
    },
  };
  api.state.messageReceiptStore.set({
    ...MessageNotificationClient.emptyReceipt('win::orphan-reconciliation'),
    readThroughAssistantSeq: 42,
    notifiedThroughAssistantSeq: 42,
    unreadAssistantIds: ['deleted-assistant-42'],
    unreadAssistantStates: {
      'deleted-assistant-42': {
        active: true,
        assistantSeq: 42,
        updatedAt: '2026-07-16T10:00:00.000Z',
      },
    },
    unnotifiedAssistantIds: ['deleted-assistant-42'],
    unnotifiedAssistantStates: {
      'deleted-assistant-42': {
        active: true,
        assistantSeq: 42,
        updatedAt: '2026-07-16T10:00:00.000Z',
      },
    },
  });
  const orphanOutboxItem = api.state.messageNotificationOutbox.enqueue({
    canonicalConversationKey: 'win::orphan-reconciliation',
    assistantMessageId: 'deleted-assistant-42',
    assistantSeq: 42,
    previewText: 'deleted answer',
    hostId: orphanSession.hostId,
    sessionId: orphanSession.sessionId,
  });
  const orphanAfterSeqs = [];
  sandbox.fetch = async (url) => {
    if (!String(url).includes('/assistant-messages?')) return originalFetch(url);
    const parsed = new URL(url, 'http://127.0.0.1:8797');
    orphanAfterSeqs.push(Number(parsed.searchParams.get('afterSeq')));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...orphanSession.assistantProjection,
        messages: [],
        hasMore: false,
        nextAfterSeq: Number(parsed.searchParams.get('afterSeq')),
      }),
    };
  };
  const orphanCatchUp = await api.catchUpAssistantProjection(
    orphanSession,
    orphanSession.assistantProjection,
    { deferApply: true }
  );
  assert.deepStrictEqual(
    orphanAfterSeqs,
    [41],
    'orphan reconciliation should start immediately before the oldest missing unread sequence'
  );
  assert.strictEqual(orphanCatchUp.authoritativeAfterSeq, 41);
  api.applyAssistantProjectionForSession(orphanSession, orphanCatchUp.projection, {
    authoritativeAfterSeq: orphanCatchUp.authoritativeAfterSeq,
  });
  const reconciledOrphanReceipt = api.state.messageReceiptStore.get('win::orphan-reconciliation');
  assert.deepStrictEqual(reconciledOrphanReceipt.unreadAssistantIds, []);
  assert.strictEqual(
    reconciledOrphanReceipt.unreadAssistantStates['deleted-assistant-42'].active,
    false,
    'a complete stable catch-up must persist an inactive orphan tombstone'
  );
  assert.deepStrictEqual(reconciledOrphanReceipt.unnotifiedAssistantIds, []);
  assert.strictEqual(
    api.state.messageNotificationOutbox.get(orphanOutboxItem.alertId),
    null,
    'authoritative deletion must cancel the matching pending notification outbox item'
  );
  sandbox.fetch = originalFetch;

  api.state.hosts = [{ hostId: 'win', label: 'Windows', platform: 'win32', online: true }];
  const sessionA = {
    hostId: 'win', sessionId: 's1', conversationKey: 'c1', title: 'First', live: true,
    assistantProjection: { canonicalConversationKey: 'win::native-a', latestAssistantSeq: 1 },
  };
  const sessionB = {
    hostId: 'win', sessionId: 's2', conversationKey: 'c2', title: 'Second', live: true,
    assistantProjection: { canonicalConversationKey: 'win::native-b', latestAssistantSeq: 2 },
  };
  api.state.sessions = [sessionA, sessionB];

  api.applyAssistantProjectionForSession(sessionA, {
    canonicalConversationKey: 'win::native-a',
    latestAssistantSeq: 1,
    latestAssistantId: 'assistant-a',
    latestAssistantAt: '2026-07-16T10:00:00.000Z',
    messages: [{
      assistantMessageId: 'assistant-a', assistantSeq: 1, notifiable: true,
      assistantAt: '2026-07-16T10:00:00.000Z', previewText: 'first answer',
    }],
  });
  api.applyAssistantProjectionForSession(sessionB, {
    canonicalConversationKey: 'win::native-b',
    latestAssistantSeq: 2,
    latestAssistantId: 'assistant-b',
    latestAssistantAt: '2026-07-16T10:01:00.000Z',
    messages: [{
      assistantMessageId: 'assistant-b', assistantSeq: 2, notifiable: true,
      assistantAt: '2026-07-16T10:01:00.000Z', previewText: 'second answer',
    }],
  });

  await Promise.all([
    api.state.messageReceiptStore.whenIdle(),
    api.state.messageNotificationOutbox.whenIdle(),
  ]);

  assert.strictEqual(api.hasUnreadMessagesForSession(sessionA), true);
  assert.strictEqual(api.hasUnreadMessagesForSession(sessionB), true);
  assert.strictEqual(api.getUnreadMessageNotifications().length, 2);
  assert(storage.has('mobile-codex-remote.message-read-receipts.v2'));
  assert(storage.has('mobile-codex-remote.message-notification-outbox.v1'));

  const liveVariant = {
    hostId: 'win', sessionId: 'variant-live', conversationKey: 'variant-group', title: 'Live variant', live: true,
    assistantProjection: { canonicalConversationKey: 'win::variant-live', latestAssistantSeq: 1 },
  };
  const unreadHistoryVariant = {
    hostId: 'win', sessionId: 'variant-history', conversationKey: 'variant-group', title: 'History variant', live: false,
    assistantProjection: { canonicalConversationKey: 'win::variant-history', latestAssistantSeq: 2 },
  };
  api.state.sessions = [liveVariant, unreadHistoryVariant];
  api.applyAssistantProjectionForSession(liveVariant, {
    canonicalConversationKey: 'win::variant-live',
    latestAssistantSeq: 1,
    latestAssistantId: 'live-read',
    messages: [{ assistantMessageId: 'live-read', assistantSeq: 1, notifiable: true }],
  });
  api.markSessionMessagesRead(liveVariant, null, { clearAllUnread: true });
  api.applyAssistantProjectionForSession(unreadHistoryVariant, {
    canonicalConversationKey: 'win::variant-history',
    latestAssistantSeq: 2,
    latestAssistantId: 'history-unread',
    latestAssistantAt: '2026-07-16T10:06:00.000Z',
    messages: [{
      assistantMessageId: 'history-unread',
      assistantSeq: 2,
      notifiable: true,
      assistantAt: '2026-07-16T10:06:00.000Z',
      previewText: 'history answer',
    }],
  });
  const variantTarget = api.getUnreadTargetForGroup({
    hostId: 'win',
    conversationKey: 'variant-group',
    preferredSession: liveVariant,
    sessions: [liveVariant, unreadHistoryVariant],
  });
  assert.strictEqual(
    variantTarget?.session?.sessionId,
    'variant-history',
    'the unread resolver must choose the unread history variant instead of preferred live'
  );
  assert.strictEqual(
    api.getUnreadMessageNotifications()[0]?.session?.sessionId,
    'variant-history',
    'the notification bell must use the same concrete unread target'
  );

  const sharedLiveVariant = {
    hostId: 'win', sessionId: 'shared-live', conversationKey: 'shared-canonical', title: 'Shared live', live: true,
    assistantProjection: { canonicalConversationKey: 'win::shared-canonical', latestAssistantSeq: 7 },
  };
  const sharedHistoryVariant = {
    hostId: 'win', sessionId: 'shared-history', conversationKey: 'shared-canonical', title: 'Shared history', live: false,
    assistantProjection: { canonicalConversationKey: 'win::shared-canonical', latestAssistantSeq: 7 },
  };
  api.state.sessions = [sharedLiveVariant, sharedHistoryVariant];
  const sharedProjection = {
    canonicalConversationKey: 'win::shared-canonical',
    latestAssistantSeq: 7,
    latestAssistantId: 'shared-history-answer',
    latestAssistantAt: '2026-07-16T10:07:00.000Z',
    messages: [
      {
        assistantMessageId: 'shared-live-answer',
        assistantSeq: 6,
        notifiable: true,
        assistantAt: '2026-07-16T10:06:00.000Z',
        previewText: 'shared live answer',
        lineageKeys: ['win::shared-live'],
      },
      {
        assistantMessageId: 'shared-history-answer',
        assistantSeq: 7,
        notifiable: true,
        assistantAt: '2026-07-16T10:07:00.000Z',
        previewText: 'shared history answer',
        lineageKeys: ['win::shared-history'],
      },
    ],
  };
  api.applyAssistantProjectionForSession(sharedLiveVariant, sharedProjection);
  api.applyAssistantProjectionForSession(sharedHistoryVariant, sharedProjection);
  const sharedTarget = api.getUnreadTargetForGroup({
    hostId: 'win',
    conversationKey: 'shared-canonical',
    preferredSession: sharedLiveVariant,
    sessions: [sharedLiveVariant, sharedHistoryVariant],
  });
  assert.strictEqual(
    sharedTarget?.session?.sessionId,
    'shared-history',
    'shared canonical receipts must route by direct message lineage before stable tie-breaks'
  );
  assert.strictEqual(
    api.getUnreadMessageNotifications()[0]?.session?.sessionId,
    'shared-history',
    'the bell must resolve all variants sharing a durable canonical identity before routing'
  );
  api.state.transcriptNotificationRenderedAssistantIds.set(
    api.makeSessionKey(sharedHistoryVariant.hostId, sharedHistoryVariant.sessionId),
    new Set(['shared-history-answer'])
  );
  api.markSessionMessagesRead(sharedHistoryVariant, null, { authoritativeAfterSeq: 0 });
  const historyOnlyRead = api.state.messageReceiptStore.get('win::shared-canonical');
  assert.deepStrictEqual(historyOnlyRead.unreadAssistantIds, ['shared-live-answer']);
  assert.strictEqual(
    historyOnlyRead.readThroughAssistantSeq,
    5,
    'reading the rendered history variant must not move the canonical cursor across an unread sibling'
  );
  api.state.transcriptNotificationRenderedAssistantIds.set(
    api.makeSessionKey(sharedLiveVariant.hostId, sharedLiveVariant.sessionId),
    new Set(['shared-live-answer'])
  );
  api.markSessionMessagesRead(sharedLiveVariant, null, { authoritativeAfterSeq: 0 });
  const bothVariantsRead = api.state.messageReceiptStore.get('win::shared-canonical');
  assert.deepStrictEqual(bothVariantsRead.unreadAssistantIds, []);
  assert.strictEqual(bothVariantsRead.readThroughAssistantSeq, 7);

  const dismissalKey = api.makeSessionKey('win', 'dismissal-cache');
  api.state.dismissedAlerts.set(dismissalKey, new Set(['warning-fingerprint']));
  api.state.alerts.set(dismissalKey, [{ severity: 'warning', message: 'dismissed warning' }]);
  api.evictSessionCacheKey(dismissalKey);
  assert.strictEqual(
    api.state.dismissedAlerts.get(dismissalKey)?.has('warning-fingerprint'),
    true,
    'weighted Session cache eviction must preserve durable Alert dismissal preferences'
  );

  api.state.sessions = [sessionA, sessionB];
  api.refreshMessageUnreadState();

  const sessionAKey = api.makeSessionKey(sessionA.hostId, sessionA.sessionId);
  await api.notificationOutboxPresenters().presentInApp({
    hostId: sessionA.hostId,
    sessionId: sessionA.sessionId,
    alertId: 'assistant-alert:test',
    previewText: 'ordinary assistant reply',
  });
  assert.deepStrictEqual(
    api.state.alerts.get(sessionAKey) || [],
    [],
    'ordinary assistant replies must use unread-message UI instead of Session Alerts'
  );
  assert.strictEqual(
    api.hasUnreadMessagesForSession(sessionA),
    true,
    'in-app notification presentation must preserve the unread-message signal'
  );

  api.state.alerts.set(sessionAKey, [{
    severity: 'info',
    source: 'assistant-message',
    message: 'historical assistant reply',
  }, {
    severity: 'info',
    source: 'runtime',
    message: 'Session stopped successfully.',
  }, {
    severity: 'warning',
    source: 'runtime',
    message: 'Session needs attention.',
  }, {
    severity: 'error',
    source: 'runtime',
    message: 'Session failed.',
  }, {
    severity: 'debug',
    source: 'runtime',
    message: 'Debug details must stay out of Alerts.',
  }]);
  assert.deepStrictEqual(
    Array.from(api.getAlertsForSession(sessionA), (alert) => alert.message),
    ['Session needs attention.', 'Session failed.'],
    'Alerts must hide historical assistant/info entries while preserving warnings and errors'
  );

  const normalizedRetryAlert = api.dedupeAlerts([{
    severity: 'warning',
    source: 'codex',
    message: 'Retry metadata survives browser dedupe.',
    transient: true,
    turnId: 'turn-retry',
  }])[0];
  assert.strictEqual(normalizedRetryAlert.transient, true, 'alert dedupe must preserve transient metadata');
  assert.strictEqual(normalizedRetryAlert.turnId, 'turn-retry', 'alert dedupe must preserve turn identity');

  const transientInputCommand = 'no live session for command session.input';
  const sameTurnRetry = 'Response stream disconnected; retrying the same turn.';
  const previousTurnRetry = 'Provider temporarily unavailable; retrying an earlier turn.';
  const uncorrelatedRetry = 'Transient retry without a turn identity.';
  const terminalTransient = 'Provider exhausted all retry attempts.';
  const realRuntimeError = 'Provider rejected the request permanently.';
  api.state.alerts.set(sessionAKey, [{
    severity: 'error',
    source: 'runtime',
    message: transientInputCommand,
    timestamp: '2026-07-16T10:02:00.000Z',
    transient: true,
    turnId: 'turn-before-retry',
  }, {
    severity: 'warning',
    source: 'codex',
    message: sameTurnRetry,
    timestamp: '2026-07-16T10:02:01.000Z',
    transient: true,
    turnId: 'turn-retry',
  }, {
    severity: 'warning',
    source: 'codex',
    message: previousTurnRetry,
    timestamp: '2026-07-16T10:02:02.000Z',
    transient: true,
    turnId: 'turn-before-retry',
  }, {
    severity: 'warning',
    source: 'codex',
    message: uncorrelatedRetry,
    timestamp: '2026-07-16T10:02:03.000Z',
    transient: true,
    turnId: null,
  }, {
    severity: 'error',
    source: 'codex',
    message: terminalTransient,
    timestamp: '2026-07-16T10:02:04.000Z',
    transient: true,
    turnId: 'turn-retry',
  }, {
    severity: 'error',
    source: 'runtime',
    message: realRuntimeError,
    timestamp: '2026-07-16T10:02:00.000Z',
  }]);
  api.state.runtime.set(sessionAKey, {
    phase: 'retrying',
    connection: 'ready',
    activeTurnId: 'turn-retry',
    busy: true,
    lastError: sameTurnRetry,
    lastCodexError: 'responseStreamDisconnected',
    updatedAt: '2026-07-16T10:03:00.000Z',
  });
  assert.deepStrictEqual(
    Array.from(api.getAlertsForSession(sessionA), (alert) => alert.message),
    [transientInputCommand, sameTurnRetry, previousTurnRetry, uncorrelatedRetry, terminalTransient, realRuntimeError],
    'transient retry warnings must remain visible while runtime still carries an error'
  );

  api.state.runtime.set(sessionAKey, {
    phase: 'error',
    connection: 'ready',
    activeTurnId: null,
    busy: false,
    currentTurnStatus: 'failed',
    lastError: null,
    lastCodexError: null,
    updatedAt: '2026-07-16T10:04:00.000Z',
  });
  assert.deepStrictEqual(
    Array.from(api.getAlertsForSession(sessionA), (alert) => alert.message),
    [transientInputCommand, sameTurnRetry, previousTurnRetry, uncorrelatedRetry, terminalTransient, realRuntimeError],
    'a newer terminal runtime is not proof that a retry warning recovered'
  );

  api.state.runtime.set(sessionAKey, {
    phase: 'thinking',
    connection: 'ready',
    activeTurnId: 'turn-retry',
    busy: true,
    currentTurnStatus: 'inProgress',
    lastError: null,
    lastCodexError: null,
    updatedAt: '2026-07-16T10:05:00.000Z',
  });
  assert.deepStrictEqual(
    Array.from(api.getAlertsForSession(sessionA), (alert) => alert.message),
    [transientInputCommand, uncorrelatedRetry, terminalTransient, realRuntimeError],
    'recovered same-turn and departed-turn retry warnings should hide without hiding terminal errors'
  );
  api.state.alerts.delete(sessionAKey);
  api.state.runtime.delete(sessionAKey);

  api.markSessionMessagesRead(sessionA, null, { clearAllUnread: true });
  api.refreshMessageUnreadState();
  assert.strictEqual(api.hasUnreadMessagesForSession(sessionA), false);
  assert.strictEqual(api.hasUnreadMessagesForSession(sessionB), true, 'reading one Session must not advance another');
  assert.strictEqual(api.getUnreadMessageNotifications()[0].text, 'second answer');

  if (api.state.messageNotificationDrainPromise) {
    await api.state.messageNotificationDrainPromise;
  }
  assert(
    Object.values(api.state.messageNotificationOutbox.all()).every((item) => (
      item.status === 'presented' || item.status === 'canceled'
    )),
    'in-app presentation must complete live notifications without reviving canceled items'
  );
  api.state.messageNotificationDrainPromise = Promise.resolve(false);

  const bulkSessions = Array.from({ length: 739 }, (_, index) => ({
    hostId: 'bulk-host',
    sessionId: `bulk-${index}`,
    conversationKey: `bulk-${index}`,
    title: `Bulk ${index}`,
    live: false,
    assistantProjection: {
      canonicalConversationKey: `bulk-host::bulk-${index}`,
      latestAssistantSeq: 1,
      projectionRevision: 1,
      messages: [{
        assistantMessageId: `bulk-assistant-${index}`,
        assistantSeq: 1,
        notifiable: true,
        previewText: `Bulk answer ${index}`,
      }],
    },
  }));
  api.state.sessions = bulkSessions;
  const writesBeforeBulk = receiptStorageWrites;
  const outboxWritesBeforeBulk = outboxStorageWrites;
  const broadcastsBeforeBulk = notificationBroadcasts.length;
  const bulkStartedAt = Date.now();
  const bulkResult = await api.syncAssistantProjectionsForSessions(bulkSessions, {
    concurrency: 6,
    deferUi: true,
  });
  const bulkElapsedMs = Date.now() - bulkStartedAt;
  assert.strictEqual(bulkResult.candidateCount, 739);
  assert(
    receiptStorageWrites - writesBeforeBulk === 1,
    '739 projection updates must persist receipts exactly once'
  );
  assert(
    outboxStorageWrites - outboxWritesBeforeBulk === 1,
    '739 pending notifications must persist the outbox exactly once'
  );
  assert.strictEqual(
    notificationBroadcasts.length - broadcastsBeforeBulk,
    2,
    'a bulk projection sync must broadcast one receipt and one outbox change'
  );
  assert.strictEqual(api.state.messageUnread.size, 739, 'every bulk Session must become unread');
  assert(
    bulkElapsedMs < 2000,
    `739 projection updates must stay within the startup budget; took ${bulkElapsedMs}ms`
  );
  const writesBeforeRepeatedSync = receiptStorageWrites;
  const outboxWritesBeforeRepeatedSync = outboxStorageWrites;
  const broadcastsBeforeRepeatedSync = notificationBroadcasts.length;
  const repeatedStartedAt = Date.now();
  await api.syncAssistantProjectionsForSessions(bulkSessions, {
    concurrency: 6,
    deferUi: true,
  });
  const repeatedElapsedMs = Date.now() - repeatedStartedAt;
  assert.strictEqual(
    receiptStorageWrites,
    writesBeforeRepeatedSync,
    'an unchanged periodic projection sync must not rewrite receipts'
  );
  assert.strictEqual(
    outboxStorageWrites,
    outboxWritesBeforeRepeatedSync,
    'an unchanged periodic projection sync must not rewrite pending notifications'
  );
  assert.strictEqual(
    notificationBroadcasts.length,
    broadcastsBeforeRepeatedSync,
    'an unchanged periodic projection sync must not broadcast'
  );
  const pendingItems = Object.values(api.state.messageNotificationOutbox.all())
    .filter((item) => item.hostId === 'bulk-host' && item.status === 'pending');
  assert.strictEqual(pendingItems.length, 739, 'every bulk message must enter the pending outbox');
  const writesBeforeAdvanceBatch = receiptStorageWrites;
  const broadcastsBeforeAdvanceBatch = notificationBroadcasts.length;
  await api.notificationOutboxPresenters().advanceNotifiedBatch(pendingItems);
  assert(
    receiptStorageWrites - writesBeforeAdvanceBatch <= 1,
    'advancing 739 notified cursors as one chunk must persist receipts at most once'
  );
  assert(
    notificationBroadcasts.length - broadcastsBeforeAdvanceBatch <= 1,
    'advancing a receipt chunk must broadcast at most once'
  );
  assert(
    repeatedElapsedMs < 1000,
    `an unchanged 739-session sync must stay lightweight; took ${repeatedElapsedMs}ms`
  );
  const writesBeforeReadOnlyRefresh = receiptStorageWrites;
  api.refreshMessageUnreadState();
  assert.strictEqual(
    receiptStorageWrites,
    writesBeforeReadOnlyRefresh,
    'full unread recomputation must not write localStorage'
  );

  let activeWorkers = 0;
  let peakWorkers = 0;
  await api.settleWithConcurrency(Array.from({ length: 40 }), async () => {
    activeWorkers += 1;
    peakWorkers = Math.max(peakWorkers, activeWorkers);
    await Promise.resolve();
    activeWorkers -= 1;
  }, 6);
  assert.strictEqual(peakWorkers, 6, 'assistant catch-up must honor its concurrency bound');

  assert.strictEqual(typeof messageChannelListener, 'function', 'notification BroadcastChannel listener must be installed');
  const queuedTimers = [];
  let nextTimerId = 1;
  sandbox.window.setTimeout = (callback) => {
    queuedTimers.push(callback);
    return nextTimerId++;
  };
  const drainQueuedTimers = () => {
    while (queuedTimers.length) queuedTimers.shift()();
  };
  const readsBeforeReceiptBroadcast = receiptStorageReads;
  const outboxReadsBeforeReceiptBroadcast = outboxStorageReads;
  for (let index = 0; index < 100; index += 1) {
    messageChannelListener({ data: { type: 'receipts-changed' } });
  }
  assert.strictEqual(queuedTimers.length, 1, 'a receipt broadcast burst must schedule one storage flush');
  assert.strictEqual(receiptStorageReads, readsBeforeReceiptBroadcast);
  drainQueuedTimers();
  assert.strictEqual(receiptStorageReads, readsBeforeReceiptBroadcast + 1);
  assert.strictEqual(
    outboxStorageReads,
    outboxReadsBeforeReceiptBroadcast,
    'receipt-only broadcasts must not parse the outbox'
  );

  const readsBeforeOutboxBroadcast = outboxStorageReads;
  const receiptReadsBeforeOutboxBroadcast = receiptStorageReads;
  for (let index = 0; index < 100; index += 1) {
    messageChannelListener({ data: { type: 'outbox-changed' } });
  }
  assert.strictEqual(queuedTimers.length, 1, 'an outbox broadcast burst must schedule one storage flush');
  drainQueuedTimers();
  assert.strictEqual(outboxStorageReads, readsBeforeOutboxBroadcast + 1);
  assert.strictEqual(
    receiptStorageReads,
    receiptReadsBeforeOutboxBroadcast,
    'outbox-only broadcasts must not parse or recompute receipts'
  );
  sandbox.window.setTimeout = immediate;

  const alertsBeforeQuota = Array.from(api.state.alerts.values())
    .reduce((total, alerts) => total + alerts.length, 0);
  const writesBeforeQuota = outboxStorageWrites;
  outboxQuotaFailuresRemaining = 2;
  api.state.messageNotificationOutbox.enqueue({
    canonicalConversationKey: 'quota::conversation',
    assistantMessageId: 'quota-assistant-1',
    assistantSeq: 1,
    previewText: 'quota fallback',
    hostId: 'quota-host',
    sessionId: 'quota-session',
  });
  await api.state.messageNotificationOutbox.whenIdle();
  assert.strictEqual(
    api.state.messageNotificationOutbox.isPersistenceDisabled(),
    true,
    'two quota failures must downgrade the outbox to memory storage'
  );
  assert.strictEqual(
    outboxStorageWrites - writesBeforeQuota,
    2,
    'the UI outbox must stop after one compacted retry without clearing durable storage'
  );
  assert.strictEqual(
    api.state.messageOutboxPersistRetryTimer,
    null,
    'quota fallback must not schedule an outbox persistence retry loop'
  );
  assert.strictEqual(
    Array.from(api.state.alerts.values()).reduce((total, alerts) => total + alerts.length, 0),
    alertsBeforeQuota,
    'localStorage quota maintenance must not create a visible Session alert'
  );
  const writesAfterFallback = outboxStorageWrites;
  api.state.messageNotificationOutbox.enqueue({
    canonicalConversationKey: 'quota::conversation',
    assistantMessageId: 'quota-assistant-2',
    assistantSeq: 2,
    previewText: 'memory only',
    hostId: 'quota-host',
    sessionId: 'quota-session',
  });
  await api.state.messageNotificationOutbox.whenIdle();
  assert.strictEqual(
    outboxStorageWrites,
    writesAfterFallback,
    'memory fallback must not keep retrying localStorage writes'
  );

  const alertsBeforeReceiptQuota = Array.from(api.state.alerts.values())
    .reduce((total, alerts) => total + alerts.length, 0);
  const receiptWritesBeforeQuota = receiptStorageWrites;
  receiptQuotaFailuresRemaining = 1;
  api.state.messageReceiptStore.set({
    ...api.state.messageReceiptStore.get('quota::receipt'),
    canonicalConversationKey: 'quota::receipt',
    notifiedThroughAssistantSeq: 1,
  });
  await api.state.messageReceiptStore.whenIdle();
  assert.strictEqual(api.state.messageReceiptStore.isPersistenceDisabled(), true);
  assert.strictEqual(receiptStorageWrites - receiptWritesBeforeQuota, 1);
  assert.strictEqual(api.state.messageReceiptPersistRetryTimer, null);
  assert.strictEqual(
    Array.from(api.state.alerts.values()).reduce((total, alerts) => total + alerts.length, 0),
    alertsBeforeReceiptQuota,
    'receipt quota fallback must not create a visible Session alert'
  );

  await Promise.resolve();
  console.log('session message notification assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
