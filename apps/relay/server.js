const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
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

const state = {
  hosts: new Map(),
  sessions: new Map(),
  commandQueues: new Map(),
  subscribers: new Map(),
  dismissedHosts: new Set(),
  sessionLogs: new Map(),
  sessionAlerts: new Map(),
  sessionRuntime: new Map(),
  sessionDiagnostics: new Map(),
  sessionRequests: new Map(),
  pendingDirectoryRequests: new Map(),
  connectors: new Map(),
  connectorSecrets: loadConnectorSecrets(),
  nextCommandId: 1,
};

for (const connector of loadConnectors()) {
  state.connectors.set(connector.connectorId, connector);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
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

function hostOnline(host) {
  if (!host) {
    return false;
  }
  const lastSeen = host.lastSeenAt ? Date.parse(host.lastSeenAt) : 0;
  return Date.now() - lastSeen < 30_000;
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

function setSessionLog(hostId, sessionId, entries) {
  const key = sessionKey(hostId, sessionId);
  state.sessionLogs.set(key, Array.isArray(entries) ? entries.slice(-200) : []);
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
  const resolved = upsertSessionRequest(hostId, sessionId, {
    requestId,
    status: patch.status || 'resolved',
    updatedAt: patch.updatedAt || nowIso(),
    response: patch.response || null,
    summary: patch.summary || null,
    message: patch.message || null,
  });
  const payload = {
    ...resolved,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.request.resolved', payload);
  return payload;
}

function appendSessionLog(hostId, sessionId, entry) {
  const key = sessionKey(hostId, sessionId);
  const existing = state.sessionLogs.get(key) || [];
  const nextEntry = {
    timestamp: entry.timestamp || nowIso(),
    speaker: entry.speaker || 'system',
    text: entry.text || '',
    stream: entry.stream || null,
  };
  existing.push(nextEntry);
  state.sessionLogs.set(key, existing.slice(-200));
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

function buildResumeTranscript(entries, maxEntries = 12) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .filter((entry) => entry && entry.text)
    .slice(-maxEntries)
    .map((entry) => ({
      speaker: entry.speaker || 'system',
      text: String(entry.text || '').slice(0, 320),
      timestamp: entry.timestamp || null,
    }));
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
      mergeByFingerprint([...toLogs, ...fromLogs], (entry) => `${entry.speaker || 'system'}|${entry.timestamp || ''}|${entry.text || ''}`, 200)
    );
    state.sessionLogs.delete(fromKey);
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

function getConnectorHost(connector) {
  if (!connector?.hostId) {
    return null;
  }
  const host = state.hosts.get(connector.hostId) || null;
  return host ? { ...host, online: hostOnline(host) } : null;
}

function decorateSingleConnector(connector) {
  const secret = state.connectorSecrets.get(connector.connectorId) || null;
  return {
    ...decorateConnector(connector, getConnectorHost(connector)),
    secretStatus: getConnectorSecretStatus(secret),
  };
}

function getConnectorList() {
  const hosts = new Map(getHostList().map((host) => [host.hostId, host]));
  return Array.from(state.connectors.values())
    .map((connector) => ({
      ...decorateConnector(connector, connector.hostId ? hosts.get(connector.hostId) || null : null),
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
        stdio: ['ignore', 'pipe', 'pipe'],
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

function connectorNeedsManualAuth(connector, secret) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  const gatewayNeedsSecret = connectorUsesGateway(connector) && requiresInteractiveAuth(gatewayMethod);
  const targetNeedsSecret = requiresInteractiveAuth(targetMethod);
  const gatewayCovered = connectorPasswordMethod(gatewayMethod) && Boolean(secret?.gatewayPassword);
  const targetCovered = connectorPasswordMethod(targetMethod) && Boolean(secret?.targetPassword);

  return (gatewayNeedsSecret && !gatewayCovered)
    || (targetNeedsSecret && !targetCovered)
    || (gatewayNeedsSecret && !connectorPasswordMethod(gatewayMethod))
    || (targetNeedsSecret && !connectorPasswordMethod(targetMethod));
}

function connectorUsesAskpass(connector, secret) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  return Boolean(
    (connectorUsesGateway(connector) && connectorPasswordMethod(gatewayMethod) && secret?.gatewayPassword)
    || (connectorPasswordMethod(targetMethod) && secret?.targetPassword)
  );
}

function ensureAskpassHelper() {
  const helperPath = path.join(process.cwd(), 'tmp', 'remote-codex-askpass.cmd');
  const script = [
    '@echo off',
    'setlocal EnableExtensions',
    'set "STATE_FILE=%RC_ASKPASS_STATE_FILE%"',
    'set "INDEX=1"',
    'if defined STATE_FILE if exist "%STATE_FILE%" set /p INDEX=<"%STATE_FILE%"',
    'if "%INDEX%"=="1" (',
    '  if defined STATE_FILE >"%STATE_FILE%" echo 2',
    '  set "B64=%RC_ASKPASS_PASSWORD_1_B64%"',
    ') else (',
    '  if defined STATE_FILE >"%STATE_FILE%" echo 2',
    '  set "B64=%RC_ASKPASS_PASSWORD_2_B64%"',
    ')',
    'if not defined B64 set "B64=%RC_ASKPASS_PASSWORD_1_B64%"',
    'powershell -NoProfile -Command "$b64=$env:B64; if ([string]::IsNullOrWhiteSpace($b64)) { exit 1 }; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))"',
  ].join('\r\n');
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(helperPath, script, 'utf8');
  return helperPath;
}

function base64Secret(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function buildAskpassEnv(connector, secret) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  const gatewayNeedsPassword = connectorUsesGateway(connector) && connectorPasswordMethod(gatewayMethod);
  const targetNeedsPassword = connectorPasswordMethod(targetMethod);
  const firstPassword = gatewayNeedsPassword
    ? (secret?.gatewayPassword || secret?.targetPassword || '')
    : (secret?.targetPassword || secret?.gatewayPassword || '');
  const secondPassword = targetNeedsPassword
    ? (secret?.targetPassword || firstPassword)
    : firstPassword;
  const statePath = path.join(process.cwd(), 'tmp', `askpass-state-${connector.connectorId || makeId()}.txt`);

  try {
    fs.rmSync(statePath, { force: true });
  } catch (_) {
    // Best effort. A stale state file only changes which saved password is tried first.
  }

  return {
    SSH_ASKPASS: ensureAskpassHelper(),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || 'remote-codex',
    RC_ASKPASS_STATE_FILE: statePath,
    RC_ASKPASS_PASSWORD_1_B64: base64Secret(firstPassword),
    RC_ASKPASS_PASSWORD_2_B64: base64Secret(secondPassword || firstPassword),
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
    options.preferredAuthentications = 'password,keyboard-interactive';
  } else {
    options.batchMode = true;
  }

  return options;
}

function buildConnectorAction(connector, action, secret = null) {
  const baseOptions = buildSshActionOptions(connector, action, secret);
  const env = connectorUsesAskpass(connector, secret)
    ? buildAskpassEnv(connector, secret)
    : null;

  if (action === 'smoke_test') {
    return {
      timeoutMs: 12_000,
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        remoteCommand: 'echo SSH_OK',
      }),
      displayCommand: decorateSingleConnector(connector).plan.sshSmokeTestCommand,
      env,
    };
  }

  if (action === 'status') {
    return {
      timeoutMs: 12_000,
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        remoteCommand: buildRemoteStatusCommand(connector),
      }),
      displayCommand: decorateSingleConnector(connector).plan.sshStatusCommand,
      env,
    };
  }

  if (action === 'bootstrap') {
    const remoteCommand = buildDetachedBootstrapCommand(connector);
    return {
      timeoutMs: 20_000,
      commandParts: remoteCommand
        ? buildSshCommandParts(connector, {
          ...baseOptions,
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
  if (action === 'bootstrap') {
    const ok = run.exitCode === 0 && stdout.includes('CODEX_REMOTE_AGENT_BOOTSTRAPPED');
    return {
      ok,
      status: ok ? 'bootstrapped' : 'bootstrap_failed',
      message: ok ? 'Remote host-agent bootstrap command completed.' : 'Remote host-agent bootstrap command failed.',
    };
  }

  return { ok: false, status: 'unknown_action', message: 'Unknown connector action.' };
}

async function runConnectorAction(connector, action) {
  const decorated = decorateSingleConnector(connector);
  const secret = state.connectorSecrets.get(connector.connectorId) || null;
  const manualCommand = decorated.plan.sshLoginCommand;
  const manualBootstrapCommand = decorated.plan.bootstrapCommand;

  if (!['smoke_test', 'status', 'bootstrap'].includes(action)) {
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

  const actionConfig = buildConnectorAction(connector, action, secret);
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

  const run = await runProcess(
    actionConfig.commandParts.command,
    actionConfig.commandParts.args,
    {
      timeoutMs: actionConfig.timeoutMs,
      env: actionConfig.env || null,
    }
  );
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

function upsertSession(hostId, patch) {
  const key = sessionKey(hostId, patch.sessionId);
  const existing = state.sessions.get(key) || {
    hostId,
    sessionId: patch.sessionId,
    title: patch.title || patch.sessionId,
    cwd: patch.cwd || null,
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
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, time: nowIso() });
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

  if (req.method === 'POST' && url.pathname.match(/^\/api\/connectors\/[^/]+\/actions$/)) {
    const connectorId = decodeURIComponent(url.pathname.split('/')[3]);
    const connector = state.connectors.get(connectorId);
    if (!connector) {
      sendJson(res, 404, { error: 'connector not found' });
      return;
    }

    const body = await readBody(req);
    const action = String(body.action || '').trim();
    const result = await runConnectorAction(connector, action);
    sendJson(res, result.httpStatus, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/hosts\/[^/]+\/sessions$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    sendJson(res, 200, { sessions: getSessionsForHost(hostId) });
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
      host.lastSeenAt = nowIso();
      state.hosts.set(body.hostId, host);
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
    const resolvedConversationKey = body.conversationKey || originSessionId || sessionId;
    const resumeTranscript = sourceDetail ? buildResumeTranscript(sourceDetail.transcript) : [];

    upsertSession(hostId, {
      sessionId,
      cwd,
      title: body.label || cwd || sessionId,
      source: 'managed',
      state: 'starting',
      live: false,
      originSessionId,
      sourceSessionId,
      conversationKey: resolvedConversationKey,
      launchMode,
      bridgeSessionId,
      nativeThreadId: nativeThreadId || sessionId,
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
      originSessionId,
      sourceSessionId,
      conversationKey: resolvedConversationKey,
      launchMode,
      resumeTranscript,
      nativeThreadId,
    });
    sendJson(res, 200, { ok: true, sessionId, command });
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

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!session.live) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }

    emitTranscriptEntry(hostId, sessionId, {
      speaker: 'user',
      text: String(body.text || ''),
      timestamp: nowIso(),
    });
    const next = upsertSession(hostId, {
      sessionId,
      latestUserMessage: String(body.text || ''),
      lastUpdatedAt: nowIso(),
    });
    broadcastSessionEvent(hostId, sessionId, 'session.snapshot', next);

    const command = enqueueCommand(hostId, {
      type: 'session.input',
      sessionId,
      text: String(body.text || ''),
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

    const command = enqueueCommand(hostId, {
      type: 'session.stop',
      sessionId,
    });
    sendJson(res, 200, { ok: true, command });
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
        lastUpdatedAt: session.updatedAt || nowIso(),
        latestUserMessage: session.latestUserMessage || null,
        latestAgentMessage: session.latestAgentMessage || null,
        transcriptPreview: session.transcriptPreview || [],
        originSessionId: session.originSessionId || null,
        sourceSessionId: session.sourceSessionId || null,
        conversationKey: session.conversationKey || session.originSessionId || session.sessionId,
        launchMode: session.launchMode || null,
        runtime: preserveManagedState ? existing.runtime || null : existing?.runtime || null,
        bridgeSessionId: existing?.bridgeSessionId || null,
        nativeThreadId: existing?.nativeThreadId || session.nativeThreadId || session.sessionId,
      });
      if (!preserveManagedState && !next.live && Array.isArray(session.transcriptPreview)) {
        setSessionLog(event.hostId, next.sessionId, session.transcriptPreview);
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

  const sessionId = event.sessionId;
  if (!sessionId) {
    return;
  }

  if (event.type === 'session.started') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    const next = event.bridgeSessionId && event.bridgeSessionId !== effectiveSessionId
      ? migrateSessionIdentity(event.hostId, event.bridgeSessionId, effectiveSessionId, {
        title: event.title || effectiveSessionId,
        cwd: event.cwd || null,
        source: event.source || 'managed',
        state: 'running',
        live: true,
        runtime: event.runtime || null,
        originSessionId: event.originSessionId || null,
        sourceSessionId: event.sourceSessionId || null,
        conversationKey: event.conversationKey || event.originSessionId || effectiveSessionId,
        launchMode: event.launchMode || null,
        nativeThreadId: event.nativeThreadId || effectiveSessionId,
      })
      : upsertSession(event.hostId, {
        sessionId: effectiveSessionId,
        title: event.title || effectiveSessionId,
        cwd: event.cwd || null,
        source: event.source || 'managed',
        state: 'running',
        live: true,
        runtime: event.runtime || null,
        originSessionId: event.originSessionId || null,
        sourceSessionId: event.sourceSessionId || null,
        conversationKey: event.conversationKey || event.originSessionId || effectiveSessionId,
        launchMode: event.launchMode || null,
        bridgeSessionId: event.bridgeSessionId || null,
        nativeThreadId: event.nativeThreadId || effectiveSessionId,
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
    const next = upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      state: event.state || 'unknown',
      live: typeof event.live === 'boolean' ? event.live : true,
      lastUpdatedAt: nowIso(),
    });

    if (/^failed:/i.test(next.state) || /^exited:(?!0:)/i.test(next.state)) {
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
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.runtime', {
      ...(runtime || {}),
      hostId: event.hostId,
      sessionId: effectiveSessionId,
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
    emitSessionAlert(event.hostId, sessionId, {
      severity: 'error',
      source: 'runtime',
      message: event.message || 'session error',
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
});
