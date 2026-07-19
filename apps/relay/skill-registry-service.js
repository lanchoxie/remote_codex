const fs = require('fs');
const path = require('path');
const { inspectSkillArtifactArchive } = require('../../shared/skill-artifact');
const { normalizePortableSkillId } = require('../../shared/skill-id');

const REGISTRY_VERSION = 1;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STORAGE_STATES = new Set(['available', 'gc-pending', 'collected']);
const SOURCE_REFRESH_POLICIES = new Set(['manual', 'hourly', 'daily', 'weekly']);
const SOURCE_ROLLOUT_POLICIES = new Set(['manual', 'enabled-hosts']);
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, maxLength, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return (text || fallback).slice(0, maxLength);
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

function requiredObjectKey(value, name, maxLength = 8192) {
  const text = requiredText(value, name, maxLength);
  if (RESERVED_OBJECT_KEYS.has(text.toLowerCase())) {
    throw new Error(`${name} is a reserved object key`);
  }
  return text;
}

function normalizeSkillId(value) {
  return normalizePortableSkillId(value);
}

function normalizeHash(value, name = 'content hash') {
  const hash = cleanText(value, 96).toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`${name} must be a sha256 digest`);
  }
  return hash;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function emptyState() {
  return {
    version: REGISTRY_VERSION,
    revision: 0,
    sources: {},
    artifacts: {},
    library: {},
  };
}

function normalizeMetadata(input = {}) {
  if (!isRecord(input)) {
    throw new Error('artifact metadata must be an object');
  }
  const skillId = normalizeSkillId(input.skillId);
  const sourceKind = cleanText(input.sourceKind, 80, 'local-host').toLowerCase();
  const sourceLocator = cleanText(input.sourceLocator, 8192);
  const sourceId = requiredObjectKey(
    cleanText(input.sourceId, 8192, `${sourceKind}:${sourceLocator || skillId}`),
    'sourceId'
  );
  return {
    skillId,
    name: cleanText(input.name, 512, skillId),
    description: cleanText(input.description, 4096),
    version: input.version == null ? null : cleanText(input.version, 160),
    sourceId,
    sourceKind,
    sourceLocator,
    sourceRef: input.sourceRef == null ? null : cleanText(input.sourceRef, 512),
    sourcePath: input.sourcePath == null ? null : cleanText(input.sourcePath, 8192),
    expectedHash: normalizeHash(input.expectedHash, 'expectedHash'),
  };
}

function sourceFromMetadata(metadata, existing, timestamp) {
  return {
    sourceId: metadata.sourceId,
    kind: metadata.sourceKind,
    name: existing?.name || metadata.sourceLocator || metadata.sourceId,
    locator: metadata.sourceLocator,
    ref: metadata.sourceRef,
    subpath: metadata.sourcePath,
    enabled: existing?.enabled !== false,
    refreshPolicy: existing?.refreshPolicy || 'manual',
    rolloutPolicy: existing?.rolloutPolicy || 'manual',
    credentialRef: existing?.credentialRef || null,
    lastRefreshAt: existing?.lastRefreshAt || null,
    lastSuccessAt: timestamp,
    lastError: null,
    revision: metadata.expectedHash,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function normalizeSourceRecord(key, input) {
  const sourceId = requiredObjectKey(key, 'sourceId');
  if (key !== sourceId || !isRecord(input) || input.sourceId !== sourceId) {
    throw new Error(`source record is invalid: ${sourceId}`);
  }
  const kind = requiredText(input.kind, `source ${sourceId} kind`, 80).toLowerCase();
  if (input.kind !== kind) {
    throw new Error(`source kind is not canonical: ${sourceId}`);
  }
  const refreshPolicy = cleanText(input.refreshPolicy, 40, 'manual').toLowerCase();
  const rolloutPolicy = cleanText(input.rolloutPolicy, 40, 'manual').toLowerCase();
  if (!SOURCE_REFRESH_POLICIES.has(refreshPolicy)) {
    throw new Error(`source refreshPolicy is invalid: ${sourceId}`);
  }
  if (!SOURCE_ROLLOUT_POLICIES.has(rolloutPolicy)) {
    throw new Error(`source rolloutPolicy is invalid: ${sourceId}`);
  }
  return {
    ...clone(input),
    sourceId,
    kind,
    enabled: input.enabled !== false,
    refreshPolicy,
    rolloutPolicy,
    lastRefreshAt: input.lastRefreshAt || null,
    lastSuccessAt: input.lastSuccessAt || null,
    lastError: input.lastError == null ? null : String(input.lastError).slice(0, 4096),
  };
}

function normalizeArtifactRecord(key, input, artifactRoot) {
  const artifactId = normalizeHash(key, 'artifactId');
  if (
    key !== artifactId
    || !isRecord(input)
    || input.artifactId !== artifactId
    || input.contentHash !== artifactId
  ) {
    throw new Error(`Artifact record is invalid: ${artifactId}`);
  }
  const skillId = normalizeSkillId(input.skillId);
  if (input.skillId !== skillId) {
    throw new Error(`Artifact skillId is not canonical: ${artifactId}`);
  }
  const skillIds = Array.from(new Set(
    (Array.isArray(input.skillIds) ? input.skillIds : [skillId])
      .map((entry) => normalizeSkillId(entry))
  )).sort();
  if (!skillIds.includes(skillId)) {
    throw new Error(`Artifact primary skillId is missing from skillIds: ${artifactId}`);
  }
  const storageState = input.storageState || 'available';
  if (!STORAGE_STATES.has(storageState)) {
    throw new Error(`Artifact storageState is invalid: ${artifactId}`);
  }
  const expectedArchivePath = path.join(
    artifactRoot,
    `${artifactId.slice('sha256:'.length)}.rcskill`
  );
  if (!samePath(input.archivePath, expectedArchivePath)) {
    throw new Error(`Artifact archivePath is invalid: ${artifactId}`);
  }
  if (storageState === 'available') {
    let stats;
    try {
      stats = fs.statSync(expectedArchivePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`available Artifact archive is missing: ${artifactId}`);
      }
      throw error;
    }
    if (!stats.isFile()) {
      throw new Error(`available Artifact archive is not a file: ${artifactId}`);
    }
  }
  if (!Array.isArray(input.sources)) {
    throw new Error(`Artifact sources are invalid: ${artifactId}`);
  }
  for (const source of input.sources) {
    if (!isRecord(source)) {
      throw new Error(`Artifact source link is invalid: ${artifactId}`);
    }
    requiredObjectKey(source.sourceId, `Artifact ${artifactId} sourceId`);
  }
  return {
    ...clone(input),
    artifactId,
    skillId,
    skillIds,
    contentHash: artifactId,
    archivePath: expectedArchivePath,
    storageState,
    gcRequestedAt: input.gcRequestedAt || null,
    collectedAt: input.collectedAt || null,
  };
}

function normalizeLibraryRecord(key, input, artifacts, sources) {
  const skillId = normalizeSkillId(key);
  if (key !== skillId || !isRecord(input) || input.skillId !== skillId) {
    throw new Error(`Library record is invalid: ${skillId}`);
  }
  if (!Array.isArray(input.artifactIds) || !Array.isArray(input.versions)) {
    throw new Error(`Library versions are invalid: ${skillId}`);
  }
  const artifactIds = input.artifactIds.map((artifactId) => normalizeHash(artifactId, 'artifactId'));
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error(`Library artifactIds contain duplicates: ${skillId}`);
  }
  const versions = input.versions.map((version) => {
    if (!isRecord(version)) {
      throw new Error(`Library version is invalid: ${skillId}`);
    }
    const artifactId = normalizeHash(version.artifactId, 'artifactId');
    const sourceId = requiredObjectKey(version.sourceId, `Library ${skillId} sourceId`);
    if (!Object.hasOwn(artifacts, artifactId) || !Object.hasOwn(sources, sourceId)) {
      throw new Error(`Library version link is missing its Artifact or Source: ${skillId}`);
    }
    if (!artifacts[artifactId].skillIds.includes(skillId)) {
      throw new Error(`Library Artifact does not support its Skill: ${skillId}/${artifactId}`);
    }
    if (!(artifacts[artifactId].sources || []).some((source) => source.sourceId === sourceId)) {
      throw new Error(`Library version Source is not linked to its Artifact: ${skillId}/${sourceId}`);
    }
    return { ...clone(version), artifactId, sourceId };
  });
  const linkedArtifactIds = Array.from(new Set(versions.map((version) => version.artifactId)));
  if (
    artifactIds.length !== linkedArtifactIds.length
    || artifactIds.some((artifactId) => !linkedArtifactIds.includes(artifactId))
  ) {
    throw new Error(`Library artifactIds do not match versions: ${skillId}`);
  }
  const latestArtifactId = input.latestArtifactId == null
    ? null
    : normalizeHash(input.latestArtifactId, 'latestArtifactId');
  if (latestArtifactId && !artifactIds.includes(latestArtifactId)) {
    throw new Error(`Library latestArtifactId is not linked: ${skillId}`);
  }
  const archived = input.archived === true;
  if (!archived) {
    for (const artifactId of artifactIds) {
      if (artifacts[artifactId].storageState !== 'available') {
        throw new Error(`active Library links a non-available Artifact: ${skillId}`);
      }
    }
  }
  return {
    ...clone(input),
    skillId,
    artifactIds,
    latestArtifactId,
    versions,
    archived,
    retiredAt: archived ? (input.retiredAt || input.updatedAt || null) : null,
  };
}

function normalizeLoadedState(parsed, artifactRoot) {
  if (
    !isRecord(parsed)
    || parsed.version !== REGISTRY_VERSION
    || !isRecord(parsed.sources)
    || !isRecord(parsed.artifacts)
    || !isRecord(parsed.library)
  ) {
    throw new Error(`invalid schema or version; expected version ${REGISTRY_VERSION}`);
  }
  const revision = parsed.revision == null ? 0 : parsed.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('revision must be a non-negative safe integer');
  }
  const sources = {};
  for (const [sourceId, source] of Object.entries(parsed.sources)) {
    sources[sourceId] = normalizeSourceRecord(sourceId, source);
  }
  const artifacts = {};
  for (const [artifactId, artifact] of Object.entries(parsed.artifacts)) {
    artifacts[artifactId] = normalizeArtifactRecord(artifactId, artifact, artifactRoot);
  }
  for (const artifact of Object.values(artifacts)) {
    for (const source of artifact.sources) {
      if (!Object.hasOwn(sources, source.sourceId)) {
        throw new Error(`Artifact source link was not found: ${artifact.artifactId}/${source.sourceId}`);
      }
    }
  }
  const library = {};
  for (const [skillId, record] of Object.entries(parsed.library)) {
    library[skillId] = normalizeLibraryRecord(skillId, record, artifacts, sources);
  }
  return {
    version: REGISTRY_VERSION,
    revision,
    sources,
    artifacts,
    library,
  };
}

function normalizeExpectedRevision(value) {
  if (value == null || value === '') {
    return null;
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer');
  }
  return revision;
}

function compareReferences(left, right) {
  return String(left.artifactId || '').localeCompare(String(right.artifactId || ''))
    || String(left.kind || '').localeCompare(String(right.kind || ''))
    || String(left.skillId || '').localeCompare(String(right.skillId || ''))
    || String(left.hostId || '').localeCompare(String(right.hostId || ''))
    || String(left.scope || '').localeCompare(String(right.scope || ''))
    || String(left.scopeId || '').localeCompare(String(right.scopeId || ''))
    || String(left.deploymentId || '').localeCompare(String(right.deploymentId || ''))
    || String(left.state || '').localeCompare(String(right.state || ''));
}

function deduplicateReferences(references) {
  const byKey = new Map();
  for (const reference of references) {
    const normalized = clone(reference);
    const key = JSON.stringify([
      normalized.artifactId || '',
      normalized.kind || '',
      normalized.skillId || '',
      normalized.hostId || '',
      normalized.scope || '',
      normalized.scopeId || '',
      normalized.deploymentId || '',
      normalized.state || '',
    ]);
    byKey.set(key, normalized);
  }
  return Array.from(byKey.values()).sort(compareReferences);
}

class SkillRegistryService {
  constructor(options = {}) {
    if (!options.registryPath) {
      throw new Error('registryPath is required');
    }
    this.registryPath = path.resolve(options.registryPath);
    this.artifactRoot = path.resolve(
      options.artifactRoot || path.join(path.dirname(this.registryPath), 'skill-artifacts')
    );
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    this.unlinkArchive = typeof options.unlinkArchive === 'function'
      ? options.unlinkArchive
      : (archivePath) => fs.promises.unlink(archivePath);
    this.mutationTail = Promise.resolve();
    this.state = this.load();
  }

  load() {
    let source;
    try {
      source = fs.readFileSync(this.registryPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return emptyState();
      }
      throw new Error(`failed to read Skill registry state: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`invalid Skill registry state JSON: ${error.message}`);
    }
    try {
      return normalizeLoadedState(parsed, this.artifactRoot);
    } catch (error) {
      throw new Error(`invalid Skill registry state: ${error.message}`);
    }
  }

  enqueueMutation(work) {
    const result = this.mutationTail.then(work, work);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  save(nextState) {
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    const tempPath = `${this.registryPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    let fd = null;
    try {
      fd = fs.openSync(tempPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        version: REGISTRY_VERSION,
        revision: nextState.revision,
        savedAt: this.now(),
        sources: nextState.sources,
        artifacts: nextState.artifacts,
        library: nextState.library,
      }, null, 2), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, this.registryPath);
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

  commit(nextState) {
    nextState.version = REGISTRY_VERSION;
    nextState.revision = this.state.revision + 1;
    this.save(nextState);
    this.state = nextState;
  }

  assertRevision(expectedRevision) {
    const expected = normalizeExpectedRevision(expectedRevision);
    if (expected != null && expected !== this.state.revision) {
      const error = new Error(
        `Skill registry revision changed; expected ${expected}, current ${this.state.revision}`
      );
      error.statusCode = 409;
      error.revision = this.state.revision;
      throw error;
    }
  }

  snapshot(options = {}) {
    const includeManifest = options.includeManifest !== false;
    const artifacts = Object.values(this.state.artifacts).map((artifact) => {
      if (includeManifest) {
        return artifact;
      }
      const { manifest, ...summary } = artifact;
      return summary;
    });
    return clone({
      revision: this.state.revision,
      sources: Object.values(this.state.sources).sort((left, right) => (
        String(left.sourceId).localeCompare(String(right.sourceId))
      )),
      artifacts: artifacts.sort((left, right) => (
        String(left.artifactId).localeCompare(String(right.artifactId))
      )),
      library: Object.values(this.state.library).sort((left, right) => (
        String(left.name || left.skillId).localeCompare(String(right.name || right.skillId))
      )),
    });
  }

  artifactPath(artifactId) {
    const normalized = normalizeHash(artifactId, 'artifactId');
    return path.join(this.artifactRoot, `${normalized.slice('sha256:'.length)}.rcskill`);
  }

  getArtifact(artifactId) {
    const normalized = normalizeHash(artifactId, 'artifactId');
    const artifact = Object.hasOwn(this.state.artifacts, normalized)
      ? this.state.artifacts[normalized]
      : null;
    return artifact ? clone(artifact) : null;
  }

  getSource(sourceId) {
    const normalized = requiredObjectKey(sourceId, 'sourceId');
    const source = Object.hasOwn(this.state.sources, normalized)
      ? this.state.sources[normalized]
      : null;
    return source ? clone(source) : null;
  }

  getLibraryRecord(skillId) {
    const normalized = normalizeSkillId(skillId);
    const record = Object.hasOwn(this.state.library, normalized)
      ? this.state.library[normalized]
      : null;
    return record ? clone(record) : null;
  }

  libraryHasArtifact(skillId, artifactId, options = {}) {
    const normalizedSkillId = normalizeSkillId(skillId);
    const normalizedArtifactId = normalizeHash(artifactId, 'artifactId');
    const record = this.state.library[normalizedSkillId];
    const artifact = this.state.artifacts[normalizedArtifactId];
    if (!record || !artifact || !record.artifactIds.includes(normalizedArtifactId)) {
      return false;
    }
    return options.availableOnly === false || artifact.storageState === 'available';
  }

  isActiveLibraryArtifact(skillId, artifactId) {
    const normalizedSkillId = normalizeSkillId(skillId);
    const record = this.state.library[normalizedSkillId];
    return Boolean(
      record
      && record.archived !== true
      && this.libraryHasArtifact(normalizedSkillId, artifactId)
    );
  }

  async ensureStoredArchive(sourceArchivePath, inspection) {
    const targetPath = this.artifactPath(inspection.artifactId);
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      let stored;
      try {
        stored = await inspectSkillArtifactArchive(targetPath);
      } catch (error) {
        throw new Error(`stored artifact is corrupt: ${error.message}`);
      }
      if (stored.contentHash !== inspection.contentHash) {
        throw new Error('stored artifact hash does not match its content address');
      }
      return { path: targetPath, existed: true };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.promises.mkdir(this.artifactRoot, { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.promises.copyFile(path.resolve(sourceArchivePath), tempPath, fs.constants.COPYFILE_EXCL);
      const copied = await inspectSkillArtifactArchive(tempPath);
      if (copied.contentHash !== inspection.contentHash) {
        throw new Error('artifact changed while copying into the registry');
      }
      const handle = await fs.promises.open(tempPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(tempPath, targetPath);
      return { path: targetPath, existed: false };
    } finally {
      await fs.promises.unlink(tempPath).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }

  importArchive(archivePath, rawMetadata) {
    return this.enqueueMutation(async () => {
      const metadata = normalizeMetadata(rawMetadata);
      const inspection = await inspectSkillArtifactArchive(archivePath);
      if (inspection.contentHash !== metadata.expectedHash) {
        throw new Error(
          `artifact hash ${inspection.contentHash} does not match expected hash ${metadata.expectedHash}`
        );
      }

      const stored = await this.ensureStoredArchive(archivePath, inspection);
      const timestamp = this.now();
      const next = clone(this.state);
      const existingSource = next.sources[metadata.sourceId] || null;
      next.sources[metadata.sourceId] = sourceFromMetadata(metadata, existingSource, timestamp);

      const existingArtifact = next.artifacts[inspection.artifactId] || null;
      const sourceRecord = {
        sourceId: metadata.sourceId,
        sourceKind: metadata.sourceKind,
        sourceLocator: metadata.sourceLocator,
        sourceRef: metadata.sourceRef,
        sourcePath: metadata.sourcePath,
      };
      const artifactSources = Array.isArray(existingArtifact?.sources)
        ? existingArtifact.sources.filter((source) => source.sourceId !== metadata.sourceId)
        : [];
      artifactSources.push(sourceRecord);
      artifactSources.sort((left, right) => String(left.sourceId).localeCompare(String(right.sourceId)));
      const skillIds = Array.from(new Set([
        ...(Array.isArray(existingArtifact?.skillIds) ? existingArtifact.skillIds : []),
        existingArtifact?.skillId,
        metadata.skillId,
      ].filter(Boolean))).sort();
      const artifact = {
        artifactId: inspection.artifactId,
        skillId: existingArtifact?.skillId || metadata.skillId,
        skillIds,
        name: existingArtifact?.name || metadata.name,
        description: existingArtifact?.description || metadata.description,
        version: existingArtifact?.version || metadata.version,
        sourceId: existingArtifact?.sourceId || metadata.sourceId,
        sourceLocator: existingArtifact?.sourceLocator || metadata.sourceLocator,
        sourceRef: existingArtifact?.sourceRef || metadata.sourceRef,
        sourcePath: existingArtifact?.sourcePath || metadata.sourcePath,
        sources: artifactSources,
        contentHash: inspection.contentHash,
        archivePath: stored.path,
        archiveBytes: inspection.archiveBytes,
        fileCount: inspection.fileCount,
        totalBytes: inspection.totalBytes,
        manifest: {
          version: REGISTRY_VERSION,
          files: inspection.files,
        },
        createdAt: existingArtifact?.createdAt || timestamp,
        updatedAt: timestamp,
        trustState: 'validated',
        storageState: 'available',
        gcRequestedAt: null,
        collectedAt: null,
      };
      next.artifacts[artifact.artifactId] = artifact;

      const existingLibrary = next.library[metadata.skillId] || null;
      const versionKey = `${artifact.artifactId}\0${metadata.sourceId}`;
      const versions = Array.isArray(existingLibrary?.versions)
        ? clone(existingLibrary.versions)
        : [];
      const existingVersionIndex = versions.findIndex((version) => (
        `${version.artifactId}\0${version.sourceId}` === versionKey
      ));
      const versionRecord = {
        artifactId: artifact.artifactId,
        sourceId: metadata.sourceId,
        sourceKind: metadata.sourceKind,
        sourceLocator: metadata.sourceLocator,
        sourceRef: metadata.sourceRef,
        sourcePath: metadata.sourcePath,
        version: metadata.version,
        createdAt: existingVersionIndex >= 0 ? versions[existingVersionIndex].createdAt : timestamp,
      };
      if (existingVersionIndex >= 0) {
        versions[existingVersionIndex] = versionRecord;
      } else {
        versions.push(versionRecord);
      }
      const artifactIds = Array.from(new Set([
        ...(Array.isArray(existingLibrary?.artifactIds) ? existingLibrary.artifactIds : []),
        artifact.artifactId,
      ]));
      const archived = existingLibrary?.archived === true;
      const libraryRecord = {
        skillId: metadata.skillId,
        name: metadata.name || existingLibrary?.name || metadata.skillId,
        description: metadata.description || existingLibrary?.description || '',
        artifactIds,
        latestArtifactId: artifact.artifactId,
        versions,
        archived,
        retiredAt: archived ? (existingLibrary.retiredAt || timestamp) : null,
        createdAt: existingLibrary?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      next.library[metadata.skillId] = libraryRecord;

      const wasAvailable = existingArtifact?.storageState == null
        || existingArtifact?.storageState === 'available';
      this.commit(next);
      return clone({
        artifact,
        libraryRecord,
        deduplicated: Boolean(existingArtifact && wasAvailable && stored.existed),
      });
    });
  }

  markSourceRefreshStarted(sourceId, options = {}) {
    return this.enqueueMutation(() => {
      this.assertRevision(options.expectedRevision);
      const normalized = requiredObjectKey(sourceId, 'sourceId');
      const existing = this.state.sources[normalized];
      if (!existing) {
        const error = new Error('Skill source was not found');
        error.statusCode = 404;
        throw error;
      }
      const timestamp = this.now();
      const next = clone(this.state);
      next.sources[normalized] = {
        ...next.sources[normalized],
        lastRefreshAt: timestamp,
        lastError: null,
        updatedAt: timestamp,
      };
      this.commit(next);
      return clone(next.sources[normalized]);
    });
  }

  markSourceRefreshFailed(sourceId, message) {
    return this.enqueueMutation(() => {
      const normalized = requiredObjectKey(sourceId, 'sourceId');
      const existing = this.state.sources[normalized];
      if (!existing) {
        const error = new Error('Skill source was not found');
        error.statusCode = 404;
        throw error;
      }
      const timestamp = this.now();
      const next = clone(this.state);
      next.sources[normalized] = {
        ...next.sources[normalized],
        lastError: cleanText(message, 4096, 'Skill source refresh failed'),
        updatedAt: timestamp,
      };
      this.commit(next);
      return clone(next.sources[normalized]);
    });
  }

  updateSourceAutomation(sourceId, input = {}) {
    return this.enqueueMutation(() => {
      this.assertRevision(input.expectedRevision);
      const normalized = requiredObjectKey(sourceId, 'sourceId');
      const existing = this.state.sources[normalized];
      if (!existing) {
        const error = new Error('Skill source was not found');
        error.statusCode = 404;
        throw error;
      }
      if (existing.kind !== 'github') {
        const error = new Error('Only GitHub Skill sources support automation');
        error.statusCode = 409;
        throw error;
      }
      const refreshPolicy = cleanText(input.refreshPolicy, 40, existing.refreshPolicy || 'manual').toLowerCase();
      const rolloutPolicy = cleanText(input.rolloutPolicy, 40, existing.rolloutPolicy || 'manual').toLowerCase();
      if (!SOURCE_REFRESH_POLICIES.has(refreshPolicy)) {
        throw new Error('refreshPolicy must be manual, hourly, daily, or weekly');
      }
      if (!SOURCE_ROLLOUT_POLICIES.has(rolloutPolicy)) {
        throw new Error('rolloutPolicy must be manual or enabled-hosts');
      }
      if (refreshPolicy === existing.refreshPolicy && rolloutPolicy === existing.rolloutPolicy) {
        return clone({ source: existing, revision: this.state.revision, idempotent: true });
      }
      const timestamp = this.now();
      const next = clone(this.state);
      next.sources[normalized] = {
        ...next.sources[normalized],
        refreshPolicy,
        rolloutPolicy,
        updatedAt: timestamp,
      };
      this.commit(next);
      return clone({ source: next.sources[normalized], revision: next.revision, idempotent: false });
    });
  }

  retireSkill(skillId, options = {}) {
    return this.enqueueMutation(() => {
      this.assertRevision(options.expectedRevision);
      const normalized = normalizeSkillId(skillId);
      const existing = this.state.library[normalized];
      if (!existing) {
        const error = new Error('Library Skill was not found');
        error.statusCode = 404;
        throw error;
      }
      if (existing.archived === true) {
        return clone({
          libraryRecord: existing,
          revision: this.state.revision,
          idempotent: true,
        });
      }
      const timestamp = this.now();
      const next = clone(this.state);
      next.library[normalized] = {
        ...next.library[normalized],
        archived: true,
        retiredAt: timestamp,
        updatedAt: timestamp,
      };
      this.commit(next);
      return clone({
        libraryRecord: next.library[normalized],
        revision: next.revision,
        idempotent: false,
      });
    });
  }

  restoreSkill(skillId, options = {}) {
    return this.enqueueMutation(() => {
      this.assertRevision(options.expectedRevision);
      const normalized = normalizeSkillId(skillId);
      const existing = this.state.library[normalized];
      if (!existing) {
        const error = new Error('Library Skill was not found');
        error.statusCode = 404;
        throw error;
      }
      if (existing.archived !== true) {
        return clone({
          libraryRecord: existing,
          revision: this.state.revision,
          idempotent: true,
        });
      }
      const availableArtifactIds = existing.artifactIds.filter((artifactId) => (
        this.state.artifacts[artifactId]?.storageState === 'available'
      ));
      if (!availableArtifactIds.length) {
        const error = new Error('Retired Library Skill has no available Artifact to restore');
        error.statusCode = 409;
        throw error;
      }
      const timestamp = this.now();
      const next = clone(this.state);
      const availableArtifactSet = new Set(availableArtifactIds);
      const availableVersions = next.library[normalized].versions.filter((version) => (
        availableArtifactSet.has(version.artifactId)
      ));
      next.library[normalized] = {
        ...next.library[normalized],
        artifactIds: availableArtifactIds,
        versions: availableVersions,
        latestArtifactId: availableArtifactSet.has(next.library[normalized].latestArtifactId)
          ? next.library[normalized].latestArtifactId
          : (availableVersions[availableVersions.length - 1]?.artifactId || null),
        archived: false,
        retiredAt: null,
        updatedAt: timestamp,
      };
      this.commit(next);
      return clone({
        libraryRecord: next.library[normalized],
        revision: next.revision,
        idempotent: false,
      });
    });
  }

  normalizeReferences(rawReferences) {
    const references = [];
    for (const input of Array.isArray(rawReferences) ? rawReferences : []) {
      if (!isRecord(input)) {
        throw new Error('Artifact reference must be an object');
      }
      const kind = requiredText(input.kind, 'Artifact reference kind', 80);
      const skillId = input.skillId == null ? null : normalizeSkillId(input.skillId);
      const artifactId = input.artifactId == null
        ? null
        : normalizeHash(input.artifactId, 'artifactId');
      if (!artifactId && !skillId) {
        throw new Error('Artifact reference requires artifactId or skillId');
      }
      const base = {
        ...clone(input),
        kind,
        skillId,
      };
      if (artifactId) {
        references.push({ ...base, artifactId });
        continue;
      }
      for (const artifact of Object.values(this.state.artifacts)) {
        if (artifact.skillIds.includes(skillId)) {
          references.push({ ...base, artifactId: artifact.artifactId });
        }
      }
    }
    return deduplicateReferences(references);
  }

  referenceReport(options = {}) {
    const requested = options.artifactIds == null
      ? Object.keys(this.state.artifacts)
      : Array.from(new Set(options.artifactIds.map((artifactId) => (
        normalizeHash(artifactId, 'artifactId')
      ))));
    requested.sort();
    const references = this.normalizeReferences(options.references);
    for (const library of Object.values(this.state.library)) {
      if (library.archived === true) {
        continue;
      }
      for (const artifactId of library.artifactIds) {
        references.push({
          kind: 'active-library',
          artifactId,
          skillId: library.skillId,
          state: 'active',
        });
      }
    }
    const normalizedReferences = deduplicateReferences(references);
    const artifacts = requested.map((artifactId) => {
      const artifact = this.state.artifacts[artifactId] || null;
      const blockers = normalizedReferences.filter((reference) => (
        reference.artifactId === artifactId
      ));
      return {
        artifactId,
        storageState: artifact?.storageState || 'missing',
        collectible: Boolean(
          artifact
          && artifact.storageState !== 'collected'
          && blockers.length === 0
        ),
        blockers,
      };
    });
    return clone({
      revision: this.state.revision,
      artifacts,
      blockers: artifacts.flatMap((artifact) => artifact.blockers).sort(compareReferences),
      collectibleArtifactIds: artifacts
        .filter((artifact) => artifact.collectible)
        .map((artifact) => artifact.artifactId),
    });
  }

  pruneRetiredVersionLinks(nextState, artifactIds) {
    const removed = new Set(artifactIds);
    for (const [skillId, library] of Object.entries(nextState.library)) {
      if (library.archived !== true) {
        continue;
      }
      const versions = library.versions.filter((version) => !removed.has(version.artifactId));
      const retainedArtifactIds = library.artifactIds.filter((artifactId) => !removed.has(artifactId));
      if (
        versions.length === library.versions.length
        && retainedArtifactIds.length === library.artifactIds.length
      ) {
        continue;
      }
      nextState.library[skillId] = {
        ...library,
        versions,
        artifactIds: retainedArtifactIds,
        latestArtifactId: retainedArtifactIds.includes(library.latestArtifactId)
          ? library.latestArtifactId
          : (versions[versions.length - 1]?.artifactId || null),
        updatedAt: this.now(),
      };
    }
  }

  collectedArtifactRecord(artifact, timestamp) {
    return {
      ...artifact,
      archiveBytes: 0,
      manifest: null,
      storageState: 'collected',
      collectedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  collectGarbage(options = {}) {
    return this.enqueueMutation(async () => {
      this.assertRevision(options.expectedRevision);
      const references = typeof options.referenceProvider === 'function'
        ? options.referenceProvider()
        : options.references;
      const report = this.referenceReport({
        artifactIds: options.artifactIds,
        references,
      });
      const blockedArtifactIds = report.artifacts
        .filter((artifact) => artifact.blockers.length > 0)
        .map((artifact) => artifact.artifactId);
      const collectibleArtifactIds = report.collectibleArtifactIds;
      if (!collectibleArtifactIds.length || (options.requireAllUnreferenced && blockedArtifactIds.length)) {
        return clone({
          revision: this.state.revision,
          collectedArtifactIds: [],
          pendingArtifactIds: [],
          blockedArtifactIds,
          blockers: report.blockers,
          errors: [],
        });
      }

      const pendingState = clone(this.state);
      const pendingTimestamp = this.now();
      let pendingChanged = false;
      for (const artifactId of collectibleArtifactIds) {
        const artifact = pendingState.artifacts[artifactId];
        if (artifact.storageState === 'available') {
          pendingState.artifacts[artifactId] = {
            ...artifact,
            storageState: 'gc-pending',
            gcRequestedAt: pendingTimestamp,
            collectedAt: null,
            updatedAt: pendingTimestamp,
          };
          pendingChanged = true;
        }
      }
      this.pruneRetiredVersionLinks(pendingState, collectibleArtifactIds);
      if (
        pendingChanged
        || JSON.stringify(pendingState.library) !== JSON.stringify(this.state.library)
      ) {
        this.commit(pendingState);
      }

      const collectedArtifactIds = [];
      const errors = [];
      for (const artifactId of collectibleArtifactIds) {
        try {
          await this.unlinkArchive(this.artifactPath(artifactId));
          collectedArtifactIds.push(artifactId);
        } catch (error) {
          if (error.code === 'ENOENT') {
            collectedArtifactIds.push(artifactId);
          } else {
            errors.push({
              artifactId,
              code: String(error.code || ''),
              error: cleanText(error.message, 4096, 'Artifact archive unlink failed'),
            });
          }
        }
      }

      if (collectedArtifactIds.length) {
        const collectedState = clone(this.state);
        const collectedTimestamp = this.now();
        for (const artifactId of collectedArtifactIds) {
          collectedState.artifacts[artifactId] = this.collectedArtifactRecord(
            collectedState.artifacts[artifactId],
            collectedTimestamp
          );
        }
        this.commit(collectedState);
      }
      const pendingArtifactIds = collectibleArtifactIds.filter((artifactId) => (
        !collectedArtifactIds.includes(artifactId)
      ));
      return clone({
        revision: this.state.revision,
        collectedArtifactIds: collectedArtifactIds.sort(),
        pendingArtifactIds: pendingArtifactIds.sort(),
        blockedArtifactIds: blockedArtifactIds.sort(),
        blockers: report.blockers,
        errors,
      });
    });
  }
}

module.exports = {
  SOURCE_REFRESH_POLICIES,
  SOURCE_ROLLOUT_POLICIES,
  SkillRegistryService,
};
