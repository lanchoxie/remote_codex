'use strict';

// Measures the local Relay acknowledgement path for Session input.  This is
// intentionally a black-box test: it does not contact a provider and does
// not alter the durable-before-ack contract.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = `input-ack-bench-host-${process.pid}`;
const SESSION_ID = `input-ack-bench-session-${process.pid}`;
const PROFILE = {
  profileId: 'input-ack-benchmark-profile',
  label: 'Input ACK benchmark',
  provider: 'OpenAI',
  providerKind: 'openai',
  baseUrl: 'https://input-ack-benchmark.invalid/v1',
  apiKey: 'input-ack-benchmark-secret',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function requestJson(port, method, pathname, body = null, timeoutMs = 30_000) {
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
          reject(new Error(`invalid JSON response (${response.statusCode}): ${error.message}\n${text.slice(0, 500)}`));
          return;
        }
        resolve({
          statusCode: response.statusCode || 0,
          body: parsed,
          headers: response.headers,
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function relayEnv(port, tempRoot, outboxPath) {
  return {
    ...process.env,
    PORT: String(port),
    RELAY_AUTH_DISABLED: 'true',
    RELAY_STATE_ROOT: tempRoot,
    INPUT_COMMAND_OUTBOX_PATH: outboxPath,
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
    RECEIVED_FILES_ROOT: path.join(tempRoot, 'received-files'),
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    RELAY_TEST_CONTROL_ENABLED: 'true',
  };
}

async function waitForHealth(port, relay) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (relay.exitCode != null) {
      throw new Error(`Relay exited before readiness (${relay.exitCode})`);
    }
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
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3_000),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function summarize(label, values) {
  return {
    label,
    count: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...values, 0).toFixed(2)),
  };
}

async function main() {
  const tempBase = path.resolve(
    process.env.REMOTE_CODEX_TEST_TMP || os.tmpdir()
  );
  fs.mkdirSync(tempBase, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(tempBase, 'remote-codex-input-ack-'));
  const outboxPath = path.join(tempRoot, 'input-command-outbox.jsonl');
  const port = await getOpenPort();
  const output = [];
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnv(port, tempRoot, outboxPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));

  let polling = true;
  let pollError = null;
  let cursor = 0;
  const idleWaiters = new Map();
  const eventQueue = [];

  async function postEvent(event) {
    const response = await requestJson(port, 'POST', '/api/agent/events', { event });
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  }

  async function acknowledgeInput(command) {
    const clientRequestId = command.clientRequestId || null;
    await postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      runId: command.runId,
      commandId: command.id,
      commandClientRequestId: clientRequestId,
      clientRequestId,
      inputOutcome: 'accepted',
      patch: {
        clientRequestId,
        nativeResumeReady: true,
        busy: false,
        activeTurnId: null,
        phase: 'idle',
        currentTurnStatus: 'completed',
        queuedCommandId: null,
        pendingClientRequestId: null,
        pendingInputSummary: null,
      },
    });
    const waiter = idleWaiters.get(clientRequestId);
    if (waiter) {
      idleWaiters.delete(clientRequestId);
      waiter();
    }
  }

  async function handleCommand(command) {
    eventQueue.push(command);
    if (command.type === 'host.api_catalog') {
      await postEvent({
        type: 'host.api_cataloged',
        hostId: HOST_ID,
        requestId: command.requestId,
        bindingFingerprint: command.bindingFingerprint || null,
        runId: command.runId || null,
        result: {
          ok: true,
          statusCode: 200,
          error: null,
          modelPage: {
            authority: 'authoritative',
            complete: true,
            truncated: false,
            nextCursor: null,
            models: [{ id: 'input-ack-benchmark-model', reasoningLevels: ['low', 'high'], defaultReasoningEffort: 'high' }],
          },
        },
      });
      return;
    }
    if (command.type === 'session.start') {
      await postEvent({
        type: 'session.started',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        nativeThreadId: command.sessionId,
        runId: command.runId,
        title: 'Input ACK benchmark',
        cwd: command.cwd,
        source: 'managed',
        launchMode: command.launchMode || 'fresh',
        conversationKey: command.conversationKey || command.sessionId,
        effectiveBinding: command.expectedBinding || null,
        runtime: {
          adapterId: 'input-ack-benchmark',
          runId: command.runId,
          launchMode: command.launchMode || 'fresh',
          nativeResumeReady: false,
          connection: 'ready',
          phase: 'idle',
          busy: false,
          activeTurnId: null,
        },
      });
      return;
    }
    if (command.type === 'session.input') {
      await acknowledgeInput(command);
    }
  }

  async function pollCommands() {
    while (polling) {
      try {
        const response = await requestJson(
          port,
          'GET',
          `/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${cursor}&ack=${cursor}`
        );
        if (response.statusCode !== 200) throw new Error(`command poll returned ${response.statusCode}`);
        for (const command of response.body?.commands || []) {
          cursor = Math.max(cursor, Number(command.id || 0));
          await handleCommand(command);
        }
      } catch (error) {
        if (polling) pollError = error;
        return;
      }
      await delay(2);
    }
  }

  async function waitForIdle(clientRequestId) {
    if (!clientRequestId) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        idleWaiters.delete(clientRequestId);
        reject(new Error(`timed out waiting for fake Host acknowledgement ${clientRequestId}`));
      }, 10_000);
      idleWaiters.set(clientRequestId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  try {
    await waitForHealth(port, relay);
    const registered = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: 'Input ACK benchmark host',
      platform: process.platform,
      capabilities: {
        apiCatalog: true,
        apiTest: true,
        bindingPreflight: true,
        runApiBinding: true,
        sessionApiRebindV1: true,
        nativeResumeReadiness: true,
        modelList: true,
        turnControls: true,
        imageInput: true,
      },
    });
    assert.strictEqual(registered.statusCode, 200, JSON.stringify(registered.body));
    const pollPromise = pollCommands();

    const started = await requestJson(port, 'POST', `/api/hosts/${encodeURIComponent(HOST_ID)}/sessions/start`, {
      sessionId: SESSION_ID,
      cwd: ROOT,
      label: 'Input ACK benchmark',
      apiConfig: PROFILE,
      model: 'input-ack-benchmark-model',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));

    // Wait until the Relay has applied session.started and exposes a live run.
    let live = null;
    let lastDetail = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = await requestJson(
        port,
        'GET',
        `/api/sessions/${encodeURIComponent(SESSION_ID)}/detail?hostId=${encodeURIComponent(HOST_ID)}`
      );
      lastDetail = detail.body;
      if (detail.statusCode === 200 && detail.body?.session?.live === true) {
        live = detail.body.session;
        break;
      }
      await delay(20);
    }
    assert(
      live?.live,
      `benchmark Session did not become live; commands=${eventQueue.map((command) => command.type).join(',')}; pollError=${pollError?.message || 'none'}; detail=${JSON.stringify(lastDetail)}\n${output.join('').slice(-4000)}`
    );

    async function measure(label, count, makeBody) {
      const values = [];
      const serverTimings = [];
      for (let index = 0; index < count; index += 1) {
        const clientRequestId = `${label}-${process.pid}-${index}`;
        const body = { ...makeBody(index), hostId: HOST_ID, clientRequestId };
        const startedAt = performance.now();
        const response = await requestJson(
          port,
          'POST',
          `/api/sessions/${encodeURIComponent(SESSION_ID)}/input`,
          body
        );
        values.push(performance.now() - startedAt);
        if (label === 'text' && index === 0) {
          serverTimings.push(response.headers?.['server-timing'] || '');
          assert(response.headers?.['x-remote-codex-input-total-ms'], 'input timing header is missing');
        }
        assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
        await waitForIdle(clientRequestId);
      }
      return { ...summarize(label, values), serverTimingSample: serverTimings[0] || null };
    }

    const textCount = Math.max(3, Number(process.env.INPUT_ACK_BENCHMARK_TEXT_COUNT || 20) || 20);
    const imageCount = Math.max(1, Number(process.env.INPUT_ACK_BENCHMARK_IMAGE_COUNT || 5) || 5);
    const imageBytes = Math.max(1, Number(process.env.INPUT_ACK_BENCHMARK_IMAGE_BYTES || 256 * 1024) || 256 * 1024);
    const imageData = `data:image/png;base64,${Buffer.alloc(imageBytes, 0x5a).toString('base64')}`;
    const results = [
      await measure('text', textCount, (index) => ({ text: `ack benchmark text ${index}` })),
      await measure('inline-image', imageCount, (index) => ({
        text: `ack benchmark image ${index}`,
        inputItems: [{ type: 'image', url: imageData, name: `benchmark-${index}.png` }],
      })),
    ];
    const outboxBytes = fs.existsSync(outboxPath) ? fs.statSync(outboxPath).size : 0;
    const payload = {
      ok: true,
      relayPort: port,
      textCount,
      imageCount,
      imageBytes,
      outboxBytes,
      commandsObserved: eventQueue.length,
      results,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (pollError) throw pollError;
    polling = false;
    await pollPromise;
  } finally {
    polling = false;
    await stopChild(relay);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {
      // Best-effort cleanup; the path is unique and contains no user data.
    }
    if (relay.exitCode && output.length) {
      process.stderr.write(output.join('').slice(-4_000));
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
