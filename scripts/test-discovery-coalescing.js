const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'discovery-coalescing-host';
const SESSION_ID = 'managed-discovery-session';

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
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

async function postDiscovery(port, sessions, batchId, discoveryId = batchId) {
  const response = await requestJson(port, 'POST', '/api/agent/events', {
    batchId,
    events: [{ type: 'session.discovery', hostId: HOST_ID, discoveryId, sessions }],
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

async function readSession(port) {
  const response = await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/sessions`);
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return (response.body.sessions || []).find((session) => session.sessionId === SESSION_ID) || null;
}

function liveSession() {
  return {
    sessionId: SESSION_ID,
    nativeThreadId: SESSION_ID,
    conversationKey: SESSION_ID,
    title: 'Managed discovery test',
    cwd: ROOT,
    source: 'managed',
    live: true,
    updatedAt: new Date().toISOString(),
    transcriptPreview: [],
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-discovery-coalescing-'));
  const port = await openPort();
  const output = [];
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_MISSING_MANAGED_DISCOVERY_CONFIRMATION_MS: '1',
      RELAY_HOST_SESSION_DISCOVERY_REQUEST_COOLDOWN_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitForRelay(port, relay);
    const registered = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: 'Discovery coalescing test',
      platform: process.platform,
      capabilities: { managedSessions: true },
    });
    assert.strictEqual(registered.statusCode, 200, JSON.stringify(registered.body));

    await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/sessions?refresh=1`);
    await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/sessions?refresh=1`);
    const commands = await requestJson(port, 'GET', `/api/agent/commands?hostId=${HOST_ID}&after=0&ack=0`);
    assert.strictEqual(
      (commands.body.commands || []).filter((command) => command.type === 'host.import').length,
      1,
      'legacy refresh clients must enqueue at most one import during the cooldown'
    );

    await postDiscovery(port, [liveSession()], 'discovery-live-1');
    assert.strictEqual((await readSession(port)).live, true);
    await postDiscovery(port, [], 'discovery-missing-1', 'missing-snapshot-1');
    assert.strictEqual((await readSession(port)).live, true, 'one missing snapshot must not close a managed Session');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await postDiscovery(port, [], 'discovery-missing-retry', 'missing-snapshot-1');
    assert.strictEqual((await readSession(port)).live, true, 'a retry of the same snapshot must not confirm absence');
    await postDiscovery(port, [], 'discovery-missing-2', 'missing-snapshot-2');
    assert.strictEqual((await readSession(port)).live, false, 'two separated missing snapshots should close a stale Session');

    await postDiscovery(port, [liveSession()], 'discovery-live-2');
    await postDiscovery(port, [], 'discovery-missing-reset-1');
    await postDiscovery(port, [liveSession()], 'discovery-present-reset');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await postDiscovery(port, [], 'discovery-missing-after-reset');
    assert.strictEqual((await readSession(port)).live, true, 'a present snapshot must reset missing confirmation');

    const concurrentSessions = Array.from({ length: 120 }, (_, index) => ({
      sessionId: `concurrent-discovery-${index}`,
      nativeThreadId: `concurrent-discovery-${index}`,
      title: `Concurrent discovery ${index}`,
      cwd: ROOT,
      source: 'vscode',
      live: false,
      transcriptPreview: [],
    }));
    const concurrentBody = {
      batchId: 'concurrent-discovery-batch',
      events: [{
        type: 'session.discovery',
        hostId: HOST_ID,
        discoveryId: 'concurrent-discovery-snapshot',
        sessions: concurrentSessions,
      }],
    };
    const concurrent = await Promise.all([
      requestJson(port, 'POST', '/api/agent/events', concurrentBody),
      requestJson(port, 'POST', '/api/agent/events', concurrentBody),
    ]);
    assert.deepStrictEqual(
      concurrent.map((response) => response.body?.duplicate).sort(),
      [false, true],
      'concurrent retries of one batch must share the in-flight application'
    );
    const conflictingBatch = await requestJson(port, 'POST', '/api/agent/events', {
      batchId: 'concurrent-discovery-batch',
      events: [{
        type: 'session.discovery',
        hostId: HOST_ID,
        discoveryId: 'different-discovery-snapshot',
        sessions: [],
      }],
    });
    assert.strictEqual(conflictingBatch.statusCode, 409);
    assert.strictEqual(conflictingBatch.body?.code, 'agent_event_batch_id_conflict');
  } catch (error) {
    if (output.length) error.message += `\nRelay output:\n${output.join('').slice(-4000)}`;
    throw error;
  } finally {
    await stopChild(relay);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('discovery coalescing assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
