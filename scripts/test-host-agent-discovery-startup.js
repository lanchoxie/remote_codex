const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-discovery-startup-'));
  const counts = { registration: 0, heartbeat: 0, discovery: 0, commandPoll: 0 };
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const send = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.url === '/api/agent/register') {
        counts.registration += 1;
        send(200, { ok: true, relayInstanceId: 'startup-test-relay', commandLanesV1: false });
      } else if (request.url === '/api/agent/heartbeat') {
        counts.heartbeat += 1;
        send(200, { ok: true, relayInstanceId: 'startup-test-relay', commandLanesV1: false });
      } else if (request.url === '/api/agent/events') {
        counts.discovery += 1;
        if (counts.discovery === 1) {
          request.socket.destroy();
        } else {
          send(413, { error: 'discovery payload exceeds test limit', code: 'request_body_too_large' });
        }
      } else if (request.url.startsWith('/api/agent/commands?')) {
        counts.commandPoll += 1;
        send(200, { ok: true, relayInstanceId: 'startup-test-relay', commandLanesV1: false, commands: [] });
      } else {
        send(404, { error: 'not found' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const output = [];
  const agent = spawn(process.execPath, [path.join(root, 'apps', 'host-agent', 'agent.js')], {
    cwd: root,
    env: {
      ...process.env,
      RELAY_URL: `http://127.0.0.1:${port}`,
      HOST_ID: 'discovery-startup-test-host',
      HOST_LABEL: 'Discovery startup test',
      CODEX_HOME: path.join(tempRoot, 'codex-home'),
      REMOTE_CODEX_STATE_ROOT: path.join(tempRoot, 'agent-state'),
      CODEX_BIN: process.execPath,
      CODEX_TAIL_ENABLED: 'false',
      AUTO_START_SESSION: 'false',
      AGENT_FETCH_RETRY_ATTEMPTS: '1',
      AGENT_FETCH_TIMEOUT_MS: '1000',
      DISCOVERY_INTERVAL_MS: '250',
      POLL_INTERVAL_MS: '250',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  agent.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && (counts.commandPoll === 0 || counts.discovery < 2) && agent.exitCode == null) {
      await delay(100);
    }
    assert(counts.registration > 0, 'Agent must register before discovery');
    assert(counts.discovery >= 2, 'the first reset and subsequent 413 must both reach discovery');
    assert(counts.heartbeat > 0, 'Agent must keep its heartbeat running');
    assert(counts.commandPoll > 0, `Agent must poll commands after discovery failure:\n${output.join('').slice(-3000)}`);
    assert.strictEqual(agent.exitCode, null, 'recoverable discovery failure must not terminate Agent');
  } finally {
    if (agent.exitCode == null) {
      agent.kill();
      await Promise.race([new Promise((resolve) => agent.once('exit', resolve)), delay(3000)]);
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log('host-agent discovery startup assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
