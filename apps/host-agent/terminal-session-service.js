const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_FLUSH_MS = 20;
const DEFAULT_OUTPUT_FLUSH_BYTES = 32 * 1024;

function terminalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedText(value, limit = 512) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function normalizeTerminalId(value) {
  const terminalId = boundedText(value, 160);
  if (!terminalId || !/^[A-Za-z0-9._:-]+$/.test(terminalId)) {
    throw terminalError('terminal_id_invalid', 'A valid terminalId is required.');
  }
  return terminalId;
}

function normalizeDimension(value, fallback, minimum, maximum) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : fallback;
}

function resolveTerminalCwd(value) {
  const cwd = boundedText(value, 32 * 1024);
  if (!cwd) {
    throw terminalError('terminal_cwd_missing', 'This Session has no known working directory.');
  }
  let resolved;
  try {
    resolved = path.resolve(cwd);
  } catch (_) {
    throw terminalError('terminal_cwd_invalid', 'The Session working directory is invalid.');
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    throw terminalError('terminal_cwd_unavailable', `The Session working directory is not available: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw terminalError('terminal_cwd_not_directory', `The Session working directory is not a directory: ${resolved}`);
  }
  return resolved;
}

function isSensitiveEnvironmentName(name) {
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|AUTH|CREDENTIAL)(?:_|$)/i
    .test(String(name || ''));
}

function sanitizedTerminalEnvironment(input = process.env) {
  const output = {};
  for (const [name, value] of Object.entries(input || {})) {
    if (value == null || isSensitiveEnvironmentName(name)) continue;
    if (/^(?:RELAY_AUTH_TOKEN|RELAY_CONTROL_TOKEN|REMOTE_CODEX_GITHUB_TOKEN)$/i.test(name)) continue;
    output[name] = String(value);
  }
  output.TERM = output.TERM || 'xterm-256color';
  output.COLORTERM = output.COLORTERM || 'truecolor';
  return output;
}

function windowsShellCandidates(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return [
    { executable: 'pwsh.exe', args: ['-NoLogo'], shell: 'PowerShell 7' },
    {
      executable: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo'],
      shell: 'Windows PowerShell',
    },
    { executable: env.ComSpec || env.COMSPEC || 'cmd.exe', args: [], shell: 'Command Prompt' },
  ];
}

function unixShellCandidates(env = process.env) {
  const candidates = [];
  const configured = boundedText(env.SHELL, 4096);
  if (configured) candidates.push({ executable: configured, args: [], shell: path.basename(configured) });
  candidates.push(
    { executable: '/bin/bash', args: [], shell: 'bash' },
    { executable: '/bin/sh', args: [], shell: 'sh' }
  );
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.executable.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadNodePty() {
  try {
    const nodePty = require('node-pty');
    if (!nodePty || typeof nodePty.spawn !== 'function') {
      throw new Error('node-pty did not export spawn()');
    }
    return { available: true, nodePty, error: null };
  } catch (error) {
    return { available: false, nodePty: null, error };
  }
}

class TerminalSessionService {
  constructor(options = {}) {
    this.hostId = boundedText(options.hostId || os.hostname(), 160);
    this.platform = boundedText(options.platform || process.platform, 32);
    this.env = options.env || process.env;
    this.ptyFactory = options.ptyFactory || null;
    this.makeId = typeof options.makeId === 'function'
      ? options.makeId
      : () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.publish = typeof options.publish === 'function' ? options.publish : async () => {};
    this.maxSessions = Math.max(1, Number(options.maxSessions || DEFAULT_MAX_SESSIONS) || DEFAULT_MAX_SESSIONS);
    this.maxInputBytes = Math.max(1024, Number(options.maxInputBytes || DEFAULT_MAX_INPUT_BYTES) || DEFAULT_MAX_INPUT_BYTES);
    this.outputFlushMs = Math.max(1, Number(options.outputFlushMs || DEFAULT_OUTPUT_FLUSH_MS) || DEFAULT_OUTPUT_FLUSH_MS);
    this.outputFlushBytes = Math.max(1024, Number(options.outputFlushBytes || DEFAULT_OUTPUT_FLUSH_BYTES) || DEFAULT_OUTPUT_FLUSH_BYTES);
    this.sessions = new Map();
    this.capability = this.probeCapability();
  }

  probeCapability() {
    if (!['win32', 'linux', 'darwin'].includes(this.platform)) {
      return {
        available: false,
        code: 'terminal_platform_unsupported',
        reason: `PTY terminals are not supported on ${this.platform || 'this platform'}.`,
      };
    }
    if (this.ptyFactory) {
      return { available: true, code: null, reason: null };
    }
    const probe = loadNodePty();
    if (!probe.available) {
      return {
        available: false,
        code: 'terminal_pty_unavailable',
        reason: `node-pty is not available on this Host: ${probe.error?.message || probe.error}`,
      };
    }
    this.ptyFactory = probe.nodePty;
    return { available: true, code: null, reason: null };
  }

  getCapability() {
    return { ...this.capability };
  }

  isAvailable() {
    return this.capability.available === true;
  }

  hasActiveSessions() {
    return this.sessions.size > 0;
  }

  get(terminalId) {
    return this.sessions.get(String(terminalId || '')) || null;
  }

  shellCandidates() {
    return this.platform === 'win32'
      ? windowsShellCandidates(this.env)
      : unixShellCandidates(this.env);
  }

  spawnPty(candidate, options) {
    return this.ptyFactory.spawn(candidate.executable, candidate.args, options);
  }

  create(input = {}) {
    if (!this.isAvailable()) {
      throw terminalError(
        this.capability.code || 'terminal_pty_unavailable',
        this.capability.reason || 'PTY terminals are not available on this Host.'
      );
    }
    if (this.sessions.size >= this.maxSessions) {
      throw terminalError('terminal_host_limit', `This Host already has ${this.maxSessions} active terminals.`);
    }
    const terminalId = normalizeTerminalId(input.terminalId || this.makeId());
    const sessionId = boundedText(input.sessionId, 512);
    if (!sessionId) {
      throw terminalError('terminal_session_required', 'A Session is required to open a terminal.');
    }
    const existing = this.sessions.get(terminalId);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw terminalError('terminal_id_conflict', 'terminalId is already bound to another Session.');
      }
      return this.publicRecord(existing);
    }

    const cwd = resolveTerminalCwd(input.cwd);
    const cols = normalizeDimension(input.cols, 100, 20, 500);
    const rows = normalizeDimension(input.rows, 30, 5, 300);
    const spawnOptions = {
      name: 'xterm-256color',
      cwd,
      cols,
      rows,
      env: sanitizedTerminalEnvironment(this.env),
      useConpty: this.platform === 'win32',
    };
    const failures = [];
    let pty = null;
    let selected = null;
    for (const candidate of this.shellCandidates()) {
      try {
        pty = this.spawnPty(candidate, spawnOptions);
        selected = candidate;
        break;
      } catch (error) {
        failures.push(`${candidate.shell}: ${error.message || error}`);
      }
    }
    if (!pty) {
      throw terminalError(
        'terminal_shell_unavailable',
        `No supported shell could be started. ${failures.join('; ')}`
      );
    }

    const record = {
      terminalId,
      sessionId,
      cwd,
      cols,
      rows,
      shell: selected.shell,
      executable: selected.executable,
      pid: Number(pty.pid || 0) || null,
      pty,
      sequence: 0,
      outputChunks: [],
      outputBytes: 0,
      outputTimer: null,
      closing: false,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(terminalId, record);
    record.dataDisposable = pty.onData((data) => this.queueOutput(record, data));
    record.exitDisposable = pty.onExit((event) => this.handleExit(record, event));
    return this.publicRecord(record);
  }

  publicRecord(record) {
    return {
      terminalId: record.terminalId,
      sessionId: record.sessionId,
      cwd: record.cwd,
      platform: this.platform,
      shell: record.shell,
      pid: record.pid,
      cols: record.cols,
      rows: record.rows,
      createdAt: record.createdAt,
    };
  }

  queueOutput(record, value) {
    if (!record || record.closing || !this.sessions.has(record.terminalId)) return;
    const data = String(value == null ? '' : value);
    if (!data) return;
    record.outputChunks.push(data);
    record.outputBytes += Buffer.byteLength(data, 'utf8');
    if (record.outputBytes >= this.outputFlushBytes) {
      void this.flushOutput(record);
      return;
    }
    if (!record.outputTimer) {
      record.outputTimer = setTimeout(() => {
        record.outputTimer = null;
        void this.flushOutput(record);
      }, this.outputFlushMs);
      record.outputTimer.unref?.();
    }
  }

  async flushOutput(record) {
    if (!record || !record.outputChunks.length) return;
    if (record.outputTimer) {
      clearTimeout(record.outputTimer);
      record.outputTimer = null;
    }
    const data = record.outputChunks.join('');
    record.outputChunks.length = 0;
    record.outputBytes = 0;
    record.sequence += 1;
    try {
      await this.publish({
        type: 'host.terminal.output',
        hostId: this.hostId,
        terminalId: record.terminalId,
        sessionId: record.sessionId,
        sequence: record.sequence,
        data,
        timestamp: new Date().toISOString(),
      });
    } catch (_) {
      // Terminal output is ephemeral. A disconnected Relay must not crash the Host Agent.
    }
  }

  write(input = {}) {
    const terminalId = normalizeTerminalId(input.terminalId);
    const record = this.sessions.get(terminalId);
    if (!record || record.closing) {
      throw terminalError('terminal_not_found', 'The terminal is no longer active.');
    }
    const data = String(input.data == null ? '' : input.data);
    if (Buffer.byteLength(data, 'utf8') > this.maxInputBytes) {
      throw terminalError('terminal_input_too_large', `Terminal input exceeds ${this.maxInputBytes} bytes.`);
    }
    if (data) record.pty.write(data);
    return this.publicRecord(record);
  }

  resize(input = {}) {
    const terminalId = normalizeTerminalId(input.terminalId);
    const record = this.sessions.get(terminalId);
    if (!record || record.closing) {
      throw terminalError('terminal_not_found', 'The terminal is no longer active.');
    }
    const cols = normalizeDimension(input.cols, record.cols, 20, 500);
    const rows = normalizeDimension(input.rows, record.rows, 5, 300);
    record.pty.resize(cols, rows);
    record.cols = cols;
    record.rows = rows;
    return this.publicRecord(record);
  }

  close(input = {}) {
    const terminalId = normalizeTerminalId(input.terminalId);
    const record = this.sessions.get(terminalId);
    if (!record) return false;
    record.closing = true;
    this.sessions.delete(terminalId);
    if (record.outputTimer) clearTimeout(record.outputTimer);
    record.outputTimer = null;
    try { record.dataDisposable?.dispose?.(); } catch (_) {}
    try { record.exitDisposable?.dispose?.(); } catch (_) {}
    try { record.pty.kill(); } catch (_) {}
    void this.publish({
      type: 'host.terminal.closed',
      hostId: this.hostId,
      terminalId: record.terminalId,
      sessionId: record.sessionId,
      reason: boundedText(input.reason || 'client-close', 160),
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    return true;
  }

  handleExit(record, event = {}) {
    if (!record || !this.sessions.has(record.terminalId)) return;
    record.closing = true;
    this.sessions.delete(record.terminalId);
    if (record.outputTimer) clearTimeout(record.outputTimer);
    record.outputTimer = null;
    void this.flushOutput(record).finally(() => this.publish({
      type: 'host.terminal.closed',
      hostId: this.hostId,
      terminalId: record.terminalId,
      sessionId: record.sessionId,
      reason: 'process-exit',
      exitCode: Number.isFinite(Number(event.exitCode)) ? Number(event.exitCode) : null,
      signal: Number.isFinite(Number(event.signal)) ? Number(event.signal) : null,
      timestamp: new Date().toISOString(),
    }).catch(() => {}));
  }

  closeAll(reason = 'host-shutdown') {
    for (const terminalId of Array.from(this.sessions.keys())) {
      this.close({ terminalId, reason });
    }
  }
}

module.exports = {
  TerminalSessionService,
  isSensitiveEnvironmentName,
  loadNodePty,
  resolveTerminalCwd,
  sanitizedTerminalEnvironment,
  terminalError,
  unixShellCandidates,
  windowsShellCandidates,
};
