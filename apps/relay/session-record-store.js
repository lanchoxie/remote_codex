const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  redactSecretText,
  stripSecrets,
} = require('../../shared/secret-redaction');
const {
  recoverMissingFileFromBackupAsync,
  replaceFileWithBackupAsync,
} = require('./atomic-file-replace');

const SCHEMA_VERSION = 1;
const SENTINEL_SCHEMA_VERSION = 1;
const SNAPSHOT_INVARIANT_ERROR_CODES = new Set([
  'session_store_high_water_rollback',
  'session_store_identity_conflict',
  'session_store_snapshot_fork',
  'session_store_snapshot_invalid',
]);

function snapshotFailureRequiresReadOnly(error) {
  const code = String(error?.code || '');
  return Boolean(
    error?.recoveryPath
    || error?.restoreError
    || SNAPSHOT_INVARIANT_ERROR_CODES.has(code)
    || code.startsWith('session_store_snapshot_')
    || code.startsWith('session_store_sentinel_')
    || code.startsWith('session_store_wal_')
    || code === 'session_store_checksum_gap'
    || code === 'session_store_revision_gap'
  );
}

class StoreRecoveryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'StoreRecoveryError';
    this.code = code;
    this.details = details;
  }
}

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function projectionStateChecksum(projection) {
  const state = { ...(projection || {}) };
  delete state.generation;
  delete state.storeId;
  return checksum(state);
}

function emptyProjection(storeId = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    storeId,
    generation: 0,
    storeRevision: 0,
    globalAssistantSeq: 0,
    records: {},
    aliases: {},
  };
}

function nonNegativeInteger(value, name, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new StoreRecoveryError(code, `Invalid ${name} high-water value.`);
  }
  return number;
}

function validateProjection(projection) {
  if (!projection || typeof projection !== 'object') {
    throw new StoreRecoveryError('session_store_snapshot_invalid', 'Snapshot projection is unavailable.');
  }
  nonNegativeInteger(
    projection.storeRevision,
    'Store revision',
    'session_store_revision_invalid'
  );
  nonNegativeInteger(
    projection.globalAssistantSeq,
    'assistant sequence',
    'session_store_high_water_invalid'
  );
  if (!projection.records || typeof projection.records !== 'object' || Array.isArray(projection.records)) {
    throw new StoreRecoveryError('session_store_snapshot_invalid', 'Snapshot records are invalid.');
  }
  if (!projection.aliases || typeof projection.aliases !== 'object' || Array.isArray(projection.aliases)) {
    throw new StoreRecoveryError('session_store_snapshot_invalid', 'Snapshot aliases are invalid.');
  }
  return projection;
}

function normalizeIdentityKeys(identity = {}) {
  const hostId = String(identity.hostId || '').trim();
  const ids = [
    identity.conversationKey,
    identity.sessionId,
    identity.bridgeSessionId,
    identity.nativeThreadId,
    identity.originSessionId,
    identity.sourceSessionId,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return {
    hostId,
    ids: [...new Set(ids)],
  };
}

function defaultRecord(seed = {}) {
  return {
    hostId: String(seed.hostId || '').trim(),
    conversationKey: String(seed.conversationKey || '').trim(),
    bridgeSessionId: seed.bridgeSessionId || null,
    nativeThreadId: seed.nativeThreadId || null,
    rolloutSessionId: seed.rolloutSessionId || null,
    rolloutSessionIds: Array.isArray(seed.rolloutSessionIds) ? [...seed.rolloutSessionIds] : [],
    originSessionId: seed.originSessionId || null,
    sourceSessionId: seed.sourceSessionId || null,
    source: seed.source || 'metadata',
    cwd: seed.cwd || null,
    title: seed.title || '',
    activeRunId: seed.activeRunId || null,
    latestSuccessfulRunId: seed.latestSuccessfulRunId || null,
    runs: clone(seed.runs) || {},
    catalog: clone(seed.catalog) || {},
    notification: clone(seed.notification) || {},
    updatedAt: seed.updatedAt || null,
  };
}

function sanitizeNamedMap(value) {
  return Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {})
      .map(([key, child]) => [key, stripSecrets(child)])
  );
}

function sanitizeRecord(record) {
  if (!record || typeof record !== 'object') {
    return record;
  }
  const base = { ...record };
  delete base.runs;
  delete base.catalog;
  delete base.notification;
  const safe = stripSecrets(base);
  safe.runs = sanitizeNamedMap(record.runs);
  safe.catalog = sanitizeNamedMap(record.catalog);
  const notification = { ...(record.notification || {}) };
  delete notification.ledger;
  safe.notification = {
    ...stripSecrets(notification),
    ledger: sanitizeNamedMap(record.notification?.ledger),
  };
  return safe;
}

function sanitizeProjection(projection) {
  const base = { ...projection };
  delete base.records;
  delete base.aliases;
  return {
    ...stripSecrets(base),
    records: Object.fromEntries(
      Object.entries(projection.records || {}).map(([key, record]) => [key, sanitizeRecord(record)])
    ),
    aliases: clone(projection.aliases) || {},
  };
}

function sanitizePayload(payload) {
  const base = { ...payload };
  delete base.records;
  delete base.aliases;
  delete base.events;
  return {
    ...stripSecrets(base),
    records: Object.fromEntries(
      Object.entries(payload.records || {}).map(([key, record]) => [
        key,
        record === null ? null : sanitizeRecord(record),
      ])
    ),
    aliases: clone(payload.aliases) || {},
    events: stripSecrets(payload.events || []),
  };
}

class Transaction {
  constructor(projection) {
    this.projection = projection;
    this.recordPatches = new Map();
    this.aliasPatches = new Map();
    this.events = [];
    this.dirty = new Set();
    this.globalAssistantSeq = Number(projection.globalAssistantSeq || 0);
  }

  aliasTarget(alias) {
    if (this.aliasPatches.has(alias)) {
      return this.aliasPatches.get(alias);
    }
    return this.projection.aliases[alias] || null;
  }

  resolveCanonicalKey(identity = {}) {
    const { hostId, ids } = normalizeIdentityKeys(identity);
    if (!hostId || !ids.length) {
      throw new TypeError('Session identity requires hostId and at least one identity value');
    }
    for (const id of ids) {
      const target = this.aliasTarget(`${hostId}::${id}`);
      if (target) {
        return target;
      }
    }
    return `${hostId}::${ids[0]}`;
  }

  getRecord(canonicalKey) {
    if (this.recordPatches.has(canonicalKey)) {
      return this.recordPatches.get(canonicalKey);
    }
    const existing = this.projection.records[canonicalKey];
    if (!existing) {
      return null;
    }
    const record = clone(existing);
    this.recordPatches.set(canonicalKey, record);
    this.dirty.add(canonicalKey);
    return record;
  }

  ensureRecord(canonicalKey, seed = {}) {
    let record = this.getRecord(canonicalKey);
    if (!record) {
      const fallback = String(canonicalKey || '').split('::').slice(1).join('::');
      record = defaultRecord({
        ...seed,
        conversationKey: seed.conversationKey || fallback,
      });
      this.recordPatches.set(canonicalKey, record);
      this.dirty.add(canonicalKey);
    }
    record.runs ||= {};
    record.catalog ||= {};
    record.notification ||= {};
    return record;
  }

  setAlias(identityKey, canonicalKey) {
    const alias = String(identityKey || '').trim();
    const target = String(canonicalKey || '').trim();
    if (!alias || !target) {
      throw new TypeError('Session aliases require non-empty identity and canonical keys');
    }
    const existingTarget = this.aliasTarget(alias);
    if (existingTarget && existingTarget !== target) {
      throw new StoreRecoveryError(
        'session_store_alias_conflict',
        'Session alias already belongs to another canonical record.'
      );
    }
    this.aliasPatches.set(alias, target);
  }

  mergeRecordInto(winnerKey, loserKey, merger) {
    const loser = this.getRecord(loserKey);
    const winner = this.ensureRecord(winnerKey, loser || {});
    const merged = loser && loserKey !== winnerKey
      ? merger(winner, loser)
      : winner;
    if (!merged || typeof merged !== 'object') {
      throw new TypeError('Session record merger must return a record object');
    }
    this.recordPatches.set(winnerKey, merged);
    this.dirty.add(winnerKey);
    if (loserKey !== winnerKey) {
      this.recordPatches.set(loserKey, null);
      this.dirty.add(loserKey);
      const aliases = new Set([
        ...Object.keys(this.projection.aliases),
        ...this.aliasPatches.keys(),
      ]);
      for (const alias of aliases) {
        if (this.aliasTarget(alias) === loserKey) {
          this.aliasPatches.set(alias, winnerKey);
        }
      }
    }
    return merged;
  }

  allocateGlobalAssistantSeq() {
    this.globalAssistantSeq += 1;
    return this.globalAssistantSeq;
  }

  appendDomainEvent(event) {
    this.events.push(stripSecrets(event));
  }

  markDirty(canonicalKey) {
    if (!this.recordPatches.has(canonicalKey) && this.projection.records[canonicalKey]) {
      this.recordPatches.set(canonicalKey, clone(this.projection.records[canonicalKey]));
    }
    this.dirty.add(canonicalKey);
  }

  payload(revision, kind) {
    const records = {};
    for (const [key, record] of this.recordPatches) {
      records[key] = record === null ? null : sanitizeRecord(record);
    }
    return sanitizePayload({
      revision,
      kind,
      records,
      aliases: Object.fromEntries(this.aliasPatches),
      globalAssistantSeq: this.globalAssistantSeq,
      events: this.events,
    });
  }
}

function applyPayload(projection, payload) {
  const currentRevision = nonNegativeInteger(
    projection.storeRevision,
    'Store revision',
    'session_store_revision_invalid'
  );
  const revision = nonNegativeInteger(
    payload.revision,
    'WAL revision',
    'session_store_revision_invalid'
  );
  const expectedRevision = currentRevision + 1;
  if (revision !== expectedRevision) {
    throw new StoreRecoveryError(
      'session_store_revision_gap',
      `Session store expected revision ${expectedRevision}, received ${payload.revision}`
    );
  }
  const currentHighWater = nonNegativeInteger(
    projection.globalAssistantSeq,
    'assistant sequence',
    'session_store_high_water_invalid'
  );
  const nextHighWater = nonNegativeInteger(
    payload.globalAssistantSeq,
    'WAL assistant sequence',
    'session_store_high_water_invalid'
  );
  if (nextHighWater < currentHighWater) {
    throw new StoreRecoveryError(
      'session_store_high_water_regression',
      `Assistant sequence regressed from ${projection.globalAssistantSeq} to ${nextHighWater}`
    );
  }
  for (const [key, record] of Object.entries(payload.records || {})) {
    if (record === null) {
      delete projection.records[key];
    } else {
      projection.records[key] = sanitizeRecord(record);
    }
  }
  for (const [alias, target] of Object.entries(payload.aliases || {})) {
    if (target == null) {
      delete projection.aliases[alias];
    } else {
      const existingTarget = projection.aliases[alias] || null;
      if (
        existingTarget
        && existingTarget !== String(target)
        && projection.records[existingTarget]
      ) {
        throw new StoreRecoveryError(
          'session_store_alias_conflict',
          'WAL attempted to transfer a Session alias without merging its owner.'
        );
      }
      projection.aliases[alias] = String(target);
    }
  }
  projection.storeRevision = revision;
  projection.globalAssistantSeq = nextHighWater;
  return projection;
}

class SessionRecordStore {
  static async open(options = {}) {
    const store = new SessionRecordStore(options);
    await store.openStore();
    return store;
  }

  constructor(options = {}) {
    if (!options.rootDir) {
      throw new TypeError('SessionRecordStore requires rootDir');
    }
    this.rootDir = path.resolve(options.rootDir);
    this.legacyMetadataPath = options.legacyMetadataPath
      ? path.resolve(options.legacyMetadataPath)
      : null;
    this.snapshotEvery = Math.max(1, Number(options.snapshotEvery || 250));
    this.now = options.now || (() => new Date().toISOString());
    this.currentSnapshotPath = path.join(this.rootDir, 'snapshot-current.json');
    this.previousSnapshotPath = path.join(this.rootDir, 'snapshot-previous.json');
    this.nextSnapshotPath = path.join(this.rootDir, 'snapshot-next.json');
    this.walPath = path.join(this.rootDir, 'wal-current.jsonl');
    this.nextWalPath = path.join(this.rootDir, 'wal-next.jsonl');
    this.sentinelPath = path.resolve(options.sentinelPath || path.join(
      path.dirname(this.rootDir),
      `.${path.basename(this.rootDir)}.session-store-sentinel.json`
    ));
    this.nextSentinelPath = `${this.sentinelPath}.next`;
    this.projection = emptyProjection();
    this.queue = Promise.resolve();
    this.mutationsClosed = null;
    this.lastSnapshotError = null;
    this.sentinelEstablished = false;
    this.needsSecretRewrite = false;
    this.fileReplaceOptions = options.fileReplaceOptions || {};
  }

  async openStore() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    await this.recoverInterruptedReplacements();
    const sentinel = await this.readSentinelEnvelope();
    const current = await this.readSnapshotEnvelope(this.currentSnapshotPath);
    const previous = await this.readSnapshotEnvelope(this.previousSnapshotPath);
    const validSnapshots = [current, previous]
      .filter((entry) => entry && !entry.error)
      .sort((left, right) => Number(right.projection.storeRevision) - Number(left.projection.storeRevision));
    for (let index = 1; index < validSnapshots.length; index += 1) {
      const left = validSnapshots[index - 1].projection;
      const right = validSnapshots[index].projection;
      if (
        Number(left.storeRevision) === Number(right.storeRevision)
        && projectionStateChecksum(left) !== projectionStateChecksum(right)
      ) {
        throw new StoreRecoveryError(
          'session_store_snapshot_fork',
          `Session store snapshots diverge at revision ${left.storeRevision}.`
        );
      }
    }
    const hasStoreArtifacts = Boolean(current || previous || fs.existsSync(this.walPath));

    if (sentinel?.sentinel?.hasStoreState && !hasStoreArtifacts) {
      throw new StoreRecoveryError(
        'session_store_artifacts_missing',
        'Session store artifacts are missing while its durable sentinel remains.'
      );
    }

    if (validSnapshots.length) {
      this.projection = clone(validSnapshots[0].projection);
    } else {
      this.projection = emptyProjection();
    }

    try {
      await this.replayWal();
    } catch (error) {
      this.mutationsClosed = error.message || String(error);
      throw error;
    }

    if (!validSnapshots.length && hasStoreArtifacts && Number(this.projection.storeRevision) === 0) {
      const snapshotError = current?.error || previous?.error;
      if (snapshotError) {
        throw snapshotError;
      }
    }

    const snapshotStoreIds = [...new Set(
      validSnapshots
        .map((entry) => String(entry.projection.storeId || '').trim())
        .filter(Boolean)
    )];
    if (snapshotStoreIds.length > 1) {
      throw new StoreRecoveryError(
        'session_store_identity_conflict',
        'Session store snapshots have conflicting identities.'
      );
    }
    const sentinelStoreId = String(sentinel?.sentinel?.storeId || '').trim() || null;
    const snapshotStoreId = snapshotStoreIds[0] || null;
    if (sentinelStoreId && snapshotStoreId && sentinelStoreId !== snapshotStoreId) {
      throw new StoreRecoveryError(
        'session_store_identity_conflict',
        'Session store sentinel does not match the recovered snapshots.'
      );
    }
    this.projection.storeId = sentinelStoreId || snapshotStoreId || crypto.randomUUID();

    if (sentinel) {
      const sentinelRevision = nonNegativeInteger(
        sentinel.sentinel.maxStoreRevision,
        'sentinel Store revision',
        'session_store_sentinel_invalid'
      );
      const sentinelAssistantSeq = nonNegativeInteger(
        sentinel.sentinel.maxGlobalAssistantSeq,
        'sentinel assistant sequence',
        'session_store_sentinel_invalid'
      );
      if (
        Number(this.projection.storeRevision) < sentinelRevision
        || Number(this.projection.globalAssistantSeq) < sentinelAssistantSeq
      ) {
        throw new StoreRecoveryError(
          'session_store_high_water_rollback',
          'Recovered Session store is older than its durable high-water sentinel.'
        );
      }
      this.sentinelEstablished = true;
    }

    if (this.needsSecretRewrite) {
      await this.rewriteSanitizedArtifacts();
    }

    if (!hasStoreArtifacts && this.legacyMetadataPath && fs.existsSync(this.legacyMetadataPath)) {
      await this.importLegacyMetadata();
      await this.writeSnapshot();
    }
    await this.writeSentinelHighWater(this.projection, {
      hasStoreState: hasStoreArtifacts || fs.existsSync(this.currentSnapshotPath) || fs.existsSync(this.walPath),
      allowCreate: true,
    });
  }

  async readSentinelEnvelope() {
    let text;
    try {
      text = await fs.promises.readFile(this.sentinelPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new StoreRecoveryError('session_store_sentinel_read_failed', redactSecretText(error.message));
    }
    try {
      const envelope = JSON.parse(text);
      if (!envelope?.sentinel || checksum(envelope.sentinel) !== envelope.checksum) {
        throw new Error('sentinel checksum mismatch');
      }
      if (Number(envelope.sentinel.schemaVersion) !== SENTINEL_SCHEMA_VERSION) {
        throw new Error(`unsupported sentinel schema ${envelope.sentinel.schemaVersion}`);
      }
      if (!String(envelope.sentinel.storeId || '').trim()) {
        throw new Error('sentinel store identity is missing');
      }
      nonNegativeInteger(
        envelope.sentinel.maxStoreRevision,
        'sentinel Store revision',
        'session_store_sentinel_invalid'
      );
      nonNegativeInteger(
        envelope.sentinel.maxGlobalAssistantSeq,
        'sentinel assistant sequence',
        'session_store_sentinel_invalid'
      );
      return envelope;
    } catch (error) {
      if (error instanceof StoreRecoveryError) {
        throw error;
      }
      throw new StoreRecoveryError(
        'session_store_sentinel_invalid',
        `Invalid Session store sentinel: ${redactSecretText(error.message)}`
      );
    }
  }

  async readSnapshotEnvelope(filePath) {
    let text;
    try {
      text = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      return { error: new StoreRecoveryError('session_store_snapshot_read_failed', error.message) };
    }
    try {
      const envelope = JSON.parse(text);
      if (!envelope || typeof envelope !== 'object' || !envelope.projection) {
        throw new Error('snapshot envelope is missing projection');
      }
      if (checksum(envelope.projection) !== envelope.checksum) {
        throw new Error('snapshot checksum mismatch');
      }
      if (Number(envelope.projection.schemaVersion) !== SCHEMA_VERSION) {
        throw new Error(`unsupported snapshot schema ${envelope.projection.schemaVersion}`);
      }
      validateProjection(envelope.projection);
      const safeProjection = sanitizeProjection(envelope.projection);
      const containsSecrets = JSON.stringify(safeProjection) !== JSON.stringify(envelope.projection);
      if (containsSecrets) {
        this.needsSecretRewrite = true;
      }
      return {
        ...envelope,
        checksum: checksum(safeProjection),
        projection: safeProjection,
      };
    } catch (error) {
      return {
        error: new StoreRecoveryError(
          'session_store_snapshot_invalid',
          `Invalid Session store snapshot ${filePath}: ${error.message}`
        ),
      };
    }
  }

  async readWalEntries() {
    let text;
    try {
      text = await fs.promises.readFile(this.walPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw new StoreRecoveryError('session_store_wal_read_failed', error.message);
    }
    const entries = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        throw new StoreRecoveryError(
          'session_store_wal_invalid',
          `Invalid WAL JSON at line ${index + 1}: ${error.message}`
        );
      }
      if (!entry.payload || Number(entry.revision) !== Number(entry.payload.revision)) {
        throw new StoreRecoveryError('session_store_wal_invalid', `Invalid WAL envelope at line ${index + 1}`);
      }
      if (checksum(entry.payload) !== entry.checksum) {
        throw new StoreRecoveryError('session_store_checksum_gap', `Invalid WAL checksum at revision ${entry.revision}`);
      }
      const safePayload = sanitizePayload(entry.payload);
      if (JSON.stringify(safePayload) !== JSON.stringify(entry.payload)) {
        this.needsSecretRewrite = true;
      }
      entries.push({
        ...entry,
        checksum: checksum(safePayload),
        payload: safePayload,
      });
    }
    return entries;
  }

  async replayWal() {
    const entries = await this.readWalEntries();
    let previousWalRevision = null;
    for (const entry of entries) {
      const revision = Number(entry.revision);
      if (previousWalRevision !== null && revision !== previousWalRevision + 1) {
        throw new StoreRecoveryError(
          'session_store_revision_gap',
          `WAL revision gap between ${previousWalRevision} and ${revision}`
        );
      }
      previousWalRevision = revision;
      if (revision <= Number(this.projection.storeRevision || 0)) {
        continue;
      }
      applyPayload(this.projection, entry.payload);
    }
  }

  async importLegacyMetadata() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.promises.readFile(this.legacyMetadataPath, 'utf8'));
    } catch (error) {
      throw new StoreRecoveryError('session_store_legacy_invalid', `Unable to load legacy Session metadata: ${error.message}`);
    }
    for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
      const hostId = String(entry?.hostId || '').trim();
      const identity = String(entry?.identity || entry?.sessionId || entry?.conversationKey || '').trim();
      if (!hostId || !identity) {
        continue;
      }
      const canonicalKey = `${hostId}::${identity}`;
      const legacyRunId = `legacy-${crypto.createHash('sha256').update(canonicalKey).digest('hex').slice(0, 16)}`;
      this.projection.records[canonicalKey] = defaultRecord({
        hostId,
        conversationKey: identity,
        title: String(entry.title || '').trim(),
        cwd: String(entry.cwd || '').trim() || null,
        source: String(entry.source || 'metadata').trim() || 'metadata',
        latestSuccessfulRunId: legacyRunId,
        runs: {
          [legacyRunId]: {
            status: 'stopped',
            launchMode: 'resume',
            parentRunId: null,
            nativeResumeReady: true,
            apiBinding: { kind: 'unknown', modelProviderHint: null },
            requestedSelection: { model: null, effort: null, source: 'legacy_metadata' },
            effectiveSelection: { model: null, effort: null, confirmedAt: null },
            createdAt: entry.updatedAt || this.now(),
            endedAt: entry.updatedAt || this.now(),
          },
        },
        notification: {
          baselineEstablishedAt: entry.updatedAt || this.now(),
          ledger: {},
          latestAssistantSeq: 0,
        },
        updatedAt: entry.updatedAt || this.now(),
      });
      this.projection.aliases[canonicalKey] = canonicalKey;
    }
  }

  transact(kind, mutator) {
    const run = () => this.commit(kind, mutator);
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async commit(kind, mutator) {
    if (this.mutationsClosed) {
      throw new StoreRecoveryError('session_store_mutation_closed', this.mutationsClosed);
    }
    const tx = new Transaction(this.projection);
    const result = mutator(tx);
    if (result && typeof result.then === 'function') {
      throw new TypeError('SessionRecordStore transaction callback must be synchronous');
    }
    const revision = Number(this.projection.storeRevision || 0) + 1;
    const payload = tx.payload(revision, String(kind || 'session.mutation'));
    const envelope = {
      revision,
      checksum: checksum(payload),
      payload,
    };
    // Records are cloned before a Transaction mutates them, so a shallow
    // projection copy is sufficient here. Deep-cloning the complete Store on
    // every mutation made prompt admission compete with unrelated history.
    const nextProjection = {
      ...this.projection,
      records: { ...this.projection.records },
      aliases: { ...this.projection.aliases },
    };
    applyPayload(nextProjection, payload);
    try {
      await this.appendWal(envelope);
    } catch (error) {
      const wrapped = error instanceof StoreRecoveryError
        && error.code === 'session_store_wal_write_failed'
        ? error
        : new StoreRecoveryError(
          'session_store_wal_write_failed',
          `Unable to append the Session store WAL: ${redactSecretText(error.message || String(error))}`
        );
      this.mutationsClosed = wrapped.message;
      throw wrapped;
    }
    try {
      await this.writeSentinelHighWater(nextProjection, { hasStoreState: true });
    } catch (error) {
      const wrapped = error instanceof StoreRecoveryError
        ? error
        : new StoreRecoveryError(
          'session_store_sentinel_write_failed',
          `Unable to advance Session store sentinel: ${redactSecretText(error.message || String(error))}`
        );
      this.mutationsClosed = wrapped.message;
      throw wrapped;
    }
    this.projection = nextProjection;
    if (revision % this.snapshotEvery === 0) {
      try {
        await this.writeSnapshot();
        this.lastSnapshotError = null;
      } catch (error) {
        const wrapped = new StoreRecoveryError(
          'session_store_snapshot_failed',
          `Unable to persist Session store snapshot: ${redactSecretText(error.message || String(error))}`
        );
        this.lastSnapshotError = wrapped;
        if (snapshotFailureRequiresReadOnly(error)) {
          // The WAL and sentinel already committed this revision. Do not report
          // it as rejected, but stop the next mutation on a broken invariant.
          this.mutationsClosed = wrapped.message;
        }
      }
    }
    return result;
  }

  async appendWal(envelope) {
    const handle = await fs.promises.open(this.walPath, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  readSnapshot() {
    return clone(this.projection);
  }

  readHealth() {
    const snapshotError = this.lastSnapshotError?.message
      ? redactSecretText(this.lastSnapshotError.message)
      : null;
    if (this.mutationsClosed) {
      return {
        status: 'failed',
        writable: false,
        revision: Number(this.projection.storeRevision || 0),
        snapshotError,
        error: redactSecretText(this.mutationsClosed),
      };
    }
    return {
      status: snapshotError ? 'degraded' : 'ok',
      writable: true,
      revision: Number(this.projection.storeRevision || 0),
      snapshotError,
      error: null,
    };
  }

  resolveCanonicalKey(identity) {
    const { hostId, ids } = normalizeIdentityKeys(identity);
    if (!hostId || !ids.length) {
      return null;
    }
    for (const id of ids) {
      const target = this.projection.aliases[`${hostId}::${id}`];
      if (target) return target;
    }
    return `${hostId}::${ids[0]}`;
  }

  readAliasesForCanonicalKey(identityOrKey) {
    const canonicalKey = typeof identityOrKey === 'string'
      ? String(identityOrKey || '').trim()
      : this.resolveCanonicalKey(identityOrKey);
    if (!canonicalKey) return [];
    return Object.entries(this.projection.aliases)
      .filter(([, target]) => target === canonicalKey)
      .map(([alias]) => alias)
      .sort();
  }

  readRecord(identity) {
    const { hostId, ids } = normalizeIdentityKeys(identity);
    if (!hostId || !ids.length) {
      return null;
    }
    let canonicalKey = null;
    for (const id of ids) {
      canonicalKey ||= this.projection.aliases[`${hostId}::${id}`] || null;
    }
    canonicalKey ||= `${hostId}::${ids[0]}`;
    return clone(this.projection.records[canonicalKey] || null);
  }

  flushSnapshot() {
    const run = async () => {
      try {
        await this.writeSnapshot();
        this.lastSnapshotError = null;
      } catch (error) {
        const wrapped = error instanceof StoreRecoveryError && error.code === 'session_store_snapshot_failed'
          ? error
          : new StoreRecoveryError(
            'session_store_snapshot_failed',
            `Unable to persist Session store snapshot: ${redactSecretText(error.message || String(error))}`
        );
        this.lastSnapshotError = wrapped;
        if (snapshotFailureRequiresReadOnly(error)) {
          this.mutationsClosed = wrapped.message;
        }
        throw wrapped;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async rewriteSanitizedArtifacts() {
    const nextProjection = sanitizeProjection(this.projection);
    nextProjection.generation = Number(nextProjection.generation || 0) + 1;
    const envelope = {
      revision: nextProjection.storeRevision,
      checksum: checksum(nextProjection),
      projection: nextProjection,
    };
    const contents = `${JSON.stringify(envelope, null, 2)}\n`;
    await this.writeSyncedFile(this.nextSnapshotPath, contents);
    const validated = await this.readSnapshotEnvelope(this.nextSnapshotPath);
    if (!validated || validated.error) {
      throw validated?.error || new StoreRecoveryError(
        'session_store_snapshot_invalid',
        'Sanitized Session store snapshot could not be validated.'
      );
    }
    await this.replaceFile(this.nextSnapshotPath, this.currentSnapshotPath);
    await this.syncDirectory();
    const previousNextPath = `${this.previousSnapshotPath}.next`;
    await this.writeSyncedFile(previousNextPath, contents);
    await this.replaceFile(previousNextPath, this.previousSnapshotPath);
    await this.syncDirectory();
    await this.writeSyncedFile(this.nextWalPath, '');
    await this.replaceFile(this.nextWalPath, this.walPath);
    await this.syncDirectory();
    this.projection = nextProjection;
    this.needsSecretRewrite = false;
    await this.writeSentinelHighWater(this.projection, {
      hasStoreState: true,
      allowCreate: true,
    });
  }

  async writeSnapshot() {
    const nextProjection = clone(this.projection);
    nextProjection.generation = Number(nextProjection.generation || 0) + 1;
    const nextEnvelope = {
      revision: nextProjection.storeRevision,
      checksum: checksum(nextProjection),
      projection: nextProjection,
    };
    await this.writeSyncedFile(this.nextSnapshotPath, `${JSON.stringify(nextEnvelope, null, 2)}\n`);
    const validatedNext = await this.readSnapshotEnvelope(this.nextSnapshotPath);
    if (!validatedNext || validatedNext.error) {
      throw validatedNext?.error || new StoreRecoveryError(
        'session_store_snapshot_invalid',
        'New Session store snapshot could not be validated.'
      );
    }

    if (fs.existsSync(this.currentSnapshotPath)) {
      const current = await this.readSnapshotEnvelope(this.currentSnapshotPath);
      if (current && !current.error) {
        if (
          current.projection.storeId
          && current.projection.storeId !== nextProjection.storeId
        ) {
          throw new StoreRecoveryError(
            'session_store_identity_conflict',
            'Current Session store snapshot belongs to another Store.'
          );
        }
        if (
          Number(current.projection.storeRevision) > Number(nextProjection.storeRevision)
          || Number(current.projection.globalAssistantSeq) > Number(nextProjection.globalAssistantSeq)
        ) {
          throw new StoreRecoveryError(
            'session_store_high_water_rollback',
            'Snapshot rotation would regress the Session store high-water mark.'
          );
        }
        const previousNextPath = `${this.previousSnapshotPath}.next`;
        await this.writeSyncedFile(previousNextPath, `${JSON.stringify(current, null, 2)}\n`);
        await this.replaceFile(previousNextPath, this.previousSnapshotPath);
      } else {
        const previous = await this.readSnapshotEnvelope(this.previousSnapshotPath);
        if (!previous || previous.error) {
          throw current?.error || previous?.error || new StoreRecoveryError(
            'session_store_snapshot_invalid',
            'No retained snapshot can support current-snapshot repair.'
          );
        }
      }
    }
    await this.replaceFile(this.nextSnapshotPath, this.currentSnapshotPath);
    this.projection.generation = nextProjection.generation;
    await this.syncDirectory();
    await this.compactWal();
    await this.writeSentinelHighWater(this.projection, { hasStoreState: true });
  }

  async writeSentinelHighWater(projection, options = {}) {
    const existing = await this.readSentinelEnvelope();
    if (!existing && this.sentinelEstablished && !options.allowCreate) {
      throw new StoreRecoveryError(
        'session_store_sentinel_missing',
        'Session store sentinel disappeared while the Store was open.'
      );
    }
    const storeId = String(projection.storeId || '').trim();
    if (!storeId) {
      throw new StoreRecoveryError('session_store_sentinel_invalid', 'Session store identity is unavailable.');
    }
    const revision = nonNegativeInteger(
      projection.storeRevision,
      'Store revision',
      'session_store_revision_invalid'
    );
    const assistantSeq = nonNegativeInteger(
      projection.globalAssistantSeq,
      'assistant sequence',
      'session_store_high_water_invalid'
    );
    const prior = existing?.sentinel || null;
    if (prior && prior.storeId !== storeId) {
      throw new StoreRecoveryError(
        'session_store_identity_conflict',
        'Session store sentinel belongs to another Store.'
      );
    }
    const priorRevision = Number(prior?.maxStoreRevision || 0);
    const priorAssistantSeq = Number(prior?.maxGlobalAssistantSeq || 0);
    if (revision < priorRevision || assistantSeq < priorAssistantSeq) {
      throw new StoreRecoveryError(
        'session_store_high_water_rollback',
        'Session store cannot regress its durable high-water sentinel.'
      );
    }
    const sentinel = {
      schemaVersion: SENTINEL_SCHEMA_VERSION,
      storeId,
      maxStoreRevision: Math.max(revision, priorRevision),
      maxGlobalAssistantSeq: Math.max(assistantSeq, priorAssistantSeq),
      hasStoreState: Boolean(prior?.hasStoreState || options.hasStoreState),
    };
    const envelope = { checksum: checksum(sentinel), sentinel };
    await fs.promises.mkdir(path.dirname(this.sentinelPath), { recursive: true });
    await this.writeSyncedFile(this.nextSentinelPath, `${JSON.stringify(envelope, null, 2)}\n`);
    await this.replaceFile(this.nextSentinelPath, this.sentinelPath);
    await this.syncDirectory(path.dirname(this.sentinelPath));
    this.sentinelEstablished = true;
  }

  async compactWal() {
    const previous = await this.readSnapshotEnvelope(this.previousSnapshotPath);
    if (!previous || previous.error) {
      return;
    }
    const previousRevision = Number(previous.projection.storeRevision || 0);
    const entries = await this.readWalEntries();
    const retained = entries.filter((entry) => Number(entry.revision) > previousRevision);
    const contents = retained.length
      ? `${retained.map((entry) => JSON.stringify(entry)).join('\n')}\n`
      : '';
    await this.writeSyncedFile(this.nextWalPath, contents);
    await this.replaceFile(this.nextWalPath, this.walPath);
    await this.syncDirectory();
  }

  async writeSyncedFile(filePath, contents) {
    const handle = await fs.promises.open(filePath, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async replaceFile(sourcePath, destinationPath) {
    await replaceFileWithBackupAsync(sourcePath, destinationPath, this.fileReplaceOptions);
  }

  async recoverInterruptedReplacements() {
    for (const targetPath of [
      this.currentSnapshotPath,
      this.previousSnapshotPath,
      this.walPath,
      this.sentinelPath,
    ]) {
      await recoverMissingFileFromBackupAsync(targetPath, this.fileReplaceOptions);
    }
  }

  async syncDirectory(directory = this.rootDir) {
    let handle;
    try {
      handle = await fs.promises.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EISDIR', 'EINVAL', 'EPERM', 'EACCES'].includes(error.code)) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async close() {
    await this.queue;
  }
}

module.exports = {
  SCHEMA_VERSION,
  SessionRecordStore,
  StoreRecoveryError,
  stripSecrets,
};
