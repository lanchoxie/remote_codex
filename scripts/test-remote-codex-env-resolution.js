const assert = require('assert');
const fs = require('fs');
const {
  agentLogCommand,
  buildAgentLaunchCommand,
  buildRemoteStatusCommand,
  connectorControlFileName,
  connectorTmuxSessionName,
  normalizeConnectorInput,
  normalizeConnectorRemoteDirectory,
} = require('../shared/connectors');

const connectors = fs.readFileSync('shared/connectors.js', 'utf8');
const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const mobileApp = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

assert.strictEqual(
  normalizeConnectorRemoteDirectory('~/mobile-codex-remote/.deployments/deploy-1234-abcd/.deployments/deploy-5678-efgh'),
  '~/mobile-codex-remote',
  'generated deployment directories must collapse back to the configured connector base'
);
assert(
  agentLogCommand('node agent.js', { logPath: '~/mobile-codex-remote/codex-remote.agent.log' })
    .includes('>> "$HOME/mobile-codex-remote/codex-remote.agent.log"'),
  'one-shot Agent logs should support a stable path under the configured base directory'
);
assert.strictEqual(
  normalizeConnectorInput({
    targetHost: 'example.test',
    bootstrap: {
      remoteDirectory: '/srv/remote-codex/.deployments/deploy-1234-abcd',
    },
  }).bootstrap.remoteDirectory,
  '/srv/remote-codex',
  'loaded connector profiles must repair a previously persisted deployment path'
);

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
const execLaunchCommand = buildAgentLaunchCommand({
  connectorId: 'connector-runtime-test',
  relayUrl: 'https://relay.example.com',
  hostId: 'remote-test',
  label: 'Remote test',
  codexHome: '~/.codex',
  workspaceRoots: [],
  bootstrap: { launchCommand: '' },
}, { execProcess: true });
assert(
  execLaunchCommand.includes('exec env RELAY_URL='),
  'detached default launch scripts should replace their shell with the Host Agent process'
);
assert(
  execLaunchCommand.includes('REMOTE_CODEX_CONNECTOR_ID='),
  'Host Agent processes should carry their Connector identity for ownership checks'
);
const connectorA = {
  connectorId: 'connector-a',
  hostId: 'host-a',
  bootstrap: { mode: 'manual_tmux', tmuxSession: 'codex-remote' },
};
const connectorB = {
  connectorId: 'connector-b',
  hostId: 'host-b',
  bootstrap: { mode: 'manual_tmux', tmuxSession: 'codex-remote' },
};
assert.notStrictEqual(
  connectorControlFileName(connectorA, 'pid'),
  connectorControlFileName(connectorB, 'pid'),
  'Connectors sharing a remote root must not share stable PID files'
);
assert.notStrictEqual(
  connectorTmuxSessionName(connectorA),
  connectorTmuxSessionName(connectorB),
  'Connectors sharing a remote account must not share managed tmux session names'
);
const remoteStatusCommand = buildRemoteStatusCommand({
  connectorId: 'connector-runtime-test',
  hostId: 'remote-test',
  bootstrap: {
    mode: 'manual_tmux',
    remoteDirectory: '~/mobile-codex-remote',
    tmuxSession: 'codex-remote',
  },
});
assertContains(
  remoteStatusCommand,
  'ps -eo pid=,comm=,args=',
  'remote status should discover a live Host Agent under the Connector root even when its stable PID is stale'
);
assertContains(
  remoteStatusCommand,
  '"$control_dir"/*',
  'remote status process discovery must stay scoped to the configured Connector root'
);
assertContains(
  remoteStatusCommand,
  'REMOTE_CODEX_CONNECTOR_ID=',
  'remote status must match the owning Connector identity instead of any Agent under the same root'
);
assert(
  !remoteStatusCommand.includes('CODEX_REMOTE_AGENT_TMUX_RUNNING'),
  'a same-named tmux session alone must not make a Connector appear online'
);

assertContains(
  relay,
  'buildCodexBinResolutionCommand',
  'one-shot bootstrap should reuse the same Codex resolver as generated connector commands'
);
const savedAnswerIndex = relay.indexOf('if (-not [string]::IsNullOrWhiteSpace($answer))');
const brokerPromptIndex = relay.indexOf('Try-BrokerPrompt | Out-Null');
assert(
  savedAnswerIndex >= 0 && brokerPromptIndex > savedAnswerIndex,
  'saved connector credentials must be answered before waiting on the interactive askpass broker'
);
assertContains(
  relay,
  'connectorActionsInFlight: new Map()',
  'Relay must keep a per-Connector server-side action lock'
);
assertContains(
  relay,
  "status: 'connector_action_in_progress'",
  'concurrent Connector actions must receive an explicit conflict status'
);
assertContains(
  relay,
  'probeConnectorBootstrapRuntime(baseConnector, secret)',
  'bootstrap must probe the remote architecture before building its payload'
);
assertContains(
  relay,
  'connector: baseConnector',
  'bootstrap results must return the configured base Connector instead of a temporary deployment path'
);
assertContains(
  relay,
  'pid_file="$control_dir/${controlPidFile}"',
  'nohup Agent ownership must use a Connector-specific stable PID file outside generated deployment directories'
);
assertContains(
  relay,
  '`echo "$$" > ${remoteShellPath(controlPidPath)}`',
  'the launched Host Agent must publish its own PID to the stable Connector control path'
);
assertContains(
  relay,
  'legacy_pid_file=',
  'the stable control directory must migrate a live PID from older deployment layouts'
);
assert(
  !mobileApp.includes('updateConnectorFromActionResult('),
  'temporary Connector action results must not replace the saved Connector profile in the editor'
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
  'buildAgentLaunchCommand(connector, { execProcess: true })',
  'the one-shot launcher should make its PID identify the real default Host Agent process'
);
assertContains(
  relay,
  "'stop_tracked_agent'",
  'the one-shot launcher should stop a tracked nohup Agent before choosing tmux or nohup'
);
assertContains(
  relay,
  "'stop_untracked_control_agents'",
  'the one-shot launcher should stop legacy Agents whose working directory belongs to the same Connector root'
);
assertContains(
  relay,
  'case "$candidate_cwd" in "$control_dir"|"$control_dir"/*)',
  'legacy Agent cleanup must remain scoped to the configured Connector root'
);
assertContains(
  relay,
  'candidate_connector_id=',
  'legacy Agent cleanup must validate Connector or Host ownership before stopping a process'
);
assert(
  !relay.includes('tmux kill-session -t ${shellQuote(tmuxSession)}'),
  'one-shot Connector restart must not kill a same-named tmux session without proving ownership'
);
assertContains(
  relay,
  'CODEX_REMOTE_AGENT_STALE_PID_IGNORED',
  'the one-shot launcher must not kill a reused PID that no longer belongs to Remote Codex'
);
assertContains(
  relay,
  'restoreDismissedHost(actionConnector.hostId)',
  'starting or restarting a saved connector should restore a previously deleted host id'
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
assert(
  !relay.includes('deploy: deployment'),
  'non-bootstrap connector actions must not read an undefined deployment result'
);
assert(
  !relay.includes('actionMultiplexFallback'),
  'disabled SSH multiplexing must not leave connector action fallback state'
);

assert.strictEqual(
  packageJson.scripts['test:remote-codex-env'],
  'node scripts/test-remote-codex-env-resolution.js',
  'package.json should expose the remote Codex env regression test'
);

console.log('remote Codex environment resolution assertions passed');
