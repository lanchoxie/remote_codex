const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert(start >= 0 && end > start, `expected to extract ${name}`);
  return source.slice(start, end);
}

function buildTrashHarness() {
  const names = [
    ['normalizeTrashSourceList', 'normalizeSessionCollectionItem'],
    ['normalizeSessionCollectionItem', 'collectionItemKey'],
    ['collectionItemKey', 'collectionItemDedupeKeys'],
    ['collectionItemDedupeKeys', 'collectionItemUpdatedMs'],
    ['collectionItemUpdatedMs', 'collectionItemsMatch'],
    ['collectionItemsMatch', 'filterCollectionItems'],
    ['filterCollectionItems', 'dedupeCollectionItems'],
    ['dedupeCollectionItems', 'looksLikeSessionId'],
    ['normalizeSessionCollection', 'loadSessionCollections'],
    ['ensureTrashCollection', 'findCollectionMembershipsForItem'],
    ['findCollectionMembershipsForItem', 'findDiscardedSessionItem'],
    ['findDiscardedSessionItem', 'isCollectionItemDiscarded'],
    ['isCollectionItemDiscarded', 'isCollectionItemInTrash'],
    ['isCollectionItemInTrash', 'isCollectionItemHiddenFromCollections'],
    ['isCollectionItemHiddenFromCollections', 'moveCollectionItemToTrash'],
    ['moveCollectionItemToTrash', 'restoreCollectionItemFromTrash'],
    ['restoreCollectionItemFromTrash', 'emptyTrashCollection'],
    ['emptyTrashCollection', 'loadSessionMetadata'],
  ];
  const source = names.map(([name, next]) => extractFunction(relay, name, next)).join('\n');
  const state = {
    sessionCollections: new Map(),
    discardedSessionItems: new Map(),
  };
  const DEFAULT_COLLECTION_ID = 'default';
  const TRASH_COLLECTION_ID = 'trash';
  let counter = 0;
  const makeId = () => `id-${++counter}`;
  const nowIso = () => `2026-06-28T00:00:${String(++counter).padStart(2, '0')}.000Z`;
  let persistCount = 0;
  const persistSessionCollections = () => {
    persistCount += 1;
  };
  const rememberSessionTitle = () => {};

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'assert',
    'state',
    'DEFAULT_COLLECTION_ID',
    'TRASH_COLLECTION_ID',
    'makeId',
    'nowIso',
    'persistSessionCollections',
    'rememberSessionTitle',
    `${source}\nreturn {
      normalizeSessionCollection,
      normalizeSessionCollectionItem,
      collectionItemsMatch,
      ensureTrashCollection,
      findCollectionMembershipsForItem,
      isCollectionItemDiscarded,
      isCollectionItemInTrash,
      isCollectionItemHiddenFromCollections,
      moveCollectionItemToTrash,
      restoreCollectionItemFromTrash,
      emptyTrashCollection,
    };`
  );
  const api = factory(
    assert,
    state,
    DEFAULT_COLLECTION_ID,
    TRASH_COLLECTION_ID,
    makeId,
    nowIso,
    persistSessionCollections,
    rememberSessionTitle
  );
  return {
    state,
    api,
    get persistCount() {
      return persistCount;
    },
  };
}

function seedCollections(harness) {
  const { state, api } = harness;
  const item = api.normalizeSessionCollectionItem({
    hostId: 'win',
    conversationKey: 'conv-1',
    sessionId: 'sess-1',
    title: 'Important session',
    cwd: 'D:/work',
    hostLabel: 'Windows',
  });
  state.sessionCollections.set('default', api.normalizeSessionCollection({
    collectionId: 'default',
    name: 'Default',
  }));
  state.sessionCollections.set('alpha', api.normalizeSessionCollection({
    collectionId: 'alpha',
    name: 'Alpha',
    items: [item],
  }));
  state.sessionCollections.set('beta', api.normalizeSessionCollection({
    collectionId: 'beta',
    name: 'Beta',
    items: [item],
  }));
  return item;
}

function testMoveToTrashRecordsMembershipsAndRemovesSourceTags() {
  const harness = buildTrashHarness();
  const item = seedCollections(harness);
  const result = harness.api.moveCollectionItemToTrash(item);

  assert.deepStrictEqual(
    result.previousCollections.map((entry) => entry.collectionId).sort(),
    ['alpha', 'beta'],
    'move-to-trash should report every source collection that contained the conversation'
  );
  assert.strictEqual(harness.state.sessionCollections.get('alpha').items.length, 0, 'source collection alpha should no longer contain the item');
  assert.strictEqual(harness.state.sessionCollections.get('beta').items.length, 0, 'source collection beta should no longer contain the item');

  const trash = harness.state.sessionCollections.get('trash');
  assert(trash, 'move-to-trash should create the system trash collection');
  assert.strictEqual(trash.system, true, 'trash collection should be system protected');
  assert.strictEqual(trash.items.length, 1, 'trash should contain the trashed item');
  assert.strictEqual(trash.items[0].trashedFrom.length, 2, 'trash item should remember all source collections');
  assert.strictEqual(trash.items[0].trashedFrom[0].name, 'Alpha', 'trash item should remember source collection names for confirmation/restoration');
  assert.strictEqual(harness.api.isCollectionItemInTrash(item), true, 'move-to-trash should mark the item as currently in trash');
  assert.strictEqual(harness.api.isCollectionItemHiddenFromCollections(item), true, 'items currently in trash should be hidden from Default and ordinary collection views');
}

function testRestoreFromTrashReturnsItemToOriginalTags() {
  const harness = buildTrashHarness();
  const item = seedCollections(harness);
  harness.api.moveCollectionItemToTrash(item);

  const result = harness.api.restoreCollectionItemFromTrash(item);

  assert.deepStrictEqual(
    result.restoredCollections.map((entry) => entry.collectionId).sort(),
    ['alpha', 'beta'],
    'restore should report every restored source collection'
  );
  assert.strictEqual(harness.state.sessionCollections.get('trash').items.length, 0, 'restore should remove the item from trash');
  assert.strictEqual(harness.state.sessionCollections.get('alpha').items.length, 1, 'restore should put item back in alpha');
  assert.strictEqual(harness.state.sessionCollections.get('beta').items.length, 1, 'restore should put item back in beta');
  assert.strictEqual(harness.api.isCollectionItemInTrash(item), false, 'restored item should no longer be in trash');
  assert.strictEqual(harness.api.isCollectionItemHiddenFromCollections(item), false, 'restored item should become visible again');
  assert.strictEqual(harness.api.isCollectionItemDiscarded(item), false, 'restored item should not be marked discarded');
}

function testEmptyTrashDiscardsAppRecordsWithoutDeletingSessions() {
  const harness = buildTrashHarness();
  const item = seedCollections(harness);
  harness.api.moveCollectionItemToTrash(item);

  const result = harness.api.emptyTrashCollection();

  assert.strictEqual(result.discardedItems.length, 1, 'empty trash should return discarded app records');
  assert.strictEqual(harness.state.sessionCollections.get('trash').items.length, 0, 'trash collection should be empty after empty-trash');
  assert.strictEqual(harness.api.isCollectionItemDiscarded(item), true, 'empty trash should hide the item from app lists through a tombstone');
  assert.strictEqual(harness.api.isCollectionItemHiddenFromCollections(item), true, 'discarded items should stay hidden from app lists after trash is emptied');
  assert.strictEqual(result.deletedFiles, undefined, 'empty trash must not claim to delete Codex transcript files');
  assert.strictEqual(result.discardedItems[0].discardedAt.includes('2026-06-28T'), true, 'discarded tombstone should record when it was hidden');
}

function testFrontendExposesTrashActionsAndConfirmations() {
  for (const needle of [
    'moveConversationToTrash',
    'restoreConversationFromTrash',
    'emptyTrashCollection',
    'isConversationInTrash',
    'isConversationHiddenByTrash',
    'Move to trash',
    'Restore',
    'Empty trash',
    'cannot be restored from Trash',
    'Codex history files will not be deleted',
  ]) {
    assertContains(app, needle, `frontend should include ${needle}`);
  }
}

testMoveToTrashRecordsMembershipsAndRemovesSourceTags();
testRestoreFromTrashReturnsItemToOriginalTags();
testEmptyTrashDiscardsAppRecordsWithoutDeletingSessions();
testFrontendExposesTrashActionsAndConfirmations();

console.log('session trash assertions passed');
