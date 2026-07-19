const fs = require('fs');
const path = require('path');

const {
  extractSessionTranscript,
  makeTranscriptEntry,
  readCodexSessionSummary,
} = require('../shared/codex-discovery');
const { makeProfileBinding } = require('../shared/api-binding');
const { containsSecretField } = require('../shared/secret-redaction');
const { SessionRecordStore } = require('../apps/relay/session-record-store');
const { SessionProvenanceService } = require('../apps/relay/session-provenance-service');

const MAX_ROLLOUT_BYTES = 20 * 1024 * 1024;
const REPAIR_LOCK_NAME = '.repair-session-provenance.lock';
const STORE_MARKERS = [
  'snapshot-current.json',
  'snapshot-previous.json',
  'snapshot-next.json',
  'wal-current.jsonl',
  'wal-next.jsonl',
];

function requiredText(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    throw new TypeError(`${name} is required`);
  }
  return text;
}

function assertFreshOutputRoot(outputRoot) {
  const resolved = path.resolve(requiredText(outputRoot, 'outputRoot'));
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`outputRoot is not a directory: ${resolved}`);
  }
  const existingMarker = STORE_MARKERS.find((name) => fs.existsSync(path.join(resolved, name)));
  if (existingMarker) {
    throw new Error(`refusing to overwrite existing isolated store: ${path.join(resolved, existingMarker)}`);
  }
  return resolved;
}

function acquireRepairLock(outputRoot) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const lockPath = path.join(outputRoot, REPAIR_LOCK_NAME);
  try {
    const descriptor = fs.openSync(lockPath, 'wx');
    return { descriptor, lockPath };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`repair already in progress for outputRoot: ${outputRoot}`);
    }
    throw error;
  }
}

function releaseRepairLock(lock) {
  if (!lock) {
    return;
  }
  fs.closeSync(lock.descriptor);
  fs.unlinkSync(lock.lockPath);
}

function countMappedTranscriptRows(rolloutPath) {
  const stat = fs.statSync(rolloutPath);
  if (!stat.isFile()) {
    throw new Error(`rollout is not a file: ${rolloutPath}`);
  }
  if (stat.size > MAX_ROLLOUT_BYTES) {
    throw new Error(`rollout exceeds ${MAX_ROLLOUT_BYTES} bytes: ${rolloutPath}`);
  }
  const lines = fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/);
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid rollout JSON at line ${index + 1}: ${error.message}`);
    }
    if (makeTranscriptEntry(row, { maxChars: Infinity })) {
      count += 1;
    }
  }
  return count;
}

async function repairIsolatedProvenance(options = {}) {
  if (containsSecretField(options.apiProfile)) {
    throw new Error('repairIsolatedProvenance does not accept API keys or credentials');
  }
  const rolloutPath = path.resolve(requiredText(options.rolloutPath, 'rolloutPath'));
  const outputRoot = assertFreshOutputRoot(options.outputRoot);
  const hostId = requiredText(options.hostId, 'hostId');
  const sessionId = requiredText(options.sessionId, 'sessionId');
  const bridgeSessionId = requiredText(options.bridgeSessionId, 'bridgeSessionId');
  if (!fs.existsSync(rolloutPath)) {
    throw new Error(`rollout does not exist: ${rolloutPath}`);
  }

  const apiBinding = makeProfileBinding(options.apiProfile || {});
  if (!apiBinding.bindingFingerprint) {
    throw new Error('API binding identity is incomplete');
  }

  const summary = readCodexSessionSummary(rolloutPath);
  if (!summary?.sessionId) {
    throw new Error(`rollout Session metadata is unavailable: ${rolloutPath}`);
  }
  if (summary.sessionId !== sessionId) {
    throw new Error(`rollout Session ID ${summary.sessionId} does not match ${sessionId}`);
  }

  const transcriptCount = countMappedTranscriptRows(rolloutPath);
  const transcript = extractSessionTranscript(rolloutPath, {
    maxRows: Infinity,
    maxChars: MAX_ROLLOUT_BYTES,
  });
  if (!transcriptCount || !transcript.length) {
    throw new Error('rollout does not contain a recoverable transcript');
  }

  let store = null;
  let repairLock = null;
  try {
    repairLock = acquireRepairLock(outputRoot);
    assertFreshOutputRoot(outputRoot);
    store = await SessionRecordStore.open({ rootDir: outputRoot });
    const provenance = new SessionProvenanceService({ store });
    await provenance.mergeDiscovery({
      hostId,
      sessionId,
      nativeThreadId: sessionId,
      source: 'rollout',
      title: summary.title,
      cwd: summary.cwd,
      createdAt: summary.createdAt,
      endedAt: summary.updatedAt,
      modelProviderHint: summary.modelProvider || summary.model_provider || null,
    });
    const imported = await provenance.importVerifiedLegacyRun({
      identity: { hostId, sessionId },
      bridgeSessionId,
      nativeThreadId: sessionId,
      originSessionId: options.originSessionId || sessionId,
      sourceSessionId: options.sourceSessionId || sessionId,
      conversationKey: options.conversationKey || sessionId,
      cwd: summary.cwd,
      title: summary.title,
      createdAt: summary.createdAt,
      endedAt: summary.updatedAt,
      apiBinding,
      selection: options.selection || {},
      evidenceSource: 'operator_verified',
    });
    await store.flushSnapshot();
    return {
      transcriptCount,
      deduplicatedTranscriptCount: transcript.length,
      fullTranscript: true,
      canonicalKey: imported.canonicalKey,
      runId: imported.runId,
      record: imported.record,
      run: imported.run,
      outputRoot,
    };
  } finally {
    if (store) {
      await store.close();
    }
    releaseRepairLock(repairLock);
  }
}

function parseCliArgs(argv) {
  const result = {};
  const names = new Set([
    'rollout',
    'output-root',
    'host-id',
    'session-id',
    'bridge-session-id',
    'origin-session-id',
    'source-session-id',
    'conversation-key',
    'profile-id',
    'label',
    'provider',
    'base-url',
    'model',
    'effort',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || '');
    if (!argument.startsWith('--')) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    if (!names.has(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    const value = argv[index + 1];
    if (typeof value === 'undefined' || String(value).startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    result[name] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await repairIsolatedProvenance({
    rolloutPath: args.rollout,
    outputRoot: args['output-root'],
    hostId: args['host-id'],
    sessionId: args['session-id'],
    bridgeSessionId: args['bridge-session-id'],
    originSessionId: args['origin-session-id'],
    sourceSessionId: args['source-session-id'],
    conversationKey: args['conversation-key'],
    apiProfile: {
      profileId: args['profile-id'],
      label: args.label,
      provider: args.provider,
      baseUrl: args['base-url'],
    },
    selection: {
      model: args.model,
      effort: args.effort,
    },
  });
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  countMappedTranscriptRows,
  repairIsolatedProvenance,
};
