const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexSessionTailer } = require('../shared/codex-tail');
const { findCodexSessionFile } = require('../shared/codex-discovery');

const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function appendJsonl(filePath, row) {
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function row(type, message, timestamp) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type,
      message,
    },
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watch-fast-path-'));
  const codexHome = path.join(root, '.codex');
  const fileA = path.join(codexHome, 'sessions', '2026', '06', '27', `rollout-2026-06-27T00-00-00-${sessionA}.jsonl`);
  const fileB = path.join(codexHome, 'sessions', '2026', '06', '27', `rollout-2026-06-27T00-00-01-${sessionB}.jsonl`);

  writeJsonl(fileA, [row('user_message', 'hello from A', '2026-06-27T00:00:00.000Z')]);
  writeJsonl(fileB, [row('user_message', 'hello from B', '2026-06-27T00:00:01.000Z')]);

  const found = findCodexSessionFile({ codexHome, sessionId: sessionA });
  assert(found, 'findCodexSessionFile should locate a rollout by session id without full discovery');
  assert.strictEqual(found.sessionId, sessionA);
  assert.strictEqual(found.rolloutPath, fileA);

  const events = [];
  const tailer = new CodexSessionTailer({
    codexHome,
    hostId: 'test-host',
    postEvent: async (event) => events.push(event),
  });

  const primeResult = tailer.prime();
  assert.strictEqual(primeResult.sessionCount, 0, 'prime() should not scan every jsonl when no sessions are watched');

  const idleResult = await tailer.poll();
  assert.strictEqual(idleResult.activeSessionCount, 0, 'poll() should report zero active sessions when nothing is watched');
  assert.strictEqual(idleResult.emittedEvents, 0, 'poll() should not emit history from unwatched sessions');
  assert.strictEqual(events.length, 0, 'poll() should not read every session just because it exists on disk');

  tailer.setWatchedSessions([{ sessionId: sessionA, nativeThreadId: sessionA, rolloutPath: fileA }]);
  const primedWatchResult = await tailer.poll();
  assert.strictEqual(primedWatchResult.activeSessionCount, 1, 'poll() should only consider watched sessions');
  assert.strictEqual(primedWatchResult.emittedEvents, 0, 'watching a history file should start at EOF because detail loading owns the existing history');
  appendJsonl(fileA, row('agent_message', 'new A message should be tailed', '2026-06-27T00:00:02.000Z'));
  const firstWatchResult = await tailer.poll();
  assert.strictEqual(firstWatchResult.activeSessionCount, 1, 'poll() should only consider watched sessions');
  assert.strictEqual(firstWatchResult.emittedEvents, 1, 'new lines in the watched rollout should be emitted');
  assert.deepStrictEqual(events.map((event) => event.sessionId), [sessionA]);

  tailer.setWatchedSessions([{ sessionId: sessionB, nativeThreadId: sessionB, rolloutPath: fileB }]);
  const switchedPrimeResult = await tailer.poll();
  assert.strictEqual(switchedPrimeResult.activeSessionCount, 1, 'switching watch targets should keep tail scope narrow');
  assert.strictEqual(switchedPrimeResult.emittedEvents, 0, 'newly watched history should also start tailing at EOF');
  appendJsonl(fileA, row('agent_message', 'new A message should be ignored', '2026-06-27T00:00:03.000Z'));
  appendJsonl(fileB, row('agent_message', 'new B message should be tailed', '2026-06-27T00:00:04.000Z'));

  const secondWatchResult = await tailer.poll();
  assert.strictEqual(secondWatchResult.activeSessionCount, 1, 'switching watch targets should keep tail scope narrow');
  assert.strictEqual(secondWatchResult.emittedEvents, 1, 'only the currently watched rollout should emit new events');
  assert.deepStrictEqual(events.map((event) => event.sessionId), [sessionA, sessionB]);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('session watch fast-path assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
