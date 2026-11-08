const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SessionRecordStore,
  StoreRecoveryError,
} = require('../apps/relay/session-record-store');

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function writeWalFixture(walPath, entryCount) {
  const descriptor = fs.openSync(walPath, 'w');
  try {
    for (let revision = 1; revision <= entryCount; revision += 1) {
      const payload = {
        revision,
        kind: 'test.streaming.wal',
        records: {},
        aliases: {},
        globalAssistantSeq: 0,
        events: [],
        padding: `row-${revision}-${'界'.repeat(1024)}`,
      };
      const line = JSON.stringify({ revision, checksum: checksum(payload), payload });
      fs.writeSync(descriptor, `${line}${revision % 2 ? '\n' : '\r\n'}`);
      if (revision % 127 === 0) {
        fs.writeSync(descriptor, '\r\n');
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

async function withoutWholeWalReads(walPath, callback) {
  const originalReadFile = fs.promises.readFile;
  let wholeWalReadAttempts = 0;
  fs.promises.readFile = async function guardedReadFile(filePath, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(walPath)) {
      wholeWalReadAttempts += 1;
      throw new RangeError('Invalid string length');
    }
    return originalReadFile.call(this, filePath, ...args);
  };
  try {
    await callback();
  } finally {
    fs.promises.readFile = originalReadFile;
  }
  assert.strictEqual(wholeWalReadAttempts, 0, 'WAL replay and compaction must never read the complete file');
}

async function withOpenInterceptor(interceptor, callback) {
  const originalOpen = fs.promises.open;
  fs.promises.open = async function interceptedOpen(filePath, ...args) {
    const handle = await originalOpen.call(this, filePath, ...args);
    return (await interceptor(path.resolve(String(filePath)), handle, args)) || handle;
  };
  try {
    return await callback();
  } finally {
    fs.promises.open = originalOpen;
  }
}

async function testStreamingReplayAndCompaction() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-streaming-wal-'));
  const walPath = path.join(rootDir, 'wal-current.jsonl');
  const entryCount = 1024;
  writeWalFixture(walPath, entryCount);

  let store;
  await withoutWholeWalReads(walPath, async () => {
    store = await SessionRecordStore.open({
      rootDir,
      snapshotEvery: 100_000,
      walReadHighWaterMark: 5,
    });
    assert.strictEqual(store.readSnapshot().storeRevision, entryCount);
    await store.flushSnapshot();
    await store.transact('test.streaming.after-snapshot', () => null);
    await store.flushSnapshot();
  });

  const retainedEntries = fs.readFileSync(walPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.strictEqual(retainedEntries.length, 1, 'compaction must retain only revisions newer than previous');
  assert.strictEqual(JSON.parse(retainedEntries[0]).revision, entryCount + 1);
  assert.strictEqual(store.readHealth().status, 'ok');
  assert.strictEqual(store.readHealth().walError, null);
  await store.close();

  await withoutWholeWalReads(walPath, async () => {
    const reopened = await SessionRecordStore.open({ rootDir, walReadHighWaterMark: 7 });
    assert.strictEqual(reopened.readSnapshot().storeRevision, entryCount + 1);
    await reopened.close();
  });
}

async function testCompactionCloseFailureDoesNotReplaceCanonicalWal() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-wal-close-error-'));
  const walPath = path.join(rootDir, 'wal-current.jsonl');
  const nextWalPath = path.join(rootDir, 'wal-next.jsonl');
  const store = await SessionRecordStore.open({ rootDir, snapshotEvery: 100_000 });
  await store.transact('test.wal.close.seed', () => null);
  await store.flushSnapshot();
  await store.transact('test.wal.close.trigger', () => null);
  const canonicalBefore = fs.readFileSync(walPath);
  let closeInjected = false;
  await assert.rejects(
    withOpenInterceptor(async (filePath, handle) => {
      if (filePath !== path.resolve(nextWalPath)) {
        return null;
      }
      return {
        write: handle.write.bind(handle),
        sync: handle.sync.bind(handle),
        close: async () => {
          await handle.close();
          closeInjected = true;
          const error = new Error('simulated WAL output close failure');
          error.code = 'EBUSY';
          throw error;
        },
      };
    }, () => store.flushSnapshot()),
    (error) => error instanceof StoreRecoveryError
      && error.code === 'session_store_wal_compaction_failed'
  );
  assert.strictEqual(closeInjected, true, 'compaction output close failure must be injected');
  assert.deepStrictEqual(
    fs.readFileSync(walPath),
    canonicalBefore,
    'output close failure must not replace the canonical WAL'
  );
  assert.strictEqual(store.readHealth().walErrorCode, 'session_store_wal_compaction_failed');
  await store.close();
}

async function testWalReadCloseFailureIsReported() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-wal-read-close-error-'));
  const walPath = path.join(rootDir, 'wal-current.jsonl');
  writeWalFixture(walPath, 1);
  let closeInjected = false;
  await assert.rejects(
    withOpenInterceptor(async (filePath, handle, args) => {
      if (filePath !== path.resolve(walPath) || args[0] !== 'r') {
        return null;
      }
      return {
        createReadStream: handle.createReadStream.bind(handle),
        close: async () => {
          await handle.close();
          closeInjected = true;
          const error = new Error('simulated WAL input close failure');
          error.code = 'EBUSY';
          throw error;
        },
      };
    }, () => SessionRecordStore.open({ rootDir, walReadHighWaterMark: 3 })),
    (error) => error instanceof StoreRecoveryError
      && error.code === 'session_store_wal_read_failed'
  );
  assert.strictEqual(closeInjected, true, 'WAL input close failure must be injected');
}

async function testCompactionHandlesShortWrites() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-wal-short-write-'));
  const walPath = path.join(rootDir, 'wal-current.jsonl');
  const nextWalPath = path.join(rootDir, 'wal-next.jsonl');
  const store = await SessionRecordStore.open({ rootDir, snapshotEvery: 100_000 });
  await store.transact('test.wal.short.seed', () => null);
  await store.flushSnapshot();
  let shortWriteCount = 0;
  await withOpenInterceptor(async (filePath, handle) => {
    if (filePath !== path.resolve(nextWalPath)) {
      return null;
    }
    return {
      write: async (buffer, offset, length, position) => {
        const limitedLength = Math.max(1, Math.min(length, 7));
        if (limitedLength < length) {
          shortWriteCount += 1;
        }
        return handle.write(buffer, offset, limitedLength, position);
      },
      sync: handle.sync.bind(handle),
      close: handle.close.bind(handle),
    };
  }, async () => {
    await store.transact('test.wal.short.trigger', () => null);
    await store.flushSnapshot();
  });
  assert(shortWriteCount > 0, 'short-write test must exercise a partial FileHandle.write result');
  const retainedRevisions = fs.readFileSync(walPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).revision);
  assert.deepStrictEqual(retainedRevisions, [2], 'short writes must still produce a complete retained WAL line');
  await store.close();
}

async function testCompactionFailureIsReportedAsWalFailure() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-wal-error-health-'));
  const walPath = path.join(rootDir, 'wal-current.jsonl');
  const store = await SessionRecordStore.open({ rootDir, snapshotEvery: 1 });
  await store.transact('test.wal.error.seed', () => null);
  store.iterateWalEntries = async function* failWalReader() {
    throw new StoreRecoveryError('session_store_wal_read_failed', 'simulated streaming WAL read failure');
  };

  await store.transact('test.wal.error.trigger', () => null);
  const health = store.readHealth();
  assert.strictEqual(health.status, 'failed');
  assert.strictEqual(health.writable, false);
  assert.strictEqual(health.snapshotError, null);
  assert.strictEqual(health.walErrorCode, 'session_store_wal_compaction_failed');
  assert.match(health.walError, /Unable to compact the Session store WAL/);
  assert.match(health.error, /Unable to compact the Session store WAL/);
  const canonicalRevisions = fs.readFileSync(walPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).revision);
  assert.deepStrictEqual(canonicalRevisions, [1, 2], 'failed compaction must not replace the canonical WAL');
  await assert.rejects(
    store.transact('test.wal.error.closed', () => null),
    (error) => error instanceof StoreRecoveryError && error.code === 'session_store_mutation_closed'
  );
  await store.close();
}

async function main() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'relay', 'session-record-store.js'),
    'utf8'
  );
  assert(!source.includes("readFile(this.walPath"), 'WAL code must not restore whole-file reads');
  assert(!source.includes('retained.map((entry)'), 'WAL compaction must not rebuild the complete file in memory');

  await testStreamingReplayAndCompaction();
  await testCompactionHandlesShortWrites();
  await testCompactionCloseFailureDoesNotReplaceCanonicalWal();
  await testWalReadCloseFailureIsReported();
  await testCompactionFailureIsReportedAsWalFailure();
  console.log('session record store streaming WAL assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
