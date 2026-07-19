const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELAY_PATH = path.join(ROOT, 'apps', 'relay', 'server.js');
const AUTH_TOKEN = 'relay-lifecycle-test-token';
const STATE_ENV_KEYS = [
  'SESSION_RECORD_STORE_ROOT',
  'SESSION_COLLECTIONS_PATH',
  'SESSION_METADATA_PATH',
  'SESSION_LOGS_PATH',
  'SESSION_DIAGNOSTICS_PATH',
  'CONNECTORS_PATH',
  'CONNECTOR_SECRETS_PATH',
  'SKILL_FAVORITES_PATH',
  'SKILL_SOURCES_PATH',
  'SKILL_LIBRARY_PATH',
  'SKILL_INVENTORIES_PATH',
  'SKILL_REGISTRY_PATH',
  'SKILL_ARTIFACT_ROOT',
  'SKILL_DEPLOYMENTS_PATH',
  'SKILL_AUDIT_PATH',
  'RELAY_AUTH_TOKEN_PATH',
  'RELAY_AUTH_ACCOUNT_PATH',
  'RELAY_CONTROL_TOKEN_PATH',
  'SSH_KNOWN_HOSTS_PATH',
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, method, pathname, body = null, headers = {}) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (error) {
          reject(new Error(`invalid JSON response: ${error.message}\n${text}`));
          return;
        }
        resolve({ statusCode: response.statusCode || 0, body: parsed });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function relayEnvironment(port, stateRoot) {
  const env = { ...process.env };
  for (const key of STATE_ENV_KEYS) delete env[key];
  return {
    ...env,
    PORT: String(port),
    RELAY_STATE_ROOT: stateRoot,
    RELAY_AUTH_TOKEN: AUTH_TOKEN,
    RELAY_AUTH_DISABLED: 'false',
    RELAY_LOCAL_AGENT_START_ENABLED: 'false',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_LOCAL_HOST_STUB: 'false',
    RELAY_PERSIST_DEBOUNCE_MS: '60000',
  };
}

function spawnRelay(port, stateRoot, envOverrides = {}) {
  const output = [];
  const child = spawn(process.execPath, [RELAY_PATH], {
    cwd: ROOT,
    env: { ...relayEnvironment(port, stateRoot), ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  return { child, output };
}

async function testStoreRootCannotEqualRelayStateRoot() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lifecycle-store-root-'));
  const before = treeSnapshot(stateRoot);
  const relay = spawnRelay(await getOpenPort(), stateRoot, {
    SESSION_RECORD_STORE_ROOT: stateRoot,
  });
  const exitCode = await waitForExit(relay);
  assert.notStrictEqual(exitCode, 0, relay.output.join(''));
  assert.match(relay.output.join(''), /must be a child directory of RELAY_STATE_ROOT/);
  assert.deepStrictEqual(treeSnapshot(stateRoot), before);
  console.log('relay Session Store root containment assertions passed');
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError || new Error('timed out waiting for condition');
}

async function waitForRelay(port, relay) {
  await waitFor(async () => {
    if (relay.child.exitCode != null) {
      throw new Error(`Relay exited early (${relay.child.exitCode}):\n${relay.output.join('')}`);
    }
    const health = await requestJson(port, 'GET', '/health');
    return health.statusCode === 200 && health.body?.ok === true;
  });
}

async function waitForExit(relay, timeoutMs = 15000) {
  if (relay.child.exitCode != null || relay.child.signalCode != null) return relay.child.exitCode;
  const result = await Promise.race([
    new Promise((resolve) => relay.child.once('exit', (code) => resolve(code))),
    delay(timeoutMs).then(() => Symbol.for('timeout')),
  ]);
  if (result === Symbol.for('timeout')) {
    relay.child.kill('SIGKILL');
    throw new Error(`Relay did not exit in time:\n${relay.output.join('')}`);
  }
  return result;
}

function treeSnapshot(root) {
  const snapshot = {};
  if (!fs.existsSync(root)) return snapshot;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        visit(fullPath);
      } else {
        snapshot[relative] = fs.readFileSync(fullPath).toString('base64');
      }
    }
  };
  visit(root);
  return snapshot;
}

async function testOccupiedPortDoesNotMutateState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lifecycle-port-conflict-'));
  fs.writeFileSync(path.join(stateRoot, 'session-logs.json'), JSON.stringify({
    savedAt: 'fixture',
    logs: { 'host::session': [{ speaker: 'assistant', text: 'unchanged' }, null] },
  }));
  fs.writeFileSync(path.join(stateRoot, 'session-diagnostics.json'), JSON.stringify({
    savedAt: 'fixture',
    diagnostics: { 'host::session': [{ message: 'unchanged' }, null] },
  }));
  const before = treeSnapshot(stateRoot);
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, resolve);
  });
  const port = blocker.address().port;
  const relay = spawnRelay(port, stateRoot);
  let exitCode;
  try {
    exitCode = await waitForExit(relay);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
  assert.notStrictEqual(exitCode, 0, relay.output.join(''));
  assert.match(relay.output.join(''), /EADDRINUSE|address already in use/i);
  assert.deepStrictEqual(treeSnapshot(stateRoot), before, 'port conflict must not touch Relay state');
  console.log('relay occupied-port startup isolation assertions passed');
}

async function testAuthenticatedGracefulShutdownPersistsDebouncedState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lifecycle-shutdown-'));
  const port = await getOpenPort();
  const relay = spawnRelay(port, stateRoot);
  const bearer = { Authorization: `Bearer ${AUTH_TOKEN}` };
  try {
    await waitForRelay(port, relay);
    const controlToken = fs.readFileSync(path.join(stateRoot, 'relay-control-token.txt'), 'utf8').trim();
    const controlHeaders = { 'X-Relay-Control-Token': controlToken };
    const owner = JSON.parse(fs.readFileSync(path.join(stateRoot, 'relay-owner.json'), 'utf8'));
    const health = await requestJson(port, 'GET', '/health');
    assert.strictEqual(owner.kind, 'remote-codex-relay-owner');
    assert.strictEqual(owner.pid, relay.child.pid);
    assert.strictEqual(owner.port, port);
    assert.strictEqual(owner.instanceId, health.body?.instanceId);
    const missing = await requestJson(port, 'POST', '/api/control/shutdown', {});
    assert.strictEqual(missing.statusCode, 403, JSON.stringify(missing.body));
    const headerOnly = await requestJson(port, 'POST', '/api/control/shutdown', {}, {
      'X-Relay-Auth-Token': AUTH_TOKEN,
    });
    assert.strictEqual(headerOnly.statusCode, 403, JSON.stringify(headerOnly.body));
    const loginBearerOnly = await requestJson(port, 'POST', '/api/control/shutdown', {}, bearer);
    assert.strictEqual(loginBearerOnly.statusCode, 403, JSON.stringify(loginBearerOnly.body));
    assert.strictEqual(relay.child.exitCode, null, 'rejected control requests must not stop Relay');

    const hostId = 'relay-lifecycle-host';
    const sessionId = 'relay-lifecycle-session';
    let response = await requestJson(port, 'POST', '/api/agent/register', {
      hostId,
      label: 'Relay lifecycle host',
      platform: process.platform,
      capabilities: {},
    }, bearer);
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
    response = await requestJson(port, 'POST', '/api/agent/events', { event: {
      type: 'session.discovery',
      hostId,
      sessions: [{
        sessionId,
        nativeThreadId: sessionId,
        runId: 'lifecycle-run',
        title: 'Relay lifecycle session',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    } }, bearer);
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
    response = await requestJson(port, 'POST', '/api/agent/events', { event: {
      type: 'session.output',
      hostId,
      sessionId,
      runId: 'lifecycle-run',
      stream: 'stdout',
      chunk: '[assistant] lifecycle-log-marker',
    } }, bearer);
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
    response = await requestJson(port, 'POST', '/api/agent/events', { event: {
      type: 'session.diagnostic',
      hostId,
      sessionId,
      runId: 'lifecycle-run',
      severity: 'info',
      source: 'test',
      kind: 'event',
      message: 'lifecycle-diagnostic-marker',
    } }, bearer);
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));

    const shutdown = await requestJson(port, 'POST', '/api/control/shutdown', {}, controlHeaders);
    assert.strictEqual(shutdown.statusCode, 202, JSON.stringify(shutdown.body));
    assert.strictEqual(shutdown.body?.status, 'shutting_down');
    assert.strictEqual(await waitForExit(relay, 30000), 0, relay.output.join(''));
    assert.strictEqual(
      fs.existsSync(path.join(stateRoot, 'relay-owner.json')),
      false,
      'graceful shutdown must remove only its own Relay ownership marker'
    );
    assert.match(fs.readFileSync(path.join(stateRoot, 'session-logs.json'), 'utf8'), /lifecycle-log-marker/);
    assert.match(fs.readFileSync(path.join(stateRoot, 'session-diagnostics.json'), 'utf8'), /lifecycle-diagnostic-marker/);

    const restartPort = await getOpenPort();
    const restarted = spawnRelay(restartPort, stateRoot, {
      RELAY_AUTH_DISABLED: 'true',
      RELAY_AUTH_TOKEN: '',
    });
    await waitForRelay(restartPort, restarted);
    const restartedShutdown = await requestJson(
      restartPort,
      'POST',
      '/api/control/shutdown',
      {},
      controlHeaders
    );
    assert.strictEqual(restartedShutdown.statusCode, 202, JSON.stringify(restartedShutdown.body));
    assert.strictEqual(await waitForExit(restarted, 30000), 0, restarted.output.join(''));
    console.log('relay authenticated graceful-shutdown persistence assertions passed');
  } finally {
    if (relay.child.exitCode == null && relay.child.signalCode == null) {
      relay.child.kill('SIGKILL');
    }
  }
}

async function main() {
  await testStoreRootCannotEqualRelayStateRoot();
  await testOccupiedPortDoesNotMutateState();
  await testAuthenticatedGracefulShutdownPersistsDebouncedState();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
