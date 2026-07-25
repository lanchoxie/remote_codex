const assert = require('assert');
const {
  ActivitySnapshotStore,
  makeActivityRecoveryToken,
} = require('../shared/activity-snapshot-store');

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
const acceptedRecoveryToken = makeActivityRecoveryToken(accepted.activityKey);
assert.strictEqual(
  store.activityByRecoveryToken('h::c', acceptedRecoveryToken).text,
  'two',
  'compact live invalidations should resolve one authoritative activity without a full snapshot'
);
assert.strictEqual(store.activityByRecoveryToken('h::c', 'missing-token'), null);

const structured = store.accept('epoch-a', 'h::structured', {
  runId: 'run-structured',
  turnId: 'turn-structured',
  itemId: 'item-structured',
  callId: 'call-structured',
  requestId: 'request-structured',
  activityRevision: 1,
  kind: 'command-output',
  itemType: 'commandExecution',
  method: 'item/completed',
  status: 'completed',
  text: 'command completed',
  command: 'npm test',
  cwd: 'D:/workspace',
  output: 'all tests passed',
  outputTruncated: true,
  exitCode: 0,
  durationMs: 42,
  processId: 'process-structured',
  stream: 'stderr',
  success: false,
  arguments: { script: '<literal>' },
  result: { ok: true },
  commandActions: [{ type: 'read', path: 'package.json' }],
  fileChanges: [{ path: 'src/app.js', status: 'modified', diff: '-old\n+new' }],
});
assert.deepStrictEqual(
  {
    callId: structured.callId,
    requestId: structured.requestId,
    itemType: structured.itemType,
    status: structured.status,
    command: structured.command,
    cwd: structured.cwd,
    output: structured.output,
    outputTruncated: structured.outputTruncated,
    exitCode: structured.exitCode,
    durationMs: structured.durationMs,
    processId: structured.processId,
    stream: structured.stream,
    success: structured.success,
    arguments: structured.arguments,
    result: structured.result,
    commandActions: structured.commandActions,
    fileChanges: structured.fileChanges,
  },
  {
    callId: 'call-structured',
    requestId: 'request-structured',
    itemType: 'commandExecution',
    status: 'completed',
    command: 'npm test',
    cwd: 'D:/workspace',
    output: 'all tests passed',
    outputTruncated: true,
    exitCode: 0,
    durationMs: 42,
    processId: 'process-structured',
    stream: 'stderr',
    success: false,
    arguments: { script: '<literal>' },
    result: { ok: true },
    commandActions: [{ type: 'read', path: 'package.json' }],
    fileChanges: [{ path: 'src/app.js', status: 'modified', diff: '-old\n+new' }],
  },
  'structured activity fields should survive Relay storage unchanged'
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

const contentRevisionPage = store.snapshotPage('h::c');
store.accept('epoch-b', 'h::c', {
  ...base,
  activityRevision: 3,
  text: 'live content update',
});
const contentUpdatePage = store.snapshotPage('h::c', {
  expectedRevision: contentRevisionPage.revision,
});
assert.strictEqual(
  contentUpdatePage.restartRequired,
  false,
  'same-key live text updates must not invalidate membership pagination'
);
assert.strictEqual(contentUpdatePage.revision, contentRevisionPage.revision);

const bounded = new ActivitySnapshotStore({
  maxConversations: 2,
  maxRecordsPerConversation: 2,
  maxRecordBytes: 1024,
  maxTotalBytes: 4096,
  pageLimit: 1,
  pageBytes: 1024,
});
for (let index = 0; index < 3; index += 1) {
  bounded.accept('epoch-bounded', 'bounded::one', {
    ...base,
    itemId: `item-${index}`,
    activityRevision: 1,
    text: index === 2 ? 'x'.repeat(4096) : `record-${index}`,
  });
}
assert.strictEqual(bounded.summary('bounded::one').count, 2, 'per-conversation record count must be bounded');
assert.strictEqual(
  bounded.snapshot('bounded::one').at(-1).textTruncated,
  true,
  'oversized activity text must be truncated before storage'
);
const firstPage = bounded.snapshotPage('bounded::one');
assert.strictEqual(firstPage.activities.length, 1);
assert.strictEqual(firstPage.hasMore, true);
const secondPage = bounded.snapshotPage('bounded::one', { cursor: firstPage.nextCursor });
assert.strictEqual(secondPage.activities.length, 1);
assert.strictEqual(secondPage.hasMore, false);
const revisionPage = bounded.snapshotPage('bounded::one');
bounded.accept('epoch-bounded', 'bounded::one', {
  ...base,
  itemId: 'item-new',
  activityRevision: 1,
  text: 'new revision',
});
const stalePage = bounded.snapshotPage('bounded::one', {
  cursor: revisionPage.nextCursor,
  expectedRevision: revisionPage.revision,
});
assert.strictEqual(stalePage.restartRequired, true, 'pagination must restart after a live mutation');

assert.strictEqual(store.pageBytes, 512 * 1024);
assert.deepStrictEqual(
  store.snapshotPage('h::c', { maxBytes: null }).activities,
  store.snapshotPage('h::c').activities,
  'a missing HTTP maxBytes query must retain the configured page budget'
);

bounded.accept('epoch-bounded', 'bounded::two', { ...base, activityRevision: 1, text: 'two' });
bounded.accept('epoch-bounded', 'bounded::three', { ...base, activityRevision: 1, text: 'three' });
assert.strictEqual(bounded.conversations.size, 2, 'conversation count must be globally bounded');
assert.strictEqual(bounded.summary('bounded::one').count, 0, 'the least-recent conversation should be evicted');
assert(bounded.totalBytes <= bounded.maxTotalBytes, 'activity store byte budget must be enforced');

console.log('activity snapshot store assertions passed');
