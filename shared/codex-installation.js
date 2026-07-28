const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 32 * 1024;

function cleanString(value) {
  return String(value || '').trim();
}

function normalizedPath(value) {
  return cleanString(value).replace(/\\/g, '/').toLowerCase();
}

function isWindowsCommandShim(filePath, platform = process.platform) {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(cleanString(filePath));
}

function executableNames(name, platform = process.platform) {
  if (platform !== 'win32') return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

function findExecutableOnPath(name, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const platform = options.platform || process.platform;
  const envPath = Object.prototype.hasOwnProperty.call(options, 'envPath')
    ? options.envPath
    : process.env.PATH;
  for (const directory of String(envPath || '').split(path.delimiter)) {
    const root = cleanString(directory).replace(/^"|"$/g, '');
    if (!root) continue;
    for (const candidateName of executableNames(name, platform)) {
      const candidate = path.join(root, candidateName);
      try {
        if (fileSystem.statSync(candidate).isFile()) return candidate;
      } catch (_) {
        // Keep searching the remaining PATH entries.
      }
    }
  }
  return '';
}

function parseCodexVersion(value) {
  const text = cleanString(value);
  if (!text) return null;
  const match = text.match(/(?:^|\s|\/|@)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=$|\s|\))/);
  return match ? match[1] : null;
}

function safeRealPath(filePath, fileSystem = fs) {
  try {
    return fileSystem.realpathSync(filePath);
  } catch (_) {
    return cleanString(filePath);
  }
}

function readSmallText(filePath, fileSystem = fs) {
  try {
    const stats = fileSystem.statSync(filePath);
    if (!stats.isFile() || stats.size > 128 * 1024) return '';
    return fileSystem.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function npmPackageRootFromPath(filePath) {
  const normalized = cleanString(filePath).replace(/\\/g, '/');
  const match = normalized.match(/^(.*\/node_modules\/@openai\/codex)(?:\/|$)/i);
  return match ? match[1] : null;
}

function readCodexPackage(packageRoot, fileSystem = fs) {
  if (!packageRoot) return null;
  try {
    const manifest = JSON.parse(fileSystem.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const binTarget = typeof manifest?.bin === 'string'
      ? manifest.bin
      : manifest?.bin?.codex;
    if (manifest?.name !== '@openai/codex' || !manifest.version || !binTarget) return null;
    return {
      root: packageRoot,
      version: String(manifest.version),
      binTarget: String(binTarget),
    };
  } catch (_) {
    return null;
  }
}

function resolveNpmCliPath(npmBin, fileSystem = fs) {
  const binPath = cleanString(npmBin);
  if (!binPath) return '';
  const realPath = safeRealPath(binPath, fileSystem);
  const candidates = [realPath];
  if (/\.(cmd|bat)$/i.test(binPath)) {
    candidates.push(path.join(path.dirname(binPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      if (
        path.basename(candidate).toLowerCase() === 'npm-cli.js'
        && fileSystem.statSync(candidate).isFile()
      ) {
        const npmRoot = path.resolve(candidate, '..', '..');
        const manifest = JSON.parse(fileSystem.readFileSync(path.join(npmRoot, 'package.json'), 'utf8'));
        const npmTarget = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.npm;
        if (
          manifest?.name === 'npm'
          && npmTarget
          && path.resolve(npmRoot, npmTarget) === path.resolve(candidate)
        ) {
          return candidate;
        }
      }
    } catch (_) {
      // Try the next npm CLI candidate.
    }
  }
  return '';
}

function npmPrefixFromPackageRoot(packageRoot) {
  if (!packageRoot) return '';
  const nodeModules = path.dirname(path.dirname(packageRoot));
  if (path.basename(nodeModules).toLowerCase() !== 'node_modules') return '';
  const parent = path.dirname(nodeModules);
  return path.resolve(path.basename(parent).toLowerCase() === 'lib' ? path.dirname(parent) : parent);
}

function pathIsWithin(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function inferNpmPrefix(binPath, platform = process.platform) {
  const resolved = path.resolve(cleanString(binPath) || '.');
  if (platform === 'win32') {
    return path.dirname(resolved);
  }
  const binDirectory = path.dirname(resolved);
  return path.basename(binDirectory) === 'bin'
    ? path.dirname(binDirectory)
    : path.dirname(binDirectory);
}

function classifyCodexInstallation(input = {}, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const platform = input.platform || options.platform || process.platform;
  const binPath = cleanString(input.binPath);
  const realPath = cleanString(input.realPath || safeRealPath(binPath, fileSystem));
  const binNormalized = normalizedPath(binPath);
  const realNormalized = normalizedPath(realPath);
  const combined = `${binNormalized}\n${realNormalized}`;
  const shimText = readSmallText(binPath, fileSystem);
  const shimNormalized = normalizedPath(shimText);
  const explicit = input.explicit === true;

  if (combined.includes('/.cursor/extensions/openai.chatgpt-')) {
    return {
      source: 'cursor_extension',
      packageManager: null,
      packageRoot: null,
      npmBin: null,
      npmPrefix: null,
      canAutoUpdate: false,
      updateReason: 'Update the Cursor/OpenAI extension that owns this Codex binary.',
    };
  }

  if (combined.includes('/.runtime/codex/') || combined.includes('/runtimes/codex/')) {
    return {
      source: 'bundled_runtime',
      packageManager: null,
      packageRoot: null,
      npmBin: null,
      npmPrefix: null,
      canAutoUpdate: false,
      updateReason: 'This bundled Codex runtime must be replaced by a matching Remote Codex runtime bundle.',
    };
  }

  const inferredPrefix = inferNpmPrefix(binPath, platform);
  const packageCandidates = [
    npmPackageRootFromPath(realPath),
    platform === 'win32' ? path.join(inferredPrefix, 'node_modules', '@openai', 'codex') : null,
    platform !== 'win32' ? path.join(inferredPrefix, 'lib', 'node_modules', '@openai', 'codex') : null,
    path.join(inferredPrefix, 'node_modules', '@openai', 'codex'),
  ].filter(Boolean);
  const verifiedPackage = packageCandidates
    .map((candidate) => readCodexPackage(candidate, fileSystem))
    .find(Boolean) || null;
  const packageRoot = verifiedPackage?.root || null;
  const npmPrefix = npmPrefixFromPackageRoot(packageRoot) || inferredPrefix;
  const expectedBinDirectory = platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  const binOwnedByPrefix = path.resolve(path.dirname(binPath)) === path.resolve(expectedBinDirectory);
  const realPathMatchesManifest = Boolean(
    verifiedPackage
    && (
      (
        pathIsWithin(verifiedPackage.root, realPath)
        && path.resolve(realPath) === path.resolve(verifiedPackage.root, verifiedPackage.binTarget)
      )
      || shimNormalized.includes('node_modules/@openai/codex')
    )
  );
  const localNodeModules = combined.includes('/node_modules/.bin/')
    && !realNormalized.includes('/lib/node_modules/@openai/codex/');
  const npmEvidence = Boolean(packageRoot && binOwnedByPrefix && realPathMatchesManifest);

  if (localNodeModules) {
    return {
      source: 'npm_local',
      packageManager: 'npm',
      packageRoot,
      npmBin: null,
      npmPrefix: null,
      canAutoUpdate: false,
      updateReason: 'Project-local Codex installations are not changed by Host maintenance.',
    };
  }

  if (npmEvidence) {
    const sameDirectoryNpm = executableNames('npm', platform)
      .map((name) => path.join(path.dirname(binPath), name))
      .find((candidate) => {
        try {
          return fileSystem.statSync(candidate).isFile();
        } catch (_) {
          return false;
        }
      }) || '';
    const requestedNpmBin = cleanString(input.npmBin);
    const pathNpmBin = findExecutableOnPath('npm', {
      fileSystem,
      platform,
      envPath: input.envPath,
    });
    const npmResolution = [requestedNpmBin, sameDirectoryNpm, pathNpmBin]
      .filter(Boolean)
      .map((candidate) => ({
        binPath: candidate,
        cliPath: resolveNpmCliPath(candidate, fileSystem),
      }))
      .find((candidate) => candidate.cliPath) || null;
    const npmBin = npmResolution?.binPath || '';
    const npmCliPath = npmResolution?.cliPath || '';
    const sameDirectoryNode = executableNames('node', platform)
      .map((name) => path.join(expectedBinDirectory, name))
      .find((candidate) => {
        try {
          return fileSystem.statSync(candidate).isFile();
        } catch (_) {
          return false;
        }
      }) || '';
    const pathNodeBin = findExecutableOnPath('node', {
      fileSystem,
      platform,
      envPath: input.envPath,
    });
    return {
      source: 'npm_global',
      packageManager: 'npm',
      packageRoot,
      packageVersion: verifiedPackage.version,
      npmBin: npmBin || null,
      npmCliPath: npmCliPath || null,
      nodeBin: sameDirectoryNode || pathNodeBin || null,
      npmPrefix,
      canAutoUpdate: Boolean(npmBin && npmCliPath),
      updateReason: npmBin && npmCliPath
        ? null
        : 'The npm CLI that owns this verified global package could not be resolved safely.',
    };
  }

  return {
    source: explicit ? 'explicit_unknown' : 'unknown',
    packageManager: null,
    packageRoot: null,
    packageVersion: null,
    npmBin: null,
    npmCliPath: null,
    npmPrefix: null,
    canAutoUpdate: false,
    updateReason: explicit
      ? 'The explicit CODEX_BIN installation is not recognized as an npm global install.'
      : 'The Codex installation source could not be identified safely.',
  };
}

function probeCodexInstallation(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const binPath = cleanString(options.codexBin || process.env.CODEX_BIN || 'codex');
  const realPath = safeRealPath(binPath, fileSystem);
  const result = spawnSyncImpl(binPath, ['--version'], {
    encoding: 'utf8',
    timeout: Math.max(500, Number(options.timeoutMs || 8000) || 8000),
    shell: isWindowsCommandShim(binPath, platform),
    env: options.env || process.env,
  });
  const rawVersion = cleanString(result?.stdout || result?.stderr).slice(0, 512);
  const error = result?.error
    ? result.error.message
    : result?.status !== 0
      ? `codex --version exited with ${result?.status}`
      : null;
  const classification = classifyCodexInstallation({
    binPath,
    realPath,
    explicit: options.explicit === true,
    platform,
    envPath: options.env?.PATH || process.env.PATH,
    npmBin: options.npmBin,
  }, { fileSystem, platform });

  return {
    binPath,
    realPath,
    version: error ? null : parseCodexVersion(rawVersion),
    rawVersion: rawVersion || null,
    platform,
    arch,
    probedAt: new Date().toISOString(),
    error,
    ...classification,
  };
}

function appendBounded(existing, chunk, limit = OUTPUT_LIMIT) {
  const next = `${existing || ''}${String(chunk || '')}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode != null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function terminateProcessTree(child, options = {}) {
  if (!child?.pid) return false;
  if (typeof options.terminateProcessTree === 'function') {
    return options.terminateProcessTree(child, options);
  }
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await waitForExit(killer, 5000);
    return waitForExit(child, 5000);
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (_) {
    try {
      child.kill('SIGTERM');
    } catch (_) {
      return false;
    }
  }
  if (await waitForExit(child, 3000)) return true;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (_) {
    try {
      child.kill('SIGKILL');
    } catch (_) {
      return false;
    }
  }
  return waitForExit(child, 3000);
}

function runProcess(command, args, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_UPDATE_TIMEOUT_MS));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };
    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        shell: options.shell === true,
        detached: options.killProcessTree === true && (options.platform || process.platform) !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({ stdout, stderr, timedOut: false, exitCode: null, signal: null, error });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', (error) => finish({ exitCode: null, signal: null, error }));
    child.once('exit', (exitCode, signal) => finish({ exitCode, signal, error: null }));
    if (typeof options.onSpawn === 'function') {
      try {
        options.onSpawn({ pid: child.pid, command, args });
      } catch (error) {
        void terminateProcessTree(child, options).then((terminated) => {
          finish({
            exitCode: child.exitCode,
            signal: 'ON_SPAWN_FAILED',
            error: terminated
              ? error
              : new Error(`Updater bookkeeping failed and its process tree could not be stopped: ${error.message || error}`),
          });
        });
        return;
      }
    }
    timer = setTimeout(async () => {
      timedOut = true;
      const terminated = await terminateProcessTree(child, options);
      finish({
        exitCode: child.exitCode,
        signal: 'TIMEOUT',
        error: terminated ? null : new Error('Updater process tree did not exit after timeout.'),
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function updateCodexInstallation(current, options = {}) {
  if (!current?.canAutoUpdate || current.source !== 'npm_global' || !current.npmCliPath) {
    const error = new Error(current?.updateReason || 'This Codex installation cannot be updated automatically.');
    error.code = 'codex_update_unsupported';
    throw error;
  }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  await onProgress({ phase: 'installing', message: 'Installing the latest @openai/codex package.' });
  const env = {
    ...process.env,
    ...(options.env || {}),
    ...(current.npmPrefix ? { NPM_CONFIG_PREFIX: current.npmPrefix } : {}),
  };
  const args = [
    current.npmCliPath,
    'install',
    '--global',
    '@openai/codex@latest',
    '--include=optional',
    '--no-audit',
    '--no-fund',
  ];
  const result = await (options.runProcess || runProcess)(options.nodeBin || current.nodeBin || process.execPath, args, {
    env,
    shell: false,
    platform: current.platform,
    killProcessTree: true,
    onSpawn: options.onSpawn,
    timeoutMs: options.timeoutMs || DEFAULT_UPDATE_TIMEOUT_MS,
  });
  if (result.error || result.timedOut || result.exitCode !== 0) {
    const detail = cleanString(result.error?.message || result.stderr || result.stdout || result.signal || result.exitCode);
    const error = new Error(result.timedOut
      ? 'Codex npm update timed out.'
      : `Codex npm update failed${detail ? `: ${detail.slice(0, 2000)}` : '.'}`);
    error.code = result.timedOut ? 'codex_update_timeout' : 'codex_update_failed';
    throw error;
  }

  await onProgress({ phase: 'verifying', message: 'Verifying the updated Codex binary.' });
  const next = probeCodexInstallation({
    codexBin: current.binPath,
    explicit: true,
    env,
    fileSystem: options.fileSystem,
    spawnSync: options.spawnSync,
    platform: current.platform,
    arch: current.arch,
    npmBin: current.npmBin,
  });
  if (next.error || !next.version) {
    const error = new Error(next.error || 'The updated Codex binary did not report a version.');
    error.code = 'codex_update_verification_failed';
    throw error;
  }
  return {
    ok: true,
    previousVersion: current.version || null,
    version: next.version,
    changed: Boolean(current.version && current.version !== next.version),
    installation: next,
    output: cleanString(result.stdout || result.stderr).slice(-4000) || null,
  };
}

module.exports = {
  classifyCodexInstallation,
  findExecutableOnPath,
  parseCodexVersion,
  probeCodexInstallation,
  runProcess,
  updateCodexInstallation,
};
