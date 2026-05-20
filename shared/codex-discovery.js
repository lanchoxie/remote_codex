const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonLines } = require('./jsonl');
const { pick } = require('./protocol');

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

    const rows = readJsonLines(filePath, 20);
    const metaRow = rows.find((row) => row && row.type === 'session_meta' && row.payload && row.payload.id);
    if (!metaRow) {
      return;
    }

    const meta = metaRow.payload;
    const preview = extractSessionPreview(filePath);
    const existing = discovered.get(meta.id) || {};
    discovered.set(meta.id, {
      ...existing,
      sessionId: meta.id,
      nativeThreadId: existing.nativeThreadId || meta.id,
      title: existing.title || meta.thread_name || meta.id,
      cwd: meta.cwd || existing.cwd || null,
      updatedAt: meta.timestamp || existing.updatedAt || null,
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
  };

  const rows = readJsonLines(filePath, 5000);
  for (const row of rows) {
    if (!row || row.type !== 'event_msg' || !row.payload) {
      continue;
    }

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

  preview.transcriptPreview = dedupeTranscriptEntries(preview.transcriptPreview).slice(-24);
  return preview;
}

function makeTranscriptEntry(row) {
  const payload = row.payload || {};
  const timestamp = row.timestamp || null;

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
    .slice(0, 1600);
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
