const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { makeHostEnvironmentBinding, makeProfileBinding } = require('../shared/api-binding');
const { SessionRecordStore } = require('../apps/relay/session-record-store');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'session-api-relay-host';
const SESSION_ID = 'session-api-relay-session';
const EMPTY_REBIND_SESSION_ID = 'session-api-empty-rebind-session';
const LATE_READY_REBIND_SESSION_ID = 'session-api-late-ready-rebind-session';
const LEGACY_READINESS_SESSION_ID = 'session-api-legacy-readiness-session';
const LEGACY_CANONICAL_BINDING_SESSION_ID = 'legacy-openai-canonical-binding-session';
const LEGACY_CANONICAL_BINDING_RUN_ID = 'legacy-openai-canonical-binding-run';
const MODEL_A = 'account-model-a';
const MODEL_B = 'account-model-b';
const OPENAI_UNKNOWN_MODEL = 'account-openai-unknown-capability';
const ROTATED_ACCOUNT_MODEL = 'rotated-account-only-model';
const STATIC_OPENAI_MODEL = 'gpt-5.6-sol';
const RUNTIME_OPENAI_MODEL = 'gpt-5.4';
const HOST_ENV_SESSION_ID = 'host-environment-static-effort-session';
const HOST_ENV_BINDING = makeHostEnvironmentBinding({
  provider: 'OpenAI',
  modelProviderHint: 'openai',
  baseUrl: 'https://host-environment.example/v1',
});
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
const PROFILE_VALIDATE = {
  profileId: 'profile-validate',
  label: 'Profile Validate',
  provider: 'Custom',
  providerKind: 'custom',
  baseUrl: 'https://profile-validate.example/v1',
  apiKey: 'profile-validate-secret-must-not-persist',
};
const LEGACY_OPENAI_KEY_ONLY_BINDING = {
  kind: 'profile',
  profileId: 'legacy-openai-key-only',
  label: 'Legacy OpenAI key-only',
  provider: 'OpenAI',
  providerKind: null,
  normalizedBaseUrl: null,
  bindingFingerprint: 'persisted-pre-canonicalization-fingerprint',
};
const MODEL_VALIDATE = 'account-model-validate';
assert.strictEqual(
  makeProfileBinding({ ...PROFILE_A, providerKind: 'openai' }).bindingFingerprint,
  makeProfileBinding({ ...PROFILE_A, providerKind: 'custom' }).bindingFingerprint,
  'providerKind is capability metadata and must not alter the API binding fingerprint'
);
assert.strictEqual(
  makeProfileBinding({ ...PROFILE_A, providerKind: 'custom' }).providerKind,
  'custom',
  'providerKind must survive as secret-free run metadata even though it is not fingerprinted'
);
const LEGACY_MANUAL_SESSION_ID = 'legacy-manual-title-session';
const LEGACY_INFERRED_SESSION_ID = 'legacy-inferred-title-session';
const CANONICAL_TITLE_SESSION_ID = 'canonical-title-session';
const MODERN_UNATTESTED_SESSION_ID = 'modern-unattested-session';
const MODERN_UNATTESTED_DISCOVERY_SESSION_ID = 'modern-unattested-discovery-session';
const DISCOVERY_PRESENCE_HOST_ID = 'discovery-presence-host';
const DISCOVERY_EXACT_PRESENCE_SESSION_ID = 'discovery-exact-presence-session';
const DISCOVERY_DIFFERENT_RUN_SESSION_ID = 'discovery-different-run-session';
const DISCOVERY_RUNLESS_PRESENCE_SESSION_ID = 'discovery-runless-presence-session';
const OWNERSHIP_COLLISION_SESSION_ID = 'ownership-collision-session';
const DISCOVERY_CLOSE_SESSION_ID = 'discovery-close-session';
const FORK_ALIAS_SOURCE_SESSION_ID = 'fork-alias-source-session';
const FALLBACK_ALIAS_SOURCE_SESSION_ID = 'fallback-alias-source-session';
const RESTART_MISSING_LIVE_SESSION_ID = 'restart-missing-live-session';
const RESTART_LIVE_REPLACEMENT_SESSION_ID = 'restart-live-replacement-session';
const REUSED_BRIDGE_SESSION_ID = 'reused-bridge-session';
const REUSED_BRIDGE_CONVERSATION_KEY = 'reused-bridge-conversation';
const REUSED_BRIDGE_FIRST_NATIVE_ID = 'reused-bridge-first-native';
const REUSED_BRIDGE_SECOND_NATIVE_ID = 'reused-bridge-second-native';
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

    const legacyBindingKey = tx.resolveCanonicalKey({
      hostId: HOST_ID,
      sessionId: LEGACY_CANONICAL_BINDING_SESSION_ID,
    });
    const legacyBindingRecord = tx.ensureRecord(legacyBindingKey, {
      hostId: HOST_ID,
      conversationKey: LEGACY_CANONICAL_BINDING_SESSION_ID,
      source: 'managed',
    });
    legacyBindingRecord.title = 'Legacy OpenAI canonical binding';
    legacyBindingRecord.cwd = ROOT;
    legacyBindingRecord.runs[LEGACY_CANONICAL_BINDING_RUN_ID] = {
      status: 'stopped',
      launchMode: 'fresh',
      parentRunId: null,
      nativeResumeReady: true,
      apiBinding: structuredClone(LEGACY_OPENAI_KEY_ONLY_BINDING),
      requestedSelection: null,
      effectiveSelection: null,
      createdAt: '2026-07-15T00:00:00.000Z',
      endedAt: '2026-07-15T00:01:00.000Z',
    };
    legacyBindingRecord.latestSuccessfulRunId = LEGACY_CANONICAL_BINDING_RUN_ID;
    legacyBindingRecord.activeRunId = null;
    legacyBindingRecord.updatedAt = '2026-07-16T00:00:00.000Z';
    tx.setAlias(`${HOST_ID}::${LEGACY_CANONICAL_BINDING_SESSION_ID}`, legacyBindingKey);
    tx.markDirty(legacyBindingKey);
  });
  await store.close();
}

async function registerHost(port, options = {}) {
  const runApiBinding = options.runApiBinding !== false;
  const nativeResumeReadiness = options.nativeResumeReadiness !== false && runApiBinding;
  const hostId = options.hostId || HOST_ID;
  const response = await requestJson(port, 'POST', '/api/agent/register', {
    hostId,
    label: options.label || 'Session API Relay Host',
    platform: process.platform,
    capabilities: {
      apiCatalog: true,
      apiTest: true,
      bindingPreflight: true,
      runApiBinding,
      nativeResumeReadiness,
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
    this.failNextApiCatalogError = null;
    this.holdNextStop = false;
    this.nativeReadySessionIds = new Set();
    this.holdNextInput = false;
    this.heldInputs = new Map();
    this.nextStartedSessionId = null;
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
    if (profileId === PROFILE_VALIDATE.profileId) return [MODEL_VALIDATE];
    if (command.apiConfig?.apiKey === 'profile-a-rotated-secret') {
      return [MODEL_A, ROTATED_ACCOUNT_MODEL];
    }
    return [MODEL_A, OPENAI_UNKNOWN_MODEL, STATIC_OPENAI_MODEL, RUNTIME_OPENAI_MODEL];
  }

  async handle(command) {
    if (command.type === 'host.api_test') {
      if (command.apiConfig?.profileId === 'diagnostic-suggestion') {
        await this.postEvent({
          type: 'host.api_tested',
          hostId: HOST_ID,
          requestId: command.requestId,
          result: {
            ok: false,
            reachable: true,
            catalogValid: false,
            statusCode: 200,
            error: 'The configured endpoint did not return a model catalog.',
            suggestedBaseUrl: 'https://diagnostic.example/v1',
            suggestionReason: 'validated_v1_models',
          },
        });
        return;
      }
      await this.postEvent({
        type: 'host.api_tested',
        hostId: HOST_ID,
        requestId: command.requestId,
        result: {
          ok: true,
          reachable: true,
          catalogValid: true,
          statusCode: 200,
          modelPage: {
            authority: 'authoritative',
            complete: true,
            truncated: false,
            nextCursor: null,
            models: [{ id: command.cursor ? 'profile-page-two' : 'profile-page-one' }],
          },
        },
      });
      return;
    }

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
        binding: command.expectedBinding || HOST_ENV_BINDING,
      });
      return;
    }

    if (command.type === 'session.model_list') {
      const activeStart = [...this.commands].reverse().find((entry) => entry.type === 'session.start');
      const activeProfileId = activeStart?.apiConfig?.profileId;
      const models = activeProfileId === PROFILE_B.profileId
        ? [{
          id: MODEL_B,
          displayName: MODEL_B,
          isDefault: true,
          reasoningLevels: ['low', 'high', 'max', 'ultra'],
          defaultReasoningEffort: 'high',
        }]
        : activeProfileId === PROFILE_VALIDATE.profileId
          ? [{
            id: MODEL_VALIDATE,
            displayName: MODEL_VALIDATE,
            isDefault: true,
          }]
        : [{
          id: MODEL_A,
          displayName: MODEL_A,
          isDefault: true,
          reasoningLevels: ['low', 'high', 'max', 'ultra'],
          defaultReasoningEffort: 'high',
        }, {
          id: OPENAI_UNKNOWN_MODEL,
          displayName: OPENAI_UNKNOWN_MODEL,
          isDefault: false,
        }, {
          id: STATIC_OPENAI_MODEL,
          displayName: STATIC_OPENAI_MODEL,
          isDefault: false,
        }, {
          id: RUNTIME_OPENAI_MODEL,
          displayName: RUNTIME_OPENAI_MODEL,
          isDefault: false,
          reasoningLevels: ['low', 'high'],
          defaultReasoningEffort: 'high',
        }];
      await this.postEvent({
        type: 'session.model_listed',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId,
        models,
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
      assert.strictEqual(
        command.expectedBinding.bindingFingerprint,
        command.apiConfig
          ? makeProfileBinding(command.apiConfig).bindingFingerprint
          : HOST_ENV_BINDING.bindingFingerprint
      );
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
      if (this.holdNextInput) {
        this.holdNextInput = false;
        this.heldInputs.set(command.id, command);
        return;
      }
      await this.announceInput(command);
    }
  }

  async announceInput(command) {
    this.nativeReadySessionIds.add(command.sessionId);
    await this.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      runId: command.runId,
      patch: { nativeResumeReady: true },
    });
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

  async announceStarted(command) {
      const actualLaunchMode = (
        command.launchMode === 'fresh_rebind'
        && command.explicitRebind === true
        && command.rebindNativeThreadId
        && this.nativeReadySessionIds.has(command.rebindNativeThreadId)
      ) ? 'resume' : command.launchMode;
      const announcedSessionId = this.nextStartedSessionId || (
        ['fork', 'transcript_fallback', 'fresh_rebind'].includes(actualLaunchMode)
          ? `${command.sessionId}-native`
          : command.nativeThreadId || command.rebindNativeThreadId || command.sessionId
      );
      this.nextStartedSessionId = null;
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
        launchMode: actualLaunchMode,
        originSessionId: command.originSessionId || null,
        sourceSessionId: command.sourceSessionId || null,
        conversationKey: command.conversationKey,
        effectiveBinding: command.expectedBinding,
        runtime: {
          adapterId: 'codex-app-server',
          runId: command.runId,
          launchMode: actualLaunchMode,
          nativeResumeReady: actualLaunchMode === 'resume',
        },
      });
  }

  async announceApiCatalog(command) {
    if (this.failNextApiCatalogError) {
      const error = this.failNextApiCatalogError;
      this.failNextApiCatalogError = null;
      await this.postEvent({
        type: 'host.api_cataloged',
        hostId: HOST_ID,
        requestId: command.requestId,
        bindingFingerprint: command.bindingFingerprint,
        runId: command.runId || null,
        result: {
          ok: false,
          statusCode: 401,
          error,
          modelPage: null,
        },
      });
      return;
    }
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

  async releaseHeldInput(commandId) {
    const command = this.heldInputs.get(commandId);
    assert(command, `missing held input ${commandId}`);
    this.heldInputs.delete(commandId);
    await this.announceInput(command);
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

async function waitForHeldInput(fakeHost, commandId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fakeHost.error) throw fakeHost.error;
    const command = fakeHost.heldInputs.get(commandId);
    if (command) return command;
    await delay(20);
  }
  throw new Error(`Timed out waiting for held input ${commandId}`);
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

    fakeHost.nextStartedSessionId = REUSED_BRIDGE_FIRST_NATIVE_ID;
    const firstReusedBridgeStart = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        sessionId: REUSED_BRIDGE_SESSION_ID,
        conversationKey: REUSED_BRIDGE_CONVERSATION_KEY,
        cwd: ROOT,
        label: 'Reused bridge lifecycle',
        apiConfig: PROFILE_A,
        model: MODEL_A,
      }
    );
    assert.strictEqual(
      firstReusedBridgeStart.statusCode,
      200,
      JSON.stringify(firstReusedBridgeStart.body)
    );
    await waitForSessionDetail(
      port,
      REUSED_BRIDGE_SESSION_ID,
      (body) => body?.session?.sessionId === REUSED_BRIDGE_FIRST_NATIVE_ID
        && body?.session?.live === true
    );
    await fakeHost.postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId: REUSED_BRIDGE_FIRST_NATIVE_ID,
      nativeThreadId: REUSED_BRIDGE_FIRST_NATIVE_ID,
      runId: firstReusedBridgeStart.body?.runId,
      state: 'history-only',
      live: false,
    });
    await waitForSessionDetail(
      port,
      REUSED_BRIDGE_SESSION_ID,
      (body) => body?.session?.live === false
    );

    fakeHost.nextStartedSessionId = REUSED_BRIDGE_SECOND_NATIVE_ID;
    const secondReusedBridgeStart = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        sessionId: REUSED_BRIDGE_SESSION_ID,
        conversationKey: REUSED_BRIDGE_CONVERSATION_KEY,
        cwd: ROOT,
        label: 'Reused bridge lifecycle',
        apiConfig: PROFILE_A,
        model: MODEL_A,
      }
    );
    assert.strictEqual(
      secondReusedBridgeStart.statusCode,
      200,
      JSON.stringify(secondReusedBridgeStart.body)
    );
    await waitForSessionDetail(
      port,
      REUSED_BRIDGE_SESSION_ID,
      (body) => body?.session?.sessionId === REUSED_BRIDGE_SECOND_NATIVE_ID
        && body?.session?.runId === secondReusedBridgeStart.body?.runId
        && body?.session?.live === true
    );
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: HOST_ID,
      discoveryId: 'reused-bridge-discovery',
      sessions: [{
        sessionId: REUSED_BRIDGE_FIRST_NATIVE_ID,
        nativeThreadId: REUSED_BRIDGE_FIRST_NATIVE_ID,
        conversationKey: REUSED_BRIDGE_CONVERSATION_KEY,
        title: 'Reused bridge lifecycle',
        cwd: ROOT,
        source: 'rollout',
        live: false,
        transcriptPreview: [],
      }, {
        sessionId: REUSED_BRIDGE_SECOND_NATIVE_ID,
        bridgeSessionId: REUSED_BRIDGE_SESSION_ID,
        nativeThreadId: REUSED_BRIDGE_SECOND_NATIVE_ID,
        conversationKey: REUSED_BRIDGE_CONVERSATION_KEY,
        runId: secondReusedBridgeStart.body?.runId,
        title: 'Reused bridge lifecycle',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    });
    const reusedBridgeSessions = await requestJson(
      port,
      'GET',
      `/api/hosts/${HOST_ID}/sessions?full=1`
    );
    assert.strictEqual(reusedBridgeSessions.statusCode, 200);
    const reusedBridgeVariants = (reusedBridgeSessions.body?.sessions || []).filter((session) => (
      session.conversationKey === REUSED_BRIDGE_CONVERSATION_KEY
    ));
    assert.strictEqual(
      reusedBridgeVariants.length,
      1,
      'reusing a bridge after its first native run stops must not retain the old native projection'
    );
    assert.strictEqual(reusedBridgeVariants[0].sessionId, REUSED_BRIDGE_SECOND_NATIVE_ID);
    assert.strictEqual(reusedBridgeVariants[0].runId, secondReusedBridgeStart.body?.runId);
    assert.strictEqual(reusedBridgeVariants[0].live, true);

    const legacyCanonicalRuntime = await requestJson(
      port,
      'GET',
      `/api/sessions/${LEGACY_CANONICAL_BINDING_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(legacyCanonicalRuntime.statusCode, 200, JSON.stringify(legacyCanonicalRuntime.body));
    assert.strictEqual(
      legacyCanonicalRuntime.body?.sessionBinding?.normalizedBaseUrl,
      'https://api.openai.com/v1'
    );
    assert.notStrictEqual(
      legacyCanonicalRuntime.body?.sessionBinding?.bindingFingerprint,
      LEGACY_OPENAI_KEY_ONLY_BINDING.bindingFingerprint
    );
    const legacyCanonicalValidation = await requestJson(
      port,
      'POST',
      `/api/sessions/${LEGACY_CANONICAL_BINDING_SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        expectedRunId: legacyCanonicalRuntime.body?.runId,
        expectedRunStatus: legacyCanonicalRuntime.body?.runStatus,
        expectedBindingFingerprint: legacyCanonicalRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(
      legacyCanonicalValidation.statusCode,
      200,
      `legacy canonical lifecycle expectation failed: ${JSON.stringify(legacyCanonicalValidation.body)}`
    );

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
    const transientAlertMessage = 'temporary provider retry for relay metadata coverage';
    await fakeHost.postEvent({
      type: 'session.alert',
      hostId: HOST_ID,
      sessionId: legacyLiveSessionId,
      runId: 'legacy',
      severity: 'warning',
      source: 'codex',
      message: transientAlertMessage,
      transient: true,
      turnId: 'legacy-retry-turn',
      timestamp: '2026-07-20T00:00:00.000Z',
    });
    const detailWithTransientAlert = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyLiveSessionId}/detail?hostId=${HOST_ID}`
    );
    const propagatedTransientAlert = detailWithTransientAlert.body?.alerts?.find(
      (alert) => alert?.message === transientAlertMessage
    );
    assert.strictEqual(propagatedTransientAlert?.transient, true, 'Relay must preserve transient alert metadata');
    assert.strictEqual(propagatedTransientAlert?.turnId, 'legacy-retry-turn', 'Relay must preserve alert turn identity');
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

    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: legacyLiveSessionId,
      runId: 'legacy',
      patch: {
        phase: 'working',
        connection: 'ready',
        busy: true,
        activeTurnId: 'legacy-turn-before-stop',
        currentTurnStatus: 'inProgress',
        pendingInputSummary: 'legacy input must survive Stop rollback',
        queuedCommandId: 'legacy-queued-command',
        customRuntimeField: 'legacy-runtime-snapshot',
        runId: 'legacy',
      },
    });
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
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: legacyLiveSessionId,
      runId: 'legacy',
      patch: {
        phase: 'thinking',
        connection: 'ready',
        busy: true,
        activeTurnId: 'late-legacy-turn',
        currentTurnStatus: 'inProgress',
        reasoningSummary: 'late legacy progress remains visible',
        runId: 'legacy',
      },
    });
    const legacyDetailWhileStopping = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyLiveSessionId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(legacyDetailWhileStopping.body?.runtime?.phase, 'ending');
    assert.strictEqual(legacyDetailWhileStopping.body?.runtime?.connection, 'closing');
    assert.strictEqual(legacyDetailWhileStopping.body?.runtime?.currentTurnStatus, 'stopping');
    assert.strictEqual(
      legacyDetailWhileStopping.body?.runtime?.reasoningSummary,
      'late legacy progress remains visible',
      'legacy Stop fencing must retain non-control runtime progress'
    );
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: legacyLiveSessionId,
      patch: {
        runId: 'foreign-legacy-run',
        phase: 'thinking',
        connection: 'ready',
        busy: true,
        activeTurnId: 'foreign-turn',
        currentTurnStatus: 'inProgress',
      },
    });
    const legacyMismatchedRunDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyLiveSessionId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      legacyMismatchedRunDetail.body?.runtime?.phase,
      'thinking',
      'a runtime patch for a different run must not inherit the pending Stop fence'
    );
    assert.strictEqual(legacyMismatchedRunDetail.body?.runtime?.activeTurnId, 'foreign-turn');
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: legacyLiveSessionId,
      runId: 'legacy',
      patch: {
        phase: 'thinking',
        connection: 'ready',
        busy: true,
        activeTurnId: 'late-legacy-turn-after-mismatch',
        currentTurnStatus: 'inProgress',
        runId: 'legacy',
      },
    });
    const legacyRefencedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${legacyLiveSessionId}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(legacyRefencedDetail.body?.runtime?.phase, 'ending');
    assert.strictEqual(legacyRefencedDetail.body?.runtime?.currentTurnStatus, 'stopping');
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

    await registerHost(port, { nativeResumeReadiness: false });
    const legacyReadinessStart = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: LEGACY_READINESS_SESSION_ID,
      cwd: ROOT,
      label: 'Legacy Readiness Host Compatibility',
      apiConfig: PROFILE_A,
    });
    assert.strictEqual(legacyReadinessStart.statusCode, 200, JSON.stringify(legacyReadinessStart.body));
    const legacyReadinessRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === legacyReadinessStart.body?.runId && body?.runStatus === 'live',
      5000,
      LEGACY_READINESS_SESSION_ID
    );
    assert.strictEqual(
      legacyReadinessRuntime.body?.nativeResumeReady,
      true,
      'a binding-aware Host without readiness capability must retain legacy resumable behavior'
    );
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: LEGACY_READINESS_SESSION_ID,
      runId: legacyReadinessStart.body?.runId,
      patch: {
        activeTurnId: 'legacy-readiness-active-turn',
        busy: true,
        phase: 'thinking',
        currentTurnStatus: 'inProgress',
      },
    });
    await fakeHost.postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId: LEGACY_READINESS_SESSION_ID,
      runId: legacyReadinessStart.body?.runId,
      state: 'history-only',
      live: false,
    });
    const legacyReadinessClosedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${LEGACY_READINESS_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(legacyReadinessClosedDetail.statusCode, 200, JSON.stringify(legacyReadinessClosedDetail.body));
    assert.strictEqual(legacyReadinessClosedDetail.body?.runtime?.phase, 'closed');
    assert.strictEqual(legacyReadinessClosedDetail.body?.runtime?.activeTurnId, null);
    assert.strictEqual(
      legacyReadinessClosedDetail.body?.runtime?.currentTurnStatus,
      'closed',
      'an authoritative live:false event must not preserve an in-progress turn status'
    );
    await registerHost(port);

    const apiTestsBeforeMissingBase = fakeHost.commands.filter(
      (command) => command.type === 'host.api_test'
    ).length;
    const missingCustomBaseUrl = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/api-test`, {
      apiConfig: {
        profileId: 'custom-key-only',
        provider: 'MineMine',
        providerKind: 'custom',
        apiKey: 'must-not-fall-through-to-openai',
      },
    });
    assert.strictEqual(missingCustomBaseUrl.statusCode, 422, JSON.stringify(missingCustomBaseUrl.body));
    assert.strictEqual(missingCustomBaseUrl.body?.code, 'api_base_url_required');
    assert.strictEqual(missingCustomBaseUrl.body?.stage, 'validate-api-profile');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_test').length,
      apiTestsBeforeMissingBase,
      'a non-OpenAI key-only profile must be rejected before the Host can contact a provider'
    );

    const diagnosticSuggestion = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/api-test`, {
      apiConfig: {
        profileId: 'diagnostic-suggestion',
        provider: 'Custom',
        providerKind: 'custom',
        baseUrl: 'https://diagnostic.example',
        apiKey: 'diagnostic-key',
      },
    });
    assert.strictEqual(diagnosticSuggestion.statusCode, 200, JSON.stringify(diagnosticSuggestion.body));
    assert.strictEqual(diagnosticSuggestion.body?.result?.ok, false);
    assert.strictEqual(
      diagnosticSuggestion.body?.result?.suggestedBaseUrl,
      'https://diagnostic.example/v1',
      'a validated diagnostic suggestion must survive Relay transport without becoming an HTTP error'
    );
    assert.strictEqual(
      diagnosticSuggestion.body?.result?.suggestionReason,
      'validated_v1_models'
    );

    const apiTestPage = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/api-test`, {
      apiConfig: PROFILE_A,
      cursor: 'profile-page-one',
      limit: 37,
      includeLimit: true,
    });
    assert.strictEqual(apiTestPage.statusCode, 200, JSON.stringify(apiTestPage.body));
    assert.strictEqual(apiTestPage.body?.result?.modelPage?.models?.[0]?.id, 'profile-page-two');
    const apiTestCommand = [...fakeHost.commands].reverse().find((command) => command.type === 'host.api_test');
    assert(apiTestCommand, 'Profile model request must enqueue host.api_test');
    assert.strictEqual(apiTestCommand.cursor, 'profile-page-one');
    assert.strictEqual(apiTestCommand.limit, 37);
    assert.strictEqual(apiTestCommand.includeLimit, true);

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

    const exactPresenceRunId = 'discovery-exact-presence-run';
    const differentPresenceRunId = 'discovery-different-presence-run';
    const runlessPresenceRunId = 'discovery-runless-presence-run';
    await registerHost(port, {
      hostId: DISCOVERY_PRESENCE_HOST_ID,
      label: 'Discovery physical presence Host',
      runApiBinding: false,
    });
    await fakeHost.postEvent({
      type: 'session.discovery',
      hostId: DISCOVERY_PRESENCE_HOST_ID,
      discoveryId: 'legacy-discovery-physical-presence-seed',
      sessions: [{
        sessionId: DISCOVERY_EXACT_PRESENCE_SESSION_ID,
        nativeThreadId: DISCOVERY_EXACT_PRESENCE_SESSION_ID,
        runId: exactPresenceRunId,
        title: 'Exact physical presence',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }, {
        sessionId: DISCOVERY_DIFFERENT_RUN_SESSION_ID,
        nativeThreadId: DISCOVERY_DIFFERENT_RUN_SESSION_ID,
        runId: differentPresenceRunId,
        title: 'Different run physical presence',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }, {
        sessionId: DISCOVERY_RUNLESS_PRESENCE_SESSION_ID,
        nativeThreadId: DISCOVERY_RUNLESS_PRESENCE_SESSION_ID,
        runId: runlessPresenceRunId,
        title: 'Runless physical presence',
        cwd: ROOT,
        source: 'managed',
        live: true,
        transcriptPreview: [],
      }],
    });
    await registerHost(port, {
      hostId: DISCOVERY_PRESENCE_HOST_ID,
      label: 'Discovery physical presence Host',
    });
    const physicalPresenceSessions = [{
      sessionId: DISCOVERY_EXACT_PRESENCE_SESSION_ID,
      nativeThreadId: DISCOVERY_EXACT_PRESENCE_SESSION_ID,
      runId: exactPresenceRunId,
      title: 'Exact physical presence',
      cwd: ROOT,
      source: 'managed',
      live: true,
      transcriptPreview: [],
    }, {
      sessionId: DISCOVERY_DIFFERENT_RUN_SESSION_ID,
      nativeThreadId: DISCOVERY_DIFFERENT_RUN_SESSION_ID,
      runId: `${differentPresenceRunId}-stale`,
      title: 'Different run physical presence',
      cwd: ROOT,
      source: 'managed',
      live: true,
      transcriptPreview: [],
    }, {
      sessionId: DISCOVERY_RUNLESS_PRESENCE_SESSION_ID,
      nativeThreadId: DISCOVERY_RUNLESS_PRESENCE_SESSION_ID,
      title: 'Runless physical presence',
      cwd: ROOT,
      source: 'managed',
      live: true,
      transcriptPreview: [],
    }];
    for (const discoveryId of ['modern-physical-presence-1', 'modern-physical-presence-2']) {
      await fakeHost.postEvent({
        type: 'session.discovery',
        hostId: DISCOVERY_PRESENCE_HOST_ID,
        discoveryId,
        sessions: physicalPresenceSessions,
      });
      await delay(5);
    }
    const exactPresenceDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_EXACT_PRESENCE_SESSION_ID}/detail?hostId=${DISCOVERY_PRESENCE_HOST_ID}`
    );
    assert.strictEqual(exactPresenceDetail.statusCode, 200, JSON.stringify(exactPresenceDetail.body));
    assert.strictEqual(
      exactPresenceDetail.body?.session?.live,
      true,
      'an exact identity + run discovery must protect the physical runner from stale closure'
    );
    const exactPresenceRuntime = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_EXACT_PRESENCE_SESSION_ID}/runtime-config?hostId=${DISCOVERY_PRESENCE_HOST_ID}`
    );
    assert.strictEqual(exactPresenceRuntime.body?.activeRunId, null);
    assert.strictEqual(
      exactPresenceRuntime.body?.runStatus,
      'stopped',
      'physical presence must not weaken the modern Host binding attestation rule'
    );
    const differentRunDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_DIFFERENT_RUN_SESSION_ID}/detail?hostId=${DISCOVERY_PRESENCE_HOST_ID}`
    );
    assert.strictEqual(differentRunDetail.statusCode, 200, JSON.stringify(differentRunDetail.body));
    assert.strictEqual(
      differentRunDetail.body?.session?.live,
      false,
      'a different run on the same Session identity must not protect the projected run'
    );
    const runlessPresenceDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_RUNLESS_PRESENCE_SESSION_ID}/detail?hostId=${DISCOVERY_PRESENCE_HOST_ID}`
    );
    assert.strictEqual(runlessPresenceDetail.statusCode, 200, JSON.stringify(runlessPresenceDetail.body));
    assert.strictEqual(
      runlessPresenceDetail.body?.session?.live,
      false,
      'a modern Host runless discovery must not act as a wildcard presence claim'
    );

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

    const idempotentCreateBody = {
      clientRequestId: 'create-session-intent-1',
      cwd: ROOT,
      label: 'Idempotent Session Create',
      apiConfig: PROFILE_A,
      model: MODEL_A,
    };
    fakeHost.holdNextStart = true;
    const idempotentCreated = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      idempotentCreateBody
    );
    assert.strictEqual(idempotentCreated.statusCode, 200, JSON.stringify(idempotentCreated.body));
    assert.strictEqual(idempotentCreated.body?.idempotentReplay, false);
    const heldIdempotentStart = await waitForHeldStart(fakeHost, idempotentCreated.body?.runId);
    const startCountAfterAcceptedCreate = fakeHost.commands.filter(
      (command) => command.type === 'session.start' && command.runId === idempotentCreated.body?.runId
    ).length;
    const catalogCountAfterAcceptedCreate = fakeHost.commands.filter(
      (command) => command.type === 'session.model_list' || command.type === 'host.api_catalog'
    ).length;

    const pendingCreateReplay = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      idempotentCreateBody
    );
    assert.strictEqual(pendingCreateReplay.statusCode, 200, JSON.stringify(pendingCreateReplay.body));
    assert.strictEqual(pendingCreateReplay.body?.idempotentReplay, true);
    assert.strictEqual(pendingCreateReplay.body?.sessionId, idempotentCreated.body?.sessionId);
    assert.strictEqual(pendingCreateReplay.body?.runId, idempotentCreated.body?.runId);
    assert.strictEqual(
      fakeHost.commands.filter(
        (command) => command.type === 'session.start' && command.runId === idempotentCreated.body?.runId
      ).length,
      startCountAfterAcceptedCreate,
      'a pending create replay must not enqueue a second Host start'
    );
    assert.strictEqual(
      fakeHost.commands.filter(
        (command) => command.type === 'session.model_list' || command.type === 'host.api_catalog'
      ).length,
      catalogCountAfterAcceptedCreate,
      'a pending create replay must not fetch the model catalog again'
    );

    const conflictingCreateReplay = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      { ...idempotentCreateBody, label: 'Changed settings under the same request ID' }
    );
    assertContractError(conflictingCreateReplay, 409, 'session_request_conflict');
    for (const [label, apiConfig] of [
      ['rotated API key', { ...PROFILE_A, apiKey: 'rotated-key-under-same-create-intent' }],
      ['changed Base URL', { ...PROFILE_A, baseUrl: 'https://changed-create.example/v1' }],
      ['changed API profile', PROFILE_B],
    ]) {
      const changedApiReplay = await requestJson(
        port,
        'POST',
        `/api/hosts/${HOST_ID}/sessions/start`,
        { ...idempotentCreateBody, apiConfig }
      );
      assertContractError(
        changedApiReplay,
        409,
        'session_request_conflict',
        `reusing a create intent with a ${label} must fail closed`
      );
    }
    assert.strictEqual(
      fakeHost.commands.filter(
        (command) => command.type === 'session.start' && command.runId === idempotentCreated.body?.runId
      ).length,
      1,
      'a conflicting create replay must not enqueue another Host start'
    );
    assert.strictEqual(
      fakeHost.commands.filter(
        (command) => command.type === 'session.model_list' || command.type === 'host.api_catalog'
      ).length,
      catalogCountAfterAcceptedCreate,
      'conflicting API settings must be rejected before another model catalog request'
    );

    await fakeHost.releaseHeldStart(heldIdempotentStart.runId);
    const idempotentLiveRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === idempotentCreated.body?.runId && body?.runStatus === 'live',
      5000,
      idempotentCreated.body?.sessionId
    );
    const liveCreateReplay = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      idempotentCreateBody
    );
    assert.strictEqual(liveCreateReplay.statusCode, 200, JSON.stringify(liveCreateReplay.body));
    assert.strictEqual(liveCreateReplay.body?.idempotentReplay, true);
    assert.strictEqual(liveCreateReplay.body?.runId, idempotentCreated.body?.runId);
    assert.strictEqual(
      fakeHost.commands.filter(
        (command) => command.type === 'session.start' && command.runId === idempotentCreated.body?.runId
      ).length,
      1,
      'a live create replay must not enqueue another Host start'
    );

    const stopIdempotentCreate = await requestJson(
      port,
      'POST',
      `/api/sessions/${encodeURIComponent(idempotentCreated.body?.sessionId)}/stop`,
      {
        hostId: HOST_ID,
        expectedRunId: idempotentLiveRuntime.body?.runId,
        expectedRunStatus: idempotentLiveRuntime.body?.runStatus,
        expectedBindingFingerprint: idempotentLiveRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(stopIdempotentCreate.statusCode, 200, JSON.stringify(stopIdempotentCreate.body));
    await waitForRuntime(
      port,
      (body) => body?.runId === idempotentCreated.body?.runId && body?.runStatus === 'stopped',
      5000,
      idempotentCreated.body?.sessionId
    );
    const stoppedCreateReplay = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      idempotentCreateBody
    );
    assert.strictEqual(stoppedCreateReplay.statusCode, 200, JSON.stringify(stoppedCreateReplay.body));
    assert.strictEqual(stoppedCreateReplay.body?.idempotentReplay, true);
    assert.strictEqual(stoppedCreateReplay.body?.runId, idempotentCreated.body?.runId);
    assert.strictEqual(
      fakeHost.commands.filter(
        (command) => command.type === 'session.start' && command.runId === idempotentCreated.body?.runId
      ).length,
      1,
      'a stopped create replay must not recreate the accepted Session'
    );

    const emptyStarted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: EMPTY_REBIND_SESSION_ID,
      cwd: ROOT,
      label: 'Empty Session Rebind Test',
      apiConfig: PROFILE_A,
    });
    assert.strictEqual(emptyStarted.statusCode, 200, JSON.stringify(emptyStarted.body));
    const emptyFirstStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start'
      && command.sessionId === EMPTY_REBIND_SESSION_ID
      && command.runId === emptyStarted.body?.runId
    ));
    assert.strictEqual(emptyFirstStart.launchMode, 'fresh');
    const emptyRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === emptyStarted.body?.runId && body?.runStatus === 'live',
      5000,
      EMPTY_REBIND_SESSION_ID
    );
    assert.strictEqual(emptyRuntime.body?.nativeResumeReady, false);
    assert.strictEqual(emptyRuntime.body?.nativeResumeReadyKnown, true);
    const startsBeforeEmptyNativeGuards = fakeHost.commands.filter(
      (command) => command.type === 'session.start'
    ).length;
    const forgedEmptyRebind = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      launchMode: 'fresh_rebind',
      sourceSessionId: EMPTY_REBIND_SESSION_ID,
      explicitRebind: true,
      apiConfig: PROFILE_A,
    });
    assertContractError(forgedEmptyRebind, 409, 'session_run_state_conflict');
    const emptyResume = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      launchMode: 'resume',
      sourceSessionId: EMPTY_REBIND_SESSION_ID,
      apiConfig: PROFILE_A,
    });
    assertContractError(emptyResume, 409, 'session_native_resume_unavailable');
    const emptyFork = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      launchMode: 'fork',
      sourceSessionId: EMPTY_REBIND_SESSION_ID,
      apiConfig: PROFILE_A,
    });
    assertContractError(emptyFork, 409, 'session_native_fork_unavailable');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startsBeforeEmptyNativeGuards,
      'unmaterialized Resume/Fork must fail before a Host start is queued'
    );

    fakeHost.holdNextStart = true;
    const emptyRebound = await requestJson(
      port,
      'POST',
      `/api/sessions/${EMPTY_REBIND_SESSION_ID}/rebind`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_B,
        expectedRunId: emptyRuntime.body?.runId,
        expectedRunStatus: emptyRuntime.body?.runStatus,
        expectedBindingFingerprint: emptyRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(emptyRebound.statusCode, 200, JSON.stringify(emptyRebound.body));
    assert.strictEqual(emptyRebound.body?.launchMode, 'fresh_rebind');
    assert.strictEqual(emptyRebound.body?.nativeThreadId, null);
    assert.strictEqual(emptyRebound.body?.conversationKey, emptyStarted.body?.conversationKey);
    const emptyReplacementStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start' && command.runId === emptyRebound.body?.runId
    ));
    await waitForHeldStart(fakeHost, emptyRebound.body?.runId);
    assert.strictEqual(emptyReplacementStart.launchMode, 'fresh_rebind');
    assert.strictEqual(emptyReplacementStart.nativeThreadId, null);
    assert.strictEqual(emptyReplacementStart.rebindNativeThreadId, EMPTY_REBIND_SESSION_ID);
    assert.strictEqual(emptyReplacementStart.explicitRebind, true);
    assert.deepStrictEqual(emptyReplacementStart.resumeTranscript, []);
    assert.strictEqual(emptyReplacementStart.sourceSessionId, EMPTY_REBIND_SESSION_ID);
    assert.strictEqual(emptyReplacementStart.conversationKey, emptyFirstStart.conversationKey);
    const emptyPendingDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${EMPTY_REBIND_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(emptyPendingDetail.statusCode, 200, JSON.stringify(emptyPendingDetail.body));
    assert.strictEqual(
      emptyPendingDetail.body?.session?.nativeThreadId,
      null,
      'fresh_rebind must not publish a native identity before the replacement thread starts'
    );
    const emptyParentStop = fakeHost.commands.find((command) => (
      command.type === 'session.stop'
      && command.runId === emptyRuntime.body?.runId
      && !command.suppressTerminalEvent
    ));
    assert(emptyParentStop, 'fresh_rebind must stop its unmaterialized parent run');
    assert(
      fakeHost.commands.indexOf(emptyParentStop) < fakeHost.commands.indexOf(emptyReplacementStart),
      'fresh_rebind must preserve parent-before-child command ordering'
    );
    await fakeHost.releaseHeldStart(emptyRebound.body?.runId);
    const emptyReboundRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === emptyRebound.body?.runId && body?.runStatus === 'live',
      5000,
      EMPTY_REBIND_SESSION_ID
    );
    assert.strictEqual(emptyReboundRuntime.body?.nativeResumeReady, false);
    assert.strictEqual(emptyReboundRuntime.body?.nativeResumeReadyKnown, true);
    assert.strictEqual(
      emptyReboundRuntime.body?.canonicalSessionId,
      `${EMPTY_REBIND_SESSION_ID}-native`,
      'fresh_rebind must publish the replacement native identity through the original canonical alias'
    );
    const emptyRuntimeByNewAlias = await requestJson(
      port,
      'GET',
      `/api/sessions/${EMPTY_REBIND_SESSION_ID}-native/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(emptyRuntimeByNewAlias.statusCode, 200, JSON.stringify(emptyRuntimeByNewAlias.body));
    assert.strictEqual(emptyRuntimeByNewAlias.body?.runId, emptyRebound.body?.runId);
    assert.strictEqual(emptyRuntimeByNewAlias.body?.provenance?.conversationKey, emptyFirstStart.conversationKey);

    const duplicateFailureSessionId = 'duplicate-start-failure-alert-session';
    const duplicateFailureStarted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: duplicateFailureSessionId,
      cwd: ROOT,
      label: 'Duplicate start failure alert test',
      apiConfig: PROFILE_A,
    });
    assert.strictEqual(duplicateFailureStarted.statusCode, 200, JSON.stringify(duplicateFailureStarted.body));
    const duplicateFailureLive = await waitForRuntime(
      port,
      (body) => body?.runId === duplicateFailureStarted.body?.runId && body?.runStatus === 'live',
      5000,
      duplicateFailureSessionId
    );
    const duplicateFailureInput = await requestJson(
      port,
      'POST',
      `/api/sessions/${duplicateFailureSessionId}/input`,
      {
        hostId: HOST_ID,
        text: 'materialize native rollout before Stop',
      }
    );
    assert.strictEqual(duplicateFailureInput.statusCode, 200, JSON.stringify(duplicateFailureInput.body));
    await waitForRuntime(
      port,
      (body) => body?.runId === duplicateFailureStarted.body?.runId && body?.nativeResumeReady === true,
      5000,
      duplicateFailureSessionId
    );
    const duplicateFailureStop = await requestJson(
      port,
      'POST',
      `/api/sessions/${duplicateFailureSessionId}/stop`,
      {
        hostId: HOST_ID,
        expectedRunId: duplicateFailureLive.body?.runId,
        expectedRunStatus: duplicateFailureLive.body?.runStatus,
        expectedBindingFingerprint: duplicateFailureLive.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(duplicateFailureStop.statusCode, 200, JSON.stringify(duplicateFailureStop.body));
    await waitForRuntime(
      port,
      (body) => body?.runId === duplicateFailureStarted.body?.runId && body?.runStatus === 'stopped',
      5000,
      duplicateFailureSessionId
    );

    const catalogsBeforeAutoResume = fakeHost.commands.filter((command) => (
      command.type === 'session.model_list' || command.type === 'host.api_catalog'
    )).length;
    fakeHost.failNextStartCode = 'session_native_resume_failed';
    const duplicateFailureResume = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        launchMode: 'resume',
        sourceSessionId: duplicateFailureSessionId,
        apiConfig: PROFILE_A,
      }
    );
    assert.strictEqual(duplicateFailureResume.statusCode, 200, JSON.stringify(duplicateFailureResume.body));
    assert.strictEqual(
      fakeHost.commands.filter((command) => (
        command.type === 'session.model_list' || command.type === 'host.api_catalog'
      )).length,
      catalogsBeforeAutoResume,
      'ordinary Auto/Auto Resume must enqueue without waiting for live/provider catalog requests'
    );
    const structuredFailureMessage = 'fake session_native_resume_failed';
    await waitForSessionDetail(port, duplicateFailureSessionId, (body) => (
      body?.session?.runId === duplicateFailureResume.body?.runId
      && body?.session?.resumeError?.error === structuredFailureMessage
    ));
    await fakeHost.postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: duplicateFailureSessionId,
      runId: duplicateFailureResume.body?.runId,
      message: `failed to spawn managed session: ${structuredFailureMessage}`,
    });
    const duplicateFailureDetail = await waitForSessionDetail(
      port,
      duplicateFailureSessionId,
      (body) => body?.diagnostics?.some((entry) => (
        entry?.method === 'session.error/suppressed-duplicate-start-failure'
      ))
    );
    assert.strictEqual(duplicateFailureDetail.body?.session?.resumeError?.code, 'session_native_resume_failed');
    assert.strictEqual(
      duplicateFailureDetail.body?.alerts?.filter((alert) => (
        String(alert?.message || '').includes(structuredFailureMessage)
      )).length,
      1,
      'one managed start failure must produce one visible alert even when Host also posts session.error'
    );

    const lateReadyStarted = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: LATE_READY_REBIND_SESSION_ID,
      cwd: ROOT,
      label: 'Late Ready Rebind Test',
      apiConfig: PROFILE_A,
    });
    assert.strictEqual(lateReadyStarted.statusCode, 200, JSON.stringify(lateReadyStarted.body));
    const lateReadyRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === lateReadyStarted.body?.runId && body?.runStatus === 'live',
      5000,
      LATE_READY_REBIND_SESSION_ID
    );
    assert.strictEqual(lateReadyRuntime.body?.nativeResumeReady, false);

    fakeHost.holdNextInput = true;
    const lateReadyInput = await requestJson(
      port,
      'POST',
      `/api/sessions/${LATE_READY_REBIND_SESSION_ID}/input`,
      {
        hostId: HOST_ID,
        text: 'first turn finishes after replacement start is queued',
        model: MODEL_A,
        effort: null,
      }
    );
    assert.strictEqual(lateReadyInput.statusCode, 200, JSON.stringify(lateReadyInput.body));
    await waitForHeldInput(fakeHost, lateReadyInput.body?.command?.id);

    fakeHost.holdNextStop = true;
    fakeHost.holdNextStart = true;
    const lateReadyRebound = await requestJson(
      port,
      'POST',
      `/api/sessions/${LATE_READY_REBIND_SESSION_ID}/rebind`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_B,
        expectedRunId: lateReadyRuntime.body?.runId,
        expectedRunStatus: lateReadyRuntime.body?.runStatus,
        expectedBindingFingerprint: lateReadyRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(lateReadyRebound.statusCode, 200, JSON.stringify(lateReadyRebound.body));
    const lateReadyReplacementStart = await waitForHeldStart(fakeHost, lateReadyRebound.body?.runId);
    assert.strictEqual(lateReadyReplacementStart.launchMode, 'fresh_rebind');
    assert.strictEqual(lateReadyReplacementStart.nativeThreadId, null);
    assert.strictEqual(lateReadyReplacementStart.rebindNativeThreadId, LATE_READY_REBIND_SESSION_ID);
    await fakeHost.releaseHeldInput(lateReadyInput.body?.command?.id);

    const lateReadyPendingRuntime = await requestJson(
      port,
      'GET',
      `/api/sessions/${LATE_READY_REBIND_SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(lateReadyPendingRuntime.statusCode, 200, JSON.stringify(lateReadyPendingRuntime.body));
    assert.strictEqual(
      lateReadyPendingRuntime.body?.pendingRun?.launchMode,
      'fresh_rebind',
      'late parent readiness must not mutate an already queued replacement command'
    );
    assert.strictEqual(lateReadyPendingRuntime.body?.pendingRun?.nativeResumeReady, false);
    await fakeHost.postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId: LATE_READY_REBIND_SESSION_ID,
      runId: lateReadyRuntime.body?.runId,
      state: 'history-only',
      live: false,
    });
    await fakeHost.releaseHeldStart(lateReadyRebound.body?.runId);
    const lateReadyReboundRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === lateReadyRebound.body?.runId && body?.runStatus === 'live',
      5000,
      LATE_READY_REBIND_SESSION_ID
    );
    assert.strictEqual(lateReadyReboundRuntime.body?.nativeResumeReady, true);
    const lateReadyDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${LATE_READY_REBIND_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(lateReadyDetail.body?.session?.launchMode, 'resume');
    assert.strictEqual(lateReadyDetail.body?.session?.nativeThreadId, LATE_READY_REBIND_SESSION_ID);

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
      effectiveBinding: firstStart.expectedBinding,
      runtime: {
        adapterId: 'codex-app-server',
        runId: firstStart.runId,
        nativeResumeReady: true,
      },
    });
    const recoveredReadiness = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(recoveredReadiness.statusCode, 200, JSON.stringify(recoveredReadiness.body));
    assert.strictEqual(
      recoveredReadiness.body?.nativeResumeReady,
      true,
      'a replayed started event must recover readiness when its earlier runtime event was lost'
    );

    const duplicateNativeThreadId = `${SESSION_ID}-duplicate-native`;
    const stopCommandsBeforeDuplicateNative = fakeHost.commands.filter(
      (command) => command.type === 'session.stop'
    ).length;
    await fakeHost.postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: duplicateNativeThreadId,
      bridgeSessionId: SESSION_ID,
      nativeThreadId: duplicateNativeThreadId,
      runId: firstStart.runId,
      title: firstStart.label,
      cwd: firstStart.cwd,
      source: 'managed',
      launchMode: firstStart.launchMode,
      conversationKey: firstStart.conversationKey,
      effectiveBinding: firstStart.expectedBinding,
      runtime: {
        adapterId: 'codex-app-server',
        runId: firstStart.runId,
        nativeResumeReady: true,
      },
    });
    const afterDuplicateNativeStarted = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      afterDuplicateNativeStarted.body?.session?.nativeThreadId,
      SESSION_ID,
      'a second native thread must not replace the native owner of an already-live run'
    );
    assert(
      (afterDuplicateNativeStarted.body?.diagnostics || []).some((entry) => (
        entry.method === 'session.started/ignored-duplicate-native'
        && entry.severity === 'info'
        && entry.data?.acceptedNativeThreadId === SESSION_ID
        && entry.data?.ignoredNativeThreadId === duplicateNativeThreadId
      )),
      'the ignored duplicate native start must leave an info diagnostic on the accepted Session'
    );
    const runtimeAfterDuplicateNativeStarted = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(runtimeAfterDuplicateNativeStarted.statusCode, 200);
    assert.strictEqual(
      runtimeAfterDuplicateNativeStarted.body?.runStatus,
      'live',
      'the duplicate native start must not fail or stop the accepted run'
    );
    assert.strictEqual(
      runtimeAfterDuplicateNativeStarted.body?.provenance?.nativeThreadId,
      SESSION_ID,
      'the duplicate start must not rewrite the canonical provenance native thread'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopCommandsBeforeDuplicateNative,
      'the Relay must not enqueue an ambiguous Stop that could terminate the accepted native owner'
    );
    const sessionsAfterDuplicateNativeStarted = await requestJson(
      port,
      'GET',
      `/api/hosts/${HOST_ID}/sessions?full=1`
    );
    assert.strictEqual(sessionsAfterDuplicateNativeStarted.statusCode, 200);
    assert.strictEqual(
      (sessionsAfterDuplicateNativeStarted.body?.sessions || []).some((session) => (
        session.sessionId === duplicateNativeThreadId
        || session.nativeThreadId === duplicateNativeThreadId
      )),
      false,
      'the ignored native thread must not appear as a Session variant'
    );
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      nativeThreadId: SESSION_ID,
      runId: firstStart.runId,
      patch: {
        connection: 'ready',
        phase: 'thinking',
        busy: true,
        activeTurnId: 'accepted-native-turn',
      },
    });
    const acceptedNativeAfterDuplicate = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(acceptedNativeAfterDuplicate.body?.session?.nativeThreadId, SESSION_ID);
    assert.strictEqual(
      acceptedNativeAfterDuplicate.body?.runtime?.activeTurnId,
      'accepted-native-turn',
      'the accepted native thread must continue processing events after a duplicate is ignored'
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
    assert.strictEqual(models.body?.providerKind, 'openai');
    const staticOpenAiModel = models.body?.models?.find((model) => model.id === STATIC_OPENAI_MODEL);
    assert(staticOpenAiModel, JSON.stringify(models.body));
    assert.strictEqual(staticOpenAiModel.capabilitySource, 'override');
    assert.deepStrictEqual(
      staticOpenAiModel.reasoningLevels,
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    );
    assert.strictEqual(staticOpenAiModel.defaultReasoningEffort, 'low');
    const runtimeOpenAiModel = models.body?.models?.find((model) => model.id === RUNTIME_OPENAI_MODEL);
    assert(runtimeOpenAiModel, JSON.stringify(models.body));
    assert.strictEqual(runtimeOpenAiModel.capabilitySource, 'live');
    assert.deepStrictEqual(runtimeOpenAiModel.reasoningLevels, ['low', 'high']);
    assert.strictEqual(
      runtimeOpenAiModel.defaultReasoningEffort,
      'high',
      'live model metadata must override the OpenAI advisory default'
    );

    const runtimeBeforeRotatedKeyPreflight = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    const rotatedKeyPreflight = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: { ...PROFILE_A, apiKey: 'profile-a-rotated-secret' },
        model: MODEL_A,
        effort: 'high',
        expectedRunId: runtimeBeforeRotatedKeyPreflight.body?.runId,
        expectedRunStatus: runtimeBeforeRotatedKeyPreflight.body?.runStatus,
        expectedBindingFingerprint: runtimeBeforeRotatedKeyPreflight.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(rotatedKeyPreflight.statusCode, 200, JSON.stringify(rotatedKeyPreflight.body));
    assert(rotatedKeyPreflight.body?.modelCatalog?.models?.some((model) => model.id === ROTATED_ACCOUNT_MODEL));
    const modelsAfterRotatedKeyPreflight = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/models?hostId=${HOST_ID}`
    );
    assert.strictEqual(modelsAfterRotatedKeyPreflight.statusCode, 200, JSON.stringify(modelsAfterRotatedKeyPreflight.body));
    assert.strictEqual(
      modelsAfterRotatedKeyPreflight.body?.models?.some((model) => model.id === ROTATED_ACCOUNT_MODEL),
      false,
      'Rebind preflight must not overwrite the current live run catalog when only the API key changes'
    );
    assert.strictEqual(
      modelsAfterRotatedKeyPreflight.body?.models?.find((model) => model.id === STATIC_OPENAI_MODEL)?.providerAdvertised,
      staticOpenAiModel.providerAdvertised,
      'the live run must retain its original account availability after a rotated-key preflight'
    );

    const catalogCommandsBeforeRefresh = fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length;
    const liveModelCommandsBeforeRefresh = fakeHost.commands.filter((command) => command.type === 'session.model_list').length;
    const refreshedModels = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/models/refresh`, {
      hostId: HOST_ID,
      apiConfig: { ...PROFILE_A, apiKey: 'profile-a-rotated-secret' },
    });
    assert.strictEqual(refreshedModels.statusCode, 200, JSON.stringify(refreshedModels.body));
    assert(refreshedModels.body?.models?.some((model) => model.id === MODEL_A));
    assert.strictEqual(
      refreshedModels.body?.models?.some((model) => model.id === ROTATED_ACCOUNT_MODEL),
      false,
      'live refresh must not query or persist a newly rotated browser credential'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
      catalogCommandsBeforeRefresh,
      'live refresh must not request provider models with mutable browser credentials'
    );
    assert(
      fakeHost.commands.filter((command) => command.type === 'session.model_list').length > liveModelCommandsBeforeRefresh,
      'live refresh must request model metadata from the current app-server'
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

    const staticEffortInput = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'bound OpenAI input using advisory effort metadata',
      model: STATIC_OPENAI_MODEL,
      effort: 'ultra',
    });
    assert.strictEqual(staticEffortInput.statusCode, 200, JSON.stringify(staticEffortInput.body));
    const staticEffortCommand = await waitForCommand(
      fakeHost,
      (command) => command.id === staticEffortInput.body?.command?.id
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(staticEffortCommand, 'apiConfig'),
      false,
      'live input must derive providerKind from its bound run without resending API credentials'
    );
    assert.strictEqual(staticEffortCommand.model, STATIC_OPENAI_MODEL);
    assert.strictEqual(staticEffortCommand.effort, 'ultra');

    const openAiUnknownEffort = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'OpenAI unknown effort must stay blocked',
      model: OPENAI_UNKNOWN_MODEL,
      effort: 'vendor_max',
      allowUnverifiedEffort: true,
    });
    assertContractError(openAiUnknownEffort, 409, 'session_effort_unsupported');

    const spoofedProviderPolicy = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'provider policy spoof must be rejected',
      apiConfig: { ...PROFILE_A, providerKind: 'custom' },
      model: OPENAI_UNKNOWN_MODEL,
      effort: 'vendor_max',
      allowUnverifiedEffort: true,
    });
    assertContractError(spoofedProviderPolicy, 409, 'session_api_binding_mismatch');

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
    assert.strictEqual(
      selectedRuntime.body?.nativeResumeReady,
      true,
      'the first accepted turn must make the native thread eligible for normal Resume'
    );

    const autoInput = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'return model and thinking to automatic defaults',
    });
    assert.strictEqual(autoInput.statusCode, 200, JSON.stringify(autoInput.body));
    const autoInputCommand = await waitForCommand(fakeHost, (command) => command.id === autoInput.body?.command?.id);
    assert.strictEqual(autoInputCommand.model, null);
    assert.strictEqual(autoInputCommand.effort, null);
    const autoRequestedRuntime = await waitForRuntime(port, (body) => (
      body?.runId === selectedRuntime.body?.runId
      && body?.requestedSelection?.model == null
      && body?.requestedSelection?.effort == null
    ));
    assert.strictEqual(autoRequestedRuntime.body?.requestedSelection?.source, 'user');

    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: selectedRuntime.body?.runId,
      patch: {
        phase: 'working',
        connection: 'ready',
        busy: true,
        activeTurnId: 'turn-awaiting-user',
        waitingOnApproval: true,
        waitingOnUserInput: true,
      },
    });
    const startsBeforeRebindValidation = fakeHost.commands.filter(
      (command) => command.type === 'session.start'
    ).length;
    const stopsBeforeRebindValidation = fakeHost.commands.filter(
      (command) => command.type === 'session.stop'
    ).length;
    const runtimeBeforeRebindValidation = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );

    fakeHost.holdNextApiCatalog = true;
    const unverifiedEffortValidationPromise = requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    const heldValidationCatalog = await waitForHeldApiCatalog(fakeHost);
    assert.strictEqual(heldValidationCatalog.apiConfig?.profileId, PROFILE_VALIDATE.profileId);
    const runtimeDuringRebindValidation = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(
      runtimeDuringRebindValidation.body?.activeRunId,
      runtimeBeforeRebindValidation.body?.activeRunId,
      'Rebind validation must not create a pending run while target model metadata is loading'
    );
    assert.strictEqual(runtimeDuringRebindValidation.body?.pendingRun, null);
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startsBeforeRebindValidation,
      'Rebind validation must not enqueue a Session start while model metadata is loading'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopsBeforeRebindValidation,
      'Rebind validation must not enqueue a Session stop while model metadata is loading'
    );
    await fakeHost.releaseHeldApiCatalog(heldValidationCatalog.requestId);
    const unverifiedEffortValidation = await unverifiedEffortValidationPromise;
    assertContractError(unverifiedEffortValidation, 409, 'session_effort_unverified');
    assert.strictEqual(unverifiedEffortValidation.body?.stage, 'load-model-catalog');

    const nonCustomManualEffortValidation = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: {
          ...PROFILE_VALIDATE,
          provider: 'OpenAI',
          providerKind: 'openai',
        },
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(nonCustomManualEffortValidation, 409, 'session_effort_unsupported');
    assert.match(nonCustomManualEffortValidation.body?.error || '', /only for Custom API providers/i);

    const validatedRebind = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assert.strictEqual(validatedRebind.statusCode, 200, JSON.stringify(validatedRebind.body));
    assert.strictEqual(validatedRebind.body?.ok, true);
    assert.strictEqual(validatedRebind.body?.valid, true);
    assert.strictEqual(validatedRebind.body?.canExecute, true);
    assert.strictEqual(validatedRebind.body?.canExecuteWithoutInterrupt, false);
    assert.strictEqual(validatedRebind.body?.requiresInterrupt, true);
    assert.strictEqual(validatedRebind.body?.busy, true);
    assert.strictEqual(validatedRebind.body?.waitingOnApproval, true);
    assert.strictEqual(validatedRebind.body?.waitingOnUserInput, true);
    assert.strictEqual(validatedRebind.body?.currentRunId, selectedRuntime.body?.runId);
    assert.strictEqual(validatedRebind.body?.currentRunStatus, selectedRuntime.body?.runStatus);
    assert.strictEqual(validatedRebind.body?.sessionBinding?.profileId, PROFILE_A.profileId);
    assert.strictEqual(validatedRebind.body?.submittedBinding?.profileId, PROFILE_VALIDATE.profileId);
    assert.strictEqual(validatedRebind.body?.requestedSelection?.model, MODEL_VALIDATE);
    assert.strictEqual(validatedRebind.body?.requestedSelection?.effort, 'custom_max');
    assert(validatedRebind.body?.modelCatalog?.models?.some((model) => model.id === MODEL_VALIDATE));
    assert.match(String(validatedRebind.body?.modelCatalogReuseToken || ''), /^[A-Za-z0-9_-]{24,}$/);

    fakeHost.failNextApiCatalogError = 'fake provider rejected credentials';
    const unreachableProviderValidation = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(unreachableProviderValidation, 409, 'session_api_binding_unavailable');
    assert.strictEqual(unreachableProviderValidation.body?.stage, 'load-model-catalog');
    assert.strictEqual(
      unreachableProviderValidation.body?.submittedBinding?.profileId,
      PROFILE_VALIDATE.profileId
    );
    assert.match(unreachableProviderValidation.body?.error || '', /rejected credentials/i);

    const invalidEffortValidation = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'Not valid!',
        allowUnverifiedEffort: true,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(invalidEffortValidation, 422, 'session_effort_invalid');

    const catalogCommandsBeforeStaleValidation = fakeHost.commands.filter(
      (command) => command.type === 'host.api_catalog'
    ).length;
    const staleRebindValidation = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind/validate`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        expectedRunId: 'stale-observed-run',
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(staleRebindValidation, 409, 'session_run_changed');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
      catalogCommandsBeforeStaleValidation,
      'stale Rebind validation must fail before target API I/O'
    );

    const runtimeAfterRebindValidation = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(runtimeAfterRebindValidation.statusCode, 200, JSON.stringify(runtimeAfterRebindValidation.body));
    assert.strictEqual(
      runtimeAfterRebindValidation.body?.activeRunId,
      runtimeBeforeRebindValidation.body?.activeRunId,
      'Rebind validation must not create or activate a pending run'
    );
    assert.strictEqual(runtimeAfterRebindValidation.body?.pendingRun, null);
    assert.strictEqual(runtimeAfterRebindValidation.body?.runId, selectedRuntime.body?.runId);
    assert.strictEqual(runtimeAfterRebindValidation.body?.sessionBinding?.profileId, PROFILE_A.profileId);
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startsBeforeRebindValidation,
      'Rebind validation must not enqueue a Session start'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopsBeforeRebindValidation,
      'Rebind validation must not enqueue a Session stop'
    );
    const catalogsBeforeBusyProof = fakeHost.commands.filter(
      (command) => command.type === 'host.api_catalog'
    ).length;
    const modelListsBeforeBusyProof = fakeHost.commands.filter(
      (command) => command.type === 'session.model_list'
    ).length;
    const busyBatchRebind = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
        requireIdle: true,
        modelCatalogReuseToken: validatedRebind.body?.modelCatalogReuseToken,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(busyBatchRebind, 409, 'session_run_busy');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startsBeforeRebindValidation,
      'idle-required batch Rebind must not start a Session that became busy'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopsBeforeRebindValidation,
      'idle-required batch Rebind must not stop a Session that became busy'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
      catalogsBeforeBusyProof,
      'a catalog proof must not bypass the final idle check or trigger provider I/O after it fails'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.model_list').length,
      modelListsBeforeBusyProof,
      'a catalog proof must not bypass the final idle check or trigger runtime model I/O after it fails'
    );
    const runtimeAfterBusyBatchRebind = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(runtimeAfterBusyBatchRebind.body?.pendingRun, null);
    assert.strictEqual(runtimeAfterBusyBatchRebind.body?.activeRunId, selectedRuntime.body?.runId);
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: selectedRuntime.body?.runId,
      patch: {
        phase: 'idle',
        connection: 'ready',
        busy: false,
        activeTurnId: null,
        waitingOnApproval: false,
        waitingOnUserInput: false,
      },
    });

    for (const mismatch of [
      {
        label: 'selection',
        apiConfig: PROFILE_VALIDATE,
        effort: 'custom_low',
      },
      {
        label: 'API config',
        apiConfig: { ...PROFILE_VALIDATE, apiKey: 'different-profile-secret' },
        effort: 'custom_max',
      },
    ]) {
      const catalogsBeforeMismatchProof = fakeHost.commands.filter(
        (command) => command.type === 'host.api_catalog'
      ).length;
      const modelListsBeforeMismatchProof = fakeHost.commands.filter(
        (command) => command.type === 'session.model_list'
      ).length;
      fakeHost.failNextApiCatalogError = `${mismatch.label} mismatch forced a fresh catalog`;
      const mismatchedProofRebind = await requestJson(
        port,
        'POST',
        `/api/sessions/${SESSION_ID}/rebind`,
        {
          hostId: HOST_ID,
          apiConfig: mismatch.apiConfig,
          model: MODEL_VALIDATE,
          effort: mismatch.effort,
          allowUnverifiedEffort: true,
          requireIdle: true,
          modelCatalogReuseToken: validatedRebind.body?.modelCatalogReuseToken,
          expectedRunId: selectedRuntime.body?.runId,
          expectedRunStatus: selectedRuntime.body?.runStatus,
          expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
        }
      );
      assertContractError(mismatchedProofRebind, 409, 'session_api_binding_unavailable');
      assert.match(mismatchedProofRebind.body?.error || '', /mismatch forced a fresh catalog/i);
      assert.strictEqual(
        fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
        catalogsBeforeMismatchProof + 1,
        `${mismatch.label} mismatch must fall back to a fresh provider catalog`
      );
      assert.strictEqual(
        fakeHost.commands.filter((command) => command.type === 'session.model_list').length,
        modelListsBeforeMismatchProof + 1,
        `${mismatch.label} mismatch must fall back to a fresh runtime model catalog`
      );
      const runtimeAfterMismatchProof = await requestJson(
        port,
        'GET',
        `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
      );
      assert.strictEqual(runtimeAfterMismatchProof.body?.pendingRun, null);
      assert.strictEqual(runtimeAfterMismatchProof.body?.runId, selectedRuntime.body?.runId);
    }

    const startsBeforeLateBusyRebind = fakeHost.commands.filter(
      (command) => command.type === 'session.start'
    ).length;
    const stopsBeforeLateBusyRebind = fakeHost.commands.filter(
      (command) => command.type === 'session.stop'
    ).length;
    fakeHost.holdNextApiCatalog = true;
    const lateBusyRebindPromise = requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
        requireIdle: true,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    const heldLateBusyCatalog = await waitForHeldApiCatalog(fakeHost);
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: selectedRuntime.body?.runId,
      patch: {
        phase: 'queued-turn',
        connection: 'ready',
        busy: true,
        activeTurnId: 'turn-started-during-rebind-catalog',
        waitingOnApproval: false,
        waitingOnUserInput: false,
      },
    });
    await fakeHost.releaseHeldApiCatalog(heldLateBusyCatalog.requestId);
    const lateBusyRebind = await lateBusyRebindPromise;
    assertContractError(lateBusyRebind, 409, 'session_run_busy');
    assert.strictEqual(lateBusyRebind.body?.stage, 'plan-run');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startsBeforeLateBusyRebind,
      'idle-required Rebind must not start after the Session becomes busy during catalog loading'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopsBeforeLateBusyRebind,
      'idle-required Rebind must not stop the live run after it becomes busy during catalog loading'
    );
    const runtimeAfterLateBusyRebind = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(runtimeAfterLateBusyRebind.body?.pendingRun, null);
    assert.strictEqual(runtimeAfterLateBusyRebind.body?.activeRunId, selectedRuntime.body?.runId);
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      runId: selectedRuntime.body?.runId,
      patch: {
        phase: 'idle',
        connection: 'ready',
        busy: false,
        activeTurnId: null,
        waitingOnApproval: false,
        waitingOnUserInput: false,
      },
    });

    const startsBeforeProviderRace = fakeHost.commands.filter((command) => command.type === 'session.start').length;
    const stopsBeforeProviderRace = fakeHost.commands.filter((command) => command.type === 'session.stop').length;
    const catalogsBeforeInvalidReuse = fakeHost.commands.filter(
      (command) => command.type === 'host.api_catalog'
    ).length;
    fakeHost.failNextApiCatalogError = 'fake provider became unavailable after preflight';
    const providerRaceRebind = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
        refreshModels: true,
        requireIdle: true,
        modelCatalogReuseToken: 'not-a-valid-catalog-proof',
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(providerRaceRebind, 409, 'session_api_binding_unavailable');
    assert.match(providerRaceRebind.body?.error || '', /became unavailable after preflight/i);
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
      catalogsBeforeInvalidReuse + 1,
      'an invalid proof must fall back to a fresh provider catalog request'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startsBeforeProviderRace,
      'Rebind must not start a new run when the provider refresh fails after preflight'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopsBeforeProviderRace,
      'Rebind must not stop the live run when the provider refresh fails after preflight'
    );
    const runtimeAfterProviderRace = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`
    );
    assert.strictEqual(runtimeAfterProviderRace.body?.pendingRun, null);

    fakeHost.failNextApiCatalogError = '<!doctype html><html><head><title>API Channels</title></head><body>provider console</body></html>';
    const htmlCatalogRebind = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/rebind`,
      {
        hostId: HOST_ID,
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        expectedRunId: selectedRuntime.body?.runId,
        expectedRunStatus: selectedRuntime.body?.runStatus,
        expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
      }
    );
    assertContractError(htmlCatalogRebind, 409, 'session_api_binding_unavailable');
    assert.match(htmlCatalogRebind.body?.error || '', /HTML page.*Base URL needs \/v1/i);
    assert.doesNotMatch(htmlCatalogRebind.body?.error || '', /<!doctype|<html|provider console/i);
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.start').length,
      startsBeforeProviderRace,
      'an HTML provider response must fail before a replacement Session starts'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.stop').length,
      stopsBeforeProviderRace,
      'an HTML provider response must fail before the live Session is stopped'
    );
    assert.strictEqual(runtimeAfterProviderRace.body?.runId, selectedRuntime.body?.runId);

    const catalogsBeforeStaleProof = fakeHost.commands.filter(
      (command) => command.type === 'host.api_catalog'
    ).length;
    const modelListsBeforeStaleProof = fakeHost.commands.filter(
      (command) => command.type === 'session.model_list'
    ).length;
    const staleRebind = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/rebind`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_B,
      model: MODEL_B,
      modelCatalogReuseToken: validatedRebind.body?.modelCatalogReuseToken,
      expectedRunId: 'stale-observed-run',
      expectedRunStatus: selectedRuntime.body?.runStatus,
      expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    assertContractError(staleRebind, 409, 'session_run_changed');
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
      catalogsBeforeStaleProof,
      'a proof must not bypass authoritative run expectation validation'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.model_list').length,
      modelListsBeforeStaleProof,
      'a stale run expectation must fail before runtime model I/O'
    );

    const compact = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/compact`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_A,
    });
    assert.strictEqual(compact.statusCode, 200, JSON.stringify(compact.body));
    const compactCommand = await waitForCommand(fakeHost, (command) => command.id === compact.body?.command?.id);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(compactCommand, 'apiConfig'), false);
    assert.strictEqual(compactCommand.expectedBinding?.profileId, PROFILE_A.profileId);

    const catalogCommandsBeforeReusablePreflight = fakeHost.commands.filter(
      (command) => command.type === 'host.api_catalog'
    ).length;
    const modelListCommandsBeforeReusablePreflight = fakeHost.commands.filter(
      (command) => command.type === 'session.model_list'
    ).length;
    fakeHost.holdNextApiCatalog = true;
    const reboundPreflightPromise = requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/rebind/validate`, {
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
      'stale discovery must not close the live parent while Rebind preflight is pending'
    );
    assert.strictEqual(sourceDuringPendingRebindDiscovery.body?.session?.live, true);
    const inputDuringRebindValidation = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'the existing run stays writable while rebind validation is pending',
      model: MODEL_A,
      effort: 'high',
    });
    await fakeHost.releaseHeldApiCatalog(heldRebindCatalog.requestId);
    const reboundPreflight = await reboundPreflightPromise;
    assert.strictEqual(
      inputDuringRebindValidation.statusCode,
      200,
      `catalog validation must not replace the live run: ${JSON.stringify(inputDuringRebindValidation.body)}`
    );
    assert.strictEqual(inputDuringRebindValidation.body?.command?.runId, firstStart.runId);
    assert.strictEqual(reboundPreflight.statusCode, 200, JSON.stringify(reboundPreflight.body));
    const catalogReuseToken = String(reboundPreflight.body?.modelCatalogReuseToken || '');
    assert.match(catalogReuseToken, /^[A-Za-z0-9_-]{24,}$/);
    assert.doesNotMatch(
      catalogReuseToken,
      new RegExp(`${HOST_ID}|${SESSION_ID}|${PROFILE_B.profileId}|${PROFILE_B.apiKey}`, 'i'),
      'the browser proof must be opaque and must not expose its bound identity or credential'
    );
    const catalogCommandsAfterReusablePreflight = fakeHost.commands.filter(
      (command) => command.type === 'host.api_catalog'
    ).length;
    const modelListCommandsAfterReusablePreflight = fakeHost.commands.filter(
      (command) => command.type === 'session.model_list'
    ).length;
    assert.strictEqual(
      catalogCommandsAfterReusablePreflight,
      catalogCommandsBeforeReusablePreflight + 1,
      'Rebind preflight must fetch the target provider catalog once'
    );
    assert.strictEqual(
      modelListCommandsAfterReusablePreflight,
      modelListCommandsBeforeReusablePreflight + 1,
      'Rebind preflight must fetch the target runtime model catalog once'
    );

    fakeHost.holdNextStart = true;
    fakeHost.holdNextStop = true;
    const rebound = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/rebind`, {
      hostId: HOST_ID,
      apiConfig: PROFILE_B,
      model: MODEL_B,
      modelCatalogReuseToken: catalogReuseToken,
      expectedRunId: selectedRuntime.body?.runId,
      expectedRunStatus: selectedRuntime.body?.runStatus,
      expectedBindingFingerprint: selectedRuntime.body?.sessionBinding?.bindingFingerprint,
    });
    assert.strictEqual(rebound.statusCode, 200, JSON.stringify(rebound.body));
    assert.strictEqual(rebound.body?.modelCatalog?.runId, rebound.body?.runId);
    assert.strictEqual(
      rebound.body?.modelCatalog?.allowProviderModelsWithoutLive,
      true,
      'a non-official OpenAI-compatible profile must retain provider-advertised models'
    );
    assert.strictEqual(
      rebound.body?.modelCatalog?.models?.find((model) => model.id === MODEL_B)?.selectable,
      true,
      'Rebind must return its already-validated target provider model for immediate UI selection'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'host.api_catalog').length,
      catalogCommandsAfterReusablePreflight,
      'a matching short-lived proof must avoid a second provider catalog fetch during Rebind'
    );
    assert.strictEqual(
      fakeHost.commands.filter((command) => command.type === 'session.model_list').length,
      modelListCommandsAfterReusablePreflight,
      'a matching short-lived proof must avoid a second runtime model-list fetch during Rebind'
    );
    const secondStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start'
      && command.runId === rebound.body?.runId
      && command.apiConfig?.profileId === PROFILE_B.profileId
    ));
    await waitForHeldStart(fakeHost, rebound.body.runId);
    assert.strictEqual(secondStart.launchMode, 'resume');
    assert.deepStrictEqual(secondStart.resumeTranscript, []);
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
        currentTurnStatus: 'inProgress',
        pendingInputSummary: 'pending input before unconfirmed Stop',
        queuedCommandId: 'queued-command-before-unconfirmed-stop',
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
        phase: 'thinking',
        connection: 'ready',
        busy: true,
        activeTurnId: 'late-turn-while-stop-pending',
        currentTurnStatus: 'inProgress',
        reasoningSummary: 'late progress remains observable while Stop owns control state',
        runId: confirmedReboundRuntime.body?.runId,
      },
    });
    const detailWhileStopping = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(detailWhileStopping.statusCode, 200, JSON.stringify(detailWhileStopping.body));
    assert.strictEqual(detailWhileStopping.body?.runtime?.phase, 'ending');
    assert.strictEqual(detailWhileStopping.body?.runtime?.connection, 'closing');
    assert.strictEqual(detailWhileStopping.body?.runtime?.busy, false);
    assert.strictEqual(detailWhileStopping.body?.runtime?.activeTurnId, null);
    assert.strictEqual(
      detailWhileStopping.body?.runtime?.currentTurnStatus,
      'stopping',
      'same-run progress must not replace a durable pending Stop projection'
    );
    assert.strictEqual(
      detailWhileStopping.body?.runtime?.reasoningSummary,
      'late progress remains observable while Stop owns control state',
      'pending Stop protection should retain non-control runtime progress'
    );
    const inputWhileStopping = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
      hostId: HOST_ID,
      text: 'must not enter a runner while Stop is pending',
    });
    assert.strictEqual(inputWhileStopping.statusCode, 409, JSON.stringify(inputWhileStopping.body));
    const restoredDetail = await waitForSessionDetail(
      port,
      SESSION_ID,
      (body) => body?.session?.state !== 'ending' && body?.runtime?.phase === 'working'
    );
    const restoredAfterUnconfirmedStop = await waitForRuntime(
      port,
      (body) => body?.runStatus === 'live' && body?.effectiveSelection?.effort === 'max'
    );
    assert.strictEqual(restoredAfterUnconfirmedStop.body?.runId, confirmedReboundRuntime.body?.runId);
    assert.strictEqual(restoredDetail.body?.session?.live, true);
    assert.notStrictEqual(restoredDetail.body?.session?.state, 'ending');
    assert.strictEqual(restoredDetail.body?.runtime?.phase, 'working');
    assert.strictEqual(restoredDetail.body?.runtime?.connection, 'ready');
    assert.strictEqual(restoredDetail.body?.runtime?.busy, true);
    assert.strictEqual(restoredDetail.body?.runtime?.activeTurnId, 'turn-before-unconfirmed-stop');
    assert.strictEqual(restoredDetail.body?.runtime?.currentTurnStatus, 'inProgress');
    assert.strictEqual(restoredDetail.body?.runtime?.pendingInputSummary, 'pending input before unconfirmed Stop');
    assert.strictEqual(restoredDetail.body?.runtime?.queuedCommandId, 'queued-command-before-unconfirmed-stop');

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
    await waitForSessionDetail(
      port,
      DISCOVERY_CLOSE_SESSION_ID,
      (body) => body?.session?.live === true
        && body?.session?.runId === discoveryCloseStarted.body?.runId
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
    assert.strictEqual(
      projectionAfterStaleDiscovery.body?.session?.live,
      true,
      JSON.stringify(projectionAfterStaleDiscovery.body)
    );
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
    await fakeHost.postEvent({
      type: 'session.runtime_updated',
      hostId: HOST_ID,
      sessionId: DISCOVERY_CLOSE_SESSION_ID,
      runId: discoveryCloseStarted.body?.runId,
      patch: {
        activeTurnId: 'discovery-close-active-turn',
        busy: true,
        phase: 'thinking',
        currentTurnStatus: 'inProgress',
      },
    });
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
    const discoveryClosedDetail = await requestJson(
      port,
      'GET',
      `/api/sessions/${DISCOVERY_CLOSE_SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert.strictEqual(discoveryClosedDetail.statusCode, 200, JSON.stringify(discoveryClosedDetail.body));
    assert.strictEqual(discoveryClosedDetail.body?.runtime?.phase, 'closed');
    assert.strictEqual(discoveryClosedDetail.body?.runtime?.activeTurnId, null);
    assert.strictEqual(
      discoveryClosedDetail.body?.runtime?.currentTurnStatus,
      'closed',
      'discovery-driven closure must terminate any previously in-progress turn status'
    );

    const forked = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      launchMode: 'fork',
      sourceSessionId: SESSION_ID,
      apiConfig: PROFILE_B,
      model: '',
      effort: '',
    });
    assert.strictEqual(forked.statusCode, 200, JSON.stringify(forked.body));
    assert.notStrictEqual(forked.body?.sessionId, SESSION_ID, 'fork must allocate its own bridge identity');
    const forkStart = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start' && command.runId === forked.body?.runId
    ));
    assert.strictEqual(forkStart.launchMode, 'fork');
    assert.strictEqual(forkStart.nativeThreadId, SESSION_ID);
    assert.deepStrictEqual(forkStart.resumeTranscript, []);
    assert.strictEqual(forkStart.model, null);
    assert.strictEqual(forkStart.effort, null);
    const forkRuntime = await waitForRuntime(
      port,
      (body) => body?.runId === forked.body?.runId && body?.provenance?.sourceSessionId === SESSION_ID,
      5000,
      forked.body.sessionId
    );
    assert.strictEqual(forkRuntime.body?.sessionBinding?.profileId, PROFILE_B.profileId);
    assert.strictEqual(
      forkRuntime.body?.requestedSelection?.model,
      null,
      'an explicit Auto model must not inherit the source run model'
    );
    assert.strictEqual(
      forkRuntime.body?.requestedSelection?.effort,
      null,
      'an explicit Auto effort must not inherit the source run effort'
    );
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
      await waitForRuntime(
        port,
        (body) => body?.runId === sourceStartCommand.runId && body?.nativeResumeReady === true,
        5000,
        sourceSessionId
      );

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
    const restartLiveReplacementInput = await requestJson(
      port,
      'POST',
      `/api/sessions/${RESTART_LIVE_REPLACEMENT_SESSION_ID}/input`,
      {
        hostId: HOST_ID,
        text: 'materialize the native thread before restart resume coverage',
        model: MODEL_A,
        effort: null,
      }
    );
    assert.strictEqual(
      restartLiveReplacementInput.statusCode,
      200,
      JSON.stringify(restartLiveReplacementInput.body)
    );
    await waitForCommand(
      fakeHost,
      (command) => command.id === restartLiveReplacementInput.body?.command?.id
    );
    await waitForRuntime(
      port,
      (body) => body?.runId === restartLiveReplacementStart.body?.runId
        && body?.nativeResumeReady === true,
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

    const hostEnvironmentStarted = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        sessionId: HOST_ENV_SESSION_ID,
        cwd: ROOT,
        label: 'Host environment static effort',
        model: STATIC_OPENAI_MODEL,
        effort: 'ultra',
      }
    );
    assert.strictEqual(hostEnvironmentStarted.statusCode, 200, JSON.stringify(hostEnvironmentStarted.body));
    assert.strictEqual(hostEnvironmentStarted.body?.sessionBinding?.kind, 'host_environment');
    assert.strictEqual(
      hostEnvironmentStarted.body?.sessionBinding?.bindingFingerprint,
      HOST_ENV_BINDING.bindingFingerprint
    );
    const hostEnvironmentStartCommand = await waitForCommand(fakeHost, (command) => (
      command.type === 'session.start' && command.runId === hostEnvironmentStarted.body?.runId
    ));
    assert.strictEqual(hostEnvironmentStartCommand.apiConfig, null);
    assert.strictEqual(hostEnvironmentStartCommand.model, STATIC_OPENAI_MODEL);
    assert.strictEqual(hostEnvironmentStartCommand.effort, 'ultra');
    await waitForRuntime(
      port,
      (body) => body?.runId === hostEnvironmentStarted.body?.runId
        && body?.runStatus === 'live'
        && body?.sessionBinding?.kind === 'host_environment',
      5000,
      HOST_ENV_SESSION_ID
    );
    const hostEnvironmentInput = await requestJson(
      port,
      'POST',
      `/api/sessions/${HOST_ENV_SESSION_ID}/input`,
      {
        hostId: HOST_ID,
        text: 'host environment input using static OpenAI effort metadata',
        model: STATIC_OPENAI_MODEL,
        effort: 'ultra',
      }
    );
    assert.strictEqual(hostEnvironmentInput.statusCode, 200, JSON.stringify(hostEnvironmentInput.body));
    const hostEnvironmentInputCommand = await waitForCommand(
      fakeHost,
      (command) => command.id === hostEnvironmentInput.body?.command?.id
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(hostEnvironmentInputCommand, 'apiConfig'), false);
    assert.strictEqual(hostEnvironmentInputCommand.model, STATIC_OPENAI_MODEL);
    assert.strictEqual(hostEnvironmentInputCommand.effort, 'ultra');

    const customPolicySessionId = 'custom-provider-policy-continuity-session';
    const customPolicyStart = await requestJson(
      port,
      'POST',
      `/api/hosts/${HOST_ID}/sessions/start`,
      {
        sessionId: customPolicySessionId,
        cwd: ROOT,
        label: 'Custom provider policy continuity',
        apiConfig: PROFILE_VALIDATE,
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
      }
    );
    assert.strictEqual(customPolicyStart.statusCode, 200, JSON.stringify(customPolicyStart.body));
    assert.strictEqual(customPolicyStart.body?.sessionBinding?.providerKind, 'custom');
    await waitForRuntime(
      port,
      (body) => body?.runId === customPolicyStart.body?.runId && body?.runStatus === 'live',
      5000,
      customPolicySessionId
    );
    const customPolicyInput = await requestJson(
      port,
      'POST',
      `/api/sessions/${customPolicySessionId}/input`,
      {
        hostId: HOST_ID,
        text: 'custom provider keeps its manual effort policy after start',
        model: MODEL_VALIDATE,
        effort: 'custom_max',
        allowUnverifiedEffort: true,
      }
    );
    assert.strictEqual(customPolicyInput.statusCode, 200, JSON.stringify(customPolicyInput.body));
    const customPolicyInputCommand = await waitForCommand(
      fakeHost,
      (command) => command.id === customPolicyInput.body?.command?.id
    );
    assert.strictEqual(customPolicyInputCommand.apiBinding?.providerKind, 'custom');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(customPolicyInputCommand, 'apiConfig'), false);
    assert.strictEqual(customPolicyInputCommand.effort, 'custom_max');

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
