const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'thinking-relay-host';
const NATIVE_ID = 'native-thinking';
const BRIDGE_ID = 'bridge-thinking';

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
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('request timed out')));
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

function openSse(port, requestPath) {
  const frames = [];
  let response = null;
  let buffer = '';
  const request = http.request({
    hostname: '127.0.0.1', port, path: requestPath, method: 'GET',
    headers: { Accept: 'text/event-stream' },
  });
  request.on('response', (incoming) => {
    response = incoming;
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk) => {
      buffer += chunk;
      while (/\r?\n\r?\n/.test(buffer)) {
        const separator = buffer.match(/\r?\n\r?\n/);
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const frame = { id: '', event: 'message', data: null, raw };
        const data = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('id:')) frame.id = line.slice(3).trim();
          if (line.startsWith('event:')) frame.event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length) frame.data = JSON.parse(data.join('\n'));
        if (raw.trim()) frames.push(frame);
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

function activity(sessionId, revision, text) {
  return {
    type: 'session.activity_snapshot',
    hostId: HOST_ID,
    sessionId,
    conversationKey: sessionId,
    canonicalConversationKey: 'untrusted::canonical',
    activityKey: 'untrusted-activity-key',
    runId: 'run-thinking',
    turnId: 'turn-thinking',
    itemId: 'item-thinking',
    summaryIndex: 0,
    kind: 'reasoning',
    text,
    activityRevision: revision,
    final: false,
    startedAt: '2099-03-01T00:00:00.500Z',
    timestamp: `2099-03-01T00:00:0${Math.min(revision, 9)}.000Z`,
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-thinking-relay-'));
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
      SESSION_RESET_SSE_MAX_BYTES: '2048',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  let stream = null;
  let resetStream = null;
  let largeResetStream = null;

  try {
    await waitForRelay(port, relay);
    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: NATIVE_ID,
        nativeThreadId: NATIVE_ID,
        conversationKey: NATIVE_ID,
      }, {
        sessionId: BRIDGE_ID,
        nativeThreadId: BRIDGE_ID,
        conversationKey: BRIDGE_ID,
      }],
    }]);

    stream = openSse(port, `/api/sessions/${BRIDGE_ID}/events?hostId=${HOST_ID}`);
    const initialReset = await waitForFrame(stream, (frame) => frame.event === 'stream.reset', 'missing initial reset');
    assert.deepStrictEqual(initialReset.data.activities, []);

    const firstText = 'First line\n\n  preserved indent  ';
    await postEvents(port, [{
      ...activity(BRIDGE_ID, 1, firstText),
      callId: 'call-thinking',
      requestId: 'request-thinking',
      itemType: 'commandExecution',
      status: 'running',
      command: 'node <literal>.js',
      cwd: 'D:/workspace',
      output: '<literal output>',
      durationMs: 12,
      processId: 'process-thinking',
      arguments: { target: '<literal>' },
      result: { ok: true },
      commandActions: [{ type: 'read', path: 'package.json' }],
      fileChanges: [{ path: 'src/app.js', status: 'modified', diff: '-old\n+new' }],
    }]);
    const first = await waitForFrame(
      stream,
      (frame) => frame.event === 'session.activity' && frame.data.activityRevision === 1,
      'missing first activity'
    );
    assert.strictEqual(first.data.text, firstText);
    assert.strictEqual(first.data.startedAt, '2099-03-01T00:00:00.500Z');
    assert.strictEqual(first.data.timestamp, '2099-03-01T00:00:01.000Z');
    assert.strictEqual(first.data.canonicalConversationKey, `${HOST_ID}::${BRIDGE_ID}`);
    assert.strictEqual(
      first.data.activityKey,
      JSON.stringify([`${HOST_ID}::${BRIDGE_ID}`, 'run-thinking', 'turn-thinking', 'item-thinking', 0])
    );
    assert.strictEqual(first.data.streamEpoch, initialReset.data.streamEpoch);
    assert.deepStrictEqual({
      callId: first.data.callId,
      requestId: first.data.requestId,
      itemType: first.data.itemType,
      status: first.data.status,
      command: first.data.command,
      cwd: first.data.cwd,
      output: first.data.output,
      durationMs: first.data.durationMs,
      processId: first.data.processId,
      arguments: first.data.arguments,
      result: first.data.result,
      commandActions: first.data.commandActions,
      fileChanges: first.data.fileChanges,
    }, {
      callId: 'call-thinking',
      requestId: 'request-thinking',
      itemType: 'commandExecution',
      status: 'running',
      command: 'node <literal>.js',
      cwd: 'D:/workspace',
      output: '<literal output>',
      durationMs: 12,
      processId: 'process-thinking',
      arguments: { target: '<literal>' },
      result: { ok: true },
      commandActions: [{ type: 'read', path: 'package.json' }],
      fileChanges: [{ path: 'src/app.js', status: 'modified', diff: '-old\n+new' }],
    }, 'Relay SSE should preserve bounded structured activity fields');

    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: NATIVE_ID,
        bridgeSessionId: BRIDGE_ID,
        nativeThreadId: NATIVE_ID,
        conversationKey: NATIVE_ID,
      }],
    }]);
    const mergeReset = await waitForFrame(
      stream,
      (frame) => frame.event === 'stream.reset' && frame.data.reason === 'canonical_key_changed',
      'alias merge did not reset the active subscriber'
    );
    assert.strictEqual(mergeReset.data.canonicalConversationKey, `${HOST_ID}::${NATIVE_ID}`);
    assert.deepStrictEqual(mergeReset.data.activities, []);
    assert.strictEqual(mergeReset.data.activitiesTruncated, true);
    assert.strictEqual(mergeReset.data.activityCount, 1);
    const mergedActivityPage = await requestJson(
      port,
      'GET',
      `/api/sessions/${BRIDGE_ID}/activities?hostId=${HOST_ID}`
    );
    assert.strictEqual(mergedActivityPage.statusCode, 200);
    assert.strictEqual(mergedActivityPage.body.activities[0].text, firstText);
    assert.strictEqual(
      mergedActivityPage.body.activities[0].activityKey,
      JSON.stringify([`${HOST_ID}::${NATIVE_ID}`, 'run-thinking', 'turn-thinking', 'item-thinking', 0])
    );

    const secondText = `${firstText}\nsecond revision`;
    await postEvents(port, [{
      ...activity(BRIDGE_ID, 2, secondText),
      conversationKey: NATIVE_ID,
      bridgeSessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
    }]);
    const second = await waitForFrame(
      stream,
      (frame) => frame.event === 'session.activity' && frame.data.activityRevision === 2,
      'old alias did not reach canonical activity stream'
    );
    assert.strictEqual(second.data.canonicalConversationKey, `${HOST_ID}::${NATIVE_ID}`);
    assert.strictEqual(second.data.text, secondText);

    const activityCount = stream.frames.filter((frame) => frame.event === 'session.activity').length;
    await postEvents(port, [{
      ...activity(BRIDGE_ID, 2, 'duplicate must be ignored'),
      conversationKey: NATIVE_ID,
      bridgeSessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
    }, {
      ...activity(BRIDGE_ID, 1, 'older must be ignored'),
      conversationKey: NATIVE_ID,
      bridgeSessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
    }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(
      stream.frames.filter((frame) => frame.event === 'session.activity').length,
      activityCount,
      'duplicate and older revisions must not be published'
    );

    resetStream = openSse(
      port,
      `/api/sessions/${BRIDGE_ID}/events?hostId=${HOST_ID}&lastEventId=old-epoch:4`
    );
    const epochReset = await waitForFrame(
      resetStream,
      (frame) => frame.event === 'stream.reset',
      'missing epoch reset'
    );
    assert.strictEqual(epochReset.data.reason, 'epoch_mismatch');
    assert.strictEqual(epochReset.data.canonicalConversationKey, `${HOST_ID}::${NATIVE_ID}`);
    assert.deepStrictEqual(epochReset.data.activities, []);
    assert.strictEqual(epochReset.data.activitiesTruncated, true);
    assert.strictEqual(epochReset.data.activityCount, 1);

    stream.close();
    stream = null;
    resetStream.close();
    resetStream = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const largeText = 'large activity '.repeat(2000);
    await postEvents(port, [{
      ...activity(BRIDGE_ID, 3, largeText),
      conversationKey: NATIVE_ID,
      bridgeSessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
    }]);
    largeResetStream = openSse(
      port,
      `/api/sessions/${BRIDGE_ID}/events?hostId=${HOST_ID}&lastEventId=old-epoch:9`
    );
    const largeReset = await waitForFrame(
      largeResetStream,
      (frame) => frame.event === 'stream.reset',
      'large activity reset was not delivered'
    );
    assert.strictEqual(largeReset.data.activitiesTruncated, true);
    assert.deepStrictEqual(largeReset.data.activities, []);
    assert(
      Buffer.byteLength(`${largeReset.raw}\n\n`, 'utf8') <= 2048,
      'stream.reset frame must remain below the configured SSE byte budget'
    );

    const liveLargeText = '持续推理内容'.repeat(4000);
    await postEvents(port, [{
      ...activity(BRIDGE_ID, 4, liveLargeText),
      conversationKey: NATIVE_ID,
      bridgeSessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
    }]);
    const compactActivity = await waitForFrame(
      largeResetStream,
      (frame) => frame.event === 'session.activity' && frame.data.activityRevision === 4,
      'large live activity invalidation was not delivered'
    );
    assert.strictEqual(compactActivity.data.activityTruncated, true);
    assert.strictEqual(compactActivity.data.text, '');
    assert.match(compactActivity.data.activityRecoveryToken, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(compactActivity.data.activityByteLength, Buffer.byteLength(liveLargeText, 'utf8'));
    assert(
      Buffer.byteLength(`${compactActivity.raw}\n\n`, 'utf8') <= 2048,
      'large live activity frame must remain below the configured SSE byte budget'
    );

    const targetedActivitySnapshot = await requestJson(
      port,
      'GET',
      `/api/sessions/${BRIDGE_ID}/activities?hostId=${HOST_ID}&activityToken=${encodeURIComponent(compactActivity.data.activityRecoveryToken)}`
    );
    assert.strictEqual(targetedActivitySnapshot.statusCode, 200);
    assert.strictEqual(targetedActivitySnapshot.body.targeted, true);
    assert.strictEqual(targetedActivitySnapshot.body.activities.length, 1);
    assert.strictEqual(targetedActivitySnapshot.body.activities[0].activityRevision, 4);
    assert.strictEqual(targetedActivitySnapshot.body.activities[0].text, liveLargeText);

    const nearBudgetText = 'm'.repeat(1400);
    await postEvents(port, [{
      ...activity(BRIDGE_ID, 5, nearBudgetText),
      conversationKey: NATIVE_ID,
      bridgeSessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
    }]);
    const nearBudgetActivity = await waitForFrame(
      largeResetStream,
      (frame) => frame.event === 'session.activity' && frame.data.activityRevision === 5,
      'near-budget live activity was not delivered'
    );
    assert.strictEqual(
      nearBudgetActivity.data.activityTruncated,
      true,
      'payloads that leave no room for SSE framing should use compact recovery'
    );
    assert(Buffer.byteLength(`${nearBudgetActivity.raw}\n\n`, 'utf8') <= 2048);

    const diagnosticMessage = 'stream remains connected after compact activity';
    await postEvents(port, [{
      type: 'session.diagnostic',
      hostId: HOST_ID,
      sessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
      severity: 'info',
      source: 'thinking-activity-test',
      kind: 'continuity',
      message: diagnosticMessage,
      timestamp: '2099-03-01T00:00:05.000Z',
    }]);
    await waitForFrame(
      largeResetStream,
      (frame) => frame.event === 'session.diagnostic' && frame.data.message === diagnosticMessage,
      'SSE stream disconnected after the compact live activity'
    );

    const duplicateDiagnosticMessage = 'same text from distinct tools';
    await postEvents(port, [{
      type: 'session.diagnostic',
      hostId: HOST_ID,
      sessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
      runId: 'run-thinking',
      turnId: 'turn-thinking',
      itemId: 'tool-a',
      severity: 'info',
      source: 'thinking-activity-test',
      kind: 'tool-call',
      method: 'item/completed',
      message: duplicateDiagnosticMessage,
      timestamp: '2099-03-01T00:00:06.000Z',
    }, {
      type: 'session.diagnostic',
      hostId: HOST_ID,
      sessionId: BRIDGE_ID,
      nativeThreadId: NATIVE_ID,
      runId: 'run-thinking',
      turnId: 'turn-thinking',
      itemId: 'tool-b',
      severity: 'info',
      source: 'thinking-activity-test',
      kind: 'tool-call',
      method: 'item/completed',
      message: duplicateDiagnosticMessage,
      timestamp: '2099-03-01T00:00:06.000Z',
    }]);
    await waitForFrame(
      largeResetStream,
      (frame) => frame.event === 'session.diagnostic' && frame.data.itemId === 'tool-b',
      'distinct diagnostic identity was incorrectly compacted'
    );
    assert.strictEqual(
      largeResetStream.frames.filter((frame) => (
        frame.event === 'session.diagnostic'
        && frame.data.message === duplicateDiagnosticMessage
      )).length,
      2,
      'same-message tool diagnostics with different item IDs must both be delivered'
    );

    const activitySnapshot = await requestJson(
      port,
      'GET',
      `/api/sessions/${BRIDGE_ID}/activities?hostId=${HOST_ID}`
    );
    assert.strictEqual(activitySnapshot.statusCode, 200);
    assert.strictEqual(activitySnapshot.body.activities.length, 1);
    assert.strictEqual(activitySnapshot.body.activities[0].activityRevision, 5);
    assert.strictEqual(activitySnapshot.body.activities[0].text, nearBudgetText);

    console.log('Relay thinking activity assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    stream?.close();
    resetStream?.close();
    largeResetStream?.close();
    await stopChild(relay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
