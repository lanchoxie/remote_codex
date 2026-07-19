(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexTranscriptState = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function positiveRevision(value) {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  }

  function createTranscriptActivityProjection() {
    const records = new Map();

    function get(canonicalKey) {
      return records.get(String(canonicalKey || '')) || null;
    }

    function ensure(canonicalKey) {
      const key = String(canonicalKey || '');
      if (!records.has(key)) {
        records.set(key, { epoch: '', activities: new Map() });
      }
      return records.get(key);
    }

    function normalize(canonicalKey, event, streamEpoch) {
      const revision = positiveRevision(event?.activityRevision);
      const activityKey = String(event?.activityKey || '');
      if (!activityKey || revision === null) return null;
      return {
        ...clone(event),
        canonicalConversationKey: String(canonicalKey || ''),
        streamEpoch: String(streamEpoch || ''),
        activityKey,
        activityRevision: revision,
      };
    }

    return {
      applyActivity(canonicalKey, event = {}) {
        const key = String(canonicalKey || '');
        const streamEpoch = String(event.streamEpoch || '');
        if (!key || !streamEpoch) return false;
        const record = ensure(key);
        if (record.epoch && record.epoch !== streamEpoch) return false;
        const normalized = normalize(key, event, streamEpoch);
        if (!normalized) return false;
        const current = record.activities.get(normalized.activityKey);
        if (current && current.activityRevision >= normalized.activityRevision) return false;
        record.epoch = streamEpoch;
        record.activities.set(normalized.activityKey, normalized);
        return true;
      },

      applyReset(canonicalKey, payload = {}) {
        const key = String(canonicalKey || '');
        const streamEpoch = String(payload.streamEpoch || '');
        if (!key || !streamEpoch) return false;
        const next = { epoch: streamEpoch, activities: new Map() };
        for (const activity of Array.isArray(payload.activities) ? payload.activities : []) {
          const normalized = normalize(key, activity, streamEpoch);
          if (!normalized) continue;
          const current = next.activities.get(normalized.activityKey);
          if (!current || normalized.activityRevision > current.activityRevision) {
            next.activities.set(normalized.activityKey, normalized);
          }
        }
        records.set(key, next);
        return true;
      },

      activitiesFor(canonicalKey) {
        const record = get(canonicalKey);
        if (!record) return [];
        return [...record.activities.values()]
          .sort((left, right) => (
            String(left.turnId || '').localeCompare(String(right.turnId || ''))
            || String(left.itemId || '').localeCompare(String(right.itemId || ''))
            || Number(left.summaryIndex || 0) - Number(right.summaryIndex || 0)
          ))
          .map(clone);
      },

      epochFor(canonicalKey) {
        return get(canonicalKey)?.epoch || '';
      },

      clearConversation(canonicalKey) {
        records.delete(String(canonicalKey || ''));
      },
    };
  }

  return { createTranscriptActivityProjection };
}));
