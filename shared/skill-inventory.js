const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { captureSkillDirectory } = require('./skill-artifact');

const MAX_DISCOVERY_ENTRIES = 100000;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/').replace(/\\/g, '/');
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveExistingDirectory(directoryPath) {
  const resolvedPath = path.resolve(directoryPath);
  const realPath = await fs.promises.realpath(resolvedPath);
  const stats = await fs.promises.stat(realPath);
  if (!stats.isDirectory()) {
    throw new Error(`not a directory: ${resolvedPath}`);
  }
  return { resolvedPath, realPath };
}

async function readDirectoryEntriesBounded(directoryPath, budget, message) {
  const entries = [];
  const directory = await fs.promises.opendir(directoryPath);
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) {
        break;
      }
      budget.count += 1;
      if (budget.count > budget.max) {
        throw new Error(message || `directory traversal exceeds ${budget.max} entries`);
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch((error) => {
      if (error.code !== 'ERR_DIR_CLOSED') {
        throw error;
      }
    });
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  return entries;
}

async function hashSkillDirectory(skillPath, options = {}) {
  const captured = await captureSkillDirectory(skillPath, options);
  return {
    hash: captured.contentHash,
    fileCount: captured.fileCount,
    totalBytes: captured.totalBytes,
  };
}

function parseSkillMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  let name = '';
  let description = '';
  let enabled;
  if (lines[0] === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === '---') {
        break;
      }
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) {
        continue;
      }
      const key = match[1].toLowerCase();
      const rawValue = match[2].trim();
      const value = rawValue.replace(/^("([\s\S]*)"|'([\s\S]*)')$/, (_, quoted, doubleValue, singleValue) => (
        doubleValue === undefined ? singleValue : doubleValue
      )).trim();
      if (key === 'name') {
        name = value;
      } else if (key === 'description') {
        description = value;
      } else if (key === 'enabled' && /^(true|false)$/i.test(rawValue)) {
        enabled = rawValue.toLowerCase() === 'true';
      }
    }
  }
  const heading = lines.find((line) => /^#\s+/.test(line));
  const result = {
    name: name || (heading ? heading.replace(/^#\s+/, '').trim() : ''),
    description,
  };
  if (typeof enabled === 'boolean') {
    result.enabled = enabled;
  }
  return result;
}

function revisionInstance(instance) {
  return {
    instanceId: String(instance.instanceId || ''),
    hostId: String(instance.hostId || ''),
    skillId: String(instance.skillId || ''),
    name: String(instance.name || ''),
    description: String(instance.description || ''),
    scope: String(instance.scope || ''),
    scopeId: String(instance.scopeId || ''),
    cwd: instance.cwd ? String(instance.cwd) : null,
    sourceId: String(instance.sourceId || ''),
    sourceKind: String(instance.sourceKind || ''),
    sourceLocator: String(instance.sourceLocator || ''),
    sourceRef: instance.sourceRef ? String(instance.sourceRef) : null,
    sourcePath: instance.sourcePath ? String(instance.sourcePath) : null,
    activationPath: String(instance.activationPath || ''),
    realPath: String(instance.realPath || ''),
    observedHash: String(instance.observedHash || ''),
    enabled: instance.enabled !== false,
    effective: typeof instance.effective === 'boolean' ? instance.effective : null,
    managed: Boolean(instance.managed),
    readonly: Boolean(instance.readonly),
    state: String(instance.state || ''),
  };
}

function computeSkillInventoryRevision(instances) {
  const normalized = (Array.isArray(instances) ? instances : [])
    .map(revisionInstance)
    .map((instance) => ({ instance, serialized: JSON.stringify(instance) }))
    .sort((left, right) => (
      compareText(left.instance.instanceId, right.instance.instanceId)
      || compareText(left.serialized, right.serialized)
    ))
    .map((entry) => entry.instance);
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

function makeScanError(descriptor, message, targetPath = null) {
  return {
    scope: descriptor.scope,
    scopeId: descriptor.scopeId,
    rootPath: descriptor.rootPath,
    path: targetPath || descriptor.rootPath,
    message: String(message || 'skill inventory scan failed'),
  };
}

async function canonicalPath(inputPath) {
  const resolved = path.resolve(inputPath);
  try {
    return await fs.promises.realpath(resolved);
  } catch (_) {
    return resolved;
  }
}

async function readUtf8FileBounded(filePath, maxBytes, rootRealPath) {
  const realPath = await fs.promises.realpath(filePath);
  if (rootRealPath && !isPathInside(rootRealPath, realPath)) {
    throw new Error(`file resolves outside configured root: ${filePath}`);
  }
  const beforeOpen = await fs.promises.stat(realPath);
  if (!beforeOpen.isFile()) {
    throw new Error(`not a regular file: ${filePath}`);
  }
  if (beforeOpen.size > maxBytes) {
    throw new Error(`file exceeds ${maxBytes} bytes: ${filePath}`);
  }

  const handle = await fs.promises.open(
    realPath,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== beforeOpen.size) {
      throw new Error(`file changed while reading: ${filePath}`);
    }
    const chunks = [];
    let position = 0;
    while (position < stats.size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stats.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) {
        throw new Error(`file changed while reading: ${filePath}`);
      }
      chunks.push(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(growthProbe, 0, 1, stats.size);
    if (extraBytes) {
      throw new Error(`file changed while reading: ${filePath}`);
    }
    return Buffer.concat(chunks, stats.size).toString('utf8');
  } finally {
    await handle.close();
  }
}

function normalizeSourcePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error('skillPath must be a relative path');
  }
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('skillPath must not traverse outside its source');
  }
  if (path.posix.basename(normalized) !== 'SKILL.md') {
    throw new Error('skillPath must end in SKILL.md');
  }
  return normalized;
}

async function loadWorkspaceLock(workspacePath, descriptor, scanErrors) {
  const lockPath = path.join(workspacePath, 'skills-lock.json');
  try {
    const raw = await readUtf8FileBounded(lockPath, 4 * 1024 * 1024, descriptor.workspacePath);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('skills-lock.json must contain an object');
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'skills')) {
      return {};
    }
    if (!parsed.skills || typeof parsed.skills !== 'object' || Array.isArray(parsed.skills)) {
      throw new Error('skills-lock.json skills must be an object');
    }
    const skills = {};
    for (const [skillId, entry] of Object.entries(parsed.skills)) {
      try {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('entry must be an object');
        }
        const sourceType = String(entry.sourceType || '').trim().toLowerCase();
        if (sourceType === 'github') {
          const source = String(entry.source || '').trim();
          if (!source) {
            throw new Error('GitHub entry requires source');
          }
          const skillPath = normalizeSourcePath(entry.skillPath);
          skills[skillId] = { ...entry, source, sourceType, skillPath };
        } else {
          skills[skillId] = { ...entry, sourceType };
        }
      } catch (error) {
        scanErrors.push(makeScanError(
          descriptor,
          `invalid skills-lock.json entry ${skillId}: ${error.message}`,
          lockPath
        ));
      }
    }
    return skills;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    scanErrors.push(makeScanError(descriptor, `invalid skills-lock.json: ${error.message}`, lockPath));
    return {};
  }
}

function parseGithubRemoteLocator(value) {
  const remote = String(value || '').trim();
  let match = remote.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) {
    match = remote.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!match) {
    match = remote.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!match) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  return `${owner}/${repo}`;
}

function parseGitOrigin(config) {
  let section = '';
  for (const rawLine of String(config || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sectionMatch = line.match(/^\[\s*([^\]]+)\s*\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section === 'remote "origin"') {
      const urlMatch = line.match(/^url\s*=\s*(.+)$/i);
      if (urlMatch) {
        return parseGithubRemoteLocator(urlMatch[1]);
      }
    }
  }
  return null;
}

function parseGitHead(value) {
  const head = String(value || '').trim();
  const branch = head.match(/^ref:\s+refs\/heads\/(.+)$/i);
  const branchName = branch?.[1] || '';
  if (
    /^[A-Za-z0-9._/-]+$/.test(branchName)
    && !branchName.startsWith('/')
    && !branchName.endsWith('/')
    && !branchName.includes('//')
    && !branchName.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return branchName;
  }
  return /^[a-f0-9]{40,64}$/i.test(head) ? head.toLowerCase() : 'HEAD';
}

async function inferGithubSourceFromGit(descriptor, realPath) {
  const boundaryInput = descriptor.workspacePath || path.dirname(descriptor.rootPath);
  let boundary;
  let current;
  try {
    boundary = await fs.promises.realpath(boundaryInput);
    current = await fs.promises.realpath(realPath);
  } catch (_) {
    return null;
  }
  if (!isPathInside(boundary, current)) {
    return null;
  }
  while (isPathInside(boundary, current)) {
    const gitPath = path.join(current, '.git');
    try {
      const gitStats = await fs.promises.lstat(gitPath);
      if (gitStats.isDirectory()) {
        const config = await readUtf8FileBounded(path.join(gitPath, 'config'), 1024 * 1024, gitPath);
        const locator = parseGitOrigin(config);
        if (!locator) {
          return null;
        }
        const head = await readUtf8FileBounded(path.join(gitPath, 'HEAD'), 64 * 1024, gitPath);
        const sourceRef = parseGitHead(head);
        const relativeSkillPath = toPosixPath(path.relative(current, realPath));
        if (!relativeSkillPath || relativeSkillPath === '..' || relativeSkillPath.startsWith('../')) {
          return null;
        }
        const sourcePath = `${relativeSkillPath}/SKILL.md`;
        return {
          sourceId: `github:${locator}:${sourceRef}:${sourcePath}`,
          sourceKind: 'github',
          sourceLocator: locator,
          sourceRef,
          sourcePath,
        };
      }
      return null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return null;
      }
    }
    if (current === boundary) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

async function inferSource(descriptor, skillId, activationPath, realPath, lockEntry) {
  const sourcePath = String(lockEntry?.skillPath || '');
  const sourceKind = String(lockEntry?.sourceType || '').trim().toLowerCase();
  const sourceLocator = String(lockEntry?.source || '').trim();
  if (
    descriptor.scope === 'project'
    && sourceKind === 'github'
    && sourceLocator
    && path.posix.basename(sourcePath) === 'SKILL.md'
  ) {
    const sourceRef = String(lockEntry?.ref || 'main').trim() || 'main';
    return {
      sourceId: `github:${sourceLocator}:${sourceRef}:${sourcePath}`,
      sourceKind: 'github',
      sourceLocator,
      sourceRef,
      sourcePath,
    };
  }

  const kind = descriptor.sourceKind;
  if (kind === 'cc-switch' || kind === 'plugin' || kind === 'system') {
    const locator = path.resolve(activationPath);
    return {
      sourceId: `${kind}:${descriptor.hostId}:${toPosixPath(locator)}`,
      sourceKind: kind,
      sourceLocator: locator,
      sourceRef: null,
      sourcePath: null,
    };
  }
  const gitSource = await inferGithubSourceFromGit(descriptor, realPath);
  if (gitSource) {
    return gitSource;
  }
  const locator = path.resolve(activationPath);
  return {
    sourceId: `${kind}:${descriptor.hostId}:${toPosixPath(locator)}`,
    sourceKind: kind,
    sourceLocator: locator,
    sourceRef: null,
    sourcePath: null,
  };
}

function isPathInsideAny(allowedRoots, candidatePath) {
  return allowedRoots.some((rootPath) => isPathInside(rootPath, candidatePath));
}

async function resolveSkillCandidate(candidatePath, allowedRealRoots) {
  const realPath = await fs.promises.realpath(candidatePath);
  if (!isPathInsideAny(allowedRealRoots, realPath)) {
    throw new Error(`linked path resolves outside configured root: ${candidatePath}`);
  }
  const targetStats = await fs.promises.stat(realPath);
  return targetStats.isDirectory() ? realPath : null;
}

async function findSkillDirectories(descriptor, scanErrors, allowedRealRoots, discoveryBudget) {
  let root;
  try {
    root = await resolveExistingDirectory(descriptor.rootPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    scanErrors.push(makeScanError(descriptor, error.message));
    return [];
  }

  if (!allowedRealRoots.length || !isPathInsideAny(allowedRealRoots, root.realPath)) {
    scanErrors.push(makeScanError(descriptor, `root resolves outside configured roots: ${descriptor.rootPath}`));
    return [];
  }

  const found = [];
  async function inspectLevel(scanParentPath, activationParentPath, depth) {
    let entries;
    try {
      entries = await readDirectoryEntriesBounded(
        scanParentPath,
        discoveryBudget,
        `skill discovery contains more than ${discoveryBudget.max} filesystem entries`
      );
    } catch (error) {
      scanErrors.push(makeScanError(descriptor, error.message, activationParentPath));
      return;
    }
    for (const entry of entries) {
      if (depth === 0 && descriptor.excludedNames?.has(entry.name)) {
        continue;
      }
      const scanCandidatePath = path.join(scanParentPath, entry.name);
      const activationCandidatePath = path.join(activationParentPath, entry.name);
      let realPath;
      try {
        realPath = await resolveSkillCandidate(scanCandidatePath, allowedRealRoots);
      } catch (error) {
        scanErrors.push(makeScanError(descriptor, error.message, activationCandidatePath));
        continue;
      }
      if (!realPath) {
        continue;
      }
      try {
        const markdownStats = await fs.promises.lstat(path.join(realPath, 'SKILL.md'));
        if (markdownStats.isFile() || markdownStats.isSymbolicLink()) {
          found.push({ activationPath: path.resolve(activationCandidatePath), realPath });
          continue;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          scanErrors.push(makeScanError(descriptor, error.message, activationCandidatePath));
          continue;
        }
      }
      if (descriptor.allowNested && depth === 0) {
        await inspectLevel(realPath, activationCandidatePath, 1);
      }
    }
  }

  await inspectLevel(root.realPath, root.resolvedPath, 0);
  return found;
}

async function makeRootDescriptors(options) {
  const hostId = String(options.hostId || '').trim();
  if (!hostId) {
    throw new Error('hostId is required');
  }
  const descriptors = [];
  const allowedRootPaths = [];
  const addAllowedRoot = (value) => {
    if (value) {
      allowedRootPaths.push(path.resolve(value));
    }
  };
  if (options.codexHome) {
    const codexHome = path.resolve(options.codexHome);
    addAllowedRoot(codexHome);
    descriptors.push({
      hostId,
      rootPath: path.join(codexHome, 'skills'),
      scope: 'user',
      scopeId: 'user',
      cwd: null,
      readonly: false,
      sourceKind: 'local-host',
      excludedNames: new Set(['.system']),
    });
    descriptors.push({
      hostId,
      rootPath: path.join(codexHome, 'skills', '.system'),
      scope: 'system',
      scopeId: 'system',
      cwd: null,
      readonly: true,
      sourceKind: 'system',
    });
  }

  const seenWorkspaces = new Set();
  for (const rawWorkspace of Array.isArray(options.workspaceRoots) ? options.workspaceRoots : []) {
    if (!rawWorkspace) {
      continue;
    }
    const workspace = await canonicalPath(rawWorkspace);
    const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
    if (seenWorkspaces.has(key)) {
      continue;
    }
    seenWorkspaces.add(key);
    addAllowedRoot(workspace);
    descriptors.push({
      hostId,
      rootPath: path.join(workspace, '.agents', 'skills'),
      workspacePath: workspace,
      scope: 'project',
      scopeId: workspace,
      cwd: workspace,
      readonly: false,
      sourceKind: 'local-host',
    });
  }

  if (options.agentsHome) {
    addAllowedRoot(options.agentsHome);
    descriptors.push({
      hostId,
      rootPath: path.join(path.resolve(options.agentsHome), 'skills'),
      scope: 'shared',
      scopeId: 'shared',
      cwd: null,
      readonly: false,
      sourceKind: 'local-host',
      allowNested: true,
    });
  }
  if (options.ccSwitchHome) {
    addAllowedRoot(options.ccSwitchHome);
    descriptors.push({
      hostId,
      rootPath: path.join(path.resolve(options.ccSwitchHome), 'skills'),
      scope: 'cc-switch',
      scopeId: 'cc-switch',
      cwd: null,
      readonly: false,
      sourceKind: 'cc-switch',
    });
  }

  const seenPluginRoots = new Set();
  for (const rawRoot of Array.isArray(options.pluginRoots) ? options.pluginRoots : []) {
    if (!rawRoot) {
      continue;
    }
    const pluginRoot = path.resolve(rawRoot);
    const key = process.platform === 'win32' ? pluginRoot.toLowerCase() : pluginRoot;
    if (seenPluginRoots.has(key)) {
      continue;
    }
    seenPluginRoots.add(key);
    addAllowedRoot(pluginRoot);
    descriptors.push({
      hostId,
      rootPath: pluginRoot,
      scope: 'plugin',
      scopeId: pluginRoot,
      cwd: null,
      readonly: true,
      sourceKind: 'plugin',
    });
  }
  return {
    descriptors,
    allowedRootPaths: Array.from(new Set(allowedRootPaths)),
  };
}

async function resolveAllowedRealRoots(allowedRootPaths) {
  const roots = [];
  const seen = new Set();
  for (const allowedPath of allowedRootPaths) {
    try {
      const allowed = await resolveExistingDirectory(allowedPath);
      const key = process.platform === 'win32' ? allowed.realPath.toLowerCase() : allowed.realPath;
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(allowed.realPath);
      }
    } catch (_) {
      // A missing configured root contributes no link boundary until it exists.
    }
  }
  return roots;
}

async function discoverSkillInventory(options = {}) {
  const { descriptors, allowedRootPaths } = await makeRootDescriptors(options);
  const allowedRealRoots = await resolveAllowedRealRoots(allowedRootPaths);
  const scannedAt = options.scannedAt || new Date().toISOString();
  const scanErrors = [];
  const instances = [];
  const discoveryBudget = {
    count: 0,
    max: Number.isFinite(options.maxDiscoveryEntries)
      ? options.maxDiscoveryEntries
      : MAX_DISCOVERY_ENTRIES,
  };

  for (const descriptor of descriptors) {
    const workspaceLock = descriptor.scope === 'project'
      ? await loadWorkspaceLock(descriptor.workspacePath, descriptor, scanErrors)
      : {};
    const candidates = await findSkillDirectories(
      descriptor,
      scanErrors,
      allowedRealRoots,
      discoveryBudget
    );
    for (const candidate of candidates) {
      const skillId = path.basename(candidate.activationPath);
      try {
        const digest = await hashSkillDirectory(candidate.realPath);
        const markdown = await readUtf8FileBounded(
          path.join(candidate.realPath, 'SKILL.md'),
          1024 * 1024,
          candidate.realPath
        );
        const metadata = parseSkillMarkdown(markdown);
        const source = await inferSource(
          descriptor,
          skillId,
          candidate.activationPath,
          candidate.realPath,
          workspaceLock[skillId]
        );
        const enabled = metadata.enabled !== false;
        const instanceId = JSON.stringify([
          descriptor.hostId,
          skillId,
          descriptor.scope,
          descriptor.scopeId,
          source.sourceId,
        ]);
        instances.push({
          instanceId,
          hostId: descriptor.hostId,
          skillId,
          name: metadata.name || skillId,
          description: metadata.description || '',
          scope: descriptor.scope,
          scopeId: descriptor.scopeId,
          cwd: descriptor.cwd,
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          sourceLocator: source.sourceLocator,
          sourceRef: source.sourceRef,
          sourcePath: source.sourcePath,
          activationPath: candidate.activationPath,
          realPath: candidate.realPath,
          observedHash: digest.hash,
          enabled,
          effective: null,
          managed: false,
          readonly: descriptor.readonly,
          state: enabled ? 'enabled' : 'disabled',
        });
      } catch (error) {
        scanErrors.push(makeScanError(descriptor, error.message, candidate.activationPath));
      }
    }
  }

  instances.sort((left, right) => (
    compareText(left.instanceId, right.instanceId)
    || compareText(JSON.stringify(revisionInstance(left)), JSON.stringify(revisionInstance(right)))
  ));
  return {
    revision: computeSkillInventoryRevision(instances),
    scannedAt,
    instances,
    scanErrors,
  };
}

module.exports = {
  computeSkillInventoryRevision,
  discoverSkillInventory,
  hashSkillDirectory,
  parseSkillMarkdown,
};
