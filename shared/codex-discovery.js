const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonLines, readJsonLinesTail } = require('./jsonl');
const { pick } = require('./protocol');

const TRANSCRIPT_READ_LIMIT = Number(process.env.CODEX_DISCOVERY_TRANSCRIPT_READ_LIMIT || 12000);
const TRANSCRIPT_HEAD_READ_LIMIT = Number(process.env.CODEX_DISCOVERY_TRANSCRIPT_HEAD_READ_LIMIT || 500);
const TRANSCRIPT_PREVIEW_LIMIT = Number(process.env.CODEX_DISCOVERY_TRANSCRIPT_PREVIEW_LIMIT || 80);
const TRANSCRIPT_ENTRY_CHAR_LIMIT = Number(process.env.CODEX_DISCOVERY_TRANSCRIPT_ENTRY_CHAR_LIMIT || 3000);

function getDefaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function discoverCodexSessions(options = {}) {
  const codexHome = options.codexHome || getDefaultCodexHome();
  const discovered = new Map();

  const indexPath = path.join(codexHome, 'session_index.jsonl');
  for (const row of readJsonLines(indexPath, 5000)) {
    if (!row || !row.id) {
      continue;
    }

    discovered.set(row.id, {
      sessionId: row.id,
      nativeThreadId: row.id,
      title: row.thread_name || row.id,
      cwd: null,
      createdAt: row.created_at || row.timestamp || null,
      updatedAt: row.updated_at || null,
      messageCount: 0,
      source: 'index',
      live: false,
      imported: true,
      latestUserMessage: null,
      latestAgentMessage: null,
      transcriptPreview: [],
    });
  }

  const sessionsRoot = path.join(codexHome, 'sessions');
  walkFiles(sessionsRoot, (filePath) => {
    if (!filePath.endsWith('.jsonl')) {
      return;
    }

    const rows = readJsonLines(filePath, 250);
    const meta = getSessionMeta(filePath, rows);
    if (!meta || !meta.id) {
      return;
    }

    const preview = extractSessionPreview(filePath);
    const stats = safeStat(filePath);
    const existing = discovered.get(meta.id) || {};
    discovered.set(meta.id, {
      ...existing,
      sessionId: meta.id,
      nativeThreadId: existing.nativeThreadId || meta.id,
      title: existing.title || meta.thread_name || meta.id,
      cwd: meta.cwd || existing.cwd || preview.cwd || null,
      createdAt: earliestTimestamp(
        existing.createdAt,
        meta.timestamp,
        preview.firstTimestamp,
        parseTimestampFromFilePath(filePath)
      ),
      updatedAt: latestTimestamp(
        preview.lastTimestamp,
        stats?.mtime?.toISOString(),
        existing.updatedAt,
        meta.timestamp
      ),
      messageCount: Math.max(Number(existing.messageCount || 0), preview.messageCount || 0),
      source: meta.source || existing.source || 'rollout',
      originator: meta.originator || existing.originator || null,
      cliVersion: meta.cli_version || existing.cliVersion || null,
      imported: true,
      live: existing.live || false,
      summary: pick(meta, ['cwd', 'timestamp', 'originator', 'cli_version', 'source']),
      latestUserMessage: preview.latestUserMessage || existing.latestUserMessage || null,
      latestAgentMessage: preview.latestAgentMessage || existing.latestAgentMessage || null,
      transcriptPreview: preview.transcriptPreview || existing.transcriptPreview || [],
      rolloutPath: filePath,
    });
  });

  return Array.from(discovered.values())
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map((session) => ({
      ...session,
      nativeThreadId: session.nativeThreadId || session.sessionId,
      cwdLabel: session.cwd ? path.basename(session.cwd) || session.cwd : '(unknown)',
    }));
}

function extractSessionPreview(filePath) {
  const preview = {
    latestUserMessage: null,
    latestAgentMessage: null,
    transcriptPreview: [],
    cwd: null,
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0,
  };

  const rows = mergeRowsByTimestampAndType([
    ...readJsonLines(filePath, TRANSCRIPT_HEAD_READ_LIMIT),
    ...readJsonLinesTail(filePath, TRANSCRIPT_READ_LIMIT),
  ]);
  for (const row of rows) {
    if (!row) {
      continue;
    }

    preview.firstTimestamp = earliestTimestamp(preview.firstTimestamp, row.timestamp);
    preview.lastTimestamp = latestTimestamp(preview.lastTimestamp, row.timestamp);
    preview.cwd = preview.cwd || getCwdFromRow(row);

    const entry = makeTranscriptEntry(row);
    if (!entry) {
      continue;
    }

    preview.transcriptPreview.push(entry);
    preview.messageCount += 1;
    if (entry.speaker === 'user') {
      preview.latestUserMessage = cleanPreviewText(entry.text);
    }
    if (entry.speaker === 'agent') {
      preview.latestAgentMessage = cleanPreviewText(entry.text);
    }
  }

  preview.transcriptPreview = dedupeTranscriptEntries(preview.transcriptPreview).slice(-TRANSCRIPT_PREVIEW_LIMIT);
  return preview;
}

function mergeRowsByTimestampAndType(rows) {
  const seen = new Set();
  const merged = [];
  for (const row of rows || []) {
    if (!row) {
      continue;
    }
    const key = `${row.timestamp || ''}|${row.type || ''}|${JSON.stringify(row.payload || {})}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function getSessionMeta(filePath, rows) {
  const metaRow = rows.find((row) => row && row.type === 'session_meta' && row.payload && row.payload.id);
  if (metaRow) {
    return metaRow.payload;
  }

  const id = parseSessionIdFromFilePath(filePath);
  if (!id) {
    return null;
  }

  return {
    id,
    cwd: firstNonEmpty(rows.map(getCwdFromRow)),
    timestamp: firstNonEmpty(rows.map((row) => row && row.timestamp)),
    source: 'rollout',
  };
}

function parseSessionIdFromFilePath(filePath) {
  const matches = String(path.basename(filePath)).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

function parseTimestampFromFilePath(filePath) {
  const match = String(path.basename(filePath)).match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  if (!match) {
    return null;
  }
  return `${match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')}.000Z`;
}

function getCwdFromRow(row) {
  if (!row || !row.payload) {
    return null;
  }
  if (row.payload.cwd) {
    return row.payload.cwd;
  }
  if (row.type === 'turn_context' && row.payload.cwd) {
    return row.payload.cwd;
  }

  const text = extractPayloadText(row.payload);
  const match = text.match(/<cwd>([^<]+)<\/cwd>/);
  return match ? match[1].trim() : null;
}

function makeTranscriptEntry(row) {
  const payload = row.payload || {};
  const timestamp = row.timestamp || null;
  const phase = String(payload.phase || '').trim().toLowerCase();

  if (row.type === 'response_item' && payload.type === 'message') {
    if (payload.role === 'user') {
      const text = cleanTranscriptText(extractPayloadText(payload), 'user');
      if (!text) {
        return null;
      }
      return { speaker: 'user', text, timestamp };
    }
    if (payload.role === 'assistant' || payload.role === 'agent') {
      if (phase === 'commentary') {
        return null;
      }
      const text = cleanTranscriptText(extractPayloadText(payload), 'agent');
      if (!text) {
        return null;
      }
      return { speaker: 'agent', text, timestamp };
    }
  }

  if (row.type !== 'event_msg' || !payload) {
    return null;
  }

  if (payload.type === 'user_message' && payload.message) {
    const text = cleanTranscriptText(payload.message, 'user');
    if (!text) {
      return null;
    }
    return {
      speaker: 'user',
      text,
      timestamp,
    };
  }

  if (payload.type === 'agent_message' && payload.message) {
    if (phase === 'commentary') {
      return null;
    }
    const text = cleanTranscriptText(payload.message, 'agent');
    if (!text) {
      return null;
    }
    return {
      speaker: 'agent',
      text,
      timestamp,
    };
  }

  if (payload.type === 'task_complete' && payload.last_agent_message) {
    const text = cleanTranscriptText(payload.last_agent_message, 'agent');
    if (!text) {
      return null;
    }
    return {
      speaker: 'agent',
      text,
      timestamp,
    };
  }

  return null;
}

function makeCodexRowEvents(row) {
  const events = [];
  if (!row || typeof row !== 'object') {
    return events;
  }

  const transcript = makeTranscriptEntry(row);
  if (transcript) {
    events.push({
      type: 'session.transcript',
      entry: transcript,
    });
  }

  const runtime = makeRuntimePatch(row);
  if (runtime) {
    events.push({
      type: 'session.runtime_updated',
      patch: runtime,
    });
  }

  const diagnostic = makeDiagnosticEntry(row);
  if (diagnostic) {
    events.push({
      type: 'session.diagnostic',
      entry: diagnostic,
    });
  }

  return events;
}

function makeRuntimePatch(row) {
  const payload = row.payload || {};
  const timestamp = row.timestamp || null;

  if (row.type === 'event_msg' && payload.type === 'task_started') {
    return {
      connection: 'tailing',
      phase: 'thinking',
      busy: true,
      activeTurnId: payload.turn_id || null,
      currentTurnStatus: 'inProgress',
      modelContextWindow: payload.model_context_window || null,
      updatedAt: timestamp,
    };
  }

  if (row.type === 'event_msg' && payload.type === 'task_complete') {
    return {
      connection: 'tailing',
      phase: 'idle',
      busy: false,
      activeTurnId: null,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      currentTurnStatus: 'completed',
      lastTurnDurationMs: payload.duration_ms || null,
      timeToFirstTokenMs: payload.time_to_first_token_ms || null,
      updatedAt: timestamp,
    };
  }

  if (row.type === 'event_msg' && payload.type === 'turn_aborted') {
    return {
      connection: 'tailing',
      phase: 'interrupted',
      busy: false,
      activeTurnId: null,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      currentTurnStatus: 'interrupted',
      lastTurnDurationMs: payload.duration_ms || null,
      updatedAt: timestamp,
    };
  }

  if (row.type === 'event_msg' && payload.type === 'token_count') {
    const patch = {
      connection: 'tailing',
      updatedAt: timestamp,
    };
    const tokenUsage = normalizeTokenUsage(payload.info || {});
    const rateLimits = normalizeRateLimits(payload.rate_limits);
    if (tokenUsage) {
      patch.tokenUsage = tokenUsage;
    }
    if (rateLimits) {
      patch.rateLimits = rateLimits;
    }
    return Object.keys(patch).length > 2 ? patch : null;
  }

  if (row.type === 'response_item' && payload.type === 'function_call') {
    return {
      connection: 'tailing',
      phase: 'thinking',
      busy: true,
      updatedAt: timestamp,
    };
  }

  return null;
}

function makeDiagnosticEntry(row) {
  const payload = row.payload || {};
  const timestamp = row.timestamp || null;
  const phase = String(payload.phase || '').trim().toLowerCase();

  if (phase === 'commentary') {
    let text = '';
    let method = '';
    if (row.type === 'response_item' && payload.type === 'message' && (payload.role === 'assistant' || payload.role === 'agent')) {
      text = cleanDiagnosticText(extractPayloadText(payload));
      method = 'response_item/message/commentary';
    } else if (row.type === 'event_msg' && payload.type === 'agent_message') {
      text = cleanDiagnosticText(payload.message || '');
      method = 'event_msg/agent_message/commentary';
    }
    if (text) {
      return {
        timestamp,
        severity: 'info',
        source: 'codex-jsonl',
        kind: 'commentary',
        method,
        message: limitText(text, 300),
        data: {
          text,
          phase,
        },
      };
    }
  }

  if (row.type === 'response_item' && payload.type === 'reasoning') {
    const text = extractReasoningText(payload);
    if (!text) {
      return null;
    }
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: 'reasoning',
      method: 'response_item/reasoning',
      message: limitText(text, 300),
      data: {
        text,
      },
    };
  }

  if (row.type === 'response_item' && payload.type === 'function_call') {
    const call = summarizeFunctionCall(payload);
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: call.kind,
      method: `response_item/function_call/${call.name || 'tool'}`,
      message: call.message,
      data: call.data,
    };
  }

  if (row.type === 'response_item' && payload.type === 'function_call_output') {
    const output = cleanDiagnosticText(payload.output || '');
    if (!output) {
      return null;
    }
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: 'command-output',
      method: 'response_item/function_call_output',
      message: limitText(output, 300),
      data: {
        callId: payload.call_id || null,
        output: limitText(output, 2000),
      },
    };
  }

  if (row.type !== 'event_msg' || !payload.type) {
    return null;
  }

  if (payload.type === 'task_started') {
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: 'turn',
      method: 'event_msg/task_started',
      message: `Turn started${payload.turn_id ? `: ${payload.turn_id}` : ''}`,
      turnId: payload.turn_id || null,
      data: {
        turnId: payload.turn_id || null,
        startedAt: payload.started_at || timestamp,
        modelContextWindow: payload.model_context_window || null,
        collaborationMode: payload.collaboration_mode_kind || null,
      },
    };
  }

  if (payload.type === 'task_complete') {
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: 'turn',
      method: 'event_msg/task_complete',
      message: `Turn completed${payload.duration_ms ? ` in ${payload.duration_ms}ms` : ''}`,
      turnId: payload.turn_id || null,
      data: {
        turnId: payload.turn_id || null,
        completedAt: payload.completed_at || timestamp,
        durationMs: payload.duration_ms || null,
        timeToFirstTokenMs: payload.time_to_first_token_ms || null,
      },
    };
  }

  if (payload.type === 'turn_aborted') {
    return {
      timestamp,
      severity: 'warning',
      source: 'codex-jsonl',
      kind: 'turn',
      method: 'event_msg/turn_aborted',
      message: payload.reason ? `Turn aborted: ${payload.reason}` : 'Turn aborted',
      turnId: payload.turn_id || null,
      data: {
        turnId: payload.turn_id || null,
        reason: payload.reason || null,
        completedAt: payload.completed_at || timestamp,
        durationMs: payload.duration_ms || null,
      },
    };
  }

  if (payload.type === 'patch_apply_end') {
    const changes = normalizePatchChanges(payload.changes);
    return {
      timestamp,
      severity: payload.success === false ? 'error' : 'info',
      source: 'codex-jsonl',
      kind: 'file-change',
      method: 'event_msg/patch_apply_end',
      message: payload.success === false ? 'Patch apply failed' : `Patch applied${changes.length ? `: ${changes.length} file(s)` : ''}`,
      turnId: payload.turn_id || null,
      data: {
        callId: payload.call_id || null,
        turnId: payload.turn_id || null,
        status: payload.status || null,
        success: typeof payload.success === 'boolean' ? payload.success : null,
        stdout: limitText(payload.stdout || '', 2000),
        stderr: limitText(payload.stderr || '', 2000),
        changes,
      },
    };
  }

  if (payload.type === 'web_search_end') {
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: 'web-search',
      method: 'event_msg/web_search_end',
      message: payload.query ? `Web search: ${limitText(payload.query, 220)}` : 'Web search finished',
      data: {
        callId: payload.call_id || null,
        query: payload.query || null,
        action: payload.action || null,
      },
    };
  }

  if (payload.type === 'context_compacted') {
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: 'thread',
      method: 'event_msg/context_compacted',
      message: 'Context compacted',
      data: payload,
    };
  }

  if (payload.type === 'thread_rolled_back') {
    return {
      timestamp,
      severity: 'warning',
      source: 'codex-jsonl',
      kind: 'thread',
      method: 'event_msg/thread_rolled_back',
      message: `Thread rolled back${payload.num_turns ? ` by ${payload.num_turns} turn(s)` : ''}`,
      data: payload,
    };
  }

  if (payload.type === 'token_count') {
    return {
      timestamp,
      severity: 'info',
      source: 'codex-jsonl',
      kind: 'token-usage',
      method: 'event_msg/token_count',
      message: 'Token usage updated',
      data: {
        tokenUsage: normalizeTokenUsage(payload.info || {}),
        rateLimits: normalizeRateLimits(payload.rate_limits),
      },
    };
  }

  return null;
}

function extractPayloadText(payload) {
  if (!payload) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload.text === 'string') {
    return payload.text;
  }
  if (typeof payload.message === 'string') {
    return payload.message;
  }

  const content = payload.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (!part || typeof part !== 'object') {
        return '';
      }
      return part.text || part.content || part.input_text || part.output_text || '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractReasoningText(payload) {
  const candidates = [
    payload.summary,
    payload.content,
    payload.text,
  ];
  for (const candidate of candidates) {
    const text = extractStructuredText(candidate);
    if (text) {
      return cleanDiagnosticText(text);
    }
  }
  return '';
}

function extractStructuredText(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(extractStructuredText)
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  return value.text
    || value.content
    || value.summary
    || value.delta
    || value.output_text
    || value.input_text
    || '';
}

function parseJsonObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function summarizeFunctionCall(payload) {
  const name = String(payload.name || 'tool').trim();
  const args = parseJsonObject(payload.arguments) || {};
  const command = cleanDiagnosticText(args.command || args.cmd || args.text || '');
  const workdir = cleanDiagnosticText(args.workdir || args.cwd || '');
  const summary = command || cleanDiagnosticText(args.path || args.file || args.target || '');
  const isPatch = /patch|apply_patch|file|edit|write/i.test(name);
  return {
    name,
    kind: isPatch ? 'file-change' : 'tool-call',
    message: `${name}${summary ? `: ${limitText(summary, 220)}` : ''}`,
    data: {
      name,
      callId: payload.call_id || null,
      arguments: args,
      command: command || null,
      cwd: workdir || null,
    },
  };
}

function normalizePatchChanges(changes) {
  if (!Array.isArray(changes)) {
    return [];
  }
  return changes
    .map((change) => {
      if (!change || typeof change !== 'object') {
        return null;
      }
      return {
        path: change.path || change.file || change.file_path || change.name || 'workspace change',
        additions: Number(change.additions || change.added || change.lines_added || 0) || 0,
        deletions: Number(change.deletions || change.deleted || change.lines_deleted || 0) || 0,
        diff: change.diff || change.patch || change.unified_diff || '',
      };
    })
    .filter(Boolean);
}

function normalizeTokenUsage(info) {
  const total = normalizeTokenUsageRecord(info.total_token_usage || info.totalTokenUsage || info.total);
  const last = normalizeTokenUsageRecord(info.last_token_usage || info.lastTokenUsage || info.last);
  if (!total && !last) {
    return null;
  }
  return {
    total: total || last,
    last: last || total,
    modelContextWindow: info.model_context_window || info.modelContextWindow || null,
  };
}

function normalizeTokenUsageRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  return {
    inputTokens: Number(record.input_tokens ?? record.inputTokens ?? 0) || 0,
    cachedInputTokens: Number(record.cached_input_tokens ?? record.cachedInputTokens ?? 0) || 0,
    outputTokens: Number(record.output_tokens ?? record.outputTokens ?? 0) || 0,
    reasoningOutputTokens: Number(record.reasoning_output_tokens ?? record.reasoningOutputTokens ?? 0) || 0,
    totalTokens: Number(record.total_tokens ?? record.totalTokens ?? 0) || 0,
  };
}

function normalizeRateLimits(rateLimits) {
  const first = Array.isArray(rateLimits) ? rateLimits[0] : rateLimits;
  if (!first || typeof first !== 'object') {
    return null;
  }
  return {
    planType: first.plan_type || first.planType || null,
    primary: normalizeRateLimitWindow(first.primary),
    secondary: normalizeRateLimitWindow(first.secondary),
    credits: first.credits || null,
    rateLimitReachedType: first.rate_limit_reached_type || first.rateLimitReachedType || null,
  };
}

function normalizeRateLimitWindow(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    usedPercent: Number(value.used_percent ?? value.usedPercent ?? 0) || 0,
    windowDurationMins: Number(value.window_duration_mins ?? value.windowDurationMins ?? 0) || null,
    resetsAt: value.resets_at || value.resetsAt || null,
  };
}

function cleanDiagnosticText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function limitText(value, max = 500) {
  const text = cleanDiagnosticText(value);
  if (!text || text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function dedupeTranscriptEntries(entries) {
  const deduped = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !entry.text) {
      continue;
    }

    const key = `${entry.speaker || 'system'}|${entry.timestamp || ''}|${canonicalTranscriptText(entry.text)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const previous = deduped[deduped.length - 1];
    if (previous && previous.speaker === entry.speaker && canonicalTranscriptText(previous.text) === canonicalTranscriptText(entry.text)) {
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
}

function cleanPreviewText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function cleanTranscriptText(value, speaker = '') {
  const text = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const stripped = cleanUserFacingTranscriptText(stripResumeBootstrapText(text, speaker), speaker);
  return stripped.slice(0, TRANSCRIPT_ENTRY_CHAR_LIMIT);
}

function cleanUserFacingTranscriptText(value, speaker = '') {
  let text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!text || isInternalTranscriptText(text)) {
    return '';
  }

  text = stripEnvironmentContextText(text).trim();
  if (String(speaker || '').toLowerCase() === 'user') {
    text = stripIdeContextText(text).trim();
  }

  return isInternalTranscriptText(text) ? '' : text;
}

function stripEnvironmentContextText(value) {
  return String(value || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .trim();
}

function stripIdeContextText(value) {
  const text = String(value || '').trim();
  const requestMatch = text.match(/(?:^|\n)## My request for Codex:\s*([\s\S]*)$/i);
  return requestMatch ? requestMatch[1].trim() : text;
}

function isInternalTranscriptText(value) {
  const text = String(value || '').trim();
  if (!text) {
    return true;
  }
  if (/^<environment_context>[\s\S]*<\/environment_context>$/i.test(text)) {
    return true;
  }
  if (/^The following is the Codex agent history (?:whose request action you are assessing|added since your last approval assessment)\b/i.test(text)) {
    return true;
  }
  if (/^>>>\s+TRANSCRIPT(?:\s+DELTA)?\s+START\b/im.test(text)) {
    return true;
  }
  if (/^\{\s*"(?:risk_level|outcome|user_authorization)"\s*:/.test(text) && /"outcome"\s*:\s*"(?:allow|deny)"/i.test(text)) {
    return true;
  }
  return false;
}

function canonicalTranscriptText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripResumeBootstrapText(value, speaker = '') {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const hasPrelude = /Continue this conversation with the following prior context in mind:/i.test(text);
  const requestMatch = text.match(/(?:^|\n)New user request:\s*([\s\S]*)$/i);
  if (!hasPrelude && !requestMatch) {
    return text;
  }

  if (speaker === 'user') {
    return requestMatch ? requestMatch[1].trim() : '';
  }
  return '';
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return null;
}

function latestTimestamp(...values) {
  let latest = null;
  let latestTime = 0;
  for (const value of values.flat()) {
    if (!value) {
      continue;
    }
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time <= latestTime) {
      continue;
    }
    latest = new Date(time).toISOString();
    latestTime = time;
  }
  return latest;
}

function earliestTimestamp(...values) {
  let earliest = null;
  let earliestTime = Infinity;
  for (const value of values.flat()) {
    if (!value) {
      continue;
    }
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time >= earliestTime) {
      continue;
    }
    earliest = new Date(time).toISOString();
    earliestTime = time;
  }
  return earliest;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function walkFiles(rootDir, visit) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

module.exports = {
  discoverCodexSessions,
  getDefaultCodexHome,
  makeCodexRowEvents,
  makeTranscriptEntry,
};
