const assert = require('assert');
const {
  pruneExpiredSessionWatches,
  removeSessionWatch,
  upsertSessionWatch,
  watchOwnerKey,
} = require('../apps/host-agent/session-watch-registry');

function command(clientId, sessionId, revision, options = {}) {
  return {
    clientId,
    viewId: options.viewId || 'primary',
    sessionId,
    nativeThreadId: options.nativeThreadId || sessionId,
    conversationKey: options.conversationKey || sessionId,
    watchRevision: revision,
  };
}

function found(sessionId, options = {}) {
  return {
    sessionId,
    nativeThreadId: options.nativeThreadId || sessionId,
    conversationKey: options.conversationKey || sessionId,
    rolloutPath: Object.prototype.hasOwnProperty.call(options, 'rolloutPath')
      ? options.rolloutPath
      : `/sessions/${sessionId}.jsonl`,
  };
}

function main() {
  let now = 1_000;
  const ttlMs = 300_000;
  const entries = new Map();
  const ownerRevisions = new Map();
  const options = { now: () => now, ttlMs, ownerRevisions };

  const tabAHistoryA = command('tab-a', 'history-a', 1);
  const tabBHistoryA = command('tab-b', 'history-a', 1);
  assert.strictEqual(upsertSessionWatch(entries, tabAHistoryA, found('history-a'), options).accepted, true);
  assert.strictEqual(upsertSessionWatch(entries, tabBHistoryA, found('history-a'), options).accepted, true);
  assert.strictEqual(entries.size, 2, 'two browser tabs must own independent selected leases');

  const tabAHistoryB = command('tab-a', 'history-b', 2);
  const replacement = upsertSessionWatch(entries, tabAHistoryB, found('history-b'), options);
  assert.strictEqual(replacement.accepted, true);
  assert.strictEqual(replacement.replaced, true, 'the same view should atomically replace its previous selection');
  assert.strictEqual(entries.size, 2, 'replacement must not accumulate another selected lease');
  assert.strictEqual(entries.get(watchOwnerKey(tabAHistoryB)).sessionId, 'history-b');
  assert.strictEqual(entries.get(watchOwnerKey(tabBHistoryA)).sessionId, 'history-a');

  const staleWatch = upsertSessionWatch(entries, tabAHistoryA, found('history-a'), options);
  assert.strictEqual(staleWatch.accepted, false, 'an older A watch must not replace current B');
  assert.strictEqual(staleWatch.stale, true);
  assert.strictEqual(entries.get(watchOwnerKey(tabAHistoryB)).sessionId, 'history-b');

  const staleUnwatch = removeSessionWatch(entries, command('tab-a', 'history-a', 1), options);
  assert.strictEqual(staleUnwatch.removed, 0, 'an older unwatch must not clear the latest selected lease');
  assert.strictEqual(staleUnwatch.stale, true);

  const tabAUnwatch = removeSessionWatch(entries, command('tab-a', 'history-b', 3), options);
  assert.strictEqual(tabAUnwatch.removed, 1);
  assert.strictEqual(entries.size, 1);
  assert.strictEqual(entries.get(watchOwnerKey(tabBHistoryA)).sessionId, 'history-a', 'one tab must not unwatch another tab');

  const tabCUnwatch = removeSessionWatch(entries, command('tab-c', 'future-session', 5), options);
  assert.strictEqual(tabCUnwatch.removed, 0);
  const staleAfterClose = upsertSessionWatch(
    entries,
    command('tab-c', 'future-session', 4),
    found('future-session'),
    options
  );
  assert.strictEqual(staleAfterClose.accepted, false, 'an unwatch tombstone must reject a delayed older watch');
  assert.strictEqual(staleAfterClose.stale, true);

  const tabDHistoryA = command('tab-d', 'history-a', 1);
  upsertSessionWatch(entries, tabDHistoryA, found('history-a'), options);
  const unresolvedReplacement = upsertSessionWatch(
    entries,
    command('tab-d', 'starting-session', 2),
    found('starting-session', { rolloutPath: null }),
    options
  );
  assert.strictEqual(unresolvedReplacement.accepted, true);
  assert.strictEqual(unresolvedReplacement.replaced, true);
  assert.strictEqual(
    entries.get(watchOwnerKey(tabDHistoryA)).sessionId,
    'starting-session',
    'an unresolved new selection must still evict the old non-live watch'
  );
  assert.strictEqual(entries.get(watchOwnerKey(tabDHistoryA)).rolloutPath, null);

  now += ttlMs + 1;
  const removed = pruneExpiredSessionWatches(entries, { now: () => now, ownerRevisions });
  assert.strictEqual(removed, 2, 'expired selected history leases should be released');
  assert.strictEqual(entries.size, 0);
  assert.strictEqual(ownerRevisions.size, 0, 'expired revision tombstones must also be bounded');

  console.log('session watch registry assertions passed');
}

main();
