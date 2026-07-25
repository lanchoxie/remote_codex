const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'host-agent-lease-test';
const LEGACY_HOST_ID = 'host-agent-lease-legacy-test';
const RELEASE_HOST_ID = 'host-agent-lease-release-test';
const DISMISSED_HOST_ID = 'host-agent-dismiss-persistence-test';
const SESSION_ID = 'host-agent-lease-live-session';
const INSTANCE_A = 'agent-instance-a';
const INSTANCE_B = 'agent-instance-b';

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

function requestJson(port, method, requestPath, body = null, headers = {}) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: requestPath,
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
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode || 0,
          body: raw ? JSON.parse(raw) : null,
        });
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function leaseHeaders(agentInstanceId, leaseId) {
  return {
    'X-Remote-Codex-Agent-Instance': agentInstanceId,
    ...(leaseId ? { 'X-Remote-Codex-Agent-Lease': leaseId } : {}),
  };
}

async function waitForRelay(port, relay) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (relay.exitCode != null) {
      throw new Error(`Relay exited before readiness with code ${relay.exitCode}`);
    }
    try {
      const health = await requestJson(port, 'GET', '/health');
      if (health.statusCode === 200 && health.body?.ok) return;
    } catch (_) {
      // Startup races are expected.
    }
    await delay(50);
  }
  throw new Error('Relay did not become ready');
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3000),
  ]);
}

async function registerAgent(port, hostId, agentInstanceId, capabilities = {}) {
  return requestJson(port, 'POST', '/api/agent/register', {
    hostId,
    agentInstanceId,
    label: hostId,
    platform: process.platform,
    capabilities,
  }, leaseHeaders(agentInstanceId));
}

async function postDiscovery(port, hostId, sessions, headers = {}, suffix = Date.now()) {
  return requestJson(port, 'POST', '/api/agent/events', {
    batchId: `lease-discovery-${hostId}-${suffix}`,
    events: [{
      type: 'session.discovery',
      hostId,
      discoveryId: `lease-snapshot-${hostId}-${suffix}`,
      sessions,
    }],
  }, headers);
}

async function readHost(port, hostId) {
  const response = await requestJson(port, 'GET', '/api/hosts');
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return (response.body?.hosts || []).find((host) => host.hostId === hostId) || null;
}

async function readSession(port, hostId, sessionId) {
  const response = await requestJson(port, 'GET', `/api/hosts/${hostId}/sessions`);
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return (response.body?.sessions || []).find((session) => session.sessionId === sessionId) || null;
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-agent-lease-'));
  const port = await openPort();
  const output = [];
  const relayEnvironment = {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      RELAY_HOST_OFFLINE_AFTER_MS: '500',
      RELAY_HOST_AGENT_LEASE_TTL_MS: '500',
      RELAY_MISSING_MANAGED_DISCOVERY_CONFIRMATION_MS: '1',
  };
  const spawnRelay = () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
      cwd: ROOT,
      env: relayEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
    return child;
  };
  let relay = spawnRelay();

  try {
    await waitForRelay(port, relay);

    const legacyRegistration = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: LEGACY_HOST_ID,
      label: 'Legacy lease test',
      capabilities: { legacyOwner: true },
    });
    assert.strictEqual(legacyRegistration.statusCode, 200, JSON.stringify(legacyRegistration.body));
    assert.strictEqual(legacyRegistration.body?.agentLeaseId, null);
    const legacyDiscovery = await postDiscovery(port, LEGACY_HOST_ID, [{
      sessionId: 'legacy-session',
      nativeThreadId: 'legacy-session',
      title: 'Legacy session',
      source: 'rollout',
      live: false,
      transcriptPreview: [],
    }], {}, 'legacy-before-lease');
    assert.strictEqual(legacyDiscovery.statusCode, 200, JSON.stringify(legacyDiscovery.body));

    const releaseOwnerA = await registerAgent(port, RELEASE_HOST_ID, INSTANCE_A, {
      releaseOwnerA: true,
    });
    assert.strictEqual(releaseOwnerA.statusCode, 200, JSON.stringify(releaseOwnerA.body));
    const releaseLeaseA = String(releaseOwnerA.body?.agentLeaseId || '');
    const releasedA = await requestJson(port, 'POST', '/api/agent/release', {
      hostId: RELEASE_HOST_ID,
      agentInstanceId: INSTANCE_A,
      agentLeaseId: releaseLeaseA,
    }, leaseHeaders(INSTANCE_A, releaseLeaseA));
    assert.strictEqual(releasedA.statusCode, 200, JSON.stringify(releasedA.body));
    assert.strictEqual(releasedA.body?.released, true);
    const releaseOwnerB = await registerAgent(port, RELEASE_HOST_ID, INSTANCE_B, {
      releaseOwnerB: true,
    });
    assert.strictEqual(
      releaseOwnerB.statusCode,
      200,
      `a released lease must permit immediate replacement: ${JSON.stringify(releaseOwnerB.body)}`
    );
    const releaseLeaseB = String(releaseOwnerB.body?.agentLeaseId || '');
    const staleReleaseA = await requestJson(port, 'POST', '/api/agent/release', {
      hostId: RELEASE_HOST_ID,
      agentInstanceId: INSTANCE_A,
      agentLeaseId: releaseLeaseA,
    }, leaseHeaders(INSTANCE_A, releaseLeaseA));
    assert.strictEqual(staleReleaseA.statusCode, 409, JSON.stringify(staleReleaseA.body));
    assert.strictEqual(staleReleaseA.body?.code, 'host_agent_lease_revoked');
    const releaseHostCommand = await requestJson(port, 'POST', `/api/hosts/${RELEASE_HOST_ID}/import`, {});
    const releaseHostPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${RELEASE_HOST_ID}&after=0&ack=0`,
      null,
      leaseHeaders(INSTANCE_B, releaseLeaseB)
    );
    assert.strictEqual(releaseHostPoll.statusCode, 200, JSON.stringify(releaseHostPoll.body));
    assert(
      (releaseHostPoll.body?.commands || []).some((command) => (
        Number(command.id) === Number(releaseHostCommand.body?.command?.id)
      )),
      'a stale release must not remove the replacement owner lease'
    );

    const ownerA = await registerAgent(port, HOST_ID, INSTANCE_A, {
      managedSessions: true,
      ownerA: true,
    });
    assert.strictEqual(ownerA.statusCode, 200, JSON.stringify(ownerA.body));
    const leaseA = String(ownerA.body?.agentLeaseId || '');
    assert(leaseA && leaseA !== INSTANCE_A, 'registration must return an opaque lease ID');

    const duplicateRegistration = await registerAgent(port, HOST_ID, INSTANCE_B, {
      managedSessions: true,
      duplicateOwner: true,
    });
    assert.strictEqual(duplicateRegistration.statusCode, 409, JSON.stringify(duplicateRegistration.body));
    assert.strictEqual(duplicateRegistration.body?.code, 'host_agent_instance_conflict');

    const duplicateHeartbeat = await requestJson(port, 'POST', '/api/agent/heartbeat', {
      hostId: HOST_ID,
      agentInstanceId: INSTANCE_B,
      label: 'duplicate-must-not-win',
      capabilities: { duplicateOwner: true },
    }, leaseHeaders(INSTANCE_B, 'not-the-owner-lease'));
    assert.strictEqual(duplicateHeartbeat.statusCode, 409, JSON.stringify(duplicateHeartbeat.body));
    assert.strictEqual(duplicateHeartbeat.body?.code, 'host_agent_lease_revoked');
    const hostAfterDuplicateHeartbeat = await readHost(port, HOST_ID);
    assert.strictEqual(hostAfterDuplicateHeartbeat?.capabilities?.ownerA, true);
    assert.strictEqual(hostAfterDuplicateHeartbeat?.capabilities?.duplicateOwner, undefined);

    const queued = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/import`, {});
    assert.strictEqual(queued.statusCode, 200, JSON.stringify(queued.body));
    const commandId = Number(queued.body?.command?.id || 0);
    assert(commandId > 0, JSON.stringify(queued.body));
    const duplicateAck = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${HOST_ID}&after=0&ack=${commandId}`,
      null,
      leaseHeaders(INSTANCE_B, 'not-the-owner-lease')
    );
    assert.strictEqual(duplicateAck.statusCode, 409, JSON.stringify(duplicateAck.body));
    const ownerPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${HOST_ID}&after=0&ack=0`,
      null,
      leaseHeaders(INSTANCE_A, leaseA)
    );
    assert.strictEqual(ownerPoll.statusCode, 200, JSON.stringify(ownerPoll.body));
    assert(
      (ownerPoll.body?.commands || []).some((command) => Number(command.id) === commandId),
      'duplicate ACK must not remove the owner command'
    );

    const liveSession = {
      sessionId: SESSION_ID,
      nativeThreadId: SESSION_ID,
      title: 'Lease-owned live Session',
      cwd: ROOT,
      source: 'managed',
      live: true,
      updatedAt: new Date().toISOString(),
      transcriptPreview: [],
    };
    const ownerDiscovery = await postDiscovery(
      port,
      HOST_ID,
      [liveSession],
      leaseHeaders(INSTANCE_A, leaseA),
      'owner-live'
    );
    assert.strictEqual(ownerDiscovery.statusCode, 200, JSON.stringify(ownerDiscovery.body));
    assert.strictEqual((await readSession(port, HOST_ID, SESSION_ID))?.live, true);
    for (const suffix of ['duplicate-empty-1', 'duplicate-empty-2']) {
      const duplicateDiscovery = await postDiscovery(
        port,
        HOST_ID,
        [],
        leaseHeaders(INSTANCE_B, 'not-the-owner-lease'),
        suffix
      );
      assert.strictEqual(duplicateDiscovery.statusCode, 409, JSON.stringify(duplicateDiscovery.body));
      assert.strictEqual(duplicateDiscovery.body?.code, 'host_agent_lease_revoked');
    }
    assert.strictEqual(
      (await readSession(port, HOST_ID, SESSION_ID))?.live,
      true,
      'a duplicate Agent discovery must not close the owner live Session'
    );

    const versionedLegacyHost = await registerAgent(port, LEGACY_HOST_ID, 'legacy-upgrade-instance', {
      versionedOwner: true,
    });
    assert.strictEqual(versionedLegacyHost.statusCode, 200, JSON.stringify(versionedLegacyHost.body));
    const rejectedLegacyEvent = await postDiscovery(
      port,
      LEGACY_HOST_ID,
      [],
      {},
      'legacy-after-lease'
    );
    assert.strictEqual(rejectedLegacyEvent.statusCode, 409, JSON.stringify(rejectedLegacyEvent.body));
    assert.strictEqual(rejectedLegacyEvent.body?.code, 'host_agent_lease_required');
    const rejectedLegacyHeartbeat = await requestJson(port, 'POST', '/api/agent/heartbeat', {
      hostId: LEGACY_HOST_ID,
      label: 'legacy-must-not-overwrite',
      capabilities: { legacyOverwrite: true },
    });
    assert.strictEqual(rejectedLegacyHeartbeat.statusCode, 409, JSON.stringify(rejectedLegacyHeartbeat.body));
    assert.strictEqual((await readHost(port, LEGACY_HOST_ID))?.capabilities?.legacyOverwrite, undefined);

    await delay(650);
    const ownerB = await registerAgent(port, HOST_ID, INSTANCE_B, {
      managedSessions: true,
      ownerB: true,
    });
    assert.strictEqual(ownerB.statusCode, 200, JSON.stringify(ownerB.body));
    const leaseB = String(ownerB.body?.agentLeaseId || '');
    assert(leaseB && leaseB !== leaseA, 'takeover must issue a new opaque lease');

    const staleOwnerHeartbeat = await requestJson(port, 'POST', '/api/agent/heartbeat', {
      hostId: HOST_ID,
      agentInstanceId: INSTANCE_A,
      label: 'stale-owner-a',
      capabilities: { staleOwnerA: true },
    }, leaseHeaders(INSTANCE_A, leaseA));
    assert.strictEqual(staleOwnerHeartbeat.statusCode, 409, JSON.stringify(staleOwnerHeartbeat.body));
    assert.strictEqual(staleOwnerHeartbeat.body?.code, 'host_agent_lease_revoked');
    const hostAfterTakeover = await readHost(port, HOST_ID);
    assert.strictEqual(hostAfterTakeover?.capabilities?.ownerB, true);
    assert.strictEqual(hostAfterTakeover?.capabilities?.staleOwnerA, undefined);

    const takeoverCommand = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/import`, {});
    const takeoverCommandId = Number(takeoverCommand.body?.command?.id || 0);
    const staleAck = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${HOST_ID}&after=0&ack=${takeoverCommandId}`,
      null,
      leaseHeaders(INSTANCE_A, leaseA)
    );
    assert.strictEqual(staleAck.statusCode, 409, JSON.stringify(staleAck.body));
    const ownerBPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${HOST_ID}&after=0&ack=0`,
      null,
      leaseHeaders(INSTANCE_B, leaseB)
    );
    assert.strictEqual(ownerBPoll.statusCode, 200, JSON.stringify(ownerBPoll.body));
    assert(
      (ownerBPoll.body?.commands || []).some((command) => Number(command.id) === takeoverCommandId),
      'expired-lease takeover owner must retain the command after a stale ACK attempt'
    );

    const dismissedOwner = await registerAgent(port, DISMISSED_HOST_ID, INSTANCE_A, {
      dismissOwner: true,
    });
    assert.strictEqual(dismissedOwner.statusCode, 200, JSON.stringify(dismissedOwner.body));
    const staleDismissCommand = await requestJson(
      port,
      'POST',
      `/api/hosts/${DISMISSED_HOST_ID}/import`,
      {}
    );
    const staleDismissCommandId = Number(staleDismissCommand.body?.command?.id || 0);
    const dismissed = await requestJson(port, 'DELETE', `/api/hosts/${DISMISSED_HOST_ID}`);
    assert.strictEqual(dismissed.statusCode, 200, JSON.stringify(dismissed.body));
    const dismissedHeartbeat = await requestJson(port, 'POST', '/api/agent/heartbeat', {
      hostId: DISMISSED_HOST_ID,
      agentInstanceId: INSTANCE_A,
      label: 'dismissed-owner',
    }, leaseHeaders(INSTANCE_A, dismissedOwner.body?.agentLeaseId));
    assert.strictEqual(dismissedHeartbeat.statusCode, 200, JSON.stringify(dismissedHeartbeat.body));
    assert.strictEqual(dismissedHeartbeat.body?.dismissed, true);
    assert.strictEqual(dismissedHeartbeat.body?.shutdown, true);

    const durableEventBatch = await postDiscovery(
      port,
      HOST_ID,
      [liveSession],
      leaseHeaders(INSTANCE_B, leaseB),
      'durable-across-restart'
    );
    assert.strictEqual(durableEventBatch.statusCode, 200, JSON.stringify(durableEventBatch.body));

    await stopChild(relay);
    relay = spawnRelay();
    await waitForRelay(port, relay);
    const dismissedAfterRestart = await registerAgent(
      port,
      DISMISSED_HOST_ID,
      INSTANCE_A,
      { shouldRemainDismissed: true }
    );
    assert.strictEqual(dismissedAfterRestart.statusCode, 200, JSON.stringify(dismissedAfterRestart.body));
    assert.strictEqual(
      dismissedAfterRestart.body?.dismissed,
      true,
      'dismissed Host state must survive a Relay restart'
    );
    const restoredDismissedHost = await requestJson(
      port,
      'POST',
      `/api/hosts/${DISMISSED_HOST_ID}/import`,
      {}
    );
    assert.strictEqual(restoredDismissedHost.statusCode, 200, JSON.stringify(restoredDismissedHost.body));
    const restoredOwner = await registerAgent(port, DISMISSED_HOST_ID, INSTANCE_A, {
      restoredOwner: true,
    });
    assert.strictEqual(restoredOwner.statusCode, 200, JSON.stringify(restoredOwner.body));
    const restoredPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${DISMISSED_HOST_ID}&after=0&ack=0`,
      null,
      leaseHeaders(INSTANCE_A, restoredOwner.body?.agentLeaseId)
    );
    const restoredCommandIds = (restoredPoll.body?.commands || []).map((command) => Number(command.id));
    assert(
      restoredCommandIds.includes(Number(restoredDismissedHost.body?.command?.id)),
      'restoring a dismissed Host must enqueue one fresh import command'
    );
    assert(
      !restoredCommandIds.includes(staleDismissCommandId),
      'restoring a dismissed Host must not replay commands queued before dismissal'
    );
    const pollBeforeRelayRecovery = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${HOST_ID}&after=0&ack=0`,
      null,
      leaseHeaders(INSTANCE_B, leaseB)
    );
    assert.strictEqual(pollBeforeRelayRecovery.statusCode, 409, JSON.stringify(pollBeforeRelayRecovery.body));
    assert.strictEqual(pollBeforeRelayRecovery.body?.code, 'host_agent_registration_required');
    const recoveredHeartbeat = await requestJson(port, 'POST', '/api/agent/heartbeat', {
      hostId: HOST_ID,
      agentInstanceId: INSTANCE_B,
      label: 'owner-b-after-relay-restart',
      capabilities: { ownerBAfterRelayRestart: true },
    }, leaseHeaders(INSTANCE_B, leaseB));
    assert.strictEqual(recoveredHeartbeat.statusCode, 200, JSON.stringify(recoveredHeartbeat.body));
    const recoveredLeaseB = String(recoveredHeartbeat.body?.agentLeaseId || '');
    assert(
      recoveredLeaseB && recoveredLeaseB !== leaseB,
      'the first heartbeat after a Relay restart must acquire the new Relay epoch lease'
    );
    const recoveredPoll = await requestJson(
      port,
      'GET',
      `/api/agent/commands?hostId=${HOST_ID}&after=0&ack=0`,
      null,
      leaseHeaders(INSTANCE_B, recoveredLeaseB)
    );
    assert.strictEqual(recoveredPoll.statusCode, 200, JSON.stringify(recoveredPoll.body));
    const durableEventReplay = await postDiscovery(
      port,
      HOST_ID,
      [liveSession],
      leaseHeaders(INSTANCE_B, recoveredLeaseB),
      'durable-across-restart'
    );
    assert.strictEqual(durableEventReplay.statusCode, 200, JSON.stringify(durableEventReplay.body));
    assert.strictEqual(
      durableEventReplay.body?.duplicate,
      true,
      'Agent event batch dedupe must survive a Relay restart'
    );
  } catch (error) {
    if (output.length) error.message += `\nRelay output:\n${output.join('').slice(-5000)}`;
    throw error;
  } finally {
    await stopChild(relay);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('host-agent instance lease assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
