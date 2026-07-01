const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

const nodeStart = relay.indexOf('function getLocalNodeRuntimeArchive()');
const nodeEnd = relay.indexOf('function copyDirectoryRecursive', nodeStart);
assert(nodeStart >= 0 && nodeEnd > nodeStart, 'relay should define getLocalNodeRuntimeArchive');
const nodeBody = relay.slice(nodeStart, nodeEnd);

assertContains(
  nodeBody,
  "process.env.CODEX_NODE_RUNTIME_ARCHIVE",
  'Node runtime lookup should allow an explicit archive override'
);
assertContains(
  nodeBody,
  "path.join(process.cwd(), 'runtimes', 'node'",
  'Node runtime lookup should prefer the release-bundled runtimes/node directory'
);
assertContains(
  nodeBody,
  "path.join(process.cwd(), 'tmp'",
  'Node runtime lookup should keep the legacy tmp cache fallback'
);

const codexStart = relay.indexOf('function getLocalCodexLinuxSourceDir()');
const codexEnd = relay.indexOf('function stageLocalCodexLinuxRuntime()', codexStart);
assert(codexStart >= 0 && codexEnd > codexStart, 'relay should define getLocalCodexLinuxSourceDir');
const codexBody = relay.slice(codexStart, codexEnd);

assertContains(
  codexBody,
  "process.env.CODEX_LINUX_RUNTIME_DIR",
  'Codex runtime lookup should allow an explicit directory override'
);
assertContains(
  codexBody,
  "path.join(process.cwd(), 'runtimes', 'codex', 'linux-x86_64')",
  'Codex runtime lookup should prefer the release-bundled runtimes/codex/linux-x86_64 directory'
);
assertContains(
  codexBody,
  "path.join(process.cwd(), 'tmp', 'codex-linux-x86_64')",
  'Codex runtime lookup should keep the legacy tmp staged runtime fallback'
);

const payloadStart = relay.indexOf('function collectOneShotBootstrapSources()');
const payloadEnd = relay.indexOf('function classifyOneShotBootstrapFailure', payloadStart);
assert(payloadStart >= 0 && payloadEnd > payloadStart, 'relay should define collectOneShotBootstrapSources');
const payloadBody = relay.slice(payloadStart, payloadEnd);

assertContains(payloadBody, 'getLocalNodeRuntimeArchive()', 'one-shot payload should include the Node runtime archive when present');
assertContains(payloadBody, 'stageLocalCodexLinuxRuntime()', 'one-shot payload should include the Codex runtime when present');
assertContains(payloadBody, 'nodeArchiveName', 'one-shot payload should pass the Node archive name to the remote script');
assertContains(payloadBody, 'codexRuntimeIncluded', 'one-shot payload should tell the remote script whether Codex runtime was included');

const gitignore = fs.readFileSync('.gitignore', 'utf8');
assert(!/^runtimes\/$/m.test(gitignore), 'release runtime directory must not be wholly ignored');

assert(fs.existsSync('download-runtimes.bat'), 'repo root should include a double-click runtime downloader');
assert(fs.existsSync('scripts/download-runtimes.ps1'), 'runtime downloader PowerShell script should exist');
assert(fs.existsSync('scripts/prepare-runtime-release-assets.ps1'), 'repo should include a script that prepares direct runtime release assets');

const downloadBat = fs.readFileSync('download-runtimes.bat', 'utf8');
const downloadScript = fs.readFileSync('scripts/download-runtimes.ps1', 'utf8');
const prepareAssetsScript = fs.readFileSync('scripts/prepare-runtime-release-assets.ps1', 'utf8');

assertContains(
  downloadScript,
  `[string]$Tag = "v${pkg.version}"`,
  'runtime downloader default release tag should match package.json version'
);

assertContains(
  downloadBat,
  'scripts\\download-runtimes.ps1',
  'download-runtimes.bat should call the PowerShell downloader'
);
assertContains(
  downloadScript,
  'node-v16.20.2-linux-x64.tar.xz',
  'runtime downloader should download the Node runtime archive directly'
);
assertContains(
  downloadScript,
  'codex-linux-x86_64.zip',
  'runtime downloader should download the Codex Linux runtime archive directly'
);
assertContains(
  downloadScript,
  'Expand-CodexRuntimeZip',
  'runtime downloader should extract the direct Codex Linux runtime archive'
);
assertContains(
  downloadScript,
  'tmp\\node-v16.20.2-linux-x64.tar.xz',
  'runtime downloader should install the Node archive into the tmp cache'
);
assertContains(
  downloadScript,
  'tmp\\codex-linux-x86_64',
  'runtime downloader should install the Codex Linux runtime into the tmp cache'
);
assertContains(
  downloadScript,
  'Expand-Archive',
  'runtime downloader should extract runtime archives when needed'
);
assertContains(
  downloadScript,
  'Expand-LegacyReleaseZip',
  'runtime downloader may keep the old full release zip path only as a fallback'
);
assertContains(
  prepareAssetsScript,
  'node-v16.20.2-linux-x64.tar.xz',
  'release asset preparation should publish the Node runtime archive as a direct asset'
);
assertContains(
  prepareAssetsScript,
  'codex-linux-x86_64.zip',
  'release asset preparation should publish the Codex Linux runtime as a direct asset'
);
assertContains(
  prepareAssetsScript,
  'Compress-Archive',
  'release asset preparation should zip the Codex Linux runtime directory'
);

console.log('runtime bundle path assertions passed');
