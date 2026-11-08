const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  attachAskpassOutcome,
  buildWindowsAskpassPowerShell,
} = require('../apps/relay/connector-askpass');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js'), 'utf8');
const relaySource = fs.readFileSync(path.join(__dirname, '..', 'apps', 'relay', 'server.js'), 'utf8');

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function runAskpass(scriptPath, root, prompt, extraEnv = {}) {
  const statePath = path.join(root, `state-${Math.random().toString(16).slice(2)}.txt`);
  const outcomePath = path.join(root, `outcome-${Math.random().toString(16).slice(2)}.txt`);
  const result = spawnSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RC_ASKPASS_PROMPT: prompt,
      RC_ASKPASS_STATE_FILE: statePath,
      RC_ASKPASS_OUTCOME_FILE: outcomePath,
      ...extraEnv,
    },
    timeout: 15_000,
  });
  return { result, outcomePath, statePath };
}

function extractFunction(source, name, nextMarker) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(nextMarker, start);
  assert(start >= 0 && end > start, `${name} should be present`);
  return source.slice(start, end);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-askpass-'));
try {
  const script = buildWindowsAskpassPowerShell();
  const scriptPath = path.join(root, 'askpass.ps1');
  fs.writeFileSync(scriptPath, script, 'utf8');

  const staticAnswer = runAskpass(scriptPath, root, "alice@pi-host's password:", {
    RC_ASKPASS_PASSWORD_1_B64: base64('saved-password'),
    RC_ASKPASS_TARGET_HOST: 'pi-host',
    RC_ASKPASS_TARGET_PASSWORD_B64: base64('saved-password'),
    RC_ASKPASS_ONLY_PASSWORD_B64: base64('saved-password'),
    RC_ASKPASS_RELAY_URL: 'http://127.0.0.1:1',
    RC_ASKPASS_CONNECTOR_ID: 'pi',
    RC_ASKPASS_ACTION_ID: 'action',
    RC_ASKPASS_TOKEN: 'token',
  });
  assert.strictEqual(staticAnswer.result.status, 0, staticAnswer.result.stderr);
  assert.strictEqual(staticAnswer.result.stdout, 'saved-password');
  assert.strictEqual(
    attachAskpassOutcome({}, {
      RC_ASKPASS_OUTCOME_FILE: staticAnswer.outcomePath,
      RC_ASKPASS_STATE_FILE: staticAnswer.statePath,
    }).askpassStatus,
    'static_answer'
  );
  assert(!fs.existsSync(staticAnswer.outcomePath), 'consuming an AskPass outcome should remove its diagnostic file');
  assert(!fs.existsSync(staticAnswer.statePath), 'completing an SSH process should remove its AskPass response index');

  const otpAnswer = runAskpass(scriptPath, root, 'Verification code (OTP):', {
    RC_ASKPASS_PASSWORD_1_B64: base64('must-not-be-used-for-otp'),
    RC_ASKPASS_RELAY_URL: 'http://127.0.0.1:1',
    RC_ASKPASS_CONNECTOR_ID: 'pi',
    RC_ASKPASS_ACTION_ID: 'action',
    RC_ASKPASS_TOKEN: 'token',
  });
  assert.notStrictEqual(otpAnswer.result.status, 0, 'OTP prompts should require the browser broker');
  assert.strictEqual(otpAnswer.result.stdout, '');
  assert.strictEqual(
    attachAskpassOutcome({}, {
      RC_ASKPASS_OUTCOME_FILE: otpAnswer.outcomePath,
      RC_ASKPASS_STATE_FILE: otpAnswer.statePath,
    }).askpassStatus,
    'askpass_unavailable'
  );

  const missingAnswer = runAskpass(scriptPath, root, 'Password:');
  assert.notStrictEqual(missingAnswer.result.status, 0);
  assert.strictEqual(
    attachAskpassOutcome({}, {
      RC_ASKPASS_OUTCOME_FILE: missingAnswer.outcomePath,
      RC_ASKPASS_STATE_FILE: missingAnswer.statePath,
    }).askpassStatus,
    'askpass_missing_answer'
  );

  const timeoutOutcome = path.join(root, 'timeout-outcome.txt');
  fs.writeFileSync(timeoutOutcome, 'askpass_timeout', 'utf8');
  assert.strictEqual(
    attachAskpassOutcome({ exitCode: 255 }, { RC_ASKPASS_OUTCOME_FILE: timeoutOutcome }).askpassStatus,
    'askpass_timeout'
  );

  assert(
    relaySource.includes("status: 'askpass_timeout'")
      && relaySource.includes("reason: 'askpass_timeout'"),
    'Relay classification should preserve AskPass timeouts as their own failure reason'
  );

  const collectSecrets = extractFunction(
    appSource,
    'collectConnectorActionSecrets',
    'function connectorActionFailureText'
  );
  assert(
    collectSecrets.match(/connectorNeedsOneTimePrompt[\s\S]*?&& !passthrough/g)?.length >= 2,
    'browser passthrough should defer gateway and target one-time prompts until SSH requests them'
  );

  const reconcileSource = extractFunction(
    appSource,
    'reconcileConnectorActionResults',
    'async function waitForRecoveredHost'
  );
  const state = {
    hosts: [{ hostId: 'pi-host', label: 'Pi', online: false }],
    connectors: [{ connectorId: 'pi-connector', hostId: 'pi-host' }],
    connectorActionResults: new Map([['pi-connector', {
      ok: false,
      action: 'bootstrap',
      status: 'askpass_timeout',
      observedHostOnlineAtStart: false,
    }]]),
  };
  const reconcile = Function(
    'state',
    'prettyStatusLabel',
    `${reconcileSource}; return reconcileConnectorActionResults;`
  )(state, (value) => String(value || '').replace(/_/g, ' '));
  reconcile();
  assert.strictEqual(state.connectorActionResults.get('pi-connector').status, 'askpass_timeout');
  state.hosts[0].online = true;
  reconcile();
  assert.strictEqual(state.connectorActionResults.get('pi-connector').status, 'host_online_after_action');
  assert.strictEqual(state.connectorActionResults.get('pi-connector').resolvedFromStatus, 'askpass_timeout');

  console.log('connector AskPass priority and recovery assertions passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
