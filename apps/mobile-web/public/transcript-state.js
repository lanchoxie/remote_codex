(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexTranscriptState = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const utf8Decoder = typeof TextDecoder === 'function'
    ? new TextDecoder('utf-8', { fatal: true })
    : null;

  const structuredTextHelper = typeof globalThis !== 'undefined'
    ? globalThis.RemoteCodexStructuredText
    : null;

  function getStructuredTextHelper() {
    // The browser loads this module after structured-text.js today, but keep
    // the lookup dynamic for tests and embedded clients that load scripts in
    // a different order.
    return (typeof globalThis !== 'undefined' && globalThis.RemoteCodexStructuredText)
      || structuredTextHelper;
  }

  function structuredText(value, options = {}) {
    const helper = getStructuredTextHelper();
    if (helper?.toText) return helper.toText(value, options);
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value);
    }
    const seen = options.seen instanceof WeakSet ? options.seen : new WeakSet();
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => structuredText(item, { ...options, seen })).filter(Boolean).join('\n');
      for (const key of ['text', 'output_text', 'outputText', 'input_text', 'inputText', 'content', 'summary', 'message', 'description', 'title', 'label', 'delta', 'value', 'step', 'command', 'query', 'path', 'output', 'stdout', 'stderr', 'reason', 'type', 'status', 'state', 'phase', 'kind', 'name', 'id']) {
        if (value[key] == null) continue;
        const text = structuredText(value[key], { ...options, seen }).trim();
        if (text) return text;
      }
      try { return JSON.stringify(value); } catch (_) { return '[Unserializable structured value]'; }
    } finally {
      seen.delete(value);
    }
  }

  function structuredScalar(value, fallback = '') {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'object') return String(value);
    for (const key of ['type', 'status', 'state', 'phase', 'kind', 'name', 'id']) {
      if (value[key] == null || value[key] === '') continue;
      const text = structuredScalar(value[key], '').trim();
      if (text) return text;
    }
    return structuredText(value) || fallback;
  }

  function clone(value) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (_) {
        // Some embedded WebViews expose structuredClone but reject host
        // objects or accessors. Fall through to the bounded clone below.
      }
    }
    const seen = new WeakMap();
    function copy(input, depth = 0) {
      if (input === null || typeof input === 'string' || typeof input === 'number'
        || typeof input === 'boolean' || typeof input === 'bigint') {
        return input;
      }
      if (typeof input === 'undefined') return null;
      if (typeof input !== 'object') return String(input);
      if (seen.has(input)) return '[Circular]';
      if (depth >= 8) return '[Nested value omitted]';
      seen.set(input, true);
      try {
        if (Array.isArray(input)) {
          return input.slice(0, 64).map((item) => copy(item, depth + 1));
        }
        const result = {};
        for (const [key, item] of Object.entries(input).slice(0, 64)) {
          try {
            result[key] = copy(item, depth + 1);
          } catch (_) {
            result[key] = '[Unserializable structured value]';
          }
        }
        return result;
      } finally {
        seen.delete(input);
      }
    }
    return copy(value);
  }

  function normalizeKey(value) {
    return structuredScalar(value, '').trim();
  }

  function normalizeTimestamp(value) {
    const text = structuredText(value).trim();
    return text || null;
  }

  function positiveRevision(value) {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
  }

  function boundedInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function utf8Bytes(value) {
    const text = String(value == null ? '' : value);
    if (utf8Encoder) return utf8Encoder.encode(text).byteLength;
    return unescape(encodeURIComponent(text)).length;
  }

  function truncateUtf8(value, maxBytes) {
    const text = String(value == null ? '' : value);
    const suffix = '\n...[activity truncated]';
    const budget = Math.max(0, maxBytes - utf8Bytes(suffix));
    if (utf8Encoder && utf8Decoder) {
      const encoded = utf8Encoder.encode(text);
      if (encoded.byteLength <= maxBytes) return { text, truncated: false };
      let end = Math.min(encoded.byteLength, budget);
      while (end > 0) {
        try {
          return {
            text: `${utf8Decoder.decode(encoded.subarray(0, end))}${suffix}`,
            truncated: true,
          };
        } catch (_) {
          end -= 1;
        }
      }
      return { text: suffix, truncated: true };
    }
    if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (utf8Bytes(text.slice(0, middle)) <= budget) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    let prefix = text.slice(0, low);
    if (prefix && /[\uD800-\uDBFF]/.test(prefix.at(-1))) prefix = prefix.slice(0, -1);
    return { text: `${prefix}${suffix}`, truncated: true };
  }

  function createTranscriptActivityProjection(options = {}) {
    const maxConversations = boundedInteger(options.maxConversations, 64, 1, 1024);
    const maxRecordsPerConversation = boundedInteger(
      options.maxRecordsPerConversation,
      256,
      1,
      1024
    );
    const maxRecordBytes = boundedInteger(
      options.maxRecordBytes,
      256 * 1024,
      1024,
      1024 * 1024
    );
    const maxTotalBytes = Math.max(
      maxRecordBytes,
      boundedInteger(options.maxTotalBytes, 16 * 1024 * 1024, 1024, 64 * 1024 * 1024)
    );
    const onConversationRemoved = typeof options.onConversationRemoved === 'function'
      ? options.onConversationRemoved
      : () => {};
    const records = new Map();
    let totalBytes = 0;
    let nextMutationGeneration = 0;
    let nextActivityOrdinal = 0;

    function get(canonicalKey) {
      return records.get(normalizeKey(canonicalKey)) || null;
    }

    function ensure(canonicalKey) {
      const key = normalizeKey(canonicalKey);
      if (!records.has(key)) {
        records.set(key, {
          epoch: '',
          activities: new Map(),
          bytesByKey: new Map(),
          generationsByKey: new Map(),
          ordinalsByKey: new Map(),
          totalBytes: 0,
        });
      }
      return records.get(key);
    }

    function touch(canonicalKey, record) {
      const key = normalizeKey(canonicalKey);
      if (records.get(key) !== record) return;
      records.delete(key);
      records.set(key, record);
    }

    function deleteActivity(record, activityKey) {
      if (!record?.activities.has(activityKey)) return false;
      const bytes = Number(record.bytesByKey.get(activityKey) || 0);
      record.activities.delete(activityKey);
      record.bytesByKey.delete(activityKey);
      record.generationsByKey.delete(activityKey);
      record.ordinalsByKey.delete(activityKey);
      record.totalBytes = Math.max(0, record.totalBytes - bytes);
      totalBytes = Math.max(0, totalBytes - bytes);
      return true;
    }

    function deleteConversation(canonicalKey, reason = '') {
      const key = normalizeKey(canonicalKey);
      const record = records.get(key);
      if (!record) return false;
      totalBytes = Math.max(0, totalBytes - record.totalBytes);
      records.delete(key);
      if (reason) onConversationRemoved(key, reason);
      return true;
    }

    function setActivity(
      record,
      activity,
      generation = ++nextMutationGeneration,
      ordinal = record.ordinalsByKey.get(activity.activityKey) || ++nextActivityOrdinal
    ) {
      deleteActivity(record, activity.activityKey);
      const bytes = utf8Bytes(JSON.stringify(activity));
      record.activities.set(activity.activityKey, activity);
      record.bytesByKey.set(activity.activityKey, bytes);
      record.generationsByKey.set(activity.activityKey, generation);
      record.ordinalsByKey.set(activity.activityKey, ordinal);
      record.totalBytes += bytes;
      totalBytes += bytes;
    }

    function enforceBounds(preferredKey) {
      const preferred = records.get(preferredKey) || null;
      while (preferred && preferred.activities.size > maxRecordsPerConversation) {
        deleteActivity(preferred, preferred.activities.keys().next().value);
      }
      while (records.size > maxConversations) {
        const oldestKey = records.keys().next().value;
        if (oldestKey !== preferredKey || records.size === 1) {
          deleteConversation(oldestKey, 'evicted');
        } else {
          const nextKey = [...records.keys()][1];
          if (!nextKey) break;
          deleteConversation(nextKey, 'evicted');
        }
      }
      while (totalBytes > maxTotalBytes && records.size) {
        const oldestKey = records.keys().next().value;
        if (oldestKey !== preferredKey) {
          deleteConversation(oldestKey, 'evicted');
          continue;
        }
        if (records.size > 1) {
          deleteConversation([...records.keys()][1], 'evicted');
          continue;
        }
        if (!preferred?.activities.size) break;
        deleteActivity(preferred, preferred.activities.keys().next().value);
      }
    }

    function normalize(canonicalKey, event, streamEpoch) {
      const revision = positiveRevision(event?.activityRevision);
      const activityKey = structuredScalar(event?.activityKey, '');
      if (!activityKey || utf8Bytes(activityKey) > 8192 || revision === null) return null;
      const normalized = {
        canonicalConversationKey: normalizeKey(canonicalKey),
        streamEpoch: normalizeKey(streamEpoch),
        activityKey,
        activityRevision: revision,
        runId: event.runId == null ? null : structuredScalar(event.runId, ''),
        turnId: event.turnId == null ? null : structuredScalar(event.turnId, ''),
        clientRequestId: event.clientRequestId == null ? null : structuredScalar(event.clientRequestId, ''),
        itemId: event.itemId == null ? null : structuredScalar(event.itemId, ''),
        callId: event.callId == null ? null : structuredScalar(event.callId, ''),
        requestId: event.requestId == null ? null : structuredScalar(event.requestId, ''),
        summaryIndex: Number(event.summaryIndex || 0),
        kind: structuredScalar(event.kind, 'reasoning'),
        itemType: event.itemType == null ? null : structuredScalar(event.itemType, ''),
        method: event.method == null ? null : structuredText(event.method),
        status: event.status == null ? null : structuredScalar(event.status, ''),
        text: '',
        textTruncated: event.textTruncated === true,
        command: event.command == null ? null : structuredText(event.command),
        cwd: event.cwd == null ? null : structuredText(event.cwd),
        output: event.output == null ? null : structuredText(event.output),
        stdout: event.stdout == null ? null : structuredText(event.stdout),
        stderr: event.stderr == null ? null : structuredText(event.stderr),
        outputTruncated: event.outputTruncated === true,
        exitCode: event.exitCode != null && Number.isFinite(Number(event.exitCode))
          ? Number(event.exitCode)
          : null,
        durationMs: event.durationMs != null && Number.isFinite(Number(event.durationMs))
          ? Number(event.durationMs)
          : null,
        processId: event.processId == null ? null : structuredScalar(event.processId, ''),
        source: event.source == null ? null : structuredScalar(event.source, ''),
        stream: event.stream == null ? null : structuredScalar(event.stream, ''),
        server: event.server == null ? null : structuredText(event.server),
        tool: event.tool == null ? null : structuredText(event.tool),
        namespace: event.namespace == null ? null : structuredText(event.namespace),
        resourceUri: event.resourceUri == null ? null : structuredText(event.resourceUri),
        senderThreadId: event.senderThreadId == null ? null : structuredScalar(event.senderThreadId, ''),
        prompt: event.prompt == null ? null : structuredText(event.prompt),
        model: event.model == null ? null : structuredText(event.model),
        reasoningEffort: event.reasoningEffort == null ? null : structuredText(event.reasoningEffort),
        query: event.query == null ? null : structuredText(event.query),
        action: event.action == null ? null : structuredText(event.action),
        receiverThreadIds: event.receiverThreadIds == null ? null : clone(event.receiverThreadIds),
        agentsStates: event.agentsStates == null ? null : clone(event.agentsStates),
        actionData: event.actionData == null ? null : clone(event.actionData),
        progress: event.progress == null ? null : structuredText(event.progress),
        progressTruncated: event.progressTruncated === true,
        success: typeof event.success === 'boolean' ? event.success : null,
        error: event.error == null ? null : clone(event.error),
        arguments: event.arguments == null ? null : clone(event.arguments),
        argumentsTruncated: event.argumentsTruncated === true,
        result: event.result == null ? null : clone(event.result),
        resultTruncated: event.resultTruncated === true,
        commandActions: event.commandActions == null ? null : clone(event.commandActions),
        fileChanges: event.fileChanges == null ? null : clone(event.fileChanges),
        fileChangesTruncated: event.fileChangesTruncated === true,
        final: event.final === true,
        startedAt: event.startedAt || event.createdAt || event.timestamp || event.updatedAt
          ? normalizeTimestamp(event.startedAt || event.createdAt || event.timestamp || event.updatedAt)
          : null,
        timestamp: event.timestamp || event.updatedAt || event.startedAt || event.createdAt
          ? normalizeTimestamp(event.timestamp || event.updatedAt || event.startedAt || event.createdAt)
          : null,
      };
      let metadataBytes = utf8Bytes(JSON.stringify(normalized));
      if (metadataBytes > maxRecordBytes) {
        normalized.outputTruncated ||= normalized.output != null
          || normalized.stdout != null
          || normalized.stderr != null;
        normalized.resultTruncated ||= normalized.result != null;
        normalized.argumentsTruncated ||= normalized.arguments != null;
        normalized.fileChangesTruncated ||= normalized.fileChanges != null;
        normalized.output = null;
        normalized.stdout = null;
        normalized.stderr = null;
        normalized.result = null;
        normalized.arguments = null;
        normalized.fileChanges = null;
        normalized.receiverThreadIds = null;
        normalized.agentsStates = null;
        normalized.actionData = null;
        normalized.textTruncated = true;
        metadataBytes = utf8Bytes(JSON.stringify(normalized));
      }
      if (metadataBytes > maxRecordBytes) return null;
      const truncated = truncateUtf8(structuredText(event.text), Math.max(0, maxRecordBytes - metadataBytes - 32));
      normalized.text = truncated.text;
      normalized.textTruncated ||= truncated.truncated;
      if (utf8Bytes(JSON.stringify(normalized)) > maxRecordBytes) {
        normalized.text = '';
        normalized.textTruncated = true;
      }
      if (utf8Bytes(JSON.stringify(normalized)) > maxRecordBytes) return null;
      return normalized;
    }

    function replaceConversation(
      canonicalKey,
      streamEpoch,
      activities,
      preserveNewer,
      preserveAfterGeneration = Number.MAX_SAFE_INTEGER
    ) {
      const key = normalizeKey(canonicalKey);
      const previous = get(key);
      const candidates = new Map();
      for (const activity of Array.isArray(activities) ? activities : []) {
        const normalized = normalize(key, activity, streamEpoch);
        if (!normalized) continue;
        const candidate = candidates.get(normalized.activityKey);
        if (!candidate || normalized.activityRevision > candidate.activity.activityRevision) {
          candidates.set(normalized.activityKey, { activity: normalized, generation: 0 });
        }
      }
      if (preserveNewer && previous?.epoch === streamEpoch) {
        for (const [activityKey, candidate] of candidates) {
          const current = previous.activities.get(activityKey);
          if (current && current.activityRevision > candidate.activity.activityRevision) {
            candidates.set(activityKey, {
              activity: current,
              generation: previous.generationsByKey.get(activityKey) || 0,
            });
          }
        }
        for (const [activityKey, current] of previous.activities) {
          const generation = previous.generationsByKey.get(activityKey) || 0;
          if (generation > preserveAfterGeneration && !candidates.has(activityKey)) {
            candidates.set(activityKey, { activity: current, generation });
          }
        }
      }
      deleteConversation(key);
      const next = ensure(key);
      next.epoch = streamEpoch;
      for (const candidate of candidates.values()) {
        setActivity(
          next,
          candidate.activity,
          candidate.generation || ++nextMutationGeneration,
          preserveNewer
            ? previous?.ordinalsByKey.get(candidate.activity.activityKey)
            : undefined
        );
        enforceBounds(key);
      }
      touch(key, next);
      enforceBounds(key);
      return true;
    }

    function rebaseConversation(canonicalKey, streamEpoch, activities) {
      const key = normalizeKey(canonicalKey);
      const record = ensure(key);
      for (const [activityKey, current] of record.activities) {
        const rebased = {
          ...current,
          canonicalConversationKey: key,
          streamEpoch,
        };
        const previousBytes = Number(record.bytesByKey.get(activityKey) || 0);
        const nextBytes = utf8Bytes(JSON.stringify(rebased));
        record.activities.set(activityKey, rebased);
        record.bytesByKey.set(activityKey, nextBytes);
        record.totalBytes += nextBytes - previousBytes;
        totalBytes += nextBytes - previousBytes;
      }
      record.epoch = streamEpoch;
      for (const activity of Array.isArray(activities) ? activities : []) {
        const normalized = normalize(key, activity, streamEpoch);
        if (!normalized) continue;
        const current = record.activities.get(normalized.activityKey);
        if (current && current.activityRevision >= normalized.activityRevision) continue;
        if (current?.startedAt) normalized.startedAt = current.startedAt;
        setActivity(record, normalized);
      }
      touch(key, record);
      enforceBounds(key);
      return true;
    }

    return {
      applyActivity(canonicalKey, event = {}) {
        const key = normalizeKey(canonicalKey);
        const streamEpoch = normalizeKey(event.streamEpoch);
        if (!key || !streamEpoch) return false;
        const normalized = normalize(key, event, streamEpoch);
        if (!normalized) return false;
        const record = ensure(key);
        if (record.epoch && record.epoch !== streamEpoch) return false;
        const current = record.activities.get(normalized.activityKey);
        if (current && current.activityRevision >= normalized.activityRevision) return false;
        if (current?.startedAt) {
          normalized.startedAt = current.startedAt;
        }
        record.epoch = streamEpoch;
        setActivity(record, normalized);
        touch(key, record);
        enforceBounds(key);
        return true;
      },

      applyReset(canonicalKey, payload = {}) {
        const key = normalizeKey(canonicalKey);
        const streamEpoch = normalizeKey(payload.streamEpoch);
        if (!key || !streamEpoch) return false;
        if (payload.activitiesTruncated === true || payload.incomplete === true) {
          return rebaseConversation(key, streamEpoch, payload.activities);
        }
        return replaceConversation(key, streamEpoch, payload.activities, false);
      },

      replaceSnapshot(canonicalKey, payload = {}) {
        const key = normalizeKey(canonicalKey);
        const streamEpoch = normalizeKey(payload.streamEpoch);
        if (!key || !streamEpoch) return false;
        const preserveAfterGeneration = Number.isSafeInteger(payload.preserveAfterGeneration)
          ? payload.preserveAfterGeneration
          : Number.MAX_SAFE_INTEGER;
        return replaceConversation(
          key,
          streamEpoch,
          payload.activities,
          true,
          preserveAfterGeneration
        );
      },

      activitiesFor(canonicalKey, options = {}) {
        const key = normalizeKey(canonicalKey);
        const record = get(key);
        if (!record) return [];
        touch(key, record);
        const sorted = [...record.activities.values()]
          .sort((left, right) => (
            Number(record.ordinalsByKey.get(left.activityKey) || 0)
            - Number(record.ordinalsByKey.get(right.activityKey) || 0)
          ));
        const limit = boundedInteger(options.limit, sorted.length, 1, maxRecordsPerConversation);
        return sorted
          .slice(Math.max(0, sorted.length - limit))
          .map(clone);
      },

      epochFor(canonicalKey) {
        return get(canonicalKey)?.epoch || '';
      },

      mutationGeneration(canonicalKey) {
        const record = get(canonicalKey);
        if (!record?.generationsByKey.size) return 0;
        return Math.max(0, ...record.generationsByKey.values());
      },

      hasConversation(canonicalKey) {
        return records.has(normalizeKey(canonicalKey));
      },

      clearConversation(canonicalKey) {
        return deleteConversation(canonicalKey, 'cleared');
      },

      conversationKeys() {
        return [...records.keys()];
      },

      debugStats() {
        return {
          conversations: records.size,
          totalBytes,
          activities: [...records.values()]
            .reduce((sum, record) => sum + record.activities.size, 0),
        };
      },
    };
  }

  return { createTranscriptActivityProjection };
}));
