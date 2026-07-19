function makeActivityKey(value = {}) {
  return JSON.stringify([
    String(value.canonicalConversationKey || ''),
    String(value.runId || ''),
    String(value.turnId || ''),
    String(value.itemId || ''),
    Number(value.summaryIndex || 0),
  ]);
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
    this.records = new Map();
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
        text: '',
        emittedText: null,
        activityRevision: 0,
        timer: null,
      });
    }
    return this.records.get(key);
  }

  appendDelta(identity, delta) {
    const record = this.record(identity);
    record.text += String(delta ?? '');
    this.schedule(record);
  }

  replaceSnapshot(identity, text) {
    const record = this.record(identity);
    record.text = String(text ?? '');
    this.schedule(record);
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
    if (!final && record.text === record.emittedText) return null;

    record.activityRevision += 1;
    record.emittedText = record.text;
    const snapshot = {
      ...record,
      timer: undefined,
      emittedText: undefined,
      final,
      timestamp: this.now(),
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
}

module.exports = {
  ThinkingActivityAggregator,
  makeActivityKey,
};
