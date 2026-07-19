const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const {
  buildRelayEnvironment,
  resolveDevInstanceConfig,
} = require('./dev-instance-config');

const ROOT = path.resolve(__dirname, '..');

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

function requestJson(port, method, pathname, token, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    request.setTimeout(2000, () => request.destroy(new Error('request timed out')));
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 15_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`development Relay exited early (${child.exitCode}):\n${output.join('')}`);
    }
    try {
      const response = await requestJson(port, 'GET', '/health', '');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError || new Error('timed out waiting for development Relay');
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(10_000),
  ]);
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
}

async function main() {
  const port = await getOpenPort();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-dev-relay-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-dev-home-'));
  const token = 'isolated-development-relay-token';
  const config = resolveDevInstanceConfig({
    root: ROOT,
    home,
    hostname: 'DEV-GUARD',
    env: {
      REMOTE_CODEX_DEV_PORT: String(port),
      REMOTE_CODEX_DEV_STATE_ROOT: stateRoot,
    },
  });
  const output = [];
  const relayEnvironment = buildRelayEnvironment(config, process.env, token);
  delete relayEnvironment.RELAY_LOCAL_AGENT_START_ENABLED;
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitForHealth(port, child, output);
    const hostId = config.hostId;
    const result = await requestJson(
      port,
      'POST',
      `/api/hosts/${encodeURIComponent(hostId)}/local-agent`,
      token,
      { action: 'start', label: config.hostLabel }
    );
    assert.strictEqual(result.statusCode, 403, JSON.stringify(result.body));
    assert.strictEqual(result.body?.status, 'local_agent_start_disabled');

    const stats = await requestJson(port, 'GET', '/api/stats', token);
    assert.strictEqual(stats.statusCode, 200, JSON.stringify(stats.body));
    assert.strictEqual(stats.body?.relay?.localAgentStartEnabled, false);
    assert.strictEqual(stats.body?.summary?.totalHosts, 0, 'development Relay must not add a local Agent stub');
    assert.strictEqual(
      fs.existsSync(path.join(stateRoot, 'local-agents')),
      false,
      'a blocked start must not create Agent logs or owner markers'
    );
    assert.strictEqual(
      fs.existsSync(config.agentStateRoot),
      false,
      'a blocked start must not create Agent-owned state'
    );
    console.log('development Relay local-Agent guard assertions passed');
  } finally {
    await stopChild(child);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
