const os = require('os');
const path = require('path');
const {
  canonicalPhysicalPath,
  comparablePhysicalPath,
  physicalPathIsInside,
  physicalPathsOverlap,
} = require('../shared/physical-path');

const INSTANCE_ENV_KEYS = [
  'PORT',
  'RELAY_URL',
  'RELAY_STATE_ROOT',
  'RELAY_AUTH_DISABLED',
  'RELAY_AUTH_TOKEN',
  'RELAY_AUTH_TOKEN_PATH',
  'RELAY_AUTH_ACCOUNT_PATH',
  'RELAY_CONTROL_TOKEN',
  'RELAY_CONTROL_TOKEN_PATH',
  'RELAY_AUTH_COOKIE_SECURE',
  'RELAY_LOCAL_AGENT_WATCHDOG_ENABLED',
  'RELAY_LOCAL_AGENT_START_ENABLED',
  'RELAY_LOCAL_HOST_STUB',
  'RELAY_LOCAL_HOST_ID',
  'RELAY_LOCAL_HOST_LABEL',
  'SESSION_RECORD_STORE_ROOT',
  'SESSION_COLLECTIONS_PATH',
  'SESSION_METADATA_PATH',
  'SESSION_LOGS_PATH',
  'SESSION_DIAGNOSTICS_PATH',
  'CONNECTORS_PATH',
  'CONNECTOR_SECRETS_PATH',
  'SKILL_FAVORITES_PATH',
  'SKILL_SOURCES_PATH',
  'SKILL_LIBRARY_PATH',
  'SKILL_INVENTORIES_PATH',
  'SKILL_REGISTRY_PATH',
  'SKILL_ARTIFACT_ROOT',
  'SKILL_DEPLOYMENTS_PATH',
  'SKILL_AUDIT_PATH',
  'SSH_KNOWN_HOSTS_PATH',
  'HOST_ID',
  'HOST_LABEL',
  'CODEX_HOME',
  'LOCAL_CODEX_HOME',
  'REMOTE_CODEX_STATE_ROOT',
  'AGENTS_HOME',
  'CC_SWITCH_HOME',
  'SKILL_PLUGIN_ROOTS',
  'SKILL_ARTIFACT_TEMP_ROOT',
  'AUTO_START_SESSION',
  'MANAGED_COMMAND',
];

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizedPath(value) {
  return comparablePhysicalPath(value);
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function pathIsInside(parent, child) {
  return physicalPathIsInside(parent, child);
}

function normalizedHostId(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'local-dev';
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid development Relay port: ${value}`);
  }
  if (port === 8797) {
    throw new Error('npm run dev refuses production port 8797; use the production Windows launcher instead.');
  }
  return port;
}

function assertDevStateRoot(root, productionStateRoot, port) {
  if (samePath(root, productionStateRoot)) {
    throw new Error('Development RELAY_STATE_ROOT must not equal the production state root.');
  }
  const relative = path.relative(normalizedPath(productionStateRoot), normalizedPath(root));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    const parts = relative.split(path.sep).filter(Boolean);
    const allowedPortNamespace = `relay-${port}`.toLowerCase();
    if (parts.length !== 1 || parts[0].toLowerCase() !== allowedPortNamespace) {
      throw new Error(`Development state root overlaps production-owned path: ${parts[0] || '.'}`);
    }
  }
}

function resolveDevInstanceConfig(options = {}) {
  const env = options.env || process.env;
  const root = canonicalPhysicalPath(options.root || path.join(__dirname, '..'));
  const home = canonicalPhysicalPath(options.home || os.homedir());
  const hostname = options.hostname || os.hostname();
  const port = parsePort(env.REMOTE_CODEX_DEV_PORT || env.PORT || 8787);
  const productionStateRoots = Array.from(new Set([
    env.REMOTE_CODEX_PRODUCTION_STATE_ROOT,
    env.RELAY_STATE_ROOT,
    env.SESSION_RECORD_STORE_ROOT
      ? path.dirname(path.resolve(env.SESSION_RECORD_STORE_ROOT))
      : '',
    path.join(root, 'tmp'),
  ].filter(Boolean).map(canonicalPhysicalPath)));
  const productionStateRoot = productionStateRoots[0];
  const relayStateRoot = canonicalPhysicalPath(
    env.REMOTE_CODEX_DEV_STATE_ROOT || path.join(root, 'tmp', `relay-${port}`)
  );
  for (const stateRoot of productionStateRoots) {
    assertDevStateRoot(relayStateRoot, stateRoot, port);
  }

  const writablePaths = Object.fromEntries(Object.entries({
    sessionRecordStoreRoot: path.join(relayStateRoot, 'session-record-store'),
    sessionCollectionsPath: path.join(relayStateRoot, 'session-collections.json'),
    sessionMetadataPath: path.join(relayStateRoot, 'session-metadata.json'),
    sessionLogsPath: path.join(relayStateRoot, 'session-logs.json'),
    sessionDiagnosticsPath: path.join(relayStateRoot, 'session-diagnostics.json'),
    connectorsPath: path.join(relayStateRoot, 'connectors.json'),
    connectorSecretsPath: path.join(relayStateRoot, 'connector-secrets.json'),
    skillFavoritesPath: path.join(relayStateRoot, 'skill-favorites.json'),
    skillSourcesPath: path.join(relayStateRoot, 'skill-sources.json'),
    skillLibraryPath: path.join(relayStateRoot, 'skill-library.json'),
    skillInventoriesPath: path.join(relayStateRoot, 'skill-inventories.json'),
    skillRegistryPath: path.join(relayStateRoot, 'skill-registry.json'),
    skillArtifactRoot: path.join(relayStateRoot, 'skill-artifacts'),
    skillDeploymentsPath: path.join(relayStateRoot, 'skill-deployments.json'),
    skillAuditPath: path.join(relayStateRoot, 'skill-audit.jsonl'),
    sshKnownHostsPath: path.join(relayStateRoot, 'ssh', 'known_hosts'),
    relayAuthTokenPath: path.join(relayStateRoot, 'relay-auth-token.txt'),
    relayAuthAccountPath: path.join(relayStateRoot, 'relay-auth-account.json'),
    relayControlTokenPath: path.join(relayStateRoot, 'relay-control-token.txt'),
  }).map(([name, value]) => [name, canonicalPhysicalPath(value)]));
  for (const value of Object.values(writablePaths)) {
    if (!pathIsInside(relayStateRoot, value)) {
      throw new Error(`Development writable path escaped RELAY_STATE_ROOT: ${value}`);
    }
  }

  const withAgent = truthy(env.REMOTE_CODEX_DEV_WITH_AGENT);
  const productionCodexHomes = Array.from(new Set([
    env.REMOTE_CODEX_PRODUCTION_CODEX_HOME,
    env.CODEX_HOME,
    path.join(home, '.codex'),
  ].filter(Boolean).map(canonicalPhysicalPath)));
  const codexHome = canonicalPhysicalPath(
    env.REMOTE_CODEX_DEV_CODEX_HOME || path.join(relayStateRoot, 'codex-home')
  );
  if (
    withAgent
    && productionCodexHomes.some((productionHome) => physicalPathsOverlap(productionHome, codexHome))
  ) {
    throw new Error('Development Agent CODEX_HOME must not overlap the production CODEX_HOME.');
  }
  const productionAgentStateRoots = Array.from(new Set([
    env.REMOTE_CODEX_PRODUCTION_AGENT_STATE_ROOT,
    env.REMOTE_CODEX_STATE_ROOT,
    path.join(home, '.remote-codex'),
  ].filter(Boolean).map(canonicalPhysicalPath)));
  const agentStateRoot = canonicalPhysicalPath(
    env.REMOTE_CODEX_DEV_AGENT_STATE_ROOT || path.join(relayStateRoot, 'agent-state')
  );
  if (
    withAgent
    && productionAgentStateRoots.some((productionRoot) => physicalPathsOverlap(productionRoot, agentStateRoot))
  ) {
    throw new Error('Development Agent state must not overlap the production Agent state root.');
  }

  const agentsHome = canonicalPhysicalPath(path.join(agentStateRoot, 'agents'));
  const ccSwitchHome = canonicalPhysicalPath(path.join(agentStateRoot, 'cc-switch'));
  const skillArtifactTempRoot = canonicalPhysicalPath(path.join(agentStateRoot, 'skill-artifact-temp'));
  const productionAgentsHomes = Array.from(new Set([
    env.AGENTS_HOME,
    path.join(home, '.agents'),
  ].filter(Boolean).map(canonicalPhysicalPath)));
  const productionCcSwitchHomes = Array.from(new Set([
    env.CC_SWITCH_HOME,
    path.join(home, '.cc-switch'),
  ].filter(Boolean).map(canonicalPhysicalPath)));
  const productionSkillArtifactTempRoots = Array.from(new Set([
    env.SKILL_ARTIFACT_TEMP_ROOT,
    path.join(os.tmpdir(), 'remote-codex-skill-artifacts'),
  ].filter(Boolean).map(canonicalPhysicalPath)));
  if (
    withAgent
    && productionAgentsHomes.some((productionHome) => physicalPathsOverlap(productionHome, agentsHome))
  ) {
    throw new Error('Development AGENTS_HOME must not overlap the production AGENTS_HOME.');
  }
  if (
    withAgent
    && productionCcSwitchHomes.some((productionHome) => physicalPathsOverlap(productionHome, ccSwitchHome))
  ) {
    throw new Error('Development CC_SWITCH_HOME must not overlap the production CC_SWITCH_HOME.');
  }
  if (
    withAgent
    && productionSkillArtifactTempRoots.some((productionRoot) => (
      physicalPathsOverlap(productionRoot, skillArtifactTempRoot)
    ))
  ) {
    throw new Error('Development skill artifact temp root must not overlap the production temp root.');
  }

  const hostId = normalizedHostId(
    env.REMOTE_CODEX_DEV_HOST_ID || `${hostname}-dev-${port}`
  );
  return {
    root,
    port,
    relayUrl: `http://127.0.0.1:${port}`,
    relayStateRoot,
    productionStateRoot,
    withAgent,
    hostId,
    hostLabel: String(env.REMOTE_CODEX_DEV_HOST_LABEL || `${hostname} Dev ${port}`).trim(),
    codexHome,
    agentStateRoot,
    agentsHome,
    ccSwitchHome,
    skillArtifactTempRoot,
    ...writablePaths,
  };
}

function cleanInstanceEnvironment(baseEnv = {}) {
  const env = { ...baseEnv };
  const instanceKeys = new Set(INSTANCE_ENV_KEYS);
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (instanceKeys.has(normalizedKey) || normalizedKey.startsWith('RELAY_MANAGED_')) {
      delete env[key];
    }
  }
  return env;
}

function buildRelayEnvironment(config, baseEnv, relayAuthToken) {
  return {
    ...cleanInstanceEnvironment(baseEnv),
    PORT: String(config.port),
    RELAY_STATE_ROOT: config.relayStateRoot,
    RELAY_AUTH_DISABLED: 'false',
    RELAY_AUTH_TOKEN: relayAuthToken,
    RELAY_AUTH_TOKEN_PATH: config.relayAuthTokenPath,
    RELAY_AUTH_ACCOUNT_PATH: config.relayAuthAccountPath,
    RELAY_CONTROL_TOKEN_PATH: config.relayControlTokenPath,
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_LOCAL_AGENT_START_ENABLED: 'false',
    RELAY_LOCAL_HOST_STUB: 'false',
    RELAY_LOCAL_HOST_ID: config.hostId,
    RELAY_LOCAL_HOST_LABEL: config.hostLabel,
    SESSION_RECORD_STORE_ROOT: config.sessionRecordStoreRoot,
    SESSION_COLLECTIONS_PATH: config.sessionCollectionsPath,
    SESSION_METADATA_PATH: config.sessionMetadataPath,
    SESSION_LOGS_PATH: config.sessionLogsPath,
    SESSION_DIAGNOSTICS_PATH: config.sessionDiagnosticsPath,
    CONNECTORS_PATH: config.connectorsPath,
    CONNECTOR_SECRETS_PATH: config.connectorSecretsPath,
    SKILL_FAVORITES_PATH: config.skillFavoritesPath,
    SKILL_SOURCES_PATH: config.skillSourcesPath,
    SKILL_LIBRARY_PATH: config.skillLibraryPath,
    SKILL_INVENTORIES_PATH: config.skillInventoriesPath,
    SKILL_REGISTRY_PATH: config.skillRegistryPath,
    SKILL_ARTIFACT_ROOT: config.skillArtifactRoot,
    SKILL_DEPLOYMENTS_PATH: config.skillDeploymentsPath,
    SKILL_AUDIT_PATH: config.skillAuditPath,
    SSH_KNOWN_HOSTS_PATH: config.sshKnownHostsPath,
    LOCAL_CODEX_HOME: config.codexHome,
    REMOTE_CODEX_STATE_ROOT: config.agentStateRoot,
    AGENTS_HOME: config.agentsHome,
    CC_SWITCH_HOME: config.ccSwitchHome,
    SKILL_ARTIFACT_TEMP_ROOT: config.skillArtifactTempRoot,
  };
}

function buildAgentEnvironment(config, baseEnv, relayAuthToken) {
  return {
    ...cleanInstanceEnvironment(baseEnv),
    RELAY_URL: config.relayUrl,
    RELAY_AUTH_TOKEN: relayAuthToken,
    HOST_ID: config.hostId,
    HOST_LABEL: config.hostLabel,
    CODEX_HOME: config.codexHome,
    LOCAL_CODEX_HOME: config.codexHome,
    REMOTE_CODEX_STATE_ROOT: config.agentStateRoot,
    AGENTS_HOME: config.agentsHome,
    CC_SWITCH_HOME: config.ccSwitchHome,
    SKILL_ARTIFACT_TEMP_ROOT: config.skillArtifactTempRoot,
    SKILL_PLUGIN_ROOTS: '',
    AUTO_START_SESSION: 'false',
    MANAGED_COMMAND: 'codex-app-server',
  };
}

module.exports = {
  buildAgentEnvironment,
  buildRelayEnvironment,
  cleanInstanceEnvironment,
  resolveDevInstanceConfig,
};
