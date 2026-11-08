const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_ID = 'review-guard-host';
const SESSION_ID = 'review-guard-session';
const PROFILE = {
  profileId: 'review-profile',
  label: 'Review profile',
  provider: 'OpenAI',
  baseUrl: 'https://review.example/v1',
  apiKey: 'test-secret-not-persisted',
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
          reject(new Error(`invalid JSON response: ${error.message}\n${text}`));
        }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error(`${method} ${pathname} timed out`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function relayEnv(port, root) {
  return {
    ...process.env,
    PORT: String(port),
    RELAY_STATE_ROOT: root,
    RELAY_AUTH_DISABLED: 'true',
    RELAY_LOCAL_AGENT_WATCHDOG_ENABLED: 'false',
    SESSION_RECORD_STORE_ROOT: path.join(root, 'session-record-store'),
    SESSION_COLLECTIONS_PATH: path.join(root, 'session-collections.json'),
    SESSION_METADATA_PATH: path.join(root, 'session-metadata.json'),
    SESSION_LOGS_PATH: path.join(root, 'session-logs.json'),
    SESSION_DIAGNOSTICS_PATH: path.join(root, 'session-diagnostics.json'),
    DISMISSED_HOSTS_PATH: path.join(root, 'dismissed-hosts.json'),
    INPUT_COMMAND_OUTBOX_PATH: path.join(root, 'input-command-outbox.jsonl'),
    AGENT_EVENT_LEDGER_PATH: path.join(root, 'agent-event-ledger.jsonl'),
    CONNECTORS_PATH: path.join(root, 'connectors.json'),
    CONNECTOR_SECRETS_PATH: path.join(root, 'connector-secrets.json'),
    SKILL_FAVORITES_PATH: path.join(root, 'skill-favorites.json'),
    SKILL_SOURCES_PATH: path.join(root, 'skill-sources.json'),
    SKILL_LIBRARY_PATH: path.join(root, 'skill-library.json'),
    SKILL_INVENTORIES_PATH: path.join(root, 'skill-inventories.json'),
    SKILL_REGISTRY_PATH: path.join(root, 'skill-registry.json'),
    SKILL_ARTIFACT_ROOT: path.join(root, 'skill-artifacts'),
    SKILL_DEPLOYMENTS_PATH: path.join(root, 'skill-deployments.json'),
    SKILL_ADOPTIONS_PATH: path.join(root, 'skill-adoptions.json'),
    SKILL_IMPORTS_PATH: path.join(root, 'skill-imports.json'),
    SKILL_REFRESHES_PATH: path.join(root, 'skill-refreshes.json'),
    SKILL_AUDIT_PATH: path.join(root, 'skill-audit.jsonl'),
    THINKING_ACTIVITY_PATH: path.join(root, 'thinking-activity.json'),
    RELAY_TEST_CONTROL_ENABLED: 'true',
  };
}

async function waitFor(port, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(20);
  }
  throw new Error('Timed out waiting for expected Relay state');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-relay-'));
  const probe = http.createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  const output = [];
  const relay = spawn(process.execPath, [path.join(ROOT, 'apps/relay/server.js')], {
    cwd: ROOT,
    env: relayEnv(port, root),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', (chunk) => output.push(chunk.toString()));
  relay.stderr.on('data', (chunk) => output.push(chunk.toString()));
  let after = 0;
  const commands = [];
  let polling = true;
  const poll = (async () => {
    while (polling) {
      try {
        const response = await requestJson(
          port,
          'GET',
          `/api/agent/commands?hostId=${HOST_ID}&after=${after}&ack=${after}`
        );
        for (const command of response.body?.commands || []) {
          commands.push(command);
          after = Math.max(after, Number(command.id || 0));
          if (command.type === 'host.api_catalog') {
            await requestJson(port, 'POST', '/api/agent/events', {
              event: {
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
                    models: [{ id: 'gpt-review-test', isDefault: true }],
                  },
                },
              },
            });
          } else if (command.type === 'host.binding_preflight') {
            await requestJson(port, 'POST', '/api/agent/events', {
              event: {
                type: 'host.binding_preflighted',
                hostId: HOST_ID,
                requestId: command.requestId,
                ok: true,
                binding: command.expectedBinding,
              },
            });
          } else if (command.type === 'session.start') {
            await requestJson(port, 'POST', '/api/agent/events', {
              event: {
                type: 'session.started',
                hostId: HOST_ID,
                sessionId: command.sessionId,
                nativeThreadId: command.sessionId,
                runId: command.runId,
                title: command.label,
                cwd: command.cwd,
                source: 'managed',
                launchMode: command.launchMode,
                conversationKey: command.conversationKey,
                effectiveBinding: command.expectedBinding,
                runtime: {
                  adapterId: 'codex-app-server',
                  runId: command.runId,
                  nativeResumeReady: true,
                  connection: 'ready',
                  phase: 'idle',
                  busy: false,
                  activeTurnId: null,
                  currentTurnStatus: 'idle',
                },
              },
            });
          }
        }
      } catch (error) {
        if (polling && relay.exitCode != null) throw error;
      }
      await delay(20);
    }
  })();

  try {
    await waitFor(port, async () => {
      try {
        const response = await requestJson(port, 'GET', '/health');
        return response.statusCode === 200 && response.body?.ok;
      } catch (_) {
        return false;
      }
    });
    const registered = await requestJson(port, 'POST', '/api/agent/register', {
      hostId: HOST_ID,
      label: 'Review Guard Host',
      platform: process.platform,
      capabilities: {
        review: true,
        apiCatalog: true,
        bindingPreflight: true,
        runApiBinding: true,
        sessionApiRebindV1: true,
        nativeResumeReadiness: true,
        managedStartPresenceV1: true,
        turnControls: true,
      },
    });
    assert.strictEqual(registered.statusCode, 200, JSON.stringify(registered.body));

    const started = await requestJson(port, 'POST', `/api/hosts/${HOST_ID}/sessions/start`, {
      sessionId: SESSION_ID,
      cwd: ROOT,
      label: 'Review guard test',
      apiConfig: PROFILE,
    });
    assert.strictEqual(started.statusCode, 200, JSON.stringify(started.body));
    await waitFor(port, async () => {
      const response = await requestJson(port, 'GET', `/api/sessions/${SESSION_ID}/runtime-config?hostId=${HOST_ID}`);
      if (response.body?.runStatus !== 'live' || response.body?.runId !== started.body?.runId) {
        return false;
      }
      const detail = await requestJson(
        port,
        'GET',
        `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
      );
      return (detail.body?.runtime?.phase || detail.body?.session?.runtime?.phase) === 'idle';
    });

    const baselineCount = () => commands.filter((command) => command.type === 'session.review_start').length;
    const allowed = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/review`, {
      hostId: HOST_ID,
      target: { type: 'uncommittedChanges' },
    });
    assert.strictEqual(allowed.statusCode, 200, JSON.stringify(allowed.body));
    await waitFor(port, async () => baselineCount() === 1);

    const missingRunReviewId = 'review-missing-run-id';
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.review_started',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        reviewThreadId: missingRunReviewId,
      },
    });
    const afterMissingRunReview = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert(afterMissingRunReview.body?.diagnostics?.some((entry) => (
      entry.method === 'session.review_started/missing-run-id'
    )), 'a binding-aware Host review event without runId must be diagnosed and ignored');
    assert(!afterMissingRunReview.body?.diagnostics?.some((entry) => (
      entry.data?.reviewThreadId === missingRunReviewId
    )), 'a review_started event without runId must not reach the active Session');

    const staleRunReviewId = 'review-stale-run';
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.review_started',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: 'stale-review-run',
        reviewThreadId: staleRunReviewId,
      },
    });
    const afterStaleRunReview = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert(!afterStaleRunReview.body?.diagnostics?.some((entry) => (
      entry.data?.reviewThreadId === staleRunReviewId
    )), 'a stale-run review_started event must not reach the active Session');

    const currentRunReviewId = 'review-current-run';
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.review_started',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: started.body?.runId,
        reviewThreadId: currentRunReviewId,
      },
    });
    const afterCurrentRunReview = await requestJson(
      port,
      'GET',
      `/api/sessions/${SESSION_ID}/detail?hostId=${HOST_ID}`
    );
    assert(afterCurrentRunReview.body?.diagnostics?.some((entry) => (
      entry.data?.reviewThreadId === currentRunReviewId
    )), 'a current-run review_started event must be accepted');

    const cases = [
      {
        name: 'active turn',
        patch: { phase: 'thinking', busy: true, activeTurnId: 'review-turn-1', currentTurnStatus: 'inProgress' },
        code: 'session_review_busy',
      },
      {
        name: 'submitting input',
        patch: { phase: 'submitting-turn', busy: true, activeTurnId: null, pendingClientRequestId: 'review-request-1', currentTurnStatus: 'submitting' },
        code: 'session_review_busy',
      },
      {
        name: 'unknown runtime',
        patch: { phase: 'runtime-unknown', busy: true, activeTurnId: null, currentTurnStatus: 'unknown' },
        code: 'session_review_runtime_unknown',
      },
    ];
    for (const testCase of cases) {
      await requestJson(port, 'POST', '/api/agent/events', {
        event: {
          type: 'session.runtime_updated',
          hostId: HOST_ID,
          sessionId: SESSION_ID,
          runId: started.body?.runId,
          patch: testCase.patch,
        },
      });
      const before = baselineCount();
      const rejected = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/review`, {
        hostId: HOST_ID,
        target: { type: 'uncommittedChanges' },
      });
      assert.strictEqual(rejected.statusCode, 409, `${testCase.name}: ${JSON.stringify(rejected.body)}`);
      assert.strictEqual(rejected.body?.code, testCase.code, `${testCase.name}: ${JSON.stringify(rejected.body)}`);
      assert.match(rejected.body?.error || '', /not queued/i);
      assert.strictEqual(baselineCount(), before, `${testCase.name} must not enqueue Review`);
    }

    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: started.body?.runId,
        patch: { phase: 'idle', busy: false, activeTurnId: null, currentTurnStatus: 'idle' },
      },
    });
    const allowedAgain = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/review`, {
      hostId: HOST_ID,
      target: { type: 'uncommittedChanges' },
    });
    assert.strictEqual(allowedAgain.statusCode, 200, JSON.stringify(allowedAgain.body));
    await waitFor(port, async () => baselineCount() === 2);

    async function queueUnknownInput(clientRequestId) {
      const input = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/input`, {
        hostId: HOST_ID,
        clientRequestId,
        text: `Review guard input ${clientRequestId}`,
      });
      assert.strictEqual(input.statusCode, 200, JSON.stringify(input.body));
      const command = await waitFor(port, async () => commands.find((candidate) => (
        candidate.type === 'session.input'
        && candidate.id === input.body?.command?.id
      )) || null);
      await requestJson(port, 'POST', '/api/agent/events', {
        event: {
          type: 'session.runtime_updated',
          hostId: HOST_ID,
          sessionId: SESSION_ID,
          runId: started.body?.runId,
          commandId: command.id,
          commandClientRequestId: clientRequestId,
          clientRequestId,
          inputOutcome: 'acceptance_unknown',
          patch: {
            phase: 'idle',
            busy: false,
            activeTurnId: null,
            currentTurnStatus: 'idle',
            pendingClientRequestId: null,
            queuedCommandId: null,
          },
        },
      });
      const rejected = await requestJson(port, 'POST', `/api/sessions/${SESSION_ID}/review`, {
        hostId: HOST_ID,
        target: { type: 'uncommittedChanges' },
      });
      assert.strictEqual(rejected.statusCode, 409, JSON.stringify(rejected.body));
      assert.strictEqual(rejected.body?.code, 'session_review_input_acceptance_unknown');
      return command;
    }

    const transcriptResolvedRequestId = 'review-unknown-transcript-resolved';
    await queueUnknownInput(transcriptResolvedRequestId);
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: started.body?.runId,
        clientRequestId: transcriptResolvedRequestId,
        patch: {
          phase: 'thinking',
          busy: true,
          activeTurnId: 'review-transcript-confirmed-turn',
          currentTurnStatus: 'inProgress',
          clientRequestId: transcriptResolvedRequestId,
        },
      },
    });
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: started.body?.runId,
        patch: { phase: 'idle', busy: false, activeTurnId: null, currentTurnStatus: 'idle' },
      },
    });
    const allowedAfterAcceptedTranscript = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/review`,
      { hostId: HOST_ID, target: { type: 'uncommittedChanges' } }
    );
    assert.strictEqual(
      allowedAfterAcceptedTranscript.statusCode,
      200,
      JSON.stringify(allowedAfterAcceptedTranscript.body)
    );
    await waitFor(port, async () => baselineCount() === 3);

    const receiptResolvedRequestId = 'review-unknown-receipt-resolved';
    const receiptResolvedCommand = await queueUnknownInput(receiptResolvedRequestId);
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: started.body?.runId,
        commandId: receiptResolvedCommand.id,
        commandClientRequestId: receiptResolvedRequestId,
        clientRequestId: receiptResolvedRequestId,
        inputOutcome: 'accepted',
        patch: {
          phase: 'idle',
          busy: false,
          activeTurnId: null,
          currentTurnStatus: 'idle',
          pendingClientRequestId: null,
          queuedCommandId: null,
        },
      },
    });
    const allowedAfterAcceptedReceipt = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/review`,
      { hostId: HOST_ID, target: { type: 'uncommittedChanges' } }
    );
    assert.strictEqual(
      allowedAfterAcceptedReceipt.statusCode,
      200,
      JSON.stringify(allowedAfterAcceptedReceipt.body)
    );
    await waitFor(port, async () => baselineCount() === 4);

    const rejectedRequestId = 'review-unknown-rejected';
    const rejectedCommand = await queueUnknownInput(rejectedRequestId);
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.command_failed',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: started.body?.runId,
        commandId: rejectedCommand.id,
        clientRequestId: rejectedRequestId,
        operation: 'input',
        code: 'session_input_rejected_for_test',
        message: 'Synthetic terminal rejection for Review guard coverage.',
      },
    });
    await requestJson(port, 'POST', '/api/agent/events', {
      event: {
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: SESSION_ID,
        runId: started.body?.runId,
        patch: { phase: 'idle', busy: false, activeTurnId: null, currentTurnStatus: 'idle' },
      },
    });
    const allowedAfterRejectedReceipt = await requestJson(
      port,
      'POST',
      `/api/sessions/${SESSION_ID}/review`,
      { hostId: HOST_ID, target: { type: 'uncommittedChanges' } }
    );
    assert.strictEqual(
      allowedAfterRejectedReceipt.statusCode,
      200,
      JSON.stringify(allowedAfterRejectedReceipt.body)
    );
    await waitFor(port, async () => baselineCount() === 5);
    console.log('session review Relay integration assertions passed');
  } catch (error) {
    error.message += `\nRelay output:\n${output.join('')}`;
    throw error;
  } finally {
    polling = false;
    await poll.catch(() => {});
    if (relay.exitCode == null) {
      relay.kill();
      await new Promise((resolve) => relay.once('exit', resolve));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
