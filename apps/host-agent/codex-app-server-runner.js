const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { nowIso } = require('../../shared/protocol');

const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RPC_REQUEST_TIMEOUT_MS || 15000);

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function shouldSurfaceStderrLine(text) {
  if (!text) {
    return false;
  }

  if (/^Updating files:\s+\d+%/.test(text)) {
    return false;
  }

  if (/^\s*</.test(text)) {
    return false;
  }

  if (/^\s*[A-Za-z0-9_-]+\s*=/.test(text)) {
    return false;
  }

  if (/^\s*[/>]\s*$/.test(text)) {
    return false;
  }

  if (/^error: unable to write file plugins\//.test(text)) {
    return false;
  }

  if (/^fatal: cannot create directory at 'plugins\//.test(text)) {
    return false;
  }

  if (/^warning: Clone succeeded, but checkout failed\./.test(text)) {
    return false;
  }

  if (/^You can inspect what was checked out/.test(text)) {
    return false;
  }

  if (/^and retry with /.test(text)) {
    return false;
  }

  return true;
}

function isRuntimeDiagnosticStderrLine(text) {
  return /codex_app_server: failed to initialize sqlite state db/i.test(text)
    || /Codex could not find bubblewrap on PATH/i.test(text)
    || /sandbox prerequisites/i.test(text)
    || /concepts\/sandboxing#prerequisites/i.test(text);
}

const CODEX_SCAN_SKIP_DIRS = new Set([
  '.cache',
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  'cache',
  'history',
  'logs',
  'node_modules',
  'projects',
  'sessions',
  'tmp',
  'temp',
]);

function isExecutableFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }
    return Boolean(stats.mode & 0o111);
  } catch {
    return false;
  }
}

function pushUnique(list, seen, value) {
  if (!value || seen.has(value)) {
    return;
  }
  seen.add(value);
  list.push(value);
}

function isCodexExecutableName(name) {
  const lower = String(name || '').toLowerCase();
  if (
    lower.startsWith('codex-command-runner')
    || lower.startsWith('codex-windows-sandbox')
    || lower.startsWith('codex-sandbox')
  ) {
    return false;
  }
  return lower === 'codex' || lower === 'codex.exe' || /^codex[-_.]/.test(lower);
}

function collectCodexExecutables(rootDir, options = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const maxDepth = options.maxDepth ?? 4;
  const maxEntries = options.maxEntries ?? 600;
  const found = [];
  const seen = new Set();
  let visitedEntries = 0;

  function visit(dir, depth) {
    if (depth > maxDepth || visitedEntries >= maxEntries) {
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visitedEntries >= maxEntries) {
        return;
      }
      visitedEntries += 1;

      const fullPath = path.join(dir, entry.name);
      if (isCodexExecutableName(entry.name) && isExecutableFile(fullPath)) {
        pushUnique(found, seen, fullPath);
        continue;
      }

      if (!entry.isDirectory() || depth >= maxDepth) {
        continue;
      }

      if (CODEX_SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) {
        continue;
      }

      visit(fullPath, depth + 1);
    }
  }

  visit(rootDir, 0);
  return found;
}

function resolveDefaultCodexBin(codexHomeOverride = null) {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }

  const candidates = [];
  const seen = new Set();
  const home = os.homedir();
  const agentRoot = path.resolve(__dirname, '..', '..');

  for (const relativePath of [
    path.join('.runtime', 'codex', 'codex'),
    path.join('.runtime', 'codex', 'bin', 'linux-x86_64', 'codex'),
    path.join('.runtime', 'codex', 'linux-x86_64', 'codex'),
  ]) {
    pushUnique(candidates, seen, path.join(agentRoot, relativePath));
  }

  const codexRoots = [
    codexHomeOverride,
    process.env.CODEX_HOME,
    path.join(home, '.codex'),
  ].filter(Boolean);

  for (const absolutePath of [
    path.join(home, 'bin', 'codex'),
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.cargo', 'bin', 'codex'),
    process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'bin', 'codex') : null,
    process.env.NPM_CONFIG_PREFIX ? path.join(process.env.NPM_CONFIG_PREFIX, 'bin', 'codex') : null,
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'codex') : null,
  ]) {
    pushUnique(candidates, seen, absolutePath);
  }

  for (const root of codexRoots) {
    for (const relativePath of [
      path.join('bin', 'codex'),
      'codex',
      path.join('bin', 'codex-x86_64-unknown-linux-musl'),
      path.join('bin', 'codex-x86_64-unknown-linux-gnu'),
      path.join('codex', 'bin', 'codex'),
      path.join('cli', 'codex'),
      path.join('node_modules', '.bin', 'codex'),
      path.join('npm', 'bin', 'codex'),
    ]) {
      pushUnique(candidates, seen, path.join(root, relativePath));
    }

    for (const binPath of collectCodexExecutables(root)) {
      pushUnique(candidates, seen, binPath);
    }
  }

  for (const root of [
    path.join(home, '.conda', 'envs'),
    path.join(home, '.nvm', 'versions', 'node'),
  ]) {
    for (const binPath of collectCodexExecutables(root, { maxDepth: 3, maxEntries: 4000 })) {
      pushUnique(candidates, seen, binPath);
    }
  }

  const cursorExtensions = path.join(home, '.cursor', 'extensions');
  if (fs.existsSync(cursorExtensions)) {
    const extensionDirs = fs.readdirSync(cursorExtensions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const entry of extensionDirs) {
      for (const platformDir of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x86_64']) {
        const binName = platformDir === 'windows-x86_64' ? 'codex.exe' : 'codex';
        pushUnique(candidates, seen, path.join(cursorExtensions, entry, 'bin', platformDir, binName));
      }
    }
  }

  return candidates.find((candidate) => isExecutableFile(candidate)) || 'codex';
}

function buildCodexProcessPath(codexBin) {
  const entries = [];
  const seen = new Set();

  function pushPath(value) {
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    entries.push(value);
  }

  const binDir = path.dirname(codexBin || '');
  for (const candidate of [
    path.join(binDir, 'codex-resources'),
    path.join(path.dirname(binDir), 'codex-resources'),
  ]) {
    if (candidate && fs.existsSync(candidate)) {
      pushPath(candidate);
    }
  }

  pushPath(process.env.PATH || '');
  return entries.filter(Boolean).join(path.delimiter);
}

function buildResumePrelude(bootstrap) {
  const historyPreview = Array.isArray(bootstrap?.historyPreview) ? bootstrap.historyPreview : [];
  if (!historyPreview.length) {
    return null;
  }

  const lines = historyPreview
    .map((entry) => {
      const speaker = entry.speaker === 'user' ? 'User' : entry.speaker === 'assistant' ? 'Codex' : 'System';
      return `${speaker}: ${String(entry.text || '').trim()}`;
    })
    .filter(Boolean);

  if (!lines.length) {
    return null;
  }

  return [
    'Continue this conversation with the following prior context in mind:',
    ...lines,
  ].join('\n');
}

function limitText(value, max = 240) {
  const text = String(value || '');
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function summarizeValue(value, depth = 0) {
  if (value === null || typeof value === 'undefined') {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(limitText(value, depth === 0 ? 240 : 120));
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => summarizeValue(item, depth + 1));
    return `[${items.join(', ')}${value.length > 4 ? ', …' : ''}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 6).map(([key, item]) => `${key}: ${summarizeValue(item, depth + 1)}`);
    return `{ ${entries.join(', ')}${Object.keys(value).length > 6 ? ', …' : ''} }`;
  }

  return JSON.stringify(value);
}

function normalizeThinkingText(value, depth = 0) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeThinkingText(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof value === 'object') {
    if (typeof value.step === 'string' && value.step.trim()) {
      const status = typeof value.status === 'string' && value.status.trim()
        ? `[${value.status.trim()}] `
        : '';
      const extra = typeof value.summary === 'string' && value.summary.trim() && value.summary.trim() !== value.step.trim()
        ? ` - ${value.summary.trim()}`
        : '';
      return `${status}${value.step.trim()}${extra}`.trim();
    }

    for (const key of ['text', 'content', 'summary', 'description', 'title', 'label']) {
      if (typeof value[key] === 'string' && value[key].trim()) {
        return value[key].trim();
      }
    }

    if (depth > 1) {
      return summarizeValue(value, depth);
    }

    return Object.entries(value)
      .map(([key, item]) => {
        const normalized = normalizeThinkingText(item, depth + 1);
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return String(value).trim();
}

function mergeThinkingBuffer(previous, chunk) {
  const left = String(previous || '').trim();
  const right = String(chunk || '').trim();
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  if (left === right || left.includes(right)) {
    return left;
  }
  if (right.includes(left)) {
    return right;
  }
  return `${left}\n${right}`.trim();
}

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);
const APPROVAL_POLICIES = new Set(['untrusted', 'on-failure', 'on-request', 'never']);
const APPROVAL_REVIEWERS = new Set(['user', 'auto_review', 'guardian_subagent']);
const SANDBOX_MODES = new Set(['workspaceWrite', 'workspace-write', 'readOnly', 'read-only', 'dangerFullAccess', 'danger-full-access', 'externalSandbox', 'external-sandbox']);
const PERSONALITIES = new Set(['none', 'friendly', 'pragmatic']);

function pickAllowedString(value, allowedValues) {
  const text = String(value || '').trim();
  return text && allowedValues.has(text) ? text : null;
}

function normalizeSandboxMode(value) {
  const mode = pickAllowedString(value, SANDBOX_MODES) || 'workspaceWrite';
  return {
    'workspace-write': 'workspaceWrite',
    'read-only': 'readOnly',
    'danger-full-access': 'dangerFullAccess',
    'external-sandbox': 'externalSandbox',
  }[mode] || mode;
}

function buildSandboxPolicy(cwd, options = {}) {
  const mode = normalizeSandboxMode(options.sandboxMode);
  const networkAccess = options.networkAccess === true;

  if (mode === 'dangerFullAccess') {
    return { type: 'dangerFullAccess' };
  }

  if (mode === 'readOnly') {
    return {
      type: 'readOnly',
      networkAccess,
    };
  }

  if (mode === 'externalSandbox') {
    return {
      type: 'externalSandbox',
      networkAccess: networkAccess ? 'enabled' : 'restricted',
    };
  }

  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess,
  };
}

function normalizeInputItems(text, options = {}) {
  const items = [];
  const prompt = String(text || '').trim();
  if (prompt) {
    items.push({
      type: 'text',
      text: prompt,
    });
  }

  const rawItems = [
    ...(Array.isArray(options.inputItems) ? options.inputItems : []),
    ...(Array.isArray(options.attachments) ? options.attachments : []),
  ];

  for (const rawItem of rawItems.slice(0, 8)) {
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }
    const type = String(rawItem.type || '').trim();

    if (type === 'image') {
      const url = String(rawItem.url || rawItem.dataUrl || '').trim();
      if (url) {
        items.push({ type: 'image', url });
      }
      continue;
    }

    if (type === 'localImage') {
      const imagePath = String(rawItem.path || '').trim();
      if (imagePath) {
        items.push({ type: 'localImage', path: imagePath });
      }
      continue;
    }

    if (type === 'mention' || type === 'skill') {
      const name = String(rawItem.name || '').trim();
      const itemPath = String(rawItem.path || '').trim();
      if (name && itemPath) {
        items.push({ type, name, path: itemPath });
      }
    }
  }

  return items;
}

function normalizeTurnStartParams(threadId, cwd, text, options = {}) {
  const input = normalizeInputItems(text, options);
  const params = {
    threadId,
    cwd,
    approvalPolicy: typeof options.approvalPolicy === 'object'
      ? options.approvalPolicy
      : pickAllowedString(options.approvalPolicy, APPROVAL_POLICIES) || 'on-request',
    sandboxPolicy: buildSandboxPolicy(cwd, options),
    input,
  };

  const model = String(options.model || '').trim();
  if (model) {
    params.model = model;
  }

  const effort = pickAllowedString(options.effort, REASONING_EFFORTS);
  if (effort) {
    params.effort = effort;
  }

  const summary = pickAllowedString(options.summary, REASONING_SUMMARIES);
  if (summary) {
    params.summary = summary;
  }

  const approvalsReviewer = pickAllowedString(options.approvalsReviewer, APPROVAL_REVIEWERS);
  if (approvalsReviewer) {
    params.approvalsReviewer = approvalsReviewer;
  }

  const personality = pickAllowedString(options.personality, PERSONALITIES);
  if (personality) {
    params.personality = personality;
  }

  const serviceTier = String(options.serviceTier || '').trim();
  if (serviceTier) {
    params.serviceTier = serviceTier;
  }

  return params;
}

function normalizeReviewTarget(input = {}) {
  const target = input.target && typeof input.target === 'object' ? input.target : input;
  const type = String(target.type || 'uncommittedChanges').trim();

  if (type === 'baseBranch') {
    const branch = String(target.branch || '').trim();
    if (!branch) {
      throw new Error('baseBranch review requires branch');
    }
    return { type, branch };
  }

  if (type === 'commit') {
    const sha = String(target.sha || '').trim();
    if (!sha) {
      throw new Error('commit review requires sha');
    }
    return {
      type,
      sha,
      title: String(target.title || '').trim() || null,
    };
  }

  if (type === 'custom') {
    const instructions = String(target.instructions || '').trim();
    if (!instructions) {
      throw new Error('custom review requires instructions');
    }
    return { type, instructions };
  }

  return { type: 'uncommittedChanges' };
}

function describeThreadStatus(status) {
  if (!status || typeof status !== 'object') {
    return 'unknown';
  }

  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags.join(', ') : '';
    return flags ? `active (${flags})` : 'active';
  }

  return String(status.type || 'unknown');
}

function describeCodexError(errorInfo) {
  if (!errorInfo) {
    return null;
  }

  if (typeof errorInfo === 'string') {
    return errorInfo;
  }

  if (errorInfo.httpConnectionFailed) {
    return `httpConnectionFailed${errorInfo.httpConnectionFailed.httpStatusCode ? ` (${errorInfo.httpConnectionFailed.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseStreamConnectionFailed) {
    return `responseStreamConnectionFailed${errorInfo.responseStreamConnectionFailed.httpStatusCode ? ` (${errorInfo.responseStreamConnectionFailed.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseStreamDisconnected) {
    return `responseStreamDisconnected${errorInfo.responseStreamDisconnected.httpStatusCode ? ` (${errorInfo.responseStreamDisconnected.httpStatusCode})` : ''}`;
  }

  if (errorInfo.responseTooManyFailedAttempts) {
    return `responseTooManyFailedAttempts${errorInfo.responseTooManyFailedAttempts.httpStatusCode ? ` (${errorInfo.responseTooManyFailedAttempts.httpStatusCode})` : ''}`;
  }

  if (errorInfo.activeTurnNotSteerable) {
    return `activeTurnNotSteerable (${errorInfo.activeTurnNotSteerable.turnKind || 'unknown'})`;
  }

  return summarizeValue(errorInfo);
}

class JsonRpcSession {
  constructor(child, handlers = {}) {
    this.child = child;
    this.handlers = handlers;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.closedError = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.on('error', (error) => {
      this.rejectPending(error);
      if (typeof this.handlers.onError === 'function') {
        this.handlers.onError(error);
      }
    });
    child.on('exit', (code, signal) => {
      this.rejectPending(new Error(`codex app-server exited early: ${code ?? 'null'} / ${signal ?? 'null'}`));
      if (typeof this.handlers.onExit === 'function') {
        this.handlers.onExit(code, signal);
      }
    });
  }

  rejectPending(error) {
    this.closedError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }

    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8');
  }

  respondError(id, code, message) {
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
      },
    })}\n`, 'utf8');
  }

  onStdout(chunk) {
    this.buffer += chunk;

    while (this.buffer.includes('\n')) {
      const newlineIndex = this.buffer.indexOf('\n');
      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!rawLine) {
        continue;
      }

      let message = null;
      try {
        message = JSON.parse(rawLine);
      } catch (error) {
        if (typeof this.handlers.onRawStdout === 'function') {
          this.handlers.onRawStdout(rawLine);
        }
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'result')) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && Object.prototype.hasOwnProperty.call(message, 'error')) {
      const pending = this.pending.get(message.id);
      const error = new Error(message.error?.message || `JSON-RPC error for ${message.id}`);
      if (pending) {
        this.pending.delete(message.id);
        pending.reject(error);
        return;
      }

      if (typeof this.handlers.onNotification === 'function') {
        this.handlers.onNotification({
          method: 'jsonrpc.error',
          params: message.error || {},
        });
      }
      return;
    }

    if (!message.method) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      Promise.resolve()
        .then(() => this.handlers.onServerRequest && this.handlers.onServerRequest(message))
        .catch((error) => {
          this.respondError(message.id, -32000, error.message || 'server request failed');
        });
      return;
    }

    if (typeof this.handlers.onNotification === 'function') {
      this.handlers.onNotification(message);
    }
  }
}

class CodexAppServerRunner {
  constructor(options) {
    this.hostId = options.hostId;
    this.sessionId = options.sessionId;
    this.bridgeSessionId = options.bridgeSessionId || options.sessionId;
    this.title = options.title;
    this.cwd = options.cwd;
    this.launchMode = options.launchMode || 'fresh';
    this.bootstrap = options.bootstrap || null;
    this.postEvent = options.postEvent;
    this.onTerminated = options.onTerminated || null;
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.codexBin = options.codexBin || resolveDefaultCodexBin(this.codexHome);
    this.child = null;
    this.rpc = null;
    this.threadId = null;
    this.nativeThreadId = options.nativeThreadId || null;
    this.activeTurnId = null;
    this.turnBuffers = new Map();
    this.planBuffers = new Map();
    this.reasoningBuffers = new Map();
    this.pendingRequests = new Map();
    this.resumePrelude = buildResumePrelude(this.bootstrap);
    this.resumePreludeUsed = !this.resumePrelude;
    this.runtime = {
      kind: 'codex_app_server',
      command: this.codexBin,
      args: ['app-server'],
      cwd: this.cwd,
      nativeThreadId: null,
      launchMode: this.launchMode,
      resumeStrategy: 'fresh',
      connection: 'starting',
      phase: 'starting',
      busy: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      updatedAt: nowIso(),
    };
  }

  async start() {
    this.child = spawn(this.codexBin, ['app-server'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
        PATH: buildCodexProcessPath(this.codexBin),
        HOME: path.dirname(this.codexHome),
        USERPROFILE: path.dirname(this.codexHome),
        HOMEDRIVE: (path.parse(path.dirname(this.codexHome)).root || process.env.HOMEDRIVE || '').replace(/\\$/, ''),
        HOMEPATH: path.dirname(this.codexHome).replace(/^[A-Za-z]:/, '') || process.env.HOMEPATH || '',
      },
    });

    let spawnError = null;
    const onEarlyError = (error) => {
      spawnError = error;
      this.emitAlert({
        severity: 'error',
        source: 'runtime',
        message: `codex app-server failed to start: ${error.message}`,
      }).catch(() => {});
    };
    this.child.once('error', onEarlyError);

    await this.emitRuntime({ connection: 'connecting', phase: 'booting' });
    if (spawnError) {
      this.child.off('error', onEarlyError);
      throw spawnError;
    }

    const stderr = readline.createInterface({
      input: this.child.stderr,
      crlfDelay: Infinity,
    });

    stderr.on('line', async (line) => {
      const text = stripAnsi(line);
      const summary = text.length > 420 ? `${text.slice(0, 417)}...` : text;
      if (isRuntimeDiagnosticStderrLine(text)) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'stderr',
          kind: 'runtime-startup',
          message: summary,
        }).catch(() => {});
        return;
      }
      if (!shouldSurfaceStderrLine(text)) {
        return;
      }
      await this.emitAlert({
        severity: 'warning',
        source: 'stderr',
        message: summary,
      }).catch(() => {});
    });

    this.rpc = new JsonRpcSession(this.child, {
      onNotification: (message) => this.handleNotification(message),
      onServerRequest: (message) => this.handleServerRequest(message),
      onRawStdout: () => {},
      onError: (error) => {
        this.emitAlert({
          severity: 'error',
          source: 'runtime',
          message: `codex app-server failed to start: ${error.message}`,
        }).catch(() => {});
      },
      onExit: (code, signal) => {
        this.handleExit(code, signal).catch(() => {});
      },
    });
    this.child.off('error', onEarlyError);

    await this.rpc.request('initialize', {
      clientInfo: {
        name: 'mobile-codex-remote',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    await this.emitRuntime({ connection: 'ready', phase: 'idle' });

    const startTranscriptFallbackThread = async (reason = null) => {
      if (reason) {
        await this.emitDiagnostic({
          severity: 'warning',
          source: 'codex',
          kind: 'native-thread-fallback',
          message: 'Native Codex thread was not available; started a live session from transcript context instead.',
          detail: String(reason.message || reason).slice(0, 500),
        }).catch(() => {});
      }
      const fallbackThread = await this.rpc.request('thread/start', {
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        personality: 'friendly',
      });
      this.runtime.resumeStrategy = this.launchMode === 'resume' || this.launchMode === 'fork'
        ? 'transcript_fallback'
        : 'fresh';
      return fallbackThread;
    };

    let thread = null;
    if (this.launchMode === 'resume' && this.nativeThreadId) {
      try {
        thread = await this.rpc.request('thread/resume', {
          threadId: this.nativeThreadId,
          cwd: this.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          personality: 'friendly',
        });
        this.runtime.resumeStrategy = 'native_resume';
      } catch (error) {
        thread = await startTranscriptFallbackThread(error);
      }
    } else if (this.launchMode === 'fork' && this.nativeThreadId) {
      try {
        thread = await this.rpc.request('thread/fork', {
          threadId: this.nativeThreadId,
          cwd: this.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          ephemeral: false,
          threadSource: 'user',
        });
        this.runtime.resumeStrategy = 'native_fork';
      } catch (error) {
        thread = await startTranscriptFallbackThread(error);
      }
    } else {
      thread = await startTranscriptFallbackThread();
    }

    this.threadId = thread?.thread?.id || null;
    if (!this.threadId) {
      throw new Error('app-server did not return thread.id');
    }
    this.sessionId = this.threadId;
    this.nativeThreadId = this.threadId;
    this.runtime.nativeThreadId = this.threadId;
    await this.emitRuntime({
      threadId: this.threadId,
      phase: 'idle',
      busy: false,
    });
  }

  async sendInput(text, options = {}) {
    if (!this.threadId) {
      throw new Error('codex thread is not ready yet');
    }

    if (this.activeTurnId) {
      throw new Error('Codex is still working on the previous turn.');
    }

    const normalizedItems = normalizeInputItems(text, options);
    if (!normalizedItems.length) {
      return null;
    }

    let prompt = String(text || '').trim();
    if (!this.resumePreludeUsed && this.resumePrelude) {
      prompt = `${this.resumePrelude}\n\nNew user request:\n${prompt}`;
      this.resumePreludeUsed = true;
      await this.emitOutput('[codex] continuing from imported history context', 'stderr');
    }

    const params = normalizeTurnStartParams(this.threadId, this.cwd, prompt, options);
    const mode = String(options.mode || '').trim();
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'turn/start',
      message: mode === 'plan'
        ? 'Starting a plan-mode turn.'
        : 'Starting a Codex turn.',
      data: {
        model: params.model || null,
        effort: params.effort || null,
        summary: params.summary || null,
        approvalPolicy: params.approvalPolicy || null,
        approvalsReviewer: params.approvalsReviewer || null,
        sandboxPolicy: params.sandboxPolicy || null,
        inputTypes: params.input.map((item) => item.type),
      },
    });

    const turn = await this.rpc.request('turn/start', params);

    const turnId = turn?.turn?.id || null;
    if (turnId) {
      this.activeTurnId = turnId;
      this.turnBuffers.set(turnId, '');
      await this.emitRuntime({
        activeTurnId: turnId,
        busy: true,
        phase: mode === 'plan' ? 'planning' : 'thinking',
        currentTurnStatus: 'inProgress',
        reasoningSummary: null,
        planSummary: null,
      });
    }
    return turnId;
  }

  async listModels(options = {}) {
    const response = await this.rpc.request('model/list', {
      cursor: options.cursor || null,
      includeHidden: options.includeHidden === true ? true : null,
      limit: Number(options.limit || 80) || 80,
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'model/list',
      message: `Loaded ${Array.isArray(response?.data) ? response.data.length : 0} models.`,
      data: {
        nextCursor: response?.nextCursor || null,
      },
    });
    return response || { data: [], nextCursor: null };
  }

  async startReview(options = {}) {
    if (!this.threadId) {
      throw new Error('No thread is available for review.');
    }

    if (this.activeTurnId) {
      throw new Error('Codex is still working on the previous turn.');
    }

    const target = normalizeReviewTarget(options);
    const delivery = String(options.delivery || 'inline').trim() === 'detached' ? 'detached' : 'inline';
    await this.emitRuntime({
      busy: true,
      phase: 'reviewing',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'review/start',
      message: `Review requested: ${target.type}`,
      data: {
        target,
        delivery,
      },
    });

    const response = await this.rpc.request('review/start', {
      threadId: this.threadId,
      target,
      delivery,
    });
    const turnId = response?.turn?.id || null;
    if (turnId) {
      this.activeTurnId = turnId;
      this.turnBuffers.set(turnId, '');
      await this.emitRuntime({
        activeTurnId: turnId,
        busy: true,
        phase: 'reviewing',
        currentTurnStatus: response?.turn?.status?.type || 'inProgress',
      });
    }
    await this.postEvent({
      type: 'session.review_started',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      reviewThreadId: response?.reviewThreadId || null,
      turnId,
      target,
      delivery,
      timestamp: nowIso(),
    });
    return response;
  }

  async stop() {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }

  async interruptTurn() {
    if (!this.threadId || !this.activeTurnId) {
      return false;
    }

    await this.emitRuntime({
      busy: true,
      phase: 'interrupting',
      currentTurnStatus: 'inProgress',
    });
    await this.rpc.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });
    await this.emitDiagnostic({
      severity: 'warning',
      source: 'codex',
      kind: 'control',
      method: 'turn/interrupt',
      message: 'Interrupt requested for the active turn.',
    });
    return true;
  }

  async steerTurn(text) {
    if (!this.threadId || !this.activeTurnId) {
      throw new Error('No active turn is available to steer.');
    }

    const prompt = String(text || '').trim();
    if (!prompt) {
      return null;
    }

    await this.emitRuntime({
      busy: true,
      phase: 'thinking',
      currentTurnStatus: 'inProgress',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'turn/steer',
      message: `Steering active turn with ${prompt.length} characters.`,
      data: {
        turnId: this.activeTurnId,
        text: limitText(prompt, 240),
      },
    });

    await this.rpc.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    });
    return this.activeTurnId;
  }

  async compactThread() {
    if (!this.threadId) {
      throw new Error('No thread is available to compact.');
    }

    await this.emitRuntime({
      busy: true,
      phase: 'compacting',
    });
    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'thread/compact/start',
      message: 'Thread compaction requested.',
      data: {
        threadId: this.threadId,
      },
    });

    await this.rpc.request('thread/compact/start', {
      threadId: this.threadId,
    });
    return true;
  }

  async runShellCommand(command) {
    if (!this.threadId) {
      throw new Error('No thread is available for shell command execution.');
    }

    const shellCommand = String(command || '').trim();
    if (!shellCommand) {
      return null;
    }

    await this.emitRuntime({
      busy: true,
      phase: 'running-shell-command',
    });
    await this.emitDiagnostic({
      severity: 'warning',
      source: 'codex',
      kind: 'control',
      method: 'thread/shellCommand',
      message: `Shell command requested: ${limitText(shellCommand, 220)}`,
      data: {
        threadId: this.threadId,
        command: limitText(shellCommand, 400),
      },
    });

    await this.rpc.request('thread/shellCommand', {
      threadId: this.threadId,
      command: shellCommand,
    });
    return true;
  }

  async respondToRequest(requestId, response) {
    const key = String(requestId || '');
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      throw new Error(`No pending Codex request found for ${key}`);
    }

    this.pendingRequests.delete(key);

    if (pending.method === 'item/tool/requestUserInput') {
      await this.rpc.respond(pending.message.id, {
        answers: response?.answers || {},
      });
    } else if (pending.method === 'item/commandExecution/requestApproval') {
      await this.rpc.respond(pending.message.id, {
        decision: response?.decision || 'decline',
      });
    } else if (pending.method === 'item/fileChange/requestApproval') {
      await this.rpc.respond(pending.message.id, {
        decision: response?.decision || 'decline',
      });
    } else if (pending.method === 'item/permissions/requestApproval') {
      await this.rpc.respond(pending.message.id, response || {
        permissions: {
          fileSystem: null,
          network: {
            enabled: false,
          },
        },
        scope: 'turn',
        strictAutoReview: false,
      });
    } else {
      throw new Error(`Unsupported pending request method: ${pending.method}`);
    }

    await this.emitRequestResolved({
      requestId: key,
      method: pending.method,
      summary: pending.summary,
      response: response || null,
    });

    await this.emitRuntime({
      waitingOnApproval: false,
      waitingOnUserInput: false,
      phase: this.activeTurnId ? 'thinking' : 'idle',
    });
    return true;
  }

  async handleNotification(message) {
    const method = message.method;
    const params = message.params || {};

    if (method === 'thread/started' && params.thread?.id) {
      this.threadId = params.thread.id;
      this.sessionId = params.thread.id;
      this.nativeThreadId = params.thread.id;
      this.runtime.nativeThreadId = params.thread.id;
      await this.emitRuntime({
        threadId: params.thread.id,
        phase: 'idle',
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'thread',
        method,
        message: `Thread started: ${params.thread.id}`,
        data: params.thread || null,
      });
      return;
    }

    if (method === 'thread/status/changed') {
      const status = params.status || null;
      const type = status?.type || 'unknown';
      const waitingOnApproval = Array.isArray(status?.activeFlags) && status.activeFlags.includes('waitingOnApproval');
      const waitingOnUserInput = Array.isArray(status?.activeFlags) && status.activeFlags.includes('waitingOnUserInput');
      await this.emitRuntime({
        threadStatus: status || null,
        phase: waitingOnApproval
          ? 'waiting-approval'
          : waitingOnUserInput
            ? 'waiting-user-input'
            : type === 'active'
              ? 'thinking'
              : type === 'systemError'
                ? 'error'
                : 'idle',
        busy: type === 'active',
        waitingOnApproval,
        waitingOnUserInput,
      });
      await this.emitDiagnostic({
        severity: type === 'systemError' ? 'error' : 'info',
        source: 'codex',
        kind: 'thread-status',
        method,
        message: describeThreadStatus(status),
        data: status,
      });
      return;
    }

    if (method === 'turn/started') {
      this.activeTurnId = params.turn?.id || params.turnId || this.activeTurnId;
      if (this.activeTurnId && !this.turnBuffers.has(this.activeTurnId)) {
        this.turnBuffers.set(this.activeTurnId, '');
      }
      await this.emitRuntime({
        activeTurnId: this.activeTurnId,
        busy: true,
        phase: 'thinking',
        currentTurnStatus: params.turn?.status?.type || 'inProgress',
        reasoningSummary: null,
        planSummary: null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'turn',
        method,
        message: `Turn started${this.activeTurnId ? `: ${this.activeTurnId}` : ''}`,
        data: params.turn || null,
      });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const turnId = params.turnId || this.activeTurnId;
      if (!turnId) {
        return;
      }
      const previous = this.turnBuffers.get(turnId) || '';
      this.turnBuffers.set(turnId, `${previous}${params.delta || ''}`);
      return;
    }

    if (method === 'item/commandExecution/outputDelta' || method === 'process/outputDelta' || method === 'command/exec/outputDelta') {
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'command-output',
        method,
        message: limitText(params.delta || params.deltaBase64 || '', 220),
        data: {
          itemId: params.itemId || null,
          processId: params.processId || null,
          processHandle: params.processHandle || null,
          stream: params.stream || null,
          capReached: typeof params.capReached === 'boolean' ? params.capReached : null,
        },
      });
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta') {
      const turnId = params.turnId || this.activeTurnId;
      const reasoningChunk = normalizeThinkingText(params.delta || '');
      if (turnId) {
        const previous = this.reasoningBuffers.get(turnId) || '';
        this.reasoningBuffers.set(turnId, mergeThinkingBuffer(previous, reasoningChunk));
        await this.emitRuntime({
          activeTurnId: turnId,
          busy: true,
          phase: 'thinking',
          reasoningSummary: limitText(this.reasoningBuffers.get(turnId), 1200),
        });
      }
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'reasoning',
        method,
        message: limitText(reasoningChunk, 200),
        turnId,
        data: {
          itemId: params.itemId || null,
          summaryIndex: params.summaryIndex ?? null,
          turnId: turnId || null,
        },
      });
      return;
    }

    if (method === 'item/plan/delta' || method === 'turn/plan/updated') {
      const turnId = params.turnId || this.activeTurnId;
      const planChunk = normalizeThinkingText(params.delta || params.plan || '');
      if (turnId) {
        const previous = this.planBuffers.get(turnId) || '';
        const next = mergeThinkingBuffer(previous, planChunk);
        this.planBuffers.set(turnId, next);
        await this.emitRuntime({
          activeTurnId: turnId,
          busy: true,
          phase: 'planning',
          planSummary: limitText(next, 1200),
        });
      }
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'plan',
        method,
        message: limitText(planChunk, 200),
        turnId,
        data: {
          itemId: params.itemId || null,
          turnId: turnId || null,
          rawPlan: params.plan || null,
        },
      });
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      await this.emitRuntime({
        tokenUsage: params.tokenUsage || null,
      });
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'token-usage',
        method,
        message: `Token usage updated${params.tokenUsage?.total?.totalTokens != null ? `: ${params.tokenUsage.total.totalTokens}` : ''}`,
        data: params.tokenUsage || null,
      });
      return;
    }

    if (method === 'account/rateLimits/updated') {
      await this.emitRuntime({
        rateLimits: params.rateLimits || null,
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'codex',
        kind: 'rate-limits',
        method,
        message: `Rate limits updated${params.rateLimits?.rateLimitReachedType ? `: ${params.rateLimits.rateLimitReachedType}` : ''}`,
        data: params.rateLimits || null,
      });
      return;
    }

    if (method === 'item/commandExecution/terminalInteraction') {
      await this.emitDiagnostic({
        severity: 'info',
        source: 'codex',
        kind: 'terminal',
        method,
        message: `Terminal input for process ${params.processId || 'unknown'}`,
        data: {
          itemId: params.itemId || null,
          processId: params.processId || null,
          stdin: limitText(params.stdin || '', 240),
        },
      });
      return;
    }

    if (method === 'turn/completed') {
      const turnId = params.turn?.id || params.turnId || this.activeTurnId;
      const text = turnId ? (this.turnBuffers.get(turnId) || '').trim() : '';
      if (text) {
        await this.emitOutput(text, 'stdout');
      }
      if (turnId) {
        this.turnBuffers.delete(turnId);
        this.planBuffers.delete(turnId);
        this.reasoningBuffers.delete(turnId);
      }
      if (turnId && turnId === this.activeTurnId) {
        this.activeTurnId = null;
      }
      await this.emitRuntime({
        activeTurnId: null,
        busy: false,
        waitingOnApproval: false,
        waitingOnUserInput: false,
        phase: params.turn?.status?.type === 'interrupted'
          ? 'interrupted'
          : params.turn?.status?.type === 'failed'
            ? 'error'
            : 'idle',
        currentTurnStatus: params.turn?.status?.type || 'completed',
      });
      await this.emitDiagnostic({
        severity: params.turn?.status?.type === 'failed' ? 'error' : 'info',
        source: 'codex',
        kind: 'turn',
        method,
        message: `Turn completed: ${params.turn?.status?.type || 'completed'}`,
        data: params.turn || null,
      });
      return;
    }

    if (method === 'warning') {
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: params.message || 'warning',
      });
      await this.emitDiagnostic({
        severity: 'warning',
        source: 'codex',
        kind: 'warning',
        method,
        message: params.message || 'warning',
        data: params || null,
      });
      return;
    }

    if (method === 'error') {
      const turnId = params.turnId || this.activeTurnId;
      const pieces = [params.error?.message || 'codex error'];
      if (params.error?.additionalDetails) {
        pieces.push(params.error.additionalDetails);
      }
      const text = pieces.filter(Boolean).join('\n');
      const codexError = describeCodexError(params.error?.codexErrorInfo || null);
      if (params.willRetry) {
        await this.emitRuntime({
          phase: String(codexError || '').startsWith('responseStreamDisconnected') ? 'reconnecting' : 'retrying',
          lastError: text,
          lastCodexError: codexError,
        });
        await this.emitAlert({
          severity: 'warning',
          source: 'codex',
          message: text,
        });
      } else {
        await this.emitRuntime({
          phase: codexError === 'usageLimitExceeded' || codexError === 'contextWindowExceeded' ? 'quota-exhausted' : 'error',
          busy: false,
          lastError: text,
          lastCodexError: codexError,
        });
        await this.postEvent({
          type: 'session.error',
          hostId: this.hostId,
          sessionId: this.currentSessionId(),
          message: text,
          timestamp: nowIso(),
        });
        this.activeTurnId = null;
      }
      await this.emitDiagnostic({
        severity: params.willRetry ? 'warning' : 'error',
        source: 'codex',
        kind: 'error',
        method,
        message: text,
        detail: codexError || null,
        data: params.error || null,
      });
      if (turnId && !params.willRetry) {
        this.turnBuffers.delete(turnId);
      }
      return;
    }

    await this.emitDiagnostic({
      severity: 'info',
      source: 'codex',
      kind: 'notification',
      method,
      message: limitText(summarizeValue(params), 320),
      data: params,
    });
  }

  async handleServerRequest(message) {
    const method = message.method;
    const params = message.params || {};

    if (method === 'item/tool/requestUserInput') {
      const labels = Array.isArray(params.questions)
        ? params.questions.map((question) => question.header || question.id || 'question').join(', ')
        : 'question';
      const requestId = String(message.id);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: labels,
      });
      await this.emitRuntime({
        waitingOnUserInput: true,
        busy: true,
        phase: 'waiting-user-input',
      });
      await this.emitRequest({
        requestId,
        kind: 'user-input',
        method,
        title: 'User input required',
        message: labels,
        summary: labels,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: `User input required: ${labels}`,
      });
      return;
    }

    if (method === 'item/commandExecution/requestApproval') {
      const requestId = String(message.id);
      const command = String(params.command || '').trim();
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: command || params.reason || 'Command approval requested',
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'approval',
        method,
        title: 'Command approval required',
        message: params.reason || command || 'Command approval required',
        summary: command || params.reason || null,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'Command execution approval was requested.',
      });
      return;
    }

    if (method === 'item/fileChange/requestApproval') {
      const requestId = String(message.id);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: params.reason || params.grantRoot || 'File change approval requested',
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'approval',
        method,
        title: 'File change approval required',
        message: params.reason || params.grantRoot || 'File change approval required',
        summary: params.reason || params.grantRoot || null,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'File change approval was requested.',
      });
      return;
    }

    if (method === 'item/permissions/requestApproval') {
      const requestId = String(message.id);
      this.pendingRequests.set(requestId, {
        message,
        method,
        params,
        summary: params.reason || 'Permissions approval requested',
      });
      await this.emitRuntime({
        waitingOnApproval: true,
        busy: true,
        phase: 'waiting-approval',
      });
      await this.emitRequest({
        requestId,
        kind: 'permissions',
        method,
        title: 'Permissions approval required',
        message: params.reason || 'Permissions approval required',
        summary: params.reason || null,
        payload: params,
      });
      await this.emitAlert({
        severity: 'warning',
        source: 'codex',
        message: 'Additional permissions were requested.',
      });
      return;
    }

    this.rpc.respondError(message.id, -32601, `Unsupported server request: ${method}`);
  }

  async handleExit(code, signal) {
    this.activeTurnId = null;
    this.turnBuffers.clear();
    this.planBuffers.clear();
    this.reasoningBuffers.clear();
    this.pendingRequests.clear();
    await this.emitRuntime({
      connection: 'closed',
      busy: false,
      waitingOnApproval: false,
      waitingOnUserInput: false,
      activeTurnId: null,
      phase: 'closed',
    });
    if (typeof this.onTerminated === 'function') {
      this.onTerminated(code, signal);
    }
    await this.postEvent({
      type: 'session.state_changed',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      state: `exited:${code ?? 'null'}:${signal ?? 'null'}`,
      live: false,
      timestamp: nowIso(),
    });
  }

  async emitOutput(text, stream) {
    await this.postEvent({
      type: 'session.output',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      stream,
      chunk: text,
      timestamp: nowIso(),
    });
  }

  currentSessionId() {
    return this.sessionId || this.nativeThreadId || this.bridgeSessionId;
  }

  async emitAlert(entry) {
    await this.postEvent({
      type: 'session.alert',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      severity: entry.severity || 'warning',
      source: entry.source || 'runtime',
      message: entry.message || '',
      timestamp: nowIso(),
    });
  }

  async emitRuntime(patch) {
    this.runtime = {
      ...this.runtime,
      ...patch,
      updatedAt: nowIso(),
    };
    await this.postEvent({
      type: 'session.runtime_updated',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      patch,
      timestamp: nowIso(),
    });
  }

  async emitDiagnostic(entry) {
    await this.postEvent({
      type: 'session.diagnostic',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      severity: entry.severity || 'info',
      source: entry.source || 'codex',
      kind: entry.kind || 'event',
      method: entry.method || null,
      message: entry.message || '',
      detail: entry.detail || null,
      data: entry.data || null,
      turnId: entry.turnId || null,
      timestamp: nowIso(),
    });
  }

  async emitRequest(entry) {
    await this.postEvent({
      type: 'session.request',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      requestId: String(entry.requestId || ''),
      kind: entry.kind || 'request',
      method: entry.method || null,
      title: entry.title || null,
      message: entry.message || '',
      summary: entry.summary || null,
      payload: entry.payload || null,
      response: entry.response || null,
      timestamp: nowIso(),
    });
  }

  async emitRequestResolved(entry) {
    await this.postEvent({
      type: 'session.request.resolved',
      hostId: this.hostId,
      sessionId: this.currentSessionId(),
      requestId: String(entry.requestId || ''),
      method: entry.method || null,
      summary: entry.summary || null,
      response: entry.response || null,
      message: entry.message || null,
      timestamp: nowIso(),
    });
  }
}

async function startCodexAppServerSession(options) {
  const runner = new CodexAppServerRunner(options);
  await runner.start();
  return runner;
}

module.exports = {
  resolveDefaultCodexBin,
  startCodexAppServerSession,
};
