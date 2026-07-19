const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  canonicalPhysicalPath,
  comparablePhysicalPath,
} = require('../../shared/physical-path');

class RelayStateLockError extends Error {
  constructor(stateRoot) {
    super(`relay_state_locked: Relay state root is already owned by another Relay process: ${stateRoot}`);
    this.name = 'RelayStateLockError';
    this.code = 'relay_state_locked';
    this.stateRoot = stateRoot;
  }
}

function canonicalStateRoot(stateRoot) {
  return comparablePhysicalPath(stateRoot);
}

function stateLockAddress(stateRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  const digest = crypto.createHash('sha256')
    .update(canonicalStateRoot(stateRoot), 'utf8')
    .digest('hex');
  if (platform === 'win32') {
    return { address: `\\\\.\\pipe\\remote-codex-relay-state-${digest}`, filesystem: false };
  }
  if (platform === 'linux') {
    return { address: `\0remote-codex-relay-state-${digest}`, filesystem: false };
  }
  const legacyAddress = path.join(
    temporaryDirectory,
    `remote-codex-relay-state-${digest}.sock`
  );
  if (Buffer.byteLength(legacyAddress, 'utf8') < 104) {
    return { address: legacyAddress, filesystem: true };
  }
  const shortName = `rc-rs-${digest.slice(0, 32)}.sock`;
  const shortAddress = path.join(temporaryDirectory, shortName);
  return {
    address: Buffer.byteLength(shortAddress, 'utf8') < 104
      ? shortAddress
      : path.join('/tmp', shortName),
    filesystem: true,
  };
}

function listenOnAddress(address) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      server.unref?.();
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function probeFilesystemSocket(address) {
  return new Promise((resolve) => {
    const socket = net.createConnection(address);
    const finish = (status, error = null) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ status, error });
    };
    socket.once('connect', () => finish('live'));
    socket.once('error', (error) => {
      if (error.code === 'ENOENT') {
        finish('absent', error);
      } else if (error.code === 'ECONNREFUSED') {
        finish('stale', error);
      } else {
        finish('indeterminate', error);
      }
    });
    socket.setTimeout(500, () => finish('indeterminate', new Error('Relay state lock probe timed out.')));
  });
}

function filesystemRecoveryGuardPath(address) {
  return `${address}.recovery`;
}

async function acquireFilesystemRecoveryGuard(address) {
  const guardPath = filesystemRecoveryGuardPath(address);
  try {
    await fs.promises.mkdir(guardPath, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return null;
    }
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      await fs.promises.rmdir(guardPath);
      released = true;
    },
  };
}

async function waitForFilesystemRecoveryGuard(address, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const guard = await acquireFilesystemRecoveryGuard(address);
    if (guard) return guard;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return null;
}

async function removeStaleFilesystemSocket(address) {
  let stat;
  try {
    stat = await fs.promises.lstat(address);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket()) {
    const error = new Error(`Relay state lock address is not a socket: ${address}`);
    error.code = 'relay_state_lock_unavailable';
    throw error;
  }
  await fs.promises.unlink(address);
}

function closeLockServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function acquireFilesystemSocket(address, stateRoot, options = {}) {
  const probeSocket = options.probeFilesystemSocket || probeFilesystemSocket;
  const guard = await acquireFilesystemRecoveryGuard(address);
  if (!guard) {
    throw new RelayStateLockError(stateRoot);
  }
  let server = null;
  let failure = null;
  try {
    try {
      server = await listenOnAddress(address);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error;
      }
      const probe = await probeSocket(address);
      if (probe.status === 'live' || probe.status === 'indeterminate') {
        throw new RelayStateLockError(stateRoot);
      }
      if (probe.status === 'stale') {
        await removeStaleFilesystemSocket(address);
      }
      try {
        server = await listenOnAddress(address);
      } catch (retryError) {
        if (retryError.code === 'EADDRINUSE') {
          throw new RelayStateLockError(stateRoot);
        }
        throw retryError;
      }
    }
  } catch (error) {
    failure = error;
  }

  try {
    await guard.release();
  } catch (error) {
    failure ||= error;
  }
  if (failure) {
    if (server) {
      let serverClosed = false;
      try {
        await closeLockServer(server);
        serverClosed = true;
      } catch {}
      if (serverClosed) {
        await removeStaleFilesystemSocket(address).catch(() => {});
      }
    }
    throw failure;
  }
  return server;
}

async function acquireRelayStateLock(stateRoot) {
  const normalizedRoot = canonicalPhysicalPath(stateRoot);
  const { address, filesystem } = stateLockAddress(normalizedRoot);
  const server = filesystem
    ? await acquireFilesystemSocket(address, normalizedRoot)
    : await listenOnAddress(address).catch((error) => {
      if (error.code === 'EADDRINUSE') {
        throw new RelayStateLockError(normalizedRoot);
      }
      throw error;
    });

  let released = false;
  let releasePromise = null;
  let releaseGuard = null;
  let serverClosed = false;
  const performRelease = async () => {
    if (filesystem) {
      releaseGuard ||= await waitForFilesystemRecoveryGuard(address);
      if (!releaseGuard) {
        throw new RelayStateLockError(normalizedRoot);
      }
    }
    if (!serverClosed) {
      await closeLockServer(server);
      serverClosed = true;
    }
    if (filesystem) {
      await removeStaleFilesystemSocket(address);
      await releaseGuard.release();
      releaseGuard = null;
    }
    released = true;
  };
  return {
    stateRoot: normalizedRoot,
    hold() {
      server.ref?.();
    },
    release() {
      if (released) return releasePromise || Promise.resolve();
      if (!releasePromise) {
        releasePromise = performRelease().catch((error) => {
          releasePromise = null;
          throw error;
        });
      }
      return releasePromise;
    },
  };
}

module.exports = {
  RelayStateLockError,
  acquireFilesystemSocket,
  acquireRelayStateLock,
  filesystemRecoveryGuardPath,
  stateLockAddress,
};
