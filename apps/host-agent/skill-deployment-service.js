const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const {
  DEFAULT_MAX_ENTRIES,
  extractSkillArtifactArchive,
  inspectSkillArtifactArchive,
} = require('../../shared/skill-artifact');
const { normalizePortableSkillId } = require('../../shared/skill-id');
const { hashSkillDirectory } = require('../../shared/skill-inventory');

const STATE_VERSION = 1;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_MAX_ARCHIVE_BYTES = 272 * 1024 * 1024;
const MAX_MANAGED_TREE_ENTRIES = DEFAULT_MAX_ENTRIES + 1;
const ACTIVATION_STAGING_DIR = '.remote-codex-staging';
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function normalizeHash(value, name = 'artifactId') {
  const hash = requiredText(value, name, 96).toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new Error(`${name} must be a sha256 digest`);
  }
  return hash;
}

function normalizeSkillId(value) {
  return normalizePortableSkillId(value);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function activationKeyForPath(scope, activationPath) {
  return JSON.stringify([String(scope || '').trim().toLowerCase(), pathKey(activationPath)]);
}

function emptyState() {
  return { version: STATE_VERSION, activations: {}, pendingResults: {} };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePendingResult(value, expectedHostId = '') {
  if (!isRecord(value)) {
    throw new Error('pending deployment result must be an object');
  }
  const deploymentId = requiredObjectKey(value.deploymentId, 'pending result deploymentId', 240);
  const hostId = requiredText(value.hostId, 'pending result hostId', 160);
  if (expectedHostId && hostId !== expectedHostId) {
    throw new Error('pending deployment result belongs to another Host');
  }
  if (value.type !== 'host.skills.deployment.result') {
    throw new Error('pending deployment result has an invalid type');
  }
  if (typeof value.ok !== 'boolean') {
    throw new Error('pending deployment result ok must be boolean');
  }
  const action = requiredText(value.action, 'pending result action', 40).toLowerCase();
  if (!['enable', 'disable', 'remove'].includes(action) || value.action !== action) {
    throw new Error('pending deployment result action is invalid');
  }
  normalizeSkillId(value.skillId);
  const artifactId = normalizeHash(value.artifactId, 'pending result artifactId');
  if (value.artifactId !== artifactId) {
    throw new Error('pending deployment result artifactId must be normalized');
  }
  const targetScope = requiredText(value.targetScope, 'pending result targetScope', 40).toLowerCase();
  if (!['user', 'project'].includes(targetScope) || value.targetScope !== targetScope) {
    throw new Error('pending deployment result targetScope is invalid');
  }
  requiredText(value.scopeId, 'pending result scopeId');
  if (value.ok) {
    const expectedState = { enable: 'enabled', disable: 'disabled', remove: 'missing' }[action];
    if (String(value.state || '').trim().toLowerCase() !== expectedState) {
      throw new Error(`pending deployment result state must be ${expectedState}`);
    }
    if (action === 'enable' && String(value.observedHash || '').trim().toLowerCase() !== artifactId) {
      throw new Error('pending deployment result observedHash must match artifactId');
    }
  }
  return { deploymentId, event: clone(value) };
}

async function copyDirectoryTree(sourcePath, targetPath) {
  const sourceStats = await fs.promises.lstat(sourcePath);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
    throw new Error('managed Artifact cache must be a physical directory');
  }
  await fs.promises.mkdir(targetPath);
  const entries = await fs.promises.readdir(sourcePath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourceEntry = path.join(sourcePath, entry.name);
    const targetEntry = path.join(targetPath, entry.name);
    const stats = await fs.promises.lstat(sourceEntry);
    if (stats.isSymbolicLink()) {
      throw new Error(`managed Artifact cache contains a link: ${sourceEntry}`);
    }
    if (stats.isDirectory()) {
      await copyDirectoryTree(sourceEntry, targetEntry);
    } else if (stats.isFile()) {
      await fs.promises.copyFile(sourceEntry, targetEntry, fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') {
        await fs.promises.chmod(targetEntry, stats.mode & 0o777);
      }
    } else {
      throw new Error(`managed Artifact cache contains an unsupported entry: ${sourceEntry}`);
    }
  }
}

async function assertWritableDirectoryTree(targetPath, label) {
  const pending = [path.resolve(targetPath)];
  let entryCount = 0;
  while (pending.length) {
    const currentPath = pending.pop();
    entryCount += 1;
    if (entryCount > MAX_MANAGED_TREE_ENTRIES) {
      throw new Error(`${label} exceeds the managed writable-check entry limit`);
    }
    const stats = await fs.promises.lstat(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} contains a link or junction and cannot be managed`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`${label} contains an unsupported entry`);
    }
    try {
      await fs.promises.access(currentPath, fs.constants.W_OK);
    } catch (_) {
      throw new Error(`${label} contains readonly content`);
    }
    if (stats.isDirectory()) {
      const entries = await fs.promises.readdir(currentPath);
      entries.sort().reverse();
      for (const entry of entries) {
        pending.push(path.join(currentPath, entry));
      }
    }
  }
}

function pathIsWithin(boundaryPath, targetPath) {
  const relative = path.relative(path.resolve(boundaryPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertSafeDirectoryAncestry(boundaryPath, targetParentPath, options = {}) {
  const label = options.label || 'Skill activation';
  const boundary = path.resolve(boundaryPath);
  const targetParent = path.resolve(targetParentPath);
  if (!pathIsWithin(boundary, targetParent)) {
    throw new Error(`${label} parent escapes its managed boundary`);
  }
  if (options.create === true) {
    await fs.promises.mkdir(boundary, { recursive: true });
  }

  const relative = path.relative(boundary, targetParent);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = boundary;
  for (const segment of [null, ...segments]) {
    if (segment) {
      current = path.join(current, segment);
    }
    let stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      if (options.create !== true) {
        return;
      }
      await fs.promises.mkdir(current);
      stats = await fs.promises.lstat(current);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} ancestor is a link or junction: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} ancestor is not a directory: ${current}`);
    }
  }

  const realBoundary = await fs.promises.realpath(boundary);
  const realTargetParent = await fs.promises.realpath(targetParent);
  if (!pathIsWithin(realBoundary, realTargetParent)) {
    throw new Error(`${label} ancestor escapes its real managed boundary`);
  }
}

function assertSafeDirectoryAncestrySync(boundaryPath, targetParentPath, options = {}) {
  const label = options.label || 'Skill state';
  const boundary = path.resolve(boundaryPath);
  const targetParent = path.resolve(targetParentPath);
  if (!pathIsWithin(boundary, targetParent)) {
    throw new Error(`${label} parent escapes its managed boundary`);
  }
  if (options.create === true) {
    fs.mkdirSync(boundary, { recursive: true });
  }
  const relative = path.relative(boundary, targetParent);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = boundary;
  for (const segment of [null, ...segments]) {
    if (segment) {
      current = path.join(current, segment);
    }
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      if (options.create !== true) {
        return;
      }
      fs.mkdirSync(current);
      stats = fs.lstatSync(current);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} ancestor is a link or junction: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} ancestor is not a directory: ${current}`);
    }
  }
  const realBoundary = fs.realpathSync.native(boundary);
  const realTargetParent = fs.realpathSync.native(targetParent);
  if (!pathIsWithin(realBoundary, realTargetParent)) {
    throw new Error(`${label} ancestor escapes its real managed boundary`);
  }
}

function downloadArtifactFile(options = {}) {
  const relayUrl = requiredText(options.relayUrl, 'relayUrl');
  const downloadPath = requiredText(options.downloadPath, 'downloadPath');
  if (!downloadPath.startsWith('/api/agent/skills/artifacts/')) {
    throw new Error('downloadPath must be a Relay Skill Artifact API path');
  }
  const target = new URL(downloadPath, relayUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Skill Artifact download requires HTTP or HTTPS');
  }
  const targetPath = path.resolve(requiredText(options.targetPath, 'targetPath'));
  const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_ARCHIVE_BYTES));
  const maxErrorBytes = Math.max(1, Number(options.maxErrorBytes || 64 * 1024));
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let finishing = false;
    let responseStream = null;
    let output = null;
    let outputCreated = false;
    const rejectAfterCleanup = (error) => {
      const finishReject = () => {
        const cleanup = outputCreated
          ? fs.promises.unlink(targetPath).catch((cleanupError) => {
            if (cleanupError.code !== 'ENOENT') {
              error.message = `${error.message}; partial download cleanup failed: ${cleanupError.message}`;
            }
          })
          : Promise.resolve();
        cleanup.finally(() => {
          settled = true;
          reject(error);
        });
      };
      if (output && !output.closed) {
        output.once('close', finishReject);
        output.destroy();
      } else {
        finishReject();
      }
    };
    const fail = (error) => {
      if (settled || finishing) {
        return;
      }
      finishing = true;
      responseStream?.destroy();
      rejectAfterCleanup(error);
    };
    const request = client.request({
      method: 'GET',
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      headers: {
        Accept: 'application/vnd.remote-codex.skill-artifact',
        'X-Remote-Codex-Host-Id': requiredText(options.hostId, 'hostId', 160),
        ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
    }, (response) => {
      responseStream = response;
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
        const chunks = [];
        let errorBytes = 0;
        response.on('data', (chunk) => {
          errorBytes += chunk.length;
          if (errorBytes > maxErrorBytes) {
            fail(new Error(`Relay Artifact download error response exceeds ${maxErrorBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (finishing) {
            return;
          }
          let message = '';
          try {
            message = JSON.parse(Buffer.concat(chunks).toString('utf8')).error || '';
          } catch (_) {
            message = Buffer.concat(chunks).toString('utf8').slice(0, 1000);
          }
          fail(new Error(message || `Relay Artifact download failed with HTTP ${response.statusCode || 0}`));
        });
        response.on('aborted', () => fail(new Error('Relay Artifact error response was aborted')));
        response.on('error', fail);
        return;
      }
      const declaredBytes = Number(response.headers['content-length']);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > maxBytes) {
        fail(new Error('Relay Artifact download has an invalid or oversized Content-Length'));
        return;
      }
      output = fs.createWriteStream(targetPath, { flags: 'wx' });
      let totalBytes = 0;
      let responseEnded = false;
      let outputFinished = false;
      output.on('open', () => {
        outputCreated = true;
      });
      response.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > declaredBytes || totalBytes > maxBytes) {
          fail(new Error('Relay Artifact download exceeds its size limit'));
        }
      });
      response.on('end', () => {
        responseEnded = true;
      });
      response.on('aborted', () => fail(new Error('Relay Artifact download response was aborted')));
      response.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => {
        outputFinished = true;
      });
      output.on('close', () => {
        if (settled || finishing) {
          return;
        }
        if (!responseEnded || !outputFinished || totalBytes !== declaredBytes) {
          fail(new Error(`Relay Artifact download length mismatch: expected ${declaredBytes}, received ${totalBytes}`));
          return;
        }
        settled = true;
        resolve({ archiveBytes: totalBytes });
      });
      response.pipe(output);
    });
    request.setTimeout(Number(options.timeoutMs || 120000), () => {
      const error = new Error('Relay Artifact download timed out');
      fail(error);
      request.destroy(error);
    });
    request.on('error', fail);
    request.end();
  });
}

class HostSkillDeploymentService {
  constructor(options = {}) {
    this.hostId = requiredText(options.hostId, 'hostId', 160);
    this.codexHome = path.resolve(requiredText(options.codexHome, 'codexHome'));
    this.stateRoot = path.resolve(requiredText(options.stateRoot, 'stateRoot'));
    if (!options.inventoryService || typeof options.inventoryService.refresh !== 'function') {
      throw new Error('inventoryService with refresh() is required');
    }
    this.inventoryService = options.inventoryService;
    this.relayUrl = String(options.relayUrl || '');
    this.authToken = String(options.authToken || '');
    this.download = typeof options.download === 'function' ? options.download : downloadArtifactFile;
    this.afterActivate = typeof options.afterActivate === 'function' ? options.afterActivate : async () => {};
    this.now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    this.skillsStateRoot = path.join(this.stateRoot, 'skills');
    this.artifactsRoot = path.join(this.skillsStateRoot, 'artifacts');
    this.statePath = path.join(this.skillsStateRoot, 'state.json');
    assertSafeDirectoryAncestrySync(this.stateRoot, this.artifactsRoot, {
      create: false,
      label: 'Host Skill state cache',
    });
    this.state = this.loadState();
    this.operationQueue = Promise.resolve();
  }

  loadState() {
    let source;
    try {
      source = fs.readFileSync(this.statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return emptyState();
      }
      throw new Error(`failed to read Host Skill managed state: ${error.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new Error(`invalid Host Skill managed state JSON: ${error.message}`);
    }

    try {
      if (!isRecord(parsed) || parsed.version !== STATE_VERSION) {
        throw new Error(`unsupported state version; expected ${STATE_VERSION}`);
      }
      if (!isRecord(parsed.activations)) {
        throw new Error('activations must be an object');
      }
      if (parsed.pendingResults != null && !isRecord(parsed.pendingResults)) {
        throw new Error('pendingResults must be an object');
      }
      const activations = {};
      for (const [storedActivationKey, record] of Object.entries(parsed.activations)) {
        if (!isRecord(record)) {
          throw new Error('activation record must be an object');
        }
        const activationPath = path.resolve(requiredText(record.activationPath, 'activationPath'));
        const hostId = requiredText(record.hostId, 'activation hostId', 160);
        if (hostId !== this.hostId) {
          throw new Error('activation record belongs to another Host');
        }
        if (record.managed !== true) {
          throw new Error('activation record must be managed');
        }
        const scope = requiredText(record.scope, 'scope', 40).toLowerCase();
        if (scope !== 'user' && scope !== 'project') {
          throw new Error('activation scope must be user or project');
        }
        const skillId = normalizeSkillId(record.skillId);
        if (record.skillId !== skillId) {
          throw new Error('activation skillId must use its canonical portable form');
        }
        const artifactId = normalizeHash(record.artifactId);
        const stateName = requiredText(record.state, 'activation state', 40).toLowerCase();
        if (stateName !== 'enabled' && stateName !== 'disabled') {
          throw new Error('activation state must be enabled or disabled');
        }
        let scopeId;
        let cwd = null;
        let expectedActivationPath;
        if (scope === 'user') {
          scopeId = requiredText(record.scopeId, 'activation scopeId');
          if (scopeId !== 'user' || record.cwd != null) {
            throw new Error('user activation scope metadata is invalid');
          }
          expectedActivationPath = path.join(this.codexHome, 'skills', skillId);
        } else {
          scopeId = requiredText(record.scopeId, 'activation scopeId');
          cwd = path.resolve(requiredText(record.cwd, 'activation cwd'));
          if (pathKey(path.resolve(scopeId)) !== pathKey(cwd)) {
            throw new Error('project activation scopeId does not match cwd');
          }
          expectedActivationPath = path.join(cwd, '.agents', 'skills', skillId);
        }
        if (pathKey(activationPath) !== pathKey(expectedActivationPath)) {
          throw new Error('activation path is outside its derived managed boundary');
        }
        const activationKey = activationKeyForPath(scope, expectedActivationPath);
        if (storedActivationKey !== activationKey || (record.activationKey && record.activationKey !== activationKey)) {
          throw new Error('activation record key is not canonical');
        }
        const existing = activations[activationKey];
        if (existing && (
          existing.artifactId !== artifactId
          || existing.state !== stateName
        )) {
          throw new Error(`managed Skill ownership conflicts at ${activationPath}`);
        }
        activations[activationKey] = {
          ...clone(record),
          activationKey,
          activationPath,
          hostId,
          scope,
          scopeId,
          cwd,
          skillId,
          artifactId,
          state: stateName,
        };
      }

      const pendingResults = {};
      for (const [storedDeploymentId, value] of Object.entries(parsed.pendingResults || {})) {
        const normalized = normalizePendingResult(value, this.hostId);
        if (storedDeploymentId !== normalized.deploymentId) {
          throw new Error('pending deployment result key does not match deploymentId');
        }
        pendingResults[normalized.deploymentId] = normalized.event;
      }
      return { version: STATE_VERSION, activations, pendingResults };
    } catch (error) {
      throw new Error(`invalid Host Skill managed state: ${error.message}`);
    }
  }

  saveState(next) {
    assertSafeDirectoryAncestrySync(this.stateRoot, this.skillsStateRoot, {
      create: true,
      label: 'Host Skill managed state',
    });
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify({
        version: STATE_VERSION,
        savedAt: this.now(),
        activations: next.activations,
        pendingResults: next.pendingResults,
      }, null, 2), 'utf8');
      fs.renameSync(tempPath, this.statePath);
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  snapshot() {
    return clone({
      activations: Object.values(this.state.activations).sort((left, right) => (
        String(left.activationKey).localeCompare(String(right.activationKey))
      )),
    });
  }

  getPendingResult(deploymentId) {
    const normalizedDeploymentId = requiredObjectKey(deploymentId, 'deploymentId', 240);
    const event = Object.hasOwn(this.state.pendingResults, normalizedDeploymentId)
      ? this.state.pendingResults[normalizedDeploymentId]
      : null;
    return event ? clone(event) : null;
  }

  stagePendingResult(event) {
    const normalized = normalizePendingResult(event, this.hostId);
    const existing = this.state.pendingResults[normalized.deploymentId];
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(normalized.event)) {
        throw new Error('pending deployment result conflicts with the persisted terminal result');
      }
      return clone(existing);
    }
    const next = clone(this.state);
    next.pendingResults[normalized.deploymentId] = normalized.event;
    this.saveState(next);
    this.state = next;
    return clone(normalized.event);
  }

  clearPendingResult(deploymentId) {
    const normalizedDeploymentId = requiredObjectKey(deploymentId, 'deploymentId', 240);
    if (!Object.hasOwn(this.state.pendingResults, normalizedDeploymentId)) {
      return false;
    }
    const next = clone(this.state);
    delete next.pendingResults[normalizedDeploymentId];
    this.saveState(next);
    this.state = next;
    return true;
  }

  decorateInventorySnapshot(snapshot) {
    const recordsByPath = new Map(
      Object.values(this.state.activations)
        .filter((record) => record?.managed && record?.activationPath)
        .map((record) => [pathKey(record.activationPath), record])
    );
    return {
      ...clone(snapshot),
      instances: (Array.isArray(snapshot?.instances) ? snapshot.instances : []).map((instance) => {
        const record = recordsByPath.get(pathKey(instance.activationPath || instance.realPath || ''));
        if (!record) {
          return { ...instance };
        }
        const observedHash = String(instance.observedHash || '').trim().toLowerCase();
        const stateName = record.state === 'enabled' && observedHash === record.artifactId
          ? 'enabled'
          : record.state === 'enabled' ? 'drifted' : 'conflict';
        return {
          ...instance,
          managed: true,
          enabled: stateName === 'enabled',
          state: stateName,
          desiredArtifactId: record.artifactId,
        };
      }),
    };
  }

  archivePath(artifactId) {
    return path.join(this.artifactsRoot, `${normalizeHash(artifactId).slice(7)}.rcskill`);
  }

  contentPath(artifactId) {
    return path.join(this.artifactsRoot, normalizeHash(artifactId).slice(7), 'content');
  }

  async ensureActivationStagingRoot(activationPath) {
    const stagingRoot = path.join(path.dirname(activationPath), ACTIVATION_STAGING_DIR);
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    const stats = await fs.promises.lstat(stagingRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('managed Skill activation staging root is a link or junction');
    }
    return stagingRoot;
  }

  async assertActivationStagingRootSafe(activationPath) {
    const stagingRoot = path.join(path.dirname(activationPath), ACTIVATION_STAGING_DIR);
    try {
      const stats = await fs.promises.lstat(stagingRoot);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error('managed Skill activation staging root is a link or junction');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  normalizeCommand(input = {}) {
    const deploymentId = requiredText(input.deploymentId, 'deploymentId', 240);
    const action = requiredText(input.action, 'action', 40).toLowerCase();
    if (!['enable', 'disable', 'remove'].includes(action)) {
      throw new Error('deployment action must be enable, disable, or remove');
    }
    const skillId = normalizeSkillId(input.skillId);
    const artifactId = normalizeHash(input.artifactId);
    const expectedHash = normalizeHash(input.expectedHash || artifactId, 'expectedHash');
    if (artifactId !== expectedHash) {
      throw new Error('artifactId and expectedHash must match');
    }
    const targetScope = requiredText(input.targetScope || 'user', 'targetScope', 40).toLowerCase();
    if (targetScope !== 'user' && targetScope !== 'project') {
      throw new Error('targetScope must be user or project');
    }
    let scopeId = 'user';
    let cwd = null;
    let activationPath;
    if (targetScope === 'project') {
      if (input.confirmProjectWrite !== true) {
        throw new Error('project deployment requires confirmProjectWrite confirmation');
      }
      const requestedCwd = requiredText(input.cwd || input.scopeId, 'cwd');
      const requestedScopeId = requiredText(input.scopeId || requestedCwd, 'scopeId');
      cwd = path.resolve(requestedCwd);
      if (pathKey(path.resolve(requestedScopeId)) !== pathKey(cwd)) {
        throw new Error('project deployment scopeId must identify the same path as cwd');
      }
      const knownRoots = typeof this.inventoryService.getWorkspaceRoots === 'function'
        ? this.inventoryService.getWorkspaceRoots()
        : [];
      if (!knownRoots.some((root) => pathKey(root) === pathKey(cwd))) {
        throw new Error('project deployment cwd must be an exact known workspace root');
      }
      const stats = fs.statSync(cwd);
      if (!stats.isDirectory()) {
        throw new Error('project deployment cwd is not a directory');
      }
      scopeId = requestedScopeId;
      activationPath = path.join(cwd, '.agents', 'skills', skillId);
    } else {
      activationPath = path.join(this.codexHome, 'skills', skillId);
    }
    const activationKey = activationKeyForPath(targetScope, activationPath);
    return {
      deploymentId,
      action,
      skillId,
      artifactId,
      expectedHash,
      downloadPath: input.downloadPath ? requiredText(input.downloadPath, 'downloadPath') : null,
      targetScope,
      scopeId,
      cwd,
      activationPath,
      activationKey,
    };
  }

  applyDeployment(command) {
    const operation = this.operationQueue.then(() => this.performDeployment(command));
    this.operationQueue = operation.catch(() => {});
    return operation;
  }

  async inspectDirectory(targetPath, label) {
    try {
      const stats = await fs.promises.lstat(targetPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`${label} is a link or junction and cannot be managed`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`${label} is not a directory`);
      }
      return await hashSkillDirectory(targetPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async ensureArtifact(command) {
    await assertSafeDirectoryAncestry(this.stateRoot, this.artifactsRoot, {
      create: true,
      label: 'Host Skill state cache',
    });
    const contentPath = this.contentPath(command.artifactId);
    const archivePath = this.archivePath(command.artifactId);
    const cachedContent = await this.inspectDirectory(contentPath, 'managed Artifact cache');
    if (cachedContent) {
      if (cachedContent.hash !== command.artifactId) {
        throw new Error('managed Artifact cache hash is corrupt');
      }
      return { archivePath, contentPath, cached: true };
    }

    await fs.promises.mkdir(this.artifactsRoot, { recursive: true });
    const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    const tempArchive = path.join(this.artifactsRoot, `.download-${token}.rcskill`);
    const tempContent = path.join(this.artifactsRoot, `.extract-${token}`);
    let sourceArchive = archivePath;
    try {
      try {
        const existingArchive = await inspectSkillArtifactArchive(archivePath);
        if (existingArchive.contentHash !== command.artifactId) {
          throw new Error('managed Artifact archive cache hash is corrupt');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        if (!command.downloadPath) {
          throw new Error('downloadPath is required when the Artifact is not cached');
        }
        sourceArchive = tempArchive;
        await this.download({
          relayUrl: this.relayUrl,
          authToken: this.authToken,
          hostId: this.hostId,
          artifactId: command.artifactId,
          expectedHash: command.expectedHash,
          downloadPath: command.downloadPath,
          targetPath: tempArchive,
        });
        const downloaded = await inspectSkillArtifactArchive(tempArchive);
        if (downloaded.contentHash !== command.expectedHash) {
          throw new Error(`downloaded Artifact hash does not match expected hash ${command.expectedHash}`);
        }
      }

      await extractSkillArtifactArchive(sourceArchive, tempContent, {
        expectedHash: command.expectedHash,
      });
      await fs.promises.mkdir(path.dirname(contentPath), { recursive: true });
      try {
        await fs.promises.rename(tempContent, contentPath);
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') {
          throw error;
        }
        const concurrent = await this.inspectDirectory(contentPath, 'managed Artifact cache');
        if (!concurrent || concurrent.hash !== command.artifactId) {
          throw new Error('concurrent managed Artifact cache publication conflicts with desired hash');
        }
      }
      if (sourceArchive === tempArchive) {
        try {
          await fs.promises.rename(tempArchive, archivePath);
        } catch (error) {
          if (error.code !== 'EEXIST') {
            throw error;
          }
        }
      }
      return { archivePath, contentPath, cached: false };
    } finally {
      await fs.promises.rm(tempContent, { recursive: true, force: true }).catch(() => {});
      await fs.promises.unlink(tempArchive).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }

  async cacheVerifiedActivation(command) {
    await assertSafeDirectoryAncestry(this.stateRoot, this.artifactsRoot, {
      create: true,
      label: 'Host Skill state cache',
    });
    const contentPath = this.contentPath(command.artifactId);
    const cachedContent = await this.inspectDirectory(contentPath, 'managed Artifact cache');
    if (cachedContent) {
      if (cachedContent.hash !== command.artifactId) {
        throw new Error('managed Artifact cache hash is corrupt');
      }
      return { cached: true, contentPath };
    }

    await fs.promises.mkdir(this.artifactsRoot, { recursive: true });
    const tempContent = path.join(
      this.artifactsRoot,
      `.adopt-${process.pid}.${crypto.randomBytes(8).toString('hex')}`
    );
    try {
      await copyDirectoryTree(command.activationPath, tempContent);
      const copied = await hashSkillDirectory(tempContent);
      if (copied.hash !== command.artifactId) {
        throw new Error('adopted Skill content changed while publishing its local Artifact cache');
      }
      await fs.promises.mkdir(path.dirname(contentPath), { recursive: true });
      try {
        await fs.promises.rename(tempContent, contentPath);
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') {
          throw error;
        }
        const concurrent = await this.inspectDirectory(contentPath, 'managed Artifact cache');
        if (!concurrent || concurrent.hash !== command.artifactId) {
          throw new Error('concurrent managed Artifact cache publication conflicts with adopted hash');
        }
      }
      return { cached: false, contentPath };
    } finally {
      await fs.promises.rm(tempContent, { recursive: true, force: true }).catch(() => {});
    }
  }

  async cleanupUnreferencedArtifactCaches() {
    await assertSafeDirectoryAncestry(this.stateRoot, this.artifactsRoot, {
      create: false,
      label: 'Host Skill state cache',
    });
    let entries;
    try {
      entries = await fs.promises.readdir(this.artifactsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    const referenced = new Set(
      Object.values(this.state.activations).map((record) => record?.artifactId).filter(Boolean)
    );
    for (const entry of entries) {
      const directoryMatch = entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)
        ? `sha256:${entry.name}`
        : null;
      const archiveMatch = entry.isFile() && /^([a-f0-9]{64})\.rcskill$/.exec(entry.name);
      const artifactId = directoryMatch || (archiveMatch ? `sha256:${archiveMatch[1]}` : null);
      if (!artifactId || referenced.has(artifactId)) {
        continue;
      }
      const targetPath = path.join(this.artifactsRoot, entry.name);
      if (entry.isDirectory()) {
        await fs.promises.rm(targetPath, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(targetPath).catch((error) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        });
      }
    }
  }

  activationRecord(command, stateName) {
    return {
      activationKey: command.activationKey,
      hostId: this.hostId,
      skillId: command.skillId,
      artifactId: command.artifactId,
      scope: command.targetScope,
      scopeId: command.scopeId,
      cwd: command.cwd,
      activationPath: command.activationPath,
      state: stateName,
      managed: true,
      updatedAt: this.now(),
    };
  }

  async enable(command) {
    const currentRecord = this.state.activations[command.activationKey] || null;
    const current = await this.inspectDirectory(command.activationPath, 'Skill activation target');
    if (current?.hash === command.artifactId) {
      const cached = await this.cacheVerifiedActivation(command);
      const next = clone(this.state);
      next.activations[command.activationKey] = this.activationRecord(command, 'enabled');
      this.saveState(next);
      this.state = next;
      return { idempotent: true, cached: cached.cached };
    }
    if (current) {
      if (!currentRecord?.managed) {
        throw new Error('refusing to overwrite unmanaged Skill activation conflict');
      }
      if (current.hash !== currentRecord.artifactId) {
        throw new Error('managed Skill activation drifted from its recorded hash');
      }
      await assertWritableDirectoryTree(command.activationPath, 'managed Skill activation');
    }

    await this.assertActivationStagingRootSafe(command.activationPath);
    const cached = await this.ensureArtifact(command);

    await fs.promises.mkdir(path.dirname(command.activationPath), { recursive: true });
    const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    const stagingRoot = await this.ensureActivationStagingRoot(command.activationPath);
    const stagePath = path.join(stagingRoot, `${command.skillId}.stage-${token}`);
    const backupPath = path.join(stagingRoot, `${command.skillId}.backup-${token}`);
    let movedCurrent = false;
    let activated = false;
    try {
      await copyDirectoryTree(cached.contentPath, stagePath);
      const staged = await hashSkillDirectory(stagePath);
      if (staged.hash !== command.artifactId) {
        throw new Error('staged Skill activation hash does not match desired Artifact');
      }
      if (current) {
        await fs.promises.rename(command.activationPath, backupPath);
        movedCurrent = true;
      }
      await fs.promises.rename(stagePath, command.activationPath);
      activated = true;
      await this.afterActivate({
        deploymentId: command.deploymentId,
        artifactId: command.artifactId,
        activationPath: command.activationPath,
      });
      const observed = await hashSkillDirectory(command.activationPath);
      if (observed.hash !== command.artifactId) {
        throw new Error('activated Skill hash does not match desired Artifact');
      }
      const next = clone(this.state);
      next.activations[command.activationKey] = this.activationRecord(command, 'enabled');
      this.saveState(next);
      this.state = next;
    } catch (error) {
      let displacedPath = null;
      let rollbackFailure = null;
      if (activated) {
        try {
          await fs.promises.rm(command.activationPath, { recursive: true, force: true });
        } catch (removeError) {
          displacedPath = path.join(stagingRoot, `${command.skillId}.failed-${token}`);
          try {
            await fs.promises.rename(command.activationPath, displacedPath);
          } catch (displaceError) {
            rollbackFailure = new Error(
              `could not remove or displace failed activation: ${removeError.message}; ${displaceError.message}`
            );
          }
        }
      }
      if (!rollbackFailure && movedCurrent) {
        if (!fs.existsSync(backupPath)) {
          rollbackFailure = new Error('activation backup disappeared during rollback');
        } else {
          try {
            await fs.promises.rename(backupPath, command.activationPath);
          } catch (restoreError) {
            rollbackFailure = new Error(`could not restore activation backup: ${restoreError.message}`);
          }
        }
      }
      if (!rollbackFailure) {
        try {
          const restored = await this.inspectDirectory(command.activationPath, 'rolled back Skill activation');
          if ((current && restored?.hash !== current.hash) || (!current && restored)) {
            rollbackFailure = new Error('rolled back Skill activation does not match its previous state');
          }
        } catch (verifyError) {
          rollbackFailure = verifyError;
        }
      }
      if (displacedPath) {
        await fs.promises.rm(displacedPath, { recursive: true, force: true }).catch(() => {});
      }
      if (rollbackFailure) {
        const combined = new Error(`${error.message}; activation rollback failed: ${rollbackFailure.message}`);
        combined.cause = error;
        throw combined;
      }
      throw error;
    } finally {
      await fs.promises.rm(stagePath, { recursive: true, force: true }).catch(() => {});
    }
    await fs.promises.rm(backupPath, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rmdir(stagingRoot).catch(() => {});
    return { idempotent: false, cached: cached.cached };
  }

  async deactivate(command) {
    const currentRecord = this.state.activations[command.activationKey] || null;
    if (currentRecord && currentRecord.artifactId !== command.artifactId) {
      throw new Error('deployment Artifact does not match the managed Skill activation');
    }
    const current = await this.inspectDirectory(command.activationPath, 'Skill activation target');
    if (current && !currentRecord?.managed) {
      throw new Error('refusing to remove unmanaged Skill activation');
    }
    if (current && current.hash !== currentRecord.artifactId) {
      throw new Error('managed Skill activation drifted from its recorded hash');
    }
    if (current) {
      await assertWritableDirectoryTree(command.activationPath, 'managed Skill activation');
    }

    const next = clone(this.state);
    let stateChanged = false;
    if (command.action === 'remove') {
      if (currentRecord) {
        delete next.activations[command.activationKey];
        stateChanged = true;
      }
    } else if (!currentRecord) {
      next.activations[command.activationKey] = this.activationRecord(command, 'disabled');
      stateChanged = true;
    } else if (currentRecord.state !== 'disabled') {
      next.activations[command.activationKey] = {
        ...currentRecord,
        state: 'disabled',
        updatedAt: this.now(),
      };
      stateChanged = true;
    }

    let tombstonePath = null;
    let stagingRoot = null;
    if (current) {
      stagingRoot = await this.ensureActivationStagingRoot(command.activationPath);
      tombstonePath = path.join(
        stagingRoot,
        `${command.skillId}.disabled-${process.pid}.${crypto.randomBytes(8).toString('hex')}`
      );
      await fs.promises.rename(command.activationPath, tombstonePath);
    }
    try {
      if (stateChanged) {
        this.saveState(next);
        this.state = next;
      }
    } catch (error) {
      if (tombstonePath && fs.existsSync(tombstonePath)) {
        try {
          await fs.promises.rename(tombstonePath, command.activationPath);
          const restored = await this.inspectDirectory(command.activationPath, 'rolled back Skill deactivation');
          if (!current || restored?.hash !== current.hash) {
            throw new Error('rolled back Skill deactivation does not match its previous state');
          }
        } catch (rollbackError) {
          const combined = new Error(`${error.message}; deactivation rollback failed: ${rollbackError.message}`);
          combined.cause = error;
          throw combined;
        }
      }
      throw error;
    }
    if (tombstonePath) {
      await fs.promises.rm(tombstonePath, { recursive: true, force: true }).catch(() => {});
    }
    if (stagingRoot) {
      await fs.promises.rmdir(stagingRoot).catch(() => {});
    }

    if (command.action === 'remove') {
      await assertSafeDirectoryAncestry(this.stateRoot, this.artifactsRoot, {
        create: false,
        label: 'Host Skill state cache',
      });
      const artifactIds = new Set([currentRecord?.artifactId, command.artifactId].filter(Boolean));
      for (const artifactId of artifactIds) {
        const stillReferenced = Object.values(this.state.activations).some((record) => (
          record.artifactId === artifactId
        ));
        if (!stillReferenced) {
          await fs.promises.rm(this.contentPath(artifactId), { recursive: true, force: true });
          await fs.promises.unlink(this.archivePath(artifactId)).catch((error) => {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          });
          await fs.promises.rmdir(path.dirname(this.contentPath(artifactId))).catch(() => {});
        }
      }
    }
    return { idempotent: !current && !stateChanged };
  }

  async performDeployment(rawCommand) {
    const command = this.normalizeCommand(rawCommand);
    await assertSafeDirectoryAncestry(
      command.targetScope === 'project' ? command.cwd : this.codexHome,
      path.dirname(command.activationPath),
      { create: command.action === 'enable' }
    );
    let operation;
    try {
      operation = command.action === 'enable'
        ? await this.enable(command)
        : await this.deactivate(command);
    } catch (error) {
      try {
        await this.cleanupUnreferencedArtifactCaches();
      } catch (cleanupError) {
        error.message = `${error.message}; cache cleanup also failed: ${cleanupError.message}`;
      }
      throw error;
    }
    let cacheCleanupError = '';
    try {
      await this.cleanupUnreferencedArtifactCaches();
    } catch (error) {
      cacheCleanupError = String(error?.message || 'Host Skill Artifact cache cleanup failed').slice(0, 4096);
    }
    let inventoryError = '';
    try {
      if (typeof this.inventoryService.invalidate === 'function') {
        this.inventoryService.invalidate();
      }
    } catch (error) {
      inventoryError = String(error?.message || 'Host Skill inventory invalidation failed').slice(0, 4096);
    }
    const record = this.state.activations[command.activationKey] || null;
    return {
      ok: true,
      deploymentId: command.deploymentId,
      hostId: this.hostId,
      action: command.action,
      skillId: command.skillId,
      artifactId: command.artifactId,
      targetScope: command.targetScope,
      scopeId: command.scopeId,
      activationPath: command.activationPath,
      state: record?.state || 'missing',
      observedHash: record?.state === 'enabled' ? record.artifactId : null,
      idempotent: Boolean(operation.idempotent),
      cached: Boolean(operation.cached),
      cacheCleanupError: cacheCleanupError || null,
      inventoryError: inventoryError || null,
      timestamp: this.now(),
    };
  }
}

module.exports = {
  HostSkillDeploymentService,
  downloadArtifactFile,
};
