const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('apps/relay/server.js', 'utf8');

function extractBlock(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert(start >= 0 && end > start, `could not extract ${startNeedle}`);
  return source.slice(start, end);
}

const logSaveBlock = extractBlock('async function saveSessionLogs()', 'function loadDismissedHosts()');
assert(logSaveBlock.includes('fs.promises.open('));
assert(logSaveBlock.includes('await descriptor.sync()'));
assert(logSaveBlock.includes('await replaceFileWithBackupAsync('));
assert(!/fs\.(?:open|writeFile|fsync|close|rename|unlink|mkdir)Sync\(/.test(logSaveBlock));

const pruningBlock = extractBlock('function sessionArtifactEntryBytes', 'function buildSessionLogsSnapshot()');
const context = {
  Buffer,
  Map,
  Number,
  Array,
  Object,
  Math,
  Date,
  JSON,
  String,
  state: {
    sessions: new Map([
      ['host::live', { hostId: 'host', sessionId: 'live', live: true, lastUpdatedAt: '2026-07-29T00:00:00.000Z' }],
      ['host::cold', { hostId: 'host', sessionId: 'cold', live: false, lastUpdatedAt: '2026-07-01T00:00:00.000Z' }],
      ['host::subscribed', { hostId: 'host', sessionId: 'subscribed', live: false, lastUpdatedAt: '2026-07-02T00:00:00.000Z' }],
    ]),
    sessionEventStream: {
      has: (key) => key === 'host::subscribed',
    },
  },
  resolveCanonicalConversationKey: (hostId, session) => `${hostId}::${session.sessionId}`,
};
vm.runInNewContext(`${pruningBlock}\nglobalThis.prune = pruneSessionArtifactMap;`, context);

const entries = new Map([
  ['host::cold', [{ timestamp: '2026-07-01T00:00:00.000Z', message: 'x'.repeat(200) }]],
  ['host::live', [{ timestamp: '2026-07-29T00:00:00.000Z', message: 'live' }]],
  ['host::subscribed', [{ timestamp: '2026-07-02T00:00:00.000Z', message: 'subscribed' }]],
]);
assert.strictEqual(context.prune(entries, { keyLimit: 2, byteLimit: 1024 * 1024 }), true);
assert.strictEqual(entries.has('host::cold'), false, 'the oldest cold artifact must be evicted first');
assert.strictEqual(entries.has('host::live'), true, 'live session artifacts must be retained');
assert.strictEqual(entries.has('host::subscribed'), true, 'subscribed session artifacts must be retained');

console.log('relay session persistence bounds assertions passed');
