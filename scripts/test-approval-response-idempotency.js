const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'approval-idempotency-host';
const SESSION_ID = 'approval-idempotency-session';
const RUN_ID = 'approval-idempotency-run';
const REQUEST_ID = '7';

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, method, pathname, body = null) {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: payload.length ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: text ? JSON.parse(text) : null,
          });
        } catch (error) {
          reject(new Error(`Invalid JSON for ${method} ${pathname}: ${error.message}\n${text}`));
        }
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.on('error', reject);
    if (payload.length) request.write(payload);
    request.end();
  });
}

function relayEnvironment(port, stateRoot) {
  const statePath = (name) => path.join(stateRoot, name);
  return {
    ...process.env,
    PORT: String(port),
    RELAY_STATE_ROOT: stateRoot,
    RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_LOCAL_AGENT_START_ENABLED: 'false',
    RELAY_LOCAL_HOST_STUB: 'false',
    SESSION_COLLECTIONS_PATH: statePath('session-collections.json'),
    SESSION_METADATA_PATH: statePath('session-metadata.json'),
    SESSION_RECORD_STORE_ROOT: statePath('session-record-store'),
    SESSION_LOGS_PATH: statePath('session-logs.json'),
    SESSION_DIAGNOSTICS_PATH: statePath('session-diagnostics.json'),
    DISMISSED_HOSTS_PATH: statePath('dismissed-hosts.json'),
    CODEX_UPDATE_OPERATIONS_PATH: statePath('codex-update-operations.json'),
    AGENT_EVENT_LEDGER_PATH: statePath('agent-event-ledger.jsonl'),
    INPUT_COMMAND_OUTBOX_PATH: statePath('input-command-outbox.jsonl'),
    CONNECTORS_PATH: statePath('connectors.json'),
    CONNECTOR_SECRETS_PATH: statePath('connector-secrets.json'),
    SKILL_FAVORITES_PATH: statePath('skill-favorites.json'),
    SKILL_SOURCES_PATH: statePath('skill-sources.json'),
    SKILL_LIBRARY_PATH: statePath('skill-library.json'),
    SKILL_INVENTORIES_PATH: statePath('skill-inventories.json'),
    SKILL_REGISTRY_PATH: statePath('skill-registry.json'),
    SKILL_ARTIFACT_ROOT: statePath('skill-artifacts'),
    SKILL_DEPLOYMENTS_PATH: statePath('skill-deployments.json'),
    SKILL_AUDIT_PATH: statePath('skill-audit.jsonl'),
    SSH_KNOWN_HOSTS_PATH: statePath('ssh-known-hosts'),
    RELAY_AUTH_TOKEN_PATH: statePath('relay-auth-token.txt'),
    RELAY_AUTH_ACCOUNT_PATH: statePath('relay-auth-account.json'),
    RELAY_CONTROL_TOKEN_PATH: statePath('relay-control-token.txt'),
  };
}

async function waitForRelay(port, relay) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (relay.child.exitCode != null) {
      throw new Error(`Relay exited with ${relay.child.exitCode}:\n${relay.output.join('').slice(-4000)}`);
    }
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`Relay did not become ready:\n${relay.output.join('').slice(-4000)}`);
}

async function startRelay(port, stateRoot) {
  const relay = { child: null, output: [] };
  relay.child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnvironment(port, stateRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.child.stdout.on('data', (chunk) => relay.output.push(chunk.toString('utf8')));
  relay.child.stderr.on('data', (chunk) => relay.output.push(chunk.toString('utf8')));
  await waitForRelay(port, relay);
  return relay;
}

async function stopRelay(relay) {
  if (!relay?.child || relay.child.exitCode != null) return;
  relay.child.kill();
  await Promise.race([
    new Promise((resolve) => relay.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function postAgentEvent(port, event) {
  const response = await requestJson(port, 'POST', '/api/agent/events', { event });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return response.body;
}

async function getSessionDetail(port) {
  const response = await requestJson(
    port,
    'GET',
    `/api/sessions/${encodeURIComponent(SESSION_ID)}/detail?hostId=${encodeURIComponent(HOST_ID)}`
  );
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return response.body;
}

async function getCommands(port, after = 0, ack = 0) {
  const response = await requestJson(
    port,
    'GET',
    `/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${after}&ack=${ack}`
  );
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return response.body?.commands || [];
}

function approvalResponseBody(runId = RUN_ID) {
  return {
    hostId: HOST_ID,
    runId,
    response: { decision: 'accept' },
  };
}

async function respond(port, runId = RUN_ID) {
  return requestJson(
    port,
    'POST',
    `/api/sessions/${encodeURIComponent(SESSION_ID)}/requests/${encodeURIComponent(REQUEST_ID)}/respond`,
    approvalResponseBody(runId)
  );
}

async function main() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-response-idempotency-'));
  const port = await getOpenPort();
  let relay = null;
  try {
    relay = await startRelay(port, stateRoot);

    const registration = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: 'Approval Idempotency Host',
      platform: 'test',
      capabilities: {},
    });
    assert.strictEqual(registration.statusCode, 200, JSON.stringify(registration.body));

    await postAgentEvent(port, {
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        conversationKey: SESSION_ID,
        title: 'Approval idempotency fixture',
        cwd: ROOT,
        source: 'managed',
        state: 'running',
        live: true,
        runId: RUN_ID,
        runtime: {
          runId: RUN_ID,
          connection: 'ready',
          phase: 'waiting-approval',
          busy: true,
          waitingOnApproval: true,
        },
      }],
    });
    await postAgentEvent(port, {
      type: 'session.request',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      requestId: REQUEST_ID,
      status: 'pending',
      kind: 'approval',
      method: 'item/commandExecution/requestApproval',
      title: 'Command approval required',
      message: 'Approve fixture command',
      summary: 'fixture command',
      payload: {
        threadId: SESSION_ID,
        turnId: 'approval-turn',
        itemId: 'approval-command',
        command: 'echo fixture',
        availableDecisions: ['accept', 'cancel'],
      },
    });

    const pendingDetail = await getSessionDetail(port);
    const pendingRequest = pendingDetail.requests.find((request) => request.requestId === REQUEST_ID);
    assert(pendingRequest, 'injected approval request should be exposed by Session detail');
    assert.strictEqual(pendingRequest.status, 'pending');
    assert.strictEqual(pendingRequest.runId, RUN_ID, 'request ownership must retain its originating runId');

    const concurrent = await Promise.all([respond(port), respond(port)]);
    for (const response of concurrent) {
      assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
      assert.strictEqual(response.body?.ok, true, JSON.stringify(response.body));
    }

    const respondingDetail = await getSessionDetail(port);
    const respondingRequest = respondingDetail.requests.find((request) => request.requestId === REQUEST_ID);
    assert.strictEqual(
      respondingRequest?.status,
      'responding',
      'the first accepted response must immediately reserve the pending request'
    );
    assert.strictEqual(respondingRequest?.runId, RUN_ID);
    assert.strictEqual(respondingRequest?.response?.decision, 'accept');

    const queuedCommands = (await getCommands(port))
      .filter((command) => command.type === 'session.request.respond');
    assert.strictEqual(queuedCommands.length, 1, 'concurrent identical responses must enqueue one Host command');
    const queued = queuedCommands[0];
    assert.strictEqual(queued.sessionId, SESSION_ID);
    assert.strictEqual(queued.requestId, REQUEST_ID);
    assert.strictEqual(queued.runId, RUN_ID);
    assert.strictEqual(queued.response?.decision, 'accept');

    const wrongRun = await respond(port, 'approval-idempotency-stale-run');
    assert.strictEqual(wrongRun.statusCode, 409, JSON.stringify(wrongRun.body));
    assert.strictEqual(
      (await getCommands(port)).filter((command) => command.type === 'session.request.respond').length,
      1,
      'a mismatched run must not enqueue another response command'
    );

    await getCommands(port, queued.id, queued.id);
    await postAgentEvent(port, {
      type: 'session.request.resolved',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      requestId: REQUEST_ID,
      status: 'resolved',
      method: 'item/commandExecution/requestApproval',
      summary: 'fixture command',
      response: { decision: 'accept' },
    });
    const resolvedDetail = await getSessionDetail(port);
    const resolvedRequest = resolvedDetail.requests.find((request) => request.requestId === REQUEST_ID);
    assert.strictEqual(resolvedRequest?.status, 'resolved');
    assert.strictEqual(resolvedRequest?.runId, RUN_ID);

    const resolvedRetry = await respond(port);
    assert.strictEqual(resolvedRetry.statusCode, 200, JSON.stringify(resolvedRetry.body));
    assert.strictEqual(resolvedRetry.body?.ok, true, JSON.stringify(resolvedRetry.body));
    assert.strictEqual(
      (await getCommands(port, queued.id, queued.id))
        .filter((command) => command.type === 'session.request.respond').length,
      0,
      'an idempotent retry after resolution must not enqueue another Host command'
    );
  } catch (error) {
    if (relay?.output?.length) {
      error.message += `\nRelay output:\n${relay.output.join('').slice(-4000)}`;
    }
    throw error;
  } finally {
    await stopRelay(relay);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('approval response idempotency assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
