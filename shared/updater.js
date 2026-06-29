const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_BACKUP_FILES = [
  'tmp/session-collections.json',
  'tmp/session-metadata.json',
  'tmp/session-logs.json',
  'tmp/session-diagnostics.json',
  'tmp/connectors.json',
  'tmp/connector-secrets.json',
  'tmp/relay-auth-account.json',
  'tmp/relay-auth-token.txt',
  'tmp/received-files/manifest.json',
];

function cleanRootDir(rootDir = process.cwd()) {
  return path.resolve(String(rootDir || process.cwd()));
}

function runGit(rootDir, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: cleanRootDir(rootDir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 60_000,
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status !== 0) {
    const error = new Error(stderr || stdout || `git ${args.join(' ')} failed`);
    error.code = 'GIT_COMMAND_FAILED';
    error.command = `git ${args.join(' ')}`;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return stdout;
}

function readPackageVersion(rootDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cleanRootDir(rootDir), 'package.json'), 'utf8'));
    return String(parsed.version || '').trim();
  } catch {
    return '';
  }
}

function parseStableTag(tag) {
  const match = String(tag || '').trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    tag: String(tag).trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareStableVersions(a, b) {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

function selectLatestStableTag(tags = []) {
  const stable = tags
    .map(parseStableTag)
    .filter(Boolean)
    .sort(compareStableVersions);
  return stable.length ? stable[stable.length - 1].tag : '';
}

function getCurrentTag(rootDir) {
  try {
    return runGit(rootDir, ['describe', '--tags', '--exact-match']);
  } catch {
    return '';
  }
}

function getCurrentCommit(rootDir) {
  try {
    return runGit(rootDir, ['rev-parse', '--short', 'HEAD']);
  } catch {
    return '';
  }
}

function getTrackedChanges(rootDir) {
  const output = runGit(rootDir, ['status', '--porcelain', '--untracked-files=no']);
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function getUntrackedFiles(rootDir) {
  const output = runGit(rootDir, ['ls-files', '--others', '--exclude-standard']);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listLocalTags(rootDir) {
  const output = runGit(rootDir, ['tag', '--list']);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function maybeFetchTags(rootDir, fetch = true) {
  if (!fetch) {
    return false;
  }
  runGit(rootDir, ['fetch', '--tags', 'origin'], { timeoutMs: 120_000 });
  return true;
}

function compareTagReachability(rootDir, fromTag, toTag) {
  if (!fromTag || !toTag || fromTag === toTag) {
    return 0;
  }
  try {
    const base = runGit(rootDir, ['merge-base', fromTag, toTag]);
    const fromCommit = runGit(rootDir, ['rev-parse', fromTag]);
    const toCommit = runGit(rootDir, ['rev-parse', toTag]);
    if (fromCommit === toCommit) {
      return 0;
    }
    if (base === fromCommit) {
      return 1;
    }
    if (base === toCommit) {
      return -1;
    }
  } catch {
    return 0;
  }
  return 0;
}

function isAncestor(rootDir, olderRef, newerRef) {
  if (!olderRef || !newerRef) {
    return false;
  }
  const result = spawnSync('git', ['merge-base', '--is-ancestor', olderRef, newerRef], {
    cwd: cleanRootDir(rootDir),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return result.status === 0;
}

function getLocalUpdateStatus(options = {}) {
  const rootDir = cleanRootDir(options.rootDir);
  maybeFetchTags(rootDir, options.fetch !== false);
  const currentVersion = readPackageVersion(rootDir);
  const currentTag = getCurrentTag(rootDir);
  const currentCommit = getCurrentCommit(rootDir);
  const trackedChanges = getTrackedChanges(rootDir);
  const untrackedFiles = getUntrackedFiles(rootDir);
  const latestStableTag = selectLatestStableTag(listLocalTags(rootDir));
  const relation = compareTagReachability(rootDir, currentTag, latestStableTag);
  const headIsBehindLatestStable = Boolean(latestStableTag && isAncestor(rootDir, 'HEAD', latestStableTag) && !isAncestor(rootDir, latestStableTag, 'HEAD'));
  return {
    rootDir,
    currentVersion,
    currentTag,
    currentCommit,
    latestStableTag,
    updateAvailable: Boolean(latestStableTag && latestStableTag !== currentTag && relation >= 0 && headIsBehindLatestStable),
    dirty: trackedChanges.length > 0,
    trackedChanges,
    untrackedFiles,
    restartRequired: false,
  };
}

function timestampForPath(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function copyPathIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.cpSync(source, target, { recursive: true });
  } else {
    fs.copyFileSync(source, target);
  }
  return true;
}

function backupUpdateData(options = {}) {
  const rootDir = cleanRootDir(options.rootDir);
  const backupRoot = options.backupRoot || path.join(rootDir, 'tmp', 'update-backups');
  const backupDir = options.backupDir || path.join(backupRoot, timestampForPath(options.now || new Date()));
  const files = options.files || DEFAULT_BACKUP_FILES;
  const copied = [];
  for (const relativePath of files) {
    const source = path.join(rootDir, relativePath);
    const target = path.join(backupDir, relativePath.replace(/^tmp[\\/]/, ''));
    if (copyPathIfExists(source, target)) {
      copied.push(relativePath);
    }
  }
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    rootDir,
    copied,
  }, null, 2), 'utf8');
  return {
    backupDir,
    copied,
  };
}

function applyStableTagUpdate(options = {}) {
  const rootDir = cleanRootDir(options.rootDir);
  const before = getLocalUpdateStatus({ rootDir, fetch: options.fetch !== false });
  if (before.dirty) {
    const error = new Error(`Cannot update while tracked files are dirty: ${before.trackedChanges.join(', ')}`);
    error.code = 'DIRTY_TRACKED_FILES';
    error.trackedChanges = before.trackedChanges;
    throw error;
  }
  if (!before.latestStableTag) {
    return {
      updated: false,
      reason: 'no-stable-tag',
      before,
    };
  }
  if (!before.updateAvailable) {
    return {
      updated: false,
      reason: 'already-current',
      before,
      targetTag: before.latestStableTag,
    };
  }

  const backup = backupUpdateData({ rootDir, backupRoot: options.backupRoot, now: options.now });
  runGit(rootDir, ['checkout', before.latestStableTag], { timeoutMs: 120_000 });
  const after = getLocalUpdateStatus({ rootDir, fetch: false });
  return {
    updated: true,
    targetTag: before.latestStableTag,
    backupDir: backup.backupDir,
    backedUpFiles: backup.copied,
    before,
    after: {
      ...after,
      restartRequired: true,
    },
  };
}

function buildWindowsRestartCommand(rootDir, delayMs = 1500) {
  const scriptPath = path.join(cleanRootDir(rootDir), 'scripts', 'start-windows.ps1');
  const delaySeconds = Math.max(1, Math.ceil(Number(delayMs || 0) / 1000));
  return [
    'Start-Sleep',
    '-Seconds',
    String(delaySeconds),
    ';',
    '&',
    `'${scriptPath.replace(/'/g, "''")}'`,
    '-Restart',
  ].join(' ');
}

function scheduleWindowsRestart(options = {}) {
  const rootDir = cleanRootDir(options.rootDir);
  const command = buildWindowsRestartCommand(rootDir, options.delayMs);
  if (options.execute === false) {
    return {
      scheduled: true,
      detached: true,
      command,
    };
  }
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return {
    scheduled: true,
    detached: true,
    command,
    pid: child.pid,
  };
}

module.exports = {
  DEFAULT_BACKUP_FILES,
  applyStableTagUpdate,
  backupUpdateData,
  getLocalUpdateStatus,
  scheduleWindowsRestart,
  selectLatestStableTag,
};
