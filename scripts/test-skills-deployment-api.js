const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createSkillArtifactArchive } = require('../shared/skill-artifact');
const { SkillRegistryService } = require('../apps/relay/skill-registry-service');

const ROOT = path.resolve(__dirname, '..');
const AUTH_TOKEN = 'skills-deployment-test-token';
const ONLINE_HOST = 'deployment-online';
const OFFLINE_HOST = 'deployment-offline';
const FAILING_HOST = 'deployment-failing';
const UNRELATED_HOST = 'deployment-unrelated';
const SUPERSEDE_HOST = 'deployment-supersede';
const LEGACY_UPGRADE_HOST = 'deployment-legacy-upgrade';
const PROJECT_HOST = 'deployment-project';

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

function request(port, method, pathname, body = null, options = {}) {
  const jsonBody = body != null && !Buffer.isBuffer(body);
  const payload = body == null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const authenticated = options.authenticated !== false;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
        ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...(payload.length ? { 'Content-Length': payload.length } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '');
        let parsed = buffer;
        if (contentType.includes('application/json')) {
          try {
            parsed = buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
          } catch (error) {
            reject(new Error(`invalid JSON response (${res.statusCode}): ${error.message}`));
            return;
          }
        }
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: parsed,
          buffer,
        });
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

function observeDeploymentEvent(port, trigger) {
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
    const timer = setTimeout(() => finish(new Error('timed out waiting for skills.deployment.updated')), 10000);
    const stream = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'GET',
      path: '/api/skills/events',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
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
          } else if (eventName === 'skills.deployment.updated') {
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
    RELAY_AUTH_DISABLED: 'false',
    RELAY_AUTH_TOKEN: AUTH_TOKEN,
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
    SKILL_DEPLOYMENT_HISTORY_LIMIT: '1',
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
      const response = await request(port, 'GET', '/health', null, { authenticated: false });
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
    error.message += `\nRelay output:\n${output.join('').slice(-5000)}`;
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
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: Fixture Skill',
    'description: Deployment API fixture',
    '---',
    '',
    '# Fixture Skill',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), 'module.exports = true;\n');
  return skillRoot;
}

async function seedRegistry(tempRoot, fixtureRoot) {
  const archivePath = path.join(fixtureRoot, 'fixture.rcskill');
  const artifact = await createSkillArtifactArchive(writeSkill(fixtureRoot), archivePath);
  const registry = new SkillRegistryService({
    registryPath: path.join(tempRoot, 'skill-registry.json'),
    artifactRoot: path.join(tempRoot, 'skill-artifacts'),
  });
  await registry.importArchive(archivePath, {
    skillId: 'fixture-skill',
    name: 'Fixture Skill',
    description: 'Deployment API fixture',
    sourceId: 'local-host:seed:fixture-skill',
    sourceKind: 'local-host',
    sourceLocator: path.join(fixtureRoot, 'fixture-skill'),
    expectedHash: artifact.contentHash,
  });
  return { artifact, archiveBuffer: fs.readFileSync(archivePath) };
}

async function registerHost(port, hostId) {
  return request(port, 'POST', '/api/agent/register', {
    hostId,
    label: hostId,
    platform: 'test',
    codexHome: `/codex/${hostId}`,
    capabilities: {
      hostSkills: true,
      hostSkillInventoryV2: true,
      hostSkillDeploymentV1: true,
    },
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-deployment-api-'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-deployment-fixture-'));
  const port = await getOpenPort();
  let relay = null;
  try {
    const { artifact, archiveBuffer } = await seedRegistry(tempRoot, fixtureRoot);
    relay = await startRelay(port, tempRoot);

    assert.strictEqual((await registerHost(port, ONLINE_HOST)).statusCode, 200);
    assert.strictEqual((await registerHost(port, FAILING_HOST)).statusCode, 200);
    assert.strictEqual((await registerHost(port, UNRELATED_HOST)).statusCode, 200);
    assert.strictEqual((await registerHost(port, SUPERSEDE_HOST)).statusCode, 200);
    assert.strictEqual((await registerHost(port, PROJECT_HOST)).statusCode, 200);

    const legacyRegistration = await request(port, 'POST', '/api/agent/register', {
      hostId: LEGACY_UPGRADE_HOST,
      label: LEGACY_UPGRADE_HOST,
      platform: 'test',
      codexHome: `/codex/${LEGACY_UPGRADE_HOST}`,
      capabilities: {
        hostSkills: true,
        hostSkillInventoryV2: true,
        hostSkillDeploymentV1: false,
      },
    });
    assert.strictEqual(legacyRegistration.statusCode, 200);
    const queuedLegacyAction = request(port, 'POST', '/api/skills/actions', {
      action: 'uninstall',
      hostIds: [LEGACY_UPGRADE_HOST],
      skillIds: ['fixture-skill'],
    }).then((response) => ({ response }), (error) => ({ error }));
    let queuedLegacyCommand = null;
    for (let attempt = 0; attempt < 100 && !queuedLegacyCommand; attempt += 1) {
      const commands = await request(
        port,
        'GET',
        `/api/agent/commands?hostId=${encodeURIComponent(LEGACY_UPGRADE_HOST)}&after=0`
      );
      queuedLegacyCommand = commands.body?.commands?.find((command) => (
        command.type === 'host.skills.uninstall'
      )) || null;
      if (!queuedLegacyCommand) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert(queuedLegacyCommand, 'legacy mutation must be queued before the Host capability upgrade');
    assert.strictEqual((await registerHost(port, LEGACY_UPGRADE_HOST)).statusCode, 200);
    const commandsAfterUpgrade = await request(
      port,
      'GET',
      `/api/agent/commands?hostId=${encodeURIComponent(LEGACY_UPGRADE_HOST)}&after=0`
    );
    assert(
      !commandsAfterUpgrade.body.commands.some((command) => (
        command.type === 'host.skills.install' || command.type === 'host.skills.uninstall'
      )),
      'Phase 3 registration must purge legacy mutation commands queued before the upgrade'
    );
    await request(port, 'POST', '/api/agent/events', {
      type: 'host.skills.result',
      hostId: LEGACY_UPGRADE_HOST,
      requestId: queuedLegacyCommand.requestId,
      action: 'uninstall',
      ok: false,
      results: [{
        ok: false,
        action: 'uninstall',
        hostId: LEGACY_UPGRADE_HOST,
        skillId: 'fixture-skill',
        error: 'legacy mutation purged during capability upgrade',
      }],
    });
    const queuedLegacyActionResult = await queuedLegacyAction;
    assert.ifError(queuedLegacyActionResult.error);
    assert.strictEqual(queuedLegacyActionResult.response.statusCode, 200);

    const legacyBypass = await request(port, 'POST', '/api/skills/actions', {
      action: 'uninstall',
      hostIds: [ONLINE_HOST],
      skillIds: ['fixture-skill'],
    });
    assert.strictEqual(legacyBypass.statusCode, 409);

    const supersededOld = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'superseded-old',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: [SUPERSEDE_HOST],
      targetScope: 'user',
    });
    assert.strictEqual(supersededOld.statusCode, 202);
    const supersededEvent = await observeDeploymentEvent(port, () => request(port, 'POST', '/api/skills/deployments', {
      requestId: 'superseded-new',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'disable',
      targetHostIds: [SUPERSEDE_HOST],
      targetScope: 'user',
    }));
    const supersededNew = supersededEvent.triggerResult;
    assert.strictEqual(supersededNew.statusCode, 202);
    assert.strictEqual(supersededEvent.payload.deploymentId, supersededOld.body.deployment.deploymentId);
    assert.strictEqual(supersededEvent.payload.result?.state, 'superseded');
    const supersedeCommands = await request(
      port,
      'GET',
      `/api/agent/commands?hostId=${encodeURIComponent(SUPERSEDE_HOST)}&after=0`
    );
    assert(!supersedeCommands.body.commands.some((command) => (
      command.type === 'host.skills.deployment.apply'
      && command.deploymentId === supersededOld.body.deployment.deploymentId
    )), 'superseded deployment commands must be removed before Host polling');
    assert(supersedeCommands.body.commands.some((command) => (
      command.type === 'host.skills.deployment.apply'
      && command.deploymentId === supersededNew.body.deployment.deploymentId
    )));

    const missingArtifact = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'missing-artifact',
      skillId: 'fixture-skill',
      artifactId: `sha256:${'0'.repeat(64)}`,
      action: 'enable',
      targetHostIds: [ONLINE_HOST],
      targetScope: 'user',
    });
    assert.strictEqual(missingArtifact.statusCode, 404);

    const reservedHostId = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'reserved-host-id',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: ['__proto__'],
      targetScope: 'user',
    });
    assert.strictEqual(reservedHostId.statusCode, 400);

    const unconfirmedProject = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'unconfirmed-project',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: [ONLINE_HOST],
      targetScope: 'project',
      cwd: '/workspace/project',
      scopeId: '/workspace/project',
      confirmProjectWrite: false,
    });
    assert.strictEqual(unconfirmedProject.statusCode, 400);

    const projectDiscovery = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.discovery',
        hostId: PROJECT_HOST,
        sessions: [{
          sessionId: 'project-workspace-session',
          title: 'Project workspace',
          cwd: '/workspace/project',
          live: false,
          updatedAt: '2026-07-13T12:00:00.000Z',
        }],
      },
    });
    assert.strictEqual(projectDiscovery.statusCode, 200, JSON.stringify(projectDiscovery.body));
    const projectRequest = {
      requestId: 'project-workspace-idempotency',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: [PROJECT_HOST],
      targetScope: 'project',
      cwd: '/workspace/project',
      scopeId: '/workspace/project',
      confirmProjectWrite: true,
    };
    const projectCreated = await request(port, 'POST', '/api/skills/deployments', projectRequest);
    assert.strictEqual(projectCreated.statusCode, 202, JSON.stringify(projectCreated.body));
    const projectHostDeleted = await request(
      port,
      'DELETE',
      `/api/hosts/${encodeURIComponent(PROJECT_HOST)}`
    );
    assert.strictEqual(projectHostDeleted.statusCode, 200, JSON.stringify(projectHostDeleted.body));
    const projectRetry = await request(port, 'POST', '/api/skills/deployments', projectRequest);
    assert.strictEqual(projectRetry.statusCode, 200, JSON.stringify(projectRetry.body));
    assert.strictEqual(projectRetry.body.reused, true);
    assert.strictEqual(
      projectRetry.body.deployment.deploymentId,
      projectCreated.body.deployment.deploymentId
    );
    const changedProjectRetry = await request(port, 'POST', '/api/skills/deployments', {
      ...projectRequest,
      cwd: '/workspace/changed',
      scopeId: '/workspace/changed',
    });
    assert.strictEqual(changedProjectRetry.statusCode, 409, JSON.stringify(changedProjectRetry.body));
    assert.match(changedProjectRetry.body.error, /requestId|different/i);

    const createdEvent = await observeDeploymentEvent(port, () => request(port, 'POST', '/api/skills/deployments', {
      requestId: 'enable-fixture-v1',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: [ONLINE_HOST, OFFLINE_HOST, FAILING_HOST],
      targetScope: 'user',
    }));
    const created = createdEvent.triggerResult;
    assert.strictEqual(created.statusCode, 202, JSON.stringify(created.body));
    assert.strictEqual(created.body?.reused, false);
    const deploymentId = created.body?.deployment?.deploymentId;
    assert(deploymentId);
    assert.strictEqual(createdEvent.payload.deploymentId, deploymentId);
    assert.strictEqual(createdEvent.payload.reason, 'created');
    const initialResults = new Map(created.body.deployment.results.map((result) => [result.hostId, result]));
    assert.strictEqual(initialResults.get(ONLINE_HOST)?.state, 'queued');
    assert.strictEqual(initialResults.get(FAILING_HOST)?.state, 'queued');
    assert.strictEqual(initialResults.get(OFFLINE_HOST)?.state, 'pending');

    const duplicate = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'enable-fixture-v1',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: [ONLINE_HOST, OFFLINE_HOST, FAILING_HOST],
      targetScope: 'user',
    });
    assert.strictEqual(duplicate.statusCode, 200);
    assert.strictEqual(duplicate.body?.reused, true);
    assert.strictEqual(duplicate.body?.deployment?.deploymentId, deploymentId);

    const conflictingDuplicate = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'enable-fixture-v1',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: [ONLINE_HOST],
      targetScope: 'user',
    });
    assert.strictEqual(conflictingDuplicate.statusCode, 409);

    for (const hostId of [ONLINE_HOST, FAILING_HOST]) {
      const commands = await request(port, 'GET', `/api/agent/commands?hostId=${encodeURIComponent(hostId)}&after=0`);
      const command = commands.body?.commands?.find((item) => item.type === 'host.skills.deployment.apply');
      assert(command, JSON.stringify(commands.body));
      assert.strictEqual(command.deploymentId, deploymentId);
      assert.strictEqual(command.skillId, 'fixture-skill');
      assert.strictEqual(command.artifactId, artifact.contentHash);
      assert.strictEqual(command.expectedHash, artifact.contentHash);
      assert.strictEqual(command.downloadPath, `/api/agent/skills/artifacts/${encodeURIComponent(artifact.contentHash)}`);
      assert.strictEqual(command.targetScope, 'user');
    }
    const deliveredDeployment = await request(
      port,
      'GET',
      `/api/skills/deployments/${encodeURIComponent(deploymentId)}`
    );
    const deliveredResults = new Map(
      deliveredDeployment.body.deployment.results.map((result) => [result.hostId, result])
    );
    assert.strictEqual(deliveredResults.get(ONLINE_HOST)?.state, 'running');
    assert.strictEqual(deliveredResults.get(FAILING_HOST)?.state, 'running');
    assert(deliveredResults.get(ONLINE_HOST)?.startedAt);
    assert.strictEqual(deliveredResults.get(OFFLINE_HOST)?.state, 'pending');

    const unauthenticatedDownload = await request(
      port,
      'GET',
      `/api/agent/skills/artifacts/${encodeURIComponent(artifact.contentHash)}`,
      null,
      {
        authenticated: false,
        headers: { 'X-Remote-Codex-Host-Id': ONLINE_HOST },
      }
    );
    assert.strictEqual(unauthenticatedDownload.statusCode, 401);

    const download = await request(
      port,
      'GET',
      `/api/agent/skills/artifacts/${encodeURIComponent(artifact.contentHash)}`,
      null,
      { headers: { 'X-Remote-Codex-Host-Id': ONLINE_HOST } }
    );
    assert.strictEqual(download.statusCode, 200);
    assert.strictEqual(download.headers['content-type'], 'application/vnd.remote-codex.skill-artifact');
    assert.strictEqual(Number(download.headers['content-length']), archiveBuffer.length);
    assert.deepStrictEqual(download.buffer, archiveBuffer);

    const unrelatedDownload = await request(
      port,
      'GET',
      `/api/agent/skills/artifacts/${encodeURIComponent(artifact.contentHash)}`,
      null,
      { headers: { 'X-Remote-Codex-Host-Id': UNRELATED_HOST } }
    );
    assert.strictEqual(unrelatedDownload.statusCode, 403);

    const invalidSuccessResult = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'enable',
        targetScope: 'user',
        scopeId: 'user',
        ok: true,
        state: 'enabled',
        observedHash: `sha256:${'f'.repeat(64)}`,
      },
    });
    assert.strictEqual(invalidSuccessResult.statusCode, 409);

    const noncanonicalSuccessResult = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'enable',
        targetScope: 'user',
        scopeId: 'user',
        ok: true,
        state: 'ENABLED',
        observedHash: artifact.contentHash.toUpperCase(),
      },
    });
    assert.strictEqual(noncanonicalSuccessResult.statusCode, 409);

    const missingMetadataResult = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId,
        skillId: 'fixture-skill',
        action: 'enable',
        targetScope: 'user',
        scopeId: 'user',
        ok: false,
        error: 'missing artifact metadata',
      },
    });
    assert.strictEqual(missingMetadataResult.statusCode, 409);

    const unregisteredResult = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: OFFLINE_HOST,
        deploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'enable',
        targetScope: 'user',
        scopeId: 'user',
        ok: true,
        state: 'enabled',
      },
    });
    assert.strictEqual(unregisteredResult.statusCode, 409);

    const failed = await observeDeploymentEvent(port, () => request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: FAILING_HOST,
        deploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'enable',
        targetScope: 'user',
        scopeId: 'user',
        ok: false,
        error: 'simulated Host activation failure',
      },
    }));
    assert.strictEqual(failed.triggerResult.statusCode, 200);
    assert.strictEqual(failed.payload.deploymentId, deploymentId);
    assert.strictEqual(failed.payload.hostId, FAILING_HOST);
    assert.strictEqual(failed.payload.result.state, 'failed');

    const succeeded = await observeDeploymentEvent(port, () => request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'enable',
        targetScope: 'user',
        scopeId: 'user',
        ok: true,
        state: 'enabled',
        observedHash: artifact.contentHash,
        activationPath: `/codex/${ONLINE_HOST}/skills/fixture-skill`,
      },
    }));
    assert.strictEqual(succeeded.triggerResult.statusCode, 200);
    assert.strictEqual(succeeded.payload.result.state, 'succeeded');
    assert.strictEqual(succeeded.payload.invalidateHostId, ONLINE_HOST);

    const duplicateSuccess = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'enable',
        targetScope: 'user',
        scopeId: 'user',
        ok: true,
        state: 'enabled',
        observedHash: artifact.contentHash,
        activationPath: `/codex/${ONLINE_HOST}/skills/fixture-skill`,
      },
    });
    assert.strictEqual(duplicateSuccess.statusCode, 200);

    const onlineCommands = await request(
      port,
      'GET',
      `/api/agent/commands?hostId=${encodeURIComponent(ONLINE_HOST)}&after=0`
    );
    assert.strictEqual(
      onlineCommands.body?.commands?.filter((item) => item.type === 'host.skills.inventory.refresh').length,
      1,
      'duplicate terminal results must not queue another inventory refresh'
    );
    assert.strictEqual(
      onlineCommands.body?.commands?.filter((item) => (
        item.type === 'host.skills.deployment.apply' && item.deploymentId === deploymentId
      )).length,
      0,
      'a confirmed deployment result must atomically acknowledge its command'
    );

    const status = await request(port, 'GET', `/api/skills/deployments/${encodeURIComponent(deploymentId)}`);
    assert.strictEqual(status.statusCode, 200);
    const completedResults = new Map(status.body.deployment.results.map((result) => [result.hostId, result]));
    assert.strictEqual(completedResults.get(ONLINE_HOST)?.state, 'succeeded');
    assert.strictEqual(completedResults.get(FAILING_HOST)?.state, 'failed');
    assert.strictEqual(completedResults.get(OFFLINE_HOST)?.state, 'pending');

    const skillsPayload = await request(port, 'GET', '/api/skills');
    assert(skillsPayload.body?.deployments?.some((deployment) => deployment.deploymentId === deploymentId));

    const disableForPrune = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'disable-for-prune',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'disable',
      targetHostIds: [ONLINE_HOST],
      targetScope: 'user',
    });
    assert.strictEqual(disableForPrune.statusCode, 202);
    const prunableDeploymentId = disableForPrune.body.deployment.deploymentId;
    const disableResult = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId: prunableDeploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'disable',
        targetScope: 'user',
        scopeId: 'user',
        ok: false,
        error: 'prunable failed result',
      },
    });
    assert.strictEqual(disableResult.statusCode, 200);
    const enableAfterPrune = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'enable-after-prune',
      skillId: 'fixture-skill',
      artifactId: artifact.contentHash,
      action: 'enable',
      targetHostIds: [ONLINE_HOST],
      targetScope: 'user',
    });
    assert.strictEqual(enableAfterPrune.statusCode, 202);
    const prunedStatus = await request(
      port,
      'GET',
      `/api/skills/deployments/${encodeURIComponent(prunableDeploymentId)}`
    );
    assert.strictEqual(prunedStatus.statusCode, 404);
    const conflictingLatePrunedResult = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId: prunableDeploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'disable',
        targetScope: 'user',
        scopeId: 'user',
        ok: true,
        state: 'disabled',
      },
    });
    assert.strictEqual(conflictingLatePrunedResult.statusCode, 409);
    const latePrunedResult = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.deployment.result',
        hostId: ONLINE_HOST,
        deploymentId: prunableDeploymentId,
        skillId: 'fixture-skill',
        artifactId: artifact.contentHash,
        action: 'disable',
        targetScope: 'user',
        scopeId: 'user',
        ok: false,
        error: 'prunable failed result',
      },
    });
    assert.strictEqual(latePrunedResult.statusCode, 200, JSON.stringify(latePrunedResult.body));

    await stopChild(relay.child);
    relay = await startRelay(port, tempRoot);

    const restored = await request(port, 'GET', `/api/skills/deployments/${encodeURIComponent(deploymentId)}`);
    assert.strictEqual(restored.statusCode, 200);
    assert.strictEqual(
      restored.body.deployment.results.find((result) => result.hostId === OFFLINE_HOST)?.state,
      'pending'
    );

    const reconciledRegistration = await registerHost(port, OFFLINE_HOST);
    assert.strictEqual(reconciledRegistration.statusCode, 200);
    const reconciledCommands = await request(
      port,
      'GET',
      `/api/agent/commands?hostId=${encodeURIComponent(OFFLINE_HOST)}&after=0`
    );
    const reconciled = reconciledCommands.body?.commands?.find((item) => (
      item.type === 'host.skills.deployment.apply' && item.deploymentId === deploymentId
    ));
    assert(reconciled, JSON.stringify(reconciledCommands.body));
    const reconciledStatus = await request(port, 'GET', `/api/skills/deployments/${encodeURIComponent(deploymentId)}`);
    assert.strictEqual(
      reconciledStatus.body.deployment.results.find((result) => result.hostId === OFFLINE_HOST)?.state,
      'running'
    );
  } catch (error) {
    if (relay?.output?.length) {
      error.message += `\nRelay output:\n${relay.output.join('').slice(-6000)}`;
    }
    throw error;
  } finally {
    await stopChild(relay?.child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('skills deployment API assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
