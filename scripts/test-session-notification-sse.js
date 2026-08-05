const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'notification-sse-host';
const SESSION_ID = 'native-sse-1';

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestJson(port, method, requestPath, body = null) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, method, path: requestPath,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode || 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRelay(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Relay exited with code ${child.exitCode}`);
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Relay did not become ready');
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function parseFrame(raw) {
  const frame = { id: '', event: 'message', data: null };
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('id:')) frame.id = line.slice(3).trim();
    if (line.startsWith('event:')) frame.event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length) frame.data = JSON.parse(data.join('\n'));
  return frame;
}

function openSse(port, requestPath, headers = {}) {
  const frames = [];
  let response = null;
  let buffer = '';
  const request = http.request({
    hostname: '127.0.0.1',
    port,
    method: 'GET',
    path: requestPath,
    headers: { Accept: 'text/event-stream', ...headers },
  });
  request.on('response', (incoming) => {
    response = incoming;
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => {
      buffer += chunk;
      while (/\r?\n\r?\n/.test(buffer)) {
        const match = buffer.match(/\r?\n\r?\n/);
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (raw.trim()) frames.push(parseFrame(raw));
      }
    });
  });
  request.end();
  return {
    frames,
    close() {
      response?.destroy();
      request.destroy();
    },
  };
}

async function waitForFrame(stream, predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const frame = stream.frames.find(predicate);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${message}; frames=${JSON.stringify(stream.frames)}`);
}

async function postEvents(port, events) {
  const response = await requestJson(port, 'POST', '/api/agent/events', { events });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

function assistantObservation() {
  return {
    assistantMessageId: 'assistant:sse:one',
    assistantAt: '2099-02-01T00:00:00.000Z',
    firstObservedAt: '2099-02-01T00:00:01.000Z',
    finalized: true,
    notifiableCandidate: true,
    previewText: 'SSE answer',
    sourceIdentity: {
      nativeThreadId: SESSION_ID,
      streamId: `rollout:${SESSION_ID}:sse.jsonl`,
      protocolTurnId: 'turn-sse',
      protocolItemId: 'item-sse',
      contentPartId: 'message',
      sourceOffset: 1,
      sourceOrdinal: 1,
      role: 'assistant',
      sourceTimestamp: '2099-02-01T00:00:00.000Z',
      finalContentDigest: null,
    },
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-notification-sse-'));
  const port = await openPort();
  assert.notStrictEqual(port, 8797);
  const output = [];
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      SESSION_EVENT_RING_SIZE: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  let initial = null;
  let replay = null;
  let aliasReplay = null;
  let expired = null;
  let released = null;
  let restarted = null;
  let invalid = null;
  try {
    await waitForRelay(port, relay);
    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        conversationKey: SESSION_ID,
        title: 'SSE Session',
      }],
    }, {
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: 'sse-runtime-run',
      timestamp: '2099-02-01T00:00:00.000Z',
      patch: {
        runId: 'sse-runtime-run',
        runtimeRevision: 7,
        phase: 'idle',
        busy: false,
        activeTurnId: null,
        currentTurnStatus: 'completed',
      },
    }]);

    initial = openSse(port, `/api/sessions/${SESSION_ID}/events?hostId=${HOST_ID}`);
    const reset = await waitForFrame(initial, (frame) => frame.event === 'stream.reset', 'missing reset');
    const ready = await waitForFrame(initial, (frame) => frame.event === 'ready', 'missing ready');
    assert(initial.frames.indexOf(reset) < initial.frames.indexOf(ready));
    assert.match(reset.id, /^[^:]+:\d+$/);
    assert.strictEqual(reset.data.reason, 'cursor_missing');
    assert.strictEqual(reset.data.canonicalConversationKey, `${HOST_ID}::${SESSION_ID}`);
    assert.strictEqual(reset.data.assistantProjection.latestAssistantSeq, 0);
    assert.strictEqual(reset.data.session.runtime.phase, 'idle');
    assert.strictEqual(reset.data.session.runtime.runtimeRevision, 7);
    assert.strictEqual(reset.data.session.runtime.activeTurnId, null);
    assert.strictEqual(ready.data.canonicalConversationKey, `${HOST_ID}::${SESSION_ID}`);

    await postEvents(port, [{
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: 'sse-runtime-run',
      timestamp: '2099-02-01T00:00:02.000Z',
      patch: {
        runId: 'sse-runtime-run',
        runtimeRevision: 8,
        phase: 'thinking',
        busy: true,
        activeTurnId: 'turn-sse',
      },
    }]);
    const liveRuntime = await waitForFrame(
      initial,
      (frame) => frame.event === 'session.runtime_updated' && frame.data.patch?.runtimeRevision === 8,
      'missing canonical live runtime update'
    );
    assert.strictEqual(liveRuntime.data.patch.phase, 'thinking');
    assert.strictEqual(initial.frames.some((frame) => frame.event === 'session.runtime'), false);

    await postEvents(port, [{
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: 'sse-runtime-run',
      timestamp: '2099-02-01T00:00:03.000Z',
      patch: {
        runId: 'sse-runtime-run',
        runtimeRevision: 9,
        phase: 'idle',
        busy: false,
        activeTurnId: null,
        currentTurnStatus: 'completed',
      },
    }]);
    await waitForFrame(
      initial,
      (frame) => frame.event === 'session.runtime_updated' && frame.data.patch?.runtimeRevision === 9,
      'missing canonical terminal runtime update'
    );

    const observation = assistantObservation();
    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      nativeThreadId: SESSION_ID,
      speaker: 'assistant',
      text: observation.previewText,
      timestamp: observation.assistantAt,
      assistantObservation: observation,
    }]);
    const projection = await waitForFrame(
      initial,
      (frame) => frame.event === 'session.assistant_projection',
      'missing assistant projection'
    );
    const transcript = await waitForFrame(
      initial,
      (frame) => frame.event === 'session.transcript' && frame.data.assistantMessageId,
      'missing assistant transcript'
    );
    await waitForFrame(initial, (frame) => frame.event === 'session.snapshot' && frame.id !== reset.id, 'missing snapshot');
    assert.strictEqual(projection.data.latestAssistantSeq, 1);
    assert.strictEqual(projection.data.messages[0].assistantMessageId, observation.assistantMessageId);
    assert.strictEqual(transcript.data.assistantSeq, 1);
    assert(initial.frames
      .filter((frame) => frame.event.startsWith('session.'))
      .every((frame) => /^[^:]+:\d+$/.test(frame.id)));
    const replayCursor = transcript.id;

    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      speaker: 'user',
      text: 'follow-up',
      timestamp: '2099-02-01T00:01:00.000Z',
    }]);
    replay = openSse(
      port,
      `/api/sessions/${SESSION_ID}/events?hostId=${HOST_ID}`,
      { 'Last-Event-ID': replayCursor }
    );
    await waitForFrame(replay, (frame) => frame.event === 'ready', 'missing replay ready');
    assert.strictEqual(replay.frames.some((frame) => frame.event === 'stream.reset'), false);
    assert(replay.frames.some((frame) => frame.event === 'session.transcript' && frame.data.text === 'follow-up'));
    const replayReady = replay.frames.find((frame) => frame.event === 'ready');
    replay.close();

    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: SESSION_ID,
        bridgeSessionId: 'bridge-sse-1',
        nativeThreadId: SESSION_ID,
        conversationKey: SESSION_ID,
      }],
    }]);
    const canonicalMergeReset = await waitForFrame(
      initial,
      (frame) => frame.event === 'stream.reset' && frame.data.reason === 'canonical_key_changed',
      'canonical merge did not reset the existing winner subscriber'
    );
    assert.strictEqual(canonicalMergeReset.data.canonicalConversationKey, `${HOST_ID}::${SESSION_ID}`);
    aliasReplay = openSse(
      port,
      `/api/sessions/bridge-sse-1/events?hostId=${HOST_ID}&lastEventId=${encodeURIComponent(replayReady.data.cursor)}`
    );
    const aliasReset = await waitForFrame(
      aliasReplay,
      (frame) => frame.event === 'stream.reset',
      'alias URL did not reset the superseded cursor generation'
    );
    const aliasReady = await waitForFrame(aliasReplay, (frame) => frame.event === 'ready', 'missing alias ready');
    assert.strictEqual(aliasReset.data.reason, 'epoch_mismatch');
    assert.strictEqual(aliasReset.data.session.sessionId, SESSION_ID);
    assert.strictEqual(aliasReady.data.canonicalConversationKey, `${HOST_ID}::${SESSION_ID}`);
    aliasReplay.close();

    for (let index = 0; index < 6; index += 1) {
      await postEvents(port, [{
        type: 'session.diagnostic',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        timestamp: `2099-02-01T00:02:0${index}.000Z`,
        kind: 'test',
        message: `diagnostic ${index}`,
      }]);
    }
    expired = openSse(
      port,
      `/api/sessions/${SESSION_ID}/events?hostId=${HOST_ID}&lastEventId=${encodeURIComponent(aliasReady.data.cursor)}`
    );
    const expiredReset = await waitForFrame(expired, (frame) => frame.event === 'stream.reset', 'missing expired reset');
    assert.strictEqual(expiredReset.data.reason, 'cursor_expired');
    assert.strictEqual(expiredReset.data.assistantProjection.latestAssistantSeq, 1);
    expired.close();

    const releasedCursor = initial.frames.filter((frame) => frame.id).at(-1).id;
    initial.close();
    initial = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      speaker: 'user',
      text: 'offline gap',
      timestamp: '2099-02-01T00:03:00.000Z',
    }]);
    released = openSse(
      port,
      `/api/sessions/${SESSION_ID}/events?hostId=${HOST_ID}&lastEventId=${encodeURIComponent(releasedCursor)}`
    );
    const releasedReset = await waitForFrame(
      released,
      (frame) => frame.event === 'stream.reset',
      'offline production event did not invalidate the released stream cursor'
    );
    assert.strictEqual(releasedReset.data.reason, 'epoch_mismatch');
    assert.strictEqual(releasedReset.data.session.latestUserMessage, 'offline gap');
    released.close();

    restarted = openSse(
      port,
      `/api/sessions/${SESSION_ID}/events?hostId=${HOST_ID}`,
      { 'Last-Event-ID': 'old-process-epoch:1' }
    );
    const restartedReset = await waitForFrame(restarted, (frame) => frame.event === 'stream.reset', 'missing epoch reset');
    assert.strictEqual(restartedReset.data.reason, 'epoch_mismatch');
    restarted.close();

    invalid = openSse(
      port,
      `/api/sessions/${SESSION_ID}/events?hostId=${HOST_ID}&lastEventId=malformed`
    );
    const invalidReset = await waitForFrame(invalid, (frame) => frame.event === 'stream.reset', 'missing invalid reset');
    assert.strictEqual(invalidReset.data.reason, 'cursor_invalid');
    invalid.close();

    console.log('session notification SSE assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    initial?.close();
    replay?.close();
    aliasReplay?.close();
    expired?.close();
    released?.close();
    restarted?.close();
    invalid?.close();
    await stopChild(relay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
