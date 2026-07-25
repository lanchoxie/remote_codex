const assert = require('assert');

const {
  ReadEligibilityGate,
  ReceiptStore,
  advanceNotifiedReceipt,
  advanceReadReceipt,
  applyAssistantProjection,
  emptyReceipt,
  mergeAliasReceipts,
  migrateLegacyReceipt,
} = require('../apps/mobile-web/public/message-notification-client');

async function main() {
const now = () => '2026-07-16T10:00:00.000Z';
const receiptA = {
  ...emptyReceipt('host::a', now),
  readThroughAssistantSeq: 3,
  notifiedThroughAssistantSeq: 3,
};
const receiptB = emptyReceipt('host::b', now);
const messages = [
  { assistantMessageId: 'a1', assistantSeq: 1, lineageKeys: ['host::a'] },
  { assistantMessageId: 'b1', assistantSeq: 2, lineageKeys: ['host::b'] },
  { assistantMessageId: 'a2', assistantSeq: 3, lineageKeys: ['host::a'] },
];
const merged = mergeAliasReceipts({
  canonicalConversationKey: 'host::native',
  receipts: [receiptA, receiptB],
  messages,
  sequenceAliases: {},
  now,
});
assert.strictEqual(merged.readThroughAssistantSeq, 3);
assert.strictEqual(merged.notifiedThroughAssistantSeq, 3);
assert.deepStrictEqual(merged.unreadAssistantIds, ['b1']);
assert.deepStrictEqual(merged.unnotifiedAssistantIds, ['b1']);

const projection = {
  canonicalConversationKey: 'host::native',
  latestAssistantSeq: 5,
  sequenceAliases: { 5: 4 },
  messages: [
    ...messages,
    { assistantMessageId: 'n1', assistantSeq: 4, assistantAt: '2026-07-16T10:00:00Z' },
    { assistantMessageId: 'n1-duplicate-sequence', assistantSeq: 5, assistantAt: '2026-07-16T10:00:00Z' },
  ],
};
const applied = applyAssistantProjection(merged, projection, { now });
assert.strictEqual(applied.unread, true);
assert.strictEqual(applied.unnotified, true);
assert.strictEqual(applied.receipt.readThroughAssistantSeq, 3);
assert.deepStrictEqual(applied.receipt.unreadAssistantIds.sort(), ['b1', 'n1', 'n1-duplicate-sequence']);

let rebasedCursorStorage = JSON.stringify({
  version: 3,
  receipts: {
    'host::rebased-cursor': {
      ...emptyReceipt('host::rebased-cursor', now),
      readThroughAssistantSeq: 100,
      notifiedThroughAssistantSeq: 100,
    },
  },
});
const rebasedCursorStore = new ReceiptStore({
  load: () => rebasedCursorStorage,
  save: (value) => { rebasedCursorStorage = value; },
  now,
});
const rebasedCursorApplied = applyAssistantProjection(
  rebasedCursorStore.get('host::rebased-cursor'),
  {
    canonicalConversationKey: 'host::rebased-cursor',
    latestAssistantSeq: 60,
    sequenceAliases: { 100: 50 },
    messages: [{ assistantMessageId: 'rebased-60', assistantSeq: 60 }],
  },
  { now }
);
rebasedCursorStore.set(rebasedCursorApplied.receipt);
const reopenedRebasedCursor = new ReceiptStore({ load: () => rebasedCursorStorage, now })
  .get('host::rebased-cursor');
assert.strictEqual(
  reopenedRebasedCursor.readThroughAssistantSeq,
  50,
  'durable pre-alias cursors must normalize before receipt merge'
);
assert.strictEqual(reopenedRebasedCursor.notifiedThroughAssistantSeq, 50);
assert.deepStrictEqual(reopenedRebasedCursor.unreadAssistantIds, ['rebased-60']);
assert.deepStrictEqual(reopenedRebasedCursor.unnotifiedAssistantIds, ['rebased-60']);
assert.strictEqual(reopenedRebasedCursor.sequenceAliases['100'], 50);

const read = advanceReadReceipt(applied.receipt, projection, { now });
assert.strictEqual(read.readThroughAssistantSeq, 4, 'losing high-water must normalize through sequence aliases');
assert.deepStrictEqual(read.unreadAssistantIds, []);
assert.strictEqual(read.notifiedThroughAssistantSeq, 3, 'reading must not falsify alert presentation state');

const notified = advanceNotifiedReceipt(read, projection, {
  assistantMessageId: 'n1',
  assistantSeq: 4,
}, { now });
assert.strictEqual(notified.notifiedThroughAssistantSeq, 4);
assert(!notified.unnotifiedAssistantIds.includes('n1'));
assert.strictEqual(notified.readThroughAssistantSeq, 4, 'presentation must not mutate read state');

const exactLegacy = migrateLegacyReceipt({ lastReadMessageKey: 'legacy-exact' }, {
  canonicalConversationKey: 'host::native',
  messages: [{ assistantMessageId: 'm7', assistantSeq: 7, legacyMarker: 'legacy-exact' }],
  baselineHighWater: 7,
  now,
});
assert.strictEqual(exactLegacy.readThroughAssistantSeq, 7);
const ambiguousLegacy = migrateLegacyReceipt({ lastReadMessageKey: 'unknown' }, {
  canonicalConversationKey: 'host::native',
  messages: [],
  baselineHighWater: 9,
  now,
});
assert.strictEqual(ambiguousLegacy.readThroughAssistantSeq, 9);
assert.deepStrictEqual(ambiguousLegacy.unreadAssistantIds, []);

const gate = new ReadEligibilityGate();
const eligible = {
  selected: true,
  visible: true,
  focused: true,
  renderCurrent: true,
  atReadingBoundary: true,
  outerScrollSource: 'user',
};
assert.strictEqual(gate.canAdvance(eligible), false, 'background state cannot establish follow');
assert.strictEqual(gate.establishFollow('session-selection', { trusted: true }), true);
assert.strictEqual(gate.canAdvance(eligible), true);
assert.strictEqual(gate.canAdvance({ ...eligible, visible: false }), false);
assert.strictEqual(gate.canAdvance({ ...eligible, focused: false }), false);
assert.strictEqual(gate.canAdvance({ ...eligible, renderCurrent: false }), false);
assert.strictEqual(gate.canAdvance({ ...eligible, outerScrollSource: 'programmatic' }), false);
gate.noteThinkingScroll();
assert.strictEqual(gate.canAdvance(eligible), true, 'inner Thinking movement must not detach the outer reader');
gate.detachByUser();
assert.strictEqual(gate.canAdvance(eligible), false);
gate.noteProgrammaticScroll();
assert.strictEqual(gate.canAdvance(eligible), false, 'programmatic scrolling cannot establish follow');
assert.strictEqual(gate.state().lastSource, 'programmatic');
gate.establishFollow('outer-user-boundary', { trusted: true });
assert.strictEqual(gate.canAdvance(eligible), true);
gate.noteProgrammaticScroll();
assert.strictEqual(
  gate.canAdvance(eligible),
  true,
  'automatic follow may preserve an already trusted reading boundary'
);

const otherGate = new ReadEligibilityGate();
otherGate.noteProgrammaticScroll();
assert.strictEqual(otherGate.canAdvance(eligible), false, 'programmatic movement cannot establish follow');

const storage = new Map();
const store = new ReceiptStore({
  load: () => storage.get('receipts') || null,
  save: (value) => storage.set('receipts', value),
  now,
});
store.set(read);
const reopened = new ReceiptStore({
  load: () => storage.get('receipts') || null,
  save: (value) => storage.set('receipts', value),
  now,
});
assert.strictEqual(reopened.get('host::native').readThroughAssistantSeq, 4);
assert.strictEqual(reopened.get('host::other').canonicalConversationKey, 'host::other');
assert.strictEqual(reopened.has('host::native'), true);
assert.strictEqual(reopened.has('host::other'), false, 'reading an empty receipt must not persist it');

const sharedStorage = new Map();
const makeSharedStore = () => new ReceiptStore({
  load: () => sharedStorage.get('receipts') || '',
  save: (value) => sharedStorage.set('receipts', value),
  now,
});
const staleStoreA = makeSharedStore();
const staleStoreB = makeSharedStore();
staleStoreA.set({ ...emptyReceipt('host::one', now), readThroughAssistantSeq: 2 });
staleStoreB.set({ ...emptyReceipt('host::two', now), notifiedThroughAssistantSeq: 4 });
const mergedStore = makeSharedStore();
assert.strictEqual(mergedStore.get('host::one').readThroughAssistantSeq, 2);
assert.strictEqual(mergedStore.get('host::two').notifiedThroughAssistantSeq, 4);

const staleSameA = makeSharedStore();
const staleSameB = makeSharedStore();
staleSameA.set({
  ...emptyReceipt('host::same', now),
  notifiedThroughAssistantSeq: 9,
  unnotifiedAssistantIds: [],
});
staleSameB.set({
  ...emptyReceipt('host::same', now),
  readThroughAssistantSeq: 7,
  notifiedThroughAssistantSeq: 0,
  unnotifiedAssistantIds: ['already-presented'],
});
const sameMerged = makeSharedStore().get('host::same');
assert.strictEqual(sameMerged.readThroughAssistantSeq, 7);
assert.strictEqual(sameMerged.notifiedThroughAssistantSeq, 9);
assert.deepStrictEqual(sameMerged.unnotifiedAssistantIds, [], 'a stale read update must not roll back presentation state');

let concurrentStorage = '';
const makeConcurrentStore = () => new ReceiptStore({
  load: () => concurrentStorage,
  save: (value) => { concurrentStorage = value; },
  now,
});
const concurrentA = makeConcurrentStore();
const concurrentB = makeConcurrentStore();
concurrentA.set(applyAssistantProjection(emptyReceipt('host::concurrent', now), {
  canonicalConversationKey: 'host::concurrent',
  latestAssistantSeq: 1,
  messages: [{ assistantMessageId: 'concurrent-a', assistantSeq: 1 }],
}, { now }).receipt);
concurrentB.set(applyAssistantProjection(emptyReceipt('host::concurrent', now), {
  canonicalConversationKey: 'host::concurrent',
  latestAssistantSeq: 2,
  messages: [{ assistantMessageId: 'concurrent-b', assistantSeq: 2 }],
}, { now }).receipt);
const concurrentMerged = makeConcurrentStore().get('host::concurrent');
assert.deepStrictEqual(
  concurrentMerged.unreadAssistantIds,
  ['concurrent-a', 'concurrent-b'],
  'same-cursor stale tabs must merge independently discovered unread IDs'
);
assert.deepStrictEqual(
  concurrentMerged.unnotifiedAssistantIds,
  ['concurrent-a', 'concurrent-b'],
  'same-cursor stale tabs must merge independently discovered notification IDs'
);

let removeWinsStorage = '';
const makeRemoveWinsStore = () => new ReceiptStore({
  load: () => removeWinsStorage,
  save: (value) => { removeWinsStorage = value; },
  now,
});
const initialConflictProjection = {
  canonicalConversationKey: 'host::remove-wins',
  latestAssistantSeq: 1,
  messages: [{ assistantMessageId: 'remove-a', assistantSeq: 1 }],
};
makeRemoveWinsStore().set(applyAssistantProjection(
  emptyReceipt('host::remove-wins', now),
  initialConflictProjection,
  { now }
).receipt);
const clearingTab = makeRemoveWinsStore();
const staleAddingTab = makeRemoveWinsStore();
let clearedConflict = advanceReadReceipt(
  clearingTab.get('host::remove-wins'),
  initialConflictProjection,
  { clearAllUnread: true, now }
);
clearedConflict = advanceNotifiedReceipt(clearedConflict, initialConflictProjection, {
  assistantMessageId: 'remove-a',
  assistantSeq: 1,
}, { now });
clearingTab.set(clearedConflict);
staleAddingTab.set(applyAssistantProjection(staleAddingTab.get('host::remove-wins'), {
  canonicalConversationKey: 'host::remove-wins',
  latestAssistantSeq: 2,
  messages: [
    { assistantMessageId: 'remove-a', assistantSeq: 1 },
    { assistantMessageId: 'remove-b', assistantSeq: 2 },
  ],
}, { now }).receipt);
const removeWinsMerged = makeRemoveWinsStore().get('host::remove-wins');
assert.deepStrictEqual(removeWinsMerged.unreadAssistantIds, ['remove-b']);
assert.deepStrictEqual(removeWinsMerged.unnotifiedAssistantIds, ['remove-b']);

let interleavedStorage = '';
let receiptWriteTail = Promise.resolve();
let activeReceiptWriters = 0;
let peakReceiptWriters = 0;
const runReceiptWriteExclusive = (callback) => {
  const run = receiptWriteTail.then(async () => {
    activeReceiptWriters += 1;
    peakReceiptWriters = Math.max(peakReceiptWriters, activeReceiptWriters);
    await Promise.resolve();
    try {
      return callback();
    } finally {
      activeReceiptWriters -= 1;
    }
  });
  receiptWriteTail = run.catch(() => {});
  return run;
};
const baseInterleavedProjection = {
  canonicalConversationKey: 'host::interleaved',
  latestAssistantSeq: 1,
  messages: [{ assistantMessageId: 'interleaved-a', assistantSeq: 1 }],
};
new ReceiptStore({
  load: () => interleavedStorage,
  save: (value) => { interleavedStorage = value; },
  now,
}).set(applyAssistantProjection(
  emptyReceipt('host::interleaved', now),
  baseInterleavedProjection,
  { now }
).receipt);
const addingInterleavedStore = new ReceiptStore({
  load: () => interleavedStorage,
  save: (value) => { interleavedStorage = value; },
  runExclusive: runReceiptWriteExclusive,
  now,
});
const clearingInterleavedStore = new ReceiptStore({
  load: () => interleavedStorage,
  save: (value) => { interleavedStorage = value; },
  runExclusive: runReceiptWriteExclusive,
  now,
});
let clearedInterleavedReceipt = advanceReadReceipt(
  clearingInterleavedStore.get('host::interleaved'),
  baseInterleavedProjection,
  { clearAllUnread: true, now }
);
clearedInterleavedReceipt = advanceNotifiedReceipt(
  clearedInterleavedReceipt,
  baseInterleavedProjection,
  { assistantMessageId: 'interleaved-a', assistantSeq: 1 },
  { now }
);
clearingInterleavedStore.set(clearedInterleavedReceipt);
addingInterleavedStore.set(applyAssistantProjection(
  addingInterleavedStore.get('host::interleaved'),
  {
    canonicalConversationKey: 'host::interleaved',
    latestAssistantSeq: 2,
    messages: [
      { assistantMessageId: 'interleaved-a', assistantSeq: 1 },
      { assistantMessageId: 'interleaved-b', assistantSeq: 2 },
    ],
  },
  { now }
).receipt);
await Promise.all([
  clearingInterleavedStore.whenIdle(),
  addingInterleavedStore.whenIdle(),
]);
assert.strictEqual(peakReceiptWriters, 1, 'Web Lock persistence must serialize full receipt transactions');
const interleavedMerged = new ReceiptStore({ load: () => interleavedStorage, now })
  .get('host::interleaved');
assert.deepStrictEqual(interleavedMerged.unreadAssistantIds, ['interleaved-b']);
assert.deepStrictEqual(interleavedMerged.unnotifiedAssistantIds, ['interleaved-b']);

const staleAlias = applyAssistantProjection(emptyReceipt('host::stale-alias', now), {
  canonicalConversationKey: 'host::stale-alias',
  latestAssistantSeq: 1,
  messages: [{ assistantMessageId: 'remove-a', assistantSeq: 1 }],
}, { now }).receipt;
const aliasRemoveWins = mergeAliasReceipts({
  canonicalConversationKey: 'host::remove-wins',
  receipts: [removeWinsMerged, staleAlias],
  messages: [{
    assistantMessageId: 'remove-a',
    assistantSeq: 1,
    lineageKeys: ['host::remove-wins', 'host::stale-alias'],
  }],
  now,
});
assert(!aliasRemoveWins.unreadAssistantIds.includes('remove-a'), 'alias merge must preserve explicit read tombstones');
assert(!aliasRemoveWins.unnotifiedAssistantIds.includes('remove-a'), 'alias merge must preserve notified tombstones');

let compactedReceiptStorage = JSON.stringify({
  version: 3,
  receipts: {
    'host::compacted': {
      ...emptyReceipt('host::compacted', now),
      unreadAssistantStates: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
        `cleared-${index}`,
        { active: false, assistantSeq: index + 1, updatedAt: `2026-07-16T09:0${index}:00.000Z` },
      ])),
      unnotifiedAssistantStates: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
        `notified-${index}`,
        { active: false, assistantSeq: index + 1, updatedAt: `2026-07-16T09:0${index}:00.000Z` },
      ])),
    },
  },
});
const compactedReceiptStore = new ReceiptStore({
  load: () => compactedReceiptStorage,
  save: (value) => { compactedReceiptStorage = value; },
  inactiveStateLimit: 2,
  now,
});
const compactedReceipt = compactedReceiptStore.get('host::compacted');
assert.strictEqual(
  Object.values(compactedReceipt.unreadAssistantStates).filter((state) => state.active === false).length,
  8
);
assert.strictEqual(
  Object.values(compactedReceipt.unnotifiedAssistantStates).filter((state) => state.active === false).length,
  8,
  'inactive receipt tombstones must not be deleted without a coordinated compaction generation'
);

let batchStorage = '';
let batchSaves = 0;
let batchPersistEvents = 0;
const batchStore = new ReceiptStore({
  load: () => batchStorage,
  save: (value) => {
    batchSaves += 1;
    batchStorage = value;
  },
  onPersist: () => { batchPersistEvents += 1; },
  now,
});
batchStore.batch((target) => {
  for (let index = 0; index < 739; index += 1) {
    target.set({
      ...emptyReceipt(`bulk::${index}`, now),
      readThroughAssistantSeq: index,
    });
  }
});
assert.strictEqual(batchSaves, 1, 'a large synchronous receipt batch must save once');
assert.strictEqual(batchPersistEvents, 1, 'a large receipt batch must broadcast once after persistence');
assert.strictEqual(new ReceiptStore({ load: () => batchStorage, now }).keys().length, 739);

batchSaves = 0;
batchPersistEvents = 0;
batchStore.batch((target) => {
  for (let index = 0; index < 739; index += 1) {
    const receipt = target.get(`bulk::${index}`);
    target.set({ ...receipt, updatedAt: '2026-07-16T11:00:00.000Z' });
  }
});
assert.strictEqual(batchSaves, 0, 'materially identical receipts must not rewrite storage');
assert.strictEqual(batchPersistEvents, 0, 'no-op batches must not broadcast');
batchStore.get('bulk::1');
batchStore.has('bulk::2');
batchStore.values();
assert.strictEqual(batchSaves, 0, 'receipt queries must remain read-only');
assert.throws(
  () => batchStore.batch(async () => {}),
  /must be synchronous/,
  'a batch must not span an await boundary'
);

let failingStorage = '';
let failSave = true;
let successfulFailureEvents = 0;
const retryStore = new ReceiptStore({
  load: () => failingStorage,
  save: (value) => {
    if (failSave) throw new Error('injected receipt save failure');
    failingStorage = value;
  },
  onPersist: () => { successfulFailureEvents += 1; },
  now,
});
assert.throws(
  () => retryStore.set({ ...emptyReceipt('retry::one', now), readThroughAssistantSeq: 1 }),
  /injected receipt save failure/
);
assert.strictEqual(successfulFailureEvents, 0, 'failed persistence must not broadcast');
failSave = false;
assert.strictEqual(retryStore.flush(), true, 'a failed receipt save must remain dirty for retry');
assert.strictEqual(successfulFailureEvents, 1);
assert.strictEqual(new ReceiptStore({ load: () => failingStorage, now }).has('retry::one'), true);

let quotaReceiptSaves = 0;
let quotaReceiptPersistErrors = 0;
let quotaReceiptDisabled = 0;
const quotaReceiptStore = new ReceiptStore({
  load: () => '',
  save: () => {
    quotaReceiptSaves += 1;
    throw Object.assign(
      new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota."),
      { name: 'QuotaExceededError' }
    );
  },
  onPersistError: () => { quotaReceiptPersistErrors += 1; },
  onPersistenceDisabled: () => { quotaReceiptDisabled += 1; },
  now,
});
assert.doesNotThrow(() => quotaReceiptStore.set({
  ...emptyReceipt('quota-receipt::one', now),
  notifiedThroughAssistantSeq: 1,
}));
assert.strictEqual(quotaReceiptSaves, 1, 'receipt quota must make one storage attempt');
assert.strictEqual(quotaReceiptPersistErrors, 0, 'receipt quota must not enter the ordinary retry path');
assert.strictEqual(quotaReceiptDisabled, 1, 'receipt quota must switch to in-memory tracking');
assert.strictEqual(quotaReceiptStore.isPersistenceDisabled(), true);
quotaReceiptStore.set({
  ...quotaReceiptStore.get('quota-receipt::one'),
  notifiedThroughAssistantSeq: 2,
});
assert.strictEqual(quotaReceiptSaves, 1, 'in-memory receipt tracking must not retry localStorage writes');
assert.strictEqual(quotaReceiptStore.get('quota-receipt::one').notifiedThroughAssistantSeq, 2);

let readFailureStorage = JSON.stringify({
  version: 3,
  receipts: {
    'read-failure::existing': {
      ...emptyReceipt('read-failure::existing', now),
      readThroughAssistantSeq: 3,
    },
  },
});
let failReceiptRead = false;
let writesDuringReadFailure = 0;
const readFailureStore = new ReceiptStore({
  load: () => {
    if (failReceiptRead) throw new Error('injected receipt read failure');
    return readFailureStorage;
  },
  save: (value) => {
    writesDuringReadFailure += 1;
    readFailureStorage = value;
  },
  now,
});
failReceiptRead = true;
assert.throws(
  () => readFailureStore.set({
    ...emptyReceipt('read-failure::new', now),
    readThroughAssistantSeq: 4,
  }),
  /injected receipt read failure/
);
assert.strictEqual(writesDuringReadFailure, 0, 'a failed durable read must never be overwritten');
failReceiptRead = false;
assert.strictEqual(readFailureStore.flush(), true);
const recoveredReadFailure = new ReceiptStore({ load: () => readFailureStorage, now });
assert.strictEqual(recoveredReadFailure.has('read-failure::existing'), true);
assert.strictEqual(recoveredReadFailure.has('read-failure::new'), true);

const isolated = applyAssistantProjection(emptyReceipt('host::other', now), {
  canonicalConversationKey: 'host::other',
  latestAssistantSeq: 8,
  messages: [{ assistantMessageId: 'other-8', assistantSeq: 8 }],
}, { now });
assert.deepStrictEqual(isolated.receipt.unreadAssistantIds, ['other-8']);
assert(!isolated.receipt.unreadAssistantIds.includes('n1'), 'receipts must stay conversation-scoped');

console.log('message notification client assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
