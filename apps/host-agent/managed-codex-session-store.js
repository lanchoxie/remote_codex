const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { findCodexSessionFile } = require('../../shared/codex-discovery');

const STORE_ROOT_NAME = '.remote-codex-sessions';
const STORE_MARKER_NAME = 'marker.json';
const STORE_MARKER_KIND = 'remote-codex-session-store';
const STORE_MARKER_VERSION = 1;
const SESSION_INDEX_NAME = 'session_index.jsonl';
const ROLLOUT_SEED_LAUNCH_MODES = new Set(['fork', 'fresh_rebind', 'resume']);

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function pathIdentity(value) {
  const normalized = path.normalize(String(value || ''));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function realPath(value) {
  const resolve = typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native
    : fs.realpathSync;
  return resolve(value);
}

function chmodPrivate(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Windows only exposes a subset of POSIX mode semantics.
  }
}

function ensurePlainDirectory(directory, options = {}) {
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: options.recursive !== false, mode: 0o700 });
  }
  const stats = fs.lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    const error = new Error(`managed Codex Session path is linked or is not a directory: ${resolved}`);
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  chmodPrivate(resolved, 0o700);
  return resolved;
}

function assertDirectChild(parentReal, directory) {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    const error = new Error('managed Codex Session store is linked or is not a directory');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  const actual = realPath(directory);
  if (pathIdentity(path.dirname(actual)) !== pathIdentity(parentReal)) {
    const error = new Error('managed Codex Session store escapes its managed root');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  return actual;
}

function ensureStoreRoot(baseCodexHome) {
  const baseHomeInput = textOrNull(baseCodexHome);
  if (!baseHomeInput) {
    const error = new Error('base CODEX_HOME is required for managed Session storage');
    error.code = 'session_store_home_missing';
    throw error;
  }
  const baseHome = path.resolve(baseHomeInput);
  if (!fs.existsSync(baseHome)) {
    fs.mkdirSync(baseHome, { recursive: true, mode: 0o700 });
  }
  const baseStats = fs.statSync(baseHome);
  if (!baseStats.isDirectory()) {
    const error = new Error('base CODEX_HOME is not a directory');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  const baseReal = realPath(baseHome);
  ensureBaseSessionsRoot(baseHome);
  const root = path.join(baseHome, STORE_ROOT_NAME);
  try {
    fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    const error = new Error('managed Codex Session root is linked or is not a directory');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  const rootReal = realPath(root);
  if (pathIdentity(rootReal) !== pathIdentity(path.join(baseReal, STORE_ROOT_NAME))) {
    const error = new Error('managed Codex Session root real path is unsafe');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  chmodPrivate(root, 0o700);
  return { baseHome, baseReal, root, rootReal };
}

function storeKey(hostId, logicalSessionId) {
  return crypto.createHash('sha256')
    .update(`${String(hostId || '').trim()}\0${String(logicalSessionId || '').trim()}`)
    .digest('hex')
    .slice(0, 32);
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    chmodPrivate(filePath, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original marker write failure.
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The authoritative marker was not replaced.
    }
    throw error;
  }
}

function readMarker(markerPath) {
  if (!fs.existsSync(markerPath)) return null;
  const stats = fs.lstatSync(markerPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    const error = new Error('managed Codex Session marker is linked or is not a file');
    error.code = 'session_store_marker_invalid';
    throw error;
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (cause) {
    const error = new Error('managed Codex Session marker is invalid JSON');
    error.code = 'session_store_marker_invalid';
    error.cause = cause;
    throw error;
  }
  return marker;
}

function uniqueAliases(values) {
  return [...new Set(values.map(textOrNull).filter(Boolean))].sort();
}

function fileFingerprint(filePath) {
  const stats = fs.statSync(filePath);
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return { size: stats.size, sha256: hash.digest('hex') };
}

function sameFileIdentity(left, right) {
  try {
    const leftStats = fs.statSync(left);
    const rightStats = fs.statSync(right);
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch {
    return false;
  }
}

function fingerprintsEqual(left, right) {
  return Boolean(
    left
    && right
    && Number(left.size) === Number(right.size)
    && String(left.sha256 || '') === String(right.sha256 || '')
  );
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readTargetSessionIndexRows(baseHome, nativeThreadId) {
  const identity = textOrNull(nativeThreadId);
  if (!identity) return [];
  const indexPath = path.join(baseHome, SESSION_INDEX_NAME);
  const stats = lstatIfPresent(indexPath);
  if (!stats) return [];
  if (!stats.isFile() || stats.isSymbolicLink()) {
    const error = new Error('base Codex Session index is linked or is not a file');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  const expectedReal = path.join(realPath(baseHome), SESSION_INDEX_NAME);
  if (pathIdentity(realPath(indexPath)) !== pathIdentity(expectedReal)) {
    const error = new Error('base Codex Session index escapes CODEX_HOME');
    error.code = 'session_store_unsafe_path';
    throw error;
  }

  const rows = [];
  for (const line of fs.readFileSync(indexPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row || Array.isArray(row) || typeof row !== 'object') continue;
    if (textOrNull(row.id) !== identity) continue;
    rows.push(JSON.stringify(row));
  }
  return rows;
}

function writePrivateFileExclusive(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodPrivate(filePath, 0o600);
}

function assertRelativeRollout(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error('managed Codex rollout path escapes its sessions root');
    error.code = 'session_store_unsafe_rollout';
    throw error;
  }
  return relative;
}

function ensureRolloutParent(root, relativePath) {
  const segments = relativePath.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
    }
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      const error = new Error('managed Codex rollout parent is linked or is not a directory');
      error.code = 'session_store_unsafe_rollout';
      throw error;
    }
  }
}

function linkOrCopyRollout(source, destination, options = {}) {
  const sourceStats = fs.lstatSync(source);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    const error = new Error('managed Codex rollout source is linked or is not a file');
    error.code = 'session_store_unsafe_rollout';
    throw error;
  }
  const destinationStats = lstatIfPresent(destination);
  if (destinationStats) {
    if (!destinationStats.isFile() || destinationStats.isSymbolicLink()) {
      const error = new Error('managed Codex rollout destination is linked or is not a file');
      error.code = 'session_store_unsafe_rollout';
      throw error;
    }
    if (sameFileIdentity(source, destination)) return 'hardlink';
    if (fingerprintsEqual(fileFingerprint(source), fileFingerprint(destination))) return 'copy';
    const error = new Error('managed Codex rollout conflicts with an existing Session rollout');
    error.code = 'session_store_rollout_conflict';
    throw error;
  }
  try {
    const linkFileSync = typeof options.linkFileSync === 'function'
      ? options.linkFileSync
      : fs.linkSync;
    linkFileSync(source, destination);
    return 'hardlink';
  } catch (error) {
    if (error?.code === 'EEXIST') return linkOrCopyRollout(source, destination);
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  chmodPrivate(destination, 0o600);
  return 'copy';
}

function atomicReplaceWithCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    chmodPrivate(temporary, 0o600);
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the copy or replacement failure.
    }
    throw error;
  }
}

function inspectBaseSessionsRoot(baseHome, options = {}) {
  const sessionsRoot = path.join(baseHome, 'sessions');
  let stats = lstatIfPresent(sessionsRoot);
  if (!stats && options.create === true) {
    fs.mkdirSync(sessionsRoot, { recursive: false, mode: 0o700 });
    stats = fs.lstatSync(sessionsRoot);
  }
  if (!stats) return null;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    const error = new Error('base Codex sessions root is linked or is not a directory');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  const baseReal = realPath(baseHome);
  const sessionsReal = realPath(sessionsRoot);
  if (pathIdentity(sessionsReal) !== pathIdentity(path.join(baseReal, 'sessions'))) {
    const error = new Error('base Codex sessions root escapes CODEX_HOME');
    error.code = 'session_store_unsafe_path';
    throw error;
  }
  chmodPrivate(sessionsRoot, 0o700);
  return sessionsRoot;
}

function ensureBaseSessionsRoot(baseHome) {
  return inspectBaseSessionsRoot(baseHome, { create: true });
}

class ManagedCodexSessionStore {
  constructor(options = {}) {
    this.hostId = textOrNull(options.hostId) || 'local';
    this.logicalSessionId = textOrNull(
      options.logicalSessionId
      || options.bridgeSessionId
      || options.sessionId
    ) || `ephemeral-${crypto.randomBytes(16).toString('hex')}`;
    this.launchMode = textOrNull(options.launchMode) || 'fresh';
    this.fileOptions = {
      linkFileSync: typeof options.linkFileSync === 'function' ? options.linkFileSync : fs.linkSync,
    };
    this.targetNativeThreadId = ROLLOUT_SEED_LAUNCH_MODES.has(this.launchMode)
      ? textOrNull(
        options.targetNativeThreadId
        || options.nativeThreadId
        || options.rebindNativeThreadId
      )
      : null;
    const roots = ensureStoreRoot(options.baseCodexHome);
    this.baseCodexHome = roots.baseHome;
    this.root = roots.root;
    this.rootReal = roots.rootReal;
    this.storeKey = storeKey(this.hostId, this.logicalSessionId);
    this.storeDirectory = path.join(this.root, `ms-${this.storeKey}`);
    if (!fs.existsSync(this.storeDirectory)) {
      fs.mkdirSync(this.storeDirectory, { recursive: false, mode: 0o700 });
    }
    assertDirectChild(this.rootReal, this.storeDirectory);
    this.storeCodexHome = ensurePlainDirectory(path.join(this.storeDirectory, '.codex'));
    this.sessionsDirectory = ensurePlainDirectory(path.join(this.storeCodexHome, 'sessions'));
    this.markerPath = path.join(this.storeDirectory, STORE_MARKER_NAME);
    this.marker = this.loadOrCreateMarker(options);
    this.seedResult = this.seedTargetRollout();
  }

  loadOrCreateMarker(options) {
    const now = new Date().toISOString();
    const aliases = uniqueAliases([
      this.logicalSessionId,
      options.sessionId,
      options.bridgeSessionId,
      options.nativeThreadId,
      options.rebindNativeThreadId,
      options.sourceSessionId,
      options.originSessionId,
      options.conversationKey,
    ]);
    const existing = readMarker(this.markerPath);
    if (existing) {
      if (
        existing.kind !== STORE_MARKER_KIND
        || Number(existing.version) !== STORE_MARKER_VERSION
        || String(existing.storeKey || '') !== this.storeKey
        || String(existing.hostId || '') !== this.hostId
        || String(existing.logicalSessionId || '') !== this.logicalSessionId
      ) {
        const error = new Error('managed Codex Session marker identity does not match its directory');
        error.code = 'session_store_marker_mismatch';
        throw error;
      }
    }
    const marker = {
      kind: STORE_MARKER_KIND,
      version: STORE_MARKER_VERSION,
      storeKey: this.storeKey,
      hostId: this.hostId,
      logicalSessionId: this.logicalSessionId,
      aliases: uniqueAliases([...(existing?.aliases || []), ...aliases]),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      publications: existing?.publications && typeof existing.publications === 'object'
        ? existing.publications
        : {},
    };
    atomicWriteJson(this.markerPath, marker);
    return marker;
  }

  saveMarker() {
    this.marker.updatedAt = new Date().toISOString();
    atomicWriteJson(this.markerPath, this.marker);
  }

  findStoredRollout(nativeThreadId) {
    const identity = textOrNull(nativeThreadId);
    if (!identity) return null;
    return findCodexSessionFile({
      codexHome: this.storeCodexHome,
      sessionId: identity,
      nativeThreadId: identity,
    });
  }

  recordCopyBaseline(nativeThreadId, relativePath, mode, baseFingerprint) {
    this.marker.aliases = uniqueAliases([...(this.marker.aliases || []), nativeThreadId]);
    this.marker.publications[nativeThreadId] = {
      relativePath: relativePath.split(path.sep).join('/'),
      mode,
      baseFingerprint,
      synchronizedAt: new Date().toISOString(),
    };
    this.saveMarker();
  }

  reconcileStoredTargetRollout(nativeThreadId, storedRolloutPath) {
    const relative = assertRelativeRollout(this.sessionsDirectory, storedRolloutPath);
    if (!inspectBaseSessionsRoot(this.baseCodexHome)) {
      return { mode: 'existing-base-missing', rolloutPath: storedRolloutPath };
    }
    const source = findCodexSessionFile({
      codexHome: this.baseCodexHome,
      sessionId: nativeThreadId,
      nativeThreadId,
    });
    if (!source?.rolloutPath) {
      return { mode: 'existing-base-missing', rolloutPath: storedRolloutPath };
    }

    const baseSessions = path.join(this.baseCodexHome, 'sessions');
    const baseRelative = assertRelativeRollout(baseSessions, source.rolloutPath);
    if (pathIdentity(baseRelative) !== pathIdentity(relative)) {
      const error = new Error('managed and base Codex rollouts use different paths for the same thread');
      error.code = 'session_store_rollout_conflict';
      throw error;
    }
    if (sameFileIdentity(source.rolloutPath, storedRolloutPath)) {
      return { mode: 'existing-hardlink', rolloutPath: storedRolloutPath };
    }

    const storedFingerprint = fileFingerprint(storedRolloutPath);
    const baseFingerprint = fileFingerprint(source.rolloutPath);
    if (fingerprintsEqual(storedFingerprint, baseFingerprint)) {
      this.recordCopyBaseline(nativeThreadId, relative, 'copy-baseline', baseFingerprint);
      return { mode: 'existing-copy', rolloutPath: storedRolloutPath };
    }

    const previousBaseFingerprint = this.marker.publications?.[nativeThreadId]?.baseFingerprint;
    const storedIsBaseline = fingerprintsEqual(storedFingerprint, previousBaseFingerprint);
    const baseIsBaseline = fingerprintsEqual(baseFingerprint, previousBaseFingerprint);
    if (baseIsBaseline && !storedIsBaseline) {
      return { mode: 'existing-unpublished', rolloutPath: storedRolloutPath };
    }
    if (storedIsBaseline && !baseIsBaseline) {
      atomicReplaceWithCopy(source.rolloutPath, storedRolloutPath);
      this.recordCopyBaseline(nativeThreadId, relative, 'copy-refresh', baseFingerprint);
      return { mode: 'copy-refresh', rolloutPath: storedRolloutPath, sourceRolloutPath: source.rolloutPath };
    }

    const error = new Error('managed and base Codex rollouts changed independently');
    error.code = 'session_store_rollout_conflict';
    throw error;
  }

  seedTargetRollout() {
    if (!this.targetNativeThreadId) return null;
    const existing = this.findStoredRollout(this.targetNativeThreadId);
    if (existing?.rolloutPath) {
      return this.reconcileStoredTargetRollout(this.targetNativeThreadId, existing.rolloutPath);
    }
    if (!inspectBaseSessionsRoot(this.baseCodexHome)) return null;
    const source = findCodexSessionFile({
      codexHome: this.baseCodexHome,
      sessionId: this.targetNativeThreadId,
      nativeThreadId: this.targetNativeThreadId,
    });
    if (!source?.rolloutPath) return null;
    const baseSessions = path.join(this.baseCodexHome, 'sessions');
    const relative = assertRelativeRollout(baseSessions, source.rolloutPath);
    ensureRolloutParent(this.sessionsDirectory, relative);
    const destination = path.join(this.sessionsDirectory, relative);
    const mode = linkOrCopyRollout(source.rolloutPath, destination, this.fileOptions);
    if (mode === 'copy') {
      this.recordCopyBaseline(
        this.targetNativeThreadId,
        relative,
        'copy-seed',
        fileFingerprint(source.rolloutPath)
      );
    }
    return { mode, rolloutPath: destination, sourceRolloutPath: source.rolloutPath };
  }

  attachToOverlay(overlayCodexHome) {
    const overlayInput = textOrNull(overlayCodexHome);
    if (!overlayInput) {
      const error = new Error('managed Codex overlay HOME is required');
      error.code = 'session_store_overlay_missing';
      throw error;
    }
    const overlay = ensurePlainDirectory(path.resolve(overlayInput));
    const target = path.join(overlay, 'sessions');
    if (lstatIfPresent(target)) {
      const error = new Error('managed Codex overlay already has a sessions entry');
      error.code = 'session_store_overlay_conflict';
      throw error;
    }
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.symlinkSync(this.sessionsDirectory, target, linkType);
    } catch (cause) {
      const error = new Error(`managed Codex Session store could not be attached: ${cause.message}`);
      error.code = 'session_store_link_failed';
      error.cause = cause;
      throw error;
    }
    if (pathIdentity(realPath(target)) !== pathIdentity(realPath(this.sessionsDirectory))) {
      try {
        fs.unlinkSync(target);
      } catch {
        // Preserve the unsafe-link failure.
      }
      const error = new Error('managed Codex Session overlay link resolved to an unexpected path');
      error.code = 'session_store_unsafe_path';
      throw error;
    }
    try {
      this.sessionIndexResult = this.writeScopedSessionIndex(overlay);
    } catch (error) {
      try {
        fs.unlinkSync(target);
      } catch {
        // Preserve the index isolation failure.
      }
      throw error;
    }
    return target;
  }

  writeScopedSessionIndex(overlayCodexHome) {
    if (!this.targetNativeThreadId) {
      return { written: false, reason: 'fresh-launch' };
    }
    const rows = readTargetSessionIndexRows(this.baseCodexHome, this.targetNativeThreadId);
    if (!rows.length) {
      return { written: false, reason: 'target-not-indexed' };
    }
    const target = path.join(overlayCodexHome, SESSION_INDEX_NAME);
    if (lstatIfPresent(target)) {
      const error = new Error('managed Codex overlay already has a Session index');
      error.code = 'session_store_overlay_conflict';
      throw error;
    }
    writePrivateFileExclusive(target, `${rows.join('\n')}\n`);
    return { written: true, rowCount: rows.length, indexPath: target };
  }

  publishNativeThread(nativeThreadId) {
    const identity = textOrNull(nativeThreadId);
    if (!identity) return { published: false, reason: 'native-thread-missing' };
    const stored = this.findStoredRollout(identity);
    if (!stored?.rolloutPath) return { published: false, reason: 'rollout-not-found' };
    const relative = assertRelativeRollout(this.sessionsDirectory, stored.rolloutPath);
    const baseSessions = ensureBaseSessionsRoot(this.baseCodexHome);
    ensureRolloutParent(baseSessions, relative);
    const destination = path.join(baseSessions, relative);
    let mode;
    const destinationStats = lstatIfPresent(destination);
    if (destinationStats && (!destinationStats.isFile() || destinationStats.isSymbolicLink())) {
      const error = new Error('base Codex rollout destination is linked or is not a file');
      error.code = 'session_store_unsafe_rollout';
      throw error;
    }
    if (destinationStats && !sameFileIdentity(stored.rolloutPath, destination)) {
      const sourceFingerprint = fileFingerprint(stored.rolloutPath);
      const destinationFingerprint = fileFingerprint(destination);
      if (!fingerprintsEqual(sourceFingerprint, destinationFingerprint)) {
        const previous = this.marker.publications?.[identity];
        if (!fingerprintsEqual(previous?.baseFingerprint, destinationFingerprint)) {
          const error = new Error('base Codex rollout changed independently of its managed Session store');
          error.code = 'session_store_rollout_conflict';
          throw error;
        }
        atomicReplaceWithCopy(stored.rolloutPath, destination);
        mode = 'copy-sync';
      } else {
        mode = 'copy';
      }
    } else {
      mode = linkOrCopyRollout(stored.rolloutPath, destination, this.fileOptions);
    }
    const baseFingerprint = mode === 'hardlink' ? null : fileFingerprint(destination);
    this.marker.aliases = uniqueAliases([...(this.marker.aliases || []), identity]);
    this.marker.publications[identity] = {
      relativePath: relative.split(path.sep).join('/'),
      mode,
      ...(baseFingerprint ? { baseFingerprint } : {}),
      publishedAt: new Date().toISOString(),
    };
    this.saveMarker();
    return { published: true, mode, rolloutPath: destination };
  }
}

function prepareManagedCodexSessionStore(options = {}) {
  return new ManagedCodexSessionStore(options);
}

module.exports = {
  ManagedCodexSessionStore,
  STORE_MARKER_KIND,
  STORE_MARKER_NAME,
  STORE_MARKER_VERSION,
  STORE_ROOT_NAME,
  prepareManagedCodexSessionStore,
  storeKey,
};
