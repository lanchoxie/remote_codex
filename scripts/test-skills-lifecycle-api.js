const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createSkillArtifactArchive } = require('../shared/skill-artifact');
const { SkillDeploymentService } = require('../apps/relay/skill-deployment-service');
const { SkillRegistryService } = require('../apps/relay/skill-registry-service');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'lifecycle-host';

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

function request(port, method, pathname, body = null, headers = {}) {
  const payload = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...(payload.length ? {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        } : {}),
        ...headers,
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
            reject(error);
            return;
          }
        }
        resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: parsed, buffer });
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

function relayEnvironment(port, root) {
  return {
    ...process.env,
    PORT: String(port),
    RELAY_STATE_ROOT: root,
    RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_LOCAL_HOST_STUB: 'false',
    SESSION_COLLECTIONS_PATH: path.join(root, 'collections.json'),
    SESSION_METADATA_PATH: path.join(root, 'metadata.json'),
    SESSION_RECORD_STORE_ROOT: path.join(root, 'session-record-store'),
    SESSION_LOGS_PATH: path.join(root, 'logs.json'),
    SESSION_DIAGNOSTICS_PATH: path.join(root, 'diagnostics.json'),
    SKILL_FAVORITES_PATH: path.join(root, 'favorites.json'),
    SKILL_SOURCES_PATH: path.join(root, 'sources.json'),
    SKILL_LIBRARY_PATH: path.join(root, 'legacy-library.json'),
    SKILL_INVENTORIES_PATH: path.join(root, 'inventories.json'),
    SKILL_REGISTRY_PATH: path.join(root, 'registry.json'),
    SKILL_ARTIFACT_ROOT: path.join(root, 'artifacts'),
    SKILL_DEPLOYMENTS_PATH: path.join(root, 'deployments.json'),
    RELAY_AUTH_TOKEN_PATH: path.join(root, 'token.txt'),
    RELAY_AUTH_ACCOUNT_PATH: path.join(root, 'account.json'),
  };
}

async function waitForRelay(port, child, output) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`Relay exited with ${child.exitCode}:\n${output.join('').slice(-4000)}`);
    }
    try {
      const health = await request(port, 'GET', '/health');
      if (health.statusCode === 200 && health.body?.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`Relay did not become ready:\n${output.join('').slice(-4000)}`);
}

async function startRelay(port, root) {
  const output = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnvironment(port, root),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  await waitForRelay(port, child, output);
  return { child, output };
}

async function stopRelay(relay) {
  if (!relay?.child || relay.child.exitCode != null) {
    return;
  }
  relay.child.kill();
  await Promise.race([
    new Promise((resolve) => relay.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function expectRelayStartupFailure(port, root) {
  const output = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnvironment(port, root),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  const exitCode = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (exitCode == null) {
    child.kill();
  }
  assert.notStrictEqual(exitCode, null, 'Relay must fail closed instead of serving an empty inventory cache');
  return output.join('');
}

async function seedRegistry(root) {
  const skillRoot = path.join(root, 'fixture-skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: Lifecycle Fixture',
    'description: Lifecycle API fixture',
    '---',
    '',
  ].join('\n'));
  const archivePath = path.join(root, 'fixture.rcskill');
  const archive = await createSkillArtifactArchive(skillRoot, archivePath);
  const sourceId = 'github:owner/repo:main:skills/fixture-skill/SKILL.md';
  const registry = new SkillRegistryService({
    registryPath: path.join(root, 'registry.json'),
    artifactRoot: path.join(root, 'artifacts'),
  });
  await registry.importArchive(archivePath, {
    skillId: 'fixture-skill',
    name: 'Lifecycle Fixture',
    description: 'Lifecycle API fixture',
    sourceId,
    sourceKind: 'github',
    sourceLocator: 'owner/repo',
    sourceRef: 'main',
    sourcePath: 'skills/fixture-skill/SKILL.md',
    expectedHash: archive.contentHash,
  });
  return { archive, sourceId };
}

async function registerHost(port) {
  const response = await request(port, 'POST', '/api/agent/register', {
    hostId: HOST_ID,
    label: HOST_ID,
    platform: 'test',
    codexHome: `/codex/${HOST_ID}`,
    capabilities: {
      hostSkills: true,
      hostSkillInventoryV2: true,
      hostSkillDeploymentV1: true,
    },
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

async function publishDeploymentResult(port, deployment, result) {
  return request(port, 'POST', '/api/agent/events', {
    event: {
      type: 'host.skills.deployment.result',
      hostId: HOST_ID,
      deploymentId: deployment.deploymentId,
      skillId: deployment.skillId,
      artifactId: deployment.artifactId,
      action: deployment.action,
      targetScope: deployment.targetScope,
      scopeId: deployment.scopeId,
      ...result,
    },
  });
}

async function publishInventory(
  port,
  revisionCharacter,
  instances,
  scanErrors = [],
  scannedAt = '2026-07-13T12:00:00.000Z'
) {
  return request(port, 'POST', '/api/agent/events', {
    event: {
      type: 'host.skills.inventory',
      hostId: HOST_ID,
      revision: `sha256:${revisionCharacter.repeat(64)}`,
      scannedAt,
      instances,
      scanErrors,
    },
  });
}

function seedLegacyAppliedUncertainty(root, artifactId) {
  let deploymentId = 0;
  const statePath = path.join(root, 'deployments.json');
  const service = new SkillDeploymentService({
    statePath,
    idFactory: () => `uncertain-cleanup-${++deploymentId}`,
  });
  const oldEnable = service.createDeployment({
    skillId: 'fixture-skill',
    artifactId,
    action: 'enable',
    targetHostIds: [HOST_ID],
    targetScope: 'user',
  }).deployment;
  service.markQueued(oldEnable.deploymentId, HOST_ID);
  service.markRunningMany(oldEnable.deploymentId, [HOST_ID]);
  const newerRemove = service.createDeployment({
    skillId: 'fixture-skill',
    artifactId,
    action: 'remove',
    targetHostIds: [HOST_ID],
    targetScope: 'user',
  }).deployment;
  service.markQueued(newerRemove.deploymentId, HOST_ID);
  service.markRunningMany(newerRemove.deploymentId, [HOST_ID]);
  service.applyResult({
    deploymentId: newerRemove.deploymentId,
    hostId: HOST_ID,
    ok: true,
    state: 'missing',
  });

  const legacyState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  delete legacyState.nextDeploymentGeneration;
  for (const deployment of Object.values(legacyState.deployments || {})) {
    delete deployment.generation;
  }
  for (const tombstone of Object.values(legacyState.tombstones || {})) {
    delete tombstone.generation;
  }
  for (const applied of Object.values(legacyState.applied || {})) {
    delete applied.deploymentCreatedAt;
    delete applied.deploymentGeneration;
  }
  fs.writeFileSync(statePath, JSON.stringify(legacyState));
  const journalPath = `${statePath}.results.jsonl`;
  const legacyJournal = fs.readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const entry of legacyJournal) {
    if (entry.appliedMutation) {
      delete entry.appliedMutation.deploymentGeneration;
    }
  }
  fs.writeFileSync(journalPath, `${legacyJournal.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const legacyService = new SkillDeploymentService({ statePath });
  legacyService.applyResult({
    deploymentId: oldEnable.deploymentId,
    hostId: HOST_ID,
    ok: true,
    state: 'enabled',
    observedHash: artifactId,
  });
}

async function testAppliedUncertainCleanupAuthorization() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-uncertain-cleanup-api-'));
  const port = await getOpenPort();
  let relay = null;
  try {
    const { archive } = await seedRegistry(root);
    const registry = new SkillRegistryService({
      registryPath: path.join(root, 'registry.json'),
      artifactRoot: path.join(root, 'artifacts'),
    });
    await registry.retireSkill('fixture-skill');
    seedLegacyAppliedUncertainty(root, archive.contentHash);
    relay = await startRelay(port, root);
    await registerHost(port);

    const manager = await request(port, 'GET', '/api/skills');
    assert.deepStrictEqual(
      manager.body.appliedSkillStates[0].uncertainArtifactIds,
      [archive.contentHash],
      'manager API must expose exact applied uncertainty'
    );
    const references = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(references.body.blockers.some((blocker) => blocker.kind === 'applied-uncertain'));

    const cleanup = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'applied-uncertain-cleanup',
      skillId: 'fixture-skill',
      artifactId: archive.contentHash,
      action: 'remove',
      targetHostIds: [HOST_ID],
      targetScope: 'user',
    });
    assert.strictEqual(
      cleanup.statusCode,
      202,
      `retired cleanup must accept an applied-uncertain Host reference: ${JSON.stringify(cleanup.body)}`
    );
    const result = await publishDeploymentResult(port, cleanup.body.deployment, {
      ok: true,
      state: 'missing',
    });
    assert.strictEqual(result.statusCode, 200, JSON.stringify(result.body));
    const settled = await request(port, 'GET', '/api/skills/library/fixture-skill/references');
    assert(!settled.body.blockers.some((blocker) => blocker.kind === 'applied-uncertain'));
  } finally {
    await stopRelay(relay);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-lifecycle-api-'));
  const port = await getOpenPort();
  let relay = null;
  try {
    const { archive, sourceId } = await seedRegistry(root);
    relay = await startRelay(port, root);
    await registerHost(port);

    const initial = await request(port, 'GET', '/api/skills');
    assert.strictEqual(initial.statusCode, 200);
    assert(Number.isSafeInteger(initial.body?.registryRevision));
    assert.strictEqual(
      initial.body.skillLibrary.find((record) => record.skillId === 'fixture-skill')?.archived,
      false
    );

    const automation = await request(
      port,
      'POST',
      `/api/skills/sources/${encodeURIComponent(sourceId)}/automation`,
      {
        expectedRevision: initial.body.registryRevision,
        refreshPolicy: 'daily',
        rolloutPolicy: 'enabled-hosts',
      }
    );
    assert.strictEqual(automation.statusCode, 200, JSON.stringify(automation.body));
    assert.strictEqual(automation.body.source.refreshPolicy, 'daily');
    assert.strictEqual(automation.body.source.rolloutPolicy, 'enabled-hosts');

    const enableRequest = {
      requestId: 'lifecycle-enable',
      skillId: 'fixture-skill',
      artifactId: archive.contentHash,
      action: 'enable',
      targetHostIds: [HOST_ID],
      targetScope: 'user',
    };
    const enable = await request(port, 'POST', '/api/skills/deployments', enableRequest);
    assert.strictEqual(enable.statusCode, 202, JSON.stringify(enable.body));
    const audit = await request(port, 'GET', '/api/skills/audit?afterSequence=0&limit=20');
    assert.strictEqual(audit.statusCode, 200, JSON.stringify(audit.body));
    assert(audit.body.events.some((event) => event.type === 'skills.source.automation_updated'));
    assert(audit.body.events.some((event) => event.type === 'skills.deployment.accepted'));

    const retire = await request(port, 'POST', '/api/skills/library/fixture-skill/retire', {
      expectedRevision: automation.body.revision,
    });
    assert.strictEqual(retire.statusCode, 200, JSON.stringify(retire.body));
    assert.strictEqual(retire.body.libraryRecord.archived, true);

    const enableRetryAfterRetire = await request(
      port,
      'POST',
      '/api/skills/deployments',
      enableRequest
    );
    assert.strictEqual(enableRetryAfterRetire.statusCode, 200, JSON.stringify(enableRetryAfterRetire.body));
    assert.strictEqual(enableRetryAfterRetire.body.reused, true);
    assert.strictEqual(
      enableRetryAfterRetire.body.deployment.deploymentId,
      enable.body.deployment.deploymentId
    );

    const retiredEnable = await request(port, 'POST', '/api/skills/deployments', {
      requestId: 'retired-enable',
      skillId: 'fixture-skill',
      artifactId: archive.contentHash,
      action: 'enable',
      targetHostIds: [HOST_ID],
      targetScope: 'user',
    });
    assert.strictEqual(retiredEnable.statusCode, 409, JSON.stringify(retiredEnable.body));

    const retiredExistingEnableDownload = await request(
      port,
      'GET',
      `/api/agent/skills/artifacts/${encodeURIComponent(archive.contentHash)}`,
      null,
      { 'X-Remote-Codex-Host-Id': HOST_ID }
    );
    assert.strictEqual(
      retiredExistingEnableDownload.statusCode,
      200,
      'Retire must not break an Enable deployment that was already accepted'
    );

    const pendingReferences = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert.strictEqual(pendingReferences.statusCode, 200, JSON.stringify(pendingReferences.body));
    assert(pendingReferences.body.blockers.some((blocker) => blocker.kind === 'desired'));
    assert(pendingReferences.body.blockers.some((blocker) => blocker.kind === 'deployment'));

    const blockedGc = await request(port, 'POST', '/api/skills/artifacts/gc', {
      artifactIds: [archive.contentHash],
      expectedRevision: retire.body.revision,
    });
    assert.strictEqual(blockedGc.statusCode, 409, JSON.stringify(blockedGc.body));
    assert.deepStrictEqual(blockedGc.body.blockedArtifactIds, [archive.contentHash]);

    const enabledResult = await publishDeploymentResult(port, enable.body.deployment, {
      ok: true,
      state: 'enabled',
      observedHash: archive.contentHash,
      activationPath: `/codex/${HOST_ID}/skills/fixture-skill`,
    });
    assert.strictEqual(enabledResult.statusCode, 200, JSON.stringify(enabledResult.body));

    const appliedReferences = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(appliedReferences.body.blockers.some((blocker) => blocker.kind === 'applied'));

    const mismatchedInventoryResult = await publishInventory(port, '9', [{
      instanceId: `${HOST_ID}|user|user|${sourceId}|renamed-skill|/codex/${HOST_ID}/skills/Renamed Skill`,
      hostId: HOST_ID,
      skillId: 'Renamed Skill',
      name: 'Renamed Lifecycle Fixture',
      description: 'Lifecycle API fixture with a noncanonical local name',
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      sourceId,
      sourceKind: 'github',
      sourceLocator: 'owner/repo',
      sourceRef: 'main',
      sourcePath: 'skills/fixture-skill/SKILL.md',
      activationPath: `/codex/${HOST_ID}/skills/Renamed Skill`,
      realPath: `/codex/${HOST_ID}/skills/Renamed Skill`,
      observedHash: archive.contentHash,
      enabled: true,
      effective: true,
      managed: false,
      readonly: false,
      state: 'enabled',
    }], [], '2026-07-13T12:00:00.000Z');
    assert.strictEqual(mismatchedInventoryResult.statusCode, 200, JSON.stringify(mismatchedInventoryResult.body));
    const mismatchedInventoryReferences = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(
      mismatchedInventoryReferences.body.blockers.some((blocker) => blocker.kind === 'host-inventory'),
      'an exact adopted source/hash must remain a blocker when the local Skill directory was renamed'
    );

    const mismatchedManagedInventoryResult = await publishInventory(port, '8', [{
      instanceId: `${HOST_ID}|user|user|managed|renamed-managed|/codex/${HOST_ID}/skills/Renamed Managed`,
      hostId: HOST_ID,
      skillId: 'Renamed Managed',
      name: 'Renamed Managed Lifecycle Fixture',
      description: 'Managed lifecycle fixture with a noncanonical local name',
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      sourceId: 'managed',
      sourceKind: 'managed',
      sourceLocator: `/codex/${HOST_ID}/skills/Renamed Managed`,
      activationPath: `/codex/${HOST_ID}/skills/Renamed Managed`,
      realPath: `/codex/${HOST_ID}/skills/Renamed Managed`,
      observedHash: archive.contentHash,
      desiredArtifactId: archive.contentHash,
      enabled: true,
      effective: true,
      managed: true,
      readonly: false,
      state: 'enabled',
    }], [], '2026-07-13T12:00:00.250Z');
    assert.strictEqual(
      mismatchedManagedInventoryResult.statusCode,
      200,
      JSON.stringify(mismatchedManagedInventoryResult.body)
    );
    const mismatchedManagedReferences = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(mismatchedManagedReferences.body.blockers.some((blocker) => (
      blocker.kind === 'host-inventory'
      && blocker.artifactId === archive.contentHash
      && blocker.skillId === null
    )), 'an exact managed digest must remain a blocker when the local Skill directory was renamed');

    const inventoryResult = await publishInventory(port, 'a', [{
      instanceId: `${HOST_ID}|user|user|${sourceId}|fixture-skill|/codex/${HOST_ID}/skills/fixture-skill`,
      hostId: HOST_ID,
      skillId: 'Fixture-Skill',
      name: 'Lifecycle Fixture',
      description: 'Lifecycle API fixture',
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      sourceId,
      sourceKind: 'github',
      sourceLocator: 'owner/repo',
      sourceRef: 'main',
      sourcePath: 'skills/fixture-skill/SKILL.md',
      activationPath: `/codex/${HOST_ID}/skills/fixture-skill`,
      realPath: `/codex/${HOST_ID}/skills/fixture-skill`,
      observedHash: archive.contentHash,
      enabled: true,
      effective: true,
      managed: false,
      readonly: false,
      state: 'enabled',
    }], [], '2026-07-13T12:00:00.500Z');
    assert.strictEqual(inventoryResult.statusCode, 200, JSON.stringify(inventoryResult.body));

    const malformedInventory = await request(port, 'POST', '/api/agent/events', {
      event: {
        type: 'host.skills.inventory',
        hostId: HOST_ID,
        revision: `sha256:${'f'.repeat(64)}`,
        scannedAt: '2026-07-13T12:00:03.000Z',
        instances: {},
        scanErrors: [],
      },
    });
    assert.strictEqual(malformedInventory.statusCode, 409);
    assert.strictEqual(malformedInventory.body.code, 'agent_event_batch_apply_failed');
    const afterMalformedInventory = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(afterMalformedInventory.body.blockers.some((blocker) => blocker.kind === 'host-inventory'));

    const staleEmptyInventory = await publishInventory(
      port,
      'e',
      [],
      [],
      '2026-07-13T11:59:59.000Z'
    );
    assert.strictEqual(staleEmptyInventory.statusCode, 200, JSON.stringify(staleEmptyInventory.body));
    const afterStaleEmpty = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(afterStaleEmpty.body.blockers.some((blocker) => blocker.kind === 'host-inventory'));

    const removeRequest = {
      requestId: 'retired-remove',
      skillId: 'fixture-skill',
      artifactId: archive.contentHash,
      action: 'remove',
      targetHostIds: [HOST_ID],
      targetScope: 'user',
    };
    const remove = await request(port, 'POST', '/api/skills/deployments', removeRequest);
    assert.strictEqual(remove.statusCode, 202, JSON.stringify(remove.body));
    const cleanupDownload = await request(
      port,
      'GET',
      `/api/agent/skills/artifacts/${encodeURIComponent(archive.contentHash)}`,
      null,
      { 'X-Remote-Codex-Host-Id': HOST_ID }
    );
    assert.strictEqual(cleanupDownload.statusCode, 403, 'Remove must not grant Artifact download');
    const removedResult = await publishDeploymentResult(port, remove.body.deployment, {
      ok: true,
      state: 'missing',
    });
    assert.strictEqual(removedResult.statusCode, 200, JSON.stringify(removedResult.body));
    const removeRetryAfterSuccess = await request(
      port,
      'POST',
      '/api/skills/deployments',
      removeRequest
    );
    assert.strictEqual(removeRetryAfterSuccess.statusCode, 200, JSON.stringify(removeRetryAfterSuccess.body));
    assert.strictEqual(removeRetryAfterSuccess.body.reused, true);
    assert.strictEqual(
      removeRetryAfterSuccess.body.deployment.deploymentId,
      remove.body.deployment.deploymentId
    );

    const inventoryBlocked = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(inventoryBlocked.body.blockers.some((blocker) => blocker.kind === 'host-inventory'));
    assert(!inventoryBlocked.body.blockers.some((blocker) => blocker.kind === 'applied'));

    const incompleteInventory = await publishInventory(port, 'd', [], [{
      scope: 'user',
      scopeId: 'user',
      rootPath: `/codex/${HOST_ID}/skills`,
      message: 'simulated partial scan failure',
    }], '2026-07-13T12:00:01.000Z');
    assert.strictEqual(incompleteInventory.statusCode, 200, JSON.stringify(incompleteInventory.body));
    const incompleteReferences = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert(incompleteReferences.body.blockers.some((blocker) => (
      blocker.kind === 'host-inventory' || blocker.kind === 'inventory-uncertain'
    )), 'an incomplete inventory must not release the last complete Host references');

    const emptyInventory = await publishInventory(
      port,
      'b',
      [],
      [],
      '2026-07-13T12:00:02.000Z'
    );
    assert.strictEqual(emptyInventory.statusCode, 200, JSON.stringify(emptyInventory.body));
    const releasable = await request(port, 'GET', '/api/skills/library/fixture-skill/references');
    assert.deepStrictEqual(releasable.body.blockers, []);

    const emptyGc = await request(port, 'POST', '/api/skills/artifacts/gc', {
      artifactIds: [],
      expectedRevision: releasable.body.revision,
    });
    assert.strictEqual(emptyGc.statusCode, 200, JSON.stringify(emptyGc.body));
    assert.deepStrictEqual(emptyGc.body.collectedArtifactIds, []);
    assert.strictEqual(
      (await request(port, 'GET', '/api/skills')).body.artifacts
        .find((artifact) => artifact.artifactId === archive.contentHash)?.storageState,
      'available',
      'an explicit empty Artifact filter must be a no-op'
    );

    const gc = await request(port, 'POST', '/api/skills/artifacts/gc', {
      artifactIds: [archive.contentHash],
      expectedRevision: releasable.body.revision,
    });
    assert.strictEqual(gc.statusCode, 200, JSON.stringify(gc.body));
    assert.deepStrictEqual(gc.body.collectedArtifactIds, [archive.contentHash]);

    const afterGc = await request(port, 'GET', '/api/skills');
    assert.strictEqual(
      afterGc.body.artifacts.find((artifact) => artifact.artifactId === archive.contentHash)?.storageState,
      'collected'
    );
    assert.deepStrictEqual(
      afterGc.body.skillLibrary.find((record) => record.skillId === 'fixture-skill')?.artifactIds,
      []
    );
    const removeRetryAfterGc = await request(
      port,
      'POST',
      '/api/skills/deployments',
      removeRequest
    );
    assert.strictEqual(removeRetryAfterGc.statusCode, 200, JSON.stringify(removeRetryAfterGc.body));
    assert.strictEqual(removeRetryAfterGc.body.reused, true);
    assert.strictEqual(
      removeRetryAfterGc.body.deployment.deploymentId,
      remove.body.deployment.deploymentId
    );

    const restore = await request(port, 'POST', '/api/skills/library/fixture-skill/restore', {
      expectedRevision: gc.body.revision,
    });
    assert.strictEqual(restore.statusCode, 409, JSON.stringify(restore.body));

    await stopRelay(relay);
    relay = await startRelay(port, root);
    const afterRestartReferences = await request(
      port,
      'GET',
      '/api/skills/library/fixture-skill/references'
    );
    assert.strictEqual(afterRestartReferences.statusCode, 200, JSON.stringify(afterRestartReferences.body));
    assert.deepStrictEqual(afterRestartReferences.body.blockers, []);

    await stopRelay(relay);
    relay = null;
    fs.writeFileSync(path.join(root, 'inventories.json'), '{invalid-json', 'utf8');
    assert.match(
      await expectRelayStartupFailure(port, root),
      /invalid persisted Skill inventory JSON/i
    );
    fs.writeFileSync(path.join(root, 'inventories.json'), JSON.stringify({
      version: 1,
      inventories: {
        [HOST_ID]: {
          hostId: HOST_ID,
          revision: `sha256:${'1'.repeat(64)}`,
          scannedAt: '2026-07-13T12:00:04.000Z',
          receivedAt: '2026-07-13T12:00:04.000Z',
          instances: {},
          scanErrors: [],
        },
      },
    }));
    assert.match(
      await expectRelayStartupFailure(port, root),
      /instances must be an array|invalid persisted Skill inventory/i
    );
    await testAppliedUncertainCleanupAuthorization();
  } finally {
    await stopRelay(relay);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('skills lifecycle API assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
