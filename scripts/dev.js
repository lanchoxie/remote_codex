const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  buildAgentEnvironment,
  buildRelayEnvironment,
  resolveDevInstanceConfig,
} = require('./dev-instance-config');

const root = path.join(__dirname, '..');
const config = resolveDevInstanceConfig({ root });
const relayAuthTokenPath = config.relayAuthTokenPath;
const relayAuthToken = getRelayAuthToken();

function getRelayAuthToken() {
  const tokenPath = relayAuthTokenPath;
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
  env: buildRelayEnvironment(config, process.env, relayAuthToken),
});

const agent = config.withAgent
  ? spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'host-agent', 'agent.js')], {
    stdio: 'inherit',
    env: buildAgentEnvironment(config, process.env, relayAuthToken),
  })
  : null;

console.log(`[dev] URL: ${config.relayUrl}`);
console.log(`[dev] state: ${config.relayStateRoot}`);
console.log(`[dev] agent: ${config.withAgent ? `${config.hostId} (${config.codexHome})` : 'disabled'}`);

function shutdown(code) {
  if (!relay.killed) {
    relay.kill();
  }
  if (agent && !agent.killed) {
    agent.kill();
  }
  process.exit(code);
}

relay.on('exit', (code) => shutdown(code || 0));
agent?.on('exit', (code) => shutdown(code || 0));

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
