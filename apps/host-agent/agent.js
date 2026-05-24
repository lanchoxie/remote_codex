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
const HOST_ID = process.env.HOST_ID || os.hostname();
const HOST_LABEL = process.env.HOST_LABEL || HOST_ID;
const CODEX_HOME = process.env.CODEX_HOME || getDefaultCodexHome();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);
const DISCOVERY_INTERVAL_MS = Number(process.env.DISCOVERY_INTERVAL_MS || 15000);
const AUTO_START_SESSION = String(process.env.AUTO_START_SESSION || 'true') !== 'false';
const MANAGED_COMMAND = process.env.MANAGED_COMMAND || 'codex-app-server';
const MANAGED_ARGS = normalizeArgs(process.env.MANAGED_ARGS_JSON || '[]');
const MANAGED_CWD = process.env.MANAGED_CWD || process.cwd();

const liveSessions = new Map();
let lastCommandId = 0;

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
    demoMode: MANAGED_COMMAND === 'demo',
  };
}

function fetchJson(targetUrl, options = {}) {
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: options.method || 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
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
            reject(new Error(`invalid JSON from ${targetUrl}: ${error.message}`));
            return;
          }
          resolve({ statusCode: res.statusCode || 0, body });
        });
      }
    );

    req.on('error', reject);
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
    updatedAt: session.updatedAt,
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
      updatedAt: nowIso(),
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

function listBrowseRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(drive)) {
        roots.push({
          name: drive,
          path: drive,
        });
      }
    }
    return roots.length ? roots : [{ name: MANAGED_CWD, path: MANAGED_CWD }];
  }

  const home = os.homedir();
  const roots = [];
  if (home && fs.existsSync(home)) {
    roots.push({ name: '~', path: home });
  }
  roots.push({ name: '/', path: '/' });
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
    .slice(-10)
    .map((entry) => {
      const speaker = entry.speaker === 'user' ? 'user' : entry.speaker === 'agent' ? 'assistant' : 'system';
      const text = String(entry.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 280);
      return { speaker, text };
    });

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

function startProcessManagedSession({ sessionId, cwd, command, args, label, originSessionId, sourceSessionId, conversationKey, launchMode, bootstrap }) {
  const spawnOptions = {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    env: {
      ...process.env,
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
  const cwd = resolveManagedCwd(command.cwd || MANAGED_CWD);
  const resolved = resolveManagedCommand(command.command || MANAGED_COMMAND);
  const args = command.args && command.args.length ? normalizeArgs(command.args) : resolved.args;
  const bootstrap = buildResumeBootstrap(command);
  const title = command.label || command.cwd || bridgeSessionId;
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
        bootstrap,
        postEvent,
        onTerminated: () => {
          liveSessions.delete(bridgeSessionId);
          liveSessions.delete(announcedSessionId);
        },
      });
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

  const runner = liveSessions.get(command.sessionId);
  if (!runner) {
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

  await registerHost();
  await sendDiscovery();

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

main().catch((error) => {
  console.error('[agent] fatal:', error);
  process.exit(1);
});
