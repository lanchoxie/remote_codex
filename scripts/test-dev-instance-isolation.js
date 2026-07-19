const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildAgentEnvironment,
  buildRelayEnvironment,
  resolveDevInstanceConfig,
} = require('./dev-instance-config');

const root = path.resolve('D:/isolated/remote-codex-dev');
const home = path.resolve('D:/isolated/home');
const primaryCodexHome = path.join(home, '.codex');
const productionStateRoot = path.join(root, 'tmp');

const defaults = resolveDevInstanceConfig({
  root,
  home,
  hostname: 'WORKSTATION',
  env: {},
});
assert.strictEqual(defaults.port, 8787);
assert.strictEqual(defaults.relayStateRoot, path.join(root, 'tmp', 'relay-8787'));
assert.strictEqual(defaults.withAgent, false);
assert.strictEqual(defaults.hostId, 'workstation-dev-8787');

assert.throws(
  () => resolveDevInstanceConfig({ root, home, env: { PORT: '8797' } }),
  /refuses production port 8797/i
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: { REMOTE_CODEX_DEV_STATE_ROOT: productionStateRoot },
  }),
  /must not equal the production state root/i
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: { REMOTE_CODEX_DEV_STATE_ROOT: path.join(productionStateRoot, 'session-record-store', 'dev') },
  }),
  /overlaps production-owned path/i
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: { REMOTE_CODEX_DEV_STATE_ROOT: path.join(productionStateRoot, 'custom-dev') },
  }),
  /overlaps production-owned path/i
);

const physicalProductionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-production-state-'));
const physicalAliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-development-alias-'));
const physicalProductionAlias = path.join(physicalAliasParent, 'aliased-production-state');
fs.symlinkSync(
  physicalProductionRoot,
  physicalProductionAlias,
  process.platform === 'win32' ? 'junction' : 'dir'
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: {
      REMOTE_CODEX_PRODUCTION_STATE_ROOT: physicalProductionRoot,
      REMOTE_CODEX_DEV_STATE_ROOT: physicalProductionAlias,
    },
  }),
  /must not equal the production state root/i
);

const polluted = {
  PORT: '8797',
  REMOTE_CODEX_DEV_PORT: '8897',
  RELAY_URL: 'http://127.0.0.1:8797',
  RELAY_STATE_ROOT: productionStateRoot,
  RELAY_AUTH_TOKEN: 'production-token',
  RELAY_CONTROL_TOKEN: 'production-control-token',
  RELAY_CONTROL_TOKEN_PATH: path.join(productionStateRoot, 'relay-control-token.txt'),
  RELAY_AUTH_COOKIE_SECURE: 'true',
  RELAY_MANAGED_LOCAL_AGENT: 'true',
  RELAY_MANAGED_AGENT_INSTANCE_ID: 'production-agent-instance',
  RELAY_MANAGED_AGENT_TOKEN: 'production-agent-owner-token',
  RELAY_MANAGED_MARKER_PATH: path.join(productionStateRoot, 'local-agents', 'production.owner.json'),
  RELAY_MANAGED_OWNER_PID: '1234',
  RELAY_MANAGED_FUTURE_OWNERSHIP_FIELD: 'must-not-survive',
  SESSION_RECORD_STORE_ROOT: path.join(productionStateRoot, 'session-record-store'),
  SESSION_LOGS_PATH: path.join(productionStateRoot, 'session-logs.json'),
  CONNECTORS_PATH: path.join(productionStateRoot, 'connectors.json'),
  CONNECTOR_SECRETS_PATH: path.join(productionStateRoot, 'connector-secrets.json'),
  HOST_ID: 'production-host',
  CODEX_HOME: primaryCodexHome,
  REMOTE_CODEX_STATE_ROOT: path.join(home, '.remote-codex'),
  AGENTS_HOME: path.join(home, '.agents'),
  CC_SWITCH_HOME: path.join(home, '.cc-switch'),
  SKILL_ARTIFACT_TEMP_ROOT: path.join(home, 'production-skill-temp'),
  SSH_KNOWN_HOSTS_PATH: path.join(home, '.ssh', 'known_hosts'),
  RELAY_LOCAL_AGENT_START_ENABLED: 'true',
  RELAY_LOCAL_HOST_STUB: 'true',
  AUTO_START_SESSION: 'true',
};
const isolated = resolveDevInstanceConfig({
  root,
  home,
  hostname: 'WORKSTATION',
  env: polluted,
});
const relayEnv = buildRelayEnvironment(isolated, polluted, 'development-token');
assert.strictEqual(isolated.port, 8897);
assert.strictEqual(isolated.relayStateRoot, path.join(root, 'tmp', 'relay-8897'));
assert.strictEqual(relayEnv.PORT, '8897');
assert.strictEqual(relayEnv.RELAY_STATE_ROOT, isolated.relayStateRoot);
assert.strictEqual(relayEnv.SESSION_RECORD_STORE_ROOT, path.join(isolated.relayStateRoot, 'session-record-store'));
assert.strictEqual(relayEnv.SESSION_LOGS_PATH, path.join(isolated.relayStateRoot, 'session-logs.json'));
assert.strictEqual(relayEnv.CONNECTORS_PATH, path.join(isolated.relayStateRoot, 'connectors.json'));
assert.strictEqual(relayEnv.CONNECTOR_SECRETS_PATH, path.join(isolated.relayStateRoot, 'connector-secrets.json'));
assert.strictEqual(relayEnv.RELAY_AUTH_TOKEN, 'development-token');
assert.strictEqual(relayEnv.RELAY_AUTH_DISABLED, 'false');
assert.strictEqual(
  relayEnv.RELAY_CONTROL_TOKEN_PATH,
  path.join(isolated.relayStateRoot, 'relay-control-token.txt')
);
assert.strictEqual(relayEnv.RELAY_CONTROL_TOKEN, undefined);
assert.strictEqual(relayEnv.RELAY_LOCAL_AGENT_WATCHDOG_ENABLED, 'false');
assert.strictEqual(relayEnv.RELAY_LOCAL_AGENT_START_ENABLED, 'false');
assert.strictEqual(relayEnv.RELAY_LOCAL_HOST_STUB, 'false');
assert.strictEqual(relayEnv.RELAY_LOCAL_HOST_ID, 'workstation-dev-8897');
assert.strictEqual(relayEnv.REMOTE_CODEX_STATE_ROOT, isolated.agentStateRoot);
assert.strictEqual(relayEnv.AGENTS_HOME, isolated.agentsHome);
assert.strictEqual(relayEnv.CC_SWITCH_HOME, isolated.ccSwitchHome);
assert.strictEqual(relayEnv.SKILL_ARTIFACT_TEMP_ROOT, isolated.skillArtifactTempRoot);
assert.strictEqual(relayEnv.RELAY_URL, undefined);
assert.strictEqual(relayEnv.RELAY_AUTH_COOKIE_SECURE, undefined);
assert.strictEqual(
  relayEnv.SSH_KNOWN_HOSTS_PATH,
  path.join(isolated.relayStateRoot, 'ssh', 'known_hosts')
);
for (const key of Object.keys(polluted).filter((name) => name.startsWith('RELAY_MANAGED_'))) {
  assert.strictEqual(relayEnv[key], undefined, `Relay environment must clear ${key}`);
}
assert.notStrictEqual(relayEnv.SESSION_RECORD_STORE_ROOT, polluted.SESSION_RECORD_STORE_ROOT);
assert.notStrictEqual(relayEnv.CONNECTORS_PATH, polluted.CONNECTORS_PATH);

const withAgent = resolveDevInstanceConfig({
  root,
  home,
  hostname: 'WORKSTATION',
  env: {
    REMOTE_CODEX_DEV_PORT: '8897',
    REMOTE_CODEX_DEV_WITH_AGENT: 'true',
  },
});
const agentEnv = buildAgentEnvironment(withAgent, polluted, 'development-token');
assert.strictEqual(withAgent.withAgent, true);
assert.strictEqual(agentEnv.RELAY_URL, 'http://127.0.0.1:8897');
assert.strictEqual(agentEnv.HOST_ID, 'workstation-dev-8897');
assert.strictEqual(agentEnv.CODEX_HOME, path.join(withAgent.relayStateRoot, 'codex-home'));
assert.strictEqual(agentEnv.REMOTE_CODEX_STATE_ROOT, path.join(withAgent.relayStateRoot, 'agent-state'));
assert.strictEqual(agentEnv.SKILL_ARTIFACT_TEMP_ROOT, path.join(withAgent.agentStateRoot, 'skill-artifact-temp'));
assert.strictEqual(agentEnv.AUTO_START_SESSION, 'false');
assert.strictEqual(agentEnv.RELAY_AUTH_TOKEN, 'development-token');
assert.strictEqual(agentEnv.PORT, undefined);
assert.strictEqual(agentEnv.RELAY_AUTH_COOKIE_SECURE, undefined);
for (const key of Object.keys(polluted).filter((name) => name.startsWith('RELAY_MANAGED_'))) {
  assert.strictEqual(agentEnv[key], undefined, `Agent environment must clear ${key}`);
}
assert.notStrictEqual(agentEnv.CODEX_HOME, primaryCodexHome);
assert.notStrictEqual(agentEnv.REMOTE_CODEX_STATE_ROOT, polluted.REMOTE_CODEX_STATE_ROOT);

assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: {
      REMOTE_CODEX_DEV_WITH_AGENT: 'true',
      REMOTE_CODEX_DEV_CODEX_HOME: primaryCodexHome,
    },
  }),
  /must not overlap the production CODEX_HOME/i
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: {
      REMOTE_CODEX_DEV_WITH_AGENT: 'true',
      REMOTE_CODEX_DEV_AGENT_STATE_ROOT: path.join(home, '.remote-codex'),
    },
  }),
  /must not overlap the production Agent state root/i
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: {
      REMOTE_CODEX_DEV_WITH_AGENT: 'true',
      REMOTE_CODEX_DEV_AGENT_STATE_ROOT: path.join(home, '.agents'),
    },
  }),
  /must not overlap the production AGENTS_HOME/i
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: {
      REMOTE_CODEX_DEV_WITH_AGENT: 'true',
      REMOTE_CODEX_DEV_AGENT_STATE_ROOT: path.join(home, '.cc-switch'),
    },
  }),
  /must not overlap the production CC_SWITCH_HOME/i
);
assert.throws(
  () => resolveDevInstanceConfig({
    root,
    home,
    env: {
      REMOTE_CODEX_DEV_WITH_AGENT: 'true',
      REMOTE_CODEX_DEV_AGENT_STATE_ROOT: path.join(os.tmpdir(), 'remote-codex-skill-artifacts'),
    },
  }),
  /must not overlap the production temp root/i
);

console.log('development instance isolation assertions passed');
