const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'open-terminal-host';
const OTHER_HOST_ID = 'open-terminal-other-host';
const SESSION_ID = 'open-terminal-session';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function requestJson(port, method, pathname, body = null) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode: response.statusCode || 0, body: text ? JSON.parse(text) : null });
        } catch (error) {
          reject(new Error(`Invalid JSON for ${method} ${pathname}: ${error.message}\n${text}`));
        }
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRelay(port, child) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Relay exited with code ${child.exitCode}`);
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError || new Error('Relay did not become ready');
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)]);
}

async function registerHost(port, hostId, openTerminalV1) {
  const response = await requestJson(port, 'POST', '/api/agent/register', {
    hostId,
    label: hostId,
    platform: process.platform,
    capabilities: { openTerminalV1 },
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

async function postEvent(port, event) {
  const response = await requestJson(port, 'POST', '/api/agent/events', { event });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

function commandPoller(port, hostId) {
  let cursor = 0;
  return async function waitForCommand(type) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await requestJson(
        port,
        'GET',
        `/api/agent/commands?hostId=${encodeURIComponent(hostId)}&after=${cursor}&ack=${cursor}`
      );
      assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
      const commands = Array.isArray(response.body?.commands) ? response.body.commands : [];
      for (const command of commands) cursor = Math.max(cursor, Number(command.id || 0));
      const matched = commands.find((command) => command.type === type);
      if (matched) return matched;
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${type}`);
  };
}

async function listCommands(port, hostId) {
  const response = await requestJson(
    port,
    'GET',
    `/api/agent/commands?hostId=${encodeURIComponent(hostId)}&after=0&ack=0`
  );
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  return Array.isArray(response.body?.commands) ? response.body.commands : [];
}

function relayEnvironment(port, tempRoot) {
  return {
    ...process.env,
    PORT: String(port),
    RELAY_STATE_ROOT: tempRoot,
    RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_LOCAL_AGENT_START_ENABLED: 'false',
    SESSION_RECORD_STORE_ROOT: path.join(tempRoot, 'session-record-store'),
    SESSION_COLLECTIONS_PATH: path.join(tempRoot, 'session-collections.json'),
    SESSION_METADATA_PATH: path.join(tempRoot, 'session-metadata.json'),
    SESSION_LOGS_PATH: path.join(tempRoot, 'session-logs.json'),
    SESSION_DIAGNOSTICS_PATH: path.join(tempRoot, 'session-diagnostics.json'),
    SKILL_FAVORITES_PATH: path.join(tempRoot, 'skill-favorites.json'),
    SKILL_SOURCES_PATH: path.join(tempRoot, 'skill-sources.json'),
    SKILL_LIBRARY_PATH: path.join(tempRoot, 'skill-library.json'),
    SKILL_INVENTORIES_PATH: path.join(tempRoot, 'skill-inventories.json'),
    SKILL_REGISTRY_PATH: path.join(tempRoot, 'skill-registry.json'),
    SKILL_ARTIFACT_ROOT: path.join(tempRoot, 'skill-artifacts'),
    SKILL_DEPLOYMENTS_PATH: path.join(tempRoot, 'skill-deployments.json'),
  };
}

async function main() {
  const agentSource = fs.readFileSync(path.join(ROOT, 'apps', 'host-agent', 'agent.js'), 'utf8');
  const relaySource = fs.readFileSync(path.join(ROOT, 'apps', 'relay', 'server.js'), 'utf8');
  const spawnStart = agentSource.indexOf('function spawnDetachedTerminal(');
  const spawnEnd = agentSource.indexOf('async function openTerminalAtCwd(');
  const terminalSpawnSource = agentSource.slice(spawnStart, spawnEnd);
  assert(agentSource.includes('openTerminalV1: true'));
  assert(agentSource.includes("command.type === 'host.open_terminal'"));
  assert(agentSource.includes('terminalOpenResults.get(requestId)'));
  assert(terminalSpawnSource.includes('spawn(candidate.command, candidate.args, {'));
  assert(terminalSpawnSource.includes('shell: false'));
  assert(relaySource.includes("const cwd = String(session.cwd || '').trim()"));
  assert(relaySource.includes('pending.hostId === eventHostId'));
  assert(relaySource.includes('pending.sessionId === eventSessionId'));

  const port = await getOpenPort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-open-terminal-'));
  const output = [];
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnvironment(port, tempRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitForRelay(port, relay);
    await registerHost(port, 'open-terminal-unsupported-host', false);
    const unsupported = await requestJson(
      port,
      'POST',
      '/api/hosts/open-terminal-unsupported-host/sessions/unknown/open-terminal'
    );
    assert.strictEqual(unsupported.statusCode, 409, JSON.stringify(unsupported.body));

    await registerHost(port, HOST_ID, true);
    await registerHost(port, OTHER_HOST_ID, true);
    await postEvent(port, {
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'open-terminal-fixture',
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        conversationKey: SESSION_ID,
        title: 'Open terminal fixture',
        cwd: ROOT,
        source: 'rollout',
        live: false,
        transcriptPreview: [],
      }, {
        sessionId: 'open-terminal-missing-cwd',
        nativeThreadId: 'open-terminal-missing-cwd',
        conversationKey: 'open-terminal-missing-cwd',
        title: 'Missing cwd fixture',
        cwd: '',
        source: 'rollout',
        live: false,
        transcriptPreview: [],
      }],
      timestamp: new Date().toISOString(),
    });

    const missingCwd = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/open-terminal-missing-cwd/open-terminal`
    );
    assert.strictEqual(missingCwd.statusCode, 409, JSON.stringify(missingCwd.body));
    assert.strictEqual(missingCwd.body?.code, 'terminal_cwd_missing');

    const invalidRequestId = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/${SESSION_ID}/open-terminal`,
      { requestId: 'invalid request id' }
    );
    assert.strictEqual(invalidRequestId.statusCode, 400, JSON.stringify(invalidRequestId.body));
    assert.strictEqual(invalidRequestId.body?.code, 'terminal_request_invalid');

    const waitForCommand = commandPoller(port, HOST_ID);
    const openedClientRequestId = 'open-terminal-client-opened';
    let openedSettled = false;
    const openedResponse = requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/${SESSION_ID}/open-terminal`,
      {
        requestId: openedClientRequestId,
        cwd: 'C:\\work\\a & echo "injected"',
      }
    ).then((response) => {
      openedSettled = true;
      return response;
    });
    const openCommand = await waitForCommand('host.open_terminal');
    assert.strictEqual(openCommand.cwd, ROOT, 'Relay must ignore a client-provided cwd');
    assert.strictEqual(openCommand.sessionId, SESSION_ID);
    assert.strictEqual(openCommand.clientRequestId, openedClientRequestId);
    await postEvent(port, {
      type: 'host.terminal_opened',
      hostId: OTHER_HOST_ID,
      sessionId: SESSION_ID,
      requestId: openCommand.requestId,
      cwd: ROOT,
      platform: process.platform,
      terminal: 'Wrong Host Terminal',
      timestamp: new Date().toISOString(),
    });
    await delay(50);
    assert.strictEqual(openedSettled, false, 'A receipt from another Host must be ignored');
    await postEvent(port, {
      type: 'host.terminal_opened',
      hostId: HOST_ID,
      sessionId: 'another-session',
      requestId: openCommand.requestId,
      cwd: ROOT,
      platform: process.platform,
      terminal: 'Wrong Session Terminal',
      timestamp: new Date().toISOString(),
    });
    await delay(50);
    assert.strictEqual(openedSettled, false, 'A receipt for another Session must be ignored');
    await postEvent(port, {
      type: 'host.terminal_opened',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      requestId: openCommand.requestId,
      cwd: ROOT,
      platform: process.platform,
      terminal: 'Test Terminal',
      timestamp: new Date().toISOString(),
    });
    const opened = await openedResponse;
    assert.strictEqual(opened.statusCode, 200, JSON.stringify(opened.body));
    assert.strictEqual(opened.body?.ok, true);
    assert.strictEqual(opened.body?.opened, true);
    assert.strictEqual(opened.body?.cwd, ROOT);
    assert.strictEqual(opened.body?.clientRequestId, openedClientRequestId);

    const failedResponse = requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/${SESSION_ID}/open-terminal`
    );
    const failedCommand = await waitForCommand('host.open_terminal');
    await postEvent(port, {
      type: 'host.terminal_error',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      requestId: failedCommand.requestId,
      cwd: ROOT,
      platform: 'linux',
      code: 'terminal_gui_unavailable',
      error: 'No graphical display.',
      timestamp: new Date().toISOString(),
    });
    const failed = await failedResponse;
    assert.strictEqual(failed.statusCode, 409, JSON.stringify(failed.body));
    assert.strictEqual(failed.body?.ok, false);
    assert.strictEqual(failed.body?.opened, false);
    assert.strictEqual(failed.body?.code, 'terminal_gui_unavailable');

    const duplicateClientRequestId = 'open-terminal-client-duplicate';
    let duplicateSettledCount = 0;
    const duplicatePath = `/api/hosts/${HOST_ID}/sessions/${SESSION_ID}/open-terminal`;
    const duplicateOne = requestJson(port, 'POST', duplicatePath, {
      requestId: duplicateClientRequestId,
    }).then((response) => {
      duplicateSettledCount += 1;
      return response;
    });
    const duplicateTwo = requestJson(port, 'POST', duplicatePath, {
      requestId: duplicateClientRequestId,
    }).then((response) => {
      duplicateSettledCount += 1;
      return response;
    });

    let duplicateCommands = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      duplicateCommands = (await listCommands(port, HOST_ID)).filter(
        (command) => command.type === 'host.open_terminal'
          && command.clientRequestId === duplicateClientRequestId
      );
      if (duplicateCommands.length) break;
      await delay(25);
    }
    assert.strictEqual(duplicateCommands.length, 1, 'Concurrent retries must enqueue one Host command');
    await delay(75);
    duplicateCommands = (await listCommands(port, HOST_ID)).filter(
      (command) => command.type === 'host.open_terminal'
        && command.clientRequestId === duplicateClientRequestId
    );
    assert.strictEqual(duplicateCommands.length, 1, 'The pending request must keep one Host command');
    assert.strictEqual(duplicateSettledCount, 0, 'Both HTTP requests should wait for the Host receipt');

    const duplicateCommand = duplicateCommands[0];
    await postEvent(port, {
      type: 'host.terminal_opened',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      requestId: duplicateCommand.requestId,
      cwd: ROOT,
      platform: process.platform,
      terminal: 'Test Terminal',
      timestamp: new Date().toISOString(),
    });
    const duplicateResponses = await Promise.all([duplicateOne, duplicateTwo]);
    assert.strictEqual(duplicateSettledCount, 2);
    for (const response of duplicateResponses) {
      assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
      assert.strictEqual(response.body?.opened, true);
      assert.strictEqual(response.body?.clientRequestId, duplicateClientRequestId);
      assert.strictEqual(response.body?.commandId, duplicateCommand.id);
    }
  } catch (error) {
    error.message = `${error.message}\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    await stopChild(relay);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('open terminal relay/agent regression tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
