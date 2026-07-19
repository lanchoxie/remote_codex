const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CodexAssistantCursorIndex,
} = require('../shared/codex-assistant-cursor');
const { CodexSessionTailer } = require('../shared/codex-tail');

function assistantRow(id, message) {
  return JSON.stringify({
    timestamp: `2026-07-16T10:00:${String(id).padStart(2, '0')}.000Z`,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      id: `item-${id}`,
      turn_id: `turn-${id}`,
      content: [{ id: 'part-0', type: 'output_text', text: message }],
    },
  });
}

function taskCompleteRow(message) {
  return JSON.stringify({
    timestamp: '2026-07-16T10:00:30.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: message },
  });
}

function makeInstrumentedFs() {
  const calls = { open: 0, read: 0, stat: 0 };
  return {
    calls,
    impl: {
      ...fs,
      openSync(...args) {
        calls.open += 1;
        return fs.openSync(...args);
      },
      readSync(...args) {
        calls.read += 1;
        return fs.readSync(...args);
      },
      statSync(...args) {
        calls.stat += 1;
        return fs.statSync(...args);
      },
    },
  };
}

function finishBackfill(index, session, firstResult) {
  let result = firstResult || index.scan(session);
  let scans = 0;
  while (result.cursorUnknown) {
    assert(result.bytesRead <= index.maxBytesPerScan, 'every rebuild slice must honor the byte budget');
    result = index.scan(session);
    scans += 1;
    assert(scans < 100, 'bounded cursor rebuild did not converge');
  }
  return result;
}

async function verifyTailProjection(root) {
  const rolloutPath = path.join(root, 'rollout-2026-07-16T11-00-00-tail-thread.jsonl');
  const initial = `${JSON.stringify({
    timestamp: '2026-07-16T11:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '初始问题' },
  })}\n`;
  fs.writeFileSync(rolloutPath, initial, 'utf8');

  const session = {
    sessionId: 'tail-thread',
    nativeThreadId: 'tail-thread',
    rolloutPath,
  };
  const cursor = new CodexAssistantCursorIndex({
    maxBytesPerScan: 4096,
    now: () => '2026-07-16T11:00:10.000Z',
  });
  const baseline = finishBackfill(cursor, session);
  cursor.acknowledge(baseline);

  const posted = [];
  const tailer = new CodexSessionTailer({
    hostId: 'cursor-tail-host',
    assistantCursorIndex: cursor,
    postEvents: async (events) => posted.push(...events),
  });
  tailer.setWatchedSessions([session]);

  const row = {
    timestamp: '2026-07-16T11:00:11.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: '尾部中文\n\n\n\n答案' },
  };
  const encoded = Buffer.from(JSON.stringify(row), 'utf8');
  const multibyte = encoded.indexOf(Buffer.from('中', 'utf8'));
  assert(multibyte > 0);
  fs.appendFileSync(rolloutPath, encoded.subarray(0, multibyte + 1));
  const partial = await tailer.poll();
  assert.strictEqual(partial.emittedEvents, 0, 'tailing must retain an incomplete UTF-8 JSON row without emitting it');
  fs.appendFileSync(rolloutPath, Buffer.concat([
    encoded.subarray(multibyte + 1),
    Buffer.from('\n'),
  ]));
  const completed = await tailer.poll();
  assert.strictEqual(completed.emittedEvents, 1);
  const transcript = posted.find((event) => event.type === 'session.transcript');
  assert(transcript?.assistantObservation?.assistantMessageId);
  assert.strictEqual(
    transcript.assistantObservation.sourceIdentity.sourceOffset,
    Buffer.byteLength(initial, 'utf8'),
    'tail coordinates must count bytes rather than JavaScript characters'
  );
  assert.strictEqual(
    transcript.assistantObservation.sourceIdentity.sourceOrdinal,
    null,
    'a tailer primed at EOF must not invent a full-file ordinal'
  );

  const discoveryAfterTail = finishBackfill(cursor, session);
  assert.deepStrictEqual(
    discoveryAfterTail.observations,
    [],
    'the shared cursor index must dedupe an observation already published by tailing'
  );
  assert(
    discoveryAfterTail.allObservedIds.includes(transcript.assistantObservation.assistantMessageId),
    'tail and discovery must converge on one assistant identity'
  );

  posted.length = 0;
  fs.appendFileSync(rolloutPath, `${taskCompleteRow('尾部中文答案')}\n`, 'utf8');
  await tailer.poll();
  assert(
    !posted.some((event) => event.type === 'session.transcript'),
    'task_complete may publish completion metadata but never a second transcript message'
  );
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-cursor-'));
  try {
    const rolloutPath = path.join(root, 'rollout-2026-07-16T10-00-00-thread-1.jsonl');
    const otherPath = path.join(root, 'rollout-2026-07-16T10-00-00-thread-2.jsonl');
    fs.writeFileSync(
      rolloutPath,
      `${assistantRow(1, 'one')}\r\n${assistantRow(2, '二号回答')}\n`,
      'utf8'
    );
    fs.writeFileSync(otherPath, `${assistantRow(8, 'other file')}\n`, 'utf8');

    const instrumented = makeInstrumentedFs();
    const index = new CodexAssistantCursorIndex({
      fsImpl: instrumented.impl,
      maxBytesPerScan: 73,
      now: () => '2026-07-16T10:01:00.000Z',
    });
    const session = { sessionId: 'thread-1', nativeThreadId: 'thread-1', rolloutPath };
    const otherSession = { sessionId: 'thread-2', nativeThreadId: 'thread-2', rolloutPath: otherPath };

    const first = index.scan(session);
    assert(first.cursorUnknown, 'an initial byte-bounded rebuild must stay unknown until it reaches a row boundary at EOF');
    assert(first.bytesRead <= 73);
    const complete = finishBackfill(index, session, first);
    assert.deepStrictEqual(complete.allObservedIds.length, 2);
    assert.deepStrictEqual(complete.observations.map((item) => item.previewText), ['one', '二号回答']);
    assert(complete.observations.every((item) => item.sourceIdentity.sourceOffset >= 0));
    assert.strictEqual(new Set(complete.observations.map((item) => item.assistantMessageId)).size, 2);
    const retryBeforeAck = index.scan(session);
    assert.strictEqual(retryBeforeAck.bytesRead, 0);
    assert.deepStrictEqual(
      retryBeforeAck.observations.map((item) => item.assistantMessageId),
      complete.observations.map((item) => item.assistantMessageId),
      'a failed discovery post must be able to resend the exact unacknowledged observations'
    );
    index.acknowledge(complete);

    const readsBeforeUnchanged = instrumented.calls.read;
    const opensBeforeUnchanged = instrumented.calls.open;
    const unchanged = index.scan(session);
    assert.strictEqual(unchanged.bytesRead, 0);
    assert.strictEqual(unchanged.cursorUnknown, false);
    assert.deepStrictEqual(unchanged.observations, []);
    assert.strictEqual(instrumented.calls.read, readsBeforeUnchanged, 'an unchanged cursor must be stat-only');
    assert.strictEqual(instrumented.calls.open, opensBeforeUnchanged, 'an unchanged cursor must not open the rollout');

    const row3 = assistantRow(3, 'three 中文');
    const row3Bytes = Buffer.from(row3, 'utf8');
    const splitAt = row3Bytes.length - 2;
    fs.appendFileSync(rolloutPath, row3Bytes.subarray(0, splitAt));
    let partial = index.scan(session);
    while (partial.cursorOffset < fs.statSync(rolloutPath).size) {
      partial = index.scan(session);
    }
    assert.strictEqual(partial.observations.length, 0, 'a partial JSON row must not become an observation');
    assert.strictEqual(partial.cursorUnknown, true, 'an unterminated row keeps the cursor incomplete');
    fs.appendFileSync(rolloutPath, Buffer.concat([row3Bytes.subarray(splitAt), Buffer.from('\n')]));
    const appended = finishBackfill(index, session);
    assert.strictEqual(appended.observations.length, 1);
    assert.strictEqual(appended.observations[0].previewText, 'three 中文');
    index.acknowledge(appended);

    fs.appendFileSync(rolloutPath, `${taskCompleteRow('three 中文')}\n`, 'utf8');
    const taskComplete = finishBackfill(index, session);
    assert.deepStrictEqual(taskComplete.observations, [], 'task_complete must not create a cursor message');

    const otherComplete = finishBackfill(index, otherSession);
    assert.strictEqual(otherComplete.allObservedIds.length, 1);
    index.acknowledge(otherComplete);
    const otherRevision = otherComplete.projectionRevision;

    fs.writeFileSync(rolloutPath, `${assistantRow(4, 'replacement')}\n`, 'utf8');
    const replacement = index.scan(session);
    assert(replacement.replaced || replacement.truncated, 'truncation or replacement must reset only the changed rollout');
    assert(replacement.bytesRead <= 73);
    const rebuilt = finishBackfill(index, session, replacement);
    assert(rebuilt.allObservedIds.some((id) => id === rebuilt.observations[0]?.assistantMessageId));
    const untouchedOther = index.scan(otherSession);
    assert.strictEqual(untouchedOther.bytesRead, 0);
    assert.strictEqual(untouchedOther.projectionRevision, otherRevision, 'resetting one rollout must not reset another cursor');

    const missing = index.scan({ nativeThreadId: 'missing', rolloutPath: path.join(root, 'missing.jsonl') });
    assert.strictEqual(missing.cursorUnknown, true, 'an unavailable rollout is unknown, never an authoritative empty projection');
    assert.deepStrictEqual(missing.observations, []);

    const corruptPath = path.join(root, 'rollout-corrupt.jsonl');
    fs.writeFileSync(corruptPath, '{not-json}\n', 'utf8');
    const corrupt = index.scan({ nativeThreadId: 'corrupt', rolloutPath: corruptPath });
    assert.strictEqual(corrupt.cursorUnknown, true, 'an unparsable retained row cannot clear a newer Relay projection');

    const many = index.scanMany([session, otherSession, { sessionId: 'no-path' }]);
    assert.strictEqual(many.length, 2);
    assert(many.every((item) => item.bytesRead <= 73));
    assert(index.getMetrics().bytesRead > 0);

    const budgetPaths = [0, 1, 2].map((number) => {
      const filePath = path.join(root, `rollout-budget-${number}.jsonl`);
      fs.writeFileSync(filePath, `${assistantRow(number + 10, 'x'.repeat(180))}\n`, 'utf8');
      return {
        nativeThreadId: `budget-${number}`,
        rolloutPath: filePath,
      };
    });
    const globallyBounded = new CodexAssistantCursorIndex({
      maxBytesPerScan: 73,
      maxBytesPerScanMany: 100,
    });
    const budgetBatch = globallyBounded.scanMany(budgetPaths);
    assert(
      budgetBatch.reduce((sum, item) => sum + item.bytesRead, 0) <= 100,
      'one discovery pass must have a global byte budget across all rollout files'
    );
    assert(budgetBatch.some((item) => item.cursorUnknown));

    const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'codex-assistant-cursor.js'), 'utf8');
    assert(!source.includes('readFileSync('), 'the cursor must never load a complete rollout file');
    const agentSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'host-agent', 'agent.js'), 'utf8');
    assert(agentSource.includes('assistantCursor: {'));
    assert(agentSource.includes('assistantCursorIndex.acknowledgeMany(cursorResults)'));
    assert(agentSource.includes('assistantCursorIndex,'), 'tail and discovery must share the same cursor index');

    await verifyTailProjection(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('codex assistant cursor assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
