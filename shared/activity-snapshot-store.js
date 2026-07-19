const { makeActivityKey } = require('./thinking-activity');

function clone(value) {
  return structuredClone(value);
}

function compareScalar(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareSnapshots(left, right) {
  return compareScalar(left.turnId, right.turnId)
    || compareScalar(left.itemId, right.itemId)
    || (Number(left.summaryIndex || 0) - Number(right.summaryIndex || 0));
}

class ActivitySnapshotStore {
  constructor() {
    this.conversations = new Map();
  }

  accept(epoch, canonicalKey, snapshot) {
    const key = String(canonicalKey || '');
    const streamEpoch = String(epoch || '');
    let conversation = this.conversations.get(key);
    if (!conversation || conversation.epoch !== streamEpoch) {
      conversation = { epoch: streamEpoch, records: new Map() };
      this.conversations.set(key, conversation);
    }

    const normalized = this.normalize(key, snapshot);
    const current = conversation.records.get(normalized.activityKey);
    if (
      current
      && normalized.activityRevision <= current.activityRevision
    ) {
      return null;
    }

    conversation.records.set(normalized.activityKey, normalized);
    return clone(normalized);
  }

  reset(epoch, canonicalKey, snapshots = []) {
    const key = String(canonicalKey || '');
    const conversation = {
      epoch: String(epoch || ''),
      records: new Map(),
    };
    this.conversations.set(key, conversation);

    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const normalized = this.normalize(key, snapshot);
      conversation.records.set(normalized.activityKey, normalized);
    }
    return this.snapshot(key);
  }

  snapshot(canonicalKey) {
    const key = String(canonicalKey || '');
    const conversation = this.conversations.get(key);
    if (!conversation) return [];
    return [...conversation.records.values()]
      .sort(compareSnapshots)
      .map((record) => clone(record));
  }

  mergeCanonicalKey(epoch, loserKeyValue, winnerKeyValue) {
    const loserKey = String(loserKeyValue || '');
    const winnerKey = String(winnerKeyValue || '');
    if (!loserKey || !winnerKey || loserKey === winnerKey) {
      return this.snapshot(winnerKey || loserKey);
    }
    const streamEpoch = String(epoch || '');
    const loser = this.conversations.get(loserKey);
    const winner = this.conversations.get(winnerKey);
    const records = new Map();
    for (const conversation of [winner, loser]) {
      if (!conversation || conversation.epoch !== streamEpoch) continue;
      for (const snapshot of conversation.records.values()) {
        const normalized = this.normalize(winnerKey, snapshot);
        const current = records.get(normalized.activityKey);
        if (!current || normalized.activityRevision > current.activityRevision) {
          records.set(normalized.activityKey, normalized);
        }
      }
    }
    this.conversations.set(winnerKey, { epoch: streamEpoch, records });
    this.conversations.delete(loserKey);
    return this.snapshot(winnerKey);
  }

  normalize(canonicalKey, snapshot = {}) {
    const activityRevision = Number(snapshot.activityRevision);
    if (!Number.isFinite(activityRevision)) {
      throw new TypeError('activityRevision must be a finite number');
    }

    const normalized = {
      ...clone(snapshot),
      canonicalConversationKey: canonicalKey,
      summaryIndex: Number(snapshot.summaryIndex || 0),
      activityRevision,
    };
    normalized.activityKey = makeActivityKey(normalized);
    return normalized;
  }
}

module.exports = {
  ActivitySnapshotStore,
};
