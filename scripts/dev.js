const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const relayAuthToken = getRelayAuthToken();

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function getRelayAuthToken() {
  if (truthyEnv(process.env.RELAY_AUTH_DISABLED)) {
    return '';
  }
  if (String(process.env.RELAY_AUTH_TOKEN || '').trim()) {
    return String(process.env.RELAY_AUTH_TOKEN).trim();
  }
  const tokenPath = path.join(root, 'tmp', 'relay-auth-token.txt');
  try {
    const saved = fs.readFileSync(tokenPath, 'utf8').trim();
    if (saved) {
      return saved;
    }
  } catch (_) {
    // First run creates the token below.
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', flag: 'wx' });
  return token;
}

const relay = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'relay', 'server.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(relayAuthToken ? { RELAY_AUTH_TOKEN: relayAuthToken } : {}),
  },
});

const agent = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'host-agent', 'agent.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(relayAuthToken ? { RELAY_AUTH_TOKEN: relayAuthToken } : {}),
    RELAY_URL: process.env.RELAY_URL || 'http://127.0.0.1:8787',
    HOST_ID: process.env.HOST_ID || 'local-demo',
    HOST_LABEL: process.env.HOST_LABEL || 'Local Demo',
    AUTO_START_SESSION: process.env.AUTO_START_SESSION || 'true',
    MANAGED_COMMAND: process.env.MANAGED_COMMAND || 'codex-app-server',
  },
});

function shutdown(code) {
  if (!relay.killed) {
    relay.kill();
  }
  if (!agent.killed) {
    agent.kill();
  }
  process.exit(code);
}

relay.on('exit', (code) => shutdown(code || 0));
agent.on('exit', (code) => shutdown(code || 0));

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
