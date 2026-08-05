const assert = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SessionRecordStore,
  StoreRecoveryError,
} = require('../apps/relay/session-record-store');
const {
  redactSecretText,
  stripSecrets,
} = require('../shared/secret-redaction');

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readAllFiles(rootDir) {
  const values = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        values.push(fs.readFileSync(entryPath, 'utf8'));
      }
    }
  };
  visit(rootDir);
  return values.join('\n');
}

function isolatedRelayEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of [
    'RELAY_STATE_ROOT',
    'SESSION_RECORD_STORE_ROOT',
    'SESSION_COLLECTIONS_PATH',
    'SESSION_METADATA_PATH',
    'SESSION_LOGS_PATH',
    'SESSION_DIAGNOSTICS_PATH',
    'CONNECTORS_PATH',
    'CONNECTOR_SECRETS_PATH',
    'SKILL_FAVORITES_PATH',
    'SKILL_SOURCES_PATH',
    'SKILL_LIBRARY_PATH',
    'SKILL_INVENTORIES_PATH',
    'SKILL_REGISTRY_PATH',
    'SKILL_ARTIFACT_ROOT',
    'SKILL_DEPLOYMENTS_PATH',
    'SKILL_AUDIT_PATH',
    'RELAY_AUTH_TOKEN_PATH',
    'RELAY_AUTH_ACCOUNT_PATH',
    'RELAY_LOCAL_AGENT_START_ENABLED',
    'RELAY_LOCAL_HOST_ID',
    'LOCAL_CODEX_HOME',
    'REMOTE_CODEX_STATE_ROOT',
    'AGENTS_HOME',
    'CC_SWITCH_HOME',
    'SKILL_ARTIFACT_TEMP_ROOT',
  ]) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

const additionalSecretMarkers = {
  secretKey: 'secret-key-opaque-marker',
  accessKey: 'access-key-opaque-marker',
  accountKey: 'account-key-opaque-marker',
  storageKey: 'storage-key-opaque-marker',
  encryptionKey: 'encryption-key-opaque-marker',
  connectionString: 'connection-string-opaque-marker',
};
const strippedAdditionalSecrets = stripSecrets({
  safeMetadata: 'kept',
  ...additionalSecretMarkers,
});
assert.deepStrictEqual(
  strippedAdditionalSecrets,
  { safeMetadata: 'kept' },
  'common cloud/database secret key fields must be removed recursively'
);
const azureConnectionError = redactSecretText(
  'Azure storage failed: DefaultEndpointsProtocol=https;AccountName=example;AccountKey=azure-account-key-opaque-marker;EndpointSuffix=core.windows.net'
);
assert(!azureConnectionError.includes('azure-account-key-opaque-marker'));
assert(azureConnectionError.includes('AccountName=example'), 'non-secret connection metadata should remain useful');

function writeSnapshotEnvelope(filePath, projection) {
  fs.writeFileSync(filePath, `${JSON.stringify({
    revision: projection.storeRevision,
    checksum: checksum(projection),
    projection,
  }, null, 2)}\n`);
}

async function testEqualRevisionSnapshotForkFailsClosed() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-snapshot-fork-'));
  const base = {
    schemaVersion: 1,
    storeId: 'snapshot-fork-store',
    generation: 2,
    storeRevision: 7,
    globalAssistantSeq: 0,
    records: {
      'host-a::session-a': { title: 'current branch' },
    },
    aliases: {
      'host-a::session-a': 'host-a::session-a',
    },
  };
  writeSnapshotEnvelope(path.join(rootDir, 'snapshot-current.json'), base);
  writeSnapshotEnvelope(path.join(rootDir, 'snapshot-previous.json'), {
    ...base,
    generation: 1,
    records: {
      'host-a::session-b': { title: 'previous branch' },
    },
    aliases: {
      'host-a::session-b': 'host-a::session-b',
    },
  });

  await assert.rejects(
    SessionRecordStore.open({ rootDir }),
    (error) => error instanceof StoreRecoveryError && error.code === 'session_store_snapshot_fork',
    'equal-revision snapshots with different durable state must fail closed'
  );

  const generationOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-snapshot-generation-'));
  writeSnapshotEnvelope(path.join(generationOnlyRoot, 'snapshot-current.json'), base);
  writeSnapshotEnvelope(path.join(generationOnlyRoot, 'snapshot-previous.json'), {
    ...base,
    generation: 1,
  });
  const generationOnlyStore = await SessionRecordStore.open({ rootDir: generationOnlyRoot });
  assert.strictEqual(generationOnlyStore.readSnapshot().storeRevision, 7);
  assert(generationOnlyStore.readSnapshot().generation >= 2);
  await generationOnlyStore.close();
}

async function testInterruptedReplacementRecovery() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-interrupted-replace-'));
  const sentinelPath = path.join(rootDir, 'store-sentinel.json');
  const store = await SessionRecordStore.open({
    rootDir,
    sentinelPath,
    snapshotEvery: 1,
  });
  await store.transact('test.interrupted.replace.first', () => null);
  await store.transact('test.interrupted.replace.second', () => null);
  await store.close();

  const canonicalPaths = [
    path.join(rootDir, 'snapshot-current.json'),
    path.join(rootDir, 'snapshot-previous.json'),
    path.join(rootDir, 'wal-current.jsonl'),
    sentinelPath,
  ];
  for (const canonicalPath of canonicalPaths) {
    assert(fs.existsSync(canonicalPath), `fixture canonical file must exist: ${canonicalPath}`);
    fs.renameSync(canonicalPath, `${canonicalPath}.interrupted.next.bak`);
  }

  const recovered = await SessionRecordStore.open({ rootDir, sentinelPath });
  assert.strictEqual(recovered.readSnapshot().storeRevision, 2);
  for (const canonicalPath of canonicalPaths) {
    assert(fs.existsSync(canonicalPath), `startup must restore interrupted replacement: ${canonicalPath}`);
  }
  await recovered.close();
}

async function testCommitUsesRecordLevelCopyOnWrite() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-record-cow-'));
  const defaultStore = new SessionRecordStore({ rootDir });
  assert.strictEqual(defaultStore.snapshotEvery, 250, 'large Stores should not rewrite a full snapshot every 25 mutations');

  const store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1000 });
  await store.transact('test.cow.seed', (tx) => {
    for (const sessionId of ['session-a', 'session-b']) {
      const key = tx.resolveCanonicalKey({ hostId: 'host-cow', sessionId });
      const record = tx.ensureRecord(key, { hostId: 'host-cow', conversationKey: sessionId });
      record.title = sessionId;
      tx.markDirty(key);
    }
  });
  const untouchedRecord = store.projection.records['host-cow::session-a'];
  await store.transact('test.cow.update', (tx) => {
    const record = tx.getRecord('host-cow::session-b');
    record.title = 'updated';
    tx.markDirty('host-cow::session-b');
  });
  assert.strictEqual(
    store.projection.records['host-cow::session-a'],
    untouchedRecord,
    'an unrelated commit must preserve immutable record objects instead of cloning the complete Store'
  );
  await store.close();
}

async function main() {
  await testEqualRevisionSnapshotForkFailsClosed();
  await testInterruptedReplacementRecovery();
  await testCommitUsesRecordLevelCopyOnWrite();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-record-store-'));
  const legacyMetadataPath = path.join(rootDir, 'legacy-session-metadata.json');
  fs.writeFileSync(legacyMetadataPath, JSON.stringify({
    entries: [{
      hostId: 'host-a',
      identity: 'native-a',
      title: 'Kept legacy title',
      cwd: 'D:/work',
      source: 'manual',
      updatedAt: '2026-07-16T00:00:00.000Z',
    }],
  }));

  const store = await SessionRecordStore.open({
    rootDir,
    legacyMetadataPath,
    snapshotEvery: 1,
    now: () => '2026-07-16T00:00:01.000Z',
  });

  const first = await store.transact('session.run.requested', (tx) => {
    const canonicalKey = tx.resolveCanonicalKey({ hostId: 'host-a', sessionId: 'native-a' });
    const record = tx.ensureRecord(canonicalKey, {
      hostId: 'host-a',
      conversationKey: 'native-a',
    });
    record.runs['run-a'] = {
      status: 'pending',
      apiBinding: {
        kind: 'profile',
        profileId: 'profile-a',
        provider: 'OpenAI',
        normalizedBaseUrl: 'https://example.invalid/v1',
        apiKey: 'must-never-persist',
        nested: { authorization: 'Bearer must-never-persist' },
        credentials: {
          accessToken: 'access-token-must-never-persist',
          refresh_token: 'refresh-token-must-never-persist',
          idToken: 'id-token-must-never-persist',
          clientSecret: 'client-secret-must-never-persist',
          AccessKeyId: 'aws-access-id-opaque-marker',
          SecretAccessKey: 'aws-secret-access-key-opaque-marker',
        },
        runtimeMetadata: { tokenBudget: 4096 },
        cloudMetadata: {
          AccessKeyId: 'aws-access-id-outside-container-marker',
          SecretAccessKey: 'aws-secret-access-key-outside-container-marker',
          accessKey: 's3-access-key-opaque-marker',
          secretKey: 's3-secret-key-opaque-marker',
          accountKey: 'azure-account-key-field-marker',
          storageKey: 'azure-storage-key-field-marker',
          connectionString: 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=azure-connection-field-marker',
        },
      },
      error: {
        code: 'provider_failure',
        message: 'Authorization: Bearer bearer-value-must-never-persist; api_key=message-key-must-never-persist',
        metadata: {
          credentials: 'opaque-credentials-must-never-persist',
          providerUrls: [
            'https://provider.example/v1?token=query-token-opaque-marker',
            'https://provider.example/v1?subscription-key=query-subscription-key-opaque-marker',
            'https://provider.example/v1?X-Amz-Signature=query-amz-signature-opaque-marker',
          ],
          providerMessage: 'Storage failed: DefaultEndpointsProtocol=https;AccountName=test;AccountKey=azure-account-key-text-marker;EndpointSuffix=core.windows.net',
        },
      },
    };
    tx.setAlias('host-a::bridge-a', canonicalKey);
    tx.markDirty(canonicalKey);
    return {
      canonicalKey,
      assistantSeq: tx.allocateGlobalAssistantSeq(),
    };
  });

  assert.deepStrictEqual(first, {
    canonicalKey: 'host-a::native-a',
    assistantSeq: 1,
  });
  assert.strictEqual(
    store.readRecord({ hostId: 'host-a', bridgeSessionId: 'bridge-a' }).title,
    'Kept legacy title'
  );
  assert.strictEqual(
    store.resolveCanonicalKey({ hostId: 'host-a', sessionId: 'bridge-a' }),
    'host-a::native-a'
  );
  assert.deepStrictEqual(
    store.readAliasesForCanonicalKey('host-a::native-a'),
    ['host-a::bridge-a', 'host-a::native-a']
  );

  const assigned = await store.transact('assistant.identity_assigned', (tx) => {
    const canonicalKey = tx.resolveCanonicalKey({ hostId: 'host-a', bridgeSessionId: 'bridge-a' });
    const record = tx.ensureRecord(canonicalKey);
    const assistantSeq = tx.allocateGlobalAssistantSeq();
    record.notification = {
      ...(record.notification || {}),
      ledger: {
        ...((record.notification && record.notification.ledger) || {}),
        'assistant:item-a': {
          assistantMessageId: 'assistant:item-a',
          assistantSeq,
          assistantAt: '2026-07-16T00:00:02.000Z',
          notifiable: true,
        },
      },
      latestAssistantSeq: assistantSeq,
    };
    tx.appendDomainEvent({
      type: 'assistant.identity_assigned',
      canonicalKey,
      assistantMessageId: 'assistant:item-a',
      assistantSeq,
    });
    tx.markDirty(canonicalKey);
    return { canonicalKey, assistantSeq };
  });
  assert.deepStrictEqual(assigned, {
    canonicalKey: 'host-a::native-a',
    assistantSeq: 2,
  });
  await store.close();

  const persisted = readAllFiles(rootDir);
  assert(!persisted.includes('must-never-persist'), 'API secrets must never reach snapshots or WAL');
  assert(!persisted.includes('access-token-must-never-persist'));
  assert(!persisted.includes('refresh-token-must-never-persist'));
  assert(!persisted.includes('id-token-must-never-persist'));
  assert(!persisted.includes('client-secret-must-never-persist'));
  assert(!persisted.includes('bearer-value-must-never-persist'));
  assert(!persisted.includes('message-key-must-never-persist'));
  assert(!persisted.includes('opaque-credentials-must-never-persist'));
  assert(!persisted.includes('aws-access-id-opaque-marker'));
  assert(!persisted.includes('aws-secret-access-key-opaque-marker'));
  assert(!persisted.includes('aws-access-id-outside-container-marker'));
  assert(!persisted.includes('aws-secret-access-key-outside-container-marker'));
  assert(!persisted.includes('s3-access-key-opaque-marker'));
  assert(!persisted.includes('s3-secret-key-opaque-marker'));
  assert(!persisted.includes('azure-account-key-field-marker'));
  assert(!persisted.includes('azure-storage-key-field-marker'));
  assert(!persisted.includes('azure-connection-field-marker'));
  assert(!persisted.includes('azure-account-key-text-marker'));
  assert(!persisted.includes('query-token-opaque-marker'));
  assert(!persisted.includes('query-subscription-key-opaque-marker'));
  assert(!persisted.includes('query-amz-signature-opaque-marker'));
  assert(!/"credentials"\s*:/.test(persisted), 'credential containers must be removed as a unit');
  assert(!/apiKey|authorization|clientSecret|idToken/i.test(persisted), 'secret field names must be stripped recursively');
  assert(persisted.includes('tokenBudget'), 'non-secret token budget metadata must be retained');

  const reopened = await SessionRecordStore.open({ rootDir, legacyMetadataPath });
  assert.strictEqual(reopened.readSnapshot().storeRevision, 2);
  assert.strictEqual(reopened.readSnapshot().globalAssistantSeq, 2);
  assert.strictEqual(
    reopened.readRecord({ hostId: 'host-a', sessionId: 'bridge-a' })
      .notification.ledger['assistant:item-a'].assistantSeq,
    2
  );
  await reopened.close();

  fs.writeFileSync(path.join(rootDir, 'snapshot-current.json'), '{broken-current-snapshot');
  const recovered = await SessionRecordStore.open({ rootDir, legacyMetadataPath });
  assert.strictEqual(recovered.readSnapshot().storeRevision, 2);
  assert.strictEqual(recovered.readSnapshot().globalAssistantSeq, 2);
  assert.strictEqual(
    recovered.readRecord({ hostId: 'host-a', nativeThreadId: 'native-a' })
      .notification.ledger['assistant:item-a'].assistantMessageId,
    'assistant:item-a',
    'previous snapshot plus retained WAL must restore identity as well as the high-water mark'
  );
  await recovered.flushSnapshot();
  await recovered.close();

  const healedCurrent = JSON.parse(fs.readFileSync(path.join(rootDir, 'snapshot-current.json'), 'utf8'));
  assert.strictEqual(healedCurrent.projection.storeRevision, 2);
  const healed = await SessionRecordStore.open({ rootDir, legacyMetadataPath });
  assert.strictEqual(healed.readSnapshot().globalAssistantSeq, 2);
  await healed.close();

  const gapPayload = {
    revision: 4,
    kind: 'test.gap',
    records: {},
    aliases: {},
    globalAssistantSeq: 4,
    events: [],
  };
  fs.appendFileSync(
    path.join(rootDir, 'wal-current.jsonl'),
    `${JSON.stringify({ revision: 4, checksum: checksum(gapPayload), payload: gapPayload })}\n`
  );
  await assert.rejects(
    SessionRecordStore.open({ rootDir, legacyMetadataPath }),
    (error) => error instanceof StoreRecoveryError && error.code === 'session_store_revision_gap'
  );

  const snapshotFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-snapshot-failure-'));
  const snapshotFailureStore = await SessionRecordStore.open({
    rootDir: snapshotFailureRoot,
    snapshotEvery: 1,
  });
  const writeSnapshotAfterFailure = snapshotFailureStore.writeSnapshot.bind(snapshotFailureStore);
  let snapshotAttempts = 0;
  snapshotFailureStore.writeSnapshot = async () => {
    snapshotAttempts += 1;
    if (snapshotAttempts === 1) {
      throw new Error('simulated snapshot failure with Bearer snapshot-secret-must-not-leak');
    }
    return writeSnapshotAfterFailure();
  };
  await snapshotFailureStore.transact('test.snapshot.failure', (tx) => {
    const key = tx.resolveCanonicalKey({ hostId: 'host-failure', sessionId: 'session-failure' });
    tx.ensureRecord(key, { hostId: 'host-failure', conversationKey: 'session-failure' });
    tx.markDirty(key);
  });
  assert.strictEqual(snapshotFailureStore.readSnapshot().storeRevision, 1);
  assert.strictEqual(snapshotFailureStore.mutationsClosed, null);
  assert.strictEqual(snapshotFailureStore.readHealth().status, 'degraded');
  assert.strictEqual(snapshotFailureStore.readHealth().writable, true);
  assert(
    snapshotFailureStore.lastSnapshotError instanceof StoreRecoveryError
      && snapshotFailureStore.lastSnapshotError.code === 'session_store_snapshot_failed'
      && !snapshotFailureStore.lastSnapshotError.message.includes('snapshot-secret-must-not-leak'),
    'a failed automatic checkpoint must be observable without leaking secrets or rejecting a durable commit'
  );
  await snapshotFailureStore.transact('test.after.snapshot.failure', () => null);
  assert.strictEqual(snapshotFailureStore.readSnapshot().storeRevision, 2);
  assert.strictEqual(snapshotFailureStore.lastSnapshotError, null, 'a later checkpoint must clear degraded state');
  assert.strictEqual(snapshotFailureStore.readHealth().status, 'ok');
  await snapshotFailureStore.close();
  const snapshotFailureRecovered = await SessionRecordStore.open({ rootDir: snapshotFailureRoot });
  assert.strictEqual(snapshotFailureRecovered.readSnapshot().storeRevision, 2);
  await snapshotFailureRecovered.close();

  const snapshotRestoreFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-snapshot-restore-failure-'));
  const snapshotRestoreFailureStore = await SessionRecordStore.open({
    rootDir: snapshotRestoreFailureRoot,
    snapshotEvery: 1,
  });
  snapshotRestoreFailureStore.writeSnapshot = async () => {
    const error = new Error('simulated replacement and restoration failure');
    error.code = 'EBUSY';
    error.recoveryPath = path.join(snapshotRestoreFailureRoot, 'snapshot-current.json.test.bak');
    error.restoreError = new Error('simulated restoration failure');
    throw error;
  };
  await snapshotRestoreFailureStore.transact('test.snapshot.restore.failure', () => null);
  assert.strictEqual(
    snapshotRestoreFailureStore.readSnapshot().storeRevision,
    1,
    'the revision is already committed before checkpoint restoration fails'
  );
  assert.strictEqual(snapshotRestoreFailureStore.readHealth().status, 'failed');
  await assert.rejects(
    snapshotRestoreFailureStore.transact('test.after.snapshot.restore.failure', () => null),
    (error) => error instanceof StoreRecoveryError && error.code === 'session_store_mutation_closed',
    'an unrestored canonical persistence file must stop the next mutation'
  );
  await snapshotRestoreFailureStore.close();
  const snapshotRestoreFailureRecovered = await SessionRecordStore.open({ rootDir: snapshotRestoreFailureRoot });
  assert.strictEqual(snapshotRestoreFailureRecovered.readSnapshot().storeRevision, 1);
  await snapshotRestoreFailureRecovered.close();

  const walFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-wal-failure-'));
  const walFailureStore = await SessionRecordStore.open({
    rootDir: walFailureRoot,
    snapshotEvery: 100,
  });
  walFailureStore.appendWal = async () => {
    fs.appendFileSync(path.join(walFailureRoot, 'wal-current.jsonl'), '{\"partial\":');
    throw new Error('simulated WAL failure with Bearer wal-secret-must-not-leak');
  };
  await assert.rejects(
    walFailureStore.transact('test.wal.failure', (tx) => {
      const key = tx.resolveCanonicalKey({ hostId: 'host-wal', sessionId: 'session-wal' });
      tx.ensureRecord(key, { hostId: 'host-wal', conversationKey: 'session-wal' });
      tx.markDirty(key);
    }),
    (error) => error instanceof StoreRecoveryError
      && error.code === 'session_store_wal_write_failed'
      && !error.message.includes('wal-secret-must-not-leak'),
    'a partial WAL append must fail without exposing provider secrets'
  );
  await assert.rejects(
    walFailureStore.transact('test.after.wal.failure', () => null),
    (error) => error instanceof StoreRecoveryError && error.code === 'session_store_mutation_closed',
    'a WAL append failure must fail every later metadata mutation closed'
  );
  assert.strictEqual(walFailureStore.readSnapshot().storeRevision, 0);
  assert.strictEqual(walFailureStore.readHealth().status, 'failed');
  assert.strictEqual(walFailureStore.readHealth().writable, false);
  await walFailureStore.close();

  const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-sentinel-'));
  const sentinelPath = path.join(
    path.dirname(sentinelRoot),
    `.${path.basename(sentinelRoot)}.session-store-sentinel.json`
  );
  const sentinelStore = await SessionRecordStore.open({
    rootDir: sentinelRoot,
    sentinelPath,
    snapshotEvery: 1,
  });
  await sentinelStore.transact('test.sentinel', (tx) => {
    const key = tx.resolveCanonicalKey({ hostId: 'host-sentinel', sessionId: 'session-sentinel' });
    tx.ensureRecord(key, { hostId: 'host-sentinel', conversationKey: 'session-sentinel' });
    tx.allocateGlobalAssistantSeq();
    tx.markDirty(key);
  });
  await sentinelStore.close();
  assert(fs.existsSync(sentinelPath), 'durable Store sentinel must be written outside the artifact directory');
  const displacedSentinelRoot = `${sentinelRoot}.with-artifacts`;
  fs.renameSync(sentinelRoot, displacedSentinelRoot);
  fs.mkdirSync(sentinelRoot);
  await assert.rejects(
    SessionRecordStore.open({ rootDir: sentinelRoot, sentinelPath }),
    (error) => error instanceof StoreRecoveryError && error.code === 'session_store_artifacts_missing',
    'a retained sentinel must reject silently recreating a previously populated Store'
  );

  const rollbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-rollback-'));
  const rollbackSentinelPath = path.join(
    path.dirname(rollbackRoot),
    `.${path.basename(rollbackRoot)}.session-store-sentinel.json`
  );
  const rollbackStore = await SessionRecordStore.open({
    rootDir: rollbackRoot,
    sentinelPath: rollbackSentinelPath,
    snapshotEvery: 1,
  });
  await rollbackStore.transact('test.rollback.one', (tx) => {
    const key = tx.resolveCanonicalKey({ hostId: 'host-rollback', sessionId: 'session-rollback' });
    tx.ensureRecord(key, { hostId: 'host-rollback', conversationKey: 'session-rollback' });
    tx.allocateGlobalAssistantSeq();
    tx.markDirty(key);
  });
  const oldSnapshotPath = path.join(rollbackRoot, 'snapshot-old.json');
  fs.copyFileSync(path.join(rollbackRoot, 'snapshot-current.json'), oldSnapshotPath);
  await rollbackStore.transact('test.rollback.two', (tx) => {
    const key = tx.resolveCanonicalKey({ hostId: 'host-rollback', sessionId: 'session-rollback' });
    tx.getRecord(key).title = 'newer state';
    tx.allocateGlobalAssistantSeq();
    tx.markDirty(key);
  });
  await rollbackStore.close();
  fs.renameSync(path.join(rollbackRoot, 'snapshot-current.json'), path.join(rollbackRoot, 'snapshot-newer.json'));
  fs.renameSync(path.join(rollbackRoot, 'wal-current.jsonl'), path.join(rollbackRoot, 'wal-newer.jsonl'));
  fs.copyFileSync(oldSnapshotPath, path.join(rollbackRoot, 'snapshot-current.json'));
  await assert.rejects(
    SessionRecordStore.open({ rootDir: rollbackRoot, sentinelPath: rollbackSentinelPath }),
    (error) => error instanceof StoreRecoveryError && error.code === 'session_store_high_water_rollback',
    'sentinel high-water must reject a stale but internally valid Store restore'
  );

  const historicalSecretRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-historical-secret-'));
  const historicalProjection = {
    schemaVersion: 1,
    generation: 1,
    storeRevision: 0,
    globalAssistantSeq: 0,
    records: {
      'host-history::session-history': {
        hostId: 'host-history',
        conversationKey: 'session-history',
        runs: {
          legacy: {
            status: 'stopped',
            apiBinding: {
              kind: 'profile',
              profileId: 'historical-profile',
              apiKey: 'historical-api-value-must-not-survive',
            },
            error: {
              message: 'Authorization: Bearer historical-bearer-value-must-not-survive',
            },
          },
        },
        catalog: {},
        notification: {},
      },
    },
    aliases: {
      'host-history::session-history': 'host-history::session-history',
    },
  };
  fs.writeFileSync(
    path.join(historicalSecretRoot, 'snapshot-current.json'),
    `${JSON.stringify({
      revision: 0,
      checksum: checksum(historicalProjection),
      projection: historicalProjection,
    }, null, 2)}\n`
  );
  const historicalWalPayload = {
    revision: 1,
    kind: 'historical.secret.fixture',
    records: {
      'host-history::session-history': {
        ...historicalProjection.records['host-history::session-history'],
        runs: {
          legacy: {
            status: 'stopped',
            apiBinding: {
              kind: 'profile',
              profileId: 'historical-profile',
              clientSecret: 'historical-wal-client-secret-must-not-survive',
            },
            error: {
              message: 'api_key=historical-wal-message-key-must-not-survive',
            },
          },
        },
      },
    },
    aliases: {},
    globalAssistantSeq: 0,
    events: [],
  };
  fs.writeFileSync(
    path.join(historicalSecretRoot, 'wal-current.jsonl'),
    `${JSON.stringify({
      revision: 1,
      checksum: checksum(historicalWalPayload),
      payload: historicalWalPayload,
    })}\n`
  );
  const historicalSecretStore = await SessionRecordStore.open({ rootDir: historicalSecretRoot });
  const historicalInMemory = JSON.stringify(historicalSecretStore.readSnapshot());
  assert(!historicalInMemory.includes('historical-api-value-must-not-survive'));
  assert(!historicalInMemory.includes('historical-bearer-value-must-not-survive'));
  assert(!historicalInMemory.includes('historical-wal-client-secret-must-not-survive'));
  assert(!historicalInMemory.includes('historical-wal-message-key-must-not-survive'));
  assert.strictEqual(historicalSecretStore.readSnapshot().storeRevision, 1);
  assert.strictEqual(
    historicalSecretStore.readRecord({ hostId: 'host-history', sessionId: 'session-history' })
      .runs.legacy.apiBinding.apiKey,
    undefined
  );
  await historicalSecretStore.close();
  const historicalOnDisk = readAllFiles(historicalSecretRoot);
  assert(!historicalOnDisk.includes('historical-api-value-must-not-survive'));
  assert(!historicalOnDisk.includes('historical-bearer-value-must-not-survive'));
  assert(!historicalOnDisk.includes('historical-wal-client-secret-must-not-survive'));
  assert(!historicalOnDisk.includes('historical-wal-message-key-must-not-survive'));

  const isolatedRelayCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-relay-port-guard-'));
  const childEnv = isolatedRelayEnvironment({ PORT: '18983' });
  const guardedRelay = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'apps', 'relay', 'server.js')],
    {
      cwd: isolatedRelayCwd,
      env: childEnv,
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.notStrictEqual(guardedRelay.status, 0, 'non-primary Relay must reject an implicit shared Store root');
  assert(
    `${guardedRelay.stdout}\n${guardedRelay.stderr}`.includes('requires an explicit RELAY_STATE_ROOT'),
    'port guard must require a complete isolated Relay state root'
  );
  assert.strictEqual(
    fs.existsSync(path.join(isolatedRelayCwd, 'tmp', 'session-record-store')),
    false,
    'port guard must run before opening or creating a Store'
  );

  const storeOnlyRoot = path.join(isolatedRelayCwd, 'store-only-root');
  const storeOnlyRelay = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'apps', 'relay', 'server.js')],
    {
      cwd: isolatedRelayCwd,
      env: isolatedRelayEnvironment({
        PORT: '18984',
        SESSION_RECORD_STORE_ROOT: storeOnlyRoot,
      }),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.notStrictEqual(storeOnlyRelay.status, 0, 'a Store path alone must not define a Relay instance');
  assert(
    `${storeOnlyRelay.stdout}\n${storeOnlyRelay.stderr}`.includes('requires an explicit RELAY_STATE_ROOT'),
    'Store-only startup must require the complete instance root'
  );
  assert.strictEqual(fs.existsSync(storeOnlyRoot), false);

  const unsafeAgentRelayRoot = path.join(isolatedRelayCwd, 'unsafe-agent-relay-state');
  const unsafeAgentRelay = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'apps', 'relay', 'server.js')],
    {
      cwd: isolatedRelayCwd,
      env: isolatedRelayEnvironment({
        PORT: '18986',
        RELAY_STATE_ROOT: unsafeAgentRelayRoot,
        RELAY_LOCAL_AGENT_START_ENABLED: 'true',
        RELAY_LOCAL_HOST_ID: 'unsafe-agent-test',
      }),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.notStrictEqual(unsafeAgentRelay.status, 0, 'non-primary Agent opt-in needs isolated Agent paths');
  assert(
    `${unsafeAgentRelay.stdout}\n${unsafeAgentRelay.stderr}`.includes(
      'Non-primary Relay local Agent opt-in requires LOCAL_CODEX_HOME'
    ),
    'Agent opt-in guard must identify the first missing isolated Agent path'
  );
  assert.strictEqual(
    fs.existsSync(unsafeAgentRelayRoot),
    false,
    'Agent opt-in validation must run before creating Relay state'
  );

  const containedRelayRoot = path.join(isolatedRelayCwd, 'isolated-relay-state');
  const escapedStoreRoot = path.join(isolatedRelayCwd, 'shared-session-record-store');
  const containmentEnv = isolatedRelayEnvironment({
    PORT: '18984',
    RELAY_STATE_ROOT: containedRelayRoot,
    SESSION_RECORD_STORE_ROOT: escapedStoreRoot,
  });
  const escapedStoreRelay = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'apps', 'relay', 'server.js')],
    {
      cwd: isolatedRelayCwd,
      env: containmentEnv,
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.notStrictEqual(
    escapedStoreRelay.status,
    0,
    'Relay must reject a Store outside its instance state root'
  );
  assert(
    `${escapedStoreRelay.stdout}\n${escapedStoreRelay.stderr}`.includes(
      'SESSION_RECORD_STORE_ROOT must resolve within RELAY_STATE_ROOT'
    ),
    'Store containment guard must identify the escaped writable path'
  );
  assert.strictEqual(
    fs.existsSync(escapedStoreRoot),
    false,
    'Store containment guard must run before opening or creating the escaped Store'
  );

  const junctionRelayRoot = path.join(isolatedRelayCwd, 'junction-relay-state');
  const junctionStoreTarget = path.join(isolatedRelayCwd, 'junction-store-target');
  fs.mkdirSync(junctionRelayRoot, { recursive: true });
  fs.mkdirSync(junctionStoreTarget, { recursive: true });
  fs.writeFileSync(path.join(junctionStoreTarget, 'marker.txt'), 'unchanged');
  fs.symlinkSync(
    junctionStoreTarget,
    path.join(junctionRelayRoot, 'session-record-store'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const junctionRelay = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'apps', 'relay', 'server.js')],
    {
      cwd: isolatedRelayCwd,
      env: isolatedRelayEnvironment({
        PORT: '18985',
        RELAY_STATE_ROOT: junctionRelayRoot,
      }),
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.notStrictEqual(junctionRelay.status, 0, 'a junction must not escape Relay state containment');
  assert(
    `${junctionRelay.stdout}\n${junctionRelay.stderr}`.includes(
      'SESSION_RECORD_STORE_ROOT must resolve within RELAY_STATE_ROOT'
    ),
    'physical containment must identify a Store junction that targets another state tree'
  );
  assert.deepStrictEqual(
    fs.readdirSync(junctionStoreTarget),
    ['marker.txt'],
    'junction containment must fail before touching the target Store'
  );

  const relaySource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'relay', 'server.js'), 'utf8');
  assert(relaySource.includes('const RELAY_STATE_ROOT = canonicalPhysicalPath('));
  for (const relativePath of [
    'received-files',
    'local-agents',
    'remote-codex-askpass.cmd',
    'runtime-stage',
  ]) {
    assert(
      relaySource.includes(`path.join(RELAY_STATE_ROOT, '${relativePath}')`),
      `${relativePath} must be rooted under the isolated Relay state root`
    );
  }
  assert.strictEqual(
    (relaySource.match(/path\.join\(process\.cwd\(\), 'tmp'/g) || []).length,
    1,
    'only the primary RELAY_STATE_ROOT default may refer directly to process.cwd()/tmp'
  );

  console.log('session record store tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
