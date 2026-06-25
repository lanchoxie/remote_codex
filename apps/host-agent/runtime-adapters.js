const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { normalizeArgs, nowIso } = require('../../shared/protocol');
const { startCodexAppServerSession } = require('./codex-app-server-runner');
const { buildApiEnvironment } = require('./runtime-utils');

const CODEX_RUNTIME_ALIASES = new Set([
  'codex',
  'codex-app-server',
  'openai-codex',
]);

function normalizeRuntimeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRuntimeArgs(value) {
  return Array.isArray(value) ? normalizeArgs(value) : [];
}

function runtimeDisplayName(kind) {
  if (kind === 'codex-app-server') {
    return 'Codex app-server';
  }
  if (kind === 'demo') {
    return 'Demo runtime';
  }
  return kind ? `${kind} runtime` : 'Process runtime';
}

function resolveManagedRuntime(command = {}, defaults = {}) {
  const runtimeName = normalizeRuntimeName(
    command.runtime
    || command.adapter
    || command.agentRuntime
    || defaults.runtime
    || defaults.defaultRuntime
  );
  const commandName = String(command.command || defaults.command || defaults.defaultCommand || '').trim();
  const args = normalizeRuntimeArgs(
    Array.isArray(command.args) && command.args.length
      ? command.args
      : defaults.args || defaults.defaultArgs || []
  );

  if (runtimeName === 'demo' || (!runtimeName && (commandName === 'demo' || !commandName))) {
    return {
      kind: 'demo',
      runtimeId: 'demo',
      label: runtimeDisplayName('demo'),
      command: process.execPath,
      args: [path.join(__dirname, 'demo-session.js')],
    };
  }

  if (CODEX_RUNTIME_ALIASES.has(runtimeName) || (!runtimeName && CODEX_RUNTIME_ALIASES.has(commandName))) {
    return {
      kind: 'codex-app-server',
      runtimeId: 'codex-app-server',
      label: runtimeDisplayName('codex-app-server'),
      command: 'codex-app-server',
      args: [],
    };
  }

  const kind = runtimeName || 'process';
  return {
    kind,
    runtimeId: kind === 'process' ? `process:${commandName}` : kind,
    label: runtimeDisplayName(kind),
    command: commandName,
    args,
  };
}

function startProcessManagedRuntimeSession({
  runtime,
  hostId,
  sessionId,
  runId,
  cwd,
  title,
  originSessionId,
  sourceSessionId,
  conversationKey,
  launchMode,
  apiConfig,
  bootstrap,
  postEvent,
  onTerminated,
}) {
  const createdAt = nowIso();
  const command = runtime.command;
  const args = normalizeRuntimeArgs(runtime.args);
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      ...buildApiEnvironment(apiConfig),
      DEMO_BOOTSTRAP_JSON: JSON.stringify(bootstrap || null),
      DEMO_SESSION_LABEL: String(title || cwd || sessionId),
    },
  });

  const runner = {
    kind: runtime.kind || 'process',
    sessionId,
    runId: runId || null,
    title: title || cwd || sessionId,
    cwd,
    createdAt,
    originSessionId: originSessionId || null,
    sourceSessionId: sourceSessionId || null,
    conversationKey: conversationKey || originSessionId || sessionId,
    launchMode: launchMode || null,
    runtime: {
      kind: 'child_process',
      adapterId: runtime.kind || 'process',
      runtimeId: runtime.runtimeId || runtime.kind || 'process',
      runtimeLabel: runtime.label || runtimeDisplayName(runtime.kind),
      runId: runId || null,
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

  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

  stdout.on('line', (line) => {
    postEvent({
      type: 'session.output',
      hostId,
      sessionId,
      runId: runner.runId,
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
      hostId,
      sessionId,
      runId: runner.runId,
      stream: 'stderr',
      chunk: line,
      timestamp: nowIso(),
    }).catch((error) => {
      console.error('[agent] failed to forward stderr', error.message);
    });
  });

  child.on('error', (error) => {
    if (typeof onTerminated === 'function') {
      onTerminated();
    }
    postEvent({
      type: 'session.error',
      hostId,
      sessionId,
      message: `managed session error: ${error.message}`,
      timestamp: nowIso(),
    }).catch((postError) => {
      console.error('[agent] failed to forward runtime error', postError.message);
    });
    postEvent({
      type: 'session.state_changed',
      hostId,
      sessionId,
      runId: runner.runId,
      state: 'failed:runtime-error',
      live: false,
      timestamp: nowIso(),
    }).catch((postError) => {
      console.error('[agent] failed to forward runtime state', postError.message);
    });
  });

  child.on('exit', (code, signal) => {
    if (typeof onTerminated === 'function') {
      onTerminated();
    }
    postEvent({
      type: 'session.state_changed',
      hostId,
      sessionId,
      runId: runner.runId,
      state: `exited:${code ?? 'null'}:${signal ?? 'null'}`,
      live: false,
      timestamp: nowIso(),
    }).catch((error) => {
      console.error('[agent] failed to forward exit state', error.message);
    });
  });

  return runner;
}

async function startManagedRuntimeSession(options) {
  const runtime = options.runtime;
  if (runtime.kind === 'codex-app-server') {
    return startCodexAppServerSession({
      hostId: options.hostId,
      sessionId: options.sessionId,
      bridgeSessionId: options.bridgeSessionId || options.sessionId,
      runId: options.runId || null,
      title: options.title,
      cwd: options.cwd,
      launchMode: options.launchMode || null,
      nativeThreadId: options.nativeThreadId || null,
      codexHome: options.codexHome,
      apiConfig: options.apiConfig,
      bootstrap: options.bootstrap,
      originSessionId: options.originSessionId || null,
      sourceSessionId: options.sourceSessionId || null,
      conversationKey: options.conversationKey || null,
      postEvent: options.postEvent,
      onTerminated: options.onTerminated,
    });
  }

  return startProcessManagedRuntimeSession(options);
}

module.exports = {
  resolveManagedRuntime,
  startManagedRuntimeSession,
};
