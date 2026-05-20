const { spawn } = require('child_process');
const path = require('path');

const relay = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'relay', 'server.js')], {
  stdio: 'inherit',
});

const agent = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'host-agent', 'agent.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
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
