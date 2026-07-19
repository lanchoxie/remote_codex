const assert = require('assert');
const { ActivitySnapshotStore } = require('../shared/activity-snapshot-store');

const store = new ActivitySnapshotStore();
const base = {
  runId: 'r1',
  turnId: 't1',
  itemId: 'i1',
  summaryIndex: 0,
};

const accepted = store.accept('epoch-a', 'h::c', {
  ...base,
  canonicalConversationKey: 'stale::alias',
  activityKey: 'stale-key',
  activityRevision: 2,
  text: 'two',
});
assert.strictEqual(accepted.text, 'two');
assert.strictEqual(accepted.canonicalConversationKey, 'h::c');
assert.strictEqual(
  accepted.activityKey,
  '["h::c","r1","t1","i1",0]',
  'the store should recompute keys from the resolved canonical conversation'
);
assert.strictEqual(
  store.accept('epoch-a', 'h::c', { ...base, activityRevision: 2, text: 'duplicate' }),
  null
);
assert.strictEqual(
  store.accept('epoch-a', 'h::c', { ...base, activityRevision: 1, text: 'old' }),
  null
);

accepted.text = 'mutated outside';
assert.strictEqual(store.snapshot('h::c')[0].text, 'two', 'accepted records should not expose store state');

store.accept('epoch-a', 'other::conversation', {
  ...base,
  activityRevision: 9,
  text: 'independent',
});
store.reset('epoch-b', 'h::c', [
  { ...base, turnId: 't2', itemId: 'i2', activityRevision: 1, text: 'later turn' },
  { ...base, summaryIndex: 1, activityRevision: 1, text: 'second summary' },
  { ...base, activityRevision: 1, text: 'rebuilt' },
]);

const rebuilt = store.snapshot('h::c');
assert.deepStrictEqual(
  rebuilt.map((snapshot) => snapshot.text),
  ['rebuilt', 'second summary', 'later turn'],
  'snapshots should be sorted by turn, item, and summary index'
);
assert.strictEqual(
  store.accept('epoch-b', 'h::c', { ...base, activityRevision: 1, text: 'reset duplicate' }),
  null,
  'reset snapshots should establish the new revision baseline'
);
assert.strictEqual(
  store.accept('epoch-b', 'h::c', { ...base, activityRevision: 2, text: 'newer' }).text,
  'newer'
);
assert.strictEqual(store.snapshot('other::conversation')[0].text, 'independent');

store.accept('epoch-b', 'alias::conversation', {
  ...base,
  activityRevision: 3,
  text: 'merged alias',
});
const merged = store.mergeCanonicalKey(
  'epoch-b',
  'alias::conversation',
  'h::c'
);
assert(merged.some((entry) => entry.text === 'merged alias'));
assert(merged.every((entry) => entry.canonicalConversationKey === 'h::c'));
assert.strictEqual(store.snapshot('alias::conversation').length, 0);

const externalSnapshot = store.snapshot('h::c');
const retainedText = externalSnapshot[0].text;
externalSnapshot[0].text = 'mutated snapshot';
assert.strictEqual(store.snapshot('h::c')[0].text, retainedText, 'snapshot() should return clones');

console.log('activity snapshot store assertions passed');
