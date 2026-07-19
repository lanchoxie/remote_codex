const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  computeSkillInventoryRevision,
  discoverSkillInventory,
  hashSkillDirectory,
  parseSkillMarkdown,
} = require('../shared/skill-inventory');

function writeSkill(root, id, description = `${id} description`, enabled = null) {
  const target = path.join(root, id);
  fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), [
    '---',
    `name: ${id}`,
    `description: ${description}`,
    ...(typeof enabled === 'boolean' ? [`enabled: ${enabled}`] : []),
    '---',
    '',
    `# ${id}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(target, 'scripts', 'run.js'), `module.exports = '${id}';\n`);
  return target;
}

function createDirectoryLink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-inventory-'));
  const codexHome = path.join(root, 'home', '.codex');
  const agentsHome = path.join(root, 'home', '.agents');
  const ccSwitchHome = path.join(root, 'home', '.cc-switch');
  const workspace = path.join(root, 'workspace');
  const malformedWorkspace = path.join(root, 'malformed-workspace');
  const nonRegularLockWorkspace = path.join(root, 'non-regular-lock-workspace');
  const gitWorkspace = path.join(root, 'git-workspace');
  const gitUnsafeRefWorkspace = path.join(root, 'git-unsafe-ref-workspace');
  const pluginRoot = path.join(codexHome, 'plugins', 'cache', 'vendor', 'plugin', '1.0.0', 'skills');

  try {
    writeSkill(path.join(codexHome, 'skills'), 'user-skill');
    writeSkill(path.join(codexHome, 'skills'), 'disabled-skill', 'Disabled fixture', false);
    writeSkill(path.join(codexHome, 'skills', '.system'), 'system-skill');
    writeSkill(path.join(workspace, '.agents', 'skills'), 'project-skill', 'Project fixture');
    writeSkill(path.join(agentsHome, 'skills'), 'shared-skill');
    writeSkill(path.join(agentsHome, 'skills', 'bundle'), 'nested-shared-skill');
    writeSkill(path.join(ccSwitchHome, 'skills'), 'cc-skill');
    writeSkill(pluginRoot, 'plugin-skill');
    const linkedUserTarget = writeSkill(path.join(codexHome, 'superpowers', 'skills'), 'linked-user-skill');
    createDirectoryLink(linkedUserTarget, path.join(codexHome, 'skills', 'linked-user-skill'));
    const linkedSharedBundle = path.join(codexHome, 'superpowers', 'shared-bundle');
    writeSkill(linkedSharedBundle, 'linked-shared-skill');
    createDirectoryLink(linkedSharedBundle, path.join(agentsHome, 'skills', 'superpowers'));
    writeSkill(path.join(workspace, '.agents', 'skills'), 'unsafe-project-skill');
    fs.writeFileSync(path.join(workspace, 'skills-lock.json'), JSON.stringify({
      version: 1,
      skills: {
        'project-skill': {
          source: 'owner/repo',
          sourceType: 'github',
          skillPath: 'skills/project-skill/SKILL.md',
          ref: 'main',
        },
        'unsafe-project-skill': {
          source: 'owner/repo',
          sourceType: 'github',
          skillPath: '../SKILL.md',
          ref: 'main',
        },
      },
    }, null, 2));
    writeSkill(path.join(malformedWorkspace, '.agents', 'skills'), 'malformed-lock-skill');
    fs.writeFileSync(path.join(malformedWorkspace, 'skills-lock.json'), JSON.stringify({ skills: [] }));
    writeSkill(path.join(nonRegularLockWorkspace, '.agents', 'skills'), 'non-regular-lock-skill');
    fs.mkdirSync(path.join(nonRegularLockWorkspace, 'skills-lock.json'), { recursive: true });
    writeSkill(path.join(gitWorkspace, '.agents', 'skills'), 'git-inferred-skill');
    fs.mkdirSync(path.join(gitWorkspace, '.git'), { recursive: true });
    fs.writeFileSync(path.join(gitWorkspace, '.git', 'config'), [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = git@github.com:inferred-owner/inferred-repo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(gitWorkspace, '.git', 'HEAD'), 'ref: refs/heads/feature/skills\n');
    writeSkill(path.join(gitUnsafeRefWorkspace, '.agents', 'skills'), 'git-unsafe-ref-skill');
    fs.mkdirSync(path.join(gitUnsafeRefWorkspace, '.git'), { recursive: true });
    fs.copyFileSync(path.join(gitWorkspace, '.git', 'config'), path.join(gitUnsafeRefWorkspace, '.git', 'config'));
    fs.writeFileSync(path.join(gitUnsafeRefWorkspace, '.git', 'HEAD'), 'ref: refs/heads/../unsafe\n');

    const escapedTarget = writeSkill(path.join(root, 'outside'), 'escaped-skill');
    const escapedLink = path.join(codexHome, 'skills', 'escaped-skill');
    createDirectoryLink(escapedTarget, escapedLink);

    const first = await discoverSkillInventory({
      hostId: 'host-a',
      codexHome,
      agentsHome,
      ccSwitchHome,
      workspaceRoots: [workspace, workspace, malformedWorkspace, nonRegularLockWorkspace, gitWorkspace, gitUnsafeRefWorkspace],
      pluginRoots: [pluginRoot],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });

    const byId = new Map(first.instances.map((item) => [item.skillId, item]));
    assert.strictEqual(byId.get('user-skill').scope, 'user');
    assert.strictEqual(byId.get('disabled-skill').enabled, false);
    assert.strictEqual(byId.get('disabled-skill').state, 'disabled');
    assert.strictEqual(byId.get('system-skill').readonly, true);
    assert.strictEqual(byId.get('project-skill').scope, 'project');
    assert.strictEqual(byId.get('project-skill').sourceKind, 'github');
    assert.strictEqual(byId.get('project-skill').sourceLocator, 'owner/repo');
    assert.strictEqual(byId.get('project-skill').sourceId, 'github:owner/repo:main:skills/project-skill/SKILL.md');
    assert.strictEqual(byId.get('shared-skill').scope, 'shared');
    assert.strictEqual(byId.get('nested-shared-skill').scope, 'shared');
    assert(first.instances.some((item) => item.skillId === 'linked-user-skill' && item.scope === 'user'));
    assert(first.instances.some((item) => item.skillId === 'linked-shared-skill' && item.scope === 'shared'));
    assert.strictEqual(byId.get('cc-skill').scope, 'cc-switch');
    assert.strictEqual(byId.get('plugin-skill').scope, 'plugin');
    assert.strictEqual(byId.get('plugin-skill').readonly, true);
    assert(!byId.has('escaped-skill'), 'links outside a configured source root must be rejected');
    assert(first.scanErrors.some((item) => /outside configured root/i.test(item.message)));
    assert.strictEqual(byId.get('unsafe-project-skill').sourceKind, 'local-host');
    assert(first.scanErrors.some((item) => /unsafe-project-skill.*skillPath|skillPath.*unsafe-project-skill/i.test(item.message)));
    assert(first.scanErrors.some((item) => /skills must be an object/i.test(item.message)));
    assert(byId.has('malformed-lock-skill'), 'a malformed lock must not abort project skill discovery');
    assert(first.scanErrors.some((item) => /not a regular file/i.test(item.message)));
    assert(byId.has('non-regular-lock-skill'), 'a non-regular lock must not abort project discovery');
    assert.strictEqual(byId.get('git-inferred-skill').sourceKind, 'github');
    assert.strictEqual(byId.get('git-inferred-skill').sourceLocator, 'inferred-owner/inferred-repo');
    assert.strictEqual(byId.get('git-inferred-skill').sourceRef, 'feature/skills');
    assert.strictEqual(
      byId.get('git-inferred-skill').sourcePath,
      '.agents/skills/git-inferred-skill/SKILL.md'
    );
    assert.strictEqual(byId.get('git-unsafe-ref-skill').sourceKind, 'github');
    assert.strictEqual(byId.get('git-unsafe-ref-skill').sourceRef, 'HEAD');
    assert.deepStrictEqual(JSON.parse(byId.get('user-skill').instanceId), [
      'host-a',
      'user-skill',
      'user',
      'user',
      byId.get('user-skill').sourceId,
    ]);
    assert(first.revision.startsWith('sha256:'));
    assert.strictEqual(first.instances.filter((item) => item.skillId === 'project-skill').length, 1);

    const parsed = parseSkillMarkdown('---\nname: Fixture\ndescription: Demo\nenabled: true\n---\n');
    assert.deepStrictEqual(parsed, { name: 'Fixture', description: 'Demo', enabled: true });

    const digestBefore = await hashSkillDirectory(byId.get('project-skill').realPath);
    fs.writeFileSync(path.join(byId.get('project-skill').realPath, 'scripts', 'run.js'), "module.exports = 'changed';\n");
    const digestAfter = await hashSkillDirectory(byId.get('project-skill').realPath);
    assert.notStrictEqual(digestAfter.hash, digestBefore.hash);

    const executableFixture = writeSkill(path.join(root, 'hash-fixtures'), 'executable-fixture');
    const executableFile = path.join(executableFixture, 'scripts', 'run.js');
    fs.chmodSync(executableFile, 0o644);
    const nonExecutableDigest = await hashSkillDirectory(executableFixture);
    fs.chmodSync(executableFile, 0o755);
    const executableDigest = await hashSkillDirectory(executableFixture);
    assert.strictEqual(executableDigest.hash, nonExecutableDigest.hash, 'portable hashes must ignore host mode differences');
    await assert.rejects(
      hashSkillDirectory(executableFixture, { maxBytes: 10 }),
      /exceeds|bytes/i
    );
    await assert.rejects(
      hashSkillDirectory(executableFixture, { maxDepth: 0 }),
      /depth/i
    );
    await assert.rejects(
      hashSkillDirectory(executableFixture, { maxEntries: 1 }),
      /entries/i
    );

    const duplicated = [
      { ...byId.get('user-skill'), instanceId: 'duplicate', name: 'A' },
      { ...byId.get('user-skill'), instanceId: 'duplicate', name: 'B' },
    ];
    assert.strictEqual(
      computeSkillInventoryRevision(duplicated),
      computeSkillInventoryRevision(duplicated.slice().reverse()),
      'duplicate instance IDs must not make revisions order-dependent'
    );

    const second = await discoverSkillInventory({
      hostId: 'host-a',
      codexHome,
      agentsHome,
      ccSwitchHome,
      workspaceRoots: [workspace, malformedWorkspace, nonRegularLockWorkspace, gitWorkspace, gitUnsafeRefWorkspace],
      pluginRoots: [pluginRoot],
      scannedAt: '2026-07-12T00:01:00.000Z',
    });
    assert.notStrictEqual(second.revision, first.revision);
    assert.strictEqual(
      computeSkillInventoryRevision(second.instances),
      computeSkillInventoryRevision(second.instances.slice().reverse()),
      'inventory revision must not depend on discovery order'
    );

    const boundedDiscovery = await discoverSkillInventory({
      hostId: 'host-a',
      codexHome,
      agentsHome,
      ccSwitchHome,
      workspaceRoots: [workspace],
      pluginRoots: [pluginRoot],
      maxDiscoveryEntries: 1,
    });
    assert(boundedDiscovery.scanErrors.some((item) => /discovery contains more than 1/i.test(item.message)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => console.log('skill inventory discovery assertions passed')).catch((error) => {
  console.error(error);
  process.exit(1);
});
