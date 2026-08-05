(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexThinkingEntryModel = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const DEFAULT_LIMITS = Object.freeze({
    maxEntries: 160,
    maxTextChars: 64 * 1024,
    maxOutputChars: 64 * 1024,
    maxDiffChars: 96 * 1024,
    maxFileChanges: 64,
    maxTotalChars: 512 * 1024,
  });
  const TEXT_TRUNCATION_SUFFIX = '\n...[text truncated]';
  const OUTPUT_TRUNCATION_PREFIX = '...[earlier output truncated]\n';
  const TERMINAL_STATUSES = new Set([
    'applied',
    'approved',
    'blocked',
    'cancelled',
    'canceled',
    'complete',
    'completed',
    'denied',
    'error',
    'expired',
    'failed',
    'finished',
    'interrupted',
    'rejected',
    'resolved',
    'stopped',
    'succeeded',
    'success',
  ]);

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(object(value), key);
  }

  function firstDefined(sources, keys) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      for (const key of keys) {
        if (hasOwn(source, key) && source[key] !== undefined && source[key] !== null) {
          return source[key];
        }
      }
    }
    return undefined;
  }

  function identifier(value) {
    return String(value == null ? '' : value).trim();
  }

  function plainText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }

  const COLLABORATION_MESSAGE_TOOLS = new Set([
    'spawn_agent',
    'send_message',
    'followup_task',
  ]);
  const ENCRYPTED_COLLABORATION_PLACEHOLDER = '[Encrypted by Codex runtime; plaintext unavailable locally]';

  function collaborationToolName(value) {
    const normalized = identifier(value).toLowerCase();
    return normalized.includes('/') ? normalized.split('/').at(-1) : normalized;
  }

  function looksLikeEncryptedCollaborationPayload(value) {
    const text = String(value || '').trim();
    return text.length >= 96
      && /^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(text);
  }

  function parseStructuredValue(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { value: { ...value }, serialized: false };
    }
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { value: parsed, serialized: true }
        : null;
    } catch (_) {
      return null;
    }
  }

  function structuredValueIsTruncated(value) {
    const parsed = parseStructuredValue(value)?.value;
    if (!parsed || parsed.truncated !== true || typeof parsed.preview !== 'string') {
      return false;
    }
    return Object.keys(parsed).every((key) => key === 'truncated' || key === 'preview');
  }

  function hasTruncationFlag(sources, keys) {
    return sources.some((source) => keys.some((key) => object(source)[key] === true));
  }

  function sanitizeCollaborationPayload(toolName, argumentsValue, promptValue) {
    const tool = collaborationToolName(toolName);
    const parsed = COLLABORATION_MESSAGE_TOOLS.has(tool)
      ? parseStructuredValue(argumentsValue)
      : null;
    let encrypted = false;
    let sanitizedArguments = argumentsValue;
    if (parsed) {
      const next = { ...parsed.value };
      for (const key of ['message', 'prompt']) {
        if (looksLikeEncryptedCollaborationPayload(next[key])) {
          next[key] = ENCRYPTED_COLLABORATION_PLACEHOLDER;
          encrypted = true;
        }
      }
      sanitizedArguments = parsed.serialized ? JSON.stringify(next) : next;
    }
    const sanitizedPrompt = looksLikeEncryptedCollaborationPayload(promptValue)
      ? ENCRYPTED_COLLABORATION_PLACEHOLDER
      : promptValue;
    encrypted = encrypted || sanitizedPrompt !== promptValue;
    return {
      argumentsValue: sanitizedArguments,
      promptValue: sanitizedPrompt,
      encrypted,
    };
  }

  function statusText(value) {
    if (value && typeof value === 'object') {
      return identifier(value.type || value.status || value.state || value.phase);
    }
    return identifier(value);
  }

  function finiteInteger(value, fallback = 0) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : fallback;
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = finiteInteger(value, fallback);
    return Math.max(minimum, Math.min(maximum, number));
  }

  function safePrefix(value, length) {
    let result = String(value || '').slice(0, Math.max(0, length));
    if (result && /[\uD800-\uDBFF]/.test(result.at(-1))) result = result.slice(0, -1);
    return result;
  }

  function safeSuffix(value, length) {
    const text = String(value || '');
    let start = Math.max(0, text.length - Math.max(0, length));
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start += 1;
    return text.slice(start);
  }

  function boundPrefix(value, maximum, suffix = TEXT_TRUNCATION_SUFFIX) {
    const text = String(value || '');
    if (text.length <= maximum) return { value: text, truncated: false };
    if (maximum <= suffix.length) {
      return { value: safePrefix(suffix, maximum), truncated: true };
    }
    return {
      value: `${safePrefix(text, maximum - suffix.length)}${suffix}`,
      truncated: true,
    };
  }

  function boundTail(value, maximum, prefix = OUTPUT_TRUNCATION_PREFIX) {
    const text = String(value || '');
    if (text.length <= maximum) return { value: text, truncated: false };
    if (maximum <= prefix.length) {
      return { value: safeSuffix(text, maximum), truncated: true };
    }
    return {
      value: `${prefix}${safeSuffix(text, maximum - prefix.length)}`,
      truncated: true,
    };
  }

  function normalizedKind(value) {
    return identifier(value || 'activity')
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-');
  }

  const CATEGORY_PRIORITY = Object.freeze({
    activity: 0,
    event: 0,
    notification: 0,
    request: 0,
    commentary: 10,
    plan: 20,
    reasoning: 30,
    tool: 40,
    command: 50,
    search: 60,
    file: 70,
  });

  function preferredCategory(current, incoming) {
    const left = normalizedKind(current || 'activity');
    const right = normalizedKind(incoming || 'activity');
    const leftPriority = CATEGORY_PRIORITY[left] ?? 1;
    const rightPriority = CATEGORY_PRIORITY[right] ?? 1;
    if (leftPriority !== rightPriority) return rightPriority > leftPriority ? right : left;
    return [left, right].sort()[0];
  }

  function actionableCategory(kind, method, name, itemType = '') {
    const normalizedMethod = identifier(method).toLowerCase();
    const normalizedName = identifier(name).toLowerCase();
    const normalizedItemType = identifier(itemType).toLowerCase();
    const combined = `${kind} ${normalizedMethod} ${normalizedName} ${normalizedItemType}`;
    if (/\breasoning\b|summarytextdelta/.test(combined)) return 'reasoning';
    if (/\bplan\b/.test(combined)) return 'plan';
    if (/\bcommentary\b/.test(combined)) return 'commentary';
    if (/file-?change|filechange|apply[_/-]?patch|\bpatch\b|\bdiff\b|\bedit\b|\bwrite\b/.test(combined)) {
      return 'file';
    }
    if (/web[_/-]?search|web-search|\bsearch\b/.test(combined)) return 'search';
    if (
      /command-?output|commandexecution|command\/exec|exec_command|shellcommand|terminal|process\/output/.test(combined)
    ) {
      return 'command';
    }
    if (/tool-?call|function_call|mcp|\btool\b/.test(combined)) return 'tool';
    return kind || 'activity';
  }

  function hashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function terminalStatus(value) {
    return TERMINAL_STATUSES.has(identifier(value).toLowerCase());
  }

  function normalizedFileChange(raw, limits) {
    const change = object(raw);
    const path = identifier(
      change.path || change.filePath || change.file_path || change.filename || change.name || 'workspace change'
    );
    const status = normalizedKind(change.status || change.type || change.action || 'changed');
    const additions = Number(change.additions ?? change.added ?? change.insertions);
    const deletions = Number(change.deletions ?? change.deleted ?? change.removed);
    const boundedDiff = boundPrefix(
      plainText(change.diff || change.patch || change.unifiedDiff || change.unified_diff || ''),
      limits.maxDiffChars,
      '\n...[diff truncated]'
    );
    return {
      path,
      status,
      additions: Number.isFinite(additions) && additions >= 0 ? additions : null,
      deletions: Number.isFinite(deletions) && deletions >= 0 ? deletions : null,
      diff: boundedDiff.value,
      truncated: change.truncated === true || boundedDiff.truncated,
    };
  }

  function collectFileChanges(raw, data, payload, limits) {
    const candidates = [
      raw.fileChanges,
      raw.files,
      raw.changes,
      data.fileChanges,
      data.file_changes,
      data.files,
      data.changes,
      payload.fileChanges,
      payload.file_changes,
      payload.files,
      payload.changes,
    ];
    const fileChanges = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const values = Array.isArray(candidate)
        ? candidate
        : candidate && typeof candidate === 'object'
          ? Object.entries(candidate).map(([path, change]) => ({ path, ...object(change) }))
          : [];
      for (const value of values) {
        const normalized = normalizedFileChange(value, limits);
        const key = normalized.path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (fileChanges.length >= limits.maxFileChanges) {
          return { fileChanges, truncated: true };
        }
        fileChanges.push(normalized);
      }
    }
    return {
      fileChanges,
      truncated: fileChanges.some((change) => change.truncated),
    };
  }

  function normalizeLimits(options = {}) {
    return {
      maxEntries: boundedInteger(options.maxEntries, DEFAULT_LIMITS.maxEntries, 1, 4096),
      maxTextChars: boundedInteger(options.maxTextChars, DEFAULT_LIMITS.maxTextChars, 32, 1024 * 1024),
      maxOutputChars: boundedInteger(options.maxOutputChars, DEFAULT_LIMITS.maxOutputChars, 32, 1024 * 1024),
      maxDiffChars: boundedInteger(options.maxDiffChars, DEFAULT_LIMITS.maxDiffChars, 32, 1024 * 1024),
      maxFileChanges: boundedInteger(options.maxFileChanges, DEFAULT_LIMITS.maxFileChanges, 1, 512),
      maxTotalChars: boundedInteger(options.maxTotalChars, DEFAULT_LIMITS.maxTotalChars, 128, 8 * 1024 * 1024),
    };
  }

  function chooseTextMode(raw, method, activityKey, revision, data) {
    const explicit = identifier(raw.textMode || raw.mergeMode || data.textMode).toLowerCase();
    if (['append', 'append-line', 'replace'].includes(explicit)) return explicit;
    const normalizedMethod = identifier(method).toLowerCase();
    if (activityKey && revision > 0) return 'replace';
    if (normalizedMethod === 'turn/plan/updated' || data.rawPlan != null) return 'replace';
    if (normalizedMethod.includes('delta')) return 'append';
    return 'append-line';
  }

  function normalizeThinkingActivityEntry(value = {}, index = 0, options = {}) {
    const limits = normalizeLimits(options);
    const raw = object(value);
    const data = object(raw.data);
    const payload = object(raw.payload || data.payload);
    const sources = [raw, data, payload];
    const kind = normalizedKind(firstDefined(sources, ['kind', 'type']) || 'activity');
    const method = identifier(firstDefined(sources, ['method']));
    const name = identifier(firstDefined(sources, ['name', 'toolName', 'tool_name']));
    const itemType = identifier(firstDefined(sources, ['itemType', 'item_type']));
    const source = identifier(firstDefined(sources, ['source']));
    const category = actionableCategory(kind, method, name, itemType);
    const canonicalConversationKey = identifier(firstDefined(sources, [
      'canonicalConversationKey',
      'conversationKey',
      'canonical_key',
    ]));
    const runId = identifier(firstDefined(sources, ['runId', 'run_id']));
    const turnId = identifier(firstDefined(sources, ['turnId', 'turn_id']));
    const itemId = identifier(firstDefined(sources, ['itemId', 'item_id']));
    const callId = identifier(firstDefined(sources, ['callId', 'call_id']));
    const requestId = identifier(firstDefined(sources, ['requestId', 'request_id']));
    const processId = identifier(firstDefined(sources, ['processId', 'process_id', 'processHandle']));
    const activityKey = identifier(firstDefined(sources, ['activityKey', 'activity_key']));
    const activityKeys = [...new Set([
      activityKey,
      ...(Array.isArray(raw.activityKeys) ? raw.activityKeys : []),
      ...(Array.isArray(data.activityKeys) ? data.activityKeys : []),
    ].map(identifier).filter(Boolean))];
    const explicitGroupKey = identifier(raw.groupKey);
    const explicitId = identifier(firstDefined(sources, ['eventKey', 'id', 'key']));
    const summaryIndex = finiteInteger(firstDefined(sources, ['summaryIndex', 'summary_index']), 0);
    const revision = Math.max(0, finiteInteger(firstDefined(sources, [
      'activityRevision',
      'revision',
      'sequence',
    ]), 0));

    let textValue = firstDefined(sources, ['text', 'message', 'detail', 'summary', 'content', 'plan']);
    if (category === 'plan' && data.rawPlan != null && method.toLowerCase() === 'turn/plan/updated') {
      textValue = data.rawPlan;
    }
    let text = plainText(textValue);
    const stream = identifier(firstDefined(sources, ['stream'])).toLowerCase();
    let output = plainText(firstDefined(sources, ['output', 'outputChunk', 'output_chunk']));
    let stdout = plainText(firstDefined(sources, ['stdout']));
    let stderr = plainText(firstDefined(sources, ['stderr']));
    if ((category === 'command' || category === 'tool') && !output && /output/.test(`${kind} ${method}`.toLowerCase())) {
      output = text;
      text = '';
    }
    if (output && stream === 'stdout') {
      stdout = output;
      output = '';
    } else if (output && stream === 'stderr') {
      stderr = output;
      output = '';
    }

    const rawStatus = firstDefined(sources, ['status', 'state', 'phase']);
    let status = statusText(rawStatus);
    const successValue = firstDefined(sources, ['success', 'succeeded', 'ok']);
    const hasSuccess = typeof successValue === 'boolean';
    if (!status && hasSuccess) status = successValue ? 'succeeded' : 'failed';
    const final = raw.final === true || data.final === true || payload.final === true;
    const terminal = raw.terminal === true || final || terminalStatus(status) || hasSuccess;
    const exitCodeValue = firstDefined(sources, ['exitCode', 'exit_code', 'code']);
    const hasExitCode = exitCodeValue !== undefined && exitCodeValue !== null && Number.isFinite(Number(exitCodeValue));
    const errorValue = firstDefined(sources, ['error', 'errorMessage', 'error_message']);
    const hasError = errorValue !== undefined && errorValue !== null;
    const error = errorValue && typeof errorValue === 'object'
      ? plainText(errorValue.message || errorValue.detail || errorValue)
      : plainText(errorValue);
    const snapshotTimestamp = identifier(firstDefined(sources, ['timestamp']));
    const timestamp = identifier(firstDefined(sources, [
      'startedAt',
      'started_at',
      'createdAt',
      'created_at',
    ])) || snapshotTimestamp;
    const updatedAt = identifier(firstDefined(sources, [
      'updatedAt',
      'updated_at',
      'completedAt',
      'completed_at',
    ])) || snapshotTimestamp || timestamp;
    const completedAtValue = firstDefined(sources, ['completedAt', 'completed_at', 'finishedAt', 'finished_at']);
    const durationValue = firstDefined(sources, ['durationMs', 'duration_ms', 'elapsedMs', 'elapsed_ms']);
    const hasDuration = durationValue !== undefined
      && durationValue !== null
      && Number.isFinite(Number(durationValue))
      && Number(durationValue) >= 0;
    const argumentsValue = firstDefined(sources, ['arguments', 'args', 'input']);
    const commandActionsValue = firstDefined(sources, ['commandActions', 'command_actions']);
    const resultValue = firstDefined(sources, ['resultText', 'result_text', 'result']);
    const progressValue = firstDefined(sources, ['progress', 'progressText', 'progress_text']);
    const receiverThreadIdsValue = firstDefined(sources, [
      'receiverThreadIdsText',
      'receiverThreadIds',
      'receiver_thread_ids',
    ]);
    const agentsStatesValue = firstDefined(sources, ['agentsStatesText', 'agentsStates', 'agents_states']);
    const actionDataValue = firstDefined(sources, ['actionDataText', 'actionData', 'action_data']);
    const promptValue = firstDefined(sources, ['prompt']);
    const collaborationPayload = sanitizeCollaborationPayload(
      name || firstDefined(sources, ['tool', 'toolName', 'tool_name']) || method,
      argumentsValue,
      promptValue
    );
    const collectedFileChanges = collectFileChanges(raw, data, payload, limits);

    const normalized = {
      _normalizedThinkingEntry: true,
      _index: finiteInteger(index, 0),
      explicitId,
      explicitGroupKey,
      activityKey,
      activityKeys,
      canonicalConversationKey,
      runId,
      turnId,
      itemId,
      callId,
      requestId,
      processId,
      summaryIndex,
      revision,
      kind,
      category,
      itemType,
      source,
      method,
      name,
      text,
      textMode: chooseTextMode(raw, method, activityKey, revision, data),
      output,
      outputMode: identifier(raw.outputMode || data.outputMode).toLowerCase() === 'replace'
        ? 'replace'
        : /delta/i.test(method) ? 'append' : 'replace',
      stdout,
      stderr,
      command: plainText(firstDefined(sources, ['command', 'cmd'])),
      cwd: plainText(firstDefined(sources, ['cwd', 'workdir', 'workingDirectory'])),
      argumentsText: plainText(collaborationPayload.argumentsValue),
      commandActionsText: plainText(commandActionsValue),
      durationMs: hasDuration ? Number(durationValue) : null,
      server: plainText(firstDefined(sources, ['server', 'serverName', 'server_name', 'mcpServer'])),
      tool: plainText(firstDefined(sources, ['tool', 'toolName', 'tool_name'])) || name,
      namespace: plainText(firstDefined(sources, ['namespace'])),
      resourceUri: plainText(firstDefined(sources, ['resourceUri', 'resource_uri', 'uri'])),
      senderThreadId: plainText(firstDefined(sources, ['senderThreadId', 'sender_thread_id'])),
      receiverThreadIdsText: plainText(receiverThreadIdsValue),
      agentThreadId: plainText(firstDefined(sources, ['agentThreadId', 'agent_thread_id'])),
      agentPath: plainText(firstDefined(sources, ['agentPath', 'agent_path'])),
      agentNickname: plainText(firstDefined(sources, ['agentNickname', 'agent_nickname'])),
      agentRole: plainText(firstDefined(sources, ['agentRole', 'agent_role'])),
      parentThreadId: plainText(firstDefined(sources, ['parentThreadId', 'parent_thread_id'])),
      subagentKind: plainText(firstDefined(sources, ['subagentKind', 'subagent_kind'])),
      prompt: plainText(collaborationPayload.promptValue),
      encryptedPrompt: collaborationPayload.encrypted,
      agentsStatesText: plainText(agentsStatesValue),
      actionDataText: plainText(actionDataValue),
      model: plainText(firstDefined(sources, ['model'])),
      reasoningEffort: plainText(firstDefined(sources, ['reasoningEffort', 'reasoning_effort', 'effort'])),
      resultText: plainText(resultValue),
      progress: progressValue == null ? null : plainText(progressValue),
      query: plainText(firstDefined(sources, ['query'])),
      action: plainText(firstDefined(sources, ['action'])),
      status,
      final,
      terminal,
      success: hasSuccess ? successValue : null,
      exitCode: hasExitCode ? Number(exitCodeValue) : null,
      error,
      completedAt: completedAtValue == null ? '' : identifier(completedAtValue),
      timestamp,
      updatedAt,
      fileChanges: collectedFileChanges.fileChanges,
      textTruncated: raw.textTruncated === true || data.textTruncated === true,
      outputTruncated: raw.outputTruncated === true || data.outputTruncated === true,
      progressTruncated: hasTruncationFlag(sources, ['progressTruncated', 'progress_truncated']),
      argumentsTruncated: hasTruncationFlag(sources, ['argumentsTruncated', 'arguments_truncated'])
        || structuredValueIsTruncated(argumentsValue),
      resultTruncated: hasTruncationFlag(sources, ['resultTruncated', 'result_truncated'])
        || structuredValueIsTruncated(resultValue),
      fileChangesTruncated: hasTruncationFlag(sources, ['fileChangesTruncated', 'file_changes_truncated'])
        || collectedFileChanges.truncated,
      _present: {
        status: rawStatus !== undefined || hasSuccess,
        success: hasSuccess,
        exitCode: hasExitCode,
        error: hasError,
        completedAt: completedAtValue !== undefined && completedAtValue !== null,
        durationMs: hasDuration,
        progress: progressValue !== undefined && progressValue !== null,
      },
    };
    normalized.groupKey = makeGroupKeyFromNormalized(normalized);
    normalized.aliasKeys = aliasKeysFor(normalized);
    return normalized;
  }

  function entityIdentity(entry) {
    const candidates = [
      ['call', entry.callId],
      ['item', entry.itemId],
      ['request', entry.requestId],
      ['process', entry.processId],
    ];
    for (const candidate of candidates) {
      if (candidate[1]) return candidate;
    }
    if (entry.activityKey || entry.activityKeys?.length) {
      return ['activity', entry.activityKey || entry.activityKeys[0]];
    }
    if (entry.explicitId) return ['event', entry.explicitId];
    if (['reasoning', 'plan', 'commentary'].includes(entry.category) && entry.turnId) {
      return ['stream', entry.method || entry.category];
    }
    return [
      'fallback',
      hashText([
        entry.category,
        entry.method,
        entry.timestamp,
        entry.text,
        entry._index,
      ].join('\u0000')),
    ];
  }

  function makeGroupKeyFromNormalized(entry) {
    if (entry.explicitGroupKey) return entry.explicitGroupKey;
    const [entityType, entityId] = entityIdentity(entry);
    return JSON.stringify([
      'thinking',
      entry.canonicalConversationKey || '',
      entry.runId || '',
      entry.turnId || '',
      entry.category || 'activity',
      entityType,
      entityId,
      entry.category === 'reasoning' ? Number(entry.summaryIndex || 0) : 0,
    ]);
  }

  function makeThinkingGroupKey(value = {}, index = 0) {
    const normalized = value?._normalizedThinkingEntry
      ? value
      : normalizeThinkingActivityEntry(value, index);
    return normalized.groupKey || makeGroupKeyFromNormalized(normalized);
  }

  function aliasKeysFor(entry) {
    const aliases = [];
    const scope = entry.canonicalConversationKey || '';
    for (const [type, value] of [
      ...(entry.activityKeys || []).map((value) => ['activity', value]),
      ['activity', entry.activityKey],
      ['item', entry.itemId],
      ['call', entry.callId],
      ['request', entry.requestId],
      ['process', entry.processId],
    ]) {
      if (!value) continue;
      aliases.push(JSON.stringify([scope, entry.runId || '', type, value]));
      aliases.push(JSON.stringify([scope, '', type, value]));
    }
    return [...new Set(aliases)];
  }

  function thinkingEntryIdentity(value = {}, index = 0) {
    const entry = value?._normalizedThinkingEntry
      ? value
      : normalizeThinkingActivityEntry(value, index);
    return {
      groupKey: entry.groupKey,
      canonicalConversationKey: entry.canonicalConversationKey,
      runId: entry.runId,
      turnId: entry.turnId,
      activityKey: entry.activityKey,
      activityKeys: entry.activityKeys.slice(),
      itemId: entry.itemId,
      callId: entry.callId,
      requestId: entry.requestId,
      processId: entry.processId,
      summaryIndex: entry.summaryIndex,
      category: entry.category,
      itemType: entry.itemType,
      source: entry.source,
    };
  }

  const STABLE_ENTITY_FIELDS = Object.freeze(['itemId', 'callId', 'requestId', 'processId']);
  const CONTEXT_IDENTITY_FIELDS = Object.freeze(['canonicalConversationKey', 'runId', 'turnId']);

  function structuredActivityPriority(entry) {
    const hasActivityIdentity = Boolean(
      entry.activityKey
      || entry.activityKeys?.length
      || Number(entry.revision || 0) > 0
    );
    if (entry.canonicalConversationKey && hasActivityIdentity) return 2;
    return hasActivityIdentity ? 1 : 0;
  }

  function stableEntityIdentityMatches(group, entry) {
    const identity = group.identity || {};
    return STABLE_ENTITY_FIELDS.some((field) => (
      identity[field]
      && entry[field]
      && identity[field] === entry[field]
    ));
  }

  function scopeCompatible(group, entry) {
    const identity = group.identity || {};
    if (
      identity.canonicalConversationKey
      && entry.canonicalConversationKey
      && identity.canonicalConversationKey !== entry.canonicalConversationKey
    ) {
      return false;
    }
    if (identity.runId && entry.runId && identity.runId !== entry.runId) return false;
    if (identity.turnId && entry.turnId && identity.turnId !== entry.turnId) return false;
    return true;
  }

  function narrowAmbiguousContextMatches(groups, matchingKeys, entry) {
    let narrowed = new Set(matchingKeys);
    for (const field of CONTEXT_IDENTITY_FIELDS) {
      if (entry[field]) continue;
      const explicitValues = new Set([...narrowed]
        .map((key) => identifier(groups.get(key)?.identity?.[field]))
        .filter(Boolean));
      if (explicitValues.size <= 1) continue;
      narrowed = new Set([...narrowed].filter((key) => (
        !identifier(groups.get(key)?.identity?.[field])
      )));
    }
    return narrowed;
  }

  function mergeBoundedText(current, incoming, mode, maximum, tail = false) {
    const previous = String(current || '');
    const next = String(incoming || '');
    if (!next) return { value: previous, truncated: false };
    let combined;
    if (mode === 'replace') {
      combined = next;
    } else if (!previous) {
      combined = next;
    } else if (previous === next || previous.endsWith(next) || previous.startsWith(next)) {
      combined = previous;
    } else if (next.startsWith(previous)) {
      combined = next;
    } else {
      combined = `${previous}${mode === 'append-line' ? '\n' : ''}${next}`;
    }
    return tail ? boundTail(combined, maximum) : boundPrefix(combined, maximum);
  }

  function mergeFileChanges(current, incoming, limits) {
    const byPath = new Map();
    for (const change of [...(current || []), ...(incoming || [])]) {
      const normalized = normalizedFileChange(change, limits);
      const key = normalized.path.toLowerCase();
      const previous = byPath.get(key) || {};
      byPath.set(key, {
        path: normalized.path || previous.path || 'workspace change',
        status: normalized.status || previous.status || 'changed',
        additions: normalized.additions !== null ? normalized.additions : previous.additions ?? null,
        deletions: normalized.deletions !== null ? normalized.deletions : previous.deletions ?? null,
        diff: normalized.diff || previous.diff || '',
        truncated: normalized.truncated || previous.truncated || false,
      });
    }
    const fileChanges = [...byPath.values()];
    return {
      fileChanges: fileChanges.slice(-limits.maxFileChanges),
      truncated: fileChanges.length > limits.maxFileChanges
        || fileChanges.some((change) => change.truncated),
    };
  }

  function createGroup(entry) {
    return {
      groupKey: entry.groupKey,
      identity: thinkingEntryIdentity(entry),
      kind: entry.kind,
      category: entry.category,
      itemType: entry.itemType,
      source: entry.source,
      explicitGroupKey: entry.explicitGroupKey || '',
      method: entry.method,
      methods: entry.method ? [entry.method] : [],
      activityKeys: [],
      name: '',
      text: '',
      output: '',
      stdout: '',
      stderr: '',
      command: '',
      cwd: '',
      argumentsText: '',
      commandActionsText: '',
      durationMs: null,
      server: '',
      tool: '',
      namespace: '',
      resourceUri: '',
      senderThreadId: '',
      receiverThreadIdsText: '',
      agentThreadId: '',
      agentPath: '',
      agentNickname: '',
      agentRole: '',
      parentThreadId: '',
      subagentKind: '',
      prompt: '',
      agentsStatesText: '',
      actionDataText: '',
      model: '',
      reasoningEffort: '',
      resultText: '',
      progress: null,
      query: '',
      action: '',
      status: '',
      final: false,
      terminal: false,
      success: null,
      exitCode: null,
      error: '',
      completedAt: '',
      timestamp: entry.timestamp,
      updatedAt: entry.updatedAt || entry.timestamp,
      revision: 0,
      fileChanges: [],
      textTruncated: false,
      outputTruncated: false,
      progressTruncated: false,
      argumentsTruncated: false,
      resultTruncated: false,
      fileChangesTruncated: false,
      _index: entry._index,
      _events: [],
      _structuredFieldPriority: Object.create(null),
      _identityFieldPriority: Object.create(null),
    };
  }

  function fillIdentity(group, entry) {
    const priority = structuredActivityPriority(entry);
    for (const key of [
      'canonicalConversationKey',
      'runId',
      'turnId',
    ]) {
      if (!group.identity[key] && entry[key]) group.identity[key] = entry[key];
    }
    for (const key of ['activityKey', ...STABLE_ENTITY_FIELDS]) {
      if (!entry[key]) continue;
      const previousPriority = group._identityFieldPriority[key] ?? -1;
      if (!group.identity[key] || priority > previousPriority) {
        group.identity[key] = entry[key];
        group._identityFieldPriority[key] = priority;
      }
    }
    if (group.identity.summaryIndex == null && entry.summaryIndex != null) {
      group.identity.summaryIndex = entry.summaryIndex;
    }
  }

  function assignPreferredStructuredField(group, entry, field, incoming = entry[field]) {
    if (incoming === undefined || incoming === null || incoming === '') return false;
    const priority = structuredActivityPriority(entry);
    const previousPriority = group._structuredFieldPriority[field] ?? -1;
    if (group[field] && priority < previousPriority) return false;
    group[field] = incoming;
    group._structuredFieldPriority[field] = priority;
    return true;
  }

  function mergeEntryIntoGroup(group, entry, limits, options = {}) {
    if (!options.replay) group._events.push(entry);
    fillIdentity(group, entry);
    assignPreferredStructuredField(group, entry, 'kind');
    group.category = preferredCategory(group.category, entry.category);
    if (assignPreferredStructuredField(group, entry, 'itemType')) {
      group.identity.itemType = group.itemType;
    }
    if (assignPreferredStructuredField(group, entry, 'source')) {
      group.identity.source = group.source;
    }
    if (entry.explicitGroupKey) {
      group.explicitGroupKey = !group.explicitGroupKey
        ? entry.explicitGroupKey
        : [group.explicitGroupKey, entry.explicitGroupKey].sort()[0];
    }
    if (entry.method) {
      assignPreferredStructuredField(group, entry, 'method');
      if (!group.methods.includes(entry.method)) group.methods.push(entry.method);
    }
    for (const activityKey of entry.activityKeys || []) {
      if (!group.activityKeys.includes(activityKey)) group.activityKeys.push(activityKey);
    }
    const staleRevision = entry.revision > 0 && group.revision > entry.revision;
    if (!staleRevision) {
      const mergedText = mergeBoundedText(
        group.text,
        entry.text,
        entry.textMode,
        limits.maxTextChars,
        false
      );
      group.text = mergedText.value;
      group.textTruncated ||= entry.textTruncated || mergedText.truncated;
      for (const [field, incoming] of [
        ['output', entry.output],
        ['stdout', entry.stdout],
        ['stderr', entry.stderr],
      ]) {
        const mergedOutput = mergeBoundedText(
          group[field],
          incoming,
          entry.outputMode,
          limits.maxOutputChars,
          true
        );
        group[field] = mergedOutput.value;
        group.outputTruncated ||= entry.outputTruncated || mergedOutput.truncated;
      }
      const mergedResult = mergeBoundedText(
        group.resultText,
        entry.resultText,
        entry.outputMode,
        limits.maxOutputChars,
        true
      );
      group.resultText = mergedResult.value;
      group.resultTruncated ||= entry.resultTruncated || mergedResult.truncated;
      const mergedFileChanges = mergeFileChanges(group.fileChanges, entry.fileChanges, limits);
      group.fileChanges = mergedFileChanges.fileChanges;
      group.fileChangesTruncated ||= entry.fileChangesTruncated || mergedFileChanges.truncated;
      group.revision = Math.max(group.revision, entry.revision);
    }

    group.progressTruncated ||= entry.progressTruncated;
    group.argumentsTruncated ||= entry.argumentsTruncated;
    group.resultTruncated ||= entry.resultTruncated;
    group.fileChangesTruncated ||= entry.fileChangesTruncated;

    for (const field of [
      'name',
      'command',
      'cwd',
      'argumentsText',
      'commandActionsText',
      'server',
      'tool',
      'namespace',
      'resourceUri',
      'senderThreadId',
      'receiverThreadIdsText',
      'agentThreadId',
      'agentPath',
      'agentNickname',
      'agentRole',
      'parentThreadId',
      'subagentKind',
      'prompt',
      'agentsStatesText',
      'actionDataText',
      'model',
      'reasoningEffort',
      'query',
      'action',
    ]) {
      assignPreferredStructuredField(group, entry, field);
    }

    if (!staleRevision) {
      const wasTerminal = group.terminal;
      if (entry.terminal) {
        group.terminal = true;
        if (entry._present.status) group.status = entry.status;
        if (entry._present.success) group.success = entry.success;
        if (entry._present.exitCode) group.exitCode = entry.exitCode;
        if (entry._present.error) group.error = entry.error;
        if (entry._present.completedAt) group.completedAt = entry.completedAt;
        if (entry._present.durationMs) group.durationMs = entry.durationMs;
        if (entry._present.progress) group.progress = entry.progress;
      } else if (!wasTerminal) {
        if (entry._present.status) group.status = entry.status;
        if (entry._present.success) group.success = entry.success;
        if (entry._present.exitCode) group.exitCode = entry.exitCode;
        if (entry._present.error) group.error = entry.error;
        if (entry._present.completedAt) group.completedAt = entry.completedAt;
        if (entry._present.durationMs) group.durationMs = entry.durationMs;
        if (entry._present.progress) group.progress = entry.progress;
      }
      group.final ||= entry.final;
    }
    if (!group.timestamp && entry.timestamp) group.timestamp = entry.timestamp;
    if (entry.updatedAt || entry.timestamp) group.updatedAt = entry.updatedAt || entry.timestamp;
    group._index = Math.min(group._index, entry._index);
    return group;
  }

  function replayMergedGroup(groups, keys, limits) {
    const records = keys.map((key) => groups.get(key)).filter(Boolean);
    records.sort((left, right) => left._index - right._index);
    const target = records[0];
    if (!target || records.length === 1) return target || null;
    const events = records.flatMap((record) => record._events).sort((left, right) => left._index - right._index);
    const rebuilt = createGroup(events[0]);
    rebuilt.groupKey = target.groupKey;
    rebuilt.identity.groupKey = target.groupKey;
    rebuilt._events = events.slice();
    for (const event of events) mergeEntryIntoGroup(rebuilt, event, limits, { replay: true });
    for (const record of records) groups.delete(record.groupKey);
    groups.set(rebuilt.groupKey, rebuilt);
    return rebuilt;
  }

  function canonicalizeGroupKey(group) {
    const identity = group.identity || {};
    const groupKey = makeGroupKeyFromNormalized({
      explicitGroupKey: group.explicitGroupKey,
      canonicalConversationKey: identity.canonicalConversationKey,
      runId: identity.runId,
      turnId: identity.turnId,
      itemId: identity.itemId,
      callId: identity.callId,
      requestId: identity.requestId,
      processId: identity.processId,
      activityKey: identity.activityKey,
      activityKeys: group.activityKeys,
      summaryIndex: identity.summaryIndex,
      kind: group.kind,
      category: group.category,
    });
    group.groupKey = groupKey;
    group.identity.groupKey = groupKey;
    return group;
  }

  function renderedEntry(group) {
    const displayText = group.text || group.output || group.stdout || group.stderr || group.command || group.query || '';
    return {
      groupKey: group.groupKey,
      identity: { ...group.identity, groupKey: group.groupKey },
      activityKey: group.identity.activityKey || group.activityKeys[0] || null,
      runId: group.identity.runId || null,
      turnId: group.identity.turnId || null,
      itemId: group.identity.itemId || null,
      callId: group.identity.callId || null,
      requestId: group.identity.requestId || null,
      summaryIndex: Number(group.identity.summaryIndex || 0),
      kind: group.kind,
      type: group.category,
      category: group.category,
      itemType: group.itemType || null,
      source: group.source || null,
      method: group.method,
      methods: group.methods.slice(),
      activityKeys: group.activityKeys.slice(),
      name: group.name,
      text: displayText,
      output: group.output,
      stdout: group.stdout,
      stderr: group.stderr,
      command: group.command,
      cwd: group.cwd,
      argumentsText: group.argumentsText,
      commandActionsText: group.commandActionsText,
      durationMs: group.durationMs,
      processId: group.identity.processId || null,
      server: group.server || null,
      tool: group.tool || null,
      namespace: group.namespace || null,
      resourceUri: group.resourceUri || null,
      senderThreadId: group.senderThreadId || null,
      receiverThreadIdsText: group.receiverThreadIdsText || null,
      agentThreadId: group.agentThreadId || null,
      agentPath: group.agentPath || null,
      agentNickname: group.agentNickname || null,
      agentRole: group.agentRole || null,
      parentThreadId: group.parentThreadId || null,
      subagentKind: group.subagentKind || null,
      prompt: group.prompt || null,
      agentsStatesText: group.agentsStatesText || null,
      actionDataText: group.actionDataText || null,
      model: group.model || null,
      reasoningEffort: group.reasoningEffort || null,
      resultText: group.resultText || null,
      progress: group.progress,
      query: group.query,
      action: group.action,
      status: group.status,
      final: group.final,
      terminal: group.terminal,
      success: group.success,
      exitCode: group.exitCode,
      error: group.error,
      completedAt: group.completedAt,
      timestamp: group.timestamp,
      updatedAt: group.updatedAt,
      revision: group.revision,
      fileChanges: group.fileChanges.map((change) => ({ ...change })),
      textTruncated: group.textTruncated,
      outputTruncated: group.outputTruncated,
      progressTruncated: group.progressTruncated,
      argumentsTruncated: group.argumentsTruncated,
      resultTruncated: group.resultTruncated,
      fileChangesTruncated: group.fileChangesTruncated,
    };
  }

  function entryCharacterCost(entry) {
    return [
      entry.name,
      entry.text,
      entry.output,
      entry.stdout,
      entry.stderr,
      entry.command,
      entry.cwd,
      entry.argumentsText,
      entry.commandActionsText,
      entry.server,
      entry.tool,
      entry.namespace,
      entry.resourceUri,
      entry.senderThreadId,
      entry.receiverThreadIdsText,
      entry.agentThreadId,
      entry.agentPath,
      entry.agentNickname,
      entry.agentRole,
      entry.parentThreadId,
      entry.subagentKind,
      entry.prompt,
      entry.agentsStatesText,
      entry.actionDataText,
      entry.model,
      entry.reasoningEffort,
      entry.resultText,
      entry.progress,
      entry.query,
      entry.action,
      entry.status,
      entry.completedAt,
      entry.error,
      ...(entry.fileChanges || []).flatMap((change) => [change.path, change.status, change.diff]),
    ].reduce((sum, value) => sum + String(value || '').length, 0);
  }

  function boundRenderedEntryToTotal(entry, maximum) {
    let remaining = Math.max(0, Number(maximum) || 0);
    const prefixFields = [
      'name',
      'command',
      'cwd',
      'argumentsText',
      'commandActionsText',
      'server',
      'tool',
      'namespace',
      'resourceUri',
      'senderThreadId',
      'receiverThreadIdsText',
      'agentThreadId',
      'agentPath',
      'agentNickname',
      'agentRole',
      'parentThreadId',
      'subagentKind',
      'prompt',
      'agentsStatesText',
      'actionDataText',
      'model',
      'reasoningEffort',
      'query',
      'action',
      'status',
      'completedAt',
      'error',
      'text',
      'progress',
    ];
    const tailFields = ['output', 'stdout', 'stderr', 'resultText'];
    for (const field of prefixFields) {
      const original = String(entry[field] || '');
      const bounded = boundPrefix(original, remaining);
      entry[field] = bounded.value;
      if (bounded.truncated) {
        if (field === 'argumentsText') entry.argumentsTruncated = true;
        else if (field === 'progress') entry.progressTruncated = true;
        else entry.textTruncated = true;
      }
      remaining = Math.max(0, remaining - bounded.value.length);
    }
    for (const field of tailFields) {
      const original = String(entry[field] || '');
      const bounded = boundTail(original, remaining);
      entry[field] = bounded.value;
      if (bounded.truncated) {
        if (field === 'resultText') entry.resultTruncated = true;
        else entry.outputTruncated = true;
      }
      remaining = Math.max(0, remaining - bounded.value.length);
    }

    const boundedChanges = [];
    for (const rawChange of entry.fileChanges || []) {
      if (remaining <= 0) break;
      const change = { ...rawChange };
      for (const field of ['path', 'status']) {
        const bounded = boundPrefix(change[field], remaining);
        change[field] = bounded.value;
        change.truncated ||= bounded.truncated;
        entry.fileChangesTruncated ||= bounded.truncated;
        remaining = Math.max(0, remaining - bounded.value.length);
      }
      const diff = boundPrefix(change.diff, remaining, '\n...[diff truncated]');
      change.diff = diff.value;
      change.truncated ||= diff.truncated;
      entry.fileChangesTruncated ||= diff.truncated;
      remaining = Math.max(0, remaining - diff.value.length);
      boundedChanges.push(change);
    }
    if (boundedChanges.length < (entry.fileChanges || []).length) entry.fileChangesTruncated = true;
    entry.fileChanges = boundedChanges;
    return entry;
  }

  function enforceRenderedBounds(entries, limits) {
    const bounded = entries.slice(-limits.maxEntries);
    let total = bounded.reduce((sum, entry) => sum + entryCharacterCost(entry), 0);
    while (bounded.length > 1 && total > limits.maxTotalChars) {
      total -= entryCharacterCost(bounded.shift());
    }
    if (bounded.length === 1 && total > limits.maxTotalChars) {
      boundRenderedEntryToTotal(bounded[0], limits.maxTotalChars);
    }
    return bounded;
  }

  function aggregateThinkingEntries(values, options = {}) {
    const limits = normalizeLimits(options);
    const groups = new Map();
    const aliases = new Map();
    const source = Array.isArray(values) ? values : [];

    for (const [index, value] of source.entries()) {
      const entry = value?._normalizedThinkingEntry
        ? {
          ...value,
          _index: index,
        }
        : normalizeThinkingActivityEntry(value, index, limits);
      if (value?._normalizedThinkingEntry) {
        entry.groupKey = makeGroupKeyFromNormalized(entry);
        entry.aliasKeys = aliasKeysFor(entry);
      }
      if (!entry.text && !entry.output && !entry.stdout && !entry.stderr && !entry.command
        && !entry.cwd && !entry.argumentsText && !entry.commandActionsText
        && !entry.name && !entry.server && !entry.tool
        && !entry.namespace && !entry.resourceUri
        && !entry.senderThreadId && !entry.receiverThreadIdsText
        && !entry.prompt && !entry.agentsStatesText && !entry.actionDataText
        && !entry.model && !entry.reasoningEffort && !entry.resultText
        && entry.progress == null && !entry.query && !entry.action
        && !entry.fileChanges.length && !entry.status && !entry.error
        && !entry.final && !entry.terminal && entry.success == null
        && entry.exitCode == null && entry.durationMs == null
        && !entry.textTruncated && !entry.outputTruncated
        && !entry.progressTruncated && !entry.argumentsTruncated
        && !entry.resultTruncated && !entry.fileChangesTruncated) {
        continue;
      }

      const matchingKeys = new Set();
      if (groups.has(entry.groupKey) && scopeCompatible(groups.get(entry.groupKey), entry)) {
        matchingKeys.add(entry.groupKey);
      }
      for (const alias of entry.aliasKeys) {
        const key = aliases.get(alias);
        const group = key ? groups.get(key) : null;
        if (group && scopeCompatible(group, entry)) matchingKeys.add(key);
      }
      for (const [key, candidate] of groups) {
        if (
          stableEntityIdentityMatches(candidate, entry)
          && scopeCompatible(candidate, entry)
        ) {
          matchingKeys.add(key);
        }
      }
      const compatibleMatchingKeys = narrowAmbiguousContextMatches(groups, matchingKeys, entry);

      let group;
      if (!compatibleMatchingKeys.size) {
        group = createGroup(entry);
        groups.set(group.groupKey, group);
      } else if (compatibleMatchingKeys.size === 1) {
        group = groups.get([...compatibleMatchingKeys][0]);
      } else {
        group = replayMergedGroup(groups, [...compatibleMatchingKeys], limits);
        const mergedKeys = new Set(compatibleMatchingKeys);
        for (const [alias, key] of aliases) {
          if (mergedKeys.has(key)) aliases.set(alias, group.groupKey);
        }
      }

      mergeEntryIntoGroup(group, entry, limits);
      for (const alias of entry.aliasKeys) aliases.set(alias, group.groupKey);
    }

    const rendered = [...groups.values()]
      .map(canonicalizeGroupKey)
      .sort((left, right) => left._index - right._index)
      .map(renderedEntry);
    return enforceRenderedBounds(rendered, limits);
  }

  return Object.freeze({
    DEFAULT_LIMITS,
    aggregateThinkingEntries,
    buildThinkingRenderEntries: aggregateThinkingEntries,
    makeThinkingGroupKey,
    normalizeThinkingActivityEntry,
    thinkingEntryIdentity,
  });
}));
