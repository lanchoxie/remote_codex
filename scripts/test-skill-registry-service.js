const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSkillArtifactArchive } = require('../shared/skill-artifact');
const { normalizePortableSkillId } = require('../shared/skill-id');
const { SkillRegistryService } = require('../apps/relay/skill-registry-service');

assert.strictEqual(normalizePortableSkillId('Fixture-Skill'), 'fixture-skill');

function writeSkill(root, body = 'first version') {
  const skillRoot = path.join(root, 'fixture-skill');
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: Fixture Skill',
    `description: ${body}`,
    '---',
    '',
    '# Fixture Skill',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), `module.exports = ${JSON.stringify(body)};\n`);
  fs.writeFileSync(path.join(skillRoot, 'assets', 'fixture.bin'), Buffer.from([1, 3, 3, 7]));
  return skillRoot;
}

function metadata(expectedHash, overrides = {}) {
  return {
    skillId: 'fixture-skill',
    name: 'Fixture Skill',
    description: 'Registry fixture',
    sourceId: 'local-host:host-a:C:/skills/fixture-skill',
    sourceKind: 'local-host',
    sourceLocator: 'C:/skills/fixture-skill',
    sourceRef: null,
    sourcePath: null,
    expectedHash,
    ...overrides,
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-'));
  const registryPath = path.join(root, 'registry.json');
  const artifactRoot = path.join(root, 'artifacts');
  let tick = 0;
  const now = () => `2026-07-13T00:00:${String(tick++).padStart(2, '0')}.000Z`;
  try {
    const skillRoot = writeSkill(root);
    const archivePath = path.join(root, 'incoming.rcskill');
    const archive = await createSkillArtifactArchive(skillRoot, archivePath);
    let registry = new SkillRegistryService({ registryPath, artifactRoot, now });

    const imported = await registry.importArchive(archivePath, metadata(archive.contentHash));
    assert.strictEqual(registry.snapshot().revision, 1);
    assert.strictEqual(imported.deduplicated, false);
    assert.strictEqual(imported.artifact.artifactId, archive.contentHash);
    assert.strictEqual(imported.artifact.contentHash, archive.contentHash);
    assert.strictEqual(imported.artifact.fileCount, 3);
    assert.strictEqual(imported.artifact.trustState, 'validated');
    assert.strictEqual(imported.libraryRecord.latestArtifactId, archive.contentHash);
    assert.strictEqual(imported.libraryRecord.archived, false);
    assert.strictEqual(imported.libraryRecord.retiredAt, null);
    assert.strictEqual(imported.artifact.storageState, 'available');
    assert.deepStrictEqual(imported.libraryRecord.artifactIds, [archive.contentHash]);
    assert(fs.existsSync(imported.artifact.archivePath));
    assert.deepStrictEqual(fs.readFileSync(imported.artifact.archivePath), fs.readFileSync(archivePath));

    const resolvedArtifact = registry.getArtifact(archive.contentHash);
    assert.strictEqual(resolvedArtifact.artifactId, archive.contentHash);
    assert.strictEqual(resolvedArtifact.archivePath, imported.artifact.archivePath);
    resolvedArtifact.skillId = 'mutated-outside-registry';
    assert.strictEqual(registry.getArtifact(archive.contentHash).skillId, 'fixture-skill');
    assert.strictEqual(registry.getArtifact(`sha256:${'0'.repeat(64)}`), null);

    const firstSnapshot = registry.snapshot();
    assert.strictEqual(firstSnapshot.sources.length, 1);
    assert.strictEqual(firstSnapshot.sources[0].kind, 'local-host');
    assert.strictEqual(firstSnapshot.artifacts.length, 1);
    assert.strictEqual(firstSnapshot.library.length, 1);
    assert.strictEqual(firstSnapshot.artifacts[0].sources[0].sourceId, metadata().sourceId);
    const summarySnapshot = registry.snapshot({ includeManifest: false });
    assert.strictEqual(summarySnapshot.artifacts[0].fileCount, 3);
    assert(!Object.prototype.hasOwnProperty.call(summarySnapshot.artifacts[0], 'manifest'));
    assert.strictEqual(registry.getSource(metadata().sourceId).sourceId, metadata().sourceId);
    assert.strictEqual(registry.getLibraryRecord('fixture-skill').skillId, 'fixture-skill');
    assert.strictEqual(
      registry.isActiveLibraryArtifact('fixture-skill', archive.contentHash),
      true
    );

    const initialVersionCreatedAt = imported.libraryRecord.versions[0].createdAt;
    const duplicate = await registry.importArchive(archivePath, metadata(archive.contentHash));
    assert.strictEqual(duplicate.deduplicated, true);
    assert.strictEqual(registry.snapshot().artifacts.length, 1);
    assert.deepStrictEqual(registry.snapshot().library[0].artifactIds, [archive.contentHash]);
    assert.strictEqual(registry.snapshot().library[0].versions[0].createdAt, initialVersionCreatedAt);

    const alternateSource = await registry.importArchive(archivePath, metadata(archive.contentHash, {
      sourceId: 'github:owner/repo:main:skills/fixture-skill/SKILL.md',
      sourceKind: 'github',
      sourceLocator: 'owner/repo',
      sourceRef: 'main',
      sourcePath: 'skills/fixture-skill/SKILL.md',
    }));
    assert.strictEqual(alternateSource.deduplicated, true);
    assert.strictEqual(alternateSource.artifact.sources.length, 2);
    assert.strictEqual(registry.snapshot().sources.length, 2);
    assert.strictEqual(registry.snapshot().library[0].versions.length, 2);
    const githubSourceId = alternateSource.artifact.sources.find((source) => source.sourceId.startsWith('github:')).sourceId;
    const automation = await registry.updateSourceAutomation(githubSourceId, {
      expectedRevision: registry.snapshot().revision,
      refreshPolicy: 'daily',
      rolloutPolicy: 'enabled-hosts',
    });
    assert.strictEqual(automation.source.refreshPolicy, 'daily');
    assert.strictEqual(automation.source.rolloutPolicy, 'enabled-hosts');
    assert.strictEqual(registry.getSource(githubSourceId).rolloutPolicy, 'enabled-hosts');
    await assert.rejects(
      registry.updateSourceAutomation(githubSourceId, { refreshPolicy: 'minute' }),
      /refreshPolicy/
    );

    fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), 'module.exports = "second version";\n');
    const secondArchivePath = path.join(root, 'second.rcskill');
    const secondArchive = await createSkillArtifactArchive(skillRoot, secondArchivePath);
    const versioned = await registry.importArchive(secondArchivePath, metadata(secondArchive.contentHash));
    assert.strictEqual(versioned.deduplicated, false);
    assert.strictEqual(versioned.libraryRecord.latestArtifactId, secondArchive.contentHash);
    assert.deepStrictEqual(versioned.libraryRecord.artifactIds, [archive.contentHash, secondArchive.contentHash]);
    assert.strictEqual(registry.snapshot().artifacts.length, 2);

    const beforeRefreshRevision = registry.snapshot().revision;
    const refreshingSource = await registry.markSourceRefreshStarted(metadata().sourceId);
    assert(refreshingSource.lastRefreshAt);
    assert.strictEqual(refreshingSource.lastError, null);
    const failedSource = await registry.markSourceRefreshFailed(
      metadata().sourceId,
      'simulated refresh failure'
    );
    assert.strictEqual(failedSource.lastError, 'simulated refresh failure');
    assert.strictEqual(registry.snapshot().revision, beforeRefreshRevision + 2);

    const retireRevision = registry.snapshot().revision;
    const retired = await registry.retireSkill('fixture-skill', {
      expectedRevision: retireRevision,
    });
    assert.strictEqual(retired.libraryRecord.archived, true);
    assert(retired.libraryRecord.retiredAt);
    assert.strictEqual(
      registry.isActiveLibraryArtifact('fixture-skill', secondArchive.contentHash),
      false
    );
    await assert.rejects(
      registry.restoreSkill('fixture-skill', { expectedRevision: retireRevision }),
      /revision/i
    );

    fs.writeFileSync(path.join(skillRoot, 'scripts', 'run.js'), 'module.exports = "third version";\n');
    const thirdArchivePath = path.join(root, 'third.rcskill');
    const thirdArchive = await createSkillArtifactArchive(skillRoot, thirdArchivePath);
    const importedWhileRetired = await registry.importArchive(
      thirdArchivePath,
      metadata(thirdArchive.contentHash)
    );
    assert.strictEqual(importedWhileRetired.libraryRecord.archived, true);
    assert(importedWhileRetired.libraryRecord.retiredAt);

    const restoredLifecycle = await registry.restoreSkill('fixture-skill', {
      expectedRevision: registry.snapshot().revision,
    });
    assert.strictEqual(restoredLifecycle.libraryRecord.archived, false);
    assert.strictEqual(restoredLifecycle.libraryRecord.retiredAt, null);
    assert.strictEqual(
      registry.isActiveLibraryArtifact('fixture-skill', thirdArchive.contentHash),
      true
    );

    const shared = await registry.importArchive(thirdArchivePath, metadata(thirdArchive.contentHash, {
      skillId: 'fixture-alias',
      name: 'Fixture Alias',
      sourceId: 'github:owner/repo:main:skills/fixture-alias/SKILL.md',
      sourceKind: 'github',
      sourceLocator: 'owner/repo',
      sourceRef: 'main',
      sourcePath: 'skills/fixture-alias/SKILL.md',
    }));
    assert(shared.artifact.skillIds.includes('fixture-skill'));
    assert(shared.artifact.skillIds.includes('fixture-alias'));
    await registry.retireSkill('fixture-skill');

    const sharedReport = registry.referenceReport({
      artifactIds: [thirdArchive.contentHash],
      references: [],
    });
    assert.strictEqual(sharedReport.artifacts[0].collectible, false);
    assert(sharedReport.artifacts[0].blockers.some((blocker) => (
      blocker.kind === 'active-library'
      && blocker.skillId === 'fixture-alias'
    )));

    await registry.retireSkill('fixture-alias');
    const externallyBlocked = registry.referenceReport({
      artifactIds: [thirdArchive.contentHash],
      references: [{
        kind: 'applied',
        artifactId: thirdArchive.contentHash,
        skillId: 'fixture-skill',
        hostId: 'host-a',
        state: 'enabled',
      }],
    });
    assert.strictEqual(externallyBlocked.artifacts[0].collectible, false);
    assert(externallyBlocked.blockers.some((blocker) => blocker.kind === 'applied'));

    const blockedCollection = await registry.collectGarbage({
      artifactIds: [thirdArchive.contentHash],
      references: externallyBlocked.blockers.filter((blocker) => blocker.kind === 'applied'),
      expectedRevision: registry.snapshot().revision,
    });
    assert.deepStrictEqual(blockedCollection.collectedArtifactIds, []);
    assert.deepStrictEqual(blockedCollection.blockedArtifactIds, [thirdArchive.contentHash]);
    assert(fs.existsSync(registry.artifactPath(thirdArchive.contentHash)));

    let failUnlink = true;
    registry.unlinkArchive = async (archiveToDelete) => {
      if (failUnlink) {
        failUnlink = false;
        const error = new Error('simulated archive busy');
        error.code = 'EBUSY';
        throw error;
      }
      await fs.promises.unlink(archiveToDelete);
    };
    const pendingCollection = await registry.collectGarbage({
      artifactIds: [thirdArchive.contentHash],
      references: [],
      expectedRevision: registry.snapshot().revision,
    });
    assert.deepStrictEqual(pendingCollection.pendingArtifactIds, [thirdArchive.contentHash]);
    assert.strictEqual(registry.getArtifact(thirdArchive.contentHash).storageState, 'gc-pending');
    assert(fs.existsSync(registry.artifactPath(thirdArchive.contentHash)));
    assert(!registry.getLibraryRecord('fixture-skill').artifactIds.includes(thirdArchive.contentHash));
    assert(!registry.getLibraryRecord('fixture-alias').artifactIds.includes(thirdArchive.contentHash));

    registry = new SkillRegistryService({ registryPath, artifactRoot, now });
    assert.strictEqual(
      registry.getArtifact(thirdArchive.contentHash).storageState,
      'gc-pending',
      'restart must not unlink pending garbage before external references are loaded'
    );
    assert(fs.existsSync(registry.artifactPath(thirdArchive.contentHash)));
    const blockedPendingAfterRestart = await registry.collectGarbage({
      artifactIds: [thirdArchive.contentHash],
      references: [{
        kind: 'applied',
        artifactId: thirdArchive.contentHash,
        skillId: 'fixture-skill',
        hostId: 'host-a',
        state: 'enabled',
      }],
      expectedRevision: registry.snapshot().revision,
    });
    assert.deepStrictEqual(blockedPendingAfterRestart.blockedArtifactIds, [thirdArchive.contentHash]);
    assert(fs.existsSync(registry.artifactPath(thirdArchive.contentHash)));

    const collected = await registry.collectGarbage({
      artifactIds: [thirdArchive.contentHash],
      references: [],
      expectedRevision: registry.snapshot().revision,
    });
    assert.deepStrictEqual(collected.collectedArtifactIds, [thirdArchive.contentHash]);
    assert.deepStrictEqual(collected.pendingArtifactIds, []);
    assert.strictEqual(registry.getArtifact(thirdArchive.contentHash).storageState, 'collected');
    assert.strictEqual(registry.getArtifact(thirdArchive.contentHash).archiveBytes, 0);
    assert.strictEqual(fs.existsSync(registry.artifactPath(thirdArchive.contentHash)), false);

    const rehydrated = await registry.importArchive(thirdArchivePath, metadata(thirdArchive.contentHash));
    assert.strictEqual(rehydrated.artifact.storageState, 'available');
    assert.strictEqual(rehydrated.libraryRecord.archived, true);
    assert(fs.existsSync(registry.artifactPath(thirdArchive.contentHash)));

    const beforeMismatch = registry.snapshot();
    for (const unsafeSkillId of ['.system', '.remote-codex-staging', 'CON', 'foo.']) {
      await assert.rejects(
        registry.importArchive(secondArchivePath, metadata(secondArchive.contentHash, { skillId: unsafeSkillId })),
        /reserved|safe|portable|skillId/i
      );
    }
    await assert.rejects(
      registry.importArchive(secondArchivePath, metadata(`sha256:${'f'.repeat(64)}`)),
      /expected|hash/i
    );
    assert.deepStrictEqual(registry.snapshot(), beforeMismatch);

    const restored = new SkillRegistryService({ registryPath, artifactRoot, now });
    assert.deepStrictEqual(restored.snapshot(), registry.snapshot());
    const persisted = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    assert.strictEqual(persisted.version, 1);
    assert(Number.isSafeInteger(persisted.revision));
    assert.strictEqual(Object.keys(persisted.artifacts).length, 3);
    assert.strictEqual(Object.keys(persisted.library).length, 2);
    assert(!fs.readdirSync(root).some((name) => name.endsWith('.tmp')), 'registry temp files must be removed');

    const storedPath = restored.snapshot().artifacts.find((item) => item.artifactId === archive.contentHash).archivePath;
    const stored = fs.readFileSync(storedPath);
    stored[stored.length - 1] ^= 0xff;
    fs.writeFileSync(storedPath, stored);
    await assert.rejects(
      restored.importArchive(archivePath, metadata(archive.contentHash)),
      /stored artifact|corrupt|hash/i
    );

    const malformedPath = path.join(root, 'malformed-registry.json');
    fs.writeFileSync(malformedPath, '{not-json', 'utf8');
    assert.throws(
      () => new SkillRegistryService({ registryPath: malformedPath, artifactRoot }),
      /invalid Skill registry state JSON/i
    );

    const invalidSchemaPath = path.join(root, 'invalid-schema-registry.json');
    fs.writeFileSync(invalidSchemaPath, JSON.stringify({
      version: 1,
      sources: {},
      artifacts: [],
      library: {},
    }), 'utf8');
    assert.throws(
      () => new SkillRegistryService({ registryPath: invalidSchemaPath, artifactRoot }),
      /schema|state/i
    );

    const canonicalState = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const canonicalArtifact = Object.values(canonicalState.artifacts).find((artifactRecord) => (
      artifactRecord.storageState === 'available'
    ));
    const noncanonicalArtifactKeyPath = path.join(root, 'noncanonical-artifact-key.json');
    fs.writeFileSync(noncanonicalArtifactKeyPath, JSON.stringify({
      ...canonicalState,
      artifacts: {
        [canonicalArtifact.artifactId.toUpperCase()]: canonicalArtifact,
      },
      library: {},
    }));
    assert.throws(
      () => new SkillRegistryService({ registryPath: noncanonicalArtifactKeyPath, artifactRoot }),
      /canonical|Artifact|state/i
    );

    const noncanonicalLibraryKeyPath = path.join(root, 'noncanonical-library-key.json');
    const canonicalLibrary = Object.values(canonicalState.library)[0];
    fs.writeFileSync(noncanonicalLibraryKeyPath, JSON.stringify({
      ...canonicalState,
      library: {
        'Fixture-Skill': canonicalLibrary,
      },
    }));
    assert.throws(
      () => new SkillRegistryService({ registryPath: noncanonicalLibraryKeyPath, artifactRoot }),
      /canonical|Library|state/i
    );

    const wrongSkillLinkPath = path.join(root, 'wrong-skill-link.json');
    const supportedVersion = canonicalLibrary.versions.find((version) => (
      version.artifactId === canonicalArtifact.artifactId
    ));
    fs.writeFileSync(wrongSkillLinkPath, JSON.stringify({
      ...canonicalState,
      library: {
        'unrelated-skill': {
          ...canonicalLibrary,
          skillId: 'unrelated-skill',
          artifactIds: [canonicalArtifact.artifactId],
          latestArtifactId: canonicalArtifact.artifactId,
          versions: [supportedVersion],
          archived: true,
        },
      },
    }));
    assert.throws(
      () => new SkillRegistryService({ registryPath: wrongSkillLinkPath, artifactRoot }),
      /belong|support|Library|state/i
    );

    const mixedRestorePath = path.join(root, 'mixed-restore.json');
    const mixedRestoreState = JSON.parse(JSON.stringify(canonicalState));
    const mixedLibrary = Object.values(mixedRestoreState.library).find((record) => (
      record.artifactIds.length > 1
    ));
    const collectedLinkId = mixedLibrary.artifactIds.find((artifactId) => (
      artifactId !== mixedLibrary.latestArtifactId
    ));
    mixedRestoreState.artifacts[collectedLinkId] = {
      ...mixedRestoreState.artifacts[collectedLinkId],
      storageState: 'collected',
      archiveBytes: 0,
      manifest: null,
      collectedAt: '2026-07-13T03:00:00.000Z',
    };
    mixedLibrary.archived = true;
    mixedLibrary.retiredAt = '2026-07-13T03:00:00.000Z';
    fs.writeFileSync(mixedRestorePath, JSON.stringify(mixedRestoreState));
    const mixedRestoreRegistry = new SkillRegistryService({
      registryPath: mixedRestorePath,
      artifactRoot,
    });
    const mixedRestored = await mixedRestoreRegistry.restoreSkill(mixedLibrary.skillId);
    assert.strictEqual(mixedRestored.libraryRecord.archived, false);
    assert(!mixedRestored.libraryRecord.artifactIds.includes(collectedLinkId));
    assert(!mixedRestored.libraryRecord.versions.some((version) => (
      version.artifactId === collectedLinkId
    )));
    assert.doesNotThrow(() => new SkillRegistryService({
      registryPath: mixedRestorePath,
      artifactRoot,
    }));

    const missingArchivePath = path.join(root, 'missing-archive-registry.json');
    const missingArchiveState = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const availableArtifact = Object.values(missingArchiveState.artifacts).find((artifactRecord) => (
      artifactRecord.storageState === 'available'
    ));
    fs.writeFileSync(missingArchivePath, JSON.stringify({
      ...missingArchiveState,
      artifacts: {
        [availableArtifact.artifactId]: {
          ...availableArtifact,
          archivePath: path.join(root, 'does-not-exist.rcskill'),
        },
      },
      library: {},
    }), 'utf8');
    assert.throws(
      () => new SkillRegistryService({ registryPath: missingArchivePath, artifactRoot }),
      /archivePath|missing|available/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('skill registry service assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
