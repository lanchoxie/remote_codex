const fs = require('fs');
const path = require('path');

const REPLACE_CONFLICT_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'ENOTEMPTY',
  'EPERM',
]);
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function isReplaceConflict(error) {
  return REPLACE_CONFLICT_CODES.has(error?.code);
}

function nextBackupPath(targetPath, tempPath, fileSystem) {
  const basePath = `${targetPath}.${path.basename(tempPath)}.bak`;
  let candidate = basePath;
  let suffix = 0;
  while (fileSystem.existsSync(candidate)) {
    suffix += 1;
    candidate = `${basePath}.${suffix}`;
  }
  return candidate;
}

function cleanupBackup(backupPath, fileSystem) {
  try {
    fileSystem.unlinkSync(backupPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // The replacement is already durable. Leave an extra old snapshot rather than fail a successful save.
    }
  }
}

async function cleanupBackupAsync(backupPath, fileSystem, options = {}) {
  try {
    await unlinkWithRetry(backupPath, { ...options, fileSystem });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // The replacement is already durable. Leave an extra old snapshot rather than fail a successful save.
    }
  }
}

async function pathExists(filePath, fileSystem) {
  try {
    await fileSystem.promises.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function renameWithRetry(fromPath, toPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const maxRetries = Math.max(0, Number(options.maxRetries ?? 8));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 20));
  const maxRetryDelayMs = Math.max(retryDelayMs, Number(options.maxRetryDelayMs ?? 500));
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let attempt = 0;
  while (true) {
    try {
      await fileSystem.promises.rename(fromPath, toPath);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** attempt));
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

async function unlinkWithRetry(filePath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const maxRetries = Math.max(0, Number(options.maxRetries ?? 8));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 20));
  const maxRetryDelayMs = Math.max(retryDelayMs, Number(options.maxRetryDelayMs ?? 500));
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let attempt = 0;
  while (true) {
    try {
      await fileSystem.promises.unlink(filePath);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** attempt));
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

function backupCandidates(targetPath, fileSystem) {
  const directory = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.`;
  const backupNamePattern = /\.bak(?:\.\d+)?$/;
  try {
    return fileSystem.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && backupNamePattern.test(name))
      .map((name) => {
        const candidate = path.join(directory, name);
        let modifiedAt = 0;
        try {
          modifiedAt = Number(fileSystem.statSync(candidate).mtimeMs) || 0;
        } catch (_) {
          // A concurrent cleanup can remove a candidate before we inspect it.
        }
        return { candidate, modifiedAt };
      })
      .sort((left, right) => (
        right.modifiedAt - left.modifiedAt
        || right.candidate.localeCompare(left.candidate)
      ));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// A process can crash after moving the canonical file aside but before the
// replacement rename. Recover that durable old snapshot before a loader treats
// the missing canonical file as an empty state.
function recoverMissingFileFromBackup(targetPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  if (fileSystem.existsSync(targetPath)) {
    return { recovered: false, backupPath: null };
  }
  const backup = backupCandidates(targetPath, fileSystem)[0];
  if (!backup) {
    return { recovered: false, backupPath: null };
  }
  try {
    fileSystem.renameSync(backup.candidate, targetPath);
    return { recovered: true, backupPath: backup.candidate };
  } catch (error) {
    if (fileSystem.existsSync(targetPath)) {
      return { recovered: false, backupPath: null };
    }
    error.recoveryPath = backup.candidate;
    error.message = `${error.message || error}; previous state remains recoverable at ${backup.candidate}`;
    throw error;
  }
}

async function recoverMissingFileFromBackupAsync(targetPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  if (await pathExists(targetPath, fileSystem)) {
    return { recovered: false, backupPath: null };
  }
  const backup = backupCandidates(targetPath, fileSystem)[0];
  if (!backup) {
    return { recovered: false, backupPath: null };
  }
  try {
    await renameWithRetry(backup.candidate, targetPath, { ...options, fileSystem });
    return { recovered: true, backupPath: backup.candidate };
  } catch (error) {
    if (await pathExists(targetPath, fileSystem)) {
      return { recovered: false, backupPath: null };
    }
    error.recoveryPath = backup.candidate;
    error.message = `${error.message || error}; previous state remains recoverable at ${backup.candidate}`;
    throw error;
  }
}

// Windows can reject a rename that replaces an existing file. Never unlink the
// canonical state first: move it to a unique backup and restore it on failure.
function replaceFileWithBackup(tempPath, targetPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  try {
    fileSystem.renameSync(tempPath, targetPath);
    return { usedBackup: false, backupPath: null };
  } catch (error) {
    if (!isReplaceConflict(error)) {
      throw error;
    }
  }

  const backupPath = nextBackupPath(targetPath, tempPath, fileSystem);
  try {
    fileSystem.renameSync(targetPath, backupPath);
  } catch (error) {
    // A concurrent remover may have made the initial replace conflict stale.
    if (error?.code === 'ENOENT') {
      fileSystem.renameSync(tempPath, targetPath);
      return { usedBackup: false, backupPath: null };
    }
    throw error;
  }

  try {
    fileSystem.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fileSystem.renameSync(backupPath, targetPath);
    } catch (restoreError) {
      error.recoveryPath = backupPath;
      error.restoreError = restoreError;
      error.message = `${error.message || error}; previous state remains recoverable at ${backupPath}`;
    }
    throw error;
  }

  cleanupBackup(backupPath, fileSystem);
  return { usedBackup: true, backupPath };
}

async function replaceFileWithBackupAsync(tempPath, targetPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  try {
    await fileSystem.promises.rename(tempPath, targetPath);
    return { usedBackup: false, backupPath: null };
  } catch (error) {
    if (!isReplaceConflict(error)) {
      throw error;
    }
  }

  const backupPath = nextBackupPath(targetPath, tempPath, fileSystem);
  try {
    await renameWithRetry(targetPath, backupPath, { ...options, fileSystem });
  } catch (error) {
    // A concurrent remover may have made the initial replace conflict stale.
    if (error?.code === 'ENOENT') {
      await renameWithRetry(tempPath, targetPath, { ...options, fileSystem });
      return { usedBackup: false, backupPath: null };
    }
    throw error;
  }

  try {
    await renameWithRetry(tempPath, targetPath, { ...options, fileSystem });
  } catch (error) {
    try {
      await renameWithRetry(backupPath, targetPath, { ...options, fileSystem });
    } catch (restoreError) {
      error.recoveryPath = backupPath;
      error.restoreError = restoreError;
      error.message = `${error.message || error}; previous state remains recoverable at ${backupPath}`;
    }
    throw error;
  }

  await cleanupBackupAsync(backupPath, fileSystem, options);
  return { usedBackup: true, backupPath };
}

module.exports = {
  recoverMissingFileFromBackup,
  recoverMissingFileFromBackupAsync,
  replaceFileWithBackup,
  replaceFileWithBackupAsync,
};
