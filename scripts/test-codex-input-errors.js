'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyCodexInputCompatibilityError,
  isModelMetadataFallbackNotice,
  normalizeInputTypes,
} = require('../shared/codex-input-errors');
const { CodexAppServerRunner } = require('../apps/host-agent/codex-app-server-runner');

const ARRAY_TOO_LONG_ERROR =
  "Invalid 'input[3].content': array too long. Expected maximum length 0, got length 1";
const ARRAY_TOO_LONG_ERROR_CURRENT =
  "Invalid 'input[11].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.";
const UNKNOWN_INPUT_CONTENT_PARAMETER_ERROR =
  "stream disconnected before completion: [ObjectParam] [input[92].content] [unknown_parameter] Unknown parameter: 'input[92].content'.";
const FRIENDLY_IMAGE_ERROR =
  'This API/model does not accept image input. Remove the image attachment and retry; text-only prompts can continue.';
const FRIENDLY_HISTORY_ERROR =
  "This API provider rejected the Session's Responses history; changing models (including switching to 5.6) does not fix this schema error. If this endpoint uses Sub2API, update to a build containing Wei-Shaw/sub2api PR #5888 (commit acce29af), then retry. If the provider still cannot read this history, create a new Session from the transcript. The original Session and its complete native history were not cropped or converted.";

function verifyClassifier() {
  assert.deepStrictEqual(
    normalizeInputTypes(['text', 'image', 'text', '', 'localImage', 'image']),
    ['text', 'image', 'localImage']
  );

  const imageError = classifyCodexInputCompatibilityError(ARRAY_TOO_LONG_ERROR, ['text', 'image']);
  assert(imageError, 'an exact image content rejection should be classified');
  assert.strictEqual(imageError.code, 'session_input_image_unsupported');
  assert.strictEqual(imageError.kind, 'image');
  assert.deepStrictEqual(imageError.inputTypes, ['text', 'image']);
  assert.strictEqual(imageError.userMessage, FRIENDLY_IMAGE_ERROR);
  assert.strictEqual(imageError.rawMessage, ARRAY_TOO_LONG_ERROR);

  const historyError = classifyCodexInputCompatibilityError(
    ARRAY_TOO_LONG_ERROR_CURRENT,
    ['text']
  );
  assert(historyError, 'the current provider wording should classify a text-only history rejection');
  assert.strictEqual(historyError.code, 'session_responses_history_incompatible');
  assert.strictEqual(historyError.kind, 'responses-history');
  assert.deepStrictEqual(historyError.inputTypes, ['text']);
  assert.strictEqual(historyError.userMessage, FRIENDLY_HISTORY_ERROR);
  assert.strictEqual(historyError.rawMessage, ARRAY_TOO_LONG_ERROR_CURRENT);

  const unknownInputError = classifyCodexInputCompatibilityError(ARRAY_TOO_LONG_ERROR, []);
  assert(unknownInputError, 'the exact provider schema rejection should classify without current input metadata');
  assert.strictEqual(unknownInputError.code, 'session_responses_history_incompatible');

  const unknownParameterError = classifyCodexInputCompatibilityError(
    UNKNOWN_INPUT_CONTENT_PARAMETER_ERROR,
    ['text']
  );
  assert(unknownParameterError, 'an unknown input[n].content parameter should classify as a history schema rejection');
  assert.strictEqual(unknownParameterError.code, 'session_responses_history_incompatible');
  assert.strictEqual(unknownParameterError.rawMessage, UNKNOWN_INPUT_CONTENT_PARAMETER_ERROR);
  assert.strictEqual(
    classifyCodexInputCompatibilityError(
      "Unknown parameter: 'model'. The diagnostic mentions input[92].content elsewhere.",
      ['text']
    ),
    null,
    'an unrelated unknown parameter must not be classified as an input history schema rejection'
  );

  const currentImageError = classifyCodexInputCompatibilityError(
    ARRAY_TOO_LONG_ERROR_CURRENT,
    ['text', 'localImage']
  );
  assert.strictEqual(currentImageError?.code, 'session_input_image_unsupported');
  assert(
    classifyCodexInputCompatibilityError('This model does not support image input.', ['localImage']),
    'the explicit capability wording should classify local image input'
  );
  assert.strictEqual(
    classifyCodexInputCompatibilityError('Invalid input content array.', ['image']),
    null,
    'a vague content error must not be guessed as an image capability error'
  );
  assert.strictEqual(
    isModelMetadataFallbackNotice('Model metadata for gpt-5.6-luna not found'),
    true
  );
  assert.strictEqual(
    isModelMetadataFallbackNotice(
      'Model metadata for `gpt-4o-audio-preview` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'
    ),
    true
  );
  assert.strictEqual(isModelMetadataFallbackNotice('provider request failed'), false);
}

function makeRunner(events, baseHome) {
  const runner = new CodexAppServerRunner({
    hostId: 'input-error-test-host',
    sessionId: 'input-error-test-session',
    bridgeSessionId: 'input-error-test-session',
    runId: 'input-error-test-run',
    title: 'Input error classification',
    cwd: process.cwd(),
    launchMode: 'fresh',
    codexHome: baseHome,
    postEvent: async (event) => events.push(event),
  });
  runner.threadId = 'input-error-test-thread';
  runner.sessionId = runner.threadId;
  runner.nativeThreadId = runner.threadId;
  runner.runtime.nativeThreadId = runner.threadId;
  // The test targets turn/start rejection; rollout publication is unrelated.
  runner.publishManagedSessionRollout = async () => ({
    published: false,
    becameNativeResumeReady: false,
  });
  return runner;
}

async function verifySynchronousTurnStartRejection() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-input-errors-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  const runner = makeRunner(events, baseHome);
  runner.rpc = {
    request: async (method) => {
      assert.strictEqual(method, 'turn/start');
      throw new Error(ARRAY_TOO_LONG_ERROR);
    },
  };

  try {
    await assert.rejects(
      runner.sendInput('include the attached image', {
        clientRequestId: 'image-request',
        inputItems: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
      }),
      (error) => {
        assert.strictEqual(error.code, 'session_input_image_unsupported');
        assert.strictEqual(error.message, FRIENDLY_IMAGE_ERROR);
        assert.strictEqual(error.userFacingMessage, FRIENDLY_IMAGE_ERROR);
        assert.strictEqual(error.rawMessage, ARRAY_TOO_LONG_ERROR);
        assert.deepStrictEqual(error.inputCapabilityError.inputTypes, ['text', 'image']);
        return true;
      }
    );
    const diagnostics = events.filter((event) => event.type === 'session.diagnostic');
    assert.strictEqual(diagnostics.length, 1, 'a sync image rejection should emit one diagnostic');
    assert.strictEqual(diagnostics[0].kind, 'input-capability');
    assert.strictEqual(diagnostics[0].message, FRIENDLY_IMAGE_ERROR);
    assert.strictEqual(diagnostics[0].detail, ARRAY_TOO_LONG_ERROR);
    assert.strictEqual(diagnostics[0].data.code, 'session_input_image_unsupported');
    assert.deepStrictEqual(diagnostics[0].data.inputTypes, ['text', 'image']);

    const textOnlyEvents = [];
    const textOnlyRunner = makeRunner(textOnlyEvents, baseHome);
    textOnlyRunner.rpc = {
      request: async () => {
        throw new Error(ARRAY_TOO_LONG_ERROR);
      },
    };
    try {
      await assert.rejects(
        textOnlyRunner.sendInput('text only', { clientRequestId: 'text-request' }),
        (error) => {
          assert.strictEqual(error.code, 'session_responses_history_incompatible');
          assert.strictEqual(error.message, FRIENDLY_HISTORY_ERROR);
          assert.strictEqual(error.userFacingMessage, FRIENDLY_HISTORY_ERROR);
          assert.strictEqual(error.rawMessage, ARRAY_TOO_LONG_ERROR);
          assert.strictEqual(
            error.inputCapabilityError?.code,
            'session_responses_history_incompatible'
          );
          assert.deepStrictEqual(error.inputCapabilityError?.inputTypes, ['text']);
          return true;
        }
      );
      assert.strictEqual(
        textOnlyEvents.filter((event) => event.type === 'session.diagnostic').length,
        1,
        'a text-only Responses history rejection should emit one compatibility diagnostic'
      );
    } finally {
      textOnlyRunner.cleanupManagedOverlay();
    }
  } finally {
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function verifyAsynchronousProviderRejection() {
  const baseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-input-errors-async-'));
  fs.writeFileSync(path.join(baseHome, 'auth.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(baseHome, 'config.toml'), '', 'utf8');
  const events = [];
  const runner = makeRunner(events, baseHome);
  const turnId = 'history-incompatible-turn';
  const clientRequestId = 'history-incompatible-request';
  runner.activeTurnId = turnId;
  runner.activeTurnLifecycleId = turnId;
  runner.activeClientRequestId = clientRequestId;
  runner.clientRequestIdsByTurn.set(turnId, clientRequestId);
  runner.turnInputTypes.set(turnId, ['text']);
  runner.resetTurnBuffer(turnId);
  Object.assign(runner.runtime, {
    activeTurnId: turnId,
    busy: true,
    phase: 'thinking',
    currentTurnStatus: 'inProgress',
  });

  try {
    await runner.handleNotification({
      method: 'error',
      params: {
        turnId,
        willRetry: true,
        error: {
          message: ARRAY_TOO_LONG_ERROR_CURRENT,
          codexErrorInfo: { responseStreamDisconnected: {} },
        },
      },
    });
    const retryAlert = events.find((event) => event.type === 'session.alert');
    assert.strictEqual(retryAlert?.message, FRIENDLY_HISTORY_ERROR);
    assert.strictEqual(retryAlert?.transient, true);
    assert.strictEqual(
      retryAlert?.inputCapabilityError?.code,
      'session_responses_history_incompatible'
    );
    assert.strictEqual(retryAlert?.inputCapabilityError?.rawMessage, ARRAY_TOO_LONG_ERROR_CURRENT);
    assert.strictEqual(runner.runtime.userFacingError, FRIENDLY_HISTORY_ERROR);

    await runner.handleNotification({
      method: 'error',
      params: {
        turnId,
        willRetry: false,
        error: {
          message: ARRAY_TOO_LONG_ERROR_CURRENT,
          codexErrorInfo: 'other',
        },
      },
    });
    const terminalError = [...events].reverse().find((event) => event.type === 'session.error');
    assert.strictEqual(terminalError?.message, ARRAY_TOO_LONG_ERROR_CURRENT);
    assert.strictEqual(
      terminalError?.inputCapabilityError?.userMessage,
      FRIENDLY_HISTORY_ERROR
    );
    assert.strictEqual(runner.runtime.lastCodexError, 'session_responses_history_incompatible');
    assert.strictEqual(runner.runtime.userFacingError, FRIENDLY_HISTORY_ERROR);
  } finally {
    runner.cleanupManagedOverlay();
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

async function main() {
  verifyClassifier();
  await verifySynchronousTurnStartRejection();
  await verifyAsynchronousProviderRejection();
  console.log('codex input error assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
