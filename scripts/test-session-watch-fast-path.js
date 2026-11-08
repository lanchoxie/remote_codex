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

function taskRow(type, turnId, timestamp, parentTurnId = null) {
  const payload = {
    type,
    turn_id: turnId,
  };
  if (parentTurnId) {
    payload.parent_turn_id = parentTurnId;
  }
  return {
    timestamp,
    type: 'event_msg',
    payload,
  };
}

function reviewRow(type, turnId, timestamp) {
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

function agentEventRow(message, timestamp, phase = null) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message,
      phase,
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
  appendJsonl(ownershipFile, agentEventRow('external terminal answer', '2026-06-27T00:03:01.500Z', 'final'));
  appendJsonl(ownershipFile, taskRow('task_complete', 'external-turn', '2026-06-27T00:03:02.000Z'));
  const externalOwnershipResult = await ownershipTailer.poll();
  assert.strictEqual(externalOwnershipResult.emittedEvents, 6);
  assert.strictEqual(ownershipEvents.length, 6);
  const externalRuntimeEvents = ownershipEvents.filter((event) => event.type === 'session.runtime_updated');
  const externalDiagnostics = ownershipEvents.filter((event) => event.type === 'session.diagnostic');
  const externalTranscript = ownershipEvents.find((event) => (
    event.type === 'session.transcript' && event.text === 'external terminal answer'
  ));
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
  assert.strictEqual(
    externalTranscript?.activityOwner,
    'external-terminal',
    'external transcript must carry an explicit ownership marker for Relay admission'
  );
  assert.strictEqual(externalTranscript?.turnId, 'external-turn');

  const reviewHome = path.join(root, '.codex-managed-review');
  const reviewFile = path.join(
    reviewHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-review-${sessionA}.jsonl`
  );
  writeJsonl(reviewFile, []);
  const reviewEvents = [];
  const reviewParentTurnId = 'managed-review-parent';
  const reviewChildTurnId = 'managed-review-child';
  const reviewTailer = new CodexSessionTailer({
    codexHome: reviewHome,
    hostId: 'review-host',
    postEvents: async (batch) => reviewEvents.push(...batch),
  });
  reviewTailer.setWatchedSessions([{
    sessionId: sessionA,
    nativeThreadId: sessionA,
    rolloutPath: reviewFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedRuntimeActive: true,
    managedTurnOwner: (turnId) => turnId === reviewParentTurnId,
  }]);
  appendJsonl(reviewFile, reviewRow('entered_review_mode', reviewParentTurnId, '2026-06-27T00:03:10.000Z'));
  appendJsonl(reviewFile, taskRow('task_started', reviewChildTurnId, '2026-06-27T00:03:11.000Z', reviewParentTurnId));
  appendJsonl(reviewFile, reasoningRow('managed reviewer reasoning', '2026-06-27T00:03:12.000Z'));
  appendJsonl(reviewFile, reviewRow('exited_review_mode', reviewParentTurnId, '2026-06-27T00:03:13.000Z'));
  await reviewTailer.poll();
  assert.deepStrictEqual(
    reviewEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [{ active: true, turnId: reviewChildTurnId }],
    'exiting Review must not settle its internal reviewer before the final output and parent terminal row'
  );
  const reviewAnswer = 'No definite, actionable regressions were identified.';
  appendJsonl(reviewFile, row('agent_message', reviewAnswer, '2026-06-27T00:03:13.010Z'));
  appendJsonl(reviewFile, agentEventRow(reviewAnswer, '2026-06-27T00:03:13.010Z'));
  appendJsonl(reviewFile, taskRow('task_complete', reviewParentTurnId, '2026-06-27T00:03:14.000Z'));
  await reviewTailer.poll();
  const reviewRuntimeEvents = reviewEvents.filter((event) => event.type === 'session.runtime_updated');
  assert.deepStrictEqual(
    reviewRuntimeEvents.map((event) => ({
      active: event.patch.externalActivity?.active,
      turnId: event.patch.externalActivity?.turnId,
    })),
    [
      { active: true, turnId: reviewChildTurnId },
      { active: false, turnId: reviewChildTurnId },
    ],
    'an internal reviewer Turn must settle with its managed parent terminal row even without a child task_complete row'
  );
  assert.strictEqual(
    reviewEvents.filter((event) => event.type === 'session.transcript' && event.text === reviewAnswer).length,
    1,
    'a response_item followed by its event_msg mirror must publish the Review answer exactly once'
  );

  const seededReviewEvents = [];
  const seededReviewTailer = new CodexSessionTailer({
    codexHome: reviewHome,
    hostId: 'seeded-review-host',
    postEvents: async (batch) => seededReviewEvents.push(...batch),
  });
  seededReviewTailer.setWatchedSessions([{
    sessionId: sessionA,
    nativeThreadId: sessionA,
    rolloutPath: reviewFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwner: (turnId) => turnId === reviewParentTurnId,
  }]);
  await seededReviewTailer.poll();
  assert.deepStrictEqual(
    seededReviewEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [{ active: false, turnId: reviewChildTurnId }],
    'attaching after a completed managed Review must repair a previously persisted reviewer activity marker'
  );

  const restartedReviewEvents = [];
  const restartedReviewTailer = new CodexSessionTailer({
    codexHome: reviewHome,
    hostId: 'restarted-review-host',
    postEvents: async (batch) => restartedReviewEvents.push(...batch),
  });
  restartedReviewTailer.setWatchedSessions([{
    sessionId: sessionA,
    nativeThreadId: sessionA,
    rolloutPath: reviewFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwner: () => false,
  }]);
  await restartedReviewTailer.poll();
  assert.deepStrictEqual(
    restartedReviewEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [{ active: false, turnId: reviewChildTurnId }],
    'late attachment after Runner ownership memory is gone must still settle a completed Review child'
  );

  const missingExitHome = path.join(root, '.codex-managed-review-missing-exit');
  const missingExitFile = path.join(
    missingExitHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-review-missing-exit-${sessionA}.jsonl`
  );
  writeJsonl(missingExitFile, []);
  const missingExitEvents = [];
  const missingExitTailer = new CodexSessionTailer({
    codexHome: missingExitHome,
    hostId: 'missing-exit-review-host',
    postEvents: async (batch) => missingExitEvents.push(...batch),
  });
  missingExitTailer.setWatchedSessions([{
    sessionId: sessionA,
    nativeThreadId: sessionA,
    rolloutPath: missingExitFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwner: (turnId) => turnId === reviewParentTurnId,
  }]);
  appendJsonl(missingExitFile, reviewRow('entered_review_mode', reviewParentTurnId, '2026-06-27T00:03:20.000Z'));
  appendJsonl(missingExitFile, taskRow('task_started', reviewChildTurnId, '2026-06-27T00:03:21.000Z', reviewParentTurnId));
  appendJsonl(missingExitFile, taskRow('task_complete', reviewParentTurnId, '2026-06-27T00:03:22.000Z'));
  await missingExitTailer.poll();
  assert.deepStrictEqual(
    missingExitEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [{ active: true, turnId: reviewChildTurnId }],
    'a parent Review terminal without an exit marker must keep the internal activity fail-closed'
  );
  appendJsonl(missingExitFile, reviewRow('exited_review_mode', reviewParentTurnId, '2026-06-27T00:03:23.000Z'));
  await missingExitTailer.poll();
  assert.deepStrictEqual(
    missingExitEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [
      { active: true, turnId: reviewChildTurnId },
      { active: false, turnId: reviewChildTurnId },
    ],
    'a late Review exit marker may settle the retained internal activity after the parent terminal'
  );

  const unrelatedTerminalHome = path.join(root, '.codex-unrelated-terminal');
  const unrelatedTerminalFile = path.join(
    unrelatedTerminalHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-unrelated-terminal-${sessionB}.jsonl`
  );
  writeJsonl(unrelatedTerminalFile, []);
  const unrelatedTerminalEvents = [];
  const unrelatedTerminalTailer = new CodexSessionTailer({
    codexHome: unrelatedTerminalHome,
    hostId: 'unrelated-terminal-host',
    postEvents: async (batch) => unrelatedTerminalEvents.push(...batch),
  });
  unrelatedTerminalTailer.setWatchedSessions([{
    sessionId: sessionB,
    nativeThreadId: sessionB,
    rolloutPath: unrelatedTerminalFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwner: (turnId) => turnId === 'managed-unrelated-turn',
  }]);
  appendJsonl(unrelatedTerminalFile, taskRow('task_started', 'external-unrelated-turn', '2026-06-27T00:03:30.000Z'));
  appendJsonl(unrelatedTerminalFile, taskRow('task_complete', 'managed-unrelated-turn', '2026-06-27T00:03:31.000Z'));
  await unrelatedTerminalTailer.poll();
  assert.deepStrictEqual(
    unrelatedTerminalEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [{ active: true, turnId: 'external-unrelated-turn' }],
    'an unrelated managed terminal must not clear a real external terminal activity'
  );
  appendJsonl(unrelatedTerminalFile, taskRow('task_complete', 'external-unrelated-turn', '2026-06-27T00:03:32.000Z'));
  await unrelatedTerminalTailer.poll();
  assert.deepStrictEqual(
    unrelatedTerminalEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [
      { active: true, turnId: 'external-unrelated-turn' },
      { active: false, turnId: 'external-unrelated-turn' },
    ],
    'the external terminal itself must still settle normally'
  );

  const reviewThenExternalHome = path.join(root, '.codex-review-then-external');
  const reviewThenExternalFile = path.join(
    reviewThenExternalHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-review-then-external-${sessionB}.jsonl`
  );
  writeJsonl(reviewThenExternalFile, []);
  const reviewThenExternalEvents = [];
  const reviewThenExternalTailer = new CodexSessionTailer({
    codexHome: reviewThenExternalHome,
    hostId: 'review-then-external-host',
    postEvents: async (batch) => reviewThenExternalEvents.push(...batch),
  });
  reviewThenExternalTailer.setWatchedSessions([{
    sessionId: sessionB,
    nativeThreadId: sessionB,
    rolloutPath: reviewThenExternalFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwner: (turnId) => turnId === 'review-parent-2',
  }]);
  appendJsonl(reviewThenExternalFile, reviewRow('entered_review_mode', 'review-parent-2', '2026-06-27T00:03:40.000Z'));
  appendJsonl(reviewThenExternalFile, taskRow('task_started', 'review-child-2', '2026-06-27T00:03:41.000Z', 'review-parent-2'));
  appendJsonl(reviewThenExternalFile, reviewRow('exited_review_mode', 'review-parent-2', '2026-06-27T00:03:42.000Z'));
  appendJsonl(reviewThenExternalFile, taskRow('task_started', 'external-new-turn', '2026-06-27T00:03:43.000Z'));
  appendJsonl(reviewThenExternalFile, taskRow('task_complete', 'review-parent-2', '2026-06-27T00:03:44.000Z'));
  await reviewThenExternalTailer.poll();
  assert.deepStrictEqual(
    reviewThenExternalEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [
      { active: true, turnId: 'review-child-2' },
      { active: true, turnId: 'external-new-turn' },
    ],
    'a newer external Turn must survive a late parent Review terminal'
  );
  appendJsonl(reviewThenExternalFile, taskRow('task_complete', 'external-new-turn', '2026-06-27T00:03:45.000Z'));
  await reviewThenExternalTailer.poll();
  assert.deepStrictEqual(
    reviewThenExternalEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [
      { active: true, turnId: 'review-child-2' },
      { active: true, turnId: 'external-new-turn' },
      { active: false, turnId: 'external-new-turn' },
    ],
    'the newer external Turn must settle by its own terminal row'
  );

  const concurrentExternalHome = path.join(root, '.codex-review-concurrent-external');
  const concurrentExternalFile = path.join(
    concurrentExternalHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-review-concurrent-external-${sessionB}.jsonl`
  );
  writeJsonl(concurrentExternalFile, []);
  const concurrentExternalEvents = [];
  const concurrentExternalTailer = new CodexSessionTailer({
    codexHome: concurrentExternalHome,
    hostId: 'review-concurrent-external-host',
    postEvents: async (batch) => concurrentExternalEvents.push(...batch),
  });
  concurrentExternalTailer.setWatchedSessions([{
    sessionId: sessionB,
    nativeThreadId: sessionB,
    rolloutPath: concurrentExternalFile,
    live: true,
    transcriptOwner: 'managed-runner',
    // The Runner explicitly reports this turn as foreign.  It has no
    // parent_turn_id, so an open Review must not claim it as a child.
    managedTurnOwner: () => false,
  }]);
  appendJsonl(concurrentExternalFile, reviewRow('entered_review_mode', 'review-parent-concurrent', '2026-06-27T00:03:50.000Z'));
  appendJsonl(concurrentExternalFile, taskRow('task_started', 'external-concurrent-turn', '2026-06-27T00:03:51.000Z'));
  appendJsonl(concurrentExternalFile, reasoningRow('unrelated terminal remains active', '2026-06-27T00:03:52.000Z'));
  appendJsonl(concurrentExternalFile, taskRow('task_complete', 'review-parent-concurrent', '2026-06-27T00:03:53.000Z'));
  await concurrentExternalTailer.poll();
  assert.deepStrictEqual(
    concurrentExternalEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [],
    'an unlinked Turn during Review must fail closed instead of being claimed as a Review child or projected as live terminal activity'
  );
  appendJsonl(concurrentExternalFile, taskRow('task_complete', 'external-concurrent-turn', '2026-06-27T00:03:54.000Z'));
  await concurrentExternalTailer.poll();
  assert.deepStrictEqual(
    concurrentExternalEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [],
    'a fail-closed unlinked Turn must not emit a guessed terminal transition later'
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

  const ownershipRevisionHome = path.join(root, '.codex-ownership-revision');
  const ownershipRevisionFile = path.join(
    ownershipRevisionHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-ownership-revision-${sessionB}.jsonl`
  );
  writeJsonl(ownershipRevisionFile, [
    taskRow('task_started', 'revision-managed-turn', '2026-06-27T00:04:10.000Z'),
    reasoningRow('ownership starts unknown', '2026-06-27T00:04:11.000Z'),
  ]);
  const ownershipRevisionEvents = [];
  let revisionTurnManaged = false;
  const ownershipRevisionTailer = new CodexSessionTailer({
    codexHome: ownershipRevisionHome,
    hostId: 'ownership-revision-host',
    postEvents: async (batch) => ownershipRevisionEvents.push(...batch),
  });
  const revisionSession = {
    sessionId: sessionB,
    nativeThreadId: sessionB,
    rolloutPath: ownershipRevisionFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwnershipRevision: 'revision-1',
    managedTurnOwner: () => revisionTurnManaged,
  };
  ownershipRevisionTailer.setWatchedSessions([revisionSession]);
  await ownershipRevisionTailer.poll();
  assert.deepStrictEqual(
    ownershipRevisionEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => event.patch.externalActivity?.active),
    [true],
    'an unresolved ownership map may conservatively project a complete external seed'
  );
  revisionTurnManaged = true;
  ownershipRevisionTailer.setWatchedSessions([{
    ...revisionSession,
    managedTurnOwnershipRevision: 'revision-2',
  }]);
  await ownershipRevisionTailer.poll();
  assert.deepStrictEqual(
    ownershipRevisionEvents
      .filter((event) => event.type === 'session.runtime_updated')
      .map((event) => ({
        active: event.patch.externalActivity?.active,
        turnId: event.patch.externalActivity?.turnId,
      })),
    [
      { active: true, turnId: 'revision-managed-turn' },
      { active: false, turnId: 'revision-managed-turn' },
    ],
    'a changed ownership revision must retract an earlier conservative external projection'
  );

  const boundedSeedHome = path.join(root, '.codex-bounded-seed');
  const boundedSeedFile = path.join(
    boundedSeedHome,
    'sessions',
    '2026',
    '06',
    '27',
    `rollout-bounded-seed-${sessionB}.jsonl`
  );
  writeJsonl(boundedSeedFile, [
    reviewRow('entered_review_mode', 'bounded-review-parent', '2026-06-27T00:04:20.000Z'),
    ...Array.from({ length: 12 }, (_, index) => reasoningRow(
      `bounded seed filler ${index} ${'x'.repeat(180)}`,
      `2026-06-27T00:04:${String(21 + index).padStart(2, '0')}.000Z`
    )),
    taskRow('task_started', 'bounded-review-child', '2026-06-27T00:04:40.000Z', 'bounded-review-parent'),
    reasoningRow('review child remains active', '2026-06-27T00:04:41.000Z'),
  ]);
  const boundedSeedEvents = [];
  const boundedSeedTailer = new CodexSessionTailer({
    codexHome: boundedSeedHome,
    hostId: 'bounded-seed-host',
    maxBytesPerSeed: 512,
    postEvents: async (batch) => boundedSeedEvents.push(...batch),
  });
  boundedSeedTailer.setWatchedSessions([{
    sessionId: sessionB,
    nativeThreadId: sessionB,
    rolloutPath: boundedSeedFile,
    live: true,
    transcriptOwner: 'managed-runner',
    managedTurnOwner: () => false,
  }]);
  await boundedSeedTailer.poll();
  assert.deepStrictEqual(
    boundedSeedEvents.filter((event) => event.type === 'session.runtime_updated'),
    [],
    'a seed with an unresolved prefix must not guess that a Review child is external'
  );
  appendJsonl(boundedSeedFile, taskRow('task_complete', 'bounded-review-child', '2026-06-27T00:04:42.000Z'));
  await boundedSeedTailer.poll();
  assert.deepStrictEqual(
    boundedSeedEvents.filter((event) => event.type === 'session.runtime_updated'),
    [],
    'an unresolved seed must not emit a lone terminal event without a published start'
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
