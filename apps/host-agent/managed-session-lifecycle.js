const { publicBinding } = require('../../shared/api-binding');

function runnerIdentityValues(runner) {
  const values = new Set();
  const add = (value) => {
    const normalized = String(value || '').trim();
    if (normalized) values.add(normalized);
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

function commandIdentityValues(command = {}) {
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

function runnerMatchesCommandRun(runner, command = {}) {
  const commandRunId = String(command.runId || '').trim();
  if (!commandRunId) return true;
  return Boolean(runner && String(runner.runId || '').trim() === commandRunId);
}

function findRunnerForCommand(liveSessions, command = {}) {
  const candidates = commandIdentityValues(command);
  for (const candidate of candidates) {
    const direct = liveSessions.get(candidate);
    if (direct && runnerMatchesCommandRun(direct, command)) {
      return direct;
    }
  }

  const candidateSet = new Set(candidates);
  const seenRunners = new Set();
  for (const runner of liveSessions.values()) {
    if (!runner || seenRunners.has(runner) || !runnerMatchesCommandRun(runner, command)) {
      continue;
    }
    seenRunners.add(runner);
    const identities = runnerIdentityValues(runner);
    for (const candidate of candidateSet) {
      if (identities.has(candidate)) return runner;
    }
  }
  return null;
}

function retainRunnerForStartRetry(liveSessions, runner, command = {}, error = null) {
  if (
    !liveSessions
    || !runner
    || error?.processTreeFallbackRequired !== true
    || !runner.child
    || runner.startCompleted === true
    || runner.childExitConfirmed
    || runner.overlayCleaned
  ) {
    return false;
  }

  error.retryCommand = true;
  runner.startRetryPending = true;
  runner.processTreeFallbackRequired = true;
  runner.startRetryFailure = {
    code: error.code || 'session_stop_timeout',
    message: error.message || 'Managed Session startup could not confirm that its child exited.',
    processTreeFallbackRequired: true,
  };
  const identities = new Set([
    command.sessionId,
    command.bridgeSessionId,
    command.runId,
    runner.sessionId,
    runner.bridgeSessionId,
    runner.runId,
    typeof runner.currentSessionId === 'function' ? runner.currentSessionId() : null,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  let retained = false;
  for (const identity of identities) {
    const current = liveSessions.get(identity);
    if (!current || current === runner) {
      liveSessions.set(identity, runner);
      retained = true;
    }
  }
  return retained;
}

async function abortUnconfirmedRunner(runner) {
  if (!runner || typeof runner.stop !== 'function') return false;
  await runner.stop({ suppressTerminalEvent: true });
  return true;
}

async function stopUniqueLiveRunners(liveSessions, options = {}) {
  const runners = Array.from(new Set(liveSessions?.values?.() || []))
    .filter((runner) => runner && typeof runner.stop === 'function');
  const settled = await Promise.allSettled(runners.map((runner) => runner.stop(options)));
  const errors = settled
    .filter((result) => result.status === 'rejected')
    .map((result) => String(result.reason?.message || result.reason || 'managed runner stop failed'));
  return {
    runnerCount: runners.length,
    stoppedCount: settled.length - errors.length,
    errors,
  };
}

function createManagedSessionStartGate() {
  const activeStarts = new Set();
  let shuttingDown = false;

  function shutdownError() {
    const error = new Error('Host Agent is shutting down; managed sessions cannot be started.');
    error.code = 'host_agent_shutting_down';
    return error;
  }

  return {
    beginStart() {
      if (shuttingDown) throw shutdownError();

      let resolveRunnerOrFinished;
      let resolveFinished;
      const record = {
        finished: false,
        runner: null,
        runnerOrFinished: new Promise((resolve) => {
          resolveRunnerOrFinished = resolve;
        }),
        finishedPromise: new Promise((resolve) => {
          resolveFinished = resolve;
        }),
      };
      activeStarts.add(record);

      return {
        assertCanSpawn() {
          if (shuttingDown) throw shutdownError();
        },
        setRunner(runner) {
          if (!runner || record.runner || record.finished) return false;
          record.runner = runner;
          resolveRunnerOrFinished(runner);
          return true;
        },
        finish(error = null) {
          if (record.finished) return;
          record.finished = true;
          if (!record.runner) resolveRunnerOrFinished(null);
          activeStarts.delete(record);
          resolveFinished(error?.shutdownTerminalDelivery === true ? error : null);
        },
      };
    },
    beginShutdown() {
      shuttingDown = true;
      return Array.from(activeStarts);
    },
    isShuttingDown() {
      return shuttingDown;
    },
    async stopStarts(records, options = {}, seenRunners = new Set()) {
      const settled = await Promise.allSettled((records || []).map(async (record) => {
        const runner = record?.runner || await record?.runnerOrFinished;
        let stopped = false;
        let stopError = null;
        if (runner && typeof runner.stop === 'function' && !seenRunners.has(runner)) {
          seenRunners.add(runner);
          stopped = true;
          try {
            await runner.stop(options);
          } catch (error) {
            stopError = error;
          }
        }
        const ownerCompletionError = await record?.finishedPromise;
        if (stopError) throw stopError;
        if (ownerCompletionError) throw ownerCompletionError;
        return stopped;
      }));
      const errors = settled
        .filter((result) => result.status === 'rejected')
        .map((result) => String(result.reason?.message || result.reason || 'managed runner stop failed'));
      return {
        runnerCount: settled.filter((result) => result.status === 'fulfilled' && result.value).length + errors.length,
        stoppedCount: settled.filter((result) => result.status === 'fulfilled' && result.value).length,
        errors,
      };
    },
  };
}

function createManagedSessionShutdown(options = {}) {
  const liveSessions = options.liveSessions;
  const startGate = options.startGate || null;
  const stopInventory = typeof options.stopInventory === 'function'
    ? options.stopInventory
    : () => {};
  const exit = typeof options.exit === 'function' ? options.exit : (code) => process.exit(code);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const graceTimeoutMs = Math.max(1, Number(options.graceTimeoutMs || 10000) || 10000);
  const stopOptions = options.stopOptions && typeof options.stopOptions === 'object'
    ? options.stopOptions
    : {};
  let shutdownPromise = null;
  let inFlightStarts = [];

  const shutdownManagedSessions = function shutdownManagedSessions(signal = 'SIGTERM') {
    if (shutdownPromise) return shutdownPromise;
    inFlightStarts = typeof startGate?.beginShutdown === 'function'
      ? startGate.beginShutdown()
      : [];
    shutdownPromise = Promise.resolve().then(async () => {
      try {
        stopInventory();
      } catch (error) {
        log(`failed to stop Host inventory watcher: ${error?.message || error}`);
      }
      const pendingRunners = new Set(
        inFlightStarts.map((record) => record?.runner).filter(Boolean)
      );
      const shutdownLiveSessions = new Map(
        Array.from(liveSessions?.entries?.() || [])
          .filter(([, runner]) => !pendingRunners.has(runner))
      );
      const liveRunners = Array.from(new Set(shutdownLiveSessions.values()))
        .filter((runner) => runner && typeof runner.stop === 'function');
      const runnerCount = liveRunners.length + inFlightStarts.length;
      const pendingStartStopOptions = {
        ...stopOptions,
        deferStartupTerminalEvent: true,
      };
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          runnerCount,
          stoppedCount: null,
          errors: [],
          timedOut: true,
        }), graceTimeoutMs);
      });
      const seenRunners = new Set(liveRunners);
      const stopped = Promise.all([
        stopUniqueLiveRunners(shutdownLiveSessions, stopOptions),
        typeof startGate?.stopStarts === 'function'
          ? startGate.stopStarts(inFlightStarts, pendingStartStopOptions, seenRunners)
          : Promise.resolve({ runnerCount: 0, stoppedCount: 0, errors: [] }),
      ]).then(([liveResult, startResult]) => ({
        runnerCount: liveResult.runnerCount + startResult.runnerCount,
        stoppedCount: liveResult.stoppedCount + startResult.stoppedCount,
        errors: [...liveResult.errors, ...startResult.errors],
        timedOut: false,
      }));
      const result = await Promise.race([stopped, timeout]);
      if (timer) clearTimeout(timer);
      if (result.timedOut) {
        log(`Host shutdown timed out after ${graceTimeoutMs}ms with ${runnerCount} runner(s).`);
      } else if (result.errors.length) {
        log(`Host shutdown completed with ${result.errors.length} runner stop error(s).`);
      }
      if (!result.timedOut && result.errors.length === 0) {
        exit(0);
      }
      return { signal, ...result };
    });
    return shutdownPromise;
  };

  shutdownManagedSessions.upgradeStopOptions = async (patch = {}) => {
    Object.assign(stopOptions, patch && typeof patch === 'object' ? patch : {});
    const upgradedOptions = { ...stopOptions };
    const [liveResult, startResult] = await Promise.all([
      stopUniqueLiveRunners(liveSessions, upgradedOptions),
      typeof startGate?.stopStarts === 'function'
        ? startGate.stopStarts(inFlightStarts, upgradedOptions, new Set())
        : Promise.resolve({ runnerCount: 0, stoppedCount: 0, errors: [] }),
    ]);
    return {
      runnerCount: liveResult.runnerCount + startResult.runnerCount,
      stoppedCount: liveResult.stoppedCount + startResult.stoppedCount,
      errors: [...liveResult.errors, ...startResult.errors],
    };
  };

  return shutdownManagedSessions;
}

function buildManagedSessionStartedEvent({ hostId, runner, command = {} }) {
  const announcedSessionId = typeof runner.currentSessionId === 'function'
    ? runner.currentSessionId()
    : runner.sessionId || command.sessionId;
  const bridgeSessionId = runner.bridgeSessionId || command.bridgeSessionId || command.sessionId || null;
  return {
    type: 'session.started',
    hostId,
    sessionId: announcedSessionId,
    bridgeSessionId: bridgeSessionId && bridgeSessionId !== announcedSessionId ? bridgeSessionId : null,
    runId: runner.runId || command.runId || null,
    nativeThreadId: runner.nativeThreadId || announcedSessionId,
    title: runner.title || command.label || command.cwd || announcedSessionId,
    cwd: runner.cwd || command.cwd || null,
    source: 'managed',
    createdAt: runner.createdAt || command.createdAt || null,
    originSessionId: runner.originSessionId || command.originSessionId || null,
    sourceSessionId: runner.sourceSessionId || command.sourceSessionId || null,
    conversationKey: runner.conversationKey || command.conversationKey || command.originSessionId || bridgeSessionId || announcedSessionId,
    launchMode: runner.launchMode || command.launchMode || null,
    effectiveBinding: publicBinding(runner.apiBinding || command.apiBinding),
    runtime: runner.runtime || null,
  };
}

async function replayManagedSessionStart({ liveSessions, command, hostId, postEvent }) {
  if (!command?.runId) return null;
  const runner = findRunnerForCommand(liveSessions, { runId: command.runId });
  if (!runner) return null;
  if (runner.startRetryPending === true) {
    const retainedFailure = runner.startRetryFailure || {};
    const error = new Error(
      retainedFailure.message
        || 'Managed Session startup is waiting for process-tree fallback after an unconfirmed child exit.'
    );
    error.code = retainedFailure.code || 'session_stop_timeout';
    error.retryCommand = true;
    error.processTreeFallbackRequired = retainedFailure.processTreeFallbackRequired !== false;
    throw error;
  }
  const event = buildManagedSessionStartedEvent({ hostId, runner, command });
  try {
    await postEvent(event);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause || 'start replay delivery failed'));
    error.retryCommand = true;
    throw error;
  }
  return event.sessionId;
}

function shouldPublishMissingRunnerStop(command = {}) {
  return command.type === 'session.stop' && command.suppressTerminalEvent !== true;
}

module.exports = {
  abortUnconfirmedRunner,
  buildManagedSessionStartedEvent,
  createManagedSessionStartGate,
  createManagedSessionShutdown,
  findRunnerForCommand,
  retainRunnerForStartRetry,
  replayManagedSessionStart,
  runnerMatchesCommandRun,
  shouldPublishMissingRunnerStop,
  stopUniqueLiveRunners,
};
