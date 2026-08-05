const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  recoverMissingFileFromBackup,
  recoverMissingFileFromBackupAsync,
  replaceFileWithBackup,
  replaceFileWithBackupAsync,
} = require('../apps/relay/atomic-file-replace');

function injectedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function makeFileSystem(renameSync) {
  return {
    ...fs,
    renameSync,
  };
}

function makeAsyncFileSystem(rename, unlink = (...args) => fs.promises.unlink(...args)) {
  return {
    ...fs,
    promises: {
      ...fs.promises,
      rename,
      unlink,
    },
  };
}

function writeFixture(root, name, targetContents, tempContents) {
  const targetPath = path.join(root, `${name}.json`);
  const tempPath = path.join(root, `${name}.json.tmp`);
  fs.writeFileSync(targetPath, targetContents, 'utf8');
  fs.writeFileSync(tempPath, tempContents, 'utf8');
  return { targetPath, tempPath };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-file-replace-'));
  try {
    {
      const { targetPath, tempPath } = writeFixture(root, 'successful-fallback', 'old', 'new');
      let replaceAttempts = 0;
      const result = replaceFileWithBackup(tempPath, targetPath, {
        fileSystem: makeFileSystem((from, to) => {
          if (from === tempPath && to === targetPath && replaceAttempts++ === 0) {
            throw injectedError('EPERM', 'simulated Windows replacement conflict');
          }
          return fs.renameSync(from, to);
        }),
      });
      assert.strictEqual(result.usedBackup, true);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'new');
      assert.strictEqual(fs.existsSync(result.backupPath), false, 'successful replacement should clean up its old snapshot');
    }

    {
      const { targetPath, tempPath } = writeFixture(root, 'restored-failure', 'old', 'new');
      let replaceAttempts = 0;
      assert.throws(() => replaceFileWithBackup(tempPath, targetPath, {
        maxRetries: 0,
        fileSystem: makeFileSystem((from, to) => {
          if (from === tempPath && to === targetPath && replaceAttempts++ < 2) {
            throw injectedError('EPERM', 'simulated replacement failure');
          }
          return fs.renameSync(from, to);
        }),
      }), /simulated replacement failure/);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'old', 'failed replacement must restore canonical state');
    }

    {
      const { targetPath, tempPath } = writeFixture(root, 'recoverable-failure', 'old', 'new');
      let replaceAttempts = 0;
      let backupPath = '';
      assert.throws(() => replaceFileWithBackup(tempPath, targetPath, {
        maxRetries: 0,
        fileSystem: makeFileSystem((from, to) => {
          if (from === tempPath && to === targetPath && replaceAttempts++ < 2) {
            throw injectedError('EPERM', 'simulated replacement failure');
          }
          if (from !== targetPath && to === targetPath && from.endsWith('.bak')) {
            backupPath = from;
            throw injectedError('EPERM', 'simulated restoration failure');
          }
          return fs.renameSync(from, to);
        }),
      }), (error) => {
        backupPath = error?.recoveryPath || backupPath;
        return error?.recoveryPath === backupPath && /recoverable at/.test(error?.message || '');
      });
      assert(backupPath, 'unrestored old state should have a reported backup path');
      assert.strictEqual(fs.existsSync(targetPath), false, 'the test must exercise the unrecoverable canonical path');
      assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), 'old', 'old state must remain recoverable from the backup');
      const recovered = recoverMissingFileFromBackup(targetPath);
      assert.strictEqual(recovered.recovered, true, 'startup recovery must restore a missing canonical file from its backup');
      assert.strictEqual(recovered.backupPath, backupPath);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'old');
      assert.strictEqual(fs.existsSync(backupPath), false);
    }

    {
      const targetPath = path.join(root, 'collision-recovery.json');
      const collisionBackupPath = `${targetPath}.prior-save.tmp.bak.1`;
      fs.writeFileSync(collisionBackupPath, 'old-collision-state', 'utf8');
      const recovered = recoverMissingFileFromBackup(targetPath);
      assert.strictEqual(recovered.recovered, true, 'collision-suffixed backups must also recover a missing canonical state');
      assert.strictEqual(recovered.backupPath, collisionBackupPath);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'old-collision-state');
    }

    {
      const { targetPath, tempPath } = writeFixture(root, 'sync-transient-lock', 'old', 'new');
      let directAttempts = 0;
      let backupAttempts = 0;
      const result = replaceFileWithBackup(tempPath, targetPath, {
        fileSystem: makeFileSystem((from, to) => {
          if (from === tempPath && to === targetPath && directAttempts++ === 0) {
            throw injectedError('EPERM', 'simulated Windows replacement conflict');
          }
          if (from === targetPath && to.endsWith('.bak') && backupAttempts++ < 2) {
            throw injectedError('EBUSY', 'simulated synchronous scanner lock');
          }
          return fs.renameSync(from, to);
        }),
        maxRetries: 3,
        sleepSync: () => {},
      });
      assert.strictEqual(result.usedBackup, true);
      assert.strictEqual(backupAttempts, 3);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'new');
    }

    {
      const { targetPath, tempPath } = writeFixture(root, 'async-transient-lock', 'old', 'new');
      let directAttempts = 0;
      let backupAttempts = 0;
      let cleanupAttempts = 0;
      const result = await replaceFileWithBackupAsync(tempPath, targetPath, {
        fileSystem: makeAsyncFileSystem(
          async (from, to) => {
            if (from === tempPath && to === targetPath && directAttempts++ === 0) {
              throw injectedError('EPERM', 'simulated Windows replacement conflict');
            }
            if (from === targetPath && to.endsWith('.bak') && backupAttempts++ < 2) {
              throw injectedError('EBUSY', 'simulated transient scanner lock');
            }
            return fs.promises.rename(from, to);
          },
          async (filePath) => {
            if (filePath.endsWith('.bak') && cleanupAttempts++ === 0) {
              throw injectedError('EBUSY', 'simulated transient backup cleanup lock');
            }
            return fs.promises.unlink(filePath);
          }
        ),
        maxRetries: 3,
        sleep: async () => {},
      });
      assert.strictEqual(result.usedBackup, true);
      assert.strictEqual(backupAttempts, 3, 'transient EBUSY must be retried before replacing');
      assert.strictEqual(cleanupAttempts, 2, 'transient EBUSY must be retried while cleaning the old backup');
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'new');
    }

    {
      const { targetPath, tempPath } = writeFixture(root, 'async-persistent-lock', 'old', 'new');
      await assert.rejects(
        replaceFileWithBackupAsync(tempPath, targetPath, {
          fileSystem: makeAsyncFileSystem(async (from, to) => {
            if (from === tempPath && to === targetPath) {
              throw injectedError('EPERM', 'simulated Windows replacement conflict');
            }
            if (from === targetPath && to.endsWith('.bak')) {
              throw injectedError('EBUSY', 'simulated persistent scanner lock');
            }
            return fs.promises.rename(from, to);
          }),
          maxRetries: 2,
          sleep: async () => {},
        }),
        (error) => error?.code === 'EBUSY'
      );
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'old', 'a locked canonical file must never be unlinked');
      assert.strictEqual(fs.readFileSync(tempPath, 'utf8'), 'new', 'the validated replacement must remain retryable');
    }

    {
      const { targetPath, tempPath } = writeFixture(root, 'async-restore-failure', 'old', 'new');
      let replacementAttempts = 0;
      let backupPath = '';
      await assert.rejects(
        replaceFileWithBackupAsync(tempPath, targetPath, {
          fileSystem: makeAsyncFileSystem(async (from, to) => {
            if (from === tempPath && to === targetPath) {
              replacementAttempts += 1;
              throw injectedError(
                replacementAttempts === 1 ? 'EPERM' : 'EBUSY',
                'simulated replacement failure'
              );
            }
            if (from.endsWith('.bak') && to === targetPath) {
              backupPath = from;
              throw injectedError('EBUSY', 'simulated restoration failure');
            }
            return fs.promises.rename(from, to);
          }),
          maxRetries: 1,
          sleep: async () => {},
        }),
        (error) => {
          backupPath = error?.recoveryPath || backupPath;
          return Boolean(error?.restoreError && error?.recoveryPath && /recoverable at/.test(error.message));
        }
      );
      assert.strictEqual(fs.existsSync(targetPath), false);
      assert.strictEqual(fs.readFileSync(backupPath, 'utf8'), 'old');
      const recovered = await recoverMissingFileFromBackupAsync(targetPath);
      assert.strictEqual(recovered.recovered, true);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'old');
    }

    {
      const targetPath = path.join(root, 'async-recovery.json');
      const backupPath = `${targetPath}.prior-save.tmp.bak`;
      fs.writeFileSync(backupPath, 'async-old-state', 'utf8');
      let restoreAttempts = 0;
      const recovered = await recoverMissingFileFromBackupAsync(targetPath, {
        fileSystem: makeAsyncFileSystem(async (from, to) => {
          if (from === backupPath && to === targetPath && restoreAttempts++ === 0) {
            throw injectedError('EBUSY', 'simulated transient recovery lock');
          }
          return fs.promises.rename(from, to);
        }),
        maxRetries: 2,
        sleep: async () => {},
      });
      assert.strictEqual(recovered.recovered, true);
      assert.strictEqual(restoreAttempts, 2);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'async-old-state');
    }

    console.log('atomic file replace assertions passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
