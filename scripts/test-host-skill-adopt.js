const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectSkillArtifactArchive } = require('../shared/skill-artifact');
const { hashSkillDirectory } = require('../shared/skill-inventory');
const { HostSkillArtifactService } = require('../apps/host-agent/skill-artifact-service');

function writeSkill(root) {
  const skillRoot = path.join(root, 'fixture-skill');
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: Fixture Skill',
    'description: Host adoption fixture',
    '---',
    '',
    '# Fixture Skill',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(skillRoot, 'references', 'guide.md'), '# Guide\n');
  return skillRoot;
}

function command(instance, overrides = {}) {
  return {
    type: 'host.skills.artifact.export',
    adoptionId: 'adoption-1',
    instanceId: instance.instanceId,
    expectedHash: instance.observedHash,
    uploadPath: '/api/agent/skills/adoptions/adoption-1/artifact',
    uploadToken: 'one-time-token',
    ...overrides,
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-skill-adopt-'));
  const tempRoot = path.join(root, 'staging');
  try {
    const skillRoot = writeSkill(root);
    const digest = await hashSkillDirectory(skillRoot);
    const instance = {
      instanceId: JSON.stringify(['host-a', 'fixture-skill', 'user', 'user', 'local-source']),
      hostId: 'host-a',
      skillId: 'fixture-skill',
      name: 'Fixture Skill',
      description: 'Host adoption fixture',
      sourceId: 'local-host:host-a:C:/skills/fixture-skill',
      sourceKind: 'local-host',
      sourceLocator: skillRoot,
      sourceRef: null,
      sourcePath: null,
      scope: 'user',
      scopeId: 'user',
      realPath: skillRoot,
      activationPath: skillRoot,
      observedHash: digest.hash,
      readonly: false,
      managed: false,
    };
    let refreshCount = 0;
    let currentInstances = [instance];
    const inventoryService = {
      async refresh(options) {
        refreshCount += 1;
        assert.deepStrictEqual(options, { force: true });
        return {
          snapshot: {
            revision: digest.hash,
            instances: currentInstances,
            scanErrors: [],
          },
        };
      },
    };
    const uploads = [];
    const service = new HostSkillArtifactService({
      hostId: 'host-a',
      inventoryService,
      relayUrl: 'http://127.0.0.1:8787',
      authToken: 'relay-token',
      tempRoot,
      upload: async (request) => {
        assert(fs.existsSync(request.archivePath));
        const inspected = await inspectSkillArtifactArchive(request.archivePath);
        uploads.push({ request: { ...request }, inspected });
        return { ok: true, artifactId: inspected.artifactId };
      },
    });

    const result = await service.exportInstance(command(instance));
    assert.strictEqual(refreshCount, 1);
    assert.strictEqual(result.adoptionId, 'adoption-1');
    assert.strictEqual(result.instanceId, instance.instanceId);
    assert.strictEqual(result.artifactId, digest.hash);
    assert.strictEqual(uploads.length, 1);
    assert.strictEqual(uploads[0].request.hostId, 'host-a');
    assert.strictEqual(uploads[0].request.uploadToken, 'one-time-token');
    assert.strictEqual(uploads[0].request.uploadPath, command(instance).uploadPath);
    assert.deepStrictEqual(uploads[0].inspected.files.map((file) => file.path), [
      'SKILL.md',
      'references/guide.md',
      'scripts/run.js',
    ]);
    assert(!fs.existsSync(uploads[0].request.archivePath), 'successful export must remove staging archive');

    await assert.rejects(
      service.exportInstance(command(instance, { expectedHash: `sha256:${'f'.repeat(64)}` })),
      /changed|hash|stale/i
    );
    assert.strictEqual(uploads.length, 1);

    currentInstances = [{ ...instance, readonly: true }];
    await assert.rejects(service.exportInstance(command(instance)), /readonly|owned/i);
    currentInstances = [{ ...instance, scope: 'plugin', readonly: false }];
    await assert.rejects(service.exportInstance(command(instance)), /plugin|owned|readonly/i);
    currentInstances = [{ ...instance, scope: 'system', readonly: false }];
    await assert.rejects(service.exportInstance(command(instance)), /system|owned|readonly/i);
    currentInstances = [];
    await assert.rejects(service.exportInstance(command(instance)), /not found|inventory/i);

    currentInstances = [instance];
    const failingService = new HostSkillArtifactService({
      hostId: 'host-a',
      inventoryService,
      relayUrl: 'http://127.0.0.1:8787',
      tempRoot,
      upload: async (request) => {
        assert(fs.existsSync(request.archivePath));
        throw new Error('simulated upload failure');
      },
    });
    await assert.rejects(failingService.exportInstance(command(instance)), /simulated upload failure/);
    assert.deepStrictEqual(
      fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot) : [],
      [],
      'failed export must remove staging archive'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('host skill adoption assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
