const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'notification-relay-host';

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
      hostname: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode || 0,
          body: raw ? JSON.parse(raw) : null,
        });
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRelay(port, child) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Relay exited with code ${child.exitCode}`);
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Relay did not become ready');
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function observation(assistantMessageId, assistantAt, previewText) {
  return {
    assistantMessageId,
    assistantAt,
    firstObservedAt: '2099-01-01T00:00:01.000Z',
    finalized: true,
    notifiableCandidate: true,
    previewText,
    sourceIdentity: {
      nativeThreadId: 'native-1',
      streamId: 'rollout:native-1:test.jsonl',
      protocolTurnId: 'turn-1',
      protocolItemId: assistantMessageId,
      contentPartId: 'message',
      sourceOffset: 1,
      sourceOrdinal: 1,
      role: 'assistant',
      sourceTimestamp: assistantAt,
      finalContentDigest: null,
    },
  };
}

async function postEvents(port, events, batchId = '') {
  const response = await requestJson(port, 'POST', '/api/agent/events', {
    ...(batchId ? { batchId } : {}),
    events,
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return response.body;
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-notification-relay-'));
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitForRelay(port, relay);
    const old = {
      ...observation('assistant-old', '2020-01-01T00:00:00.000Z', 'old history'),
      firstObservedAt: '2099-01-01T00:00:00.000Z',
    };
    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: 'native-1',
        nativeThreadId: 'native-1',
        conversationKey: 'native-1',
        title: 'Primary',
        assistantCursor: {
          observations: [old],
          fileIdentity: 'file-native-1',
          projectionRevision: 1,
          cursorOffset: 20,
          cursorUnknown: false,
        },
      }, {
        sessionId: 'native-2',
        nativeThreadId: 'native-2',
        conversationKey: 'native-2',
        title: 'Second',
      }],
    }], 'baseline-discovery');

    const first = observation(
      'assistant-live-1',
      '2099-01-01T00:00:00.000Z',
      'first live answer'
    );
    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-1',
      nativeThreadId: 'native-1',
      speaker: 'assistant',
      text: first.previewText,
      timestamp: first.assistantAt,
      assistantObservation: first,
    }], 'first-live');

    let catchup = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/assistant-messages?hostId=${HOST_ID}&afterSeq=0&limit=10`
    );
    assert.strictEqual(catchup.statusCode, 200);
    assert.strictEqual(catchup.body.messages.length, 1);
    assert.strictEqual(catchup.body.messages[0].assistantMessageId, first.assistantMessageId);
    assert.strictEqual(catchup.body.messages[0].assistantSeq, 2);
    assert.strictEqual(catchup.body.latestAssistantSeq, 2);
    assert.strictEqual(catchup.body.messages[0].sourceIdentity, undefined);

    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-1',
      nativeThreadId: 'native-1',
      speaker: 'assistant',
      text: 'same identity, later representation',
      timestamp: '2099-01-01T00:00:02.000Z',
      assistantObservation: {
        ...first,
        previewText: 'same identity, later representation',
      },
    }], 'duplicate-live');
    catchup = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/assistant-messages?hostId=${HOST_ID}&afterSeq=0&limit=10`
    );
    assert.strictEqual(catchup.body.latestAssistantSeq, 2);
    assert.strictEqual(catchup.body.messages.length, 1);

    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: 'native-1',
        bridgeSessionId: 'bridge-1',
        nativeThreadId: 'native-1',
        conversationKey: 'native-1',
        latestAgentMessage: null,
        transcriptPreview: [],
        assistantCursor: {
          observations: [],
          fileIdentity: 'file-native-1',
          projectionRevision: 2,
          cursorOffset: 21,
          cursorUnknown: true,
        },
      }],
    }], 'unknown-cursor');
    let aliasProjection = await requestJson(
      port,
      'GET',
      `/api/sessions/bridge-1/assistant-messages?hostId=${HOST_ID}&afterSeq=0&limit=10`
    );
    assert.strictEqual(aliasProjection.body.canonicalConversationKey, `${HOST_ID}::native-1`);
    assert(aliasProjection.body.aliases.includes(`${HOST_ID}::bridge-1`));
    assert.strictEqual(aliasProjection.body.latestAssistantSeq, 2);
    assert.strictEqual(aliasProjection.body.cursorUnknown, true);

    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: 'native-1',
        bridgeSessionId: 'bridge-1',
        nativeThreadId: 'native-1',
        conversationKey: 'native-1',
        assistantCursor: {
          observations: [],
          fileIdentity: 'file-native-1',
          projectionRevision: 1,
          cursorOffset: 22,
          cursorUnknown: false,
        },
      }],
    }], 'stale-complete-cursor');
    aliasProjection = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/assistant-messages?hostId=${HOST_ID}`
    );
    assert.strictEqual(aliasProjection.body.cursorUnknown, true, 'older completion must not clear unknown');

    await postEvents(port, [{
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: 'native-1',
        bridgeSessionId: 'bridge-1',
        nativeThreadId: 'native-1',
        conversationKey: 'native-1',
        assistantCursor: {
          observations: [],
          fileIdentity: 'file-native-1',
          projectionRevision: 3,
          cursorOffset: 23,
          cursorUnknown: false,
        },
      }],
    }], 'complete-cursor');
    aliasProjection = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/assistant-messages?hostId=${HOST_ID}`
    );
    assert.strictEqual(aliasProjection.body.cursorUnknown, false);

    const second = {
      ...observation('assistant-live-2', '2099-01-01T00:01:00.000Z', 'second Session'),
      sourceIdentity: {
        ...observation('assistant-live-2', '2099-01-01T00:01:00.000Z', '').sourceIdentity,
        nativeThreadId: 'native-2',
        streamId: 'rollout:native-2:test.jsonl',
      },
    };
    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-2',
      nativeThreadId: 'native-2',
      speaker: 'assistant',
      text: second.previewText,
      timestamp: second.assistantAt,
      assistantObservation: second,
    }], 'second-live');
    const secondProjection = await requestJson(
      port,
      'GET',
      `/api/sessions/native-2/assistant-messages?hostId=${HOST_ID}`
    );
    assert.strictEqual(secondProjection.body.latestAssistantSeq, 3);

    const sessions = await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/sessions`);
    const primary = sessions.body.sessions.find((session) => session.sessionId === 'native-1');
    assert.strictEqual(primary.latestAgentMessage, 'same identity, later representation');
    assert.strictEqual(primary.assistantProjection.latestAssistantSeq, 2);
    assert.strictEqual(primary.assistantProjection.cursorUnknown, false);

    const detail = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(detail.body.session.assistantProjection.latestAssistantSeq, 2);
    assert(detail.body.transcript.some((entry) => (
      entry.assistantMessageId === first.assistantMessageId
      && entry.assistantSeq === 2
    )));
    const compatibleProjection = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/assistant-projection?hostId=${HOST_ID}&afterSeq=0&limit=10`
    );
    assert.deepStrictEqual(compatibleProjection.body.messages, aliasProjection.body.messages);

    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-1',
      nativeThreadId: 'native-1',
      source: 'codex-jsonl',
      speaker: 'assistant',
      text: 'same identity, rollout-authoritative representation',
      timestamp: '2099-01-01T00:00:02.100Z',
      assistantObservation: {
        ...first,
        previewText: 'same identity, rollout-authoritative representation',
      },
    }], 'same-id-rollout-update');
    let updatedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/detail?hostId=${HOST_ID}`
    );
    const firstIdentityEntries = updatedDetail.body.transcript.filter((entry) => (
      entry.assistantMessageId === first.assistantMessageId
    ));
    assert.strictEqual(firstIdentityEntries.length, 1, 'one assistant ID must remain one transcript entry');
    assert.strictEqual(firstIdentityEntries[0].text, 'same identity, rollout-authoritative representation');
    assert.strictEqual(firstIdentityEntries[0].source, 'codex-jsonl');

    const transitionalText = 'an older history projection and its identified live message are one reply';
    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-1',
      nativeThreadId: 'native-1',
      source: 'codex-jsonl',
      speaker: 'assistant',
      text: transitionalText,
      timestamp: '2099-01-01T00:01:00.000Z',
    }], 'legacy-unidentified-history');
    const identifiedTransition = observation(
      'assistant-transition-identified',
      '2099-01-01T00:01:00.100Z',
      transitionalText
    );
    await postEvents(port, [{
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-1',
      nativeThreadId: 'native-1',
      source: 'codex-app-server',
      speaker: 'assistant',
      text: transitionalText,
      timestamp: identifiedTransition.assistantAt,
      assistantObservation: identifiedTransition,
    }], 'identified-history-transition');
    updatedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/detail?hostId=${HOST_ID}`
    );
    const transitionalEntries = updatedDetail.body.transcript.filter((entry) => entry.text === transitionalText);
    assert.strictEqual(
      transitionalEntries.length,
      1,
      'a nearby unidentified JSONL copy must be absorbed by its identified assistant message'
    );
    assert.strictEqual(transitionalEntries[0].assistantMessageId, identifiedTransition.assistantMessageId);

    const fallbackMirrorText = 'one fallback JSONL answer mirrored thirteen milliseconds later';
    const fallbackMirrorDigest = 'a'.repeat(64);
    const fallbackMirrorA = {
      ...observation('assistant-fallback-mirror-a', '2099-01-01T00:01:30.000Z', fallbackMirrorText),
      sourceIdentity: {
        nativeThreadId: 'native-1',
        streamId: 'rollout:native-1:test.jsonl',
        protocolTurnId: '',
        protocolItemId: '',
        contentPartId: '',
        sourceOffset: 100,
        sourceOrdinal: null,
        role: 'assistant',
        sourceTimestamp: '2099-01-01T00:01:30.000Z',
        finalContentDigest: fallbackMirrorDigest,
      },
    };
    const fallbackMirrorB = {
      ...observation('assistant-fallback-mirror-b', '2099-01-01T00:01:30.013Z', fallbackMirrorText),
      sourceIdentity: {
        ...fallbackMirrorA.sourceIdentity,
        sourceOffset: 200,
        sourceOrdinal: 2,
        sourceTimestamp: '2099-01-01T00:01:30.013Z',
      },
    };
    await postEvents(port, [fallbackMirrorA, fallbackMirrorB].map((item) => ({
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-1',
      nativeThreadId: 'native-1',
      source: 'codex-jsonl',
      speaker: 'assistant',
      text: fallbackMirrorText,
      timestamp: item.assistantAt,
      assistantObservation: item,
    })), 'fallback-jsonl-mirror');
    updatedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      updatedDetail.body.transcript.filter((entry) => entry.text === fallbackMirrorText).length,
      1,
      'nearby fallback JSONL mirrors with the same finalized content must render once'
    );

    const repeatedText = 'two legitimate messages may have exactly the same text';
    const repeatedA = observation('assistant-repeat-a', '2099-01-01T00:02:00.000Z', repeatedText);
    const repeatedB = observation('assistant-repeat-b', '2099-01-01T00:02:01.000Z', repeatedText);
    await postEvents(port, [repeatedA, repeatedB].map((item) => ({
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: 'native-1',
      nativeThreadId: 'native-1',
      source: 'codex-app-server',
      speaker: 'assistant',
      text: repeatedText,
      timestamp: item.assistantAt,
      assistantObservation: item,
    })), 'distinct-ids-same-text');
    updatedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/native-1/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      updatedDetail.body.transcript.filter((entry) => (
        ['assistant-repeat-a', 'assistant-repeat-b'].includes(entry.assistantMessageId)
      )).length,
      2,
      'different assistant IDs must not be collapsed by text equality or containment'
    );

    console.log('session notification Relay assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(relay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
