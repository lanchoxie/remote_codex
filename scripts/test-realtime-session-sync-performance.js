const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXISTING_DIAGNOSTICS = Number(process.env.SYNC_PERF_EXISTING_DIAGNOSTICS || 4000);
const INCOMING_DIAGNOSTICS = Number(process.env.SYNC_PERF_INCOMING_DIAGNOSTICS || 120);
const MAX_SINGLETON_INGEST_MS = Number(process.env.SYNC_PERF_MAX_SINGLETON_MS || 2500);
const DIAGNOSTIC_LIMIT = 10000;
const HOST_ID = 'sync-performance-host';
const SESSION_ID = 'sync-performance-session';
const SESSION_KEY = `${HOST_ID}::${SESSION_ID}`;

function makeDiagnostic(index, prefix = 'existing') {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 3000).toISOString(),
    severity: 'info',
    source: 'sync-performance-test',
    kind: 'reasoning',
    method: `${prefix}/${index}`,
    message: `${prefix} diagnostic ${index}`,
    detail: null,
    data: null,
    turnId: null,
  };
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
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
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (error) {
          reject(new Error(`invalid JSON response: ${error.message}`));
          return;
        }
        resolve({ statusCode: response.statusCode || 0, body: parsed });
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('relay request timed out')));
    request.on('error', reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

async function waitForRelay(port, child) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`relay exited before becoming ready with code ${child.exitCode}`);
    }
    try {
      const response = await requestJson(port, 'GET', '/health');
      if (response.statusCode === 200 && response.body?.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('relay did not become ready');
}

async function stopChild(child) {
  if (!child || child.exitCode != null) {
    return;
  }
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

async function main() {
  const agentSource = fs.readFileSync(path.join(ROOT, 'apps', 'host-agent', 'agent.js'), 'utf8');
  assert(
    /event\?\.type === 'session\.diagnostic'\s*\? ''/.test(agentSource),
    'Host diagnostic events must bypass durable batch checkpoints so high-frequency output cannot wait on full snapshots'
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'realtime-sync-performance-'));
  const diagnosticsPath = path.join(tempRoot, 'session-diagnostics.json');
  const existing = Array.from({ length: EXISTING_DIAGNOSTICS }, (_, index) => makeDiagnostic(index));
  fs.writeFileSync(diagnosticsPath, JSON.stringify({
    savedAt: new Date().toISOString(),
    diagnostics: {
      [SESSION_KEY]: existing,
    },
  }, null, 2));

  const port = await getOpenPort();
  const relayOutput = [];
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_STATE_ROOT: tempRoot,
      RELAY_AUTH_DISABLED: 'true',
      RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
      SESSION_RECORD_STORE_ROOT: path.join(tempRoot, 'session-record-store'),
      SESSION_COLLECTIONS_PATH: path.join(tempRoot, 'session-collections.json'),
      SESSION_METADATA_PATH: path.join(tempRoot, 'session-metadata.json'),
      SESSION_LOGS_PATH: path.join(tempRoot, 'session-logs.json'),
      SESSION_DIAGNOSTICS_PATH: diagnosticsPath,
      SKILL_FAVORITES_PATH: path.join(tempRoot, 'skill-favorites.json'),
      SKILL_SOURCES_PATH: path.join(tempRoot, 'skill-sources.json'),
      SKILL_LIBRARY_PATH: path.join(tempRoot, 'skill-library.json'),
      SKILL_INVENTORIES_PATH: path.join(tempRoot, 'skill-inventories.json'),
      SKILL_REGISTRY_PATH: path.join(tempRoot, 'skill-registry.json'),
      SKILL_ARTIFACT_ROOT: path.join(tempRoot, 'skill-artifacts'),
      SKILL_DEPLOYMENTS_PATH: path.join(tempRoot, 'skill-deployments.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => relayOutput.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => relayOutput.push(chunk.toString('utf8')));
  let measuredSingletonIngestMs = null;

  try {
    await waitForRelay(port, relay);
    const events = Array.from({ length: INCOMING_DIAGNOSTICS }, (_, index) => ({
      type: 'session.diagnostic',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      ...makeDiagnostic(EXISTING_DIAGNOSTICS + index, 'incoming'),
    }));

    const startedAt = Date.now();
    for (const event of events) {
      const response = await requestJson(port, 'POST', '/api/agent/events', { event });
      assert.strictEqual(response.statusCode, 200, `relay diagnostic failed: ${JSON.stringify(response.body)}`);
      assert.strictEqual(response.body?.count, 1, 'relay must ingest each singleton diagnostic');
    }
    const elapsedMs = Date.now() - startedAt;
    measuredSingletonIngestMs = elapsedMs;

    assert(
      elapsedMs < MAX_SINGLETON_INGEST_MS,
      `singleton diagnostics must not rewrite the full snapshot before each ACK; ${INCOMING_DIAGNOSTICS} events over ${EXISTING_DIAGNOSTICS} stored entries took ${elapsedMs}ms`
    );

    const detail = await requestJson(
      port,
      'GET',
      `/api/sessions/${encodeURIComponent(SESSION_ID)}/detail?hostId=${encodeURIComponent(HOST_ID)}&diagnostics=full`
    );
    assert.strictEqual(detail.statusCode, 200, `session detail failed: ${JSON.stringify(detail.body)}`);
    assert.strictEqual(
      detail.body?.diagnostics?.length,
      Math.min(DIAGNOSTIC_LIMIT, EXISTING_DIAGNOSTICS + INCOMING_DIAGNOSTICS),
      'incremental append must retain all existing and incoming diagnostics'
    );

    const duplicate = events[events.length - 1];
    const outOfOrder = {
      type: 'session.diagnostic',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      ...makeDiagnostic(EXISTING_DIAGNOSTICS + INCOMING_DIAGNOSTICS - 2, 'out-of-order'),
    };
    await requestJson(port, 'POST', '/api/agent/events', { events: [duplicate, outOfOrder] });
    const finalDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${encodeURIComponent(SESSION_ID)}/detail?hostId=${encodeURIComponent(HOST_ID)}&diagnostics=full`
    );
    assert.strictEqual(
      finalDetail.body?.diagnostics?.length,
      Math.min(DIAGNOSTIC_LIMIT, EXISTING_DIAGNOSTICS + INCOMING_DIAGNOSTICS + 1),
      'duplicate events must stay deduplicated while out-of-order events use the full compaction fallback'
    );
    assert(
      finalDetail.body.diagnostics.some((entry) => entry.message === outOfOrder.message),
      'the out-of-order fallback must retain the new diagnostic'
    );

    const blankDiagnostic = {
      type: 'session.diagnostic',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      ...makeDiagnostic(EXISTING_DIAGNOSTICS + INCOMING_DIAGNOSTICS + 1, 'blank'),
      message: '   ',
    };
    await requestJson(port, 'POST', '/api/agent/events', {
      batchId: 'blank-diagnostic-batch',
      events: [blankDiagnostic],
    });
    const blankDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${encodeURIComponent(SESSION_ID)}/detail?hostId=${encodeURIComponent(HOST_ID)}&diagnostics=full`
    );
    assert.strictEqual(
      blankDetail.body?.diagnostics?.length,
      finalDetail.body?.diagnostics?.length,
      'blank diagnostics must be filtered consistently before and after persistence'
    );

    const olderRuntimeBatch = {
      batchId: 'runtime-ordering-old',
      events: [{
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        timestamp: '2026-07-11T12:00:00.000Z',
        patch: { phase: 'older-runtime' },
      }],
    };
    await requestJson(port, 'POST', '/api/agent/events', olderRuntimeBatch);
    await requestJson(port, 'POST', '/api/agent/events', {
      batchId: 'runtime-ordering-new',
      events: [{
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        timestamp: '2026-07-11T12:00:01.000Z',
        patch: { phase: 'newer-runtime' },
      }],
    });
    const replayResponse = await requestJson(port, 'POST', '/api/agent/events', olderRuntimeBatch);
    assert.strictEqual(replayResponse.body?.duplicate, true, 'relay must acknowledge a replay without applying it twice');
    const runtimeDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${encodeURIComponent(SESSION_ID)}/detail?hostId=${encodeURIComponent(HOST_ID)}`
    );
    assert.strictEqual(
      runtimeDetail.body?.runtime?.phase,
      'newer-runtime',
      'an ambiguous-response retry must not let an older runtime patch overwrite newer state'
    );

    await requestJson(port, 'POST', '/api/agent/events', {
      events: [{
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: 'sync-current-run',
        timestamp: '2026-07-11T12:00:02.000Z',
        patch: {
          runId: 'sync-current-run',
          runtimeRevision: 2,
          phase: 'idle',
          busy: false,
          activeTurnId: null,
        },
      }],
    });
    await requestJson(port, 'POST', '/api/agent/events', {
      events: [{
        type: 'session.activity_snapshot',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: 'sync-old-run',
        turnId: 'stale-turn',
        itemId: 'stale-item',
        kind: 'reasoning',
        text: 'stale activity',
        activityRevision: 1,
        timestamp: '2026-07-11T12:00:03.000Z',
      }],
    });
    const staleActivities = await requestJson(
      port,
      'GET',
      `/api/sessions/${encodeURIComponent(SESSION_ID)}/activities?hostId=${encodeURIComponent(HOST_ID)}`
    );
    assert.strictEqual(staleActivities.body?.activities?.length, 0, 'activity from a completed run must not enter the current Session');

    await requestJson(port, 'POST', '/api/agent/events', {
      events: [{
        type: 'session.activity_snapshot',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: 'sync-current-run',
        turnId: 'current-turn',
        itemId: 'current-item',
        kind: 'reasoning',
        text: 'current activity',
        activityRevision: 1,
        timestamp: '2026-07-11T12:00:04.000Z',
      }],
    });
    const currentActivities = await requestJson(
      port,
      'GET',
      `/api/sessions/${encodeURIComponent(SESSION_ID)}/activities?hostId=${encodeURIComponent(HOST_ID)}`
    );
    assert.strictEqual(currentActivities.body?.activities?.length, 1, 'activity from the current run must remain observable');
  } catch (error) {
    if (relayOutput.length) {
      error.message += `\nRelay output:\n${relayOutput.join('').slice(-4000)}`;
    }
    throw error;
  } finally {
    await stopChild(relay);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`realtime session sync performance assertions passed (${measuredSingletonIngestMs}ms for ${INCOMING_DIAGNOSTICS} singleton diagnostics over ${EXISTING_DIAGNOSTICS} stored entries)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
