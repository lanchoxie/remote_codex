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

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
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

    function get(canonicalKey) {
      return records.get(String(canonicalKey || '')) || null;
    }

    function ensure(canonicalKey) {
      const key = String(canonicalKey || '');
      if (!records.has(key)) {
        records.set(key, {
          epoch: '',
          activities: new Map(),
          bytesByKey: new Map(),
          generationsByKey: new Map(),
          totalBytes: 0,
        });
      }
      return records.get(key);
    }

    function touch(canonicalKey, record) {
      const key = String(canonicalKey || '');
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
      record.totalBytes = Math.max(0, record.totalBytes - bytes);
      totalBytes = Math.max(0, totalBytes - bytes);
      return true;
    }

    function deleteConversation(canonicalKey, reason = '') {
      const key = String(canonicalKey || '');
      const record = records.get(key);
      if (!record) return false;
      totalBytes = Math.max(0, totalBytes - record.totalBytes);
      records.delete(key);
      if (reason) onConversationRemoved(key, reason);
      return true;
    }

    function setActivity(record, activity, generation = ++nextMutationGeneration) {
      deleteActivity(record, activity.activityKey);
      const bytes = utf8Bytes(JSON.stringify(activity));
      record.activities.set(activity.activityKey, activity);
      record.bytesByKey.set(activity.activityKey, bytes);
      record.generationsByKey.set(activity.activityKey, generation);
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
      const activityKey = String(event?.activityKey || '');
      if (!activityKey || utf8Bytes(activityKey) > 8192 || revision === null) return null;
      const normalized = {
        canonicalConversationKey: String(canonicalKey || ''),
        streamEpoch: String(streamEpoch || ''),
        activityKey,
        activityRevision: revision,
        runId: event.runId == null ? null : String(event.runId),
        turnId: event.turnId == null ? null : String(event.turnId),
        itemId: event.itemId == null ? null : String(event.itemId),
        callId: event.callId == null ? null : String(event.callId),
        requestId: event.requestId == null ? null : String(event.requestId),
        summaryIndex: Number(event.summaryIndex || 0),
        kind: String(event.kind || 'reasoning'),
        itemType: event.itemType == null ? null : String(event.itemType),
        method: event.method == null ? null : String(event.method),
        status: event.status == null ? null : String(event.status),
        text: '',
        textTruncated: event.textTruncated === true,
        command: event.command == null ? null : String(event.command),
        cwd: event.cwd == null ? null : String(event.cwd),
        output: event.output == null ? null : String(event.output),
        stdout: event.stdout == null ? null : String(event.stdout),
        stderr: event.stderr == null ? null : String(event.stderr),
        outputTruncated: event.outputTruncated === true,
        exitCode: event.exitCode != null && Number.isFinite(Number(event.exitCode))
          ? Number(event.exitCode)
          : null,
        durationMs: event.durationMs != null && Number.isFinite(Number(event.durationMs))
          ? Number(event.durationMs)
          : null,
        processId: event.processId == null ? null : String(event.processId),
        source: event.source == null ? null : String(event.source),
        stream: event.stream == null ? null : String(event.stream),
        server: event.server == null ? null : String(event.server),
        tool: event.tool == null ? null : String(event.tool),
        namespace: event.namespace == null ? null : String(event.namespace),
        resourceUri: event.resourceUri == null ? null : String(event.resourceUri),
        senderThreadId: event.senderThreadId == null ? null : String(event.senderThreadId),
        prompt: event.prompt == null ? null : String(event.prompt),
        model: event.model == null ? null : String(event.model),
        reasoningEffort: event.reasoningEffort == null ? null : String(event.reasoningEffort),
        query: event.query == null ? null : String(event.query),
        action: event.action == null ? null : String(event.action),
        receiverThreadIds: event.receiverThreadIds == null ? null : clone(event.receiverThreadIds),
        agentsStates: event.agentsStates == null ? null : clone(event.agentsStates),
        actionData: event.actionData == null ? null : clone(event.actionData),
        progress: event.progress == null ? null : String(event.progress),
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
          ? String(event.startedAt || event.createdAt || event.timestamp || event.updatedAt)
          : null,
        timestamp: event.timestamp || event.updatedAt || event.startedAt || event.createdAt
          ? String(event.timestamp || event.updatedAt || event.startedAt || event.createdAt)
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
      const truncated = truncateUtf8(event.text, Math.max(0, maxRecordBytes - metadataBytes - 32));
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
      const key = String(canonicalKey || '');
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
          candidate.generation || ++nextMutationGeneration
        );
        enforceBounds(key);
      }
      touch(key, next);
      enforceBounds(key);
      return true;
    }

    return {
      applyActivity(canonicalKey, event = {}) {
        const key = String(canonicalKey || '');
        const streamEpoch = String(event.streamEpoch || '');
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
        const key = String(canonicalKey || '');
        const streamEpoch = String(payload.streamEpoch || '');
        if (!key || !streamEpoch) return false;
        return replaceConversation(key, streamEpoch, payload.activities, false);
      },

      replaceSnapshot(canonicalKey, payload = {}) {
        const key = String(canonicalKey || '');
        const streamEpoch = String(payload.streamEpoch || '');
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
        const key = String(canonicalKey || '');
        const record = get(key);
        if (!record) return [];
        touch(key, record);
        const sorted = [...record.activities.values()]
          .sort((left, right) => (
            String(left.turnId || '').localeCompare(String(right.turnId || ''))
            || String(left.itemId || '').localeCompare(String(right.itemId || ''))
            || Number(left.summaryIndex || 0) - Number(right.summaryIndex || 0)
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
        return records.has(String(canonicalKey || ''));
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
