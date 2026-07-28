const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  discoverCodexSessions,
  findCodexSessionFile,
  isInternalApprovalReviewSession,
  isSubagentSession,
  readCodexSessionSummary,
} = require('../shared/codex-discovery');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'internal-approval-filter-host';
const GUARDIAN_ID = '11111111-1111-4111-8111-111111111111';
const USER_NAMED_ID = '22222222-2222-4222-8222-222222222222';
const NORMAL_SUBAGENT_ID = '33333333-3333-4333-8333-333333333333';
const INDEX_ONLY_ID = '44444444-4444-4444-8444-444444444444';

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function metaRow(id, source, extra = {}) {
  return {
    timestamp: '2026-07-22T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-07-22T00:00:00.000Z',
      cwd: '/workspace/project',
      originator: 'codex-tui',
      cli_version: '0.145.0-alpha.18',
      source,
      ...extra,
    },
  };
}

function userRow(message) {
  return {
    timestamp: '2026-07-22T00:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message },
  };
}

function rolloutPath(codexHome, id, second) {
  return path.join(
    codexHome,
    'sessions',
    '2026',
    '07',
    '22',
    `rollout-2026-07-22T00-00-${String(second).padStart(2, '0')}-${id}.jsonl`
  );
}

function verifyDiscoveryFiltering(tempRoot) {
  const codexHome = path.join(tempRoot, 'codex-home');
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  writeJsonl(indexPath, [
    { id: GUARDIAN_ID, thread_name: 'Approval review', created_at: '2026-07-22T00:00:00.000Z' },
    { id: USER_NAMED_ID, thread_name: 'Approval review', created_at: '2026-07-22T00:00:01.000Z' },
    { id: NORMAL_SUBAGENT_ID, thread_name: 'Approval review', created_at: '2026-07-22T00:00:02.000Z' },
    { id: INDEX_ONLY_ID, thread_name: 'Approval review', created_at: '2026-07-22T00:00:03.000Z' },
  ]);

  const guardianPath = rolloutPath(codexHome, GUARDIAN_ID, 0);
  const userNamedPath = rolloutPath(codexHome, USER_NAMED_ID, 1);
  const normalSubagentPath = rolloutPath(codexHome, NORMAL_SUBAGENT_ID, 2);
  writeJsonl(guardianPath, [
    metaRow(GUARDIAN_ID, { subagent: { other: 'guardian' } }, {
      thread_source: 'subagent',
      parent_thread_id: USER_NAMED_ID,
    }),
    userRow('The following is the Codex agent history whose request action you are assessing.'),
  ]);
  writeJsonl(userNamedPath, [
    metaRow(USER_NAMED_ID, 'cli', { thread_source: 'user', thread_name: 'Approval review' }),
    userRow('This is an ordinary user conversation.'),
  ]);
  writeJsonl(normalSubagentPath, [
    metaRow(NORMAL_SUBAGENT_ID, {
      subagent: {
        thread_spawn: {
          parent_thread_id: USER_NAMED_ID,
          depth: 1,
          agent_path: '/root/review_code',
        },
      },
    }, { thread_source: 'subagent', thread_name: 'Approval review' }),
    userRow('Review the implementation for the parent task.'),
  ]);

  assert.strictEqual(
    isInternalApprovalReviewSession({ source: { subagent: { other: 'guardian' } } }),
    true
  );
  assert.strictEqual(
    isInternalApprovalReviewSession({ source: { subagent: { thread_spawn: { depth: 1 } } } }),
    false
  );
  assert.strictEqual(
    isSubagentSession({ source: { subagent: { thread_spawn: { depth: 1 } } }, thread_source: 'subagent' }),
    true
  );
  assert.strictEqual(
    isInternalApprovalReviewSession({ title: 'Approval review', source: 'cli' }),
    false
  );

  const discoveredIds = new Set(
    discoverCodexSessions({ codexHome }).map((session) => session.sessionId)
  );
  assert(!discoveredIds.has(GUARDIAN_ID), 'guardian approval rollout must not be discovered');
  assert(discoveredIds.has(USER_NAMED_ID), 'a user-named Approval review Session must remain visible');
  assert(discoveredIds.has(NORMAL_SUBAGENT_ID), 'ordinary thread_spawn subagents should remain discoverable for lineage metadata');
  const normalSubagent = discoverCodexSessions({ codexHome })
    .find((session) => session.sessionId === NORMAL_SUBAGENT_ID);
  assert.strictEqual(normalSubagent.source, 'subagent');
  assert.strictEqual(normalSubagent.readOnly, true);
  assert.strictEqual(normalSubagent.parentThreadId, USER_NAMED_ID);
  assert.strictEqual(normalSubagent.agentPath, '/root/review_code');
  assert(discoveredIds.has(INDEX_ONLY_ID), 'an index-only same-title Session cannot be hidden without semantic metadata');

  assert.strictEqual(readCodexSessionSummary(guardianPath), null);
  assert.strictEqual(findCodexSessionFile({ codexHome, sessionId: GUARDIAN_ID }), null);
  assert(readCodexSessionSummary(userNamedPath));
  assert(findCodexSessionFile({ codexHome, sessionId: NORMAL_SUBAGENT_ID }));
}

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, method, requestPath, body = null) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode || 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function waitForRelay(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Relay exited with code ${child.exitCode}`);
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Relay did not become ready');
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function verifyRelayOutputFiltering(tempRoot) {
  const port = await openPort();
  const stateRoot = path.join(tempRoot, 'relay-state');
  const output = [];
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: stateRoot,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  try {
    await waitForRelay(port, relay);
    const registered = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: 'Internal approval filter test',
      platform: process.platform,
      capabilities: { sessionSearch: false },
    });
    assert.strictEqual(registered.statusCode, 200, JSON.stringify(registered.body));

    const discovered = await requestJson(port, 'POST', '/api/agent/events', {
      batchId: 'internal-approval-filter-batch',
      events: [{
        type: 'session.discovery',
        hostId: HOST_ID,
        discoveryId: 'internal-approval-filter-discovery',
        sessions: [
          {
            sessionId: GUARDIAN_ID,
            title: 'Approval review',
            source: { subagent: { other: 'guardian' } },
            live: false,
            updatedAt: '2026-07-22T00:00:03.000Z',
          },
          {
            sessionId: USER_NAMED_ID,
            title: 'Approval review',
            source: 'rollout',
            live: false,
            updatedAt: '2026-07-22T00:00:02.000Z',
          },
          {
            sessionId: NORMAL_SUBAGENT_ID,
            title: 'Approval review',
            source: { subagent: { thread_spawn: { depth: 1 } } },
            live: false,
            updatedAt: '2026-07-22T00:00:01.000Z',
          },
        ],
      }],
    });
    assert.strictEqual(discovered.statusCode, 200, JSON.stringify(discovered.body));

    const listed = await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/sessions`);
    assert.strictEqual(listed.statusCode, 200, JSON.stringify(listed.body));
    const listedIds = new Set((listed.body.sessions || []).map((session) => session.sessionId));
    assert(!listedIds.has(GUARDIAN_ID), 'Relay must hide an already imported guardian Session');
    assert(listedIds.has(USER_NAMED_ID), 'Relay must retain a same-title user Session');
    assert(!listedIds.has(NORMAL_SUBAGENT_ID), 'Relay must hide ordinary thread_spawn subagents from the Session list');

    const searched = await requestJson(
      port,
      'GET',
      `/api/sessions/search?hostId=${encodeURIComponent(HOST_ID)}&mode=title&q=Approval`
    );
    assert.strictEqual(searched.statusCode, 200, JSON.stringify(searched.body));
    const searchedIds = new Set((searched.body.results || []).map((session) => session.sessionId));
    assert(!searchedIds.has(GUARDIAN_ID), 'Relay search must hide an already imported guardian Session');
    assert(searchedIds.has(USER_NAMED_ID), 'Relay search must retain a same-title user Session');
    assert(!searchedIds.has(NORMAL_SUBAGENT_ID), 'Relay search must hide ordinary thread_spawn subagents');

    const input = await requestJson(
      port,
      'POST',
      `/api/sessions/${encodeURIComponent(NORMAL_SUBAGENT_ID)}/input`,
      {
        hostId: HOST_ID,
        text: 'should be rejected',
        clientRequestId: 'subagent-input-rejection',
      }
    );
    assert.strictEqual(input.statusCode, 409, JSON.stringify(input.body));
    assert.strictEqual(input.body?.code, 'subagent_session_read_only');
  } catch (error) {
    if (output.length) error.message += `\nRelay output:\n${output.join('').slice(-4000)}`;
    throw error;
  } finally {
    await stopChild(relay);
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-internal-approval-filter-'));
  try {
    verifyDiscoveryFiltering(tempRoot);
    await verifyRelayOutputFiltering(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log('internal approval Session filtering assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
