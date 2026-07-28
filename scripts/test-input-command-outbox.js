const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  InputCommandOutbox,
  isPersistableInputCommand,
} = require('../apps/relay/input-command-outbox');

function makeCommand(id, clientRequestId, overrides = {}) {
  return {
    type: 'session.input',
    id,
    createdAt: new Date(1_000 + id).toISOString(),
    priority: 0,
    clientRequestId,
    sessionId: 'native-session',
    requestedSessionId: 'visible-session',
    bridgeSessionId: 'bridge-session',
    conversationKey: 'canonical-session',
    runId: 'run-current',
    apiBinding: {
      kind: 'profile',
      profileId: 'profile-a',
      provider: 'OpenAI',
      providerKind: 'openai',
      normalizedBaseUrl: 'https://api.openai.com/v1',
    },
    expectedBinding: {
      kind: 'profile',
      profileId: 'profile-a',
      provider: 'OpenAI',
      providerKind: 'openai',
      normalizedBaseUrl: 'https://api.openai.com/v1',
    },
    text: `prompt-${id}`,
    inputItems: [{ type: 'mention', name: 'app.js', path: '/workspace/app.js' }],
    mode: null,
    model: 'gpt-test',
    effort: 'high',
    summary: 'auto',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxMode: 'workspaceWrite',
    planFallback: null,
    serviceTier: null,
    personality: null,
    ...overrides,
  };
}

function makeTranscriptProjection(command, overrides = {}) {
  return {
    sessionId: command.requestedSessionId || command.sessionId,
    text: command.text || '',
    files: [{
      fileId: `projection-file-${command.id}`,
      name: 'app.js',
      path: '/workspace/app.js',
      size: 128,
      mime: 'text/javascript',
      isImage: false,
      cached: true,
      uploadedAt: command.createdAt,
    }],
    timestamp: command.createdAt,
    clientRequestId: command.clientRequestId,
    deliveryStatus: 'pending',
    ...overrides,
  };
}

function queueInput(outbox, options = {}) {
  const id = options.id ?? 101;
  const clientRequestId = options.clientRequestId || `request-${id}`;
  const command = options.command || makeCommand(id, clientRequestId, options.commandOverrides);
  const input = {
    hostId: options.hostId || 'host-a',
    scopeKey: options.scopeKey || 'scope-a',
    clientRequestId,
    fingerprint: options.fingerprint || `fingerprint-${id}`,
    command,
  };
  if (options.omitTranscriptProjection !== true) {
    input.transcriptProjection = options.transcriptProjection
      || makeTranscriptProjection(command, options.transcriptProjectionOverrides);
  }
  return outbox.recordQueued(input);
}

function readRecords(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withTempRoot(label, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `input-command-outbox-${label}-`));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testRestartRecoveryAndEligibility() {
  withTempRoot('restart', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 10_000;
    const outbox = new InputCommandOutbox({ filePath, now: () => clock });
    assert.strictEqual(isPersistableInputCommand({ type: 'session.stop', clientRequestId: 'request-x' }), false);
    assert.strictEqual(isPersistableInputCommand({ type: 'session.input' }), false);
    assert.strictEqual(
      outbox.recordQueued({ command: { type: 'session.stop', clientRequestId: 'request-x' } }).reason,
      'ineligible'
    );
    assert.strictEqual(fs.existsSync(filePath), false, 'ineligible commands must not create the WAL');

    const recorded = queueInput(outbox, { id: 101, clientRequestId: 'request-restart' });
    assert.strictEqual(recorded.recorded, true);
    assert.strictEqual(recorded.entry.originalCommandId, 101);
    const linesBeforeDuplicate = readRecords(filePath).length;
    const duplicate = queueInput(outbox, { id: 101, clientRequestId: 'request-restart' });
    assert.strictEqual(duplicate.reason, 'duplicate');
    assert.strictEqual(readRecords(filePath).length, linesBeforeDuplicate, 'exact retries must not append another queued record');

    const restarted = new InputCommandOutbox({ filePath, now: () => clock });
    const recovered = restarted.getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 1);
    assert.strictEqual(recovered.pendingCommands[0].hostId, 'host-a');
    assert.strictEqual(recovered.pendingCommands[0].scopeKey, 'scope-a');
    assert.strictEqual(recovered.pendingCommands[0].clientRequestId, 'request-restart');
    assert.strictEqual(recovered.pendingCommands[0].fingerprint, 'fingerprint-101');
    assert.strictEqual(recovered.pendingCommands[0].originalCommandId, 101);
    assert.strictEqual(recovered.pendingCommands[0].command.text, 'prompt-101');
    assert.strictEqual(recovered.pendingCommands[0].transcriptProjection.sessionId, 'visible-session');
    assert.strictEqual(recovered.pendingCommands[0].transcriptProjection.deliveryStatus, 'pending');
    assert.strictEqual(recovered.pendingCommands[0].projectionOutcome, 'pending');
    assert.strictEqual(recovered.pendingCommands[0].projectionApplied, false);
    assert.strictEqual(recovered.projectionWork.length, 1);
    assert.strictEqual(recovered.cacheRecords.length, 1);
    assert.strictEqual(recovered.cacheRecords[0].payload.ok, true);
    assert.strictEqual(recovered.cacheRecords[0].payload.command.id, 101);
    assert.strictEqual(recovered.maxCommandId, 101);
  });
}

function testAckIsDurableBeforeMemoryTransition() {
  withTempRoot('ack', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 20_000;
    let fsyncCalls = 0;
    const fileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'fsyncSync') {
          return (descriptor) => {
            fsyncCalls += 1;
            return target.fsyncSync(descriptor);
          };
        }
        return target[property];
      },
    });
    const outbox = new InputCommandOutbox({ filePath, now: () => ++clock, fileSystem });
    queueInput(outbox, { id: 201, clientRequestId: 'request-201' });
    queueInput(outbox, { id: 202, clientRequestId: 'request-202' });
    queueInput(outbox, { id: 203, clientRequestId: 'request-203', hostId: 'host-b' });
    assert.strictEqual(fsyncCalls, 3, 'every queued append must fsync');

    const appendRecord = outbox.appendRecord.bind(outbox);
    outbox.appendRecord = (record, options) => {
      if (record.op === 'ack') throw new Error('simulated ACK tombstone write failure');
      return appendRecord(record, options);
    };
    assert.throws(() => outbox.ackThrough('host-a', 201), /tombstone write failure/);
    assert.deepStrictEqual(
      outbox.getRecoveryState().pendingCommands.map((entry) => entry.originalCommandId),
      [201, 202, 203],
      'a failed tombstone append must leave the in-memory pending set unchanged'
    );

    outbox.appendRecord = appendRecord;
    const acked = outbox.ackThrough('host-a', 201);
    assert.strictEqual(acked.recorded, true);
    assert.strictEqual(acked.acknowledgedInputs, 1);
    assert.strictEqual(fsyncCalls, 4, 'ACK tombstones must fsync before queue removal');
    assert.strictEqual(readRecords(filePath).at(-1).op, 'ack');

    const restarted = new InputCommandOutbox({ filePath, now: () => clock });
    const recovered = restarted.getRecoveryState();
    assert.deepStrictEqual(
      recovered.pendingCommands.map((entry) => entry.originalCommandId),
      [202, 203]
    );
    assert.deepStrictEqual(
      recovered.cacheRecords.map((entry) => entry.payload.command.id),
      [201, 202, 203],
      'ACK must not erase the short-lived HTTP dedupe response'
    );
    restarted.ackThrough('host-a', 999);
    assert.strictEqual(restarted.getRecoveryState().maxCommandId, 999, 'ACK must advance the command ID watermark');
  });
}

function testIndividualCompletionIsDurableAndIdempotent() {
  withTempRoot('complete', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 25_000;
    const options = {
      filePath,
      now: () => ++clock,
      compactOperationThreshold: 1,
    };
    const outbox = new InputCommandOutbox(options);
    queueInput(outbox, { id: 251, clientRequestId: 'request-complete' });

    const appendRecord = outbox.appendRecord.bind(outbox);
    outbox.appendRecord = (record, appendOptions) => {
      if (record.op === 'complete') throw new Error('simulated completion tombstone write failure');
      return appendRecord(record, appendOptions);
    };
    assert.throws(
      () => outbox.markCompleted('host-a', 251, 'request-complete', {
        sessionId: 'visible-session',
        outcome: 'rejected',
      }),
      /tombstone write failure/
    );
    assert.deepStrictEqual(
      outbox.getRecoveryState().pendingCommands.map((entry) => entry.originalCommandId),
      [251],
      'a failed completion fsync must leave the command replayable'
    );

    outbox.appendRecord = appendRecord;
    const completed = outbox.markCompleted('host-a', 251, 'request-complete', {
      sessionId: 'visible-session',
      outcome: 'rejected',
    });
    assert.strictEqual(completed.recorded, true);
    assert.strictEqual(outbox.getRecoveryState().pendingCommands.length, 0);
    assert.strictEqual(outbox.getRecoveryState().completedCommands[0].completedOutcome, 'rejected');
    assert.strictEqual(outbox.getRecoveryState().completedCommands[0].completedSessionId, 'visible-session');
    assert.strictEqual(
      outbox.markCompleted('host-a', 251, 'request-complete', {
        sessionId: 'visible-session',
        outcome: 'rejected',
      }).reason,
      'duplicate'
    );
    assert.throws(
      () => outbox.markCompleted('host-a', 251, 'different-request', { outcome: 'rejected' }),
      (error) => error?.code === 'input_command_outbox_conflict'
    );

    outbox.compact();
    const records = readRecords(filePath);
    assert(records.some((record) => record.op === 'complete' && record.commandId === 251));
    const restarted = new InputCommandOutbox(options);
    const recovered = restarted.getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 0, 'a completed command must not replay without a high-water ACK');
    assert.strictEqual(recovered.completedCommands[0].completedOutcome, 'rejected');
    assert.strictEqual(recovered.cacheRecords[0].payload.command.id, 251, 'completion must retain HTTP dedupe state');
    fs.appendFileSync(filePath, `${JSON.stringify({
      version: 1,
      op: 'complete',
      at: ++clock,
      hostId: 'host-a',
      commandId: 251,
      clientRequestId: 'request-complete',
      sessionId: 'visible-session',
      outcome: 'accepted',
    })}\n`, 'utf8');
    assert.throws(
      () => new InputCommandOutbox(options),
      (error) => error?.code === 'input_command_outbox_corrupt'
        && error?.cause?.code === 'input_command_outbox_conflict',
      'conflicting durable terminal outcomes must fail restart closed'
    );
  });
}

function testTtlBoundaries() {
  withTempRoot('ttl', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 1_000;
    const options = {
      filePath,
      now: () => clock,
      commandQueueTtlMs: 1_000,
      dedupeTtlMs: 200,
    };
    const outbox = new InputCommandOutbox(options);
    queueInput(outbox, { id: 301, clientRequestId: 'request-ttl' });

    clock = 1_201;
    let recovered = outbox.getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 1, 'queue TTL should outlive the dedupe cache TTL');
    assert.strictEqual(recovered.cacheRecords.length, 0);
    recovered = new InputCommandOutbox(options).getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 1);
    assert.strictEqual(recovered.cacheRecords.length, 0);

    clock = 2_001;
    const expired = new InputCommandOutbox(options);
    recovered = expired.getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 0);
    assert.strictEqual(recovered.cacheRecords.length, 0);
    assert.strictEqual(recovered.maxCommandId, 301, 'expiry must retain the ID watermark across compaction');
    queueInput(expired, { id: 302, clientRequestId: 'request-ttl' });
    recovered = new InputCommandOutbox(options).getRecoveryState();
    assert.deepStrictEqual(
      recovered.pendingCommands.map((entry) => entry.originalCommandId),
      [302],
      'reusing a clientRequestId after both TTLs expire must compact away its old conflicting generation'
    );
  });
}

function testProjectionRecoveryAndOutcomeCheckpoints() {
  withTempRoot('projection-recovery', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 3_000;
    const options = {
      filePath,
      now: () => ++clock,
      compactOperationThreshold: 1,
    };
    const outbox = new InputCommandOutbox(options);
    queueInput(outbox, { id: 321, clientRequestId: 'request-projection-recovery' });

    let restarted = new InputCommandOutbox(options);
    let recovered = restarted.getRecoveryState();
    assert.strictEqual(recovered.projectionWork.length, 1, 'a crash before projection must expose recovery work');
    assert.strictEqual(recovered.projectionWork[0].projectionOutcome, 'pending');
    assert.strictEqual(recovered.projectionWork[0].transcriptProjection.text, 'prompt-321');
    assert.strictEqual(recovered.projectionWork[0].transcriptProjection.files[0].path, '/workspace/app.js');

    const pendingApplied = restarted.markProjectionApplied(
      'host-a',
      321,
      'request-projection-recovery',
      'pending'
    );
    assert.strictEqual(pendingApplied.recorded, true);
    assert.strictEqual(pendingApplied.entry.projectionAppliedOutcome, 'pending');
    assert.strictEqual(
      restarted.markProjectionApplied('host-a', 321, 'request-projection-recovery', 'pending').reason,
      'duplicate'
    );

    restarted = new InputCommandOutbox(options);
    recovered = restarted.getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 1, 'projection checkpoint must not ACK the command');
    assert.strictEqual(recovered.projectionWork.length, 0);
    assert.strictEqual(recovered.pendingCommands[0].projectionApplied, true);

    restarted.markCompleted('host-a', 321, 'request-projection-recovery', {
      sessionId: 'visible-session',
      outcome: 'accepted',
    });
    recovered = restarted.getRecoveryState();
    assert.strictEqual(recovered.projectionWork.length, 1, 'a terminal outcome must invalidate pending projection');
    assert.strictEqual(recovered.projectionWork[0].projectionOutcome, 'accepted');
    assert.strictEqual(recovered.projectionWork[0].projectionApplied, false);
    assert.throws(
      () => restarted.markProjectionApplied('host-a', 321, 'request-projection-recovery', 'pending'),
      (error) => error?.code === 'input_command_outbox_conflict'
    );
    restarted.markProjectionApplied('host-a', 321, 'request-projection-recovery', 'accepted');

    recovered = new InputCommandOutbox(options).getRecoveryState();
    assert.strictEqual(recovered.projectionWork.length, 0);
    assert.strictEqual(recovered.completedCommands[0].projectionAppliedOutcome, 'accepted');
  });
}

function testTerminalProjectionSurvivesDedupeTtl() {
  withTempRoot('terminal-projection-ttl', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 4_000;
    const options = {
      filePath,
      now: () => clock,
      commandQueueTtlMs: 100,
      dedupeTtlMs: 50,
    };
    const outbox = new InputCommandOutbox(options);
    queueInput(outbox, { id: 331, clientRequestId: 'request-rejected-projection' });
    outbox.markCompleted('host-a', 331, 'request-rejected-projection', {
      sessionId: 'visible-session',
      outcome: 'rejected',
    });

    clock = 10_000;
    const restarted = new InputCommandOutbox(options);
    let recovered = restarted.getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 0);
    assert.strictEqual(recovered.cacheRecords.length, 0, 'HTTP dedupe may expire independently');
    assert.strictEqual(recovered.completedCommands.length, 1, 'unapplied terminal outcome must survive TTL');
    assert.strictEqual(recovered.projectionWork.length, 1);
    assert.strictEqual(recovered.projectionWork[0].completedOutcome, 'rejected');

    restarted.markProjectionApplied('host-a', 331, 'request-rejected-projection', 'rejected');
    recovered = restarted.getRecoveryState();
    assert.strictEqual(recovered.completedCommands.length, 0, 'applied terminal state may prune after TTL');
    assert.strictEqual(recovered.projectionWork.length, 0);
    assert.strictEqual(recovered.maxCommandId, 331);
    recovered = new InputCommandOutbox(options).getRecoveryState();
    assert.strictEqual(recovered.completedCommands.length, 0);
    assert.strictEqual(recovered.maxCommandId, 331);
  });
}

function testAcceptanceUnknownRefinesAuthoritatively() {
  withTempRoot('acceptance-refinement', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 10_500;
    const options = {
      filePath,
      now: () => ++clock,
      compactOperationThreshold: 1,
    };
    const outbox = new InputCommandOutbox(options);
    queueInput(outbox, { id: 336, clientRequestId: 'request-acceptance-refinement' });
    outbox.markCompleted('host-a', 336, 'request-acceptance-refinement', {
      sessionId: 'visible-session',
      outcome: 'acceptance_unknown',
    });
    outbox.markProjectionApplied(
      'host-a',
      336,
      'request-acceptance-refinement',
      'acceptance_unknown'
    );
    assert.strictEqual(outbox.getRecoveryState().projectionWork.length, 0);

    const refined = outbox.markCompleted('host-a', 336, 'request-acceptance-refinement', {
      sessionId: 'visible-session',
      outcome: 'accepted',
    });
    assert.strictEqual(refined.recorded, true);
    assert.strictEqual(refined.reason, 'refined');
    assert.strictEqual(refined.entry.completedOutcome, 'accepted');
    assert.strictEqual(refined.entry.projectionApplied, false, 'old unknown checkpoint must be invalidated');
    assert.strictEqual(outbox.getRecoveryState().projectionWork[0].projectionOutcome, 'accepted');
    assert.throws(
      () => outbox.markCompleted('host-a', 336, 'request-acceptance-refinement', {
        sessionId: 'visible-session',
        outcome: 'rejected',
      }),
      (error) => error?.code === 'input_command_outbox_conflict',
      'accepted and rejected terminal outcomes must never replace each other'
    );
    assert.throws(
      () => outbox.markCompleted('host-a', 336, 'request-acceptance-refinement', {
        sessionId: 'visible-session',
        outcome: 'acceptance_unknown',
      }),
      (error) => error?.code === 'input_command_outbox_conflict',
      'authoritative accepted state must not regress to unknown'
    );
    outbox.markProjectionApplied('host-a', 336, 'request-acceptance-refinement', 'accepted');
    const recovered = new InputCommandOutbox(options).getRecoveryState();
    assert.strictEqual(recovered.completedCommands[0].completedOutcome, 'accepted');
    assert.strictEqual(recovered.completedCommands[0].projectionAppliedOutcome, 'accepted');
    assert.strictEqual(recovered.projectionWork.length, 0);
  });
}

function testLegacyV1QueuedRecordDerivesProjection() {
  withTempRoot('legacy-v1-projection', (root) => {
    const sourcePath = path.join(root, 'source.jsonl');
    const legacyPath = path.join(root, 'legacy.jsonl');
    const source = new InputCommandOutbox({ filePath: sourcePath, now: () => 11_000 });
    queueInput(source, { id: 337, clientRequestId: 'request-legacy-v1' });
    const legacyRecord = readRecords(sourcePath).find((record) => record.op === 'queued');
    delete legacyRecord.transcriptProjection;
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacyRecord)}\n`, 'utf8');

    const legacy = new InputCommandOutbox({ filePath: legacyPath, now: () => 11_000 });
    let recovered = legacy.getRecoveryState();
    assert.strictEqual(recovered.pendingCommands.length, 1);
    assert.strictEqual(recovered.projectionWork.length, 1);
    assert.strictEqual(recovered.projectionWork[0].transcriptProjection.sessionId, 'visible-session');
    assert.strictEqual(recovered.projectionWork[0].transcriptProjection.text, 'prompt-337');
    assert.deepStrictEqual(recovered.projectionWork[0].transcriptProjection.files, []);
    legacy.compact();
    assert(
      readRecords(legacyPath).some((record) => record.op === 'queued' && record.transcriptProjection),
      'compaction should upgrade a legacy v1 queued record with its derived projection'
    );
    recovered = new InputCommandOutbox({ filePath: legacyPath, now: () => 11_000 }).getRecoveryState();
    assert.strictEqual(recovered.projectionWork[0].transcriptProjection.text, 'prompt-337');
  });
}

function testDurableScopeMigrationAndConflicts() {
  withTempRoot('scope-migration', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 5_000;
    const options = { filePath, now: () => ++clock };
    const outbox = new InputCommandOutbox(options);
    queueInput(outbox, {
      id: 341,
      clientRequestId: 'request-scope-migration',
      scopeKey: 'scope-a',
    });
    queueInput(outbox, {
      id: 342,
      clientRequestId: 'request-other-host',
      hostId: 'host-b',
      scopeKey: 'scope-a',
    });
    const migrated = outbox.migrateScope('host-a', 'scope-a', 'scope-b');
    assert.strictEqual(migrated.recorded, true);
    assert.strictEqual(migrated.migratedEntries, 1);
    assert.strictEqual(readRecords(filePath).at(-1).op, 'migrate_scope');
    outbox.compact();
    assert.strictEqual(
      readRecords(filePath).find((record) => record.op === 'queued' && record.originalCommandId === 341).scopeKey,
      'scope-b',
      'compaction must fold the durable migration into the queued identity'
    );

    let restarted = new InputCommandOutbox(options);
    let recovered = restarted.getRecoveryState();
    assert.strictEqual(
      recovered.pendingCommands.find((entry) => entry.originalCommandId === 341).scopeKey,
      'scope-b'
    );
    assert.strictEqual(
      recovered.pendingCommands.find((entry) => entry.originalCommandId === 342).scopeKey,
      'scope-a',
      'scope migration must remain inside the Host boundary'
    );
    assert(recovered.cacheRecords.some((entry) => (
      entry.cacheKey === 'host-a::scope-b::request-scope-migration'
    )));
    assert.strictEqual(
      queueInput(restarted, {
        id: 341,
        clientRequestId: 'request-scope-migration',
        scopeKey: 'scope-b',
      }).reason,
      'duplicate',
      'retry after migration and restart must resolve to the original command'
    );
    restarted.migrateScope('host-a', 'scope-b', 'scope-c');
    recovered = new InputCommandOutbox(options).getRecoveryState();
    assert.strictEqual(
      recovered.pendingCommands.find((entry) => entry.originalCommandId === 341).scopeKey,
      'scope-c',
      'scope migrations must compose across restarts'
    );

    const conflictPath = path.join(root, 'scope-conflict.jsonl');
    const conflict = new InputCommandOutbox({ filePath: conflictPath, now: () => ++clock });
    queueInput(conflict, {
      id: 343,
      clientRequestId: 'request-scope-conflict',
      scopeKey: 'scope-source',
      fingerprint: 'same-fingerprint',
    });
    queueInput(conflict, {
      id: 344,
      clientRequestId: 'request-scope-conflict',
      scopeKey: 'scope-target',
      fingerprint: 'same-fingerprint',
    });
    const recordCount = readRecords(conflictPath).length;
    assert.throws(
      () => conflict.migrateScope('host-a', 'scope-source', 'scope-target'),
      (error) => (
        error?.code === 'input_command_outbox_conflict'
        && error.fingerprintMatches === true
        && error.commandIdMatches === false
      ),
      'scope collisions with another command ID must fail closed'
    );
    assert.strictEqual(readRecords(conflictPath).length, recordCount, 'conflict must not append migration WAL');
    assert.deepStrictEqual(
      new InputCommandOutbox({ filePath: conflictPath, now: () => clock })
        .getRecoveryState().pendingCommands.map((entry) => entry.scopeKey).sort(),
      ['scope-source', 'scope-target']
    );
    fs.appendFileSync(conflictPath, `${JSON.stringify({
      version: 1,
      op: 'migrate_scope',
      at: ++clock,
      hostId: 'host-a',
      fromScopeKey: 'scope-source',
      toScopeKey: 'scope-target',
    })}\n`, 'utf8');
    assert.throws(
      () => new InputCommandOutbox({ filePath: conflictPath, now: () => clock }),
      (error) => (
        error?.code === 'input_command_outbox_corrupt'
        && error?.cause?.code === 'input_command_outbox_conflict'
      ),
      'a conflicting durable migration must fail restart closed'
    );
  });
}

function testProjectionAndMigrationFsyncFailures() {
  withTempRoot('new-op-fsync', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 6_000;
    let failFsync = false;
    const fileSystem = new Proxy(fs, {
      get(target, property) {
        if (property === 'fsyncSync') {
          return (descriptor) => {
            if (failFsync) throw new Error('simulated new-op fsync failure');
            return target.fsyncSync(descriptor);
          };
        }
        return target[property];
      },
    });
    const outbox = new InputCommandOutbox({ filePath, now: () => ++clock, fileSystem });
    queueInput(outbox, { id: 351, clientRequestId: 'request-projection-fsync' });

    let durableBefore = fs.readFileSync(filePath, 'utf8');
    failFsync = true;
    assert.throws(
      () => outbox.markProjectionApplied('host-a', 351, 'request-projection-fsync', 'pending'),
      /new-op fsync failure/
    );
    assert.strictEqual(outbox.getRecoveryState().projectionWork[0].projectionApplied, false);
    fs.writeFileSync(filePath, durableBefore, 'utf8');
    failFsync = false;
    assert.strictEqual(
      outbox.markProjectionApplied('host-a', 351, 'request-projection-fsync', 'pending').recorded,
      true
    );

    queueInput(outbox, {
      id: 352,
      clientRequestId: 'request-migration-fsync',
      scopeKey: 'scope-before-fsync',
    });
    durableBefore = fs.readFileSync(filePath, 'utf8');
    failFsync = true;
    assert.throws(
      () => outbox.migrateScope('host-a', 'scope-before-fsync', 'scope-after-fsync'),
      /new-op fsync failure/
    );
    assert.strictEqual(
      outbox.getRecoveryState().pendingCommands.find((entry) => entry.originalCommandId === 352).scopeKey,
      'scope-before-fsync',
      'failed migration fsync must not mutate memory'
    );
    fs.writeFileSync(filePath, durableBefore, 'utf8');
    failFsync = false;
    assert.strictEqual(
      outbox.migrateScope('host-a', 'scope-before-fsync', 'scope-after-fsync').recorded,
      true
    );
    assert.strictEqual(
      new InputCommandOutbox({ filePath, now: () => clock })
        .getRecoveryState().pendingCommands.find((entry) => entry.originalCommandId === 352).scopeKey,
      'scope-after-fsync'
    );
  });
}

function testCorruptionTailAndBackupRecovery() {
  withTempRoot('corruption', (root) => {
    const goodPath = path.join(root, 'good.jsonl');
    const good = new InputCommandOutbox({ filePath: goodPath, now: () => 5_000 });
    queueInput(good, { id: 401, clientRequestId: 'request-tail' });
    fs.appendFileSync(goodPath, '{"version":1,"op":"queued"', 'utf8');
    const recoveredTail = new InputCommandOutbox({ filePath: goodPath, now: () => 5_000 });
    assert.strictEqual(recoveredTail.getRecoveryState().pendingCommands.length, 1);
    assert.doesNotThrow(() => readRecords(goodPath), 'truncated tail recovery must rewrite a valid journal');

    const unterminatedPath = path.join(root, 'unterminated-valid.jsonl');
    const unterminated = new InputCommandOutbox({ filePath: unterminatedPath, now: () => 5_000 });
    queueInput(unterminated, { id: 404, clientRequestId: 'request-unterminated-a' });
    fs.writeFileSync(unterminatedPath, fs.readFileSync(unterminatedPath, 'utf8').trimEnd(), 'utf8');
    const repairedUnterminated = new InputCommandOutbox({ filePath: unterminatedPath, now: () => 5_000 });
    queueInput(repairedUnterminated, { id: 405, clientRequestId: 'request-unterminated-b' });
    assert.deepStrictEqual(
      new InputCommandOutbox({ filePath: unterminatedPath, now: () => 5_000 })
        .getRecoveryState().pendingCommands.map((entry) => entry.originalCommandId),
      [404, 405],
      'a complete final JSON object without a newline must be repaired before the next append'
    );

    const corruptPath = path.join(root, 'corrupt.jsonl');
    const corrupt = new InputCommandOutbox({ filePath: corruptPath, now: () => 5_000 });
    queueInput(corrupt, { id: 402, clientRequestId: 'request-corrupt' });
    fs.appendFileSync(corruptPath, '{"version":1,"op":"ack"}\n', 'utf8');
    fs.appendFileSync(corruptPath, `${JSON.stringify({
      version: 1,
      op: 'watermark',
      at: 5_000,
      maxCommandId: 500,
    })}\n`, 'utf8');
    assert.throws(
      () => new InputCommandOutbox({ filePath: corruptPath, now: () => 5_000 }),
      (error) => error?.code === 'input_command_outbox_corrupt' && error?.lineNumber === 2,
      'non-tail corruption must fail closed'
    );

    const backupPath = path.join(root, 'backup.jsonl');
    const backupSource = new InputCommandOutbox({ filePath: backupPath, now: () => 5_000 });
    queueInput(backupSource, { id: 403, clientRequestId: 'request-backup' });
    const interruptedBackup = `${backupPath}.interrupted-compaction.tmp.bak`;
    fs.renameSync(backupPath, interruptedBackup);
    const recoveredBackup = new InputCommandOutbox({ filePath: backupPath, now: () => 5_000 });
    assert.strictEqual(recoveredBackup.getRecoveryState().pendingCommands[0].originalCommandId, 403);
    assert.strictEqual(fs.existsSync(interruptedBackup), false);
  });
}

function testSensitiveDataFailsClosed() {
  withTempRoot('secrets', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    const outbox = new InputCommandOutbox({ filePath, now: () => 7_000 });
    const secretCommand = makeCommand(501, 'request-secret-field', {
      apiConfig: { apiKey: 'super-secret-value' },
    });
    assert.throws(
      () => queueInput(outbox, {
        id: 501,
        clientRequestId: 'request-secret-field',
        command: secretCommand,
      }),
      (error) => error?.code === 'input_command_outbox_sensitive_data'
    );
    assert.strictEqual(fs.existsSync(filePath), false);

    const businessText = 'Example request: curl https://example.invalid/v1?api_key=sample-token-value';
    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    const businessPath = '/workspace/examples/api_key=sample-token.txt';
    queueInput(outbox, {
      id: 502,
      clientRequestId: 'request-business-text',
      commandOverrides: { text: businessText },
    });
    queueInput(outbox, {
      id: 503,
      clientRequestId: 'request-business-attachments',
      commandOverrides: {
        inputItems: [
          { type: 'image', url: dataUrl, name: 'example.png' },
          { type: 'mention', name: 'sample-token.txt', path: businessPath },
        ],
      },
    });

    assert.throws(
      () => queueInput(outbox, {
        id: 504,
        clientRequestId: 'request-top-level-secret',
        commandOverrides: { apiKey: 'blocked-top-level-value' },
      }),
      (error) => error?.code === 'input_command_outbox_sensitive_data'
    );
    assert.throws(
      () => queueInput(outbox, {
        id: 505,
        clientRequestId: 'request-nested-secret',
        commandOverrides: {
          approvalPolicy: { mode: 'custom', token: 'blocked-nested-value' },
        },
      }),
      (error) => error?.code === 'input_command_outbox_sensitive_data'
    );
    assert.throws(
      () => queueInput(outbox, {
        id: 506,
        clientRequestId: 'request-unknown-field',
        commandOverrides: { customMetadata: { harmless: true } },
      }),
      (error) => error?.code === 'input_command_outbox_validation_failed'
    );
    assert.throws(
      () => queueInput(outbox, {
        id: 508,
        clientRequestId: 'request-projection-secret',
        transcriptProjection: {
          ...makeTranscriptProjection(makeCommand(508, 'request-projection-secret')),
          apiKey: 'blocked-projection-value',
        },
      }),
      (error) => error?.code === 'input_command_outbox_sensitive_data'
    );
    assert.throws(
      () => queueInput(outbox, {
        id: 509,
        clientRequestId: 'request-projection-extra-field',
        transcriptProjection: {
          ...makeTranscriptProjection(makeCommand(509, 'request-projection-extra-field')),
          source: 'unsupported',
        },
      }),
      (error) => error?.code === 'input_command_outbox_validation_failed'
    );
    const unsafeFileProjection = makeTranscriptProjection(
      makeCommand(510, 'request-projection-inline-data')
    );
    unsafeFileProjection.files[0].dataBase64 = 'blocked-inline-file-content';
    assert.throws(
      () => queueInput(outbox, {
        id: 510,
        clientRequestId: 'request-projection-inline-data',
        transcriptProjection: unsafeFileProjection,
      }),
      (error) => error?.code === 'input_command_outbox_validation_failed'
    );

    queueInput(outbox, { id: 507, clientRequestId: 'request-safe' });
    const raw = fs.readFileSync(filePath, 'utf8');
    assert(!raw.includes('super-secret-value'));
    assert(!raw.includes('blocked-top-level-value'));
    assert(!raw.includes('blocked-nested-value'));
    assert(!raw.includes('blocked-projection-value'));
    assert(!raw.includes('blocked-inline-file-content'));
    assert(raw.includes(businessText), 'prompt text that resembles a token must remain business data');
    assert(raw.includes(dataUrl), 'image data URLs must remain replayable');
    assert(raw.includes(businessPath), 'attachment and mention paths must remain replayable');

    const recoveredBusinessData = new InputCommandOutbox({ filePath, now: () => 7_000 })
      .getRecoveryState().pendingCommands;
    assert.strictEqual(recoveredBusinessData.find((entry) => entry.originalCommandId === 502).command.text, businessText);
    assert.strictEqual(
      recoveredBusinessData.find((entry) => entry.originalCommandId === 503).command.inputItems[0].url,
      dataUrl
    );

    const poisonedPath = path.join(root, 'poisoned.jsonl');
    const poisoned = readRecords(filePath)[0];
    poisoned.command.apiKey = 'must-not-load';
    fs.writeFileSync(poisonedPath, `${JSON.stringify(poisoned)}\n`, 'utf8');
    assert.throws(
      () => new InputCommandOutbox({ filePath: poisonedPath, now: () => 7_000 }),
      (error) => (
        error?.code === 'input_command_outbox_corrupt'
        && error?.cause?.code === 'input_command_outbox_sensitive_data'
      ),
      'a credential-bearing durable record must fail Relay startup closed'
    );
  });
}

function testConflictsAndCapacity() {
  withTempRoot('conflict', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    const outbox = new InputCommandOutbox({ filePath, now: () => 9_000, entryLimit: 2 });
    queueInput(outbox, {
      id: 601,
      clientRequestId: 'request-conflict',
      fingerprint: 'fingerprint-original',
    });
    assert.throws(
      () => queueInput(outbox, {
        id: 601,
        clientRequestId: 'request-conflict',
        fingerprint: 'fingerprint-different',
      }),
      (error) => error?.code === 'input_command_outbox_conflict'
    );
    assert.throws(
      () => queueInput(outbox, {
        id: 602,
        clientRequestId: 'request-conflict',
        fingerprint: 'fingerprint-original',
      }),
      (error) => error?.code === 'input_command_outbox_conflict'
    );
    assert.throws(
      () => queueInput(outbox, {
        id: 601,
        clientRequestId: 'request-other-identity',
        scopeKey: 'scope-other',
      }),
      (error) => error?.code === 'input_command_outbox_conflict'
    );

    queueInput(outbox, { id: 603, clientRequestId: 'request-capacity-2' });
    assert.throws(
      () => queueInput(outbox, { id: 604, clientRequestId: 'request-capacity-3' }),
      (error) => error?.code === 'input_command_outbox_capacity_exceeded'
    );
    assert.deepStrictEqual(
      outbox.getRecoveryState().pendingCommands.map((entry) => entry.originalCommandId),
      [601, 603],
      'capacity failure must not silently evict an older pending command'
    );
    const restarted = new InputCommandOutbox({ filePath, now: () => 9_000, entryLimit: 2 });
    assert.deepStrictEqual(
      restarted.getRecoveryState().pendingCommands.map((entry) => entry.originalCommandId),
      [601, 603]
    );

    const durableConflictPath = path.join(root, 'durable-conflict.jsonl');
    const durableConflict = new InputCommandOutbox({ filePath: durableConflictPath, now: () => 9_000 });
    queueInput(durableConflict, { id: 606, clientRequestId: 'request-durable-conflict' });
    const conflictingRecord = readRecords(durableConflictPath)[0];
    conflictingRecord.fingerprint = 'different-durable-fingerprint';
    fs.appendFileSync(durableConflictPath, `${JSON.stringify(conflictingRecord)}\n`, 'utf8');
    assert.throws(
      () => new InputCommandOutbox({ filePath: durableConflictPath, now: () => 9_000 }),
      (error) => (
        error?.code === 'input_command_outbox_corrupt'
        && error?.cause?.code === 'input_command_outbox_conflict'
      ),
      'conflicting durable generations must fail restart closed'
    );

    const largePath = path.join(root, 'large.jsonl');
    const bounded = new InputCommandOutbox({
      filePath: largePath,
      now: () => 9_000,
      maxRecordBytes: 1024,
      maxJournalBytes: 2048,
    });
    assert.throws(
      () => queueInput(bounded, {
        id: 605,
        clientRequestId: 'request-too-large',
        commandOverrides: { text: 'x'.repeat(4_000) },
      }),
      (error) => error?.code === 'input_command_outbox_capacity_exceeded'
    );
    assert.strictEqual(bounded.getRecoveryState().pendingCommands.length, 0);
  });
}

function testCompactionPreservesRecoveryContract() {
  withTempRoot('compact', (root) => {
    const filePath = path.join(root, 'input-outbox.jsonl');
    let clock = 11_000;
    const options = {
      filePath,
      now: () => ++clock,
      compactOperationThreshold: 1,
    };
    const outbox = new InputCommandOutbox(options);
    queueInput(outbox, { id: 701, clientRequestId: 'request-compact-a' });
    queueInput(outbox, { id: 702, clientRequestId: 'request-compact-b' });
    outbox.ackThrough('host-a', 701);
    const records = readRecords(filePath);
    assert(records.some((record) => record.op === 'watermark' && record.maxCommandId >= 702));
    assert(records.some((record) => record.op === 'ack' && record.throughCommandId === 701));
    assert.strictEqual(records.filter((record) => record.op === 'queued').length, 2);

    const restarted = new InputCommandOutbox(options);
    const recovered = restarted.getRecoveryState();
    assert.deepStrictEqual(recovered.pendingCommands.map((entry) => entry.originalCommandId), [702]);
    assert.deepStrictEqual(recovered.cacheRecords.map((entry) => entry.payload.command.id), [701, 702]);
    assert.strictEqual(recovered.maxCommandId, 702);
  });
}

function main() {
  testRestartRecoveryAndEligibility();
  testAckIsDurableBeforeMemoryTransition();
  testIndividualCompletionIsDurableAndIdempotent();
  testTtlBoundaries();
  testProjectionRecoveryAndOutcomeCheckpoints();
  testTerminalProjectionSurvivesDedupeTtl();
  testAcceptanceUnknownRefinesAuthoritatively();
  testLegacyV1QueuedRecordDerivesProjection();
  testDurableScopeMigrationAndConflicts();
  testProjectionAndMigrationFsyncFailures();
  testCorruptionTailAndBackupRecovery();
  testSensitiveDataFailsClosed();
  testConflictsAndCapacity();
  testCompactionPreservesRecoveryContract();
  console.log('input command outbox assertions passed');
}

main();
