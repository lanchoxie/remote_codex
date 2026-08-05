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

function taskRow(type, turnId, timestamp) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type,
      turn_id: turnId,
    },
  };
}

function reasoningRow(message, timestamp) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: message }],
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

  const externalRuntime = tailer.makeSessionEvent(
    { sessionId: sessionA, rolloutPath: fileA, live: true },
    {
      type: 'session.runtime_updated',
      patch: { phase: 'thinking', busy: true, activeTurnId: 'external-turn' },
    },
    { timestamp: '2026-06-27T00:00:00.000Z' },
    { owner: 'external-terminal', turnId: 'external-turn' }
  );
  assert.strictEqual(externalRuntime.patch.phase, undefined);
  assert.strictEqual(externalRuntime.patch.busy, undefined);
  assert.deepStrictEqual(externalRuntime.patch.externalActivity, {
    owner: 'external-terminal',
    active: true,
    turnId: 'external-turn',
    phase: 'thinking',
    status: 'inProgress',
    updatedAt: '2026-06-27T00:00:00.000Z',
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

  const ownershipHome = path.join(root, '.codex-ownership');
  const ownershipFile = path.join(
    ownershipHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-ownership-${sessionA}.jsonl`
  );
  writeJsonl(ownershipFile, []);
  const ownershipEvents = [];
  const managedTurnIds = new Set(['managed-turn']);
  const ownershipTailer = new CodexSessionTailer({
    codexHome: ownershipHome,
    hostId: 'ownership-host',
    postEvents: async (batch) => ownershipEvents.push(...batch),
  });
  ownershipTailer.setWatchedSessions([{
    sessionId: sessionA,
    nativeThreadId: sessionA,
    rolloutPath: ownershipFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedRuntimeActive: true,
    managedTurnOwner: (turnId) => managedTurnIds.has(turnId),
  }]);
  appendJsonl(ownershipFile, taskRow('task_started', 'managed-turn', '2026-06-27T00:02:00.000Z'));
  appendJsonl(ownershipFile, reasoningRow('managed reasoning must remain app-server owned', '2026-06-27T00:02:01.000Z'));
  appendJsonl(ownershipFile, taskRow('task_complete', 'managed-turn', '2026-06-27T00:02:02.000Z'));
  const managedOwnershipResult = await ownershipTailer.poll();
  assert.strictEqual(managedOwnershipResult.emittedEvents, 0);
  assert.strictEqual(ownershipEvents.length, 0, 'a completed managed turn must not be replayed as external activity');

  appendJsonl(ownershipFile, reasoningRow('late-attached managed reasoning', '2026-06-27T00:02:03.000Z'));
  appendJsonl(ownershipFile, taskRow('task_complete', 'managed-turn', '2026-06-27T00:02:04.000Z'));
  const lateAttachResult = await ownershipTailer.poll();
  assert.strictEqual(lateAttachResult.emittedEvents, 0, 'late tail attachment must not turn managed reasoning into external activity');

  appendJsonl(ownershipFile, taskRow('task_started', 'external-turn', '2026-06-27T00:03:00.000Z'));
  appendJsonl(ownershipFile, reasoningRow('external terminal reasoning', '2026-06-27T00:03:01.000Z'));
  appendJsonl(ownershipFile, taskRow('task_complete', 'external-turn', '2026-06-27T00:03:02.000Z'));
  const externalOwnershipResult = await ownershipTailer.poll();
  assert.strictEqual(externalOwnershipResult.emittedEvents, 5);
  assert.strictEqual(ownershipEvents.length, 5);
  const externalRuntimeEvents = ownershipEvents.filter((event) => event.type === 'session.runtime_updated');
  const externalDiagnostics = ownershipEvents.filter((event) => event.type === 'session.diagnostic');
  assert.deepStrictEqual(
    externalRuntimeEvents.map((event) => event.patch.externalActivity.active),
    [true, false],
    'external task lifecycle must be projected without replacing managed runtime fields'
  );
  assert(
    externalRuntimeEvents.every((event) => !Object.prototype.hasOwnProperty.call(event.patch, 'busy')),
    'external observations must not publish canonical busy state'
  );
  assert(
    externalDiagnostics.every((event) => event.data?.activityOwner === 'external-terminal'),
    'external diagnostics must carry an explicit ownership marker for the Relay and browser'
  );

  const lateExternalHome = path.join(root, '.codex-late-external');
  const lateExternalFile = path.join(
    lateExternalHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-late-external-${sessionB}.jsonl`
  );
  writeJsonl(lateExternalFile, [
    taskRow('task_started', 'late-external-turn', '2026-06-27T00:04:00.000Z'),
    reasoningRow('already running before the watch was attached', '2026-06-27T00:04:01.000Z'),
  ]);
  const lateExternalEvents = [];
  const lateExternalTailer = new CodexSessionTailer({
    codexHome: lateExternalHome,
    hostId: 'late-external-host',
    postEvents: async (batch) => lateExternalEvents.push(...batch),
  });
  lateExternalTailer.setWatchedSessions([{
    sessionId: sessionB,
    nativeThreadId: sessionB,
    rolloutPath: lateExternalFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwner: () => false,
  }]);
  await lateExternalTailer.poll();
  assert.deepStrictEqual(
    lateExternalEvents.filter((event) => event.type === 'session.runtime_updated')
      .map((event) => event.patch.externalActivity?.active),
    [true],
    'attaching during an external turn must immediately project Thinking activity'
  );
  appendJsonl(lateExternalFile, row('agent_message', 'external answer after late watch', '2026-06-27T00:04:02.000Z'));
  const lateExternalTranscriptResult = await lateExternalTailer.poll();
  assert.strictEqual(lateExternalTranscriptResult.emittedEvents, 1);
  assert(
    lateExternalEvents.some((event) => event.type === 'session.transcript' && event.speaker === 'agent'),
    'assistant output from an external rollout must remain visible in the managed Session'
  );

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
