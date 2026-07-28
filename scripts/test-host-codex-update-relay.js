const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'codex-update-test-host';
const INPUT_GATE_HOST_ID = 'codex-update-input-gate-host';
const INPUT_GATE_SESSION_ID = 'codex-update-input-gate-session';

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

function requestJson(port, method, pathname, body = null) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRelay(port, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Relay exited with ${child.exitCode}`);
    try {
      const health = await requestJson(port, 'GET', '/health');
      if (health.statusCode === 200 && health.body?.ok) return;
    } catch (_) {
      // Keep waiting for the isolated Relay.
    }
    await delay(50);
  }
  throw new Error('Relay did not become ready');
}

async function waitForCommand(port, type, after = 0) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${after}&ack=${after}`
    );
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
    const command = (response.body?.commands || []).find((entry) => entry.type === type);
    if (command) return command;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function postEvent(port, event) {
  const response = await requestJson(port, 'POST', '/api/agent/events', { event });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

async function main() {
  const port = await getOpenPort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-update-relay-'));
  const recoveredOperationId = 'recovered-no-session-update';
  fs.writeFileSync(path.join(tempRoot, 'codex-update-operations.json'), JSON.stringify({
    version: 1,
    operations: [{
      operationId: recoveredOperationId,
      hostId: HOST_ID,
      status: 'updated',
      phase: 'updated',
      message: 'Recovered Codex update finished.',
      updateSucceeded: true,
      sessions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
    }],
  }, null, 2), 'utf8');
  const output = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_HOST_STUB: 'false',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_TEST_CONTROL_ENABLED: 'true',
      RELAY_TEST_INPUT_PREPARE_DELAY_MS: '500',
      SESSION_RECORD_STORE_ROOT: path.join(tempRoot, 'session-record-store'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitForRelay(port, child);
    const register = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: 'Codex Update Test Host',
      platform: 'linux',
      capabilities: {
        codexRuntimeV1: true,
        codexUpdateV1: true,
        managedSessions: true,
        nativeResumeReadiness: true,
        runApiBinding: true,
      },
      codexRuntime: {
        version: '0.145.0',
        rawVersion: 'codex-cli 0.145.0',
        source: 'npm_global',
        packageManager: 'npm',
        platform: 'linux',
        arch: 'arm64',
        canAutoUpdate: true,
        probedAt: new Date().toISOString(),
      },
    });
    assert.strictEqual(register.statusCode, 200, JSON.stringify(register.body));

    const recoveredStatus = await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/codex-update`);
    assert.strictEqual(recoveredStatus.statusCode, 200, JSON.stringify(recoveredStatus.body));
    assert.strictEqual(recoveredStatus.body.operation.operationId, recoveredOperationId);
    assert.strictEqual(recoveredStatus.body.operation.status, 'completed');
    assert(recoveredStatus.body.operation.completedAt);

    const inputGateRegister = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: INPUT_GATE_HOST_ID,
      label: 'ZZZ Codex Update Input Gate Host',
      platform: 'linux',
      capabilities: {
        codexRuntimeV1: true,
        codexUpdateV1: true,
        managedSessions: true,
        nativeResumeReadiness: true,
        runApiBinding: true,
      },
      codexRuntime: {
        version: '0.145.0',
        rawVersion: 'codex-cli 0.145.0',
        source: 'npm_global',
        packageManager: 'npm',
        platform: 'linux',
        arch: 'arm64',
        canAutoUpdate: true,
        probedAt: new Date().toISOString(),
      },
    });
    assert.strictEqual(inputGateRegister.statusCode, 200, JSON.stringify(inputGateRegister.body));

    await postEvent(port, {
      type: 'session.started',
      hostId: INPUT_GATE_HOST_ID,
      sessionId: INPUT_GATE_SESSION_ID,
      nativeThreadId: INPUT_GATE_SESSION_ID,
      runId: 'codex-update-input-gate-run',
      title: 'Codex update input gate',
      cwd: ROOT,
      source: 'managed',
      launchMode: 'fresh',
      conversationKey: INPUT_GATE_SESSION_ID,
      effectiveBinding: {
        kind: 'profile',
        profileId: 'codex-update-input-gate-profile',
        label: 'Codex update input gate profile',
        provider: 'OpenAI',
        providerKind: 'openai',
        normalizedBaseUrl: 'https://api.openai.com/v1',
      },
      runtime: {
        adapterId: 'codex-app-server',
        runId: 'codex-update-input-gate-run',
        nativeResumeReady: true,
        connection: 'ready',
        phase: 'idle',
        busy: false,
        activeTurnId: null,
        currentTurnStatus: 'idle',
      },
    });

    const acceptedInputRequestId = 'input-before-codex-maintenance';
    const acceptedInputBody = {
      hostId: INPUT_GATE_HOST_ID,
      clientRequestId: acceptedInputRequestId,
      text: 'This prompt reserved its input intent before maintenance started.',
    };
    const acceptedInputPromise = requestJson(
      port,
      'POST',
      `/api/sessions/${INPUT_GATE_SESSION_ID}/input`,
      acceptedInputBody
    );
    await delay(100);

    const inputGatePrepared = await requestJson(
      port,
      'POST',
      `/api/hosts/${INPUT_GATE_HOST_ID}/codex-update`,
      { action: 'prepare' }
    );
    assert.strictEqual(inputGatePrepared.statusCode, 200, JSON.stringify(inputGatePrepared.body));
    assert.deepStrictEqual(
      inputGatePrepared.body.operation.sessions.map((session) => session.sessionId),
      [INPUT_GATE_SESSION_ID]
    );

    const inFlightReplayPromise = requestJson(
      port,
      'POST',
      `/api/sessions/${INPUT_GATE_SESSION_ID}/input`,
      acceptedInputBody
    );
    const blockedInputRequestId = 'new-input-during-codex-maintenance';
    const blockedInput = await requestJson(
      port,
      'POST',
      `/api/sessions/${INPUT_GATE_SESSION_ID}/input`,
      {
        hostId: INPUT_GATE_HOST_ID,
        clientRequestId: blockedInputRequestId,
        text: 'This new prompt must not enter the durable input outbox.',
      }
    );
    assert.strictEqual(blockedInput.statusCode, 423, JSON.stringify(blockedInput.body));
    assert.strictEqual(blockedInput.body.code, 'host_codex_maintenance');

    const acceptedInput = await acceptedInputPromise;
    const inFlightReplay = await inFlightReplayPromise;
    assert.strictEqual(acceptedInput.statusCode, 200, JSON.stringify(acceptedInput.body));
    assert.strictEqual(inFlightReplay.statusCode, 200, JSON.stringify(inFlightReplay.body));
    assert.strictEqual(inFlightReplay.body.command.id, acceptedInput.body.command.id);

    const cachedReplay = await requestJson(
      port,
      'POST',
      `/api/sessions/${INPUT_GATE_SESSION_ID}/input`,
      acceptedInputBody
    );
    assert.strictEqual(cachedReplay.statusCode, 200, JSON.stringify(cachedReplay.body));
    assert.strictEqual(cachedReplay.body.command.id, acceptedInput.body.command.id);

    const inputOutbox = fs.readFileSync(path.join(tempRoot, 'input-command-outbox.jsonl'), 'utf8');
    assert(inputOutbox.includes(acceptedInputRequestId));
    assert(!inputOutbox.includes(blockedInputRequestId));

    const cancelledInputGate = await requestJson(
      port,
      'POST',
      `/api/hosts/${INPUT_GATE_HOST_ID}/codex-update`,
      {
        action: 'cancel',
        operationId: inputGatePrepared.body.operation.operationId,
        confirmAbandonStoppedSessions: true,
      }
    );
    assert.strictEqual(cancelledInputGate.statusCode, 200, JSON.stringify(cancelledInputGate.body));
    assert.strictEqual(cancelledInputGate.body.operation.status, 'cancelled');

    const prepared = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, { action: 'prepare' });
    assert.strictEqual(prepared.statusCode, 200, JSON.stringify(prepared.body));
    const operation = prepared.body.operation;
    assert.strictEqual(operation.status, 'stopping_sessions');
    assert.deepStrictEqual(operation.sessions, []);

    const blockedStart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      cwd: ROOT,
      launchMode: 'fresh',
    });
    assert.strictEqual(blockedStart.statusCode, 423, JSON.stringify(blockedStart.body));
    assert.strictEqual(blockedStart.body.code, 'host_codex_maintenance');

    const applyPromise = requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'apply',
      operationId: operation.operationId,
    });
    const command = await waitForCommand(port, 'host.codex_update');
    assert.strictEqual(command.operationId, operation.operationId);
    await postEvent(port, {
      type: 'host.codex_update_progress',
      hostId: HOST_ID,
      requestId: command.requestId,
      operationId: operation.operationId,
      phase: 'installing',
      message: 'Installing fixed package target',
      timestamp: new Date().toISOString(),
    });
    await postEvent(port, {
      type: 'host.codex_updated',
      hostId: HOST_ID,
      requestId: command.requestId,
      operationId: operation.operationId,
      ok: true,
      previousVersion: '0.145.0',
      version: '0.146.0',
      changed: true,
      codexRuntime: {
        version: '0.146.0',
        rawVersion: 'codex-cli 0.146.0',
        source: 'npm_global',
        packageManager: 'npm',
        platform: 'linux',
        arch: 'arm64',
        canAutoUpdate: true,
        probedAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });
    const applied = await applyPromise;
    assert.strictEqual(applied.statusCode, 200, JSON.stringify(applied.body));
    assert.strictEqual(applied.body.ok, true);
    assert.strictEqual(applied.body.operation.status, 'completed');
    assert(applied.body.operation.completedAt);

    const launchAfterUpdate = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      cwd: ROOT,
      launchMode: 'fresh',
      clientRequestId: 'invalid request id',
    });
    assert.strictEqual(launchAfterUpdate.statusCode, 400, JSON.stringify(launchAfterUpdate.body));
    assert.strictEqual(launchAfterUpdate.body.code, 'session_request_invalid');

    const resuming = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'resuming',
      operationId: operation.operationId,
    });
    assert.strictEqual(resuming.statusCode, 200, JSON.stringify(resuming.body));
    assert.strictEqual(resuming.body.operation.status, 'completed');

    const completed = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'complete',
      operationId: operation.operationId,
      updateSucceeded: true,
      resumeFailures: [],
    });
    assert.strictEqual(completed.statusCode, 200, JSON.stringify(completed.body));
    assert.strictEqual(completed.body.operation.status, 'completed');

    const hosts = await requestJson(port, 'GET', '/api/hosts');
    assert.strictEqual(hosts.body.hosts[0].codexRuntime.version, '0.146.0');
    assert.strictEqual(hosts.body.hosts[0].codexUpdate.status, 'completed');

    await postEvent(port, {
      type: 'host.codex_update_progress',
      hostId: HOST_ID,
      requestId: command.requestId,
      operationId: operation.operationId,
      phase: 'installing',
      message: 'late progress must not reopen maintenance',
      timestamp: new Date().toISOString(),
    });
    await postEvent(port, {
      type: 'host.codex_updated',
      hostId: HOST_ID,
      requestId: command.requestId,
      operationId: operation.operationId,
      ok: false,
      error: 'late terminal must not replace completed state',
      timestamp: new Date().toISOString(),
    });
    const afterLateEvents = await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/codex-update`);
    assert.strictEqual(afterLateEvents.body.operation.status, 'completed');

    const cancelCompleted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'cancel',
      operationId: operation.operationId,
      confirmAbandonStoppedSessions: true,
    });
    assert.strictEqual(cancelCompleted.statusCode, 409, JSON.stringify(cancelCompleted.body));

    const recoveryPrepared = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'prepare',
    });
    assert.strictEqual(recoveryPrepared.statusCode, 200, JSON.stringify(recoveryPrepared.body));
    const recoveryOperation = recoveryPrepared.body.operation;
    const prematureComplete = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'complete',
      operationId: recoveryOperation.operationId,
      updateSucceeded: true,
    });
    assert.strictEqual(prematureComplete.statusCode, 409, JSON.stringify(prematureComplete.body));
    const recoveryResuming = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'resuming',
      operationId: recoveryOperation.operationId,
      recoveryOnly: true,
    });
    assert.strictEqual(recoveryResuming.statusCode, 200, JSON.stringify(recoveryResuming.body));
    const forgedSuccess = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/codex-update`, {
      action: 'complete',
      operationId: recoveryOperation.operationId,
      updateSucceeded: true,
    });
    assert.strictEqual(forgedSuccess.statusCode, 200, JSON.stringify(forgedSuccess.body));
    assert.strictEqual(forgedSuccess.body.operation.status, 'failed');

    const persisted = fs.readFileSync(path.join(tempRoot, 'codex-update-operations.json'), 'utf8');
    assert(persisted.includes(recoveryOperation.operationId));
    assert(!persisted.includes('apiKey'));
    console.log('Host Codex update Relay integration assertions passed');
  } finally {
    if (child.exitCode == null) child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
