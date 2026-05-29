const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { discoverCodexSessions, getDefaultCodexHome } = require('../../shared/codex-discovery');
const { makeId, nowIso, normalizeArgs } = require('../../shared/protocol');
const { startCodexAppServerSession } = require('./codex-app-server-runner');

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const RELAY_AUTH_TOKEN = loadRelayAuthToken();
const HOST_ID = process.env.HOST_ID || os.hostname();
const HOST_LABEL = process.env.HOST_LABEL || HOST_ID;
const CODEX_HOME = process.env.CODEX_HOME || getDefaultCodexHome();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);
const DISCOVERY_INTERVAL_MS = Number(process.env.DISCOVERY_INTERVAL_MS || 15000);
const AUTO_START_SESSION = String(process.env.AUTO_START_SESSION || 'true') !== 'false';
const MANAGED_COMMAND = process.env.MANAGED_COMMAND || 'codex-app-server';
const MANAGED_ARGS = normalizeArgs(process.env.MANAGED_ARGS_JSON || '[]');
const MANAGED_CWD = process.env.MANAGED_CWD || process.cwd();
const WORKSPACE_ROOTS = parseWorkspaceRoots(process.env.WORKSPACE_ROOTS || '');
const MAX_FILE_TRANSFER_BYTES = Number(process.env.AGENT_MAX_FILE_TRANSFER_BYTES || 128 * 1024 * 1024);
const MAX_CHUNKED_FILE_TRANSFER_BYTES = Number(process.env.AGENT_MAX_CHUNKED_FILE_TRANSFER_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_FILE_CHUNK_BYTES = Number(process.env.AGENT_FILE_TRANSFER_CHUNK_BYTES || 4 * 1024 * 1024);

const liveSessions = new Map();
const activeFileUploads = new Map();
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

function normalizeApiConfig(input = {}) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const provider = String(input.provider || '').trim().slice(0, 80);
  const baseUrl = String(input.baseUrl || '').trim().slice(0, 500);
  const apiKey = String(input.apiKey || '').trim();
  if (!baseUrl && !apiKey) {
    return null;
  }
  return {
    provider: provider || 'OpenAI',
    baseUrl,
    apiKey,
  };
}

function buildApiEnvironment(apiConfig) {
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return {};
  }
  const env = {};
  if (config.apiKey) {
    env.OPENAI_API_KEY = config.apiKey;
  }
  if (config.baseUrl) {
    env.OPENAI_BASE_URL = config.baseUrl;
    env.OPENAI_API_BASE = config.baseUrl;
  }
  return env;
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
    modelList: true,
    review: true,
    imageInput: true,
    fileTransfer: true,
    chunkedFileTransfer: true,
    demoMode: MANAGED_COMMAND === 'demo',
  };
}

function fetchJson(targetUrl, options = {}) {
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;
  const authHeaders = RELAY_AUTH_TOKEN
    ? { Authorization: `Bearer ${RELAY_AUTH_TOKEN}` }
    : {};

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
      }
    );

    req.on('error', (error) => settle(reject, error));
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

async function postEvent(event) {
  await fetchJson(`${RELAY_URL}/api/agent/events`, {
    method: 'POST',
    body: { event },
  });
}

async function registerHost() {
  await fetchJson(`${RELAY_URL}/api/agent/register`, {
    method: 'POST',
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
  const sessions = discoverCodexSessions({ codexHome: CODEX_HOME }).map((session) => ({
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
      nativeThreadId: runner.nativeThreadId || liveSessionId,
      launchMode: runner.launchMode || null,
      runtime: runner.runtime || null,
    });
  }

  await postEvent({
    type: 'session.discovery',
    hostId: HOST_ID,
    sessions,
  });
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
    for (let code = 67; code <= 90; code += 1) {
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
  const raw = String(inputPath || '').trim();
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
  const raw = String(inputPath || '').trim();
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

function resolveManagedCommand(command) {
  if (!command || command === 'demo') {
    return {
      kind: 'demo',
      command: process.execPath,
      args: [path.join(__dirname, 'demo-session.js')],
    };
  }

  if (command === 'codex-app-server') {
    return {
      kind: 'codex-app-server',
      command,
      args: [],
    };
  }

  return {
    kind: 'process',
    command,
    args: MANAGED_ARGS,
  };
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
  const target = String(cwd || '').trim();
  if (!target) {
    return MANAGED_CWD;
  }

  return path.isAbsolute(target) ? target : path.resolve(MANAGED_CWD, target);
}

async function failManagedSession(sessionId, cwd, message, state = 'failed') {
  await postEvent({
    type: 'session.error',
    hostId: HOST_ID,
    sessionId,
    message,
    timestamp: nowIso(),
  });

  await postEvent({
    type: 'session.state_changed',
    hostId: HOST_ID,
    sessionId,
    state,
    live: false,
    timestamp: nowIso(),
  });
}

function startProcessManagedSession({ sessionId, cwd, command, args, label, originSessionId, sourceSessionId, conversationKey, launchMode, apiConfig, bootstrap }) {
  const createdAt = nowIso();
  const spawnOptions = {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: {
      ...process.env,
      ...buildApiEnvironment(apiConfig),
      DEMO_BOOTSTRAP_JSON: JSON.stringify(bootstrap),
      DEMO_SESSION_LABEL: String(label || cwd || sessionId),
    },
  };

  const child = spawn(command, args, spawnOptions);
  const runner = {
    kind: 'process',
    sessionId,
    title: label || cwd || sessionId,
    cwd,
    createdAt,
    originSessionId: originSessionId || null,
    sourceSessionId: sourceSessionId || null,
    conversationKey: conversationKey || originSessionId || sessionId,
    launchMode: launchMode || null,
    runtime: {
      kind: 'child_process',
      command,
      args,
      cwd,
    },
    async sendInput(text) {
      child.stdin.write(`${String(text || '')}\n`);
    },
    async stop() {
      child.kill();
    },
  };

  liveSessions.set(sessionId, runner);

  const stdout = require('readline').createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = require('readline').createInterface({ input: child.stderr, crlfDelay: Infinity });

  stdout.on('line', (line) => {
    postEvent({
      type: 'session.output',
      hostId: HOST_ID,
      sessionId,
      stream: 'stdout',
      chunk: line,
      timestamp: nowIso(),
    }).catch((error) => {
      console.error('[agent] failed to forward stdout', error.message);
    });
  });

  stderr.on('line', (line) => {
    postEvent({
      type: 'session.output',
      hostId: HOST_ID,
      sessionId,
      stream: 'stderr',
      chunk: line,
      timestamp: nowIso(),
    }).catch((error) => {
      console.error('[agent] failed to forward stderr', error.message);
    });
  });

  child.on('error', (error) => {
    liveSessions.delete(sessionId);
    failManagedSession(sessionId, cwd, `managed session error: ${error.message}`, 'failed:runtime-error').catch((postError) => {
      console.error('[agent] failed to forward runtime error', postError.message);
    });
  });

  child.on('exit', (code, signal) => {
    liveSessions.delete(sessionId);
    postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId,
      state: `exited:${code ?? 'null'}:${signal ?? 'null'}`,
      live: false,
      timestamp: nowIso(),
    }).catch((error) => {
      console.error('[agent] failed to forward exit state', error.message);
    });
  });

  return runner;
}

async function startManagedSession(command) {
  const bridgeSessionId = command.sessionId || makeId();
  const createdAt = command.createdAt || nowIso();
  const cwd = resolveManagedCwd(command.cwd || MANAGED_CWD);
  const resolved = resolveManagedCommand(command.command || MANAGED_COMMAND);
  const args = command.args && command.args.length ? normalizeArgs(command.args) : resolved.args;
  const bootstrap = buildResumeBootstrap(command);
  const title = command.label || command.cwd || bridgeSessionId;
  const apiConfig = normalizeApiConfig(command.apiConfig);
  let announcedSessionId = bridgeSessionId;

  if (!fs.existsSync(cwd)) {
    await failManagedSession(bridgeSessionId, cwd, `workspace path does not exist: ${cwd}`, 'failed:missing-workspace');
    return bridgeSessionId;
  }

  let cwdStats = null;
  try {
    cwdStats = fs.statSync(cwd);
  } catch (error) {
    await failManagedSession(bridgeSessionId, cwd, `failed to inspect workspace path: ${error.message}`, 'failed:workspace-stat-error');
    return bridgeSessionId;
  }

  if (!cwdStats.isDirectory()) {
    await failManagedSession(bridgeSessionId, cwd, `workspace path is not a directory: ${cwd}`, 'failed:not-a-directory');
    return bridgeSessionId;
  }

  try {
    let runner = null;

    if (resolved.kind === 'codex-app-server') {
      runner = await startCodexAppServerSession({
        hostId: HOST_ID,
        sessionId: bridgeSessionId,
        bridgeSessionId,
        title,
        cwd,
        launchMode: command.launchMode || null,
        nativeThreadId: command.nativeThreadId || null,
        codexHome: CODEX_HOME,
        apiConfig,
        bootstrap,
        postEvent,
        onTerminated: () => {
          liveSessions.delete(bridgeSessionId);
          liveSessions.delete(announcedSessionId);
        },
      });
      runner.createdAt = runner.createdAt || createdAt;
      announcedSessionId = runner.sessionId || bridgeSessionId;
      liveSessions.set(bridgeSessionId, runner);
      liveSessions.set(announcedSessionId, runner);
    } else {
      runner = startProcessManagedSession({
        sessionId: bridgeSessionId,
        cwd,
        command: resolved.command,
        args,
        label: title,
        originSessionId: command.originSessionId || null,
        sourceSessionId: command.sourceSessionId || null,
        conversationKey: command.conversationKey || command.originSessionId || bridgeSessionId,
        launchMode: command.launchMode || null,
        apiConfig,
        bootstrap,
      });
    }

    await postEvent({
      type: 'session.started',
      hostId: HOST_ID,
      sessionId: announcedSessionId,
      bridgeSessionId: announcedSessionId === bridgeSessionId ? null : bridgeSessionId,
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
        command: resolved.command,
        args,
        cwd,
      },
    });
  } catch (error) {
    await failManagedSession(bridgeSessionId, cwd, `failed to spawn managed session: ${error.message}`, 'failed:spawn-error');
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
    await sendDiscovery();
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

    if (command.type === 'session.stop') {
      await postEvent({
        type: 'session.state_changed',
        hostId: HOST_ID,
        sessionId: command.requestedSessionId || command.sessionId,
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
        serviceTier: command.serviceTier || null,
        personality: command.personality || null,
        apiConfig: normalizeApiConfig(command.apiConfig),
      });
    } catch (error) {
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
      await runner.compactThread();
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
      state: 'history-only',
      live: false,
      timestamp: nowIso(),
    });
    return;
  }
}

async function pollCommandsLoop() {
  while (true) {
    try {
      const result = await fetchJson(`${RELAY_URL}/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${lastCommandId}`);
      const commands = Array.isArray(result.body && result.body.commands) ? result.body.commands : [];
      for (const command of commands) {
        lastCommandId = Math.max(lastCommandId, Number(command.id || 0));
        await handleCommand(command);
      }
      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      console.error('[agent] command poll failed:', error.message);
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
      console.error('[agent] discovery failed:', error.message);
      await sleep(Math.max(DISCOVERY_INTERVAL_MS, 3000));
    }
  }
}

async function heartbeatLoop() {
  while (true) {
    try {
      await heartbeat();
      await sleep(5000);
    } catch (error) {
      console.error('[agent] heartbeat failed:', error.message);
      await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`[agent] host ${HOST_ID} connecting to ${RELAY_URL}`);
  console.log(`[agent] codex home ${CODEX_HOME}`);

  await retryStartupStep('register host', registerHost);
  await retryStartupStep('send initial discovery', sendDiscovery);

  if (AUTO_START_SESSION) {
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

  await Promise.all([pollCommandsLoop(), discoveryLoop(), heartbeatLoop()]);
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
      console.error(`[agent] ${label} failed (${attempt}/${attempts}): ${error.message}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

main().catch((error) => {
  console.error('[agent] fatal:', error);
  process.exit(1);
});
