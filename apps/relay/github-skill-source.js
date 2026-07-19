const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_FILES = 10000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const GITHUB_CONTENTS_DIRECTORY_LIMIT = 1000;

function positiveLimit(value, fallback, name) {
  if (value == null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeRepositoryPart(value, name) {
  const part = String(value || '').trim().replace(/\.git$/i, '');
  if (!part || !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..') {
    throw new Error(`invalid GitHub ${name}`);
  }
  return part;
}

function normalizeRef(value) {
  const ref = String(value || 'main').trim() || 'main';
  if (
    ref.length > 512
    || !/^[A-Za-z0-9._/-]+$/.test(ref)
    || ref.startsWith('/')
    || ref.endsWith('/')
    || ref.includes('//')
    || ref.split('/').some((part) => part === '..')
  ) {
    throw new Error('invalid GitHub ref');
  }
  return ref;
}

function normalizeSubpath(value) {
  const raw = String(value == null ? '' : value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) {
    return '';
  }
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.includes('\0')) {
    throw new Error('GitHub Skill subpath must be relative');
  }
  let normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('GitHub Skill subpath must not traverse outside the repository');
  }
  if (path.posix.basename(normalized).toLowerCase() === 'skill.md') {
    normalized = path.posix.dirname(normalized);
  }
  return normalized === '.' ? '' : normalized.replace(/\/$/, '');
}

function parseGithubLocator(rawLocator) {
  const locator = String(rawLocator || '').trim();
  if (!locator) {
    throw new Error('GitHub locator is required');
  }
  const sshMatch = locator.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2], ref: null, subpath: null };
  }
  if (/^[^/:\s]+\/[^/\s]+$/.test(locator)) {
    const [owner, repo] = locator.split('/');
    return { owner, repo, ref: null, subpath: null };
  }
  let parsed;
  try {
    parsed = new URL(locator);
  } catch (_) {
    throw new Error('GitHub locator must be owner/repository or a github.com URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('GitHub locator must use https://github.com');
  }
  const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 2) {
    throw new Error('GitHub URL must contain owner and repository');
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (parts.length === 2) {
    return { owner, repo, ref: null, subpath: null };
  }
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    const inferredPath = parts.slice(4).join('/');
    return {
      owner,
      repo,
      ref: parts[3],
      subpath: parts[2] === 'blob' && path.posix.basename(inferredPath).toLowerCase() === 'skill.md'
        ? path.posix.dirname(inferredPath)
        : inferredPath,
    };
  }
  throw new Error('GitHub URL must identify a repository or tree');
}

function normalizeGithubSkillSource(input = {}) {
  const parsed = parseGithubLocator(input.locator || input.url || input.repository);
  const owner = normalizeRepositoryPart(parsed.owner, 'owner');
  const repo = normalizeRepositoryPart(parsed.repo, 'repository');
  const ref = normalizeRef(input.ref || parsed.ref || 'main');
  const subpath = normalizeSubpath(input.subpath != null ? input.subpath : parsed.subpath);
  const sourcePath = subpath ? `${subpath}/SKILL.md` : 'SKILL.md';
  return {
    owner,
    repo,
    locator: `${owner}/${repo}`,
    ref,
    subpath,
    sourceId: `github:${owner}/${repo}:${ref}:${sourcePath}`,
    sourcePath,
  };
}

function encodeRepositoryPath(value) {
  return String(value || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function ensureRepositoryApiUrl(value, apiBase, source) {
  const candidate = new URL(value);
  const repositoryPrefix = `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/`;
  if (candidate.origin !== apiBase.origin || !candidate.pathname.startsWith(repositoryPrefix)) {
    throw new Error('GitHub request or redirect left the configured repository API');
  }
  return candidate;
}

function ensureResponseStayedInRepository(response, requestedUrl, apiBase, source) {
  ensureRepositoryApiUrl(response.url || requestedUrl, apiBase, source);
}

async function fetchJsonBounded(url, context) {
  ensureRepositoryApiUrl(url, context.apiBase, context.source);
  const response = await context.fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'remote-codex-skill-import',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(context.token ? { Authorization: `Bearer ${context.token}` } : {}),
    },
  });
  ensureResponseStayedInRepository(response, url, context.apiBase, context.source);
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > context.maxApiResponseBytes) {
    throw new Error('GitHub API response exceeds the configured metadata limit');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > context.maxApiResponseBytes) {
    throw new Error('GitHub API response exceeds the configured metadata limit');
  }
  let body = null;
  try {
    body = buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
  } catch (error) {
    throw new Error(`GitHub API returned invalid JSON: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${body?.message || response.statusText || 'request failed'}`);
  }
  return body;
}

function validateEntryName(value) {
  const name = String(value || '');
  if (
    !name
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    throw new Error('GitHub directory entry contains an unsafe path name');
  }
  return name;
}

function decodeGithubFile(file, expectedRepositoryPath) {
  if (!file || file.type !== 'file') {
    throw new Error(`GitHub entry is not a regular file: ${expectedRepositoryPath}`);
  }
  if (String(file.path || '') !== expectedRepositoryPath) {
    throw new Error(`GitHub file path does not match the requested repository path: ${expectedRepositoryPath}`);
  }
  if (file.encoding !== 'base64' || typeof file.content !== 'string') {
    return null;
  }
  const compact = file.content.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`GitHub file has invalid base64 content: ${expectedRepositoryPath}`);
  }
  const content = Buffer.from(compact, 'base64');
  if (Number.isSafeInteger(file.size) && file.size >= 0 && file.size !== content.length) {
    throw new Error(`GitHub file size changed while importing: ${expectedRepositoryPath}`);
  }
  return content;
}

function decodeGithubBlob(blob, expectedRepositoryPath, expectedSize) {
  if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new Error(`GitHub Blob content is not available as base64: ${expectedRepositoryPath}`);
  }
  const compact = blob.content.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`GitHub Blob has invalid base64 content: ${expectedRepositoryPath}`);
  }
  const content = Buffer.from(compact, 'base64');
  if (Number.isSafeInteger(expectedSize) && expectedSize >= 0 && expectedSize !== content.length) {
    throw new Error(`GitHub Blob size changed while importing: ${expectedRepositoryPath}`);
  }
  if (Number.isSafeInteger(blob.size) && blob.size >= 0 && blob.size !== content.length) {
    throw new Error(`GitHub Blob response has an invalid size: ${expectedRepositoryPath}`);
  }
  return content;
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function downloadGithubSkill(options = {}) {
  const source = normalizeGithubSkillSource(options);
  const destination = path.resolve(String(options.destination || '').trim());
  if (!options.destination) {
    throw new Error('GitHub Skill import destination is required');
  }
  const maxFiles = positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, 'maxFiles');
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const maxDepth = positiveLimit(options.maxDepth, DEFAULT_MAX_DEPTH, 'maxDepth');
  const maxApiResponseBytes = positiveLimit(
    options.maxApiResponseBytes,
    DEFAULT_MAX_API_RESPONSE_BYTES,
    'maxApiResponseBytes'
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is required for GitHub Skill import');
  }
  const apiBase = new URL(options.apiBaseUrl || 'https://api.github.com');
  if (apiBase.protocol !== 'https:' && apiBase.hostname !== '127.0.0.1' && apiBase.hostname !== 'localhost') {
    throw new Error('GitHub API base URL must use HTTPS');
  }
  const context = {
    source,
    fetchImpl,
    apiBase,
    token: String(options.token || '').trim(),
    maxApiResponseBytes,
  };
  const seenFiles = new Set();
  const queue = [{ repositoryPath: source.subpath, relativePath: '', depth: 0 }];
  let fileCount = 0;
  let totalBytes = 0;
  await fs.promises.mkdir(destination, { recursive: true });

  while (queue.length) {
    const current = queue.shift();
    if (current.depth > maxDepth) {
      throw new Error(`GitHub Skill directory depth exceeds ${maxDepth}`);
    }
    const contentsPath = encodeRepositoryPath(current.repositoryPath);
    const listUrl = new URL(
      `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${contentsPath}`,
      apiBase
    );
    listUrl.searchParams.set('ref', source.ref);
    const entries = await fetchJsonBounded(listUrl, context);
    if (!Array.isArray(entries)) {
      throw new Error(`GitHub Skill subpath is not a directory: ${current.repositoryPath || '/'}`);
    }
    if (entries.length >= GITHUB_CONTENTS_DIRECTORY_LIMIT) {
      throw new Error(
        `GitHub directory returned ${entries.length} entries and may be truncated; use a smaller Skill subpath or the Git Tree API`
      );
    }
    entries.sort((left, right) => String(left?.name || '').localeCompare(String(right?.name || '')));
    for (const entry of entries) {
      const name = validateEntryName(entry?.name);
      const repositoryPath = current.repositoryPath
        ? `${current.repositoryPath}/${name}`
        : name;
      if (String(entry.path || '') !== repositoryPath) {
        throw new Error(`GitHub directory entry path does not match its parent: ${repositoryPath}`);
      }
      const relativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
      if (entry.type === 'dir') {
        if (current.depth + 1 > maxDepth) {
          throw new Error(`GitHub Skill directory depth exceeds ${maxDepth}`);
        }
        queue.push({ repositoryPath, relativePath, depth: current.depth + 1 });
        continue;
      }
      if (entry.submodule_git_url) {
        throw new Error(`GitHub Skill contains an unsupported submodule: ${repositoryPath}`);
      }
      if (entry.type !== 'file') {
        throw new Error(`GitHub Skill contains an unsupported ${entry.type || 'unknown'} entry: ${repositoryPath}`);
      }
      fileCount += 1;
      if (fileCount > maxFiles) {
        throw new Error(`GitHub Skill contains more than ${maxFiles} files`);
      }
      if (seenFiles.has(relativePath)) {
        throw new Error(`GitHub Skill contains a duplicate path: ${relativePath}`);
      }
      seenFiles.add(relativePath);
      const fileUrl = new URL(
        `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${encodeRepositoryPath(repositoryPath)}`,
        apiBase
      );
      fileUrl.searchParams.set('ref', source.ref);
      const file = await fetchJsonBounded(fileUrl, context);
      if (file?.submodule_git_url) {
        throw new Error(`GitHub Skill contains an unsupported submodule: ${repositoryPath}`);
      }
      let content = decodeGithubFile(file, repositoryPath);
      if (!content && file?.git_url) {
        const blobUrl = ensureRepositoryApiUrl(file.git_url, apiBase, source);
        const blob = await fetchJsonBounded(blobUrl, context);
        content = decodeGithubBlob(blob, repositoryPath, file.size);
      }
      if (!content) {
        throw new Error(`GitHub file content is unavailable: ${repositoryPath}`);
      }
      totalBytes += content.length;
      if (totalBytes > maxBytes) {
        throw new Error(`GitHub Skill content exceeds ${maxBytes} bytes`);
      }
      const targetPath = path.resolve(destination, ...relativePath.split('/'));
      if (!isPathInside(destination, targetPath) || targetPath === destination) {
        throw new Error(`GitHub Skill path escapes staging root: ${relativePath}`);
      }
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, content, { flag: 'wx' });
    }
  }

  if (!seenFiles.has('SKILL.md')) {
    throw new Error('GitHub Skill directory does not contain a root SKILL.md');
  }
  return {
    ...source,
    destination,
    fileCount,
    totalBytes,
  };
}

module.exports = {
  downloadGithubSkill,
  normalizeGithubSkillSource,
};
