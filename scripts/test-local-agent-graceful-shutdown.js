const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'graceful-local-agent-test';
const AGENT_SOURCE = fs.readFileSync(path.join(ROOT, 'apps', 'host-agent', 'agent.js'), 'utf8');
const RELAY_SOURCE = fs.readFileSync(path.join(ROOT, 'apps', 'relay', 'server.js'), 'utf8');

const localRelayHostIdSource = RELAY_SOURCE.slice(
  RELAY_SOURCE.indexOf('function getLocalRelayHostId'),
  RELAY_SOURCE.indexOf('function getLocalRelayHostLabel')
);
assert(
  /legacySafeLocalAgentId/.test(localRelayHostIdSource)
    && !/return safeLocalAgentId/.test(localRelayHostIdSource),
  'the public local Host ID must preserve the configured ID instead of using the hashed marker filename'
);

assert(
  /ownership-revoked/.test(AGENT_SOURCE)
    && /local_agent_ownership_(?:required|mismatch)/.test(AGENT_SOURCE),
  'a Relay-managed Agent must terminate itself when Relay ownership is revoked'
);
const ownershipRevocationShutdownSource = AGENT_SOURCE.slice(
  AGENT_SOURCE.indexOf('function retryOwnershipRevokedShutdown'),
  AGENT_SOURCE.indexOf('function handleShutdownSignal')
);
assert(
  /ownershipRevocationShutdownPromise/.test(ownershipRevocationShutdownSource)
    && /while \(true\)/.test(ownershipRevocationShutdownSource)
    && /await shutdownHostAgent\('ownership-revoked'\)/.test(ownershipRevocationShutdownSource)
    && /result\?\.timedOut/.test(ownershipRevocationShutdownSource)
    && /await sleep\(OWNERSHIP_REVOKED_SHUTDOWN_RETRY_MS\)/.test(ownershipRevocationShutdownSource),
  'ownership loss must share one shutdown attempt and retry incomplete shutdowns until the Agent exits'
);
assert(
  (AGENT_SOURCE.match(/await shutdownForRelayOwnershipLoss\(error\)/g) || []).length >= 6,
  'every dismissed or lease-revoked Agent loop must use the shared ownership-loss shutdown path'
);
assert(
  /host_dismissed/.test(AGENT_SOURCE)
    && /recoverAgentLeaseForRequest\(error, requestLeaseId\)/.test(
      AGENT_SOURCE.slice(
        AGENT_SOURCE.indexOf('async function heartbeatLoop'),
        AGENT_SOURCE.indexOf('function sleep')
      )
    ),
  'heartbeat must recover a rotated lease and terminate explicitly when a Host is dismissed'
);
assert(
  /host_shutdown_incomplete/.test(AGENT_SOURCE)
    && /retryCommand\s*=\s*true/.test(
      AGENT_SOURCE.slice(
        AGENT_SOURCE.indexOf("if (command.type === 'host.shutdown')"),
        AGENT_SOURCE.indexOf("if (command.type === 'session.start')")
      )
    ),
  'an incomplete host shutdown must remain retryable instead of acknowledging a dead Agent'
);
assert(
  /stopLocalAgent\(hostId,\s*\{[\s\S]*host dismissed by operator/.test(RELAY_SOURCE),
  'dismissing a live local Host must disable its watchdog and request local Agent shutdown'
);
assert(
  /async function failShutdownCancelledManagedSession/.test(AGENT_SOURCE)
    && /publishShutdownFailureOnce/.test(AGENT_SOURCE)
    && (AGENT_SOURCE.match(/cancelStartForShutdown\(\)/g) || []).length >= 3
    && /failed:host-shutdown/.test(AGENT_SOURCE),
  'Host shutdown must publish an authoritative failure for every cancelled pending Session start'
);
const failManagedSessionSource = AGENT_SOURCE.slice(
  AGENT_SOURCE.indexOf('async function failManagedSession'),
  AGENT_SOURCE.indexOf('async function postSessionCommandFailure')
);
assert(
  /diagnosticDeliveryError/.test(failManagedSessionSource)
    && /terminalDeliveryError\.retryCommand\s*=\s*true/.test(failManagedSessionSource),
  'a diagnostic delivery failure must not skip terminal state, and failed terminal delivery must retry the command'
);
assert(
  /local_agent_process_identity_unverified/.test(RELAY_SOURCE),
  'recovered local Agents must fail closed when Relay lacks authoritative ChildProcess identity'
);
const pollLoopSource = AGENT_SOURCE.slice(
  AGENT_SOURCE.indexOf('async function pollCommandsLoop'),
  AGENT_SOURCE.indexOf('async function discoveryLoop')
);
assert(
  /acknowledgeCommandsBeforeShutdown/.test(pollLoopSource)
    && pollLoopSource.indexOf('acknowledgeCommandsBeforeShutdown')
      < pollLoopSource.indexOf('processPolledCommand(command'),
  'Agent must durably ack successful earlier commands before processing host.shutdown'
);
const finalAckSource = AGENT_SOURCE.slice(
  AGENT_SOURCE.indexOf('async function acknowledgeCommandsBeforeShutdown'),
  AGENT_SOURCE.indexOf('async function pollCommandsLoop')
);
assert(
  /after=\$\{Number\.MAX_SAFE_INTEGER\}/.test(finalAckSource)
    && /managedAgentRequestHeaders\(\)/.test(finalAckSource),
  'the pre-shutdown final ack must be authenticated and must not fetch/process later commands'
);
const sessionStopSource = AGENT_SOURCE.slice(
  AGENT_SOURCE.indexOf("if (command.type === 'session.stop')"),
  AGENT_SOURCE.indexOf('async function postCommandFailure')
);
assert(
  /stopRunnerOnce\(runner/.test(sessionStopSource)
    && /stopError\.retryCommand\s*=\s*true/.test(sessionStopSource),
  'session.stop must share Host shutdown cleanup and stay durable when it fails'
);
const managedStartSource = AGENT_SOURCE.slice(
  AGENT_SOURCE.indexOf('async function startManagedSession'),
  AGENT_SOURCE.indexOf('async function handleCommand')
);
const startedPostIndex = managedStartSource.indexOf('await postEvent(buildManagedSessionStartedEvent');
assert(
  startedPostIndex >= 0
    && managedStartSource.indexOf('managedSessionStartGate.isShuttingDown()', startedPostIndex) > startedPostIndex
    && /shutdownTerminalDelivery/.test(managedStartSource),
  'managed Session startup must recheck the shutdown gate after publishing started and preserve terminal retry failures'
);
const eventPostSource = AGENT_SOURCE.slice(
  AGENT_SOURCE.indexOf('async function postAgentEventPayload'),
  AGENT_SOURCE.indexOf('async function postEvent')
);
assert(
  /const headers = managedAgentRequestHeaders\(\)/.test(eventPostSource)
    && /headers,/.test(eventPostSource),
  'Relay-managed Agents must attest ownership on every event batch request'
);
assert(
  /batchId\s*=\s*String\(options\.batchId/.test(AGENT_SOURCE)
    && /event:\$\{HOST_ID\}:\$\{makeId\(\)\}/.test(AGENT_SOURCE),
  'Agent event retries must reuse a stable idempotency key for each POST call'
);
assert(
  /sendSingle:\s*\(event\)\s*=>\s*postEvent\(event,\s*\{\s*\.\.\.options,\s*batchId:\s*''\s*\}\)/.test(AGENT_SOURCE),
  'legacy batch fallback must allocate a distinct idempotency key per single event'
);
assert(
  /expectedRelayInstanceId/.test(AGENT_SOURCE)
    && /lastCommandId\s*=\s*0/.test(
      AGENT_SOURCE.slice(
        AGENT_SOURCE.indexOf('async function pollCommandsLoop'),
        AGENT_SOURCE.indexOf('async function discoveryLoop')
      )
    ),
  'command polling must stop processing a batch when the Relay epoch changes'
);
assert(
  /partialAgentEventBatches/.test(RELAY_SOURCE)
    && /rememberPartialAgentEventBatch/.test(RELAY_SOURCE),
  'Relay event retries must resume a partially applied batch at the failed event'
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localAgentIsolationEnvironment(stateRoot) {
  const agentStateRoot = path.join(stateRoot, 'agent-state');
  return {
    RELAY_LOCAL_AGENT_START_ENABLED: 'true',
    RELAY_LOCAL_HOST_ID: 'relay-managed-agent-test-local',
    REMOTE_CODEX_STATE_ROOT: agentStateRoot,
    AGENTS_HOME: path.join(agentStateRoot, 'agents'),
    CC_SWITCH_HOME: path.join(agentStateRoot, 'cc-switch'),
    SKILL_ARTIFACT_TEMP_ROOT: path.join(agentStateRoot, 'skill-artifact-temp'),
  };
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
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
        try {
          resolve({ statusCode: response.statusCode || 0, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(new Error(`invalid JSON response: ${error.message}\n${text}`));
        }
      });
    });
    request.setTimeout(7000, () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError || new Error('timed out waiting for condition');
}

async function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode != null) return;
  child.kill(signal);
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(3000).then(() => false),
  ]);
  if (!exited && child.exitCode == null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(3000),
    ]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processProbe(pid) {
  try {
    process.kill(Number(pid), 0);
    return 'alive';
  } catch (error) {
    return `${error?.code || 'error'}:${error?.message || error}`;
  }
}

function forceKillTree(pid) {
  if (!Number(pid) || !processAlive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(Number(pid), 'SIGKILL');
  } catch (_) {
    // Best-effort test cleanup.
  }
}

function findOwnershipMarker(stateRoot, hostId) {
  const markerRoot = path.join(stateRoot, 'local-agents');
  for (const name of fs.readdirSync(markerRoot)) {
    if (!name.endsWith('.owner.json')) continue;
    const markerPath = path.join(markerRoot, name);
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (marker?.hostId === hostId) return { marker, markerPath };
    } catch (_) {
      // Ignore incomplete markers while the managed Agent is starting.
    }
  }
  return null;
}

function ownershipHeaders(marker, overrides = {}) {
  return {
    'X-Remote-Codex-Agent-Managed': '1',
    'X-Remote-Codex-Agent-Pid': String(marker.pid),
    'X-Remote-Codex-Agent-Instance': String(marker.instanceId),
    'X-Remote-Codex-Agent-Token': String(marker.ownershipToken),
    ...overrides,
  };
}

async function main() {
  const port = await getOpenPort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-graceful-'));
  const output = [];
  const agentPids = new Set();
  const spawnRelay = () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        RELAY_STATE_ROOT: tempRoot,
        ...localAgentIsolationEnvironment(tempRoot),
        RELAY_AUTH_DISABLED: 'true',
        RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
        RELAY_LOCAL_AGENT_SHUTDOWN_GRACE_MS: '3000',
        LOCAL_AGENT_MANAGED_COMMAND: 'demo',
        LOCAL_AGENT_AUTO_START_SESSION: 'false',
        POLL_INTERVAL_MS: '1000',
        CODEX_TAIL_ENABLED: 'false',
        LOCAL_CODEX_HOME: path.join(tempRoot, 'codex-home'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
    return child;
  };
  let relay = spawnRelay();

  try {
    await waitFor(async () => {
      if (relay.exitCode != null) throw new Error(`Relay exited early: ${relay.exitCode}`);
      const health = await requestJson(port, 'GET', '/health');
      return health.statusCode === 200 && health.body?.ok;
    });

    const started = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'start',
      label: 'Graceful local agent test',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    await waitFor(async () => {
      const hosts = await requestJson(port, 'GET', '/api/hosts');
      return (hosts.body?.hosts || []).some((host) => (
        host.hostId === HOST_ID && host.lastSeenAt
      ));
    }, 15000);

    const beforeRestart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'status',
    });
    const firstPid = beforeRestart.body?.localAgent?.pid;
    agentPids.add(Number(firstPid));
    assert(Number(firstPid) > 0, JSON.stringify(beforeRestart.body));

    const ownedMarker = findOwnershipMarker(tempRoot, HOST_ID);
    assert(ownedMarker, `ownership marker missing for ${HOST_ID}`);
    const eventSessionId = `event-attestation-${Date.now()}`;
    const mixedSessionId = `${eventSessionId}-mixed`;
    const discoveryEvent = (hostId, sessionId) => ({
      type: 'session.discovery',
      hostId,
      sessions: [{
        sessionId,
        title: sessionId,
        cwd: ROOT,
        source: 'managed',
        live: false,
        updatedAt: new Date().toISOString(),
        transcriptPreview: [],
      }],
    });
    const retryableBatchId = `event-attestation-retry-${Date.now()}`;
    const retryableDiscoveryEvent = discoveryEvent(HOST_ID, eventSessionId);
    const missingAttestationEvent = await requestJson(port, 'POST', '/api/agent/events', {
      batchId: retryableBatchId,
      events: [retryableDiscoveryEvent],
    });
    assert.strictEqual(missingAttestationEvent.statusCode, 409, JSON.stringify(missingAttestationEvent.body));
    assert.strictEqual(missingAttestationEvent.body?.code, 'local_agent_ownership_required');
    const wrongAttestationEvent = await requestJson(
      port,
      'POST',
      '/api/agent/events',
      {
        batchId: retryableBatchId,
        events: [retryableDiscoveryEvent],
      },
      ownershipHeaders(ownedMarker.marker, {
        'X-Remote-Codex-Agent-Token': 'wrong-event-token',
      })
    );
    assert.strictEqual(wrongAttestationEvent.statusCode, 409, JSON.stringify(wrongAttestationEvent.body));
    assert.strictEqual(wrongAttestationEvent.body?.code, 'local_agent_ownership_mismatch');
    const mixedHostBatch = await requestJson(
      port,
      'POST',
      '/api/agent/events',
      {
        batchId: `event-attestation-mixed-${Date.now()}`,
        events: [
          discoveryEvent(HOST_ID, mixedSessionId),
          discoveryEvent('other-event-host', `${mixedSessionId}-other`),
        ],
      },
      ownershipHeaders(ownedMarker.marker)
    );
    assert.strictEqual(mixedHostBatch.statusCode, 400, JSON.stringify(mixedHostBatch.body));
    const missingHostBatch = await requestJson(
      port,
      'POST',
      '/api/agent/events',
      { events: [{ type: 'session.discovery', sessions: [] }] },
      ownershipHeaders(ownedMarker.marker)
    );
    assert.strictEqual(missingHostBatch.statusCode, 400, JSON.stringify(missingHostBatch.body));
    const sessionsBeforeAuthorizedEvent = await requestJson(
      port,
      'GET',
      `/api/hosts/${HOST_ID}/sessions?full=1`
    );
    assert(
      !(sessionsBeforeAuthorizedEvent.body?.sessions || []).some((session) => (
        session.sessionId === eventSessionId || session.sessionId === mixedSessionId
      )),
      'rejected managed event batches must not apply any event'
    );
    const authorizedEvent = await requestJson(
      port,
      'POST',
      '/api/agent/events',
      {
        batchId: retryableBatchId,
        events: [retryableDiscoveryEvent],
      },
      ownershipHeaders(ownedMarker.marker)
    );
    assert.strictEqual(authorizedEvent.statusCode, 200, JSON.stringify(authorizedEvent.body));
    assert.strictEqual(authorizedEvent.body?.duplicate, false, JSON.stringify(authorizedEvent.body));
    const authorizedReplay = await requestJson(
      port,
      'POST',
      '/api/agent/events',
      {
        batchId: retryableBatchId,
        events: [retryableDiscoveryEvent],
      },
      ownershipHeaders(ownedMarker.marker)
    );
    assert.strictEqual(authorizedReplay.statusCode, 200, JSON.stringify(authorizedReplay.body));
    assert.strictEqual(authorizedReplay.body?.duplicate, true, JSON.stringify(authorizedReplay.body));
    const sessionsAfterAuthorizedEvent = await requestJson(
      port,
      'GET',
      `/api/hosts/${HOST_ID}/sessions?full=1`
    );
    assert(
      (sessionsAfterAuthorizedEvent.body?.sessions || []).some((session) => session.sessionId === eventSessionId),
      'correct managed event attestation must apply the batch after earlier rejected attempts'
    );

    const synchronizedProbe = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/probe`, {});
    assert.strictEqual(synchronizedProbe.statusCode, 200, JSON.stringify(synchronizedProbe.body));
    assert.strictEqual(
      synchronizedProbe.body?.mode,
      'active',
      'the ordering test must first synchronize with the Agent command poll loop'
    );
    const earlierProbePromise = requestJson(port, 'POST', `/api/hosts/${HOST_ID}/probe`, {});
    await delay(75);
    const restarted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'restart',
      label: 'Graceful local agent test',
    });
    assert.strictEqual(restarted.statusCode, 200, JSON.stringify(restarted.body));
    assert.strictEqual(restarted.body?.command?.type, 'host.shutdown');
    assert.strictEqual(restarted.body?.status, 'restarting');
    const earlierProbe = await earlierProbePromise;
    assert.strictEqual(earlierProbe.statusCode, 200, JSON.stringify(earlierProbe.body));
    assert.strictEqual(
      earlierProbe.body?.mode,
      'active',
      'host.shutdown must not skip an earlier durable command in the same poll batch'
    );
    const afterRestart = await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
        action: 'status',
      });
      const localAgent = status.body?.localAgent;
      return localAgent?.status === 'running'
        && localAgent?.restartCount === 1
        && Number(localAgent?.pid) > 0
        && Number(localAgent.pid) !== Number(firstPid)
        ? status
        : null;
    }, 15000);
    assert.strictEqual(afterRestart.body?.localAgent?.desiredState, 'running');
    const restartedPid = afterRestart.body?.localAgent?.pid;
    agentPids.add(Number(restartedPid));
    await delay(1500);
    const stableRestart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'status',
    });
    assert.strictEqual(stableRestart.body?.localAgent?.status, 'running');
    assert.strictEqual(
      stableRestart.body?.localAgent?.pid,
      restartedPid,
      'the acknowledged shutdown command must not terminate the replacement Agent'
    );

    const stopped = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'stop',
    });
    assert.strictEqual(stopped.statusCode, 200, JSON.stringify(stopped.body));
    assert.strictEqual(stopped.body?.command?.type, 'host.shutdown');
    await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
        action: 'status',
      });
      return status.body?.localAgent?.status === 'stopped'
        && status.body?.localAgent?.pid == null;
    }, 10000);
    assert.strictEqual(
      output.join('').includes('graceful shutdown timed out'),
      false,
      output.join('')
    );
    const ordinaryRemoteEvent = await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.discovery',
        hostId: HOST_ID,
        sessions: [],
      },
    });
    assert.strictEqual(
      ordinaryRemoteEvent.statusCode,
      200,
      'a dead historical local-Agent record must not require ownership from an ordinary remote Agent'
    );

    const hostsBeforeRecoveryStart = await requestJson(port, 'GET', '/api/hosts');
    const lastSeenBeforeRecoveryStart = (hostsBeforeRecoveryStart.body?.hosts || [])
      .find((host) => host.hostId === HOST_ID)?.lastSeenAt || null;
    const recoveryStart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'start',
      label: 'Graceful local agent test',
    });
    assert.strictEqual(recoveryStart.statusCode, 200, JSON.stringify(recoveryStart.body));
    const recoveredPid = Number(recoveryStart.body?.localAgent?.pid);
    agentPids.add(recoveredPid);
    await waitFor(async () => {
      const hosts = await requestJson(port, 'GET', '/api/hosts');
      return (hosts.body?.hosts || []).some((host) => (
        host.hostId === HOST_ID
        && host.lastSeenAt
        && host.lastSeenAt !== lastSeenBeforeRecoveryStart
      ));
    }, 15000);

    await stopChild(relay, 'SIGKILL');
    assert.strictEqual(
      processAlive(recoveredPid),
      true,
      `Relay crash should not silently lose the live Agent process: ${JSON.stringify({
        recoveredPid,
        probe: processProbe(recoveredPid),
        startStatus: recoveryStart.body?.status,
        localAgent: recoveryStart.body?.localAgent,
      })}`
    );
    relay = spawnRelay();
    await waitFor(async () => {
      if (relay.exitCode != null) throw new Error(`replacement Relay exited early: ${relay.exitCode}`);
      const health = await requestJson(port, 'GET', '/health');
      return health.statusCode === 200 && health.body?.ok;
    });
    const replacementHostsBeforeAgent = await requestJson(port, 'GET', '/api/hosts');
    const replacementLastSeenBeforeAgent = (replacementHostsBeforeAgent.body?.hosts || [])
      .find((host) => host.hostId === HOST_ID)?.lastSeenAt || null;
    await waitFor(async () => {
      const hosts = await requestJson(port, 'GET', '/api/hosts');
      return (hosts.body?.hosts || []).some((host) => (
        host.hostId === HOST_ID
        && host.lastSeenAt
        && host.lastSeenAt !== replacementLastSeenBeforeAgent
      ));
    }, 15000);
    await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
        action: 'status',
      });
      return status.body?.localAgent?.status === 'running'
        && Number(status.body?.localAgent?.pid) === recoveredPid
        ? status
        : null;
    }, 15000);

    const adopted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'start',
      label: 'Graceful local agent test',
    });
    if (adopted.body?.localAgent?.pid) agentPids.add(Number(adopted.body.localAgent.pid));
    assert.strictEqual(adopted.statusCode, 200, JSON.stringify(adopted.body));
    assert.strictEqual(adopted.body?.status, 'already_running', JSON.stringify(adopted.body));
    assert.strictEqual(Number(adopted.body?.localAgent?.pid), recoveredPid, JSON.stringify(adopted.body));

    const timeoutCountBeforeRecoveryRestart = (output.join('').match(/graceful shutdown timed out/g) || []).length;
    const recoveryRestart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
      action: 'restart',
      label: 'Graceful local agent test',
    });
    assert.strictEqual(recoveryRestart.body?.command?.type, 'host.shutdown');
    const recoveredRestart = await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, {
        action: 'status',
      });
      const pid = Number(status.body?.localAgent?.pid);
      return status.body?.localAgent?.status === 'running' && pid > 0 && pid !== recoveredPid
        ? status
        : null;
    }, 15000);
    agentPids.add(Number(recoveredRestart.body.localAgent.pid));
    assert.strictEqual(processAlive(recoveredPid), false, 'replacement must wait for the recovered Agent to exit');
    assert.strictEqual(
      (output.join('').match(/graceful shutdown timed out/g) || []).length,
      timeoutCountBeforeRecoveryRestart,
      'a recovered Agent must reset its command cursor and consume graceful shutdown from the replacement Relay'
    );
    const missingAttestation = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: 'duplicate without ownership attestation',
    });
    assert.strictEqual(missingAttestation.statusCode, 409, JSON.stringify(missingAttestation.body));
    assert.strictEqual(missingAttestation.body?.code, 'local_agent_ownership_required');

    await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, { action: 'stop' });
    await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/local-agent`, { action: 'status' });
      return status.body?.localAgent?.status === 'stopped' && status.body?.localAgent?.pid == null;
    }, 10000);

    const collidingHostIds = [
      'marker-a/b',
      'marker-a?b',
      'marker-a-b',
      'marker-case',
      'MARKER-CASE',
    ];
    for (const collidingHostId of collidingHostIds) {
      const markerStart = await requestJson(
        port,
        'POST',
        `/api/hosts/${encodeURIComponent(collidingHostId)}/local-agent`,
        { action: 'start', label: collidingHostId }
      );
      assert.strictEqual(markerStart.statusCode, 200, JSON.stringify(markerStart.body));
      assert.notStrictEqual(markerStart.body?.status, 'ownership_error', JSON.stringify(markerStart.body));
      agentPids.add(Number(markerStart.body?.localAgent?.pid));
    }
    const collidingMarkers = fs.readdirSync(path.join(tempRoot, 'local-agents'))
      .filter((name) => name.endsWith('.owner.json'))
      .map((name) => ({
        name,
        marker: JSON.parse(fs.readFileSync(path.join(tempRoot, 'local-agents', name), 'utf8')),
      }))
      .filter((entry) => collidingHostIds.includes(entry.marker.hostId));
    assert.deepStrictEqual(
      collidingMarkers.map((entry) => entry.marker.hostId).sort(),
      collidingHostIds.slice().sort(),
      'each colliding Host ID must retain its own ownership marker'
    );
    assert.strictEqual(
      new Set(collidingMarkers.map((entry) => entry.name.toLowerCase())).size,
      collidingHostIds.length,
      'ownership marker basenames must remain unique on case-insensitive filesystems'
    );
    for (const collidingHostId of collidingHostIds) {
      await requestJson(
        port,
        'POST',
        `/api/hosts/${encodeURIComponent(collidingHostId)}/local-agent`,
        { action: 'stop' }
      );
    }
    await waitFor(async () => {
      const statuses = await Promise.all(collidingHostIds.map((collidingHostId) => requestJson(
        port,
        'POST',
        `/api/hosts/${encodeURIComponent(collidingHostId)}/local-agent`,
        { action: 'status' }
      )));
      return statuses.every((status) => (
        status.body?.localAgent?.status === 'stopped'
        && status.body?.localAgent?.pid == null
      ));
    }, 15000);

    const unclaimedHostId = 'unclaimed-live-marker-test';
    const unclaimed = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    unclaimed.unref();
    agentPids.add(Number(unclaimed.pid));
    const ownerRoot = path.join(tempRoot, 'local-agents');
    fs.mkdirSync(ownerRoot, { recursive: true });
    fs.writeFileSync(path.join(ownerRoot, `${unclaimedHostId}.owner.json`), `${JSON.stringify({
      kind: 'remote-codex-local-agent-owner',
      version: 1,
      hostId: unclaimedHostId,
      pid: unclaimed.pid,
      instanceId: 'unclaimed-instance',
      ownershipToken: 'unclaimed-token',
      ownerRelayPid: 999999,
      relayUrl: `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const unclaimedRestart = await requestJson(port, 'POST', `/api/hosts/${unclaimedHostId}/local-agent`, {
      action: 'restart',
    });
    assert.strictEqual(unclaimedRestart.body?.status, 'ownership_pending', JSON.stringify(unclaimedRestart.body));
    assert.strictEqual(processAlive(unclaimed.pid), true, 'unverified marker PID must never be killed');
    const unclaimedStart = await requestJson(port, 'POST', `/api/hosts/${unclaimedHostId}/local-agent`, {
      action: 'start',
    });
    assert.strictEqual(unclaimedStart.body?.status, 'ownership_pending', JSON.stringify(unclaimedStart.body));
    const queuedForOwnedAgent = await requestJson(port, 'POST', `/api/hosts/${unclaimedHostId}/import`, {});
    assert.strictEqual(queuedForOwnedAgent.statusCode, 200, JSON.stringify(queuedForOwnedAgent.body));
    const unauthenticatedPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${unclaimedHostId}&after=0&ack=999`
    );
    assert.strictEqual(unauthenticatedPoll.statusCode, 409, JSON.stringify(unauthenticatedPoll.body));
    assert.strictEqual(unauthenticatedPoll.body?.code, 'local_agent_ownership_required');
    const wrongPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${unclaimedHostId}&after=0&ack=999`,
      null,
      {
        'X-Remote-Codex-Agent-Managed': '1',
        'X-Remote-Codex-Agent-Pid': String(unclaimed.pid),
        'X-Remote-Codex-Agent-Instance': 'unclaimed-instance',
        'X-Remote-Codex-Agent-Token': 'wrong-token',
      }
    );
    assert.strictEqual(wrongPoll.statusCode, 409, JSON.stringify(wrongPoll.body));
    assert.strictEqual(wrongPoll.body?.code, 'local_agent_ownership_mismatch');
    const verifiedPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${unclaimedHostId}&after=0&ack=0`,
      null,
      {
        'X-Remote-Codex-Agent-Managed': '1',
        'X-Remote-Codex-Agent-Pid': String(unclaimed.pid),
        'X-Remote-Codex-Agent-Instance': 'unclaimed-instance',
        'X-Remote-Codex-Agent-Token': 'unclaimed-token',
      }
    );
    assert.strictEqual(verifiedPoll.statusCode, 200, JSON.stringify(verifiedPoll.body));
    assert(
      (verifiedPoll.body?.commands || []).some((command) => command.type === 'host.import'),
      'rejected ownership polls must not ack/drain the command queue'
    );
    const unclaimedWithoutAttestation = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: unclaimedHostId,
      label: 'unclaimed plain duplicate',
    });
    assert.strictEqual(unclaimedWithoutAttestation.statusCode, 409, JSON.stringify(unclaimedWithoutAttestation.body));
    assert.strictEqual(unclaimedWithoutAttestation.body?.code, 'local_agent_ownership_required');

    const mismatchedRegistration = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: unclaimedHostId,
      label: unclaimedHostId,
      agentProcess: {
        relayManaged: true,
        pid: unclaimed.pid,
        parentPid: process.pid,
        instanceId: 'unclaimed-instance',
        ownershipToken: 'wrong-token',
        relayUrl: `http://127.0.0.1:${port}`,
      },
    });
    assert.strictEqual(mismatchedRegistration.statusCode, 409, JSON.stringify(mismatchedRegistration.body));
    assert.strictEqual(mismatchedRegistration.body?.code, 'local_agent_ownership_mismatch');
    const mismatchedHeartbeat = await requestJson(port, 'POST', '/api/agent/heartbeat', {
      hostId: unclaimedHostId,
      agentProcess: {
        relayManaged: true,
        pid: unclaimed.pid,
        instanceId: 'different-instance',
        ownershipToken: 'unclaimed-token',
        relayUrl: `http://127.0.0.1:${port}`,
      },
    });
    assert.strictEqual(mismatchedHeartbeat.statusCode, 409, JSON.stringify(mismatchedHeartbeat.body));
    assert.strictEqual(mismatchedHeartbeat.body?.code, 'local_agent_ownership_mismatch');
    assert.strictEqual(processAlive(unclaimed.pid), true, 'mismatched attestation must not affect its PID');
    console.log('local-agent graceful shutdown assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(relay);
    for (const pid of agentPids) forceKillTree(pid);
  }
}

async function testOwnershipRevocationSuppressesStaleEvents() {
  const port = await getOpenPort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-ownership-revoked-'));
  const output = [];
  const hostId = 'ownership-revoked-terminal-test';
  let agentPid = null;
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      ...localAgentIsolationEnvironment(tempRoot),
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_LOCAL_AGENT_SHUTDOWN_GRACE_MS: '3000',
      LOCAL_AGENT_AUTO_START_SESSION: 'true',
      LOCAL_AGENT_MANAGED_COMMAND: 'demo',
      MANAGED_CWD: ROOT,
      POLL_INTERVAL_MS: '100',
      DISCOVERY_INTERVAL_MS: '60000',
      CODEX_TAIL_ENABLED: 'false',
      LOCAL_CODEX_HOME: path.join(tempRoot, 'codex-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitFor(async () => {
      if (relay.exitCode != null) throw new Error(`Relay exited early: ${relay.exitCode}`);
      const health = await requestJson(port, 'GET', '/health');
      return health.statusCode === 200 && health.body?.ok;
    });
    const started = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
      action: 'start',
      label: 'Ownership revoked terminal test',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    agentPid = Number(started.body?.localAgent?.pid);
    assert(agentPid > 0, JSON.stringify(started.body));

    const liveSession = await waitFor(async () => {
      const sessions = await requestJson(port, 'GET', `/api/hosts/${hostId}/sessions?full=1`);
      return (sessions.body?.sessions || []).find((session) => session.live === true) || null;
    }, 15000);
    const ownedMarker = findOwnershipMarker(tempRoot, hostId);
    assert(ownedMarker, `ownership marker missing for ${hostId}`);
    const { marker, markerPath } = ownedMarker;
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ...marker,
      ownershipToken: `revoked-${Date.now()}`,
    }, null, 2)}\n`);

    await waitFor(() => !processAlive(agentPid), 15000);
    const sessionsAfterRevocation = await requestJson(
      port,
      'GET',
      `/api/hosts/${hostId}/sessions?full=1`
    );
    const sessionAfterRevocation = (sessionsAfterRevocation.body?.sessions || [])
      .find((session) => session.sessionId === liveSession.sessionId);
    assert(sessionAfterRevocation, JSON.stringify(sessionsAfterRevocation.body));
    assert.strictEqual(
      sessionAfterRevocation.live,
      true,
      'an ownership-revoked old Agent must not publish stale terminal Session state'
    );
    console.log('local-agent ownership-revocation assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(relay);
    forceKillTree(agentPid);
  }
}

async function testUnreachedShutdownPreservesEarlierCommands() {
  const port = await getOpenPort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-exact-shutdown-ack-'));
  const output = [];
  const hostId = 'exact-shutdown-command-test';
  let agentPid = null;
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      ...localAgentIsolationEnvironment(tempRoot),
      RELAY_AUTH_DISABLED: 'true',
      RELAY_TEST_CONTROL_ENABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_LOCAL_AGENT_SHUTDOWN_GRACE_MS: '10000',
      RELAY_LOCAL_AGENT_FORCE_EXIT_WAIT_MS: '3000',
      LOCAL_AGENT_AUTO_START_SESSION: 'false',
      LOCAL_AGENT_MANAGED_COMMAND: 'demo',
      POLL_INTERVAL_MS: '60000',
      CODEX_TAIL_ENABLED: 'false',
      LOCAL_CODEX_HOME: path.join(tempRoot, 'codex-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitFor(async () => {
      if (relay.exitCode != null) throw new Error(`Relay exited early: ${relay.exitCode}`);
      const health = await requestJson(port, 'GET', '/health');
      return health.statusCode === 200 && health.body?.ok;
    });
    const stagedHost = await requestJson(port, 'POST', '/api/agent/register', {
      hostId,
      label: 'Exact shutdown command test',
      platform: process.platform,
      capabilities: { hostProbe: true },
    });
    assert.strictEqual(stagedHost.statusCode, 200, JSON.stringify(stagedHost.body));
    const synchronizedProbePromise = requestJson(port, 'POST', `/api/hosts/${hostId}/probe`, {});
    await delay(50);
    const started = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
      action: 'start',
      label: 'Exact shutdown command test',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    agentPid = Number(started.body?.localAgent?.pid);
    assert(agentPid > 0, JSON.stringify(started.body));
    const synchronizedProbe = await synchronizedProbePromise;
    assert.strictEqual(synchronizedProbe.body?.mode, 'active', JSON.stringify(synchronizedProbe.body));

    const earlier = await requestJson(port, 'POST', `/api/hosts/${hostId}/import`, {});
    assert.strictEqual(earlier.statusCode, 200, JSON.stringify(earlier.body));
    const stopped = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
      action: 'stop',
    });
    assert.strictEqual(stopped.body?.command?.type, 'host.shutdown', JSON.stringify(stopped.body));
    const ownedMarker = findOwnershipMarker(tempRoot, hostId);
    assert(ownedMarker, `ownership marker missing for ${hostId}`);
    fs.writeFileSync(ownedMarker.markerPath, `${JSON.stringify({
      ...ownedMarker.marker,
      ownershipToken: `revoked-before-shutdown-${Date.now()}`,
    }, null, 2)}\n`);
    let lastStopStatus = null;
    try {
      await waitFor(async () => {
        lastStopStatus = await requestJson(
          port,
          'POST',
          `/api/hosts/${hostId}/local-agent`,
          { action: 'status' }
        );
        return lastStopStatus.body?.localAgent?.status === 'stopped'
          && lastStopStatus.body?.localAgent?.pid == null;
      }, 10000);
    } catch (error) {
      error.message += `\nLast local Agent status: ${JSON.stringify(lastStopStatus?.body)}`;
      throw error;
    }

    const pending = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${hostId}&after=0&ack=0`
    );
    const pendingIds = (pending.body?.commands || []).map((command) => Number(command.id));
    assert(
      pendingIds.includes(Number(earlier.body?.command?.id)),
      'Agent exit before reaching shutdown must preserve an earlier unacknowledged durable command'
    );
    assert(
      !pendingIds.includes(Number(stopped.body?.command?.id)),
      'forced Agent exit must remove only its targeted host.shutdown command'
    );
    console.log('local-agent exact shutdown command assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(relay);
    forceKillTree(agentPid);
  }
}

async function testRelayStaysAliveWhenAgentTreeCannotBeKilled() {
  if (process.platform !== 'win32') {
    console.log('local-agent force-kill failure assertion skipped outside Windows');
    return;
  }
  const port = await getOpenPort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-force-failure-'));
  const output = [];
  const hostId = 'force-kill-failure-test';
  let agentPid = null;
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAY_LOCAL_AGENT_TASKKILL_PATH: path.join(tempRoot, 'missing-taskkill.exe'),
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      ...localAgentIsolationEnvironment(tempRoot),
      RELAY_AUTH_DISABLED: 'true',
      RELAY_TEST_CONTROL_ENABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_LOCAL_AGENT_SHUTDOWN_GRACE_MS: '1000',
      RELAY_LOCAL_AGENT_FORCE_EXIT_WAIT_MS: '250',
      LOCAL_AGENT_AUTO_START_SESSION: 'false',
      LOCAL_AGENT_MANAGED_COMMAND: 'demo',
      POLL_INTERVAL_MS: '60000',
      CODEX_TAIL_ENABLED: 'false',
      LOCAL_CODEX_HOME: path.join(tempRoot, 'codex-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitFor(async () => {
      if (relay.exitCode != null) throw new Error(`Relay exited early: ${relay.exitCode}`);
      const health = await requestJson(port, 'GET', '/health');
      return health.statusCode === 200 && health.body?.ok;
    });
    const stagedHost = await requestJson(port, 'POST', '/api/agent/register', {
      hostId,
      label: 'Force kill failure test',
      platform: process.platform,
      capabilities: { hostProbe: true },
    });
    assert.strictEqual(stagedHost.statusCode, 200, JSON.stringify(stagedHost.body));
    const synchronizedProbePromise = requestJson(port, 'POST', `/api/hosts/${hostId}/probe`, {});
    await delay(50);
    const started = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
      action: 'start',
      label: 'Force kill failure test',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    agentPid = Number(started.body?.localAgent?.pid);
    assert(agentPid > 0, JSON.stringify(started.body));
    const synchronizedProbe = await synchronizedProbePromise;
    assert.strictEqual(synchronizedProbe.body?.mode, 'active', JSON.stringify(synchronizedProbe.body));

    relay.send({ type: 'remote-codex:test:shutdown' });
    await delay(5000);
    assert.strictEqual(
      relay.exitCode ?? relay.signalCode,
      null,
      'Relay must remain alive when a managed Agent process tree cannot be confirmed dead'
    );
    assert.strictEqual(
      processAlive(agentPid),
      true,
      'the fixture must leave the Agent alive so launcher/service fallback can kill the full tree'
    );
    const lateRegistration = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: 'late-shutdown-registration',
      label: 'late shutdown registration',
      agentProcess: {
        relayManaged: true,
        pid: process.pid,
        instanceId: 'late-instance',
        ownershipToken: 'late-token',
        relayUrl: `http://127.0.0.1:${port}`,
      },
    });
    assert.strictEqual(lateRegistration.statusCode, 409, JSON.stringify(lateRegistration.body));
    assert.strictEqual(lateRegistration.body?.code, 'local_agent_ownership_mismatch');
    console.log('relay force-kill failure assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    forceKillTree(agentPid);
    await stopChild(relay);
  }
}

async function testRelayJoinsLateManagedAgent() {
  const port = await getOpenPort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-late-shutdown-'));
  const executableFixtureRoot = path.join(ROOT, 'tmp');
  fs.mkdirSync(executableFixtureRoot, { recursive: true });
  const fixtureRoot = fs.mkdtempSync(path.join(executableFixtureRoot, 'local-agent-late-join-'));
  const output = [];
  const hostId = 'shutdown-snapshot-anchor';
  const lateHostId = 'late-shutdown-managed-agent';
  const lateReadyPath = path.join(fixtureRoot, 'late-ready');
  const lateReleasePath = path.join(fixtureRoot, 'late-release');
  const lateFixturePath = path.join(fixtureRoot, 'late-agent.js');
  fs.writeFileSync(lateFixturePath, [
    "const fs = require('fs');",
    'fs.writeFileSync(process.argv[2], String(process.pid));',
    'const timer = setInterval(() => {',
    '  if (!fs.existsSync(process.argv[3])) return;',
    '  clearInterval(timer);',
    '  process.exit(0);',
    '}, 25);',
    '',
  ].join('\n'));

  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      ...localAgentIsolationEnvironment(tempRoot),
      RELAY_AUTH_DISABLED: 'true',
      RELAY_TEST_CONTROL_ENABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_LOCAL_AGENT_SHUTDOWN_GRACE_MS: '8000',
      RELAY_LOCAL_AGENT_FORCE_EXIT_WAIT_MS: '3000',
      LOCAL_AGENT_AUTO_START_SESSION: 'false',
      LOCAL_AGENT_MANAGED_COMMAND: 'demo',
      POLL_INTERVAL_MS: '5000',
      DISCOVERY_INTERVAL_MS: '60000',
      CODEX_TAIL_ENABLED: 'false',
      LOCAL_CODEX_HOME: path.join(tempRoot, 'codex-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  let anchorAgentPid = null;
  let lateAgent = null;

  try {
    await waitFor(async () => {
      if (relay.exitCode != null) throw new Error(`Relay exited early: ${relay.exitCode}`);
      const health = await requestJson(port, 'GET', '/health');
      return health.statusCode === 200 && health.body?.ok;
    });
    const started = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
      action: 'start',
      label: 'Shutdown snapshot anchor',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    anchorAgentPid = Number(started.body?.localAgent?.pid);
    assert(anchorAgentPid > 0, JSON.stringify(started.body));
    await waitFor(async () => {
      const hosts = await requestJson(port, 'GET', '/api/hosts');
      return (hosts.body?.hosts || []).some((host) => host.hostId === hostId && host.lastSeenAt);
    }, 20000);
    const synchronizedProbe = await requestJson(port, 'POST', `/api/hosts/${hostId}/probe`, {});
    assert.strictEqual(synchronizedProbe.body?.mode, 'active', JSON.stringify(synchronizedProbe.body));

    relay.send({ type: 'remote-codex:test:shutdown' });
    await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
        action: 'status',
      });
      return status.body?.localAgent?.status === 'stopping';
    }, 3000);

    lateAgent = spawn(process.execPath, [lateFixturePath, lateReadyPath, lateReleasePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    lateAgent.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
    lateAgent.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
    await waitFor(() => {
      if (lateAgent.exitCode != null) {
        throw new Error(`late fixture exited before ready with code ${lateAgent.exitCode}`);
      }
      return fs.existsSync(lateReadyPath);
    }, 5000);
    const lateInstanceId = `late-instance-${Date.now()}`;
    const lateOwnershipToken = `late-token-${Date.now()}`;
    const markerRoot = path.join(tempRoot, 'local-agents');
    const markerPath = path.join(markerRoot, `${lateHostId}.owner.json`);
    fs.mkdirSync(markerRoot, { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      kind: 'remote-codex-local-agent-owner',
      version: 1,
      hostId: lateHostId,
      pid: lateAgent.pid,
      instanceId: lateInstanceId,
      ownershipToken: lateOwnershipToken,
      ownerRelayPid: relay.pid,
      relayUrl: `http://127.0.0.1:${port}`,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    const lateRegistration = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: lateHostId,
      label: 'Late managed Agent',
      agentProcess: {
        relayManaged: true,
        pid: lateAgent.pid,
        parentPid: relay.pid,
        instanceId: lateInstanceId,
        ownershipToken: lateOwnershipToken,
        relayUrl: `http://127.0.0.1:${port}`,
        startedAt: new Date().toISOString(),
      },
    });
    assert.strictEqual(lateRegistration.statusCode, 409, JSON.stringify(lateRegistration.body));
    assert.strictEqual(lateRegistration.body?.code, 'local_agent_ownership_mismatch');

    await waitFor(() => !processAlive(anchorAgentPid), 15000);
    await delay(250);
    assert.strictEqual(processAlive(lateAgent.pid), true, 'late fixture must still be alive');
    assert.strictEqual(
      relay.exitCode ?? relay.signalCode,
      null,
      'Relay must join a valid managed Agent that appears after the shutdown snapshot'
    );

    fs.writeFileSync(lateReleasePath, 'release');
    await waitFor(() => !processAlive(lateAgent.pid), 5000);
    await waitFor(() => relay.exitCode != null || relay.signalCode != null, 10000);
    console.log('relay late managed-Agent shutdown join assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(lateAgent, 'SIGKILL');
    forceKillTree(anchorAgentPid);
    await stopChild(relay);
  }
}

async function testForcedProcessTreeShutdown() {
  const port = await getOpenPort();
  const executableFixtureRoot = path.join(ROOT, 'tmp');
  fs.mkdirSync(executableFixtureRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(executableFixtureRoot, 'local-agent-force-tree-'));
  const fixturePath = path.join(tempRoot, 'managed-child.js');
  const managedPidPath = path.join(tempRoot, 'managed-child.pid');
  fs.writeFileSync(fixturePath, [
    "const fs = require('fs');",
    'fs.writeFileSync(process.argv[2], String(process.pid));',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  const output = [];
  const cleanupPids = new Set();
  let lastReplacementStatus = null;
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      ...localAgentIsolationEnvironment(tempRoot),
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_LOCAL_AGENT_SHUTDOWN_GRACE_MS: '1000',
      RELAY_LOCAL_AGENT_FORCE_EXIT_WAIT_MS: '3000',
      LOCAL_AGENT_AUTO_START_SESSION: 'true',
      LOCAL_AGENT_MANAGED_COMMAND: process.execPath,
      MANAGED_ARGS_JSON: JSON.stringify([fixturePath, managedPidPath]),
      POLL_INTERVAL_MS: '60000',
      CODEX_TAIL_ENABLED: 'false',
      LOCAL_CODEX_HOME: path.join(tempRoot, 'codex-home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  const hostId = 'forced-process-tree-test';
  try {
    await waitFor(async () => {
      if (relay.exitCode != null) throw new Error(`Relay exited early: ${relay.exitCode}`);
      const health = await requestJson(port, 'GET', '/health');
      return health.statusCode === 200 && health.body?.ok;
    });
    const started = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
      action: 'start',
      label: 'Forced process tree test',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    const oldAgentPid = Number(started.body?.localAgent?.pid);
    cleanupPids.add(oldAgentPid);
    await waitFor(async () => {
      const hosts = await requestJson(port, 'GET', '/api/hosts');
      return (hosts.body?.hosts || []).some((host) => host.hostId === hostId && host.lastSeenAt);
    }, 30000);
    await waitFor(() => fs.existsSync(managedPidPath), 30000);
    const oldManagedPid = Number(fs.readFileSync(managedPidPath, 'utf8').trim());
    cleanupPids.add(oldManagedPid);
    assert(processAlive(oldAgentPid) && processAlive(oldManagedPid), 'Agent and managed child must be live before fallback');
    await delay(500);

    const restarted = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, {
      action: 'restart',
      label: 'Forced process tree test',
    });
    assert.strictEqual(restarted.body?.command?.type, 'host.shutdown');
    const replacement = await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, { action: 'status' });
      lastReplacementStatus = status;
      const pid = Number(status.body?.localAgent?.pid);
      return status.body?.localAgent?.status === 'running' && pid > 0 && pid !== oldAgentPid
        ? status
        : null;
    }, 15000);
    cleanupPids.add(Number(replacement.body.localAgent.pid));
    assert.strictEqual(processAlive(oldAgentPid), false, 'forced replacement must wait for old Agent exit');
    assert.strictEqual(processAlive(oldManagedPid), false, 'forced Agent shutdown must terminate its managed child tree');

    await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, { action: 'stop' });
    await waitFor(async () => {
      const status = await requestJson(port, 'POST', `/api/hosts/${hostId}/local-agent`, { action: 'status' });
      return status.body?.localAgent?.status === 'stopped' && status.body?.localAgent?.pid == null;
    }, 10000);
    console.log('local-agent forced process-tree assertions passed');
  } catch (error) {
    if (lastReplacementStatus) {
      error.message += `\nLast replacement status:\n${JSON.stringify(lastReplacementStatus.body, null, 2)}`;
    }
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(relay);
    for (const pid of cleanupPids) forceKillTree(pid);
  }
}

const selectedScenario = String(process.argv[2] || '').trim();
const testRun = selectedScenario === 'core'
  ? Promise.resolve().then(main)
  : selectedScenario === 'forced-tree'
  ? Promise.resolve().then(testForcedProcessTreeShutdown)
  : selectedScenario === 'late-shutdown'
    ? Promise.resolve().then(testRelayJoinsLateManagedAgent)
  : main()
    .then(testOwnershipRevocationSuppressesStaleEvents)
    .then(testUnreachedShutdownPreservesEarlierCommands)
    .then(testRelayStaysAliveWhenAgentTreeCannotBeKilled)
    .then(testForcedProcessTreeShutdown);

testRun
  .catch((error) => {
  console.error(error);
  process.exitCode = 1;
  });
