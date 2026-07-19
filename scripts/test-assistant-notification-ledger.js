const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deleteRetainedAssistantIdentities,
  emptyNotificationState,
  ingestAssistantObservation,
  mergeNotificationRecords,
  projectAssistantState,
} = require('../apps/relay/assistant-notification-ledger');
const { SessionRecordStore } = require('../apps/relay/session-record-store');

function fakeTx(startSeq = 0) {
  const records = new Map();
  const events = [];
  const dirty = new Set();
  let globalAssistantSeq = startSeq;
  return {
    records,
    events,
    dirty,
    ensureRecord(key, seed) {
      if (!records.has(key)) records.set(key, structuredClone(seed));
      return records.get(key);
    },
    getRecord: (key) => records.get(key) || null,
    allocateGlobalAssistantSeq() {
      globalAssistantSeq += 1;
      return globalAssistantSeq;
    },
    appendDomainEvent: (event) => events.push(structuredClone(event)),
    markDirty: (key) => dirty.add(key),
    currentSeq: () => globalAssistantSeq,
  };
}

function observation(id, at, previewText = id, overrides = {}) {
  return {
    assistantMessageId: id,
    assistantAt: at,
    firstObservedAt: at,
    finalized: true,
    notifiableCandidate: true,
    previewText,
    sourceIdentity: {
      nativeThreadId: 'native-1',
      streamId: 'rollout:native-1:file',
      sourceOffset: Number(id.replace(/\D/g, '')) || 1,
      sourceOrdinal: null,
      role: 'assistant',
      sourceTimestamp: at,
      finalContentDigest: null,
    },
    ...overrides,
  };
}

function ingestInStore(store, identity, value, baselineAt) {
  return store.transact('assistant.identity_assigned', (tx) => {
    const canonicalKey = tx.resolveCanonicalKey(identity);
    return ingestAssistantObservation(tx, {
      canonicalKey,
      lineageKey: `${identity.hostId}::${identity.sessionId}`,
      observation: value,
      baselineAt,
    });
  });
}

async function main() {
  const tx = fakeTx();
  const keyA = 'host::alias-a';
  const keyB = 'host::alias-b';
  tx.records.set(keyA, {
    canonicalKey: keyA,
    notification: emptyNotificationState('2026-07-16T10:00:00.000Z'),
  });
  tx.records.set(keyB, {
    canonicalKey: keyB,
    notification: emptyNotificationState('2026-07-16T10:00:00.000Z'),
  });

  const old = ingestAssistantObservation(tx, {
    canonicalKey: keyA,
    lineageKey: keyA,
    observation: observation('assistant-old', '2026-07-16T09:59:00.000Z'),
  });
  assert.strictEqual(old.entry.notifiable, false, 'pre-baseline history must not alert');
  const oldReobserved = ingestAssistantObservation(tx, {
    canonicalKey: keyA,
    lineageKey: keyA,
    observation: observation('assistant-old', '2026-07-16T10:05:00.000Z'),
  });
  assert.strictEqual(
    oldReobserved.entry.notifiable,
    false,
    'a finalized baseline import must not become notifiable when rediscovered later'
  );

  const a1 = ingestAssistantObservation(tx, {
    canonicalKey: keyA,
    lineageKey: keyA,
    observation: observation('assistant-a1', '2026-07-16T10:01:00.000Z'),
  });
  const b1 = ingestAssistantObservation(tx, {
    canonicalKey: keyB,
    lineageKey: keyB,
    observation: observation('assistant-b1', '2026-07-16T10:02:00.000Z'),
  });
  const a2 = ingestAssistantObservation(tx, {
    canonicalKey: keyA,
    lineageKey: keyA,
    observation: observation('assistant-a2', '2026-07-16T10:03:00.000Z'),
  });
  assert.deepStrictEqual(
    [a1.entry.assistantSeq, b1.entry.assistantSeq, a2.entry.assistantSeq],
    [2, 3, 4],
    'all Sessions must share one global first-observation order'
  );

  const updatedA1 = ingestAssistantObservation(tx, {
    canonicalKey: keyA,
    lineageKey: keyA,
    observation: observation('assistant-a1', '2026-07-16T10:01:00.000Z', 'updated preview'),
  });
  assert.strictEqual(updatedA1.created, false);
  assert.strictEqual(updatedA1.entry.assistantSeq, 2);
  assert.strictEqual(updatedA1.entry.previewText, 'updated preview');
  assert.strictEqual(
    tx.events.filter((event) => event.type === 'assistant.identity_assigned').length,
    4,
    'duplicate streaming updates must not allocate another durable identity'
  );

  const streaming = ingestAssistantObservation(tx, {
    canonicalKey: keyA,
    lineageKey: keyA,
    observation: observation('assistant-stream', '2026-07-16T09:58:00.000Z', 'partial', {
      finalized: false,
      notifiableCandidate: false,
    }),
  });
  assert.strictEqual(streaming.entry.notifiable, false);
  const finalized = ingestAssistantObservation(tx, {
    canonicalKey: keyA,
    lineageKey: keyA,
    observation: observation('assistant-stream', '2026-07-16T09:58:00.000Z', 'settled', {
      firstObservedAt: '2026-07-16T10:04:00.000Z',
    }),
  });
  assert.strictEqual(finalized.entry.assistantSeq, streaming.entry.assistantSeq);
  assert.strictEqual(finalized.entry.finalized, true);
  assert.strictEqual(finalized.entry.notifiable, true);

  const duplicateInB = {
    ...structuredClone(a1.entry),
    assistantSeq: 9,
    lineageKeys: [keyB],
  };
  tx.records.get(keyB).notification.ledger['assistant-a1'] = duplicateInB;
  tx.records.get(keyB).notification.sequenceAliases['12'] = 9;
  const merged = mergeNotificationRecords(tx.records.get(keyA), tx.records.get(keyB), {
    winnerKey: keyA,
    loserKey: keyB,
  });
  assert.strictEqual(merged.notification.ledger['assistant-a1'].assistantSeq, 2);
  assert.strictEqual(merged.notification.sequenceAliases['9'], 2);
  assert.strictEqual(merged.notification.sequenceAliases['12'], 2);
  assert.deepStrictEqual(
    merged.notification.ledger['assistant-a1'].lineageKeys.sort(),
    [keyA, keyB]
  );
  assert.strictEqual(merged.notification.ledger['assistant-b1'].assistantSeq, 3);
  assert.strictEqual(
    merged.notification.latestAssistantSeq,
    streaming.entry.assistantSeq,
    'latest projection is recomputed from retained notifiable entries'
  );

  const projection = projectAssistantState(merged, { afterSeq: 2, limit: 1 });
  assert.strictEqual(projection.messages.length, 1);
  assert.strictEqual(projection.messages[0].assistantMessageId, 'assistant-b1');
  assert.strictEqual(projection.hasMore, true);
  assert.strictEqual(projection.nextAfterSeq, 3);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(projection.messages[0], 'sourceIdentity'),
    false,
    'public projections must not expose ingestion coordinates'
  );

  const deletedSeq = merged.notification.ledger['assistant-a1'].assistantSeq;
  const deleted = deleteRetainedAssistantIdentities(tx, keyA, ['assistant-a1', 'missing']);
  assert.deepStrictEqual(deleted.deletedAssistantIds, ['assistant-a1']);
  assert.strictEqual(merged.notification.ledger['assistant-a1'], undefined);
  assert.strictEqual(
    Object.values(merged.notification.sequenceAliases).includes(deletedSeq),
    false,
    'sequence aliases targeting deleted history must be pruned'
  );

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-assistant-ledger-'));
  const identity = { hostId: 'host', sessionId: 'native-1' };
  const baselineAt = '2026-07-16T10:00:00.000Z';
  const persistentObservation = observation(
    'assistant-persisted',
    '2026-07-16T10:05:00.000Z',
    'persisted preview'
  );
  let store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1 });
  const original = await ingestInStore(store, identity, persistentObservation, baselineAt);
  assert.strictEqual(original.entry.assistantSeq, 1);
  await store.close();

  store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1 });
  const duplicate = await ingestInStore(store, identity, persistentObservation, baselineAt);
  assert.strictEqual(duplicate.created, false);
  assert.strictEqual(duplicate.entry.assistantSeq, original.entry.assistantSeq);
  assert.strictEqual(store.readSnapshot().globalAssistantSeq, 1);
  await store.close();

  fs.writeFileSync(path.join(rootDir, 'snapshot-current.json'), '{broken-current-snapshot');
  store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1 });
  const recoveredRecord = store.readRecord(identity);
  assert.strictEqual(
    recoveredRecord.notification.ledger['assistant-persisted'].assistantMessageId,
    'assistant-persisted'
  );
  assert.strictEqual(
    recoveredRecord.notification.ledger['assistant-persisted'].assistantSeq,
    original.entry.assistantSeq,
    'WAL recovery must restore the identity-to-sequence mapping, not only high-water'
  );

  const revisionsBefore = store.readSnapshot().storeRevision;
  await Promise.all([
    store.transact('session.provenance.test', (storeTx) => {
      const key = storeTx.resolveCanonicalKey(identity);
      const record = storeTx.ensureRecord(key);
      record.title = 'concurrent provenance';
      storeTx.markDirty(key);
    }),
    ingestInStore(
      store,
      identity,
      observation('assistant-concurrent', '2026-07-16T10:06:00.000Z'),
      baselineAt
    ),
  ]);
  assert.strictEqual(store.readSnapshot().storeRevision, revisionsBefore + 2);
  assert.strictEqual(store.readRecord(identity).title, 'concurrent provenance');
  assert.strictEqual(
    store.readRecord(identity).notification.ledger['assistant-concurrent'].assistantSeq,
    2
  );

  const aliasIdentity = { hostId: 'host', sessionId: 'bridge-1' };
  const aliasDuplicate = await ingestInStore(
    store,
    aliasIdentity,
    observation('assistant-concurrent', '2026-07-16T10:06:00.000Z'),
    baselineAt
  );
  assert.strictEqual(aliasDuplicate.entry.assistantSeq, 3);
  await store.transact('session.alias_merged', (storeTx) => {
    const winnerKey = storeTx.resolveCanonicalKey(identity);
    const loserKey = storeTx.resolveCanonicalKey(aliasIdentity);
    storeTx.mergeRecordInto(winnerKey, loserKey, (winner, loser) => (
      mergeNotificationRecords(winner, loser, { winnerKey, loserKey })
    ));
    storeTx.setAlias('host::bridge-1', winnerKey);
  });
  const aliasedRecord = store.readRecord(aliasIdentity);
  assert.strictEqual(
    aliasedRecord.notification.ledger['assistant-concurrent'].assistantSeq,
    2
  );
  assert.strictEqual(aliasedRecord.notification.sequenceAliases['3'], 2);
  await store.close();

  store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1 });
  assert.strictEqual(
    store.readRecord(aliasIdentity).notification.sequenceAliases['3'],
    2,
    'alias merge and its losing sequence mapping must survive restart'
  );
  assert.strictEqual(store.readSnapshot().globalAssistantSeq, 3);
  await store.close();

  console.log('assistant notification ledger assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
