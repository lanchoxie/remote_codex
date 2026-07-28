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
  if (type === 'agent_message') {
    return {
      timestamp,
      type: 'response_item',
      payload: {
        id: `msg-${String(timestamp).replace(/[^0-9]/g, '')}`,
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: message }],
      },
    };
  }
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type,
      message,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  const diagnostic = {
    type: 'session.diagnostic',
    entry: { kind: 'reasoning', message: 'selected history diagnostic' },
  };
  const diagnosticRow = { timestamp: '2026-06-27T00:00:00.000Z' };
  assert.strictEqual(
    tailer.makeSessionEvent({ sessionId: sessionA, rolloutPath: fileA, live: true }, diagnostic, diagnosticRow),
    null,
    'live managed Sessions must keep app-server as the sole runtime/diagnostic source'
  );
  assert(
    tailer.makeSessionEvent({ sessionId: sessionB, rolloutPath: fileB, live: false, selected: true }, diagnostic, diagnosticRow),
    'a selected non-live history Session must still receive JSONL diagnostics'
  );

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

  tailer.setWatchedSessions([
    { sessionId: sessionA, nativeThreadId: sessionA, rolloutPath: fileA, live: true },
    { sessionId: sessionB, nativeThreadId: sessionB, rolloutPath: fileB, selected: true },
  ]);
  await tailer.poll();
  appendJsonl(fileA, row('agent_message', 'live A must continue while B is selected', '2026-06-27T00:00:05.000Z'));
  appendJsonl(fileB, row('agent_message', 'selected history B must update', '2026-06-27T00:00:06.000Z'));
  const unionResult = await tailer.poll();
  assert.strictEqual(unionResult.activeSessionCount, 2, 'the active scope should contain live plus selected history');
  assert.deepStrictEqual(events.slice(-2).map((event) => event.sessionId), [sessionA, sessionB]);

  tailer.setWatchedSessions([
    { sessionId: sessionA, nativeThreadId: sessionA, rolloutPath: fileA, live: true },
  ]);
  appendJsonl(fileA, row('agent_message', 'live A remains after switching away', '2026-06-27T00:00:07.000Z'));
  appendJsonl(fileB, row('agent_message', 'unselected history B must stop', '2026-06-27T00:00:08.000Z'));
  const liveOnlyResult = await tailer.poll();
  assert.strictEqual(liveOnlyResult.activeSessionCount, 1);
  assert.strictEqual(events.at(-1).sessionId, sessionA, 'switching away must retain live A but drop history B');

  tailer.setWatchedSessions([
    { sessionId: sessionA, nativeThreadId: sessionA, rolloutPath: fileA, live: true },
    { sessionId: sessionA, nativeThreadId: sessionA, rolloutPath: fileA, selected: true },
  ]);
  const dedupedResult = await tailer.poll();
  assert.strictEqual(dedupedResult.activeSessionCount, 1, 'selected=live must deduplicate by rollout path');

  const raceHome = path.join(root, '.codex-race');
  const raceFileA = path.join(raceHome, 'sessions', '2026', '06', '27', `rollout-a-${sessionA}.jsonl`);
  const raceFileB = path.join(raceHome, 'sessions', '2026', '06', '27', `rollout-b-${sessionB}.jsonl`);
  writeJsonl(raceFileA, []);
  writeJsonl(raceFileB, []);
  const transportStarted = deferred();
  const releaseTransport = deferred();
  const raceEvents = [];
  let shouldBlock = true;
  const raceTailer = new CodexSessionTailer({
    codexHome: raceHome,
    hostId: 'race-host',
    postEvents: async (batch) => {
      raceEvents.push(...batch);
      if (shouldBlock) {
        shouldBlock = false;
        transportStarted.resolve();
        await releaseTransport.promise;
      }
    },
  });
  raceTailer.setWatchedSessions([{ sessionId: sessionA, nativeThreadId: sessionA, rolloutPath: raceFileA }]);
  appendJsonl(raceFileA, row('agent_message', 'block old poll', '2026-06-27T00:01:00.000Z'));
  const blockedPoll = raceTailer.poll();
  await transportStarted.promise;
  raceTailer.setWatchedSessions([{ sessionId: sessionB, nativeThreadId: sessionB, rolloutPath: raceFileB }]);
  appendJsonl(raceFileB, row('agent_message', 'must survive old poll cleanup', '2026-06-27T00:01:01.000Z'));
  releaseTransport.resolve();
  await blockedPoll;
  const raceResult = await raceTailer.poll();
  assert.strictEqual(raceResult.emittedEvents, 1, 'a watch added during an older poll must not be re-primed at EOF');
  assert.strictEqual(raceEvents.at(-1).sessionId, sessionB);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('session watch fast-path assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
