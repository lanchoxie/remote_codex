const assert = require('assert');
const fs = require('fs');

assert(fs.existsSync('config/remote-codex.defaults.json'), 'install helper defaults should exist');

const defaults = JSON.parse(fs.readFileSync('config/remote-codex.defaults.json', 'utf8'));

assert.strictEqual(defaults.runtimeReleaseRepo, 'lanchoxie/remote_codex', 'defaults should point to the release repo');
assert(/^v\d+\.\d+\.\d+$/.test(defaults.runtimeReleaseTag), 'defaults should include a stable runtime release tag');
assert(defaults.localCodexHome.includes('.codex'), 'defaults should include local CODEX_HOME');
assert(defaults.remoteCodexHome.includes('.codex'), 'defaults should include remote CODEX_HOME');
assert(Array.isArray(defaults.remoteCodexBinHints), 'defaults should include remote Codex binary hints');
assert(defaults.remoteCodexBinHints.some((item) => item.includes('.conda/envs')), 'remote hints should include conda env roots');
assert(defaults.remotePreflightCommand.includes('CODEX_REMOTE_PREFLIGHT_BEGIN'), 'defaults should document the remote preflight marker');

const gitignore = fs.readFileSync('.gitignore', 'utf8');
assert(gitignore.includes('config/remote-codex.local.json'), 'local install helper override should be ignored');

const readme = fs.readFileSync('README.md', 'utf8');
assert(readme.includes('Setup and Start Remote Codex.bat'), 'README should mention the setup-and-start entrypoint');
assert(readme.includes('download-runtimes.bat'), 'README should mention the runtime downloader');
assert(readme.includes('remote-codex.local.json'), 'README should mention the local install helper override');

console.log('install config assertions passed');
