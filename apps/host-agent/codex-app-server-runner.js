const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { nowIso } = require('../../shared/protocol');
const {
  ThinkingActivityAggregator,
  makeActivityKey,
} = require('../../shared/thinking-activity');
const {
  buildApiEnvironment,
  describeApiConfig,
  normalizeApiConfig,
} = require('./runtime-utils');
const {
  assertRunBinding,
  classifyNativeThreadError,
  deriveRunBinding,
  modelCapabilitiesFromList,
  normalizeReasoningEffort,
  resumeStrategyForLaunchMode,
  validateModelSelection: validateRuntimeModelSelection,
} = require('./session-api-runtime');

const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_REQUEST_TIMEOUT_MS || 15000);
const LIST_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_LIST_REQUEST_TIMEOUT_MS || 30000);
const INITIALIZE_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_INITIALIZE_TIMEOUT_MS || 60000);
const THREAD_OPEN_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_THREAD_OPEN_TIMEOUT_MS || 120000);
const TURN_START_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_TURN_START_TIMEOUT_MS || 120000);
const MANAGED_OVERLAY_MARKER_KIND = 'remote-codex-managed-overlay';
const MANAGED_OVERLAY_MARKER_VERSION = 1;
const MANAGED_OVERLAY_MARKER_NAME = '.remote-codex-owner';

function retryableTerminalDeliveryError(error) {
  const result = error instanceof Error
    ? error
    : new Error(String(error || 'Session terminal state delivery failed.'));
  result.retryCommand = true;
  return result;
}

function throwTerminalErrors(errors, message) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const aggregate = new AggregateError(errors, message);
    if (errors.some((error) => error?.retryCommand === true)) aggregate.retryCommand = true;
    if (errors.some((error) => error?.processTreeFallbackRequired === true)) {
      aggregate.processTreeFallbackRequired = true;
    }
    throw aggregate;
  }
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function countTextLines(value) {
  const text = String(value || '');
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).filter((line, index, lines) => line || index < lines.length - 1).length;
}

function countDiffLines(diffText) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function normalizeAppServerFileChangeStatus(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'add') {
    return 'added';
  }
  if (text === 'delete') {
    return 'deleted';
  }
  if (text === 'update') {
    return 'modified';
  }
  return text || 'modified';
}

function normalizeAppServerFileChanges(fileChanges) {
  if (!fileChanges || typeof fileChanges !== 'object') {
    return [];
  }
  return Object.entries(fileChanges)
    .map(([pathValue, change]) => {
      if (!change || typeof change !== 'object') {
        return null;
      }
      const status = normalizeAppServerFileChangeStatus(change.type || change.status);
      const diff = String(change.unified_diff || change.unifiedDiff || change.diff || change.patch || '').trim();
      const diffCounts = countDiffLines(diff);
      const contentLines = countTextLines(change.content || '');
      return {
        path: String(pathValue || change.path || change.file || change.file_path || 'workspace change'),
        status,
        additions: status === 'added' && !diff ? contentLines : diff ? diffCounts.additions : null,
        deletions: status === 'deleted' && !diff ? contentLines : diff ? diffCounts.deletions : null,
        diff,
      };
    })
    .filter(Boolean);
}

function shouldSurfaceStderrLine(text) {
  if (!text) {
    return false;
  }

  if (/^Updating files:\s+\d+%/.test(text)) {
    return false;
  }

  if (/^\s*</.test(text)) {
    return false;
  }

  if (/^\s*[A-Za-z0-9_-]+\s*=/.test(text)) {
    return false;
  }

  if (/^\s*[/>]\s*$/.test(text)) {
    return false;
  }

  if (/\bWARN\s+codex_core::shell_snapshot\b/.test(text) && /PowerShell|snapshot not supported/i.test(text)) {
    return false;
  }

  if (/\bWARN\s+codex_core_plugins::/.test(text)
    && /(remote plugin|plugin bundle|featured plugin|chatgpt authentication|Unauthorized|api key auth is not supported)/i.test(text)) {
    return false;
  }

  if (/^error: unable to write file plugins\//.test(text)) {
    return false;
  }

  if (/^fatal: cannot create directory at 'plugins\//.test(text)) {
    return false;
  }

  if (/^warning: Clone succeeded, but checkout failed\./.test(text)) {
    return false;
  }

  if (/^You can inspect what was checked out/.test(text)) {
    return false;
  }

  if (/^and retry with /.test(text)) {
    return false;
  }

  return true;
}

function isRuntimeDiagnosticStderrLine(text) {
  return /codex_app_server: failed to initialize sqlite state db/i.test(text)
    || /failed to initialize sqlite state runtime/i.test(text)
    || /file is not a database/i.test(text)
    || /Codex could not find bubblewrap on PATH/i.test(text)
    || /sandbox prerequisites/i.test(text)
    || /concepts\/sandboxing#prerequisites/i.test(text);
}

function isCodexStateDatabaseError(text) {
  return /codex_app_server: failed to initialize sqlite state db/i.test(text)
    || /failed to initialize sqlite state runtime/i.test(text)
    || /file is not a database/i.test(text);
}

function codexStateDatabaseHint(text) {
  return [
    'Codex could not start because the SQLite state under CODEX_HOME is not a valid database.',
    'Do not delete the whole ~/.codex directory.',
    'Inspect and move only the broken sqlite state file, then restart this host-agent.',
    `Raw stderr: ${limitText(text, 420)}`,
  ].join(' ');
}

const CODEX_SCAN_SKIP_DIRS = new Set([
  '.cache',
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  'cache',
  'history',
  'logs',
  'node_modules',
  'projects',
  'sessions',
  'tmp',
  'temp',
]);

function isExecutableFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    return Boolean(stats.mode & 0o111);
  } catch {
    return false;
  }
}

function shouldSpawnCodexThroughShell(codexBin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(codexBin || ''));
}

function pushUnique(list, seen, value) {
  if (!value || seen.has(value)) {
    return;
  }
  seen.add(value);
  list.push(value);
}

function isCodexExecutableName(name) {
  const lower = String(name || '').toLowerCase();
  if (
    lower.startsWith('codex-command-runner')
    || lower.startsWith('codex-windows-sandbox')
    || lower.startsWith('codex-sandbox')
  ) {
    return false;
  }
  return lower === 'codex' || lower === 'codex.exe' || /^codex[-_.]/.test(lower);
}

function collectCodexExecutables(rootDir, options = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const maxDepth = options.maxDepth ?? 4;
  const maxEntries = options.maxEntries ?? 600;
  const found = [];
  const seen = new Set();
  let visitedEntries = 0;

  function visit(dir, depth) {
    if (depth > maxDepth || visitedEntries >= maxEntries) {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visitedEntries >= maxEntries) {
        return;
      }
      visitedEntries += 1;

      const fullPath = path.join(dir, entry.name);
      if (isCodexExecutableName(entry.name) && isExecutableFile(fullPath)) {
        pushUnique(found, seen, fullPath);
        continue;
      }

      if (!entry.isDirectory() || depth >= maxDepth) {
        continue;
      }

      if (CODEX_SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) {
        continue;
      }

      visit(fullPath, depth + 1);
    }
  }

  visit(rootDir, 0);
  return found;
}

function resolveDefaultCodexBin(codexHomeOverride = null) {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }

  const candidates = [];
  const seen = new Set();
  const home = os.homedir();
  const agentRoot = path.resolve(__dirname, '..', '..');

  for (const relativePath of [
    path.join('.runtime', 'codex', 'codex'),
    path.join('.runtime', 'codex', 'bin', 'linux-x86_64', 'codex'),
    path.join('.runtime', 'codex', 'linux-x86_64', 'codex'),
  ]) {
    pushUnique(candidates, seen, path.join(agentRoot, relativePath));
  }

  const codexRoots = [
    codexHomeOverride,
    process.env.CODEX_HOME,
    path.join(home, '.codex'),
  ].filter(Boolean);

  for (const absolutePath of [
    path.join(home, 'bin', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.cargo', 'bin', 'codex'),
    process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'bin', 'codex') : null,
    process.env.NPM_CONFIG_PREFIX ? path.join(process.env.NPM_CONFIG_PREFIX, 'bin', 'codex') : null,
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'codex') : null,
  ]) {
    pushUnique(candidates, seen, absolutePath);
  }

  for (const root of codexRoots) {
    for (const relativePath of [
      path.join('bin', 'codex'),
      'codex',
      path.join('bin', 'codex-x86_64-unknown-linux-musl'),
      path.join('bin', 'codex-x86_64-unknown-linux-gnu'),
      path.join('codex', 'bin', 'codex'),
      path.join('cli', 'codex'),
      path.join('node_modules', '.bin', 'codex'),
      path.join('npm', 'bin', 'codex'),
    ]) {
      pushUnique(candidates, seen, path.join(root, relativePath));
    }

    for (const binPath of collectCodexExecutables(root)) {
      pushUnique(candidates, seen, binPath);
    }
  }

  for (const root of [
    path.join(home, '.conda', 'envs'),
    path.join(home, '.nvm', 'versions', 'node'),
  ]) {
    for (const binPath of collectCodexExecutables(root, { maxDepth: 3, maxEntries: 4000 })) {
      pushUnique(candidates, seen, binPath);
    }
  }

  const cursorExtensions = path.join(home, '.cursor', 'extensions');
  if (fs.existsSync(cursorExtensions)) {
    const extensionDirs = fs.readdirSync(cursorExtensions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const entry of extensionDirs) {
      for (const platformDir of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x86_64']) {
        const binName = platformDir === 'windows-x86_64' ? 'codex.exe' : 'codex';
        pushUnique(candidates, seen, path.join(cursorExtensions, entry, 'bin', platformDir, binName));
      }
    }
  }

  return candidates.find((candidate) => isExecutableFile(candidate)) || 'codex';
}

function buildCodexProcessPath(codexBin) {
  const entries = [];
  const seen = new Set();

  function pushPath(value) {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    entries.push(value);
  }

  const binDir = path.dirname(codexBin || '');
  for (const candidate of [
    path.join(binDir, 'codex-resources'),
    path.join(path.dirname(binDir), 'codex-resources'),
  ]) {
    if (candidate && fs.existsSync(candidate)) {
      pushPath(candidate);
    }
  }

  pushPath(process.env.PATH || '');
  return entries.filter(Boolean).join(path.delimiter);
}

function buildResumePrelude(bootstrap) {
  const historyPreview = Array.isArray(bootstrap?.historyPreview) ? bootstrap.historyPreview : [];
  if (!historyPreview.length) {
    return null;
  }

  const lines = historyPreview
    .map((entry) => {
      const speaker = entry.speaker === 'user' ? 'User' : entry.speaker === 'assistant' ? 'Codex' : 'System';
      return `${speaker}: ${String(entry.text || '').trim()}`;
    })
    .filter(Boolean);

  if (!lines.length) {
    return null;
  }

  return [
    'Continue this conversation with the following prior context in mind:',
    ...lines,
  ].join('\n');
}

function limitText(value, max = 240) {
  const text = String(value || '');
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function codexCliInstallHint() {
  return [
    'Codex CLI was not found on this host.',
    'Install options:',
    'conda create -n codex-node -c conda-forge nodejs=20 -y && conda activate codex-node && npm install -g @openai/codex',
    'or: curl -fsSL https://fnm.vercel.app/install | bash && source ~/.bashrc && fnm install 20 && fnm use 20 && npm install -g @openai/codex',
    'Then restart this host-agent.',
  ].join(' ');
}

function formatCodexStartError(error) {
  const message = error?.message || String(error || 'unknown error');
  if (error?.code === 'ENOENT' || /not found|enoent|spawn codex/i.test(message)) {
    return `${message}. ${codexCliInstallHint()}`;
  }
  return message;
}

function safeProfileSegment(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'profile';
}

function hashApiConfig(config) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      provider: config.provider || '',
      baseUrl: config.baseUrl || '',
      apiKey: config.apiKey || '',
      profileId: config.profileId || '',
    }))
    .digest('hex')
    .slice(0, 16);
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function copyFileIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
}

function ensurePrivateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
}

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
}

function writeManagedOverlayOwnerMarker(ownerMarkerPath, contents) {
  const directory = path.dirname(ownerMarkerPath);
  const tempPath = path.join(
    directory,
    `${MANAGED_OVERLAY_MARKER_NAME}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  const data = Buffer.from(String(contents), 'utf8');
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    let offset = 0;
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error('owner marker temp write made no progress');
      }
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, ownerMarkerPath);
    try {
      fs.chmodSync(ownerMarkerPath, 0o600);
    } catch {
      // Windows only exposes a subset of POSIX mode semantics.
    }
    let directoryFd = null;
    try {
      directoryFd = fs.openSync(directory, 'r');
      fs.fsyncSync(directoryFd);
    } catch {
      // Directory fsync is unsupported on some Windows/filesystem combinations.
    } finally {
      if (directoryFd !== null) {
        try {
          fs.closeSync(directoryFd);
        } catch {
          // The marker file was already atomically replaced and flushed.
        }
      }
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort before removing the incomplete temp file.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The authoritative marker is unchanged even if temp cleanup must be retried later.
    }
    throw error;
  }
}

function managedOverlayPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function readManagedOverlayOwnerMarker(markerPath) {
  try {
    const stats = fs.lstatSync(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (
      !marker
      || marker.kind !== MANAGED_OVERLAY_MARKER_KIND
      || marker.version !== MANAGED_OVERLAY_MARKER_VERSION
      || !/^[a-f0-9]{32}$/i.test(String(marker.ownerToken || ''))
      || !managedOverlayPid(marker.ownerPid)
    ) {
      return null;
    }
    return {
      ...marker,
      ownerPid: managedOverlayPid(marker.ownerPid),
      childPid: managedOverlayPid(marker.childPid),
      childState: String(marker.childState || '').trim() || 'unknown',
    };
  } catch {
    return null;
  }
}

function readLegacyManagedOverlayOwnerToken(markerPath) {
  try {
    const stats = fs.lstatSync(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128) return null;
    const markerText = fs.readFileSync(markerPath, 'utf8').trim();
    return /^[a-f0-9]{32}$/i.test(markerText) ? markerText : null;
  } catch {
    return null;
  }
}

function updateApiProfileCodexHomeOwnership(cleanupOwner, patch = {}) {
  if (!cleanupOwner || typeof cleanupOwner !== 'object') return false;
  const profileHomeDir = path.resolve(String(cleanupOwner.profileHomeDir || ''));
  const ownerMarkerPath = path.resolve(String(cleanupOwner.ownerMarkerPath || ''));
  if (ownerMarkerPath !== path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME)) return false;
  const marker = readManagedOverlayOwnerMarker(ownerMarkerPath);
  if (!marker || marker.ownerToken !== cleanupOwner.ownerToken) return false;
  const childState = Object.prototype.hasOwnProperty.call(patch, 'childState')
    ? String(patch.childState || '').trim()
    : marker.childState;
  if (!['not-started', 'spawning', 'running', 'exited', 'spawn-failed'].includes(childState)) {
    return false;
  }
  let childPid = marker.childPid;
  if (Object.prototype.hasOwnProperty.call(patch, 'childPid')) {
    childPid = patch.childPid == null ? null : managedOverlayPid(patch.childPid);
    if (patch.childPid != null && !childPid) return false;
  }
  writeManagedOverlayOwnerMarker(ownerMarkerPath, `${JSON.stringify({
    ...marker,
    childPid,
    childState,
    updatedAt: nowIso(),
  }, null, 2)}\n`);
  return true;
}

function isProcessAlive(pid) {
  const normalizedPid = managedOverlayPid(pid);
  if (!normalizedPid) return false;
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function managedOverlayPathIdentity(value) {
  const normalized = path.normalize(String(value || ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function managedOverlayRealPath(value) {
  const resolver = typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native
    : fs.realpathSync;
  return resolver(value);
}

function inspectManagedOverlayDirectory(managedRootReal, directory) {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('managed Codex overlay directory is a link or is not a directory');
  }
  const real = managedOverlayRealPath(directory);
  if (
    managedOverlayPathIdentity(path.dirname(real))
    !== managedOverlayPathIdentity(managedRootReal)
  ) {
    throw new Error('managed Codex overlay real path escapes its managed root');
  }
  return real;
}

function ensureManagedOverlayRoot(baseHome, managedRoot) {
  const resolvedBaseHome = path.resolve(baseHome);
  if (!fs.existsSync(resolvedBaseHome)) {
    fs.mkdirSync(resolvedBaseHome, { recursive: true, mode: 0o700 });
  }
  const baseHomeStats = fs.statSync(resolvedBaseHome);
  if (!baseHomeStats.isDirectory()) {
    throw new Error('base Codex home is not a directory');
  }
  const baseHomeReal = managedOverlayRealPath(resolvedBaseHome);
  try {
    fs.mkdirSync(managedRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const managedRootStats = fs.lstatSync(managedRoot);
  if (!managedRootStats.isDirectory() || managedRootStats.isSymbolicLink()) {
    throw new Error('managed Codex overlay root is a link or is not a directory');
  }
  const managedRootReal = managedOverlayRealPath(managedRoot);
  if (
    managedOverlayPathIdentity(managedRootReal)
    !== managedOverlayPathIdentity(path.join(baseHomeReal, '.remote-codex-managed'))
  ) {
    throw new Error('managed Codex overlay root real path is unsafe');
  }
  try {
    fs.chmodSync(managedRoot, 0o700);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
  return managedRootReal;
}

function linkSharedCodexHomeEntry(baseHome, overlayHome, name) {
  const source = path.join(baseHome, name);
  const target = path.join(overlayHome, name);
  if (!fs.existsSync(source) || fs.existsSync(target)) {
    return;
  }
  const stats = fs.statSync(source);
  try {
    const linkType = stats.isDirectory()
      ? (process.platform === 'win32' ? 'junction' : 'dir')
      : 'file';
    fs.symlinkSync(source, target, linkType);
    return;
  } catch {
    // Symlinks can be disabled on Windows/HPC; fall back to copying only small files.
  }
  if (stats.isFile() && stats.size <= 1024 * 1024) {
    fs.copyFileSync(source, target);
  }
}

function rewriteConfigTomlForApiProfile(baseConfig, config, providerKey) {
  const begin = '# BEGIN remote-codex-api-profile';
  const end = '# END remote-codex-api-profile';
  const blockPattern = new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`, 'g');
  let next = String(baseConfig || '').replace(blockPattern, '\n').trim();
  const providerName = config.label || config.provider || 'API profile';
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const profileBlock = [
    '',
    begin,
    `[model_providers.${providerKey}]`,
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    end,
    '',
  ].filter((line) => line !== '').join('\n');

  if (/^model_provider\s*=.*$/m.test(next)) {
    next = next.replace(/^model_provider\s*=.*$/m, `model_provider = ${tomlString(providerKey)}`);
  } else {
    next = `model_provider = ${tomlString(providerKey)}\n${next}`;
  }
  return `${next.trim()}\n${profileBlock}`;
}

function prepareApiProfileCodexHome(baseHome, apiConfig, options = {}) {
  const config = normalizeApiConfig(apiConfig);
  const hash = config ? hashApiConfig(config) : 'host-env';
  const segment = safeProfileSegment(config?.profileId || config?.label || config?.provider || 'host-env');
  const sessionSegment = safeProfileSegment(options.sessionId || options.bridgeSessionId || 'session');
  const ownerToken = crypto.randomBytes(16).toString('hex');
  const runSegment = safeProfileSegment(options.runId || ownerToken.slice(0, 12));
  const managedRoot = path.join(baseHome, '.remote-codex-managed');
  const profileHomeDir = path.join(managedRoot, `${sessionSegment}-${segment}-${hash}-${runSegment}-${ownerToken.slice(0, 12)}`);
  // Keep every managed session in its own HOME. This prevents our app-server
  // from sharing Codex SQLite state with an interactive Codex running on HPC.
  const overlayHome = path.join(profileHomeDir, '.codex');
  const ownerMarkerPath = path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME);
  let profileHomeCreated = false;
  let managedRootReal = null;
  try {
    managedRootReal = ensureManagedOverlayRoot(baseHome, managedRoot);
    fs.mkdirSync(profileHomeDir, { recursive: false, mode: 0o700 });
    profileHomeCreated = true;
    inspectManagedOverlayDirectory(managedRootReal, profileHomeDir);
    ensurePrivateDirectory(overlayHome);
    writeManagedOverlayOwnerMarker(ownerMarkerPath, `${JSON.stringify({
      kind: MANAGED_OVERLAY_MARKER_KIND,
      version: MANAGED_OVERLAY_MARKER_VERSION,
      ownerToken,
      ownerPid: process.pid,
      childPid: null,
      childState: 'not-started',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }, null, 2)}\n`);

    const baseAuthPath = path.join(baseHome, 'auth.json');
    const overlayAuthPath = path.join(overlayHome, 'auth.json');
    let auth = {};
    try {
      auth = JSON.parse(fs.readFileSync(baseAuthPath, 'utf8'));
    } catch {
      auth = {};
    }
    if (config?.apiKey) {
      auth.OPENAI_API_KEY = config.apiKey;
    }
    writePrivateFile(overlayAuthPath, `${JSON.stringify(auth, null, 2)}\n`);

    const baseConfigPath = path.join(baseHome, 'config.toml');
    const overlayConfigPath = path.join(overlayHome, 'config.toml');
    let baseConfig = '';
    try {
      baseConfig = fs.readFileSync(baseConfigPath, 'utf8');
    } catch {
      baseConfig = '';
    }
    const providerKey = config ? `remote_codex_${hash}` : null;
    writePrivateFile(
      overlayConfigPath,
      config ? rewriteConfigTomlForApiProfile(baseConfig, config, providerKey) : baseConfig
    );

    for (const name of ['installation_id', 'cap_sid', 'session_index.jsonl', '.personality_migration']) {
      copyFileIfExists(path.join(baseHome, name), path.join(overlayHome, name));
    }
    for (const name of ['sessions', 'skills', 'rules', 'memories', 'generated_images']) {
      linkSharedCodexHomeEntry(baseHome, overlayHome, name);
    }

    return {
      codexHome: overlayHome,
      profileHome: Boolean(config),
      isolatedHome: true,
      profileHomeDir,
      providerKey,
      cleanupOwner: { baseHome, managedRoot, profileHomeDir, ownerMarkerPath, ownerToken },
    };
  } catch (error) {
    if (profileHomeCreated) {
      try {
        if (
          managedRootReal
          && managedOverlayPathIdentity(inspectManagedOverlayDirectory(managedRootReal, profileHomeDir))
            === managedOverlayPathIdentity(managedOverlayRealPath(profileHomeDir))
        ) {
          fs.rmSync(profileHomeDir, { recursive: true, force: true });
        }
      } catch {
        // Preserve the constructor failure; the startup janitor can retry owned cleanup.
      }
    }
    throw error;
  }
}

function cleanupApiProfileCodexHome(cleanupOwner) {
  if (!cleanupOwner || typeof cleanupOwner !== 'object') return false;
  const baseHome = path.resolve(String(cleanupOwner.baseHome || ''));
  const managedRoot = path.resolve(String(cleanupOwner.managedRoot || ''));
  const profileHomeDir = path.resolve(String(cleanupOwner.profileHomeDir || ''));
  const ownerMarkerPath = path.resolve(String(cleanupOwner.ownerMarkerPath || ''));
  const expectedManagedRoot = path.join(baseHome, '.remote-codex-managed');
  const expectedOwnerMarkerPath = path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME);
  if (
    managedRoot !== expectedManagedRoot
    || path.dirname(profileHomeDir) !== managedRoot
    || ownerMarkerPath !== expectedOwnerMarkerPath
    || profileHomeDir === managedRoot
    || managedRoot === baseHome
  ) {
    return false;
  }
  try {
    const managedRootStats = fs.lstatSync(managedRoot);
    const markerStats = fs.lstatSync(ownerMarkerPath);
    if (
      !managedRootStats.isDirectory()
      || managedRootStats.isSymbolicLink()
      || !markerStats.isFile()
      || markerStats.isSymbolicLink()
    ) {
      return false;
    }
    const baseHomeReal = managedOverlayRealPath(baseHome);
    const managedRootReal = managedOverlayRealPath(managedRoot);
    if (
      managedOverlayPathIdentity(managedRootReal)
      !== managedOverlayPathIdentity(path.join(baseHomeReal, '.remote-codex-managed'))
    ) {
      return false;
    }
    inspectManagedOverlayDirectory(managedRootReal, profileHomeDir);
  } catch {
    return false;
  }
  let markerToken = '';
  try {
    const markerText = fs.readFileSync(ownerMarkerPath, 'utf8').trim();
    try {
      const marker = JSON.parse(markerText);
      if (
        marker?.kind !== MANAGED_OVERLAY_MARKER_KIND
        || marker?.version !== MANAGED_OVERLAY_MARKER_VERSION
      ) {
        return false;
      }
      markerToken = String(marker.ownerToken || '').trim();
    } catch {
      // Runners created by the immediately previous version used the token as the marker body.
      markerToken = markerText;
    }
  } catch {
    return false;
  }
  if (!markerToken || markerToken !== cleanupOwner.ownerToken) return false;
  fs.rmSync(profileHomeDir, { recursive: true, force: true });
  return true;
}

function cleanupStaleApiProfileCodexHomes(baseHome, options = {}) {
  const normalizedBaseHome = String(baseHome || '').trim();
  const result = {
    scanned: 0,
    removed: 0,
    preserved: 0,
    legacyUnattributed: 0,
    legacyRemoved: 0,
    legacyPreserved: 0,
    diagnostics: [],
    errors: [],
  };
  if (!normalizedBaseHome) return result;
  const resolvedBaseHome = path.resolve(normalizedBaseHome);
  const managedRoot = path.join(resolvedBaseHome, '.remote-codex-managed');
  let managedRootReal = null;
  let entries = [];
  try {
    const managedRootStats = fs.lstatSync(managedRoot);
    if (!managedRootStats.isDirectory() || managedRootStats.isSymbolicLink()) {
      result.errors.push('managed Codex overlay root is a link or is not a directory; cleanup was skipped');
      return result;
    }
    const baseHomeReal = managedOverlayRealPath(resolvedBaseHome);
    managedRootReal = managedOverlayRealPath(managedRoot);
    if (
      managedOverlayPathIdentity(managedRootReal)
      !== managedOverlayPathIdentity(path.join(baseHomeReal, '.remote-codex-managed'))
    ) {
      result.errors.push('managed Codex overlay root real path is unsafe; cleanup was skipped');
      return result;
    }
    entries = fs.readdirSync(managedRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') result.errors.push(String(error.message || error));
    return result;
  }
  const processIsAlive = typeof options.isProcessAlive === 'function'
    ? options.isProcessAlive
    : isProcessAlive;
  const legacyOverlayIsInactive = typeof options.legacyOverlayIsInactive === 'function'
    ? options.legacyOverlayIsInactive
    : null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    result.scanned += 1;
    const profileHomeDir = path.join(managedRoot, entry.name);
    let profileHomeReal = null;
    try {
      profileHomeReal = inspectManagedOverlayDirectory(managedRootReal, profileHomeDir);
    } catch {
      result.preserved += 1;
      result.errors.push('managed Codex overlay entry has an unsafe link or real path; cleanup was skipped');
      continue;
    }
    const ownerMarkerPath = path.join(profileHomeDir, MANAGED_OVERLAY_MARKER_NAME);
    const marker = readManagedOverlayOwnerMarker(ownerMarkerPath);
    if (!marker) {
      const legacyOwnerToken = readLegacyManagedOverlayOwnerToken(ownerMarkerPath);
      if (!legacyOwnerToken) {
        result.preserved += 1;
        continue;
      }

      result.legacyUnattributed += 1;
      let inactiveAttested = false;
      if (legacyOverlayIsInactive) {
        try {
          inactiveAttested = legacyOverlayIsInactive(Object.freeze({
            baseHome: path.resolve(normalizedBaseHome),
            managedRoot,
            profileHomeDir,
            codexHome: path.join(profileHomeDir, '.codex'),
          })) === true;
        } catch {
          result.errors.push('legacy managed Codex overlay liveness attestation failed');
        }
      }
      if (!inactiveAttested) {
        result.preserved += 1;
        result.legacyPreserved += 1;
        continue;
      }

      // Re-read the token immediately before removal so a concurrent marker
      // replacement cannot turn an operator attestation into foreign cleanup.
      if (readLegacyManagedOverlayOwnerToken(ownerMarkerPath) !== legacyOwnerToken) {
        result.preserved += 1;
        result.legacyPreserved += 1;
        result.errors.push('legacy managed Codex overlay ownership changed during cleanup');
        continue;
      }
      try {
        if (
          managedOverlayPathIdentity(inspectManagedOverlayDirectory(managedRootReal, profileHomeDir))
          !== managedOverlayPathIdentity(profileHomeReal)
        ) {
          throw new Error('managed Codex overlay ownership path changed during cleanup');
        }
        fs.rmSync(profileHomeDir, { recursive: true, force: true });
        result.removed += 1;
        result.legacyRemoved += 1;
      } catch {
        result.preserved += 1;
        result.legacyPreserved += 1;
        result.errors.push('legacy managed Codex overlay cleanup failed after liveness attestation');
      }
      continue;
    }
    if (processIsAlive(marker.ownerPid)) {
      result.preserved += 1;
      continue;
    }
    let childIsConfirmedDead = false;
    if (marker.childPid) {
      childIsConfirmedDead = !processIsAlive(marker.childPid);
    } else if (['not-started', 'exited', 'spawn-failed'].includes(marker.childState)) {
      childIsConfirmedDead = true;
    }
    if (!childIsConfirmedDead) {
      result.preserved += 1;
      continue;
    }
    try {
      if (
        managedOverlayPathIdentity(inspectManagedOverlayDirectory(managedRootReal, profileHomeDir))
        !== managedOverlayPathIdentity(profileHomeReal)
      ) {
        throw new Error('managed Codex overlay ownership path changed during cleanup');
      }
      fs.rmSync(profileHomeDir, { recursive: true, force: true });
      result.removed += 1;
    } catch (error) {
      result.preserved += 1;
      result.errors.push(`${entry.name}: ${String(error.message || error)}`);
    }
  }
  if (result.legacyPreserved > 0) {
    result.diagnostics.push({
      severity: 'warning',
      code: 'legacy_overlay_preserved_unattributed',
      count: result.legacyPreserved,
      message: `Preserved ${result.legacyPreserved} unattributed legacy managed Codex overlay(s). Confirm that no old Host Agent or app-server uses this CODEX_HOME before enabling the one-time legacy cleanup attestation.`,
    });
  }
  if (result.legacyRemoved > 0) {
    result.diagnostics.push({
      severity: 'info',
      code: 'legacy_overlay_removed_by_attestation',
      count: result.legacyRemoved,
      message: `Removed ${result.legacyRemoved} legacy managed Codex overlay(s) after explicit operator liveness attestation.`,
    });
  }
  return result;
}

function quarantineCodexStateDatabases(codexHome, reason = 'startup') {
  if (!codexHome || !fs.existsSync(codexHome)) {
    return { backupDir: null, moved: [] };
  }
  const backupDir = path.join(codexHome, `broken-sqlite-backup-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${safeProfileSegment(reason)}`);
  const moved = [];
  fs.mkdirSync(backupDir, { recursive: true });

  for (const entry of fs.readdirSync(codexHome)) {
    if (!/^(logs|state)_\d+\.sqlite(?:-(?:wal|shm))?$/.test(entry)) {
      continue;
    }
    const source = path.join(codexHome, entry);
    const target = path.join(backupDir, entry);
    try {
      fs.renameSync(source, target);
      moved.push(entry);
    } catch {
      // Best effort: another Codex process may still hold the file.
    }
  }

  return { backupDir, moved };
}

function summarizeValue(value, depth = 0) {
  if (value === null || typeof value === 'undefined') {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(limitText(value, depth === 0 ? 240 : 120));
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => summarizeValue(item, depth + 1));
    return `[${items.join(', ')}${value.length > 4 ? ', ...' : ''}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 6).map(([key, item]) => `${key}: ${summarizeValue(item, depth + 1)}`);
    return `{ ${entries.join(', ')}${Object.keys(value).length > 6 ? ', ...' : ''} }`;
  }

  return JSON.stringify(value);
}

function normalizeThinkingText(value, depth = 0) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeThinkingText(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof value === 'object') {
    if (typeof value.step === 'string' && value.step.trim()) {
      const status = typeof value.status === 'string' && value.status.trim()
        ? `[${value.status.trim()}] `
        : '';
      const extra = typeof value.summary === 'string' && value.summary.trim() && value.summary.trim() !== value.step.trim()
        ? ` - ${value.summary.trim()}`
        : '';
      return `${status}${value.step.trim()}${extra}`.trim();
    }

    for (const key of ['text', 'content', 'summary', 'description', 'title', 'label']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        return value[key].trim();
      }
    }

    if (depth > 1) {
      return summarizeValue(value, depth);
    }

    return Object.entries(value)
      .map(([key, item]) => {
        const normalized = normalizeThinkingText(item, depth + 1);
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return String(value).trim();
}

function mergeThinkingBuffer(previous, chunk) {
  const left = String(previous || '').trim();
  const right = String(chunk || '').trim();
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  if (left === right || left.includes(right)) {
    return left;
  }
  if (right.includes(left)) {
    return right;
  }
  return `${left}\n${right}`.trim();
}

function persistedReasoningSummaryText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') {
    return value.text;
  }
  return String(value ?? '');
}

function notificationPhase(params = {}) {
  return String(
    params.phase
      || params.item?.phase
      || params.message?.phase
      || params.payload?.phase
      || ''
  ).trim().toLowerCase();
}

function notificationDeltaText(params = {}) {
  return normalizeThinkingText(
    params.delta
      || params.text
      || params.message
      || params.item?.text
      || params.item?.message
      || ''
  );
}

const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);
const APPROVAL_POLICIES = new Set(['untrusted', 'on-failure', 'on-request', 'never']);
const APPROVAL_REVIEWERS = new Set(['user', 'auto_review', 'guardian_subagent']);
const SANDBOX_MODES = new Set(['workspaceWrite', 'workspace-write', 'readOnly', 'read-only', 'dangerFullAccess', 'danger-full-access', 'externalSandbox', 'external-sandbox']);
const PERSONALITIES = new Set(['none', 'friendly', 'pragmatic']);

function pickAllowedString(value, allowedValues) {
  const text = String(value || '').trim();
  return text && allowedValues.has(text) ? text : null;
}

function normalizeSandboxMode(value) {
  const mode = pickAllowedString(value, SANDBOX_MODES) || 'workspaceWrite';
  return {
    'workspace-write': 'workspaceWrite',
    'read-only': 'readOnly',
    'danger-full-access': 'dangerFullAccess',
    'external-sandbox': 'externalSandbox',
  }[mode] || mode;
}

function buildSandboxPolicy(cwd, options = {}) {
  const mode = normalizeSandboxMode(options.sandboxMode);
  const networkAccess = options.networkAccess === true;

  if (mode === 'dangerFullAccess') {
    return { type: 'dangerFullAccess' };
  }

  if (mode === 'readOnly') {
    return {
      type: 'readOnly',
      networkAccess,
    };
  }

  if (mode === 'externalSandbox') {
    return {
      type: 'externalSandbox',
      networkAccess: networkAccess ? 'enabled' : 'restricted',
    };
  }

  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess,
  };
}

function normalizeInputItems(text, options = {}) {
  const items = [];
  const prompt = String(text || '').trim();
  if (prompt) {
    items.push({
      type: 'text',
      text: prompt,
    });
  }

  const rawItems = [
    ...(Array.isArray(options.inputItems) ? options.inputItems : []),
    ...(Array.isArray(options.attachments) ? options.attachments : []),
  ];

  for (const rawItem of rawItems.slice(0, 8)) {
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }
    const type = String(rawItem.type || '').trim();

    if (type === 'image') {
      const url = String(rawItem.url || rawItem.dataUrl || '').trim();
      if (url) {
        items.push({ type: 'image', url });
      }
      continue;
    }

    if (type === 'localImage') {
      const imagePath = String(rawItem.path || '').trim();
      if (imagePath) {
        items.push({ type: 'localImage', path: imagePath });
      }
      continue;
    }

    if (type === 'mention' || type === 'skill') {
      const name = String(rawItem.name || '').trim();
      const itemPath = String(rawItem.path || '').trim();
      if (name && itemPath) {
        items.push({ type, name, path: itemPath });
      }
    }
  }

  return items;
}

function normalizeTurnStartParams(threadId, cwd, text, options = {}) {
  const input = normalizeInputItems(text, options);
  const params = {
    threadId,
    cwd,
    approvalPolicy: typeof options.approvalPolicy === 'object'
      ? options.approvalPolicy
      : pickAllowedString(options.approvalPolicy, APPROVAL_POLICIES) || 'on-request',
    sandboxPolicy: buildSandboxPolicy(cwd, options),
    input,
  };

  if (options.collaborationMode && typeof options.collaborationMode === 'object') {
    params.collaborationMode = options.collaborationMode;
  }

  const model = String(options.model || '').trim();
  if (model) {
    params.model = model;
  }

  const effort = normalizeReasoningEffort(options.effort);
  if (effort) {
    params.effort = effort;
  }

  const summary = pickAllowedString(options.summary, REASONING_SUMMARIES);
  if (summary) {
    params.summary = summary;
  }

  const approvalsReviewer = pickAllowedString(options.approvalsReviewer, APPROVAL_REVIEWERS);
  if (approvalsReviewer) {
    params.approvalsReviewer = approvalsReviewer;
  }

  const personality = pickAllowedString(options.personality, PERSONALITIES);
  if (personality) {
    params.personality = personality;
  }

  const serviceTier = String(options.serviceTier || '').trim();
  if (serviceTier) {
    params.serviceTier = serviceTier;
  }

  return params;
}

function normalizeOfficialCollaborationMode(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const mode = String(value.mode || '').trim();
  if (mode !== 'plan' && mode !== 'default') {
    return null;
  }
  const settings = value.settings && typeof value.settings === 'object' ? value.settings : {};
  return {
    mode,
    settings: {
      model: String(settings.model || '').trim(),
      reasoning_effort: settings.reasoning_effort || settings.reasoningEffort || null,
      developer_instructions: settings.developer_instructions ?? settings.developerInstructions ?? null,
    },
  };
}

function shouldUseLocalPlanFallback(error) {
  const message = String(error?.message || error || '');
  return /collaborationMode\/list/i.test(message)
    || /collaboration mode/i.test(message)
    || /method not found/i.test(message)
    || /unknown method/i.test(message)
    || /unknown field/i.test(message)
    || /invalid params/i.test(message)
    || /did not return an official plan/i.test(message);
}

function buildLocalPlanPrompt(text, hasAttachments) {
  const request = String(text || '').trim()
    || (hasAttachments ? 'Please inspect the attached file or image inputs and propose a safe next-step plan.' : '');
  return [
    'Local Plan fallback: do not modify files, do not run destructive commands, and do not make irreversible changes.',
    'Analyze the request, list the concrete steps you would take, and call out risks or decisions that need confirmation.',
    '',
    'User request:',
    request,
  ].join('\n').trim();
}

function normalizeReviewTarget(input = {}) {
  const target = input.target && typeof input.target === 'object' ? input.target : input;
  const type = String(target.type || 'uncommittedChanges').trim();

  if (type === 'baseBranch') {
    const branch = String(target.branch || '').trim();
    if (!branch) {
      throw new Error('baseBranch review requires branch');
    }
    return { type, branch };
  }

  if (type === 'commit') {
    const sha = String(target.sha || '').trim();
    if (!sha) {
      throw new Error('commit review requires sha');
    }
    return {
      type,
      sha,
      title: String(target.title || '').trim() || null,
    };
  }

  if (type === 'custom') {
    const instructions = String(target.instructions || '').trim();
    if (!instructions) {
      throw new Error('custom review requires instructions');
    }
    return { type, instructions };
  }

  return { type: 'uncommittedChanges' };
}

function describeThreadStatus(status) {
  if (!status || typeof status !== 'object') {
    return 'unknown';
  }

  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags.join(', ') : '';
    return flags ? `active (${flags})` : 'active';
  }

  return String(status.type || 'unknown');
}

function describeCodexError(errorInfo) {
  if (!errorInfo) {
    return null;
  }

  if (typeof errorInfo === 'string') {
    return errorInfo;
  }

  if (errorInfo.httpConnectionFailed) {
    return `httpConnectionFailed${errorInfo.httpConnectionFailed.httpStatusCode ? ` (${errorInfo.httpConnectionFailed.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseStreamConnectionFailed) {
    return `responseStreamConnectionFailed${errorInfo.responseStreamConnectionFailed.httpStatusCode ? ` (${errorInfo.responseStreamConnectionFailed.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseStreamDisconnected) {
    return `responseStreamDisconnected${errorInfo.responseStreamDisconnected.httpStatusCode ? ` (${errorInfo.responseStreamDisconnected.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseTooManyFailedAttempts) {
    return `responseTooManyFailedAttempts${errorInfo.responseTooManyFailedAttempts.httpStatusCode ? ` (${errorInfo.responseTooManyFailedAttempts.httpStatusCode})` : ''}`;
  }

  if (errorInfo.activeTurnNotSteerable) {
    return `activeTurnNotSteerable (${errorInfo.activeTurnNotSteerable.turnKind || 'unknown'})`;
  }

  return summarizeValue(errorInfo);
}

class JsonRpcSession {
  constructor(child, handlers = {}) {
    this.child = child;
    this.handlers = handlers;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closedError = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.on('error', (error) => {
      this.rejectPending(error);
      if (typeof this.handlers.onError === 'function') {
        this.handlers.onError(error);
      }
    });
    child.on('exit', (code, signal) => {
      this.rejectPending(new Error(`codex app-server exited early: ${code ?? 'null'} / ${signal ?? 'null'}`));
      if (typeof this.handlers.onExit === 'function') {
        this.handlers.onExit(code, signal);
      }
    });
  }

  rejectPending(error) {
    this.closedError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }

    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8');
  }

  respondError(id, code, message) {
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    })}\n`, 'utf8');
  }

  onStdout(chunk) {
    this.buffer += chunk;

    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n');
      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!rawLine) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(rawLine);
      } catch (error) {
        if (typeof this.handlers.onRawStdout === 'function') {
          this.handlers.onRawStdout(rawLine);
        }
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'result')) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'error')) {
      const pending = this.pending.get(message.id);
      const error = new Error(message.error?.message || `JSON-RPC error for ${message.id}`);
      if (pending) {
        this.pending.delete(message.id);
        pending.reject(error);
        return;
      }

      if (typeof this.handlers.onNotification === 'function') {
        this.handlers.onNotification({
          method: 'jsonrpc.error',
          params: message.error || {},
        });
      }
      return;
    }

    if (!message.method) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      Promise.resolve()
        .then(() => this.handlers.onServerRequest && this.handlers.onServerRequest(message))
        .catch((error) => {
          this.respondError(message.id, -32000, error.message || 'server request failed');
        });
      return;
    }

    if (typeof this.handlers.onNotification === 'function') {
      this.handlers.onNotification(message);
    }
  }
}

class CodexAppServerRunner {
  constructor(options) {
    this.hostId = options.hostId;
    this.sessionId = options.sessionId;
    this.bridgeSessionId = options.bridgeSessionId || options.sessionId;
    this.runId = options.runId || null;
    this.title = options.title;
    this.cwd = options.cwd;
    this.launchMode = options.launchMode || 'fresh';
    this.originSessionId = options.originSessionId || null;
    this.sourceSessionId = options.sourceSessionId || null;
    this.conversationKey = options.conversationKey || this.originSessionId || this.bridgeSessionId;
    this.bootstrap = options.bootstrap || null;
    this.postEvent = options.postEvent;
    this.onTerminated = options.onTerminated || null;
    this.apiConfig = normalizeApiConfig(options.apiConfig);
    this.apiBinding = deriveRunBinding({
      apiBinding: options.apiBinding,
      apiConfig: this.apiConfig,
      env: options.env || process.env,
      codexHome: options.codexHome,
      allowUnavailable: true,
    });
    this.baseCodexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const preparedCodexHome = prepareApiProfileCodexHome(this.baseCodexHome, this.apiConfig, {
      sessionId: this.sessionId,
      bridgeSessionId: this.bridgeSessionId,
      nativeThreadId: options.nativeThreadId || null,
      sourceSessionId: this.sourceSessionId,
      originSessionId: this.originSessionId,
      conversationKey: this.conversationKey,
      runId: this.runId,
    });
    try {
      this.codexHome = preparedCodexHome.codexHome;
      this.apiProfileHome = preparedCodexHome.profileHome;
      this.isolatedCodexHome = preparedCodexHome.isolatedHome;
      this.profileHomeDir = preparedCodexHome.profileHomeDir || null;
      this.apiProfileCleanupOwner = preparedCodexHome.cleanupOwner || null;
      this.apiProviderKey = preparedCodexHome.providerKey || null;
      this.spawnProcess = typeof options.spawnProcess === 'function' ? options.spawnProcess : spawn;
      this.codexBin = options.codexBin || resolveDefaultCodexBin(this.baseCodexHome);
      this.codexArgs = Array.isArray(options.codexArgs) && options.codexArgs.length
        ? options.codexArgs.map((value) => String(value))
        : ['app-server'];
      this.child = null;
      this.rpc = null;
      this.stopRequested = false;
      this.stopGraceTimeoutMs = Math.max(1, Number(options.stopGraceTimeoutMs || 5000) || 5000);
      this.stopKillTimeoutMs = Math.max(1, Number(options.stopKillTimeoutMs || 1000) || 1000);
      this.suppressTerminalEvent = false;
      this.terminationPromise = null;
      this.startCompleted = false;
      this.childExitConfirmed = false;
      this.startupRetryExit = null;
      this.startupRetryExitResolver = null;
      this.startRetryPending = false;
      this.startRetryFailure = null;
      this.processTreeFallbackRequired = false;
      this.overlayCleaned = false;
      this.threadId = null;
      this.nativeThreadId = options.nativeThreadId || null;
      this.activeTurnId = null;
      this.turnBuffers = new Map();
      this.turnModes = new Map();
      this.planBuffers = new Map();
      this.reasoningBuffers = new Map();
      this.notificationHandlers = new Set();
      this.initializeThinkingActivity();
      this.pendingRequests = new Map();
      this.modelCapabilities = new Map();
      this.resumePrelude = buildResumePrelude(this.bootstrap);
      this.resumePreludeUsed = !this.resumePrelude;
      this.runtime = {
        kind: 'codex_app_server',
        adapterId: 'codex-app-server',
        runtimeId: 'codex-app-server',
        runId: this.runId,
        runtimeLabel: 'Codex app-server',
        command: this.codexBin,
        args: this.codexArgs,
        cwd: this.cwd,
        codexHome: this.codexHome,
        nativeThreadId: this.nativeThreadId || null,
        launchMode: this.launchMode,
        codexHomeProfile: this.apiProfileHome ? 'api-profile-isolated' : 'managed-isolated',
        apiProfileId: this.apiConfig?.profileId || null,
        apiProfileLabel: this.apiConfig?.label || null,
        apiProvider: this.apiConfig?.provider || null,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey,
        apiBinding: this.apiBinding,
        resumeStrategy: 'fresh',
        connection: 'starting',
        phase: 'starting',
        startupStep: 'starting',
        busy: false,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        updatedAt: nowIso(),
      };
    } catch (error) {
      try {
        cleanupApiProfileCodexHome(preparedCodexHome.cleanupOwner);
      } catch {
        // Preserve the constructor error; the startup janitor can retry owned cleanup.
      }
      throw error;
    }
  }

  assertCommandBinding(explicitBinding) {
    if (!this.apiBinding && !explicitBinding) {
      return null;
    }
    return assertRunBinding(this.apiBinding, explicitBinding);
  }

  validateModelSelection(model, effort) {
    return validateRuntimeModelSelection(this.modelCapabilities, model, effort);
  }

  enqueueNotification(message) {
    if (!this.notificationHandlers) this.notificationHandlers = new Set();
    const handling = this.handleNotification(message)
      .catch((error) => {
        console.error(`[codex-runner] notification failed: ${error.message || error}`);
      });
    this.notificationHandlers.add(handling);
    handling.finally(() => this.notificationHandlers.delete(handling));
    return handling;
  }

  async drainNotifications() {
    while (this.notificationHandlers?.size) {
      await Promise.all(Array.from(this.notificationHandlers));
    }
  }

  activityCanonicalConversationKey() {
    const hostId = String(this.hostId || '').trim();
    const conversationKey = String(
      this.conversationKey
        || this.originSessionId
        || this.nativeThreadId
        || this.bridgeSessionId
        || this.sessionId
        || ''
    ).trim();
    if (!hostId) return conversationKey;
    return conversationKey.startsWith(`${hostId}::`)
      ? conversationKey
      : `${hostId}::${conversationKey}`;
  }

  initializeThinkingActivity(options = {}) {
    this.thinkingActivities = new Map();
    this.activitySnapshotDelivery = Promise.resolve();
    this.activitySnapshotDeliveryErrors = new Map();
    this.thinkingActivityAggregator = new ThinkingActivityAggregator({
      canonicalConversationKey: this.activityCanonicalConversationKey(),
      runId: this.runId,
      flushDelayMs: 75,
      emitSnapshot: (snapshot) => this.emitActivitySnapshot(snapshot),
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      now: options.now,
    });
  }

  ensureThinkingActivityAggregator() {
    if (!this.thinkingActivityAggregator) {
      this.initializeThinkingActivity();
    }
    return this.thinkingActivityAggregator;
  }

  normalizeThinkingIdentity(identity = {}) {
    const turnId = String(identity.turnId || '').trim();
    const itemId = String(identity.itemId || '').trim();
    if (!turnId || !itemId) return null;
    const summaryIndex = Number(identity.summaryIndex ?? 0);
    return {
      turnId,
      itemId,
      summaryIndex: Number.isFinite(summaryIndex) ? summaryIndex : 0,
      kind: 'reasoning',
    };
  }

  trackThinkingActivity(identity) {
    const normalized = this.normalizeThinkingIdentity(identity);
    if (!normalized) return null;
    const activityKey = makeActivityKey({
      canonicalConversationKey: this.activityCanonicalConversationKey(),
      runId: this.runId,
      ...normalized,
    });
    let tracked = this.thinkingActivities.get(activityKey);
    if (!tracked) {
      tracked = { activityKey, identity: normalized, finalized: false };
      this.thinkingActivities.set(activityKey, tracked);
    }
    return tracked;
  }

  appendThinkingDelta(identity, delta) {
    const tracked = this.trackThinkingActivity(identity);
    if (!tracked) return null;
    tracked.finalized = false;
    this.ensureThinkingActivityAggregator().appendDelta(tracked.identity, String(delta ?? ''));
    return tracked;
  }

  replaceThinkingSnapshot(identity, text) {
    const tracked = this.trackThinkingActivity(identity);
    if (!tracked) return null;
    tracked.finalized = false;
    this.ensureThinkingActivityAggregator().replaceSnapshot(tracked.identity, String(text ?? ''));
    return tracked;
  }

  emitActivitySnapshot(snapshot) {
    const event = {
      type: 'session.activity_snapshot',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      conversationKey: this.conversationKey || null,
      bridgeSessionId: this.bridgeSessionId || null,
      nativeThreadId: this.nativeThreadId || null,
      originSessionId: this.originSessionId || null,
      sourceSessionId: this.sourceSessionId || null,
      ...snapshot,
    };
    const activityKey = String(snapshot.activityKey || '');
    const delivery = this.activitySnapshotDelivery.then(async () => {
      try {
        await this.postEvent(event);
        this.activitySnapshotDeliveryErrors.delete(activityKey);
      } catch (error) {
        this.activitySnapshotDeliveryErrors.set(activityKey, error);
      }
    });
    this.activitySnapshotDelivery = delivery;
    return delivery;
  }

  async finalizeThinkingActivities(filter = {}) {
    if (!this.thinkingActivityAggregator) return [];
    const selected = Array.from(this.thinkingActivities.values()).filter((tracked) => {
      if (tracked.finalized) return false;
      if (filter.turnId != null && tracked.identity.turnId !== String(filter.turnId)) return false;
      if (filter.itemId != null && tracked.identity.itemId !== String(filter.itemId)) return false;
      return true;
    });
    for (const tracked of selected) tracked.finalized = true;

    const snapshots = [];
    for (const tracked of selected) {
      snapshots.push(await this.thinkingActivityAggregator.flush(tracked.identity, { final: true }));
    }
    await this.activitySnapshotDelivery;

    const failures = selected
      .map((tracked) => this.activitySnapshotDeliveryErrors.get(tracked.activityKey))
      .filter(Boolean);
    if (failures.length) {
      for (const tracked of selected) tracked.finalized = false;
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, 'Thinking activity snapshot delivery failed.');
    }
    return snapshots;
  }

  async start() {
    if (this.stopRequested) {
      const error = new Error('Managed Codex startup was cancelled before spawn.');
      error.code = 'session_start_cancelled';
      error.failureState = 'failed:start-cancelled';
      throw error;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.startupStateDbError = false;
      try {
        await this.startOnce();
        if (this.stopRequested) {
          const error = new Error('Managed Codex startup was cancelled before confirmation.');
          error.code = 'session_start_cancelled';
          error.failureState = 'failed:start-cancelled';
          throw error;
        }
        this.startCompleted = true;
        return;
      } catch (error) {
        if (attempt === 0 && this.startupStateDbError) {
          try {
            await this.stopChildForStartupRetry();
          } catch (stopError) {
            this.startupStateDbError = false;
            stopError.cause = stopError.cause || error;
            throw stopError;
          }
          const repair = quarantineCodexStateDatabases(this.codexHome, 'startup');
          await this.emitDiagnostic({
            severity: repair.moved.length ? 'warning' : 'error',
            source: 'runtime',
            kind: 'sqlite-repair',
            message: repair.moved.length
              ? 'Moved corrupted Codex SQLite state files and retrying app-server startup.'
              : 'Codex SQLite state looked corrupted, but no state files could be moved automatically.',
            data: repair,
          }).catch(() => {});
          if (repair.moved.length) {
            continue;
          }
        }
        this.startupStateDbError = false;
        throw error;
      }
    }
  }

  async stopChildForStartupRetry() {
    if (this.terminationPromise || this.overlayCleaned) {
      const error = new Error('Codex startup retry cannot reuse a finalized managed overlay.');
      error.code = 'session_start_retry_overlay_finalized';
      throw error;
    }
    const child = this.child;
    if (!child) {
      this.rpc = null;
      return;
    }

    let resolveExitConfirmation;
    const exitConfirmation = new Promise((resolve) => {
      resolveExitConfirmation = resolve;
    });
    const onExit = (code, signal) => {
      resolveExitConfirmation();
      this.handleExit(code, signal).catch(() => {});
    };
    child.once('exit', onExit);
    this.startupRetryExitResolver = resolveExitConfirmation;
    if (
      this.startupRetryExit
      || child.exitCode !== null
      || child.signalCode !== null
    ) {
      resolveExitConfirmation();
    }
    const waitForExit = async (timeoutMs) => {
      let timer = null;
      const confirmed = await Promise.race([
        exitConfirmation.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      return confirmed;
    };

    try {
      let confirmed = Boolean(
        this.startupRetryExit
        || child.exitCode !== null
        || child.signalCode !== null
      );
      if (!confirmed) {
        try {
          child.kill();
        } catch {
          // The exit confirmation below remains authoritative.
        }
        confirmed = await waitForExit(this.stopGraceTimeoutMs);
      }
      if (!confirmed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The bounded confirmation below decides whether retry is safe.
        }
        confirmed = await waitForExit(this.stopKillTimeoutMs);
      }
      if (!confirmed) {
        const error = new Error(
          `Codex app-server did not confirm exit before SQLite retry after ${this.stopGraceTimeoutMs + this.stopKillTimeoutMs}ms.`
        );
        error.code = 'session_stop_timeout';
        error.processTreeFallbackRequired = true;
        throw error;
      }
    } finally {
      child.off('exit', onExit);
      this.startupRetryExitResolver = null;
    }

    if (this.terminationPromise || this.overlayCleaned) {
      const error = new Error('Codex startup retry overlay was finalized while stopping the first child.');
      error.code = 'session_start_retry_overlay_finalized';
      throw error;
    }
    if (!updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
      childPid: child.pid || null,
      childState: 'exited',
    })) {
      const error = new Error('Managed Codex overlay ownership could not confirm the first retry child exit.');
      error.code = 'session_overlay_ownership_update_failed';
      throw error;
    }
    this.child = null;
    this.rpc = null;
    this.childExitConfirmed = false;
    this.startupRetryExit = null;
  }

  async startOnce() {
    const processHome = this.profileHomeDir || path.dirname(this.baseCodexHome);
    const threadApiParams = this.apiProviderKey ? { modelProvider: this.apiProviderKey } : {};
    if (!updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
      childPid: null,
      childState: 'spawning',
    })) {
      const error = new Error('Managed Codex overlay ownership could not enter spawning state.');
      error.code = 'session_overlay_ownership_update_failed';
      throw error;
    }
    try {
      this.child = this.spawnProcess(this.codexBin, this.codexArgs, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: shouldSpawnCodexThroughShell(this.codexBin),
        windowsHide: true,
        env: {
          ...process.env,
          ...buildApiEnvironment(this.apiConfig),
          CODEX_HOME: this.codexHome,
          PATH: buildCodexProcessPath(this.codexBin),
          HOME: processHome,
          USERPROFILE: processHome,
          HOMEDRIVE: (path.parse(processHome).root || process.env.HOMEDRIVE || '').replace(/\\$/, ''),
          HOMEPATH: processHome.replace(/^[A-Za-z]:/, '') || process.env.HOMEPATH || '',
        },
      });
    } catch (error) {
      updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
        childPid: null,
        childState: 'spawn-failed',
      });
      throw error;
    }
    let spawnError = null;
    let earlyExitError = null;
    let spawnHandshakeSettled = false;
    let resolveSpawnHandshake;
    let rejectSpawnHandshake;
    const spawnHandshake = new Promise((resolve, reject) => {
      resolveSpawnHandshake = resolve;
      rejectSpawnHandshake = reject;
    });
    const settleSpawnHandshake = (settle, value) => {
      if (spawnHandshakeSettled) return;
      spawnHandshakeSettled = true;
      settle(value);
    };
    const onEarlyError = (error) => {
      spawnError = error;
      this.emitAlert({
        severity: 'error',
        source: 'runtime',
        message: `codex app-server failed to start: ${formatCodexStartError(error)}`,
      }).catch(() => {});
      settleSpawnHandshake(rejectSpawnHandshake, error);
    };
    const onEarlyExit = (code, signal) => {
      earlyExitError = new Error(`codex app-server exited early: ${code ?? 'null'} / ${signal ?? 'null'}`);
      settleSpawnHandshake(rejectSpawnHandshake, earlyExitError);
      this.handleExit(code, signal).catch(() => {});
    };
    const onSpawned = () => {
      try {
        if (!this.child.pid) {
          const error = new Error('Codex app-server spawn did not provide a child PID.');
          error.code = 'session_spawn_pid_missing';
          throw error;
        }
        if (!updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
          childPid: this.child.pid,
          childState: 'running',
        })) {
          const error = new Error('Managed Codex overlay ownership could not record the spawned child.');
          error.code = 'session_overlay_ownership_update_failed';
          throw error;
        }
        settleSpawnHandshake(resolveSpawnHandshake);
      } catch (error) {
        settleSpawnHandshake(rejectSpawnHandshake, error);
      }
    };
    this.child.once('error', onEarlyError);
    this.child.once('exit', onEarlyExit);
    this.child.once('spawn', onSpawned);

    try {
      await spawnHandshake;
    } catch (error) {
      if (error === spawnError) throw new Error(formatCodexStartError(error));
      throw error;
    }

    await this.emitRuntime({
      connection: 'connecting',
      phase: 'booting',
      startupStep: 'spawned-app-server',
      busy: true,
    });
    if (spawnError) throw new Error(formatCodexStartError(spawnError));
    if (earlyExitError) throw earlyExitError;

    const stderr = readline.createInterface({
      input: this.child.stderr,
      crlfDelay: Infinity,
    });

    stderr.on('line', async (line) => {
      const text = stripAnsi(line);
      const summary = text.length > 420 ? `${text.slice(0, 417)}...` : text;
      if (isCodexStateDatabaseError(text)) {
        this.startupStateDbError = true;
        const hint = codexStateDatabaseHint(text);
        await this.emitDiagnostic({
          severity: 'error',
          source: 'stderr',
          kind: 'runtime-startup',
          message: 'Codex state database is not readable.',
          detail: hint,
        }).catch(() => {});
        await this.emitAlert({
          severity: 'error',
          source: 'runtime',
          message: hint,
        }).catch(() => {});
        return;
      }
      if (isRuntimeDiagnosticStderrLine(text)) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'stderr',
          kind: 'runtime-startup',
          message: summary,
        }).catch(() => {});
        return;
      }
      if (!shouldSurfaceStderrLine(text)) {
        return;
      }
      await this.emitAlert({
        severity: 'warning',
        source: 'stderr',
        message: summary,
      }).catch(() => {});
    });

    this.rpc = new JsonRpcSession(this.child, {
      onNotification: (message) => {
        this.enqueueNotification(message);
      },
      onServerRequest: (message) => this.handleServerRequest(message),
      onRawStdout: () => {},
      onError: (error) => {
        this.emitAlert({
          severity: 'error',
          source: 'runtime',
          message: `codex app-server failed to start: ${formatCodexStartError(error)}`,
        }).catch(() => {});
      },
      onExit: (code, signal) => {
        this.handleExit(code, signal).catch(() => {});
      },
    });
    this.child.off('error', onEarlyError);
    this.child.off('exit', onEarlyExit);
    if (spawnError) throw new Error(formatCodexStartError(spawnError));
    if (earlyExitError) throw earlyExitError;

    await this.emitRuntime({
      connection: 'connecting',
      phase: 'initializing',
      startupStep: 'initialize-app-server',
      busy: true,
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'lifecycle',
      method: 'app-server/initialize',
      message: 'Initializing Codex app-server.',
      data: {
        launchMode: this.launchMode,
        nativeThreadId: this.nativeThreadId || null,
        codexHome: this.codexHome,
        processHome,
      },
    }).catch(() => {});
    await this.rpc.request('initialize', {
      clientInfo: {
        name: 'mobile-codex-remote',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }, INITIALIZE_REQUEST_TIMEOUT_MS);

    await this.emitRuntime({
      connection: 'ready',
      phase: 'opening-thread',
      startupStep: 'opening-thread',
      busy: true,
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'api-profile',
      message: this.apiConfig
        ? `Using API profile ${describeApiConfig(this.apiConfig)}.`
        : 'Using host environment API configuration.',
      data: {
        apiProfileId: this.apiConfig?.profileId || null,
        apiProfileLabel: this.apiConfig?.label || null,
        apiProvider: this.apiConfig?.provider || null,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey || null,
        baseCodexHome: this.baseCodexHome,
        codexHome: this.codexHome,
        isolatedCodexHome: this.isolatedCodexHome,
        processHome,
      },
    });

    const startTranscriptFallbackThread = async (reason = null) => {
      if (reason) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'native-thread-fallback',
          message: 'Native Codex thread was not available; started a live session from transcript context instead.',
          detail: String(reason.message || reason).slice(0, 500),
        }).catch(() => {});
      }
      await this.emitRuntime({
        connection: 'ready',
        phase: 'starting-thread',
        startupStep: reason ? 'thread-start-fallback' : 'thread-start',
        busy: true,
      });
      await this.emitDiagnostic({
        severity: reason ? 'warning' : 'info',
        source: 'codex',
        kind: 'lifecycle',
        method: 'thread/start',
        message: reason
          ? 'Starting a fallback Codex thread from transcript context.'
          : 'Starting a new Codex thread.',
        detail: reason ? String(reason.message || reason).slice(0, 500) : undefined,
        data: {
          launchMode: this.launchMode,
          nativeThreadId: this.nativeThreadId || null,
        },
      }).catch(() => {});
      const fallbackThread = await this.rpc.request('thread/start', {
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        personality: 'friendly',
        ...threadApiParams,
      }, THREAD_OPEN_REQUEST_TIMEOUT_MS);
      this.runtime.resumeStrategy = resumeStrategyForLaunchMode(this.launchMode);
      return fallbackThread;
    };

    let thread = null;
    if (this.launchMode === 'resume') {
      if (!this.nativeThreadId) {
        throw classifyNativeThreadError('resume', new Error('native thread id is missing'));
      }
      try {
        await this.emitRuntime({
          connection: 'ready',
          phase: 'resuming-thread',
          startupStep: 'thread-resume',
          busy: true,
        });
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: 'lifecycle',
          method: 'thread/resume',
          message: `Resuming Codex thread ${limitText(this.nativeThreadId, 64)}.`,
          data: {
            launchMode: this.launchMode,
            nativeThreadId: this.nativeThreadId,
          },
        }).catch(() => {});
        thread = await this.rpc.request('thread/resume', {
          threadId: this.nativeThreadId,
          cwd: this.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          personality: 'friendly',
          ...threadApiParams,
        }, THREAD_OPEN_REQUEST_TIMEOUT_MS);
        this.runtime.resumeStrategy = 'native_resume';
      } catch (error) {
        throw classifyNativeThreadError('resume', error);
      }
    } else if (this.launchMode === 'fork') {
      if (!this.nativeThreadId) {
        throw classifyNativeThreadError('fork', new Error('native thread id is missing'));
      }
      try {
        await this.emitRuntime({
          connection: 'ready',
          phase: 'forking-thread',
          startupStep: 'thread-fork',
          busy: true,
        });
        await this.emitDiagnostic({
          severity: 'info',
          source: 'codex',
          kind: 'lifecycle',
          method: 'thread/fork',
          message: `Forking Codex thread ${limitText(this.nativeThreadId, 64)}.`,
          data: {
            launchMode: this.launchMode,
            nativeThreadId: this.nativeThreadId,
          },
        }).catch(() => {});
        thread = await this.rpc.request('thread/fork', {
          threadId: this.nativeThreadId,
          cwd: this.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          ephemeral: false,
          threadSource: 'user',
          ...threadApiParams,
        }, THREAD_OPEN_REQUEST_TIMEOUT_MS);
        this.runtime.resumeStrategy = 'native_fork';
      } catch (error) {
        throw classifyNativeThreadError('fork', error);
      }
    } else if (this.launchMode === 'transcript_fallback') {
      if (!this.resumePrelude) {
        const error = new Error('Transcript fallback requires non-empty bounded history.');
        error.code = 'session_history_unavailable';
        throw error;
      }
      thread = await startTranscriptFallbackThread(new Error('Explicit transcript fallback requested.'));
    } else {
      thread = await startTranscriptFallbackThread();
    }

    this.threadId = thread?.thread?.id || null;
    if (!this.threadId) {
      throw new Error('app-server did not return thread.id');
    }
    this.sessionId = this.threadId;
    this.nativeThreadId = this.threadId;
    this.runtime.nativeThreadId = this.threadId;
    await this.emitRuntime({
      connection: 'ready',
      threadId: this.threadId,
      phase: 'idle',
      startupStep: 'ready',
      busy: false,
    });
  }

  async sendInput(text, options = {}) {
    if (!this.threadId) {
      throw new Error('codex thread is not ready yet');
    }

    const explicitBinding = options.apiBinding || (options.apiConfig
      ? deriveRunBinding({ apiConfig: options.apiConfig, allowUnavailable: true })
      : null);
    this.assertCommandBinding(explicitBinding);
    this.validateModelSelection(options.model, options.effort);

    if (this.activeTurnId) {
      throw new Error('Codex is still working on the previous turn.');
    }

    const normalizedItems = normalizeInputItems(text, options);
    if (!normalizedItems.length) {
      return null;
    }

    let prompt = String(text || '').trim();
    if (!this.resumePreludeUsed && this.resumePrelude) {
      prompt = `${this.resumePrelude}\n\nNew user request:\n${prompt}`;
      this.resumePreludeUsed = true;
      await this.emitOutput('[codex] continuing from imported history context', 'stderr');
    }

    let collaborationMode = normalizeOfficialCollaborationMode(options.collaborationMode);
    const mode = String(options.mode || '').trim();
    if (!collaborationMode && mode === 'plan') {
      try {
        collaborationMode = await this.getOfficialCollaborationMode('plan');
      } catch (error) {
        if (String(options.planFallback || '').trim() !== 'local' || !shouldUseLocalPlanFallback(error)) {
          throw error;
        }
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'control',
          method: 'collaborationMode/list',
          message: `Native Codex Plan is unavailable; using Local Plan fallback: ${error.message}`,
          data: { error: error.message },
        });
      }
    }

    const localPlanFallback = mode === 'plan' && !collaborationMode && String(options.planFallback || '').trim() === 'local';
    const effectivePrompt = localPlanFallback
      ? buildLocalPlanPrompt(prompt, normalizedItems.some((item) => item.type === 'image' || item.type === 'localImage'))
      : prompt;
    const effectiveOptions = localPlanFallback
      ? {
        ...options,
        collaborationMode: null,
        approvalPolicy: 'never',
        sandboxMode: 'readOnly',
      }
      : options;

    const params = normalizeTurnStartParams(this.threadId, this.cwd, effectivePrompt, effectiveOptions);
    if (collaborationMode) {
      params.collaborationMode = collaborationMode;
    }
    await this.emitRuntime({
      busy: true,
      phase: 'submitting-turn',
      currentTurnStatus: 'submitting',
      pendingInputSummary: limitText(effectivePrompt, 240),
      model: params.model || null,
      effort: params.effort || null,
      summary: params.summary || null,
      collaborationMode: params.collaborationMode || null,
      approvalPolicy: params.approvalPolicy || null,
      approvalsReviewer: params.approvalsReviewer || null,
      sandboxPolicy: params.sandboxPolicy || null,
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'turn/start',
      message: collaborationMode?.mode === 'plan'
        ? 'Starting a plan-mode turn.'
        : localPlanFallback
          ? 'Starting a Local Plan fallback turn.'
        : 'Starting a Codex turn.',
      data: {
        model: params.model || null,
        effort: params.effort || null,
        summary: params.summary || null,
        collaborationMode: params.collaborationMode || null,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey || null,
        codexHomeProfile: this.runtime.codexHomeProfile || null,
        approvalPolicy: params.approvalPolicy || null,
        approvalsReviewer: params.approvalsReviewer || null,
        sandboxPolicy: params.sandboxPolicy || null,
        localPlanFallback,
        inputTypes: params.input.map((item) => item.type),
      },
    });

    let turn = null;
    try {
      turn = await this.rpc.request('turn/start', params, TURN_START_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (
        mode === 'plan'
        && collaborationMode
        && String(options.planFallback || '').trim() === 'local'
        && shouldUseLocalPlanFallback(error)
      ) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'control',
          method: 'turn/start',
          message: `Native Codex Plan turn failed; retrying with Local Plan fallback: ${error.message}`,
          data: { error: error.message, collaborationMode },
        });
        const fallbackParams = normalizeTurnStartParams(
          this.threadId,
          this.cwd,
          buildLocalPlanPrompt(prompt, normalizedItems.some((item) => item.type === 'image' || item.type === 'localImage')),
          {
            ...options,
            collaborationMode: null,
            approvalPolicy: 'never',
            sandboxMode: 'readOnly',
          }
        );
        await this.emitRuntime({
          busy: true,
          phase: 'submitting-turn',
          currentTurnStatus: 'submitting',
          pendingInputSummary: limitText(prompt, 240),
          model: fallbackParams.model || null,
          effort: fallbackParams.effort || null,
          summary: fallbackParams.summary || null,
          collaborationMode: null,
          approvalPolicy: fallbackParams.approvalPolicy || null,
          approvalsReviewer: fallbackParams.approvalsReviewer || null,
          sandboxPolicy: fallbackParams.sandboxPolicy || null,
        });
        turn = await this.rpc.request('turn/start', fallbackParams, TURN_START_REQUEST_TIMEOUT_MS);
        Object.keys(params).forEach((key) => delete params[key]);
        Object.assign(params, fallbackParams);
        collaborationMode = null;
      } else {
        await this.emitRuntime({
          activeTurnId: null,
          busy: false,
          phase: 'error',
          currentTurnStatus: 'failed',
          pendingInputSummary: null,
          lastCodexError: error.message || String(error),
        }).catch(() => {});
        throw error;
      }
    }

    const turnId = turn?.turn?.id || null;
    if (turnId) {
      this.activeTurnId = turnId;
      this.turnBuffers.set(turnId, '');
      this.turnModes.set(turnId, collaborationMode?.mode || mode || 'default');
      await this.emitRuntime({
        activeTurnId: turnId,
        busy: true,
        phase: (collaborationMode?.mode === 'plan' || mode === 'plan') ? 'planning' : 'thinking',
        currentTurnStatus: 'inProgress',
        model: params.model || null,
        effort: params.effort || null,
        summary: params.summary || null,
        collaborationMode: params.collaborationMode || null,
        approvalPolicy: params.approvalPolicy || null,
        approvalsReviewer: params.approvalsReviewer || null,
        sandboxPolicy: params.sandboxPolicy || null,
        reasoningSummary: null,
        planSummary: null,
      });
    }
    await this.postEvent({
      type: 'session.selection_confirmed',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      model: params.model || null,
      effort: params.effort || null,
      effectiveBinding: this.apiBinding,
      timestamp: nowIso(),
    }).catch(() => {});
    return turnId;
  }

  async getOfficialCollaborationMode(modeName) {
    const response = await this.rpc.request('collaborationMode/list', {});
    const modes = Array.isArray(response?.data) ? response.data : [];
    const match = modes.find((entry) => String(entry?.mode || '').trim() === modeName)
      || modes.find((entry) => String(entry?.name || '').trim().toLowerCase() === modeName);
    if (!match) {
      throw new Error(`Codex app-server did not return an official ${modeName} collaboration mode.`);
    }
    const model = String(match.model || '').trim();
    if (!model) {
      throw new Error(`Official ${modeName} collaboration mode is missing required settings.model.`);
    }
    return {
      mode: modeName,
      settings: {
        model,
        reasoning_effort: match.reasoning_effort || match.reasoningEffort || null,
        developer_instructions: null,
      },
    };
  }

  async listModels(options = {}) {
    const response = await this.rpc.request('model/list', {
      cursor: options.cursor || null,
      includeHidden: options.includeHidden === true ? true : null,
      limit: Number(options.limit || 80) || 80,
    }, LIST_REQUEST_TIMEOUT_MS);
    const pageCapabilities = modelCapabilitiesFromList(response?.data || []);
    if (!options.cursor) {
      this.modelCapabilities.clear();
    }
    for (const [model, metadata] of pageCapabilities) {
      this.modelCapabilities.set(model, metadata);
    }
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'model/list',
      message: `Loaded ${Array.isArray(response?.data) ? response.data.length : 0} models.`,
      data: {
        nextCursor: response?.nextCursor || null,
      },
    });
    return {
      ...(response || { data: [], nextCursor: null }),
      bindingFingerprint: this.apiBinding?.bindingFingerprint || null,
      runId: this.runId,
    };
  }

  async listSkills(options = {}) {
    const cwd = String(options.cwd || this.cwd || '').trim();
    const response = await this.rpc.request('skills/list', {
      cwds: cwd ? [cwd] : undefined,
      forceReload: options.forceReload === true,
    }, LIST_REQUEST_TIMEOUT_MS);
    const entries = Array.isArray(response?.data) ? response.data : [];
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'skills/list',
      message: `Loaded ${entries.reduce((sum, entry) => sum + (Array.isArray(entry?.skills) ? entry.skills.length : 0), 0)} skills.`,
      data: {
        cwd: cwd || null,
        entries: entries.length,
      },
    });
    return response || { data: [] };
  }

  async startReview(options = {}) {
    if (!this.threadId) {
      throw new Error('No thread is available for review.');
    }

    if (this.activeTurnId) {
      throw new Error('Codex is still working on the previous turn.');
    }

    const target = normalizeReviewTarget(options);
    const delivery = String(options.delivery || 'inline').trim() === 'detached' ? 'detached' : 'inline';
    await this.emitRuntime({
      busy: true,
      phase: 'reviewing',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'review/start',
      message: `Review requested: ${target.type}`,
      data: {
        target,
        delivery,
      },
    });

    const response = await this.rpc.request('review/start', {
      threadId: this.threadId,
      target,
      delivery,
    });
    const turnId = response?.turn?.id || null;
    if (turnId) {
      this.activeTurnId = turnId;
      this.turnBuffers.set(turnId, '');
      await this.emitRuntime({
        activeTurnId: turnId,
        busy: true,
        phase: 'reviewing',
        currentTurnStatus: response?.turn?.status?.type || 'inProgress',
      });
    }
    await this.postEvent({
      type: 'session.review_started',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      reviewThreadId: response?.reviewThreadId || null,
      turnId,
      target,
      delivery,
      timestamp: nowIso(),
    });
    return response;
  }

  cleanupManagedOverlay() {
    if (this.overlayCleaned) return false;
    const cleaned = cleanupApiProfileCodexHome(this.apiProfileCleanupOwner);
    if (cleaned) this.overlayCleaned = true;
    return cleaned;
  }

  async stop(options = {}) {
    if (options.suppressTerminalEvent === true || options.deferStartupTerminalEvent === true) {
      this.suppressTerminalEvent = true;
    }
    this.stopRequested = true;
    const terminalErrors = [];
    let activityFlushError = null;
    try {
      await this.drainNotifications();
      await this.finalizeThinkingActivities();
    } catch (error) {
      activityFlushError = error;
    }
    const finishStop = () => {
      if (
        activityFlushError
        && this.activitySnapshotDeliveryErrors?.size
        && !terminalErrors.includes(activityFlushError)
      ) {
        terminalErrors.push(activityFlushError);
      }
      throwTerminalErrors(terminalErrors, 'Codex runner stop did not complete cleanly.');
    };
    const child = this.child;
    if (!child) {
      if (!this.terminationPromise) {
        this.terminationPromise = this.finalizePreSpawnCancellation();
      }
      try {
        await this.terminationPromise;
      } catch (error) {
        terminalErrors.push(error);
      }
      finishStop();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      try {
        if (this.terminationPromise) {
          await this.terminationPromise;
        } else {
          await this.handleExit(child.exitCode, child.signalCode);
        }
      } catch (error) {
        terminalErrors.push(error);
      }
      finishStop();
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off('exit', finish);
        child.off('error', finish);
        resolve();
      };
      const timer = setTimeout(finish, this.stopGraceTimeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      child.once('exit', finish);
      child.once('error', finish);
      if (!child.killed) {
        child.kill();
      }
    });
    if (
      !this.terminationPromise
      && child.exitCode === null
      && child.signalCode === null
    ) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off('exit', finish);
          child.off('error', finish);
          resolve();
        };
        const timer = setTimeout(finish, this.stopKillTimeoutMs);
        timer.unref?.();
        child.once('exit', finish);
        child.once('error', finish);
        child.kill('SIGKILL');
      });
    }
    if (this.terminationPromise) {
      try {
        await this.terminationPromise;
      } catch (error) {
        terminalErrors.push(error);
      }
    } else if (child.exitCode !== null || child.signalCode !== null) {
      try {
        await this.handleExit(child.exitCode, child.signalCode);
      } catch (error) {
        terminalErrors.push(error);
      }
    } else {
      const error = new Error(
        `Codex app-server did not confirm exit after ${this.stopGraceTimeoutMs + this.stopKillTimeoutMs}ms.`
      );
      error.code = 'session_stop_timeout';
      error.processTreeFallbackRequired = true;
      terminalErrors.push(error);
    }
    finishStop();
  }

  async interruptTurn() {
    if (!this.threadId || !this.activeTurnId) {
      return false;
    }

    const interruptedTurnId = this.activeTurnId;
    await this.emitRuntime({
      busy: true,
      phase: 'interrupting',
      currentTurnStatus: 'inProgress',
    });
    await this.rpc.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: interruptedTurnId,
    });
    let activityFlushError = null;
    try {
      await this.drainNotifications();
      await this.finalizeThinkingActivities({ turnId: interruptedTurnId });
    } catch (error) {
      activityFlushError = error;
    }
    if (this.activeTurnId === interruptedTurnId) {
      this.activeTurnId = null;
      this.turnBuffers.delete(interruptedTurnId);
      this.turnModes.delete(interruptedTurnId);
      this.planBuffers.delete(interruptedTurnId);
      this.reasoningBuffers.delete(interruptedTurnId);
    }
    await this.emitDiagnostic({
      severity: 'warning',
      source: 'codex',
      kind: 'control',
      method: 'turn/interrupt',
      message: 'Interrupt requested for the active turn.',
    });
    await this.resolvePendingRequestsForClosedTurn(
      'interrupted',
      'Request closed because the Codex turn was interrupted.'
    );
    await this.emitRuntime({
      activeTurnId: null,
      busy: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      phase: 'interrupted',
      currentTurnStatus: 'interrupted',
    });
    if (activityFlushError) throw activityFlushError;
    return true;
  }

  async steerTurn(text) {
    if (!this.threadId || !this.activeTurnId) {
      throw new Error('No active turn is available to steer.');
    }

    const prompt = String(text || '').trim();
    if (!prompt) {
      return null;
    }

    await this.emitRuntime({
      busy: true,
      phase: 'thinking',
      currentTurnStatus: 'inProgress',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'turn/steer',
      message: `Steering active turn with ${prompt.length} characters.`,
      data: {
        turnId: this.activeTurnId,
        text: limitText(prompt, 240),
      },
    });

    await this.rpc.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    });
    return this.activeTurnId;
  }

  async compactThread(options = {}) {
    if (!this.threadId) {
      throw new Error('No thread is available to compact.');
    }

    const explicitBinding = options.apiBinding || (options.apiConfig
      ? deriveRunBinding({ apiConfig: options.apiConfig, allowUnavailable: true })
      : null);
    this.assertCommandBinding(explicitBinding);

    await this.emitRuntime({
      busy: true,
      phase: 'compacting',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'thread/compact/start',
      message: 'Thread compaction requested.',
      data: {
        threadId: this.threadId,
        apiBaseUrl: this.apiConfig?.baseUrl || null,
        apiProviderKey: this.apiProviderKey || null,
        codexHomeProfile: this.runtime.codexHomeProfile || null,
      },
    });

    await this.rpc.request('thread/compact/start', {
      threadId: this.threadId,
    });
    return true;
  }

  async getGoal() {
    if (!this.threadId) {
      throw new Error('No thread is available for goal state.');
    }
    const response = await this.rpc.request('thread/goal/get', {
      threadId: this.threadId,
    });
    const goal = response?.goal || null;
    await this.emitRuntime({ goal });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'goal',
      method: 'thread/goal/get',
      message: goal ? `Goal loaded: ${goal.status || 'active'}` : 'No active goal.',
      data: { goal },
    });
    return goal;
  }

  async setGoal(options = {}) {
    if (!this.threadId) {
      throw new Error('No thread is available for goal state.');
    }
    const params = { threadId: this.threadId };
    if (Object.prototype.hasOwnProperty.call(options, 'objective')) {
      params.objective = String(options.objective || '').trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'status')) {
      params.status = String(options.status || '').trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(options, 'tokenBudget')) {
      const tokenBudget = Number(options.tokenBudget);
      params.tokenBudget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.floor(tokenBudget) : null;
    }
    const response = await this.rpc.request('thread/goal/set', params);
    const goal = response?.goal || null;
    await this.emitRuntime({ goal });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'goal',
      method: 'thread/goal/set',
      message: goal ? `Goal updated: ${goal.status || 'active'}` : 'Goal updated.',
      data: { goal, params },
    });
    return goal;
  }

  async clearGoal() {
    if (!this.threadId) {
      throw new Error('No thread is available for goal state.');
    }
    const response = await this.rpc.request('thread/goal/clear', {
      threadId: this.threadId,
    });
    await this.emitRuntime({ goal: null });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'goal',
      method: 'thread/goal/clear',
      message: response?.cleared === false ? 'Goal was already clear.' : 'Goal cleared.',
      data: response || null,
    });
    return response || { cleared: true };
  }

  async runShellCommand(command) {
    if (!this.threadId) {
      throw new Error('No thread is available for shell command execution.');
    }

    const shellCommand = String(command || '').trim();
    if (!shellCommand) {
      return null;
    }

    await this.emitRuntime({
      busy: true,
      phase: 'running-shell-command',
    });
    await this.emitDiagnostic({
      severity: 'warning',
      source: 'codex',
      kind: 'control',
      method: 'thread/shellCommand',
      message: `Shell command requested: ${limitText(shellCommand, 220)}`,
      data: {
        threadId: this.threadId,
        command: limitText(shellCommand, 400),
      },
    });

    await this.rpc.request('thread/shellCommand', {
      threadId: this.threadId,
      command: shellCommand,
    });
    return true;
  }

  async respondToRequest(requestId, response) {
    const key = String(requestId || '');
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      throw new Error(`No pending Codex request found for ${key}`);
    }

    this.pendingRequests.delete(key);

    if (pending.method === 'item/tool/requestUserInput') {
      await this.rpc.respond(pending.message.id, {
        answers: response?.answers || {},
      });
    } else if (pending.method === 'item/commandExecution/requestApproval') {
      await this.rpc.respond(pending.message.id, {
        decision: response?.decision || 'decline',
      });
    } else if (pending.method === 'item/fileChange/requestApproval') {
      await this.rpc.respond(pending.message.id, {
        decision: response?.decision || 'decline',
      });
    } else if (pending.method === 'item/permissions/requestApproval') {
      await this.rpc.respond(pending.message.id, response || {
        permissions: {
          fileSystem: null,
          network: {
            enabled: false,
          },
        },
        scope: 'turn',
        strictAutoReview: false,
      });
    } else {
      throw new Error(`Unsupported pending request method: ${pending.method}`);
    }

    await this.emitRequestResolved({
      requestId: key,
      method: pending.method,
      summary: pending.summary,
      response: response ? {
        ...response,
        autoApproved: Boolean(response?.autoApproved),
      } : null,
    });

    await this.emitRuntime({
      waitingOnApproval: false,
      waitingOnUserInput: false,
      busy: Boolean(this.activeTurnId),
      phase: this.activeTurnId ? 'thinking' : 'idle',
    });
    return true;
  }

  async resolvePendingRequestsForClosedTurn(status, message) {
    if (!this.pendingRequests.size) {
      return;
    }

    const pendingEntries = Array.from(this.pendingRequests.entries());
    this.pendingRequests.clear();
    for (const [requestId, pending] of pendingEntries) {
      await this.emitRequestResolved({
        requestId,
        status: status || 'expired',
        method: pending.method,
        summary: pending.summary,
        message: message || 'Request closed because the Codex turn is no longer active.',
        response: {
          status: status || 'expired',
          reason: message || 'Request closed because the Codex turn is no longer active.',
        },
      });
    }
  }

  async handleNotification(message) {
    const method = message.method;
    const params = message.params || {};

    if (method === 'thread/started' && params.thread?.id) {
      this.threadId = params.thread.id;
      this.sessionId = params.thread.id;
      this.nativeThreadId = params.thread.id;
      this.runtime.nativeThreadId = params.thread.id;
      await this.emitRuntime({
        threadId: params.thread.id,
        phase: 'idle',
        startupStep: 'ready',
        busy: false,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'thread',
        method,
        message: `Thread started: ${params.thread.id}`,
        data: params.thread || null,
      });
      return;
    }

    if (method === 'thread/status/changed') {
      const status = params.status || null;
      const type = status?.type || 'unknown';
      const waitingOnApproval = Array.isArray(status?.activeFlags) && status.activeFlags.includes('waitingOnApproval');
      const waitingOnUserInput = Array.isArray(status?.activeFlags) && status.activeFlags.includes('waitingOnUserInput');
      await this.emitRuntime({
        threadStatus: status || null,
        phase: waitingOnApproval
          ? 'waiting-approval'
          : waitingOnUserInput
            ? 'waiting-user-input'
            : type === 'active'
              ? 'thinking'
              : type === 'systemError'
                ? 'error'
                : 'idle',
        busy: type === 'active',
        waitingOnApproval,
        waitingOnUserInput,
      });
      await this.emitDiagnostic({
        severity: type === 'systemError' ? 'error' : 'info',
        source: 'codex',
        kind: 'thread-status',
        method,
        message: describeThreadStatus(status),
        data: status,
      });
      return;
    }

    if (method === 'thread/goal/updated') {
      await this.emitRuntime({
        goal: params.goal || null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'goal',
        method,
        message: params.goal
          ? `Goal ${params.goal.status || 'active'}: ${limitText(params.goal.objective || '', 180)}`
          : 'Goal updated.',
        data: params || null,
      });
      return;
    }

    if (method === 'thread/goal/cleared') {
      await this.emitRuntime({
        goal: null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'goal',
        method,
        message: 'Goal cleared.',
        data: params || null,
      });
      return;
    }

    if (method === 'turn/started') {
      this.activeTurnId = params.turn?.id || params.turnId || this.activeTurnId;
      if (this.activeTurnId && !this.turnBuffers.has(this.activeTurnId)) {
        this.turnBuffers.set(this.activeTurnId, '');
      }
      const turnMode = this.activeTurnId ? this.turnModes.get(this.activeTurnId) : '';
      await this.emitRuntime({
        activeTurnId: this.activeTurnId,
        busy: true,
        phase: turnMode === 'plan' ? 'planning' : 'thinking',
        currentTurnStatus: params.turn?.status?.type || 'inProgress',
        reasoningSummary: null,
        planSummary: null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'turn',
        method,
        message: `Turn started${this.activeTurnId ? `: ${this.activeTurnId}` : ''}`,
        data: params.turn || null,
      });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const turnId = params.turnId || this.activeTurnId;
      if (!turnId) {
        return;
      }
      const text = notificationDeltaText(params);
      if (notificationPhase(params) === 'commentary') {
        if (text) {
          await this.emitDiagnostic({
            severity: 'info',
            source: 'codex',
            kind: 'commentary',
            method,
            message: limitText(text, 300),
            turnId,
            data: {
              itemId: params.itemId || null,
              turnId,
              text,
              phase: 'commentary',
            },
          });
        }
        return;
      }
      const previous = this.turnBuffers.get(turnId) || '';
      this.turnBuffers.set(turnId, `${previous}${params.delta || ''}`);
      return;
    }

    if (method === 'item/commandExecution/outputDelta' || method === 'process/outputDelta' || method === 'command/exec/outputDelta') {
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'command-output',
        method,
        message: limitText(params.delta || params.deltaBase64 || '', 220),
        data: {
          itemId: params.itemId || null,
          processId: params.processId || null,
          processHandle: params.processHandle || null,
          stream: params.stream || null,
          capReached: typeof params.capReached === 'boolean' ? params.capReached : null,
        },
      });
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta') {
      const turnId = params.turnId || this.activeTurnId;
      const reasoningChunk = String(params.delta ?? '');
      const isActiveTurn = turnId && turnId === this.activeTurnId;
      this.appendThinkingDelta({
        turnId,
        itemId: params.itemId,
        summaryIndex: params.summaryIndex ?? 0,
      }, reasoningChunk);
      if (turnId) {
        const previous = this.reasoningBuffers.get(turnId) || '';
        this.reasoningBuffers.set(turnId, `${previous}${reasoningChunk}`);
      }
      if (isActiveTurn) {
        await this.emitRuntime({
          activeTurnId: turnId,
          busy: true,
          phase: 'thinking',
          reasoningSummary: limitText(this.reasoningBuffers.get(turnId), 1200),
        });
      }
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'reasoning',
        method,
        message: limitText(reasoningChunk, 200),
        turnId,
        data: {
          itemId: params.itemId || null,
          summaryIndex: params.summaryIndex ?? null,
          turnId: turnId || null,
        },
      });
      return;
    }

    if (method === 'item/plan/delta' || method === 'turn/plan/updated') {
      const turnId = params.turnId || this.activeTurnId;
      const planChunk = normalizeThinkingText(params.delta || params.plan || '');
      const isActiveTurn = turnId && turnId === this.activeTurnId;
      if (turnId) {
        const previous = this.planBuffers.get(turnId) || '';
        const next = mergeThinkingBuffer(previous, planChunk);
        this.planBuffers.set(turnId, next);
      }
      if (isActiveTurn) {
        await this.emitRuntime({
          activeTurnId: turnId,
          busy: true,
          phase: 'planning',
          planSummary: limitText(this.planBuffers.get(turnId), 1200),
        });
      }
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'plan',
        method,
        message: limitText(planChunk, 200),
        turnId,
        data: {
          itemId: params.itemId || null,
          turnId: turnId || null,
          rawPlan: params.plan || null,
        },
      });
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      await this.emitRuntime({
        tokenUsage: params.tokenUsage || null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'token-usage',
        method,
        message: `Token usage updated${params.tokenUsage?.total?.totalTokens != null ? `: ${params.tokenUsage.total.totalTokens}` : ''}`,
        data: params.tokenUsage || null,
      });
      return;
    }

    if (method === 'account/rateLimits/updated') {
      await this.emitRuntime({
        rateLimits: params.rateLimits || null,
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'codex',
        kind: 'rate-limits',
        method,
        message: `Rate limits updated${params.rateLimits?.rateLimitReachedType ? `: ${params.rateLimits.rateLimitReachedType}` : ''}`,
        data: params.rateLimits || null,
      });
      return;
    }

    if (method === 'item/commandExecution/terminalInteraction') {
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'terminal',
        method,
        message: `Terminal input for process ${params.processId || 'unknown'}`,
        data: {
          itemId: params.itemId || null,
          processId: params.processId || null,
          stdin: limitText(params.stdin || '', 240),
        },
      });
      return;
    }

    if (method === 'item/completed' && params.item?.type === 'reasoning') {
      const turnId = params.turnId || this.activeTurnId;
      const itemId = params.item.id || params.itemId;
      const summaries = Array.isArray(params.item.summary) ? params.item.summary : [];
      summaries.forEach((summary, summaryIndex) => {
        this.replaceThinkingSnapshot({ turnId, itemId, summaryIndex }, persistedReasoningSummaryText(summary));
      });
      await this.finalizeThinkingActivities({ turnId, itemId });
    }

    if (method === 'turn/completed') {
      const turnId = params.turn?.id || params.turnId || this.activeTurnId;
      let activityFlushError = null;
      try {
        await this.finalizeThinkingActivities({ turnId });
      } catch (error) {
        activityFlushError = error;
      }
      const text = turnId ? (this.turnBuffers.get(turnId) || '').trim() : '';
      if (text) {
        await this.emitOutput(text, 'stdout');
      }
      if (turnId) {
        this.turnBuffers.delete(turnId);
        this.turnModes.delete(turnId);
        this.planBuffers.delete(turnId);
        this.reasoningBuffers.delete(turnId);
      }
      if (turnId && turnId === this.activeTurnId) {
        this.activeTurnId = null;
      }
      await this.resolvePendingRequestsForClosedTurn(
        params.turn?.status?.type === 'failed' ? 'failed' : 'expired',
        `Request closed because the turn completed as ${params.turn?.status?.type || 'completed'}.`
      );
      await this.emitRuntime({
        activeTurnId: null,
        busy: false,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        phase: params.turn?.status?.type === 'interrupted'
          ? 'interrupted'
          : params.turn?.status?.type === 'failed'
            ? 'error'
            : 'idle',
        currentTurnStatus: params.turn?.status?.type || 'completed',
      });
      await this.emitDiagnostic({
        severity: params.turn?.status?.type === 'failed' ? 'error' : 'info',
        source: 'codex',
        kind: 'turn',
        method,
        message: `Turn completed: ${params.turn?.status?.type || 'completed'}`,
        data: params.turn || null,
      });
      if (activityFlushError) throw activityFlushError;
      return;
    }

    if (method === 'warning') {
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: params.message || 'warning',
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'codex',
        kind: 'warning',
        method,
        message: params.message || 'warning',
        data: params || null,
      });
      return;
    }

    if (method === 'error') {
      const turnId = params.turnId || this.activeTurnId;
      const pieces = [params.error?.message || 'codex error'];
      if (params.error?.additionalDetails) {
        pieces.push(params.error.additionalDetails);
      }
      const text = pieces.filter(Boolean).join('\n');
      const codexError = describeCodexError(params.error?.codexErrorInfo || null);
      let activityFlushError = null;
      if (params.willRetry) {
        await this.emitRuntime({
          phase: String(codexError || '').startsWith('responseStreamDisconnected') ? 'reconnecting' : 'retrying',
          lastError: text,
          lastCodexError: codexError,
        });
        await this.emitAlert({
          severity: 'warning',
          source: 'codex',
          message: text,
        });
      } else {
        try {
          await this.finalizeThinkingActivities({ turnId });
        } catch (error) {
          activityFlushError = error;
        }
        await this.resolvePendingRequestsForClosedTurn(
          'failed',
          'Request closed because the Codex turn failed.'
        );
        await this.emitRuntime({
          phase: codexError === 'usageLimitExceeded' || codexError === 'contextWindowExceeded' ? 'quota-exhausted' : 'error',
          busy: false,
          lastError: text,
          lastCodexError: codexError,
        });
        await this.postEvent({
          type: 'session.error',
          hostId: this.hostId,
          sessionId: this.currentSessionId(),
          message: text,
          timestamp: nowIso(),
        });
        this.activeTurnId = null;
      }
      await this.emitDiagnostic({
        severity: params.willRetry ? 'warning' : 'error',
        source: 'codex',
        kind: 'error',
        method,
        message: text,
        detail: codexError || null,
        data: params.error || null,
      });
      if (turnId && !params.willRetry) {
        this.turnBuffers.delete(turnId);
      }
      if (activityFlushError) throw activityFlushError;
      return;
    }

    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'notification',
      method,
      message: limitText(summarizeValue(params), 320),
      data: params,
    });
  }

  async handleServerRequest(message) {
    const method = message.method;
    const params = message.params || {};

    if (method === 'item/tool/requestUserInput') {
      const labels = Array.isArray(params.questions)
        ? params.questions.map((question) => question.header || question.id || 'question').join(', ')
        : 'question';
      const requestId = String(message.id);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: labels,
      });
      await this.emitRuntime({
        waitingOnUserInput: true,
        busy: true,
        phase: 'waiting-user-input',
      });
      await this.emitRequest({
        requestId,
        kind: 'user-input',
        method,
        title: 'User input required',
        message: labels,
        summary: labels,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: `User input required: ${labels}`,
      });
      return;
    }

    if (method === 'item/commandExecution/requestApproval') {
      const requestId = String(message.id);
      const command = String(params.command || '').trim();
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: command || params.reason || 'Command approval requested',
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'approval',
        method,
        title: 'Command approval required',
        message: params.reason || command || 'Command approval required',
        summary: command || params.reason || null,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'Command execution approval was requested.',
      });
      return;
    }

    if (method === 'item/fileChange/requestApproval') {
      const requestId = String(message.id);
      const fileChanges = normalizeAppServerFileChanges(params.fileChanges);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: params.reason || params.grantRoot || 'File change approval requested',
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'approval',
        method,
        title: 'File change approval required',
        message: params.reason || params.grantRoot || 'File change approval required',
        summary: params.reason || params.grantRoot || null,
        payload: params,
      });
      if (fileChanges.length) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'file-change',
          method,
          message: `File change approval requested: ${fileChanges.length} file(s)`,
          data: {
            requestId,
            fileChanges,
            reason: params.reason || null,
            grantRoot: params.grantRoot || null,
          },
        });
      }
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'File change approval was requested.',
      });
      return;
    }

    if (method === 'item/permissions/requestApproval') {
      const requestId = String(message.id);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: params.reason || 'Permissions approval requested',
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'permissions',
        method,
        title: 'Permissions approval required',
        message: params.reason || 'Permissions approval required',
        summary: params.reason || null,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'Additional permissions were requested.',
      });
      return;
    }

    this.rpc.respondError(message.id, -32601, `Unsupported server request: ${method}`);
  }

  async handleExit(code, signal) {
    this.childExitConfirmed = true;
    if (
      this.startupStateDbError
      && !this.startCompleted
      && !this.stopRequested
      && !this.terminationPromise
    ) {
      this.startupRetryExit = { code, signal };
      if (typeof this.startupRetryExitResolver === 'function') {
        this.startupRetryExitResolver();
      }
      return;
    }
    if (!this.terminationPromise) {
      this.terminationPromise = this.finalizeExit(code, signal);
    }
    return this.terminationPromise;
  }

  async finalizeExit(code, signal) {
    const terminalErrors = [];
    try {
      await this.drainNotifications();
      await this.finalizeThinkingActivities();
    } catch (error) {
      terminalErrors.push(error);
    }
    let overlayCleanupError = null;
    try {
      updateApiProfileCodexHomeOwnership(this.apiProfileCleanupOwner, {
        childPid: this.child?.pid || null,
        childState: 'exited',
      });
    } catch {
      // Ownership metadata is advisory once the child has confirmed exit.
      // Cleanup still verifies the original owner token before removal.
    }
    try {
      if (!this.cleanupManagedOverlay() && this.apiProfileCleanupOwner) {
        overlayCleanupError = new Error('Owned Codex overlay could not be removed after process exit.');
        overlayCleanupError.code = 'session_overlay_cleanup_failed';
      }
    } catch (error) {
      overlayCleanupError = error;
    }
    this.activeTurnId = null;
    this.turnBuffers.clear();
    this.turnModes.clear();
    this.planBuffers.clear();
    this.reasoningBuffers.clear();
    try {
      await this.resolvePendingRequestsForClosedTurn(
        'cancelled',
        'Request closed because the Codex app-server exited.'
      );
    } catch (error) {
      terminalErrors.push(error);
    }
    try {
      await this.emitRuntime({
        connection: 'closed',
        busy: false,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        activeTurnId: null,
        phase: 'closed',
      }).catch(() => {});
      if (typeof this.onTerminated === 'function') {
        try {
          this.onTerminated(code, signal);
        } catch (error) {
          terminalErrors.push(error);
        }
      }
      if (!this.suppressTerminalEvent) {
        try {
          await this.postEvent({
            type: 'session.state_changed',
            hostId: this.hostId,
            sessionId: this.currentSessionId(),
            runId: this.runId,
            state: this.stopRequested
              ? (this.startCompleted ? 'history-only' : 'failed:start-cancelled')
              : `exited:${code ?? 'null'}:${signal ?? 'null'}`,
            live: false,
            timestamp: nowIso(),
          });
        } catch (error) {
          terminalErrors.push(retryableTerminalDeliveryError(error));
        }
      }
    } finally {
      if (!this.overlayCleaned) {
        try {
          if (this.cleanupManagedOverlay()) overlayCleanupError = null;
        } catch (error) {
          overlayCleanupError = error;
        }
      }
    }
    if (overlayCleanupError) terminalErrors.push(overlayCleanupError);
    throwTerminalErrors(terminalErrors, 'Codex runner termination did not complete cleanly.');
  }

  async finalizePreSpawnCancellation() {
    const terminalErrors = [];
    try {
      if (!this.overlayCleaned && !this.cleanupManagedOverlay() && this.apiProfileCleanupOwner) {
        const error = new Error('Owned Codex overlay could not be removed after startup cancellation.');
        error.code = 'session_overlay_cleanup_failed';
        terminalErrors.push(error);
      }
    } catch (error) {
      terminalErrors.push(error);
    }
    if (typeof this.onTerminated === 'function') {
      try {
        this.onTerminated(null, null);
      } catch (error) {
        terminalErrors.push(error);
      }
    }
    if (!this.suppressTerminalEvent) {
      try {
        await this.postEvent({
          type: 'session.state_changed',
          hostId: this.hostId,
          sessionId: this.currentSessionId(),
          runId: this.runId,
          state: 'failed:start-cancelled',
          live: false,
          timestamp: nowIso(),
        });
      } catch (error) {
        terminalErrors.push(retryableTerminalDeliveryError(error));
      }
    }
    throwTerminalErrors(terminalErrors, 'Codex startup cancellation did not complete cleanly.');
  }

  async emitOutput(text, stream) {
    await this.postEvent({
      type: 'session.output',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      stream,
      chunk: text,
      timestamp: nowIso(),
    });
  }

  currentSessionId() {
    return this.sessionId || this.nativeThreadId || this.bridgeSessionId;
  }

  async emitAlert(entry) {
    await this.postEvent({
      type: 'session.alert',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      severity: entry.severity || 'warning',
      source: entry.source || 'runtime',
      message: entry.message || '',
      timestamp: nowIso(),
    });
  }

  async emitRuntime(patch) {
    this.runtime = {
      ...this.runtime,
      ...patch,
      updatedAt: nowIso(),
    };
    await this.postEvent({
      type: 'session.runtime_updated',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      patch,
      timestamp: nowIso(),
    });
  }

  async emitDiagnostic(entry) {
    await this.postEvent({
      type: 'session.diagnostic',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      severity: entry.severity || 'info',
      source: entry.source || 'codex',
      kind: entry.kind || 'event',
      method: entry.method || null,
      message: entry.message || '',
      detail: entry.detail || null,
      data: entry.data || null,
      turnId: entry.turnId || null,
      timestamp: nowIso(),
    });
  }

  async emitRequest(entry) {
    await this.postEvent({
      type: 'session.request',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      requestId: String(entry.requestId || ''),
      kind: entry.kind || 'request',
      method: entry.method || null,
      title: entry.title || null,
      message: entry.message || '',
      summary: entry.summary || null,
      payload: entry.payload || null,
      response: entry.response || null,
      timestamp: nowIso(),
    });
  }

  async emitRequestResolved(entry) {
    await this.postEvent({
      type: 'session.request.resolved',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      runId: this.runId,
      requestId: String(entry.requestId || ''),
      status: entry.status || 'resolved',
      method: entry.method || null,
      summary: entry.summary || null,
      response: entry.response || null,
      message: entry.message || null,
      timestamp: nowIso(),
    });
  }
}

async function startCodexAppServerSession(options) {
  const runner = new CodexAppServerRunner(options);
  try {
    if (typeof options.onRunnerCreated === 'function') options.onRunnerCreated(runner);
    await runner.start();
    return runner;
  } catch (error) {
    let failure = error;
    try {
      await runner.stop(runner.stopRequested ? {} : { suppressTerminalEvent: true });
    } catch (stopError) {
      stopError.cause = stopError.cause || error;
      failure = stopError;
    }
    if (error?.processTreeFallbackRequired === true) {
      failure.processTreeFallbackRequired = true;
    }
    if (
      !runner.overlayCleaned
      && (!runner.child || runner.childExitConfirmed)
    ) {
      runner.cleanupManagedOverlay();
    }
    if (
      failure?.processTreeFallbackRequired === true
      && runner.child
      && !runner.childExitConfirmed
      && !runner.overlayCleaned
    ) {
      failure.retryCommand = true;
      runner.startRetryPending = true;
      runner.processTreeFallbackRequired = true;
      runner.startRetryFailure = {
        code: failure.code || 'session_stop_timeout',
        message: failure.message || 'Managed Codex startup could not confirm that its child exited.',
        processTreeFallbackRequired: true,
      };
    }
    throw failure;
  }
}

module.exports = {
  CodexAppServerRunner,
  cleanupApiProfileCodexHome,
  cleanupStaleApiProfileCodexHomes,
  normalizeAppServerFileChanges,
  normalizeTurnStartParams,
  prepareApiProfileCodexHome,
  resolveDefaultCodexBin,
  startCodexAppServerSession,
  updateApiProfileCodexHomeOwnership,
};
