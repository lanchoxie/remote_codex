const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARCHIVE_MAGIC = Buffer.from('RCSKILL1\n', 'ascii');
const ARCHIVE_VERSION = 1;
const DEFAULT_MAX_FILES = 10000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 50000;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '__pycache__']);
const PORTABLE_EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe', '.ps1']);

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

function positiveLimit(value, fallback, name) {
  if (value == null) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function artifactLimits(options = {}) {
  return {
    maxFiles: positiveLimit(options.maxFiles, DEFAULT_MAX_FILES, 'maxFiles'),
    maxBytes: positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes'),
    maxEntries: positiveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries'),
    maxDepth: positiveLimit(options.maxDepth, DEFAULT_MAX_DEPTH, 'maxDepth'),
    maxManifestBytes: positiveLimit(
      options.maxManifestBytes,
      DEFAULT_MAX_MANIFEST_BYTES,
      'maxManifestBytes'
    ),
  };
}

function normalizeArtifactPath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.length > 4096) {
    throw new Error('artifact path must be a non-empty POSIX relative path');
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error('artifact path must be relative');
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized !== raw
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('artifact path must not traverse outside its root');
  }
  return normalized;
}

function portableExecutableBit(relativePath, firstBytes) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (PORTABLE_EXECUTABLE_EXTENSIONS.has(extension)) {
    return true;
  }
  if (firstBytes.length >= 2 && firstBytes[0] === 0x23 && firstBytes[1] === 0x21) {
    return true;
  }
  if (firstBytes.length >= 2 && firstBytes[0] === 0x4d && firstBytes[1] === 0x5a) {
    return true;
  }
  if (firstBytes.length >= 4) {
    const magic = firstBytes.readUInt32BE(0);
    return magic === 0x7f454c46
      || magic === 0xcafebabe
      || magic === 0xfeedface
      || magic === 0xfeedfacf
      || magic === 0xcefaedfe
      || magic === 0xcffaedfe;
  }
  return false;
}

function updateContentHashPrefix(digest, file) {
  digest.update('path\0');
  digest.update(file.path, 'utf8');
  digest.update('\0executable\0');
  digest.update(file.executable ? '1' : '0');
  digest.update('\0length\0');
  digest.update(String(file.size));
  digest.update('\0content\0');
}

async function readDirectoryEntriesBounded(directoryPath, budget) {
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
        throw new Error(`skill contains more than ${budget.max} filesystem entries`);
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

async function readOpenFile(handle, expectedSize, onChunk) {
  let position = 0;
  while (position < expectedSize) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) {
      throw new Error('skill file changed while reading');
    }
    const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    await onChunk(chunk);
    position += bytesRead;
  }
  const growthProbe = Buffer.allocUnsafe(1);
  const { bytesRead: extraBytes } = await handle.read(growthProbe, 0, 1, expectedSize);
  if (extraBytes) {
    throw new Error('skill file changed while reading');
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!bytesWritten) {
      throw new Error('unable to write complete skill artifact archive');
    }
    offset += bytesWritten;
  }
}

async function readExact(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (!bytesRead) {
      return false;
    }
    offset += bytesRead;
  }
  return true;
}

async function captureSkillDirectory(rootPath, options = {}) {
  const limits = artifactLimits(options);
  const resolvedRoot = path.resolve(rootPath);
  const rootRealPath = await fs.promises.realpath(resolvedRoot);
  const rootStats = await fs.promises.stat(rootRealPath);
  if (!rootStats.isDirectory()) {
    throw new Error(`not a directory: ${resolvedRoot}`);
  }

  const files = [];
  const activeDirectories = new Set();
  const entryBudget = { count: 0, max: limits.maxEntries };
  let declaredTotalBytes = 0;

  async function visit(directoryPath, relativeDirectory, depth) {
    if (depth > limits.maxDepth) {
      throw new Error(`skill directory depth exceeds ${limits.maxDepth}`);
    }
    const directoryRealPath = await fs.promises.realpath(directoryPath);
    if (!isPathInside(rootRealPath, directoryRealPath)) {
      throw new Error(`linked path resolves outside skill root: ${directoryPath}`);
    }
    if (activeDirectories.has(directoryRealPath)) {
      throw new Error(`cyclic directory link in skill: ${directoryPath}`);
    }
    activeDirectories.add(directoryRealPath);
    try {
      const entries = await readDirectoryEntriesBounded(directoryRealPath, entryBudget);
      for (const entry of entries) {
        const displayPath = path.join(directoryRealPath, entry.name);
        const targetRealPath = await fs.promises.realpath(displayPath);
        if (!isPathInside(rootRealPath, targetRealPath)) {
          throw new Error(`linked path resolves outside skill root: ${displayPath}`);
        }
        const targetStats = await fs.promises.stat(targetRealPath);
        if (IGNORED_DIRECTORY_NAMES.has(entry.name) && targetStats.isDirectory()) {
          continue;
        }
        const relativePath = normalizeArtifactPath(toPosixPath(
          relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        ));
        if (targetStats.isDirectory()) {
          await visit(targetRealPath, relativePath, depth + 1);
          continue;
        }
        if (!targetStats.isFile()) {
          throw new Error(`unsupported filesystem entry in skill: ${displayPath}`);
        }
        declaredTotalBytes += targetStats.size;
        if (declaredTotalBytes > limits.maxBytes) {
          throw new Error(`skill content exceeds ${limits.maxBytes} bytes`);
        }
        files.push({
          path: relativePath,
          realPath: targetRealPath,
          size: targetStats.size,
        });
        if (files.length > limits.maxFiles) {
          throw new Error(`skill contains more than ${limits.maxFiles} files`);
        }
      }
    } finally {
      activeDirectories.delete(directoryRealPath);
    }
  }

  await visit(rootRealPath, '', 0);
  files.sort((left, right) => compareText(left.path, right.path));
  if (options.requireSkillMarkdown && !files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('skill artifact requires a root SKILL.md');
  }

  const contentDigest = crypto.createHash('sha256');
  let totalBytes = 0;
  for (const file of files) {
    const handle = await fs.promises.open(
      file.realPath,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== file.size) {
        throw new Error(`skill file changed while hashing: ${file.realPath}`);
      }
      totalBytes += stats.size;
      if (totalBytes > limits.maxBytes) {
        throw new Error(`skill content exceeds ${limits.maxBytes} bytes`);
      }
      const firstBytes = Buffer.allocUnsafe(Math.min(4, stats.size));
      if (firstBytes.length) {
        const { bytesRead } = await handle.read(firstBytes, 0, firstBytes.length, 0);
        if (bytesRead !== firstBytes.length) {
          throw new Error(`skill file changed while hashing: ${file.realPath}`);
        }
      }
      file.executable = portableExecutableBit(file.path, firstBytes);
      const fileDigest = crypto.createHash('sha256');
      updateContentHashPrefix(contentDigest, file);
      await readOpenFile(handle, stats.size, async (chunk) => {
        fileDigest.update(chunk);
        contentDigest.update(chunk);
      });
      file.sha256 = fileDigest.digest('hex');
      contentDigest.update('\0');
    } finally {
      await handle.close();
    }
  }

  return {
    rootPath: resolvedRoot,
    realPath: rootRealPath,
    contentHash: `sha256:${contentDigest.digest('hex')}`,
    fileCount: files.length,
    totalBytes,
    files,
  };
}

function publicFiles(files) {
  return files.map((file) => ({
    path: file.path,
    size: file.size,
    executable: Boolean(file.executable),
    sha256: file.sha256,
  }));
}

async function inspectSkillArtifactArchive(archivePath, options = {}) {
  const limits = artifactLimits(options);
  const resolvedPath = path.resolve(archivePath);
  const handle = await fs.promises.open(resolvedPath, fs.constants.O_RDONLY);
  try {
    const stats = await handle.stat();
    const minimumBytes = ARCHIVE_MAGIC.length + 4 + 2;
    if (!stats.isFile() || stats.size < minimumBytes) {
      throw new Error('skill artifact archive is truncated');
    }
    if (stats.size > limits.maxBytes + limits.maxManifestBytes + ARCHIVE_MAGIC.length + 4) {
      throw new Error('skill artifact archive exceeds configured size limits');
    }
    const prefix = Buffer.allocUnsafe(ARCHIVE_MAGIC.length + 4);
    if (!await readExact(handle, prefix, 0) || !prefix.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
      throw new Error('invalid skill artifact archive magic');
    }
    const manifestLength = prefix.readUInt32BE(ARCHIVE_MAGIC.length);
    if (!manifestLength || manifestLength > limits.maxManifestBytes) {
      throw new Error('skill artifact manifest exceeds configured size limits');
    }
    const payloadOffset = prefix.length + manifestLength;
    if (payloadOffset > stats.size) {
      throw new Error('skill artifact archive is truncated');
    }
    const manifestBuffer = Buffer.allocUnsafe(manifestLength);
    if (!await readExact(handle, manifestBuffer, prefix.length)) {
      throw new Error('skill artifact manifest is truncated');
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestBuffer.toString('utf8'));
    } catch (error) {
      throw new Error(`invalid skill artifact manifest: ${error.message}`);
    }
    if (!manifest || manifest.version !== ARCHIVE_VERSION || !Array.isArray(manifest.files)) {
      throw new Error('unsupported skill artifact manifest');
    }
    if (!manifest.files.length || manifest.files.length > limits.maxFiles) {
      throw new Error(`skill artifact must contain between 1 and ${limits.maxFiles} files`);
    }

    const files = [];
    let totalBytes = 0;
    let previousPath = null;
    for (const rawFile of manifest.files) {
      if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) {
        throw new Error('skill artifact file entry must be an object');
      }
      const filePath = normalizeArtifactPath(rawFile.path);
      if (previousPath != null && compareText(previousPath, filePath) >= 0) {
        throw new Error('skill artifact paths must be unique and sorted');
      }
      if (!Number.isSafeInteger(rawFile.size) || rawFile.size < 0) {
        throw new Error(`invalid skill artifact size for ${filePath}`);
      }
      if (typeof rawFile.executable !== 'boolean') {
        throw new Error(`invalid executable metadata for ${filePath}`);
      }
      const fileHash = String(rawFile.sha256 || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(fileHash)) {
        throw new Error(`invalid file hash for ${filePath}`);
      }
      totalBytes += rawFile.size;
      if (totalBytes > limits.maxBytes) {
        throw new Error(`skill content exceeds ${limits.maxBytes} bytes`);
      }
      files.push({
        path: filePath,
        size: rawFile.size,
        executable: rawFile.executable,
        sha256: fileHash,
      });
      previousPath = filePath;
    }
    if (!files.some((file) => file.path === 'SKILL.md')) {
      throw new Error('skill artifact requires a root SKILL.md');
    }
    if (payloadOffset + totalBytes !== stats.size) {
      throw new Error(payloadOffset + totalBytes > stats.size
        ? 'skill artifact payload is truncated'
        : 'skill artifact archive has unexpected trailing content');
    }

    const contentDigest = crypto.createHash('sha256');
    let position = payloadOffset;
    for (const file of files) {
      const fileDigest = crypto.createHash('sha256');
      updateContentHashPrefix(contentDigest, file);
      let remaining = file.size;
      while (remaining > 0) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) {
          throw new Error(`skill artifact content is truncated: ${file.path}`);
        }
        const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
        fileDigest.update(chunk);
        contentDigest.update(chunk);
        position += bytesRead;
        remaining -= bytesRead;
      }
      if (fileDigest.digest('hex') !== file.sha256) {
        throw new Error(`skill artifact file hash mismatch: ${file.path}`);
      }
      contentDigest.update('\0');
    }
    const contentHash = `sha256:${contentDigest.digest('hex')}`;
    return {
      artifactId: contentHash,
      contentHash,
      archiveBytes: stats.size,
      fileCount: files.length,
      totalBytes,
      files,
    };
  } finally {
    await handle.close();
  }
}

async function createSkillArtifactArchive(rootPath, archivePath, options = {}) {
  const capture = await captureSkillDirectory(rootPath, {
    ...options,
    requireSkillMarkdown: true,
  });
  const targetPath = path.resolve(archivePath);
  if (isPathInside(capture.realPath, targetPath)) {
    throw new Error('skill artifact archive must be written outside the skill root');
  }
  const files = publicFiles(capture.files);
  const manifest = Buffer.from(JSON.stringify({
    version: ARCHIVE_VERSION,
    files,
  }), 'utf8');
  const limits = artifactLimits(options);
  if (manifest.length > limits.maxManifestBytes) {
    throw new Error('skill artifact manifest exceeds configured size limits');
  }
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(manifest.length, 0);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let output = null;
  try {
    output = await fs.promises.open(tempPath, 'wx');
    await writeAll(output, ARCHIVE_MAGIC);
    await writeAll(output, lengthBuffer);
    await writeAll(output, manifest);
    for (const file of capture.files) {
      const input = await fs.promises.open(
        file.realPath,
        fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)
      );
      try {
        const stats = await input.stat();
        if (!stats.isFile() || stats.size !== file.size) {
          throw new Error(`skill file changed while archiving: ${file.realPath}`);
        }
        const digest = crypto.createHash('sha256');
        await readOpenFile(input, file.size, async (chunk) => {
          digest.update(chunk);
          await writeAll(output, chunk);
        });
        if (digest.digest('hex') !== file.sha256) {
          throw new Error(`skill file changed while archiving: ${file.realPath}`);
        }
      } finally {
        await input.close();
      }
    }
    await output.sync();
    await output.close();
    output = null;
    const inspected = await inspectSkillArtifactArchive(tempPath, options);
    if (inspected.contentHash !== capture.contentHash) {
      throw new Error('skill artifact content hash changed while archiving');
    }
    await fs.promises.rename(tempPath, targetPath);
    return inspected;
  } finally {
    if (output) {
      await output.close().catch(() => {});
    }
    await fs.promises.unlink(tempPath).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

async function extractSkillArtifactArchive(archivePath, targetPath, options = {}) {
  const inspection = await inspectSkillArtifactArchive(archivePath, options);
  if (options.expectedHash != null) {
    const expectedHash = String(options.expectedHash || '').trim().toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error('expectedHash must be a sha256 digest');
    }
    if (inspection.contentHash !== expectedHash) {
      throw new Error(
        `skill artifact hash ${inspection.contentHash} does not match expected hash ${expectedHash}`
      );
    }
  }

  const resolvedArchivePath = path.resolve(archivePath);
  const resolvedTargetPath = path.resolve(targetPath);
  try {
    await fs.promises.lstat(resolvedTargetPath);
    throw new Error(`skill artifact extraction target already exists; expected a new directory: ${resolvedTargetPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.promises.mkdir(path.dirname(resolvedTargetPath), { recursive: true });
  let createdTarget = false;
  let archive = null;
  try {
    await fs.promises.mkdir(resolvedTargetPath);
    createdTarget = true;
    archive = await fs.promises.open(resolvedArchivePath, fs.constants.O_RDONLY);
    const prefix = Buffer.allocUnsafe(ARCHIVE_MAGIC.length + 4);
    if (!await readExact(archive, prefix, 0)) {
      throw new Error('skill artifact archive is truncated');
    }
    const manifestLength = prefix.readUInt32BE(ARCHIVE_MAGIC.length);
    let archivePosition = prefix.length + manifestLength;

    for (const file of inspection.files) {
      const outputPath = path.resolve(resolvedTargetPath, ...file.path.split('/'));
      if (!isPathInside(resolvedTargetPath, outputPath) || outputPath === resolvedTargetPath) {
        throw new Error(`skill artifact extraction path escapes target root: ${file.path}`);
      }
      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
      const output = await fs.promises.open(outputPath, 'wx');
      const digest = crypto.createHash('sha256');
      try {
        let remaining = file.size;
        while (remaining > 0) {
          const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
          const { bytesRead } = await archive.read(buffer, 0, buffer.length, archivePosition);
          if (!bytesRead) {
            throw new Error(`skill artifact content is truncated: ${file.path}`);
          }
          const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
          digest.update(chunk);
          await writeAll(output, chunk);
          archivePosition += bytesRead;
          remaining -= bytesRead;
        }
        await output.sync();
      } finally {
        await output.close();
      }
      if (digest.digest('hex') !== file.sha256) {
        throw new Error(`skill artifact file hash mismatch while extracting: ${file.path}`);
      }
      if (process.platform !== 'win32') {
        await fs.promises.chmod(outputPath, file.executable ? 0o755 : 0o644);
      }
    }

    const extracted = await captureSkillDirectory(resolvedTargetPath, {
      ...options,
      requireSkillMarkdown: true,
    });
    if (extracted.contentHash !== inspection.contentHash) {
      throw new Error('extracted skill directory hash does not match the artifact');
    }
    return inspection;
  } catch (error) {
    if (createdTarget) {
      await fs.promises.rm(resolvedTargetPath, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (archive) {
      await archive.close().catch(() => {});
    }
  }
}

module.exports = {
  ARCHIVE_MAGIC,
  DEFAULT_MAX_ENTRIES,
  captureSkillDirectory,
  createSkillArtifactArchive,
  extractSkillArtifactArchive,
  inspectSkillArtifactArchive,
  normalizeArtifactPath,
};
