const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkLocalCodexPreflight,
  findCodexInCursorExtensions,
  spawnCodexForPreflight,
} = require('../shared/codex-preflight');

const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'host-agent', 'codex-app-server-runner.js'), 'utf8');

function makeTempHome(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `remote-codex-${name}-`));
  return root;
}

function makeWorkspaceTempHome(name) {
  const rootBase = path.join(__dirname, '..', 'tmp', 'test-codex-preflight');
  fs.mkdirSync(rootBase, { recursive: true });
  return fs.mkdtempSync(path.join(rootBase, `${name}-`));
}

function makeCodexBin(dir, name = process.platform === 'win32' ? 'codex.cmd' : 'codex') {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, process.platform === 'win32' ? '@echo codex help\r\n' : '#!/bin/sh\necho codex help\n', 'utf8');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function makeNodeBackedWindowsShim(dir, name = 'codex.cmd') {
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'codex-shim.js');
  fs.writeFileSync(scriptPath, [
    'if (process.argv.includes("--help")) {',
    '  console.log("Codex CLI");',
    '  process.exit(0);',
    '}',
    'console.error("unexpected args: " + process.argv.slice(2).join(" "));',
    'process.exit(2);',
    '',
  ].join('\n'), 'utf8');
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, [
    '@ECHO off',
    'node "%~dp0\\codex-shim.js" %*',
    '',
  ].join('\r\n'), 'utf8');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function writeInitializedHome(home) {
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5"\n', 'utf8');
}

{
  const home = makeTempHome('missing-bin');
  writeInitializedHome(home);
  const result = checkLocalCodexPreflight({
    codexHome: home,
    codexBin: path.join(home, 'missing-codex.cmd'),
    runHelp: false,
  });
  assert.strictEqual(result.ok, false, 'missing codex binary should fail preflight');
  assert(result.errors.some((item) => item.code === 'codex_cli_missing'), 'missing codex should report codex_cli_missing');
}

{
  const bin = makeCodexBin(makeTempHome('bin-only'));
  const result = checkLocalCodexPreflight({
    codexHome: path.join(os.tmpdir(), 'remote-codex-home-does-not-exist'),
    codexBin: bin,
    runHelp: false,
  });
  assert.strictEqual(result.ok, false, 'missing CODEX_HOME should fail preflight');
  assert(result.errors.some((item) => item.code === 'codex_home_missing'), 'missing home should report codex_home_missing');
}

{
  const home = makeTempHome('uninitialized-home');
  const bin = makeCodexBin(makeTempHome('bin-uninitialized'));
  const result = checkLocalCodexPreflight({
    codexHome: home,
    codexBin: bin,
    runHelp: false,
  });
  assert.strictEqual(result.ok, false, 'uninitialized CODEX_HOME should fail preflight');
  assert(result.errors.some((item) => item.code === 'codex_home_uninitialized'), 'uninitialized home should report codex_home_uninitialized');
}

{
  const home = makeTempHome('initialized-home');
  const bin = makeCodexBin(makeTempHome('bin-initialized'));
  writeInitializedHome(home);
  const result = checkLocalCodexPreflight({
    codexHome: home,
    codexBin: bin,
    runHelp: false,
  });
  assert.strictEqual(result.ok, true, 'initialized Codex home and executable should pass preflight');
  assert(result.checks.some((item) => item.code === 'codex_cli_found'), 'valid preflight should report codex_cli_found');
  assert(result.checks.some((item) => item.code === 'codex_home_initialized'), 'valid preflight should report codex_home_initialized');
}

if (process.platform === 'win32') {
  for (const extension of ['cmd', 'bat']) {
    const home = makeWorkspaceTempHome(`windows-${extension}-home`);
    const bin = makeNodeBackedWindowsShim(makeWorkspaceTempHome(`windows-${extension}-bin`), `codex.${extension}`);
    writeInitializedHome(home);

    const direct = require('child_process').spawnSync(bin, ['--help'], {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
      shell: false,
    });
    assert(
      direct.error || direct.status !== 0,
      `Windows codex.${extension} shim should demonstrate the direct shell:false spawn failure this regression covers`
    );

    const wrapped = spawnCodexForPreflight(bin, ['--help'], {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: home },
    });
    assert.strictEqual(wrapped.status, 0, `preflight should execute Windows codex.${extension} shim through the shell wrapper`);
    assert.match(wrapped.stdout, /Codex CLI/, `preflight should capture codex.${extension} help output`);

    const result = checkLocalCodexPreflight({
      codexHome: home,
      codexBin: bin,
    });
    assert.strictEqual(result.ok, true, `Windows codex.${extension} shim should pass local preflight`);
    assert(result.checks.some((item) => item.code === 'codex_cli_help_ok'), `codex.${extension} help check should pass`);
  }
}

assert(
  runnerSource.includes('function shouldSpawnCodexThroughShell('),
  'codex app-server runner should centralize Windows command-shim spawn detection'
);
assert(
  runnerSource.includes('shell: shouldSpawnCodexThroughShell(this.codexBin)'),
  'codex app-server runner should not spawn Windows .cmd/.bat shims with shell:false'
);

{
  const home = makeTempHome('cursor-extension-home');
  const extensionRoot = makeTempHome('cursor-extensions');
  const bin = makeCodexBin(
    path.join(extensionRoot, 'openai.chatgpt-26.5623.61825-win32-x64', 'bin', 'windows-x86_64'),
    'codex.exe',
  );
  writeInitializedHome(home);
  assert.strictEqual(findCodexInCursorExtensions(extensionRoot), bin, 'preflight should find Codex in Cursor extension bins');
  const result = checkLocalCodexPreflight({
    codexHome: home,
    cursorExtensionsDir: extensionRoot,
    pathEnv: '',
    runHelp: false,
  });
  assert.strictEqual(result.ok, true, 'Cursor extension Codex binary should pass local preflight without PATH');
  assert.strictEqual(result.codexBin, bin, 'preflight should report the Cursor extension Codex path');
}

console.log('codex preflight assertions passed');
