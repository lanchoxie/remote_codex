const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSkillArtifactArchive } = require('../shared/skill-artifact');
const { hashSkillDirectory } = require('../shared/skill-inventory');
const {
  HostSkillDeploymentService,
  downloadArtifactFile,
} = require('../apps/host-agent/skill-deployment-service');
const hostDeploymentSource = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'host-agent', 'skill-deployment-service.js'),
  'utf8'
);
assert(
  hostDeploymentSource.includes('DEFAULT_MAX_ENTRIES + 1'),
  'managed writable checks must accept every valid Artifact entry plus its root directory'
);

const deploymentSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'host-agent', 'skill-deployment-service.js'), 'utf8');
assert(deploymentSource.includes("'.remote-codex-staging'"), 'Host mutations need an unscanned same-volume staging root');
assert(
  !deploymentSource.includes('`${command.activationPath}.remote-codex-'),
  'stage, backup, and tombstone directories must not look like direct Skills'
);

function writeSkill(root, id, version) {
  const skillRoot = path.join(root, `${id}-${version}`);
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    `name: ${id}`,
    `description: ${version}`,
    '---',
    '',
    `# ${id}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), `module.exports = ${JSON.stringify(version)};\n`);
  fs.writeFileSync(path.join(skillRoot, 'assets', 'data.bin'), Buffer.from(version));
  return skillRoot;
}

async function archiveSkill(root, skillRoot, label) {
  const archivePath = path.join(root, `${label}.rcskill`);
  const artifact = await createSkillArtifactArchive(skillRoot, archivePath);
  return { ...artifact, archivePath };
}

function deployment(artifact, overrides = {}) {
  return {
    type: 'host.skills.deployment.apply',
    deploymentId: overrides.deploymentId || `deployment-${overrides.action || 'enable'}-${artifact.artifactId.slice(-8)}`,
    action: overrides.action || 'enable',
    skillId: overrides.skillId || 'fixture-skill',
    artifactId: artifact.artifactId,
    expectedHash: artifact.contentHash,
    downloadPath: `/api/agent/skills/artifacts/${encodeURIComponent(artifact.artifactId)}`,
    targetScope: overrides.targetScope || 'user',
    scopeId: overrides.scopeId || (overrides.targetScope === 'project' ? overrides.cwd : 'user'),
    cwd: overrides.cwd || null,
    confirmProjectWrite: Boolean(overrides.confirmProjectWrite),
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-skill-deployment-'));
  const codexHome = path.join(root, 'codex-home');
  const stateRoot = path.join(root, 'remote-codex-state');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const v1Root = writeSkill(root, 'fixture-skill', 'v1');
    const v2Root = writeSkill(root, 'fixture-skill', 'v2');
    const otherRoot = writeSkill(root, 'fixture-skill', 'other');
    const v1 = await archiveSkill(root, v1Root, 'v1');
    const v2 = await archiveSkill(root, v2Root, 'v2');
    const other = await archiveSkill(root, otherRoot, 'other');
    const archives = new Map([
      [v1.artifactId, v1.archivePath],
      [v2.artifactId, v2.archivePath],
      [other.artifactId, other.archivePath],
    ]);
    const downloads = [];
    let invalidateCount = 0;
    let refreshCount = 0;
    let rollbackArtifactId = null;
    const inventoryService = {
      getWorkspaceRoots: () => [workspace],
      invalidate() {
        invalidateCount += 1;
      },
      async refresh(options) {
        assert.deepStrictEqual(options, { force: true });
        refreshCount += 1;
        return { snapshot: { revision: v1.artifactId, instances: [], scanErrors: [] } };
      },
    };
    const service = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome,
      stateRoot,
      inventoryService,
      download: async ({ artifactId, targetPath }) => {
        downloads.push(artifactId);
        fs.copyFileSync(archives.get(artifactId), targetPath);
      },
      afterActivate: async ({ artifactId }) => {
        if (artifactId === rollbackArtifactId) {
          throw new Error('simulated post-activation validation failure');
        }
      },
    });

    for (const unsafeSkillId of ['.system', '.remote-codex-staging', 'CON', 'foo.']) {
      await assert.rejects(
        service.applyDeployment(deployment(v1, {
          deploymentId: `unsafe-${unsafeSkillId}`,
          skillId: unsafeSkillId,
        })),
        /reserved|safe|portable|skillId/i
      );
    }

    const stagingOutside = path.join(root, 'unsafe-staging-target');
    fs.mkdirSync(stagingOutside, { recursive: true });
    const stagingLink = path.join(codexHome, 'skills', '.remote-codex-staging');
    fs.mkdirSync(path.dirname(stagingLink), { recursive: true });
    fs.symlinkSync(stagingOutside, stagingLink, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      service.applyDeployment(deployment(v1, { deploymentId: 'linked-staging-root' })),
      /staging.*link|link.*staging|junction/i
    );
    fs.rmSync(stagingLink, { recursive: true, force: true });

    const linkedUserHome = path.join(root, 'linked-user-home');
    const linkedUserOutside = path.join(root, 'linked-user-outside');
    fs.mkdirSync(linkedUserHome, { recursive: true });
    fs.mkdirSync(linkedUserOutside, { recursive: true });
    fs.symlinkSync(
      linkedUserOutside,
      path.join(linkedUserHome, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const linkedUserService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: linkedUserHome,
      stateRoot: path.join(root, 'linked-user-state'),
      inventoryService,
      download: async ({ targetPath }) => fs.copyFileSync(v1.archivePath, targetPath),
    });
    await assert.rejects(
      linkedUserService.applyDeployment(deployment(v1, { deploymentId: 'linked-user-ancestor' })),
      /ancestor|link|junction|boundary/i
    );
    assert(!fs.existsSync(path.join(linkedUserOutside, 'fixture-skill')));

    const linkedWorkspace = path.join(root, 'linked-workspace');
    const linkedProjectOutside = path.join(root, 'linked-project-outside');
    fs.mkdirSync(linkedWorkspace, { recursive: true });
    fs.mkdirSync(linkedProjectOutside, { recursive: true });
    fs.symlinkSync(
      linkedProjectOutside,
      path.join(linkedWorkspace, '.agents'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const linkedProjectService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: path.join(root, 'linked-project-codex-home'),
      stateRoot: path.join(root, 'linked-project-state'),
      inventoryService: {
        ...inventoryService,
        getWorkspaceRoots: () => [linkedWorkspace],
      },
      download: async ({ targetPath }) => fs.copyFileSync(v1.archivePath, targetPath),
    });
    await assert.rejects(
      linkedProjectService.applyDeployment(deployment(v1, {
        deploymentId: 'linked-project-ancestor',
        targetScope: 'project',
        scopeId: linkedWorkspace,
        cwd: linkedWorkspace,
        confirmProjectWrite: true,
      })),
      /ancestor|link|junction|boundary/i
    );
    assert(!fs.existsSync(path.join(linkedProjectOutside, 'skills', 'fixture-skill')));

    const linkedCacheStateRoot = path.join(root, 'linked-cache-state');
    const linkedCacheOutside = path.join(root, 'linked-cache-outside');
    const linkedCacheSentinel = path.join(linkedCacheOutside, 'a'.repeat(64), 'sentinel.txt');
    fs.mkdirSync(path.dirname(linkedCacheSentinel), { recursive: true });
    fs.writeFileSync(linkedCacheSentinel, 'keep');
    fs.mkdirSync(path.join(linkedCacheStateRoot, 'skills'), { recursive: true });
    fs.symlinkSync(
      linkedCacheOutside,
      path.join(linkedCacheStateRoot, 'skills', 'artifacts'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    assert.throws(() => new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: path.join(root, 'linked-cache-codex-home'),
      stateRoot: linkedCacheStateRoot,
      inventoryService,
    }), /state|cache|ancestor|link|junction|boundary/i);
    assert(fs.existsSync(linkedCacheSentinel));

    const swappedCacheStateRoot = path.join(root, 'swapped-cache-state');
    const swappedCacheOutside = path.join(root, 'swapped-cache-outside');
    const swappedCacheService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: path.join(root, 'swapped-cache-codex-home'),
      stateRoot: swappedCacheStateRoot,
      inventoryService,
    });
    const swappedHash = v1.artifactId.slice(7);
    const swappedSentinel = path.join(swappedCacheOutside, swappedHash, 'content', 'sentinel.txt');
    fs.mkdirSync(path.dirname(swappedSentinel), { recursive: true });
    fs.writeFileSync(swappedSentinel, 'keep');
    fs.writeFileSync(path.join(swappedCacheOutside, `${swappedHash}.rcskill`), 'keep');
    fs.mkdirSync(path.join(swappedCacheStateRoot, 'skills'), { recursive: true });
    fs.rmSync(swappedCacheService.artifactsRoot, { recursive: true, force: true });
    fs.symlinkSync(
      swappedCacheOutside,
      swappedCacheService.artifactsRoot,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await assert.rejects(
      swappedCacheService.applyDeployment(deployment(v1, {
        deploymentId: 'swapped-cache-remove',
        action: 'remove',
      })),
      /state|cache|ancestor|link|junction|boundary/i
    );
    assert(fs.existsSync(swappedSentinel), 'Remove must not delete through a cache junction added after startup');

    const userTarget = path.join(codexHome, 'skills', 'fixture-skill');
    const enabled = await service.applyDeployment(deployment(v1));
    assert.strictEqual(enabled.ok, true);
    assert.strictEqual(enabled.state, 'enabled');
    assert.strictEqual(enabled.observedHash, v1.artifactId);
    assert.strictEqual((await hashSkillDirectory(userTarget)).hash, v1.artifactId);
    assert.strictEqual(downloads.length, 1);
    assert.strictEqual(invalidateCount, 1);
    assert.strictEqual(refreshCount, 0, 'deployment results must not wait for a local inventory scan');

    const managedInventory = service.decorateInventorySnapshot({
      revision: v1.artifactId,
      scannedAt: 'managed-inventory',
      instances: [{
        instanceId: 'fixture-instance',
        skillId: 'fixture-skill',
        activationPath: userTarget,
        observedHash: v1.artifactId,
        managed: false,
        state: 'enabled',
      }],
      scanErrors: [],
    });
    assert.strictEqual(managedInventory.instances[0].managed, true);
    assert.strictEqual(managedInventory.instances[0].state, 'enabled');
    assert.strictEqual(managedInventory.instances[0].desiredArtifactId, v1.artifactId);
    const driftedInventory = service.decorateInventorySnapshot({
      ...managedInventory,
      instances: [{ ...managedInventory.instances[0], observedHash: other.artifactId }],
    });
    assert.strictEqual(driftedInventory.instances[0].state, 'drifted');
    if (process.platform === 'win32') {
      await service.applyDeployment(deployment(v1, {
        deploymentId: 'case-alias-enable',
        skillId: 'FIXTURE-SKILL',
      }));
      assert.strictEqual(
        service.snapshot().activations.length,
        1,
        'Windows case aliases must share one ownership record'
      );
    }

    const targetMtime = fs.statSync(path.join(userTarget, 'SKILL.md')).mtimeMs;
    const repeated = await service.applyDeployment(deployment(v1, { deploymentId: 'repeat-enable' }));
    assert.strictEqual(repeated.idempotent, true);
    assert.strictEqual(fs.statSync(path.join(userTarget, 'SKILL.md')).mtimeMs, targetMtime);
    assert.strictEqual(downloads.length, 1, 'cached identical enable must not download again');

    await assert.rejects(
      service.applyDeployment(deployment(other, {
        deploymentId: 'disable-stale-artifact',
        action: 'disable',
      })),
      /artifact.*match|match.*artifact|stale/i,
      'Disable must not claim a requested Artifact different from managed ownership'
    );
    await assert.rejects(
      service.applyDeployment(deployment(other, {
        deploymentId: 'remove-stale-artifact',
        action: 'remove',
      })),
      /artifact.*match|match.*artifact|stale/i,
      'Remove must not delete ownership for a different Artifact'
    );

    const disabled = await service.applyDeployment(deployment(v1, {
      deploymentId: 'disable-v1',
      action: 'disable',
    }));
    assert.strictEqual(disabled.state, 'disabled');
    assert(!fs.existsSync(userTarget));
    assert(fs.existsSync(service.contentPath(v1.artifactId)), 'disable must retain extracted cache');
    const disabledStateBytes = fs.readFileSync(service.statePath);
    const repeatedDisabled = await service.applyDeployment(deployment(v1, {
      deploymentId: 'disable-v1-repeat',
      action: 'disable',
    }));
    assert.strictEqual(repeatedDisabled.idempotent, true);
    assert.deepStrictEqual(fs.readFileSync(service.statePath), disabledStateBytes);

    const reenabled = await service.applyDeployment(deployment(v1, { deploymentId: 'reenable-v1' }));
    assert.strictEqual(reenabled.state, 'enabled');
    assert.strictEqual(downloads.length, 1);

    const readonlyFile = path.join(userTarget, 'scripts', 'run.js');
    fs.chmodSync(readonlyFile, 0o444);
    await assert.rejects(
      service.applyDeployment(deployment(v1, { deploymentId: 'disable-readonly', action: 'disable' })),
      /readonly|writable|permission/i
    );
    fs.chmodSync(readonlyFile, 0o644);
    assert(fs.existsSync(userTarget));

    rollbackArtifactId = v2.artifactId;
    const originalRm = fs.promises.rm;
    let injectedRollbackRemoveFailure = true;
    fs.promises.rm = async (targetPath, ...args) => {
      if (injectedRollbackRemoveFailure && path.resolve(targetPath) === path.resolve(userTarget)) {
        injectedRollbackRemoveFailure = false;
        throw new Error('simulated rollback remove failure');
      }
      return originalRm.call(fs.promises, targetPath, ...args);
    };
    try {
      await assert.rejects(
        service.applyDeployment(deployment(v2, { deploymentId: 'rollback-v2' })),
        /simulated post-activation validation failure/
      );
    } finally {
      fs.promises.rm = originalRm;
    }
    assert.strictEqual((await hashSkillDirectory(userTarget)).hash, v1.artifactId, 'failed replacement must restore v1');
    assert.strictEqual(service.snapshot().activations[0].artifactId, v1.artifactId);
    rollbackArtifactId = null;

    const driftFile = path.join(userTarget, 'scripts', 'run.js');
    fs.writeFileSync(driftFile, 'module.exports = "drifted";\n');
    await assert.rejects(
      service.applyDeployment(deployment(v1, { deploymentId: 'disable-drift', action: 'disable' })),
      /drift|managed hash|changed/i
    );
    assert(fs.existsSync(userTarget));
    fs.writeFileSync(driftFile, 'module.exports = "v1";\n');
    assert.strictEqual((await hashSkillDirectory(userTarget)).hash, v1.artifactId);

    const removed = await service.applyDeployment(deployment(v1, {
      deploymentId: 'remove-v1',
      action: 'remove',
    }));
    assert.strictEqual(removed.state, 'missing');
    assert(!fs.existsSync(userTarget));
    assert(!fs.existsSync(service.contentPath(v1.artifactId)), 'remove must delete unreferenced extracted cache');
    assert(!fs.existsSync(service.archivePath(v1.artifactId)), 'remove must delete unreferenced archive cache');
    const removedStateBytes = fs.readFileSync(service.statePath);
    const repeatedRemoved = await service.applyDeployment(deployment(v1, {
      deploymentId: 'remove-v1-repeat',
      action: 'remove',
    }));
    assert.strictEqual(repeatedRemoved.idempotent, true);
    assert.deepStrictEqual(fs.readFileSync(service.statePath), removedStateBytes);
    const missingDisabled = await service.applyDeployment(deployment(v1, {
      deploymentId: 'disable-missing',
      action: 'disable',
    }));
    assert.strictEqual(missingDisabled.state, 'disabled');
    assert.strictEqual(service.snapshot().activations[0]?.state, 'disabled');
    service.stagePendingResult({
      type: 'host.skills.deployment.result',
      ...missingDisabled,
    });
    service.clearPendingResult('disable-missing');
    await service.applyDeployment(deployment(v1, {
      deploymentId: 'remove-disabled-missing',
      action: 'remove',
    }));

    const unmanagedRoot = writeSkill(root, 'unmanaged', 'different');
    fs.mkdirSync(path.dirname(userTarget), { recursive: true });
    fs.cpSync(unmanagedRoot, userTarget, { recursive: true });
    await assert.rejects(
      service.applyDeployment(deployment(v1, { deploymentId: 'unmanaged-conflict' })),
      /unmanaged|conflict|overwrite/i
    );
    assert.strictEqual((await hashSkillDirectory(userTarget)).hash, (await hashSkillDirectory(unmanagedRoot)).hash);
    fs.rmSync(userTarget, { recursive: true, force: true });

    fs.cpSync(v1Root, userTarget, { recursive: true });
    const identicalMtime = fs.statSync(path.join(userTarget, 'SKILL.md')).mtimeMs;
    const adoptedOwnership = await service.applyDeployment(deployment(v1, { deploymentId: 'adopt-identical' }));
    assert.strictEqual(adoptedOwnership.idempotent, true);
    assert.strictEqual(fs.statSync(path.join(userTarget, 'SKILL.md')).mtimeMs, identicalMtime);
    assert(
      fs.existsSync(service.contentPath(v1.artifactId)),
      'identical-content ownership adoption must retain a verified local Artifact cache'
    );
    const downloadsBeforeOfflineEnable = downloads.length;
    await service.applyDeployment(deployment(v1, { deploymentId: 'disable-adopted', action: 'disable' }));
    assert(!fs.existsSync(userTarget));
    assert(fs.existsSync(service.contentPath(v1.artifactId)), 'Disable must retain the adopted Artifact cache');
    await service.applyDeployment({
      ...deployment(v1, { deploymentId: 'offline-enable-adopted' }),
      downloadPath: null,
    });
    assert.strictEqual(
      downloads.length,
      downloadsBeforeOfflineEnable,
      'offline re-enable must use the cache published during adoption'
    );
    await service.applyDeployment(deployment(v1, { deploymentId: 'remove-adopted', action: 'remove' }));

    const projectScopeId = `${workspace}${path.sep}`;
    const projectCommand = deployment(v2, {
      deploymentId: 'project-enable',
      targetScope: 'project',
      scopeId: projectScopeId,
      cwd: projectScopeId,
    });
    await assert.rejects(service.applyDeployment(projectCommand), /confirmProjectWrite|confirmation/i);
    await assert.rejects(service.applyDeployment({
      ...projectCommand,
      deploymentId: 'unknown-project',
      cwd: path.join(root, 'unknown-workspace'),
      scopeId: path.join(root, 'unknown-workspace'),
      confirmProjectWrite: true,
    }), /known workspace|workspace/i);
    const projectEnabled = await service.applyDeployment({
      ...projectCommand,
      confirmProjectWrite: true,
    });
    const projectTarget = path.join(workspace, '.agents', 'skills', 'fixture-skill');
    assert.strictEqual(projectEnabled.state, 'enabled');
    assert.strictEqual(projectEnabled.scopeId, projectScopeId);
    assert.strictEqual((await hashSkillDirectory(projectTarget)).hash, v2.artifactId);
    await service.applyDeployment({
      ...projectCommand,
      deploymentId: 'project-remove',
      action: 'remove',
      confirmProjectWrite: true,
    });
    assert(!fs.existsSync(projectTarget));

    const outside = path.join(root, 'outside-link-target');
    fs.cpSync(otherRoot, outside, { recursive: true });
    fs.mkdirSync(path.dirname(userTarget), { recursive: true });
    fs.symlinkSync(outside, userTarget, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      service.applyDeployment(deployment(other, { deploymentId: 'linked-target' })),
      /link|junction|managed target/i
    );
    fs.rmSync(userTarget, { recursive: true, force: true });

    const conflictCodexHome = path.join(root, 'cache-conflict-codex-home');
    const conflictTarget = path.join(conflictCodexHome, 'skills', 'fixture-skill');
    fs.mkdirSync(path.dirname(conflictTarget), { recursive: true });
    fs.cpSync(otherRoot, conflictTarget, { recursive: true });
    const conflictCacheService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: conflictCodexHome,
      stateRoot: path.join(root, 'cache-conflict-state'),
      inventoryService,
      download: async ({ targetPath }) => fs.copyFileSync(v1.archivePath, targetPath),
    });
    await assert.rejects(
      conflictCacheService.applyDeployment(deployment(v1, { deploymentId: 'cache-conflict' })),
      /unmanaged|conflict|overwrite/i
    );
    assert(!fs.existsSync(conflictCacheService.contentPath(v1.artifactId)));
    assert(!fs.existsSync(conflictCacheService.archivePath(v1.artifactId)));

    const wrongDownloadService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: path.join(root, 'wrong-codex-home'),
      stateRoot: path.join(root, 'wrong-state-root'),
      inventoryService,
      download: async ({ targetPath }) => fs.copyFileSync(other.archivePath, targetPath),
    });
    await assert.rejects(
      wrongDownloadService.applyDeployment(deployment(v1, { deploymentId: 'wrong-download' })),
      /expected|hash/i
    );
    assert(!fs.existsSync(path.join(root, 'wrong-codex-home', 'skills', 'fixture-skill')));

    let deferredRefreshCount = 0;
    const refreshFailureService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: path.join(root, 'refresh-failure-codex-home'),
      stateRoot: path.join(root, 'refresh-failure-state-root'),
      inventoryService: {
        getWorkspaceRoots: () => [],
        invalidate() {},
        async refresh() {
          deferredRefreshCount += 1;
          throw new Error('simulated inventory publication failure');
        },
      },
      download: async ({ targetPath }) => fs.copyFileSync(v1.archivePath, targetPath),
    });
    const appliedWithoutInventory = await refreshFailureService.applyDeployment(deployment(v1, {
      deploymentId: 'refresh-failure-enable',
    }));
    assert.strictEqual(appliedWithoutInventory.ok, true);
    assert.strictEqual(deferredRefreshCount, 0);
    assert.strictEqual(appliedWithoutInventory.inventoryError, null);
    assert(fs.existsSync(path.join(root, 'refresh-failure-codex-home', 'skills', 'fixture-skill')));

    const replacementCodexHome = path.join(root, 'replacement-codex-home');
    const replacementService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome: replacementCodexHome,
      stateRoot: path.join(root, 'replacement-state-root'),
      inventoryService,
      download: async ({ artifactId, targetPath }) => fs.copyFileSync(archives.get(artifactId), targetPath),
    });
    await replacementService.applyDeployment(deployment(v1, { deploymentId: 'replacement-v1' }));
    assert(fs.existsSync(replacementService.contentPath(v1.artifactId)));
    await replacementService.applyDeployment(deployment(v2, { deploymentId: 'replacement-v2' }));
    assert.strictEqual(
      (await hashSkillDirectory(path.join(replacementCodexHome, 'skills', 'fixture-skill'))).hash,
      v2.artifactId
    );
    assert(
      !fs.existsSync(replacementService.contentPath(v1.artifactId)),
      'successful replacement must clean the unreferenced previous content cache'
    );
    assert(
      !fs.existsSync(replacementService.archivePath(v1.artifactId)),
      'successful replacement must clean the unreferenced previous archive cache'
    );

    const orphanStateRoot = path.join(root, 'orphan-state-root');
    const orphanCodexHome = path.join(root, 'orphan-codex-home');
    const orphanOptions = {
      hostId: 'host-a',
      codexHome: orphanCodexHome,
      stateRoot: orphanStateRoot,
      inventoryService,
      download: async ({ targetPath }) => fs.copyFileSync(v1.archivePath, targetPath),
    };
    const orphanService = new HostSkillDeploymentService(orphanOptions);
    await orphanService.applyDeployment(deployment(v1, { deploymentId: 'orphan-enable' }));
    fs.rmSync(path.join(orphanCodexHome, 'skills', 'fixture-skill'), { recursive: true, force: true });
    const interruptedState = JSON.parse(fs.readFileSync(orphanService.statePath, 'utf8'));
    interruptedState.activations = {};
    fs.writeFileSync(orphanService.statePath, JSON.stringify(interruptedState, null, 2));
    const recoveredOrphanService = new HostSkillDeploymentService(orphanOptions);
    assert(fs.existsSync(recoveredOrphanService.contentPath(v1.artifactId)));
    await recoveredOrphanService.applyDeployment(deployment(v1, {
      deploymentId: 'orphan-remove-retry',
      action: 'remove',
    }));
    assert(
      !fs.existsSync(recoveredOrphanService.contentPath(v1.artifactId)),
      'remove retry must clean an unreferenced cache after ownership was already committed'
    );

    const outboxOptions = {
      hostId: 'host-a',
      codexHome: path.join(root, 'outbox-codex-home'),
      stateRoot: path.join(root, 'outbox-state-root'),
      inventoryService,
    };
    const outboxService = new HostSkillDeploymentService(outboxOptions);
    assert.throws(() => outboxService.stagePendingResult({
      type: 'host.skills.deployment.result',
      hostId: 'host-a',
      deploymentId: '__proto__',
      action: 'enable',
      skillId: 'fixture-skill',
      artifactId: v1.artifactId,
      targetScope: 'user',
      scopeId: 'user',
      ok: false,
      error: 'reserved deployment id fixture',
    }), /reserved|object key|deploymentId/i);
    assert.throws(() => outboxService.stagePendingResult({
      type: 'host.skills.deployment.result',
      hostId: 'host-a',
      deploymentId: 'incomplete-outbox-deployment',
      ok: false,
      error: 'incomplete result fixture',
    }), /action|skillId|artifactId|scope/i);
    const pendingResult = {
      type: 'host.skills.deployment.result',
      hostId: 'host-a',
      deploymentId: 'outbox-deployment',
      action: 'enable',
      skillId: 'fixture-skill',
      artifactId: v1.artifactId,
      targetScope: 'user',
      scopeId: 'user',
      ok: false,
      error: 'persisted result fixture',
    };
    outboxService.stagePendingResult(pendingResult);
    assert.deepStrictEqual(outboxService.getPendingResult('outbox-deployment'), pendingResult);
    const restoredOutboxService = new HostSkillDeploymentService(outboxOptions);
    assert.deepStrictEqual(restoredOutboxService.getPendingResult('outbox-deployment'), pendingResult);
    restoredOutboxService.clearPendingResult('outbox-deployment');
    assert.strictEqual(restoredOutboxService.getPendingResult('outbox-deployment'), null);

    const semanticCodexHome = path.join(root, 'semantic-codex-home');
    const semanticActivationPath = path.join(semanticCodexHome, 'skills', 'fixture-skill');
    const semanticKey = (scope, activationPath) => JSON.stringify([
      scope,
      process.platform === 'win32'
        ? path.resolve(activationPath).toLowerCase()
        : path.resolve(activationPath),
    ]);
    const baseSemanticRecord = {
      activationKey: semanticKey('user', semanticActivationPath),
      hostId: 'host-a',
      skillId: 'fixture-skill',
      artifactId: v1.artifactId,
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      activationPath: semanticActivationPath,
      state: 'enabled',
      managed: true,
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const invalidSemanticRecords = [
      { ...baseSemanticRecord, hostId: 'host-b' },
      { ...baseSemanticRecord, managed: false },
      { ...baseSemanticRecord, scopeId: null },
      {
        ...baseSemanticRecord,
        activationKey: semanticKey('user', path.join(root, 'outside-managed-skill')),
        activationPath: path.join(root, 'outside-managed-skill'),
      },
    ];
    for (const [index, record] of invalidSemanticRecords.entries()) {
      const invalidStateRoot = path.join(root, `invalid-semantic-state-${index}`);
      fs.mkdirSync(path.join(invalidStateRoot, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(invalidStateRoot, 'skills', 'state.json'), JSON.stringify({
        version: 1,
        activations: { [record.activationKey]: record },
        pendingResults: {},
      }));
      assert.throws(() => new HostSkillDeploymentService({
        hostId: 'host-a',
        codexHome: semanticCodexHome,
        stateRoot: invalidStateRoot,
        inventoryService,
      }), /invalid|state|host|managed|scope|activation|boundary/i);
    }

    const corruptStateRoot = path.join(root, 'corrupt-state-root');
    fs.mkdirSync(path.join(corruptStateRoot, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(corruptStateRoot, 'skills', 'state.json'), '{"version":1,"activations":');
    assert.throws(
      () => new HostSkillDeploymentService({
        hostId: 'host-a',
        codexHome: path.join(root, 'corrupt-codex-home'),
        stateRoot: corruptStateRoot,
        inventoryService,
      }),
      /invalid|parse|state/i
    );

    const oversizedErrorServer = http.createServer((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.write(Buffer.alloc(4096, 0x61));
    });
    await new Promise((resolve, reject) => {
      oversizedErrorServer.once('error', reject);
      oversizedErrorServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = oversizedErrorServer.address();
      await assert.rejects(downloadArtifactFile({
        relayUrl: `http://127.0.0.1:${address.port}`,
        downloadPath: `/api/agent/skills/artifacts/${encodeURIComponent(v1.artifactId)}`,
        targetPath: path.join(root, 'oversized-error-download.rcskill'),
        hostId: 'host-a',
        maxErrorBytes: 1024,
        timeoutMs: 500,
      }), /error response exceeds|oversized error/i);
    } finally {
      await new Promise((resolve) => oversizedErrorServer.close(resolve));
    }

    const truncatedServer = http.createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/vnd.remote-codex.skill-artifact',
        'Content-Length': '100',
      });
      response.write(Buffer.alloc(10, 0x61));
      process.nextTick(() => response.destroy());
    });
    await new Promise((resolve, reject) => {
      truncatedServer.once('error', reject);
      truncatedServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = truncatedServer.address();
      const existingTargetPath = path.join(root, 'existing-download-target.rcskill');
      fs.writeFileSync(existingTargetPath, 'pre-existing');
      await assert.rejects(downloadArtifactFile({
        relayUrl: `http://127.0.0.1:${address.port}`,
        downloadPath: `/api/agent/skills/artifacts/${encodeURIComponent(v1.artifactId)}`,
        targetPath: existingTargetPath,
        hostId: 'host-a',
        timeoutMs: 1000,
      }), /exist|aborted|socket|reset/i);
      assert.strictEqual(
        fs.readFileSync(existingTargetPath, 'utf8'),
        'pre-existing',
        'download cleanup must never unlink a target it did not create'
      );
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const targetPath = path.join(root, `truncated-download-${attempt}.rcskill`);
        await assert.rejects(downloadArtifactFile({
          relayUrl: `http://127.0.0.1:${address.port}`,
          downloadPath: `/api/agent/skills/artifacts/${encodeURIComponent(v1.artifactId)}`,
          targetPath,
          hostId: 'host-a',
          timeoutMs: 1000,
        }), /aborted|socket|length|reset/i);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert(!fs.existsSync(targetPath), 'a rejected truncated download must not leave a late partial file');
      }
    } finally {
      await new Promise((resolve) => truncatedServer.close(resolve));
    }

    const restoredService = new HostSkillDeploymentService({
      hostId: 'host-a',
      codexHome,
      stateRoot,
      inventoryService,
      download: async () => {
        throw new Error('restart should use persisted state only');
      },
    });
    assert.strictEqual(restoredService.snapshot().activations.length, 0);
    assert(fs.existsSync(path.join(stateRoot, 'skills', 'state.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('host Skill deployment assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
