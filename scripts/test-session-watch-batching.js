const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexSessionTailer } = require('../shared/codex-tail');

const SESSION_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const EVENTS_PER_SESSION = Number(process.env.SYNC_PERF_EVENTS_PER_SESSION || 70);
const POST_LATENCY_MS = 15;
const MAX_EVENTS_PER_BATCH = 64;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rolloutPath(codexHome, sessionId, index) {
  return path.join(
    codexHome,
    'sessions',
    '2026',
    '07',
    '11',
    `rollout-2026-07-11T19-00-0${index}-${sessionId}.jsonl`
  );
}

function appendAgentMessages(filePath, sessionId) {
  const rows = [];
  for (let index = 0; index < EVENTS_PER_SESSION; index += 1) {
    rows.push(JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 6, 11, 11, 0, 0) + index * 1000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: `${sessionId}:${index}`,
      },
    }));
  }
  fs.appendFileSync(filePath, `${rows.join('\n')}\n`);
}

function createWatchedSessions(codexHome, suffix = '') {
  return SESSION_IDS.map((sessionId, index) => {
    const filePath = rolloutPath(codexHome, sessionId, `${index}${suffix}`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
    return {
      sessionId,
      nativeThreadId: sessionId,
      rolloutPath: filePath,
    };
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watch-batching-'));
  const codexHome = path.join(root, '.codex');
  const watchedSessions = createWatchedSessions(codexHome);

  let singlePostCount = 0;
  const postedBatches = [];
  const postedBatchIds = [];
  let measuredPollMs = null;
  const expectedEventCount = SESSION_IDS.length * EVENTS_PER_SESSION;
  const expectedBatchCount = Math.ceil(expectedEventCount / MAX_EVENTS_PER_BATCH);
  const tailer = new CodexSessionTailer({
    codexHome,
    hostId: 'batch-test-host',
    postEvent: async () => {
      singlePostCount += 1;
      await delay(POST_LATENCY_MS);
    },
    postEvents: async (events, options) => {
      postedBatches.push(events);
      postedBatchIds.push(options?.batchId || null);
      await delay(POST_LATENCY_MS);
    },
    assistantMirrorGraceMs: 0,
  });

  try {
    tailer.setWatchedSessions(watchedSessions);
    for (const session of watchedSessions) {
      appendAgentMessages(session.rolloutPath, session.sessionId);
    }

    const startedAt = Date.now();
    const result = await tailer.poll();
    const elapsedMs = Date.now() - startedAt;
    measuredPollMs = elapsedMs;
    const postedEvents = postedBatches.flat();

    assert.strictEqual(result.activeSessionCount, 3, 'the regression must cover three active sessions');
    assert.strictEqual(result.emittedEvents, expectedEventCount, 'all appended session events must be emitted');
    assert.strictEqual(singlePostCount, 0, 'poll() must not wait for one HTTP request per event when batch posting is available');
    assert.strictEqual(postedBatches.length, expectedBatchCount, 'events must use bounded relay batches');
    assert(postedBatches.every((batch) => batch.length <= MAX_EVENTS_PER_BATCH), 'no batch may exceed the configured bound');
    assert(postedBatchIds.every(Boolean), 'every batch must have an idempotency key');
    assert.strictEqual(new Set(postedBatchIds).size, expectedBatchCount, 'each completed batch must have a distinct idempotency key');
    assert.strictEqual(postedEvents.length, expectedEventCount, 'the batches must contain every emitted event');
    assert(
      postedEvents.every((event) => event.assistantObservation?.assistantMessageId),
      'every finalized assistant transcript row must carry a stable assistant observation'
    );
    assert(
      postedEvents.every((event) => Number.isSafeInteger(event.assistantObservation.sourceIdentity.sourceOffset)),
      'tail observations must retain immutable byte offsets'
    );
    assert.deepStrictEqual(
      postedEvents.map((event) => event.sessionId),
      SESSION_IDS.flatMap((sessionId) => Array(EVENTS_PER_SESSION).fill(sessionId)),
      'batching must preserve file and event order'
    );
    assert(
      elapsedMs < POST_LATENCY_MS * expectedBatchCount + 150,
      `three-session polling should amortize ${POST_LATENCY_MS}ms transport latency; observed ${elapsedMs}ms`
    );

    const retryCodexHome = path.join(root, '.codex-retry');
    const retrySessions = createWatchedSessions(retryCodexHome, '-retry');
    const deliveryAttempts = [];
    const deliveredEvents = [];
    let injectedFailure = false;
    const retryTailer = new CodexSessionTailer({
      codexHome: retryCodexHome,
      hostId: 'batch-retry-test-host',
      postEvents: async (events, options) => {
        deliveryAttempts.push({
          batchId: options?.batchId || null,
          events: events.slice(),
        });
        if (!injectedFailure && deliveryAttempts.length === 2) {
          injectedFailure = true;
          throw new Error('injected batch failure');
        }
        deliveredEvents.push(...events);
      },
      assistantMirrorGraceMs: 0,
    });
    retryTailer.setWatchedSessions(retrySessions);
    for (const session of retrySessions) {
      appendAgentMessages(session.rolloutPath, session.sessionId);
    }

    await assert.rejects(retryTailer.poll(), /injected batch failure/);
    const failedBatch = deliveryAttempts[1];
    const retryResult = await retryTailer.poll();
    const retriedBatch = deliveryAttempts[2];

    assert(failedBatch.batchId, 'a failed batch must retain an idempotency key');
    assert.strictEqual(retriedBatch.batchId, failedBatch.batchId, 'retry must reuse the failed batch idempotency key');
    assert.deepStrictEqual(retriedBatch.events, failedBatch.events, 'retry must resend the exact failed batch');
    assert.strictEqual(deliveredEvents.length, expectedEventCount, 'a failed batch must not lose unread or queued events');
    assert.deepStrictEqual(
      deliveredEvents.map((event) => event.sessionId),
      SESSION_IDS.flatMap((sessionId) => Array(EVENTS_PER_SESSION).fill(sessionId)),
      'retry must preserve global file and event order without redelivering confirmed batches'
    );
    assert(
      retryResult.emittedEvents < expectedEventCount,
      'retry must not reread sessions that the failed poll already queued'
    );

    const mirrorHome = path.join(root, '.codex-mirror');
    const mirrorSessionId = '44444444-4444-4444-8444-444444444444';
    const mirrorPath = rolloutPath(mirrorHome, mirrorSessionId, 'mirror');
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, '');
    const mirrorPosted = [];
    let mirrorNowMs = Date.parse('2026-07-11T12:00:00.000Z');
    const mirrorTailer = new CodexSessionTailer({
      codexHome: mirrorHome,
      hostId: 'mirror-test-host',
      assistantMirrorGraceMs: 250,
      nowMs: () => mirrorNowMs,
      postEvents: async (events) => mirrorPosted.push(...events),
    });
    mirrorTailer.setWatchedSessions([{
      sessionId: mirrorSessionId,
      nativeThreadId: mirrorSessionId,
      rolloutPath: mirrorPath,
    }]);
    const finalEvent = {
      timestamp: '2026-07-11T12:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final', message: 'mirrored answer' },
    };
    const finalResponse = {
      timestamp: '2026-07-11T12:00:00.035Z',
      type: 'response_item',
      payload: {
        id: 'msg-mirror-final',
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: 'mirrored answer' }],
      },
    };
    fs.appendFileSync(mirrorPath, `${JSON.stringify(finalEvent)}\n`);
    const pendingMirror = await mirrorTailer.poll();
    assert.strictEqual(pendingMirror.emittedEvents, 0, 'an event_msg at EOF must wait briefly for its response mirror');
    fs.appendFileSync(mirrorPath, `${JSON.stringify(finalResponse)}\n`);
    await mirrorTailer.poll();
    const mirroredTranscripts = mirrorPosted.filter((event) => event.type === 'session.transcript');
    assert.strictEqual(mirroredTranscripts.length, 1, 'a mirror split across polls must emit one transcript');
    assert.strictEqual(
      mirroredTranscripts[0].assistantObservation?.sourceIdentity?.protocolItemId,
      'msg-mirror-final'
    );

    const commentaryEvent = {
      timestamp: '2026-07-11T12:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'checking files' },
    };
    const commentaryResponse = {
      timestamp: '2026-07-11T12:00:01.020Z',
      type: 'response_item',
      payload: {
        id: 'msg-mirror-commentary',
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'checking files' }],
      },
    };
    fs.appendFileSync(
      mirrorPath,
      `${JSON.stringify(commentaryEvent)}\n${JSON.stringify(commentaryResponse)}\n`
    );
    await mirrorTailer.poll();
    assert.strictEqual(
      mirrorPosted.filter((event) => event.type === 'session.diagnostic' && event.message === 'checking files').length,
      1,
      'commentary mirrors must produce one Thinking diagnostic'
    );

    const legacyEvent = {
      timestamp: '2026-07-11T12:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'legacy event-only answer' },
    };
    const taskComplete = {
      timestamp: '2026-07-11T12:00:02.100Z',
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'legacy event-only answer' },
    };
    fs.appendFileSync(mirrorPath, `${JSON.stringify(legacyEvent)}\n${JSON.stringify(taskComplete)}\n`);
    await mirrorTailer.poll();
    assert.strictEqual(
      mirrorPosted.filter((event) => event.type === 'session.transcript' && event.text === 'legacy event-only answer').length,
      1,
      'an unpaired legacy event_msg must remain visible'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`session watch batching assertions passed (${measuredPollMs}ms for ${expectedEventCount} events across 3 sessions in ${expectedBatchCount} batches)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
