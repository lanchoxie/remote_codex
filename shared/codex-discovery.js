const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonLines } = require('./jsonl');
const { pick } = require('./protocol');

const TRANSCRIPT_READ_LIMIT = Number(process.env.CODEX_DISCOVERY_TRANSCRIPT_READ_LIMIT || 12000);
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
      updatedAt: row.updated_at || null,
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
      updatedAt: latestTimestamp(
        preview.lastTimestamp,
        stats?.mtime?.toISOString(),
        existing.updatedAt,
        meta.timestamp
      ),
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
    lastTimestamp: null,
  };

  const rows = readJsonLines(filePath, TRANSCRIPT_READ_LIMIT);
  for (const row of rows) {
    if (!row) {
      continue;
    }

    preview.lastTimestamp = latestTimestamp(preview.lastTimestamp, row.timestamp);
    preview.cwd = preview.cwd || getCwdFromRow(row);

    const entry = makeTranscriptEntry(row);
    if (!entry) {
      continue;
    }

    preview.transcriptPreview.push(entry);
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

  if (row.type === 'response_item' && payload.type === 'message') {
    const text = cleanTranscriptText(extractPayloadText(payload));
    if (!text) {
      return null;
    }
    if (payload.role === 'user') {
      return { speaker: 'user', text, timestamp };
    }
    if (payload.role === 'assistant' || payload.role === 'agent') {
      return { speaker: 'agent', text, timestamp };
    }
  }

  if (row.type !== 'event_msg' || !payload) {
    return null;
  }

  if (payload.type === 'user_message' && payload.message) {
    return {
      speaker: 'user',
      text: cleanTranscriptText(payload.message),
      timestamp,
    };
  }

  if (payload.type === 'agent_message' && payload.message) {
    return {
      speaker: 'agent',
      text: cleanTranscriptText(payload.message),
      timestamp,
    };
  }

  if (payload.type === 'task_complete' && payload.last_agent_message) {
    return {
      speaker: 'agent',
      text: cleanTranscriptText(payload.last_agent_message),
      timestamp,
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

function dedupeTranscriptEntries(entries) {
  const deduped = [];
  for (const entry of entries) {
    if (!entry || !entry.text) {
      continue;
    }

    const previous = deduped[deduped.length - 1];
    if (previous && previous.speaker === entry.speaker && previous.text === entry.text) {
      continue;
    }
    deduped.push(entry);
  }
  return deduped;
}

function cleanPreviewText(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function cleanTranscriptText(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, TRANSCRIPT_ENTRY_CHAR_LIMIT);
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
};
