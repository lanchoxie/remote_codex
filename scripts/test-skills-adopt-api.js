const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createSkillArtifactArchive } = require('../shared/skill-artifact');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'adopt-host';

function instanceDigest(instanceId) {
  return crypto.createHash('sha256').update(String(instanceId || '')).digest('hex');
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

function request(port, method, pathname, body = null, headers = {}) {
  const payload = body == null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(Buffer.isBuffer(body) ? {} : body == null ? {} : { 'Content-Type': 'application/json' }),
        ...(payload.length ? { 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (error) {
          reject(new Error(`invalid JSON response (${res.statusCode}): ${error.message}\n${text.slice(0, 1000)}`));
          return;
        }
        resolve({ statusCode: res.statusCode || 0, body: parsed });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload.length) {
      req.write(payload);
    }
    req.end();
  });
}

function observeLibraryEvent(port, trigger) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    let triggerPromise = null;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('timed out waiting for skills.library.updated')), 10000);
    const stream = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: '/api/skills/events',
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      assert.strictEqual(res.statusCode, 200);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n\n')) {
          const boundary = buffer.indexOf('\n\n');
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split('\n');
          const eventName = lines.find((line) => line.startsWith('event: '))?.slice(7) || '';
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6) || '{}';
          if (eventName === 'ready' && !triggerPromise) {
            triggerPromise = Promise.resolve().then(trigger);
            triggerPromise.catch((error) => finish(error));
          } else if (eventName === 'skills.library.updated') {
            Promise.resolve(triggerPromise).then((triggerResult) => finish(null, {
              payload: JSON.parse(data),
              triggerResult,
            }), (error) => finish(error));
          }
        }
      });
    });
    stream.on('error', (error) => {
      if (!settled && error.code !== 'ECONNRESET') {
        finish(error);
      }
    });
    stream.end();
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
    SKILL_ARTIFACT_MAX_UPLOAD_BYTES: String(1024 * 1024),
    SKILL_MAX_ACTIVE_ADOPTIONS: '1',
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
      const response = await request(port, 'GET', '/health');
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

function writeSkill(root) {
  const skillRoot = path.join(root, 'fixture-skill');
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: Fixture Skill\ndescription: Adopt API fixture\n---\n');
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(skillRoot, 'assets', 'data.bin'), Buffer.from([0, 2, 4, 8]));
  return skillRoot;
}

function makeInstance(artifact, overrides = {}) {
  const skillId = overrides.skillId || 'fixture-skill';
  const scope = overrides.scope || 'user';
  const sourceId = overrides.sourceId || `local-host:${HOST_ID}:C:/skills/${skillId}`;
  return {
    instanceId: JSON.stringify([HOST_ID, skillId, scope, scope, sourceId]),
    hostId: HOST_ID,
    skillId,
    name: overrides.name || 'Fixture Skill',
    description: overrides.description || 'Adopt API fixture',
    scope,
    scopeId: scope,
    cwd: null,
    sourceId,
    sourceKind: overrides.sourceKind || 'local-host',
    sourceLocator: overrides.sourceLocator || `C:/skills/${skillId}`,
    sourceRef: null,
    sourcePath: null,
    activationPath: `C:/skills/${skillId}`,
    realPath: `C:/skills/${skillId}`,
    observedHash: artifact.contentHash,
    enabled: true,
    effective: true,
    managed: false,
    readonly: Boolean(overrides.readonly),
    state: 'enabled',
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-adopt-api-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-adopt-fixture-'));
  const port = await getOpenPort();
  let relay = null;
  try {
    const archivePath = path.join(fixtureRoot, 'fixture.rcskill');
    const artifact = await createSkillArtifactArchive(writeSkill(fixtureRoot), archivePath);
    const archiveBuffer = fs.readFileSync(archivePath);
    const primary = makeInstance(artifact);
    const readonly = makeInstance(artifact, { skillId: 'readonly-skill', readonly: true, scope: 'system' });
    const failure = makeInstance(artifact, { skillId: 'failure-skill' });

    relay = await startRelay(port, tempRoot);
    const registered = await request(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: HOST_ID,
      platform: 'test',
      codexHome: 'C:/codex',
      capabilities: {
        hostSkillInventoryV2: true,
        hostSkillArtifactsV1: true,
      },
    });
    assert.strictEqual(registered.statusCode, 200);
    const inventory = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.inventory',
        hostId: HOST_ID,
        revision: `sha256:${'a'.repeat(64)}`,
        scannedAt: '2026-07-13T00:00:00.000Z',
        instances: [primary, readonly, failure],
        scanErrors: [],
      },
    });
    assert.strictEqual(inventory.statusCode, 200, JSON.stringify(inventory.body));

    const unknown = await request(port, 'POST', '/api/skills/adopt', {
      hostId: HOST_ID,
      instanceId: 'unknown-instance',
    });
    assert.strictEqual(unknown.statusCode, 404);
    const blocked = await request(port, 'POST', '/api/skills/adopt', {
      hostId: HOST_ID,
      instanceId: readonly.instanceId,
    });
    assert.strictEqual(blocked.statusCode, 409);

    const queued = await request(port, 'POST', '/api/skills/adopt', {
      hostId: HOST_ID,
      instanceId: primary.instanceId,
    });
    assert.strictEqual(queued.statusCode, 202, JSON.stringify(queued.body));
    assert.strictEqual(queued.body?.state, 'queued');
    const adoptionId = queued.body.adoptionId;
    assert(adoptionId);

    const concurrencyBlocked = await request(port, 'POST', '/api/skills/adopt', {
      hostId: HOST_ID,
      instanceId: failure.instanceId,
    });
    assert.strictEqual(concurrencyBlocked.statusCode, 429);
    assert.match(concurrencyBlocked.body?.error || '', /adoption|in progress/i);

    const commands = await request(port, 'GET', `/api/agent/commands?hostId=${HOST_ID}&after=0`);
    const exportCommand = commands.body?.commands?.find((item) => item.type === 'host.skills.artifact.export');
    assert(exportCommand, JSON.stringify(commands.body));
    assert.strictEqual(exportCommand.adoptionId, adoptionId);
    assert.strictEqual(exportCommand.instanceId, primary.instanceId);
    assert.strictEqual(exportCommand.expectedHash, artifact.contentHash);
    assert(exportCommand.uploadToken);

    const wrongToken = await request(port, 'PUT', exportCommand.uploadPath, archiveBuffer, {
      'Content-Type': 'application/vnd.remote-codex.skill-artifact',
      'X-Remote-Codex-Upload-Token': 'wrong-token',
      'X-Remote-Codex-Host-Id': HOST_ID,
      'X-Remote-Codex-Instance-Digest': instanceDigest(primary.instanceId),
    });
    assert.strictEqual(wrongToken.statusCode, 403);

    const observed = await observeLibraryEvent(port, () => request(
      port,
      'PUT',
      exportCommand.uploadPath,
      archiveBuffer,
      {
        'Content-Type': 'application/vnd.remote-codex.skill-artifact',
        'X-Remote-Codex-Upload-Token': exportCommand.uploadToken,
        'X-Remote-Codex-Host-Id': HOST_ID,
        'X-Remote-Codex-Instance-Digest': instanceDigest(primary.instanceId),
      }
    ));
    assert.strictEqual(observed.triggerResult.statusCode, 201, JSON.stringify(observed.triggerResult.body));
    assert.strictEqual(observed.triggerResult.body?.artifactId, artifact.contentHash);
    assert.strictEqual(observed.payload.adoptionId, adoptionId);
    assert.strictEqual(observed.payload.hostId, HOST_ID);
    assert.strictEqual(observed.payload.skillId, primary.skillId);
    assert.strictEqual(observed.payload.state, 'completed');

    const status = await request(port, 'GET', `/api/skills/adoptions/${encodeURIComponent(adoptionId)}`);
    assert.strictEqual(status.statusCode, 200);
    assert.strictEqual(status.body?.adoption?.state, 'completed');
    assert.strictEqual(status.body?.adoption?.artifactId, artifact.contentHash);

    const duplicate = await request(port, 'PUT', exportCommand.uploadPath, archiveBuffer, {
      'Content-Type': 'application/vnd.remote-codex.skill-artifact',
      'X-Remote-Codex-Upload-Token': exportCommand.uploadToken,
      'X-Remote-Codex-Host-Id': HOST_ID,
      'X-Remote-Codex-Instance-Digest': instanceDigest(primary.instanceId),
    });
    assert.strictEqual(duplicate.statusCode, 409);

    const payload = await request(port, 'GET', '/api/skills');
    assert.strictEqual(payload.statusCode, 200);
    assert(payload.body?.artifacts?.some((item) => item.artifactId === artifact.contentHash));
    assert(payload.body?.skillLibrary?.some((item) => (
      item.skillId === primary.skillId && item.latestArtifactId === artifact.contentHash
    )));

    const failedQueued = await request(port, 'POST', '/api/skills/adopt', {
      hostId: HOST_ID,
      instanceId: failure.instanceId,
    });
    assert.strictEqual(failedQueued.statusCode, 202);
    const failedEvent = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.artifact.result',
        hostId: HOST_ID,
        adoptionId: failedQueued.body.adoptionId,
        instanceId: failure.instanceId,
        ok: false,
        error: 'simulated Host packaging failure',
      },
    });
    assert.strictEqual(failedEvent.statusCode, 200);
    const failedStatus = await request(
      port,
      'GET',
      `/api/skills/adoptions/${encodeURIComponent(failedQueued.body.adoptionId)}`
    );
    assert.strictEqual(failedStatus.body?.adoption?.state, 'failed');
    assert.match(failedStatus.body?.adoption?.error || '', /simulated Host packaging failure/);

    await stopChild(relay.child);
    relay = await startRelay(port, tempRoot);
    const restored = await request(port, 'GET', '/api/skills');
    assert.strictEqual(restored.statusCode, 200);
    assert(restored.body?.artifacts?.some((item) => item.artifactId === artifact.contentHash));
    assert(restored.body?.skillLibrary?.some((item) => item.skillId === primary.skillId));
  } catch (error) {
    if (relay?.output?.length) {
      error.message += `\nRelay output:\n${relay.output.join('').slice(-5000)}`;
    }
    throw error;
  } finally {
    await stopChild(relay?.child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('skills adoption API assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
