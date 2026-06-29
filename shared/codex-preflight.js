const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function cleanString(value) {
  return String(value || '').trim();
}

function expandHome(value) {
  const text = cleanString(value);
  if (text === '~') {
    return os.homedir();
  }
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function isExecutableCandidate(filePath) {
  if (!filePath || !fileExists(filePath)) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch (_) {
    return false;
  }
}

function findCodexOnPath(envPath = process.env.PATH || '') {
  const names = process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
    : ['codex'];
  for (const dir of String(envPath || '').split(path.delimiter)) {
    const trimmed = cleanString(dir);
    if (!trimmed) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(trimmed, name);
      if (isExecutableCandidate(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

function defaultCodexHome() {
  return path.join(os.homedir(), '.codex');
}

function checkLocalCodexPreflight(options = {}) {
  const checks = [];
  const errors = [];
  const warnings = [];
  const codexHome = expandHome(options.codexHome || process.env.CODEX_HOME || defaultCodexHome());
  const codexBin = cleanString(options.codexBin || process.env.CODEX_BIN) || findCodexOnPath(options.pathEnv || process.env.PATH);

  if (codexBin && isExecutableCandidate(codexBin)) {
    checks.push({ code: 'codex_cli_found', ok: true, path: codexBin });
  } else {
    errors.push({
      code: 'codex_cli_missing',
      message: 'Codex CLI was not found. Install the Cursor/OpenAI Codex extension or set CODEX_BIN to the codex executable.',
    });
  }

  if (!fileExists(codexHome)) {
    errors.push({
      code: 'codex_home_missing',
      message: `CODEX_HOME does not exist: ${codexHome}`,
      path: codexHome,
    });
  } else {
    checks.push({ code: 'codex_home_found', ok: true, path: codexHome });
    const initFiles = ['auth.json', 'config.toml'];
    const hasInitFile = initFiles.some((name) => fileExists(path.join(codexHome, name)));
    const sessionsDir = path.join(codexHome, 'sessions');
    if (!hasInitFile || !fileExists(sessionsDir)) {
      errors.push({
        code: 'codex_home_uninitialized',
        message: `CODEX_HOME exists but does not look initialized: ${codexHome}`,
        path: codexHome,
      });
    } else {
      checks.push({ code: 'codex_home_initialized', ok: true, path: codexHome });
    }
  }

  if (codexBin && isExecutableCandidate(codexBin) && options.runHelp !== false) {
    const help = spawnSync(codexBin, ['--help'], {
      encoding: 'utf8',
      timeout: options.helpTimeoutMs || 8_000,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });
    if (help.error || help.status !== 0) {
      errors.push({
        code: 'codex_cli_help_failed',
        message: `Codex CLI was found but "codex --help" failed: ${help.error?.message || help.stderr || help.status}`,
      });
    } else {
      checks.push({ code: 'codex_cli_help_ok', ok: true });
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    checks.push({ code: 'codex_preflight_ok', ok: true });
  }

  return {
    ok: errors.length === 0,
    codexHome,
    codexBin,
    checks,
    warnings,
    errors,
  };
}

module.exports = {
  checkLocalCodexPreflight,
  defaultCodexHome,
  expandHome,
  findCodexOnPath,
};
