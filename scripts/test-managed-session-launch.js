const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeLaunchReceipt,
  decodePersistedLaunchReceipt,
  classifyLaunchObservation,
} = require('../apps/mobile-web/public/managed-session-launch');
const {
  createLaunchIntentKey,
  normalizeLaunchPath,
} = require('../apps/mobile-web/public/managed-session-launch-intent');

const acceptedAtMs = Date.parse('2026-08-16T12:00:00.000Z');

function receipt(overrides = {}) {
  return normalizeLaunchReceipt({
    ok: true,
    hostId: 'host-a',
    sessionId: 'session-a',
    bridgeSessionId: 'session-a',
    runId: 'run-a',
    launchMode: 'fresh',
    acceptedAtMs,
    ...overrides,
  });
}

function classify(receiptValue, overrides = {}) {
  return classifyLaunchObservation(receiptValue, {
    sessions: [],
    runtimeConfig: null,
    now: acceptedAtMs + 1_000,
    softTimeoutMs: 10_000,
    ...overrides,
  });
}

function main() {
  const normalized = normalizeLaunchReceipt({
    hostId: 'host-a',
    sessionId: 'session-a',
    runId: 'run-a',
    apiKey: 'top-level-secret',
    apiConfig: { apiKey: 'nested-secret' },
    command: {
      clientRequestId: 'request-a',
      createdAt: '2026-08-16T12:00:00.000Z',
      apiConfig: { apiKey: 'command-secret' },
    },
  }, {
    intentKey: '["host-a","D:/workspace","fresh",""]',
    cwd: 'D:/workspace',
    label: 'Workspace',
    rebindTargetKind: 'profile',
    rebindProfileId: 'profile-b',
    rebindProvider: 'MineMine',
    rebindProviderKind: 'openai',
    rebindCompatibilityKey: 'Shared-Sub2API-Gateway',
    rebindBaseUrl: 'https://api.example/v1?region=x&api_key=url-secret#fragment',
  });
  assert.strictEqual(normalized.clientRequestId, 'request-a');
  assert.strictEqual(normalized.acceptedAtMs, acceptedAtMs);
  assert(!Object.prototype.hasOwnProperty.call(normalized, 'apiConfig'));
  assert(!Object.prototype.hasOwnProperty.call(normalized, 'apiKey'));
  assert(!JSON.stringify(normalized).includes('secret'), 'normalized receipts must be capability-free');
  assert.strictEqual(normalized.cwd, 'D:/workspace');
  assert.strictEqual(normalized.label, 'Workspace');
  assert.strictEqual(normalized.rebindProfileId, 'profile-b');
  assert.strictEqual(normalized.rebindProvider, 'MineMine');
  assert.strictEqual(normalized.rebindCompatibilityKey, 'shared-sub2api-gateway');
  assert.strictEqual(normalized.rebindBaseUrl, 'https://api.example/v1?region=x');
  assert.match(normalized.intentKey, /host-a/);
  assert(!JSON.stringify(normalized).includes('url-secret'));
  assert.strictEqual(
    normalizeLaunchReceipt({
      hostId: 'host-a',
      sessionId: 'session-a',
      runId: 'run-a',
      rebindBaseUrl: 'https://user:password@example.test/v1',
    }).rebindBaseUrl,
    null,
    'URL userinfo must never be persisted in a receipt'
  );
  assert.strictEqual(
    normalizeLaunchReceipt({
      hostId: 'host-a',
      sessionId: 'session-a',
      runId: 'run-a',
      rebindBaseUrl: 'not a URL with token=secret',
    }).rebindBaseUrl,
    null,
    'invalid Rebind URLs must fail closed rather than persist raw text'
  );

  assert.strictEqual(
    decodePersistedLaunchReceipt(normalized, { now: acceptedAtMs + 1_000 })?.runId,
    'run-a'
  );
  assert.strictEqual(
    decodePersistedLaunchReceipt({ ...normalized, version: 99 }, { now: acceptedAtMs + 1_000 }),
    null,
    'unknown receipt versions must not be recovered'
  );
  assert.strictEqual(
    decodePersistedLaunchReceipt({ ...normalized, acceptedAt: null, acceptedAtMs: null }, { now: acceptedAtMs + 1_000 }),
    null,
    'a persisted receipt without its original acceptance time must not be renewed'
  );
  assert.strictEqual(
    decodePersistedLaunchReceipt(normalized, { now: acceptedAtMs + 20_000, maxAgeMs: 10_000 }),
    null,
    'expired receipts must not regain a new lifetime'
  );
  assert.strictEqual(
    decodePersistedLaunchReceipt(
      { ...normalized, acceptedAtMs: acceptedAtMs + (6 * 60 * 1_000), acceptedAt: null },
      { now: acceptedAtMs }
    ),
    null,
    'implausibly future-dated receipts must fail closed'
  );

  assert.strictEqual(
    classify(receipt(), {
      runtimeConfig: {
        hostId: 'host-a',
        sessionId: 'session-a',
        activeRunId: 'run-a',
        pendingRun: { runId: 'run-a', status: 'pending' },
      },
    }).status,
    'pending'
  );
  assert.strictEqual(
    classify(receipt(), {
      now: acceptedAtMs + 10_000,
      runtimeConfig: {
        hostId: 'host-a',
        sessionId: 'session-a',
        activeRunId: 'run-a',
        pendingRun: { runId: 'run-a', status: 'pending' },
      },
      sessions: [{ hostId: 'host-a', sessionId: 'session-a', runId: 'run-a', live: true }],
    }).status,
    'slow',
    'an exact durable pending run must outrank a prematurely live list projection'
  );
  assert.strictEqual(
    classify(receipt(), {
      runtimeConfig: {
        hostId: 'host-a',
        sessionId: 'session-a',
        runId: 'run-a',
        activeRunId: 'run-a',
        runStatus: 'live',
      },
      sessions: [{ hostId: 'host-a', sessionId: 'session-a', runId: 'run-a', state: 'failed' }],
    }).status,
    'live',
    'an exact durable live run must outrank a stale terminal list projection'
  );
  assert.strictEqual(
    classify(receipt(), {
      runtimeConfig: {
        hostId: 'host-a',
        sessionId: 'session-a',
        runId: 'run-a',
        activeRunId: 'run-a',
        runStatus: 'failed',
      },
    }).status,
    'failed'
  );
  assert.strictEqual(
    classify(receipt(), {
      sessions: [{
        hostId: 'host-a',
        sessionId: 'session-a',
        runId: 'run-a',
        state: 'failed: app-server exited',
        live: false,
      }],
    }).status,
    'failed',
    'an explicit terminal projection is terminal only when its run identity is exact'
  );
  assert.strictEqual(
    classify(receipt(), {
      now: acceptedAtMs + 9_999,
      sessions: [],
    }).status,
    'pending',
    'a missing list entry before the soft deadline is not a failure'
  );
  assert.strictEqual(
    classify(receipt(), {
      now: acceptedAtMs + 10_000,
      sessions: [],
    }).status,
    'indeterminate',
    'a missing list entry after the soft deadline remains non-terminal'
  );
  assert.strictEqual(
    classify(receipt(), {
      now: acceptedAtMs + 10_000,
      sessions: [{ hostId: 'host-a', sessionId: 'session-a', state: 'starting', live: false }],
    }).status,
    'slow',
    'an identity-only starting projection may describe slowness but never failure'
  );
  assert.strictEqual(
    classify(receipt(), {
      runtimeConfig: {
        hostId: 'host-a',
        sessionId: 'session-a',
        runId: 'run-b',
        activeRunId: 'run-b',
        runStatus: 'live',
      },
    }).status,
    'conflict',
    'a different authoritative active run is an identity conflict'
  );
  assert.strictEqual(
    classify(receipt(), {
      now: acceptedAtMs + 10_000,
      sessions: [{ hostId: 'host-a', sessionId: 'session-a', runId: 'run-b', state: 'failed' }],
    }).status,
    'indeterminate',
    'a terminal projection for a different run must never fail the accepted run'
  );
  assert.strictEqual(
    classify(receipt(), {
      now: acceptedAtMs + 10_000,
      sessions: [{
        hostId: 'host-a',
        sessionId: 'session-a',
        runId: 'run-a',
        state: 'starting',
        live: false,
        resumeError: { code: 'stale-previous-run' },
      }],
    }).status,
    'slow',
    'a stale Resume error must not turn the exact starting run into a terminal failure'
  );
  assert.strictEqual(
    classify(normalizeLaunchReceipt({ sessionId: 'session-a' }, { now: acceptedAtMs })).status,
    'indeterminate',
    'a receipt without an accepted run identity cannot be classified'
  );

  assert.strictEqual(normalizeLaunchPath('D:\\Work\\Repo', 'win32'), 'd:/work/repo');
  assert.strictEqual(normalizeLaunchPath('D:\\', 'win32'), 'd:/');
  assert.strictEqual(normalizeLaunchPath('\\\\Server\\Share', 'windows'), '//server/share');
  assert.strictEqual(normalizeLaunchPath('/Work/Repo', 'linux'), '/Work/Repo');
  assert.notStrictEqual(
    createLaunchIntentKey({ hostId: 'linux-a', hostPlatform: 'linux', cwd: '/Work/Repo' }),
    createLaunchIntentKey({ hostId: 'linux-a', hostPlatform: 'linux', cwd: '/work/repo' }),
    'case-distinct POSIX paths must never share a launch intent'
  );
  assert.strictEqual(
    createLaunchIntentKey({ hostId: 'win-a', hostPlatform: 'win32', cwd: 'D:\\Work\\Repo' }),
    createLaunchIntentKey({ hostId: 'win-a', hostPlatform: 'windows', cwd: 'd:/work/repo/' }),
    'Windows launch intents must case-fold equivalent paths'
  );

  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'apps/mobile-web/public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'apps/mobile-web/public/app.js'), 'utf8');
  const moduleIndex = html.indexOf('/managed-session-launch.js');
  const intentIndex = html.indexOf('/managed-session-launch-intent.js');
  const coordinatorIndex = html.indexOf('/managed-session-launch-coordinator.js');
  const storageIndex = html.indexOf('/managed-session-launch-storage.js');
  const appIndex = html.indexOf('/app.js');
  assert(moduleIndex >= 0, 'index.html must load the managed Session launch policy module');
  assert(intentIndex >= 0, 'index.html must load the extracted launch intent module');
  assert(coordinatorIndex >= 0, 'index.html must load the managed Session launch coordinator module');
  assert(moduleIndex < appIndex, 'the launch policy module must load before app.js');
  assert(moduleIndex < coordinatorIndex, 'the launch policy must load before its coordinator');
  assert(intentIndex < appIndex, 'the launch intent module must load before app.js');
  assert(coordinatorIndex < appIndex, 'the launch coordinator must load before app.js');
  assert(storageIndex >= 0 && storageIndex < appIndex, 'the HTTP coordination storage module must load before app.js');
  assert(!app.includes('decodePersistedLaunchReceipt'), 'app restoration must use the canonical Coordinator decoder');
  assert(!app.includes('persistManagedLaunchReceipts'), 'app.js must not perform unlocked whole-ledger writes');
  assert.match(
    app,
    /function requireRelayLogin\(message = ''\) \{\s+getManagedSessionLaunchCoordinator\(\)\.pause\(null, 'authentication-required'\);/,
    'a Relay 401 must pause accepted-run observation without deleting its receipt'
  );
  assert.match(
    app,
    /async function loginRelay\([^)]*\) \{[\s\S]*?getManagedSessionLaunchCoordinator\(\)\.resumeAuthentication\(\);\s+await recoverManagedLaunchReceipts\(\);/,
    'successful login must resume observation of the already accepted run'
  );
  assert.match(
    app,
    /function withManagedLaunchIntentLock\(intentKey, operation\) \{[\s\S]*?getManagedLaunchStorage\(\)\.withIntent/,
    'ordinary HTTP must use durable submission intents while retaining Web Locks where available'
  );

  console.log('managed Session launch policy tests passed');
}

main();
