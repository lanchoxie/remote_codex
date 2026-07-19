const NOTIFICATION_SCHEMA_VERSION = 1;
const PREVIEW_TEXT_LIMIT = 1000;
const PROJECTION_LIMIT_MAX = 500;
const EPOCH_ISO = new Date(0).toISOString();

function text(value) {
  return String(value == null ? '' : value).trim();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function sequence(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function revision(value) {
  const number = sequence(value);
  return number === null ? 0 : number;
}

function boundedPreview(value) {
  return text(value).slice(0, PREVIEW_TEXT_LIMIT);
}

function unique(values) {
  return [...new Set((values || []).map(text).filter(Boolean))];
}

function validTimestamp(value) {
  const normalized = text(value);
  return Number.isFinite(Date.parse(normalized)) ? normalized : '';
}

function earliest(left, right) {
  const leftValue = validTimestamp(left);
  const rightValue = validTimestamp(right);
  if (!leftValue) return rightValue || text(left) || text(right) || EPOCH_ISO;
  if (!rightValue) return leftValue;
  return Date.parse(leftValue) <= Date.parse(rightValue) ? leftValue : rightValue;
}

function emptyNotificationState(baselineAt) {
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    migrationBaselineAt: validTimestamp(baselineAt) || EPOCH_ISO,
    ledger: {},
    sequenceAliases: {},
    latestAssistantSeq: 0,
    latestAssistantId: null,
    latestAssistantAt: null,
    projectionRevision: 0,
    cursorUnknown: false,
  };
}

function copyLedger(value) {
  const result = {};
  for (const [key, rawEntry] of Object.entries(
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  )) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      continue;
    }
    const assistantMessageId = text(rawEntry.assistantMessageId || key);
    const assistantSeq = sequence(rawEntry.assistantSeq);
    if (!assistantMessageId || assistantSeq === null) {
      continue;
    }
    result[assistantMessageId] = {
      ...clone(rawEntry),
      assistantMessageId,
      assistantSeq,
      assistantAt: text(rawEntry.assistantAt),
      firstObservedAt: text(rawEntry.firstObservedAt),
      notifiable: rawEntry.notifiable === true,
      finalized: rawEntry.finalized === true,
      previewText: boundedPreview(rawEntry.previewText),
      sourceIdentity: clone(rawEntry.sourceIdentity) || {},
      lineageKeys: unique(rawEntry.lineageKeys),
    };
  }
  return result;
}

function copySequenceAliases(value) {
  const result = {};
  for (const [rawFrom, rawTo] of Object.entries(
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  )) {
    const from = sequence(rawFrom);
    const to = sequence(rawTo);
    if (from === null || to === null || from === to) {
      continue;
    }
    result[String(from)] = to;
  }
  return result;
}

function normalizedNotification(value, baselineAt) {
  const current = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const notification = emptyNotificationState(
    current.migrationBaselineAt
    || current.baselineEstablishedAt
    || baselineAt
  );
  notification.ledger = copyLedger(current.ledger);
  notification.sequenceAliases = copySequenceAliases(current.sequenceAliases);
  notification.projectionRevision = revision(current.projectionRevision);
  notification.cursorUnknown = current.cursorUnknown === true;
  recomputeLatest(notification);
  return notification;
}

function ensureNotification(record, baselineAt) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('Assistant notification state requires a Session record');
  }
  if (
    record.notification?.schemaVersion === NOTIFICATION_SCHEMA_VERSION
    && record.notification.ledger
    && typeof record.notification.ledger === 'object'
    && !Array.isArray(record.notification.ledger)
    && record.notification.sequenceAliases
    && typeof record.notification.sequenceAliases === 'object'
    && !Array.isArray(record.notification.sequenceAliases)
  ) {
    record.notification.migrationBaselineAt = validTimestamp(
      record.notification.migrationBaselineAt
    ) || validTimestamp(baselineAt) || EPOCH_ISO;
    record.notification.projectionRevision = revision(
      record.notification.projectionRevision
    );
    record.notification.cursorUnknown = record.notification.cursorUnknown === true;
    return record.notification;
  }
  record.notification = normalizedNotification(record.notification, baselineAt);
  return record.notification;
}

function recomputeLatest(notification) {
  const latest = Object.values(notification.ledger || {})
    .filter((entry) => entry?.notifiable === true && sequence(entry.assistantSeq) !== null)
    .sort((left, right) => (
      right.assistantSeq - left.assistantSeq
      || text(left.assistantMessageId).localeCompare(text(right.assistantMessageId))
    ))[0] || null;
  notification.latestAssistantSeq = latest ? latest.assistantSeq : 0;
  notification.latestAssistantId = latest ? latest.assistantMessageId : null;
  notification.latestAssistantAt = latest ? text(latest.assistantAt) || null : null;
  return notification;
}

function observationIsNotifiable(observation, migrationBaselineAt, options = {}) {
  const eligibilityAt = options.finalizationTransition
    ? observation.finalizedAt || observation.firstObservedAt
    : observation.assistantAt;
  const assistantMs = Date.parse(text(eligibilityAt));
  const baselineMs = Date.parse(text(migrationBaselineAt));
  return Boolean(
    observation.finalized === true
    && observation.notifiableCandidate === true
    && Number.isFinite(assistantMs)
    && Number.isFinite(baselineMs)
    && assistantMs > baselineMs
  );
}

function seedForCanonicalKey(canonicalKey, observation, baselineAt) {
  const separator = canonicalKey.indexOf('::');
  return {
    canonicalKey,
    hostId: separator >= 0 ? canonicalKey.slice(0, separator) : '',
    conversationKey: separator >= 0 ? canonicalKey.slice(separator + 2) : canonicalKey,
    updatedAt: text(observation.firstObservedAt) || null,
    notification: emptyNotificationState(
      baselineAt || observation.firstObservedAt
    ),
  };
}

function ingestAssistantObservation(tx, input = {}) {
  if (!tx || typeof tx.ensureRecord !== 'function') {
    throw new TypeError('Assistant observation ingestion requires a SessionRecordStore transaction');
  }
  const canonicalKey = text(input.canonicalKey);
  const observation = input.observation;
  const assistantMessageId = text(observation?.assistantMessageId);
  if (!canonicalKey || !assistantMessageId) {
    throw new TypeError('Assistant observation ingestion requires canonicalKey and assistantMessageId');
  }

  const record = tx.ensureRecord(
    canonicalKey,
    seedForCanonicalKey(canonicalKey, observation, input.baselineAt)
  );
  record.canonicalKey ||= canonicalKey;
  const notification = ensureNotification(
    record,
    input.baselineAt || observation.firstObservedAt
  );
  const lineageKey = text(input.lineageKey || canonicalKey);
  const existing = notification.ledger[assistantMessageId];
  if (existing) {
    let changed = false;
    const finalizedNow = existing.finalized !== true && observation.finalized === true;
    const lineageKeys = unique([...(existing.lineageKeys || []), lineageKey]);
    if (JSON.stringify(lineageKeys) !== JSON.stringify(existing.lineageKeys || [])) {
      existing.lineageKeys = lineageKeys;
      changed = true;
    }
    if (observation.finalized === true && existing.finalized !== true) {
      existing.finalized = true;
      changed = true;
    }
    const nextNotifiable = existing.notifiable === true || (
      finalizedNow
      && observationIsNotifiable(
        observation,
        notification.migrationBaselineAt,
        { finalizationTransition: true }
      )
    );
    if (nextNotifiable !== existing.notifiable) {
      existing.notifiable = nextNotifiable;
      changed = true;
    }
    const nextPreview = boundedPreview(observation.previewText);
    if (nextPreview && nextPreview !== existing.previewText) {
      existing.previewText = nextPreview;
      changed = true;
    }
    if (!existing.assistantAt && observation.assistantAt) {
      existing.assistantAt = text(observation.assistantAt);
      changed = true;
    }
    if (!existing.firstObservedAt && observation.firstObservedAt) {
      existing.firstObservedAt = text(observation.firstObservedAt);
      changed = true;
    }
    if (
      (!existing.sourceIdentity || !Object.keys(existing.sourceIdentity).length)
      && observation.sourceIdentity
    ) {
      existing.sourceIdentity = clone(observation.sourceIdentity);
      changed = true;
    }
    if (changed) {
      notification.projectionRevision += 1;
      recomputeLatest(notification);
      tx.markDirty(canonicalKey);
    }
    return { created: false, updated: changed, canonicalKey, entry: existing };
  }

  if (
    typeof tx.allocateGlobalAssistantSeq !== 'function'
    || typeof tx.appendDomainEvent !== 'function'
    || typeof tx.markDirty !== 'function'
  ) {
    throw new TypeError('SessionRecordStore transaction is missing assistant ledger methods');
  }
  const assistantSeq = tx.allocateGlobalAssistantSeq();
  const notifiable = observationIsNotifiable(
    observation,
    notification.migrationBaselineAt
  );
  const entry = {
    assistantMessageId,
    assistantSeq,
    assistantAt: text(observation.assistantAt),
    firstObservedAt: text(observation.firstObservedAt),
    notifiable,
    finalized: observation.finalized === true,
    previewText: boundedPreview(observation.previewText),
    sourceIdentity: clone(observation.sourceIdentity) || {},
    lineageKeys: unique([lineageKey]),
  };
  notification.ledger[assistantMessageId] = entry;
  notification.projectionRevision += 1;
  recomputeLatest(notification);
  tx.appendDomainEvent({
    type: 'assistant.identity_assigned',
    canonicalKey,
    assistantMessageId,
    assistantSeq,
    assistantAt: entry.assistantAt,
    firstObservedAt: entry.firstObservedAt,
    notifiable,
    sourceIdentity: entry.sourceIdentity,
  });
  tx.markDirty(canonicalKey);
  return { created: true, updated: true, canonicalKey, entry };
}

function addSequenceAlias(aliases, rawFrom, rawTo) {
  const from = sequence(rawFrom);
  const to = sequence(rawTo);
  if (from === null || to === null || from === to) {
    return;
  }
  const existing = sequence(aliases[String(from)]);
  aliases[String(from)] = existing === null ? to : Math.min(existing, to);
}

function normalizeSequence(rawValue, aliases) {
  const initial = sequence(rawValue);
  if (initial === null) {
    return 0;
  }
  let current = initial;
  const visited = [];
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    visited.push(current);
    const next = sequence(aliases?.[String(current)]);
    if (next === null || next === current) {
      return current;
    }
    current = next;
  }
  return Math.min(...visited, current);
}

function canonicalizeSequenceAliases(aliases, activeSequences = new Set()) {
  const copied = copySequenceAliases(aliases);
  const result = {};
  for (const rawFrom of Object.keys(copied)) {
    const from = sequence(rawFrom);
    if (from === null || activeSequences.has(from)) {
      continue;
    }
    const target = normalizeSequence(copied[rawFrom], copied);
    if (target !== from) {
      result[String(from)] = target;
    }
  }
  return result;
}

function mergedEntry(current, sourceEntry, context, aliases) {
  const currentSeq = sequence(current.assistantSeq);
  const sourceSeq = sequence(sourceEntry.assistantSeq);
  const keepCurrent = sourceSeq === null
    || (currentSeq !== null && currentSeq <= sourceSeq);
  const keep = keepCurrent ? current : sourceEntry;
  const lose = keepCurrent ? sourceEntry : current;
  if (sequence(lose.assistantSeq) !== sequence(keep.assistantSeq)) {
    addSequenceAlias(aliases, lose.assistantSeq, keep.assistantSeq);
  }
  const preferredPreview = [current, sourceEntry]
    .filter((entry) => entry.finalized === true && boundedPreview(entry.previewText))
    .sort((left, right) => (
      Date.parse(text(right.firstObservedAt)) - Date.parse(text(left.firstObservedAt))
    ))[0]?.previewText
    || keep.previewText
    || lose.previewText;
  return {
    ...clone(keep),
    assistantMessageId: text(keep.assistantMessageId || current.assistantMessageId),
    assistantSeq: sequence(keep.assistantSeq),
    firstObservedAt: earliest(current.firstObservedAt, sourceEntry.firstObservedAt),
    notifiable: current.notifiable === true || sourceEntry.notifiable === true,
    finalized: current.finalized === true || sourceEntry.finalized === true,
    previewText: boundedPreview(preferredPreview),
    sourceIdentity: clone(
      Object.keys(keep.sourceIdentity || {}).length
        ? keep.sourceIdentity
        : lose.sourceIdentity
    ) || {},
    lineageKeys: unique([
      ...(current.lineageKeys || []),
      ...(sourceEntry.lineageKeys || []),
      context.winnerKey,
      context.loserKey,
    ]),
  };
}

function mergeNotificationRecords(winner, loser, context = {}) {
  if (!winner || typeof winner !== 'object' || !loser || typeof loser !== 'object') {
    throw new TypeError('Assistant notification merge requires winner and loser records');
  }
  const winnerKey = text(context.winnerKey || winner.canonicalKey);
  const loserKey = text(context.loserKey || loser.canonicalKey);
  const target = ensureNotification(
    winner,
    loser.notification?.migrationBaselineAt || loser.notification?.baselineEstablishedAt
  );
  const source = normalizedNotification(
    loser.notification,
    target.migrationBaselineAt
  );
  target.migrationBaselineAt = earliest(
    target.migrationBaselineAt,
    source.migrationBaselineAt
  );

  const aliases = {};
  for (const [from, to] of Object.entries(target.sequenceAliases || {})) {
    addSequenceAlias(aliases, from, to);
  }
  for (const [from, to] of Object.entries(source.sequenceAliases || {})) {
    addSequenceAlias(aliases, from, to);
  }

  for (const [assistantMessageId, rawSourceEntry] of Object.entries(source.ledger || {})) {
    const sourceEntry = clone(rawSourceEntry);
    const current = target.ledger[assistantMessageId];
    if (!current) {
      target.ledger[assistantMessageId] = {
        ...sourceEntry,
        assistantMessageId,
        previewText: boundedPreview(sourceEntry.previewText),
        lineageKeys: unique([
          ...(sourceEntry.lineageKeys || []),
          loserKey,
        ]),
      };
      continue;
    }
    target.ledger[assistantMessageId] = mergedEntry(
      current,
      sourceEntry,
      { winnerKey, loserKey },
      aliases
    );
  }

  for (const entry of Object.values(target.ledger)) {
    if (winnerKey && !entry.lineageKeys?.length) {
      entry.lineageKeys = [winnerKey];
    }
  }
  const activeSequences = new Set(
    Object.values(target.ledger)
      .map((entry) => sequence(entry.assistantSeq))
      .filter((value) => value !== null)
  );
  target.sequenceAliases = canonicalizeSequenceAliases(aliases, activeSequences);
  target.projectionRevision = Math.max(
    revision(target.projectionRevision),
    revision(source.projectionRevision)
  ) + 1;
  target.cursorUnknown = target.cursorUnknown === true || source.cursorUnknown === true;
  recomputeLatest(target);
  winner.notification = target;
  if (winnerKey) {
    winner.canonicalKey = winnerKey;
  }
  return winner;
}

function publicAssistantEntry(entry) {
  return {
    assistantMessageId: text(entry.assistantMessageId),
    assistantSeq: sequence(entry.assistantSeq) || 0,
    assistantAt: text(entry.assistantAt) || null,
    firstObservedAt: text(entry.firstObservedAt) || null,
    notifiable: entry.notifiable === true,
    finalized: entry.finalized === true,
    previewText: boundedPreview(entry.previewText),
    lineageKeys: unique(entry.lineageKeys),
  };
}

function canonicalKeyForRecord(record, options) {
  const explicit = text(options.canonicalKey || record?.canonicalKey);
  if (explicit) {
    return explicit;
  }
  const hostId = text(record?.hostId);
  const conversationKey = text(record?.conversationKey);
  return hostId && conversationKey ? `${hostId}::${conversationKey}` : null;
}

function projectAssistantState(record, options = {}) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('Assistant projection requires a Session record');
  }
  const notification = normalizedNotification(record.notification);
  const afterSeq = Math.max(0, sequence(options.afterSeq) ?? 0);
  const requestedLimit = sequence(options.limit);
  const limit = Math.max(
    1,
    Math.min(PROJECTION_LIMIT_MAX, requestedLimit === null ? 100 : requestedLimit)
  );
  const eligible = Object.values(notification.ledger)
    .filter((entry) => entry.notifiable === true && entry.assistantSeq > afterSeq)
    .sort((left, right) => (
      left.assistantSeq - right.assistantSeq
      || text(left.assistantMessageId).localeCompare(text(right.assistantMessageId))
    ));
  const messages = eligible.slice(0, limit).map(publicAssistantEntry);
  return {
    canonicalConversationKey: canonicalKeyForRecord(record, options),
    latestAssistantSeq: notification.latestAssistantSeq,
    latestAssistantId: notification.latestAssistantId,
    latestAssistantAt: notification.latestAssistantAt,
    projectionRevision: notification.projectionRevision,
    cursorUnknown: notification.cursorUnknown,
    sequenceAliases: { ...notification.sequenceAliases },
    aliases: unique([...(record.aliases || []), ...(options.aliases || [])]),
    messages,
    hasMore: eligible.length > messages.length,
    nextAfterSeq: messages.at(-1)?.assistantSeq || afterSeq,
  };
}

function deleteRetainedAssistantIdentities(tx, canonicalKeyValue, assistantIds) {
  if (!tx || typeof tx.getRecord !== 'function' || typeof tx.markDirty !== 'function') {
    throw new TypeError('Assistant identity deletion requires a SessionRecordStore transaction');
  }
  const canonicalKey = text(canonicalKeyValue);
  const record = tx.getRecord(canonicalKey);
  if (!record) {
    return { canonicalKey, deletedAssistantIds: [], deletedAssistantSeqs: [] };
  }
  const notification = ensureNotification(record);
  const deletedAssistantIds = [];
  const deletedAssistantSeqs = [];
  for (const assistantMessageId of unique(assistantIds)) {
    const entry = notification.ledger[assistantMessageId];
    if (!entry) {
      continue;
    }
    deletedAssistantIds.push(assistantMessageId);
    const assistantSeq = sequence(entry.assistantSeq);
    if (assistantSeq !== null) {
      deletedAssistantSeqs.push(assistantSeq);
    }
    delete notification.ledger[assistantMessageId];
  }
  if (!deletedAssistantIds.length) {
    return { canonicalKey, deletedAssistantIds, deletedAssistantSeqs };
  }

  const deletedSequences = new Set(deletedAssistantSeqs);
  const retainedAliases = {};
  for (const [from, to] of Object.entries(notification.sequenceAliases || {})) {
    const fromSeq = sequence(from);
    const resolvedTo = normalizeSequence(to, notification.sequenceAliases);
    if (
      fromSeq === null
      || deletedSequences.has(fromSeq)
      || deletedSequences.has(resolvedTo)
    ) {
      continue;
    }
    addSequenceAlias(retainedAliases, fromSeq, resolvedTo);
  }
  const activeSequences = new Set(
    Object.values(notification.ledger)
      .map((entry) => sequence(entry.assistantSeq))
      .filter((value) => value !== null)
  );
  notification.sequenceAliases = canonicalizeSequenceAliases(
    retainedAliases,
    activeSequences
  );
  notification.projectionRevision += 1;
  recomputeLatest(notification);
  tx.markDirty(canonicalKey);
  return { canonicalKey, deletedAssistantIds, deletedAssistantSeqs };
}

module.exports = {
  deleteRetainedAssistantIdentities,
  emptyNotificationState,
  ingestAssistantObservation,
  mergeNotificationRecords,
  projectAssistantState,
};
