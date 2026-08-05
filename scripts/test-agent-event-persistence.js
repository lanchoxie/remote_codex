const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FAULT_HOOK = path.join(__dirname, 'fixtures', 'relay-persistence-faults.js');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (_) {
          parsed = { raw };
        }
        resolve({ statusCode: response.statusCode || 0, body: parsed });
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error(`${method} ${requestPath} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRelay(port, relay) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (relay.exitCode != null) {
      throw new Error(`Relay exited before readiness with code ${relay.exitCode}`);
    }
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch (_) {
      // Startup races are expected.
    }
    await delay(25);
  }
  throw new Error('Relay did not become ready');
}

async function waitForFile(filePath, relay) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    if (relay.exitCode != null) throw new Error(`Relay exited with code ${relay.exitCode}`);
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000),
  ]);
}

async function withRelay(label, faultOptions, task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `relay-persistence-${label}-`));
  const port = await openPort();
  const logsPath = path.join(root, 'session-logs.json');
  const diagnosticsPath = path.join(root, 'session-diagnostics.json');
  const dismissedHostsPath = path.join(root, 'dismissed-hosts.json');
  const output = [];
  const nodeOptions = [
    String(process.env.NODE_OPTIONS || '').trim(),
    `--require=${FAULT_HOOK}`,
  ].filter(Boolean).join(' ');
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      PORT: String(port),
      RELAY_STATE_ROOT: root,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      SESSION_DIAGNOSTICS_PATH: diagnosticsPath,
      RELAY_TEST_DIAGNOSTICS_PATH: diagnosticsPath,
      DISMISSED_HOSTS_PATH: dismissedHostsPath,
      RELAY_TEST_DISMISSED_HOSTS_PATH: dismissedHostsPath,
      ...faultOptions,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  try {
    await waitForRelay(port, relay);
    await task({ port, root, logsPath, diagnosticsPath, dismissedHostsPath, relay });
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(relay);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function registerHost(port, hostId) {
  const response = await requestJson(port, 'POST', '/api/agent/register', {
    hostId,
    label: hostId,
    platform: process.platform,
    capabilities: {},
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

function diagnosticEvent(hostId, sessionId, message) {
  return {
    type: 'session.diagnostic',
    hostId,
    sessionId,
    severity: 'info',
    kind: 'persistence-test',
    message,
  };
}

async function testDiagnosticsFailOnceRecovery() {
  await withRelay('fail-once', {
    RELAY_TEST_DIAGNOSTICS_FAIL_ONCE: '1',
  }, async ({ port, diagnosticsPath }) => {
    const hostId = 'persistence-fail-once-host';
    const sessionId = 'persistence-fail-once-session';
    const batch = {
      batchId: 'persistence-fail-once-batch',
      events: [diagnosticEvent(hostId, sessionId, 'fail-once diagnostic')],
    };
    await registerHost(port, hostId);
    const first = await requestJson(port, 'POST', '/api/agent/events', batch);
    assert.strictEqual(first.statusCode, 409, JSON.stringify(first.body));
    assert.strictEqual(first.body?.appliedCount, 1);
    const retry = await requestJson(port, 'POST', '/api/agent/events', batch);
    assert.strictEqual(retry.statusCode, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.body?.duplicate, false);
    const persisted = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'));
    const entries = persisted.diagnostics?.[`${hostId}::${sessionId}`] || [];
    assert.strictEqual(entries.filter((entry) => entry.message === 'fail-once diagnostic').length, 1);
  });
}

async function testDiagnosticsTransientBusyRecovery() {
  await withRelay('transient-busy', {
    RELAY_TEST_DIAGNOSTICS_BUSY_ATTEMPTS: '2',
  }, async ({ port, diagnosticsPath }) => {
    const hostId = 'persistence-transient-busy-host';
    const sessionId = 'persistence-transient-busy-session';
    await registerHost(port, hostId);
    const response = await requestJson(port, 'POST', '/api/agent/events', {
      batchId: 'persistence-transient-busy-batch',
      events: [diagnosticEvent(hostId, sessionId, 'transient busy diagnostic')],
    });
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
    const persisted = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8'));
    const entries = persisted.diagnostics?.[`${hostId}::${sessionId}`] || [];
    assert.strictEqual(entries.filter((entry) => entry.message === 'transient busy diagnostic').length, 1);
  });
}

async function testTranscriptCheckpointPersistsAtomically() {
  await withRelay('transcript-checkpoint', {}, async ({ port, logsPath }) => {
    const hostId = 'persistence-transcript-host';
    const sessionId = 'persistence-transcript-session';
    await registerHost(port, hostId);
    const response = await requestJson(port, 'POST', '/api/agent/events', {
      batchId: 'persistence-transcript-batch',
      events: [{
        type: 'session.transcript',
        hostId,
        sessionId,
        speaker: 'agent',
        text: 'durable transcript checkpoint',
      }],
    });
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
    const persisted = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
    const entries = persisted.logs?.[`${hostId}::${sessionId}`] || [];
    assert.strictEqual(entries.filter((entry) => entry.text === 'durable transcript checkpoint').length, 1);
  });
}

async function testConcurrentPartialCheckpoint() {
  const markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-persistence-marker-'));
  const markerPath = path.join(markerRoot, 'diagnostics-write-started');
  try {
    await withRelay('concurrent-partial', {
      RELAY_TEST_DIAGNOSTICS_DELAY_MS: '3200',
      RELAY_TEST_DIAGNOSTICS_MARKER_PATH: markerPath,
    }, async ({ port, relay }) => {
      const hostId = 'persistence-concurrent-host';
      const sessionId = 'persistence-concurrent-session';
      const message = 'concurrent partial diagnostic';
      const batch = {
        batchId: 'persistence-concurrent-partial-batch',
        events: [
          diagnosticEvent(hostId, sessionId, message),
          {
            type: 'host.skills.deployment.result',
            hostId,
            deploymentId: 'missing-persistence-test-deployment',
            action: 'enable',
            ok: false,
            error: 'intentional partial batch failure',
          },
        ],
      };
      await registerHost(port, hostId);
      const firstRequest = requestJson(port, 'POST', '/api/agent/events', batch);
      firstRequest.catch(() => {});
      await waitForFile(markerPath, relay);
      await delay(2100);
      const secondRequest = requestJson(port, 'POST', '/api/agent/events', batch);
      const [first, second] = await Promise.all([firstRequest, secondRequest]);
      assert.strictEqual(first.statusCode, 409, JSON.stringify(first.body));
      assert.strictEqual(second.statusCode, 409, JSON.stringify(second.body));
      assert.strictEqual(first.body?.appliedCount, 1);
      assert.strictEqual(second.body?.appliedCount, 1);
      const detail = await requestJson(
        port,
        'GET',
        `/api/sessions/${encodeURIComponent(sessionId)}/detail?hostId=${encodeURIComponent(hostId)}`
      );
      assert.strictEqual(detail.statusCode, 200, JSON.stringify(detail.body));
      assert.strictEqual(
        (detail.body?.diagnostics || []).filter((entry) => entry.message === message).length,
        1,
        'a retry arriving during the partial checkpoint must not reapply the accepted prefix'
      );
    });
  } finally {
    fs.rmSync(markerRoot, { recursive: true, force: true });
  }
}

async function testDismissedRestoreWriteRetry() {
  const triggerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dismissed-trigger-'));
  const triggerPath = path.join(triggerRoot, 'fail-next-dismissed-save');
  try {
    await withRelay('dismissed-restore', {
      RELAY_TEST_DISMISSED_FAILURE_TRIGGER: triggerPath,
    }, async ({ port, dismissedHostsPath }) => {
      const hostId = 'dismissed-restore-retry-host';
      await registerHost(port, hostId);
      const removed = await requestJson(port, 'DELETE', `/api/hosts/${encodeURIComponent(hostId)}`);
      assert.strictEqual(removed.statusCode, 200, JSON.stringify(removed.body));
      assert(JSON.parse(fs.readFileSync(dismissedHostsPath, 'utf8')).hosts.includes(hostId));

      fs.writeFileSync(triggerPath, 'fail', 'utf8');
      const failedRestore = await requestJson(port, 'POST', `/api/hosts/${encodeURIComponent(hostId)}/import`, {});
      assert(failedRestore.statusCode >= 500, JSON.stringify(failedRestore.body));
      const retry = await requestJson(port, 'POST', `/api/hosts/${encodeURIComponent(hostId)}/import`, {});
      assert.strictEqual(retry.statusCode, 200, JSON.stringify(retry.body));
      assert.strictEqual(
        JSON.parse(fs.readFileSync(dismissedHostsPath, 'utf8')).hosts.includes(hostId),
        false,
        'a failed restore save must leave the in-memory dismissal retryable'
      );
    });
  } finally {
    fs.rmSync(triggerRoot, { recursive: true, force: true });
  }
}

testDiagnosticsFailOnceRecovery()
  .then(testDiagnosticsTransientBusyRecovery)
  .then(testTranscriptCheckpointPersistsAtomically)
  .then(testConcurrentPartialCheckpoint)
  .then(testDismissedRestoreWriteRetry)
  .then(() => console.log('Agent event persistence assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
