const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyCodexInstallation,
  parseCodexVersion,
  probeCodexInstallation,
  updateCodexInstallation,
} = require('../shared/codex-installation');

async function main() {
  assert.strictEqual(parseCodexVersion('codex-cli 0.145.0'), '0.145.0');
  assert.strictEqual(parseCodexVersion('codex 1.2.3-beta.1'), '1.2.3-beta.1');
  assert.strictEqual(parseCodexVersion('not a version'), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-installation-test-'));
  const npmPrefix = path.join(root, 'npm-global');
  fs.mkdirSync(npmPrefix, { recursive: true });
  const codexBin = path.join(npmPrefix, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const npmBin = path.join(npmPrefix, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const codexPackageRoot = path.join(npmPrefix, 'node_modules', '@openai', 'codex');
  const npmCliPath = path.join(npmPrefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(codexPackageRoot, { recursive: true });
  fs.mkdirSync(path.dirname(npmCliPath), { recursive: true });
  fs.writeFileSync(path.join(codexPackageRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: '0.145.0',
    bin: { codex: 'bin/codex.js' },
  }));
  fs.writeFileSync(path.join(npmPrefix, 'node_modules', 'npm', 'package.json'), JSON.stringify({
    name: 'npm',
    version: '11.0.0',
    bin: { npm: 'bin/npm-cli.js' },
  }));
  fs.writeFileSync(npmCliPath, 'module.exports = {};\n');
  fs.writeFileSync(codexBin, process.platform === 'win32'
    ? '@node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
    : '#!/bin/sh\nnode "$HOME/lib/node_modules/@openai/codex/bin/codex.js" "$@"\n');
  fs.writeFileSync(npmBin, process.platform === 'win32' ? '@node npm-cli.js %*\r\n' : '#!/bin/sh\n');

  const npmInstall = classifyCodexInstallation({
    binPath: codexBin,
    realPath: path.join(codexPackageRoot, 'bin', 'codex.js'),
    explicit: true,
    platform: process.platform,
    envPath: '',
  });
  assert.strictEqual(npmInstall.source, 'npm_global');
  assert.strictEqual(npmInstall.canAutoUpdate, true);
  assert.strictEqual(npmInstall.npmBin, npmBin);
  assert.strictEqual(npmInstall.npmCliPath, npmCliPath);

  const splitCodexPrefix = path.join(root, 'split-codex-global');
  const splitCodexBin = path.join(splitCodexPrefix, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const splitCodexPackageRoot = path.join(splitCodexPrefix, 'node_modules', '@openai', 'codex');
  const toolchainPrefix = path.join(root, 'node-toolchain');
  const pathNpmBin = path.join(toolchainPrefix, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const pathNodeBin = path.join(toolchainPrefix, process.platform === 'win32' ? 'node.exe' : 'node');
  const pathNpmCli = path.join(toolchainPrefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(splitCodexPackageRoot, { recursive: true });
  fs.mkdirSync(path.dirname(pathNpmCli), { recursive: true });
  fs.writeFileSync(path.join(splitCodexPackageRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex',
    version: '0.145.0',
    bin: { codex: 'bin/codex.js' },
  }));
  fs.writeFileSync(path.join(toolchainPrefix, 'node_modules', 'npm', 'package.json'), JSON.stringify({
    name: 'npm',
    version: '11.0.0',
    bin: { npm: 'bin/npm-cli.js' },
  }));
  fs.writeFileSync(pathNpmCli, 'module.exports = {};\n');
  fs.writeFileSync(splitCodexBin, process.platform === 'win32'
    ? '@node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
    : '#!/bin/sh\nnode "$HOME/lib/node_modules/@openai/codex/bin/codex.js" "$@"\n');
  fs.writeFileSync(pathNpmBin, process.platform === 'win32' ? '@node npm-cli.js %*\r\n' : '#!/bin/sh\n');
  fs.writeFileSync(pathNodeBin, '');

  const splitPrefixInstall = classifyCodexInstallation({
    binPath: splitCodexBin,
    realPath: path.join(splitCodexPackageRoot, 'bin', 'codex.js'),
    explicit: true,
    platform: process.platform,
    envPath: toolchainPrefix,
  });
  assert.strictEqual(splitPrefixInstall.source, 'npm_global');
  assert.strictEqual(splitPrefixInstall.canAutoUpdate, true);
  assert.strictEqual(splitPrefixInstall.npmPrefix, splitCodexPrefix);
  assert.strictEqual(splitPrefixInstall.npmBin, pathNpmBin);
  assert.strictEqual(splitPrefixInstall.npmCliPath, pathNpmCli);
  assert.strictEqual(splitPrefixInstall.nodeBin, pathNodeBin);

  const directPackageBinary = classifyCodexInstallation({
    binPath: path.join(codexPackageRoot, 'bin', 'codex.js'),
    realPath: path.join(codexPackageRoot, 'bin', 'codex.js'),
    explicit: true,
    platform: process.platform,
    envPath: '',
  });
  assert.strictEqual(directPackageBinary.source, 'explicit_unknown');
  assert.strictEqual(directPackageBinary.canAutoUpdate, false);

  const cursorInstall = classifyCodexInstallation({
    binPath: path.join(root, '.cursor', 'extensions', 'openai.chatgpt-1.0.0', 'bin', 'codex'),
    realPath: path.join(root, '.cursor', 'extensions', 'openai.chatgpt-1.0.0', 'bin', 'codex'),
    explicit: true,
    platform: process.platform,
  });
  assert.strictEqual(cursorInstall.source, 'cursor_extension');
  assert.strictEqual(cursorInstall.canAutoUpdate, false);

  const bundledInstall = classifyCodexInstallation({
    binPath: path.join(root, '.runtime', 'codex', 'codex'),
    realPath: path.join(root, '.runtime', 'codex', 'codex'),
    platform: process.platform,
  });
  assert.strictEqual(bundledInstall.source, 'bundled_runtime');
  assert.strictEqual(bundledInstall.canAutoUpdate, false);

  const probed = probeCodexInstallation({
    codexBin,
    explicit: true,
    npmBin,
    spawnSync: () => ({ status: 0, stdout: 'codex-cli 0.145.0\n', stderr: '' }),
  });
  assert.strictEqual(probed.version, '0.145.0');
  assert.strictEqual(probed.source, 'npm_global');
  assert.strictEqual(probed.canAutoUpdate, true);

  let invocation = null;
  const updated = await updateCodexInstallation(probed, {
    runProcess: async (command, args, options) => {
      invocation = { command, args, options };
      return { exitCode: 0, signal: null, error: null, timedOut: false, stdout: 'updated', stderr: '' };
    },
    spawnSync: () => ({ status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' }),
  });
  assert.strictEqual(invocation.command, process.execPath);
  assert.deepStrictEqual(invocation.args, [
    npmCliPath,
    'install',
    '--global',
    '@openai/codex@latest',
    '--include=optional',
    '--no-audit',
    '--no-fund',
  ]);
  assert.strictEqual(invocation.options.env.NPM_CONFIG_PREFIX, npmInstall.npmPrefix);
  assert.strictEqual(updated.previousVersion, '0.145.0');
  assert.strictEqual(updated.version, '0.146.0');
  assert.strictEqual(updated.changed, true);

  await assert.rejects(
    () => updateCodexInstallation(cursorInstall),
    (error) => error.code === 'codex_update_unsupported'
  );

  fs.rmSync(root, { recursive: true, force: true });
  console.log('Codex installation detection and update assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
