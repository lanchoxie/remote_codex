const assert = require('assert');
const fs = require('fs');

const connectors = fs.readFileSync('shared/connectors.js', 'utf8');
const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

assertContains(
  connectors,
  'function buildCodexBinResolutionCommand',
  'connectors should expose one canonical remote Codex resolver'
);
assertContains(
  connectors,
  '$HOME/.conda/envs/node_env/bin',
  'remote Codex resolver should check the common node_env conda bin directory directly'
);
assertContains(
  connectors,
  'find -L',
  'remote Codex resolver should follow conda/npm symlinks when scanning for codex'
);
assertContains(
  connectors,
  'codex-execve-wrapper',
  'remote Codex resolver should explicitly reject temporary Codex execve wrappers'
);
assertContains(
  connectors,
  '/arg0/',
  'remote Codex resolver should avoid CODEX_HOME tmp/arg0 wrapper directories'
);
assertContains(
  connectors,
  'PATH="$CODEX_BIN_DIR:$PATH"',
  'remote Codex resolver should prepend the resolved Codex bin directory to PATH'
);
assertContains(
  connectors,
  'buildCodexBinResolutionCommand(connector',
  'default host-agent launch command should reuse the canonical Codex resolver'
);
assertContains(
  connectors,
  'buildNodeBinResolutionCommand()',
  'default host-agent launch command should use a non-ambiguous Node resolver'
);

assertContains(
  relay,
  'buildCodexBinResolutionCommand',
  'one-shot bootstrap should reuse the same Codex resolver as generated connector commands'
);
assertContains(
  relay,
  'CODEX_REMOTE_CHECK_CODEX=$CODEX_BIN',
  'one-shot bootstrap should report the same CODEX_BIN it passes to the host-agent'
);
assertContains(
  relay,
  'CODEX_REMOTE_PREFLIGHT_BEGIN',
  'one-shot bootstrap should emit a remote Codex preflight begin marker'
);
assertContains(
  relay,
  'CODEX_REMOTE_PREFLIGHT_HOME=missing',
  'one-shot bootstrap should fail clearly when remote CODEX_HOME is missing'
);
assertContains(
  relay,
  'CODEX_REMOTE_PREFLIGHT_INIT=missing',
  'one-shot bootstrap should fail clearly when remote CODEX_HOME is not initialized'
);
assertContains(
  relay,
  'CODEX_REMOTE_PREFLIGHT_SESSIONS=unwritable',
  'one-shot bootstrap should fail clearly when remote Codex sessions cannot be written'
);
assertContains(
  relay,
  'codex_init_failed',
  'one-shot bootstrap failure classifier should expose Codex initialization failures'
);
assertContains(
  relay,
  'REMOTE_CODEX_AGENT_LAUNCH',
  'one-shot bootstrap should write the remote agent launch command to a script file before invoking tmux/nohup'
);
assertContains(
  relay,
  'sh .remote-codex-agent-launch.sh',
  'one-shot bootstrap should invoke a short launch script instead of embedding the full resolver in the tmux command'
);
assertContains(
  relay,
  'const refreshExistingAgent = true;',
  'Start Agent one-shot bootstrap should refresh any existing remote host-agent instead of reusing stale tmux/nohup state'
);
assertContains(
  relay,
  'const restartFlag = refreshExistingAgent ? \'1\' : \'0\';',
  'one-shot bootstrap should use refresh semantics for both Start Agent and Restart Agent'
);
assertContains(
  relay,
  'const tmuxEnsureCommand = tmuxStartCommand;',
  'Start Agent should launch a fresh tmux session after killing any stale one'
);
assertContains(
  relay,
  'command too long',
  'one-shot bootstrap failure classifier should not report success when the remote shell rejects a long launcher command'
);
assert(
  !relay.includes('& then'),
  'one-shot nohup fallback should not generate invalid shell syntax with "& then"'
);
assertContains(
  connectors,
  'PATH="$PATH" CODEX_BIN="$CODEX_BIN"',
  'the default host-agent launch should pass the resolver-adjusted PATH and CODEX_BIN into the process'
);

assert.strictEqual(
  packageJson.scripts['test:remote-codex-env'],
  'node scripts/test-remote-codex-env-resolution.js',
  'package.json should expose the remote Codex env regression test'
);

console.log('remote Codex environment resolution assertions passed');
