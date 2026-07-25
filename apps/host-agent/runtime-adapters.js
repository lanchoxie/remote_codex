const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { normalizeArgs, nowIso } = require('../../shared/protocol');
const { startCodexAppServerSession } = require('./codex-app-server-runner');
const { buildApiProcessEnvironment } = require('./runtime-utils');

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

async function startProcessManagedRuntimeSession({
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
  onRunnerCreated,
  spawnProcess = spawn,
  stopGraceTimeoutMs = 5000,
  stopKillTimeoutMs = 1000,
}) {
  const createdAt = nowIso();
  const command = runtime.command;
  const args = normalizeRuntimeArgs(runtime.args);
  let child = null;
  let spawned = false;
  let spawnFailed = false;
  let runtimeError = null;
  let agentEventsSuppressed = false;
  let resolveTerminalCompletion;
  const terminalCompletion = new Promise((resolve) => {
    resolveTerminalCompletion = resolve;
  });

  async function waitForTerminal(timeoutMs) {
    let timer = null;
    const completed = await Promise.race([
      terminalCompletion.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

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
    stopRequested: false,
    stopPromise: null,
    startCompleted: false,
    suppressTerminalEvent: false,
    agentEventsSuppressed: false,
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
      if (!child?.stdin) throw new Error('Managed process is not running.');
      child.stdin.write(`${String(text || '')}\n`);
    },
    applyStopOptions(options = {}) {
      if (options.suppressTerminalEvent === true || options.deferStartupTerminalEvent === true) {
        runner.suppressTerminalEvent = true;
        runner.agentEventsSuppressed = true;
        agentEventsSuppressed = true;
      }
    },
    stop(options = {}) {
      runner.applyStopOptions(options);
      runner.stopRequested = true;
      if (runner.stopPromise) {
        return runner.stopPromise;
      }
      let attemptPromise = null;
      attemptPromise = performRunnerStop().catch((error) => {
        if (runner.stopPromise === attemptPromise) {
          runner.stopPromise = null;
        }
        throw error;
      });
      runner.stopPromise = attemptPromise;
      return attemptPromise;
    },
  };

  let terminalPromise = null;

  function deliverEvent(event) {
    return agentEventsSuppressed ? Promise.resolve(null) : postEvent(event);
  }

  async function awaitTerminalCleanup() {
    try {
      await terminalPromise;
    } catch (error) {
      if (agentEventsSuppressed && error?.terminalDeliveryFailure === true) {
        return;
      }
      throw error;
    }
  }

  async function performRunnerStop() {
    if (!child) {
      await finalizeTerminal(null, null, {
        terminalState: 'failed:start-cancelled',
      });
      return;
    }
    if (spawnFailed && terminalPromise) {
      await awaitTerminalCleanup();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (!terminalPromise) finalizeTerminal(child.exitCode, child.signalCode);
      await awaitTerminalCleanup();
      return;
    }
    try {
      child.kill();
    } catch (error) {
      runtimeError = runtimeError || error;
      forwardRuntimeError(error);
    }
    if (!(await waitForTerminal(Math.max(1, Number(stopGraceTimeoutMs) || 5000)))) {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        runtimeError = runtimeError || error;
        forwardRuntimeError(error);
      }
      await waitForTerminal(Math.max(1, Number(stopKillTimeoutMs) || 1000));
    }
    if (!terminalPromise) {
      const error = new Error(
        `Managed process did not confirm exit after ${Math.max(1, Number(stopGraceTimeoutMs) || 5000) + Math.max(1, Number(stopKillTimeoutMs) || 1000)}ms.`
      );
      error.code = 'session_stop_timeout';
      error.processTreeFallbackRequired = true;
      throw error;
    }
    await awaitTerminalCleanup();
  }

  async function forwardRuntimeError(error) {
    try {
      await deliverEvent({
        type: 'session.error',
        hostId,
        sessionId,
        runId: runner.runId,
        message: `managed session error: ${error.message}`,
        timestamp: nowIso(),
      });
    } catch (postError) {
      console.error('[agent] failed to forward runtime error', postError.message);
    }
  }

  function finalizeTerminal(code, signal, options = {}) {
    if (terminalPromise) return terminalPromise;
    terminalPromise = (async () => {
      if (typeof onTerminated === 'function') {
        try {
          onTerminated(code, signal);
        } catch (error) {
          console.error('[agent] managed runtime termination callback failed', error.message);
        }
      }
      if (options.error) await forwardRuntimeError(options.error);
      if (!runner.suppressTerminalEvent) {
        try {
          await deliverEvent({
            type: 'session.state_changed',
            hostId,
            sessionId,
            runId: runner.runId,
            state: options.terminalState
              || (runner.stopRequested
                ? (runner.startCompleted ? 'history-only' : 'failed:start-cancelled')
                : runtimeError
                  ? 'failed:runtime-error'
                  : `exited:${code ?? 'null'}:${signal ?? 'null'}`),
            live: false,
            timestamp: nowIso(),
          });
        } catch (postError) {
          const retryError = postError instanceof Error
            ? postError
            : new Error(String(postError || 'Session terminal state delivery failed.'));
          retryError.retryCommand = true;
          retryError.terminalDeliveryFailure = true;
          throw retryError;
        }
      }
    })().finally(() => {
      resolveTerminalCompletion();
    });
    return terminalPromise;
  }

  try {
    if (typeof onRunnerCreated === 'function') onRunnerCreated(runner);
  } catch (error) {
    await runner.stop(runner.stopRequested ? {} : { suppressTerminalEvent: true }).catch(() => {});
    throw error;
  }

  if (runner.stopRequested) {
    const error = new Error('Managed process startup was cancelled before spawn.');
    error.code = 'session_start_cancelled';
    error.failureState = 'failed:start-cancelled';
    throw error;
  }

  try {
    child = spawnProcess(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: {
        ...buildApiProcessEnvironment(process.env, apiConfig),
        DEMO_BOOTSTRAP_JSON: JSON.stringify(bootstrap || null),
        DEMO_SESSION_LABEL: String(title || cwd || sessionId),
      },
    });
  } catch (error) {
    runtimeError = error;
    if (!runner.stopRequested) runner.suppressTerminalEvent = true;
    await finalizeTerminal(null, null, { error, terminalState: 'failed:runtime-error' });
    throw error;
  }

  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

  stdout.on('line', (line) => {
    deliverEvent({
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
    deliverEvent({
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

  const spawnHandshake = new Promise((resolve, reject) => {
    child.once('spawn', () => {
      spawned = true;
      resolve();
    });
    child.once('error', reject);
  });

  child.on('error', (error) => {
    runtimeError = runtimeError || error;
    if (spawned) {
      forwardRuntimeError(error);
    }
  });
  child.on('exit', (code, signal) => {
    finalizeTerminal(code, signal).catch(() => {});
  });

  try {
    await spawnHandshake;
  } catch (error) {
    spawnFailed = true;
    runtimeError = runtimeError || error;
    if (!runner.stopRequested) runner.suppressTerminalEvent = true;
    await finalizeTerminal(null, null, { error, terminalState: 'failed:runtime-error' });
    throw error;
  }
  if (terminalPromise || child.exitCode !== null || child.signalCode !== null) {
    if (terminalPromise) await terminalPromise;
    const error = runtimeError || new Error('Managed process exited during startup.');
    error.code = error.code || 'session_process_exited_during_start';
    throw error;
  }
  runner.startCompleted = true;
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
      rebindNativeThreadId: options.rebindNativeThreadId || null,
      explicitRebind: options.explicitRebind === true,
      codexHome: options.codexHome,
      apiConfig: options.apiConfig,
      apiBinding: options.apiBinding,
      bootstrap: options.bootstrap,
      originSessionId: options.originSessionId || null,
      sourceSessionId: options.sourceSessionId || null,
      conversationKey: options.conversationKey || null,
      postEvent: options.postEvent,
      onTerminated: options.onTerminated,
      onRunnerCreated: options.onRunnerCreated,
      spawnProcess: options.spawnProcess,
    });
  }

  return startProcessManagedRuntimeSession(options);
}

module.exports = {
  resolveManagedRuntime,
  startManagedRuntimeSession,
};
