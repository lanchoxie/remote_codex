const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  acquireFilesystemSocket,
  acquireRelayStateLock,
  filesystemRecoveryGuardPath,
  stateLockAddress,
} = require('../apps/relay/relay-state-lock');

const ROOT = path.resolve(__dirname, '..');
const RELAY_PATH = path.join(ROOT, 'apps', 'relay', 'server.js');
const LOCK_SOURCE = fs.readFileSync(path.join(ROOT, 'apps', 'relay', 'relay-state-lock.js'), 'utf8');

assert(
  /probe\.status === 'stale'/.test(LOCK_SOURCE)
    && /error\.code === 'ECONNREFUSED'/.test(LOCK_SOURCE)
    && /probe\.status === 'live' \|\| probe\.status === 'indeterminate'/.test(LOCK_SOURCE),
  'filesystem stale recovery must fail closed unless connect explicitly returns ECONNREFUSED'
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health' }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.setTimeout(1000, () => request.destroy(new Error('health request timed out')));
    request.once('error', reject);
  });
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError || new Error('timed out waiting for condition');
}

function spawnRelay(port, stateRoot) {
  const output = [];
  const child = spawn(process.execPath, [RELAY_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: stateRoot,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  return { child, output };
}

async function waitForRelay(port, relay) {
  await waitFor(async () => {
    if (relay.child.exitCode != null) {
      throw new Error(`Relay exited early (${relay.child.exitCode}):\n${relay.output.join('')}`);
    }
    return (await requestHealth(port)) === 200;
  });
}

async function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs).then(() => false),
  ]);
  if (exited === false) throw new Error('timed out waiting for child exit');
}

async function stopRelay(relay, signal = 'SIGTERM') {
  if (!relay?.child || relay.child.exitCode != null || relay.child.signalCode != null) return;
  relay.child.kill(signal);
  await waitForExit(relay.child);
}

async function createStaleFilesystemSocket(address) {
  const child = spawn(process.execPath, ['-e', [
    "const net = require('net');",
    'const server = net.createServer();',
    "server.listen(process.argv[1], () => process.send('ready'));",
    'setInterval(() => {}, 1000);',
  ].join(' '), address], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', (code, signal) => reject(new Error(
        `stale socket fixture exited before ready (${code ?? signal})`
      )));
    }),
    delay(5000).then(() => {
      throw new Error('stale socket fixture timed out');
    }),
  ]);
  child.kill('SIGKILL');
  await waitForExit(child);
}

function socketConnects(address) {
  return new Promise((resolve) => {
    const socket = net.createConnection(address);
    const finish = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

function testFilesystemSocketPathSelection() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-lock-address-'));
  const shortTmpDir = process.platform === 'win32' ? 'C:\\t' : '/t';
  const legacy = stateLockAddress(stateRoot, {
    platform: 'darwin',
    temporaryDirectory: shortTmpDir,
  });
  assert.strictEqual(legacy.filesystem, true);
  const legacyMatch = path.basename(legacy.address)
    .match(/^remote-codex-relay-state-([a-f0-9]{64})\.sock$/);
  assert(legacyMatch, `short temp directory must preserve the legacy address: ${legacy.address}`);
  assert(Buffer.byteLength(legacy.address, 'utf8') < 104);

  const shortName = `rc-rs-${legacyMatch[1].slice(0, 32)}.sock`;
  const mediumTmpDir = path.join(shortTmpDir, 'm'.repeat(12));
  const mediumLegacyAddress = path.join(mediumTmpDir, path.basename(legacy.address));
  const mediumShortAddress = path.join(mediumTmpDir, shortName);
  assert(Buffer.byteLength(mediumLegacyAddress, 'utf8') >= 104);
  assert(Buffer.byteLength(mediumShortAddress, 'utf8') < 104);
  const shortened = stateLockAddress(stateRoot, {
    platform: 'darwin',
    temporaryDirectory: mediumTmpDir,
  });
  assert.strictEqual(shortened.filesystem, true);
  assert.strictEqual(shortened.address, mediumShortAddress);

  const longTmpDir = path.join(shortTmpDir, 'x'.repeat(160));
  const fallback = stateLockAddress(stateRoot, {
    platform: 'darwin',
    temporaryDirectory: longTmpDir,
  });
  assert.strictEqual(fallback.filesystem, true);
  assert.strictEqual(fallback.address, path.join('/tmp', shortName));
  assert(Buffer.byteLength(fallback.address, 'utf8') < 104);
  console.log('relay filesystem socket path assertions passed');
}

async function testConcurrentRelease() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-lock-release-'));
  const lock = await acquireRelayStateLock(stateRoot);
  const firstRelease = lock.release();
  const secondRelease = lock.release();
  assert.strictEqual(secondRelease, firstRelease, 'concurrent releases must share one operation');
  await Promise.all([firstRelease, secondRelease]);
  await lock.release();
  const { address, filesystem } = stateLockAddress(stateRoot);
  if (filesystem) {
    assert.strictEqual(fs.existsSync(address), false);
    assert.strictEqual(fs.existsSync(filesystemRecoveryGuardPath(address)), false);
  }
  console.log('relay state lock concurrent release assertions passed');
}

async function testIndeterminateFilesystemProbeFailsClosed() {
  if (process.platform !== 'darwin') return;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-lock-probe-'));
  const { address } = stateLockAddress(stateRoot);
  const owner = await acquireRelayStateLock(stateRoot);
  try {
    const before = fs.lstatSync(address, { bigint: true });
    let probeCalls = 0;
    await assert.rejects(
      acquireFilesystemSocket(address, stateRoot, {
        async probeFilesystemSocket(probedAddress) {
          probeCalls += 1;
          assert.strictEqual(probedAddress, address);
          return { status: 'indeterminate', error: new Error('injected probe failure') };
        },
      }),
      /relay_state_locked/
    );
    const after = fs.lstatSync(address, { bigint: true });
    assert.strictEqual(probeCalls, 1);
    assert.strictEqual(after.dev, before.dev, 'indeterminate probe must not replace the owner socket');
    assert.strictEqual(after.ino, before.ino, 'indeterminate probe must not replace the owner socket');
    assert.strictEqual(await socketConnects(address), true);
    assert.strictEqual(fs.existsSync(filesystemRecoveryGuardPath(address)), false);
  } finally {
    await owner.release();
  }
  console.log('relay filesystem indeterminate probe assertions passed');
}

async function testFilesystemGuardFailClosed() {
  if (process.platform !== 'darwin') return;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-lock-guard-'));
  const { address } = stateLockAddress(stateRoot);
  const guardPath = filesystemRecoveryGuardPath(address);
  fs.mkdirSync(guardPath);
  const blocked = spawnRelay(await getOpenPort(), stateRoot);
  await waitForExit(blocked.child);
  assert.notStrictEqual(blocked.child.exitCode, 0, blocked.output.join(''));
  assert.match(blocked.output.join(''), /relay_state_locked/);
  assert.strictEqual(fs.existsSync(address), false, 'guarded acquisition must not create a socket');
  fs.rmdirSync(guardPath);

  const lock = await acquireRelayStateLock(stateRoot);
  fs.mkdirSync(guardPath);
  await assert.rejects(lock.release(), /relay_state_locked/);
  assert.strictEqual(await socketConnects(address), true, 'failed release must keep its listener alive');
  fs.rmdirSync(guardPath);
  await lock.release();
  assert.strictEqual(await socketConnects(address), false);
  console.log('relay filesystem recovery guard fail-closed assertions passed');
}

async function testConcurrentFilesystemSocketRecovery() {
  if (process.platform !== 'darwin') return;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-lock-stale-race-'));
  const { address, filesystem } = stateLockAddress(stateRoot);
  assert.strictEqual(filesystem, true);
  assert(Buffer.byteLength(address, 'utf8') < 104, `filesystem socket path is too long: ${address}`);
  await createStaleFilesystemSocket(address);
  assert.strictEqual(fs.existsSync(address), true, 'SIGKILL fixture must leave a stale socket');

  const firstPort = await getOpenPort();
  const secondPort = await getOpenPort();
  const contenders = [spawnRelay(firstPort, stateRoot), spawnRelay(secondPort, stateRoot)];
  let winnerIndex = -1;
  let third = null;
  try {
    winnerIndex = await waitFor(async () => {
      const health = await Promise.all([
        requestHealth(firstPort).catch(() => 0),
        requestHealth(secondPort).catch(() => 0),
      ]);
      if (health[0] === 200 && health[1] === 200) {
        throw new Error('concurrent stale recovery created two Relay state owners');
      }
      if (health[0] === 200) return 0;
      if (health[1] === 200) return 1;
      if (contenders.every((relay) => relay.child.exitCode != null)) {
        throw new Error(`both stale recovery contenders exited:\n${contenders.flatMap((relay) => relay.output).join('')}`);
      }
      return false;
    }, 15000);

    const loser = contenders[1 - winnerIndex];
    await waitForExit(loser.child);
    assert.notStrictEqual(loser.child.exitCode, 0, loser.output.join(''));
    assert.match(loser.output.join(''), /relay_state_locked/);

    const winner = contenders[winnerIndex];
    const winnerPort = winnerIndex === 0 ? firstPort : secondPort;
    assert.strictEqual(await socketConnects(address), true, 'winner lock socket must remain connectable');
    const winnerSocket = fs.lstatSync(address, { bigint: true });
    third = spawnRelay(await getOpenPort(), stateRoot);
    await waitForExit(third.child);
    assert.notStrictEqual(third.child.exitCode, 0, third.output.join(''));
    assert.match(third.output.join(''), /relay_state_locked/);
    const afterThird = fs.lstatSync(address, { bigint: true });
    assert.strictEqual(afterThird.dev, winnerSocket.dev, 'third contender must not replace winner socket');
    assert.strictEqual(afterThird.ino, winnerSocket.ino, 'third contender must not replace winner socket');
    assert.strictEqual(await socketConnects(address), true, 'third contender must not unlink winner socket');
    assert.strictEqual(await requestHealth(winnerPort), 200, winner.output.join(''));
  } finally {
    await stopRelay(contenders[0]);
    await stopRelay(contenders[1]);
    await stopRelay(third);
  }
  assert.strictEqual(fs.existsSync(filesystemRecoveryGuardPath(address)), false);
  console.log('relay filesystem stale-lock recovery race assertions passed');
}

async function main() {
  testFilesystemSocketPathSelection();
  await testConcurrentRelease();
  await testIndeterminateFilesystemProbeFailsClosed();
  await testFilesystemGuardFailClosed();
  await testConcurrentFilesystemSocketRecovery();
  const firstPort = await getOpenPort();
  const secondPort = await getOpenPort();
  assert.notStrictEqual(firstPort, secondPort);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-lock-'));
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-state-lock-alias-'));
  const aliasRoot = path.join(aliasParent, 'state-root-alias');
  fs.symlinkSync(stateRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const sentinelPath = path.join(stateRoot, '.session-record-store.session-store-sentinel.json');
  const first = spawnRelay(firstPort, stateRoot);
  let second = null;
  let takeover = null;

  try {
    await waitForRelay(firstPort, first);
    const sentinelBefore = fs.readFileSync(sentinelPath, 'utf8');
    const sentinelMtimeBefore = fs.statSync(sentinelPath).mtimeMs;

    second = spawnRelay(secondPort, aliasRoot);
    await waitForExit(second.child);
    assert.notStrictEqual(second.child.exitCode, 0, second.output.join(''));
    assert.match(second.output.join(''), /relay_state_locked/);
    assert.strictEqual(
      fs.readFileSync(sentinelPath, 'utf8'),
      sentinelBefore,
      'a Relay using a physical-path alias must not rewrite the Session Store sentinel'
    );
    assert.strictEqual(
      fs.statSync(sentinelPath).mtimeMs,
      sentinelMtimeBefore,
      'state ownership must fail before opening the Session Store'
    );

    await stopRelay(first, 'SIGKILL');
    takeover = spawnRelay(secondPort, stateRoot);
    await waitForRelay(secondPort, takeover);
    console.log('relay state-root ownership lock assertions passed');
  } finally {
    await stopRelay(first);
    await stopRelay(second);
    await stopRelay(takeover);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
