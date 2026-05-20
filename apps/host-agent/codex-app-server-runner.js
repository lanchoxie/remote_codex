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

function resolveDefaultCodexBin() {
  if (process.env.CODEX_BIN) {
    return process.env.CODEX_BIN;
  }

  const candidates = [];
  const home = os.homedir();
  if (process.platform === 'win32') {
    const cursorExtensions = path.join(home, '.cursor', 'extensions');
    if (fs.existsSync(cursorExtensions)) {
      const extensionDirs = fs.readdirSync(cursorExtensions, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
        .map((entry) => entry.name)
        .sort()
        .reverse();

      for (const entry of extensionDirs) {
        const binPath = path.join(cursorExtensions, entry, 'bin', 'windows-x86_64', 'codex.exe');
        if (fs.existsSync(binPath)) {
          candidates.push(binPath);
        }
      }
    }
  }

  return candidates[0] || 'codex';
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

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`codex app-server exited early: ${code ?? 'null'} / ${signal ?? 'null'}`));
      }
      this.pending.clear();
      if (typeof this.handlers.onExit === 'function') {
        this.handlers.onExit(code, signal);
      }
    });
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
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
    this.codexBin = options.codexBin || resolveDefaultCodexBin();
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
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
        HOME: path.dirname(this.codexHome),
        USERPROFILE: path.dirname(this.codexHome),
        HOMEDRIVE: (path.parse(path.dirname(this.codexHome)).root || process.env.HOMEDRIVE || '').replace(/\\$/, ''),
        HOMEPATH: path.dirname(this.codexHome).replace(/^[A-Za-z]:/, '') || process.env.HOMEPATH || '',
      },
    });

    await this.emitRuntime({ connection: 'connecting', phase: 'booting' });

    const stderr = readline.createInterface({
      input: this.child.stderr,
      crlfDelay: Infinity,
    });

    stderr.on('line', async (line) => {
      const text = stripAnsi(line);
      if (!shouldSurfaceStderrLine(text)) {
        return;
      }
      const summary = text.length > 420 ? `${text.slice(0, 417)}...` : text;
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
      onExit: (code, signal) => {
        this.handleExit(code, signal).catch(() => {});
      },
    });

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

    let thread = null;
    if (this.launchMode === 'resume' && this.nativeThreadId) {
      thread = await this.rpc.request('thread/resume', {
        threadId: this.nativeThreadId,
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        personality: 'friendly',
      });
      this.runtime.resumeStrategy = 'native_resume';
    } else if (this.launchMode === 'fork' && this.nativeThreadId) {
      thread = await this.rpc.request('thread/fork', {
        threadId: this.nativeThreadId,
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ephemeral: false,
        threadSource: 'user',
      });
      this.runtime.resumeStrategy = 'native_fork';
    } else {
      thread = await this.rpc.request('thread/start', {
        cwd: this.cwd,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        personality: 'friendly',
      });
      this.runtime.resumeStrategy = this.launchMode === 'resume' || this.launchMode === 'fork'
        ? 'transcript_fallback'
        : 'fresh';
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

  async sendInput(text) {
    if (!this.threadId) {
      throw new Error('codex thread is not ready yet');
    }

    if (this.activeTurnId) {
      throw new Error('Codex is still working on the previous turn.');
    }

    let prompt = String(text || '').trim();
    if (!prompt) {
      return null;
    }

    if (!this.resumePreludeUsed && this.resumePrelude) {
      prompt = `${this.resumePrelude}\n\nNew user request:\n${prompt}`;
      this.resumePreludeUsed = true;
      await this.emitOutput('[codex] continuing from imported history context', 'stderr');
    }

    const turn = await this.rpc.request('turn/start', {
      threadId: this.threadId,
      cwd: this.cwd,
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [this.cwd],
        networkAccess: false,
      },
      input: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    });

    const turnId = turn?.turn?.id || null;
    if (turnId) {
      this.activeTurnId = turnId;
      this.turnBuffers.set(turnId, '');
      await this.emitRuntime({
        activeTurnId: turnId,
        busy: true,
        phase: 'thinking',
        currentTurnStatus: 'inProgress',
        reasoningSummary: null,
        planSummary: null,
      });
    }
    return turnId;
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
