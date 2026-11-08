const assert = require('assert');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { makeProfileBinding } = require('../shared/api-binding');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'discovery-cursor-ownership-host';
const MANAGED_SESSION_ID = 'managed-cursor-restart-session';
const ORDINARY_SESSION_ID = 'ordinary-rollout-cursor-session';
const RUN_ID = 'managed-cursor-restart-run';
const PROFILE = makeProfileBinding({
  profileId: 'cursor-restart-profile',
  label: 'Cursor restart profile',
  provider: 'OpenAI',
  baseUrl: 'https://cursor-restart.example/v1',
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: raw ? JSON.parse(raw) : null,
          });
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}\n${raw}`));
        }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error(`${method} ${requestPath} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRelay(port, child) {
  let lastError = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`Relay exited before readiness with code ${child.exitCode}`);
    }
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw lastError || new Error('Relay did not become ready');
}

async function stopRelay(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000),
  ]);
}

function relayEnv(port, root) {
  return {
    ...process.env,
    PORT: String(port),
    RELAY_STATE_ROOT: root,
    RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_TEST_CONTROL_ENABLED: 'true',
    SESSION_RECORD_STORE_ROOT: path.join(root, 'session-record-store'),
    SESSION_COLLECTIONS_PATH: path.join(root, 'session-collections.json'),
    SESSION_METADATA_PATH: path.join(root, 'session-metadata.json'),
    SESSION_LOGS_PATH: path.join(root, 'session-logs.json'),
    SESSION_DIAGNOSTICS_PATH: path.join(root, 'session-diagnostics.json'),
  };
}

function startRelay(port, root, output) {
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnv(port, root),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  return child;
}

async function postEvent(port, event, batchId) {
  const response = await requestJson(port, 'POST', '/api/agent/events', {
    ...(batchId ? { batchId } : {}),
    event,
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return response.body;
}

function assistantObservation(id, nativeThreadId, text, timestamp) {
  return {
    assistantMessageId: id,
    assistantAt: timestamp,
    firstObservedAt: '2099-01-01T00:00:00.000Z',
    finalized: true,
    notifiableCandidate: true,
    previewText: text,
    sourceIdentity: {
      nativeThreadId,
      streamId: `rollout:${nativeThreadId}:cursor.jsonl`,
      protocolTurnId: `turn-${id}`,
      protocolItemId: id,
      contentPartId: 'message',
      sourceOffset: 1,
      sourceOrdinal: 1,
      role: 'assistant',
      sourceTimestamp: timestamp,
      finalContentDigest: null,
    },
  };
}

async function readProjection(port, sessionId) {
  const response = await requestJson(
    port,
    'GET',
    `/api/sessions/${encodeURIComponent(sessionId)}/assistant-messages?hostId=${encodeURIComponent(HOST_ID)}&afterSeq=0&limit=100`
  );
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return response.body;
}

async function registerHost(port) {
  const response = await requestJson(port, 'POST', '/api/agent/register', {
    hostId: HOST_ID,
    label: 'Discovery cursor ownership test host',
    platform: process.platform,
    capabilities: {
      managedSessions: true,
      runApiBinding: true,
      nativeResumeReadiness: true,
    },
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

async function main() {
  const root = require('fs').mkdtempSync(path.join(os.tmpdir(), 'remote-codex-cursor-ownership-'));
  const output = [];
  let relay = null;
  let port = await openPort();
  try {
    relay = startRelay(port, root, output);
    await waitForRelay(port, relay);
    await registerHost(port);

    await postEvent(port, {
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: MANAGED_SESSION_ID,
      nativeThreadId: MANAGED_SESSION_ID,
      runId: RUN_ID,
      title: 'Managed cursor restart session',
      cwd: ROOT,
      source: 'managed',
      launchMode: 'fresh',
      conversationKey: MANAGED_SESSION_ID,
      effectiveBinding: PROFILE,
      runtime: {
        adapterId: 'codex-app-server',
        runId: RUN_ID,
        connection: 'ready',
        phase: 'idle',
        busy: false,
        activeTurnId: null,
        nativeResumeReady: true,
      },
    }, 'cursor-ownership-start');

    await stopRelay(relay);
    relay = null;
    port = await openPort();
    relay = startRelay(port, root, output);
    await waitForRelay(port, relay);
    await registerHost(port);

    const managedCursor = assistantObservation(
      'managed-history-cursor-message',
      MANAGED_SESSION_ID,
      'history cursor must not create an orphan notification',
      '2099-01-01T00:00:02.000Z'
    );
    await postEvent(port, {
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'cursor-ownership-history-only',
      sessions: [{
        sessionId: MANAGED_SESSION_ID,
        nativeThreadId: MANAGED_SESSION_ID,
        conversationKey: MANAGED_SESSION_ID,
        source: 'imported',
        live: false,
        assistantCursor: {
          observations: [managedCursor],
          fileIdentity: 'managed-history-rollout',
          projectionRevision: 1,
          cursorOffset: 128,
          cursorUnknown: false,
        },
      }],
    }, 'cursor-ownership-history-only');
    const suppressed = await readProjection(port, MANAGED_SESSION_ID);
    assert.deepStrictEqual(
      suppressed.messages,
      [],
      'a history cursor must stay suppressed when the durable managed run survives a Relay restart'
    );

    const authoritative = assistantObservation(
      'managed-authoritative-message',
      MANAGED_SESSION_ID,
      'authoritative app-server transcript remains visible',
      '2099-01-01T00:00:03.000Z'
    );
    await postEvent(port, {
      type: 'session.transcript',
      hostId: HOST_ID,
      sessionId: MANAGED_SESSION_ID,
      nativeThreadId: MANAGED_SESSION_ID,
      source: 'codex-app-server',
      speaker: 'assistant',
      text: authoritative.previewText,
      timestamp: authoritative.assistantAt,
      assistantObservation: authoritative,
    }, 'cursor-ownership-authoritative');
    const visible = await readProjection(port, MANAGED_SESSION_ID);
    assert.deepStrictEqual(
      visible.messages.map((entry) => entry.assistantMessageId),
      [authoritative.assistantMessageId],
      'the authoritative app-server transcript must still be ingested after restart'
    );

    const ordinaryCursor = assistantObservation(
      'ordinary-rollout-cursor-message',
      ORDINARY_SESSION_ID,
      'ordinary rollout cursor remains visible',
      '2099-01-01T00:00:04.000Z'
    );
    await postEvent(port, {
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'cursor-ownership-ordinary',
      sessions: [{
        sessionId: ORDINARY_SESSION_ID,
        nativeThreadId: ORDINARY_SESSION_ID,
        conversationKey: ORDINARY_SESSION_ID,
        source: 'rollout',
        live: false,
        assistantCursor: {
          observations: [ordinaryCursor],
          fileIdentity: 'ordinary-rollout-file',
          projectionRevision: 1,
          cursorOffset: 64,
          cursorUnknown: false,
        },
      }],
    }, 'cursor-ownership-ordinary');
    const ordinary = await readProjection(port, ORDINARY_SESSION_ID);
    assert.deepStrictEqual(
      ordinary.messages.map((entry) => entry.assistantMessageId),
      [ordinaryCursor.assistantMessageId],
      'a cursor without managed app-server ownership must remain visible'
    );

    console.log('discovery cursor managed ownership assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopRelay(relay);
    try {
      require('fs').rmSync(root, { recursive: true, force: true });
    } catch (_) {
      // Best effort cleanup; the test result is already determined above.
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
