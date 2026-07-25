function text(value) {
  return String(value == null ? '' : value).trim();
}

function watchRevision(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function watchOwnerKey(input = {}) {
  const clientId = text(input.clientId);
  if (!clientId) {
    return '';
  }
  return `owner:${JSON.stringify([clientId, text(input.viewId) || 'primary'])}`;
}

function strongIdentityValues(input = {}) {
  return [
    input.sessionId,
    input.requestedSessionId,
    input.nativeThreadId,
    input.bridgeSessionId,
    input.originSessionId,
    input.sourceSessionId,
  ].map(text).filter(Boolean);
}

function fallbackIdentityValues(input = {}) {
  return [input.conversationKey].map(text).filter(Boolean);
}

function identityValues(input = {}) {
  return [...new Set([...strongIdentityValues(input), ...fallbackIdentityValues(input)])];
}

function targetsOverlap(left = {}, right = {}) {
  const leftStrong = new Set(strongIdentityValues(left));
  const rightStrong = strongIdentityValues(right);
  if (leftStrong.size && rightStrong.length) {
    return rightStrong.some((identity) => leftStrong.has(identity));
  }
  const leftFallback = new Set(fallbackIdentityValues(left));
  return fallbackIdentityValues(right).some((identity) => leftFallback.has(identity));
}

function legacyWatchKey(input = {}) {
  const identities = identityValues(input);
  return identities.length ? `legacy:${JSON.stringify(identities)}` : '';
}

function ownerRevisionRecord(ownerRevisions, ownerKey) {
  const record = ownerKey && ownerRevisions instanceof Map ? ownerRevisions.get(ownerKey) : null;
  return record && typeof record === 'object' ? record : null;
}

function staleRevision(existing, input, recordedRevision = null) {
  const previous = recordedRevision === null
    ? watchRevision(existing?.watchRevision)
    : watchRevision(recordedRevision);
  const incoming = watchRevision(input?.watchRevision);
  return previous !== null && incoming !== null && incoming < previous;
}

function upsertSessionWatch(entries, command, session, options = {}) {
  const ownerKey = watchOwnerKey(command);
  const key = ownerKey || legacyWatchKey({ ...command, ...session });
  if (!key) {
    return { accepted: false, stale: false, replaced: false, entry: null };
  }

  const existing = entries.get(key) || null;
  const incomingRevision = watchRevision(command.watchRevision);
  const ownerRevisions = options.ownerRevisions;
  const recordedRevision = watchRevision(ownerRevisionRecord(ownerRevisions, ownerKey)?.revision);
  if (
    (existing || recordedRevision !== null)
    && (
      staleRevision(existing, command, recordedRevision)
      || (
        existing
        &&
        incomingRevision !== null
        && incomingRevision === (recordedRevision ?? watchRevision(existing.watchRevision))
        && !targetsOverlap(existing, { ...command, ...session })
      )
    )
  ) {
    return { accepted: false, stale: true, replaced: false, entry: existing };
  }

  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const ttlMs = Math.max(1, Number(options.ttlMs) || 1);
  const entry = {
    ...session,
    clientId: text(command.clientId) || null,
    viewId: text(command.viewId) || null,
    requestedSessionId: text(command.sessionId || command.nativeThreadId) || null,
    conversationKey: text(command.conversationKey || session.conversationKey) || null,
    watchOwnerKey: ownerKey || null,
    watchRevision: incomingRevision,
    expiresAt: now + ttlMs,
  };
  entries.set(key, entry);
  if (ownerKey && ownerRevisions instanceof Map && incomingRevision !== null) {
    ownerRevisions.set(ownerKey, {
      revision: incomingRevision,
      expiresAt: now + ttlMs,
    });
  }
  return {
    accepted: true,
    stale: false,
    replaced: Boolean(existing && !targetsOverlap(existing, entry)),
    entry,
  };
}

function removeSessionWatch(entries, command = {}, options = {}) {
  const ownerKey = watchOwnerKey(command);
  if (ownerKey) {
    const existing = entries.get(ownerKey) || null;
    const ownerRevisions = options.ownerRevisions;
    const recordedRevision = watchRevision(ownerRevisionRecord(ownerRevisions, ownerKey)?.revision);
    const incomingRevision = watchRevision(command.watchRevision);
    if (staleRevision(existing, command, recordedRevision)) {
      return { removed: 0, stale: true };
    }
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const ttlMs = Math.max(1, Number(options.ttlMs) || 1);
    if (ownerRevisions instanceof Map && incomingRevision !== null) {
      ownerRevisions.set(ownerKey, {
        revision: incomingRevision,
        expiresAt: now + ttlMs,
      });
    }
    if (!existing) {
      return { removed: 0, stale: false };
    }
    const supersedesExisting = incomingRevision !== null && (
      watchRevision(existing.watchRevision) === null
      || incomingRevision > watchRevision(existing.watchRevision)
    );
    if (!supersedesExisting && identityValues(command).length && !targetsOverlap(existing, command)) {
      return { removed: 0, stale: false };
    }
    entries.delete(ownerKey);
    return { removed: 1, stale: false };
  }

  const identities = new Set(identityValues(command));
  if (!identities.size) {
    return { removed: 0, stale: false };
  }
  let removed = 0;
  for (const [key, entry] of Array.from(entries.entries())) {
    if (entry.watchOwnerKey) {
      continue;
    }
    if (identityValues(entry).some((identity) => identities.has(identity))) {
      entries.delete(key);
      removed += 1;
    }
  }
  return { removed, stale: false };
}

function pruneExpiredSessionWatches(entries, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  let removed = 0;
  for (const [key, entry] of Array.from(entries.entries())) {
    if (Number(entry.expiresAt || 0) <= now) {
      entries.delete(key);
      removed += 1;
    }
  }
  if (options.ownerRevisions instanceof Map) {
    for (const [key, record] of Array.from(options.ownerRevisions.entries())) {
      if (Number(record?.expiresAt || 0) <= now) {
        options.ownerRevisions.delete(key);
      }
    }
  }
  return removed;
}

module.exports = {
  identityValues,
  pruneExpiredSessionWatches,
  removeSessionWatch,
  targetsOverlap,
  upsertSessionWatch,
  watchOwnerKey,
  watchRevision,
};
