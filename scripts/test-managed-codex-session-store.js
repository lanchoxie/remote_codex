const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  STORE_MARKER_NAME,
  STORE_ROOT_NAME,
  prepareManagedCodexSessionStore,
} = require('../apps/host-agent/managed-codex-session-store');
const {
  initializeTimeoutForLaunchMode,
  threadOpenTimeoutForLaunchMode,
} = require('../apps/host-agent/managed-codex-launch-policy');

const TEST_TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });

function rolloutRelativePath(threadId, ordinal = 0) {
  const second = String(ordinal % 60).padStart(2, '0');
  return path.join(
    '2026',
    '08',
    '16',
    `rollout-2026-08-16T20-00-${second}-${threadId}.jsonl`
  );
}

function writeRollout(codexHome, threadId, ordinal = 0, extra = '') {
  const relative = rolloutRelativePath(threadId, ordinal);
  const target = path.join(codexHome, 'sessions', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    timestamp: '2026-08-16T20:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, cwd: 'D:/workspace' },
  })}\n${extra}`, 'utf8');
  return { relative, target };
}

function uuid(index) {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function writeSessionIndex(codexHome, rows) {
  fs.writeFileSync(
    path.join(codexHome, 'session_index.jsonl'),
    `${rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n')}\n`,
    'utf8'
  );
}

function visibleRollouts(store) {
  const root = store.sessionsDirectory;
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(target);
    }
  };
  visit(root);
  return result;
}

function verifyFreshStoreDoesNotExposeGlobalHistory() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-fresh-'));
  try {
    const unrelated = writeRollout(baseHome, uuid(1));
    writeSessionIndex(baseHome, [
      { id: uuid(1), thread_name: 'unrelated global Session' },
    ]);
    const store = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'logical-fresh',
      launchMode: 'fresh',
    });
    const overlay = path.join(baseHome, 'overlay');
    fs.mkdirSync(overlay);
    store.attachToOverlay(overlay);
    assert.deepStrictEqual(visibleRollouts(store), []);
    assert.strictEqual(fs.existsSync(path.join(overlay, 'sessions', unrelated.relative)), false);
    assert.strictEqual(
      fs.existsSync(path.join(overlay, 'session_index.jsonl')),
      false,
      'Fresh must not expose the global Session index'
    );
    assert.notStrictEqual(
      fs.realpathSync(path.join(overlay, 'sessions')),
      fs.realpathSync(path.join(baseHome, 'sessions')),
      'Fresh must not attach the global history directory'
    );
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyFreshRolloutSurvivesOverlayCleanup() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-publish-'));
  try {
    const threadId = uuid(2);
    const store = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'logical-publish',
      launchMode: 'fresh',
    });
    const overlay = path.join(baseHome, 'overlay');
    fs.mkdirSync(overlay);
    store.attachToOverlay(overlay);
    const rollout = writeRollout(overlay, threadId, 2, '{"type":"response_item"}\n');
    const published = store.publishNativeThread(threadId);
    assert.strictEqual(published.published, true);
    fs.rmSync(overlay, { recursive: true, force: true });
    const durable = path.join(baseHome, 'sessions', rollout.relative);
    assert.strictEqual(fs.existsSync(durable), true);
    assert.match(fs.readFileSync(durable, 'utf8'), /response_item/);
    assert.strictEqual(fs.existsSync(store.storeDirectory), true);
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyResumeImportsOnlyTargetRollout() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-resume-'));
  try {
    for (let index = 10; index < 1010; index += 1) {
      writeRollout(baseHome, uuid(index), index);
    }
    const targetThreadId = uuid(700);
    writeSessionIndex(baseHome, [
      { id: uuid(10), thread_name: 'unrelated first row' },
      '{invalid-json',
      { id: targetThreadId, thread_name: 'target row' },
      { id: uuid(11), thread_name: 'unrelated last row' },
    ]);
    const store = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: targetThreadId,
      nativeThreadId: targetThreadId,
      launchMode: 'resume',
    });
    const rollouts = visibleRollouts(store);
    assert.strictEqual(rollouts.length, 1, 'Resume must expose only its target rollout');
    assert.match(path.basename(rollouts[0]), new RegExp(targetThreadId));
    assert(store.seedResult);
    const overlay = path.join(baseHome, 'overlay');
    fs.mkdirSync(overlay);
    store.attachToOverlay(overlay);
    const scopedIndexRows = fs.readFileSync(path.join(overlay, 'session_index.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepStrictEqual(scopedIndexRows, [
      { id: targetThreadId, thread_name: 'target row' },
    ]);
    assert.deepStrictEqual(store.sessionIndexResult, {
      written: true,
      rowCount: 1,
      indexPath: path.join(overlay, 'session_index.jsonl'),
    });
    if (store.seedResult.mode === 'hardlink') {
      const baseRollout = path.join(baseHome, 'sessions', rolloutRelativePath(targetThreadId, 700));
      const baseStats = fs.statSync(baseRollout);
      const storeStats = fs.statSync(rollouts[0]);
      assert.strictEqual(storeStats.dev, baseStats.dev);
      assert.strictEqual(storeStats.ino, baseStats.ino);
    }
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyTranscriptFallbackStartsWithoutSourceRollout() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-transcript-fallback-'));
  try {
    const sourceThreadId = uuid(3);
    writeRollout(baseHome, sourceThreadId, 3);
    const store = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'logical-transcript-fallback',
      nativeThreadId: sourceThreadId,
      launchMode: 'transcript_fallback',
    });
    assert.deepStrictEqual(visibleRollouts(store), []);
    assert.strictEqual(store.seedResult, null);
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyStoreIdentityAndMarkerSafety() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-identity-'));
  try {
    const first = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'stable-session',
      launchMode: 'fresh',
      apiConfig: { apiKey: 'must-not-be-persisted' },
    });
    const second = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'stable-session',
      launchMode: 'resume',
      apiConfig: { apiKey: 'rotated-secret' },
    });
    const other = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'other-session',
      launchMode: 'fresh',
    });
    assert.strictEqual(first.storeDirectory, second.storeDirectory);
    assert.notStrictEqual(first.storeDirectory, other.storeDirectory);
    const markerText = fs.readFileSync(path.join(first.storeDirectory, STORE_MARKER_NAME), 'utf8');
    assert.strictEqual(markerText.includes('must-not-be-persisted'), false);
    assert.strictEqual(markerText.includes('rotated-secret'), false);

    const marker = JSON.parse(markerText);
    marker.logicalSessionId = 'tampered-session';
    fs.writeFileSync(path.join(first.storeDirectory, STORE_MARKER_NAME), JSON.stringify(marker), 'utf8');
    assert.throws(
      () => prepareManagedCodexSessionStore({
        baseCodexHome: baseHome,
        hostId: 'host-a',
        sessionId: 'stable-session',
      }),
      (error) => error?.code === 'session_store_marker_mismatch'
    );
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyUnsafeStoreRootFailsClosed() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-linked-root-'));
  const outside = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-linked-outside-'));
  const root = path.join(baseHome, STORE_ROOT_NAME);
  fs.symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(
      () => prepareManagedCodexSessionStore({
        baseCodexHome: baseHome,
        hostId: 'host-a',
        sessionId: 'linked-root',
      }),
      (error) => error?.code === 'session_store_unsafe_path'
    );
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  } finally {
    try {
      fs.unlinkSync(root);
    } catch {
      // Isolated fixture roots are removed below.
    }
    fs.rmSync(baseHome, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function verifyMissingBaseHomeFailsClosed() {
  assert.throws(
    () => prepareManagedCodexSessionStore({
      hostId: 'host-a',
      sessionId: 'missing-home',
      launchMode: 'fresh',
    }),
    (error) => error?.code === 'session_store_home_missing'
  );
  assert.throws(
    () => prepareManagedCodexSessionStore({
      baseCodexHome: '   ',
      hostId: 'host-a',
      sessionId: 'blank-home',
      launchMode: 'fresh',
    }),
    (error) => error?.code === 'session_store_home_missing'
  );

  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-missing-overlay-'));
  try {
    const store = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'missing-overlay',
      launchMode: 'fresh',
    });
    assert.throws(
      () => store.attachToOverlay(''),
      (error) => error?.code === 'session_store_overlay_missing'
    );
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyLinkedBaseSessionsRootFailsClosed() {
  for (const launchMode of ['fresh', 'transcript_fallback', 'resume', 'fork', 'fresh_rebind']) {
    const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-linked-sessions-'));
    const outside = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-linked-history-'));
    const sessionsRoot = path.join(baseHome, 'sessions');
    fs.symlinkSync(outside, sessionsRoot, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      assert.throws(
        () => prepareManagedCodexSessionStore({
          baseCodexHome: baseHome,
          hostId: 'host-a',
          sessionId: uuid(6),
          nativeThreadId: uuid(6),
          launchMode,
        }),
        (error) => error?.code === 'session_store_unsafe_path',
        `${launchMode} must reject a linked base sessions root before launch`
      );
      assert.strictEqual(
        fs.existsSync(path.join(baseHome, STORE_ROOT_NAME)),
        false,
        'unsafe base history must be rejected before creating managed state'
      );
    } finally {
      try {
        fs.unlinkSync(sessionsRoot);
      } catch {
        // Isolated fixture roots are removed below.
      }
      fs.rmSync(baseHome, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
}

function verifyLinkedPublishDestinationFailsClosed() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-linked-publish-'));
  const outside = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-linked-destination-'));
  try {
    const threadId = uuid(7);
    const store = prepareManagedCodexSessionStore({
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: 'linked-publish',
      launchMode: 'fresh',
    });
    const stored = writeRollout(store.storeCodexHome, threadId, 7);
    const destination = path.join(baseHome, 'sessions', stored.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => store.publishNativeThread(threadId),
      (error) => error?.code === 'session_store_unsafe_rollout'
    );
    assert.deepStrictEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(destination);
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function copyOnlyFileOptions() {
  return {
    linkFileSync() {
      const error = new Error('hardlinks disabled by test fixture');
      error.code = 'EPERM';
      throw error;
    },
  };
}

function verifyCopyFallbackPublishesKnownContinuation() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-copy-publish-'));
  try {
    const threadId = uuid(4);
    const base = writeRollout(baseHome, threadId, 4);
    const options = {
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: threadId,
      nativeThreadId: threadId,
      launchMode: 'resume',
      ...copyOnlyFileOptions(),
    };
    const store = prepareManagedCodexSessionStore(options);
    assert.strictEqual(store.seedResult?.mode, 'copy');
    assert.strictEqual(store.seedResult?.rolloutPath === base.target, false);
    fs.appendFileSync(store.seedResult.rolloutPath, '{"type":"response_item","payload":"managed"}\n');

    const published = store.publishNativeThread(threadId);
    assert.strictEqual(published.published, true);
    assert.strictEqual(published.mode, 'copy-sync');
    assert.match(fs.readFileSync(base.target, 'utf8'), /managed/);

    const resumed = prepareManagedCodexSessionStore(options);
    assert.strictEqual(resumed.seedResult?.mode, 'existing-copy');
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyCopyFallbackReconcilesOnlyOneKnownContinuation() {
  const baseHome = fs.mkdtempSync(path.join(TEST_TMP_ROOT, 'managed-codex-copy-reconcile-'));
  try {
    const threadId = uuid(5);
    const base = writeRollout(baseHome, threadId, 5);
    const options = {
      baseCodexHome: baseHome,
      hostId: 'host-a',
      sessionId: threadId,
      nativeThreadId: threadId,
      launchMode: 'resume',
      ...copyOnlyFileOptions(),
    };
    const seeded = prepareManagedCodexSessionStore(options);
    fs.appendFileSync(base.target, '{"type":"response_item","payload":"base-only"}\n');

    const refreshed = prepareManagedCodexSessionStore(options);
    assert.strictEqual(refreshed.seedResult?.mode, 'copy-refresh');
    assert.match(fs.readFileSync(refreshed.seedResult.rolloutPath, 'utf8'), /base-only/);

    fs.appendFileSync(base.target, '{"type":"response_item","payload":"base-diverged"}\n');
    fs.appendFileSync(refreshed.seedResult.rolloutPath, '{"type":"response_item","payload":"store-diverged"}\n');
    assert.throws(
      () => prepareManagedCodexSessionStore(options),
      (error) => error?.code === 'session_store_rollout_conflict'
    );
    assert.match(fs.readFileSync(base.target, 'utf8'), /base-diverged/);
    assert.match(fs.readFileSync(refreshed.seedResult.rolloutPath, 'utf8'), /store-diverged/);
  } finally {
    fs.rmSync(baseHome, { recursive: true, force: true });
  }
}

function verifyLaunchSpecificInitializeTimeouts() {
  assert.strictEqual(initializeTimeoutForLaunchMode('fresh', {}), 60_000);
  assert.strictEqual(initializeTimeoutForLaunchMode('transcript_fallback', {}), 60_000);
  assert.strictEqual(initializeTimeoutForLaunchMode('resume', {}), 180_000);
  assert.strictEqual(initializeTimeoutForLaunchMode('fork', {}), 180_000);
  assert.strictEqual(initializeTimeoutForLaunchMode('fresh_rebind', {}), 180_000);
  assert.strictEqual(
    initializeTimeoutForLaunchMode('fresh', { CODEX_RPC_INITIALIZE_FRESH_TIMEOUT_MS: '1234' }),
    1234
  );
  assert.strictEqual(
    initializeTimeoutForLaunchMode('resume', { CODEX_RPC_INITIALIZE_RESUME_TIMEOUT_MS: '5678' }),
    5678
  );
  assert.strictEqual(
    initializeTimeoutForLaunchMode('resume', { CODEX_RPC_INITIALIZE_TIMEOUT_MS: '4321' }),
    4321,
    'the legacy override remains a compatibility fallback'
  );
  assert.strictEqual(threadOpenTimeoutForLaunchMode('fresh', {}), 60_000);
  assert.strictEqual(threadOpenTimeoutForLaunchMode('transcript_fallback', {}), 60_000);
  assert.strictEqual(threadOpenTimeoutForLaunchMode('resume', {}), 180_000);
  assert.strictEqual(threadOpenTimeoutForLaunchMode('fork', {}), 180_000);
  assert.strictEqual(threadOpenTimeoutForLaunchMode('fresh_rebind', {}), 180_000);
  assert.strictEqual(
    threadOpenTimeoutForLaunchMode('fresh', { CODEX_RPC_THREAD_OPEN_FRESH_TIMEOUT_MS: '2468' }),
    2468
  );
  assert.strictEqual(
    threadOpenTimeoutForLaunchMode('resume', { CODEX_RPC_THREAD_OPEN_RESUME_TIMEOUT_MS: '8642' }),
    8642
  );
  assert.strictEqual(
    threadOpenTimeoutForLaunchMode('resume', { CODEX_RPC_THREAD_OPEN_TIMEOUT_MS: '9753' }),
    9753,
    'the legacy thread-open override remains a compatibility fallback'
  );
}

verifyFreshStoreDoesNotExposeGlobalHistory();
verifyFreshRolloutSurvivesOverlayCleanup();
verifyResumeImportsOnlyTargetRollout();
verifyTranscriptFallbackStartsWithoutSourceRollout();
verifyStoreIdentityAndMarkerSafety();
verifyUnsafeStoreRootFailsClosed();
verifyMissingBaseHomeFailsClosed();
verifyLinkedBaseSessionsRootFailsClosed();
verifyLinkedPublishDestinationFailsClosed();
verifyCopyFallbackPublishesKnownContinuation();
verifyCopyFallbackReconcilesOnlyOneKnownContinuation();
verifyLaunchSpecificInitializeTimeouts();
console.log('managed Codex Session store assertions passed');
