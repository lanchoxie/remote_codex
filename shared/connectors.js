const fs = require('fs');
const path = require('path');
const { makeId, nowIso } = require('./protocol');

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'tmp', 'connectors.json');

const CONNECTOR_KINDS = new Set([
  'outbound_agent',
  'ssh_jump',
  'gateway_agent',
  'reverse_tunnel',
  'manual_only',
]);

const AUTH_METHODS = new Set([
  'ssh_key',
  'ssh_agent',
  'password',
  'keyboard_interactive',
  'otp',
  'browser_sso',
  'manual_captcha',
]);

const BOOTSTRAP_MODES = new Set([
  'manual_tmux',
  'manual_systemd',
  'ssh_exec',
  'gateway_launcher',
  'manual_only',
]);

function cleanString(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  return String(value).trim();
}

function cleanText(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  return String(value).replace(/\r\n/g, '\n').trim();
}

function normalizePort(value, fallback = 22) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }

  const text = cleanText(value);
  if (!text) {
    return [];
  }

  return text
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function shellQuote(value) {
  const text = cleanString(value);
  if (!text) {
    return "''";
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function escapeDoubleQuoted(value, escapeDollar = true) {
  const pattern = escapeDollar ? /["\\$`]/g : /["\\`]/g;
  return cleanString(value).replace(pattern, (char) => `\\${char}`);
}

function shellDoubleQuote(value) {
  return `"${escapeDoubleQuoted(value)}"`;
}

function shellPathArg(value) {
  const text = cleanString(value);
  if (text === '~') {
    return '"$HOME"';
  }
  if (text.startsWith('~/')) {
    return `"$HOME/${escapeDoubleQuoted(text.slice(2))}"`;
  }
  return shellDoubleQuote(text);
}

function shellEnvValue(value, options = {}) {
  const text = cleanString(value);
  if (options.allowHome && text === '~') {
    return '"$HOME"';
  }
  if (options.allowHome && text.startsWith('~/')) {
    return `"$HOME/${escapeDoubleQuoted(text.slice(2))}"`;
  }
  return shellDoubleQuote(text);
}

function shellCommand(command, args = []) {
  return [command, ...args.map((arg) => shellQuote(arg))].join(' ');
}

function kindLabel(kind) {
  return {
    outbound_agent: 'Outbound Agent',
    ssh_jump: 'SSH Jump',
    gateway_agent: 'Gateway Sidecar',
    reverse_tunnel: 'Reverse Tunnel',
    manual_only: 'Manual Only',
  }[kind] || 'Connector';
}

function authLabel(method) {
  return {
    ssh_key: 'SSH Key',
    ssh_agent: 'SSH Agent',
    password: 'Password',
    keyboard_interactive: 'Keyboard-Interactive',
    otp: 'OTP / MFA',
    browser_sso: 'Browser SSO',
    manual_captcha: 'Manual Captcha',
  }[method] || 'Auth';
}

function bootstrapLabel(mode) {
  return {
    manual_tmux: 'Manual + tmux',
    manual_systemd: 'Manual + systemd',
    ssh_exec: 'SSH Exec',
    gateway_launcher: 'Gateway Launcher',
    manual_only: 'Manual Only',
  }[mode] || 'Bootstrap';
}

function requiresInteractiveAuth(method) {
  return [
    'password',
    'keyboard_interactive',
    'otp',
    'browser_sso',
    'manual_captcha',
  ].includes(method);
}

function connectorUsesGateway(connector) {
  const gateway = connector?.gateway || {};
  return Boolean(gateway.enabled && (gateway.host || gateway.proxyJump));
}

function normalizeConnectorInput(input = {}, existing = null) {
  const previous = existing || {};
  const previousGateway = previous.gateway || {};
  const previousAuth = previous.auth || {};
  const previousBootstrap = previous.bootstrap || {};
  const nextGateway = input.gateway || {};
  const nextAuth = input.auth || {};
  const nextBootstrap = input.bootstrap || {};
  const now = nowIso();

  const kind = cleanString(input.kind || previous.kind);
  const authMethod = cleanString(nextAuth.method || input.authMethod || previousAuth.method);
  const bootstrapMode = cleanString(nextBootstrap.mode || input.bootstrapMode || previousBootstrap.mode);

  return {
    connectorId: cleanString(input.connectorId || previous.connectorId) || makeId(),
    label: cleanString(input.label || previous.label) || 'Untitled HPC connector',
    kind: CONNECTOR_KINDS.has(kind) ? kind : 'outbound_agent',
    hostId: cleanString(input.hostId || previous.hostId),
    relayUrl: cleanString(input.relayUrl || previous.relayUrl),
    targetHost: cleanString(input.targetHost || previous.targetHost),
    targetPort: normalizePort(input.targetPort || previous.targetPort, 22),
    username: cleanString(input.username || previous.username),
    codexHome: cleanString(input.codexHome || previous.codexHome) || '~/.codex',
    workspaceRoots: normalizeStringList(input.workspaceRoots || previous.workspaceRoots),
    notes: cleanText(input.notes || previous.notes),
    gateway: {
      enabled: normalizeBoolean(nextGateway.enabled ?? input.gatewayEnabled, previousGateway.enabled),
      host: cleanString(nextGateway.host || input.gatewayHost || previousGateway.host),
      port: normalizePort(nextGateway.port || input.gatewayPort || previousGateway.port, 22),
      username: cleanString(nextGateway.username || input.gatewayUsername || previousGateway.username),
      proxyJump: cleanString(nextGateway.proxyJump || input.proxyJump || previousGateway.proxyJump),
      authMethod: AUTH_METHODS.has(cleanString(nextGateway.authMethod || input.gatewayAuthMethod || previousGateway.authMethod))
        ? cleanString(nextGateway.authMethod || input.gatewayAuthMethod || previousGateway.authMethod)
        : 'ssh_key',
      otpSource: cleanString(nextGateway.otpSource || input.gatewayOtpSource || previousGateway.otpSource),
    },
    auth: {
      method: AUTH_METHODS.has(authMethod) ? authMethod : 'ssh_key',
      keyPath: cleanString(nextAuth.keyPath || input.authKeyPath || previousAuth.keyPath),
      agentForwarding: normalizeBoolean(nextAuth.agentForwarding ?? input.authAgentForwarding, previousAuth.agentForwarding),
      rememberDevice: normalizeBoolean(nextAuth.rememberDevice ?? input.authRememberDevice, previousAuth.rememberDevice),
      otpSource: cleanString(nextAuth.otpSource || input.authOtpSource || previousAuth.otpSource),
    },
    bootstrap: {
      mode: BOOTSTRAP_MODES.has(bootstrapMode) ? bootstrapMode : 'manual_tmux',
      remoteDirectory: cleanString(nextBootstrap.remoteDirectory || input.bootstrapRemoteDirectory || previousBootstrap.remoteDirectory) || '~/mobile-codex-remote',
      tmuxSession: cleanString(nextBootstrap.tmuxSession || input.bootstrapTmuxSession || previousBootstrap.tmuxSession) || 'codex-remote',
      serviceName: cleanString(nextBootstrap.serviceName || input.bootstrapServiceName || previousBootstrap.serviceName) || 'codex-remote',
      launchCommand: cleanText(nextBootstrap.launchCommand || input.bootstrapLaunchCommand || previousBootstrap.launchCommand),
    },
    createdAt: cleanString(previous.createdAt || input.createdAt) || now,
    updatedAt: now,
  };
}

function buildAgentLaunchCommand(connector) {
  const exports = [];
  if (connector.relayUrl) {
    exports.push(`RELAY_URL=${shellEnvValue(connector.relayUrl)}`);
  }
  if (connector.relayAuthToken) {
    exports.push(`RELAY_AUTH_TOKEN=${shellEnvValue(connector.relayAuthToken)}`);
  }
  if (connector.hostId) {
    exports.push(`HOST_ID=${shellEnvValue(connector.hostId)}`);
  }
  if (connector.label) {
    exports.push(`HOST_LABEL=${shellEnvValue(connector.label)}`);
  }
  if (connector.codexHome) {
    exports.push(`CODEX_HOME=${shellEnvValue(connector.codexHome, { allowHome: true })}`);
  }
  if (Array.isArray(connector.workspaceRoots) && connector.workspaceRoots.length > 0) {
    exports.push(`WORKSPACE_ROOTS=${shellEnvValue(connector.workspaceRoots.join(';'))}`);
  }
  exports.push('AUTO_START_SESSION=false');

  const envBlock = exports.length ? `${exports.join(' ')} ` : '';
  return connector.bootstrap.launchCommand
    || `NODE_BIN="$(command -v node || command -v nodejs || test -x .runtime/node/bin/node && printf '%s\\n' "$PWD/.runtime/node/bin/node" || true)" && test -n "$NODE_BIN" && ${envBlock}"$NODE_BIN" apps/host-agent/agent.js`;
}

function tmuxShellCommand(command) {
  return shellQuote(`sh -lc ${shellQuote(command)}`);
}

function agentLogCommand(command) {
  return `echo "[remote-codex] start $(date -Is 2>/dev/null || date)" >> codex-remote.agent.log; { ${command}; } >> codex-remote.agent.log 2>&1`;
}

function buildBootstrapCommand(connector) {
  const remoteDir = connector.bootstrap.remoteDirectory || '~/mobile-codex-remote';
  const launchCommand = buildAgentLaunchCommand(connector);

  if (connector.bootstrap.mode === 'manual_tmux') {
    return `cd ${shellPathArg(remoteDir)} && tmux new -As ${shellQuote(connector.bootstrap.tmuxSession)} ${tmuxShellCommand(agentLogCommand(launchCommand))}`;
  }

  if (connector.bootstrap.mode === 'manual_systemd') {
    return `cd ${shellPathArg(remoteDir)} && ${launchCommand}`;
  }

  if (connector.bootstrap.mode === 'ssh_exec') {
    return `cd ${shellPathArg(remoteDir)} && ${launchCommand}`;
  }

  if (connector.bootstrap.mode === 'gateway_launcher') {
    return `cd ${shellPathArg(remoteDir)} && ${launchCommand}`;
  }

  return launchCommand;
}

function buildDetachedBootstrapCommand(connector, options = {}) {
  const remoteDir = connector.bootstrap.remoteDirectory || '~/mobile-codex-remote';
  const launchCommand = buildAgentLaunchCommand(connector);

  if (connector.bootstrap.mode === 'manual_tmux') {
    const tmuxSession = connector.bootstrap.tmuxSession || 'codex-remote';
    const startCommand = `tmux new-session -d -s ${shellQuote(tmuxSession)} ${tmuxShellCommand(agentLogCommand(launchCommand))}`;
    const tmuxCommand = options.restart
      ? `(tmux kill-session -t ${shellQuote(tmuxSession)} 2>/dev/null || true) && ${startCommand}`
      : `(tmux has-session -t ${shellQuote(tmuxSession)} 2>/dev/null || ${startCommand})`;
    return [
      `cd ${shellPathArg(remoteDir)}`,
      tmuxCommand,
      'echo CODEX_REMOTE_AGENT_BOOTSTRAPPED',
    ].join(' && ');
  }

  if (connector.bootstrap.mode === 'ssh_exec' || connector.bootstrap.mode === 'gateway_launcher') {
    return [
      `cd ${shellPathArg(remoteDir)}`,
      `nohup sh -lc ${shellQuote(launchCommand)} > codex-remote.agent.log 2>&1 < /dev/null &`,
      'echo CODEX_REMOTE_AGENT_BOOTSTRAPPED',
    ].join(' && ');
  }

  if (connector.bootstrap.mode === 'manual_systemd') {
    return `systemctl --user restart ${shellQuote(connector.bootstrap.serviceName || 'codex-remote')} && echo CODEX_REMOTE_AGENT_BOOTSTRAPPED`;
  }

  return '';
}

function buildRemoteStatusCommand(connector) {
  if (connector.bootstrap?.mode === 'manual_tmux') {
    const tmuxSession = connector.bootstrap.tmuxSession || 'codex-remote';
    return `tmux has-session -t ${shellQuote(tmuxSession)} 2>/dev/null && echo CODEX_REMOTE_AGENT_TMUX_RUNNING || echo CODEX_REMOTE_AGENT_TMUX_MISSING`;
  }

  return 'echo CODEX_REMOTE_AGENT_STATUS_UNKNOWN';
}

function buildSshLoginCommand(connector) {
  return buildSshCommand(connector, {});
}

function buildSshSmokeTestCommand(connector) {
  const target = buildSshCommand(connector, {
    batchMode: true,
    connectTimeout: 8,
    disableTty: true,
    remoteCommand: 'echo SSH_OK',
  });
  if (!target) {
    return '';
  }
  return target;
}

function buildSshBootstrapCommand(connector) {
  const remoteCommand = buildDetachedBootstrapCommand(connector);
  if (!remoteCommand) {
    return '';
  }

  return buildSshCommand(connector, {
    batchMode: true,
    connectTimeout: 12,
    disableTty: true,
    remoteCommand,
  });
}

function buildSshStatusCommand(connector) {
  return buildSshCommand(connector, {
    batchMode: true,
    connectTimeout: 8,
    disableTty: true,
    remoteCommand: buildRemoteStatusCommand(connector),
  });
}

function buildSshCommand(connector, options = {}) {
  const parts = buildSshCommandParts(connector, options);
  if (!parts) {
    return '';
  }

  return shellCommand(parts.command, parts.args);
}

function buildSshCommandParts(connector, options = {}) {
  if (!connector.targetHost) {
    return null;
  }

  const args = [];
  if (options.disableTty) {
    args.push('-T');
  }
  if (options.batchMode) {
    args.push('-o', 'BatchMode=yes');
  }
  if (options.connectTimeout) {
    args.push('-o', `ConnectTimeout=${normalizePort(options.connectTimeout, 8)}`);
  }
  if (options.strictHostKeyChecking) {
    args.push('-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`);
  }
  if (options.userKnownHostsFile) {
    args.push('-o', `UserKnownHostsFile=${options.userKnownHostsFile}`);
  }
  if (options.numberOfPasswordPrompts) {
    args.push('-o', `NumberOfPasswordPrompts=${normalizePort(options.numberOfPasswordPrompts, 1)}`);
  }
  if (options.preferredAuthentications) {
    args.push('-o', `PreferredAuthentications=${options.preferredAuthentications}`);
  }
  if (options.controlMaster) {
    args.push('-o', `ControlMaster=${options.controlMaster}`);
  }
  if (options.controlPersist) {
    args.push('-o', `ControlPersist=${options.controlPersist}`);
  }
  if (options.controlPath) {
    args.push('-o', `ControlPath=${options.controlPath}`);
  }
  if (options.streamLocalBindUnlink) {
    args.push('-o', `StreamLocalBindUnlink=${options.streamLocalBindUnlink}`);
  }
  if (connector.auth?.keyPath) {
    args.push('-i', connector.auth.keyPath);
    args.push('-o', 'IdentitiesOnly=yes');
    args.push('-o', 'IdentityAgent=none');
  }
  if (connector.auth?.agentForwarding) {
    args.push('-A');
  }
  const gateway = connector.gateway || {};
  const gatewayTarget = connectorUsesGateway(connector) && (gateway.proxyJump
    || (
      gateway.host
        ? `${gateway.username || connector.username ? `${gateway.username || connector.username}@` : ''}${gateway.host}${gateway.port ? `:${gateway.port}` : ''}`
        : ''
    ));

  if (gatewayTarget) {
    args.push('-J', gatewayTarget);
  }
  if (connector.targetPort && Number(connector.targetPort) !== 22) {
    args.push('-p', String(connector.targetPort));
  }

  const target = `${connector.username ? `${connector.username}@` : ''}${connector.targetHost}`;
  args.push(target);

  if (options.remoteCommand) {
    args.push(options.remoteCommand);
  }

  return {
    command: 'ssh',
    args,
  };
}

function describeAuthPrompt(scope, method) {
  const label = authLabel(method);
  if (method === 'password') {
    return `${scope} uses Password auth. Enter it in this manager to save it locally, or type it into a manual SSH prompt.`;
  }
  if (method === 'keyboard_interactive') {
    return `${scope} uses keyboard-interactive auth. Save the password locally, or add OTP notes so this manager prompts for the current code.`;
  }
  if (method === 'otp') {
    return `${scope} requires OTP / MFA. This manager prompts for the current code when you run Test, Status, or Start Agent.`;
  }
  if (method === 'browser_sso') {
    return `${scope} requires browser SSO. Complete that login outside this manager, then keep the agent alive.`;
  }
  if (method === 'manual_captcha') {
    return `${scope} requires a captcha/manual challenge. This manager can prompt for the current challenge response when SSH accepts askpass.`;
  }
  if (method === 'ssh_key' || method === 'ssh_agent') {
    return `${scope} uses ${label}; keep keys and passphrases in your SSH agent or local terminal.`;
  }
  return `${scope} uses ${label}.`;
}

function buildConnectorPlan(connector) {
  const steps = [];
  const warnings = [];
  const recommendations = [];
  const gatewayAuthMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetAuthMethod = connector.auth?.method || 'ssh_key';

  if (connector.kind === 'outbound_agent') {
    steps.push('Run the host agent directly on the HPC login node so the cluster dials the relay outward.');
    recommendations.push('Best default for campus HPC and office PCs behind NAT or strict firewalls.');
  } else if (connector.kind === 'ssh_jump') {
    steps.push('Use an SSH jump recipe to reach the login node, then launch the host agent on the final target.');
    recommendations.push('Good when users must pass through a bastion or campus gateway before they can reach the cluster.');
  } else if (connector.kind === 'gateway_agent') {
    steps.push('Keep a small launcher on the gateway and let it attach or bootstrap the real login-node agent on demand.');
    recommendations.push('Useful when the gateway is stable but the final login node changes or requires extra local policy.');
  } else if (connector.kind === 'reverse_tunnel') {
    steps.push('Let the remote side create the outbound tunnel first, then keep the host agent attached to that reverse path.');
    recommendations.push('Useful when the relay cannot be reached directly from the phone but the remote side can call out.');
  } else {
    steps.push('Treat this connector as a saved runbook for a manual HPC connection flow.');
  }

  if (connectorUsesGateway(connector)) {
    const gatewayTarget = connector.gateway.host
      ? `${connector.gateway.username ? `${connector.gateway.username}@` : ''}${connector.gateway.host}:${connector.gateway.port || 22}`
      : (connector.gateway.proxyJump || 'a saved ProxyJump rule');
    steps.push(`Route bootstrap traffic through ${gatewayTarget} before reaching the final target host.`);
    steps.push(describeAuthPrompt('Gateway', gatewayAuthMethod));
  }

  if (connector.targetHost) {
    steps.push(`Target host: ${connector.username ? `${connector.username}@` : ''}${connector.targetHost}:${connector.targetPort || 22}.`);
    steps.push(describeAuthPrompt('Target', targetAuthMethod));
  }

  if (targetAuthMethod === 'ssh_key') {
    steps.push('Use key-based SSH auth and keep any passphrase outside the relay, ideally in your local SSH agent.');
  } else if (targetAuthMethod === 'ssh_agent') {
    steps.push('Use SSH agent forwarding or a local SSH agent so the relay never stores the private key.');
  }

  if (requiresInteractiveAuth(gatewayAuthMethod)) {
    warnings.push(describeAuthPrompt('Gateway', gatewayAuthMethod));
  }

  if (requiresInteractiveAuth(targetAuthMethod)) {
    warnings.push(describeAuthPrompt('Target', targetAuthMethod));
  }

  if (requiresInteractiveAuth(gatewayAuthMethod) || requiresInteractiveAuth(targetAuthMethod)) {
    warnings.push('Saved passwords are stored only on this relay machine in an ignored local secret file. For shared machines, prefer manual SSH or SSH keys.');
  }

  if (connector.auth.rememberDevice) {
    recommendations.push('Use any available remember-this-device option to reduce repeated MFA prompts on the same gateway or login node.');
  }

  if (connector.bootstrap.mode === 'manual_tmux') {
    steps.push(`Keep the agent inside tmux session "${connector.bootstrap.tmuxSession}" so Codex survives SSH disconnects.`);
  } else if (connector.bootstrap.mode === 'manual_systemd') {
    steps.push(`Prefer a user-level systemd unit such as "${connector.bootstrap.serviceName}" if the cluster allows long-lived user services.`);
  } else if (connector.bootstrap.mode === 'ssh_exec') {
    steps.push('Bootstrap over SSH once, then rely on the host agent outbound relay connection for phone control.');
  } else if (connector.bootstrap.mode === 'gateway_launcher') {
    steps.push('Let the gateway launcher start or resume the target-side agent, instead of trying to expose the final host directly to the phone.');
  } else {
    warnings.push('This connector still needs a human-run bootstrap command before it becomes phone-controllable.');
  }

  if (connector.workspaceRoots.length > 0) {
    recommendations.push(`Known workspace roots: ${connector.workspaceRoots.join(', ')}`);
  }

  return {
    summary: recommendations[0] || steps[0] || 'Saved HPC connector profile.',
    steps,
    warnings,
    recommendations,
    sshSmokeTestCommand: buildSshSmokeTestCommand(connector),
    sshLoginCommand: buildSshLoginCommand(connector),
    sshStatusCommand: buildSshStatusCommand(connector),
    sshBootstrapCommand: buildSshBootstrapCommand(connector),
    bootstrapCommand: buildBootstrapCommand(connector),
  };
}

function decorateConnector(connector, host = null) {
  const plan = buildConnectorPlan(connector);
  const interactiveAuth = requiresInteractiveAuth(connector.auth.method)
    || (connectorUsesGateway(connector) && requiresInteractiveAuth(connector.gateway?.authMethod));
  const attached = Boolean(host);
  const online = Boolean(host?.online);

  let phase = 'saved';
  let phaseLabel = 'Saved';
  if (attached && online) {
    phase = 'attached';
    phaseLabel = 'Attached';
  } else if (interactiveAuth) {
    phase = 'manual-step-required';
    phaseLabel = 'Manual Step';
  } else if (connector.kind === 'outbound_agent') {
    phase = 'ready-to-bootstrap';
    phaseLabel = 'Ready';
  }

  const gatewaySummary = connectorUsesGateway(connector)
    ? (connector.gateway.proxyJump || `${connector.gateway.username ? `${connector.gateway.username}@` : ''}${connector.gateway.host}:${connector.gateway.port || 22}`)
    : 'No gateway';

  return {
    ...connector,
    kindLabel: kindLabel(connector.kind),
    authLabel: authLabel(connector.auth.method),
    gatewayAuthLabel: authLabel(connector.gateway?.authMethod),
    bootstrapLabel: bootstrapLabel(connector.bootstrap.mode),
    gatewaySummary,
    plan,
    runtime: {
      phase,
      phaseLabel,
      interactiveAuth,
      usesGateway: connectorUsesGateway(connector),
      attachedHostId: host?.hostId || connector.hostId || null,
      attachedHostLabel: host?.label || null,
      attachedHostOnline: online,
    },
  };
}

function serializeConnector(connector) {
  return {
    connectorId: connector.connectorId,
    label: connector.label,
    kind: connector.kind,
    hostId: connector.hostId,
    relayUrl: connector.relayUrl,
    targetHost: connector.targetHost,
    targetPort: connector.targetPort,
    username: connector.username,
    codexHome: connector.codexHome,
    workspaceRoots: Array.isArray(connector.workspaceRoots) ? connector.workspaceRoots.slice() : [],
    notes: connector.notes,
    gateway: {
      enabled: Boolean(connector.gateway?.enabled),
      host: connector.gateway?.host || '',
      port: connector.gateway?.port || 22,
      username: connector.gateway?.username || '',
      proxyJump: connector.gateway?.proxyJump || '',
      authMethod: connector.gateway?.authMethod || 'ssh_key',
      otpSource: connector.gateway?.otpSource || '',
    },
    auth: {
      method: connector.auth?.method || 'ssh_key',
      keyPath: connector.auth?.keyPath || '',
      agentForwarding: Boolean(connector.auth?.agentForwarding),
      rememberDevice: Boolean(connector.auth?.rememberDevice),
      otpSource: connector.auth?.otpSource || '',
    },
    bootstrap: {
      mode: connector.bootstrap?.mode || 'manual_tmux',
      remoteDirectory: connector.bootstrap?.remoteDirectory || '~/mobile-codex-remote',
      tmuxSession: connector.bootstrap?.tmuxSession || 'codex-remote',
      serviceName: connector.bootstrap?.serviceName || 'codex-remote',
      launchCommand: connector.bootstrap?.launchCommand || '',
    },
    createdAt: connector.createdAt || nowIso(),
    updatedAt: connector.updatedAt || nowIso(),
  };
}

function loadConnectors(storePath = DEFAULT_STORE_PATH) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.connectors)
      ? parsed.connectors
      : Array.isArray(parsed)
        ? parsed
        : [];
    return list.map((item) => normalizeConnectorInput(item, item));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function saveConnectors(connectors, storePath = DEFAULT_STORE_PATH) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const payload = {
    savedAt: nowIso(),
    connectors: Array.isArray(connectors) ? connectors.map((item) => serializeConnector(item)) : [],
  };
  fs.writeFileSync(storePath, JSON.stringify(payload, null, 2), 'utf8');
}

module.exports = {
  DEFAULT_STORE_PATH,
  buildDetachedBootstrapCommand,
  buildRemoteStatusCommand,
  buildSshCommandParts,
  decorateConnector,
  connectorUsesGateway,
  loadConnectors,
  normalizeConnectorInput,
  requiresInteractiveAuth,
  saveConnectors,
};
