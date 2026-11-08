const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionRecordStore } = require('../apps/relay/session-record-store');
const { ActivitySnapshotStore } = require('../shared/activity-snapshot-store');
const {
  ThinkingActivityPersistence,
  mergeThinkingHistory,
} = require('../apps/relay/thinking-activity-persistence');

function fixture(overrides = {}) {
  return {
    canonicalConversationKey: 'host-a::session-a',
    runId: 'run-a',
    turnId: 'turn-a',
    itemId: 'item-a',
    summaryIndex: 0,
    kind: 'reasoning',
    status: 'completed',
    activityRevision: 1,
    final: true,
    startedAt: '2026-08-14T01:00:00.000Z',
    timestamp: '2026-08-14T01:00:01.000Z',
    text: 'completed reasoning',
    ...overrides,
  };
}

function readAllFiles(rootDir) {
  const values = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) values.push(fs.readFileSync(entryPath, 'utf8'));
    }
  };
  visit(rootDir);
  return values.join('\n');
}

async function seedRecord(store, canonicalKey = 'host-a::session-a') {
  await store.transact('test.thinking.seed', (tx) => {
    const record = tx.ensureRecord(canonicalKey, {
      hostId: canonicalKey.split('::')[0],
      conversationKey: canonicalKey.split('::').slice(1).join('::'),
    });
    record.title = canonicalKey;
    tx.setAlias(canonicalKey, canonicalKey);
    tx.markDirty(canonicalKey);
  });
}

async function main() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-thinking-persist-'));
  let store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1000 });
  await seedRecord(store);
  const persistence = new ThinkingActivityPersistence({
    sessionRecordStore: store,
    maxActivitiesPerSession: 3,
    maxActivityBytes: 1400,
    maxSessionBytes: 3100,
  });

  const initialRevision = store.readSnapshot().storeRevision;
  assert.deepStrictEqual(
    await persistence.persist('host-a::session-a', fixture({ final: false, status: 'running' })),
    { persisted: false, reason: 'not_terminal' }
  );
  assert.strictEqual(
    store.readSnapshot().storeRevision,
    initialRevision,
    'non-final activity must not append a Session Store WAL revision'
  );

  const first = await persistence.persist('host-a::session-a', fixture({
    apiKey: 'field-secret-must-not-persist',
    arguments: { authorization: 'Bearer nested-secret-must-not-persist', safe: 'kept' },
    text: 'Authorization: Bearer text-secret-must-not-persist',
  }));
  assert.strictEqual(first.persisted, true);
  let durable = store.readSnapshot().records['host-a::session-a'].thinking;
  assert.strictEqual(durable.activities.length, 1);
  assert.strictEqual(durable.activities[0].firstObservedOrdinal, 1);
  assert.strictEqual(durable.activities[0].startedAt, '2026-08-14T01:00:00.000Z');
  assert.strictEqual(durable.activities[0].arguments.safe, 'kept');
  assert(!JSON.stringify(durable).includes('field-secret-must-not-persist'));
  assert(!JSON.stringify(durable).includes('nested-secret-must-not-persist'));
  assert(!JSON.stringify(durable).includes('text-secret-must-not-persist'));

  const cyclicArguments = { safe: 'cycle-safe' };
  cyclicArguments.self = cyclicArguments;
  const cyclic = await persistence.persist('host-a::session-a', fixture({
    itemId: 'cyclic-protocol-payload',
    activityRevision: 1,
    arguments: cyclicArguments,
    output: { nested: cyclicArguments },
  }));
  assert.strictEqual(
    cyclic.persisted,
    true,
    'cyclic protocol payloads must degrade to a bounded durable representation'
  );
  durable = store.readSnapshot().records['host-a::session-a'].thinking;
  const cyclicActivity = durable.activities.find((activity) => activity.itemId === 'cyclic-protocol-payload');
  assert(cyclicActivity, 'cyclic terminal activity must be retained');
  assert.strictEqual(cyclicActivity.arguments.self, '[Circular]');
  assert.strictEqual(cyclicActivity.arguments.safe, 'cycle-safe');
  assert(!JSON.stringify(durable).includes('[object Object]'));

  const cyclicArray = [];
  cyclicArray.push(cyclicArray);
  const special = await persistence.persist('host-a::session-a', fixture({
    itemId: 'special-protocol-payload',
    activityRevision: 1,
    arguments: cyclicArray,
    result: {
      when: new Date('2026-08-30T01:02:03.000Z'),
      mapping: new Map([['safe', 42], ['authorization', 'Bearer hidden-map-secret']]),
      selection: new Set(['alpha', 'beta']),
      bytes: Buffer.from('binary secret must not persist'),
      count: 7n,
    },
  }));
  assert.strictEqual(special.persisted, true);
  durable = store.readSnapshot().records['host-a::session-a'].thinking;
  const specialActivity = durable.activities.find((activity) => activity.itemId === 'special-protocol-payload');
  assert(specialActivity, 'special terminal activity must be retained');
  assert.strictEqual(specialActivity.arguments[0], '[Circular]');
  assert.strictEqual(specialActivity.result.when, '2026-08-30T01:02:03.000Z');
  assert.deepStrictEqual(specialActivity.result.mapping, { $map: [['safe', 42]] });
  assert.deepStrictEqual(specialActivity.result.selection, { $set: ['alpha', 'beta'] });
  assert.strictEqual(specialActivity.result.bytes, '[Buffer 30 bytes]');
  assert.strictEqual(specialActivity.result.count, '7');
  assert(!JSON.stringify(specialActivity).includes('hidden-map-secret'));
  assert(!JSON.stringify(specialActivity).includes('binary secret must not persist'));

  const throwingIdentity = fixture({ itemId: 'unreachable' });
  Object.defineProperty(throwingIdentity, 'itemId', {
    enumerable: true,
    get() {
      throw new Error('identity getter failed');
    },
  });
  assert.deepStrictEqual(
    await persistence.persist('host-a::session-a', throwingIdentity),
    { persisted: false, reason: 'invalid_activity' },
    'throwing identity getters must be rejected without failing the persistence queue'
  );
  assert.deepStrictEqual(
    await persistence.persist('host-a::session-a', fixture({ activityRevision: Symbol('revision') })),
    { persisted: false, reason: 'invalid_activity' },
    'non-coercible revisions must be rejected without throwing'
  );

  const revisionAfterFirst = store.readSnapshot().storeRevision;
  for (const stale of [
    fixture({ activityRevision: undefined, text: 'missing revision' }),
    fixture({ activityRevision: 1, text: 'equal revision' }),
    fixture({ activityRevision: 0, text: 'old revision' }),
    fixture({ activityRevision: 2, final: false, status: 'running', text: 'non-final regression' }),
  ]) {
    const result = await persistence.persist('host-a::session-a', stale);
    assert.strictEqual(result.persisted, false);
  }
  assert.strictEqual(
    store.readSnapshot().storeRevision,
    revisionAfterFirst,
    'missing, stale, and non-final revisions must not write WAL'
  );

  const update = await persistence.persist('host-a::session-a', fixture({
    activityRevision: 2,
    startedAt: '2026-08-14T09:00:00.000Z',
    timestamp: '2026-08-14T09:00:01.000Z',
    text: 'newer terminal revision',
  }));
  assert.strictEqual(update.persisted, true);
  durable = store.readSnapshot().records['host-a::session-a'].thinking;
  assert.strictEqual(durable.activities[0].text, 'newer terminal revision');
  assert.strictEqual(durable.activities[0].firstObservedOrdinal, 1);
  assert.strictEqual(
    durable.activities[0].startedAt,
    '2026-08-14T01:00:00.000Z',
    'in-place terminal updates must preserve the original start time'
  );

  const competingPersistence = new ThinkingActivityPersistence({
    sessionRecordStore: store,
    maxActivitiesPerSession: 3,
    maxActivityBytes: 1400,
    maxSessionBytes: 3100,
  });
  const revisionBeforeRace = store.readSnapshot().storeRevision;
  const [newerRace, staleRace] = await Promise.all([
    persistence.persist('host-a::session-a', fixture({ activityRevision: 4, text: 'race-newer' })),
    competingPersistence.persist('host-a::session-a', fixture({ activityRevision: 3, text: 'race-stale' })),
  ]);
  assert.strictEqual(newerRace.persisted, true);
  assert.deepStrictEqual(staleRace, { persisted: false, reason: 'stale_revision' });
  assert.strictEqual(
    store.readSnapshot().storeRevision,
    revisionBeforeRace + 1,
    'a stale concurrent terminal write must abort before an empty WAL revision is appended'
  );
  assert.strictEqual(
    store.readSnapshot().records['host-a::session-a'].thinking.activities[0].text,
    'race-newer',
    'a second persistence instance must not regress a completed activity'
  );
  const terminalStatus = await persistence.persist('host-a::session-a', fixture({
    itemId: 'terminal-status-without-final-flag',
    final: false,
    status: 'completed',
  }));
  assert.strictEqual(
    terminalStatus.persisted,
    true,
    'an explicitly terminal structured status is durable even without a final flag'
  );

  for (let index = 1; index <= 5; index += 1) {
    await persistence.persist('host-a::session-a', fixture({
      itemId: `bounded-${index}`,
      activityRevision: 1,
      text: `${index}:${'x'.repeat(2400)}`,
    }));
  }
  durable = store.readSnapshot().records['host-a::session-a'].thinking;
  assert(durable.activities.length <= 3, 'history count must be bounded');
  assert(durable.totalBytes <= 3100, 'per-session persisted bytes must be bounded');
  assert(
    durable.activities.every((activity) => Buffer.byteLength(JSON.stringify(activity), 'utf8') <= 1400),
    'each persisted activity must obey its byte limit'
  );
  assert(
    durable.activities.some((activity) => activity.textTruncated === true),
    'oversized text must disclose truncation'
  );

  await store.close();
  const persistedFiles = readAllFiles(rootDir);
  for (const secret of [
    'field-secret-must-not-persist',
    'nested-secret-must-not-persist',
    'text-secret-must-not-persist',
  ]) {
    assert(!persistedFiles.includes(secret), `secret leaked into Session Store artifacts: ${secret}`);
  }

  store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1000 });
  const hydratedStore = new ActivitySnapshotStore({ maxRecordBytes: 2048 });
  const reopenedPersistence = new ThinkingActivityPersistence({
    sessionRecordStore: store,
    maxActivitiesPerSession: 3,
    maxActivityBytes: 1400,
    maxSessionBytes: 3100,
  });
  const hydrated = reopenedPersistence.hydrate(hydratedStore, { epoch: 'relay-epoch-restart' });
  const durableAfterRestart = store.readSnapshot().records['host-a::session-a'].thinking.activities;
  assert.strictEqual(hydrated.accepted, durableAfterRestart.length);
  assert.strictEqual(hydratedStore.summary('host-a::session-a').count, durableAfterRestart.length);
  assert(
    hydratedStore.snapshot('host-a::session-a').every((activity) => activity.final === true),
    'hydration must restore only terminal snapshots'
  );

  const winner = {
    schemaVersion: 1,
    nextOrdinal: 4,
    activities: [
      fixture({ itemId: 'winner-first', firstObservedOrdinal: 1 }),
      fixture({ itemId: 'duplicate', activityRevision: 1, firstObservedOrdinal: 3, text: 'winner-old' }),
    ],
  };
  const loser = {
    schemaVersion: 1,
    nextOrdinal: 8,
    activities: [
      fixture({ itemId: 'loser-first', firstObservedOrdinal: 2 }),
      fixture({
        itemId: 'duplicate',
        activityRevision: 4,
        firstObservedOrdinal: 7,
        startedAt: '2026-08-14T00:30:00.000Z',
        text: 'loser-new',
      }),
    ],
  };
  const merged = mergeThinkingHistory(winner, loser, {
    canonicalConversationKey: 'host-a::session-a',
    maxActivitiesPerSession: 8,
    maxActivityBytes: 4096,
    maxSessionBytes: 32 * 1024,
  });
  assert.deepStrictEqual(
    merged.activities.map((activity) => activity.itemId),
    ['winner-first', 'duplicate', 'loser-first'],
    'canonical merge must retain winner order, append loser-only entries, and deduplicate'
  );
  const duplicate = merged.activities.find((activity) => activity.itemId === 'duplicate');
  assert.strictEqual(duplicate.text, 'loser-new', 'the highest terminal revision must win content');
  assert.strictEqual(duplicate.firstObservedOrdinal, 3, 'dedupe must retain the winner observation slot');
  assert.strictEqual(duplicate.startedAt, '2026-08-14T01:00:00.000Z');
  assert.strictEqual(merged.activities[2].firstObservedOrdinal, 4, 'loser-only rows follow winner rows stably');

  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-thinking-alias-'));
  const aliasStore = await SessionRecordStore.open({ rootDir: aliasRoot, snapshotEvery: 1000 });
  const winnerKey = 'host-alias::winner';
  const loserKey = 'host-alias::loser';
  await seedRecord(aliasStore, winnerKey);
  await seedRecord(aliasStore, loserKey);
  await aliasStore.transact('test.thinking.alias_merge', (tx) => {
    tx.mergeRecordInto(winnerKey, loserKey, (winnerRecord) => winnerRecord);
  });
  const aliasPersistence = new ThinkingActivityPersistence({
    sessionRecordStore: aliasStore,
    maxActivitiesPerSession: 8,
    maxActivityBytes: 4096,
    maxSessionBytes: 32 * 1024,
  });
  const aliasResult = await aliasPersistence.persist(loserKey, fixture({
    canonicalConversationKey: loserKey,
    runId: 'alias-run',
    turnId: 'alias-turn',
    itemId: 'alias-final',
    text: 'persisted through a retired alias',
  }));
  assert.strictEqual(aliasResult.persisted, true);
  const aliasSnapshot = aliasStore.readSnapshot();
  assert.strictEqual(
    aliasSnapshot.records[loserKey],
    undefined,
    'persisting through a retired alias must not recreate the loser record'
  );
  assert.strictEqual(aliasSnapshot.aliases[loserKey], winnerKey);
  assert.strictEqual(aliasSnapshot.records[winnerKey].thinking.activities.length, 1);
  assert.strictEqual(
    aliasSnapshot.records[winnerKey].thinking.activities[0].canonicalConversationKey,
    winnerKey,
    'durable activity identity must use the resolved canonical winner key'
  );
  await aliasStore.close();

  await store.close();

  const batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-thinking-batch-'));
  const batchStore = await SessionRecordStore.open({ rootDir: batchRoot, snapshotEvery: 1000 });
  await seedRecord(batchStore, 'host-batch::session-batch');
  const batchPersistence = new ThinkingActivityPersistence({
    sessionRecordStore: batchStore,
    maxActivitiesPerSession: 32,
    maxActivityBytes: 2048,
    maxSessionBytes: 64 * 1024,
    now: () => '2026-08-14T02:00:00.000Z',
  });
  const batchRevision = batchStore.readSnapshot().storeRevision;
  const batchPending = batchPersistence.persistMany(
    'host-batch::session-batch',
    Array.from({ length: 20 }, (_, index) => fixture({
      canonicalConversationKey: 'host-batch::session-batch',
      runId: 'run-batch',
      turnId: 'turn-batch',
      itemId: `batch-item-${index}`,
      text: `batch activity ${index}`,
    }))
  );
  await batchPersistence.flush();
  const batchResult = await batchPending;
  assert.strictEqual(batchResult.persisted, true);
  assert.strictEqual(batchResult.persistedCount, 20);
  assert.strictEqual(
    batchStore.readSnapshot().storeRevision,
    batchRevision + 1,
    'twenty completed snapshots for one canonical Session must share one WAL revision'
  );
  const batchHistory = batchStore.readSnapshot().records['host-batch::session-batch'].thinking;
  assert.strictEqual(batchHistory.activities.length, 20);
  assert.strictEqual(batchHistory.updatedAt, '2026-08-14T02:00:00.000Z');
  await batchStore.close();

  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-thinking-global-'));
  let globalStore = await SessionRecordStore.open({ rootDir: globalRoot, snapshotEvery: 1000 });
  const globalKeys = Array.from({ length: 4 }, (_, index) => `host-global::session-${index + 1}`);
  for (const canonicalKey of globalKeys) await seedRecord(globalStore, canonicalKey);
  let clock = 0;
  const globalOptions = {
    sessionRecordStore: globalStore,
    maxActivitiesPerSession: 4,
    maxActivityBytes: 1000,
    maxSessionBytes: 1100,
    maxThinkingSessions: 2,
    maxTotalThinkingBytes: 1024,
    now: () => `2026-08-14T03:00:0${clock += 1}.000Z`,
  };
  let globalPersistence = new ThinkingActivityPersistence(globalOptions);
  for (let index = 0; index < 3; index += 1) {
    await globalPersistence.persist(globalKeys[index], fixture({
      canonicalConversationKey: globalKeys[index],
      runId: `global-run-${index}`,
      turnId: `global-turn-${index}`,
      itemId: `global-item-${index}`,
      text: `small-${index}`,
    }));
  }
  let globalSnapshot = globalStore.readSnapshot();
  let retainedKeys = globalKeys.filter(
    (canonicalKey) => globalSnapshot.records[canonicalKey]?.thinking?.activities?.length
  );
  assert.deepStrictEqual(
    retainedKeys,
    [globalKeys[1], globalKeys[2]],
    'global Session count retention must remove the oldest Thinking history first'
  );
  assert.strictEqual(
    globalSnapshot.records[globalKeys[0]].thinking,
    undefined,
    'global retention must clear the complete evicted history field'
  );

  const byteBoundResult = await globalPersistence.persist(globalKeys[3], fixture({
    canonicalConversationKey: globalKeys[3],
    runId: 'global-run-large',
    turnId: 'global-turn-large',
    itemId: 'global-item-large',
    text: 't'.repeat(4000),
    output: 'o'.repeat(4000),
    fileChanges: [{ path: 'large.js', diff: 'd'.repeat(4000) }],
  }));
  assert.strictEqual(byteBoundResult.persisted, true);
  assert.strictEqual(byteBoundResult.retained, true, 'the current Session must be evicted last');
  globalSnapshot = globalStore.readSnapshot();
  retainedKeys = globalKeys.filter(
    (canonicalKey) => globalSnapshot.records[canonicalKey]?.thinking?.activities?.length
  );
  const globalBytes = retainedKeys.reduce(
    (total, canonicalKey) => total + globalSnapshot.records[canonicalKey].thinking.totalBytes,
    0
  );
  assert(retainedKeys.length <= 2, 'global Thinking Session count must remain bounded');
  assert(globalBytes <= 1024, 'global Thinking activity bytes must remain bounded');
  assert.deepStrictEqual(
    retainedKeys,
    [globalKeys[3]],
    'the byte bound must clear the older retained history before the current large history'
  );
  assert(
    byteBoundResult.historiesCleared.includes(globalKeys[2]),
    'the batch result must report the older history removed by the global byte bound'
  );

  await globalStore.close();
  globalStore = await SessionRecordStore.open({ rootDir: globalRoot, snapshotEvery: 1000 });
  globalPersistence = new ThinkingActivityPersistence({
    ...globalOptions,
    sessionRecordStore: globalStore,
  });
  const globalHydratedStore = new ActivitySnapshotStore({ maxRecordBytes: 2048 });
  const globalHydrated = globalPersistence.hydrate(globalHydratedStore, {
    epoch: 'relay-global-retention-restart',
  });
  const reopenedGlobalSnapshot = globalStore.readSnapshot();
  const reopenedRetainedKeys = globalKeys.filter(
    (canonicalKey) => reopenedGlobalSnapshot.records[canonicalKey]?.thinking?.activities?.length
  );
  const expectedHydratedActivities = reopenedRetainedKeys.reduce(
    (total, canonicalKey) => (
      total + reopenedGlobalSnapshot.records[canonicalKey].thinking.activities.length
    ),
    0
  );
  assert.strictEqual(globalHydrated.conversations, reopenedRetainedKeys.length);
  assert.strictEqual(globalHydrated.accepted, expectedHydratedActivities);
  for (const canonicalKey of globalKeys.filter((key) => !reopenedRetainedKeys.includes(key))) {
    assert.strictEqual(
      globalHydratedStore.summary(canonicalKey).count,
      0,
      'hydrate must not recreate a globally evicted Thinking history'
    );
  }
  await globalStore.close();
  console.log('thinking activity persistence assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
