const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SkillDeploymentService } = require('../apps/relay/skill-deployment-service');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-deployment-service-'));
  const statePath = path.join(root, 'deployments.json');
  let id = 0;
  let tick = 0;
  const options = {
    statePath,
    idFactory: () => `deployment-${++id}`,
    now: () => `2026-07-13T01:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  const artifactId = `sha256:${'a'.repeat(64)}`;
  const secondArtifactId = `sha256:${'b'.repeat(64)}`;
  try {
    let appliedId = 0;
    let appliedTick = 0;
    const appliedStatePath = path.join(root, 'applied-projection.json');
    const appliedService = new SkillDeploymentService({
      statePath: appliedStatePath,
      idFactory: () => `applied-deployment-${++appliedId}`,
      now: () => `2026-07-13T00:00:${String(appliedTick++).padStart(2, '0')}.000Z`,
    });
    const appliedEnable = appliedService.createDeployment({
      skillId: 'projection-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-projection'],
      targetScope: 'user',
    }).deployment;
    appliedService.markQueued(appliedEnable.deploymentId, 'host-projection');
    const appliedEnableResult = appliedService.applyResult({
      deploymentId: appliedEnable.deploymentId,
      hostId: 'host-projection',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    assert.deepStrictEqual(appliedService.appliedStates(), [{
      deploymentId: appliedEnable.deploymentId,
      hostId: 'host-projection',
      skillId: 'projection-skill',
      artifactId,
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      appliedState: 'enabled',
      updatedAt: appliedEnableResult.updatedAt,
    }], 'a successful Enable must durably project its Artifact');
    const enableJournalEntry = JSON.parse(
      fs.readFileSync(`${appliedStatePath}.results.jsonl`, 'utf8').trim().split('\n').at(-1)
    );
    assert.deepStrictEqual(enableJournalEntry.appliedMutation, {
      appliedKey: JSON.stringify(['host-projection', 'projection-skill', 'user', 'user']),
      deploymentId: appliedEnable.deploymentId,
      deploymentCreatedAt: appliedEnable.createdAt,
      deploymentGeneration: appliedEnable.generation,
      uncertainArtifactIds: [],
      skillWideUncertain: false,
      hostId: 'host-projection',
      skillId: 'projection-skill',
      artifactId,
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      appliedState: 'enabled',
      updatedAt: appliedEnableResult.updatedAt,
    }, 'the result journal must contain the exact applied-state mutation');

    const appliedAfterJournalReplay = new SkillDeploymentService({ statePath: appliedStatePath });
    assert.deepStrictEqual(
      appliedAfterJournalReplay.appliedStates(),
      appliedService.appliedStates(),
      'a successful result must restore its applied projection from the result journal'
    );
    const failedDisable = appliedAfterJournalReplay.createDeployment({
      skillId: 'projection-skill',
      artifactId,
      action: 'disable',
      targetHostIds: ['host-projection'],
      targetScope: 'user',
    }).deployment;
    appliedAfterJournalReplay.markQueued(failedDisable.deploymentId, 'host-projection');
    appliedAfterJournalReplay.applyResult({
      deploymentId: failedDisable.deploymentId,
      hostId: 'host-projection',
      ok: false,
      error: 'simulated Disable failure',
    });
    assert.strictEqual(
      JSON.parse(fs.readFileSync(`${appliedStatePath}.results.jsonl`, 'utf8').trim().split('\n').at(-1))
        .appliedMutation,
      null,
      'failed results must journal an explicit no-op applied mutation'
    );
    assert.strictEqual(appliedAfterJournalReplay.appliedStates()[0].appliedState, 'enabled');
    assert.strictEqual(appliedAfterJournalReplay.appliedStates()[0].artifactId, artifactId);

    const unknownSeedService = new SkillDeploymentService({
      statePath: path.join(root, 'unknown-seed.json'),
      idFactory: () => 'unknown-seed-deployment',
    });
    const originalFsyncSync = fs.fsyncSync;
    let desiredSnapshotFsyncs = 0;
    fs.fsyncSync = (fd) => {
      desiredSnapshotFsyncs += 1;
      return originalFsyncSync(fd);
    };
    let unknownSeedDeployment;
    try {
      unknownSeedDeployment = unknownSeedService.createDeployment({
        skillId: 'unknown-seed-skill',
        artifactId: secondArtifactId,
        action: 'enable',
        targetHostIds: ['host-unknown-seed'],
        targetScope: 'user',
      }).deployment;
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
    assert(desiredSnapshotFsyncs > 0, 'desired/applied snapshot must fsync before publication');
    assert(unknownSeedService.artifactReferences().some((reference) => (
      reference.kind === 'applied'
      && reference.skillId === 'unknown-seed-skill'
      && reference.artifactId === null
      && reference.state === 'unknown'
    )), 'a first deployment must conservatively represent unknown pre-existing Host state');
    unknownSeedService.markQueued(unknownSeedDeployment.deploymentId, 'host-unknown-seed');
    unknownSeedService.applyResult({
      deploymentId: unknownSeedDeployment.deploymentId,
      hostId: 'host-unknown-seed',
      ok: false,
      error: 'simulated first Enable failure',
    });
    assert(unknownSeedService.artifactReferences().some((reference) => (
      reference.kind === 'applied' && reference.state === 'unknown'
    )), 'a failed first Enable must preserve the unknown applied projection');

    const partialAppliedState = JSON.parse(
      fs.readFileSync(path.join(root, 'unknown-seed.json'), 'utf8')
    );
    partialAppliedState.applied = {};
    fs.writeFileSync(path.join(root, 'unknown-seed.json'), JSON.stringify(partialAppliedState));
    fs.writeFileSync(path.join(root, 'unknown-seed.json.results.jsonl'), '');
    assert.strictEqual(
      new SkillDeploymentService({ statePath: path.join(root, 'unknown-seed.json') })
        .appliedStates()[0].appliedState,
      'unknown',
      'loading a partial applied map must fill every missing desired key conservatively'
    );

    let inFlightId = 0;
    const inFlightService = new SkillDeploymentService({
      statePath: path.join(root, 'superseded-in-flight.json'),
      idFactory: () => `in-flight-${++inFlightId}`,
    });
    const inFlightOld = inFlightService.createDeployment({
      skillId: 'in-flight-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-in-flight'],
      targetScope: 'user',
    }).deployment;
    inFlightService.markQueued(inFlightOld.deploymentId, 'host-in-flight');
    inFlightService.markRunningMany(inFlightOld.deploymentId, ['host-in-flight']);
    const inFlightNew = inFlightService.createDeployment({
      skillId: 'in-flight-skill',
      artifactId: secondArtifactId,
      action: 'enable',
      targetHostIds: ['host-in-flight'],
      targetScope: 'user',
    }).deployment;
    assert(inFlightService.artifactReferences().some((reference) => (
      reference.kind === 'deployment'
      && reference.artifactId === artifactId
      && reference.deploymentId === inFlightOld.deploymentId
      && reference.state === 'superseded-running'
    )), 'a superseded command already delivered to a Host must retain its Artifact');
    const lateOldSuccess = inFlightService.applyResult({
      deploymentId: inFlightOld.deploymentId,
      hostId: 'host-in-flight',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    assert.strictEqual(lateOldSuccess.state, 'succeeded');
    assert.strictEqual(inFlightService.appliedStates()[0].artifactId, artifactId);
    inFlightService.markQueued(inFlightNew.deploymentId, 'host-in-flight');
    inFlightService.applyResult({
      deploymentId: inFlightNew.deploymentId,
      hostId: 'host-in-flight',
      ok: true,
      state: 'enabled',
      observedHash: secondArtifactId,
    });
    assert.strictEqual(inFlightService.appliedStates()[0].artifactId, secondArtifactId);

    const equalTimestampPath = path.join(root, 'equal-timestamp-generation.json');
    const equalTimestampIds = ['z-older-deployment', 'a-newer-deployment'];
    const equalTimestampService = new SkillDeploymentService({
      statePath: equalTimestampPath,
      idFactory: () => equalTimestampIds.shift(),
      now: () => '2026-07-13T00:30:00.000Z',
    });
    const equalTimestampOld = equalTimestampService.createDeployment({
      skillId: 'equal-timestamp-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-equal-timestamp'],
      targetScope: 'user',
    }).deployment;
    equalTimestampService.markQueued(equalTimestampOld.deploymentId, 'host-equal-timestamp');
    equalTimestampService.markRunningMany(equalTimestampOld.deploymentId, ['host-equal-timestamp']);
    const equalTimestampNew = equalTimestampService.createDeployment({
      skillId: 'equal-timestamp-skill',
      artifactId: secondArtifactId,
      action: 'enable',
      targetHostIds: ['host-equal-timestamp'],
      targetScope: 'user',
    }).deployment;
    equalTimestampService.markQueued(equalTimestampNew.deploymentId, 'host-equal-timestamp');
    equalTimestampService.applyResult({
      deploymentId: equalTimestampNew.deploymentId,
      hostId: 'host-equal-timestamp',
      ok: true,
      state: 'enabled',
      observedHash: secondArtifactId,
    });
    equalTimestampService.applyResult({
      deploymentId: equalTimestampOld.deploymentId,
      hostId: 'host-equal-timestamp',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    assert.strictEqual(
      equalTimestampService.appliedStates()[0].artifactId,
      secondArtifactId,
      'monotonic deployment generation must beat equal timestamps and reverse-sorted IDs'
    );
    assert.strictEqual(
      new SkillDeploymentService({ statePath: equalTimestampPath }).appliedStates()[0].artifactId,
      secondArtifactId,
      'monotonic deployment generation must survive journal replay and restart'
    );

    const staleOld = inFlightService.createDeployment({
      skillId: 'in-flight-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-in-flight'],
      targetScope: 'user',
    }).deployment;
    inFlightService.markQueued(staleOld.deploymentId, 'host-in-flight');
    inFlightService.markRunningMany(staleOld.deploymentId, ['host-in-flight']);
    const newerWinner = inFlightService.createDeployment({
      skillId: 'in-flight-skill',
      artifactId: secondArtifactId,
      action: 'enable',
      targetHostIds: ['host-in-flight'],
      targetScope: 'user',
    }).deployment;
    inFlightService.markQueued(newerWinner.deploymentId, 'host-in-flight');
    inFlightService.applyResult({
      deploymentId: newerWinner.deploymentId,
      hostId: 'host-in-flight',
      ok: true,
      state: 'enabled',
      observedHash: secondArtifactId,
    });
    inFlightService.applyResult({
      deploymentId: staleOld.deploymentId,
      hostId: 'host-in-flight',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    assert.strictEqual(
      inFlightService.appliedStates()[0].artifactId,
      secondArtifactId,
      'a late older result must not overwrite a newer successful projection'
    );

    let prunedLateId = 0;
    const prunedLatePath = path.join(root, 'pruned-late-result.json');
    let prunedLateService = new SkillDeploymentService({
      statePath: prunedLatePath,
      historyLimit: 1,
      idFactory: () => `pruned-late-${++prunedLateId}`,
    });
    const prunedLateOld = prunedLateService.createDeployment({
      skillId: 'pruned-late-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-pruned-late'],
      targetScope: 'user',
    }).deployment;
    prunedLateService.markQueued(prunedLateOld.deploymentId, 'host-pruned-late');
    prunedLateService.markRunningMany(prunedLateOld.deploymentId, ['host-pruned-late']);
    const prunedLateWinner = prunedLateService.createDeployment({
      skillId: 'pruned-late-skill',
      artifactId: secondArtifactId,
      action: 'enable',
      targetHostIds: ['host-pruned-late'],
      targetScope: 'user',
    }).deployment;
    prunedLateService.markQueued(prunedLateWinner.deploymentId, 'host-pruned-late');
    prunedLateService.applyResult({
      deploymentId: prunedLateWinner.deploymentId,
      hostId: 'host-pruned-late',
      ok: true,
      state: 'enabled',
      observedHash: secondArtifactId,
    });
    const prunedLateFailedCurrent = prunedLateService.createDeployment({
      skillId: 'pruned-late-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-pruned-late'],
      targetScope: 'user',
    }).deployment;
    prunedLateService.markQueued(prunedLateFailedCurrent.deploymentId, 'host-pruned-late');
    prunedLateService.applyResult({
      deploymentId: prunedLateFailedCurrent.deploymentId,
      hostId: 'host-pruned-late',
      ok: false,
      error: 'newer desired deployment failed',
    });
    assert.strictEqual(prunedLateService.getDeployment(prunedLateWinner.deploymentId), null);

    const legacyPrunedLatePath = path.join(root, 'legacy-pruned-late-result.json');
    const legacyPrunedLateState = JSON.parse(fs.readFileSync(prunedLatePath, 'utf8'));
    delete legacyPrunedLateState.nextDeploymentGeneration;
    for (const deployment of Object.values(legacyPrunedLateState.deployments || {})) {
      delete deployment.generation;
    }
    for (const tombstone of Object.values(legacyPrunedLateState.tombstones || {})) {
      delete tombstone.generation;
    }
    for (const applied of Object.values(legacyPrunedLateState.applied || {})) {
      delete applied.deploymentCreatedAt;
      delete applied.deploymentGeneration;
    }
    fs.writeFileSync(legacyPrunedLatePath, JSON.stringify(legacyPrunedLateState));
    fs.copyFileSync(`${prunedLatePath}.results.jsonl`, `${legacyPrunedLatePath}.results.jsonl`);
    const legacyPrunedLateService = new SkillDeploymentService({
      statePath: legacyPrunedLatePath,
      historyLimit: 1,
    });
    legacyPrunedLateService.applyResult({
      deploymentId: prunedLateOld.deploymentId,
      hostId: 'host-pruned-late',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    assert.strictEqual(legacyPrunedLateService.appliedStates()[0].artifactId, secondArtifactId);
    assert.deepStrictEqual(
      legacyPrunedLateService.appliedStates()[0].uncertainArtifactIds,
      [artifactId],
      'manager projection must expose exact legacy ordering uncertainty for cleanup'
    );
    assert(legacyPrunedLateService.artifactReferences().some((reference) => (
      reference.kind === 'applied-uncertain'
      && reference.artifactId === artifactId
      && reference.state === 'unknown-order'
    )), 'legacy applied ordering uncertainty must retain both possible Artifacts');

    prunedLateService = new SkillDeploymentService({
      statePath: prunedLatePath,
      historyLimit: 1,
    });
    assert(prunedLateService.artifactReferences().some((reference) => (
      reference.state === 'superseded-running'
      && reference.deploymentId === prunedLateOld.deploymentId
    )));
    prunedLateService.applyResult({
      deploymentId: prunedLateOld.deploymentId,
      hostId: 'host-pruned-late',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    assert.strictEqual(
      prunedLateService.appliedStates()[0].artifactId,
      secondArtifactId,
      'applied generation ordering must survive history pruning and restart'
    );

    const supersededEnable = appliedAfterJournalReplay.createDeployment({
      skillId: 'projection-skill',
      artifactId: secondArtifactId,
      action: 'enable',
      targetHostIds: ['host-projection'],
      targetScope: 'user',
    }).deployment;
    const replacementDisable = appliedAfterJournalReplay.createDeployment({
      skillId: 'projection-skill',
      artifactId,
      action: 'disable',
      targetHostIds: ['host-projection'],
      targetScope: 'user',
    }).deployment;
    assert.strictEqual(
      appliedAfterJournalReplay.getDeployment(supersededEnable.deploymentId)
        .results[0].state,
      'superseded'
    );
    assert.strictEqual(appliedAfterJournalReplay.appliedStates()[0].appliedState, 'enabled');
    assert.strictEqual(appliedAfterJournalReplay.appliedStates()[0].artifactId, artifactId);

    appliedAfterJournalReplay.markQueued(replacementDisable.deploymentId, 'host-projection');
    const disableResult = appliedAfterJournalReplay.applyResult({
      deploymentId: replacementDisable.deploymentId,
      hostId: 'host-projection',
      ok: true,
      state: 'disabled',
    });
    assert.deepStrictEqual(appliedAfterJournalReplay.appliedStates()[0], {
      deploymentId: replacementDisable.deploymentId,
      hostId: 'host-projection',
      skillId: 'projection-skill',
      artifactId,
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      appliedState: 'disabled',
      updatedAt: disableResult.updatedAt,
    }, 'a successful Disable must retain the applied Artifact');

    const failedRemove = appliedAfterJournalReplay.createDeployment({
      skillId: 'projection-skill',
      artifactId,
      action: 'remove',
      targetHostIds: ['host-projection'],
      targetScope: 'user',
    }).deployment;
    appliedAfterJournalReplay.markQueued(failedRemove.deploymentId, 'host-projection');
    appliedAfterJournalReplay.applyResult({
      deploymentId: failedRemove.deploymentId,
      hostId: 'host-projection',
      ok: false,
      error: 'simulated Remove failure',
    });
    assert.strictEqual(appliedAfterJournalReplay.appliedStates()[0].appliedState, 'disabled');
    assert.strictEqual(appliedAfterJournalReplay.appliedStates()[0].artifactId, artifactId);
    assert.strictEqual(
      appliedAfterJournalReplay.appliedStates()[0].skillWideUncertain,
      true,
      'manager projection must expose failed cleanup uncertainty for retry'
    );
    assert(appliedAfterJournalReplay.artifactReferences().some((reference) => (
      reference.kind === 'applied-uncertain'
      && reference.skillId === 'projection-skill'
      && reference.artifactId === null
      && reference.state === 'cleanup-failed'
    )), 'failed Remove must conservatively block every Artifact for the Skill');
    const legacyCleanupJournalPath = path.join(root, 'legacy-cleanup-failure-journal.json');
    fs.copyFileSync(appliedStatePath, legacyCleanupJournalPath);
    const legacyCleanupJournalEntries = fs.readFileSync(
      `${appliedStatePath}.results.jsonl`,
      'utf8'
    ).trim().split('\n').map((line) => JSON.parse(line));
    delete legacyCleanupJournalEntries.at(-1).skillWideUncertain;
    fs.writeFileSync(
      `${legacyCleanupJournalPath}.results.jsonl`,
      `${legacyCleanupJournalEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    );
    assert(new SkillDeploymentService({ statePath: legacyCleanupJournalPath })
      .artifactReferences().some((reference) => (
        reference.kind === 'applied-uncertain' && reference.state === 'cleanup-failed'
      )), 'legacy cleanup failure journals must infer Skill-wide uncertainty');

    const prunedCleanupPath = path.join(root, 'legacy-pruned-cleanup-failure.json');
    let prunedCleanupId = 0;
    const prunedCleanupService = new SkillDeploymentService({
      statePath: prunedCleanupPath,
      historyLimit: 1,
      idFactory: () => `pruned-cleanup-${++prunedCleanupId}`,
    });
    const prunedCleanupEnable = prunedCleanupService.createDeployment({
      skillId: 'pruned-cleanup-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-pruned-cleanup'],
      targetScope: 'user',
    }).deployment;
    prunedCleanupService.markQueued(prunedCleanupEnable.deploymentId, 'host-pruned-cleanup');
    prunedCleanupService.applyResult({
      deploymentId: prunedCleanupEnable.deploymentId,
      hostId: 'host-pruned-cleanup',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    const prunedCleanupFailure = prunedCleanupService.createDeployment({
      skillId: 'pruned-cleanup-skill',
      artifactId,
      action: 'remove',
      targetHostIds: ['host-pruned-cleanup'],
      targetScope: 'user',
    }).deployment;
    prunedCleanupService.markQueued(prunedCleanupFailure.deploymentId, 'host-pruned-cleanup');
    prunedCleanupService.applyResult({
      deploymentId: prunedCleanupFailure.deploymentId,
      hostId: 'host-pruned-cleanup',
      ok: false,
      error: 'legacy pruned cleanup failure',
    });
    prunedCleanupService.createDeployment({
      skillId: 'pruned-cleanup-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-pruned-cleanup'],
      targetScope: 'user',
    });
    const legacyPrunedCleanupState = JSON.parse(fs.readFileSync(prunedCleanupPath, 'utf8'));
    assert.strictEqual(
      legacyPrunedCleanupState.tombstones[prunedCleanupFailure.deploymentId]
        ?.resultStates?.['host-pruned-cleanup'],
      'failed',
      'the fixture must prune the failed cleanup into a tombstone'
    );
    const legacyPrunedCleanupApplied = Object.values(legacyPrunedCleanupState.applied)[0];
    delete legacyPrunedCleanupApplied.uncertainArtifactIds;
    delete legacyPrunedCleanupApplied.skillWideUncertain;
    fs.writeFileSync(prunedCleanupPath, JSON.stringify(legacyPrunedCleanupState));
    fs.writeFileSync(`${prunedCleanupPath}.results.jsonl`, '');
    const recoveredPrunedCleanup = new SkillDeploymentService({ statePath: prunedCleanupPath });
    assert.strictEqual(
      recoveredPrunedCleanup.appliedStates()[0].skillWideUncertain,
      true,
      'a pruned legacy failed cleanup must restore Skill-wide uncertainty after restart'
    );
    assert(recoveredPrunedCleanup.artifactReferences().some((reference) => (
      reference.kind === 'applied-uncertain'
      && reference.skillId === 'pruned-cleanup-skill'
      && reference.artifactId === null
      && reference.state === 'cleanup-failed'
    )), 'a pruned legacy failed cleanup must continue blocking every Artifact for the Skill');
    const prunedCleanupSuccessorId = recoveredPrunedCleanup.snapshot().desired[0].deploymentId;
    recoveredPrunedCleanup.markQueued(prunedCleanupSuccessorId, 'host-pruned-cleanup');
    recoveredPrunedCleanup.applyResult({
      deploymentId: prunedCleanupSuccessorId,
      hostId: 'host-pruned-cleanup',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    const recoveredAfterNewerSuccess = new SkillDeploymentService({ statePath: prunedCleanupPath });
    assert.strictEqual(recoveredAfterNewerSuccess.appliedStates()[0].artifactId, artifactId);
    assert.strictEqual(
      recoveredAfterNewerSuccess.artifactReferences().some((reference) => (
        reference.kind === 'applied-uncertain'
      )),
      false,
      'an older failed cleanup tombstone must not contaminate a newer successful generation'
    );

    const successfulRemove = appliedAfterJournalReplay.createDeployment({
      skillId: 'projection-skill',
      artifactId,
      action: 'remove',
      targetHostIds: ['host-projection'],
      targetScope: 'user',
    }).deployment;
    appliedAfterJournalReplay.markQueued(successfulRemove.deploymentId, 'host-projection');
    const removeResult = appliedAfterJournalReplay.applyResult({
      deploymentId: successfulRemove.deploymentId,
      hostId: 'host-projection',
      ok: true,
      state: 'missing',
    });
    assert.deepStrictEqual(appliedAfterJournalReplay.appliedStates()[0], {
      deploymentId: successfulRemove.deploymentId,
      hostId: 'host-projection',
      skillId: 'projection-skill',
      artifactId: null,
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      appliedState: 'missing',
      updatedAt: removeResult.updatedAt,
    }, 'a successful Remove must release the applied Artifact');
    const appliedAfterSuccessfulRemoveRestart = new SkillDeploymentService({
      statePath: appliedStatePath,
    });
    assert.strictEqual(
      appliedAfterSuccessfulRemoveRestart.appliedStates()[0].appliedState,
      'missing'
    );
    assert.strictEqual(
      appliedAfterSuccessfulRemoveRestart.artifactReferences().some((reference) => (
        reference.kind === 'applied-uncertain'
        && reference.state === 'cleanup-failed'
      )),
      false,
      'an older failed Remove must not restore cleanup uncertainty after a newer successful Remove'
    );

    let referenceId = 0;
    const referenceService = new SkillDeploymentService({
      statePath: path.join(root, 'artifact-references.json'),
      idFactory: () => `reference-deployment-${++referenceId}`,
    });
    const referencedEnable = referenceService.createDeployment({
      skillId: 'reference-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-reference'],
      targetScope: 'user',
    }).deployment;
    referenceService.markQueued(referencedEnable.deploymentId, 'host-reference');
    referenceService.applyResult({
      deploymentId: referencedEnable.deploymentId,
      hostId: 'host-reference',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    const pendingRemove = referenceService.createDeployment({
      skillId: 'reference-skill',
      artifactId,
      action: 'remove',
      targetHostIds: ['host-reference'],
      targetScope: 'user',
    }).deployment;
    const expectedReferences = [{
      kind: 'applied',
      artifactId,
      skillId: 'reference-skill',
      hostId: 'host-reference',
      scope: 'user',
      scopeId: 'user',
      deploymentId: referencedEnable.deploymentId,
      state: 'enabled',
    }, {
      kind: 'deployment',
      artifactId,
      skillId: 'reference-skill',
      hostId: 'host-reference',
      scope: 'user',
      scopeId: 'user',
      deploymentId: pendingRemove.deploymentId,
      state: 'pending',
    }, {
      kind: 'desired',
      artifactId,
      skillId: 'reference-skill',
      hostId: 'host-reference',
      scope: 'user',
      scopeId: 'user',
      deploymentId: pendingRemove.deploymentId,
      state: 'missing',
    }];
    assert.deepStrictEqual(referenceService.artifactReferences(), expectedReferences);
    assert.deepStrictEqual(
      referenceService.artifactReferences(),
      expectedReferences,
      'Artifact references must be returned in stable order'
    );
    referenceService.markQueued(pendingRemove.deploymentId, 'host-reference');
    referenceService.applyResult({
      deploymentId: pendingRemove.deploymentId,
      hostId: 'host-reference',
      ok: false,
      error: 'simulated pending Remove failure',
    });
    assert.deepStrictEqual(referenceService.artifactReferences(), [expectedReferences[0], {
      kind: 'applied-uncertain',
      artifactId: null,
      skillId: 'reference-skill',
      hostId: 'host-reference',
      scope: 'user',
      scopeId: 'user',
      deploymentId: referencedEnable.deploymentId,
      state: 'cleanup-failed',
    }, {
      ...expectedReferences[2],
      state: 'missing',
    }], 'failed desired Remove must retain its target while terminal history stays soft');

    let pruneProjectionId = 0;
    const pruneProjectionPath = path.join(root, 'applied-history-prune.json');
    const pruneProjectionService = new SkillDeploymentService({
      statePath: pruneProjectionPath,
      historyLimit: 1,
      idFactory: () => `prune-projection-${++pruneProjectionId}`,
    });
    const pruneEnable = pruneProjectionService.createDeployment({
      skillId: 'prune-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-prune'],
      targetScope: 'user',
    }).deployment;
    pruneProjectionService.markQueued(pruneEnable.deploymentId, 'host-prune');
    pruneProjectionService.applyResult({
      deploymentId: pruneEnable.deploymentId,
      hostId: 'host-prune',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    pruneProjectionService.createDeployment({
      skillId: 'prune-skill',
      artifactId,
      action: 'disable',
      targetHostIds: ['host-prune'],
      targetScope: 'user',
    });
    assert.strictEqual(pruneProjectionService.getDeployment(pruneEnable.deploymentId), null);
    assert.strictEqual(pruneProjectionService.appliedStates()[0].artifactId, artifactId);
    assert.strictEqual(pruneProjectionService.appliedStates()[0].appliedState, 'enabled');
    assert.strictEqual(
      new SkillDeploymentService({ statePath: pruneProjectionPath, historyLimit: 1 })
        .appliedStates()[0].artifactId,
      artifactId,
      'history pruning must not remove the durable applied projection'
    );

    const appliedSourceState = JSON.parse(fs.readFileSync(pruneProjectionPath, 'utf8'));
    const appliedSourceRecord = Object.values(appliedSourceState.applied)[0];
    const appliedSourceTombstone = appliedSourceState.tombstones[appliedSourceRecord.deploymentId];
    assert(appliedSourceTombstone, 'the semantic binding fixture must use a pruned source');
    for (const [label, mutate] of [
      ['successful Host result', (state, record, source) => {
        source.resultStates[record.hostId] = 'failed';
      }],
      ['action-to-state mapping', (_state, _record, source) => {
        source.action = 'disable';
      }],
      ['Artifact identity', (_state, record) => {
        record.artifactId = secondArtifactId;
      }],
      ['Skill identity', (state, record) => {
        delete state.applied[record.appliedKey];
        record.skillId = 'different-skill';
        record.appliedKey = JSON.stringify([
          record.hostId,
          record.skillId,
          record.scope,
          record.scopeId,
        ]);
        state.applied[record.appliedKey] = record;
      }],
      ['scope identity', (_state, _record, source) => {
        source.targetScope = 'project';
        source.scopeId = '/different-project';
        source.cwd = '/different-project';
        source.confirmProjectWrite = true;
      }],
    ]) {
      const corrupted = JSON.parse(JSON.stringify(appliedSourceState));
      const record = Object.values(corrupted.applied)[0];
      const source = corrupted.tombstones[record.deploymentId];
      mutate(corrupted, record, source);
      const corruptedPath = path.join(
        root,
        `invalid-applied-source-${label.replace(/\s+/g, '-').toLowerCase()}.json`
      );
      fs.writeFileSync(corruptedPath, JSON.stringify(corrupted));
      assert.throws(
        () => new SkillDeploymentService({ statePath: corruptedPath, historyLimit: 1 }),
        /invalid|applied|source|deployment|tombstone|artifact|state/i,
        `persisted applied projections must bind their ${label} to a successful source`
      );
    }

    const legacyKnownPath = path.join(root, 'legacy-known-applied.json');
    let legacyKnownId = 0;
    const legacyKnownWriter = new SkillDeploymentService({
      statePath: legacyKnownPath,
      idFactory: () => `legacy-known-${++legacyKnownId}`,
    });
    const legacyKnownEnable = legacyKnownWriter.createDeployment({
      skillId: 'legacy-known-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['legacy-known-host'],
      targetScope: 'user',
    }).deployment;
    legacyKnownWriter.markQueued(legacyKnownEnable.deploymentId, 'legacy-known-host');
    legacyKnownWriter.applyResult({
      deploymentId: legacyKnownEnable.deploymentId,
      hostId: 'legacy-known-host',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    legacyKnownWriter.createDeployment({
      skillId: 'legacy-known-skill',
      artifactId,
      action: 'disable',
      targetHostIds: ['legacy-known-host'],
      targetScope: 'user',
    });
    const legacyKnownState = JSON.parse(fs.readFileSync(legacyKnownPath, 'utf8'));
    delete legacyKnownState.applied;
    fs.writeFileSync(legacyKnownPath, JSON.stringify(legacyKnownState));
    fs.writeFileSync(`${legacyKnownPath}.results.jsonl`, '');
    const migratedKnown = new SkillDeploymentService({ statePath: legacyKnownPath });
    assert.strictEqual(migratedKnown.appliedStates()[0].appliedState, 'enabled');
    assert.strictEqual(migratedKnown.appliedStates()[0].artifactId, artifactId);

    const legacyUnknownPath = path.join(root, 'legacy-unknown-applied.json');
    const legacyUnknownWriter = new SkillDeploymentService({
      statePath: legacyUnknownPath,
      idFactory: () => 'legacy-unknown-deployment',
    });
    legacyUnknownWriter.createDeployment({
      skillId: 'legacy-unknown-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['legacy-unknown-host'],
      targetScope: 'user',
    });
    const legacyUnknownState = JSON.parse(fs.readFileSync(legacyUnknownPath, 'utf8'));
    delete legacyUnknownState.applied;
    fs.writeFileSync(legacyUnknownPath, JSON.stringify(legacyUnknownState));
    const migratedUnknown = new SkillDeploymentService({ statePath: legacyUnknownPath });
    assert.strictEqual(migratedUnknown.appliedStates()[0].appliedState, 'unknown');
    assert.strictEqual(migratedUnknown.appliedStates()[0].artifactId, null);
    assert(migratedUnknown.artifactReferences().some((reference) => (
      reference.kind === 'applied'
      && reference.skillId === 'legacy-unknown-skill'
      && reference.artifactId === null
      && reference.state === 'unknown'
    )), 'an ambiguous migration must conservatively block every Artifact for the Skill');

    const invalidAppliedPath = path.join(root, 'invalid-applied-projection.json');
    const invalidAppliedState = JSON.parse(fs.readFileSync(legacyKnownPath, 'utf8'));
    invalidAppliedState.applied = {
      [JSON.stringify(['invalid-host', 'legacy-known-skill', 'user', 'user'])]: {
        appliedKey: JSON.stringify(['invalid-host', 'legacy-known-skill', 'user', 'user']),
        deploymentId: 'invalid-deployment',
        hostId: 'invalid-host',
        skillId: 'legacy-known-skill',
        artifactId: 'not-a-hash',
        scope: 'user',
        scopeId: 'user',
        cwd: null,
        appliedState: 'enabled',
        updatedAt: '2026-07-13T00:00:00.000Z',
      },
    };
    fs.writeFileSync(invalidAppliedPath, JSON.stringify(invalidAppliedState));
    assert.throws(
      () => new SkillDeploymentService({ statePath: invalidAppliedPath }),
      /invalid|applied|artifact|sha256/i,
      'persisted applied projections must be semantically validated'
    );

    const invalidUncertainPath = path.join(root, 'invalid-uncertain-artifacts.json');
    const invalidUncertainState = JSON.parse(fs.readFileSync(pruneProjectionPath, 'utf8'));
    const invalidUncertainRecord = Object.values(invalidUncertainState.applied)[0];
    invalidUncertainRecord.uncertainArtifactIds = {};
    fs.writeFileSync(invalidUncertainPath, JSON.stringify(invalidUncertainState));
    assert.throws(
      () => new SkillDeploymentService({ statePath: invalidUncertainPath }),
      /uncertainArtifactIds|array|invalid applied/i,
      'malformed uncertain Artifact references must fail closed'
    );

    const invalidGenerationPath = path.join(root, 'invalid-applied-generation.json');
    const invalidGenerationState = JSON.parse(fs.readFileSync(pruneProjectionPath, 'utf8'));
    Object.values(invalidGenerationState.applied)[0].deploymentCreatedAt = 'not-a-timestamp';
    fs.writeFileSync(invalidGenerationPath, JSON.stringify(invalidGenerationState));
    assert.throws(
      () => new SkillDeploymentService({ statePath: invalidGenerationPath }),
      /deploymentCreatedAt|timestamp|generation|invalid/i,
      'applied generation ordering metadata must be semantically validated'
    );

    const service = new SkillDeploymentService(options);
    assert.strictEqual(service.getDeployment('__proto__'), null);
    assert.strictEqual(service.getPrunedDeployment('__proto__', 'host-a'), null);
    for (const [label, overrides] of [
      ['reserved Skill ID', { skillId: '__proto__' }],
      ['reserved Host ID', { targetHostIds: ['__proto__'] }],
      ['reserved request ID', { requestId: '__proto__' }],
      ['reserved deployment ID', { deploymentId: '__proto__' }],
    ]) {
      const reservedService = new SkillDeploymentService({
        ...options,
        statePath: path.join(root, `reserved-${label.replace(/\s+/g, '-').toLowerCase()}.json`),
      });
      assert.throws(() => reservedService.createDeployment({
        requestId: `request-${label}`,
        deploymentId: `deployment-${label}`,
        skillId: 'fixture-skill',
        artifactId,
        action: 'enable',
        targetHostIds: ['host-a'],
        targetScope: 'user',
        ...overrides,
      }), /reserved|safe object key|portable/i, label);
    }
    const created = service.createDeployment({
      requestId: 'request-enable-v1',
      skillId: 'fixture-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-b', 'host-a', 'host-a'],
      targetScope: 'user',
      scopeId: 'user',
      createdBy: 'test',
    });
    assert.strictEqual(created.reused, false);
    assert.strictEqual(created.deployment.deploymentId, 'deployment-1');
    assert.deepStrictEqual(created.deployment.targetHostIds, ['host-a', 'host-b']);
    assert.strictEqual(created.deployment.desiredState, 'enabled');
    assert.strictEqual(created.deployment.results.length, 2);
    assert(created.deployment.results.every((result) => result.state === 'pending'));
    assert.strictEqual(service.snapshot().desired.length, 2);
    assert.strictEqual(service.hasRequestId('request-enable-v1'), true);
    assert.strictEqual(service.hasRequestId('missing-request'), false);

    const duplicate = service.createDeployment({
      requestId: 'request-enable-v1',
      skillId: 'fixture-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-a', 'host-b'],
      targetScope: 'user',
      scopeId: 'user',
    });
    assert.strictEqual(duplicate.reused, true);
    assert.strictEqual(duplicate.deployment.deploymentId, created.deployment.deploymentId);
    assert.strictEqual(service.snapshot().deployments.length, 1);
    assert.strictEqual(Object.hasOwn(duplicate.deployment, 'requestFingerprint'), false);
    assert.throws(() => service.createDeployment({
      requestId: 'request-enable-v1',
      skillId: 'fixture-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-a'],
      targetScope: 'user',
      scopeId: 'user',
    }), /requestId|conflict|different/i);

    const originalSave = service.save.bind(service);
    let queuedSaveCount = 0;
    service.save = (next) => {
      queuedSaveCount += 1;
      return originalSave(next);
    };
    const queuedMany = service.markQueuedMany('deployment-1', ['host-b', 'host-a']);
    service.save = originalSave;
    assert.strictEqual(queuedSaveCount, 1, 'batch queueing must persist once');
    assert.deepStrictEqual(queuedMany.map((result) => result.hostId), ['host-a', 'host-b']);
    assert(queuedMany.every((result) => result.state === 'queued'));
    assert(queuedMany.every((result) => result.attemptCount === 1));
    const saveBeforeResult = service.save.bind(service);
    let resultSnapshotSaveCount = 0;
    service.save = (next) => {
      resultSnapshotSaveCount += 1;
      return saveBeforeResult(next);
    };
    const succeeded = service.applyResult({
      deploymentId: 'deployment-1',
      hostId: 'host-a',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
      activationPath: '/codex/skills/fixture-skill',
    });
    service.save = saveBeforeResult;
    assert.strictEqual(succeeded.state, 'succeeded');
    assert.strictEqual(succeeded.observedHash, artifactId);
    assert.strictEqual(resultSnapshotSaveCount, 0, 'per-Host results must append a journal, not rewrite the full snapshot');
    assert(fs.existsSync(`${statePath}.results.jsonl`));
    const beforeTerminalRequeue = service.snapshot();
    assert.strictEqual(service.markQueued('deployment-1', 'host-a').state, 'succeeded');
    assert.deepStrictEqual(service.snapshot(), beforeTerminalRequeue);
    assert.strictEqual(service.getDeployment('deployment-1').results.find((item) => item.hostId === 'host-b').state, 'queued');

    const running = service.markRunningMany('deployment-1', ['host-b']);
    assert.strictEqual(running[0].state, 'running');
    assert(running[0].startedAt);
    assert.strictEqual(service.markRunningMany('deployment-1', ['host-b'])[0].startedAt, running[0].startedAt);

    const restored = new SkillDeploymentService(options);
    assert.deepStrictEqual(restored.snapshot(), service.snapshot());
    assert.strictEqual(restored.pendingForHost('host-b').length, 1);
    assert.strictEqual(restored.pendingForHost('host-a').length, 0);

    const disabled = restored.createDeployment({
      requestId: 'request-disable-v1',
      skillId: 'fixture-skill',
      artifactId,
      action: 'disable',
      targetHostIds: ['host-a', 'host-b'],
      targetScope: 'user',
      scopeId: 'user',
    });
    assert.strictEqual(disabled.deployment.desiredState, 'disabled');
    assert.deepStrictEqual(disabled.superseded.map((entry) => ({
      deploymentId: entry.deploymentId,
      hostId: entry.hostId,
    })), [{ deploymentId: 'deployment-1', hostId: 'host-b' }]);
    assert.strictEqual(
      restored.getDeployment('deployment-1').results.find((item) => item.hostId === 'host-b').state,
      'superseded'
    );
    assert.deepStrictEqual(
      restored.pendingForHost('host-b').map((item) => item.deploymentId),
      [disabled.deployment.deploymentId]
    );

    restored.markQueued(disabled.deployment.deploymentId, 'host-a');
    const failed = restored.applyResult({
      deploymentId: disabled.deployment.deploymentId,
      hostId: 'host-a',
      ok: false,
      error: 'simulated Host failure',
    });
    assert.strictEqual(failed.state, 'failed');
    assert.match(failed.error, /simulated Host failure/);
    assert.strictEqual(
      restored.getDeployment(disabled.deployment.deploymentId).results.find((item) => item.hostId === 'host-b').state,
      'pending'
    );

    const beforeDuplicateFailure = restored.snapshot();
    const duplicateFailure = restored.applyResult({
      deploymentId: disabled.deployment.deploymentId,
      hostId: 'host-a',
      ok: false,
      error: 'simulated Host failure',
    });
    assert.strictEqual(duplicateFailure.state, 'failed');
    assert.deepStrictEqual(restored.snapshot(), beforeDuplicateFailure);
    await assert.rejects(Promise.resolve().then(() => restored.applyResult({
      deploymentId: disabled.deployment.deploymentId,
      hostId: 'host-a',
      ok: true,
      state: 'disabled',
    })), /conflict|terminal/i);

    await assert.rejects(Promise.resolve().then(() => restored.createDeployment({
      skillId: 'fixture-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-a'],
      targetScope: 'project',
      scopeId: '/workspace',
      cwd: '/workspace',
      confirmProjectWrite: false,
    })), /confirmProjectWrite|confirmation/i);
    await assert.rejects(Promise.resolve().then(() => restored.createDeployment({
      skillId: 'fixture-skill',
      artifactId: 'invalid',
      action: 'enable',
      targetHostIds: ['host-a'],
      targetScope: 'user',
    })), /sha256/i);

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(persisted.version, 1);
    assert.strictEqual(Object.keys(persisted.deployments).length, 2);
    assert(!fs.readdirSync(root).some((name) => name.endsWith('.tmp')));

    let reconnectId = 0;
    const reconnectService = new SkillDeploymentService({
      statePath: path.join(root, 'reconnect-batch.json'),
      idFactory: () => `reconnect-deployment-${++reconnectId}`,
    });
    const reconnectDeployments = ['skill-a', 'skill-b', 'skill-c'].map((skillId, index) => (
      reconnectService.createDeployment({
        requestId: `reconnect-request-${index}`,
        skillId,
        artifactId,
        action: 'enable',
        targetHostIds: ['host-reconnect'],
        targetScope: 'user',
      }).deployment
    ));
    const reconnectSave = reconnectService.save.bind(reconnectService);
    let reconnectSaveCount = 0;
    reconnectService.save = (next) => {
      reconnectSaveCount += 1;
      return reconnectSave(next);
    };
    const reconnected = reconnectService.markQueuedBatch(reconnectDeployments.map((deployment) => ({
      deploymentId: deployment.deploymentId,
      hostId: 'host-reconnect',
    })));
    reconnectService.save = reconnectSave;
    assert.strictEqual(reconnectSaveCount, 1, 'Host reconciliation must persist all pending Skills once');
    assert.strictEqual(reconnected.length, 3);
    assert(reconnected.every((entry) => entry.result.state === 'queued'));
    const activeSummaries = reconnectService.deploymentSummaries(2);
    assert.strictEqual(activeSummaries.length, 3, 'summary limit must be soft for active desired deployments');
    assert(activeSummaries.every((deployment) => (
      deployment.results.some((result) => result.state === 'queued')
    )));
    assert.strictEqual(reconnectService.desiredStates().length, 3);

    let historyId = 0;
    let historyTick = 0;
    const historyStatePath = path.join(root, 'bounded-history.json');
    const historyService = new SkillDeploymentService({
      statePath: historyStatePath,
      historyLimit: 2,
      idFactory: () => `history-deployment-${++historyId}`,
      now: () => `2026-07-13T02:00:${String(historyTick++).padStart(2, '0')}.000Z`,
    });
    for (const [requestId, action] of [
      ['history-request-1', 'enable'],
      ['history-request-2', 'disable'],
    ]) {
      const item = historyService.createDeployment({
        requestId,
        skillId: 'fixture-skill',
        artifactId,
        action,
        targetHostIds: ['host-a'],
        targetScope: 'user',
      }).deployment;
      historyService.markQueued(item.deploymentId, 'host-a');
      historyService.applyResult({
        deploymentId: item.deploymentId,
        hostId: 'host-a',
        ok: true,
        state: action === 'enable' ? 'enabled' : 'disabled',
        observedHash: action === 'enable' ? artifactId : null,
      });
    }
    const currentDesired = historyService.createDeployment({
      requestId: 'history-request-3',
      skillId: 'fixture-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-a'],
      targetScope: 'user',
    }).deployment;
    assert.strictEqual(historyService.getDeployment('history-deployment-1'), null);
    assert.strictEqual(
      historyService.getPrunedDeployment('history-deployment-1', 'host-a')?.action,
      'enable'
    );
    assert.strictEqual(
      historyService.getPrunedDeployment('history-deployment-1', 'host-a')?.resultStates?.['host-a'],
      'succeeded'
    );
    assert.strictEqual(historyService.getPrunedDeployment('history-deployment-1', 'host-b'), null);
    assert.throws(() => historyService.createDeployment({
      deploymentId: 'history-deployment-1',
      skillId: 'fixture-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['host-b'],
      targetScope: 'user',
    }), /deploymentId|exists|pruned|tombstone/i);
    assert(historyService.getDeployment('history-deployment-2'));
    assert(historyService.getDeployment(currentDesired.deploymentId));
    const boundedPersisted = JSON.parse(fs.readFileSync(historyStatePath, 'utf8'));
    assert.strictEqual(Object.keys(boundedPersisted.deployments).length, 2);
    assert.strictEqual(Object.hasOwn(boundedPersisted.requestIndex, 'history-request-1'), false);
    assert(Object.values(boundedPersisted.desired).every((entry) => (
      boundedPersisted.deployments[entry.deploymentId]
    )), 'history pruning must retain desired-state deployments');

    const compactStatePath = path.join(root, 'journal-compaction-crash.json');
    let compactId = 0;
    const compactService = new SkillDeploymentService({
      statePath: compactStatePath,
      historyLimit: 1,
      idFactory: () => `compact-deployment-${++compactId}`,
    });
    const compactFirst = compactService.createDeployment({
      skillId: 'compact-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['compact-host'],
      targetScope: 'user',
    }).deployment;
    compactService.markQueued(compactFirst.deploymentId, 'compact-host');
    compactService.applyResult({
      deploymentId: compactFirst.deploymentId,
      hostId: 'compact-host',
      ok: true,
      state: 'enabled',
      observedHash: artifactId,
    });
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function failJournalTruncate(filePath, data, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(`${compactStatePath}.results.jsonl`) && data === '') {
        throw new Error('simulated journal truncate crash');
      }
      return originalWriteFileSync.call(this, filePath, data, ...args);
    };
    try {
      const compactSecond = compactService.createDeployment({
        skillId: 'compact-skill',
        artifactId,
        action: 'disable',
        targetHostIds: ['compact-host'],
        targetScope: 'user',
      }).deployment;
      assert(compactService.getDeployment(compactSecond.deploymentId));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    const compactRecovered = new SkillDeploymentService({
      statePath: compactStatePath,
      historyLimit: 1,
    });
    assert.strictEqual(
      compactRecovered.getPrunedDeployment(compactFirst.deploymentId, 'compact-host')?.resultStates?.['compact-host'],
      'succeeded',
      'a stale journal entry matching a compacted tombstone must be replay-safe'
    );

    const retainedJournalStatePath = path.join(root, 'retained-journal-tombstones.json');
    let retainedJournalId = 0;
    const retainedJournalService = new SkillDeploymentService({
      statePath: retainedJournalStatePath,
      historyLimit: 1,
      tombstoneLimit: 1,
      idFactory: () => `retained-journal-${++retainedJournalId}`,
    });
    const retainedJournalFirst = retainedJournalService.createDeployment({
      skillId: 'retained-journal-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['retained-journal-host'],
      targetScope: 'user',
    }).deployment;
    retainedJournalService.markQueued(retainedJournalFirst.deploymentId, 'retained-journal-host');
    retainedJournalService.applyResult({
      deploymentId: retainedJournalFirst.deploymentId,
      hostId: 'retained-journal-host',
      ok: false,
      error: 'simulated first failure',
    });

    let retainedJournalTruncateFailures = 0;
    fs.writeFileSync = function failRepeatedJournalTruncates(filePath, data, ...args) {
      if (
        path.resolve(String(filePath)) === path.resolve(`${retainedJournalStatePath}.results.jsonl`)
        && data === ''
      ) {
        retainedJournalTruncateFailures += 1;
        throw new Error('simulated repeated journal truncate crash');
      }
      return originalWriteFileSync.call(this, filePath, data, ...args);
    };
    let retainedJournalSecond;
    let retainedJournalCurrent;
    try {
      retainedJournalSecond = retainedJournalService.createDeployment({
        skillId: 'retained-journal-skill',
        artifactId,
        action: 'disable',
        targetHostIds: ['retained-journal-host'],
        targetScope: 'user',
      }).deployment;
      retainedJournalService.markQueued(
        retainedJournalSecond.deploymentId,
        'retained-journal-host'
      );
      retainedJournalService.applyResult({
        deploymentId: retainedJournalSecond.deploymentId,
        hostId: 'retained-journal-host',
        ok: false,
        error: 'simulated second failure',
      });
      retainedJournalCurrent = retainedJournalService.createDeployment({
        skillId: 'retained-journal-skill',
        artifactId,
        action: 'enable',
        targetHostIds: ['retained-journal-host'],
        targetScope: 'user',
      }).deployment;
      assert(
        retainedJournalTruncateFailures >= 2,
        'the fixture must exercise consecutive journal truncate failures'
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    const retainedJournalRecovered = new SkillDeploymentService({
      statePath: retainedJournalStatePath,
      historyLimit: 1,
      tombstoneLimit: 1,
    });
    assert.strictEqual(
      retainedJournalRecovered.getPrunedDeployment(
        retainedJournalFirst.deploymentId,
        'retained-journal-host'
      )?.resultStates?.['retained-journal-host'],
      'failed',
      'replay must retain the first stale journal line tombstone across repeated truncate failures'
    );
    assert.strictEqual(
      retainedJournalRecovered.getPrunedDeployment(
        retainedJournalSecond.deploymentId,
        'retained-journal-host'
      )?.resultStates?.['retained-journal-host'],
      'failed',
      'replay must retain every stale journal line tombstone until truncation succeeds'
    );
    retainedJournalRecovered.markQueued(
      retainedJournalCurrent.deploymentId,
      'retained-journal-host'
    );
    retainedJournalRecovered.markRunningMany(
      retainedJournalCurrent.deploymentId,
      ['retained-journal-host']
    );
    assert.strictEqual(
      Object.keys(JSON.parse(fs.readFileSync(retainedJournalStatePath, 'utf8')).tombstones).length,
      1,
      'a save after successful journal truncation may restore the tombstone soft limit'
    );

    const malformedJournalStatePath = path.join(root, 'malformed-result-journal.json');
    const malformedJournalService = new SkillDeploymentService({
      statePath: malformedJournalStatePath,
      idFactory: () => 'malformed-journal-deployment',
    });
    malformedJournalService.createDeployment({
      skillId: 'journal-skill',
      artifactId,
      action: 'enable',
      targetHostIds: ['journal-host'],
      targetScope: 'user',
    });
    malformedJournalService.markQueued('malformed-journal-deployment', 'journal-host');
    fs.appendFileSync(`${malformedJournalStatePath}.results.jsonl`, `${JSON.stringify({
      version: 1,
      deploymentId: 'malformed-journal-deployment',
      hostId: 'journal-host',
      deploymentUpdatedAt: '2026-07-13T03:00:00.000Z',
      result: { hostId: 'journal-host', state: 'succeeded' },
    })}\n`);
    assert.throws(
      () => new SkillDeploymentService({ statePath: malformedJournalStatePath }),
      /invalid|journal|attemptCount|result/i
    );

    const corruptStatePath = path.join(root, 'corrupt-deployments.json');
    fs.writeFileSync(corruptStatePath, '{"version":1,"deployments":');
    assert.throws(
      () => new SkillDeploymentService({ ...options, statePath: corruptStatePath }),
      /invalid|parse|state/i
    );
    const wrongVersionPath = path.join(root, 'wrong-version-deployments.json');
    fs.writeFileSync(wrongVersionPath, JSON.stringify({
      version: 999,
      deployments: {},
      desired: {},
      requestIndex: {},
    }));
    assert.throws(
      () => new SkillDeploymentService({ ...options, statePath: wrongVersionPath }),
      /invalid|schema|version/i
    );
    const wrongSchemaPath = path.join(root, 'wrong-schema-deployments.json');
    fs.writeFileSync(wrongSchemaPath, JSON.stringify({
      version: 1,
      deployments: [],
      desired: {},
      requestIndex: {},
    }));
    assert.throws(
      () => new SkillDeploymentService({ ...options, statePath: wrongSchemaPath }),
      /invalid|schema|version/i
    );
    const semanticCorruptPath = path.join(root, 'semantic-corrupt-deployments.json');
    const semanticCorrupt = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    semanticCorrupt.deployments['deployment-1'].action = 'launch';
    fs.writeFileSync(semanticCorruptPath, JSON.stringify(semanticCorrupt));
    assert.throws(
      () => new SkillDeploymentService({ ...options, statePath: semanticCorruptPath }),
      /invalid|action|deployment|state/i
    );
    const noncanonicalScopePath = path.join(root, 'noncanonical-scope-deployments.json');
    const noncanonicalScope = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    noncanonicalScope.deployments['deployment-1'].targetScope = 'USER';
    fs.writeFileSync(noncanonicalScopePath, JSON.stringify(noncanonicalScope));
    assert.throws(
      () => new SkillDeploymentService({ ...options, statePath: noncanonicalScopePath }),
      /invalid|canonical|scope|deployment|state/i
    );
    const noncanonicalResultPath = path.join(root, 'noncanonical-result-deployments.json');
    const noncanonicalResult = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const firstPersistedResult = Object.values(noncanonicalResult.deployments['deployment-1'].results)[0];
    firstPersistedResult.state = String(firstPersistedResult.state).toUpperCase();
    fs.writeFileSync(noncanonicalResultPath, JSON.stringify(noncanonicalResult));
    assert.throws(
      () => new SkillDeploymentService({ ...options, statePath: noncanonicalResultPath }),
      /invalid|canonical|result|deployment|state/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('Skill deployment service assertions passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
