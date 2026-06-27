const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');
const {
  discoverCodexSessions,
  extractSessionDiagnostics,
  extractSessionTranscript,
  findCodexSessionFile,
  getDefaultCodexHome,
  makeTranscriptEntry,
  readCodexSessionSummary,
} = require('../../shared/codex-discovery');
const { CodexSessionTailer } = require('../../shared/codex-tail');
const { makeId, nowIso, normalizeArgs } = require('../../shared/protocol');
const { resolveManagedRuntime, startManagedRuntimeSession } = require('./runtime-adapters');
const { normalizeApiConfig } = require('./runtime-utils');

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const RELAY_AUTH_TOKEN = loadRelayAuthToken();
const HOST_ID = process.env.HOST_ID || os.hostname();
const HOST_LABEL = process.env.HOST_LABEL || HOST_ID;
const CODEX_HOME = process.env.CODEX_HOME || getDefaultCodexHome();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);
const DISCOVERY_INTERVAL_MS = Number(process.env.DISCOVERY_INTERVAL_MS || 15000);
const CODEX_TAIL_ENABLED = String(process.env.CODEX_TAIL_ENABLED || 'true') !== 'false';
const CODEX_TAIL_INTERVAL_MS = Number(process.env.CODEX_TAIL_INTERVAL_MS || 1000);
const CODEX_DISCOVERY_LIST_PREVIEW = String(
  process.env.CODEX_DISCOVERY_LIST_PREVIEW || (process.platform !== 'win32' ? 'true' : 'false')
).trim().toLowerCase() !== 'false';
const CODEX_DISCOVERY_LIST_META_LIMIT = Number(
  process.env.CODEX_DISCOVERY_LIST_META_LIMIT || (CODEX_DISCOVERY_LIST_PREVIEW ? 250 : 40)
);
const SESSION_WATCH_TTL_MS = Math.max(30000, Number(process.env.AGENT_SESSION_WATCH_TTL_MS || 5 * 60 * 1000));
const WATCH_PERFORMANCE_WARN_MS = Math.max(1000, Number(process.env.AGENT_WATCH_PERFORMANCE_WARN_MS || 8000));
const WATCH_PERFORMANCE_SLOW_MS = Math.max(WATCH_PERFORMANCE_WARN_MS, Number(process.env.AGENT_WATCH_PERFORMANCE_SLOW_MS || 15000));
const WATCH_PERFORMANCE_REPORT_COOLDOWN_MS = Math.max(10000, Number(process.env.AGENT_WATCH_PERFORMANCE_REPORT_COOLDOWN_MS || 60000));
const AUTO_START_SESSION = String(process.env.AUTO_START_SESSION || 'true') !== 'false';
const MANAGED_RUNTIME = process.env.MANAGED_RUNTIME || '';
const MANAGED_COMMAND = process.env.MANAGED_COMMAND || 'codex-app-server';
const MANAGED_ARGS = normalizeArgs(process.env.MANAGED_ARGS_JSON || '[]');
const MANAGED_CWD = process.env.MANAGED_CWD || process.cwd();
const WORKSPACE_ROOTS = parseWorkspaceRoots(process.env.WORKSPACE_ROOTS || '');
const MAX_FILE_TRANSFER_BYTES = Number(process.env.AGENT_MAX_FILE_TRANSFER_BYTES || 128 * 1024 * 1024);
const MAX_CHUNKED_FILE_TRANSFER_BYTES = Number(process.env.AGENT_MAX_CHUNKED_FILE_TRANSFER_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_FILE_CHUNK_BYTES = Number(process.env.AGENT_FILE_TRANSFER_CHUNK_BYTES || 4 * 1024 * 1024);
const FETCH_RETRY_ATTEMPTS = Math.max(1, Number(process.env.AGENT_FETCH_RETRY_ATTEMPTS || 3));
const FETCH_RETRY_BASE_MS = Math.max(50, Number(process.env.AGENT_FETCH_RETRY_BASE_MS || 150));
const FETCH_REQUEST_TIMEOUT_MS = Number(process.env.AGENT_FETCH_TIMEOUT_MS || 30000);
const SESSION_DETAIL_DIAGNOSTIC_LIMIT = Number(process.env.AGENT_SESSION_DETAIL_DIAGNOSTIC_LIMIT || 400);
const WINDOWS_DRIVE_PROBE_LETTERS = String(process.env.AGENT_WINDOWS_BROWSE_DRIVES || 'CDE')
  .toUpperCase()
  .replace(/[^A-Z]/g, '');

const liveSessions = new Map();
const activeFileUploads = new Map();
const watchedHistorySessions = new Map();
let lastWatchPerformanceReportAt = 0;
const codexTailer = CODEX_TAIL_ENABLED
  ? new CodexSessionTailer({
    codexHome: CODEX_HOME,
    hostId: HOST_ID,
    postEvent,
    log: logAgentError,
  })
  : null;
let lastCommandId = 0;

function loadRelayAuthToken() {
  const envToken = String(process.env.RELAY_AUTH_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }
  try {
    return fs.readFileSync(path.join(process.cwd(), 'tmp', 'relay-auth-token.txt'), 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function getCapabilities() {
  return {
    discovery: true,
    managedSessions: true,
    directoryBrowse: true,
    structuredStatus: true,
    requestResponses: true,
    interrupt: true,
    hostProbe: true,
    turnControls: true,
    nativePlan: true,
    goalControls: true,
    sessionDetail: true,
    sessionSearch: true,
    modelList: true,
    skillList: true,
    apiTest: true,
    review: true,
    imageInput: true,
    fileTransfer: true,
    chunkedFileTransfer: true,
    agentRuntimes: true,
    realtimeSessionSync: CODEX_TAIL_ENABLED,
    codexJsonlTail: CODEX_TAIL_ENABLED,
    demoMode: MANAGED_RUNTIME === 'demo' || MANAGED_COMMAND === 'demo',
  };
}

function logAgentError(...args) {
  console.error(`[${nowIso()}]`, ...args);
}

function logAgentNotice(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

function isTransientFetchError(error) {
  if (!error) {
    return false;
  }
  return error.code === 'ECONNRESET'
    || error.code === 'ECONNREFUSED'
    || error.code === 'EPIPE'
    || error.code === 'ETIMEDOUT'
    || error.code === 'ECONNABORTED'
    || error.message === 'socket hang up'
    || error.message === 'aborted'
    || error.message === 'response aborted';
}

function logAgentTransient(prefix, error) {
  const log = isTransientFetchError(error) ? logAgentNotice : logAgentError;
  log(prefix, error?.message || String(error || 'unknown error'));
}

async function fetchJson(targetUrl, options = {}) {
  const attempts = options.retryOnTransient ? FETCH_RETRY_ATTEMPTS : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(targetUrl, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientFetchError(error)) {
        throw error;
      }
      await sleep(FETCH_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

function fetchJsonOnce(targetUrl, options = {}) {
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;
  const authHeaders = RELAY_AUTH_TOKEN
    ? { Authorization: `Bearer ${RELAY_AUTH_TOKEN}` }
    : {};
  const serializedBody = options.body ? JSON.stringify(options.body) : '';

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      fn(value);
    };
    const req = client.request(
      {
        method: options.method || 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(serializedBody ? { 'Content-Length': Buffer.byteLength(serializedBody) } : {}),
          ...authHeaders,
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch (error) {
            settle(reject, new Error(`invalid JSON from ${targetUrl}: ${error.message}`));
            return;
          }
          if ((res.statusCode || 0) >= 400) {
            settle(reject, new Error((body && body.error) || `relay request failed with ${res.statusCode}`));
            return;
          }
          settle(resolve, { statusCode: res.statusCode || 0, body });
        });
        res.on('error', (error) => settle(reject, error));
        res.on('aborted', () => {
          const error = new Error('response aborted');
          error.code = 'ECONNRESET';
          settle(reject, error);
        });
      }
    );

    req.on('error', (error) => settle(reject, error));
    if (FETCH_REQUEST_TIMEOUT_MS > 0) {
      req.setTimeout(FETCH_REQUEST_TIMEOUT_MS, () => {
        const error = new Error('relay request timed out');
        error.code = 'ETIMEDOUT';
        req.destroy(error);
      });
    }
    if (serializedBody) {
      req.write(serializedBody);
    }
    req.end();
  });
}

function buildApiTestUrl(baseUrl) {
  const raw = String(baseUrl || '').trim() || 'https://api.openai.com/v1';
  return `${raw.replace(/\/+$/, '')}/models`;
}

function summarizeApiTestBody(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) {
      return String(parsed.error.message).slice(0, 500);
    }
    if (parsed?.message) {
      return String(parsed.message).slice(0, 500);
    }
    if (Array.isArray(parsed?.data)) {
      return `${parsed.data.length} model${parsed.data.length === 1 ? '' : 's'} returned`;
    }
    return JSON.stringify(parsed).slice(0, 500);
  } catch (_) {
    return text.slice(0, 500);
  }
}

function testApiProfile(apiConfig, options = {}) {
  const config = normalizeApiConfig(apiConfig) || {};
  const targetUrl = buildApiTestUrl(config.baseUrl);
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;
  const timeoutMs = Number(options.timeoutMs || 15000) || 15000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        ok: Boolean(payload.ok),
        statusCode: payload.statusCode || 0,
        latencyMs: Date.now() - startedAt,
        url: targetUrl,
        provider: config.provider || null,
        profileId: config.profileId || null,
        label: config.label || null,
        message: payload.message || '',
        error: payload.error || null,
        testedAt: nowIso(),
      });
    };

    const req = client.request(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          Accept: 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode || 0;
          const message = summarizeApiTestBody(raw);
          finish({
            ok: statusCode >= 200 && statusCode < 300,
            statusCode,
            message: message || `${statusCode} ${res.statusMessage || ''}`.trim(),
            error: statusCode >= 400 ? (message || `${statusCode} ${res.statusMessage || 'HTTP error'}`.trim()) : null,
          });
        });
        res.on('error', (error) => finish({ error: error.message }));
        res.on('aborted', () => finish({ error: 'response aborted' }));
      }
    );
    req.on('error', (error) => finish({ error: error.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`API test timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

async function postEvent(event, options = {}) {
  try {
    await fetchJson(`${RELAY_URL}/api/agent/events`, {
      method: 'POST',
      body: { event },
      retryOnTransient: options.retryOnTransient !== false,
    });
  } catch (error) {
    if (options.bestEffort || isTransientFetchError(error)) {
      logAgentTransient(`[agent] failed to post ${event?.type || 'event'}:`, error);
      return;
    }
    throw error;
  }
}

async function registerHost() {
  await fetchJson(`${RELAY_URL}/api/agent/register`, {
    method: 'POST',
    retryOnTransient: true,
    body: {
      hostId: HOST_ID,
      label: HOST_LABEL,
      platform: process.platform,
      capabilities: getCapabilities(),
    },
  });
}

async function heartbeat() {
  await fetchJson(`${RELAY_URL}/api/agent/heartbeat`, {
    method: 'POST',
    retryOnTransient: true,
    body: {
      hostId: HOST_ID,
      label: HOST_LABEL,
      platform: process.platform,
      capabilities: getCapabilities(),
      time: nowIso(),
    },
  });
}

async function sendDiscovery() {
  const sessions = discoverCodexSessions({
    codexHome: CODEX_HOME,
    preview: CODEX_DISCOVERY_LIST_PREVIEW,
    metaReadLimit: CODEX_DISCOVERY_LIST_META_LIMIT,
  }).map((session) => ({
    sessionId: session.sessionId,
    title: session.title,
    cwd: session.cwd,
    source: session.source || 'imported',
    live: false,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount || 0,
    latestUserMessage: session.latestUserMessage || null,
    latestAgentMessage: session.latestAgentMessage || null,
    transcriptPreview: session.transcriptPreview || [],
    rolloutPath: session.rolloutPath || null,
    originSessionId: session.originSessionId || null,
    conversationKey: session.conversationKey || session.sessionId,
  }));

  const seenRunners = new Set();
  for (const runner of liveSessions.values()) {
    if (!runner || seenRunners.has(runner)) {
      continue;
    }
    seenRunners.add(runner);
    const liveSessionId = typeof runner.currentSessionId === 'function'
      ? runner.currentSessionId()
      : runner.sessionId;
    if (!liveSessionId) {
      continue;
    }
    sessions.push({
      sessionId: liveSessionId,
      title: runner.title || runner.runtime?.cwd || liveSessionId,
      cwd: runner.cwd || runner.runtime?.cwd || MANAGED_CWD,
      source: 'managed',
      live: true,
      createdAt: runner.createdAt || runner.startedAt || nowIso(),
      updatedAt: nowIso(),
      messageCount: 0,
      latestUserMessage: null,
      latestAgentMessage: null,
      transcriptPreview: [],
      originSessionId: runner.originSessionId || null,
      sourceSessionId: runner.sourceSessionId || null,
      conversationKey: runner.conversationKey || runner.originSessionId || liveSessionId,
      bridgeSessionId: runner.bridgeSessionId || null,
      runId: runner.runId || runner.runtime?.runId || null,
      nativeThreadId: runner.nativeThreadId || liveSessionId,
      launchMode: runner.launchMode || null,
      runtime: runner.runtime || null,
    });
  }

  await postEvent({
    type: 'session.discovery',
    hostId: HOST_ID,
    sessions,
  }, { retryOnTransient: true });
}

function collectSessionIdentityCandidates(input = {}) {
  return [
    input.sessionId,
    input.nativeThreadId,
    input.bridgeSessionId,
    input.originSessionId,
    input.sourceSessionId,
    input.conversationKey,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function resolveSessionFileFromCandidates(input = {}) {
  for (const candidate of collectSessionIdentityCandidates(input)) {
    const found = findCodexSessionFile({
      codexHome: CODEX_HOME,
      sessionId: candidate,
      nativeThreadId: candidate,
      bridgeSessionId: candidate,
      originSessionId: candidate,
      sourceSessionId: candidate,
      conversationKey: candidate,
    });
    if (found) {
      return found;
    }
  }
  return null;
}

function resolveDiscoveredSession(command = {}) {
  const candidates = new Set(collectSessionIdentityCandidates(command));

  if (!candidates.size) {
    return null;
  }

  const found = resolveSessionFileFromCandidates(command);
  if (found?.rolloutPath) {
    const includePreview = !(command.fullTranscript === true || command.full === true || command.preview === false);
    return readCodexSessionSummary(found.rolloutPath, {
      metaReadLimit: 80,
      preview: includePreview,
    }) || found;
  }

  return discoverCodexSessions({ codexHome: CODEX_HOME }).find((session) => (
    candidates.has(String(session.sessionId || ''))
    || candidates.has(String(session.nativeThreadId || ''))
  )) || null;
}

function watchKey(command = {}) {
  return [
    command.clientId,
    command.viewId,
    command.sessionId,
    command.nativeThreadId,
    command.conversationKey,
  ].map((value) => String(value || '').trim()).filter(Boolean).join('::');
}

async function handleSessionWatch(command = {}) {
  const requestId = command.requestId || makeId();
  const requestedSessionId = String(command.sessionId || command.nativeThreadId || '').trim();
  const found = resolveSessionFileFromCandidates(command);
  if (!found?.rolloutPath) {
    await postEvent({
      type: 'session.watch.updated',
      hostId: HOST_ID,
      requestId,
      sessionId: requestedSessionId,
      watched: false,
      error: `history session ${requestedSessionId || '(unknown)'} was not found under CODEX_HOME`,
      timestamp: nowIso(),
    }, { bestEffort: true });
    return;
  }

  const key = watchKey(command) || found.sessionId;
  watchedHistorySessions.set(key, {
    ...found,
    sessionId: found.sessionId,
    nativeThreadId: found.nativeThreadId || found.sessionId,
    clientId: command.clientId || null,
    viewId: command.viewId || null,
    requestedSessionId: requestedSessionId || null,
    conversationKey: command.conversationKey || null,
    expiresAt: Date.now() + SESSION_WATCH_TTL_MS,
  });
  refreshTailerWatchedSessions();
  await postEvent({
    type: 'session.watch.updated',
    hostId: HOST_ID,
    requestId,
    sessionId: found.sessionId,
    requestedSessionId: requestedSessionId || null,
    nativeThreadId: found.nativeThreadId || found.sessionId,
    watched: true,
    watchedSessionCount: watchedHistorySessions.size,
    timestamp: nowIso(),
  }, { bestEffort: true });
}

async function handleSessionUnwatch(command = {}) {
  const key = watchKey(command);
  let removed = 0;
  if (key && watchedHistorySessions.delete(key)) {
    removed += 1;
  }

  const identities = new Set(collectSessionIdentityCandidates(command));
  if (identities.size) {
    for (const [entryKey, entry] of Array.from(watchedHistorySessions.entries())) {
      if (
        identities.has(String(entry.sessionId || ''))
        || identities.has(String(entry.nativeThreadId || ''))
        || identities.has(String(entry.requestedSessionId || ''))
        || identities.has(String(entry.conversationKey || ''))
      ) {
        watchedHistorySessions.delete(entryKey);
        removed += 1;
      }
    }
  }

  refreshTailerWatchedSessions();
  await postEvent({
    type: 'session.watch.updated',
    hostId: HOST_ID,
    requestId: command.requestId || makeId(),
    sessionId: command.sessionId || command.nativeThreadId || null,
    watched: false,
    removed,
    watchedSessionCount: watchedHistorySessions.size,
    timestamp: nowIso(),
  }, { bestEffort: true });
}

function pruneExpiredWatchedSessions() {
  const now = Date.now();
  for (const [key, entry] of Array.from(watchedHistorySessions.entries())) {
    if (Number(entry.expiresAt || 0) <= now) {
      watchedHistorySessions.delete(key);
    }
  }
}

function uniqueLiveRunners() {
  return Array.from(new Set(Array.from(liveSessions.values()).filter(Boolean)));
}

function resolveLiveTailSessions() {
  const sessions = [];
  for (const runner of uniqueLiveRunners()) {
    const liveSessionId = typeof runner.currentSessionId === 'function'
      ? runner.currentSessionId()
      : runner.sessionId;
    const found = resolveSessionFileFromCandidates({
      sessionId: liveSessionId,
      nativeThreadId: runner.nativeThreadId,
      bridgeSessionId: runner.bridgeSessionId,
      runId: runner.runId,
      conversationKey: runner.conversationKey,
    });
    if (found?.rolloutPath) {
      sessions.push({
        ...found,
        live: true,
      });
    }
  }
  return sessions;
}

function refreshTailerWatchedSessions() {
  if (!codexTailer) {
    return { activeSessionCount: 0, watchedSessionCount: 0, liveSessionCount: 0 };
  }
  pruneExpiredWatchedSessions();
  const liveTailSessions = resolveLiveTailSessions();
  const active = new Map();
  for (const session of watchedHistorySessions.values()) {
    if (session?.rolloutPath) {
      active.set(session.rolloutPath, session);
    }
  }
  for (const session of liveTailSessions) {
    if (session?.rolloutPath) {
      active.set(session.rolloutPath, session);
    }
  }
  const activeSessionCount = codexTailer.setWatchedSessions(Array.from(active.values()));
  return {
    activeSessionCount,
    watchedSessionCount: watchedHistorySessions.size,
    liveSessionCount: liveTailSessions.length,
  };
}

async function maybeReportWatchPerformance(pollMs, result, scope) {
  if (pollMs < WATCH_PERFORMANCE_WARN_MS) {
    return;
  }
  const now = Date.now();
  if (now - lastWatchPerformanceReportAt < WATCH_PERFORMANCE_REPORT_COOLDOWN_MS) {
    return;
  }
  lastWatchPerformanceReportAt = now;
  const severity = pollMs >= WATCH_PERFORMANCE_SLOW_MS ? 'warning' : 'info';
  const activeSessionCount = Number(result?.activeSessionCount ?? scope?.activeSessionCount ?? 0) || 0;
  const message = severity === 'warning'
    ? `Realtime session sync took ${Math.round(pollMs / 1000)}s for ${activeSessionCount} active session(s). Close idle live conversations or switch away from sessions you no longer need.`
    : `Realtime session sync is slowing down (${Math.round(pollMs)}ms for ${activeSessionCount} active session(s)).`;
  await postEvent({
    type: 'watch.performance',
    hostId: HOST_ID,
    severity,
    message,
    pollMs,
    platform: process.platform,
    activeSessionCount,
    watchedSessionCount: scope?.watchedSessionCount || 0,
    liveSessionCount: scope?.liveSessionCount || 0,
    thresholdMs: severity === 'warning' ? WATCH_PERFORMANCE_SLOW_MS : WATCH_PERFORMANCE_WARN_MS,
    timestamp: nowIso(),
  }, { bestEffort: true });
}

function sessionDetailDiagnosticOptions(fullDiagnostics = false) {
  if (fullDiagnostics) {
    return { maxRows: Infinity };
  }

  const limit = SESSION_DETAIL_DIAGNOSTIC_LIMIT;
  const options = {
    headRows: 0,
    tailRows: limit,
  };
  if (Number.isFinite(limit) && limit > 0) {
    options.maxEntries = limit;
  }
  return options;
}

function normalizeSearchTerms(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
}

function textMatchesTerms(value, terms) {
  const haystack = String(value || '').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function makeSearchSnippet(text, terms, maxLength = 220) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) {
    return '';
  }
  const lower = source.toLowerCase();
  const indexes = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const firstIndex = indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, firstIndex - Math.floor(maxLength / 3));
  const end = Math.min(source.length, start + maxLength);
  return `${start > 0 ? '...' : ''}${source.slice(start, end).trim()}${end < source.length ? '...' : ''}`;
}

function sessionSearchHaystack(session) {
  return [
    session?.title,
    session?.cwd,
    session?.sessionId,
    session?.nativeThreadId,
    session?.conversationKey,
    session?.latestUserMessage,
    session?.latestAgentMessage,
  ].filter(Boolean).join('\n');
}

async function searchTranscriptFile(filePath, terms, maxMatches) {
  const matches = [];
  if (!filePath || !fs.existsSync(filePath) || !terms.length || maxMatches <= 0) {
    return matches;
  }

  let entryIndex = 0;
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      const trimmed = String(line || '').trim();
      if (!trimmed) {
        continue;
      }
      let row = null;
      try {
        row = JSON.parse(trimmed);
      } catch (_) {
        continue;
      }
      const entry = makeTranscriptEntry(row, { maxChars: Infinity });
      if (!entry || !['user', 'agent', 'assistant'].includes(String(entry.speaker || '').toLowerCase())) {
        continue;
      }
      const currentIndex = entryIndex;
      entryIndex += 1;
      if (!textMatchesTerms(entry.text || '', terms)) {
        continue;
      }
      matches.push({
        type: 'transcript',
        entryIndex: currentIndex,
        speaker: entry.speaker || 'system',
        timestamp: entry.timestamp || null,
        snippet: makeSearchSnippet(entry.text || '', terms),
      });
      if (matches.length >= maxMatches) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return matches;
}

async function searchDiscoveredSessions(command = {}) {
  const query = String(command.query || '').trim();
  const mode = ['keyword', 'path', 'title'].includes(command.mode) ? command.mode : 'keyword';
  const terms = normalizeSearchTerms(query);
  const maxSessions = Math.max(1, Math.min(200, Number(command.maxSessions || 80) || 80));
  const maxMatchesPerSession = Math.max(1, Math.min(20, Number(command.maxMatchesPerSession || 5) || 5));
  const sessions = discoverCodexSessions({ codexHome: CODEX_HOME });
  const results = [];

  for (const session of sessions) {
    const matches = [];
    if (mode === 'title') {
      if (textMatchesTerms(session.title || '', terms)) {
        matches.push({
          type: 'title',
          entryIndex: -1,
          speaker: 'title',
          timestamp: session.updatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(session.title || '', terms),
        });
      }
    } else if (mode === 'path') {
      if (textMatchesTerms(session.cwd || '', terms)) {
        matches.push({
          type: 'path',
          entryIndex: -1,
          speaker: 'path',
          timestamp: session.updatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(session.cwd || '', terms),
        });
      }
    } else {
      if (textMatchesTerms(sessionSearchHaystack(session), terms)) {
        matches.push({
          type: 'metadata',
          entryIndex: -1,
          speaker: 'session',
          timestamp: session.updatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(sessionSearchHaystack(session), terms),
        });
      }
      if (matches.length < maxMatchesPerSession) {
        matches.push(...await searchTranscriptFile(
          session.rolloutPath,
          terms,
          maxMatchesPerSession - matches.length
        ));
      }
    }
    if (!matches.length) {
      continue;
    }
    results.push({
      hostId: HOST_ID,
      sessionId: session.sessionId,
      conversationKey: session.conversationKey || session.sessionId,
      title: session.title || session.sessionId,
      cwd: session.cwd || null,
      lastUpdatedAt: session.updatedAt || session.createdAt || null,
      live: false,
      matchCount: matches.length,
      matches,
    });
    if (results.length >= maxSessions) {
      break;
    }
  }
  return {
    query,
    mode,
    results,
    scannedSessions: sessions.length,
    truncated: results.length >= maxSessions,
  };
}

async function handleSessionDetail(command) {
  const requestId = command.requestId || makeId();
  const requestedSessionId = String(command.sessionId || command.nativeThreadId || '').trim();
  try {
    const session = resolveDiscoveredSession(command);
    if (!session || !session.rolloutPath || !fs.existsSync(session.rolloutPath)) {
      throw new Error(`history session ${requestedSessionId || '(unknown)'} was not found under CODEX_HOME`);
    }

    const fullTranscript = command.fullTranscript === true || command.full === true;
    const fullDiagnostics = command.fullDiagnostics === true || command.diagnostics === 'full';
    const transcript = fullTranscript
      ? extractSessionTranscript(session.rolloutPath, { maxChars: Infinity })
      : (Array.isArray(session.transcriptPreview) ? session.transcriptPreview : []);
    const diagnostics = extractSessionDiagnostics(session.rolloutPath, sessionDetailDiagnosticOptions(fullDiagnostics));

    await postEvent({
      type: 'session.detailed',
      hostId: HOST_ID,
      sessionId: requestedSessionId || session.sessionId,
      nativeThreadId: session.nativeThreadId || session.sessionId,
      requestId,
      session: {
        sessionId: session.sessionId,
        nativeThreadId: session.nativeThreadId || session.sessionId,
        title: session.title || session.sessionId,
        cwd: session.cwd || null,
        source: session.source || 'rollout',
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        messageCount: session.messageCount || transcript.length || 0,
        latestUserMessage: session.latestUserMessage || null,
        latestAgentMessage: session.latestAgentMessage || null,
        conversationKey: session.conversationKey || session.sessionId,
      },
      transcript,
      diagnostics,
      fullTranscript,
      fullDiagnostics,
      timestamp: nowIso(),
    }, { retryOnTransient: true });
  } catch (error) {
    await postEvent({
      type: 'session.detailed',
      hostId: HOST_ID,
      sessionId: requestedSessionId,
      requestId,
      error: error.message || 'failed to load session detail',
      timestamp: nowIso(),
    }, { bestEffort: true });
  }
}

function parseWorkspaceRoots(value) {
  return String(value || '')
    .split(/[\r\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function browseRootKey(rootPath) {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pushBrowseRoot(roots, seen, name, rawPath) {
  let resolved = null;
  try {
    resolved = normalizeBrowsePath(rawPath);
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return;
    }
  } catch {
    return;
  }

  const key = browseRootKey(resolved);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  roots.push({
    name: name || rawPath || resolved,
    path: resolved,
  });
}

function listBrowseRoots() {
  const roots = [];
  const seen = new Set();
  for (const rawRoot of WORKSPACE_ROOTS) {
    pushBrowseRoot(roots, seen, rawRoot, rawRoot);
  }

  if (process.platform === 'win32') {
    for (const letter of WINDOWS_DRIVE_PROBE_LETTERS) {
      const code = letter.charCodeAt(0);
      if (code < 65 || code > 90) {
        continue;
      }
      const drive = `${String.fromCharCode(code)}:\\`;
      pushBrowseRoot(roots, seen, drive, drive);
    }
    return roots.length ? roots : [{ name: MANAGED_CWD, path: MANAGED_CWD }];
  }

  const home = os.homedir();
  if (home && fs.existsSync(home)) {
    pushBrowseRoot(roots, seen, '~', home);
  }
  pushBrowseRoot(roots, seen, '/', '/');
  return roots;
}

function normalizeBrowsePath(inputPath) {
  const raw = normalizeRemoteFilePath(inputPath);
  if (!raw) {
    return null;
  }
  if (raw === '~') {
    return os.homedir();
  }
  if (raw.startsWith('~/')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(MANAGED_CWD, raw);
}

function normalizeRemoteFilePath(value) {
  return String(value || '')
    .trim()
    .replace(/^[\\/]+([A-Za-z]:[\\/])/, '$1');
}

function listDirectoriesAt(targetPath) {
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry && entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(targetPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getParentDirectory(targetPath) {
  const parent = path.dirname(targetPath);
  return parent && parent !== targetPath ? parent : null;
}

function safeFileName(value, fallback = 'file') {
  const raw = String(value || '').trim();
  const leaf = raw.split(/[\\/]/).filter(Boolean).pop() || fallback;
  return leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+$/, fallback)
    .slice(0, 180) || fallback;
}

function pathInside(parent, candidate) {
  const root = path.resolve(parent);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueFilePath(directory, filename) {
  const parsed = path.parse(safeFileName(filename));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function mimeFromPath(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return {
    '.apk': 'application/vnd.android.package-archive',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.c': 'text/plain; charset=utf-8',
    '.cpp': 'text/plain; charset=utf-8',
    '.cs': 'text/plain; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.go': 'text/plain; charset=utf-8',
    '.h': 'text/plain; charset=utf-8',
    '.hpp': 'text/plain; charset=utf-8',
    '.gif': 'image/gif',
    '.htm': 'text/html; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ipynb': 'application/json; charset=utf-8',
    '.java': 'text/plain; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jsonl': 'application/x-ndjson; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.pps': 'application/vnd.ms-powerpoint',
    '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ps1': 'text/plain; charset=utf-8',
    '.py': 'text/x-python; charset=utf-8',
    '.r': 'text/plain; charset=utf-8',
    '.rs': 'text/plain; charset=utf-8',
    '.sh': 'text/x-shellscript; charset=utf-8',
    '.sql': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.toml': 'application/toml; charset=utf-8',
    '.ts': 'application/typescript; charset=utf-8',
    '.tsx': 'application/typescript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.xml': 'application/xml; charset=utf-8',
    '.yaml': 'application/yaml; charset=utf-8',
    '.yml': 'application/yaml; charset=utf-8',
    '.zip': 'application/zip',
  }[ext] || fallback;
}

function isImageMime(mime, filePath) {
  return /^image\//i.test(String(mime || '')) || /\.(png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i.test(String(filePath || ''));
}

function getRunnerForSession(sessionId) {
  return liveSessions.get(sessionId) || null;
}

function getRunnerIdentityValues(runner) {
  const values = new Set();
  const add = (value) => {
    if (value) {
      values.add(String(value));
    }
  };
  add(runner?.sessionId);
  add(runner?.bridgeSessionId);
  add(runner?.nativeThreadId);
  add(runner?.threadId);
  add(runner?.originSessionId);
  add(runner?.sourceSessionId);
  add(runner?.conversationKey);
  add(runner?.runId);
  if (runner && typeof runner.currentSessionId === 'function') {
    add(runner.currentSessionId());
  }
  return values;
}

function getCommandSessionCandidates(command = {}) {
  return [
    command.sessionId,
    command.bridgeSessionId,
    command.nativeThreadId,
    command.originSessionId,
    command.sourceSessionId,
    command.conversationKey,
    command.runId,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function getRunnerForCommand(command = {}) {
  for (const candidate of getCommandSessionCandidates(command)) {
    const direct = liveSessions.get(candidate);
    if (direct) {
      return direct;
    }
  }

  const candidates = new Set(getCommandSessionCandidates(command));
  const seenRunners = new Set();
  for (const runner of liveSessions.values()) {
    if (!runner || seenRunners.has(runner)) {
      continue;
    }
    seenRunners.add(runner);
    const identities = getRunnerIdentityValues(runner);
    for (const candidate of candidates) {
      if (identities.has(candidate)) {
        return runner;
      }
    }
  }
  return null;
}

function resolveCommandCwd(command = {}) {
  const runner = getRunnerForCommand(command);
  const cwd = String(command.cwd || command.targetDirectory || runner?.cwd || MANAGED_CWD || '').trim();
  return resolveManagedCwd(cwd || MANAGED_CWD);
}

function resolveRemoteFilePath(inputPath, baseCwd) {
  const raw = normalizeRemoteFilePath(inputPath);
  if (!raw) {
    throw new Error('file path is required');
  }
  if (raw === '~') {
    return os.homedir();
  }
  if (raw.startsWith('~/')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseCwd || MANAGED_CWD, raw);
}

async function handleFileUpload(command) {
  const requestId = command.requestId || makeId();
  const sessionId = command.sessionId || null;

  try {
    const baseCwd = resolveCommandCwd(command);
    if (!fs.existsSync(baseCwd) || !fs.statSync(baseCwd).isDirectory()) {
      throw new Error(`upload target directory does not exist: ${baseCwd}`);
    }

    const sessionSegment = sessionId ? safeFileName(sessionId, 'session') : 'sessionless';
    const uploadRoot = path.join(baseCwd, '.codex-remote-files', 'uploads', sessionSegment, requestId);
    fs.mkdirSync(uploadRoot, { recursive: true });

    const files = [];
    for (const rawFile of Array.isArray(command.files) ? command.files.slice(0, 8) : []) {
      const name = safeFileName(rawFile?.name || 'upload');
      const dataBase64 = String(rawFile?.dataBase64 || '').replace(/^data:[^,]+,/, '').trim();
      if (!dataBase64) {
        continue;
      }

      const data = Buffer.from(dataBase64, 'base64');
      if (data.length > MAX_FILE_TRANSFER_BYTES) {
        throw new Error(`${name} is too large; limit is ${MAX_FILE_TRANSFER_BYTES} bytes`);
      }

      const targetPath = uniqueFilePath(uploadRoot, name);
      if (!pathInside(uploadRoot, targetPath)) {
        throw new Error(`refusing to write outside upload directory: ${name}`);
      }

      fs.writeFileSync(targetPath, data);
      const mime = String(rawFile?.mime || rawFile?.type || mimeFromPath(targetPath)).trim() || mimeFromPath(targetPath);
      files.push({
        fileId: rawFile?.fileId || makeId(),
        name: path.basename(targetPath),
        originalName: name,
        path: targetPath,
        size: data.length,
        mime,
        isImage: isImageMime(mime, targetPath),
        uploadedAt: nowIso(),
      });
    }

    if (!files.length) {
      throw new Error('no uploadable files were provided');
    }

    await postEvent({
      type: 'file.uploaded',
      hostId: HOST_ID,
      sessionId,
      requestId,
      targetDirectory: uploadRoot,
      files,
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'file.error',
      hostId: HOST_ID,
      sessionId,
      requestId,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleChunkedFileUploadBegin(command) {
  const requestId = command.requestId || makeId();
  const uploadId = String(command.uploadId || requestId || makeId()).trim();
  const sessionId = command.sessionId || null;

  try {
    const expectedSize = Number(command.size || 0) || 0;
    if (expectedSize < 0 || expectedSize > MAX_CHUNKED_FILE_TRANSFER_BYTES) {
      throw new Error(`file is too large to upload (${expectedSize} bytes); limit is ${MAX_CHUNKED_FILE_TRANSFER_BYTES} bytes`);
    }

    const baseCwd = resolveCommandCwd(command);
    if (!fs.existsSync(baseCwd) || !fs.statSync(baseCwd).isDirectory()) {
      throw new Error(`upload target directory does not exist: ${baseCwd}`);
    }

    const sessionSegment = sessionId ? safeFileName(sessionId, 'session') : 'sessionless';
    const uploadRoot = path.join(baseCwd, '.codex-remote-files', 'uploads', sessionSegment, uploadId);
    fs.mkdirSync(uploadRoot, { recursive: true });

    const originalName = safeFileName(command.name || 'upload');
    const targetPath = uniqueFilePath(uploadRoot, originalName);
    const tempPath = `${targetPath}.part`;
    if (!pathInside(uploadRoot, targetPath) || !pathInside(uploadRoot, tempPath)) {
      throw new Error(`refusing to write outside upload directory: ${originalName}`);
    }

    fs.writeFileSync(tempPath, Buffer.alloc(0), { flag: 'wx' });
    activeFileUploads.set(uploadId, {
      uploadId,
      fileId: String(command.fileId || uploadId),
      sessionId,
      uploadRoot,
      targetPath,
      tempPath,
      originalName,
      mime: String(command.mime || command.type || mimeFromPath(targetPath)).trim() || mimeFromPath(targetPath),
      expectedSize,
      receivedBytes: 0,
    });

    await postEvent({
      type: 'file.upload.ready',
      hostId: HOST_ID,
      sessionId,
      requestId,
      uploadId,
      fileId: String(command.fileId || uploadId),
      targetDirectory: uploadRoot,
      name: path.basename(targetPath),
      path: targetPath,
      size: expectedSize,
      timestamp: nowIso(),
    });
  } catch (error) {
    activeFileUploads.delete(uploadId);
    await postEvent({
      type: 'file.error',
      hostId: HOST_ID,
      sessionId,
      requestId,
      uploadId,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleChunkedFileUploadChunk(command) {
  const requestId = command.requestId || makeId();
  const uploadId = String(command.uploadId || '').trim();
  const upload = activeFileUploads.get(uploadId);
  const sessionId = command.sessionId || upload?.sessionId || null;

  try {
    if (!upload) {
      throw new Error(`upload ${uploadId || '(missing)'} is not active`);
    }

    const offset = Number(command.offset || 0) || 0;
    if (offset !== upload.receivedBytes) {
      throw new Error(`upload chunk offset mismatch: expected ${upload.receivedBytes}, got ${offset}`);
    }

    const dataBase64 = String(command.dataBase64 || '').replace(/^data:[^,]+,/, '').trim();
    const data = dataBase64 ? Buffer.from(dataBase64, 'base64') : Buffer.alloc(0);
    if (data.length > MAX_FILE_CHUNK_BYTES) {
      throw new Error(`upload chunk is too large (${data.length} bytes); limit is ${MAX_FILE_CHUNK_BYTES} bytes`);
    }
    if (upload.receivedBytes + data.length > upload.expectedSize) {
      throw new Error('upload chunk exceeds declared file size');
    }

    fs.appendFileSync(upload.tempPath, data);
    upload.receivedBytes += data.length;
    activeFileUploads.set(uploadId, upload);

    await postEvent({
      type: 'file.upload.chunk',
      hostId: HOST_ID,
      sessionId,
      requestId,
      uploadId,
      offset,
      length: data.length,
      receivedBytes: upload.receivedBytes,
      size: upload.expectedSize,
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'file.error',
      hostId: HOST_ID,
      sessionId,
      requestId,
      uploadId,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleChunkedFileUploadComplete(command) {
  const requestId = command.requestId || makeId();
  const uploadId = String(command.uploadId || '').trim();
  const upload = activeFileUploads.get(uploadId);
  const sessionId = command.sessionId || upload?.sessionId || null;

  try {
    if (!upload) {
      throw new Error(`upload ${uploadId || '(missing)'} is not active`);
    }
    if (upload.receivedBytes !== upload.expectedSize) {
      throw new Error(`upload is incomplete: received ${upload.receivedBytes} of ${upload.expectedSize} bytes`);
    }

    fs.renameSync(upload.tempPath, upload.targetPath);
    activeFileUploads.delete(uploadId);

    await postEvent({
      type: 'file.uploaded',
      hostId: HOST_ID,
      sessionId,
      requestId,
      uploadId,
      targetDirectory: upload.uploadRoot,
      files: [{
        fileId: upload.fileId,
        name: path.basename(upload.targetPath),
        originalName: upload.originalName,
        path: upload.targetPath,
        size: upload.receivedBytes,
        mime: upload.mime,
        isImage: isImageMime(upload.mime, upload.targetPath),
        uploadedAt: nowIso(),
      }],
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'file.error',
      hostId: HOST_ID,
      sessionId,
      requestId,
      uploadId,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleChunkedFileUploadAbort(command) {
  const requestId = command.requestId || makeId();
  const uploadId = String(command.uploadId || '').trim();
  const upload = activeFileUploads.get(uploadId);
  if (upload?.tempPath && fs.existsSync(upload.tempPath)) {
    try {
      fs.unlinkSync(upload.tempPath);
    } catch (_) {
      // Best effort cleanup; the stale .part file can be removed manually.
    }
  }
  activeFileUploads.delete(uploadId);
  await postEvent({
    type: 'file.upload.aborted',
    hostId: HOST_ID,
    sessionId: command.sessionId || upload?.sessionId || null,
    requestId,
    uploadId,
    timestamp: nowIso(),
  });
}

async function handleFileDownload(command) {
  const requestId = command.requestId || makeId();
  const sessionId = command.sessionId || null;

  try {
    const baseCwd = resolveCommandCwd(command);
    const targetPath = resolveRemoteFilePath(command.path, baseCwd);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`file does not exist: ${targetPath}`);
    }

    const stats = fs.statSync(targetPath);
    if (!stats.isFile()) {
      throw new Error(`path is not a regular file: ${targetPath}`);
    }
    if (stats.size > MAX_FILE_TRANSFER_BYTES) {
      throw new Error(`file is too large to transfer (${stats.size} bytes); limit is ${MAX_FILE_TRANSFER_BYTES} bytes`);
    }

    const mime = mimeFromPath(targetPath);
    await postEvent({
      type: 'file.downloaded',
      hostId: HOST_ID,
      sessionId,
      requestId,
      name: path.basename(targetPath),
      path: targetPath,
      size: stats.size,
      mime,
      isImage: isImageMime(mime, targetPath),
      dataBase64: fs.readFileSync(targetPath).toString('base64'),
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'file.error',
      hostId: HOST_ID,
      sessionId,
      requestId,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleFileDownloadInfo(command) {
  const requestId = command.requestId || makeId();
  const sessionId = command.sessionId || null;

  try {
    const baseCwd = resolveCommandCwd(command);
    const targetPath = resolveRemoteFilePath(command.path, baseCwd);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`file does not exist: ${targetPath}`);
    }

    const stats = fs.statSync(targetPath);
    if (!stats.isFile()) {
      throw new Error(`path is not a regular file: ${targetPath}`);
    }
    if (stats.size > MAX_CHUNKED_FILE_TRANSFER_BYTES) {
      throw new Error(`file is too large to transfer (${stats.size} bytes); limit is ${MAX_CHUNKED_FILE_TRANSFER_BYTES} bytes`);
    }

    const mime = mimeFromPath(targetPath);
    await postEvent({
      type: 'file.download.info',
      hostId: HOST_ID,
      sessionId,
      requestId,
      name: path.basename(targetPath),
      path: targetPath,
      size: stats.size,
      mime,
      isImage: isImageMime(mime, targetPath),
      mtimeMs: stats.mtimeMs,
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'file.error',
      hostId: HOST_ID,
      sessionId,
      requestId,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleFileDownloadChunk(command) {
  const requestId = command.requestId || makeId();
  const sessionId = command.sessionId || null;

  try {
    const baseCwd = resolveCommandCwd(command);
    const targetPath = resolveRemoteFilePath(command.path, baseCwd);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`file does not exist: ${targetPath}`);
    }

    const stats = fs.statSync(targetPath);
    if (!stats.isFile()) {
      throw new Error(`path is not a regular file: ${targetPath}`);
    }

    const offset = Number(command.offset || 0) || 0;
    const requestedLength = Number(command.length || 0) || 0;
    if (offset < 0 || offset > stats.size) {
      throw new Error(`download chunk offset is outside the file: ${offset}`);
    }
    const length = Math.min(requestedLength, MAX_FILE_CHUNK_BYTES, Math.max(0, stats.size - offset));
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(targetPath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }

    await postEvent({
      type: 'file.download.chunk',
      hostId: HOST_ID,
      sessionId,
      requestId,
      path: targetPath,
      offset,
      length: bytesRead,
      size: stats.size,
      dataBase64: buffer.subarray(0, bytesRead).toString('base64'),
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'file.error',
      hostId: HOST_ID,
      sessionId,
      requestId,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleDirectoryList(command) {
  const roots = listBrowseRoots();
  const requestId = command.requestId || makeId();

  try {
    let currentPath = normalizeBrowsePath(command.path);
    if (!currentPath) {
      currentPath = roots[0]?.path || MANAGED_CWD;
    }

    if (!fs.existsSync(currentPath)) {
      throw new Error(`workspace path does not exist: ${currentPath}`);
    }

    const stats = fs.statSync(currentPath);
    if (!stats.isDirectory()) {
      throw new Error(`workspace path is not a directory: ${currentPath}`);
    }

    await postEvent({
      type: 'directory.listed',
      hostId: HOST_ID,
      requestId,
      currentPath,
      parentPath: getParentDirectory(currentPath),
      roots,
      directories: listDirectoriesAt(currentPath).slice(0, 200),
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'directory.error',
      hostId: HOST_ID,
      requestId,
      path: command.path || null,
      message: error.message,
      timestamp: nowIso(),
    });
  }
}

function buildResumeBootstrap(command) {
  const transcript = Array.isArray(command.resumeTranscript) ? command.resumeTranscript : [];
  const lines = transcript
    .filter((entry) => entry && entry.text)
    .map((entry) => {
      const speaker = entry.speaker === 'user' ? 'user' : entry.speaker === 'agent' ? 'assistant' : 'system';
      const text = String(entry.text || '').replace(/\r\n?/g, '\n').trim();
      return { speaker, text };
    })
    .filter((entry) => entry.text);

  return {
    launchMode: command.launchMode || 'fresh',
    sourceSessionId: command.sourceSessionId || null,
    originSessionId: command.originSessionId || null,
    conversationKey: command.conversationKey || null,
    nativeThreadId: command.nativeThreadId || null,
    historyPreview: lines,
    summary: command.launchMode === 'resume'
      ? 'Resuming from history transcript'
      : command.launchMode === 'fork'
        ? 'Forking from an existing conversation'
        : 'Starting a fresh managed session',
  };
}

function resolveManagedCwd(cwd) {
  const target = normalizeRemoteFilePath(cwd);
  if (!target) {
    return MANAGED_CWD;
  }

  return path.isAbsolute(target) ? target : path.resolve(MANAGED_CWD, target);
}

async function failManagedSession(sessionId, cwd, message, state = 'failed', runId = null) {
  await postEvent({
    type: 'session.error',
    hostId: HOST_ID,
    sessionId,
    runId,
    message,
    timestamp: nowIso(),
  });

  await postEvent({
    type: 'session.state_changed',
    hostId: HOST_ID,
    sessionId,
    runId,
    state,
    live: false,
    timestamp: nowIso(),
  });
}

async function startManagedSession(command) {
  const bridgeSessionId = command.sessionId || makeId();
  const runId = command.runId || makeId();
  const createdAt = command.createdAt || nowIso();
  const cwd = resolveManagedCwd(command.cwd || MANAGED_CWD);
  const runtime = resolveManagedRuntime(command, {
    defaultRuntime: MANAGED_RUNTIME,
    defaultCommand: MANAGED_COMMAND,
    defaultArgs: MANAGED_ARGS,
  });
  const bootstrap = buildResumeBootstrap(command);
  const title = command.label || command.cwd || bridgeSessionId;
  const apiConfig = normalizeApiConfig(command.apiConfig);
  let announcedSessionId = bridgeSessionId;

  if (!fs.existsSync(cwd)) {
    await failManagedSession(bridgeSessionId, cwd, `workspace path does not exist: ${cwd}`, 'failed:missing-workspace', runId);
    return bridgeSessionId;
  }

  let cwdStats = null;
  try {
    cwdStats = fs.statSync(cwd);
  } catch (error) {
    await failManagedSession(bridgeSessionId, cwd, `failed to inspect workspace path: ${error.message}`, 'failed:workspace-stat-error', runId);
    return bridgeSessionId;
  }

  if (!cwdStats.isDirectory()) {
    await failManagedSession(bridgeSessionId, cwd, `workspace path is not a directory: ${cwd}`, 'failed:not-a-directory', runId);
    return bridgeSessionId;
  }

  try {
    const runner = await startManagedRuntimeSession({
      runtime,
      hostId: HOST_ID,
      sessionId: bridgeSessionId,
      bridgeSessionId,
      runId,
      title,
      cwd,
      launchMode: command.launchMode || null,
      nativeThreadId: command.nativeThreadId || null,
      codexHome: CODEX_HOME,
      apiConfig,
      bootstrap,
      originSessionId: command.originSessionId || null,
      sourceSessionId: command.sourceSessionId || null,
      conversationKey: command.conversationKey || command.originSessionId || bridgeSessionId,
      postEvent,
      onTerminated: () => {
        if (liveSessions.get(bridgeSessionId) === runner) {
          liveSessions.delete(bridgeSessionId);
        }
        if (liveSessions.get(announcedSessionId) === runner) {
          liveSessions.delete(announcedSessionId);
        }
        if (liveSessions.get(runId) === runner) {
          liveSessions.delete(runId);
        }
      },
    });
    runner.createdAt = runner.createdAt || createdAt;
    announcedSessionId = runner.sessionId || bridgeSessionId;
    liveSessions.set(bridgeSessionId, runner);
    liveSessions.set(announcedSessionId, runner);
    liveSessions.set(runId, runner);

    await postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: announcedSessionId,
      bridgeSessionId: announcedSessionId === bridgeSessionId ? null : bridgeSessionId,
      runId,
      nativeThreadId: runner?.nativeThreadId || announcedSessionId,
      title,
      cwd,
      source: 'managed',
      createdAt: runner?.createdAt || createdAt,
      originSessionId: command.originSessionId || null,
      sourceSessionId: command.sourceSessionId || null,
      conversationKey: command.conversationKey || command.originSessionId || bridgeSessionId,
      launchMode: command.launchMode || null,
      runtime: runner.runtime || {
        kind: 'child_process',
        adapterId: runtime.kind,
        runtimeId: runtime.runtimeId,
        command: runtime.command,
        args: runtime.args,
        cwd,
      },
    });
  } catch (error) {
    await failManagedSession(bridgeSessionId, cwd, `failed to spawn managed session: ${error.message}`, 'failed:spawn-error', runId);
    return bridgeSessionId;
  }

  return announcedSessionId;
}

async function handleCommand(command) {
  if (!command || !command.type) {
    return;
  }

  if (command.type === 'session.start') {
    await startManagedSession(command);
    return;
  }

  if (command.type === 'host.import') {
    sendDiscovery().catch((error) => {
      logAgentError('[agent] discovery refresh failed:', error.message);
    });
    return;
  }

  if (command.type === 'host.probe') {
    await postEvent({
      type: 'host.probe',
      hostId: HOST_ID,
      requestId: command.requestId || makeId(),
      label: HOST_LABEL,
      platform: process.platform,
      capabilities: getCapabilities(),
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'host.api_test') {
    const result = await testApiProfile(command.apiConfig, {
      timeoutMs: command.timeoutMs,
    });
    await postEvent({
      type: 'host.api_tested',
      hostId: HOST_ID,
      requestId: command.requestId || makeId(),
      result,
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'directory.list') {
    await handleDirectoryList(command);
    return;
  }

  if (command.type === 'host.file_upload') {
    await handleFileUpload(command);
    return;
  }

  if (command.type === 'host.file_upload_begin') {
    await handleChunkedFileUploadBegin(command);
    return;
  }

  if (command.type === 'host.file_upload_chunk') {
    await handleChunkedFileUploadChunk(command);
    return;
  }

  if (command.type === 'host.file_upload_complete') {
    await handleChunkedFileUploadComplete(command);
    return;
  }

  if (command.type === 'host.file_upload_abort') {
    await handleChunkedFileUploadAbort(command);
    return;
  }

  if (command.type === 'host.file_download') {
    await handleFileDownload(command);
    return;
  }

  if (command.type === 'host.file_download_info') {
    await handleFileDownloadInfo(command);
    return;
  }

  if (command.type === 'host.file_download_chunk') {
    await handleFileDownloadChunk(command);
    return;
  }

  if (command.type === 'session.watch') {
    await handleSessionWatch(command);
    return;
  }

  if (command.type === 'session.unwatch') {
    await handleSessionUnwatch(command);
    return;
  }

  if (command.type === 'session.detail') {
    await handleSessionDetail(command);
    return;
  }

  if (command.type === 'session.search') {
    try {
      const result = await searchDiscoveredSessions(command);
      await postEvent({
        type: 'session.searched',
        hostId: HOST_ID,
        requestId: command.requestId || makeId(),
        query: result.query,
        mode: result.mode,
        results: result.results,
        scannedSessions: result.scannedSessions,
        truncated: result.truncated,
        timestamp: nowIso(),
      }, { retryOnTransient: true });
    } catch (error) {
      await postEvent({
        type: 'session.searched',
        hostId: HOST_ID,
        requestId: command.requestId || makeId(),
        query: command.query || '',
        mode: command.mode || 'keyword',
        error: error.message || 'session search failed',
        timestamp: nowIso(),
      }, { bestEffort: true });
    }
    return;
  }

  const runner = getRunnerForCommand(command);
  if (!runner) {
    if (command.type === 'session.model_list' && command.requestId) {
      await postEvent({
        type: 'session.model_listed',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId,
        error: 'session is not live on this host-agent; resume or restart the session before listing models',
        timestamp: nowIso(),
      });
      return;
    }

    if (command.type === 'session.skills_list' && command.requestId) {
      await postEvent({
        type: 'session.skills_listed',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId,
        error: 'session is not live on this host-agent; resume or restart the session before listing skills',
        timestamp: nowIso(),
      });
      return;
    }

    if (command.type === 'session.goal' && command.requestId) {
      await postEvent({
        type: 'session.goal_result',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId,
        error: 'session is not live on this host-agent; resume or restart the session before using native Goal controls',
        timestamp: nowIso(),
      });
      return;
    }

    if (command.type === 'session.stop') {
      await postEvent({
        type: 'session.state_changed',
        hostId: HOST_ID,
        sessionId: command.requestedSessionId || command.sessionId,
        runId: command.runId || null,
        state: 'history-only',
        live: false,
        timestamp: nowIso(),
      });
      return;
    }

    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: `no live session for command ${command.type}`,
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.input') {
    try {
      await postEvent({
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        runId: runner.runId || command.runId || null,
        patch: {
          busy: true,
          phase: 'submitting-turn',
          currentTurnStatus: 'submitting',
          queuedCommandId: command.id || null,
          pendingInputSummary: String(command.text || '').slice(0, 240),
          runId: runner.runId || command.runId || null,
        },
        timestamp: nowIso(),
      }, { bestEffort: true });
      await runner.sendInput(String(command.text || ''), {
        inputItems: Array.isArray(command.inputItems) ? command.inputItems : [],
        attachments: Array.isArray(command.attachments) ? command.attachments : [],
        mode: command.mode || null,
        model: command.model || null,
        effort: command.effort || null,
        summary: command.summary || null,
        approvalPolicy: command.approvalPolicy || null,
        approvalsReviewer: command.approvalsReviewer || null,
        sandboxMode: command.sandboxMode || null,
        planFallback: command.planFallback || null,
        serviceTier: command.serviceTier || null,
        personality: command.personality || null,
        apiConfig: normalizeApiConfig(command.apiConfig),
      });
    } catch (error) {
      await postEvent({
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        runId: runner.runId || command.runId || null,
        patch: {
          activeTurnId: null,
          busy: false,
          phase: 'error',
          currentTurnStatus: 'failed',
          pendingInputSummary: null,
          lastCodexError: error.message || String(error),
          runId: runner.runId || command.runId || null,
        },
        timestamp: nowIso(),
      }, { bestEffort: true });
      await postEvent({
        type: 'session.error',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        message: `Unable to start Codex turn: ${error.message}`,
        timestamp: nowIso(),
      });
    }
    return;
  }

  if (command.type === 'session.model_list') {
    if (typeof runner.listModels === 'function') {
      try {
        const result = await runner.listModels({
          cursor: command.cursor || null,
          includeHidden: command.includeHidden === true,
          limit: command.limit || 80,
        });
        await postEvent({
          type: 'session.model_listed',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          requestId: command.requestId || makeId(),
          models: Array.isArray(result?.data) ? result.data : [],
          nextCursor: result?.nextCursor || null,
          timestamp: nowIso(),
        });
      } catch (error) {
        await postEvent({
          type: 'session.model_listed',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          requestId: command.requestId || makeId(),
          error: error.message,
          timestamp: nowIso(),
        });
        await postEvent({
          type: 'session.error',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          message: `Unable to list Codex models: ${error.message}`,
          timestamp: nowIso(),
        });
      }
      return;
    }

    await postEvent({
      type: 'session.model_listed',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      requestId: command.requestId || makeId(),
      error: 'This runner does not support model listing.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.skills_list') {
    if (typeof runner.listSkills === 'function') {
      try {
        const result = await runner.listSkills({
          cwd: command.cwd || null,
          forceReload: command.forceReload === true,
        });
        await postEvent({
          type: 'session.skills_listed',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          requestId: command.requestId || makeId(),
          data: Array.isArray(result?.data) ? result.data : [],
          timestamp: nowIso(),
        });
      } catch (error) {
        await postEvent({
          type: 'session.skills_listed',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          requestId: command.requestId || makeId(),
          error: error.message,
          timestamp: nowIso(),
        });
        await postEvent({
          type: 'session.error',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          message: `Unable to list Codex skills: ${error.message}`,
          timestamp: nowIso(),
        });
      }
      return;
    }

    await postEvent({
      type: 'session.skills_listed',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      requestId: command.requestId || makeId(),
      error: 'This runner does not support skill listing.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.interrupt') {
    if (typeof runner.interruptTurn === 'function') {
      await runner.interruptTurn();
      return;
    }

    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: 'This runner does not support turn interruption.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.steer') {
    if (typeof runner.steerTurn === 'function') {
      await runner.steerTurn(String(command.text || ''));
      return;
    }

    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: 'This runner does not support turn steering.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.compact') {
    if (typeof runner.compactThread === 'function') {
      try {
        await runner.compactThread({
          apiConfig: normalizeApiConfig(command.apiConfig),
        });
      } catch (error) {
        await postEvent({
          type: 'session.error',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          message: `Unable to compact Codex thread: ${error.message}`,
          timestamp: nowIso(),
        });
      }
      return;
    }

    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: 'This runner does not support thread compaction.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.goal') {
    try {
      let result = null;
      const action = String(command.action || '').trim() || 'get';
      if (action === 'get') {
        if (typeof runner.getGoal !== 'function') {
          throw new Error('This runner does not support native Codex goals.');
        }
        result = await runner.getGoal();
      } else if (action === 'set') {
        if (typeof runner.setGoal !== 'function') {
          throw new Error('This runner does not support native Codex goals.');
        }
        result = await runner.setGoal({
          objective: command.objective,
          status: command.status,
          tokenBudget: command.tokenBudget,
        });
      } else if (action === 'clear') {
        if (typeof runner.clearGoal !== 'function') {
          throw new Error('This runner does not support native Codex goals.');
        }
        const clearResult = await runner.clearGoal();
        await postEvent({
          type: 'session.goal_result',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          requestId: command.requestId || makeId(),
          goal: null,
          result: clearResult || { cleared: true },
          timestamp: nowIso(),
        });
        return;
      } else {
        throw new Error('Unknown goal action.');
      }

      await postEvent({
        type: 'session.goal_result',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId || makeId(),
        goal: result || null,
        result,
        timestamp: nowIso(),
      });
    } catch (error) {
      await postEvent({
        type: 'session.goal_result',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId || makeId(),
        error: error.message,
        timestamp: nowIso(),
      });
      await postEvent({
        type: 'session.error',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        message: `Unable to run native Codex goal action: ${error.message}`,
        timestamp: nowIso(),
      });
    }
    return;
  }

  if (command.type === 'session.review_start') {
    if (typeof runner.startReview === 'function') {
      try {
        await runner.startReview({
          target: command.target || { type: 'uncommittedChanges' },
          delivery: command.delivery || 'inline',
        });
      } catch (error) {
        await postEvent({
          type: 'session.error',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          message: `Unable to start Codex review: ${error.message}`,
          timestamp: nowIso(),
        });
      }
      return;
    }

    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: 'This runner does not support Codex reviews.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.shell_command') {
    if (typeof runner.runShellCommand === 'function') {
      await runner.runShellCommand(String(command.command || ''));
      return;
    }

    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: 'This runner does not support thread shell commands.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.request.respond') {
    if (typeof runner.respondToRequest === 'function') {
      await runner.respondToRequest(command.requestId, command.response || null);
      return;
    }

    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: 'This runner does not support request responses.',
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'session.stop') {
    await runner.stop();
    await postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId: command.requestedSessionId || command.sessionId,
      runId: runner.runId || command.runId || null,
      state: 'history-only',
      live: false,
      timestamp: nowIso(),
    });
    return;
  }
}

async function postCommandFailure(command, error) {
  const message = String(error?.message || error || `failed to handle ${command?.type || 'command'}`);
  logAgentError(`[agent] command ${command?.id || '(unknown)'} ${command?.type || '(unknown)'} failed:`, message);

  if (command?.type === 'session.model_list' && command.requestId) {
    await postEvent({
      type: 'session.model_listed',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      requestId: command.requestId,
      error: message,
      timestamp: nowIso(),
    }, { bestEffort: true });
    return;
  }

  if (command?.type === 'session.skills_list' && command.requestId) {
    await postEvent({
      type: 'session.skills_listed',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      requestId: command.requestId,
      error: message,
      timestamp: nowIso(),
    }, { bestEffort: true });
    return;
  }

  if (command?.sessionId) {
    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: `Unable to handle ${command.type || 'command'}: ${message}`,
      timestamp: nowIso(),
    }, { bestEffort: true });
  }
}

async function processPolledCommand(command) {
  const commandId = Number(command?.id || 0);
  try {
    await handleCommand(command);
  } catch (error) {
    await postCommandFailure(command, error);
  } finally {
    lastCommandId = Math.max(lastCommandId, commandId);
  }
}

async function pollCommandsLoop() {
  while (true) {
    try {
      const result = await fetchJson(`${RELAY_URL}/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${lastCommandId}&ack=${lastCommandId}`, {
        retryOnTransient: true,
      });
      const commands = Array.isArray(result.body && result.body.commands) ? result.body.commands : [];
      for (const command of commands) {
        await processPolledCommand(command);
      }
      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      logAgentTransient('[agent] command poll failed:', error);
      await sleep(Math.max(POLL_INTERVAL_MS, 3000));
    }
  }
}

async function discoveryLoop() {
  while (true) {
    try {
      await sendDiscovery();
      await sleep(DISCOVERY_INTERVAL_MS);
    } catch (error) {
      logAgentTransient('[agent] discovery failed:', error);
      await sleep(Math.max(DISCOVERY_INTERVAL_MS, 3000));
    }
  }
}

async function codexTailLoop() {
  if (!codexTailer) {
    return;
  }

  while (true) {
    try {
      const scope = refreshTailerWatchedSessions();
      const startedAt = Date.now();
      const result = await codexTailer.poll();
      const pollMs = Date.now() - startedAt;
      await maybeReportWatchPerformance(pollMs, result, scope);
      if (result.newSessionCount > 0) {
        await sendDiscovery();
      }
      await sleep(CODEX_TAIL_INTERVAL_MS);
    } catch (error) {
      logAgentTransient('[agent] codex tail failed:', error);
      await sleep(Math.max(CODEX_TAIL_INTERVAL_MS, 3000));
    }
  }
}

async function heartbeatLoop() {
  while (true) {
    try {
      await heartbeat();
      await sleep(5000);
    } catch (error) {
      logAgentTransient('[agent] heartbeat failed:', error);
      await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStartupDiscovery() {
  await retryStartupStep('send initial discovery', sendDiscovery);
}

async function runStartupTailPrime() {
  if (!codexTailer) {
    return;
  }
  try {
    const result = codexTailer.prime();
    console.log(`[agent] codex tail primed ${result.sessionCount} session(s)`);
  } catch (error) {
    logAgentError('[agent] codex tail prime failed:', error.message);
  }
}

async function runStartupAutoStart() {
  if (!AUTO_START_SESSION) {
    return;
  }
  try {
    await startManagedSession({
      command: MANAGED_COMMAND,
      args: MANAGED_ARGS,
      cwd: MANAGED_CWD,
      label: MANAGED_COMMAND === 'demo' ? `${HOST_LABEL} demo` : `${HOST_LABEL} live`,
    });
  } catch (error) {
    console.error('[agent] auto-start session failed:', error.message);
  }
}

async function main() {
  console.log(`[agent] host ${HOST_ID} connecting to ${RELAY_URL}`);
  console.log(`[agent] codex home ${CODEX_HOME}`);

  await retryStartupStep('register host', registerHost);

  const loops = [pollCommandsLoop(), heartbeatLoop(), discoveryLoop(), codexTailLoop()];
  void runStartupDiscovery();
  void runStartupTailPrime();
  void runStartupAutoStart();

  await Promise.all(loops);
}

async function retryStartupStep(label, task, attempts = 8) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      lastError = error;
      const delay = Math.min(5000, 300 * attempt * attempt);
      logAgentError(`[agent] ${label} failed (${attempt}/${attempts}): ${error.message}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

main().catch((error) => {
  console.error('[agent] fatal:', error);
  process.exit(1);
});
