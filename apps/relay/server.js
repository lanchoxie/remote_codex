const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  buildDetachedBootstrapCommand,
  buildRemoteStatusCommand,
  buildSshCommandParts,
  connectorUsesGateway,
  decorateConnector,
  loadConnectors,
  normalizeConnectorInput,
  requiresInteractiveAuth,
  saveConnectors,
} = require('../../shared/connectors');
const {
  getConnectorSecretStatus,
  loadConnectorSecrets,
  normalizeConnectorSecretsInput,
  saveConnectorSecrets,
} = require('../../shared/connector-secrets');
const { makeId, nowIso, sessionKey } = require('../../shared/protocol');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, '..', 'mobile-web', 'public');
const SESSION_COLLECTIONS_PATH = path.join(process.cwd(), 'tmp', 'session-collections.json');
const SESSION_LOGS_PATH = path.join(process.cwd(), 'tmp', 'session-logs.json');
const RECEIVED_FILES_ROOT = path.join(process.cwd(), 'tmp', 'received-files');
const RECEIVED_FILES_MANIFEST_PATH = path.join(RECEIVED_FILES_ROOT, 'manifest.json');
const RELAY_AUTH_TOKEN_PATH = process.env.RELAY_AUTH_TOKEN_PATH || path.join(process.cwd(), 'tmp', 'relay-auth-token.txt');
const RELAY_AUTH_ACCOUNT_PATH = process.env.RELAY_AUTH_ACCOUNT_PATH || path.join(process.cwd(), 'tmp', 'relay-auth-account.json');
const RELAY_AUTH_COOKIE_NAME = 'remote_codex_auth';
const DEFAULT_COLLECTION_ID = 'default';
const ASKPASS_MAX_PROMPTS_PER_ACTION = 8;
const MAX_JSON_BODY_BYTES = Number(process.env.RELAY_MAX_JSON_BODY_BYTES || 40 * 1024 * 1024);
const MAX_FILE_TRANSFER_BYTES = Number(process.env.RELAY_MAX_FILE_TRANSFER_BYTES || 24 * 1024 * 1024);
const RECEIVED_FILE_TTL_MS = Number(process.env.RELAY_RECEIVED_FILE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const SESSION_LOG_ENTRY_LIMIT = Number(process.env.RELAY_SESSION_LOG_ENTRY_LIMIT || 1000);
const RESUME_TRANSCRIPT_MAX_ENTRIES = Number(process.env.RELAY_RESUME_TRANSCRIPT_MAX_ENTRIES || 1000);
const RESUME_TRANSCRIPT_MAX_ENTRY_CHARS = Number(process.env.RELAY_RESUME_TRANSCRIPT_MAX_ENTRY_CHARS || 12000);
const RESUME_TRANSCRIPT_MAX_TOTAL_CHARS = Number(process.env.RELAY_RESUME_TRANSCRIPT_MAX_TOTAL_CHARS || 240000);
const RELAY_AUTH_TOKEN = loadRelayAuthToken();
let relayAuthAccount = loadRelayAuthAccount();

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeApiConfig(input = {}) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const provider = String(input.provider || '').trim().slice(0, 80);
  const baseUrl = String(input.baseUrl || '').trim().slice(0, 500);
  const apiKey = String(input.apiKey || '').trim();
  const profileId = String(input.profileId || '').trim().slice(0, 120);
  const label = String(input.label || '').trim().slice(0, 120);
  if (!baseUrl && !apiKey) {
    return null;
  }
  return {
    provider: provider || 'OpenAI',
    baseUrl,
    apiKey,
    profileId,
    label,
  };
}

function summarizeApiConfig(apiConfig) {
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return null;
  }
  return {
    profileId: config.profileId || null,
    label: config.label || config.provider || 'API profile',
    provider: config.provider || null,
    baseUrl: config.baseUrl || null,
  };
}

function loadRelayAuthToken() {
  if (truthyEnv(process.env.RELAY_AUTH_DISABLED)) {
    return '';
  }

  const envToken = String(process.env.RELAY_AUTH_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }

  try {
    const saved = fs.readFileSync(RELAY_AUTH_TOKEN_PATH, 'utf8').trim();
    if (saved) {
      return saved;
    }
  } catch (_) {
    // Missing token file is expected on first run.
  }

  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(RELAY_AUTH_TOKEN_PATH), { recursive: true });
  try {
    fs.writeFileSync(RELAY_AUTH_TOKEN_PATH, `${token}\n`, { encoding: 'utf8', flag: 'wx' });
    return token;
  } catch (_) {
    const saved = fs.readFileSync(RELAY_AUTH_TOKEN_PATH, 'utf8').trim();
    return saved || token;
  }
}

function loadRelayAuthAccount() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RELAY_AUTH_ACCOUNT_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.username || !parsed.passwordHash) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveRelayAuthAccount(account) {
  fs.mkdirSync(path.dirname(RELAY_AUTH_ACCOUNT_PATH), { recursive: true });
  relayAuthAccount = {
    version: 1,
    username: account.username,
    passwordHash: account.passwordHash,
    createdAt: account.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  fs.writeFileSync(RELAY_AUTH_ACCOUNT_PATH, JSON.stringify(relayAuthAccount, null, 2), 'utf8');
  return relayAuthAccount;
}

function normalizeAuthUsername(value) {
  return String(value || '').trim().slice(0, 64);
}

function validateAuthUsername(username) {
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) {
    throw new Error('username must be 2-64 characters: letters, numbers, dot, underscore, dash, or @');
  }
}

function validateAuthPassword(password) {
  const text = String(password || '');
  if (text.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  if (text.length > 256) {
    throw new Error('password is too long');
  }
}

function hashAuthPassword(password) {
  validateAuthPassword(password);
  const salt = crypto.randomBytes(16);
  const params = {
    N: 16384,
    r: 8,
    p: 1,
    keyLength: 64,
  };
  const key = crypto.scryptSync(String(password), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    algorithm: 'scrypt',
    params,
    salt: salt.toString('base64'),
    hash: key.toString('base64'),
  };
}

function verifyAuthPassword(password, account = relayAuthAccount) {
  if (!account?.passwordHash || account.passwordHash.algorithm !== 'scrypt') {
    return false;
  }
  try {
    const params = account.passwordHash.params || {};
    const keyLength = Number(params.keyLength || 64);
    const expected = Buffer.from(String(account.passwordHash.hash || ''), 'base64');
    if (!expected.length || expected.length !== keyLength) {
      return false;
    }
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(String(account.passwordHash.salt || ''), 'base64'), keyLength, {
      N: Number(params.N || 16384),
      r: Number(params.r || 8),
      p: Number(params.p || 1),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createRelayAuthAccount(username, password) {
  const normalizedUsername = normalizeAuthUsername(username || 'admin');
  validateAuthUsername(normalizedUsername);
  return saveRelayAuthAccount({
    username: normalizedUsername,
    passwordHash: hashAuthPassword(password),
  });
}

function normalizeSessionCollectionItem(input = {}) {
  const hostId = String(input.hostId || '').trim();
  const conversationKey = String(input.conversationKey || input.originSessionId || input.sessionId || '').trim();
  const sessionId = String(input.sessionId || '').trim();
  if (!hostId || !conversationKey) {
    return null;
  }

  return {
    hostId,
    conversationKey,
    sessionId,
    title: String(input.title || '').trim(),
    cwd: String(input.cwd || '').trim(),
    hostLabel: String(input.hostLabel || '').trim(),
    hostPlatform: String(input.hostPlatform || '').trim(),
    targetHost: String(input.targetHost || '').trim(),
    targetPort: Number(input.targetPort || 0) || null,
    connectorId: String(input.connectorId || '').trim(),
    connectorLabel: String(input.connectorLabel || '').trim(),
    relayUrl: String(input.relayUrl || '').trim(),
    addedAt: input.addedAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function collectionItemKey(item) {
  return `${item.hostId}::${item.conversationKey}`;
}

function normalizeSessionCollection(input = {}) {
  const collectionId = String(input.collectionId || input.id || makeId()).trim();
  const name = String(input.name || '').trim() || 'Untitled';
  const seen = new Set();
  const items = [];

  for (const rawItem of Array.isArray(input.items) ? input.items : []) {
    const item = normalizeSessionCollectionItem(rawItem);
    if (!item) {
      continue;
    }
    const key = collectionItemKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(item);
  }

  return {
    collectionId,
    name,
    system: collectionId === DEFAULT_COLLECTION_ID,
    items,
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
  };
}

function loadSessionCollections() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_COLLECTIONS_PATH, 'utf8'));
    const collections = Array.isArray(parsed.collections) ? parsed.collections : [];
    return collections.map(normalizeSessionCollection);
  } catch {
    return [];
  }
}

function saveSessionCollections(collections) {
  fs.mkdirSync(path.dirname(SESSION_COLLECTIONS_PATH), { recursive: true });
  fs.writeFileSync(SESSION_COLLECTIONS_PATH, JSON.stringify({
    savedAt: nowIso(),
    collections: collections.map((collection) => ({
      ...collection,
      items: collection.collectionId === DEFAULT_COLLECTION_ID ? [] : collection.items,
    })),
  }, null, 2), 'utf8');
}

function safePathSegment(value, fallback = 'item') {
  const text = String(value || '').trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return text || fallback;
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function loadReceivedFiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RECEIVED_FILES_MANIFEST_PATH, 'utf8'));
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    return new Map(files
      .filter((file) => file?.fileId && file?.localPath)
      .map((file) => [String(file.fileId), file]));
  } catch {
    return new Map();
  }
}

function saveReceivedFiles() {
  fs.mkdirSync(RECEIVED_FILES_ROOT, { recursive: true });
  fs.writeFileSync(RECEIVED_FILES_MANIFEST_PATH, JSON.stringify({
    savedAt: nowIso(),
    ttlMs: RECEIVED_FILE_TTL_MS,
    root: RECEIVED_FILES_ROOT,
    files: Array.from(state.receivedFiles.values()),
  }, null, 2), 'utf8');
}

function normalizeStoredTranscriptEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const text = String(entry.text || '').trim();
  const files = normalizeFileTransferRefs(entry.files || entry.attachments || []);
  if (!text && !files.length) {
    return null;
  }
  return {
    timestamp: entry.timestamp || nowIso(),
    speaker: entry.speaker || 'system',
    text,
    stream: entry.stream || null,
    files,
  };
}

function loadSessionLogs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_LOGS_PATH, 'utf8'));
    const rawLogs = parsed && typeof parsed.logs === 'object' ? parsed.logs : {};
    const logs = new Map();
    for (const [key, entries] of Object.entries(rawLogs)) {
      const normalized = (Array.isArray(entries) ? entries : [])
        .map(normalizeStoredTranscriptEntry)
        .filter(Boolean)
        .slice(-200);
      if (normalized.length) {
        logs.set(key, normalized);
      }
    }
    return logs;
  } catch {
    return new Map();
  }
}

function saveSessionLogs() {
  const logs = {};
  for (const [key, entries] of state.sessionLogs.entries()) {
    const normalized = (Array.isArray(entries) ? entries : [])
      .map(normalizeStoredTranscriptEntry)
      .filter(Boolean)
      .slice(-200);
    if (normalized.length) {
      logs[key] = normalized;
    }
  }
  fs.mkdirSync(path.dirname(SESSION_LOGS_PATH), { recursive: true });
  fs.writeFileSync(SESSION_LOGS_PATH, JSON.stringify({
    savedAt: nowIso(),
    logs,
  }, null, 2), 'utf8');
}

const state = {
  hosts: new Map(),
  sessions: new Map(),
  commandQueues: new Map(),
  subscribers: new Map(),
  dismissedHosts: new Set(),
  sessionLogs: loadSessionLogs(),
  sessionAlerts: new Map(),
  sessionRuntime: new Map(),
  sessionDiagnostics: new Map(),
  sessionRequests: new Map(),
  pendingDirectoryRequests: new Map(),
  pendingHostProbes: new Map(),
  pendingModelRequests: new Map(),
  pendingFileRequests: new Map(),
  askpassActions: new Map(),
  sshMultiplexDisabled: new Map(),
  connectors: new Map(),
  connectorSecrets: loadConnectorSecrets(),
  sessionCollections: new Map(),
  receivedFiles: loadReceivedFiles(),
  // Agents keep their last command id in memory across relay restarts, so use
  // a monotonic-ish epoch instead of restarting command ids at 1.
  nextCommandId: Date.now(),
};

for (const connector of loadConnectors()) {
  state.connectors.set(connector.connectorId, connector);
}

for (const collection of loadSessionCollections()) {
  state.sessionCollections.set(collection.collectionId, collection);
}
if (!state.sessionCollections.has(DEFAULT_COLLECTION_ID)) {
  state.sessionCollections.set(DEFAULT_COLLECTION_ID, normalizeSessionCollection({
    collectionId: DEFAULT_COLLECTION_ID,
    name: 'Default',
    system: true,
    items: [],
  }));
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        rejected = true;
        reject(new Error(`request body too large; limit is ${MAX_JSON_BODY_BYTES} bytes`));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (rejected) {
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies.set(name, decodeURIComponent(value));
    }
  }
  return cookies;
}

function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function getAuthTokenFromRequest(req, url) {
  const authorization = String(req.headers.authorization || '').trim();
  if (/^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, '').trim();
  }
  const headerToken = String(req.headers['x-relay-auth-token'] || '').trim();
  if (headerToken) {
    return headerToken;
  }
  const queryToken = String(url.searchParams.get('authToken') || '').trim();
  if (queryToken) {
    return queryToken;
  }
  return '';
}

function authCookieHeader(maxAgeSeconds) {
  const secure = truthyEnv(process.env.RELAY_AUTH_COOKIE_SECURE) ? '; Secure' : '';
  if (maxAgeSeconds <= 0) {
    return `${RELAY_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${RELAY_AUTH_COOKIE_NAME}=${encodeURIComponent(currentAuthCookieValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function currentAuthCookieValue() {
  if (!RELAY_AUTH_TOKEN) {
    return '';
  }
  const accountMarker = relayAuthAccount?.passwordHash?.hash || 'no-account';
  return crypto
    .createHmac('sha256', RELAY_AUTH_TOKEN)
    .update(`remote-codex-auth-cookie-v2:${accountMarker}`)
    .digest('base64url');
}

function relayAuthStatus(req, url = null) {
  if (!RELAY_AUTH_TOKEN) {
    return { required: false, authenticated: true };
  }

  const parsedUrl = url || parseUrl(req);
  const token = getAuthTokenFromRequest(req, parsedUrl);
  if (token && constantTimeEqual(token, RELAY_AUTH_TOKEN)) {
    return { required: true, authenticated: true };
  }

  const cookieValue = parseCookies(req).get(RELAY_AUTH_COOKIE_NAME) || '';
  if (cookieValue && constantTimeEqual(cookieValue, currentAuthCookieValue())) {
    return { required: true, authenticated: true };
  }

  return { required: true, authenticated: false };
}

function relayAuthHint() {
  return RELAY_AUTH_TOKEN
    ? `${RELAY_AUTH_TOKEN.slice(0, 4)}...${RELAY_AUTH_TOKEN.slice(-4)}`
    : '';
}

function relayAuthConfig(req, url = null) {
  const status = relayAuthStatus(req, url);
  return {
    authRequired: status.required,
    authenticated: status.authenticated,
    hasAccount: Boolean(relayAuthAccount?.username),
    setupRequired: Boolean(status.required && !relayAuthAccount?.username),
    username: relayAuthAccount?.username || '',
    tokenHint: relayAuthHint(),
    tokenFile: RELAY_AUTH_TOKEN ? RELAY_AUTH_TOKEN_PATH : null,
    accountFile: RELAY_AUTH_TOKEN ? RELAY_AUTH_ACCOUNT_PATH : null,
  };
}

function requestIsPublic(req, url) {
  if (req.method === 'OPTIONS') {
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return true;
  }
  if (url.pathname === '/api/auth/config' || url.pathname === '/api/auth/login' || url.pathname === '/api/auth/setup') {
    return true;
  }
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    return true;
  }
  return false;
}

function authorizeRequest(req, res, url) {
  if (requestIsPublic(req, url)) {
    return true;
  }
  const status = relayAuthStatus(req, url);
  if (status.authenticated) {
    return true;
  }
  sendJson(res, 401, {
    error: relayAuthAccount?.username ? 'relay login is required' : 'relay setup or recovery token is required',
    authRequired: true,
    setupRequired: Boolean(!relayAuthAccount?.username),
  });
  return false;
}

function hostOnline(host) {
  if (!host) {
    return false;
  }
  const lastSeen = host.lastSeenAt ? Date.parse(host.lastSeenAt) : 0;
  return Date.now() - lastSeen < 30_000;
}

function hostHeartbeatAgeMs(host) {
  const lastSeen = host?.lastSeenAt ? Date.parse(host.lastSeenAt) : 0;
  return lastSeen ? Date.now() - lastSeen : Number.POSITIVE_INFINITY;
}

function hostHasFreshHeartbeat(host, maxAgeMs = 15_000) {
  return hostHeartbeatAgeMs(host) <= maxAgeMs;
}

function connectorAttachKey(value) {
  return String(value || '').trim().toLowerCase();
}

function attachMatchingConnectorsToHost(host) {
  const hostLabel = connectorAttachKey(host?.label);
  if (!host?.hostId || !hostLabel) {
    return false;
  }

  let changed = false;
  for (const connector of state.connectors.values()) {
    if (connector.hostId || connectorAttachKey(connector.label) !== hostLabel) {
      continue;
    }
    state.connectors.set(connector.connectorId, {
      ...connector,
      hostId: host.hostId,
      updatedAt: nowIso(),
    });
    changed = true;
  }
  if (changed) {
    persistConnectors();
  }
  return changed;
}

function getHostUnavailableError(hostId) {
  const host = state.hosts.get(hostId);
  if (!host) {
    return { statusCode: 404, error: 'host not found' };
  }
  if (!hostOnline(host)) {
    return { statusCode: 409, error: `host ${host.label || hostId} is offline` };
  }
  return null;
}

function getHostCapabilityError(hostId, capability, message) {
  const hostError = getHostUnavailableError(hostId);
  if (hostError) {
    return hostError;
  }
  const host = state.hosts.get(hostId);
  if (!host?.capabilities?.[capability]) {
    return {
      statusCode: 409,
      error: message || `this host agent needs to be restarted before it can use ${capability}`,
    };
  }
  return null;
}

function getHostList() {
  return Array.from(state.hosts.values()).map((host) => ({
    ...host,
    online: hostOnline(host),
    sessionCount: Array.from(state.sessions.values()).filter((session) => session.hostId === host.hostId).length,
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function getSessionsForHost(hostId) {
  return Array.from(state.sessions.values())
    .filter((session) => session.hostId === hostId)
    .sort((a, b) => String(b.lastUpdatedAt || '').localeCompare(String(a.lastUpdatedAt || '')));
}

function getSession(hostId, sessionId) {
  return state.sessions.get(sessionKey(hostId, sessionId)) || null;
}

function getSessionDetail(hostId, sessionId) {
  const session = getSession(hostId, sessionId);
  if (!session) {
    return null;
  }

  const key = sessionKey(hostId, sessionId);
  const transcript = state.sessionLogs.get(key) || session.transcriptPreview || [];
  const alerts = state.sessionAlerts.get(key) || [];
  const runtime = state.sessionRuntime.get(key) || null;
  const diagnostics = state.sessionDiagnostics.get(key) || [];
  const requests = state.sessionRequests.get(key) || [];
  return {
    session,
    transcript,
    alerts,
    runtime,
    diagnostics,
    requests,
  };
}

function safeFileDisplayName(value, fallback = 'download') {
  const text = String(value || '').trim();
  const leaf = text.split(/[\\/]/).filter(Boolean).pop() || fallback;
  return leaf.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || fallback;
}

function isAmbiguousBareDownloadPath(value) {
  const text = String(value || '').trim();
  return Boolean(text)
    && !/[\\/]/.test(text)
    && !/^[A-Za-z]:/.test(text)
    && !text.startsWith('~');
}

function normalizeFileTransferRefs(rawFiles) {
  const files = [];
  for (const rawFile of Array.isArray(rawFiles) ? rawFiles.slice(0, 16) : []) {
    if (!rawFile || typeof rawFile !== 'object') {
      continue;
    }

    const remotePath = String(rawFile.path || rawFile.remotePath || '').trim();
    const name = safeFileDisplayName(rawFile.name || remotePath || 'file');
    if (!remotePath && !rawFile.dataBase64) {
      continue;
    }

    files.push({
      fileId: String(rawFile.fileId || rawFile.id || makeId()).trim(),
      name,
      path: remotePath,
      size: Number(rawFile.size || 0) || 0,
      mime: String(rawFile.mime || rawFile.type || 'application/octet-stream').trim() || 'application/octet-stream',
      isImage: Boolean(rawFile.isImage) || /^image\//i.test(String(rawFile.mime || rawFile.type || '')),
      uploadedAt: rawFile.uploadedAt || rawFile.timestamp || nowIso(),
    });
  }
  return files;
}

function transcriptFingerprint(entry) {
  return `${entry.speaker || 'system'}|${entry.timestamp || ''}|${entry.text || ''}|${(entry.files || []).map((file) => file.path || file.name || '').join(',')}`;
}

function setSessionLog(hostId, sessionId, entries, options = {}) {
  const key = sessionKey(hostId, sessionId);
  const normalized = (Array.isArray(entries) ? entries : [])
    .map(normalizeStoredTranscriptEntry)
    .filter(Boolean);
  const existing = options.merge ? state.sessionLogs.get(key) || [] : [];
  state.sessionLogs.set(
    key,
    mergeByFingerprint([...existing, ...normalized], transcriptFingerprint, SESSION_LOG_ENTRY_LIMIT)
  );
  saveSessionLogs();
}

function mergeByFingerprint(entries, fingerprint, limit) {
  const seen = new Set();
  const merged = [];
  for (const entry of entries || []) {
    if (!entry) {
      continue;
    }
    const key = fingerprint(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }
  return merged.slice(-limit);
}

function setSessionAlerts(hostId, sessionId, entries) {
  const key = sessionKey(hostId, sessionId);
  const alerts = Array.isArray(entries) ? entries : [];
  state.sessionAlerts.set(key, mergeByFingerprint(alerts, (entry) => `${entry.severity || 'warning'}|${entry.timestamp || ''}|${entry.message || ''}`, 100));
}

function setSessionRuntime(hostId, sessionId, runtime) {
  const key = sessionKey(hostId, sessionId);
  if (!runtime || typeof runtime !== 'object') {
    state.sessionRuntime.delete(key);
    return null;
  }

  const existing = state.sessionRuntime.get(key) || {};
  const next = {
    ...existing,
    ...runtime,
    updatedAt: runtime.updatedAt || nowIso(),
  };
  state.sessionRuntime.set(key, next);
  return next;
}

function appendSessionDiagnostic(hostId, sessionId, entry) {
  const key = sessionKey(hostId, sessionId);
  const existing = state.sessionDiagnostics.get(key) || [];
  const nextEntry = {
    timestamp: entry.timestamp || nowIso(),
    severity: entry.severity || 'info',
    source: entry.source || 'codex',
    kind: entry.kind || 'event',
    method: entry.method || null,
    message: entry.message || '',
    detail: entry.detail || null,
    data: entry.data || null,
    turnId: entry.turnId || entry.data?.turnId || null,
  };
  existing.push(nextEntry);
  state.sessionDiagnostics.set(
    key,
    mergeByFingerprint(
      existing,
      (item) => `${item.timestamp || ''}|${item.kind || ''}|${item.method || ''}|${item.message || ''}|${item.detail || ''}|${item.turnId || ''}`,
      200
    )
  );
  return nextEntry;
}

function emitSessionDiagnostic(hostId, sessionId, entry) {
  const nextEntry = appendSessionDiagnostic(hostId, sessionId, entry);
  const payload = {
    ...nextEntry,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.diagnostic', payload);
  return payload;
}

function upsertSessionRequest(hostId, sessionId, entry) {
  const key = sessionKey(hostId, sessionId);
  const existing = state.sessionRequests.get(key) || [];
  const nextEntry = {
    requestId: String(entry.requestId || ''),
    createdAt: entry.createdAt || nowIso(),
    updatedAt: entry.updatedAt || entry.createdAt || nowIso(),
    status: entry.status || 'pending',
    kind: entry.kind || 'request',
    method: entry.method || null,
    title: entry.title || null,
    message: entry.message || null,
    summary: entry.summary || null,
    payload: entry.payload || null,
    response: entry.response || null,
  };

  const index = existing.findIndex((item) => String(item.requestId || '') === nextEntry.requestId);
  if (index === -1) {
    existing.push(nextEntry);
  } else {
    existing[index] = {
      ...existing[index],
      ...nextEntry,
    };
  }

  state.sessionRequests.set(key, existing.slice(-40));
  return nextEntry;
}

function emitSessionRequest(hostId, sessionId, entry) {
  const nextEntry = upsertSessionRequest(hostId, sessionId, entry);
  const payload = {
    ...nextEntry,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.request', payload);
  return payload;
}

function resolveSessionRequest(hostId, sessionId, requestId, patch = {}) {
  const key = sessionKey(hostId, sessionId);
  const existing = (state.sessionRequests.get(key) || [])
    .find((item) => String(item.requestId || '') === String(requestId || ''));
  const resolved = upsertSessionRequest(hostId, sessionId, {
    requestId,
    createdAt: existing?.createdAt || patch.createdAt || nowIso(),
    status: patch.status || 'resolved',
    updatedAt: patch.updatedAt || nowIso(),
    kind: patch.kind ?? existing?.kind ?? 'request',
    method: patch.method ?? existing?.method ?? null,
    title: patch.title ?? existing?.title ?? null,
    message: patch.message ?? existing?.message ?? null,
    summary: patch.summary ?? existing?.summary ?? null,
    payload: patch.payload ?? existing?.payload ?? null,
    response: patch.response ?? existing?.response ?? null,
  });
  const payload = {
    ...resolved,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.request.resolved', payload);
  return payload;
}

function resolvePendingSessionRequests(hostId, sessionId, patch = {}) {
  const key = sessionKey(hostId, sessionId);
  const requests = state.sessionRequests.get(key) || [];
  const pending = requests.filter((item) => item.status === 'pending');
  for (const request of pending) {
    resolveSessionRequest(hostId, sessionId, request.requestId, {
      status: patch.status || 'expired',
      updatedAt: patch.updatedAt || nowIso(),
      message: patch.message || request.message || 'Request closed because the Codex turn is no longer active.',
      summary: patch.summary ?? request.summary ?? null,
      response: patch.response || {
        status: patch.status || 'expired',
        reason: patch.message || 'Request closed because the Codex turn is no longer active.',
      },
    });
  }
}

function appendSessionLog(hostId, sessionId, entry) {
  const key = sessionKey(hostId, sessionId);
  const existing = state.sessionLogs.get(key) || [];
  const nextEntry = {
    timestamp: entry.timestamp || nowIso(),
    speaker: entry.speaker || 'system',
    text: entry.text || '',
    stream: entry.stream || null,
    files: normalizeFileTransferRefs(entry.files || entry.attachments || []),
  };
  existing.push(nextEntry);
  state.sessionLogs.set(key, mergeByFingerprint(existing, transcriptFingerprint, SESSION_LOG_ENTRY_LIMIT));
  const session = getSession(hostId, sessionId);
  if (session) {
    session.messageCount = Math.max(Number(session.messageCount || 0), state.sessionLogs.get(key)?.length || 0);
    session.lastUpdatedAt = nextEntry.timestamp || nowIso();
    state.sessions.set(key, session);
  }
  saveSessionLogs();
  return nextEntry;
}

function appendSessionAlert(hostId, sessionId, entry) {
  const key = sessionKey(hostId, sessionId);
  const existing = state.sessionAlerts.get(key) || [];
  const nextEntry = {
    timestamp: entry.timestamp || nowIso(),
    severity: entry.severity || 'warning',
    source: entry.source || 'runtime',
    message: entry.message || '',
  };
  existing.push(nextEntry);
  state.sessionAlerts.set(
    key,
    mergeByFingerprint(existing, (item) => `${item.severity || 'warning'}|${item.timestamp || ''}|${item.message || ''}`, 100)
  );
  return nextEntry;
}

function emitTranscriptEntry(hostId, sessionId, entry) {
  const nextEntry = appendSessionLog(hostId, sessionId, entry);
  const payload = {
    ...nextEntry,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.transcript', payload);
  return payload;
}

function emitSessionAlert(hostId, sessionId, entry) {
  const nextEntry = appendSessionAlert(hostId, sessionId, entry);
  const payload = {
    ...nextEntry,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.alert', payload);
  return payload;
}

function buildResumeTranscript(entries, options = {}) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const maxEntries = Number(options.maxEntries ?? RESUME_TRANSCRIPT_MAX_ENTRIES);
  const maxEntryChars = Number(options.maxEntryChars ?? RESUME_TRANSCRIPT_MAX_ENTRY_CHARS);
  const maxTotalChars = Number(options.maxTotalChars ?? RESUME_TRANSCRIPT_MAX_TOTAL_CHARS);
  const filtered = entries
    .filter((entry) => entry && entry.text)
    .map((entry) => ({
      speaker: entry.speaker || 'system',
      text: String(entry.text || ''),
      timestamp: entry.timestamp || null,
    }));

  const source = maxEntries > 0 ? filtered.slice(-maxEntries) : filtered;
  const result = [];
  let totalChars = 0;

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const entry = source[index];
    let text = String(entry.text || '').trim();
    if (!text) {
      continue;
    }
    if (maxEntryChars > 0 && text.length > maxEntryChars) {
      text = text.slice(0, maxEntryChars);
    }
    if (maxTotalChars > 0 && totalChars + text.length > maxTotalChars) {
      const remaining = maxTotalChars - totalChars;
      if (remaining <= 0) {
        break;
      }
      text = text.slice(Math.max(0, text.length - remaining));
    }
    result.unshift({
      speaker: entry.speaker,
      text,
      timestamp: entry.timestamp,
    });
    totalChars += text.length;
  }

  return result;
}

function describeLaunchMode(hostId, event) {
  const sourceSession = event.sourceSessionId ? getSession(hostId, event.sourceSessionId) : null;
  const sourceLabel = sourceSession?.title || event.sourceSessionId || 'source session';

  if (event.launchMode === 'resume') {
    return `Resumed from history: ${sourceLabel}`;
  }

  if (event.launchMode === 'fork') {
    return `Forked into a new live branch from: ${sourceLabel}`;
  }

  return `${event.title || event.sessionId} is live`;
}

function classifyOutputSpeaker(chunk, stream = 'stdout') {
  const text = String(chunk || '');
  if (stream === 'stderr' || text.startsWith('[demo]') || text.startsWith('[history:') || text.startsWith('[codex')) {
    return 'system';
  }
  return 'agent';
}

function isImportantAlertText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }

  if (/^\[codex\] continuing from imported history context$/i.test(normalized)) {
    return false;
  }

  if (/^\[codex raw]/i.test(normalized)) {
    return false;
  }

  if (/^\[demo]/i.test(normalized)) {
    return false;
  }

  return /\b(error|failed|failure|denied|declined|retry|timed out|timeout|quota|limit|approval|permission|request|required|network|offline|unreachable|disk|space|sandbox)\b/i.test(normalized)
    || /磁盘空间不足|空间不足|失败|错误/.test(normalized);
}

function classifyAlertSeverity(text, fallback = 'warning') {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return fallback;
  }

  if (/\b(error|failed|failure|denied|declined|timed out|timeout)\b/i.test(normalized) || /错误|失败/.test(normalized)) {
    return 'error';
  }

  if (/\bretry\b/i.test(normalized)) {
    return 'warning';
  }

  return fallback;
}

function buildAlertFromOutput(event) {
  const message = String(event.chunk || '').trim();
  if (!isImportantAlertText(message)) {
    return null;
  }

  return {
    timestamp: event.timestamp || nowIso(),
    severity: classifyAlertSeverity(message, 'warning'),
    source: event.stream === 'stderr' ? 'stderr' : 'runtime',
    message,
  };
}

function moveSessionArtifacts(hostId, fromSessionId, toSessionId) {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
    return;
  }

  const fromKey = sessionKey(hostId, fromSessionId);
  const toKey = sessionKey(hostId, toSessionId);
  const fromLogs = state.sessionLogs.get(fromKey) || [];
  const toLogs = state.sessionLogs.get(toKey) || [];
  if (fromLogs.length || toLogs.length) {
    state.sessionLogs.set(
      toKey,
      mergeByFingerprint([...toLogs, ...fromLogs], transcriptFingerprint, SESSION_LOG_ENTRY_LIMIT)
    );
    state.sessionLogs.delete(fromKey);
    saveSessionLogs();
  }

  const fromAlerts = state.sessionAlerts.get(fromKey) || [];
  const toAlerts = state.sessionAlerts.get(toKey) || [];
  if (fromAlerts.length || toAlerts.length) {
    state.sessionAlerts.set(
      toKey,
      mergeByFingerprint([...toAlerts, ...fromAlerts], (entry) => `${entry.severity || 'warning'}|${entry.timestamp || ''}|${entry.message || ''}`, 100)
    );
    state.sessionAlerts.delete(fromKey);
  }

  const fromRuntime = state.sessionRuntime.get(fromKey) || null;
  const toRuntime = state.sessionRuntime.get(toKey) || null;
  if (fromRuntime || toRuntime) {
    state.sessionRuntime.set(toKey, {
      ...(toRuntime || {}),
      ...(fromRuntime || {}),
      updatedAt: nowIso(),
    });
    state.sessionRuntime.delete(fromKey);
  }

  const fromDiagnostics = state.sessionDiagnostics.get(fromKey) || [];
  const toDiagnostics = state.sessionDiagnostics.get(toKey) || [];
  if (fromDiagnostics.length || toDiagnostics.length) {
    state.sessionDiagnostics.set(
      toKey,
      mergeByFingerprint(
        [...toDiagnostics, ...fromDiagnostics],
        (entry) => `${entry.timestamp || ''}|${entry.kind || ''}|${entry.method || ''}|${entry.message || ''}|${entry.detail || ''}`,
        200
      )
    );
    state.sessionDiagnostics.delete(fromKey);
  }

  const fromRequests = state.sessionRequests.get(fromKey) || [];
  const toRequests = state.sessionRequests.get(toKey) || [];
  if (fromRequests.length || toRequests.length) {
    state.sessionRequests.set(
      toKey,
      mergeByFingerprint(
        [...toRequests, ...fromRequests],
        (entry) => `${entry.requestId || ''}|${entry.updatedAt || entry.createdAt || ''}|${entry.status || ''}`,
        40
      )
    );
    state.sessionRequests.delete(fromKey);
  }

  const fromSubscribers = state.subscribers.get(fromKey);
  if (fromSubscribers && fromSubscribers.size) {
    const existing = state.subscribers.get(toKey) || new Set();
    for (const subscriber of fromSubscribers) {
      existing.add(subscriber);
    }
    state.subscribers.set(toKey, existing);
    state.subscribers.delete(fromKey);
  }
}

function migrateSessionIdentity(hostId, fromSessionId, toSessionId, patch = {}) {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
    return upsertSession(hostId, {
      sessionId: toSessionId || fromSessionId,
      ...patch,
    });
  }

  const fromKey = sessionKey(hostId, fromSessionId);
  const toKey = sessionKey(hostId, toSessionId);
  const fromSession = state.sessions.get(fromKey) || null;
  const toSession = state.sessions.get(toKey) || null;
  const next = {
    ...(fromSession || {}),
    ...(toSession || {}),
    ...patch,
    hostId,
    sessionId: toSessionId,
    bridgeSessionId: fromSessionId,
    nativeThreadId: patch.nativeThreadId || toSessionId,
    lastUpdatedAt: patch.lastUpdatedAt || nowIso(),
  };

  state.sessions.set(toKey, next);
  state.sessions.delete(fromKey);
  moveSessionArtifacts(hostId, fromSessionId, toSessionId);
  return next;
}

function persistConnectors() {
  saveConnectors(Array.from(state.connectors.values()));
}

function persistConnectorSecrets() {
  saveConnectorSecrets(state.connectorSecrets);
}

function persistSessionCollections() {
  saveSessionCollections(Array.from(state.sessionCollections.values()));
}

function getSessionCollectionList() {
  return Array.from(state.sessionCollections.values())
    .map((collection) => ({
      ...collection,
      itemCount: collection.collectionId === DEFAULT_COLLECTION_ID
        ? Array.from(state.sessions.values()).length
        : collection.items.length,
    }))
    .sort((a, b) => {
      if (a.collectionId === DEFAULT_COLLECTION_ID) {
        return -1;
      }
      if (b.collectionId === DEFAULT_COLLECTION_ID) {
        return 1;
      }
      return String(a.name).localeCompare(String(b.name));
    });
}

function upsertConnectorSecretsFromBody(connectorId, body) {
  const input = body?.secrets || {};
  const gatewayPassword = typeof input.gatewayPassword === 'string' ? input.gatewayPassword : '';
  const targetPassword = typeof input.targetPassword === 'string' ? input.targetPassword : '';
  if (!gatewayPassword && !targetPassword) {
    return false;
  }

  const existing = state.connectorSecrets.get(connectorId) || null;
  const next = normalizeConnectorSecretsInput({
    connectorId,
    gatewayPassword: gatewayPassword || existing?.gatewayPassword || '',
    targetPassword: targetPassword || existing?.targetPassword || '',
  }, existing);
  state.connectorSecrets.set(connectorId, next);
  persistConnectorSecrets();
  return true;
}

function buildConnectorActionSecret(connectorId, body) {
  const input = body?.secrets || {};
  const askpass = body?.askpass || {};
  const existing = state.connectorSecrets.get(connectorId) || null;
  const gatewayPassword = typeof input.gatewayPassword === 'string' ? input.gatewayPassword : '';
  const targetPassword = typeof input.targetPassword === 'string' ? input.targetPassword : '';
  const gatewayOtp = typeof input.gatewayOtp === 'string' ? input.gatewayOtp.trim() : '';
  const targetOtp = typeof input.targetOtp === 'string' ? input.targetOtp.trim() : '';
  const askpassActionId = String(askpass.actionId || body?.askpassActionId || '').trim();
  const askpassToken = String(askpass.token || body?.askpassToken || '').trim();

  return {
    connectorId,
    gatewayPassword: gatewayPassword || existing?.gatewayPassword || '',
    targetPassword: targetPassword || existing?.targetPassword || '',
    gatewayOtp,
    targetOtp,
    askpassActionId,
    askpassToken,
    interactiveAskpass: Boolean(askpassActionId && askpassToken),
  };
}

function askpassActionKey(connectorId, actionId) {
  return `${connectorId}::${actionId}`;
}

function registerAskpassAction(connectorId, action, secret) {
  if (!secret?.interactiveAskpass) {
    return null;
  }

  const record = {
    connectorId,
    action,
    actionId: secret.askpassActionId,
    token: secret.askpassToken,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    closed: false,
    cancelled: false,
    maxPrompts: ASKPASS_MAX_PROMPTS_PER_ACTION,
    prompts: new Map(),
  };
  state.askpassActions.set(askpassActionKey(connectorId, secret.askpassActionId), record);
  return record;
}

function getAskpassAction(connectorId, actionId, token) {
  const record = state.askpassActions.get(askpassActionKey(connectorId, actionId));
  if (!record || record.token !== token) {
    return null;
  }
  return record;
}

function closeAskpassAction(record) {
  if (!record) {
    return;
  }
  record.closed = true;
  record.updatedAt = nowIso();
  for (const prompt of record.prompts.values()) {
    if (!prompt.responseReady) {
      prompt.cancelled = true;
      prompt.updatedAt = nowIso();
    }
  }
  setTimeout(() => {
    state.askpassActions.delete(askpassActionKey(record.connectorId, record.actionId));
  }, 60_000).unref?.();
}

function cancelAskpassAction(record) {
  if (!record) {
    return;
  }
  record.cancelled = true;
  closeAskpassAction(record);
}

function createAskpassPrompt({ connectorId, actionId, token, prompt }) {
  const record = getAskpassAction(connectorId, actionId, token);
  if (!record || record.closed || record.cancelled) {
    return null;
  }
  if (record.prompts.size >= record.maxPrompts) {
    cancelAskpassAction(record);
    return null;
  }

  const promptId = makeId();
  const entry = {
    promptId,
    connectorId,
    actionId,
    prompt: String(prompt || 'SSH authentication prompt').trim() || 'SSH authentication prompt',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    responseReady: false,
    response: '',
    cancelled: false,
  };
  record.prompts.set(promptId, entry);
  record.updatedAt = nowIso();
  return entry;
}

function getAskpassPrompt(record, promptId) {
  return record?.prompts?.get(promptId) || null;
}

function publicAskpassPrompt(prompt) {
  return {
    promptId: prompt.promptId,
    connectorId: prompt.connectorId,
    actionId: prompt.actionId,
    prompt: prompt.prompt,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
    status: prompt.cancelled ? 'cancelled' : prompt.responseReady ? 'answered' : 'pending',
  };
}

function getConnectorHost(connector) {
  if (!connector?.hostId) {
    return null;
  }
  const host = state.hosts.get(connector.hostId) || null;
  return host ? { ...host, online: hostOnline(host) } : null;
}

function connectorWithRelayAuth(connector) {
  if (!RELAY_AUTH_TOKEN) {
    return connector;
  }
  return {
    ...connector,
    relayAuthToken: RELAY_AUTH_TOKEN,
  };
}

function decorateConnectorForClient(connector, host = null) {
  const decorated = decorateConnector(connectorWithRelayAuth(connector), host);
  delete decorated.relayAuthToken;
  return decorated;
}

function decorateSingleConnector(connector) {
  const secret = state.connectorSecrets.get(connector.connectorId) || null;
  return {
    ...decorateConnectorForClient(connector, getConnectorHost(connector)),
    secretStatus: getConnectorSecretStatus(secret),
  };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || host.startsWith('127.');
}

function safeRelayOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || isLoopbackHost(url.hostname)) {
      return '';
    }
    return url.origin;
  } catch (_) {
    return '';
  }
}

function localRelayOrigin() {
  const candidates = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal || !entry.address) {
        continue;
      }
      candidates.push(entry.address);
    }
  }

  const preferred = candidates.find((address) => /^10\./.test(address))
    || candidates.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address))
    || candidates.find((address) => /^192\.168\./.test(address))
    || candidates[0];

  return preferred ? `http://${preferred}:${PORT}` : '';
}

function connectorWithActionRelayOrigin(connector, actionOrigin) {
  const origin = safeRelayOrigin(actionOrigin) || localRelayOrigin();
  if (!origin) {
    return connector;
  }

  try {
    const relayUrl = new URL(String(connector.relayUrl || ''));
    if (!connector.relayUrl || isLoopbackHost(relayUrl.hostname)) {
      return {
        ...connector,
        relayUrl: origin,
      };
    }
  } catch (_) {
    return {
      ...connector,
      relayUrl: origin,
    };
  }

  return connector;
}

function getConnectorList() {
  const hosts = new Map(getHostList().map((host) => [host.hostId, host]));
  return Array.from(state.connectors.values())
    .map((connector) => ({
      ...decorateConnectorForClient(connector, connector.hostId ? hosts.get(connector.hostId) || null : null),
      secretStatus: getConnectorSecretStatus(state.connectorSecrets.get(connector.connectorId) || null),
    }))
    .sort((a, b) => {
      const phaseDelta = String(a.runtime?.phaseLabel || '').localeCompare(String(b.runtime?.phaseLabel || ''));
      if (phaseDelta !== 0) {
        return phaseDelta;
      }
      return String(a.label || a.connectorId).localeCompare(String(b.label || b.connectorId));
    });
}

function limitOutput(existing, chunk, limit = 8000) {
  const next = `${existing}${chunk.toString('utf8')}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 15_000;
  const startedAt = nowIso();
  const input = options.input || null;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let child = null;

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        ...result,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        startedAt,
        completedAt: nowIso(),
      });
    }

    try {
      child = spawn(command, args, {
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ...(options.env || {}),
        },
      });
    } catch (error) {
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        error: error.message,
      });
      return;
    }

    if (input && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (child && !child.killed) {
        child.kill();
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = limitOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = limitOutput(stderr, chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        error: error.message,
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({
        exitCode,
        signal,
        timedOut,
        error: null,
      });
    });
  });
}

function connectorPasswordMethod(method) {
  return method === 'password' || method === 'keyboard_interactive';
}

function connectorOneTimeMethod(method) {
  return method === 'otp' || method === 'manual_captcha';
}

function connectorMethodCanUseAskpass(method) {
  return connectorPasswordMethod(method) || connectorOneTimeMethod(method);
}

function connectorMethodCovered(method, password, oneTimeCode, interactiveAskpass = false) {
  if (!requiresInteractiveAuth(method)) {
    return true;
  }
  if (interactiveAskpass && connectorMethodCanUseAskpass(method)) {
    return true;
  }
  if (method === 'browser_sso') {
    return false;
  }
  if (method === 'password') {
    return Boolean(password);
  }
  if (method === 'keyboard_interactive') {
    return Boolean(password || oneTimeCode);
  }
  if (connectorOneTimeMethod(method)) {
    return Boolean(oneTimeCode);
  }
  return false;
}

function connectorAskpassResponsesForMethod(method, password, oneTimeCode) {
  const responses = [];
  if ((method === 'password' || method === 'keyboard_interactive') && password) {
    responses.push(password);
  }
  if (
    (method === 'password'
      || method === 'keyboard_interactive'
      || connectorOneTimeMethod(method))
    && oneTimeCode
  ) {
    responses.push(oneTimeCode);
  }
  return responses;
}

function connectorAskpassResponses(connector, secret) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  const responses = [];

  if (connectorUsesGateway(connector) && connectorMethodCanUseAskpass(gatewayMethod)) {
    responses.push(...connectorAskpassResponsesForMethod(
      gatewayMethod,
      secret?.gatewayPassword || '',
      secret?.gatewayOtp || ''
    ));
  }

  if (connectorMethodCanUseAskpass(targetMethod)) {
    responses.push(...connectorAskpassResponsesForMethod(
      targetMethod,
      secret?.targetPassword || '',
      secret?.targetOtp || ''
    ));
  }

  return responses.filter(Boolean);
}

function connectorHasAskpassPromptableAuth(connector) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  return Boolean(
    (connectorUsesGateway(connector) && connectorMethodCanUseAskpass(gatewayMethod))
    || connectorMethodCanUseAskpass(targetMethod)
  );
}

function connectorPrefersKeyboardInteractive(connector) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  return [
    connectorUsesGateway(connector) ? gatewayMethod : '',
    targetMethod,
  ].some((method) => ['keyboard_interactive', 'otp', 'manual_captcha'].includes(method));
}

function connectorPreferredAuthentications(connector, secret) {
  if (!connectorUsesAskpass(connector, secret)) {
    return undefined;
  }
  return connectorPrefersKeyboardInteractive(connector)
    ? 'publickey,keyboard-interactive,password'
    : 'publickey,password,keyboard-interactive';
}

function connectorNeedsManualAuth(connector, secret) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  const gatewayNeedsSecret = connectorUsesGateway(connector) && requiresInteractiveAuth(gatewayMethod);
  const targetNeedsSecret = requiresInteractiveAuth(targetMethod);
  const gatewayCovered = connectorMethodCovered(
    gatewayMethod,
    secret?.gatewayPassword || '',
    secret?.gatewayOtp || '',
    Boolean(secret?.interactiveAskpass)
  );
  const targetCovered = connectorMethodCovered(
    targetMethod,
    secret?.targetPassword || '',
    secret?.targetOtp || '',
    Boolean(secret?.interactiveAskpass)
  );

  return (gatewayNeedsSecret && !gatewayCovered)
    || (targetNeedsSecret && !targetCovered);
}

function connectorUsesAskpass(connector, secret) {
  return connectorAskpassResponses(connector, secret).length > 0
    || (Boolean(secret?.interactiveAskpass) && connectorHasAskpassPromptableAuth(connector));
}

function ensureAskpassHelper() {
  const helperPath = path.join(process.cwd(), 'tmp', 'remote-codex-askpass.cmd');
  const helperScriptPath = path.join(process.cwd(), 'tmp', 'remote-codex-askpass.ps1');
  const psScript = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$promptText = [string]$env:RC_ASKPASS_PROMPT',
    'function Decode-B64([string]$value) {',
    '  if ([string]::IsNullOrWhiteSpace($value)) { return "" }',
    '  try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) } catch { return "" }',
    '}',
    'function Encode-Query([string]$value) {',
    '  return [uri]::EscapeDataString($value)',
    '}',
    'function Try-BrokerPrompt {',
    '  if ([string]::IsNullOrWhiteSpace($env:RC_ASKPASS_RELAY_URL) -or [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_CONNECTOR_ID) -or [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_ACTION_ID) -or [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_TOKEN)) { return $null }',
    '  $timeoutSeconds = 180',
    '  if ($env:RC_ASKPASS_TIMEOUT_SECONDS) { try { $timeoutSeconds = [Math]::Max(10, [int]$env:RC_ASKPASS_TIMEOUT_SECONDS) } catch {} }',
    '  $base = [string]$env:RC_ASKPASS_RELAY_URL',
    '  $headers = @{}',
    '  if (-not [string]::IsNullOrWhiteSpace($env:RC_RELAY_AUTH_TOKEN)) { $headers["Authorization"] = "Bearer $env:RC_RELAY_AUTH_TOKEN" }',
    '  $body = @{ connectorId = [string]$env:RC_ASKPASS_CONNECTOR_ID; actionId = [string]$env:RC_ASKPASS_ACTION_ID; token = [string]$env:RC_ASKPASS_TOKEN; prompt = $promptText } | ConvertTo-Json -Compress',
    '  try { $created = Invoke-RestMethod -Method Post -Uri "$base/api/askpass/prompts" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 8 } catch { exit 1 }',
    '  if (-not $created -or [string]::IsNullOrWhiteSpace([string]$created.promptId)) { exit 1 }',
    '  $promptId = [string]$created.promptId',
    '  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)',
    '  $query = "connectorId=$(Encode-Query $env:RC_ASKPASS_CONNECTOR_ID)&actionId=$(Encode-Query $env:RC_ASKPASS_ACTION_ID)&token=$(Encode-Query $env:RC_ASKPASS_TOKEN)"',
    '  while ([DateTime]::UtcNow -lt $deadline) {',
    '    try { $status = Invoke-RestMethod -Method Get -Uri "$base/api/askpass/prompts/$promptId`?$query" -Headers $headers -TimeoutSec 8 } catch { Start-Sleep -Milliseconds 700; continue }',
    '    if ($status.status -eq "answered") { [Console]::Out.Write([string]$status.response); exit 0 }',
    '    if ($status.status -eq "cancelled" -or $status.status -eq "closed") { exit 1 }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '  exit 1',
    '}',
    'Try-BrokerPrompt | Out-Null',
    '$index = 1',
    'if ($env:RC_ASKPASS_STATE_FILE -and (Test-Path -LiteralPath $env:RC_ASKPASS_STATE_FILE)) { try { $index = [int](Get-Content -LiteralPath $env:RC_ASKPASS_STATE_FILE -TotalCount 1) } catch { $index = 1 } }',
    'if ($index -lt 1) { $index = 1 }',
    '$nextIndex = $index + 1',
    'if ($env:RC_ASKPASS_STATE_FILE) { try { Set-Content -LiteralPath $env:RC_ASKPASS_STATE_FILE -Value ([string]$nextIndex) -NoNewline } catch {} }',
    '$b64 = [Environment]::GetEnvironmentVariable("RC_ASKPASS_PASSWORD_${index}_B64")',
    'if ([string]::IsNullOrWhiteSpace($b64)) { $b64 = $env:RC_ASKPASS_PASSWORD_LAST_B64 }',
    'if ([string]::IsNullOrWhiteSpace($b64)) { $b64 = $env:RC_ASKPASS_PASSWORD_1_B64 }',
    'if ($env:RC_ASKPASS_OTP_B64 -and $promptText -match "(?i)(otp|mfa|verification|authenticator|passcode|one[- _]?time|2fa|two[- _]?factor|totp|google|duo|challenge|token|code)") {',
    '  $b64 = $env:RC_ASKPASS_OTP_B64',
    '} elseif ($env:RC_ASKPASS_PASSWORD_PROMPT_B64 -and $promptText -match "(?i)password") {',
    '  $b64 = $env:RC_ASKPASS_PASSWORD_PROMPT_B64',
    '}',
    '$answer = Decode-B64 $b64',
    'if ([string]::IsNullOrWhiteSpace($answer)) { exit 1 }',
    '[Console]::Out.Write($answer)',
  ].join('\r\n');
  const script = [
    '@echo off',
    'setlocal EnableExtensions',
    'set "RC_ASKPASS_PROMPT=%*"',
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${helperScriptPath.replace(/"/g, '""')}"`,
  ].join('\r\n');
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(helperScriptPath, psScript, 'utf8');
  fs.writeFileSync(helperPath, script, 'utf8');
  return helperPath;
}

function base64Secret(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function buildAskpassEnv(connector, secret) {
  const responses = connectorAskpassResponses(connector, secret);
  const passwordResponses = [
    secret?.gatewayPassword || '',
    secret?.targetPassword || '',
  ].filter(Boolean);
  const otpResponses = [
    secret?.gatewayOtp || '',
    secret?.targetOtp || '',
  ].filter(Boolean);
  const firstResponse = responses[0] || '';
  const lastResponse = responses[responses.length - 1] || firstResponse;
  const statePath = path.join(process.cwd(), 'tmp', `askpass-state-${connector.connectorId || makeId()}.txt`);

  try {
    fs.rmSync(statePath, { force: true });
  } catch (_) {
    // Best effort. A stale state file only changes which response is tried first.
  }

  const env = {
    SSH_ASKPASS: ensureAskpassHelper(),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || 'remote-codex',
    RC_ASKPASS_STATE_FILE: statePath,
    RC_ASKPASS_PASSWORD_1_B64: base64Secret(firstResponse),
    RC_ASKPASS_PASSWORD_LAST_B64: base64Secret(lastResponse),
    RC_ASKPASS_PASSWORD_PROMPT_B64: base64Secret(passwordResponses[0] || ''),
    RC_ASKPASS_OTP_B64: base64Secret(otpResponses[0] || ''),
  };

  if (secret?.interactiveAskpass) {
    env.RC_ASKPASS_RELAY_URL = `http://127.0.0.1:${PORT}`;
    env.RC_ASKPASS_CONNECTOR_ID = connector.connectorId || secret.connectorId || '';
    env.RC_ASKPASS_ACTION_ID = secret.askpassActionId || '';
    env.RC_ASKPASS_TOKEN = secret.askpassToken || '';
    env.RC_ASKPASS_TIMEOUT_SECONDS = '180';
    if (RELAY_AUTH_TOKEN) {
      env.RC_RELAY_AUTH_TOKEN = RELAY_AUTH_TOKEN;
    }
  }

  responses.slice(0, 8).forEach((response, index) => {
    env[`RC_ASKPASS_PASSWORD_${index + 1}_B64`] = base64Secret(response);
  });

  return env;
}

function remoteShellPath(value) {
  const text = String(value || '~/mobile-codex-remote').trim() || '~/mobile-codex-remote';
  if (text.startsWith('~/')) {
    return `"$HOME/${text.slice(2).replace(/"/g, '\\"')}"`;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function remoteScpPath(value) {
  return String(value || '~/mobile-codex-remote').trim() || '~/mobile-codex-remote';
}

function remoteScpChildPath(base, child) {
  return `${remoteScpPath(base).replace(/\/+$/, '')}/${String(child || '').replace(/^\/+/, '')}`;
}

function makeRemoteDeploymentDirectory(connector) {
  const base = connector.bootstrap?.remoteDirectory || '~/mobile-codex-remote';
  const id = `deploy-${Date.now()}-${makeId().slice(0, 8)}`.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return remoteScpChildPath(base, `.deployments/${id}`);
}

function withConnectorRemoteDirectory(connector, remoteDirectory) {
  return {
    ...connector,
    bootstrap: {
      ...(connector.bootstrap || {}),
      remoteDirectory,
    },
  };
}

function localScpPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function buildSshMultiplexOptions(connector) {
  const safeId = String(connector?.connectorId || connector?.hostId || makeId())
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .slice(0, 48) || 'connector';
  const controlRoot = process.platform === 'win32'
    ? path.join('C:\\tmp', 'remote-codex-ssh-control')
    : path.join(process.cwd(), 'tmp', 'ssh-control');
  const controlPath = localScpPath(path.join(controlRoot, safeId));
  fs.mkdirSync(path.dirname(controlPath), { recursive: true });
  return {
    controlMaster: 'auto',
    controlPersist: '24h',
    controlPath,
    streamLocalBindUnlink: 'yes',
  };
}

function sshRunText(run) {
  return [
    run?.stdout,
    run?.stderr,
    run?.error,
    run?.message,
    run?.status,
  ].filter(Boolean).join('\n');
}

function isSshMultiplexSocketFailureText(text) {
  return /getsockname failed|not a socket|controlpath|controlmaster|mux_client|stale control socket/i.test(String(text || ''));
}

function isSshMultiplexSocketFailureStep(step) {
  return Boolean(step && (
    isSshMultiplexSocketFailureText(sshRunText(step))
    || (Number(step.exitCode) === 4294967295 && /unknown error|read from remote host/i.test(sshRunText(step)))
  ));
}

function deploymentHasSshMultiplexSocketFailure(deployment) {
  return Boolean(deployment?.steps?.some(isSshMultiplexSocketFailureStep));
}

function cleanupSshMultiplexOptions(sshOptions = {}) {
  if (!sshOptions.controlPath) {
    return;
  }
  try {
    fs.rmSync(sshOptions.controlPath, { force: true });
  } catch (_) {
    // Best effort: a failed cleanup should not hide the real SSH result.
  }
}

function connectorSshMultiplexDisabled(connector) {
  return state.sshMultiplexDisabled.get(connector?.connectorId || connector?.hostId || '') || null;
}

function disableConnectorSshMultiplex(connector, reason) {
  const key = connector?.connectorId || connector?.hostId || '';
  if (!key) {
    return;
  }
  state.sshMultiplexDisabled.set(key, {
    reason: reason || 'ControlMaster socket failure',
    disabledAt: nowIso(),
  });
}

function getConnectorSshOptions(connector, action, secret) {
  // Bootstrap now runs as one SSH tar stream, so ControlMaster is no longer on
  // the critical path for MFA-heavy hosts or Windows OpenSSH clients.
  void connector;
  void action;
  void secret;
  return {};
}

function buildScpCommandParts(connector, localSources, remoteDirectory, options = {}) {
  if (!connector.targetHost) {
    return null;
  }

  const args = ['-r'];
  if (options.connectTimeout) {
    args.push('-o', `ConnectTimeout=${options.connectTimeout}`);
  }
  if (options.strictHostKeyChecking) {
    args.push('-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`);
  }
  if (options.numberOfPasswordPrompts) {
    args.push('-o', `NumberOfPasswordPrompts=${Math.max(1, Number(options.numberOfPasswordPrompts) || 1)}`);
  }
  if (options.preferredAuthentications) {
    args.push('-o', `PreferredAuthentications=${options.preferredAuthentications}`);
  }
  if (options.controlMaster) {
    args.push('-o', `ControlMaster=${options.controlMaster}`);
  }
  if (options.controlPersist) {
    args.push('-o', `ControlPersist=${options.controlPersist}`);
  }
  if (options.controlPath) {
    args.push('-o', `ControlPath=${options.controlPath}`);
  }
  if (options.streamLocalBindUnlink) {
    args.push('-o', `StreamLocalBindUnlink=${options.streamLocalBindUnlink}`);
  }
  if (connector.auth?.keyPath) {
    args.push('-i', connector.auth.keyPath);
    args.push('-o', 'IdentitiesOnly=yes');
    args.push('-o', 'IdentityAgent=none');
  }

  const gateway = connector.gateway || {};
  const gatewayTarget = connectorUsesGateway(connector) && (gateway.proxyJump
    || (
      gateway.host
        ? `${gateway.username || connector.username ? `${gateway.username || connector.username}@` : ''}${gateway.host}${gateway.port ? `:${gateway.port}` : ''}`
        : ''
    ));

  if (gatewayTarget) {
    args.push('-o', `ProxyJump=${gatewayTarget}`);
  }
  if (connector.targetPort && Number(connector.targetPort) !== 22) {
    args.push('-P', String(connector.targetPort));
  }

  const target = `${connector.username ? `${connector.username}@` : ''}${connector.targetHost}`;
  args.push(...localSources, `${target}:${remoteScpPath(remoteDirectory).replace(/\/+$/, '')}/`);
  return {
    command: 'scp',
    args,
  };
}

function normalizeTarPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function writeTarString(buffer, offset, length, value) {
  const text = Buffer.from(String(value || ''), 'utf8');
  text.copy(buffer, offset, 0, Math.min(text.length, length));
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, '0').slice(-(length - 1));
  writeTarString(buffer, offset, length, `${text}\0`);
}

function splitTarName(name) {
  if (Buffer.byteLength(name) <= 100) {
    return { name, prefix: '' };
  }

  const parts = name.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const suffix = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`tar path is too long: ${name}`);
}

function createTarHeader(name, stats, size, typeFlag = '0') {
  const header = Buffer.alloc(512, 0);
  const splitName = splitTarName(name);
  writeTarString(header, 0, 100, splitName.name);
  writeTarOctal(header, 100, 8, stats?.mode ? stats.mode & 0o777 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor((stats?.mtimeMs || Date.now()) / 1000));
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, typeFlag);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  writeTarString(header, 345, 155, splitName.prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function collectTarEntries(sourcePath, archivePath, entries) {
  const stats = fs.statSync(sourcePath);
  const normalizedArchivePath = normalizeTarPath(archivePath);
  if (!normalizedArchivePath) {
    return;
  }

  if (stats.isDirectory()) {
    entries.push({
      type: 'directory',
      sourcePath,
      archivePath: `${normalizedArchivePath.replace(/\/+$/, '')}/`,
      stats,
    });
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      collectTarEntries(
        path.join(sourcePath, entry.name),
        `${normalizedArchivePath}/${entry.name}`,
        entries
      );
    }
    return;
  }

  if (stats.isFile()) {
    entries.push({
      type: 'file',
      sourcePath,
      archivePath: normalizedArchivePath,
      stats,
    });
  }
}

function createTarArchive(localSources) {
  const tarSources = (localSources || []).map((source) => String(source || '').trim()).filter(Boolean);
  if (tarSources.length > 0) {
    const systemTar = spawnSync('tar', ['-cf', '-', ...tarSources], {
      cwd: process.cwd(),
      encoding: null,
      maxBuffer: 1024 * 1024 * 768,
      windowsHide: true,
    });
    if (systemTar.status === 0 && systemTar.stdout?.length) {
      return systemTar.stdout;
    }
  }

  const entries = [];
  for (const source of tarSources) {
    const sourceText = String(source || '');
    const sourcePath = path.resolve(process.cwd(), sourceText);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`local source does not exist: ${source}`);
    }
    const archivePath = path.isAbsolute(sourceText)
      ? path.basename(sourcePath)
      : normalizeTarPath(sourceText);
    collectTarEntries(sourcePath, archivePath || path.basename(sourcePath), entries);
  }

  const chunks = [];
  for (const entry of entries) {
    if (entry.type === 'directory') {
      chunks.push(createTarHeader(entry.archivePath, entry.stats, 0, '5'));
      continue;
    }
    const data = fs.readFileSync(entry.sourcePath);
    chunks.push(createTarHeader(entry.archivePath, entry.stats, data.length, '0'));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) {
      chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function buildRemoteTarExtractCommand(remoteDirectory, afterCommand = '') {
  const remoteDir = remoteShellPath(remoteDirectory);
  const commands = [
    `mkdir -p ${remoteDir}`,
    `cd ${remoteDir}`,
  ];
  commands.push('tar -xf -');
  if (afterCommand) {
    commands.push(afterCommand);
  }
  return commands.join(' && ');
}

async function runSshTarExtract(connector, secret, localSources, remoteDirectory, afterCommand, stepName, timeoutMs, sshOptions = {}) {
  const archive = createTarArchive(localSources);
  const commandParts = buildConnectorSshActionCommand(
    connector,
    buildRemoteTarExtractCommand(remoteDirectory, afterCommand),
    secret,
    'bootstrap',
    sshOptions
  );
  if (!commandParts) {
    return {
      ok: false,
      status: `${stepName || 'tar_extract'}_not_ready`,
      message: 'Connector does not have enough SSH information to upload files over SSH.',
      step: null,
    };
  }
  const run = await runProcess(commandParts.command, commandParts.args, {
    timeoutMs: authAwareTimeout(timeoutMs || 90_000, secret),
    env: connectorUsesAskpass(connector, secret) ? buildAskpassEnv(connector, secret) : null,
    input: archive,
  });
  return {
    ok: run.exitCode === 0,
    status: run.exitCode === 0 ? 'uploaded' : 'upload_failed',
    message: run.exitCode === 0 ? 'Files uploaded over a single SSH stream.' : 'Unable to upload files over SSH.',
    step: { name: stepName || 'ssh_tar_upload', ...run },
  };
}

function getLocalNodeRuntimeArchive() {
  const archiveName = 'node-v16.20.2-linux-x64.tar.xz';
  const archivePath = path.join(process.cwd(), 'tmp', archiveName);
  if (!fs.existsSync(archivePath)) {
    return null;
  }
  return {
    archiveName,
    localPath: localScpPath(path.relative(process.cwd(), archivePath)),
  };
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function getLocalCodexLinuxSourceDir() {
  const override = String(process.env.CODEX_LINUX_RUNTIME_DIR || '').trim();
  if (override && fs.existsSync(path.join(override, 'codex'))) {
    return path.resolve(override);
  }

  const cursorExtensions = path.join(os.homedir(), '.cursor', 'extensions');
  if (!fs.existsSync(cursorExtensions)) {
    return null;
  }

  const extensionDirs = fs.readdirSync(cursorExtensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const entry of extensionDirs) {
    const binDir = path.join(cursorExtensions, entry, 'bin', 'linux-x86_64');
    if (fs.existsSync(path.join(binDir, 'codex'))) {
      return binDir;
    }
  }

  return null;
}

function stageLocalCodexLinuxRuntime() {
  const sourceDir = getLocalCodexLinuxSourceDir();
  if (!sourceDir) {
    return null;
  }

  const sourceCodex = path.join(sourceDir, 'codex');
  const codexStat = fs.statSync(sourceCodex);
  const tmpRoot = path.resolve(process.cwd(), 'tmp');
  const stageDir = path.join(tmpRoot, 'codex-linux-x86_64');
  const markerPath = path.join(stageDir, '.source.json');
  const marker = {
    sourceDir,
    codexSize: codexStat.size,
    codexMtimeMs: Math.trunc(codexStat.mtimeMs),
  };

  let staged = false;
  try {
    const current = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    staged = current.sourceDir === marker.sourceDir
      && current.codexSize === marker.codexSize
      && current.codexMtimeMs === marker.codexMtimeMs
      && fs.existsSync(path.join(stageDir, 'codex'));
  } catch {
    staged = false;
  }

  if (!staged) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    for (const name of ['codex', 'rg', 'codex-resources']) {
      const sourcePath = path.join(sourceDir, name);
      const targetPath = path.join(stageDir, name);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) {
        copyDirectoryRecursive(sourcePath, targetPath);
      } else if (stats.isFile()) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }

  const localSources = ['codex', 'rg', 'codex-resources']
    .map((name) => path.join(stageDir, name))
    .filter((sourcePath) => fs.existsSync(sourcePath))
    .map((sourcePath) => localScpPath(path.relative(process.cwd(), sourcePath)));

  return {
    sourceDir,
    stageDir,
    localSources,
  };
}

function buildSshActionOptions(connector, action, secret) {
  const useAskpass = connectorUsesAskpass(connector, secret);
  const options = {
    connectTimeout: action === 'bootstrap' ? 12 : 8,
    disableTty: true,
    strictHostKeyChecking: 'accept-new',
  };

  if (useAskpass) {
    options.preferredAuthentications = connectorPreferredAuthentications(connector, secret);
    options.numberOfPasswordPrompts = 6;
  } else {
    options.batchMode = true;
  }

  return options;
}

function authAwareTimeout(baseMs, secret) {
  return secret?.interactiveAskpass ? Math.max(baseMs, 180_000) : baseMs;
}

function buildRemotePrepareCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `mkdir -p ${remoteDir}`,
    `test -d ${remoteDir}`,
    'echo CODEX_REMOTE_AGENT_DIR_READY',
  ].join(' && ');
}

function buildRemoteDeploymentCheckCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `test -f ${remoteDir}/apps/host-agent/agent.js && echo CODEX_REMOTE_CHECK_AGENT=ok || echo CODEX_REMOTE_CHECK_AGENT=missing`,
    `test -f ${remoteDir}/shared/protocol.js && echo CODEX_REMOTE_CHECK_SHARED=ok || echo CODEX_REMOTE_CHECK_SHARED=missing`,
    `NODE_BIN="$(command -v node || command -v nodejs || test -x ${remoteDir}/.runtime/node/bin/node && printf '%s\\n' ${remoteDir}/.runtime/node/bin/node || true)"`,
    'test -n "$NODE_BIN" && echo CODEX_REMOTE_CHECK_NODE=$NODE_BIN || echo CODEX_REMOTE_CHECK_NODE=missing',
    'test -n "$NODE_BIN" && "$NODE_BIN" -v 2>/dev/null || true',
    `CODEX_BIN="$(command -v codex || test -x ${remoteDir}/.runtime/codex/codex && printf '%s\\n' ${remoteDir}/.runtime/codex/codex || true)"`,
    'test -n "$CODEX_BIN" && echo CODEX_REMOTE_CHECK_CODEX=$CODEX_BIN || echo CODEX_REMOTE_CHECK_CODEX=missing',
    'command -v tmux >/dev/null && echo CODEX_REMOTE_CHECK_TMUX=$(command -v tmux) || echo CODEX_REMOTE_CHECK_TMUX=missing',
    'tmux -V 2>/dev/null || true',
    `test -f ${remoteDir}/apps/host-agent/agent.js && test -f ${remoteDir}/shared/protocol.js && test -n "$NODE_BIN" && test -n "$CODEX_BIN" && command -v tmux >/dev/null && echo CODEX_REMOTE_AGENT_DEPLOYED`,
  ].join('; ');
}

function buildRemoteBundleCheckCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `test -f ${remoteDir}/apps/host-agent/agent.js && echo CODEX_REMOTE_CHECK_AGENT=ok || echo CODEX_REMOTE_CHECK_AGENT=missing`,
    `test -f ${remoteDir}/shared/protocol.js && echo CODEX_REMOTE_CHECK_SHARED=ok || echo CODEX_REMOTE_CHECK_SHARED=missing`,
    `test -f ${remoteDir}/apps/host-agent/agent.js && test -f ${remoteDir}/shared/protocol.js && echo CODEX_REMOTE_BUNDLE_DEPLOYED`,
  ].join('; ');
}

function buildRemoteNodeProbeCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `NODE_BIN="$(command -v node || command -v nodejs || test -x ${remoteDir}/.runtime/node/bin/node && printf '%s\\n' ${remoteDir}/.runtime/node/bin/node || true)"`,
    'test -n "$NODE_BIN" && echo CODEX_REMOTE_NODE_PRESENT=$NODE_BIN || echo CODEX_REMOTE_NODE_MISSING',
  ].join('; ');
}

function buildRemoteCodexProbeCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  const codexHome = remoteShellPath(connector.codexHome || '~/.codex');
  return [
    `REMOTE_CODEX_DIR=${remoteDir}`,
    `CODEX_HOME_DIR=${codexHome}`,
    'CODEX_BIN="$(command -v codex 2>/dev/null || true)"',
    'if [ -z "$CODEX_BIN" ]; then',
    '  for p in "$REMOTE_CODEX_DIR/.runtime/codex/codex" "$CODEX_HOME_DIR/bin/codex" "$CODEX_HOME_DIR/codex" "$CODEX_HOME_DIR/node_modules/.bin/codex"; do',
    '    if [ -x "$p" ]; then CODEX_BIN="$p"; break; fi',
    '  done',
    'fi',
    'if [ -z "$CODEX_BIN" ] && [ -d "$CODEX_HOME_DIR" ]; then',
    '  CODEX_BIN="$(find "$CODEX_HOME_DIR" -maxdepth 5 -type f \\( -name codex -o -name codex.exe -o -name "codex-*" \\) -perm -111 2>/dev/null | head -n 1 || true)"',
    'fi',
    'if [ -z "$CODEX_BIN" ]; then',
    '  for root in "$HOME/.local/bin" "$HOME/bin" "$HOME/.npm-global/bin" "$HOME/.conda/envs" "$HOME/miniconda3/envs" "$HOME/anaconda3/envs" "$HOME/mambaforge/envs" "$HOME/.micromamba/envs" "$HOME/.nvm/versions/node"; do',
    '    if [ -x "$root/codex" ]; then CODEX_BIN="$root/codex"; break; fi',
    '    if [ -d "$root" ]; then',
    '      CODEX_BIN="$(find "$root" -maxdepth 5 -type f \\( -name codex -o -name codex.exe -o -name "codex-*" \\) -perm -111 2>/dev/null | head -n 1 || true)"',
    '      if [ -n "$CODEX_BIN" ]; then break; fi',
    '    fi',
    '  done',
    'fi',
    'test -n "$CODEX_BIN" && echo CODEX_REMOTE_CODEX_PRESENT=$CODEX_BIN || echo CODEX_REMOTE_CODEX_MISSING',
  ].join('\n');
}

function buildRemoteRuntimePrepareCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return `mkdir -p ${remoteDir}/.runtime && echo CODEX_REMOTE_RUNTIME_DIR_READY`;
}

function buildRemoteCodexRuntimePrepareCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return `mkdir -p ${remoteDir}/.runtime/codex && echo CODEX_REMOTE_CODEX_RUNTIME_DIR_READY`;
}

function buildRemoteRuntimeExtractCommand(connector, archiveName) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  const archive = String(archiveName || '').replace(/'/g, '');
  return [
    `mkdir -p ${remoteDir}/.runtime/node`,
    `tar -xJf ${remoteDir}/.runtime/${archive} -C ${remoteDir}/.runtime/node --strip-components=1`,
    `test -x ${remoteDir}/.runtime/node/bin/node`,
    `${remoteDir}/.runtime/node/bin/node -v`,
    'echo CODEX_REMOTE_NODE_RUNTIME_READY',
  ].join(' && ');
}

function buildRemoteCodexRuntimeVerifyCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `chmod +x ${remoteDir}/.runtime/codex/codex ${remoteDir}/.runtime/codex/rg ${remoteDir}/.runtime/codex/codex-resources/bwrap 2>/dev/null || true`,
    `test -x ${remoteDir}/.runtime/codex/codex`,
    `CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}" ${remoteDir}/.runtime/codex/codex --help >/dev/null`,
    `echo CODEX_REMOTE_CODEX_RUNTIME_READY=${remoteDir}/.runtime/codex/codex`,
  ].join(' && ');
}

function shellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function buildRemoteCodexResolutionScript(connector, codexRuntimeIncluded) {
  const codexHome = remoteShellPath(connector.codexHome || '~/.codex');
  const lines = [
    `CODEX_HOME_DIR=${codexHome}`,
    'CODEX_BIN="$(command -v codex 2>/dev/null || true)"',
    'if [ -z "$CODEX_BIN" ]; then',
    '  for p in "$CODEX_HOME_DIR/bin/codex" "$CODEX_HOME_DIR/codex" "$CODEX_HOME_DIR/bin/codex-x86_64-unknown-linux-musl" "$CODEX_HOME_DIR/bin/codex-x86_64-unknown-linux-gnu" "$CODEX_HOME_DIR/node_modules/.bin/codex"; do',
    '    if [ -x "$p" ]; then CODEX_BIN="$p"; break; fi',
    '  done',
    'fi',
    'if [ -z "$CODEX_BIN" ] && [ -d "$CODEX_HOME_DIR" ]; then',
    '  CODEX_BIN="$(find "$CODEX_HOME_DIR" -maxdepth 5 -type f \\( -name codex -o -name "codex-*" -o -name codex.exe \\) -perm -111 2>/dev/null | head -n 1 || true)"',
    'fi',
    'if [ -z "$CODEX_BIN" ]; then',
    '  for root in "$HOME/.local/bin" "$HOME/bin" "$HOME/.npm-global/bin" "$HOME/.conda/envs" "$HOME/miniconda3/envs" "$HOME/anaconda3/envs" "$HOME/mambaforge/envs" "$HOME/.micromamba/envs" "$HOME/.nvm/versions/node"; do',
    '    if [ -x "$root/codex" ]; then CODEX_BIN="$root/codex"; break; fi',
    '    if [ -d "$root" ]; then',
    '      CODEX_BIN="$(find "$root" -maxdepth 5 -type f \\( -name codex -o -name codex.exe -o -name "codex-*" \\) -perm -111 2>/dev/null | head -n 1 || true)"',
    '      if [ -n "$CODEX_BIN" ]; then break; fi',
    '    fi',
    '  done',
    'fi',
  ];

  if (codexRuntimeIncluded) {
    lines.push(
      'if [ -z "$CODEX_BIN" ] && [ -f "tmp/codex-linux-x86_64/codex" ]; then',
      '  mkdir -p .runtime/codex',
      '  cp -R "tmp/codex-linux-x86_64/." .runtime/codex/',
      '  chmod +x .runtime/codex/codex .runtime/codex/rg .runtime/codex/codex-resources/bwrap 2>/dev/null || true',
      '  if [ -x .runtime/codex/codex ]; then CODEX_BIN="$PWD/.runtime/codex/codex"; fi',
      'fi'
    );
  }

  return lines.join('\n');
}

function buildRemoteOneShotBootstrapCommand(connector, action, payload = {}) {
  const nodeArchive = String(payload.nodeArchiveName || '').replace(/'/g, '');
  const bootstrapCommand = buildDetachedBootstrapCommand(connector, { restart: action === 'restart' });
  const script = [
    'echo CODEX_REMOTE_AGENT_DIR_READY',
    'test -f apps/host-agent/agent.js && echo CODEX_REMOTE_CHECK_AGENT=ok || { echo CODEX_REMOTE_CHECK_AGENT=missing; exit 70; }',
    'test -f shared/protocol.js && echo CODEX_REMOTE_CHECK_SHARED=ok || { echo CODEX_REMOTE_CHECK_SHARED=missing; exit 71; }',
    'echo CODEX_REMOTE_BUNDLE_DEPLOYED',
    'NODE_BIN="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"',
    'if [ -z "$NODE_BIN" ] && [ -x .runtime/node/bin/node ]; then NODE_BIN="$PWD/.runtime/node/bin/node"; fi',
    nodeArchive
      ? [
        'if [ -z "$NODE_BIN" ] && [ -f "tmp/' + nodeArchive + '" ]; then',
        '  mkdir -p .runtime/node',
        '  tar -xJf "tmp/' + nodeArchive + '" -C .runtime/node --strip-components=1',
        '  if [ -x .runtime/node/bin/node ]; then NODE_BIN="$PWD/.runtime/node/bin/node"; fi',
        '  test -n "$NODE_BIN" && echo CODEX_REMOTE_NODE_RUNTIME_READY',
        'fi',
      ].join('\n')
      : 'true',
    'test -n "$NODE_BIN" && echo "CODEX_REMOTE_CHECK_NODE=$NODE_BIN" || { echo CODEX_REMOTE_CHECK_NODE=missing; exit 72; }',
    '"$NODE_BIN" -v 2>/dev/null || true',
    buildRemoteCodexResolutionScript(connector, Boolean(payload.codexRuntimeIncluded)),
    'test -n "$CODEX_BIN" && echo "CODEX_REMOTE_CHECK_CODEX=$CODEX_BIN" || { echo CODEX_REMOTE_CHECK_CODEX=missing; exit 73; }',
    '"$CODEX_BIN" --help >/dev/null 2>&1 && echo CODEX_REMOTE_CODEX_HELP_OK || echo CODEX_REMOTE_CODEX_HELP_WARNING',
    'command -v tmux >/dev/null && echo CODEX_REMOTE_CHECK_TMUX=$(command -v tmux) || { echo CODEX_REMOTE_CHECK_TMUX=missing; exit 74; }',
    bootstrapCommand,
    'echo CODEX_REMOTE_ONESHOT_BOOTSTRAP_DONE',
  ].filter(Boolean).join('\n');

  return `sh -lc ${shellSingleQuote(script)}`;
}

function collectOneShotBootstrapSources() {
  const sources = ['apps', 'shared', 'package.json'];
  const nodeRuntime = getLocalNodeRuntimeArchive();
  if (nodeRuntime) {
    sources.push(nodeRuntime.localPath);
  }

  const codexRuntime = stageLocalCodexLinuxRuntime();
  if (codexRuntime?.localSources?.length) {
    sources.push(...codexRuntime.localSources);
  }

  return {
    sources,
    nodeArchiveName: nodeRuntime?.archiveName || '',
    codexRuntimeIncluded: Boolean(codexRuntime?.localSources?.length),
  };
}

function classifyOneShotBootstrapFailure(action, step) {
  const text = sshRunText(step);
  if (step?.timedOut) {
    return { status: 'timeout', message: 'SSH one-shot bootstrap timed out.' };
  }
  if (step?.error) {
    return { status: 'error', message: step.error };
  }
  if (/CODEX_REMOTE_CHECK_AGENT=missing|CODEX_REMOTE_CHECK_SHARED=missing/.test(text)) {
    return { status: 'verify_failed', message: 'Remote bundle uploaded, but the host-agent files did not verify.' };
  }
  if (/CODEX_REMOTE_CHECK_NODE=missing/.test(text)) {
    return { status: 'node_runtime_missing', message: 'No usable Node runtime was found or uploaded for the remote host.' };
  }
  if (/CODEX_REMOTE_CHECK_CODEX=missing/.test(text)) {
    return { status: 'codex_runtime_missing', message: 'No usable Codex CLI was found in PATH, CODEX_HOME, common conda/nvm locations, or the uploaded runtime.' };
  }
  if (/CODEX_REMOTE_CHECK_TMUX=missing/.test(text)) {
    return { status: 'tmux_missing', message: 'tmux is required to keep the remote host-agent alive, but it was not found.' };
  }
  if (/permission denied/i.test(text)) {
    return { status: 'ssh_failed', message: 'SSH authentication or remote permissions failed during one-shot bootstrap.' };
  }
  return {
    status: action === 'restart' ? 'restart_failed' : 'bootstrap_failed',
    message: action === 'restart'
      ? 'Remote host-agent restart failed during one-shot bootstrap.'
      : 'Remote host-agent bootstrap failed during one-shot bootstrap.',
  };
}

async function runConnectorBootstrapOneShot(connector, action, secret) {
  const remoteDirectory = makeRemoteDeploymentDirectory(connector);
  const deploymentConnector = withConnectorRemoteDirectory(connector, remoteDirectory);
  let payload;
  try {
    payload = collectOneShotBootstrapSources();
  } catch (error) {
    return {
      ok: false,
      status: 'local_runtime_stage_failed',
      message: `Unable to prepare the local one-shot bootstrap payload: ${error.message}`,
      remoteDirectory,
      connector: deploymentConnector,
      steps: [],
    };
  }

  const remoteCommand = buildRemoteOneShotBootstrapCommand(deploymentConnector, action, payload);
  let upload;
  try {
    upload = await runSshTarExtract(
      deploymentConnector,
      secret,
      payload.sources,
      remoteDirectory,
      remoteCommand,
      'oneshot_bootstrap',
      600_000,
      {}
    );
  } catch (error) {
    return {
      ok: false,
      status: 'local_archive_failed',
      message: `Unable to build the local one-shot bootstrap archive: ${error.message}`,
      remoteDirectory,
      connector: deploymentConnector,
      steps: [],
      payload: {
        nodeRuntimeIncluded: Boolean(payload.nodeArchiveName),
        codexRuntimeIncluded: payload.codexRuntimeIncluded,
      },
    };
  }
  const steps = upload.step ? [upload.step] : [];
  const ok = upload.ok && upload.step?.stdout?.includes('CODEX_REMOTE_AGENT_BOOTSTRAPPED');
  const classification = ok
    ? {
      status: action === 'restart' ? 'restarted' : 'bootstrapped',
      message: action === 'restart'
        ? 'Remote host-agent restarted with a single SSH bootstrap stream.'
        : 'Remote host-agent bootstrapped with a single SSH stream.',
    }
    : classifyOneShotBootstrapFailure(action, upload.step || upload);

  return {
    ok,
    ...classification,
    remoteDirectory,
    connector: deploymentConnector,
    command: decorateSingleConnector(deploymentConnector).plan.sshBootstrapCommand,
    step: upload.step || null,
    steps,
    payload: {
      nodeRuntimeIncluded: Boolean(payload.nodeArchiveName),
      codexRuntimeIncluded: payload.codexRuntimeIncluded,
    },
  };
}

function buildRemoteDiagnosticCommand(connector = null) {
  const remoteDir = remoteShellPath(connector?.bootstrap?.remoteDirectory);
  const script = [
    'echo CODEX_REMOTE_DIAG_BEGIN',
    'echo SHELL=$SHELL',
    'echo HOME=$HOME',
    `REMOTE_CODEX_DIR=${remoteDir}/.runtime/codex`,
    'uname -a || true',
    'echo --commands--',
    'for c in codex codex.exe node nodejs npm tmux conda module ml; do type "$c" 2>&1 || true; done',
    'echo --codex-paths--',
    'for d in "$REMOTE_CODEX_DIR" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.cursor/extensions" "$HOME/.conda/envs" "$HOME/.nvm/versions/node" "$HOME/.local/bin" "$HOME/bin"; do [ -d "$d" ] && timeout 6s find "$d" -maxdepth 5 -type f \\( -name "codex" -o -name "codex.exe" -o -name "codex-*" \\) -perm -111 2>/dev/null; done | head -80 || true',
    'echo --codex-home-top--',
    'ls -la "${CODEX_HOME:-$HOME/.codex}" 2>/dev/null | head -80 || true',
    'echo --node-paths--',
    'ls -1 /usr/bin/node* /usr/local/bin/node* /opt/*/bin/node* /hpc/*/*/bin/node* 2>/dev/null | head -80 || true',
    'echo --module-node--',
    'module avail node 2>&1 | head -80 || true',
    'echo --module-js--',
    'module avail 2>&1 | grep -i -E "node|javascript|js" | head -80 || true',
    'echo --conda-envs--',
    'conda env list 2>/dev/null | head -80 || true',
    'echo CODEX_REMOTE_DIAG_END',
  ].join('\n');
  return `bash -lc ${shellSingleQuote(script)}`;
}

function buildRemoteAgentLogCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return `cd ${remoteDir} && tail -n 160 codex-remote.agent.log 2>/dev/null || true`;
}

function buildConnectorSshActionCommand(connector, remoteCommand, secret, action = 'bootstrap', sshOptions = {}) {
  return buildSshCommandParts(connector, {
    ...buildSshActionOptions(connector, action, secret),
    ...(sshOptions || {}),
    remoteCommand,
  });
}

function buildConnectorAction(connector, action, secret = null, sshOptions = {}) {
  const baseOptions = buildSshActionOptions(connector, action, secret);
  const env = connectorUsesAskpass(connector, secret)
    ? buildAskpassEnv(connector, secret)
    : null;

  if (action === 'smoke_test') {
    return {
      timeoutMs: authAwareTimeout(12_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: 'echo SSH_OK',
      }),
      displayCommand: decorateSingleConnector(connector).plan.sshSmokeTestCommand,
      env,
    };
  }

  if (action === 'status') {
    return {
      timeoutMs: authAwareTimeout(12_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: buildRemoteStatusCommand(connector),
      }),
      displayCommand: decorateSingleConnector(connector).plan.sshStatusCommand,
      env,
    };
  }

  if (action === 'diagnose') {
    return {
      timeoutMs: authAwareTimeout(20_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: buildRemoteDiagnosticCommand(connector),
      }),
      displayCommand: 'remote environment diagnostic',
      env,
    };
  }

  if (action === 'logs') {
    return {
      timeoutMs: authAwareTimeout(12_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: buildRemoteAgentLogCommand(connector),
      }),
      displayCommand: 'remote host-agent logs',
      env,
    };
  }

  if (action === 'bootstrap') {
    const remoteCommand = buildDetachedBootstrapCommand(connector);
    return {
      timeoutMs: authAwareTimeout(20_000, secret),
      commandParts: remoteCommand
        ? buildSshCommandParts(connector, {
          ...baseOptions,
          ...(sshOptions || {}),
          remoteCommand,
        })
        : null,
      displayCommand: decorateSingleConnector(connector).plan.sshBootstrapCommand,
      remoteCommand,
      env,
    };
  }

  if (action === 'restart') {
    const remoteCommand = buildDetachedBootstrapCommand(connector, { restart: true });
    return {
      timeoutMs: authAwareTimeout(20_000, secret),
      commandParts: remoteCommand
        ? buildSshCommandParts(connector, {
          ...baseOptions,
          ...(sshOptions || {}),
          remoteCommand,
        })
        : null,
      displayCommand: decorateSingleConnector(connector).plan.sshBootstrapCommand,
      remoteCommand,
      env,
    };
  }

  return null;
}

async function deployConnectorBundle(connector, secret, sshOptions = {}) {
  const useAskpass = connectorUsesAskpass(connector, secret);
  const makeEnv = () => (useAskpass ? buildAskpassEnv(connector, secret) : null);
  const remoteDirectory = makeRemoteDeploymentDirectory(connector);
  const deploymentConnector = withConnectorRemoteDirectory(connector, remoteDirectory);
  const upload = await runSshTarExtract(
    deploymentConnector,
    secret,
    ['apps', 'shared', 'package.json'],
    remoteDirectory,
    [
      'echo CODEX_REMOTE_AGENT_DIR_READY',
      buildRemoteBundleCheckCommand(deploymentConnector),
    ].join(' && '),
    'upload_bundle',
    120_000,
    sshOptions
  );
  const steps = [];
  if (upload.step) {
    steps.push(upload.step);
  }
  if (!upload.ok) {
    return {
      ok: false,
      status: upload.status,
      message: 'Unable to upload the host-agent bundle over SSH.',
      steps,
    };
  }
  if (!upload.step.stdout.includes('CODEX_REMOTE_AGENT_DIR_READY')) {
    return {
      ok: false,
      status: 'remote_directory_failed',
      message: 'Unable to create or verify the remote agent directory.',
      steps,
    };
  }

  const nodeRuntime = await ensureRemoteNodeRuntime(deploymentConnector, secret, remoteDirectory, makeEnv, steps, sshOptions);
  if (!nodeRuntime.ok) {
    return nodeRuntime;
  }

  const codexRuntime = await ensureRemoteCodexRuntime(deploymentConnector, secret, remoteDirectory, makeEnv, steps, sshOptions);
  if (!codexRuntime.ok) {
    return codexRuntime;
  }

  if (!upload.step.stdout.includes('CODEX_REMOTE_CHECK_AGENT=ok')
    || !upload.step.stdout.includes('CODEX_REMOTE_CHECK_SHARED=ok')
    || !upload.step.stdout.includes('CODEX_REMOTE_BUNDLE_DEPLOYED')) {
    return {
      ok: false,
      status: 'verify_failed',
      message: 'Remote bundle uploaded, but verification failed.',
      steps,
    };
  }

  const checkCommandParts = buildConnectorSshActionCommand(deploymentConnector, buildRemoteDeploymentCheckCommand(deploymentConnector), secret, 'bootstrap', sshOptions);
  if (!checkCommandParts) {
    return {
      ok: false,
      status: 'verify_not_ready',
      message: 'Connector does not have enough SSH information to verify the deployed runtime.',
      steps,
    };
  }
  const check = await runProcess(checkCommandParts.command, checkCommandParts.args, {
    timeoutMs: authAwareTimeout(30_000, secret),
    env: makeEnv(),
  });
  steps.push({ name: 'verify_deployment', ...check });
  if (check.exitCode !== 0 || !check.stdout.includes('CODEX_REMOTE_AGENT_DEPLOYED')) {
    return {
      ok: false,
      status: 'verify_failed',
      message: 'Remote bundle and runtime uploaded, but final verification failed.',
      steps,
    };
  }

  return {
    ok: true,
    status: 'deployed',
    message: 'Remote host-agent bundle is deployed and verified.',
    remoteDirectory,
    connector: deploymentConnector,
    steps,
  };
}

async function ensureRemoteNodeRuntime(connector, secret, remoteDirectory, makeEnv, steps, sshOptions = {}) {
  const probeCommandParts = buildConnectorSshActionCommand(connector, buildRemoteNodeProbeCommand(connector), secret, 'bootstrap', sshOptions);
  if (!probeCommandParts) {
    return {
      ok: false,
      status: 'node_probe_not_ready',
      message: 'Connector does not have enough SSH information to check the remote Node runtime.',
      steps,
    };
  }

  const probe = await runProcess(probeCommandParts.command, probeCommandParts.args, {
    timeoutMs: authAwareTimeout(15_000, secret),
    env: makeEnv(),
  });
  steps.push({ name: 'probe_node_runtime', ...probe });
  if (probe.exitCode === 0 && probe.stdout.includes('CODEX_REMOTE_NODE_PRESENT=')) {
    return { ok: true };
  }

  const archive = getLocalNodeRuntimeArchive();
  if (!archive) {
    return {
      ok: false,
      status: 'node_runtime_missing',
      message: 'No system Node was found on the remote host, and no local Node runtime archive is available in tmp/.',
      steps,
    };
  }

  const upload = await runSshTarExtract(
    connector,
    secret,
    [archive.localPath],
    remoteScpChildPath(remoteDirectory, '.runtime'),
    buildRemoteRuntimeExtractCommand(connector, archive.archiveName),
    'upload_node_runtime',
    240_000,
    sshOptions
  );
  if (upload.step) {
    steps.push(upload.step);
  }
  if (!upload.ok) {
    return {
      ok: false,
      status: 'node_runtime_upload_failed',
      message: 'Unable to upload the Node runtime archive over SSH.',
      steps,
    };
  }
  if (!upload.step.stdout.includes('CODEX_REMOTE_NODE_RUNTIME_READY')) {
    return {
      ok: false,
      status: 'node_runtime_extract_failed',
      message: 'Unable to extract or verify the Node runtime on the remote host.',
      steps,
    };
  }

  return { ok: true };
}

async function ensureRemoteCodexRuntime(connector, secret, remoteDirectory, makeEnv, steps, sshOptions = {}) {
  const probeCommandParts = buildConnectorSshActionCommand(connector, buildRemoteCodexProbeCommand(connector), secret, 'bootstrap', sshOptions);
  if (!probeCommandParts) {
    return {
      ok: false,
      status: 'codex_probe_not_ready',
      message: 'Connector does not have enough SSH information to check the remote Codex CLI.',
      steps,
    };
  }

  const probe = await runProcess(probeCommandParts.command, probeCommandParts.args, {
    timeoutMs: authAwareTimeout(15_000, secret),
    env: makeEnv(),
  });
  steps.push({ name: 'probe_codex_runtime', ...probe });
  if (probe.exitCode === 0 && probe.stdout.includes('CODEX_REMOTE_CODEX_PRESENT=')) {
    return { ok: true };
  }

  const codexRuntime = stageLocalCodexLinuxRuntime();
  if (!codexRuntime || !codexRuntime.localSources.length) {
    return {
      ok: false,
      status: 'codex_runtime_missing',
      message: 'No remote Codex CLI was found in PATH, CODEX_HOME, or common conda/nvm locations, and no local linux-x86_64 Codex runtime is available to deploy.',
      steps,
    };
  }

  const upload = await runSshTarExtract(
    connector,
    secret,
    codexRuntime.localSources,
    remoteScpChildPath(remoteDirectory, '.runtime/codex'),
    buildRemoteCodexRuntimeVerifyCommand(connector),
    'upload_codex_runtime',
    360_000,
    sshOptions
  );
  if (upload.step) {
    steps.push(upload.step);
  }
  if (!upload.ok) {
    return {
      ok: false,
      status: 'codex_runtime_upload_failed',
      message: 'Unable to upload the Codex CLI runtime over SSH.',
      steps,
    };
  }
  if (!upload.step.stdout.includes('CODEX_REMOTE_CODEX_RUNTIME_READY=')) {
    return {
      ok: false,
      status: 'codex_runtime_verify_failed',
      message: 'The Codex CLI runtime uploaded to the remote host, but it did not pass verification.',
      steps,
    };
  }

  return { ok: true };
}

function classifyConnectorAction(action, run) {
  const stdout = run.stdout || '';
  if (run.timedOut) {
    return { ok: false, status: 'timeout', message: 'SSH command timed out.' };
  }
  if (run.error) {
    return { ok: false, status: 'error', message: run.error };
  }
  if (action === 'smoke_test') {
    const ok = run.exitCode === 0 && stdout.includes('SSH_OK');
    return {
      ok,
      status: ok ? 'ssh_ok' : 'ssh_failed',
      message: ok ? 'SSH smoke test succeeded.' : 'SSH smoke test failed.',
    };
  }
  if (action === 'status') {
    if (run.exitCode !== 0) {
      return { ok: false, status: 'status_failed', message: 'Unable to query remote agent status.' };
    }
    if (stdout.includes('CODEX_REMOTE_AGENT_TMUX_RUNNING')) {
      return { ok: true, status: 'remote_agent_running', message: 'Remote tmux agent session is running.' };
    }
    if (stdout.includes('CODEX_REMOTE_AGENT_TMUX_MISSING')) {
      return { ok: true, status: 'remote_agent_missing', message: 'Remote tmux agent session is not running yet.' };
    }
    return { ok: true, status: 'remote_status_unknown', message: 'Remote status command completed, but no known status marker was returned.' };
  }
  if (action === 'diagnose') {
    const ok = run.exitCode === 0 && stdout.includes('CODEX_REMOTE_DIAG_END');
    return {
      ok,
      status: ok ? 'diagnosed' : 'diagnose_failed',
      message: ok ? 'Remote environment diagnostic completed.' : 'Remote environment diagnostic failed.',
    };
  }
  if (action === 'logs') {
    return {
      ok: run.exitCode === 0,
      status: run.exitCode === 0 ? 'logs_read' : 'logs_failed',
      message: run.exitCode === 0 ? 'Remote host-agent logs captured.' : 'Unable to read remote host-agent logs.',
    };
  }
  if (action === 'bootstrap') {
    const ok = run.exitCode === 0 && stdout.includes('CODEX_REMOTE_AGENT_BOOTSTRAPPED');
    return {
      ok,
      status: ok ? 'bootstrapped' : 'bootstrap_failed',
      message: ok ? 'Remote host-agent bootstrap command completed.' : 'Remote host-agent bootstrap command failed.',
    };
  }
  if (action === 'restart') {
    const ok = run.exitCode === 0 && stdout.includes('CODEX_REMOTE_AGENT_BOOTSTRAPPED');
    return {
      ok,
      status: ok ? 'restarted' : 'restart_failed',
      message: ok ? 'Remote host-agent restarted with the latest bundle.' : 'Remote host-agent restart failed.',
    };
  }

  return { ok: false, status: 'unknown_action', message: 'Unknown connector action.' };
}

async function runConnectorAction(connector, action, secretOverride = null) {
  connector = connectorWithRelayAuth(connector);
  const decorated = decorateSingleConnector(connector);
  const secret = secretOverride || state.connectorSecrets.get(connector.connectorId) || null;
  const manualCommand = decorated.plan.sshLoginCommand;
  const manualBootstrapCommand = decorated.plan.bootstrapCommand;
  const sshOptions = getConnectorSshOptions(connector, action, secret);
  let activeSshOptions = sshOptions;

  if (!['smoke_test', 'status', 'diagnose', 'logs', 'bootstrap', 'restart'].includes(action)) {
    return {
      httpStatus: 400,
      payload: { ok: false, action, status: 'invalid_action', message: 'Unsupported connector action.' },
    };
  }

  if (connectorNeedsManualAuth(connector, secret)) {
    return {
      httpStatus: 200,
      payload: {
        ok: false,
        action,
        status: 'manual_required',
        message: 'This connector needs a saved local password or a manual SSH login before the relay can run it automatically.',
        command: manualCommand,
        bootstrapCommand: manualBootstrapCommand,
        connector: decorated,
      },
    };
  }

  if (action === 'bootstrap' || action === 'restart') {
    const bootstrap = await runConnectorBootstrapOneShot(connector, action, secret);
    return {
      httpStatus: 200,
      payload: {
        ok: bootstrap.ok,
        action,
        status: bootstrap.status,
        message: bootstrap.message,
        command: bootstrap.command || manualBootstrapCommand,
        stdout: bootstrap.step?.stdout || '',
        stderr: bootstrap.step?.stderr || '',
        exitCode: bootstrap.step?.exitCode ?? null,
        signal: bootstrap.step?.signal ?? null,
        timedOut: Boolean(bootstrap.step?.timedOut),
        error: bootstrap.step?.error || null,
        remoteDirectory: bootstrap.remoteDirectory,
        deploy: {
          ok: bootstrap.ok,
          status: bootstrap.status,
          message: bootstrap.message,
          remoteDirectory: bootstrap.remoteDirectory,
          payload: bootstrap.payload,
          steps: bootstrap.steps,
        },
        connector: decorateSingleConnector(bootstrap.connector || connector),
      },
    };
  }

  const actionConfig = buildConnectorAction(connector, action, secret, activeSshOptions);
  if (!actionConfig?.commandParts) {
    return {
      httpStatus: 200,
      payload: {
        ok: false,
        action,
        status: 'not_ready',
        message: 'This connector does not have enough target or bootstrap information to run automatically.',
        command: actionConfig?.displayCommand || manualCommand || manualBootstrapCommand,
        connector: decorated,
      },
    };
  }

  let run = await runProcess(
    actionConfig.commandParts.command,
    actionConfig.commandParts.args,
    {
      timeoutMs: actionConfig.timeoutMs,
      env: actionConfig.env || null,
    }
  );
  let actionMultiplexFallback = null;
  if (activeSshOptions.controlPath && isSshMultiplexSocketFailureStep(run)) {
    disableConnectorSshMultiplex(connector, 'ControlMaster socket failure during action command');
    cleanupSshMultiplexOptions(activeSshOptions);
    const fallbackActionConfig = buildConnectorAction(connector, action, secret, {});
    if (fallbackActionConfig?.commandParts) {
      actionMultiplexFallback = {
        controlPath: activeSshOptions.controlPath,
        failedRun: run,
      };
      run = await runProcess(
        fallbackActionConfig.commandParts.command,
        fallbackActionConfig.commandParts.args,
        {
          timeoutMs: fallbackActionConfig.timeoutMs,
          env: fallbackActionConfig.env || null,
        }
      );
    }
  }
  const classification = classifyConnectorAction(action, run);
  return {
    httpStatus: 200,
    payload: {
      ...classification,
      action,
      command: actionConfig.displayCommand,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      error: run.error,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      deploy: deployment,
      multiplexFallback: deployment?.multiplexFallback || actionMultiplexFallback,
      expectedHostId: connector.hostId || null,
      connector: decorateSingleConnector(connector),
    },
  };
}

function getStats() {
  const hosts = getHostList();
  const sessions = Array.from(state.sessions.values());
  const connectors = getConnectorList();
  const directories = new Map();

  for (const session of sessions) {
    const cwd = session.cwd || '(unknown)';
    const existing = directories.get(cwd) || {
      cwd,
      cwdLabel: path.basename(cwd) || cwd,
      totalSessions: 0,
      liveSessions: 0,
      hosts: new Set(),
    };

    existing.totalSessions += 1;
    if (session.live) {
      existing.liveSessions += 1;
    }
    existing.hosts.add(session.hostId);
    directories.set(cwd, existing);
  }

  return {
    summary: {
      totalHosts: hosts.length,
      onlineHosts: hosts.filter((host) => host.online).length,
      totalSessions: sessions.length,
      liveSessions: sessions.filter((session) => session.live).length,
      managedSessions: sessions.filter((session) => session.source === 'managed').length,
      importedSessions: sessions.filter((session) => session.source !== 'managed').length,
      historyOnlySessions: sessions.filter((session) => !session.live).length,
      removedHosts: state.dismissedHosts.size,
      savedConnectors: connectors.length,
      gatewayConnectors: connectors.filter((connector) => connector.runtime?.usesGateway).length,
      interactiveAuthConnectors: connectors.filter((connector) => connector.runtime?.interactiveAuth).length,
      attachedConnectors: connectors.filter((connector) => connector.runtime?.attachedHostOnline).length,
    },
    byHost: hosts.map((host) => {
      const hostSessions = sessions.filter((session) => session.hostId === host.hostId);
      return {
        hostId: host.hostId,
        label: host.label,
        platform: host.platform,
        online: host.online,
        totalSessions: hostSessions.length,
        liveSessions: hostSessions.filter((session) => session.live).length,
        managedSessions: hostSessions.filter((session) => session.source === 'managed').length,
        importedSessions: hostSessions.filter((session) => session.source !== 'managed').length,
        lastSeenAt: host.lastSeenAt,
      };
    }),
    topDirectories: Array.from(directories.values())
      .map((entry) => ({
        cwd: entry.cwd,
        cwdLabel: entry.cwdLabel,
        totalSessions: entry.totalSessions,
        liveSessions: entry.liveSessions,
        hostCount: entry.hosts.size,
      }))
      .sort((a, b) => {
        if (b.liveSessions !== a.liveSessions) {
          return b.liveSessions - a.liveSessions;
        }
        return b.totalSessions - a.totalSessions;
      })
      .slice(0, 6),
    connectors: connectors.map((connector) => ({
      connectorId: connector.connectorId,
      label: connector.label,
      kind: connector.kind,
      kindLabel: connector.kindLabel,
      phase: connector.runtime?.phase || 'saved',
      phaseLabel: connector.runtime?.phaseLabel || 'Saved',
    })),
  };
}

function awaitDirectoryRequest(requestId, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingDirectoryRequests.delete(requestId);
      reject(new Error('directory listing timed out'));
    }, timeoutMs);

    state.pendingDirectoryRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingDirectoryRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingDirectoryRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitHostProbe(requestId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingHostProbes.delete(requestId);
      reject(new Error('host health check timed out'));
    }, timeoutMs);

    state.pendingHostProbes.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingHostProbes.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingHostProbes.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitModelListRequest(requestId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingModelRequests.delete(requestId);
      reject(new Error('model list request timed out'));
    }, timeoutMs);

    state.pendingModelRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingModelRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingModelRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitFileRequest(requestId, timeoutMs = 120000, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingFileRequests.delete(requestId);
      reject(new Error('file transfer request timed out'));
    }, timeoutMs);

    state.pendingFileRequests.set(requestId, {
      suppressAlert: options.suppressAlert === true,
      source: options.source || null,
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingFileRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingFileRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function resolvePendingFileRequest(requestId, payload) {
  const pending = state.pendingFileRequests.get(requestId);
  if (pending) {
    pending.resolve(payload);
  }
}

function rejectPendingFileRequest(requestId, message) {
  const pending = state.pendingFileRequests.get(requestId);
  if (pending) {
    pending.reject(new Error(message || 'file transfer failed'));
  }
}

function removeQueuedFileCommand(hostId, requestId) {
  if (!hostId || !requestId) {
    return;
  }
  const queue = state.commandQueues.get(hostId);
  if (!queue?.length) {
    return;
  }
  state.commandQueues.set(
    hostId,
    queue.filter((command) => String(command.requestId || '') !== String(requestId))
  );
}

function validateUploadFiles(rawFiles) {
  const files = [];
  let totalBytes = 0;
  for (const rawFile of Array.isArray(rawFiles) ? rawFiles.slice(0, 8) : []) {
    if (!rawFile || typeof rawFile !== 'object') {
      continue;
    }
    const name = safeFileDisplayName(rawFile.name || 'upload');
    const dataBase64 = String(rawFile.dataBase64 || '').replace(/^data:[^,]+,/, '').trim();
    if (!dataBase64) {
      continue;
    }
    const size = Number(rawFile.size || 0) || Math.floor(dataBase64.length * 0.75);
    if (size > MAX_FILE_TRANSFER_BYTES) {
      throw new Error(`${name} is too large; limit is ${MAX_FILE_TRANSFER_BYTES} bytes per file`);
    }
    totalBytes += size;
    if (totalBytes > MAX_FILE_TRANSFER_BYTES) {
      throw new Error(`uploaded files are too large; total limit is ${MAX_FILE_TRANSFER_BYTES} bytes`);
    }
    files.push({
      fileId: String(rawFile.fileId || rawFile.id || makeId()).trim(),
      name,
      mime: String(rawFile.mime || rawFile.type || 'application/octet-stream').trim() || 'application/octet-stream',
      size,
      dataBase64,
    });
  }
  return files;
}

function contentDispositionValue(disposition, filename) {
  const name = safeFileDisplayName(filename || 'download');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function receivedFileIsExpired(record, now = Date.now()) {
  const expiresAt = record?.expiresAt ? Date.parse(record.expiresAt) : 0;
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

function pruneReceivedFiles() {
  const root = path.resolve(RECEIVED_FILES_ROOT);
  let changed = false;
  for (const [fileId, record] of state.receivedFiles) {
    const localPath = record?.localPath ? path.resolve(record.localPath) : '';
    const expired = receivedFileIsExpired(record);
    const missing = !localPath || !fs.existsSync(localPath);
    if (!expired && !missing) {
      continue;
    }
    if (expired && localPath && pathInside(root, localPath) && fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch {
        // The manifest is still updated below; stale files can be retried later.
      }
    }
    state.receivedFiles.delete(fileId);
    changed = true;
  }
  if (changed) {
    saveReceivedFiles();
  }
}

function findReceivedFile(hostId, sessionId, remotePath) {
  pruneReceivedFiles();
  const normalizedHost = String(hostId || '');
  const normalizedSession = String(sessionId || '');
  const normalizedRemotePath = String(remotePath || '');
  for (const record of state.receivedFiles.values()) {
    if (
      record.hostId === normalizedHost
      && record.sessionId === normalizedSession
      && record.remotePath === normalizedRemotePath
      && record.localPath
      && fs.existsSync(record.localPath)
    ) {
      return record;
    }
  }
  return null;
}

function storeReceivedFile({ hostId, sessionId, remotePath, name, mime, buffer }) {
  pruneReceivedFiles();
  const fileId = makeId();
  const filename = safeFileDisplayName(name || remotePath || 'download');
  const hostSegment = safePathSegment(hostId, 'host');
  const sessionSegment = safePathSegment(sessionId, 'session');
  const targetDirectory = path.join(RECEIVED_FILES_ROOT, hostSegment, sessionSegment);
  fs.mkdirSync(targetDirectory, { recursive: true });

  const localPath = path.resolve(targetDirectory, `${fileId}-${filename}`);
  if (!pathInside(RECEIVED_FILES_ROOT, localPath)) {
    throw new Error('refusing to cache outside received-files directory');
  }
  fs.writeFileSync(localPath, buffer);

  const expiresAt = new Date(Date.now() + RECEIVED_FILE_TTL_MS).toISOString();
  const existing = findReceivedFile(hostId, sessionId, remotePath);
  if (existing?.localPath && pathInside(RECEIVED_FILES_ROOT, existing.localPath) && fs.existsSync(existing.localPath)) {
    try {
      fs.unlinkSync(existing.localPath);
    } catch {
      // The new cache copy is already written; stale files are cleaned by TTL.
    }
    state.receivedFiles.delete(existing.fileId);
  }

  const record = {
    fileId,
    hostId: String(hostId || ''),
    sessionId: String(sessionId || ''),
    remotePath: String(remotePath || ''),
    name: filename,
    mime: String(mime || 'application/octet-stream'),
    size: buffer.length,
    localPath,
    receivedAt: nowIso(),
    lastAccessedAt: nowIso(),
    expiresAt,
  };
  state.receivedFiles.set(fileId, record);
  saveReceivedFiles();
  return record;
}

function serveReceivedFile(res, record, inline) {
  if (!record?.localPath || !fs.existsSync(record.localPath)) {
    sendJson(res, 404, { error: 'received file not found or expired' });
    return;
  }
  record.lastAccessedAt = nowIso();
  state.receivedFiles.set(record.fileId, record);
  saveReceivedFiles();
  const buffer = fs.readFileSync(record.localPath);
  res.writeHead(200, {
    'Content-Type': record.mime || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Content-Disposition': contentDispositionValue(inline ? 'inline' : 'attachment', record.name || 'download'),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'X-Codex-Received-File-Id': record.fileId,
    'X-Codex-Received-Expires-At': record.expiresAt || '',
    'X-Codex-Remote-Path': encodeURIComponent(record.remotePath || ''),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buffer);
}

function normalizeTurnInputItems(rawItems) {
  const items = [];
  for (const rawItem of Array.isArray(rawItems) ? rawItems.slice(0, 8) : []) {
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }

    const type = String(rawItem.type || '').trim();
    if (type === 'image') {
      const url = String(rawItem.url || rawItem.dataUrl || '').trim();
      if (url) {
        items.push({
          type: 'image',
          url,
          name: String(rawItem.name || '').trim(),
        });
      }
      continue;
    }

    if (type === 'localImage') {
      const imagePath = String(rawItem.path || '').trim();
      if (imagePath) {
        items.push({
          type: 'localImage',
          path: imagePath,
          name: String(rawItem.name || '').trim(),
        });
      }
      continue;
    }

    if (type === 'mention' || type === 'skill') {
      const name = String(rawItem.name || '').trim();
      const itemPath = String(rawItem.path || '').trim();
      if (name && itemPath) {
        items.push({
          type,
          name,
          path: itemPath,
        });
      }
    }
  }
  return items;
}

function summarizeTurnInput(text, inputItems, files = []) {
  const pieces = [];
  const prompt = String(text || '').trim();
  if (prompt) {
    pieces.push(prompt);
  }

  for (const [index, item] of inputItems.entries()) {
    if (item.type === 'image') {
      pieces.push(`[image ${index + 1}${item.name ? `: ${item.name}` : ''}]`);
    } else if (item.type === 'localImage') {
      pieces.push(`[local image: ${item.path}]`);
    } else if (item.type === 'mention') {
      pieces.push(`[mention: ${item.name}]`);
    } else if (item.type === 'skill') {
      pieces.push(`[skill: ${item.name}]`);
    }
  }

  for (const file of files) {
    const label = file.path || file.name || 'file';
    pieces.push(`[uploaded file: ${label}]`);
  }

  return pieces.join('\n').trim().slice(0, 4000);
}

function normalizeReviewTarget(input = {}) {
  const rawTarget = input.target && typeof input.target === 'object' ? input.target : input;
  const type = String(rawTarget.type || input.targetType || 'uncommittedChanges').trim();

  if (type === 'baseBranch') {
    const branch = String(rawTarget.branch || input.branch || '').trim();
    if (!branch) {
      throw new Error('baseBranch review requires branch');
    }
    return { type, branch };
  }

  if (type === 'commit') {
    const sha = String(rawTarget.sha || input.sha || '').trim();
    if (!sha) {
      throw new Error('commit review requires sha');
    }
    return {
      type,
      sha,
      title: String(rawTarget.title || input.title || '').trim() || null,
    };
  }

  if (type === 'custom') {
    const instructions = String(rawTarget.instructions || input.instructions || '').trim();
    if (!instructions) {
      throw new Error('custom review requires instructions');
    }
    return { type, instructions };
  }

  return { type: 'uncommittedChanges' };
}

function earliestIso(...values) {
  let best = null;
  let bestTime = Infinity;
  for (const value of values) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time) || time >= bestTime) {
      continue;
    }
    bestTime = time;
    best = value;
  }
  return best;
}

function upsertSession(hostId, patch) {
  const key = sessionKey(hostId, patch.sessionId);
  const existing = state.sessions.get(key) || {
    hostId,
    sessionId: patch.sessionId,
    title: patch.title || patch.sessionId,
    cwd: patch.cwd || null,
    createdAt: patch.createdAt || nowIso(),
    source: patch.source || 'imported',
    state: patch.state || 'unknown',
    live: Boolean(patch.live),
    lastUpdatedAt: nowIso(),
  };

  const next = {
    ...existing,
    ...patch,
    hostId,
    sessionId: patch.sessionId,
    createdAt: earliestIso(existing.createdAt, patch.createdAt, patch.updatedAt, patch.lastUpdatedAt, nowIso()) || existing.createdAt || patch.createdAt || nowIso(),
    lastUpdatedAt: patch.lastUpdatedAt || nowIso(),
  };

  if (typeof next.live === 'undefined') {
    next.live = Boolean(existing.live);
  }

  if (!next.cwdLabel) {
    next.cwdLabel = next.cwd ? path.basename(next.cwd) || next.cwd : '(unknown)';
  }

  if (!next.conversationKey) {
    next.conversationKey = next.originSessionId || next.sessionId;
  }

  state.sessions.set(key, next);
  return next;
}

function enqueueCommand(hostId, command) {
  const queue = state.commandQueues.get(hostId) || [];
  const next = {
    id: state.nextCommandId++,
    createdAt: nowIso(),
    ...command,
  };
  queue.push(next);
  state.commandQueues.set(hostId, queue);
  return next;
}

function markSessionClosed(hostId, sessionId, stateName = 'history-only') {
  const next = upsertSession(hostId, {
    sessionId,
    state: stateName,
    live: false,
    lastUpdatedAt: nowIso(),
  });
  const runtime = setSessionRuntime(hostId, sessionId, {
    phase: 'closed',
    connection: 'closed',
    busy: false,
    activeTurnId: null,
    waitingOnApproval: false,
    waitingOnUserInput: false,
    updatedAt: nowIso(),
  });
  broadcastSessionEvent(hostId, sessionId, 'session.runtime_updated', {
    hostId,
    sessionId,
    patch: runtime,
    timestamp: nowIso(),
  });
  broadcastSessionEvent(hostId, sessionId, 'session.snapshot', next);
  return next;
}

function scheduleStopFallback(hostId, sessionId, delayMs = 4000) {
  const timer = setTimeout(() => {
    const session = getSession(hostId, sessionId);
    const runtime = state.sessionRuntime.get(sessionKey(hostId, sessionId)) || null;
    if (session?.live && (session.state === 'ending' || runtime?.phase === 'ending')) {
      markSessionClosed(hostId, sessionId);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function getCommands(hostId, afterId = 0) {
  const queue = state.commandQueues.get(hostId) || [];
  return queue.filter((command) => command.id > afterId);
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastSessionEvent(hostId, sessionId, eventName, payload) {
  const subscribers = state.subscribers.get(sessionKey(hostId, sessionId));
  if (!subscribers) {
    return;
  }

  for (const res of subscribers) {
    sendSse(res, eventName, payload);
  }
}

function addSessionSubscriber(hostId, sessionId, res) {
  const key = sessionKey(hostId, sessionId);
  const subscribers = state.subscribers.get(key) || new Set();
  subscribers.add(res);
  state.subscribers.set(key, subscribers);
}

function removeSessionSubscriber(hostId, sessionId, res) {
  const key = sessionKey(hostId, sessionId);
  const subscribers = state.subscribers.get(key);
  if (!subscribers) {
    return;
  }

  subscribers.delete(res);
  if (subscribers.size === 0) {
    state.subscribers.delete(key);
  }
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'forbidden' });
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function handleRequest(req, res) {
  const url = parseUrl(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Auth-Token',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/config') {
    sendJson(res, 200, relayAuthConfig(req, url));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
    const body = await readBody(req);
    if (!RELAY_AUTH_TOKEN) {
      sendJson(res, 409, { error: 'relay auth is disabled' });
      return;
    }
    if (relayAuthAccount?.username) {
      sendJson(res, 409, { error: 'relay account is already configured' });
      return;
    }
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || body.passwordConfirm || '');
    if (password !== confirmPassword) {
      sendJson(res, 400, { error: 'password confirmation does not match' });
      return;
    }
    try {
      createRelayAuthAccount(body.username || 'admin', password);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      ...relayAuthConfig(req, url),
      authenticated: true,
    }, {
      'Set-Cookie': authCookieHeader(30 * 24 * 60 * 60),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    if (!RELAY_AUTH_TOKEN) {
      sendJson(res, 200, relayAuthConfig(req, url));
      return;
    }

    const token = String(body.token || '').trim();
    const username = normalizeAuthUsername(body.username || '');
    const password = String(body.password || '');
    const tokenOk = token && constantTimeEqual(token, RELAY_AUTH_TOKEN);
    const passwordOk = relayAuthAccount?.username
      && constantTimeEqual(username.toLowerCase(), String(relayAuthAccount.username).toLowerCase())
      && verifyAuthPassword(password, relayAuthAccount);
    if (!tokenOk && !passwordOk) {
      sendJson(res, 401, {
        error: relayAuthAccount?.username ? 'invalid username or password' : 'setup is required or recovery token is invalid',
        authRequired: true,
        setupRequired: Boolean(!relayAuthAccount?.username),
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ...relayAuthConfig(req, url),
      authenticated: true,
    }, {
      'Set-Cookie': authCookieHeader(30 * 24 * 60 * 60),
    });
    return;
  }

  if (!authorizeRequest(req, res, url)) {
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    sendJson(res, 200, {
      ok: true,
      authRequired: Boolean(RELAY_AUTH_TOKEN),
      authenticated: false,
    }, {
      'Set-Cookie': authCookieHeader(0),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
    if (!relayAuthAccount?.username) {
      sendJson(res, 409, { error: 'relay account is not configured yet' });
      return;
    }
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || '');
    const recoveryToken = String(body.recoveryToken || '').trim();
    const authorizedByPassword = currentPassword && verifyAuthPassword(currentPassword, relayAuthAccount);
    const authorizedByToken = recoveryToken && RELAY_AUTH_TOKEN && constantTimeEqual(recoveryToken, RELAY_AUTH_TOKEN);
    if (!authorizedByPassword && !authorizedByToken) {
      sendJson(res, 401, { error: 'current password or recovery token is required' });
      return;
    }

    const newPassword = String(body.newPassword || body.password || '');
    const confirmPassword = String(body.confirmPassword || body.passwordConfirm || '');
    if (newPassword !== confirmPassword) {
      sendJson(res, 400, { error: 'password confirmation does not match' });
      return;
    }

    try {
      const nextUsername = normalizeAuthUsername(body.username || relayAuthAccount.username);
      validateAuthUsername(nextUsername);
      saveRelayAuthAccount({
        ...relayAuthAccount,
        username: nextUsername,
        passwordHash: hashAuthPassword(newPassword),
        createdAt: relayAuthAccount.createdAt || nowIso(),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ...relayAuthConfig(req, url),
      authenticated: true,
    }, {
      'Set-Cookie': authCookieHeader(30 * 24 * 60 * 60),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, time: nowIso(), authRequired: Boolean(RELAY_AUTH_TOKEN) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/hosts') {
    sendJson(res, 200, {
      hosts: getHostList(),
      dismissedHosts: Array.from(state.dismissedHosts.values()).sort(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    sendJson(res, 200, getStats());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session-collections') {
    sendJson(res, 200, { collections: getSessionCollectionList() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session-collections') {
    const body = await readBody(req);
    const collection = normalizeSessionCollection({
      name: body.name || 'Untitled',
      items: [],
    });
    state.sessionCollections.set(collection.collectionId, collection);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection });
    return;
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/session-collections\/[^/]+$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    const existing = state.sessionCollections.get(collectionId);
    if (!existing) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    if (collectionId === DEFAULT_COLLECTION_ID) {
      sendJson(res, 409, { error: 'default collection cannot be renamed' });
      return;
    }

    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'collection name is required' });
      return;
    }

    const collection = {
      ...existing,
      name,
      updatedAt: nowIso(),
    };
    state.sessionCollections.set(collectionId, collection);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/session-collections\/[^/]+$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    if (collectionId === DEFAULT_COLLECTION_ID) {
      sendJson(res, 409, { error: 'default collection cannot be deleted' });
      return;
    }
    const existed = state.sessionCollections.delete(collectionId);
    if (!existed) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collectionId });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/session-collections\/[^/]+\/items$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    const collection = state.sessionCollections.get(collectionId);
    if (!collection) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    if (collectionId === DEFAULT_COLLECTION_ID) {
      sendJson(res, 409, { error: 'default collection already contains all sessions' });
      return;
    }

    const body = await readBody(req);
    const item = normalizeSessionCollectionItem(body.item || body);
    if (!item) {
      sendJson(res, 400, { error: 'hostId and conversationKey are required' });
      return;
    }

    const key = collectionItemKey(item);
    const existingItems = collection.items.filter((entry) => collectionItemKey(entry) !== key);
    const next = {
      ...collection,
      items: [...existingItems, item],
      updatedAt: nowIso(),
    };
    state.sessionCollections.set(collectionId, next);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection: next, item });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/session-collections\/[^/]+\/items\/remove$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    const collection = state.sessionCollections.get(collectionId);
    if (!collection) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    if (collectionId === DEFAULT_COLLECTION_ID) {
      sendJson(res, 409, { error: 'default collection items cannot be removed' });
      return;
    }

    const body = await readBody(req);
    const item = normalizeSessionCollectionItem(body.item || body);
    if (!item) {
      sendJson(res, 400, { error: 'hostId and conversationKey are required' });
      return;
    }

    const key = collectionItemKey(item);
    const next = {
      ...collection,
      items: collection.items.filter((entry) => collectionItemKey(entry) !== key),
      updatedAt: nowIso(),
    };
    state.sessionCollections.set(collectionId, next);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection: next });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/connectors') {
    sendJson(res, 200, { connectors: getConnectorList() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/connectors') {
    const body = await readBody(req);
    const connector = normalizeConnectorInput(body);
    state.connectors.set(connector.connectorId, connector);
    upsertConnectorSecretsFromBody(connector.connectorId, body);
    persistConnectors();
    sendJson(res, 200, { ok: true, connector: decorateSingleConnector(connector) });
    return;
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/connectors\/[^/]+$/)) {
    const connectorId = decodeURIComponent(url.pathname.split('/')[3]);
    const existing = state.connectors.get(connectorId);
    if (!existing) {
      sendJson(res, 404, { error: 'connector not found' });
      return;
    }

    const body = await readBody(req);
    const connector = normalizeConnectorInput({ ...body, connectorId }, existing);
    state.connectors.set(connector.connectorId, connector);
    upsertConnectorSecretsFromBody(connector.connectorId, body);
    persistConnectors();
    sendJson(res, 200, { ok: true, connector: decorateSingleConnector(connector) });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/connectors\/[^/]+$/)) {
    const connectorId = decodeURIComponent(url.pathname.split('/')[3]);
    const existed = state.connectors.delete(connectorId);
    if (!existed) {
      sendJson(res, 404, { error: 'connector not found' });
      return;
    }
    if (state.connectorSecrets.delete(connectorId)) {
      persistConnectorSecrets();
    }
    persistConnectors();
    sendJson(res, 200, { ok: true, connectorId });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/connectors\/[^/]+\/action-prompts$/)) {
    const connectorId = decodeURIComponent(url.pathname.split('/')[3]);
    const actionId = String(url.searchParams.get('actionId') || '').trim();
    const token = String(url.searchParams.get('token') || '').trim();
    const record = getAskpassAction(connectorId, actionId, token);
    if (!record) {
      sendJson(res, 404, { error: 'askpass action not found', prompts: [] });
      return;
    }
    const prompts = Array.from(record.prompts.values())
      .filter((prompt) => !prompt.responseReady && !prompt.cancelled)
      .map(publicAskpassPrompt);
    sendJson(res, 200, { ok: true, prompts, closed: record.closed });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/connectors\/[^/]+\/action-prompts\/[^/]+$/)) {
    const parts = url.pathname.split('/');
    const connectorId = decodeURIComponent(parts[3]);
    const promptId = decodeURIComponent(parts[5]);
    const body = await readBody(req);
    const actionId = String(body.actionId || '').trim();
    const token = String(body.token || '').trim();
    const record = getAskpassAction(connectorId, actionId, token);
    const prompt = getAskpassPrompt(record, promptId);
    if (!prompt) {
      sendJson(res, 404, { error: 'askpass prompt not found' });
      return;
    }
    if (body.cancel) {
      prompt.cancelled = true;
      prompt.responseReady = false;
      prompt.updatedAt = nowIso();
      cancelAskpassAction(record);
      sendJson(res, 200, { ok: true, prompt: publicAskpassPrompt(prompt) });
      return;
    }
    prompt.response = String(body.response || '');
    prompt.responseReady = true;
    prompt.updatedAt = nowIso();
    record.updatedAt = nowIso();
    sendJson(res, 200, { ok: true, prompt: publicAskpassPrompt(prompt) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/askpass/prompts') {
    const body = await readBody(req);
    const prompt = createAskpassPrompt({
      connectorId: String(body.connectorId || '').trim(),
      actionId: String(body.actionId || '').trim(),
      token: String(body.token || '').trim(),
      prompt: String(body.prompt || '').trim(),
    });
    if (!prompt) {
      sendJson(res, 403, { error: 'askpass action not available' });
      return;
    }
    sendJson(res, 200, publicAskpassPrompt(prompt));
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/askpass\/prompts\/[^/]+$/)) {
    const promptId = decodeURIComponent(url.pathname.split('/')[4]);
    const connectorId = String(url.searchParams.get('connectorId') || '').trim();
    const actionId = String(url.searchParams.get('actionId') || '').trim();
    const token = String(url.searchParams.get('token') || '').trim();
    const record = getAskpassAction(connectorId, actionId, token);
    const prompt = getAskpassPrompt(record, promptId);
    if (!prompt) {
      sendJson(res, 404, { status: 'closed' });
      return;
    }
    if (prompt.cancelled || record.closed) {
      sendJson(res, 200, { status: 'cancelled' });
      return;
    }
    if (prompt.responseReady) {
      sendJson(res, 200, { status: 'answered', response: prompt.response });
      return;
    }
    sendJson(res, 200, { status: 'pending' });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/connectors\/[^/]+\/actions$/)) {
    const connectorId = decodeURIComponent(url.pathname.split('/')[3]);
    const connector = state.connectors.get(connectorId);
    if (!connector) {
      sendJson(res, 404, { error: 'connector not found' });
      return;
    }

    const body = await readBody(req);
    upsertConnectorSecretsFromBody(connector.connectorId, body);
    const action = String(body.action || '').trim();
    const requestOrigin = body.clientOrigin || (req.headers.host ? `http://${req.headers.host}` : '');
    const actionConnector = (action === 'bootstrap' || action === 'restart')
      ? connectorWithActionRelayOrigin(connector, requestOrigin)
      : connector;
    const actionSecret = buildConnectorActionSecret(connector.connectorId, body);
    const askpassRecord = registerAskpassAction(connector.connectorId, action, actionSecret);
    try {
      const result = await runConnectorAction(actionConnector, action, actionSecret);
      sendJson(res, result.httpStatus, result.payload);
    } finally {
      closeAskpassAction(askpassRecord);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/hosts\/[^/]+\/sessions$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    sendJson(res, 200, { sessions: getSessionsForHost(hostId) });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/probe$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const host = state.hosts.get(hostId);
    if (!host) {
      sendJson(res, 404, { error: 'host not found' });
      return;
    }
    if (!hostOnline(host)) {
      sendJson(res, 409, { error: `host ${host.label || hostId} is offline` });
      return;
    }

    if (!host.capabilities?.hostProbe) {
      sendJson(res, 200, {
        ok: true,
        hostId,
        mode: 'heartbeat',
        message: 'Host is online by heartbeat. Restart its agent to enable active probe checks.',
      });
      return;
    }

    const requestId = makeId();
    enqueueCommand(hostId, {
      type: 'host.probe',
      requestId,
    });

    try {
      const result = await awaitHostProbe(requestId);
      sendJson(res, 200, {
        ok: true,
        hostId,
        mode: 'active',
        ...result,
      });
    } catch (error) {
      const currentHost = state.hosts.get(hostId) || host;
      if (hostHasFreshHeartbeat(currentHost)) {
        sendJson(res, 200, {
          ok: true,
          hostId,
          mode: 'heartbeat-fallback',
          warning: `Active health check timed out, but ${currentHost.label || hostId} has a fresh heartbeat.`,
          heartbeatAgeMs: Math.max(0, Math.round(hostHeartbeatAgeMs(currentHost))),
        });
        return;
      }
      sendJson(res, 504, {
        ok: false,
        hostId,
        error: `host ${host.label || hostId} did not answer the health check: ${error.message}`,
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/hosts\/[^/]+\/directories$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const host = state.hosts.get(hostId);
    if (!host) {
      sendJson(res, 404, { error: 'host not found' });
      return;
    }
    if (!hostOnline(host)) {
      sendJson(res, 409, { error: 'host is offline' });
      return;
    }

    const requestId = makeId();
    const targetPath = String(url.searchParams.get('path') || '').trim();
    enqueueCommand(hostId, {
      type: 'directory.list',
      requestId,
      path: targetPath || null,
    });

    const result = await awaitDirectoryRequest(requestId);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/upload$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const capabilityError = getHostCapabilityError(
      hostId,
      'fileTransfer',
      'this host agent needs to be restarted before it can upload files'
    );
    if (capabilityError) {
      sendJson(res, capabilityError.statusCode, { error: capabilityError.error });
      return;
    }

    const body = await readBody(req);
    let files = [];
    try {
      files = validateUploadFiles(body.files || []);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (!files.length) {
      sendJson(res, 400, { error: 'files are required' });
      return;
    }

    const requestId = makeId();
    const pending = awaitFileRequest(requestId);
    enqueueCommand(hostId, {
      type: 'host.file_upload',
      requestId,
      sessionId: String(body.sessionId || '').trim() || null,
      targetDirectory: String(body.targetDirectory || body.cwd || '').trim() || null,
      files,
    });

    try {
      const result = await pending;
      sendJson(res, 200, {
        ok: true,
        hostId,
        requestId,
        files: normalizeFileTransferRefs(result.files || []),
      });
    } catch (error) {
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/received-files\/[^/]+$/)) {
    pruneReceivedFiles();
    const fileId = decodeURIComponent(url.pathname.split('/')[3]);
    const record = state.receivedFiles.get(fileId);
    const inline = url.searchParams.get('inline') === '1' || url.searchParams.get('inline') === 'true';
    serveReceivedFile(res, record, inline);
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/received-files$/)) {
    pruneReceivedFiles();
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = String(url.searchParams.get('hostId') || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    const files = Array.from(state.receivedFiles.values())
      .filter((file) => file.hostId === hostId && file.sessionId === sessionId)
      .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
      .map((file) => ({
        fileId: file.fileId,
        hostId: file.hostId,
        sessionId: file.sessionId,
        remotePath: file.remotePath,
        name: file.name,
        mime: file.mime,
        size: file.size,
        receivedAt: file.receivedAt,
        lastAccessedAt: file.lastAccessedAt,
        expiresAt: file.expiresAt,
        url: `/api/received-files/${encodeURIComponent(file.fileId)}`,
      }));
    sendJson(res, 200, {
      root: RECEIVED_FILES_ROOT,
      ttlMs: RECEIVED_FILE_TTL_MS,
      files,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/download$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const sessionId = String(url.searchParams.get('sessionId') || '').trim() || null;
    const remotePath = String(url.searchParams.get('path') || '').trim();
    const inline = url.searchParams.get('inline') === '1' || url.searchParams.get('inline') === 'true';
    const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    if (!remotePath) {
      sendJson(res, 400, { error: 'path is required' });
      return;
    }
    if (isAmbiguousBareDownloadPath(remotePath)) {
      sendJson(res, 400, {
        error: 'remote file path must include a directory or be absolute; bare file names are ambiguous',
      });
      return;
    }

    const cached = !refresh ? findReceivedFile(hostId, sessionId || '', remotePath) : null;
    if (cached) {
      serveReceivedFile(res, cached, inline);
      return;
    }

    const capabilityError = getHostCapabilityError(
      hostId,
      'fileTransfer',
      'this host agent needs to be restarted before it can download files'
    );
    if (capabilityError) {
      sendJson(res, capabilityError.statusCode, { error: capabilityError.error });
      return;
    }

    const requestId = makeId();
    const pending = awaitFileRequest(requestId, 120000, {
      suppressAlert: inline,
      source: inline ? 'inline-preview' : 'download',
    });
    enqueueCommand(hostId, {
      type: 'host.file_download',
      requestId,
      sessionId,
      path: remotePath,
      cwd: String(url.searchParams.get('cwd') || '').trim() || null,
    });

    try {
      const result = await pending;
      const dataBase64 = String(result.dataBase64 || '');
      const buffer = Buffer.from(dataBase64, 'base64');
      const filename = safeFileDisplayName(result.name || result.path || remotePath);
      const received = storeReceivedFile({
        hostId,
        sessionId: sessionId || '',
        remotePath,
        name: filename,
        mime: result.mime || 'application/octet-stream',
        buffer,
      });
      serveReceivedFile(res, received, inline);
    } catch (error) {
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/detail$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    const detail = getSessionDetail(hostId, sessionId);
    if (!detail) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }

    sendJson(res, 200, detail);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/hosts/import') {
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    state.dismissedHosts.delete(hostId);
    const host = state.hosts.get(hostId) || {
      hostId,
      label: body.label || hostId,
      platform: body.platform || 'unknown',
      capabilities: {},
      registeredAt: nowIso(),
      lastSeenAt: null,
    };
    state.hosts.set(hostId, host);
    const command = enqueueCommand(hostId, { type: 'host.import' });
    sendJson(res, 200, { ok: true, host, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/import$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    state.dismissedHosts.delete(hostId);
    const host = state.hosts.get(hostId) || {
      hostId,
      label: hostId,
      platform: 'unknown',
      capabilities: {},
      registeredAt: nowIso(),
      lastSeenAt: null,
    };
    state.hosts.set(hostId, host);
    const command = enqueueCommand(hostId, { type: 'host.import' });
    sendJson(res, 200, { ok: true, host, command });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/hosts\/[^/]+$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    state.dismissedHosts.add(hostId);
    state.hosts.delete(hostId);
    for (const key of Array.from(state.sessions.keys())) {
      if (key.startsWith(`${hostId}::`)) {
        state.sessions.delete(key);
        state.sessionLogs.delete(key);
        state.sessionAlerts.delete(key);
        state.sessionRuntime.delete(key);
        state.sessionDiagnostics.delete(key);
        state.sessionRequests.delete(key);
      }
    }
    saveSessionLogs();
    sendJson(res, 200, { ok: true, hostId });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/register') {
    const body = await readBody(req);
    if (!body.hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    if (state.dismissedHosts.has(body.hostId)) {
      sendJson(res, 200, { ok: true, dismissed: true });
      return;
    }

    const host = {
      hostId: body.hostId,
      label: body.label || body.hostId,
      platform: body.platform || process.platform,
      capabilities: body.capabilities || {},
      registeredAt: state.hosts.get(body.hostId)?.registeredAt || nowIso(),
      lastSeenAt: nowIso(),
    };
    state.hosts.set(body.hostId, host);
    attachMatchingConnectorsToHost(host);
    state.commandQueues.delete(body.hostId);
    sendJson(res, 200, { ok: true, host });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
    const body = await readBody(req);
    if (state.dismissedHosts.has(body.hostId)) {
      sendJson(res, 200, { ok: true, dismissed: true });
      return;
    }
    const host = state.hosts.get(body.hostId);
    if (host) {
      host.label = body.label || host.label || body.hostId;
      host.platform = body.platform || host.platform || 'unknown';
      host.capabilities = body.capabilities || host.capabilities || {};
      host.lastSeenAt = nowIso();
      state.hosts.set(body.hostId, host);
      attachMatchingConnectorsToHost(host);
    } else if (body.hostId) {
      const nextHost = {
        hostId: body.hostId,
        label: body.label || body.hostId,
        platform: body.platform || 'unknown',
        capabilities: body.capabilities || {},
        registeredAt: nowIso(),
        lastSeenAt: nowIso(),
      };
      state.hosts.set(body.hostId, nextHost);
      attachMatchingConnectorsToHost(nextHost);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent/commands') {
    const hostId = url.searchParams.get('hostId');
    const after = Number(url.searchParams.get('after') || '0');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    sendJson(res, 200, { commands: getCommands(hostId, after) });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/sessions\/start$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const host = state.hosts.get(hostId);
    if (!host) {
      sendJson(res, 404, { error: 'host not found' });
      return;
    }
    if (!hostOnline(host)) {
      sendJson(res, 409, { error: `host ${host.label || hostId} is offline` });
      return;
    }

    const cwd = String(body.cwd || '').trim();
    if (!cwd) {
      sendJson(res, 400, { error: 'cwd is required' });
      return;
    }

    const originSessionId = body.originSessionId || null;
    const sourceSessionId = body.sourceSessionId || originSessionId;
    const launchMode = body.launchMode || (sourceSessionId ? 'resume' : 'fresh');
    const sourceDetail = sourceSessionId ? getSessionDetail(hostId, sourceSessionId) : null;
    const sourceSession = sourceDetail?.session || null;
    const nativeThreadId = String(body.nativeThreadId || sourceSession?.nativeThreadId || sourceSession?.sessionId || '').trim() || null;
    const sessionId = launchMode === 'resume' && sourceSessionId
      ? sourceSessionId
      : (body.sessionId || makeId());
    const bridgeSessionId = sessionId;
    const createdAt = nowIso();
    const resolvedConversationKey = body.conversationKey || originSessionId || sessionId;
    const resumeTranscript = sourceDetail ? buildResumeTranscript(sourceDetail.transcript) : [];

    const apiConfig = normalizeApiConfig(body.apiConfig);
    const apiProfile = summarizeApiConfig(apiConfig);

    upsertSession(hostId, {
      sessionId,
      cwd,
      title: body.label || cwd || sessionId,
      source: 'managed',
      state: 'starting',
      live: false,
      createdAt,
      originSessionId,
      sourceSessionId,
      conversationKey: resolvedConversationKey,
      launchMode,
      bridgeSessionId,
      nativeThreadId: nativeThreadId || sessionId,
      messageCount: sourceDetail?.transcript?.length || 0,
      apiProfile,
    });

    if (sourceDetail && Array.isArray(sourceDetail.transcript)) {
      setSessionLog(hostId, sessionId, sourceDetail.transcript);
    }

    const command = enqueueCommand(hostId, {
      type: 'session.start',
      sessionId,
      bridgeSessionId,
      cwd,
      label: body.label || cwd || sessionId,
      command: body.command || null,
      args: body.args || [],
      createdAt,
      originSessionId,
      sourceSessionId,
      conversationKey: resolvedConversationKey,
      launchMode,
      resumeTranscript,
      nativeThreadId,
      apiConfig,
    });
    sendJson(res, 200, { ok: true, sessionId, command });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/models$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!session.live) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }

    const host = state.hosts.get(hostId);
    if (!host?.capabilities?.modelList) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can list Codex models' });
      return;
    }

    const requestId = makeId();
    const pending = awaitModelListRequest(requestId);
    enqueueCommand(hostId, {
      type: 'session.model_list',
      sessionId,
      requestId,
      includeHidden: url.searchParams.get('includeHidden') === 'true',
      cursor: url.searchParams.get('cursor') || null,
      limit: Number(url.searchParams.get('limit') || 80) || 80,
    });

    try {
      const payload = await pending;
      sendJson(res, 200, payload);
    } catch (error) {
      const statusCode = /not live|no live session/i.test(error.message || '') ? 409 : 504;
      sendJson(res, statusCode, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/input$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!session.live) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }

    const text = String(body.text || '');
    const inputItems = normalizeTurnInputItems(body.inputItems || body.attachments || []);
    const uploadedFiles = normalizeFileTransferRefs(body.uploadedFiles || body.files || []);
    const hasDisplayText = Object.prototype.hasOwnProperty.call(body, 'displayText');
    const displayText = hasDisplayText ? String(body.displayText || '') : text;
    const transcriptText = summarizeTurnInput(displayText, inputItems, uploadedFiles)
      || summarizeTurnInput(text, inputItems, uploadedFiles);
    if (!transcriptText) {
      sendJson(res, 400, { error: 'text or inputItems are required' });
      return;
    }
    const host = state.hosts.get(hostId);
    if (inputItems.length && !host?.capabilities?.imageInput) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can receive image inputs' });
      return;
    }
    const advancedTurnControlRequested = Boolean(
      String(body.model || '').trim()
      || String(body.effort || '').trim()
      || String(body.summary || '').trim()
      || String(body.serviceTier || '').trim()
      || String(body.personality || '').trim()
      || String(body.mode || '').trim() === 'plan'
      || (String(body.sandboxMode || '').trim() && String(body.sandboxMode || '').trim() !== 'workspaceWrite')
      || (String(body.approvalsReviewer || '').trim() && String(body.approvalsReviewer || '').trim() !== 'user')
      || (String(body.approvalPolicy || '').trim() && String(body.approvalPolicy || '').trim() !== 'on-request')
    );
    if (advancedTurnControlRequested && !host?.capabilities?.turnControls) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can use Codex turn controls' });
      return;
    }

    emitTranscriptEntry(hostId, sessionId, {
      speaker: 'user',
      text: transcriptText,
      files: uploadedFiles,
      timestamp: nowIso(),
    });
    const apiConfig = normalizeApiConfig(body.apiConfig);
    const apiProfile = summarizeApiConfig(apiConfig);
    const next = upsertSession(hostId, {
      sessionId,
      latestUserMessage: transcriptText,
      apiProfile: apiProfile || session.apiProfile || null,
      codexOptions: {
        model: String(body.model || '').trim() || null,
        effort: String(body.effort || '').trim() || null,
        summary: String(body.summary || '').trim() || null,
        mode: String(body.mode || '').trim() || null,
        approvalPolicy: typeof body.approvalPolicy === 'object' ? body.approvalPolicy : String(body.approvalPolicy || '').trim() || null,
        approvalsReviewer: String(body.approvalsReviewer || '').trim() || null,
        sandboxMode: String(body.sandboxMode || '').trim() || null,
        serviceTier: String(body.serviceTier || '').trim() || null,
        personality: String(body.personality || '').trim() || null,
      },
      lastUpdatedAt: nowIso(),
    });
    broadcastSessionEvent(hostId, sessionId, 'session.snapshot', next);

    const command = enqueueCommand(hostId, {
      type: 'session.input',
      sessionId,
      text,
      inputItems,
      mode: String(body.mode || '').trim() || null,
      model: String(body.model || '').trim() || null,
      effort: String(body.effort || '').trim() || null,
      summary: String(body.summary || '').trim() || null,
      approvalPolicy: typeof body.approvalPolicy === 'object' ? body.approvalPolicy : String(body.approvalPolicy || '').trim() || null,
      approvalsReviewer: String(body.approvalsReviewer || '').trim() || null,
      sandboxMode: String(body.sandboxMode || '').trim() || null,
      serviceTier: String(body.serviceTier || '').trim() || null,
      personality: String(body.personality || '').trim() || null,
      apiConfig,
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/review$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!session.live) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }

    const host = state.hosts.get(hostId);
    if (!host?.capabilities?.review) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can run Codex reviews' });
      return;
    }

    let target = null;
    try {
      target = normalizeReviewTarget(body);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    const delivery = String(body.delivery || 'inline').trim() === 'detached' ? 'detached' : 'inline';
    const command = enqueueCommand(hostId, {
      type: 'session.review_start',
      sessionId,
      target,
      delivery,
    });
    emitSessionDiagnostic(hostId, sessionId, {
      severity: 'info',
      source: 'ui',
      kind: 'control',
      method: 'review/start',
      message: `Review requested: ${target.type}`,
      data: {
        target,
        delivery,
      },
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/stop$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (session) {
      const next = upsertSession(hostId, {
        sessionId,
        state: 'ending',
        live: true,
        lastUpdatedAt: nowIso(),
      });
      setSessionRuntime(hostId, sessionId, {
        phase: 'ending',
        connection: 'closing',
        busy: false,
        activeTurnId: null,
        updatedAt: nowIso(),
      });
      broadcastSessionEvent(hostId, sessionId, 'session.snapshot', next);
      broadcastSessionEvent(hostId, sessionId, 'session.runtime_updated', {
        hostId,
        sessionId,
        patch: {
          phase: 'ending',
          connection: 'closing',
          busy: false,
          activeTurnId: null,
        },
        timestamp: nowIso(),
      });
    }

    const stopCandidates = Array.from(new Set([
      session?.bridgeSessionId,
      sessionId,
      session?.nativeThreadId,
    ].map((value) => String(value || '').trim()).filter(Boolean)));
    const commands = stopCandidates.map((candidateSessionId) => enqueueCommand(hostId, {
      type: 'session.stop',
      sessionId: candidateSessionId,
      requestedSessionId: sessionId,
      bridgeSessionId: session?.bridgeSessionId || null,
      nativeThreadId: session?.nativeThreadId || null,
      originSessionId: session?.originSessionId || null,
      sourceSessionId: session?.sourceSessionId || null,
      conversationKey: session?.conversationKey || null,
    }));
    scheduleStopFallback(hostId, sessionId);
    sendJson(res, 200, { ok: true, command: commands[0] || null, commands });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/interrupt$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const command = enqueueCommand(hostId, {
      type: 'session.interrupt',
      sessionId,
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/steer$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const text = String(body.text || '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return;
    }

    const command = enqueueCommand(hostId, {
      type: 'session.steer',
      sessionId,
      text,
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/compact$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const command = enqueueCommand(hostId, {
      type: 'session.compact',
      sessionId,
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/shell-command$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const shellCommand = String(body.command || '').trim();
    if (!shellCommand) {
      sendJson(res, 400, { error: 'command is required' });
      return;
    }

    const command = enqueueCommand(hostId, {
      type: 'session.shell_command',
      sessionId,
      command: shellCommand,
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/requests\/[^/]+\/respond$/)) {
    const segments = url.pathname.split('/');
    const sessionId = decodeURIComponent(segments[3]);
    const requestId = decodeURIComponent(segments[5]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const command = enqueueCommand(hostId, {
      type: 'session.request.respond',
      sessionId,
      requestId,
      response: body.response || null,
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/events$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, hostId, sessionId })}\n\n`);
    addSessionSubscriber(hostId, sessionId, res);

    const ping = setInterval(() => {
      res.write(`event: ping\ndata: ${JSON.stringify({ time: nowIso() })}\n\n`);
    }, 20_000);

    req.on('close', () => {
      clearInterval(ping);
      removeSessionSubscriber(hostId, sessionId, res);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/events') {
    const body = await readBody(req);
    const events = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
    for (const event of events) {
      applyAgentEvent(event);
    }
    sendJson(res, 200, { ok: true, count: events.length });
    return;
  }

  if (req.method === 'GET' && serveStatic(req, res, url.pathname)) {
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    if (serveStatic(req, res, '/index.html')) {
      return;
    }
  }

  sendJson(res, 404, { error: 'not found' });
}

function applyAgentEvent(event) {
  if (!event || !event.type || !event.hostId) {
    return;
  }
  if (state.dismissedHosts.has(event.hostId)) {
    return;
  }

  const host = state.hosts.get(event.hostId);
  if (host) {
    host.lastSeenAt = nowIso();
    state.hosts.set(event.hostId, host);
  }

  if (event.type === 'session.discovery') {
    const sessions = Array.isArray(event.sessions) ? event.sessions : [];
    for (const session of sessions) {
      const existing = getSession(event.hostId, session.sessionId);
      const preserveManagedState = existing && existing.source === 'managed' && (existing.live || existing.state === 'starting');
      const next = upsertSession(event.hostId, {
        sessionId: session.sessionId,
        title: session.title || session.sessionId,
        cwd: session.cwd || null,
        source: preserveManagedState ? existing.source : (session.source || 'imported'),
        state: preserveManagedState ? existing.state : (session.live ? 'running' : 'imported'),
        live: preserveManagedState ? existing.live : Boolean(session.live),
        createdAt: session.createdAt || existing?.createdAt || session.updatedAt || nowIso(),
        lastUpdatedAt: session.updatedAt || nowIso(),
        messageCount: Math.max(Number(existing?.messageCount || 0), Number(session.messageCount || 0), Array.isArray(session.transcriptPreview) ? session.transcriptPreview.length : 0),
        latestUserMessage: session.latestUserMessage || null,
        latestAgentMessage: session.latestAgentMessage || null,
        transcriptPreview: session.transcriptPreview || [],
        originSessionId: session.originSessionId || null,
        sourceSessionId: session.sourceSessionId || null,
        conversationKey: session.conversationKey || session.originSessionId || session.sessionId,
        launchMode: session.launchMode || null,
        runtime: preserveManagedState ? existing.runtime || null : session.runtime || existing?.runtime || null,
        bridgeSessionId: session.bridgeSessionId || existing?.bridgeSessionId || null,
        nativeThreadId: existing?.nativeThreadId || session.nativeThreadId || session.sessionId,
      });
      if (!preserveManagedState && !next.live && Array.isArray(session.transcriptPreview)) {
        setSessionLog(event.hostId, next.sessionId, session.transcriptPreview, { merge: true });
      }
      broadcastSessionEvent(event.hostId, next.sessionId, 'session.snapshot', next);
    }
    return;
  }

  if (event.type === 'directory.listed' && event.requestId) {
    const pending = state.pendingDirectoryRequests.get(event.requestId);
    if (pending) {
      pending.resolve({
        hostId: event.hostId,
        currentPath: event.currentPath || null,
        parentPath: event.parentPath || null,
        roots: Array.isArray(event.roots) ? event.roots : [],
        directories: Array.isArray(event.directories) ? event.directories : [],
      });
    }
    return;
  }

  if (event.type === 'directory.error' && event.requestId) {
    const pending = state.pendingDirectoryRequests.get(event.requestId);
    if (pending) {
      pending.reject(new Error(event.message || 'directory listing failed'));
    }
    return;
  }

  if (event.type === 'host.probe' && event.requestId) {
    const pending = state.pendingHostProbes.get(event.requestId);
    if (pending) {
      pending.resolve({
        requestId: event.requestId,
        answeredAt: event.timestamp || nowIso(),
        label: event.label || null,
        platform: event.platform || null,
        capabilities: event.capabilities || null,
      });
    }
    return;
  }

  if (event.type === 'session.model_listed' && event.requestId) {
    const pending = state.pendingModelRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          models: Array.isArray(event.models) ? event.models : [],
          nextCursor: event.nextCursor || null,
          hostId: event.hostId,
          sessionId: event.sessionId || null,
        });
      }
    }
    return;
  }

  if (event.type === 'file.uploaded' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      files: Array.isArray(event.files) ? event.files : [],
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.downloaded' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      name: event.name || null,
      path: event.path || null,
      size: event.size || 0,
      mime: event.mime || 'application/octet-stream',
      dataBase64: event.dataBase64 || '',
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.error' && event.requestId) {
    const pendingFileRequest = state.pendingFileRequests.get(event.requestId) || null;
    removeQueuedFileCommand(event.hostId, event.requestId);
    rejectPendingFileRequest(event.requestId, event.message || 'file transfer failed');
    if (event.sessionId && !pendingFileRequest?.suppressAlert) {
      emitSessionAlert(event.hostId, event.sessionId, {
        severity: 'error',
        source: 'file-transfer',
        message: event.message || 'file transfer failed',
        timestamp: event.timestamp || nowIso(),
      });
    }
    return;
  }

  const sessionId = event.sessionId;
  if (!sessionId) {
    return;
  }

  if (event.type === 'session.started') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    const bridgeSession = event.bridgeSessionId && event.bridgeSessionId !== effectiveSessionId
      ? getSession(event.hostId, event.bridgeSessionId)
      : null;
    const currentSession = getSession(event.hostId, effectiveSessionId);
    const apiProfile = bridgeSession?.apiProfile || currentSession?.apiProfile || null;
    const next = event.bridgeSessionId && event.bridgeSessionId !== effectiveSessionId
      ? migrateSessionIdentity(event.hostId, event.bridgeSessionId, effectiveSessionId, {
        title: event.title || effectiveSessionId,
        cwd: event.cwd || null,
        source: event.source || 'managed',
        state: 'running',
        live: true,
        createdAt: event.createdAt || bridgeSession?.createdAt || currentSession?.createdAt || nowIso(),
        messageCount: bridgeSession?.messageCount || currentSession?.messageCount || 0,
        runtime: event.runtime || null,
        originSessionId: event.originSessionId || null,
        sourceSessionId: event.sourceSessionId || null,
        conversationKey: event.conversationKey || event.originSessionId || effectiveSessionId,
        launchMode: event.launchMode || null,
        nativeThreadId: event.nativeThreadId || effectiveSessionId,
        apiProfile,
      })
      : upsertSession(event.hostId, {
        sessionId: effectiveSessionId,
        title: event.title || effectiveSessionId,
        cwd: event.cwd || null,
        source: event.source || 'managed',
        state: 'running',
        live: true,
        createdAt: event.createdAt || currentSession?.createdAt || nowIso(),
        messageCount: currentSession?.messageCount || 0,
        runtime: event.runtime || null,
        originSessionId: event.originSessionId || null,
        sourceSessionId: event.sourceSessionId || null,
        conversationKey: event.conversationKey || event.originSessionId || effectiveSessionId,
        launchMode: event.launchMode || null,
        bridgeSessionId: event.bridgeSessionId || null,
        nativeThreadId: event.nativeThreadId || effectiveSessionId,
        apiProfile,
        lastUpdatedAt: nowIso(),
      });
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.started', next);
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.snapshot', next);
    return;
  }

  if (event.type === 'session.output') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    const next = upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      state: 'running',
      live: true,
      lastUpdatedAt: nowIso(),
    });

    if (event.stream === 'stderr') {
      const alert = buildAlertFromOutput(event);
      if (alert) {
        emitSessionAlert(event.hostId, effectiveSessionId, alert);
      }
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.snapshot', next);
      return;
    }

    const speaker = classifyOutputSpeaker(event.chunk || '', event.stream || 'stdout');
    if (speaker === 'agent') {
      const snapshot = upsertSession(event.hostId, {
        sessionId: effectiveSessionId,
        state: 'running',
        live: true,
        latestAgentMessage: event.chunk || null,
        lastUpdatedAt: nowIso(),
      });
      emitTranscriptEntry(event.hostId, effectiveSessionId, {
        speaker,
        text: event.chunk || '',
        stream: event.stream || 'stdout',
        timestamp: event.timestamp || nowIso(),
      });
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.output', {
        ...event,
        sessionId: effectiveSessionId,
        hostId: event.hostId,
        timestamp: event.timestamp || nowIso(),
      });
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.snapshot', snapshot);
      return;
    }

    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.snapshot', next);
    return;
  }

  if (event.type === 'session.state_changed') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    const existingSession = getSession(event.hostId, effectiveSessionId);
    const existingRuntime = state.sessionRuntime.get(sessionKey(event.hostId, effectiveSessionId)) || null;
    const wasEnding = existingSession?.state === 'ending' || existingRuntime?.phase === 'ending';
    const next = upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      state: event.state || 'unknown',
      live: typeof event.live === 'boolean' ? event.live : true,
      lastUpdatedAt: nowIso(),
    });

    if (event.live === false) {
      const runtime = setSessionRuntime(event.hostId, effectiveSessionId, {
        phase: 'closed',
        connection: 'closed',
        busy: false,
        activeTurnId: null,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        updatedAt: event.timestamp || nowIso(),
      });
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.runtime_updated', {
        hostId: event.hostId,
        sessionId: effectiveSessionId,
        patch: runtime,
        timestamp: event.timestamp || nowIso(),
      });
    }

    if (/^failed:/i.test(next.state) || (/^exited:(?!0:)/i.test(next.state) && !wasEnding)) {
      emitSessionAlert(event.hostId, effectiveSessionId, {
        severity: 'error',
        source: 'runtime',
        message: `Session state changed: ${next.state}`,
        timestamp: event.timestamp || nowIso(),
      });
    }

    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.state_changed', next);
    return;
  }

  if (event.type === 'session.runtime_updated') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    const runtime = setSessionRuntime(event.hostId, effectiveSessionId, {
      ...(event.patch || {}),
      updatedAt: event.timestamp || nowIso(),
    });
    const phase = String(runtime?.phase || '').toLowerCase();
    const turnIsInactive = !runtime?.activeTurnId
      && !runtime?.busy
      && !runtime?.waitingOnApproval
      && !runtime?.waitingOnUserInput
      && ['idle', 'error', 'interrupted', 'closed', 'quota-exhausted'].includes(phase);
    if (turnIsInactive) {
      resolvePendingSessionRequests(event.hostId, effectiveSessionId, {
        status: phase === 'error' || phase === 'quota-exhausted' ? 'failed' : 'expired',
        updatedAt: event.timestamp || nowIso(),
        message: `Request closed because the session runtime is ${phase}.`,
      });
    }
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.runtime', {
      ...(runtime || {}),
      hostId: event.hostId,
      sessionId: effectiveSessionId,
    });
    return;
  }

  if (event.type === 'session.review_started') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    emitSessionDiagnostic(event.hostId, effectiveSessionId, {
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'review/start',
      message: `Review started${event.reviewThreadId ? `: ${event.reviewThreadId}` : ''}`,
      data: {
        reviewThreadId: event.reviewThreadId || null,
        turnId: event.turnId || null,
        target: event.target || null,
        delivery: event.delivery || null,
      },
      turnId: event.turnId || null,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'session.diagnostic') {
    emitSessionDiagnostic(event.hostId, sessionId, {
      severity: event.severity || 'info',
      source: event.source || 'codex',
      kind: event.kind || 'event',
      method: event.method || null,
      message: event.message || '',
      detail: event.detail || null,
      data: event.data || null,
      turnId: event.turnId || event.data?.turnId || null,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'session.request') {
    emitSessionRequest(event.hostId, sessionId, {
      requestId: event.requestId,
      createdAt: event.timestamp || nowIso(),
      updatedAt: event.timestamp || nowIso(),
      status: event.status || 'pending',
      kind: event.kind || 'request',
      method: event.method || null,
      title: event.title || null,
      message: event.message || null,
      summary: event.summary || null,
      payload: event.payload || null,
      response: event.response || null,
    });
    return;
  }

  if (event.type === 'session.request.resolved') {
    resolveSessionRequest(event.hostId, sessionId, event.requestId, {
      status: event.status || 'resolved',
      updatedAt: event.timestamp || nowIso(),
      response: event.response || null,
      summary: event.summary || null,
      message: event.message || null,
    });
    return;
  }

  if (event.type === 'session.error') {
    const message = event.message || 'session error';
    if (/no live session for command session\.(model_list|stop)/i.test(message)) {
      markSessionClosed(event.hostId, sessionId);
      return;
    }

    emitSessionAlert(event.hostId, sessionId, {
      severity: 'error',
      source: 'runtime',
      message,
      timestamp: event.timestamp || nowIso(),
    });
    broadcastSessionEvent(event.hostId, sessionId, 'session.error', {
      ...event,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'session.alert') {
    emitSessionAlert(event.hostId, sessionId, {
      severity: event.severity || 'warning',
      source: event.source || 'runtime',
      message: event.message || '',
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message || 'internal error' });
      return;
    }
    res.destroy(error);
  });
});

server.listen(PORT, () => {
  console.log(`relay listening on http://127.0.0.1:${PORT}`);
  if (RELAY_AUTH_TOKEN) {
    console.log(`relay auth enabled; token file: ${RELAY_AUTH_TOKEN_PATH}`);
    console.log(relayAuthAccount?.username
      ? `relay web login enabled for user: ${relayAuthAccount.username}`
      : `relay web login setup pending; account file: ${RELAY_AUTH_ACCOUNT_PATH}`);
  } else {
    console.warn('relay auth disabled by RELAY_AUTH_DISABLED');
  }
});
