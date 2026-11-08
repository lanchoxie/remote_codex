const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripSecrets } = require('../shared/secret-redaction');
const { SessionRecordStore } = require('../apps/relay/session-record-store');

function nested(depth, leaf) {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

function leafAt(value, depth) {
  for (let index = 0; index < depth; index += 1) {
    assert(value && typeof value === 'object', `Nested content was lost at level ${index}`);
    value = value.child;
  }
  return value;
}

const safeLeaf = { text: 'Preserve this complete tool result', count: 0, enabled: false, optional: null };
const safeInput = nested(160, safeLeaf);
assert.deepStrictEqual(stripSecrets(safeInput), safeInput, 'valid deep JSON must not be silently truncated');
assert.notStrictEqual(stripSecrets(safeInput), safeInput, 'redaction must return a copy');
assert.strictEqual(leafAt(stripSecrets(nested(20000, 'deep leaf')), 20000), 'deep leaf', 'redaction must not depend on the JavaScript call stack');
let nestedArrays = safeLeaf;
for (let index = 0; index < 160; index += 1) nestedArrays = [nestedArrays];
assert.deepStrictEqual(stripSecrets(nestedArrays), nestedArrays, 'deep JSON arrays must retain their complete contents');
const prototypeNamedField = JSON.parse('{"__proto__":{"text":"ordinary JSON field"},"safe":true}');
assert.strictEqual(JSON.stringify(stripSecrets(prototypeNamedField)), JSON.stringify(prototypeNamedField), 'valid JSON property names must remain data properties');

const sensitiveLeaf = {
  ...safeLeaf,
  apiKey: 'synthetic-key-must-not-survive',
  authorization: 'Bearer synthetic-field-must-not-survive',
  text: 'Authorization: Bearer synthetic-text-must-not-survive',
  tokenBudget: 4096,
};
const scrubbed = leafAt(stripSecrets(nested(160, sensitiveLeaf)), 160);
assert.strictEqual(scrubbed.apiKey, undefined);
assert.strictEqual(scrubbed.authorization, undefined);
assert.strictEqual(scrubbed.text, '[REDACTED]');
assert.strictEqual(scrubbed.tokenBudget, 4096);
assert.strictEqual(sensitiveLeaf.apiKey, 'synthetic-key-must-not-survive', 'redaction must not mutate the caller');

const repeated = { text: 'Shared reference', apiKey: 'synthetic-shared-secret' };
const cyclic = { left: repeated, right: repeated };
cyclic.self = cyclic;
cyclic.array = [cyclic];
cyclic.mapping = new Map([['safe', repeated], ['apiKey', 'synthetic-map-secret'], ['self', cyclic]]);
cyclic.values = new Set([cyclic, repeated]);
const cycleSafe = stripSecrets(cyclic);
assert.deepStrictEqual(cycleSafe.left, { text: 'Shared reference' });
assert.deepStrictEqual(cycleSafe.right, cycleSafe.left, 'repeated references are not cycles');
assert.strictEqual(cycleSafe.self, '[Circular]');
assert.deepStrictEqual(cycleSafe.array, ['[Circular]']);
assert.deepStrictEqual(cycleSafe.mapping, { $map: [['safe', { text: 'Shared reference' }], ['self', '[Circular]']] });
assert.deepStrictEqual(cycleSafe.values, { $set: ['[Circular]', { text: 'Shared reference' }] });
assert(!JSON.stringify(cycleSafe).includes('synthetic-'));

const error = new Error('Authorization: Bearer synthetic-error-secret');
error.cause = error;
const special = stripSecrets({
  when: new Date('2026-11-05T00:00:00.000Z'),
  expression: /safe/i,
  location: new URL('https://example.invalid/path?token=synthetic-url-secret'),
  buffer: Buffer.from('synthetic-buffer-secret'),
  number: 42n,
  error,
  get unavailable() { throw new Error('synthetic-getter-secret'); },
});
assert.strictEqual(special.when, '2026-11-05T00:00:00.000Z');
assert.strictEqual(special.expression, '/safe/i');
assert.strictEqual(special.number, '42');
assert.strictEqual(special.error.$error.cause, '[Circular]');
assert.strictEqual(special.unavailable, '[Unserializable property]');
assert(!JSON.stringify(special).includes('synthetic-'), 'special values must retain existing secret protection');

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function verifyDurableRoundTrip() {
  // All data below is synthetic and lives only in this dedicated temporary
  // directory. Importing the Store does not start a Relay or Host Agent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-redaction-depth-'));
  let store;
  try {
    const rootDir = path.join(root, 'store');
    fs.mkdirSync(rootDir);
    const key = 'synthetic-host::synthetic-session';
    const record = {
      hostId: 'synthetic-host', conversationKey: 'synthetic-session',
      title: 'Preserved title', metadata: safeInput,
      runs: {}, catalog: {}, notification: { ledger: {} },
    };
    const projection = {
      schemaVersion: 1, storeId: 'synthetic-depth-store', generation: 1,
      storeRevision: 1, globalAssistantSeq: 0,
      records: { [key]: record }, aliases: { [key]: key },
    };
    const snapshot = JSON.stringify({ revision: 1, checksum: checksum(projection), projection });
    const payload = {
      revision: 2, kind: 'synthetic.history', globalAssistantSeq: 0,
      records: { [key]: { ...record, title: 'Preserved WAL title' } },
      aliases: {}, events: [],
    };
    const wal = `${JSON.stringify({ revision: 2, checksum: checksum(payload), payload })}\n`;
    const snapshotPath = path.join(rootDir, 'snapshot-current.json');
    const walPath = path.join(rootDir, 'wal-current.jsonl');
    fs.writeFileSync(snapshotPath, snapshot);
    fs.writeFileSync(walPath, wal);

    store = await SessionRecordStore.open({ rootDir });
    const recovered = store.readRecord({ hostId: 'synthetic-host', sessionId: 'synthetic-session' });
    assert.strictEqual(recovered.title, 'Preserved WAL title');
    assert.deepStrictEqual(leafAt(recovered.metadata, 160), safeLeaf);
    assert.strictEqual(fs.readFileSync(snapshotPath, 'utf8'), snapshot, 'deep data must not trigger a destructive sanitizer rewrite');
    assert.strictEqual(fs.readFileSync(walPath, 'utf8'), wal, 'deep data must not clear the existing WAL on open');

    await store.transact('synthetic.secret.update', (tx) => {
      tx.getRecord(key).metadata = nested(160, sensitiveLeaf);
      tx.markDirty(key);
    });
    await store.close();
    store = null;
    store = await SessionRecordStore.open({ rootDir });
    const reopened = store.readRecord({ hostId: 'synthetic-host', sessionId: 'synthetic-session' });
    assert.deepStrictEqual(leafAt(reopened.metadata, 160), scrubbed, 'deep data and secret redaction must survive persistence and reopen');
    for (const name of fs.readdirSync(rootDir)) {
      const file = path.join(rootDir, name);
      if (fs.statSync(file).isFile()) {
        assert(!fs.readFileSync(file, 'utf8').includes('must-not-survive'), 'secrets must not reach snapshot or WAL files');
      }
    }
  } finally {
    if (store) await store.close();
    const resolved = path.resolve(root);
    assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('remote-codex-redaction-depth-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

verifyDurableRoundTrip().then(() => {
  console.log('Deep JSON survives secret redaction, snapshot recovery and WAL replay without truncation');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
