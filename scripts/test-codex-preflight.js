const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkLocalCodexPreflight,
} = require('../shared/codex-preflight');

function makeTempHome(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `remote-codex-${name}-`));
  return root;
}

function makeCodexBin(dir, name = process.platform === 'win32' ? 'codex.cmd' : 'codex') {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, process.platform === 'win32' ? '@echo codex help\r\n' : '#!/bin/sh\necho codex help\n', 'utf8');
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

console.log('codex preflight assertions passed');
