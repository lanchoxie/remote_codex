(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.MessageNotificationClient = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const RECEIPT_SCHEMA_VERSION = 4;
  const OUTBOX_SCHEMA_VERSION = 1;
  const OUTBOX_DRAIN_BATCH_SIZE = 50;
  const DEFAULT_PRESENTED_OUTBOX_LIMIT = 1000;
  const DEFAULT_PENDING_OUTBOX_LIMIT = 2000;
  const DEFAULT_OUTBOX_BYTE_LIMIT = 512 * 1024;
  const QUOTA_RETRY_PENDING_LIMIT = 100;
  const QUOTA_RETRY_BYTE_LIMIT = 64 * 1024;
  const OUTBOX_PREVIEW_TEXT_LIMIT = 280;
  const DEFAULT_PRESENTED_OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function sequence(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  }

  function limitedText(value, limit) {
    return text(value).slice(0, limit);
  }

  function isQuotaExceededError(error) {
    const name = text(error?.name).toLowerCase();
    const message = text(error?.message).toLowerCase();
    return name === 'quotaexceedederror'
      || name === 'ns_error_dom_quota_reached'
      || Number(error?.code) === 22
      || Number(error?.code) === 1014
      || (message.includes('storage') && message.includes('quota'))
      || message.includes('exceeded the quota');
  }

  function serializedByteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  function serializedOutboxEntryByteLength(id, item) {
    return serializedByteLength(id) + 1 + serializedByteLength(item);
  }

  function serializedOutboxByteLength(items) {
    let total = serializedByteLength({ version: OUTBOX_SCHEMA_VERSION, items: {} });
    let count = 0;
    for (const [id, item] of Object.entries(items)) {
      if (count > 0) total += 1;
      total += serializedOutboxEntryByteLength(id, item);
      count += 1;
    }
    return total;
  }

  function unique(values) {
    return [...new Set((values || []).map(text).filter(Boolean))];
  }

  function normalizeSequenceAliases(...values) {
    const aliases = Object.create(null);
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      for (const [rawFrom, rawTo] of Object.entries(value)) {
        const from = sequence(rawFrom);
        const to = sequence(rawTo);
        if (!from || !to || from === to) continue;
        aliases[String(from)] = to;
      }
    }
    return aliases;
  }

  function sameSequenceAliases(leftValue, rightValue) {
    const left = Object.entries(leftValue || {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const right = Object.entries(rightValue || {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    return left.length === right.length
      && left.every(([key, value], index) => key === right[index][0] && value === right[index][1]);
  }

  function normalizeReceiptIdStates(value, activeIds, fallbackUpdatedAt, aliases = {}) {
    const states = Object.create(null);
    if (value && typeof value === 'object') {
      for (const [rawId, rawState] of Object.entries(value)) {
        const id = text(rawId);
        if (!id) continue;
        const state = rawState && typeof rawState === 'object' ? rawState : { active: rawState !== false };
        states[id] = {
          active: state.active !== false,
          assistantSeq: normalizeSequence(state.assistantSeq, aliases),
          updatedAt: text(state.updatedAt) || fallbackUpdatedAt,
        };
      }
    }
    for (const id of unique(activeIds)) {
      if (!Object.prototype.hasOwnProperty.call(states, id)) {
        states[id] = { active: true, assistantSeq: 0, updatedAt: fallbackUpdatedAt };
      }
    }
    return states;
  }

  function activeReceiptIds(states) {
    return Object.entries(states || {})
      .filter(([, state]) => state?.active !== false)
      .map(([id]) => id)
      .sort();
  }

  function sameReceiptIdStates(leftValue, rightValue) {
    const left = Object.entries(leftValue || {}).sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
    const right = Object.entries(rightValue || {}).sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
    if (left.length !== right.length) return false;
    return left.every(([id, state], index) => {
      const [rightId, rightState] = right[index];
      return id === rightId
        && state?.active !== false === (rightState?.active !== false)
        && sequence(state?.assistantSeq) === sequence(rightState?.assistantSeq)
        && text(state?.updatedAt) === text(rightState?.updatedAt);
    });
  }

  function mergeReceiptIdStates(leftValue, rightValue) {
    const merged = Object.create(null);
    const ids = new Set([...Object.keys(leftValue || {}), ...Object.keys(rightValue || {})]);
    for (const id of ids) {
      const left = leftValue?.[id] || null;
      const right = rightValue?.[id] || null;
      if (!left || !right) {
        merged[id] = { ...(left || right) };
        continue;
      }
      const leftTime = Date.parse(left.updatedAt || '') || 0;
      const rightTime = Date.parse(right.updatedAt || '') || 0;
      const winner = left.active === false && right.active !== false
        ? left
        : right.active === false && left.active !== false
          ? right
          : leftTime > rightTime
            ? left
            : right;
      merged[id] = {
        ...winner,
        assistantSeq: Math.max(sequence(left.assistantSeq), sequence(right.assistantSeq)),
        updatedAt: leftTime >= rightTime ? left.updatedAt : right.updatedAt,
      };
    }
    return merged;
  }

  function mergeReceiptDimension(local, stored, cursorField, stateField) {
    const merged = mergeReceiptIdStates(local[stateField], stored[stateField]);
    const localCursor = sequence(local[cursorField]);
    const storedCursor = sequence(stored[cursorField]);
    if (localCursor === storedCursor) return merged;
    const higher = localCursor > storedCursor ? local : stored;
    const lower = higher === local ? stored : local;
    const higherCursor = Math.max(localCursor, storedCursor);
    for (const [id, state] of Object.entries(lower[stateField] || {})) {
      if (
        state?.active !== false
        && !Object.prototype.hasOwnProperty.call(higher[stateField] || {}, id)
        && sequence(state.assistantSeq) <= higherCursor
      ) {
        merged[id] = {
          active: false,
          assistantSeq: sequence(state.assistantSeq),
          updatedAt: higher.updatedAt,
        };
      }
    }
    return merged;
  }

  function setReceiptIdState(states, idValue, active, updatedAt, assistantSeq = 0) {
    const id = text(idValue);
    if (!id) return false;
    const current = states[id] || null;
    const nextSeq = Math.max(sequence(current?.assistantSeq), sequence(assistantSeq));
    if (current && current.active === active && sequence(current.assistantSeq) === nextSeq) return false;
    states[id] = { active, assistantSeq: nextSeq, updatedAt };
    return true;
  }

  function nowIso(options) {
    return (options?.now || (() => new Date().toISOString()))();
  }

  function normalizeSequence(value, aliases = {}) {
    let current = sequence(value);
    const visited = [];
    const seen = new Set();
    while (!seen.has(current)) {
      seen.add(current);
      visited.push(current);
      const next = sequence(aliases[String(current)]);
      if (!next || next === current) return current;
      current = next;
    }
    return Math.min(...visited, current);
  }

  function emptyReceipt(canonicalConversationKey, now = () => new Date().toISOString()) {
    const updatedAt = now();
    return {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      canonicalConversationKey: text(canonicalConversationKey),
      sequenceAliases: Object.create(null),
      readThroughAssistantSeq: 0,
      unreadAssistantIds: [],
      unreadAssistantStates: Object.create(null),
      notifiedThroughAssistantSeq: 0,
      unnotifiedAssistantIds: [],
      unnotifiedAssistantStates: Object.create(null),
      updatedAt,
    };
  }

  function normalizeReceipt(value, canonicalConversationKey, options = {}) {
    const receipt = value && typeof value === 'object' ? value : {};
    const updatedAt = text(receipt.updatedAt) || nowIso(options);
    const sequenceAliases = normalizeSequenceAliases(receipt.sequenceAliases, options.sequenceAliases);
    const unreadAssistantStates = normalizeReceiptIdStates(
      receipt.unreadAssistantStates,
      receipt.unreadAssistantIds,
      updatedAt,
      sequenceAliases
    );
    const unnotifiedAssistantStates = normalizeReceiptIdStates(
      receipt.unnotifiedAssistantStates,
      receipt.unnotifiedAssistantIds,
      updatedAt,
      sequenceAliases
    );
    return {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      canonicalConversationKey: text(canonicalConversationKey || receipt.canonicalConversationKey),
      sequenceAliases,
      readThroughAssistantSeq: normalizeSequence(receipt.readThroughAssistantSeq, sequenceAliases),
      unreadAssistantIds: activeReceiptIds(unreadAssistantStates),
      unreadAssistantStates,
      notifiedThroughAssistantSeq: normalizeSequence(receipt.notifiedThroughAssistantSeq, sequenceAliases),
      unnotifiedAssistantIds: activeReceiptIds(unnotifiedAssistantStates),
      unnotifiedAssistantStates,
      updatedAt,
    };
  }

  function sameIds(left, right) {
    if (left.length !== right.length) return false;
    const rightIds = new Set(right);
    return left.every((value) => rightIds.has(value));
  }

  function receiptMateriallyEqual(leftValue, rightValue) {
    if (!leftValue || !rightValue) return false;
    const left = normalizeReceipt(leftValue, leftValue.canonicalConversationKey);
    const right = normalizeReceipt(rightValue, rightValue.canonicalConversationKey);
    return left.canonicalConversationKey === right.canonicalConversationKey
      && left.readThroughAssistantSeq === right.readThroughAssistantSeq
      && left.notifiedThroughAssistantSeq === right.notifiedThroughAssistantSeq
      && sameSequenceAliases(left.sequenceAliases, right.sequenceAliases)
      && sameIds(left.unreadAssistantIds, right.unreadAssistantIds)
      && sameIds(left.unnotifiedAssistantIds, right.unnotifiedAssistantIds)
      && sameReceiptIdStates(left.unreadAssistantStates, right.unreadAssistantStates)
      && sameReceiptIdStates(left.unnotifiedAssistantStates, right.unnotifiedAssistantStates);
  }

  function applyAssistantProjection(receiptValue, projection = {}, options = {}) {
    const aliases = normalizeSequenceAliases(
      receiptValue?.sequenceAliases,
      projection.sequenceAliases
    );
    const receipt = normalizeReceipt(
      { ...receiptValue, sequenceAliases: aliases },
      projection.canonicalConversationKey,
      options
    );
    receipt.readThroughAssistantSeq = normalizeSequence(receipt.readThroughAssistantSeq, aliases);
    receipt.notifiedThroughAssistantSeq = normalizeSequence(receipt.notifiedThroughAssistantSeq, aliases);
    const updatedAt = nowIso(options);
    for (const message of Array.isArray(projection.messages) ? projection.messages : []) {
      const id = text(message.assistantMessageId);
      if (!id || message.notifiable === false) continue;
      const assistantSeq = normalizeSequence(message.assistantSeq, aliases);
      if (
        assistantSeq > receipt.readThroughAssistantSeq
        && !Object.prototype.hasOwnProperty.call(receipt.unreadAssistantStates, id)
      ) {
        setReceiptIdState(receipt.unreadAssistantStates, id, true, updatedAt, assistantSeq);
      }
      if (
        assistantSeq > receipt.notifiedThroughAssistantSeq
        && !Object.prototype.hasOwnProperty.call(receipt.unnotifiedAssistantStates, id)
      ) {
        setReceiptIdState(receipt.unnotifiedAssistantStates, id, true, updatedAt, assistantSeq);
      }
    }
    receipt.unreadAssistantIds = activeReceiptIds(receipt.unreadAssistantStates);
    receipt.unnotifiedAssistantIds = activeReceiptIds(receipt.unnotifiedAssistantStates);
    receipt.updatedAt = updatedAt;
    const latest = normalizeSequence(projection.latestAssistantSeq, aliases);
    return {
      receipt,
      unread: latest > receipt.readThroughAssistantSeq || receipt.unreadAssistantIds.length > 0,
      unnotified: latest > receipt.notifiedThroughAssistantSeq || receipt.unnotifiedAssistantIds.length > 0,
    };
  }

  function receiptCoversMessage(receipt, message, field, exceptionField, aliases) {
    const cursor = normalizeSequence(receipt[field], aliases);
    const messageSeq = normalizeSequence(message.assistantSeq, aliases);
    return cursor >= messageSeq && !new Set(receipt[exceptionField] || []).has(message.assistantMessageId);
  }

  function receiptExplicitlyClearsMessage(receipt, message, stateField) {
    const id = text(message?.assistantMessageId);
    return Boolean(id && receipt?.[stateField]?.[id]?.active === false);
  }

  function mergeAliasReceipts(input = {}) {
    const inputReceipts = Array.isArray(input.receipts) ? input.receipts : [];
    const aliases = normalizeSequenceAliases(
      ...inputReceipts.map((receipt) => receipt?.sequenceAliases),
      input.sequenceAliases
    );
    const receipts = inputReceipts.map((receipt) => normalizeReceipt(
      { ...receipt, sequenceAliases: aliases },
      receipt?.canonicalConversationKey,
      input
    ));
    const byKey = new Map(receipts.map((receipt) => [receipt.canonicalConversationKey, receipt]));
    const merged = emptyReceipt(input.canonicalConversationKey, input.now);
    merged.sequenceAliases = aliases;
    merged.readThroughAssistantSeq = Math.max(
      0,
      ...receipts.map((receipt) => normalizeSequence(receipt.readThroughAssistantSeq, aliases))
    );
    merged.notifiedThroughAssistantSeq = Math.max(
      0,
      ...receipts.map((receipt) => normalizeSequence(receipt.notifiedThroughAssistantSeq, aliases))
    );
    const unreadAssistantStates = receipts.reduce(
      (states, receipt) => mergeReceiptIdStates(states, receipt.unreadAssistantStates),
      Object.create(null)
    );
    const unnotifiedAssistantStates = receipts.reduce(
      (states, receipt) => mergeReceiptIdStates(states, receipt.unnotifiedAssistantStates),
      Object.create(null)
    );
    for (const message of Array.isArray(input.messages) ? input.messages : []) {
      const id = text(message.assistantMessageId);
      if (!id) continue;
      const lineageReceipts = unique(message.lineageKeys)
        .map((key) => byKey.get(key))
        .filter(Boolean);
      if (!lineageReceipts.length) {
        if (
          normalizeSequence(message.assistantSeq, aliases) > merged.readThroughAssistantSeq
          && unreadAssistantStates[id]?.active !== false
        ) {
          setReceiptIdState(
            unreadAssistantStates,
            id,
            true,
            merged.updatedAt,
            message.assistantSeq
          );
        }
        if (
          normalizeSequence(message.assistantSeq, aliases) > merged.notifiedThroughAssistantSeq
          && unnotifiedAssistantStates[id]?.active !== false
        ) {
          setReceiptIdState(
            unnotifiedAssistantStates,
            id,
            true,
            merged.updatedAt,
            message.assistantSeq
          );
        }
        continue;
      }
      const explicitlyRead = lineageReceipts.some((receipt) => receiptExplicitlyClearsMessage(
        receipt,
        message,
        'unreadAssistantStates'
      ));
      if (
        !explicitlyRead
        && unreadAssistantStates[id]?.active !== false
        && lineageReceipts.some((receipt) => !receiptCoversMessage(
        receipt, message, 'readThroughAssistantSeq', 'unreadAssistantIds', aliases
        ))
      ) {
        setReceiptIdState(unreadAssistantStates, id, true, merged.updatedAt, message.assistantSeq);
      }
      const explicitlyNotified = lineageReceipts.some((receipt) => receiptExplicitlyClearsMessage(
        receipt,
        message,
        'unnotifiedAssistantStates'
      ));
      if (
        !explicitlyNotified
        && unnotifiedAssistantStates[id]?.active !== false
        && lineageReceipts.some((receipt) => !receiptCoversMessage(
        receipt, message, 'notifiedThroughAssistantSeq', 'unnotifiedAssistantIds', aliases
        ))
      ) {
        setReceiptIdState(unnotifiedAssistantStates, id, true, merged.updatedAt, message.assistantSeq);
      }
    }
    merged.updatedAt = nowIso(input);
    merged.unreadAssistantStates = unreadAssistantStates;
    merged.unreadAssistantIds = activeReceiptIds(unreadAssistantStates);
    merged.unnotifiedAssistantStates = unnotifiedAssistantStates;
    merged.unnotifiedAssistantIds = activeReceiptIds(unnotifiedAssistantStates);
    return merged;
  }

  function advanceReadReceipt(receiptValue, projection = {}, options = {}) {
    const aliases = normalizeSequenceAliases(receiptValue?.sequenceAliases, projection.sequenceAliases);
    const receipt = normalizeReceipt(
      { ...receiptValue, sequenceAliases: aliases },
      projection.canonicalConversationKey,
      options
    );
    const updatedAt = nowIso(options);
    receipt.readThroughAssistantSeq = normalizeSequence(
      Math.max(receipt.readThroughAssistantSeq, sequence(projection.latestAssistantSeq)),
      aliases
    );
    const visibleIds = new Set((projection.messages || []).map((message) => text(message.assistantMessageId)));
    for (const [id, state] of Object.entries(receipt.unreadAssistantStates)) {
      if (options.clearAllUnread === true || visibleIds.has(id)) {
        setReceiptIdState(receipt.unreadAssistantStates, id, false, updatedAt, state.assistantSeq);
      }
    }
    receipt.unreadAssistantIds = activeReceiptIds(receipt.unreadAssistantStates);
    receipt.updatedAt = updatedAt;
    return receipt;
  }

  function advanceNotifiedReceipt(receiptValue, projection = {}, message = {}, options = {}) {
    const aliases = normalizeSequenceAliases(receiptValue?.sequenceAliases, projection.sequenceAliases);
    const receipt = normalizeReceipt(
      { ...receiptValue, sequenceAliases: aliases },
      projection.canonicalConversationKey,
      options
    );
    const updatedAt = nowIso(options);
    const assistantMessageId = text(message.assistantMessageId);
    const assistantSeq = normalizeSequence(message.assistantSeq, aliases);
    receipt.notifiedThroughAssistantSeq = normalizeSequence(
      Math.max(receipt.notifiedThroughAssistantSeq, assistantSeq),
      aliases
    );
    if (assistantMessageId) {
      setReceiptIdState(
        receipt.unnotifiedAssistantStates,
        assistantMessageId,
        false,
        updatedAt,
        assistantSeq
      );
    }
    receipt.unnotifiedAssistantIds = activeReceiptIds(receipt.unnotifiedAssistantStates);
    receipt.updatedAt = updatedAt;
    return receipt;
  }

  function migrateLegacyReceipt(legacy, options = {}) {
    const receipt = emptyReceipt(options.canonicalConversationKey, options.now);
    const marker = text(legacy?.lastReadMessageKey);
    const exact = (options.messages || []).find((message) => text(message.legacyMarker) === marker);
    const baseline = exact ? sequence(exact.assistantSeq) : sequence(options.baselineHighWater);
    receipt.readThroughAssistantSeq = baseline;
    receipt.notifiedThroughAssistantSeq = baseline;
    return receipt;
  }

  class ReadEligibilityGate {
    constructor() {
      this.followEstablished = false;
      this.detached = false;
      this.lastSource = 'none';
    }

    establishFollow(reason, options = {}) {
      const allowed = reason === 'session-selection' || reason === 'outer-user-boundary';
      if (!allowed || options.trusted !== true) return false;
      this.followEstablished = true;
      this.detached = false;
      this.lastSource = 'user';
      return true;
    }

    detachByUser() {
      this.detached = true;
      this.lastSource = 'user';
    }

    noteProgrammaticScroll() {
      if (!this.followEstablished || this.detached) {
        this.lastSource = 'programmatic';
      }
    }

    noteThinkingScroll() {
      return false;
    }

    canAdvance(context = {}) {
      return Boolean(
        this.followEstablished
        && !this.detached
        && context.selected === true
        && context.visible === true
        && context.focused === true
        && context.renderCurrent === true
        && context.atReadingBoundary === true
        && this.lastSource === 'user'
        && context.outerScrollSource === 'user'
      );
    }

    state() {
      return {
        followEstablished: this.followEstablished,
        detached: this.detached,
        lastSource: this.lastSource,
      };
    }
  }

  function queueExclusivePersistence(store) {
    if (store.persistPromise) {
      store.persistAgainRequested = true;
      return store.persistPromise;
    }
    let runner = null;
    runner = Promise.resolve().then(async () => {
      try {
        do {
          store.persistAgainRequested = false;
          if (!store.dirty) continue;
          let entered = false;
          await store.runExclusive(() => {
            entered = true;
            return store.persistUnlocked();
          });
          if (!entered) {
            throw new Error('Notification storage lock did not enter its critical section');
          }
        } while (store.dirty || store.persistAgainRequested);
        return true;
      } finally {
        if (store.persistPromise === runner) store.persistPromise = null;
      }
    });
    store.persistPromise = runner;
    runner.catch((error) => {
      try {
        store.onPersistError(error);
      } catch {
        // The original persistence error remains observable to explicit awaiters.
      }
    });
    return runner;
  }

  async function waitForPersistence(store) {
    let persisted = false;
    while (store.persistPromise || store.dirty) {
      const pending = store.persistPromise || store.persist();
      if (pending && typeof pending.then === 'function') {
        await pending;
        persisted = true;
      } else {
        return Boolean(pending) || persisted;
      }
    }
    return persisted;
  }

  class ReceiptStore {
    constructor(options = {}) {
      this.load = options.load || (() => null);
      this.save = options.save || (() => {});
      this.onPersist = options.onPersist || (() => {});
      this.runExclusive = options.runExclusive || null;
      this.onLockUnavailable = options.onLockUnavailable || (() => {});
      this.onPersistError = options.onPersistError || (() => {});
      this.onPersistenceDisabled = options.onPersistenceDisabled || (() => {});
      this.now = options.now || (() => new Date().toISOString());
      this.receipts = new Map();
      this.dirty = false;
      this.batchDepth = 0;
      this.persistPromise = null;
      this.persistAgainRequested = false;
      this.persistenceDisabled = false;
      try {
        const loaded = this.load();
        const parsed = typeof loaded === 'string'
          ? JSON.parse(loaded || '{}')
          : (loaded || {});
        const source = parsed.receipts && typeof parsed.receipts === 'object'
          ? parsed.receipts
          : parsed;
        for (const [key, value] of Object.entries(source || {})) {
          const receipt = normalizeReceipt(value, key, { now: this.now });
          if (receipt.canonicalConversationKey) this.receipts.set(key, receipt);
        }
      } catch {
        this.receipts.clear();
      }
    }

    get(key) {
      const canonicalKey = text(key);
      return normalizeReceipt(
        this.receipts.get(canonicalKey) || emptyReceipt(canonicalKey, this.now),
        canonicalKey,
        { now: this.now }
      );
    }

    has(key) {
      return this.receipts.has(text(key));
    }

    keys() {
      return [...this.receipts.keys()];
    }

    values() {
      return [...this.receipts.values()].map((receipt) => normalizeReceipt(
        receipt,
        receipt.canonicalConversationKey,
        { now: this.now }
      ));
    }

    set(receiptValue) {
      const receipt = normalizeReceipt(receiptValue, receiptValue?.canonicalConversationKey, { now: this.now });
      if (!receipt.canonicalConversationKey) throw new TypeError('canonicalConversationKey is required');
      const current = this.receipts.get(receipt.canonicalConversationKey);
      if (current && receiptMateriallyEqual(current, receipt)) {
        return this.get(receipt.canonicalConversationKey);
      }
      this.receipts.set(receipt.canonicalConversationKey, receipt);
      this.dirty = true;
      if (this.batchDepth === 0) this.flush();
      return this.get(receipt.canonicalConversationKey);
    }

    batch(callback) {
      if (typeof callback !== 'function') throw new TypeError('ReceiptStore batch callback is required');
      const outermost = this.batchDepth === 0;
      const snapshot = outermost ? new Map(this.receipts) : null;
      const dirtyBefore = this.dirty;
      this.batchDepth += 1;
      let result;
      try {
        result = callback(this);
        if (result && typeof result.then === 'function') {
          throw new TypeError('ReceiptStore batches must be synchronous');
        }
      } catch (error) {
        this.batchDepth -= 1;
        if (outermost) {
          this.receipts = snapshot;
          this.dirty = dirtyBefore;
        }
        throw error;
      }
      this.batchDepth -= 1;
      if (outermost) this.flush();
      return result;
    }

    flush() {
      if (this.persistPromise) {
        if (this.dirty) this.persistAgainRequested = true;
        return this.persistPromise;
      }
      if (!this.dirty) return false;
      return this.persist();
    }

    whenIdle() {
      return waitForPersistence(this);
    }

    readDurable(options = {}) {
      try {
        const loaded = this.load();
        const parsed = typeof loaded === 'string'
          ? JSON.parse(loaded || '{}')
          : (loaded || {});
        const source = parsed.receipts && typeof parsed.receipts === 'object'
          ? parsed.receipts
          : parsed;
        const durable = new Map();
        for (const [key, value] of Object.entries(source || {})) {
          const receipt = normalizeReceipt(value, key, { now: this.now });
          if (receipt.canonicalConversationKey) durable.set(key, receipt);
        }
        return durable;
      } catch (error) {
        if (options.strict === true) throw error;
        return new Map();
      }
    }

    reload() {
      if (this.dirty || this.persistenceDisabled) return this.values();
      this.receipts = this.readDurable();
      return this.values();
    }

    isPersistenceDisabled() {
      return this.persistenceDisabled;
    }

    persist() {
      if (this.persistPromise) {
        if (this.dirty) this.persistAgainRequested = true;
        return this.persistPromise;
      }
      if (!this.dirty) return false;
      if (typeof this.runExclusive === 'function') {
        return queueExclusivePersistence(this);
      }
      return this.persistUnlocked();
    }

    persistUnlocked() {
      if (!this.dirty) return false;
      if (this.persistenceDisabled) {
        this.dirty = false;
        return false;
      }
      const durable = this.readDurable({ strict: true });
      for (const [key, stored] of durable.entries()) {
        const local = this.receipts.get(key);
        if (!local) {
          this.receipts.set(key, stored);
          continue;
        }
        const localUpdated = Date.parse(local.updatedAt || '') || 0;
        const storedUpdated = Date.parse(stored.updatedAt || '') || 0;
        const sequenceAliases = localUpdated >= storedUpdated
          ? normalizeSequenceAliases(stored.sequenceAliases, local.sequenceAliases)
          : normalizeSequenceAliases(local.sequenceAliases, stored.sequenceAliases);
        const normalizedLocal = normalizeReceipt(
          { ...local, sequenceAliases },
          key,
          { now: this.now }
        );
        const normalizedStored = normalizeReceipt(
          { ...stored, sequenceAliases },
          key,
          { now: this.now }
        );
        const unreadAssistantStates = mergeReceiptDimension(
          normalizedLocal,
          normalizedStored,
          'readThroughAssistantSeq',
          'unreadAssistantStates'
        );
        const unnotifiedAssistantStates = mergeReceiptDimension(
          normalizedLocal,
          normalizedStored,
          'notifiedThroughAssistantSeq',
          'unnotifiedAssistantStates'
        );
        this.receipts.set(key, {
          ...normalizedLocal,
          sequenceAliases,
          readThroughAssistantSeq: Math.max(
            normalizedLocal.readThroughAssistantSeq,
            normalizedStored.readThroughAssistantSeq
          ),
          unreadAssistantIds: activeReceiptIds(unreadAssistantStates),
          unreadAssistantStates,
          notifiedThroughAssistantSeq: Math.max(
            normalizedLocal.notifiedThroughAssistantSeq,
            normalizedStored.notifiedThroughAssistantSeq
          ),
          unnotifiedAssistantIds: activeReceiptIds(unnotifiedAssistantStates),
          unnotifiedAssistantStates,
          updatedAt: localUpdated >= storedUpdated ? local.updatedAt : stored.updatedAt,
        });
      }
      try {
        this.save(JSON.stringify({
          version: RECEIPT_SCHEMA_VERSION,
          receipts: Object.fromEntries(this.receipts),
        }));
      } catch (error) {
        if (!isQuotaExceededError(error)) throw error;
        this.persistenceDisabled = true;
        this.dirty = false;
        try {
          this.onPersistenceDisabled(error);
        } catch {
          // Storage diagnostics must not break in-memory receipt tracking.
        }
        return false;
      }
      this.dirty = false;
      try {
        this.onPersist();
      } catch {
        // Cross-tab notification is best effort after durable storage succeeds.
      }
      return true;
    }
  }

  function stableHash(value) {
    let hash = 14695981039346656037n;
    for (const byte of new TextEncoder().encode(String(value))) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 1099511628211n);
    }
    return hash.toString(16).padStart(16, '0');
  }

  function alertIdFor(canonicalConversationKey, assistantMessageId) {
    return `assistant-alert:${stableHash(`${canonicalConversationKey}\0${assistantMessageId}`)}`;
  }

  function normalizeOutboxItem(value, alertId, now) {
    if (!value || typeof value !== 'object') return null;
    const canonicalConversationKey = limitedText(value.canonicalConversationKey, 512);
    const assistantMessageId = limitedText(value.assistantMessageId, 512);
    if (!canonicalConversationKey || !assistantMessageId || !alertId) return null;
    return {
      alertId,
      canonicalConversationKey,
      assistantMessageId,
      assistantSeq: sequence(value.assistantSeq),
      assistantAt: limitedText(value.assistantAt, 64),
      previewText: limitedText(value.previewText, OUTBOX_PREVIEW_TEXT_LIMIT),
      hostId: limitedText(value.hostId, 256),
      sessionId: limitedText(value.sessionId, 512),
      revision: Math.max(1, sequence(value.revision)),
      status: value.status === 'presented' ? 'presented' : 'pending',
      updatedAt: limitedText(value.updatedAt, 64) || now,
    };
  }

  function compareOutboxOldest(left, right) {
    return (Date.parse(left[1]?.updatedAt || '') || 0) - (Date.parse(right[1]?.updatedAt || '') || 0)
      || sequence(left[1]?.assistantSeq) - sequence(right[1]?.assistantSeq)
      || left[0].localeCompare(right[0]);
  }

  class NotificationOutbox {
    constructor(options = {}) {
      this.load = options.load || (() => ({}));
      this.save = options.save || (() => {});
      this.clear = options.clear || (() => {});
      this.onPersist = options.onPersist || (() => {});
      this.runExclusive = options.runExclusive || null;
      this.onLockUnavailable = options.onLockUnavailable || (() => {});
      this.onPersistError = options.onPersistError || (() => {});
      this.onPersistenceDisabled = options.onPersistenceDisabled || (() => {});
      this.onQuotaRecovered = options.onQuotaRecovered || (() => {});
      this.now = options.now || (() => new Date().toISOString());
      this.presentedLimit = Math.max(
        0,
        Number(options.presentedLimit ?? DEFAULT_PRESENTED_OUTBOX_LIMIT) || 0
      );
      this.presentedRetentionMs = Math.max(
        0,
        Number(options.presentedRetentionMs ?? DEFAULT_PRESENTED_OUTBOX_RETENTION_MS) || 0
      );
      this.pendingLimit = Math.max(
        1,
        Number(options.pendingLimit ?? DEFAULT_PENDING_OUTBOX_LIMIT) || DEFAULT_PENDING_OUTBOX_LIMIT
      );
      this.byteLimit = Math.max(
        1024,
        Number(options.byteLimit ?? DEFAULT_OUTBOX_BYTE_LIMIT) || DEFAULT_OUTBOX_BYTE_LIMIT
      );
      this.items = {};
      this.drainPromise = null;
      this.drainAgainRequested = false;
      this.dirty = false;
      this.batchDepth = 0;
      this.persistPromise = null;
      this.persistAgainRequested = false;
      this.persistenceDisabled = false;
      let normalized = false;
      try {
        const raw = this.load();
        const loaded = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
        const source = loaded.items && typeof loaded.items === 'object' ? loaded.items : loaded;
        for (const [id, item] of Object.entries(source || {})) {
          const next = normalizeOutboxItem(item, id, this.now());
          if (!next) {
            normalized = true;
            continue;
          }
          this.items[id] = next;
          if (JSON.stringify({ ...item, alertId: id }) !== JSON.stringify(next)) normalized = true;
        }
      } catch {
        this.items = {};
      }
      if (normalized || this.pruneToLimits()) {
        this.dirty = true;
        try {
          this.flush();
        } catch {
          // Keep the compacted in-memory state dirty for the next persistence attempt.
        }
      }
    }

    prunePresented() {
      const now = Date.parse(this.now()) || Date.now();
      const presented = Object.entries(this.items)
        .filter(([, item]) => item?.status === 'presented')
        .sort((left, right) => (
          (Date.parse(right[1]?.updatedAt || '') || 0) - (Date.parse(left[1]?.updatedAt || '') || 0)
          || sequence(right[1]?.assistantSeq) - sequence(left[1]?.assistantSeq)
          || left[0].localeCompare(right[0])
        ));
      let retained = 0;
      let changed = false;
      for (const [id, item] of presented) {
        const updatedAt = Date.parse(item?.updatedAt || '') || 0;
        const expired = updatedAt > 0 && now - updatedAt > this.presentedRetentionMs;
        if (expired || retained >= this.presentedLimit) {
          delete this.items[id];
          changed = true;
        } else {
          retained += 1;
        }
      }
      return changed;
    }

    prunePending(limit = this.pendingLimit) {
      const pending = Object.entries(this.items)
        .filter(([, item]) => item?.status !== 'presented')
        .sort(compareOutboxOldest);
      const removeCount = Math.max(0, pending.length - Math.max(0, limit));
      for (let index = 0; index < removeCount; index += 1) {
        delete this.items[pending[index][0]];
      }
      return removeCount > 0;
    }

    pruneToByteLimit(limit = this.byteLimit) {
      let total = serializedOutboxByteLength(this.items);
      if (total <= limit) return false;
      const candidates = [
        ...Object.entries(this.items)
          .filter(([, item]) => item?.status === 'presented')
          .sort(compareOutboxOldest),
        ...Object.entries(this.items)
          .filter(([, item]) => item?.status !== 'presented')
          .sort(compareOutboxOldest),
      ];
      let changed = false;
      let count = Object.keys(this.items).length;
      for (const [id, item] of candidates) {
        total -= serializedOutboxEntryByteLength(id, item) + (count > 1 ? 1 : 0);
        delete this.items[id];
        count -= 1;
        changed = true;
        if (total <= limit) break;
      }
      return changed;
    }

    pruneToLimits() {
      const presentedChanged = this.prunePresented();
      const pendingChanged = this.prunePending();
      const bytesChanged = this.pruneToByteLimit();
      return presentedChanged || pendingChanged || bytesChanged;
    }

    compactForQuotaRetry() {
      let changed = false;
      for (const [id, item] of Object.entries(this.items)) {
        if (item?.status === 'presented') {
          delete this.items[id];
          changed = true;
          continue;
        }
        const previewText = limitedText(item?.previewText, 160);
        if (previewText !== item.previewText) {
          this.items[id] = { ...item, previewText };
          changed = true;
        }
      }
      const pendingChanged = this.prunePending(Math.min(this.pendingLimit, QUOTA_RETRY_PENDING_LIMIT));
      const bytesChanged = this.pruneToByteLimit(Math.min(this.byteLimit, QUOTA_RETRY_BYTE_LIMIT));
      return changed || pendingChanged || bytesChanged;
    }

    isPersistenceDisabled() {
      return this.persistenceDisabled;
    }

    persist() {
      if (this.persistPromise) {
        if (this.dirty) this.persistAgainRequested = true;
        return this.persistPromise;
      }
      if (!this.dirty) return false;
      if (typeof this.runExclusive === 'function') {
        return queueExclusivePersistence(this);
      }
      return this.persistUnlocked();
    }

    persistUnlocked() {
      if (!this.dirty) return false;
      if (this.persistenceDisabled) {
        this.pruneToLimits();
        this.dirty = false;
        return false;
      }
      const raw = this.load();
      const loaded = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      const source = loaded.items && typeof loaded.items === 'object' ? loaded.items : loaded;
      for (const [id, durable] of Object.entries(source || {})) {
        const normalizedDurable = normalizeOutboxItem(durable, id, this.now());
        if (!normalizedDurable) continue;
        const local = this.items[id];
        const durableRevision = sequence(normalizedDurable.revision);
        const localRevision = sequence(local?.revision);
        if (
          !local
          || durableRevision > localRevision
          || (
            durableRevision === localRevision
            && normalizedDurable.status === 'presented'
            && local.status !== 'presented'
          )
        ) {
          if (
            local
            && durableRevision > localRevision
            && normalizedDurable.status === 'pending'
            && this.drainPromise
          ) {
            this.drainAgainRequested = true;
          }
          this.items[id] = normalizedDurable;
        }
      }
      this.pruneToLimits();
      let payload = { version: OUTBOX_SCHEMA_VERSION, items: this.items };
      let quotaRecovered = false;
      try {
        this.save(payload);
      } catch (error) {
        if (!isQuotaExceededError(error)) throw error;
        this.compactForQuotaRetry();
        payload = { version: OUTBOX_SCHEMA_VERSION, items: this.items };
        try {
          this.save(payload);
          quotaRecovered = true;
        } catch (retryError) {
          if (!isQuotaExceededError(retryError)) throw retryError;
          try {
            this.clear();
          } catch {
            // Clearing an obsolete durable snapshot is best effort.
          }
          try {
            this.save(payload);
            quotaRecovered = true;
          } catch (finalError) {
            if (!isQuotaExceededError(finalError)) throw finalError;
            this.persistenceDisabled = true;
            this.dirty = false;
            try {
              this.onPersistenceDisabled(finalError);
            } catch {
              // Storage diagnostics must not break the in-memory outbox.
            }
            return false;
          }
        }
      }
      this.dirty = false;
      try {
        this.onPersist();
      } catch {
        // Cross-tab notification is best effort after durable storage succeeds.
      }
      if (quotaRecovered) {
        try {
          this.onQuotaRecovered();
        } catch {
          // Recovery follow-up is best effort after durable storage succeeds.
        }
      }
      return true;
    }

    batch(callback) {
      if (typeof callback !== 'function') throw new TypeError('NotificationOutbox batch callback is required');
      const outermost = this.batchDepth === 0;
      const snapshot = outermost ? { ...this.items } : null;
      const dirtyBefore = this.dirty;
      this.batchDepth += 1;
      let result;
      try {
        result = callback(this);
        if (result && typeof result.then === 'function') {
          throw new TypeError('NotificationOutbox batches must be synchronous');
        }
      } catch (error) {
        this.batchDepth -= 1;
        if (outermost) {
          this.items = snapshot;
          this.dirty = dirtyBefore;
        }
        throw error;
      }
      this.batchDepth -= 1;
      if (outermost) this.flush();
      return result;
    }

    flush() {
      if (this.persistPromise) {
        if (this.dirty) this.persistAgainRequested = true;
        return this.persistPromise;
      }
      if (!this.dirty) return false;
      return this.persist();
    }

    whenIdle() {
      return waitForPersistence(this);
    }

    reload() {
      if (this.dirty || this.persistenceDisabled) return this.all();
      try {
        const raw = this.load();
        const loaded = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
        const source = loaded.items && typeof loaded.items === 'object' ? loaded.items : loaded;
        const next = {};
        let normalizedChanged = false;
        for (const [id, item] of Object.entries(source || {})) {
          const normalized = normalizeOutboxItem(item, id, this.now());
          if (!normalized) {
            normalizedChanged = true;
            continue;
          }
          next[id] = normalized;
          if (JSON.stringify({ ...item, alertId: id }) !== JSON.stringify(normalized)) {
            normalizedChanged = true;
          }
        }
        this.items = next;
        if (normalizedChanged || this.pruneToLimits()) {
          this.dirty = true;
          this.flush();
        }
      } catch {
        // Keep the last valid in-memory snapshot when storage is temporarily unavailable.
      }
      return this.all();
    }

    enqueue(message = {}) {
      const canonicalConversationKey = text(message.canonicalConversationKey);
      const assistantMessageId = text(message.assistantMessageId);
      if (!canonicalConversationKey || !assistantMessageId) {
        throw new TypeError('Notification outbox message identity is required');
      }
      const alertId = alertIdFor(canonicalConversationKey, assistantMessageId);
      const current = this.items[alertId];
      let changed = false;
      if (!current || current.status !== 'presented') {
        const next = normalizeOutboxItem({
          ...current,
          ...message,
          canonicalConversationKey,
          assistantMessageId,
          alertId,
          status: 'pending',
          updatedAt: this.now(),
        }, alertId, this.now());
        const unchanged = current
          && current.status === next.status
          && current.canonicalConversationKey === next.canonicalConversationKey
          && current.assistantMessageId === next.assistantMessageId
          && sequence(current.assistantSeq) === sequence(next.assistantSeq)
          && text(current.assistantAt) === text(next.assistantAt)
          && text(current.previewText) === text(next.previewText)
          && text(current.hostId) === text(next.hostId)
          && text(current.sessionId) === text(next.sessionId);
        if (!unchanged) {
          next.revision = sequence(current?.revision) + 1;
          this.items[alertId] = next;
          this.dirty = true;
          changed = true;
          if (this.drainPromise) this.drainAgainRequested = true;
          if (this.batchDepth === 0) this.flush();
        }
      }
      return { ...this.items[alertId], changed };
    }

    get(alertId) {
      return this.items[alertId] ? { ...this.items[alertId] } : null;
    }

    all() {
      return Object.fromEntries(Object.entries(this.items).map(([id, item]) => [id, { ...item }]));
    }

    drain(presenters = {}) {
      if (this.drainPromise) {
        this.drainAgainRequested = true;
        return this.drainPromise;
      }
      this.drainPromise = Promise.resolve().then(async () => {
        if (this.dirty || this.persistPromise) await this.whenIdle();
        const attempted = new Set();
        let firstFailure = null;
        do {
          this.drainAgainRequested = false;
          const pending = Object.values(this.items)
            .filter((value) => (
              value.status === 'pending'
              && !attempted.has(`${value.alertId}\0${sequence(value.revision)}`)
            ))
            .sort((left, right) => (
              sequence(left.assistantSeq) - sequence(right.assistantSeq)
              || text(left.alertId).localeCompare(text(right.alertId))
            ));
          for (let offset = 0; offset < pending.length; offset += OUTBOX_DRAIN_BATCH_SIZE) {
            const ready = [];
            for (const item of pending.slice(offset, offset + OUTBOX_DRAIN_BATCH_SIZE)) {
              attempted.add(`${item.alertId}\0${sequence(item.revision)}`);
              try {
                await presenters.presentInApp(item);
                const result = await presenters.presentSystem(item);
                if (result?.presented === true || result?.explicitlyUnavailable === true) {
                  ready.push(item);
                }
              } catch (error) {
                firstFailure ||= error;
              }
            }
            const stableReady = ready.filter((item) => {
              const current = this.items[item.alertId] || null;
              const unchanged = current
                && current.status === 'pending'
                && sequence(current.revision) === sequence(item.revision);
              if (current?.status === 'pending' && !unchanged) this.drainAgainRequested = true;
              return unchanged;
            });
            if (stableReady.length) {
              try {
                if (typeof presenters.advanceNotifiedBatch === 'function') {
                  await presenters.advanceNotifiedBatch(stableReady);
                } else {
                  for (const item of stableReady) {
                    await presenters.advanceNotified(item);
                  }
                }
                const completedReady = stableReady.filter((item) => {
                  const current = this.items[item.alertId];
                  const unchanged = current
                    && current.status === 'pending'
                    && sequence(current.revision) === sequence(item.revision);
                  if (current?.status === 'pending' && !unchanged) this.drainAgainRequested = true;
                  return unchanged;
                });
                for (const item of completedReady) {
                  const current = this.items[item.alertId];
                  current.status = 'presented';
                  current.updatedAt = this.now();
                  this.items[item.alertId] = current;
                }
                if (completedReady.length) {
                  this.dirty = true;
                  await this.flush();
                }
              } catch (error) {
                firstFailure ||= error;
              }
            }
            if (offset + OUTBOX_DRAIN_BATCH_SIZE < pending.length) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }
        } while (this.drainAgainRequested);
        if (firstFailure) throw firstFailure;
      }).finally(() => {
        this.drainPromise = null;
      });
      return this.drainPromise;
    }
  }

  function parseLease(raw) {
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  }

  function acquireStorageLease(options = {}) {
    const storage = options.storage;
    const key = text(options.key || 'mobile-codex-remote.message-notification-lease.v1');
    const ownerId = text(options.ownerId);
    const now = Number((options.now || Date.now)());
    const ttlMs = Math.max(1000, Number(options.ttlMs || 8000));
    if (!storage?.getItem || !storage?.setItem || !key || !ownerId) return null;
    const current = parseLease(storage.getItem(key));
    if (current && Number(current.expiresAt || 0) > now && current.ownerId !== ownerId) {
      return null;
    }
    const nonce = text(options.nonce)
      || `${ownerId}:${now}:${Math.random().toString(36).slice(2)}`;
    const lease = { ownerId, nonce, expiresAt: now + ttlMs };
    storage.setItem(key, JSON.stringify(lease));
    const confirmed = parseLease(storage.getItem(key));
    return confirmed?.ownerId === ownerId && confirmed?.nonce === nonce ? lease : null;
  }

  function releaseStorageLease(options = {}, lease = null) {
    const storage = options.storage;
    const key = text(options.key || 'mobile-codex-remote.message-notification-lease.v1');
    if (!lease || !storage?.getItem || !key) return false;
    const current = parseLease(storage.getItem(key));
    if (current?.ownerId !== lease.ownerId || current?.nonce !== lease.nonce) return false;
    storage.removeItem?.(key);
    return true;
  }

  async function drainOutboxWithElection(options = {}) {
    const navigatorValue = options.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const run = () => {
      if (options.reload === true) options.outbox.reload?.();
      return options.outbox.drain(options.presenters);
    };
    if (navigatorValue?.locks?.request) {
      return navigatorValue.locks.request(
        'mobile-codex-remote.notification-outbox',
        { mode: 'exclusive', ifAvailable: true },
        (lock) => (lock ? run() : false)
      );
    }
    if (typeof options.acquireLease === 'function') {
      const lease = await options.acquireLease();
      if (!lease) return false;
      try {
        return await run();
      } finally {
        await options.releaseLease?.(lease);
      }
    }
    const lease = acquireStorageLease({
      storage: options.storage,
      key: options.leaseKey,
      ownerId: options.ownerId,
      now: options.now,
      ttlMs: options.leaseTtlMs,
    });
    if (!lease) return false;
    try {
      return await run();
    } finally {
      releaseStorageLease({ storage: options.storage, key: options.leaseKey }, lease);
    }
  }

  return {
    NotificationOutbox,
    ReadEligibilityGate,
    ReceiptStore,
    acquireStorageLease,
    advanceNotifiedReceipt,
    advanceReadReceipt,
    alertIdFor,
    applyAssistantProjection,
    drainOutboxWithElection,
    emptyReceipt,
    isQuotaExceededError,
    mergeAliasReceipts,
    migrateLegacyReceipt,
    normalizeReceipt,
    releaseStorageLease,
  };
}));
