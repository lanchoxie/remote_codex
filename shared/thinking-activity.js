function makeActivityKey(value = {}) {
  return JSON.stringify([
    String(value.canonicalConversationKey || ''),
    String(value.runId || ''),
    String(value.turnId || ''),
    String(value.itemId || ''),
    Number(value.summaryIndex || 0),
  ]);
}

const ACTIVITY_TRUNCATION_SUFFIX = '\n...[activity truncated]';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function truncateActivityText(value, maxBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  const suffixBytes = Buffer.byteLength(ACTIVITY_TRUNCATION_SUFFIX, 'utf8');
  const budget = Math.max(0, maxBytes - suffixBytes);
  const encoded = Buffer.from(text, 'utf8');
  let end = Math.min(encoded.length, budget);
  while (end > 0 && (encoded[end] & 0b11000000) === 0b10000000) end -= 1;
  return {
    text: `${encoded.subarray(0, end).toString('utf8')}${ACTIVITY_TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

class ThinkingActivityAggregator {
  constructor(options = {}) {
    if (typeof options.emitSnapshot !== 'function') {
      throw new TypeError('emitSnapshot is required');
    }

    this.base = {
      canonicalConversationKey: options.canonicalConversationKey,
      runId: options.runId,
    };
    this.delay = options.flushDelayMs === undefined
      ? 75
      : Number(options.flushDelayMs);
    this.emit = options.emitSnapshot;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.now = options.now || (() => new Date().toISOString());
    this.maxRecords = boundedInteger(options.maxRecords, 64, 1, 1024);
    this.maxTextBytes = boundedInteger(
      options.maxTextBytes,
      256 * 1024,
      1024,
      1024 * 1024
    );
    this.maxTotalTextBytes = Math.max(
      this.maxTextBytes,
      boundedInteger(options.maxTotalTextBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024)
    );
    this.onEvict = typeof options.onEvict === 'function' ? options.onEvict : () => {};
    this.records = new Map();
    this.totalTextBytes = 0;
  }

  deleteRecord(key, options = {}) {
    const record = this.records.get(String(key || ''));
    if (!record) return false;
    if (record.timer !== null) this.clearTimer(record.timer);
    this.records.delete(record.activityKey);
    this.totalTextBytes = Math.max(0, this.totalTextBytes - record.textBytes);
    if (options.evicted) this.onEvict(record);
    record.timer = null;
    record.text = '';
    record.textBytes = 0;
    record.emittedText = null;
    return true;
  }

  touch(record) {
    if (this.records.get(record.activityKey) !== record) return;
    this.records.delete(record.activityKey);
    this.records.set(record.activityKey, record);
  }

  enforceBounds(preferredRecord) {
    while (this.records.size > this.maxRecords) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === preferredRecord.activityKey && this.records.size > 1) {
        this.deleteRecord([...this.records.keys()][1], { evicted: true });
      } else {
        this.deleteRecord(oldestKey, { evicted: true });
      }
    }
    while (this.totalTextBytes > this.maxTotalTextBytes && this.records.size > 1) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey === preferredRecord.activityKey) {
        this.deleteRecord([...this.records.keys()][1], { evicted: true });
      } else {
        this.deleteRecord(oldestKey, { evicted: true });
      }
    }
  }

  setRecordText(record, value, maxBytes = this.maxTextBytes) {
    const boundedLimit = boundedInteger(maxBytes, this.maxTextBytes, 1, this.maxTextBytes);
    const bounded = truncateActivityText(value, boundedLimit);
    this.totalTextBytes = Math.max(0, this.totalTextBytes - record.textBytes);
    const changed = record.text !== bounded.text || record.textTruncated !== bounded.truncated;
    record.text = bounded.text;
    record.textBytes = Buffer.byteLength(record.text, 'utf8');
    record.textTruncated = bounded.truncated;
    this.totalTextBytes += record.textBytes;
    if (changed) record.contentRevision += 1;
    this.touch(record);
    this.enforceBounds(record);
    return { ...bounded, changed };
  }

  record(identity = {}) {
    const normalized = {
      ...this.base,
      ...identity,
      summaryIndex: Number(identity.summaryIndex || 0),
    };
    const key = makeActivityKey(normalized);
    if (!this.records.has(key)) {
      this.records.set(key, {
        ...normalized,
        activityKey: key,
        startedAt: this.now(),
        text: '',
        textBytes: 0,
        textTruncated: false,
        emittedText: null,
        contentRevision: 1,
        emittedContentRevision: 0,
        activityRevision: 0,
        timer: null,
      });
      this.enforceBounds(this.records.get(key));
    }
    const record = this.records.get(key);
    if (record) {
      let metadataChanged = false;
      for (const [field, value] of Object.entries(normalized)) {
        if (field === 'startedAt' || field === 'updatedAt' || field === 'timestamp') continue;
        if (!Object.is(record[field], value)) {
          record[field] = value;
          metadataChanged = true;
        }
      }
      if (metadataChanged) record.contentRevision += 1;
      this.touch(record);
    }
    return record;
  }

  appendDelta(identity, delta, options = {}) {
    const record = this.record(identity);
    if (!record || record.textTruncated) return record;
    const result = this.setRecordText(
      record,
      `${record.text}${String(delta ?? '')}`,
      options.maxTextBytes
    );
    if (
      result.changed
      || options.force === true
      || record.contentRevision !== record.emittedContentRevision
    ) this.schedule(record);
    return record;
  }

  replaceSnapshot(identity, text, options = {}) {
    const record = this.record(identity);
    if (!record) return null;
    const result = this.setRecordText(record, text, options.maxTextBytes);
    if (
      result.changed
      || options.force === true
      || record.contentRevision !== record.emittedContentRevision
    ) this.schedule(record);
    return record;
  }

  schedule(record) {
    if (record.timer !== null) return;
    record.timer = this.setTimer(() => {
      record.timer = null;
      return this.flushRecord(record, false);
    }, this.delay);
  }

  async flush(identity, options = {}) {
    return this.flushRecord(this.record(identity), Boolean(options.final));
  }

  async flushRecord(record, final) {
    if (record.timer !== null) {
      this.clearTimer(record.timer);
      record.timer = null;
    }
    if (!final && record.contentRevision === record.emittedContentRevision) return null;

    record.activityRevision += 1;
    record.emittedText = record.text;
    record.emittedContentRevision = record.contentRevision;
    const updatedAt = this.now();
    const snapshot = {
      ...record,
      textBytes: undefined,
      timer: undefined,
      emittedText: undefined,
      contentRevision: undefined,
      emittedContentRevision: undefined,
      final,
      timestamp: updatedAt,
    };
    await this.emit(snapshot);
    return snapshot;
  }

  async flushAll(options = {}) {
    const snapshots = [];
    for (const record of this.records.values()) {
      snapshots.push(await this.flushRecord(record, Boolean(options.final)));
    }
    return snapshots;
  }

  release(identity = {}) {
    const key = makeActivityKey({
      ...this.base,
      ...identity,
      summaryIndex: Number(identity.summaryIndex || 0),
    });
    return this.deleteRecord(key);
  }

  has(identity = {}) {
    const key = makeActivityKey({
      ...this.base,
      ...identity,
      summaryIndex: Number(identity.summaryIndex || 0),
    });
    return this.records.has(key);
  }

  debugStats() {
    return {
      records: this.records.size,
      totalTextBytes: this.totalTextBytes,
    };
  }
}

module.exports = {
  ThinkingActivityAggregator,
  makeActivityKey,
  truncateActivityText,
};
