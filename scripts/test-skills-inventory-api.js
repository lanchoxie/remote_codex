const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_IDS = ['inventory-host-a', 'inventory-host-b', 'inventory-host-c'];

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
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            statusCode: response.statusCode || 0,
            body: text ? JSON.parse(text) : null,
          });
        } catch (error) {
          reject(new Error(`invalid JSON response: ${error.message}`));
        }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('relay request timed out')));
    request.on('error', reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function observeSkillsInventoryUpdate(port, trigger) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let triggerResult = null;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new Error('timed out waiting for skills inventory SSE')), 5000);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: '/api/skills/events',
      headers: { Accept: 'text/event-stream' },
    }, (response) => {
      assert.strictEqual(response.statusCode, 200);
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n\n')) {
          const boundary = buffer.indexOf('\n\n');
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split('\n');
          const eventName = lines.find((line) => line.startsWith('event: '))?.slice(7) || '';
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6) || '{}';
          if (eventName === 'ready' && !triggerResult) {
            triggerResult = Promise.resolve().then(trigger);
            triggerResult.catch((error) => finish(error));
          } else if (eventName === 'skills.inventory.updated') {
            Promise.resolve(triggerResult).then((result) => {
              finish(null, { payload: JSON.parse(data), triggerResult: result });
            }, (error) => finish(error));
          }
        }
      });
      response.on('error', (error) => finish(error));
    });
    request.on('error', (error) => {
      if (!settled && error.code !== 'ECONNRESET') {
        finish(error);
      }
    });
    request.end();
  });
}

function relayEnvironment(port, tempRoot) {
  return {
    ...process.env,
    PORT: String(port),
    RELAY_STATE_ROOT: tempRoot,
    RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_LOCAL_HOST_STUB: 'false',
    SESSION_COLLECTIONS_PATH: path.join(tempRoot, 'session-collections.json'),
    SESSION_METADATA_PATH: path.join(tempRoot, 'session-metadata.json'),
    SESSION_RECORD_STORE_ROOT: path.join(tempRoot, 'session-record-store'),
    SESSION_LOGS_PATH: path.join(tempRoot, 'session-logs.json'),
    SESSION_DIAGNOSTICS_PATH: path.join(tempRoot, 'session-diagnostics.json'),
    SKILL_FAVORITES_PATH: path.join(tempRoot, 'skill-favorites.json'),
    SKILL_SOURCES_PATH: path.join(tempRoot, 'skill-sources.json'),
    SKILL_LIBRARY_PATH: path.join(tempRoot, 'skill-library.json'),
    SKILL_INVENTORIES_PATH: path.join(tempRoot, 'skill-inventories.json'),
    SKILL_REGISTRY_PATH: path.join(tempRoot, 'skill-registry.json'),
    SKILL_ARTIFACT_ROOT: path.join(tempRoot, 'skill-artifacts'),
    SKILL_DEPLOYMENTS_PATH: path.join(tempRoot, 'skill-deployments.json'),
    RELAY_AUTH_TOKEN_PATH: path.join(tempRoot, 'relay-auth-token.txt'),
    RELAY_AUTH_ACCOUNT_PATH: path.join(tempRoot, 'relay-auth-account.json'),
  };
}

async function waitForRelay(port, child) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`relay exited before readiness with code ${child.exitCode}`);
    }
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('relay did not become ready');
}

async function startRelay(port, tempRoot) {
  const output = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnvironment(port, tempRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  try {
    await waitForRelay(port, child);
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('').slice(-4000)}`;
    throw error;
  }
  return { child, output };
}

async function stopChild(child) {
  if (!child || child.exitCode != null) {
    return;
  }
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function registerHosts(port) {
  for (const hostId of HOST_IDS) {
    const registered = await requestJson(port, 'POST', '/api/agent/register', {
      hostId,
      label: hostId,
      platform: 'test',
      codexHome: `/codex/${hostId}`,
      skillsRevision: null,
      capabilities: {
        hostSkills: true,
        hostSkillInventoryV2: true,
      },
    });
    assert.strictEqual(registered.statusCode, 200);
    const discovered = await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.discovery',
        hostId,
        sessions: [{
          sessionId: `${hostId}-session`,
          title: hostId,
          cwd: `/workspace/${hostId}`,
          live: false,
        }],
      },
    });
    assert.strictEqual(discovered.statusCode, 200);
  }
}

function fixtureInstance() {
  return {
    instanceId: 'inventory-host-a|project|/workspace/inventory-host-a|github:owner/repo:main:skills/fixture/SKILL.md|fixture|/workspace/inventory-host-a/.agents/skills/fixture',
    hostId: 'inventory-host-a',
    skillId: 'fixture',
    name: 'Fixture Skill',
    description: 'Inventory API fixture',
    scope: 'project',
    scopeId: '/workspace/inventory-host-a',
    cwd: '/workspace/inventory-host-a',
    sourceId: 'github:owner/repo:main:skills/fixture/SKILL.md',
    sourceKind: 'github',
    sourceLocator: 'owner/repo',
    sourceRef: 'main',
    sourcePath: 'skills/fixture/SKILL.md',
    activationPath: '/workspace/inventory-host-a/.agents/skills/fixture',
    realPath: '/workspace/inventory-host-a/.agents/skills/fixture',
    observedHash: `sha256:${'a'.repeat(64)}`,
    enabled: true,
    effective: true,
    managed: true,
    desiredArtifactId: `sha256:${'c'.repeat(64)}`,
    readonly: false,
    state: 'enabled',
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-inventory-api-'));
  const port = await getOpenPort();
  let relay = null;
  let measuredCachedMs = null;

  try {
    relay = await startRelay(port, tempRoot);
    await registerHosts(port);

    let initial = null;
    const cachedDurations = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const startedAt = Date.now();
      const response = await requestJson(port, 'GET', '/api/skills');
      const elapsedMs = Date.now() - startedAt;
      initial = initial || response;
      cachedDurations.push(elapsedMs);
      assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
      assert(
        elapsedMs < 500,
        `cached skills payload must not wait for unresponsive hosts; observed ${elapsedMs}ms`
      );
    }
    measuredCachedMs = Math.max(...cachedDurations);
    assert.strictEqual(initial.body?.hosts?.length, 3);
    assert.strictEqual(initial.body?.inventories?.length, 3);
    assert(!initial.body?.installed?.some((item) => String(item.skillId || '').startsWith('host-error-')));

    const observedUpdate = await observeSkillsInventoryUpdate(port, () => requestJson(
      port,
      'POST',
      '/api/agent/events',
      {
        event: {
          type: 'host.skills.inventory',
          hostId: 'inventory-host-a',
          revision: `sha256:${'b'.repeat(64)}`,
          scannedAt: '2026-07-12T00:00:00.000Z',
          instances: [fixtureInstance()],
          scanErrors: [],
        },
      }
    ));
    const inventoryEvent = observedUpdate.triggerResult;
    assert.strictEqual(observedUpdate.payload.hostId, 'inventory-host-a');
    assert.strictEqual(observedUpdate.payload.revision, `sha256:${'b'.repeat(64)}`);
    assert.strictEqual(inventoryEvent.statusCode, 200);

    const populated = await requestJson(port, 'GET', '/api/skills');
    assert.strictEqual(populated.body?.inventories?.find((item) => item.hostId === 'inventory-host-a')?.revision, `sha256:${'b'.repeat(64)}`);
    const managedInstance = populated.body?.instances?.find((item) => item.skillId === 'fixture');
    assert(managedInstance);
    assert.strictEqual(managedInstance.managed, true);
    assert.strictEqual(managedInstance.desiredArtifactId, `sha256:${'c'.repeat(64)}`);

    const invalidInstanceInventory = await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.inventory',
        hostId: 'inventory-host-a',
        revision: `sha256:${'d'.repeat(64)}`,
        scannedAt: '2026-07-12T00:00:01.000Z',
        instances: [{
          ...fixtureInstance(),
          observedHash: 'not-a-digest',
        }],
        scanErrors: [],
      },
    });
    assert.strictEqual(
      invalidInstanceInventory.statusCode,
      409,
      'an inventory with an invalid instance hash must be rejected instead of releasing cached references'
    );
    assert.strictEqual(invalidInstanceInventory.body?.code, 'agent_event_batch_apply_failed');
    assert.strictEqual(invalidInstanceInventory.body?.appliedCount, 0);
    const afterInvalidInstance = await requestJson(port, 'GET', '/api/skills');
    assert.strictEqual(
      afterInvalidInstance.body?.inventories?.find((item) => item.hostId === 'inventory-host-a')?.revision,
      `sha256:${'b'.repeat(64)}`,
      'an invalid instance must retain the last valid inventory'
    );

    const invalidInventory = await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.inventory',
        hostId: 'inventory-host-a',
        revision: 'not-a-digest',
        scannedAt: '2026-07-12T00:00:00.000Z',
        instances: [],
        scanErrors: [],
      },
    });
    assert.strictEqual(invalidInventory.statusCode, 409, 'invalid inventory events must be rejected');
    assert.strictEqual(invalidInventory.body?.code, 'agent_event_batch_apply_failed');
    assert.strictEqual(invalidInventory.body?.appliedCount, 0);
    const afterInvalid = await requestJson(port, 'GET', '/api/skills');
    assert.strictEqual(
      afterInvalid.body?.inventories?.find((item) => item.hostId === 'inventory-host-a')?.revision,
      `sha256:${'b'.repeat(64)}`,
      'an invalid event must retain the last valid inventory'
    );

    const refreshStartedAt = Date.now();
    const refresh = await requestJson(port, 'POST', '/api/skills/refresh', { hostIds: [] });
    const refreshElapsedMs = Date.now() - refreshStartedAt;
    assert.strictEqual(refresh.statusCode, 202, JSON.stringify(refresh.body));
    assert(refreshElapsedMs < 500, `refresh queueing should be non-blocking; observed ${refreshElapsedMs}ms`);
    assert.strictEqual(refresh.body?.hosts?.length, 3);
    assert(refresh.body.hosts.every((host) => host.state === 'queued'));

    for (const hostId of HOST_IDS) {
      const queue = await requestJson(port, 'GET', `/api/agent/commands?hostId=${encodeURIComponent(hostId)}&after=0`);
      const command = queue.body?.commands?.find((item) => item.type === 'host.skills.inventory.refresh');
      assert(command, `missing inventory refresh command for ${hostId}`);
      assert(command.workspaceRoots.includes(`/workspace/${hostId}`));
    }

    await stopChild(relay.child);
    relay = await startRelay(port, tempRoot);
    await registerHosts(port);
    const restored = await requestJson(port, 'GET', '/api/skills');
    assert.strictEqual(restored.statusCode, 200);
    assert.strictEqual(restored.body?.inventories?.find((item) => item.hostId === 'inventory-host-a')?.revision, `sha256:${'b'.repeat(64)}`);
    assert(restored.body?.instances?.some((item) => item.skillId === 'fixture'));
  } catch (error) {
    if (relay?.output?.length) {
      error.message += `\nRelay output:\n${relay.output.join('').slice(-4000)}`;
    }
    throw error;
  } finally {
    await stopChild(relay?.child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`skills inventory API assertions passed (${measuredCachedMs}ms cached GET for 3 hosts)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
