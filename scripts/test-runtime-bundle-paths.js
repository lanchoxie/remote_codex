const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');

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

console.log('runtime bundle path assertions passed');
