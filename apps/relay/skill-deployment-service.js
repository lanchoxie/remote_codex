const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizePortableSkillId } = require('../../shared/skill-id');

const STATE_VERSION = 1;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESULT_STATES = new Set(['pending', 'queued', 'running', 'succeeded', 'failed', 'superseded']);
const TERMINAL_RESULT_STATES = new Set(['succeeded', 'failed', 'superseded']);
const APPLIED_STATES = new Set(['enabled', 'disabled', 'missing', 'unknown']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, name, maxLength = 8192) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw new Error(`${name} is required`);
  }
  if (text.length > maxLength) {
    throw new Error(`${name} exceeds ${maxLength} characters`);
  }
  return text;
}

function requiredObjectKey(value, name, maxLength = 240) {
  const text = requiredText(value, name, maxLength);
  if (RESERVED_OBJECT_KEYS.has(text.toLowerCase())) {
    throw new Error(`${name} is a reserved object key`);
  }
  return text;
}

function requiredTimestamp(value, name) {
  const timestamp = requiredText(value, name, 80);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function optionalGeneration(value, name) {
  if (value == null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function normalizeHash(value) {
  const hash = requiredText(value, 'artifactId', 96).toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new Error('artifactId must be a sha256 digest');
  }
  return hash;
}

function uniqueTexts(values, name, maxItems = 1000) {
  if (!Array.isArray(values)) {
    throw new Error(`${name} must be an array`);
  }
  const result = Array.from(new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean)))
    .sort();
  if (!result.length || result.length > maxItems) {
    throw new Error(`${name} must contain between 1 and ${maxItems} unique values`);
  }
  for (const value of result) {
    requiredObjectKey(value, name, 160);
  }
  return result;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    nextDeploymentGeneration: 1,
    deployments: {},
    desired: {},
    applied: {},
    requestIndex: {},
    tombstones: {},
  };
}

function desiredKey(hostId, skillId, scope, scopeId) {
  return JSON.stringify([hostId, skillId, scope, scopeId]);
}

function validateAppliedRecord(record, key, label) {
  if (!isRecord(record)) {
    throw new Error(`${label} must be an object`);
  }
  const hostId = requiredObjectKey(record.hostId, `${label} hostId`, 160);
  const skillId = normalizePortableSkillId(record.skillId);
  if (record.skillId !== skillId) {
    throw new Error(`${label} skillId is not canonical`);
  }
  const scope = requiredText(record.scope, `${label} scope`, 40).toLowerCase();
  if ((scope !== 'user' && scope !== 'project') || record.scope !== scope) {
    throw new Error(`${label} scope is invalid or noncanonical`);
  }
  const scopeId = requiredText(record.scopeId, `${label} scopeId`);
  let cwd = null;
  if (scope === 'project') {
    cwd = requiredText(record.cwd, `${label} cwd`);
    if (scopeId !== cwd) {
      throw new Error(`${label} project scope metadata is invalid`);
    }
  } else if (scopeId !== 'user' || record.cwd != null) {
    throw new Error(`${label} user scope metadata is invalid`);
  }
  const expectedKey = desiredKey(hostId, skillId, scope, scopeId);
  if (key !== expectedKey || record.appliedKey !== expectedKey) {
    throw new Error(`${label} key is invalid`);
  }
  const appliedState = requiredText(record.appliedState, `${label} state`, 40).toLowerCase();
  if (!APPLIED_STATES.has(appliedState) || record.appliedState !== appliedState) {
    throw new Error(`${label} state is invalid or noncanonical`);
  }
  let artifactId = null;
  if (appliedState === 'enabled' || appliedState === 'disabled') {
    artifactId = normalizeHash(record.artifactId);
    if (record.artifactId !== artifactId) {
      throw new Error(`${label} artifactId is noncanonical`);
    }
  } else if (record.artifactId != null) {
    throw new Error(`${label} ${appliedState} state cannot retain an Artifact`);
  }
  const deploymentId = record.deploymentId == null
    ? null
    : requiredObjectKey(record.deploymentId, `${label} deploymentId`, 240);
  const deploymentCreatedAt = record.deploymentCreatedAt == null
    ? null
    : requiredTimestamp(record.deploymentCreatedAt, `${label} deploymentCreatedAt`);
  const deploymentGeneration = optionalGeneration(
    record.deploymentGeneration,
    `${label} deploymentGeneration`
  );
  if (record.uncertainArtifactIds != null && !Array.isArray(record.uncertainArtifactIds)) {
    throw new Error(`${label} uncertainArtifactIds must be an array`);
  }
  const uncertainArtifactIds = Array.from(new Set(
    (record.uncertainArtifactIds || []).map((artifactIdValue) => normalizeHash(artifactIdValue))
  )).sort();
  if (record.skillWideUncertain != null && typeof record.skillWideUncertain !== 'boolean') {
    throw new Error(`${label} skillWideUncertain must be a boolean`);
  }
  const skillWideUncertain = record.skillWideUncertain === true;
  const updatedAt = requiredText(record.updatedAt, `${label} updatedAt`, 80);
  if (record.updatedAt !== updatedAt) {
    throw new Error(`${label} updatedAt is noncanonical`);
  }
  return {
    appliedKey: expectedKey,
    deploymentId,
    deploymentCreatedAt,
    deploymentGeneration,
    uncertainArtifactIds,
    skillWideUncertain,
    hostId,
    skillId,
    artifactId,
    scope,
    scopeId,
    cwd,
    appliedState,
    updatedAt,
  };
}

function appliedMutationForResult(deployment, hostId, result) {
  if (result.state !== 'succeeded') {
    return null;
  }
  const key = desiredKey(hostId, deployment.skillId, deployment.targetScope, deployment.scopeId);
  return {
    appliedKey: key,
    deploymentId: deployment.deploymentId,
    deploymentCreatedAt: deployment.createdAt || result.updatedAt,
    deploymentGeneration: optionalGeneration(
      deployment.generation,
      `deployment ${deployment.deploymentId} generation`
    ),
    uncertainArtifactIds: [],
    skillWideUncertain: false,
    hostId,
    skillId: deployment.skillId,
    artifactId: deployment.action === 'remove' ? null : deployment.artifactId,
    scope: deployment.targetScope,
    scopeId: deployment.scopeId,
    cwd: deployment.cwd,
    appliedState: { enable: 'enabled', disable: 'disabled', remove: 'missing' }[deployment.action],
    updatedAt: result.updatedAt,
  };
}

function addAmbiguousAppliedArtifact(existing, mutation) {
  if (mutation.artifactId) {
    existing.uncertainArtifactIds = Array.from(new Set([
      ...(existing.uncertainArtifactIds || []),
      mutation.artifactId,
    ])).sort();
  }
}

function applyMutationIfNotOlder(state, mutation, deployment) {
  if (!mutation) {
    return false;
  }
  const existing = state.applied[mutation.appliedKey] || null;
  if (existing?.deploymentId && existing.deploymentId !== deployment.deploymentId) {
    const existingDeployment = state.deployments[existing.deploymentId] || null;
    const candidateGeneration = mutation.deploymentGeneration ?? deployment.generation ?? null;
    const existingGeneration = existing.deploymentGeneration
      ?? existingDeployment?.generation
      ?? state.tombstones?.[existing.deploymentId]?.generation
      ?? null;
    if (candidateGeneration != null && existingGeneration != null
      && candidateGeneration !== existingGeneration) {
      if (candidateGeneration < existingGeneration) {
        return false;
      }
    } else {
      const desired = state.desired[mutation.appliedKey];
      if (desired?.deploymentId !== deployment.deploymentId) {
        addAmbiguousAppliedArtifact(existing, mutation);
        return false;
      }
    }
  }
  state.applied[mutation.appliedKey] = clone(mutation);
  return true;
}

function needsCleanupFailureUncertainty(deployment, result) {
  return result.state === 'failed'
    && (deployment.action === 'disable' || deployment.action === 'remove');
}

function markCleanupFailureUncertain(state, deployment, hostId, result) {
  if (!needsCleanupFailureUncertainty(deployment, result)) {
    return false;
  }
  const key = desiredKey(hostId, deployment.skillId, deployment.targetScope, deployment.scopeId);
  const applied = state.applied[key];
  if (!applied) {
    return false;
  }
  const cleanupGeneration = deployment.generation ?? null;
  const appliedGeneration = applied.deploymentGeneration
    ?? state.deployments[applied.deploymentId]?.generation
    ?? state.tombstones?.[applied.deploymentId]?.generation
    ?? null;
  if (cleanupGeneration != null && appliedGeneration != null) {
    if (cleanupGeneration <= appliedGeneration) {
      return true;
    }
  } else if (applied.deploymentId) {
    const desiredDeploymentId = state.desired[key]?.deploymentId;
    if (desiredDeploymentId === applied.deploymentId) {
      return true;
    }
  }
  applied.skillWideUncertain = true;
  applied.updatedAt = result.updatedAt;
  return true;
}

function migratedAppliedState(state) {
  const applied = {};
  const migrationState = { ...state, applied };
  const tombstones = Object.values(state.tombstones || {}).sort((left, right) => (
    left.generation != null && right.generation != null
      ? left.generation - right.generation
      : 0
  ));
  for (const tombstone of tombstones) {
    for (const hostId of tombstone.targetHostIds || []) {
      if (tombstone.resultStates?.[hostId] !== 'succeeded' || !tombstone.prunedAt) {
        continue;
      }
      const mutation = appliedMutationForResult(tombstone, hostId, {
        state: 'succeeded',
        updatedAt: tombstone.prunedAt,
      });
      applyMutationIfNotOlder(migrationState, mutation, tombstone);
    }
  }
  const deployments = Object.values(state.deployments || {}).sort((left, right) => (
    left.generation != null && right.generation != null
      ? left.generation - right.generation
      : 0
  ));
  for (const deployment of deployments) {
    for (const hostId of deployment.targetHostIds || []) {
      const result = deployment.results?.[hostId];
      if (result?.state !== 'succeeded') {
        continue;
      }
      const mutation = appliedMutationForResult(deployment, hostId, result);
      applyMutationIfNotOlder(migrationState, mutation, deployment);
    }
  }
  for (const [key, desired] of Object.entries(state.desired || {})) {
    if (applied[key]) {
      continue;
    }
    applied[key] = {
      appliedKey: key,
      deploymentId: null,
      deploymentCreatedAt: null,
      deploymentGeneration: null,
      uncertainArtifactIds: [],
      skillWideUncertain: false,
      hostId: desired.hostId,
      skillId: desired.skillId,
      artifactId: null,
      scope: desired.scope,
      scopeId: desired.scopeId,
      cwd: desired.cwd,
      appliedState: 'unknown',
      updatedAt: desired.updatedAt,
    };
  }
  return applied;
}

function fillMissingAppliedState(state) {
  for (const [key, desired] of Object.entries(state.desired || {})) {
    if (state.applied[key]) {
      continue;
    }
    state.applied[key] = {
      appliedKey: key,
      deploymentId: null,
      deploymentCreatedAt: null,
      deploymentGeneration: null,
      uncertainArtifactIds: [],
      skillWideUncertain: false,
      hostId: desired.hostId,
      skillId: desired.skillId,
      artifactId: null,
      scope: desired.scope,
      scopeId: desired.scopeId,
      cwd: desired.cwd,
      appliedState: 'unknown',
      updatedAt: desired.updatedAt,
    };
  }
  for (const tombstone of Object.values(state.tombstones || {})) {
    for (const hostId of tombstone.targetHostIds || []) {
      if (tombstone.resultStates?.[hostId] !== 'failed') {
        continue;
      }
      const key = desiredKey(hostId, tombstone.skillId, tombstone.targetScope, tombstone.scopeId);
      const updatedAt = state.applied[key]?.updatedAt
        || tombstone.prunedAt
        || tombstone.createdAt;
      if (!updatedAt) {
        continue;
      }
      markCleanupFailureUncertain(state, tombstone, hostId, {
        state: 'failed',
        updatedAt,
      });
    }
  }
  for (const deployment of Object.values(state.deployments || {})) {
    for (const [hostId, result] of Object.entries(deployment.results || {})) {
      markCleanupFailureUncertain(state, deployment, hostId, result);
    }
  }
  return state;
}

function requestFingerprint(input) {
  const canonical = {
    skillId: input.skillId,
    artifactId: input.artifactId,
    action: input.action,
    targetHostIds: [...input.targetHostIds].sort(),
    targetScope: input.targetScope,
    scopeId: input.scopeId,
    cwd: input.cwd,
    confirmProjectWrite: input.confirmProjectWrite === true,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function validateDeploymentIdentity(record, label) {
  if (!isRecord(record)) {
    throw new Error(`${label} must be an object`);
  }
  const skillId = normalizePortableSkillId(record.skillId);
  if (record.skillId !== skillId) {
    throw new Error(`${label} skillId is not canonical`);
  }
  const artifactId = normalizeHash(record.artifactId);
  if (record.artifactId !== artifactId) {
    throw new Error(`${label} artifactId is not canonical`);
  }
  const action = requiredText(record.action, `${label} action`, 40).toLowerCase();
  const desiredState = { enable: 'enabled', disable: 'disabled', remove: 'missing' }[action];
  if (!desiredState || record.action !== action) {
    throw new Error(`${label} action is invalid`);
  }
  const targetHostIds = uniqueTexts(record.targetHostIds, `${label} targetHostIds`);
  if (JSON.stringify(record.targetHostIds) !== JSON.stringify(targetHostIds)) {
    throw new Error(`${label} targetHostIds must be unique and sorted`);
  }
  const targetScope = requiredText(record.targetScope, `${label} targetScope`, 40).toLowerCase();
  if ((targetScope !== 'user' && targetScope !== 'project') || record.targetScope !== targetScope) {
    throw new Error(`${label} targetScope is invalid`);
  }
  let scopeId = 'user';
  let cwd = null;
  if (targetScope === 'project') {
    cwd = requiredText(record.cwd, `${label} cwd`);
    scopeId = requiredText(record.scopeId, `${label} scopeId`);
    if (scopeId !== cwd || record.confirmProjectWrite !== true) {
      throw new Error(`${label} project scope metadata is invalid`);
    }
  } else if (record.scopeId !== 'user' || record.cwd != null || record.confirmProjectWrite !== false) {
    throw new Error(`${label} user scope metadata is invalid`);
  }
  return {
    skillId,
    artifactId,
    action,
    desiredState,
    targetHostIds,
    targetScope,
    scopeId,
    cwd,
    confirmProjectWrite: targetScope === 'project',
  };
}

function normalizeDeploymentGenerations(state, hasPersistedClock) {
  const sources = [
    ...Object.values(state.deployments || {}),
    ...Object.values(state.tombstones || {}),
  ];
  for (const source of sources) {
    if (!Object.hasOwn(source, 'generation')) {
      if (hasPersistedClock) {
        throw new Error(`deployment generation is missing: ${source.deploymentId}`);
      }
      source.generation = null;
      continue;
    }
    source.generation = optionalGeneration(
      source.generation,
      `deployment ${source.deploymentId} generation`
    );
  }

  const highestGeneration = sources.reduce((highest, source) => (
    source.generation == null ? highest : Math.max(highest, source.generation)
  ), 0);
  const nextGeneration = hasPersistedClock
    ? optionalGeneration(state.nextDeploymentGeneration, 'nextDeploymentGeneration')
    : highestGeneration + 1;
  if (nextGeneration == null || nextGeneration <= highestGeneration) {
    throw new Error('nextDeploymentGeneration must exceed every deployment generation');
  }
  state.nextDeploymentGeneration = nextGeneration;
}

function validateAppliedSource(state, normalized, rawRecord, key, label, options = {}) {
  if (!normalized.deploymentId) {
    if (
      normalized.appliedState !== 'unknown'
      || normalized.deploymentCreatedAt != null
      || normalized.deploymentGeneration != null
    ) {
      throw new Error(`${label} without a source deployment must be unknown`);
    }
    return normalized;
  }

  const deployment = state.deployments[normalized.deploymentId] || null;
  const tombstone = state.tombstones?.[normalized.deploymentId] || null;
  const source = deployment || tombstone;
  if (!source) {
    throw new Error(`${label} source deployment was not found`);
  }
  const sourceSucceeded = deployment
    ? deployment.results?.[normalized.hostId]?.state === 'succeeded'
    : tombstone.resultStates?.[normalized.hostId] === 'succeeded';
  const expectedState = { enable: 'enabled', disable: 'disabled', remove: 'missing' }[source.action];
  const expectedArtifactId = source.action === 'remove' ? null : source.artifactId;
  const expectedKey = desiredKey(
    normalized.hostId,
    source.skillId,
    source.targetScope,
    source.scopeId
  );
  if (
    !source.targetHostIds.includes(normalized.hostId)
    || !sourceSucceeded
    || key !== expectedKey
    || normalized.skillId !== source.skillId
    || normalized.artifactId !== expectedArtifactId
    || normalized.scope !== source.targetScope
    || normalized.scopeId !== source.scopeId
    || normalized.cwd !== source.cwd
    || normalized.appliedState !== expectedState
  ) {
    throw new Error(`${label} does not match its successful source deployment`);
  }
  if (
    normalized.deploymentCreatedAt != null
    && source.createdAt != null
    && normalized.deploymentCreatedAt !== source.createdAt
  ) {
    throw new Error(`${label} source deployment timestamp is invalid`);
  }
  if (
    normalized.deploymentGeneration != null
    && normalized.deploymentGeneration !== source.generation
  ) {
    throw new Error(`${label} source deployment generation is invalid`);
  }
  if (
    options.requireGenerationMetadata
    && source.generation != null
    && (!Object.hasOwn(rawRecord, 'deploymentGeneration')
      || normalized.deploymentGeneration == null)
  ) {
    throw new Error(`${label} source deployment generation is missing`);
  }
  return {
    ...normalized,
    deploymentCreatedAt: source.createdAt || normalized.deploymentCreatedAt,
    deploymentGeneration: source.generation ?? normalized.deploymentGeneration,
  };
}

function validateDeploymentResult(result, identity, hostId, label, options = {}) {
  if (!isRecord(result) || result.hostId !== hostId) {
    throw new Error(`${label} identity is invalid`);
  }
  const state = requiredText(result.state, `${label} state`, 40);
  if (!RESULT_STATES.has(state) || result.state !== state) {
    throw new Error(`${label} state is invalid or noncanonical`);
  }
  if (options.terminalOnly && state !== 'succeeded' && state !== 'failed') {
    throw new Error(`${label} is not a journal terminal result`);
  }
  if (!Number.isSafeInteger(result.attemptCount) || result.attemptCount < 0) {
    throw new Error(`${label} attemptCount is invalid`);
  }
  for (const timestampName of ['queuedAt', 'startedAt', 'completedAt']) {
    if (result[timestampName] != null) {
      const timestamp = requiredText(result[timestampName], `${label} ${timestampName}`, 80);
      if (result[timestampName] !== timestamp) {
        throw new Error(`${label} ${timestampName} is noncanonical`);
      }
    }
  }
  const updatedAt = requiredText(result.updatedAt, `${label} updatedAt`, 80);
  if (result.updatedAt !== updatedAt) {
    throw new Error(`${label} updatedAt is noncanonical`);
  }
  if (typeof result.error !== 'string' || result.error.length > 4096) {
    throw new Error(`${label} error is invalid`);
  }
  if (result.observedHash != null) {
    const observedHash = normalizeHash(result.observedHash);
    if (result.observedHash !== observedHash) {
      throw new Error(`${label} observedHash is noncanonical`);
    }
  }
  if (result.activationPath != null) {
    const activationPath = requiredText(result.activationPath, `${label} activationPath`, 8192);
    if (result.activationPath !== activationPath) {
      throw new Error(`${label} activationPath is noncanonical`);
    }
  }
  if (result.hostState != null) {
    const hostState = requiredText(result.hostState, `${label} hostState`, 40);
    if (!['enabled', 'disabled', 'missing'].includes(hostState) || result.hostState !== hostState) {
      throw new Error(`${label} hostState is invalid or noncanonical`);
    }
  }
  if (result.idempotent != null && typeof result.idempotent !== 'boolean') {
    throw new Error(`${label} idempotent is invalid`);
  }
  if ((state === 'succeeded' || state === 'failed') && result.completedAt == null) {
    throw new Error(`${label} completedAt is required for a terminal result`);
  }
  if (state === 'failed' && !result.error.trim()) {
    throw new Error(`${label} error is required for a failed result`);
  }
  if (state === 'succeeded') {
    const expectedHostState = { enable: 'enabled', disable: 'disabled', remove: 'missing' }[identity.action];
    if (result.hostState !== expectedHostState) {
      throw new Error(`${label} hostState is invalid`);
    }
    if (identity.action === 'enable' && result.observedHash !== identity.artifactId) {
      throw new Error(`${label} Artifact is invalid`);
    }
  }
  return state;
}

function publicDeployment(record) {
  if (!record) {
    return null;
  }
  const { requestFingerprint: _requestFingerprint, ...publicRecord } = record;
  return clone({
    ...publicRecord,
    results: Object.values(record.results || {}).sort((left, right) => (
      String(left.hostId).localeCompare(String(right.hostId))
    )),
  });
}

class SkillDeploymentService {
  constructor(options = {}) {
    if (!options.statePath) {
      throw new Error('statePath is required');
    }
    this.statePath = path.resolve(options.statePath);
    this.resultJournalPath = `${this.statePath}.results.jsonl`;
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    this.idFactory = typeof options.idFactory === 'function'
      ? options.idFactory
      : () => crypto.randomUUID();
    this.historyLimit = Math.max(1, Math.trunc(Number(options.historyLimit || 1000)) || 1000);
    this.tombstoneLimit = Math.max(
      this.historyLimit,
      Math.trunc(Number(options.tombstoneLimit || this.historyLimit * 4)) || this.historyLimit * 4
    );
    this.lastJournalCompactionError = null;
    this.state = this.load();
  }

  load() {
    let source;
    try {
      source = fs.readFileSync(this.statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        try {
          if (fs.statSync(this.resultJournalPath).size > 0) {
            throw new Error('Skill deployment result journal exists without its state snapshot');
          }
        } catch (journalError) {
          if (journalError.code !== 'ENOENT') {
            throw journalError;
          }
        }
        return emptyState();
      }
      throw new Error(`failed to read Skill deployment state: ${error.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`invalid Skill deployment state JSON: ${error.message}`);
    }

    if (
      !isRecord(parsed)
      || parsed.version !== STATE_VERSION
      || !isRecord(parsed.deployments)
      || !isRecord(parsed.desired)
      || (parsed.applied != null && !isRecord(parsed.applied))
      || !isRecord(parsed.requestIndex)
      || (parsed.tombstones != null && !isRecord(parsed.tombstones))
    ) {
      throw new Error(`invalid Skill deployment state schema or version; expected version ${STATE_VERSION}`);
    }
    try {
      for (const [deploymentId, deployment] of Object.entries(parsed.deployments)) {
        requiredObjectKey(deploymentId, 'deploymentId', 240);
        if (!isRecord(deployment) || deployment.deploymentId !== deploymentId || !isRecord(deployment.results)) {
          throw new Error(`deployment record is invalid: ${deploymentId}`);
        }
        const identity = validateDeploymentIdentity(deployment, `deployment ${deploymentId}`);
        if (
          requiredTimestamp(deployment.createdAt, `deployment ${deploymentId} createdAt`)
            !== deployment.createdAt
        ) {
          throw new Error(`deployment createdAt is noncanonical: ${deploymentId}`);
        }
        if (deployment.desiredState !== identity.desiredState) {
          throw new Error(`deployment desiredState is invalid: ${deploymentId}`);
        }
        const resultHostIds = Object.keys(deployment.results).sort();
        if (JSON.stringify(resultHostIds) !== JSON.stringify(identity.targetHostIds)) {
          throw new Error(`deployment results do not match target Hosts: ${deploymentId}`);
        }
        for (const hostId of identity.targetHostIds) {
          const result = deployment.results[hostId];
          const resultState = validateDeploymentResult(
            result,
            identity,
            hostId,
            `deployment result ${deploymentId}/${hostId}`
          );
          if (resultState === 'pending' || resultState === 'queued' || resultState === 'running') {
            const key = desiredKey(hostId, identity.skillId, identity.targetScope, identity.scopeId);
            if (parsed.desired[key]?.deploymentId !== deploymentId) {
              throw new Error(`nonterminal deployment is not current desired state: ${deploymentId}/${hostId}`);
            }
          }
        }
        if (deployment.requestId != null) {
          const requestId = requiredText(deployment.requestId, 'deployment requestId', 240);
          if (parsed.requestIndex[requestId] !== deploymentId) {
            throw new Error(`deployment request index is missing: ${deploymentId}`);
          }
        }
        if (deployment.requestFingerprint != null) {
          if (!/^[a-f0-9]{64}$/.test(deployment.requestFingerprint)
            || deployment.requestFingerprint !== requestFingerprint(identity)) {
            throw new Error(`deployment request fingerprint is invalid: ${deploymentId}`);
          }
        }
      }
      for (const [key, desired] of Object.entries(parsed.desired)) {
        if (!isRecord(desired) || desired.desiredKey !== key || !parsed.deployments[desired.deploymentId]) {
          throw new Error(`desired-state record is invalid: ${key}`);
        }
        const deployment = parsed.deployments[desired.deploymentId];
        const hostId = requiredText(desired.hostId, 'desired hostId', 160);
        const expectedKey = desiredKey(hostId, deployment.skillId, deployment.targetScope, deployment.scopeId);
        if (
          key !== expectedKey
          || !deployment.results[hostId]
          || desired.skillId !== deployment.skillId
          || desired.artifactId !== deployment.artifactId
          || desired.scope !== deployment.targetScope
          || desired.scopeId !== deployment.scopeId
          || desired.cwd !== deployment.cwd
          || desired.desiredState !== deployment.desiredState
        ) {
          throw new Error(`desired-state identity is invalid: ${key}`);
        }
      }
      for (const [requestId, deploymentId] of Object.entries(parsed.requestIndex)) {
        if (
          requiredObjectKey(requestId, 'deployment requestId', 240) !== requestId
          || typeof deploymentId !== 'string'
          || !parsed.deployments[deploymentId]
          || parsed.deployments[deploymentId].requestId !== requestId
        ) {
          throw new Error(`request index record is invalid: ${requestId}`);
        }
      }
      for (const [deploymentId, tombstone] of Object.entries(parsed.tombstones || {})) {
        requiredObjectKey(deploymentId, 'deployment tombstone ID', 240);
        if (
          !isRecord(tombstone)
          || tombstone.deploymentId !== deploymentId
          || !Array.isArray(tombstone.targetHostIds)
          || !tombstone.targetHostIds.length
          || !isRecord(tombstone.resultStates)
        ) {
          throw new Error(`deployment tombstone is invalid: ${deploymentId}`);
        }
        if (parsed.deployments[deploymentId]) {
          throw new Error(`deployment tombstone collides with an active deployment: ${deploymentId}`);
        }
        const identity = validateDeploymentIdentity(tombstone, `deployment tombstone ${deploymentId}`);
        if (tombstone.createdAt != null) {
          requiredTimestamp(tombstone.createdAt, `deployment tombstone ${deploymentId} createdAt`);
        }
        const resultHostIds = Object.keys(tombstone.resultStates).sort();
        if (JSON.stringify(resultHostIds) !== JSON.stringify(identity.targetHostIds)) {
          throw new Error(`deployment tombstone results are invalid: ${deploymentId}`);
        }
        for (const stateName of Object.values(tombstone.resultStates)) {
          if (!['succeeded', 'failed', 'superseded'].includes(stateName)) {
            throw new Error(`deployment tombstone terminal state is invalid: ${deploymentId}`);
          }
        }
      }
      const hasPersistedClock = Object.hasOwn(parsed, 'nextDeploymentGeneration');
      normalizeDeploymentGenerations(parsed, hasPersistedClock);
      if (parsed.applied != null) {
        for (const [key, applied] of Object.entries(parsed.applied)) {
          const label = `applied-state record ${key}`;
          const normalizedApplied = validateAppliedRecord(applied, key, label);
          parsed.applied[key] = validateAppliedSource(
            parsed,
            normalizedApplied,
            applied,
            key,
            label,
            { requireGenerationMetadata: hasPersistedClock }
          );
        }
      }
    } catch (error) {
      throw new Error(`invalid Skill deployment state: ${error.message}`);
    }
    const loadedState = {
      version: STATE_VERSION,
      nextDeploymentGeneration: parsed.nextDeploymentGeneration,
      deployments: clone(parsed.deployments),
      desired: clone(parsed.desired),
      applied: {},
      requestIndex: clone(parsed.requestIndex),
      tombstones: clone(parsed.tombstones || {}),
    };
    loadedState.applied = parsed.applied == null
      ? migratedAppliedState(loadedState)
      : clone(parsed.applied);
    return fillMissingAppliedState(this.replayResultJournal(loadedState));
  }

  replayResultJournal(loadedState) {
    let source;
    try {
      source = fs.readFileSync(this.resultJournalPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return loadedState;
      }
      throw new Error(`failed to read Skill deployment result journal: ${error.message}`);
    }
    if (!source) {
      return loadedState;
    }
    const lines = source.split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    try {
      for (const [index, line] of lines.entries()) {
        if (!line) {
          throw new Error(`empty journal entry at line ${index + 1}`);
        }
        const entry = JSON.parse(line);
        if (!isRecord(entry) || entry.version !== STATE_VERSION || !isRecord(entry.result)) {
          throw new Error(`invalid journal entry at line ${index + 1}`);
        }
        const deploymentId = requiredObjectKey(entry.deploymentId, 'journal deploymentId', 240);
        const hostId = requiredObjectKey(entry.hostId, 'journal hostId', 160);
        const deployment = loadedState.deployments[deploymentId];
        const current = deployment?.results?.[hostId];
        if (!deployment || !current) {
          const tombstone = loadedState.tombstones[deploymentId];
          if (!tombstone || !tombstone.targetHostIds.includes(hostId)) {
            throw new Error(`journal result target was not found: ${deploymentId}/${hostId}`);
          }
          const tombstoneIdentity = validateDeploymentIdentity(
            tombstone,
            `deployment tombstone ${deploymentId}`
          );
          const tombstoneResultState = validateDeploymentResult(
            entry.result,
            tombstoneIdentity,
            hostId,
            `journal result ${deploymentId}/${hostId}`,
            { terminalOnly: true }
          );
          if (tombstone.resultStates[hostId] !== tombstoneResultState) {
            throw new Error(`journal result conflicts with compacted tombstone: ${deploymentId}/${hostId}`);
          }
          if (
            Object.hasOwn(entry, 'skillWideUncertain')
            && entry.skillWideUncertain !== needsCleanupFailureUncertainty(tombstone, entry.result)
          ) {
            throw new Error(`journal cleanup uncertainty is invalid: ${deploymentId}/${hostId}`);
          }
          this.validateJournalAppliedMutation(entry, tombstone, hostId);
          requiredText(entry.deploymentUpdatedAt, 'journal deploymentUpdatedAt', 80);
          continue;
        }
        const identity = validateDeploymentIdentity(deployment, `deployment ${deploymentId}`);
        validateDeploymentResult(
          entry.result,
          identity,
          hostId,
          `journal result ${deploymentId}/${hostId}`,
          { terminalOnly: true }
        );
        const appliedMutation = this.validateJournalAppliedMutation(entry, deployment, hostId);
        const expectedCleanupUncertainty = needsCleanupFailureUncertainty(deployment, entry.result);
        if (
          Object.hasOwn(entry, 'skillWideUncertain')
          && entry.skillWideUncertain !== expectedCleanupUncertainty
        ) {
          throw new Error(`journal cleanup uncertainty is invalid: ${deploymentId}/${hostId}`);
        }
        if (current.state === 'succeeded' || current.state === 'failed') {
          if (JSON.stringify(current) !== JSON.stringify(entry.result)) {
            throw new Error(`journal result conflicts with snapshot terminal state: ${deploymentId}/${hostId}`);
          }
          continue;
        }
        deployment.results[hostId] = clone(entry.result);
        const deploymentUpdatedAt = requiredText(
          entry.deploymentUpdatedAt,
          'journal deploymentUpdatedAt',
          80
        );
        if (entry.deploymentUpdatedAt !== deploymentUpdatedAt) {
          throw new Error(`journal deploymentUpdatedAt is noncanonical: ${deploymentId}/${hostId}`);
        }
        deployment.updatedAt = deploymentUpdatedAt;
        applyMutationIfNotOlder(loadedState, appliedMutation, deployment);
        if (expectedCleanupUncertainty) {
          if (!markCleanupFailureUncertain(loadedState, deployment, hostId, entry.result)) {
            throw new Error(`journal cleanup uncertainty is invalid: ${deploymentId}/${hostId}`);
          }
        }
      }
    } catch (error) {
      throw new Error(`invalid Skill deployment result journal: ${error.message}`);
    }
    return loadedState;
  }

  validateJournalAppliedMutation(entry, deployment, hostId) {
    const expected = appliedMutationForResult(deployment, hostId, entry.result);
    if (!Object.hasOwn(entry, 'appliedMutation')) {
      return expected;
    }
    if (entry.appliedMutation == null) {
      if (expected != null) {
        throw new Error(`journal applied mutation is missing for ${deployment.deploymentId}/${hostId}`);
      }
      return null;
    }
    const appliedKey = requiredText(
      entry.appliedMutation.appliedKey,
      'journal applied mutation key',
      8192
    );
    const actual = validateAppliedRecord(
      entry.appliedMutation,
      appliedKey,
      `journal applied mutation ${deployment.deploymentId}/${hostId}`
    );
    const comparableActual = clone(actual);
    const comparableExpected = clone(expected);
    if (!Object.hasOwn(entry.appliedMutation, 'deploymentCreatedAt')) {
      delete comparableActual.deploymentCreatedAt;
      delete comparableExpected.deploymentCreatedAt;
    }
    if (!Object.hasOwn(entry.appliedMutation, 'deploymentGeneration')) {
      delete comparableActual.deploymentGeneration;
      delete comparableExpected.deploymentGeneration;
    }
    if (JSON.stringify(comparableActual) !== JSON.stringify(comparableExpected)) {
      throw new Error(`journal applied mutation conflicts with result: ${deployment.deploymentId}/${hostId}`);
    }
    return expected;
  }

  appendResultJournal(entry) {
    fs.mkdirSync(path.dirname(this.resultJournalPath), { recursive: true });
    const fd = fs.openSync(this.resultJournalPath, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  resultJournalHasEntries() {
    try {
      return fs.statSync(this.resultJournalPath).size > 0;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw new Error(`failed to inspect Skill deployment result journal: ${error.message}`);
    }
  }

  save(next) {
    this.pruneHistory(next);
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd = null;
    try {
      fd = fs.openSync(tempPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        version: STATE_VERSION,
        savedAt: this.now(),
        nextDeploymentGeneration: next.nextDeploymentGeneration,
        deployments: next.deployments,
        desired: next.desired,
        applied: next.applied,
        requestIndex: next.requestIndex,
        tombstones: next.tombstones,
      }, null, 2), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, this.statePath);
      try {
        fs.writeFileSync(this.resultJournalPath, '', 'utf8');
        this.lastJournalCompactionError = null;
      } catch (error) {
        // The published snapshot already contains every result. Replay safely
        // ignores matching stale journal entries on restart.
        this.lastJournalCompactionError = error;
      }
    } finally {
      if (fd != null) {
        fs.closeSync(fd);
      }
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  pruneHistory(next) {
    let deploymentCount = Object.keys(next.deployments).length;
    next.tombstones = isRecord(next.tombstones) ? next.tombstones : {};
    const desiredDeploymentIds = new Set(
      Object.values(next.desired).map((record) => record?.deploymentId).filter(Boolean)
    );
    const candidates = Object.values(next.deployments)
      .filter((deployment) => {
        const results = Object.values(deployment?.results || {});
        return !desiredDeploymentIds.has(deployment.deploymentId)
          && results.length > 0
          && results.every((result) => (
            result.state === 'succeeded'
            || result.state === 'failed'
            || (
              result.state === 'superseded'
              && !(result.startedAt && !result.completedAt)
            )
          ));
      })
      .sort((left, right) => (
        String(left.createdAt).localeCompare(String(right.createdAt))
        || String(left.deploymentId).localeCompare(String(right.deploymentId))
      ));
    for (const deployment of candidates) {
      if (deploymentCount <= this.historyLimit) {
        break;
      }
      next.tombstones[deployment.deploymentId] = {
        deploymentId: deployment.deploymentId,
        generation: deployment.generation ?? null,
        skillId: deployment.skillId,
        artifactId: deployment.artifactId,
        action: deployment.action,
        targetHostIds: [...deployment.targetHostIds],
        targetScope: deployment.targetScope,
        scopeId: deployment.scopeId,
        cwd: deployment.cwd,
        confirmProjectWrite: deployment.confirmProjectWrite,
        createdAt: deployment.createdAt,
        resultStates: Object.fromEntries(
          Object.entries(deployment.results || {}).map(([hostId, result]) => [hostId, result.state])
        ),
        prunedAt: this.now(),
      };
      delete next.deployments[deployment.deploymentId];
      deploymentCount -= 1;
      for (const [requestId, indexedDeploymentId] of Object.entries(next.requestIndex)) {
        if (indexedDeploymentId === deployment.deploymentId) {
          delete next.requestIndex[requestId];
        }
      }
    }
    if (this.resultJournalHasEntries()) {
      return;
    }
    const tombstones = Object.values(next.tombstones).sort((left, right) => (
      String(left.prunedAt).localeCompare(String(right.prunedAt))
      || String(left.deploymentId).localeCompare(String(right.deploymentId))
    ));
    const appliedSourceIds = new Set(
      Object.values(next.applied || {}).map((record) => record?.deploymentId).filter(Boolean)
    );
    while (tombstones.length > this.tombstoneLimit) {
      const expiredIndex = tombstones.findIndex(
        (tombstone) => !appliedSourceIds.has(tombstone.deploymentId)
      );
      if (expiredIndex < 0) {
        break;
      }
      const [expired] = tombstones.splice(expiredIndex, 1);
      delete next.tombstones[expired.deploymentId];
    }
  }

  snapshot() {
    return clone({
      deployments: Object.values(this.state.deployments)
        .map(publicDeployment)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))),
      desired: Object.values(this.state.desired)
        .sort((left, right) => String(left.desiredKey).localeCompare(String(right.desiredKey))),
    });
  }

  deploymentSummaries(limit = 100) {
    const normalizedLimit = Math.max(1, Math.trunc(Number(limit || 100)) || 100);
    const deployments = Object.values(this.state.deployments).map(publicDeployment);
    const desiredDeploymentIds = new Set(
      Object.values(this.state.desired).map((record) => record?.deploymentId).filter(Boolean)
    );
    const required = deployments.filter((deployment) => {
      const results = Array.isArray(deployment.results) ? deployment.results : [];
      return desiredDeploymentIds.has(deployment.deploymentId)
        || !results.length
        || results.some((result) => (
          result.state === 'pending'
          || result.state === 'queued'
          || result.state === 'running'
          || (
            result.state === 'superseded'
            && result.startedAt
            && !result.completedAt
          )
        ));
    });
    const requiredIds = new Set(required.map((deployment) => deployment.deploymentId));
    const optional = deployments.filter((deployment) => !requiredIds.has(deployment.deploymentId));
    const newestFirst = (left, right) => (
      String(right.createdAt).localeCompare(String(left.createdAt))
      || String(right.deploymentId).localeCompare(String(left.deploymentId))
    );
    required.sort(newestFirst);
    optional.sort(newestFirst);
    return clone([
      ...required,
      ...optional.slice(0, Math.max(0, normalizedLimit - required.length)),
    ].sort(newestFirst));
  }

  desiredStates() {
    return clone(Object.values(this.state.desired)
      .map((record) => ({
        deploymentId: record.deploymentId,
        hostId: record.hostId,
        skillId: record.skillId,
        artifactId: record.artifactId,
        scope: record.scope,
        scopeId: record.scopeId,
        cwd: record.cwd,
        desiredState: record.desiredState,
        updatedAt: record.updatedAt,
      }))
      .sort((left, right) => (
        String(left.hostId).localeCompare(String(right.hostId))
        || String(left.skillId).localeCompare(String(right.skillId))
        || String(left.scopeId).localeCompare(String(right.scopeId))
      )));
  }

  appliedStates() {
    return clone(Object.values(this.state.applied)
      .map((record) => ({
        deploymentId: record.deploymentId,
        hostId: record.hostId,
        skillId: record.skillId,
        artifactId: record.artifactId,
        scope: record.scope,
        scopeId: record.scopeId,
        cwd: record.cwd,
        appliedState: record.appliedState,
        ...(record.uncertainArtifactIds?.length ? {
          uncertainArtifactIds: [...record.uncertainArtifactIds],
        } : {}),
        ...(record.skillWideUncertain ? { skillWideUncertain: true } : {}),
        updatedAt: record.updatedAt,
      }))
      .sort((left, right) => (
        String(left.hostId).localeCompare(String(right.hostId))
        || String(left.skillId).localeCompare(String(right.skillId))
        || String(left.scope).localeCompare(String(right.scope))
        || String(left.scopeId).localeCompare(String(right.scopeId))
      )));
  }

  artifactReferences() {
    const references = [];
    for (const desired of Object.values(this.state.desired)) {
      const deployment = this.state.deployments[desired.deploymentId];
      const result = deployment?.results?.[desired.hostId];
      const retainMissing = desired.desiredState === 'missing'
        && ['pending', 'queued', 'running', 'failed'].includes(result?.state);
      if (desired.desiredState === 'enabled' || desired.desiredState === 'disabled' || retainMissing) {
        references.push({
          kind: 'desired',
          artifactId: desired.artifactId,
          skillId: desired.skillId,
          hostId: desired.hostId,
          scope: desired.scope,
          scopeId: desired.scopeId,
          deploymentId: desired.deploymentId,
          state: desired.desiredState,
        });
      }
    }
    for (const deployment of Object.values(this.state.deployments)) {
      for (const [hostId, result] of Object.entries(deployment.results || {})) {
        const supersededRunning = result.state === 'superseded'
          && result.startedAt
          && !result.completedAt;
        if (!['pending', 'queued', 'running'].includes(result.state) && !supersededRunning) {
          continue;
        }
        references.push({
          kind: 'deployment',
          artifactId: deployment.artifactId,
          skillId: deployment.skillId,
          hostId,
          scope: deployment.targetScope,
          scopeId: deployment.scopeId,
          deploymentId: deployment.deploymentId,
          state: supersededRunning ? 'superseded-running' : result.state,
        });
      }
    }
    for (const applied of Object.values(this.state.applied)) {
      if (!['enabled', 'disabled', 'unknown'].includes(applied.appliedState)) {
        // A successful Remove can still carry legacy ordering uncertainty.
      } else {
        references.push({
          kind: 'applied',
          artifactId: applied.artifactId,
          skillId: applied.skillId,
          hostId: applied.hostId,
          scope: applied.scope,
          scopeId: applied.scopeId,
          deploymentId: applied.deploymentId,
          state: applied.appliedState,
        });
      }
      for (const artifactId of applied.uncertainArtifactIds || []) {
        if (artifactId === applied.artifactId) {
          continue;
        }
        references.push({
          kind: 'applied-uncertain',
          artifactId,
          skillId: applied.skillId,
          hostId: applied.hostId,
          scope: applied.scope,
          scopeId: applied.scopeId,
          deploymentId: applied.deploymentId,
          state: 'unknown-order',
        });
      }
      if (applied.skillWideUncertain) {
        references.push({
          kind: 'applied-uncertain',
          artifactId: null,
          skillId: applied.skillId,
          hostId: applied.hostId,
          scope: applied.scope,
          scopeId: applied.scopeId,
          deploymentId: applied.deploymentId,
          state: 'cleanup-failed',
        });
      }
    }
    return clone(references.sort((left, right) => (
      String(left.kind).localeCompare(String(right.kind))
      || String(left.artifactId || '').localeCompare(String(right.artifactId || ''))
      || String(left.skillId).localeCompare(String(right.skillId))
      || String(left.hostId).localeCompare(String(right.hostId))
      || String(left.scope).localeCompare(String(right.scope))
      || String(left.scopeId).localeCompare(String(right.scopeId))
      || String(left.deploymentId || '').localeCompare(String(right.deploymentId || ''))
      || String(left.state).localeCompare(String(right.state))
    )));
  }

  getDeployment(deploymentId) {
    const id = String(deploymentId || '').trim();
    return Object.hasOwn(this.state.deployments, id)
      ? publicDeployment(this.state.deployments[id])
      : null;
  }

  hasRequestId(requestId) {
    const id = String(requestId || '').trim();
    return Boolean(id && Object.hasOwn(this.state.requestIndex, id));
  }

  getPrunedDeployment(deploymentId, hostId) {
    const id = String(deploymentId || '').trim();
    const normalizedHostId = String(hostId || '').trim();
    const tombstone = Object.hasOwn(this.state.tombstones, id)
      ? this.state.tombstones[id]
      : null;
    if (!tombstone || !tombstone.targetHostIds.includes(normalizedHostId)) {
      return null;
    }
    return clone(tombstone);
  }

  createDeployment(input = {}) {
    const requestId = input.requestId ? requiredObjectKey(input.requestId, 'requestId', 240) : null;
    const skillId = normalizePortableSkillId(input.skillId);
    const artifactId = normalizeHash(input.artifactId);
    const action = requiredText(input.action, 'action', 40).toLowerCase();
    const desiredState = {
      enable: 'enabled',
      disable: 'disabled',
      remove: 'missing',
    }[action];
    if (!desiredState) {
      throw new Error('action must be enable, disable, or remove');
    }
    const targetHostIds = uniqueTexts(input.targetHostIds, 'targetHostIds');
    const targetScope = requiredText(input.targetScope || 'user', 'targetScope', 40).toLowerCase();
    if (targetScope !== 'user' && targetScope !== 'project') {
      throw new Error('targetScope must be user or project');
    }
    let scopeId = 'user';
    let cwd = null;
    if (targetScope === 'project') {
      if (input.confirmProjectWrite !== true) {
        throw new Error('project deployment requires confirmProjectWrite confirmation');
      }
      cwd = requiredText(input.cwd || input.scopeId, 'cwd');
      scopeId = requiredText(input.scopeId || cwd, 'scopeId');
      if (scopeId !== cwd) {
        throw new Error('project scopeId must exactly match cwd');
      }
    }

    const fingerprint = requestFingerprint({
      skillId,
      artifactId,
      action,
      targetHostIds,
      targetScope,
      scopeId,
      cwd,
      confirmProjectWrite: targetScope === 'project',
    });
    if (requestId && this.state.requestIndex[requestId]) {
      const existingDeploymentId = this.state.requestIndex[requestId];
      const existing = this.state.deployments[existingDeploymentId];
      if (!existing) {
        throw new Error(`request index references a missing deployment: ${requestId}`);
      }
      const existingFingerprint = existing.requestFingerprint || requestFingerprint(existing);
      if (existingFingerprint !== fingerprint) {
        const error = new Error('requestId was already used for a different Skill deployment request');
        error.statusCode = 409;
        throw error;
      }
      return {
        reused: true,
        deployment: publicDeployment(existing),
        superseded: [],
      };
    }

    const deploymentId = requiredObjectKey(
      input.deploymentId || this.idFactory(),
      'deploymentId',
      240
    );
    if (this.state.deployments[deploymentId] || this.state.tombstones[deploymentId]) {
      throw new Error(`deploymentId already exists: ${deploymentId}`);
    }
    const timestamp = this.now();
    const next = clone(this.state);
    const generation = optionalGeneration(
      next.nextDeploymentGeneration,
      'nextDeploymentGeneration'
    );
    if (generation == null || generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error('deployment generation space is exhausted');
    }
    next.nextDeploymentGeneration = generation + 1;
    const results = {};
    const superseded = [];
    for (const hostId of targetHostIds) {
      const key = desiredKey(hostId, skillId, targetScope, scopeId);
      const previousDesired = next.desired[key];
      if (previousDesired?.deploymentId) {
        const previousDeployment = next.deployments[previousDesired.deploymentId];
        const previousResult = previousDeployment?.results?.[hostId];
        if (previousResult && (
          previousResult.state === 'pending'
          || previousResult.state === 'queued'
          || previousResult.state === 'running'
        )) {
          previousResult.state = 'superseded';
          previousResult.updatedAt = timestamp;
          previousResult.error = '';
          superseded.push({
            deploymentId: previousDeployment.deploymentId,
            hostId,
            result: clone(previousResult),
          });
        }
      }
      results[hostId] = {
        hostId,
        state: 'pending',
        attemptCount: 0,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
        updatedAt: timestamp,
        error: '',
        observedHash: null,
        activationPath: null,
      };
      next.desired[key] = {
        desiredKey: key,
        deploymentId,
        hostId,
        skillId,
        artifactId,
        scope: targetScope,
        scopeId,
        cwd,
        desiredState,
        updatedAt: timestamp,
      };
      if (!next.applied[key]) {
        next.applied[key] = {
          appliedKey: key,
          deploymentId: null,
          deploymentCreatedAt: null,
          deploymentGeneration: null,
          uncertainArtifactIds: [],
          skillWideUncertain: false,
          hostId,
          skillId,
          artifactId: null,
          scope: targetScope,
          scopeId,
          cwd,
          appliedState: 'unknown',
          updatedAt: timestamp,
        };
      }
    }
    const deployment = {
      deploymentId,
      generation,
      requestId,
      requestFingerprint: fingerprint,
      skillId,
      artifactId,
      action,
      targetHostIds,
      targetScope,
      scopeId,
      cwd,
      confirmProjectWrite: targetScope === 'project',
      desiredState,
      createdBy: String(input.createdBy || 'user').trim().slice(0, 160) || 'user',
      createdAt: timestamp,
      updatedAt: timestamp,
      results,
    };
    next.deployments[deploymentId] = deployment;
    if (requestId) {
      next.requestIndex[requestId] = deploymentId;
    }
    this.save(next);
    this.state = next;
    return { reused: false, deployment: publicDeployment(deployment), superseded };
  }

  markQueued(deploymentId, hostId) {
    return this.markQueuedMany(deploymentId, [hostId])[0];
  }

  markQueuedMany(deploymentId, hostIds) {
    const id = requiredObjectKey(deploymentId, 'deploymentId', 240);
    const normalizedHostIds = uniqueTexts(hostIds, 'hostIds');
    return this.markQueuedBatch(normalizedHostIds.map((hostId) => ({
      deploymentId: id,
      hostId,
    }))).map((entry) => entry.result);
  }

  markQueuedBatch(targets) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 10000) {
      throw new Error('queue targets must contain between 1 and 10000 entries');
    }
    const uniqueTargets = new Map();
    for (const target of targets) {
      const deploymentId = requiredObjectKey(target?.deploymentId, 'deploymentId', 240);
      const hostId = requiredObjectKey(target?.hostId, 'hostId', 160);
      uniqueTargets.set(JSON.stringify([deploymentId, hostId]), { deploymentId, hostId });
    }
    const normalizedTargets = Array.from(uniqueTargets.values()).sort((left, right) => (
      left.deploymentId.localeCompare(right.deploymentId) || left.hostId.localeCompare(right.hostId)
    ));
    for (const { deploymentId, hostId } of normalizedTargets) {
      const deployment = this.state.deployments[deploymentId];
      if (!deployment?.results?.[hostId]) {
        throw new Error(`deployment result was not found for Host ${hostId}`);
      }
    }

    const next = clone(this.state);
    const timestamp = this.now();
    let changed = false;
    for (const { deploymentId, hostId } of normalizedTargets) {
      const deployment = next.deployments[deploymentId];
      const result = deployment.results[hostId];
      if (result.state === 'succeeded' || result.state === 'failed' || result.state === 'superseded') {
        continue;
      }
      const key = desiredKey(hostId, deployment.skillId, deployment.targetScope, deployment.scopeId);
      if (next.desired[key]?.deploymentId !== deploymentId) {
        result.state = 'superseded';
        result.updatedAt = timestamp;
        changed = true;
      } else {
        result.state = 'queued';
        result.attemptCount = Number(result.attemptCount || 0) + 1;
        result.queuedAt = timestamp;
        result.startedAt = null;
        result.completedAt = null;
        result.updatedAt = timestamp;
        result.error = '';
        deployment.updatedAt = timestamp;
        changed = true;
      }
    }
    if (changed) {
      this.save(next);
      this.state = next;
    }
    return normalizedTargets.map(({ deploymentId, hostId }) => ({
      deploymentId,
      hostId,
      result: clone(next.deployments[deploymentId].results[hostId]),
    }));
  }

  markRunningMany(deploymentId, hostIds) {
    const id = requiredObjectKey(deploymentId, 'deploymentId', 240);
    const normalizedHostIds = uniqueTexts(hostIds, 'hostIds');
    return this.markRunningBatch(normalizedHostIds.map((hostId) => ({
      deploymentId: id,
      hostId,
    }))).map((entry) => entry.result);
  }

  markRunningBatch(targets) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 10000) {
      throw new Error('running targets must contain between 1 and 10000 entries');
    }
    const uniqueTargets = new Map();
    for (const target of targets) {
      const deploymentId = requiredObjectKey(target?.deploymentId, 'deploymentId', 240);
      const hostId = requiredObjectKey(target?.hostId, 'hostId', 160);
      uniqueTargets.set(JSON.stringify([deploymentId, hostId]), { deploymentId, hostId });
    }
    const normalizedTargets = Array.from(uniqueTargets.values()).sort((left, right) => (
      left.deploymentId.localeCompare(right.deploymentId) || left.hostId.localeCompare(right.hostId)
    ));
    for (const { deploymentId, hostId } of normalizedTargets) {
      const deployment = this.state.deployments[deploymentId];
      if (!deployment?.results?.[hostId]) {
        throw new Error(`deployment result was not found for Host ${hostId}`);
      }
    }

    const next = clone(this.state);
    const timestamp = this.now();
    let changed = false;
    for (const { deploymentId, hostId } of normalizedTargets) {
      const deployment = next.deployments[deploymentId];
      const result = deployment.results[hostId];
      if (result.state !== 'queued') {
        continue;
      }
      result.state = 'running';
      result.startedAt = timestamp;
      result.updatedAt = timestamp;
      deployment.updatedAt = timestamp;
      changed = true;
    }
    if (changed) {
      this.save(next);
      this.state = next;
    }
    return normalizedTargets.map(({ deploymentId, hostId }) => ({
      deploymentId,
      hostId,
      result: clone(next.deployments[deploymentId].results[hostId]),
    }));
  }

  applyResult(input = {}) {
    const deploymentId = requiredObjectKey(input.deploymentId, 'deploymentId', 240);
    const hostId = requiredObjectKey(input.hostId, 'hostId', 160);
    const deployment = this.state.deployments[deploymentId];
    const result = deployment?.results?.[hostId];
    if (!deployment || !result) {
      throw new Error('deployment result was not found');
    }
    const nextState = input.ok === false ? 'failed' : 'succeeded';
    if (result.state === 'superseded' && !result.startedAt) {
      return clone(result);
    }
    if (result.state === 'failed' || result.state === 'succeeded') {
      if (result.state === nextState) {
        return clone(result);
      }
      throw new Error(`deployment result conflicts with terminal ${result.state} state`);
    }
    const timestamp = this.now();
    const nextResult = {
      ...clone(result),
      state: nextState,
      completedAt: timestamp,
      updatedAt: timestamp,
      error: input.ok === false
        ? String(input.error || 'Host deployment failed').trim().slice(0, 4096)
        : '',
      observedHash: input.observedHash ? String(input.observedHash).trim().slice(0, 96) : null,
      activationPath: input.activationPath ? String(input.activationPath).trim().slice(0, 8192) : null,
      hostState: input.state ? String(input.state).trim().slice(0, 40) : null,
      idempotent: Boolean(input.idempotent),
    };
    validateDeploymentResult(
      nextResult,
      deployment,
      hostId,
      `deployment result ${deploymentId}/${hostId}`,
      { terminalOnly: true }
    );
    const appliedMutation = appliedMutationForResult(deployment, hostId, nextResult);
    this.appendResultJournal({
      version: STATE_VERSION,
      deploymentId,
      hostId,
      deploymentUpdatedAt: timestamp,
      result: nextResult,
      appliedMutation,
      skillWideUncertain: needsCleanupFailureUncertainty(deployment, nextResult),
    });
    deployment.results[hostId] = nextResult;
    deployment.updatedAt = timestamp;
    applyMutationIfNotOlder(this.state, appliedMutation, deployment);
    markCleanupFailureUncertain(this.state, deployment, hostId, nextResult);
    return clone(nextResult);
  }

  pendingForHost(hostId, options = {}) {
    const normalizedHostId = requiredObjectKey(hostId, 'hostId', 160);
    const includeRunning = options.includeRunning !== false;
    const pending = [];
    for (const deployment of Object.values(this.state.deployments)) {
      const result = deployment.results?.[normalizedHostId];
      if (!result || !(
        result.state === 'pending'
        || result.state === 'queued'
        || (includeRunning && result.state === 'running')
      )) {
        continue;
      }
      const key = desiredKey(
        normalizedHostId,
        deployment.skillId,
        deployment.targetScope,
        deployment.scopeId
      );
      if (this.state.desired[key]?.deploymentId !== deployment.deploymentId) {
        continue;
      }
      pending.push(clone({
        deploymentId: deployment.deploymentId,
        skillId: deployment.skillId,
        artifactId: deployment.artifactId,
        action: deployment.action,
        targetScope: deployment.targetScope,
        scopeId: deployment.scopeId,
        cwd: deployment.cwd,
        confirmProjectWrite: deployment.confirmProjectWrite,
        desiredState: deployment.desiredState,
        createdAt: deployment.createdAt,
        result,
      }));
    }
    return pending.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }
}

module.exports = {
  SkillDeploymentService,
};
