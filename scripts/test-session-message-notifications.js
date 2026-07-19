const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MessageNotificationClient = require('../apps/mobile-web/public/message-notification-client');
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

assertContains(html, '<script src="/message-notification-client.js"></script>', 'notification client must load before app.js');
assert(
  html.indexOf('/message-notification-client.js') < html.indexOf('/app.js'),
  'notification client must be available while app.js initializes'
);
assertContains(html, 'id="message-notification-button"', 'header should expose the notification bell');
assertContains(html, 'id="mark-all-message-notifications-read-button"', 'panel should expose explicit mark-all-read');
assertContains(styles, '.conversation-card.message-unread::after', 'sidebar should render an unread indicator');
assertContains(styles, '.message-notification-button.has-unread', 'bell should expose unread state');

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
        }
        if (key === 'mobile-codex-remote.message-notification-outbox.v1') {
          outboxStorageWrites += 1;
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
    BroadcastChannel: class BroadcastChannelStub {
      addEventListener(_type, listener) { messageChannelListener = listener; }
      postMessage(message) { notificationBroadcasts.push(message); }
    },
    addEventListener() {},
    location: { origin: 'http://127.0.0.1:8797', search: '' },
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
  mergeAssistantProjection,
  applyAssistantProjectionForSession,
  getUnreadMessageNotifications,
  hasUnreadMessagesForSession,
  markSessionMessagesRead,
  refreshMessageUnreadState,
  notificationOutboxPresenters,
  catchUpAssistantProjection,
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

  api.markSessionMessagesRead(sessionA, null, { clearAllUnread: true });
  api.refreshMessageUnreadState();
  assert.strictEqual(api.hasUnreadMessagesForSession(sessionA), false);
  assert.strictEqual(api.hasUnreadMessagesForSession(sessionB), true, 'reading one Session must not advance another');
  assert.strictEqual(api.getUnreadMessageNotifications()[0].text, 'second answer');

  if (api.state.messageNotificationDrainPromise) {
    await api.state.messageNotificationDrainPromise;
  }
  assert(
    Object.values(api.state.messageNotificationOutbox.all()).every((item) => item.status === 'presented'),
    'in-app presentation must complete the outbox when system notifications are unavailable'
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

  await Promise.resolve();
  console.log('session message notification assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
