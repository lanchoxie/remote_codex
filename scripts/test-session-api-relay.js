const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { makeProfileBinding } = require('../shared/api-binding');
const { SessionRecordStore } = require('../apps/relay/session-record-store');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'session-api-relay-host';
const SESSION_ID = 'session-api-relay-session';
const MODEL_A = 'account-model-a';
const MODEL_B = 'account-model-b';
const PROFILE_A = {
  profileId: 'profile-a',
  label: 'Profile A',
  provider: 'OpenAI',
  baseUrl: 'https://profile-a.example/v1/?catalog=account#models',
  apiKey: 'profile-a-secret-must-not-persist',
};
const PROFILE_B = {
  profileId: 'profile-b',
  label: 'Profile B',
  provider: 'OpenAI',
  baseUrl: 'https://profile-b.example/v1',
  apiKey: 'profile-b-secret-must-not-persist',
};
const LEGACY_MANUAL_SESSION_ID = 'legacy-manual-title-session';
const LEGACY_INFERRED_SESSION_ID = 'legacy-inferred-title-session';
const CANONICAL_TITLE_SESSION_ID = 'canonical-title-session';
const MODERN_UNATTESTED_SESSION_ID = 'modern-unattested-session';
const MODERN_UNATTESTED_DISCOVERY_SESSION_ID = 'modern-unattested-discovery-session';
const OWNERSHIP_COLLISION_SESSION_ID = 'ownership-collision-session';
const DISCOVERY_CLOSE_SESSION_ID = 'discovery-close-session';
const FORK_ALIAS_SOURCE_SESSION_ID = 'fork-alias-source-session';
const FALLBACK_ALIAS_SOURCE_SESSION_ID = 'fallback-alias-source-session';
const RESTART_MISSING_LIVE_SESSION_ID = 'restart-missing-live-session';
const RESTART_LIVE_REPLACEMENT_SESSION_ID = 'restart-live-replacement-session';
const HISTORICAL_DIAGNOSTIC_SECRET = 'historical-diagnostic-secret-123456';
const LIVE_DIAGNOSTIC_SECRET = 'live-diagnostic-secret-123456';

const relaySource = fs.readFileSync(path.join(ROOT, 'apps', 'relay', 'server.js'), 'utf8');
assert(relaySource.includes("require('./session-record-store')"), 'Relay must use SessionRecordStore');
assert(relaySource.includes("require('./session-provenance-service')"), 'Relay must use SessionProvenanceService');
assert(relaySource.includes("require('./model-catalog-service')"), 'Relay must use ModelCatalogService');

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
          resolve({
            statusCode: response.statusCode || 0,
            body: text ? JSON.parse(text) : null,
          });
        } catch (error) {
          reject(new Error(`invalid JSON response for ${method} ${pathname}: ${error.message}\n${text}`));
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
    if (child.exitCode != null) {
      throw new Error(`Relay exited before readiness with code ${child.exitCode}`);
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
    delay(3000),
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relayEnv(port, tempRoot) {
  return {
    ...process.env,
    PORT: String(port),
    RELAY_STATE_ROOT: tempRoot,
    RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
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
    RELAY_STALE_MANAGED_SESSION_GRACE_MS: '0',
    RELAY_MISSING_MANAGED_DISCOVERY_CONFIRMATION_MS: '1',
    RELAY_TEST_CONTROL_ENABLED: 'true',
    RELAY_TEST_MANAGED_DISCOVERY_CLOSE_DELAY_MS: '150',
    RELAY_SESSION_STOP_FALLBACK_MS: '500',
  };
}

function spawnRelay(port, tempRoot, output) {
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'relay', 'server.js')], {
    cwd: ROOT,
    env: relayEnv(port, tempRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => output.push(chunk.toString('utf8')));
  return child;
}

async function seedSessionMetadataHydrationFixture(tempRoot) {
  fs.writeFileSync(path.join(tempRoot, 'session-metadata.json'), JSON.stringify({
    entries: [{
      hostId: HOST_ID,
      identity: LEGACY_MANUAL_SESSION_ID,
      title: 'Legacy manual title',
      cwd: ROOT,
      source: 'manual',
      updatedAt: '2026-07-15T00:00:00.000Z',
    }, {
      hostId: HOST_ID,
      identity: LEGACY_INFERRED_SESSION_ID,
      title: 'Legacy inferred title',
      cwd: ROOT,
      source: 'summary',
      updatedAt: '2026-07-15T00:00:01.000Z',
    }, {
      hostId: HOST_ID,
      identity: CANONICAL_TITLE_SESSION_ID,
      title: 'Stale legacy canonical title',
      cwd: ROOT,
      source: 'manual',
      updatedAt: '2026-07-15T00:00:02.000Z',
    }],
  }, null, 2));
  fs.writeFileSync(path.join(tempRoot, 'session-diagnostics.json'), JSON.stringify({
    diagnostics: {
      [`${HOST_ID}::${CANONICAL_TITLE_SESSION_ID}`]: [{
        timestamp: '2026-07-15T00:00:03.000Z',
        severity: 'error',
        source: 'codex',
        kind: 'error',
        method: 'error/historical-secret',
        message: `Authorization: Bearer ${HISTORICAL_DIAGNOSTIC_SECRET}`,
        detail: `https://example.invalid/failure?api_key=${HISTORICAL_DIAGNOSTIC_SECRET}`,
        data: {
          nested: { apiKey: HISTORICAL_DIAGNOSTIC_SECRET },
          echoed: `api_key=${HISTORICAL_DIAGNOSTIC_SECRET}`,
        },
      }],
    },
  }, null, 2));

  const store = await SessionRecordStore.open({
    rootDir: path.join(tempRoot, 'session-record-store'),
    now: () => '2026-07-16T00:00:00.000Z',
  });
  await store.transact('test.session.presentation.seeded', (tx) => {
    const canonicalKey = tx.resolveCanonicalKey({
      hostId: HOST_ID,
      sessionId: CANONICAL_TITLE_SESSION_ID,
    });
    const record = tx.ensureRecord(canonicalKey, {
      hostId: HOST_ID,
      conversationKey: CANONICAL_TITLE_SESSION_ID,
      source: 'manual',
    });
    record.title = 'New canonical store title';
    record.cwd = ROOT;
    record.source = 'manual';
    record.updatedAt = '2026-07-16T00:00:00.000Z';
    tx.setAlias(`${HOST_ID}::${CANONICAL_TITLE_SESSION_ID}`, canonicalKey);
    tx.markDirty(canonicalKey);
  });
  await store.close();
}

async function registerHost(port, options = {}) {
  const runApiBinding = options.runApiBinding !== false;
  const response = await requestJson(port, 'POST', '/api/agent/register', {
    hostId: HOST_ID,
    label: 'Session API Relay Host',
    platform: process.platform,
    capabilities: {
      apiCatalog: true,
      bindingPreflight: true,
      runApiBinding,
      modelList: true,
      turnControls: true,
    },
  });
  assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
}

class FakeHost {
  constructor(port) {
    this.port = port;
    this.after = 0;
    this.running = false;
    this.commands = [];
    this.error = null;
    this.failNextStartCode = null;
    this.holdNextStart = false;
    this.heldStarts = new Map();
    this.holdNextApiCatalog = false;
    this.heldApiCatalogs = new Map();
    this.holdNextStop = false;
  }

  start() {
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop() {
    this.running = false;
    await this.loopPromise;
    if (this.error) throw this.error;
  }

  async loop() {
    while (this.running) {
      try {
        const response = await requestJson(
          this.port,
          'GET',
          `/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${this.after}&ack=${this.after}`
        );
        assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
        for (const command of response.body?.commands || []) {
          this.commands.push(command);
          this.after = Math.max(this.after, Number(command.id || 0));
          await this.handle(command);
        }
      } catch (error) {
        if (this.running) this.error = error;
        this.running = false;
        return;
      }
      await delay(20);
    }
  }

  async postEvent(event) {
    const response = await requestJson(this.port, 'POST', '/api/agent/events', { event });
    assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
  }

  modelsForCommand(command) {
    const profileId = command.apiConfig?.profileId;
    if (profileId === PROFILE_B.profileId) return [MODEL_B];
    return [MODEL_A];
  }

  async handle(command) {
    if (command.type === 'host.api_catalog') {
      if (this.holdNextApiCatalog) {
        this.holdNextApiCatalog = false;
        this.heldApiCatalogs.set(command.requestId, command);
        return;
      }
      await this.announceApiCatalog(command);
      return;
    }

    if (command.type === 'host.binding_preflight') {
      await this.postEvent({
        type: 'host.binding_preflighted',
        hostId: HOST_ID,
        requestId: command.requestId,
        ok: true,
        binding: command.expectedBinding,
      });
      return;
    }

    if (command.type === 'session.model_list') {
      const activeStart = [...this.commands].reverse().find((entry) => entry.type === 'session.start');
      const model = activeStart?.apiConfig?.profileId === PROFILE_B.profileId ? MODEL_B : MODEL_A;
      await this.postEvent({
        type: 'session.model_listed',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId,
        models: [{
          id: model,
          displayName: model,
          isDefault: true,
          reasoningLevels: ['low', 'high', 'max', 'ultra'],
        }],
        nextCursor: null,
        complete: true,
        truncated: false,
        bindingFingerprint: activeStart?.expectedBinding?.bindingFingerprint || null,
        runId: activeStart?.runId || null,
      });
      return;
    }

    if (command.type === 'session.start') {
      assert(command.expectedBinding?.bindingFingerprint, 'start command must carry expectedBinding');
      assert.strictEqual(command.expectedBinding.bindingFingerprint, makeProfileBinding(command.apiConfig).bindingFingerprint);
      if (this.failNextStartCode) {
        const code = this.failNextStartCode;
        this.failNextStartCode = null;
        await this.postEvent({
          type: 'session.command_failed',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          runId: command.runId,
          operation: 'start',
          code,
          error: `fake ${code}`,
          canRebind: true,
        });
        return;
      }
      if (this.holdNextStart) {
        this.holdNextStart = false;
        this.heldStarts.set(command.runId, command);
        return;
      }
      await this.announceStarted(command);
      return;
    }

    if (command.type === 'session.stop') {
      if (command.suppressTerminalEvent) {
        return;
      }
      if (this.holdNextStop) {
        this.holdNextStop = false;
        return;
      }
      await this.postEvent({
        type: 'session.state_changed',
        hostId: HOST_ID,
        sessionId: command.requestedSessionId || command.sessionId,
        runId: command.runId,
        state: 'history-only',
        live: false,
      });
      return;
    }

    if (command.type === 'session.input') {
      await this.postEvent({
        type: 'session.selection_confirmed',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        runId: command.runId,
        model: command.model || null,
        effort: command.effort || null,
        effectiveBinding: command.apiBinding,
      });
    }
  }

  async announceStarted(command) {
      const announcedSessionId = ['fork', 'transcript_fallback'].includes(command.launchMode)
        ? `${command.sessionId}-native`
        : command.nativeThreadId || command.sessionId;
      await this.postEvent({
        type: 'session.started',
        hostId: HOST_ID,
        sessionId: announcedSessionId,
        bridgeSessionId: announcedSessionId === command.sessionId ? null : command.bridgeSessionId || command.sessionId,
        nativeThreadId: announcedSessionId,
        runId: command.runId,
        title: command.label,
        cwd: command.cwd,
        source: 'managed',
        launchMode: command.launchMode,
        originSessionId: command.originSessionId || null,
        sourceSessionId: command.sourceSessionId || null,
        conversationKey: command.conversationKey,
        effectiveBinding: command.expectedBinding,
      });
  }

  async announceApiCatalog(command) {
    const models = this.modelsForCommand(command).map((id) => ({ id }));
    await this.postEvent({
      type: 'host.api_cataloged',
      hostId: HOST_ID,
      requestId: command.requestId,
      bindingFingerprint: command.bindingFingerprint,
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
          models,
        },
      },
    });
  }

  async releaseHeldApiCatalog(requestId) {
    const command = this.heldApiCatalogs.get(requestId);
    assert(command, `missing held API catalog ${requestId}`);
    this.heldApiCatalogs.delete(requestId);
    await this.announceApiCatalog(command);
  }

  async releaseHeldStart(runId) {
    const command = this.heldStarts.get(runId);
    assert(command, `missing held start ${runId}`);
    this.heldStarts.delete(runId);
    await this.announceStarted(command);
  }
}

async function waitForCommand(fakeHost, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fakeHost.error) throw fakeHost.error;
    const command = fakeHost.commands.find(predicate);
    if (command) return command;
    await delay(20);
  }
  throw new Error('Timed out waiting for fake Host command');
}

async function waitForHeldStart(fakeHost, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fakeHost.error) throw fakeHost.error;
    const command = fakeHost.heldStarts.get(runId);
    if (command) return command;
    await delay(20);
  }
  throw new Error(`Timed out waiting for held start ${runId}`);
}

async function waitForHeldApiCatalog(fakeHost, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fakeHost.error) throw fakeHost.error;
    const held = [...fakeHost.heldApiCatalogs.values()][0];
    if (held) return held;
    await delay(20);
  }
  throw new Error('Timed out waiting for held API catalog');
}

async function waitForRuntime(port, predicate, timeoutMs = 5000, sessionId = SESSION_ID) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;
  while (Date.now() < deadline) {
    lastResponse = await requestJson(
      port,
      'GET',
      `/api/sessions/${sessionId}/runtime-config?hostId=${HOST_ID}`
    );
    if (lastResponse.statusCode === 200 && predicate(lastResponse.body)) {
      return lastResponse;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for Session runtime: ${JSON.stringify(lastResponse?.body)}`);
}

async function waitForSessionDetail(port, sessionId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;
  while (Date.now() < deadline) {
    lastResponse = await requestJson(
      port,
      'GET',
      `/api/sessions/${sessionId}/detail?hostId=${HOST_ID}`
    );
    if (lastResponse.statusCode === 200 && predicate(lastResponse.body)) {
      return lastResponse;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for Session detail: ${JSON.stringify(lastResponse?.body)}`);
}

function assertContractError(response, statusCode, code) {
  assert.strictEqual(response.statusCode, statusCode, JSON.stringify(response.body));
  assert.strictEqual(response.body?.code, code, JSON.stringify(response.body));
  assert(Object.prototype.hasOwnProperty.call(response.body || {}, 'stage'));
  assert(Object.prototype.hasOwnProperty.call(response.body || {}, 'sessionBinding'));
  assert(Object.prototype.hasOwnProperty.call(response.body || {}, 'submittedBinding'));
  assert(Object.prototype.hasOwnProperty.call(response.body || {}, 'canRebind'));
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-api-relay-'));
  const port = await getOpenPort();
  const output = [];
  await seedSessionMetadataHydrationFixture(tempRoot);
  let relay = spawnRelay(port, tempRoot, output);
  let fakeHost = null;

  try {
    await waitForRelay(port, relay);
    await registerHost(port, { runApiBinding: false });
    fakeHost = new FakeHost(port);
    fakeHost.start();

    const sanitizedHistoricalDiagnostics = await requestJson(
      port,
      'GET',
      `/api/sessions/${CANONICAL_TITLE_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      sanitizedHistoricalDiagnostics.statusCode,
      200,
      JSON.stringify(sanitizedHistoricalDiagnostics.body)
    );
    assert.strictEqual(
      JSON.stringify(sanitizedHistoricalDiagnostics.body).includes(HISTORICAL_DIAGNOSTIC_SECRET),
      false,
      'historical diagnostics must be sanitized before they are loaded into Relay state'
    );

    const legacyLiveSessionId = 'legacy-live-without-binding-attestation';
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: legacyLiveSessionId,
        nativeThreadId: legacyLiveSessionId,
        runId: 'legacy',
        title: 'Grandfathered live Session',
        cwd: ROOT,
        source: 'managed',
        live: true,
        runtime: { adapterId: 'codex-app-server' },
        transcriptPreview: [],
      }],
    });
    await fakeHost.postEvent({
      type: 'session.diagnostic',
      hostId: HOST_ID,
      sessionId: legacyLiveSessionId,
      runId: 'legacy',
      severity: 'error',
      source: 'codex',
      kind: 'error',
      method: 'error/live-secret',
      message: `Authorization: Bearer ${LIVE_DIAGNOSTIC_SECRET}`,
      detail: `request failed?access_token=${LIVE_DIAGNOSTIC_SECRET}`,
      data: {
        nested: { apiKey: LIVE_DIAGNOSTIC_SECRET },
        echoed: `api_key=${LIVE_DIAGNOSTIC_SECRET}`,
      },
    });
    const sanitizedLiveDiagnostics = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyLiveSessionId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(sanitizedLiveDiagnostics.statusCode, 200, JSON.stringify(sanitizedLiveDiagnostics.body));
    assert.strictEqual(
      JSON.stringify(sanitizedLiveDiagnostics.body).includes(LIVE_DIAGNOSTIC_SECRET),
      false,
      'new diagnostics must be sanitized before they enter Relay state'
    );
    const legacyInput = await requestJson(port, 'POST', `/api/sessions/${legacyLiveSessionId}/input`, {
      hostId: HOST_ID,
      text: 'grandfathered live input',
      apiConfig: PROFILE_A,
      model: 'legacy-saved-model',
      effort: 'xhigh',
    });
    assert.strictEqual(
      legacyInput.statusCode,
      200,
      `a Host without runApiBinding must keep its grandfathered live Session usable: ${JSON.stringify(legacyInput.body)}`
    );
    const legacyInputCommand = await waitForCommand(
      fakeHost,
      (command) => command.id === legacyInput.body?.command?.id
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyInputCommand, 'apiConfig'), false);
    assert.strictEqual(legacyInputCommand.apiBinding, null);
    assert.strictEqual(legacyInputCommand.expectedBinding, null);
    assert.strictEqual(legacyInputCommand.model, 'legacy-saved-model');
    assert.strictEqual(legacyInputCommand.effort, 'xhigh');

    fakeHost.holdNextStop = true;
    const legacyUnconfirmedStop = await requestJson(
      port,
      'POST',
      `/api/sessions/${legacyLiveSessionId}/stop`,
      { hostId: HOST_ID }
    );
    assert.strictEqual(legacyUnconfirmedStop.statusCode, 200, JSON.stringify(legacyUnconfirmedStop.body));
    await fakeHost.postEvent({
      type: 'session.output',
      hostId: HOST_ID,
      sessionId: legacyLiveSessionId,
      runId: 'legacy',
      stream: 'stdout',
      chunk: '[assistant] late legacy output while Stop is pending',
    });
    const legacyInputWhileStopping = await requestJson(
      port,
      'POST',
      `/api/sessions/${legacyLiveSessionId}/input`,
      { hostId: HOST_ID, text: 'must not enter a legacy runner while Stop is pending' }
    );
    assert.strictEqual(
      legacyInputWhileStopping.statusCode,
      409,
      JSON.stringify(legacyInputWhileStopping.body)
    );
    await waitForSessionDetail(
      port,
      legacyLiveSessionId,
      (body) => body?.session?.state !== 'ending'
    );

    const legacyUnattestedStartId = 'legacy-planned-start-without-effective-binding';
    fakeHost.holdNextStart = true;
    const legacyUnattestedStart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: legacyUnattestedStartId,
      cwd: ROOT,
      label: 'Legacy Host unattested planned start',
      apiConfig: PROFILE_A,
      model: MODEL_A,
    });
    assert.strictEqual(legacyUnattestedStart.statusCode, 200, JSON.stringify(legacyUnattestedStart.body));
    const heldLegacyStart = await waitForHeldStart(fakeHost, legacyUnattestedStart.body?.runId);
    const duplicatePendingStart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: legacyUnattestedStartId,
      cwd: ROOT,
      label: 'Duplicate pending start must fail closed',
      apiConfig: PROFILE_A,
      model: MODEL_A,
    });
    assertContractError(duplicatePendingStart, 409, 'session_run_pending');
    assert.strictEqual(
      fakeHost.commands.filter((command) => (
        command.type === 'session.start' && command.sessionId === legacyUnattestedStartId
      )).length,
      1,
      'a rejected duplicate launch must not enqueue another Host start command'
    );
    await fakeHost.postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: legacyUnattestedStartId,
      nativeThreadId: legacyUnattestedStartId,
      runId: heldLegacyStart.runId,
      title: heldLegacyStart.label,
      cwd: heldLegacyStart.cwd,
      source: 'managed',
      launchMode: heldLegacyStart.launchMode,
      conversationKey: heldLegacyStart.conversationKey,
    });
    const abortLegacyStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.stop' && command.runId === heldLegacyStart.runId
    ));
    assert.strictEqual(abortLegacyStart.sessionId, legacyUnattestedStartId);
    const legacyUnattestedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyUnattestedStartId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(legacyUnattestedDetail.statusCode, 200, JSON.stringify(legacyUnattestedDetail.body));
    assert.strictEqual(legacyUnattestedDetail.body?.session?.live, false);
    assert.strictEqual(
      legacyUnattestedDetail.body?.session?.resumeError?.code,
      'session_api_binding_attestation_unsupported'
    );
    await fakeHost.postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId: legacyUnattestedStartId,
      runId: heldLegacyStart.runId,
      state: 'history-only',
      live: false,
    });
    const legacyAfterAbortTerminal = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyUnattestedStartId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      legacyAfterAbortTerminal.body?.session?.state,
      'failed:session_api_binding_attestation_unsupported',
      'a legacy Host terminal event must not overwrite the failed start confirmation outcome'
    );
    assert.strictEqual(
      legacyAfterAbortTerminal.body?.session?.resumeError?.code,
      'session_api_binding_attestation_unsupported'
    );
    await fakeHost.postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: legacyUnattestedStartId,
      nativeThreadId: legacyUnattestedStartId,
      runId: heldLegacyStart.runId,
      title: heldLegacyStart.label,
      cwd: heldLegacyStart.cwd,
      source: 'managed',
      launchMode: heldLegacyStart.launchMode,
      conversationKey: heldLegacyStart.conversationKey,
    });
    const repeatedAbortLegacyStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.stop'
      && command.runId === heldLegacyStart.runId
      && Number(command.id || 0) > Number(abortLegacyStart.id || 0)
    ));
    assert.strictEqual(repeatedAbortLegacyStart.suppressTerminalEvent, true);
    const legacyAfterLateStarted = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyUnattestedStartId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      legacyAfterLateStarted.body?.session?.state,
      'failed:session_api_binding_attestation_unsupported',
      'a late started event must remain failed while its orphan runner is stopped again'
    );

    await registerHost(port);

    const partialBatchSessionId = 'agent-event-partial-batch-session';
    const partialBatchFailure = await requestJson(port, 'POST', '/api/agent/events', {
      batchId: 'agent-event-partial-batch-failure',
      events: [{
        type: 'session.discovery',
        hostId: HOST_ID,
        sessions: [{
          sessionId: partialBatchSessionId,
          nativeThreadId: partialBatchSessionId,
          title: 'Applied before batch failure',
          cwd: ROOT,
          source: 'imported',
          live: false,
          transcriptPreview: [],
        }],
      }, {
        type: 'host.skills.deployment.result',
        hostId: HOST_ID,
        deploymentId: 'missing-partial-batch-deployment',
        action: 'enable',
        ok: false,
        error: 'intentional invalid deployment result',
      }],
    });
    assert.strictEqual(partialBatchFailure.statusCode, 409, JSON.stringify(partialBatchFailure.body));
    assert.strictEqual(
      partialBatchFailure.body?.code,
      'agent_event_batch_apply_failed',
      JSON.stringify(partialBatchFailure.body)
    );
    assert.strictEqual(partialBatchFailure.body?.appliedCount, 1);
    assert.strictEqual(partialBatchFailure.body?.failedEventIndex, 1);
    const partiallyAppliedSession = await requestJson(
      port,
      'GET',
      `/api/sessions/${partialBatchSessionId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      partiallyAppliedSession.statusCode,
      200,
      'the response must disclose ordered at-least-once partial application without triggering legacy singles'
    );

    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: MODERN_UNATTESTED_DISCOVERY_SESSION_ID,
        nativeThreadId: MODERN_UNATTESTED_DISCOVERY_SESSION_ID,
        runId: 'modern-unattested-discovery-run',
        title: 'Modern discovered Session without attestation',
        cwd: ROOT,
        source: 'managed',
        live: true,
        runtime: { adapterId: 'codex-app-server' },
        transcriptPreview: [],
      }],
    });
    const unattestedDiscovery = await requestJson(
      port,
      'GET',
      `/api/sessions/${MODERN_UNATTESTED_DISCOVERY_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(unattestedDiscovery.statusCode, 200, JSON.stringify(unattestedDiscovery.body));
    assert.strictEqual(
      unattestedDiscovery.body?.session?.live,
      false,
      'a modern Host discovery must not publish a live Session without a verified live binding'
    );
    assert.notStrictEqual(unattestedDiscovery.body?.session?.state, 'running');

    await fakeHost.postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: MODERN_UNATTESTED_SESSION_ID,
      nativeThreadId: MODERN_UNATTESTED_SESSION_ID,
      runId: 'modern-unattested-run',
      title: 'Modern Host without attestation',
      cwd: ROOT,
      source: 'managed',
      launchMode: 'fresh',
    });
    const unattestedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${MODERN_UNATTESTED_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(unattestedDetail.statusCode, 200, JSON.stringify(unattestedDetail.body));
    assert.strictEqual(
      unattestedDetail.body?.session?.live,
      false,
      'a modern Host must not publish an unattested Session as live through compatibility fallback'
    );
    assert.strictEqual(
      unattestedDetail.body?.session?.state,
      'failed:session_api_binding_unavailable'
    );

    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [LEGACY_MANUAL_SESSION_ID, LEGACY_INFERRED_SESSION_ID].map((sessionId) => ({
        sessionId,
        title: sessionId,
        cwd: ROOT,
        source: 'vscode',
        live: false,
        transcriptPreview: [],
      })),
    });
    const hydratedTitles = await requestJson(port, 'GET', `/api/hosts/${HOST_ID}/sessions?full=1`);
    assert.strictEqual(hydratedTitles.statusCode, 200, JSON.stringify(hydratedTitles.body));
    const titleBySessionId = new Map(
      (hydratedTitles.body?.sessions || []).map((session) => [session.sessionId, session.title])
    );
    assert.strictEqual(
      titleBySessionId.get(LEGACY_MANUAL_SESSION_ID),
      'Legacy manual title',
      'Store hydration must preserve legacy manual Session metadata missing from the Store'
    );
    assert.strictEqual(
      titleBySessionId.get(LEGACY_INFERRED_SESSION_ID),
      'Legacy inferred title',
      'Store hydration must preserve legacy inferred Session metadata missing from the Store'
    );
    assert.strictEqual(
      titleBySessionId.get(CANONICAL_TITLE_SESSION_ID),
      'New canonical store title',
      'Store-backed canonical Session metadata must overlay an older legacy cache entry'
    );

    const startCommandCountBeforeInvalidLaunches = fakeHost.commands.filter((command) => command.type === 'session.start').length;
    const missingCwd = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      apiConfig: PROFILE_A,
    });
    assertContractError(missingCwd, 422, 'session_cwd_unavailable');
    const missingHistory = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      launchMode: 'resume',
      sourceSessionId: 'missing-history-session',
      apiConfig: PROFILE_A,
    });
    assertContractError(missingHistory, 404, 'session_history_unavailable');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startCommandCountBeforeInvalidLaunches,
      'invalid launch prerequisites must be rejected before queueing a start'
    );

    const started = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: SESSION_ID,
      cwd: ROOT,
      label: 'Session API Relay Test',
      apiConfig: PROFILE_A,
      model: MODEL_A,
      selectionSource: 'user',
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    assert.strictEqual(started.body?.sessionId, SESSION_ID);

    const firstStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start'
      && command.sessionId === SESSION_ID
      && command.apiConfig?.profileId === PROFILE_A.profileId
    ));
    assert.strictEqual(firstStart.model, MODEL_A);
    assert.strictEqual(firstStart.effort, null);
    assert.strictEqual(JSON.stringify(started.body).includes(PROFILE_A.apiKey), false);

    const runtime = await waitForRuntime(port, (body) => body?.sessionBinding?.profileId === PROFILE_A.profileId);
    assert.strictEqual(runtime.statusCode, 200, JSON.stringify(runtime.body));
    assert.strictEqual(runtime.body?.sessionBinding?.profileId, PROFILE_A.profileId);
    assert.strictEqual(runtime.body?.requestedSelection?.model, MODEL_A);
    assert.strictEqual(runtime.body?.effectiveSelection?.model, null);
    assert.strictEqual(runtime.body?.effectiveSelection?.effort, null);
    assert.strictEqual(JSON.stringify(runtime.body).includes(PROFILE_A.apiKey), false);

    await fakeHost.announceStarted(firstStart);
    const afterDuplicateStarted = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(afterDuplicateStarted.statusCode, 200, JSON.stringify(afterDuplicateStarted.body));
    assert.strictEqual(afterDuplicateStarted.body?.session?.live, true, 'duplicate started delivery must be idempotent');
    assert.strictEqual(afterDuplicateStarted.body?.session?.runId, firstStart.runId);

    await fakeHost.postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      nativeThreadId: SESSION_ID,
      runId: firstStart.runId,
      title: firstStart.label,
      cwd: firstStart.cwd,
      source: 'managed',
      launchMode: firstStart.launchMode,
      conversationKey: firstStart.conversationKey,
      effectiveBinding: makeProfileBinding(PROFILE_B),
    });
    const afterMismatchedDuplicateStarted = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(afterMismatchedDuplicateStarted.statusCode, 200, JSON.stringify(afterMismatchedDuplicateStarted.body));
    assert.strictEqual(
      afterMismatchedDuplicateStarted.body?.session?.live,
      true,
      'an invalid duplicate confirmation must not rewrite an already terminal live run in the UI projection'
    );

    await fakeHost.postEvent({
      type: 'session.command_failed',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: firstStart.runId,
      operation: 'start',
      code: 'session_spawn_failed',
      error: 'delayed failure after the run was confirmed live',
    });
    const afterLiveStartFailure = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(afterLiveStartFailure.statusCode, 200, JSON.stringify(afterLiveStartFailure.body));
    assert.strictEqual(
      afterLiveStartFailure.body?.session?.live,
      true,
      'a delayed start failure must not close the same run after it is live'
    );
    assert.strictEqual(afterLiveStartFailure.body?.session?.runId, firstStart.runId);

    const models = await requestJson(port, 'GET', `/api/sessions/${SESSION_ID}/models?hostId=${HOST_ID}`);
    assert.strictEqual(models.statusCode, 200, JSON.stringify(models.body));
    assert(models.body?.models?.some((model) => model.id === MODEL_A));
    assert(models.body?.sources?.some((source) => source.source === 'live'));
    assert(models.body?.sources?.some((source) => source.source === 'provider'));

    const catalogCommandsBeforeRefresh = fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length;
    const refreshedModels = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/models/refresh`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_A,
    });
    assert.strictEqual(refreshedModels.statusCode, 200, JSON.stringify(refreshedModels.body));
    assert(refreshedModels.body?.models?.some((model) => model.id === MODEL_A));
    assert(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length > catalogCommandsBeforeRefresh,
      'explicit refresh must request a fresh provider catalog'
    );
    const catalogCommandsBeforeMismatch = fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length;
    const refreshMismatch = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/models/refresh`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_B,
    });
    assertContractError(refreshMismatch, 409, 'session_api_binding_mismatch');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
      catalogCommandsBeforeMismatch,
      'mismatched refresh must be rejected before Host I/O'
    );

    const mismatch = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'must be rejected before queueing',
      apiConfig: PROFILE_B,
    });
    assertContractError(mismatch, 409, 'session_api_binding_mismatch');
    const detailAfterMismatch = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      (detailAfterMismatch.body?.transcript || []).some((entry) => entry.text === 'must be rejected before queueing'),
      false,
      'rejected input must not be written to the transcript'
    );

    const input = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'bound live input',
      model: MODEL_A,
      effort: 'high',
    });
    assert.strictEqual(input.statusCode, 200, JSON.stringify(input.body));
    const inputCommand = await waitForCommand(fakeHost, (command) => command.id === input.body?.command?.id);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(inputCommand, 'apiConfig'), false);
    assert.strictEqual(inputCommand.expectedBinding?.profileId, PROFILE_A.profileId);
    assert.strictEqual(inputCommand.apiBinding?.profileId, PROFILE_A.profileId);
    const selectedRuntime = await waitForRuntime(port, (body) => body?.effectiveSelection?.effort === 'high');
    assert.strictEqual(selectedRuntime.body?.effectiveSelection?.model, MODEL_A);
    assert.strictEqual(selectedRuntime.body?.effectiveSelection?.effort, 'high');

    const staleRebind = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/rebind`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_B,
      model: MODEL_B,
      expectedRunId: 'stale-observed-run',
      expectedRunStatus: selectedRuntime.body?.runStatus,
      expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    assertContractError(staleRebind, 409, 'session_run_changed');

    const compact = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/compact`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_A,
    });
    assert.strictEqual(compact.statusCode, 200, JSON.stringify(compact.body));
    const compactCommand = await waitForCommand(fakeHost, (command) => command.id === compact.body?.command?.id);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(compactCommand, 'apiConfig'), false);
    assert.strictEqual(compactCommand.expectedBinding?.profileId, PROFILE_A.profileId);

    fakeHost.holdNextApiCatalog = true;
    fakeHost.holdNextStart = true;
    fakeHost.holdNextStop = true;
    const reboundPromise = requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/rebind`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_B,
      model: MODEL_B,
      expectedRunId: selectedRuntime.body?.runId,
      expectedRunStatus: selectedRuntime.body?.runStatus,
      expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    const heldRebindCatalog = await waitForHeldApiCatalog(fakeHost);
    assert.strictEqual(heldRebindCatalog.apiConfig?.profileId, PROFILE_B.profileId);
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [],
    });
    const sourceDuringPendingRebindDiscovery = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      sourceDuringPendingRebindDiscovery.body?.session?.runId,
      firstStart.runId,
      'stale discovery must not close the live parent or overwrite a pending replacement projection'
    );
    assert.strictEqual(sourceDuringPendingRebindDiscovery.body?.session?.live, true);
    const inputDuringRebindValidation = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'the existing run stays writable while rebind validation is pending',
      model: MODEL_A,
      effort: 'high',
    });
    await fakeHost.releaseHeldApiCatalog(heldRebindCatalog.requestId);
    const rebound = await reboundPromise;
    assert.strictEqual(
      inputDuringRebindValidation.statusCode,
      200,
      `catalog validation must not replace the live run: ${JSON.stringify(inputDuringRebindValidation.body)}`
    );
    assert.strictEqual(inputDuringRebindValidation.body?.command?.runId, firstStart.runId);
    assert.strictEqual(rebound.statusCode, 200, JSON.stringify(rebound.body));
    const secondStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start' && command.apiConfig?.profileId === PROFILE_B.profileId
    ));
    await waitForHeldStart(fakeHost, rebound.body.runId);
    assert.strictEqual(secondStart.launchMode, 'resume');
    assert.strictEqual(secondStart.expectedBinding.profileId, PROFILE_B.profileId);
    assert.strictEqual(secondStart.model, MODEL_B);
    assert.strictEqual(secondStart.effort, null);

    const pendingRebindDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      pendingRebindDetail.body?.session?.runId,
      rebound.body.runId,
      `pending Rebind projection must retain the child run: ${JSON.stringify(pendingRebindDetail.body?.session)}`
    );

    const pendingRebindModels = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/models?hostId=${HOST_ID}`
    );
    assert.strictEqual(pendingRebindModels.statusCode, 200, JSON.stringify(pendingRebindModels.body));
    assert.strictEqual(
      pendingRebindModels.body?.runId,
      rebound.body.runId,
      `a pending Rebind model catalog must be labeled with the pending run identity: ${JSON.stringify(pendingRebindModels.body)}`
    );
    assert.strictEqual(pendingRebindModels.body?.sessionBinding?.profileId, PROFILE_B.profileId);
    assert(pendingRebindModels.body?.models?.some((model) => model.id === MODEL_B));
    assert.strictEqual(
      pendingRebindModels.body?.models?.some((model) => model.id === MODEL_A),
      false,
      'the previous successful run catalog must not be cached under the pending Rebind key'
    );
    const stopCommandsBeforePendingStop = fakeHost.commands.filter(
      (command) => command.type === 'session.stop'
    ).length;
    const stopWhileRebindPending = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/stop`,
      {
        hostId: HOST_ID,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(stopWhileRebindPending, 409, 'session_run_pending');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopCommandsBeforePendingStop,
      'a rejected Stop during pending Rebind must not enqueue another Host command'
    );
    const rebindParentStop = [...fakeHost.commands].reverse().find((command) => (
      command.type === 'session.stop'
      && command.runId === selectedRuntime.body?.runId
      && !command.suppressTerminalEvent
    ));
    assert(rebindParentStop, 'Rebind must stop its parent run before starting the replacement');
    await fakeHost.postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: rebindParentStop.runId,
      state: 'history-only',
      live: false,
    });
    const afterParentTerminal = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(afterParentTerminal.body?.session?.runId, rebound.body.runId);
    assert.strictEqual(afterParentTerminal.body?.session?.state, 'starting');
    await fakeHost.releaseHeldStart(rebound.body.runId);

    const reboundRuntime = await waitForRuntime(port, (body) => body?.sessionBinding?.profileId === PROFILE_B.profileId);
    assert.strictEqual(reboundRuntime.statusCode, 200, JSON.stringify(reboundRuntime.body));
    assert.strictEqual(reboundRuntime.body?.sessionBinding?.profileId, PROFILE_B.profileId);
    assert.strictEqual(reboundRuntime.body?.requestedSelection?.model, MODEL_B);
    assert.strictEqual(reboundRuntime.body?.effectiveSelection?.model, null);

    const reboundModels = await requestJson(port, 'GET', `/api/sessions/${SESSION_ID}/models?hostId=${HOST_ID}`);
    assert.strictEqual(reboundModels.statusCode, 200, JSON.stringify(reboundModels.body));
    assert(reboundModels.body?.models?.some((model) => model.id === MODEL_B));
    const reboundInput = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'confirm rebound model selection',
      model: MODEL_B,
      effort: 'max',
    });
    assert.strictEqual(reboundInput.statusCode, 200, JSON.stringify(reboundInput.body));
    await waitForCommand(fakeHost, (command) => command.id === reboundInput.body?.command?.id);
    const confirmedReboundRuntime = await waitForRuntime(port, (body) => body?.effectiveSelection?.effort === 'max');
    assert.strictEqual(confirmedReboundRuntime.body?.effectiveSelection?.model, MODEL_B);
    assert.strictEqual(confirmedReboundRuntime.body?.effectiveSelection?.effort, 'max');

    await fakeHost.postEvent({
      type: 'session.selection_confirmed',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      model: MODEL_A,
      effort: 'low',
    });
    const afterUnscopedSelection = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      afterUnscopedSelection.body?.effectiveSelection?.effort,
      'max',
      'a modern Host event without runId must not mutate the current run selection'
    );

    await fakeHost.postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      state: 'history-only',
      live: false,
    });
    const afterUnscopedTerminal = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      afterUnscopedTerminal.body?.session?.live,
      true,
      'a modern Host terminal event without runId must not stop the current replacement run'
    );

    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: confirmedReboundRuntime.body?.runId,
      patch: {
        phase: 'working',
        connection: 'ready',
        busy: true,
        activeTurnId: 'turn-before-unconfirmed-stop',
        runId: confirmedReboundRuntime.body?.runId,
      },
    });
    fakeHost.holdNextStop = true;
    const unconfirmedStop = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/stop`, {
      hostId: HOST_ID,
      expectedRunId: confirmedReboundRuntime.body?.runId,
      expectedRunStatus: confirmedReboundRuntime.body?.runStatus,
      expectedBindingFingerprint: confirmedReboundRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    assert.strictEqual(unconfirmedStop.statusCode, 200, JSON.stringify(unconfirmedStop.body));
    const stoppingRuntime = await waitForRuntime(port, (body) => body?.runStatus === 'stopping');
    assert.strictEqual(stoppingRuntime.body?.runId, confirmedReboundRuntime.body?.runId);
    await fakeHost.postEvent({
      type: 'session.output',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: confirmedReboundRuntime.body?.runId,
      stream: 'stdout',
      chunk: '[assistant] late output while Stop is pending',
    });
    await fakeHost.postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      nativeThreadId: SESSION_ID,
      runId: confirmedReboundRuntime.body?.runId,
      title: 'Late duplicate start while Stop is pending',
      cwd: ROOT,
      source: 'managed',
      effectiveBinding: makeProfileBinding(PROFILE_B),
    });
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: confirmedReboundRuntime.body?.runId,
      patch: {
        phase: 'idle',
        connection: 'ready',
        busy: false,
        activeTurnId: null,
        runId: confirmedReboundRuntime.body?.runId,
      },
    });
    const inputWhileStopping = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'must not enter a runner while Stop is pending',
    });
    assert.strictEqual(inputWhileStopping.statusCode, 409, JSON.stringify(inputWhileStopping.body));
    const restoredAfterUnconfirmedStop = await waitForRuntime(
      port,
      (body) => body?.runStatus === 'live' && body?.effectiveSelection?.effort === 'max'
    );
    assert.strictEqual(restoredAfterUnconfirmedStop.body?.runId, confirmedReboundRuntime.body?.runId);
    const restoredDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(restoredDetail.body?.session?.live, true);
    assert.notStrictEqual(restoredDetail.body?.session?.state, 'ending');
    assert.strictEqual(restoredDetail.body?.runtime?.phase, 'idle');
    assert.strictEqual(restoredDetail.body?.runtime?.busy, false);
    assert.strictEqual(restoredDetail.body?.runtime?.activeTurnId, null);

    const stopCommandsBeforeStaleRequest = fakeHost.commands.filter(
      (command) => command.type === 'session.stop'
    ).length;
    const staleStop = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/stop`, {
      hostId: HOST_ID,
      expectedRunId: selectedRuntime.body?.runId,
      expectedRunStatus: selectedRuntime.body?.runStatus,
      expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    assertContractError(staleStop, 409, 'session_run_changed');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopCommandsBeforeStaleRequest,
      'a stale Stop must be rejected before a Host command is queued'
    );

    await fakeHost.postEvent({
      type: 'session.selection_confirmed',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: firstStart.runId,
      model: MODEL_A,
      effort: 'low',
    });
    await fakeHost.postEvent({
      type: 'session.command_failed',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: firstStart.runId,
      operation: 'start',
      code: 'session_spawn_failed',
      error: 'delayed failure from the replaced run',
    });
    const afterStaleEvents = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(afterStaleEvents.statusCode, 200, JSON.stringify(afterStaleEvents.body));
    assert.strictEqual(afterStaleEvents.body?.session?.live, true, 'a stale failure must not close the current run');
    assert.strictEqual(
      afterStaleEvents.body?.session?.runId,
      secondStart.runId,
      'delayed selection/failure events must not replace the current run identity'
    );
    const commandHighWaterBeforeStaleStarted = Math.max(
      0,
      ...fakeHost.commands.map((command) => Number(command.id || 0))
    );
    await fakeHost.postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      nativeThreadId: SESSION_ID,
      runId: firstStart.runId,
      title: firstStart.label,
      cwd: firstStart.cwd,
      source: 'managed',
      launchMode: firstStart.launchMode,
      conversationKey: firstStart.conversationKey,
      effectiveBinding: firstStart.expectedBinding,
    });
    const staleStartedAbort = await waitForCommand(fakeHost, (command) => (
      Number(command.id || 0) > commandHighWaterBeforeStaleStarted
      && command.type === 'session.stop'
      && command.runId === firstStart.runId
    ));
    assert.strictEqual(staleStartedAbort.suppressTerminalEvent, true);
    assert.strictEqual(staleStartedAbort.reason, 'stale-session-started');
    assert.strictEqual(staleStartedAbort.sessionId, SESSION_ID);
    assert.notStrictEqual(staleStartedAbort.runId, secondStart.runId);
    const afterStaleStarted = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(afterStaleStarted.body?.session?.live, true);
    assert.strictEqual(afterStaleStarted.body?.session?.runId, secondStart.runId);
    const inputAfterStaleEvents = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'current run remains writable after stale events',
      model: MODEL_B,
      effort: 'max',
    });
    assert.strictEqual(inputAfterStaleEvents.statusCode, 200, JSON.stringify(inputAfterStaleEvents.body));
    const inputAfterStaleCommand = await waitForCommand(
      fakeHost,
      (command) => command.id === inputAfterStaleEvents.body?.command?.id
    );
    assert.strictEqual(inputAfterStaleCommand.runId, secondStart.runId);

    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        runId: secondStart.runId,
        title: 'Session API Relay Test',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }, {
        sessionId: OWNERSHIP_COLLISION_SESSION_ID,
        nativeThreadId: OWNERSHIP_COLLISION_SESSION_ID,
        runId: secondStart.runId,
        originSessionId: SESSION_ID,
        sourceSessionId: SESSION_ID,
        conversationKey: SESSION_ID,
        title: 'Independent ownership collision history',
        cwd: ROOT,
        source: 'vscode',
        live: false,
        transcriptPreview: [{ speaker: 'user', text: 'independent ownership history' }],
      }],
    });
    const ownershipCollisionDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${OWNERSHIP_COLLISION_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(ownershipCollisionDetail.statusCode, 200, JSON.stringify(ownershipCollisionDetail.body));
    assert.strictEqual(
      ownershipCollisionDetail.body?.session?.sessionId,
      OWNERSHIP_COLLISION_SESSION_ID,
      'run and lineage fields must not transfer Session ownership to a different live Session'
    );
    assert.strictEqual(
      ownershipCollisionDetail.body?.session?.title,
      'Independent ownership collision history'
    );

    const discoveryCloseStarted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: DISCOVERY_CLOSE_SESSION_ID,
      cwd: ROOT,
      label: 'Discovery close durability',
      apiConfig: PROFILE_A,
      model: MODEL_A,
    });
    assert.strictEqual(discoveryCloseStarted.statusCode, 200, JSON.stringify(discoveryCloseStarted.body));
    const discoveryCloseStartCommand = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start' && command.runId === discoveryCloseStarted.body?.runId
    ));
    const discoveryCloseRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === discoveryCloseStarted.body?.runId && body?.runStatus === 'live',
      5000,
      DISCOVERY_CLOSE_SESSION_ID
    );
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'stale-discovery-close-run',
      sessions: [{
        sessionId: DISCOVERY_CLOSE_SESSION_ID,
        nativeThreadId: DISCOVERY_CLOSE_SESSION_ID,
        bridgeSessionId: 'stale-discovery-bridge',
        conversationKey: 'stale-discovery-conversation',
        originSessionId: 'stale-discovery-origin',
        sourceSessionId: 'stale-discovery-source',
        runId: 'stale-discovery-run',
        title: 'Stale discovery projection',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
        assistantCursor: {
          observations: [],
          cursorOffset: 41,
          cursorUnknown: false,
          fileIdentity: 'stale-discovery-assistant-cursor',
          projectionRevision: 1,
        },
      }],
    });
    const projectionAfterStaleDiscovery = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_CLOSE_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(projectionAfterStaleDiscovery.body?.session?.live, true);
    assert.strictEqual(
      projectionAfterStaleDiscovery.body?.session?.runId,
      discoveryCloseStarted.body?.runId,
      'an old discovery snapshot must not overwrite a replacement run projection'
    );
    assert.notStrictEqual(projectionAfterStaleDiscovery.body?.session?.title, 'Stale discovery projection');
    assert.notStrictEqual(projectionAfterStaleDiscovery.body?.session?.bridgeSessionId, 'stale-discovery-bridge');
    assert.notStrictEqual(projectionAfterStaleDiscovery.body?.session?.conversationKey, 'stale-discovery-conversation');
    assert.notStrictEqual(projectionAfterStaleDiscovery.body?.session?.originSessionId, 'stale-discovery-origin');
    assert.notStrictEqual(projectionAfterStaleDiscovery.body?.session?.sourceSessionId, 'stale-discovery-source');
    const provenanceAfterStaleDiscovery = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_CLOSE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      provenanceAfterStaleDiscovery.body?.provenance?.title,
      discoveryCloseRuntime.body?.provenance?.title,
      'stale discovery must not durably overwrite the current run title'
    );
    assert.strictEqual(
      provenanceAfterStaleDiscovery.body?.provenance?.conversationKey,
      discoveryCloseRuntime.body?.provenance?.conversationKey
    );
    assert.strictEqual(
      provenanceAfterStaleDiscovery.body?.provenance?.bridgeSessionId,
      discoveryCloseRuntime.body?.provenance?.bridgeSessionId
    );
    assert.strictEqual(
      provenanceAfterStaleDiscovery.body?.provenance?.originSessionId,
      discoveryCloseRuntime.body?.provenance?.originSessionId
    );
    assert.strictEqual(
      provenanceAfterStaleDiscovery.body?.provenance?.sourceSessionId,
      discoveryCloseRuntime.body?.provenance?.sourceSessionId
    );
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'current-discovery-close-run',
      sessions: [{
        sessionId: DISCOVERY_CLOSE_SESSION_ID,
        nativeThreadId: DISCOVERY_CLOSE_SESSION_ID,
        runId: discoveryCloseStarted.body?.runId,
        title: 'Discovery close durability',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    });
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'discovery-close-missing-1',
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        runId: secondStart.runId,
        title: 'Session API Relay Test',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    });
    const discoveryStillLiveAfterFirstMissing = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_CLOSE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      discoveryStillLiveAfterFirstMissing.body?.activeRunId,
      discoveryCloseStarted.body?.runId,
      'one missing discovery snapshot must not close an active run'
    );
    const staleMissingAfterRestartedEvent = {
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'discovery-close-stale-missing-after-started',
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        runId: secondStart.runId,
        title: 'Session API Relay Test',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    };
    const overlappingMissingRequest = requestJson(port, 'POST', '/api/agent/events', {
      event: staleMissingAfterRestartedEvent,
    });
    await delay(30);
    await fakeHost.announceStarted(discoveryCloseStartCommand);
    const overlappingMissingResponse = await overlappingMissingRequest;
    assert.strictEqual(
      overlappingMissingResponse.statusCode,
      200,
      JSON.stringify(overlappingMissingResponse.body)
    );
    const discoveryStillLiveAfterStartedRace = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_CLOSE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      discoveryStillLiveAfterStartedRace.body?.activeRunId,
      discoveryCloseStarted.body?.runId,
      'a verified current-run start must clear an older missing-discovery strike'
    );
    await delay(5);
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'discovery-close-missing-3',
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        runId: secondStart.runId,
        title: 'Session API Relay Test',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    });
    const discoveryStillLiveAfterNewFirstMissing = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_CLOSE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      discoveryStillLiveAfterNewFirstMissing.body?.activeRunId,
      discoveryCloseStarted.body?.runId,
      'the stale overlapping snapshot must not count after current-run presence is confirmed'
    );
    await delay(5);
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'discovery-close-missing-4',
      sessions: [{
        sessionId: SESSION_ID,
        nativeThreadId: SESSION_ID,
        runId: secondStart.runId,
        title: 'Session API Relay Test',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    });
    const discoveryClosedRuntime = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_CLOSE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(discoveryClosedRuntime.statusCode, 200, JSON.stringify(discoveryClosedRuntime.body));
    assert.strictEqual(
      discoveryClosedRuntime.body?.activeRunId,
      null,
      'discovery timeout closure must durably stop the active run'
    );
    assert.strictEqual(discoveryClosedRuntime.body?.runStatus, 'stopped');

    const forked = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      launchMode: 'fork',
      sourceSessionId: SESSION_ID,
      apiConfig: PROFILE_B,
      model: MODEL_B,
    });
    assert.strictEqual(forked.statusCode, 200, JSON.stringify(forked.body));
    assert.notStrictEqual(forked.body?.sessionId, SESSION_ID, 'fork must allocate its own bridge identity');
    const forkStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start' && command.runId === forked.body?.runId
    ));
    assert.strictEqual(forkStart.launchMode, 'fork');
    assert.strictEqual(forkStart.nativeThreadId, SESSION_ID);
    const forkRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === forked.body?.runId && body?.provenance?.sourceSessionId === SESSION_ID,
      5000,
      forked.body.sessionId
    );
    assert.strictEqual(forkRuntime.body?.sessionBinding?.profileId, PROFILE_B.profileId);
    const renamedFork = await requestJson(port, 'PATCH', `/api/sessions/${forked.body.sessionId}/title`, {
      hostId: HOST_ID,
      title: 'Renamed fork only',
    });
    assert.strictEqual(renamedFork.statusCode, 200, JSON.stringify(renamedFork.body));
    const renamedForkRuntime = await requestJson(
      port,
      'GET',
      `/api/sessions/${forked.body.sessionId}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(renamedForkRuntime.body?.provenance?.title, 'Renamed fork only');
    const sourceAfterFork = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      sourceAfterFork.body?.effectiveSelection?.effort,
      'max',
      `fork must not replace the source run: ${JSON.stringify(sourceAfterFork.body)}`
    );
    assert.strictEqual(
      sourceAfterFork.body?.provenance?.title,
      'Session API Relay Test',
      'renaming a fork must not overwrite the source Session presentation'
    );

    fakeHost.failNextStartCode = 'session_native_resume_failed';
    const failedResume = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/rebind`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_A,
      model: MODEL_A,
      expectedRunId: sourceAfterFork.body?.runId,
      expectedRunStatus: sourceAfterFork.body?.runStatus,
      expectedBindingFingerprint: sourceAfterFork.body?.sessionBinding?.bindingFingerprint,
    });
    assert.strictEqual(failedResume.statusCode, 200, JSON.stringify(failedResume.body));
    await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start' && command.runId === failedResume.body?.runId
    ));
    const preservedRuntime = await waitForRuntime(
      port,
      (body) => body?.pendingRun == null && body?.sessionBinding?.profileId === PROFILE_B.profileId
    );
    assert.strictEqual(preservedRuntime.body?.effectiveSelection?.effort, 'max');
    const preservedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(preservedDetail.statusCode, 200, JSON.stringify(preservedDetail.body));
    assert((preservedDetail.body?.transcript || []).length >= 2, 'failed native resume must retain prior transcript');
    assert.strictEqual(
      fakeHost.commands.some((command) => command.launchMode === 'transcript_fallback'),
      false,
      'native resume failure must not queue an implicit transcript fallback'
    );

    fakeHost.holdNextStart = true;
    const explicitFallback = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/transcript-fallback`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_B,
      model: MODEL_B,
      expectedRunId: preservedRuntime.body?.runId,
      expectedRunStatus: preservedRuntime.body?.runStatus,
      expectedBindingFingerprint: preservedRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    assert.strictEqual(explicitFallback.statusCode, 200, JSON.stringify(explicitFallback.body));
    const fallbackStart = await waitForHeldStart(fakeHost, explicitFallback.body?.runId);
    const duplicateFallback = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/transcript-fallback`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_B,
      model: MODEL_B,
      expectedRunId: preservedRuntime.body?.runId,
      expectedRunStatus: preservedRuntime.body?.runStatus,
      expectedBindingFingerprint: preservedRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    assertContractError(duplicateFallback, 409, 'session_run_pending');
    assert.strictEqual(fallbackStart.launchMode, 'transcript_fallback');
    assert(fallbackStart.resumeTranscript.length >= 2, 'explicit fallback must carry bounded saved history');
    assert.strictEqual(fallbackStart.sourceSessionId, SESSION_ID);
    await fakeHost.releaseHeldStart(explicitFallback.body?.runId);

    const emptyHistoryId = 'empty-history-session';
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: emptyHistoryId,
        title: 'Empty history',
        cwd: ROOT,
        source: 'vscode',
        live: false,
        transcriptPreview: [],
      }],
    });
    await delay(5);
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: emptyHistoryId,
        title: 'Empty history',
        cwd: ROOT,
        source: 'vscode',
        live: false,
        transcriptPreview: [],
      }],
    });
    const walPath = path.join(tempRoot, 'session-record-store', 'wal-current.jsonl');
    const walRevisionCount = () => fs.readFileSync(walPath, 'utf8').split(/\r?\n/).filter(Boolean).length;
    const revisionsBeforeRepeatedDiscovery = walRevisionCount();
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      sessions: [{
        sessionId: emptyHistoryId,
        title: 'Empty history',
        cwd: ROOT,
        source: 'vscode',
        live: false,
        transcriptPreview: [],
      }],
    });
    assert.strictEqual(
      walRevisionCount(),
      revisionsBeforeRepeatedDiscovery,
      'unchanged discovery polling must not fsync another provenance transaction'
    );
    const fallback = await requestJson(port, 'POST', `/api/sessions/${emptyHistoryId}/transcript-fallback`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_A,
    });
    assertContractError(fallback, 422, 'session_history_unavailable');

    const pendingDerivedSessionIds = [];
    let delayedRestartStartCommand = null;
    const assertPendingDerivedLaunchIsolation = async (sourceSessionId, launchMode) => {
      const sourceStarted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
        sessionId: sourceSessionId,
        cwd: ROOT,
        label: `${launchMode} pending alias source`,
        apiConfig: PROFILE_A,
        model: MODEL_A,
      });
      assert.strictEqual(sourceStarted.statusCode, 200, JSON.stringify(sourceStarted.body));
      const sourceStartCommand = await waitForCommand(fakeHost, (command) => (
        command.type === 'session.start' && command.runId === sourceStarted.body?.runId
      ));
      await waitForRuntime(
        port,
        (body) => body?.runId === sourceStartCommand.runId && body?.runStatus === 'live',
        5000,
        sourceSessionId
      );
      const sourceDetailBeforeModels = await requestJson(
        port,
        'GET',
        `/api/sessions/${sourceSessionId}/detail?hostId=${HOST_ID}`
      );
      assert.strictEqual(sourceDetailBeforeModels.statusCode, 200, JSON.stringify(sourceDetailBeforeModels.body));
      assert.strictEqual(
        sourceDetailBeforeModels.body?.session?.runId,
        sourceStartCommand.runId,
        'the source projection must stay attached to the canonically live run while started rendering catches up'
      );
      const sourceModels = await requestJson(
        port,
        'GET',
        `/api/sessions/${sourceSessionId}/models?hostId=${HOST_ID}`
      );
      assert.strictEqual(sourceModels.statusCode, 200, JSON.stringify(sourceModels.body));
      const sourceModel = sourceModels.body?.models?.find((model) => model.id === MODEL_A);
      assert(sourceModel, `source model catalog must include ${MODEL_A}: ${JSON.stringify(sourceModels.body)}`);
      assert(
        sourceModel.reasoningLevels?.includes('high'),
        `canonically live source catalog must include live reasoning capabilities: ${JSON.stringify(sourceModels.body)}`
      );
      const sourceDetailAfterModels = await requestJson(
        port,
        'GET',
        `/api/sessions/${sourceSessionId}/detail?hostId=${HOST_ID}`
      );
      assert.strictEqual(sourceDetailAfterModels.statusCode, 200, JSON.stringify(sourceDetailAfterModels.body));
      assert.strictEqual(
        sourceDetailAfterModels.body?.session?.runId,
        sourceStartCommand.runId,
        'model catalog loading must not detach the source projection from its live run'
      );
      const transcriptMarker = `${launchMode} source transcript remains owned by the source`;
      const sourceInput = await requestJson(port, 'POST', `/api/sessions/${sourceSessionId}/input`, {
        hostId: HOST_ID,
        text: transcriptMarker,
        model: MODEL_A,
        effort: 'high',
      });
      assert.strictEqual(sourceInput.statusCode, 200, JSON.stringify(sourceInput.body));
      await waitForCommand(fakeHost, (command) => command.id === sourceInput.body?.command?.id);

      const sourceRuntimeBeforeDerived = await requestJson(
        port,
        'GET',
        `/api/sessions/${sourceSessionId}/runtime-config?hostId=${HOST_ID}`
      );
      assert.strictEqual(
        sourceRuntimeBeforeDerived.statusCode,
        200,
        JSON.stringify(sourceRuntimeBeforeDerived.body)
      );

      fakeHost.holdNextStart = true;
      const derived = launchMode === 'fork'
        ? await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
          launchMode,
          sourceSessionId,
          apiConfig: PROFILE_A,
          model: MODEL_A,
        })
        : await requestJson(port, 'POST', `/api/sessions/${sourceSessionId}/transcript-fallback`, {
          hostId: HOST_ID,
          apiConfig: PROFILE_A,
          model: MODEL_A,
          expectedRunId: sourceRuntimeBeforeDerived.body?.runId,
          expectedRunStatus: sourceRuntimeBeforeDerived.body?.runStatus,
          expectedBindingFingerprint: sourceRuntimeBeforeDerived.body?.sessionBinding?.bindingFingerprint,
        });
      assert.strictEqual(derived.statusCode, 200, JSON.stringify(derived.body));
      const heldStart = await waitForHeldStart(fakeHost, derived.body.runId);
      assert.strictEqual(heldStart.nativeThreadId, sourceSessionId);
      pendingDerivedSessionIds.push(derived.body.sessionId);
      delayedRestartStartCommand ||= heldStart;

      const sourceDetail = await requestJson(
        port,
        'GET',
        `/api/sessions/${sourceSessionId}/detail?hostId=${HOST_ID}`
      );
      assert.strictEqual(sourceDetail.statusCode, 200, JSON.stringify(sourceDetail.body));
      assert.strictEqual(sourceDetail.body?.session?.sessionId, sourceSessionId);
      assert.strictEqual(sourceDetail.body?.session?.runId, sourceStartCommand.runId);
      assert((sourceDetail.body?.transcript || []).some((entry) => entry.text === transcriptMarker));

      const pendingDetail = await requestJson(
        port,
        'GET',
        `/api/sessions/${derived.body.sessionId}/detail?hostId=${HOST_ID}`
      );
      assert.strictEqual(pendingDetail.statusCode, 200, JSON.stringify(pendingDetail.body));
      assert.strictEqual(pendingDetail.body?.session?.sessionId, derived.body.sessionId);
      assert.notStrictEqual(
        pendingDetail.body?.session?.nativeThreadId,
        sourceSessionId,
        `${launchMode} must not publish the source native ID as a pending target alias`
      );
      assert.strictEqual(
        pendingDetail.body?.session?.apiProfile?.baseUrl,
        'https://profile-a.example/v1?catalog=account',
        'public API profile metadata must preserve normalized endpoint identity query parameters'
      );

      const isolatedInput = await requestJson(port, 'POST', `/api/sessions/${sourceSessionId}/input`, {
        hostId: HOST_ID,
        text: `${launchMode} pending target must not capture source input`,
        model: MODEL_A,
        effort: 'high',
      });
      assert.strictEqual(isolatedInput.statusCode, 200, JSON.stringify(isolatedInput.body));
      const isolatedInputCommand = await waitForCommand(
        fakeHost,
        (command) => command.id === isolatedInput.body?.command?.id
      );
      assert.strictEqual(isolatedInputCommand.sessionId, sourceSessionId);
      assert.strictEqual(isolatedInputCommand.requestedSessionId, sourceSessionId);
      assert.strictEqual(isolatedInputCommand.runId, sourceStartCommand.runId);

      const sourceRuntimeBeforeStop = await requestJson(
        port,
        'GET',
        `/api/sessions/${sourceSessionId}/runtime-config?hostId=${HOST_ID}`
      );
      assert.strictEqual(sourceRuntimeBeforeStop.statusCode, 200, JSON.stringify(sourceRuntimeBeforeStop.body));
      const isolatedStop = await requestJson(port, 'POST', `/api/sessions/${sourceSessionId}/stop`, {
        hostId: HOST_ID,
        expectedRunId: sourceRuntimeBeforeStop.body?.runId,
        expectedRunStatus: sourceRuntimeBeforeStop.body?.runStatus,
        expectedBindingFingerprint: sourceRuntimeBeforeStop.body?.sessionBinding?.bindingFingerprint,
      });
      assert.strictEqual(isolatedStop.statusCode, 200, JSON.stringify(isolatedStop.body));
      assert((isolatedStop.body?.commands || []).length > 0);
      assert((isolatedStop.body?.commands || []).every((command) => (
        command.requestedSessionId === sourceSessionId
        && command.sessionId !== derived.body.sessionId
      )));
      const stoppedRuntime = await waitForRuntime(
        port,
        (body) => body?.activeRunId == null && body?.runStatus === 'stopped',
        5000,
        sourceSessionId
      );
      assert.strictEqual(stoppedRuntime.body?.runId, sourceStartCommand.runId);
    };

    await assertPendingDerivedLaunchIsolation(FORK_ALIAS_SOURCE_SESSION_ID, 'fork');
    await assertPendingDerivedLaunchIsolation(FALLBACK_ALIAS_SOURCE_SESSION_ID, 'transcript_fallback');

    const restartMissingLiveStart = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        sessionId: RESTART_MISSING_LIVE_SESSION_ID,
        cwd: ROOT,
        label: 'Runner missing after Relay restart',
        apiConfig: PROFILE_A,
        model: MODEL_A,
      }
    );
    assert.strictEqual(restartMissingLiveStart.statusCode, 200, JSON.stringify(restartMissingLiveStart.body));
    const restartMissingLiveRuntime = await waitForRuntime(
      port,
      (body) => body?.activeRunId === restartMissingLiveStart.body?.runId && body?.runStatus === 'live',
      5000,
      RESTART_MISSING_LIVE_SESSION_ID
    );
    const restartLiveReplacementStart = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        sessionId: RESTART_LIVE_REPLACEMENT_SESSION_ID,
        cwd: ROOT,
        label: 'Live replacement after Relay restart',
        apiConfig: PROFILE_A,
        model: MODEL_A,
      }
    );
    assert.strictEqual(
      restartLiveReplacementStart.statusCode,
      200,
      JSON.stringify(restartLiveReplacementStart.body)
    );
    await waitForRuntime(
      port,
      (body) => body?.activeRunId === restartLiveReplacementStart.body?.runId
        && body?.runStatus === 'live',
      5000,
      RESTART_LIVE_REPLACEMENT_SESSION_ID
    );
    fakeHost.holdNextStop = true;
    const interruptedStop = await requestJson(
      port,
      'POST',
      `/api/sessions/${RESTART_MISSING_LIVE_SESSION_ID}/stop`,
      {
        hostId: HOST_ID,
        expectedRunId: restartMissingLiveRuntime.body?.runId,
        expectedRunStatus: restartMissingLiveRuntime.body?.runStatus,
        expectedBindingFingerprint: restartMissingLiveRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(interruptedStop.statusCode, 200, JSON.stringify(interruptedStop.body));
    await waitForRuntime(
      port,
      (body) => body?.runStatus === 'stopping',
      5000,
      RESTART_MISSING_LIVE_SESSION_ID
    );

    await fakeHost.stop();
    fakeHost = null;
    await stopChild(relay);

    relay = spawnRelay(port, tempRoot, output);
    await waitForRelay(port, relay);
    await registerHost(port);
    fakeHost = new FakeHost(port);
    fakeHost.start();
    const recovered = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(recovered.statusCode, 200, JSON.stringify(recovered.body));
    assert.strictEqual(recovered.body?.sessionBinding?.profileId, PROFILE_B.profileId);
    assert.strictEqual(recovered.body?.effectiveSelection?.model, MODEL_B);
    const recoveredInterruptedStop = await requestJson(
      port,
      'GET',
      `/api/sessions/${RESTART_MISSING_LIVE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(recoveredInterruptedStop.statusCode, 200, JSON.stringify(recoveredInterruptedStop.body));
    assert.strictEqual(
      recoveredInterruptedStop.body?.runStatus,
      'live',
      'Relay restart must clear an unconfirmed durable Stop intent so Host discovery can recover the real runner state'
    );
    const hydratedLiveReplacement = await requestJson(
      port,
      'GET',
      `/api/sessions/${RESTART_LIVE_REPLACEMENT_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(hydratedLiveReplacement.statusCode, 200, JSON.stringify(hydratedLiveReplacement.body));
    assert.strictEqual(
      hydratedLiveReplacement.body?.session?.live,
      false,
      'the restart fixture must exercise a durable live run with a history-only UI projection'
    );
    const replacementResume = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        launchMode: 'resume',
        sourceSessionId: RESTART_LIVE_REPLACEMENT_SESSION_ID,
        apiConfig: PROFILE_A,
      }
    );
    assert.strictEqual(replacementResume.statusCode, 200, JSON.stringify(replacementResume.body));
    const durableParentStop = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.stop'
      && command.runId === restartLiveReplacementStart.body?.runId
    ));
    const replacementStartCommand = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start'
      && command.runId === replacementResume.body?.runId
    ));
    assert.strictEqual(durableParentStop.requestedSessionId, RESTART_LIVE_REPLACEMENT_SESSION_ID);
    assert(
      Number(durableParentStop.id) < Number(replacementStartCommand.id),
      'the durable live parent must receive Stop before its replacement Start is queued'
    );
    assert(
      fakeHost.commands.indexOf(durableParentStop) < fakeHost.commands.indexOf(replacementStartCommand),
      'command delivery must stop the durable live parent before starting its replacement'
    );
    for (const pendingSessionId of pendingDerivedSessionIds) {
      const reconciled = await requestJson(
        port,
        'GET',
        `/api/sessions/${pendingSessionId}/runtime-config?hostId=${HOST_ID}`
      );
      assert.strictEqual(reconciled.statusCode, 200, JSON.stringify(reconciled.body));
      assert.strictEqual(
        reconciled.body?.activeRunId,
        null,
        'Relay restart must reconcile a durable pending launch'
      );
      assert.strictEqual(reconciled.body?.pendingRun, null);
    }

    assert(delayedRestartStartCommand, 'test fixture must retain a delayed start event');
    const delayedSessionId = ['fork', 'transcript_fallback'].includes(delayedRestartStartCommand.launchMode)
      ? `${delayedRestartStartCommand.sessionId}-native`
      : delayedRestartStartCommand.nativeThreadId || delayedRestartStartCommand.sessionId;
    const delayedStarted = await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.started',
        hostId: HOST_ID,
        sessionId: delayedSessionId,
        bridgeSessionId: delayedSessionId === delayedRestartStartCommand.sessionId
          ? null
          : delayedRestartStartCommand.bridgeSessionId || delayedRestartStartCommand.sessionId,
        nativeThreadId: delayedSessionId,
        runId: delayedRestartStartCommand.runId,
        title: delayedRestartStartCommand.label,
        cwd: delayedRestartStartCommand.cwd,
        source: 'managed',
        launchMode: delayedRestartStartCommand.launchMode,
        originSessionId: delayedRestartStartCommand.originSessionId || null,
        sourceSessionId: delayedRestartStartCommand.sourceSessionId || null,
        conversationKey: delayedRestartStartCommand.conversationKey,
        effectiveBinding: delayedRestartStartCommand.expectedBinding,
      },
    });
    assert.strictEqual(delayedStarted.statusCode, 200, JSON.stringify(delayedStarted.body));
    const afterDelayedRestartStarted = await requestJson(
      port,
      'GET',
      `/api/sessions/${delayedRestartStartCommand.sessionId}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(afterDelayedRestartStarted.statusCode, 200, JSON.stringify(afterDelayedRestartStarted.body));
    assert.strictEqual(
      afterDelayedRestartStarted.body?.activeRunId,
      null,
      'a delayed started event must not revive a run failed during Relay startup reconciliation'
    );
    assert.strictEqual(afterDelayedRestartStarted.body?.pendingRun, null);

    const emptyDiscovery = await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.discovery',
        hostId: HOST_ID,
        sessions: [],
      },
    });
    assert.strictEqual(emptyDiscovery.statusCode, 200, JSON.stringify(emptyDiscovery.body));
    const durableRunAfterFirstMissing = await requestJson(
      port,
      'GET',
      `/api/sessions/${RESTART_MISSING_LIVE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.notStrictEqual(
      durableRunAfterFirstMissing.body?.activeRunId,
      null,
      'one missing discovery snapshot must preserve a durable live run'
    );
    await delay(5);
    const confirmedEmptyDiscovery = await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.discovery',
        hostId: HOST_ID,
        sessions: [],
      },
    });
    assert.strictEqual(
      confirmedEmptyDiscovery.statusCode,
      200,
      JSON.stringify(confirmedEmptyDiscovery.body)
    );
    const closedMissingDurableRun = await requestJson(
      port,
      'GET',
      `/api/sessions/${RESTART_MISSING_LIVE_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      closedMissingDurableRun.body?.activeRunId,
      null,
      'authoritative discovery must close a durable live run even after its in-memory projection was rehydrated as history-only'
    );
    assert.strictEqual(closedMissingDurableRun.body?.runStatus, 'stopped');

    const storeText = fs.readdirSync(path.join(tempRoot, 'session-record-store'))
      .filter((name) => /\.(?:json|jsonl)$/i.test(name))
      .map((name) => fs.readFileSync(path.join(tempRoot, 'session-record-store', name), 'utf8'))
      .join('\n');
    assert.strictEqual(storeText.includes(PROFILE_A.apiKey), false, 'profile A secret leaked into Session store');
    assert.strictEqual(storeText.includes(PROFILE_B.apiKey), false, 'profile B secret leaked into Session store');
    assert.strictEqual(
      storeText.includes('stale-discovery-assistant-cursor'),
      false,
      'stale discovery must not durably ingest assistant cursor state'
    );
    const diagnosticsText = fs.readFileSync(path.join(tempRoot, 'session-diagnostics.json'), 'utf8');
    assert.strictEqual(diagnosticsText.includes(HISTORICAL_DIAGNOSTIC_SECRET), false);
    assert.strictEqual(diagnosticsText.includes(LIVE_DIAGNOSTIC_SECRET), false);

    console.log('session API Relay integration assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    if (fakeHost) await fakeHost.stop().catch(() => {});
    await stopChild(relay);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
