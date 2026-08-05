const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CodexSessionDiscoveryIndex,
} = require('../shared/codex-discovery');

const SESSION_COUNT = Number(process.env.DISCOVERY_INDEX_SESSION_COUNT || 900);

function writeSession(filePath, index) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({
    timestamp: `2026-07-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    type: 'session_meta',
    payload: {
      id: `incremental-session-${index}`,
      cwd: `C:\\workspace\\project-${index}`,
      timestamp: '2026-07-01T00:00:00.000Z',
      source: 'cli',
    },
  })}\n`, 'utf8');
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-index-'));
  try {
    const codexHome = path.join(root, '.codex');
    const sessionsRoot = path.join(codexHome, 'sessions', '2026', '07', '01');
    const paths = [];
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      const filePath = path.join(
        sessionsRoot,
        `rollout-2026-07-01T00-00-00-incremental-session-${index}.jsonl`
      );
      paths.push(filePath);
      writeSession(filePath, index);
    }

    const index = new CodexSessionDiscoveryIndex({
      codexHome,
      preview: false,
      metaReadLimit: 4,
    });

    const first = index.scan();
    assert.strictEqual(first.initial, true);
    assert.strictEqual(first.sessions.length, SESSION_COUNT);
    assert.strictEqual(first.changedSessions.length, SESSION_COUNT);
    assert.strictEqual(first.cacheStats.parsedFiles, SESSION_COUNT);
    index.acknowledge(first);

    const secondStartedAt = Date.now();
    const second = index.scan();
    const secondElapsedMs = Date.now() - secondStartedAt;
    assert.strictEqual(second.initial, false);
    assert.strictEqual(second.changedSessions.length, 0);
    assert.strictEqual(second.cacheStats.parsedFiles, 0);
    assert.strictEqual(second.cacheStats.reusedFiles, SESSION_COUNT);
    assert(
      secondElapsedMs < 2000,
      `an unchanged ${SESSION_COUNT}-Session inventory took ${secondElapsedMs}ms`
    );

    fs.appendFileSync(paths[417], `${JSON.stringify({
      timestamp: '2026-07-01T00:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'changed' },
    })}\n`, 'utf8');
    const changed = index.scan();
    assert.strictEqual(changed.cacheStats.parsedFiles, 1);
    assert.deepStrictEqual(
      changed.changedSessions.map((session) => session.sessionId),
      ['incremental-session-417']
    );

    const retryBeforeAck = index.scan();
    assert.deepStrictEqual(
      retryBeforeAck.changedSessions.map((session) => session.sessionId),
      ['incremental-session-417'],
      'a failed discovery POST must retain its exact pending delta'
    );
    assert.strictEqual(retryBeforeAck.cacheStats.parsedFiles, 0);
    index.acknowledge(retryBeforeAck);
    assert.strictEqual(index.scan().changedSessions.length, 0);

    const found = index.find(['incremental-session-417']);
    assert.strictEqual(found?.rolloutPath, paths[417]);

    const latePath = path.join(
      sessionsRoot,
      'rollout-2026-07-01T00-00-00-incremental-session-late.jsonl'
    );
    assert.strictEqual(index.find(['incremental-session-late']), null);
    writeSession(latePath, 'late');
    const lateScan = index.scan();
    assert.strictEqual(index.find(['incremental-session-late'])?.rolloutPath, latePath);
    assert(
      lateScan.changedSessions.some((session) => session.sessionId === 'incremental-session-late'),
      'a Session created immediately after a warm scan must be discoverable on the first miss refresh'
    );
    index.acknowledge(lateScan);

    fs.unlinkSync(paths[612]);
    const removed = index.scan();
    assert.deepStrictEqual(removed.removedSessionIds, ['incremental-session-612']);
    assert.strictEqual(index.find(['incremental-session-612']), null);
    index.acknowledge(removed);

    const agentSource = fs.readFileSync(
      path.join(__dirname, '..', 'apps', 'host-agent', 'agent.js'),
      'utf8'
    );
    assert(
      agentSource.includes('scanCodexHomeIndex(codexHome, { force: true });'),
      'an index miss must bypass the warm-scan age gate for newly created Sessions'
    );

    console.log(
      `incremental discovery index assertions passed (${SESSION_COUNT} Sessions, unchanged scan ${secondElapsedMs}ms)`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
