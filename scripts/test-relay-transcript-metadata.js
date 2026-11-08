const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the real Relay merge and append functions without loading server.js,
// opening a listener, or reading/writing any installation's runtime state.
const serverPath = path.join(__dirname, '../apps/relay/server.js');
const source = fs.readFileSync(serverPath, 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Missing Relay function: ${name}`);
  const end = source.indexOf('\nfunction ', start + 1);
  assert(end > start, `Missing boundary after Relay function: ${name}`);
  return source.slice(start, end);
}

let savesScheduled = 0;
const sandbox = {
  state: { sessionLogs: new Map() },
  SESSION_LOG_ENTRY_LIMIT: 1000,
  cleanStoredTranscriptText: (value) => String(value).trim(),
  normalizeFileTransferRefs: (files) => structuredClone(files),
  normalizeClientRequestId: (value) => value || null,
  canonicalTranscriptText: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
  sortTranscriptEntries: (entries) => [...entries],
  sessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
  getSession: () => null,
  nowIso: () => '2026-11-05T00:00:00.000Z',
  scheduleSessionLogsSave: () => { savesScheduled += 1; },
};
vm.createContext(sandbox);
for (const name of [
  'normalizeStoredTranscriptEntry',
  'transcriptIdentityCoordinate',
  'mergeAssistantTranscriptMetadata',
  'mergeExportTranscriptFiles',
  'mergeAdjacentTranscriptDuplicate',
  'isAdjacentTranscriptDuplicate',
  'compactTranscriptEntries',
  'mergeByFingerprint',
  'appendSessionLog',
]) {
  vm.runInContext(functionSource(name), sandbox, { filename: `${serverPath}:${name}` });
}

const attachment = { fileId: 'structure-file', name: 'structure.cif', path: '/work/structure.cif' };
const authoritative = {
  speaker: 'agent',
  timestamp: '2026-11-05T00:00:00.000Z',
  text: 'Complete answer with the structure file and the finished explanation.',
  source: 'codex-jsonl',
  assistantMessageId: 'answer-1',
  assistantSeq: 4,
  assistantAt: '2026-11-05T00:00:00.000Z',
  notifiable: false,
  files: [attachment],
};
const lateSnapshot = {
  ...authoritative,
  timestamp: '2026-11-05T00:00:01.000Z',
  text: 'Complete answer',
  source: 'codex-app-server',
  assistantSeq: 7,
  assistantAt: '2026-11-05T00:00:01.000Z',
  notifiable: true,
  files: [],
};
sandbox.state.sessionLogs.set('host::session', [structuredClone(authoritative)]);
sandbox.appendSessionLog('host', 'session', lateSnapshot);
const persisted = sandbox.state.sessionLogs.get('host::session')[0];
assert.strictEqual(persisted.text, authoritative.text, 'a late short snapshot must not replace authoritative saved text');
assert.strictEqual(persisted.source, 'codex-jsonl', 'the append path must preserve its selected authoritative source');
assert.deepStrictEqual(JSON.parse(JSON.stringify(persisted.files)), [attachment], 'empty late attachments must not erase saved references');
assert.strictEqual(persisted.assistantSeq, 7, 'new notification sequence still advances');
assert.strictEqual(persisted.assistantAt, authoritative.assistantAt, 'the first assistant timestamp stays stable');
assert.strictEqual(persisted.notifiable, true, 'notification eligibility still advances');
assert.strictEqual(savesScheduled, 1, 'the protected result must reach the normal persistence scheduling path');

const secondAttachment = { fileId: 'plot-file', name: 'plot.png', path: '/work/plot.png' };
const adjacent = sandbox.mergeAdjacentTranscriptDuplicate(authoritative, {
  ...lateSnapshot,
  text: authoritative.text,
  files: [secondAttachment],
});
assert.deepStrictEqual(JSON.parse(JSON.stringify(adjacent.files)), [attachment, secondAttachment], 'adjacent duplicate merging must retain its attachment union');
assert.strictEqual(adjacent.assistantSeq, 7);

const merged = sandbox.mergeByFingerprint(
  [authoritative, lateSnapshot],
  (entry) => entry.assistantMessageId,
  1000
);
assert.strictEqual(merged.length, 1);
assert.strictEqual(merged[0].text, authoritative.text, 'fingerprint merging must retain the selected first content');
assert.deepStrictEqual(JSON.parse(JSON.stringify(merged[0].files)), [attachment]);
assert.strictEqual(merged[0].assistantSeq, 7);
assert.strictEqual(merged[0].notifiable, true);

console.log('Relay transcript metadata preserves authoritative content and attachment references');
