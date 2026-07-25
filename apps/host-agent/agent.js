const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');
const {
  discoverCodexSessions,
  extractSessionDiagnostics,
  extractSessionTranscript,
  findCodexSessionFile,
  getDefaultCodexHome,
  makeTranscriptEntry,
  readCodexSessionSummary,
} = require('../../shared/codex-discovery');
const { CodexSessionTailer } = require('../../shared/codex-tail');
const {
  CodexAssistantCursorIndex,
  normalizedFileKey,
} = require('../../shared/codex-assistant-cursor');
const { deliverAgentEventBatch } = require('../../shared/agent-event-batch');
const { createCoalescedAsyncTask } = require('../../shared/coalesced-async-task');
const { makeId, nowIso, normalizeArgs } = require('../../shared/protocol');
const { normalizePortableSkillId } = require('../../shared/skill-id');
const { resolveManagedRuntime, startManagedRuntimeSession } = require('./runtime-adapters');
const {
  abortUnconfirmedRunner,
  buildManagedSessionStartedEvent,
  createManagedSessionStartGate,
  createManagedSessionShutdown,
  findRunnerForCommand,
  retainRunnerForStartRetry,
  replayManagedSessionStart,
  shouldPublishMissingRunnerStop,
  stopRunnerOnce,
} = require('./managed-session-lifecycle');
const { cleanupStaleApiProfileCodexHomes } = require('./codex-app-server-runner');
const { normalizeApiConfig } = require('./runtime-utils');
const {
  attestHostEnvironmentBinding,
  deriveRunBinding,
  testApiProfile,
} = require('./session-api-runtime');
const { HostSkillArtifactService } = require('./skill-artifact-service');
const { HostSkillDeploymentService } = require('./skill-deployment-service');
const { HostSkillInventoryService } = require('./skill-inventory-service');
const {
  pruneExpiredSessionWatches,
  removeSessionWatch,
  upsertSessionWatch,
} = require('./session-watch-registry');

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const RELAY_AUTH_TOKEN = loadRelayAuthToken();
const HOST_ID = process.env.HOST_ID || os.hostname();
const HOST_LABEL = process.env.HOST_LABEL || HOST_ID;
const CODEX_HOME = process.env.CODEX_HOME || getDefaultCodexHome();
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);
const DISCOVERY_INTERVAL_MS = Number(process.env.DISCOVERY_INTERVAL_MS || 15000);
const CODEX_TAIL_ENABLED = String(process.env.CODEX_TAIL_ENABLED || 'true') !== 'false';
const CODEX_TAIL_INTERVAL_MS = Number(process.env.CODEX_TAIL_INTERVAL_MS || 1000);
const CODEX_DISCOVERY_LIST_PREVIEW = String(
  process.env.CODEX_DISCOVERY_LIST_PREVIEW || (process.platform !== 'win32' ? 'true' : 'false')
).trim().toLowerCase() !== 'false';
const CODEX_DISCOVERY_LIST_META_LIMIT = Number(
  process.env.CODEX_DISCOVERY_LIST_META_LIMIT || (CODEX_DISCOVERY_LIST_PREVIEW ? 250 : 40)
);
const CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_SCAN = Math.max(
  1024,
  Number(process.env.CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_SCAN || 256 * 1024) || 256 * 1024
);
const CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_DISCOVERY = Math.max(
  CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_SCAN,
  Number(process.env.CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_DISCOVERY || 4 * 1024 * 1024)
    || 4 * 1024 * 1024
);
const SESSION_WATCH_TTL_MS = Math.max(30000, Number(process.env.AGENT_SESSION_WATCH_TTL_MS || 5 * 60 * 1000));
const WATCH_PERFORMANCE_WARN_MS = Math.max(1000, Number(process.env.AGENT_WATCH_PERFORMANCE_WARN_MS || 8000));
const WATCH_PERFORMANCE_SLOW_MS = Math.max(WATCH_PERFORMANCE_WARN_MS, Number(process.env.AGENT_WATCH_PERFORMANCE_SLOW_MS || 15000));
const WATCH_PERFORMANCE_REPORT_COOLDOWN_MS = Math.max(10000, Number(process.env.AGENT_WATCH_PERFORMANCE_REPORT_COOLDOWN_MS || 60000));
const AUTO_START_SESSION = String(process.env.AUTO_START_SESSION || 'true') !== 'false';
const MANAGED_RUNTIME = process.env.MANAGED_RUNTIME || '';
const MANAGED_COMMAND = process.env.MANAGED_COMMAND || 'codex-app-server';
const MANAGED_ARGS = normalizeArgs(process.env.MANAGED_ARGS_JSON || '[]');
const MANAGED_CWD = process.env.MANAGED_CWD || process.cwd();
const WORKSPACE_ROOTS = parseWorkspaceRoots(process.env.WORKSPACE_ROOTS || '');
const AGENTS_HOME = process.env.AGENTS_HOME || path.join(os.homedir(), '.agents');
const CC_SWITCH_HOME = process.env.CC_SWITCH_HOME || path.join(os.homedir(), '.cc-switch');
const SKILL_PLUGIN_ROOTS = parseWorkspaceRoots(process.env.SKILL_PLUGIN_ROOTS || '');
const REMOTE_CODEX_STATE_ROOT = process.env.REMOTE_CODEX_STATE_ROOT || path.join(os.homedir(), '.remote-codex');
const MAX_FILE_TRANSFER_BYTES = Number(process.env.AGENT_MAX_FILE_TRANSFER_BYTES || 128 * 1024 * 1024);
const MAX_CHUNKED_FILE_TRANSFER_BYTES = Number(process.env.AGENT_MAX_CHUNKED_FILE_TRANSFER_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_FILE_CHUNK_BYTES = Number(process.env.AGENT_FILE_TRANSFER_CHUNK_BYTES || 4 * 1024 * 1024);
const FETCH_RETRY_ATTEMPTS = Math.max(1, Number(process.env.AGENT_FETCH_RETRY_ATTEMPTS || 3));
const FETCH_RETRY_BASE_MS = Math.max(50, Number(process.env.AGENT_FETCH_RETRY_BASE_MS || 150));
const FETCH_REQUEST_TIMEOUT_MS = Number(process.env.AGENT_FETCH_TIMEOUT_MS || 30000);
const SESSION_DETAIL_DIAGNOSTIC_LIMIT = Number(process.env.AGENT_SESSION_DETAIL_DIAGNOSTIC_LIMIT || 400);
const WINDOWS_DRIVE_PROBE_LETTERS = String(process.env.AGENT_WINDOWS_BROWSE_DRIVES || 'CDE')
  .toUpperCase()
  .replace(/[^A-Z]/g, '');
const AGENT_SHUTDOWN_GRACE_MS = Math.max(
  1000,
  Number(process.env.AGENT_SHUTDOWN_GRACE_MS || 10000) || 10000
);
const OWNERSHIP_REVOKED_SHUTDOWN_RETRY_MS = Math.max(
  250,
  Number(process.env.AGENT_OWNERSHIP_REVOKED_SHUTDOWN_RETRY_MS || 1000) || 1000
);
const AGENT_PROCESS_STARTED_AT = nowIso();
const RELAY_MANAGED_LOCAL_AGENT = /^(1|true|yes|on)$/i.test(
  String(process.env.RELAY_MANAGED_LOCAL_AGENT || '').trim()
);
const RELAY_MANAGED_AGENT_INSTANCE_ID = String(
  process.env.RELAY_MANAGED_AGENT_INSTANCE_ID || ''
).trim();
const AGENT_INSTANCE_ID = RELAY_MANAGED_AGENT_INSTANCE_ID || makeId();
const RELAY_MANAGED_AGENT_TOKEN = String(process.env.RELAY_MANAGED_AGENT_TOKEN || '').trim();
const RELAY_MANAGED_MARKER_PATH = String(process.env.RELAY_MANAGED_MARKER_PATH || '').trim();
const RELAY_MANAGED_OWNER_PID = Math.trunc(Number(process.env.RELAY_MANAGED_OWNER_PID || 0));
const CLEAN_LEGACY_MANAGED_OVERLAYS = String(
  process.env.AGENT_CLEAN_LEGACY_MANAGED_OVERLAYS || ''
).trim().toLowerCase() === 'true';

const liveSessions = new Map();
const managedSessionStartGate = createManagedSessionStartGate();
const activeFileUploads = new Map();
const watchedHistorySessions = new Map();
const watchedSessionRevisions = new Map();
let lastWatchPerformanceReportAt = 0;
let hostSkillInventory = null;
let hostSkillDeployment = null;
const assistantCursorIndex = new CodexAssistantCursorIndex({
  maxBytesPerScan: CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_SCAN,
  maxBytesPerScanMany: CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_DISCOVERY,
  now: nowIso,
});
const codexTailer = CODEX_TAIL_ENABLED
  ? new CodexSessionTailer({
    codexHome: CODEX_HOME,
    hostId: HOST_ID,
    postEvent,
    postEvents,
    assistantCursorIndex,
    log: logAgentError,
  })
  : null;
let lastCommandId = 0;
let relayInstanceId = null;
let agentLeaseId = null;
let agentRegistrationPromise = null;

function observeRelayInstance(body) {
  const nextRelayInstanceId = String(body?.relayInstanceId || '').trim();
  if (!nextRelayInstanceId) return false;
  const changed = Boolean(relayInstanceId && relayInstanceId !== nextRelayInstanceId);
  if (changed) {
    lastCommandId = 0;
  }
  relayInstanceId = nextRelayInstanceId;
  return changed;
}

function observeAgentLease(body) {
  const nextLeaseId = String(body?.agentLeaseId || '').trim();
  if (!nextLeaseId) return false;
  const changed = Boolean(agentLeaseId && agentLeaseId !== nextLeaseId);
  agentLeaseId = nextLeaseId;
  return changed;
}

function managedAgentProcessMetadata() {
  if (
    !RELAY_MANAGED_LOCAL_AGENT
    || !RELAY_MANAGED_AGENT_INSTANCE_ID
    || !RELAY_MANAGED_AGENT_TOKEN
  ) {
    return null;
  }
  return {
    relayManaged: true,
    pid: process.pid,
    parentPid: process.ppid,
    instanceId: RELAY_MANAGED_AGENT_INSTANCE_ID,
    ownershipToken: RELAY_MANAGED_AGENT_TOKEN,
    relayUrl: RELAY_URL,
    startedAt: AGENT_PROCESS_STARTED_AT,
  };
}

function managedAgentRequestHeaders() {
  const metadata = managedAgentProcessMetadata();
  return {
    'X-Remote-Codex-Agent-Instance': AGENT_INSTANCE_ID,
    ...(agentLeaseId ? { 'X-Remote-Codex-Agent-Lease': agentLeaseId } : {}),
    ...(metadata ? {
      'X-Remote-Codex-Agent-Managed': '1',
      'X-Remote-Codex-Agent-Pid': String(metadata.pid),
      'X-Remote-Codex-Agent-Token': metadata.ownershipToken,
    } : {}),
  };
}

function managedAgentOwnershipMarker() {
  const metadata = managedAgentProcessMetadata();
  if (!metadata || !RELAY_MANAGED_MARKER_PATH) return null;
  return {
    kind: 'remote-codex-local-agent-owner',
    version: 1,
    hostId: HOST_ID,
    pid: process.pid,
    instanceId: metadata.instanceId,
    ownershipToken: metadata.ownershipToken,
    ownerRelayPid: RELAY_MANAGED_OWNER_PID > 0 ? RELAY_MANAGED_OWNER_PID : process.ppid,
    relayUrl: RELAY_URL,
    startedAt: AGENT_PROCESS_STARTED_AT,
  };
}

function ensureManagedAgentOwnershipMarker() {
  const marker = managedAgentOwnershipMarker();
  if (!marker) return false;
  try {
    if (fs.existsSync(RELAY_MANAGED_MARKER_PATH)) {
      const existing = JSON.parse(fs.readFileSync(RELAY_MANAGED_MARKER_PATH, 'utf8'));
      return String(existing?.instanceId || '') === marker.instanceId
        && String(existing?.ownershipToken || '') === marker.ownershipToken
        && Number(existing?.pid || 0) === marker.pid;
    }
    fs.mkdirSync(path.dirname(RELAY_MANAGED_MARKER_PATH), { recursive: true });
    const tempPath = `${RELAY_MANAGED_MARKER_PATH}.${process.pid}.${makeId()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(tempPath, RELAY_MANAGED_MARKER_PATH);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch (_) {
        // Best effort cleanup of an incomplete marker write.
      }
      throw error;
    }
    return true;
  } catch (error) {
    logAgentError('[agent] failed to ensure Relay ownership marker:', error.message || error);
    return false;
  }
}

function removeManagedAgentOwnershipMarker() {
  const marker = managedAgentOwnershipMarker();
  if (!marker) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(RELAY_MANAGED_MARKER_PATH, 'utf8'));
    if (
      String(existing?.instanceId || '') !== marker.instanceId
      || String(existing?.ownershipToken || '') !== marker.ownershipToken
      || Number(existing?.pid || 0) !== marker.pid
    ) {
      return false;
    }
    fs.rmSync(RELAY_MANAGED_MARKER_PATH, { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

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

function getCapabilities() {
  return {
    discovery: true,
    hostAgentLeaseV1: true,
    managedSessions: true,
    directoryBrowse: true,
    hostSkills: true,
    hostSkillInventoryV2: true,
    hostSkillArtifactsV1: true,
    hostSkillDeploymentV1: true,
    structuredStatus: true,
    requestResponses: true,
    interrupt: true,
    hostProbe: true,
    turnControls: true,
    nativePlan: true,
    goalControls: true,
    sessionDetail: true,
    sessionSearch: true,
    modelList: true,
    skillList: true,
    apiTest: true,
    apiCatalog: true,
    bindingPreflight: true,
    runApiBinding: MANAGED_RUNTIME !== 'demo' && MANAGED_COMMAND !== 'demo',
    nativeResumeReadiness: MANAGED_RUNTIME !== 'demo' && MANAGED_COMMAND !== 'demo',
    review: true,
    imageInput: true,
    fileTransfer: true,
    chunkedFileTransfer: true,
    agentRuntimes: true,
    realtimeSessionSync: CODEX_TAIL_ENABLED,
    codexJsonlTail: CODEX_TAIL_ENABLED,
    sessionWatchV2: true,
    demoMode: MANAGED_RUNTIME === 'demo' || MANAGED_COMMAND === 'demo',
  };
}

function normalizeSkillId(value) {
  return normalizePortableSkillId(value);
}

function ensureSafeSkillPath(codexHome, skillId) {
  const normalizedId = normalizeSkillId(skillId);
  const skillsRoot = path.resolve(codexHome || CODEX_HOME, 'skills');
  const target = path.resolve(skillsRoot, normalizedId);
  const relative = path.relative(skillsRoot, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('skill path escapes CODEX_HOME skills directory');
  }
  return { skillsRoot, skillId: normalizedId, target };
}

function listInstalledSkills(options = {}) {
  const codexHome = options.codexHome || CODEX_HOME;
  const snapshot = options.snapshot || hostSkillInventory?.snapshot();
  return (Array.isArray(snapshot?.instances) ? snapshot.instances : [])
    .filter((instance) => instance.scope === 'user' && instance.enabled !== false)
    .map((instance) => ({
      skillId: instance.skillId,
      name: instance.name || instance.skillId,
      description: instance.description || '',
      installed: true,
      readonly: Boolean(instance.readonly),
      source: instance.sourceKind || 'codexHome',
      sourceId: instance.sourceId || null,
      hostId: HOST_ID,
      codexHome,
      installPath: instance.activationPath,
      observedHash: instance.observedHash || null,
    }))
    .sort((a, b) => String(a.name || a.skillId).localeCompare(String(b.name || b.skillId)));
}

function skillMarkdownFromCatalog(skill) {
  const name = String(skill?.name || skill?.skillId || 'Skill').trim();
  const description = String(skill?.description || '').trim();
  const body = String(skill?.markdown || skill?.content || '').trim();
  if (body) {
    return body.endsWith('\n') ? body : `${body}\n`;
  }
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    description || 'Installed from Remote Codex Skills Manager.',
    '',
  ].join('\n');
}

function installHostSkill(skill, options = {}) {
  const codexHome = options.codexHome || CODEX_HOME;
  const { skillId, target } = ensureSafeSkillPath(codexHome, skill?.skillId || skill?.id || skill?.name);
  fs.mkdirSync(target, { recursive: true });
  const markdown = skillMarkdownFromCatalog({ ...skill, skillId });
  fs.writeFileSync(path.join(target, 'SKILL.md'), markdown, 'utf8');
  return {
    ok: true,
    action: 'install',
    skillId,
    hostId: HOST_ID,
    codexHome,
    installPath: target,
  };
}

function uninstallHostSkill(skillId, options = {}) {
  const codexHome = options.codexHome || CODEX_HOME;
  const { target, skillId: normalizedId } = ensureSafeSkillPath(codexHome, skillId);
  const markdownPath = path.join(target, 'SKILL.md');
  if (!fs.existsSync(markdownPath)) {
    return {
      ok: true,
      action: 'uninstall',
      skillId: normalizedId,
      hostId: HOST_ID,
      codexHome,
      skipped: true,
      message: 'not installed',
    };
  }
  const markdown = fs.readFileSync(markdownPath, 'utf8');
  const readonly = /remote-codex-readonly:\s*true/i.test(markdown);
  if (readonly) {
    throw new Error(`skill ${normalizedId} is readonly and cannot be uninstalled`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  return {
    ok: true,
    action: 'uninstall',
    skillId: normalizedId,
    hostId: HOST_ID,
    codexHome,
  };
}

async function handleHostSkillsCommand(command) {
  const requestId = command.requestId || makeId();
  const action = command.type === 'host.skills.install'
    ? 'install'
    : command.type === 'host.skills.uninstall'
      ? 'uninstall'
      : 'list';
  try {
    if (action === 'list') {
      const inventory = await hostSkillInventory.refresh({ force: true });
      await postEvent({
        type: 'host.skills.result',
        hostId: HOST_ID,
        requestId,
        action,
        ok: true,
        skills: listInstalledSkills({
          codexHome: command.codexHome || CODEX_HOME,
          snapshot: inventory.snapshot,
        }),
        timestamp: nowIso(),
      });
      return;
    }
    if (hostSkillDeployment) {
      throw new Error('Legacy Skill install/uninstall commands are disabled for managed deployment Hosts');
    }
    const skills = Array.isArray(command.skills) ? command.skills : [];
    const results = skills.map((skill) => {
      try {
        return action === 'install'
          ? installHostSkill(skill, { codexHome: command.codexHome || CODEX_HOME })
          : uninstallHostSkill(skill.skillId || skill.id || skill.name || skill, { codexHome: command.codexHome || CODEX_HOME });
      } catch (error) {
        return {
          ok: false,
          action,
          skillId: String(skill?.skillId || skill?.id || skill?.name || skill || ''),
          hostId: HOST_ID,
          codexHome: command.codexHome || CODEX_HOME,
          error: error.message,
        };
      }
    });
    const inventory = await hostSkillInventory.refresh({ force: true });
    await postEvent({
      type: 'host.skills.result',
      hostId: HOST_ID,
      requestId,
      action,
      ok: results.every((result) => result.ok),
      results,
      skills: listInstalledSkills({
        codexHome: command.codexHome || CODEX_HOME,
        snapshot: inventory.snapshot,
      }),
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'host.skills.result',
      hostId: HOST_ID,
      requestId,
      action,
      ok: false,
      error: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleHostSkillArtifactCommand(command) {
  const adoptionId = String(command.adoptionId || '').trim();
  const instanceId = String(command.instanceId || '').trim();
  try {
    const result = await hostSkillArtifact.exportInstance(command);
    await postEvent({
      type: 'host.skills.artifact.result',
      hostId: HOST_ID,
      adoptionId,
      instanceId,
      ok: true,
      ...result,
      timestamp: nowIso(),
    });
  } catch (error) {
    await postEvent({
      type: 'host.skills.artifact.result',
      hostId: HOST_ID,
      adoptionId,
      instanceId,
      ok: false,
      error: error.message,
      timestamp: nowIso(),
    });
  }
}

async function handleHostSkillDeploymentCommand(command) {
  let deploymentEvent;
  const pendingDeploymentResult = hostSkillDeployment.getPendingResult(command.deploymentId);
  if (pendingDeploymentResult) {
    deploymentEvent = pendingDeploymentResult;
  } else {
    try {
      const result = await hostSkillDeployment.applyDeployment(command);
      deploymentEvent = {
        type: 'host.skills.deployment.result',
        ...result,
        commandId: Number(command.id || 0),
        timestamp: result.timestamp || nowIso(),
      };
    } catch (error) {
      deploymentEvent = {
        type: 'host.skills.deployment.result',
        hostId: HOST_ID,
        deploymentId: String(command.deploymentId || '').trim(),
        commandId: Number(command.id || 0),
        action: String(command.action || '').trim(),
        skillId: String(command.skillId || '').trim(),
        artifactId: String(command.artifactId || '').trim(),
        targetScope: String(command.targetScope || '').trim(),
        scopeId: String(command.scopeId || '').trim(),
        ok: false,
        error: error.message,
        timestamp: nowIso(),
      };
    }
    hostSkillDeployment.stagePendingResult(deploymentEvent);
  }
  await postEvent(deploymentEvent);
  hostSkillDeployment.clearPendingResult(command.deploymentId);
}

function logAgentError(...args) {
  console.error(`[${nowIso()}]`, ...args);
}

function logAgentNotice(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

function isTransientFetchError(error) {
  if (!error) {
    return false;
  }
  return error.code === 'ECONNRESET'
    || error.code === 'ECONNREFUSED'
    || error.code === 'EPIPE'
    || error.code === 'ETIMEDOUT'
    || error.code === 'ECONNABORTED'
    || error.message === 'socket hang up'
    || error.message === 'aborted'
    || error.message === 'response aborted';
}

function isRelayOwnershipRevokedError(error) {
  if (Number(error?.statusCode || 0) !== 409) return false;
  const code = String(error?.body?.code || '').trim();
  if (code === 'host_agent_instance_conflict') {
    return Boolean(agentLeaseId);
  }
  return new Set([
    'local_agent_ownership_required',
    'local_agent_ownership_mismatch',
    'local_agent_instance_conflict',
    'host_agent_lease_revoked',
  ]).has(code);
}

function isRelayHostDismissedError(error) {
  return String(error?.code || error?.body?.code || '').trim() === 'host_dismissed';
}

function makeRelayHostDismissedError() {
  const error = new Error(`Host ${HOST_ID} was dismissed by the Relay.`);
  error.code = 'host_dismissed';
  return error;
}

function isPreLeaseAgentInstanceConflict(error) {
  return !agentLeaseId
    && Number(error?.statusCode || 0) === 409
    && String(error?.body?.code || '').trim() === 'host_agent_instance_conflict';
}

function logAgentTransient(prefix, error) {
  const log = isTransientFetchError(error) ? logAgentNotice : logAgentError;
  log(prefix, error?.message || String(error || 'unknown error'));
}

async function fetchJson(targetUrl, options = {}) {
  const attempts = options.retryOnTransient ? FETCH_RETRY_ATTEMPTS : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonOnce(targetUrl, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientFetchError(error)) {
        throw error;
      }
      await sleep(FETCH_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

function fetchJsonOnce(targetUrl, options = {}) {
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;
  const authHeaders = RELAY_AUTH_TOKEN
    ? { Authorization: `Bearer ${RELAY_AUTH_TOKEN}` }
    : {};
  const serializedBody = options.body ? JSON.stringify(options.body) : '';

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
          ...(serializedBody ? { 'Content-Length': Buffer.byteLength(serializedBody) } : {}),
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
            const responseError = new Error(`invalid JSON from ${targetUrl}: ${error.message}`);
            responseError.statusCode = res.statusCode || 0;
            responseError.body = raw;
            settle(reject, responseError);
            return;
          }
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            const error = new Error((body && body.error) || `relay request failed with ${res.statusCode}`);
            error.statusCode = res.statusCode || 0;
            error.body = body;
            settle(reject, error);
            return;
          }
          settle(resolve, { statusCode: res.statusCode || 0, body });
        });
        res.on('error', (error) => settle(reject, error));
        res.on('aborted', () => {
          const error = new Error('response aborted');
          error.code = 'ECONNRESET';
          settle(reject, error);
        });
      }
    );

    req.on('error', (error) => settle(reject, error));
    const requestTimeoutMs = Number(options.timeoutMs ?? FETCH_REQUEST_TIMEOUT_MS);
    if (requestTimeoutMs > 0) {
      req.setTimeout(requestTimeoutMs, () => {
        const error = new Error('relay request timed out');
        error.code = 'ETIMEDOUT';
        req.destroy(error);
      });
    }
    if (serializedBody) {
      req.write(serializedBody);
    }
    req.end();
  });
}

async function postAgentEventPayload(body, label, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = managedAgentRequestHeaders();
    const requestLeaseId = String(headers['X-Remote-Codex-Agent-Lease'] || '').trim();
    try {
      const result = await fetchJson(`${RELAY_URL}/api/agent/events`, {
        method: 'POST',
        body,
        retryOnTransient: options.retryOnTransient !== false,
        headers,
      });
      if (result.body?.dismissed) {
        throw makeRelayHostDismissedError();
      }
      observeRelayInstance(result.body);
      observeAgentLease(result.body);
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        try {
          if (await recoverAgentLeaseForRequest(error, requestLeaseId)) {
            continue;
          }
        } catch (recoveryError) {
          lastError = recoveryError;
        }
      }
      break;
    }
  }
  if (options.bestEffort) {
    logAgentTransient(`[agent] failed to post ${label}:`, lastError);
    return null;
  }
  if (isTransientFetchError(lastError)) {
    logAgentTransient(`[agent] failed to post ${label}:`, lastError);
  }
  throw lastError;
}

async function postEvent(event, options = {}) {
  const batchId = String(options.batchId || '').trim() || `event:${HOST_ID}:${makeId()}`;
  await postAgentEventPayload({ event, batchId }, event?.type || 'event', options);
}

async function postEvents(events, options = {}) {
  const batch = (Array.isArray(events) ? events : []).filter(Boolean);
  const batchId = String(options.batchId || '').trim() || `events:${HOST_ID}:${makeId()}`;
  return deliverAgentEventBatch(batch, {
    batchId,
    bestEffort: Boolean(options.bestEffort),
    sendBatch: (eventBatch, batchId) => postAgentEventPayload({
      events: eventBatch,
      ...(batchId ? { batchId } : {}),
    }, `${eventBatch.length} event(s)`, options),
    // A legacy Relay receives separate POSTs. Each event needs its own key;
    // reusing the original batch id would conflict after the first payload.
    sendSingle: (event) => postEvent(event, { ...options, batchId: '' }),
  });
}

hostSkillInventory = new HostSkillInventoryService({
  hostId: HOST_ID,
  codexHome: CODEX_HOME,
  agentsHome: AGENTS_HOME,
  ccSwitchHome: CC_SWITCH_HOME,
  pluginRoots: SKILL_PLUGIN_ROOTS,
  workspaceRoots: [
    ...WORKSPACE_ROOTS,
    MANAGED_CWD,
    ...uniqueLiveRunners().map((runner) => runner.cwd || runner.runtime?.cwd).filter(Boolean),
  ],
  transformSnapshot: (snapshot) => (
    hostSkillDeployment ? hostSkillDeployment.decorateInventorySnapshot(snapshot) : snapshot
  ),
  publish: async (snapshot, context = null) => {
    await postEvent({
      type: 'host.skills.inventory',
      hostId: HOST_ID,
      requestId: context?.requestId || null,
      ...snapshot,
      timestamp: nowIso(),
    }, { retryOnTransient: true });
  },
  log: logAgentNotice,
});

const hostSkillArtifact = new HostSkillArtifactService({
  hostId: HOST_ID,
  inventoryService: hostSkillInventory,
  relayUrl: RELAY_URL,
  authToken: RELAY_AUTH_TOKEN,
  tempRoot: process.env.SKILL_ARTIFACT_TEMP_ROOT || undefined,
});

hostSkillDeployment = new HostSkillDeploymentService({
  hostId: HOST_ID,
  codexHome: CODEX_HOME,
  stateRoot: REMOTE_CODEX_STATE_ROOT,
  inventoryService: hostSkillInventory,
  relayUrl: RELAY_URL,
  authToken: RELAY_AUTH_TOKEN,
});

async function registerHost() {
  const result = await fetchJson(`${RELAY_URL}/api/agent/register`, {
    method: 'POST',
    retryOnTransient: true,
    headers: managedAgentRequestHeaders(),
    body: {
      hostId: HOST_ID,
      agentInstanceId: AGENT_INSTANCE_ID,
      label: HOST_LABEL,
      platform: process.platform,
      codexHome: CODEX_HOME,
      skillsRevision: hostSkillInventory.snapshot()?.revision || null,
      capabilities: getCapabilities(),
      agentProcess: managedAgentProcessMetadata(),
    },
  });
  if (result.body?.dismissed) {
    throw makeRelayHostDismissedError();
  }
  observeRelayInstance(result.body);
  observeAgentLease(result.body);
}

function ensureHostRegistration() {
  if (!agentRegistrationPromise) {
    agentRegistrationPromise = registerHost().finally(() => {
      agentRegistrationPromise = null;
    });
  }
  return agentRegistrationPromise;
}

async function recoverAgentLeaseForRequest(error, requestLeaseId = '') {
  const code = String(error?.body?.code || '').trim();
  const relayChanged = observeRelayInstance(error?.body);
  const leaseRotated = Boolean(
    requestLeaseId
    && agentLeaseId
    && requestLeaseId !== agentLeaseId
  );
  if (code === 'host_agent_registration_required') {
    await ensureHostRegistration();
    return true;
  }
  if (code === 'host_agent_lease_revoked' && (relayChanged || leaseRotated)) {
    if (!leaseRotated) {
      await ensureHostRegistration();
    }
    return true;
  }
  return false;
}

async function heartbeat() {
  const result = await fetchJson(`${RELAY_URL}/api/agent/heartbeat`, {
    method: 'POST',
    retryOnTransient: true,
    headers: managedAgentRequestHeaders(),
    body: {
      hostId: HOST_ID,
      agentInstanceId: AGENT_INSTANCE_ID,
      label: HOST_LABEL,
      platform: process.platform,
      codexHome: CODEX_HOME,
      skillsRevision: hostSkillInventory.snapshot()?.revision || null,
      capabilities: getCapabilities(),
      agentProcess: managedAgentProcessMetadata(),
      time: nowIso(),
    },
  });
  if (result.body?.dismissed) {
    throw makeRelayHostDismissedError();
  }
  observeRelayInstance(result.body);
  observeAgentLease(result.body);
}

async function releaseAgentLease() {
  const releasingLeaseId = String(agentLeaseId || '').trim();
  if (!releasingLeaseId) return false;
  try {
    await fetchJson(`${RELAY_URL}/api/agent/release`, {
      method: 'POST',
      body: {
        hostId: HOST_ID,
        agentInstanceId: AGENT_INSTANCE_ID,
        agentLeaseId: releasingLeaseId,
      },
      headers: managedAgentRequestHeaders(),
      timeoutMs: 1500,
    });
    if (agentLeaseId === releasingLeaseId) {
      agentLeaseId = null;
    }
    return true;
  } catch (error) {
    logAgentTransient('[agent] lease release failed:', error);
    return false;
  }
}

async function performDiscovery() {
  const discoveredSessions = discoverCodexSessions({
    codexHome: CODEX_HOME,
    preview: CODEX_DISCOVERY_LIST_PREVIEW,
    metaReadLimit: CODEX_DISCOVERY_LIST_META_LIMIT,
  });
  const cursorResults = assistantCursorIndex.scanMany(discoveredSessions);
  const cursorByPath = new Map(cursorResults.map((result) => [
    normalizedFileKey(result.rolloutPath),
    result,
  ]));
  const sessions = discoveredSessions.map((session) => {
    const cursor = session.rolloutPath
      ? cursorByPath.get(normalizedFileKey(session.rolloutPath))
      : null;
    return {
      sessionId: session.sessionId,
      nativeThreadId: session.nativeThreadId || session.sessionId,
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
      rolloutPath: session.rolloutPath || null,
      originSessionId: session.originSessionId || null,
      conversationKey: session.conversationKey || session.sessionId,
      ...(cursor ? {
        assistantCursor: {
          observations: cursor.observations,
          cursorOffset: cursor.cursorOffset,
          cursorUnknown: cursor.cursorUnknown,
          fileIdentity: cursor.fileIdentity,
          replaced: cursor.replaced,
          truncated: cursor.truncated,
          projectionRevision: cursor.projectionRevision,
        },
      } : {}),
    };
  });

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
      runId: runner.runId || runner.runtime?.runId || null,
      nativeThreadId: runner.nativeThreadId || liveSessionId,
      launchMode: runner.launchMode || null,
      runtime: runner.runtime || null,
    });
  }

  const addedWorkspaceRoots = hostSkillInventory.addWorkspaceRoots(
    sessions.map((session) => session.cwd).filter(Boolean)
  );
  hostSkillInventory.refresh({ force: addedWorkspaceRoots > 0 }).catch((error) => {
    logAgentTransient('[agent] skill inventory refresh failed:', error);
  });

  const discoveryId = makeId();
  await postEvents([{
    type: 'session.discovery',
    hostId: HOST_ID,
    discoveryId,
    discoveredAt: nowIso(),
    sessions,
  }], {
    batchId: `session.discovery:${discoveryId}`,
    retryOnTransient: true,
  });
  assistantCursorIndex.acknowledgeMany(cursorResults);
}

const runCoalescedDiscovery = createCoalescedAsyncTask(performDiscovery);

function sendDiscovery() {
  return runCoalescedDiscovery();
}

function collectSessionIdentityCandidates(input = {}) {
  return [
    input.sessionId,
    input.nativeThreadId,
    input.bridgeSessionId,
    input.originSessionId,
    input.sourceSessionId,
    input.conversationKey,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function commandCodexHomeCandidates(input = {}) {
  const values = [];
  const add = (value) => {
    const text = String(value || '').trim();
    if (text && !values.includes(text)) {
      values.push(text);
    }
  };
  add(input.codexHome);
  const runner = findRunnerForCommand(liveSessions, input);
  add(runner?.codexHome);
  add(runner?.runtime?.codexHome);
  add(CODEX_HOME);
  return values;
}

function resolveSessionFileFromCandidates(input = {}) {
  for (const codexHome of commandCodexHomeCandidates(input)) {
    for (const candidate of collectSessionIdentityCandidates(input)) {
      const found = findCodexSessionFile({
        codexHome,
        sessionId: candidate,
        nativeThreadId: candidate,
        bridgeSessionId: candidate,
        originSessionId: candidate,
        sourceSessionId: candidate,
        conversationKey: candidate,
      });
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function resolveDiscoveredSession(command = {}) {
  const candidates = new Set(collectSessionIdentityCandidates(command));

  if (!candidates.size) {
    return null;
  }

  const found = resolveSessionFileFromCandidates(command);
  if (found?.rolloutPath) {
    const includePreview = !(command.fullTranscript === true || command.full === true || command.preview === false);
    return readCodexSessionSummary(found.rolloutPath, {
      metaReadLimit: 80,
      preview: includePreview,
    }) || found;
  }

  for (const codexHome of commandCodexHomeCandidates(command)) {
    const discovered = discoverCodexSessions({ codexHome }).find((session) => (
      candidates.has(String(session.sessionId || ''))
      || candidates.has(String(session.nativeThreadId || ''))
    ));
    if (discovered) {
      return discovered;
    }
  }
  return null;
}

async function handleSessionWatch(command = {}) {
  const requestId = command.requestId || makeId();
  const requestedSessionId = String(command.sessionId || command.nativeThreadId || '').trim();
  const found = resolveSessionFileFromCandidates(command);
  const watchOptions = {
    ownerRevisions: watchedSessionRevisions,
    ttlMs: SESSION_WATCH_TTL_MS,
  };
  if (!found?.rolloutPath) {
    const watchResult = upsertSessionWatch(watchedHistorySessions, command, {
      sessionId: requestedSessionId,
      nativeThreadId: command.nativeThreadId || requestedSessionId,
      conversationKey: command.conversationKey || null,
      rolloutPath: null,
    }, watchOptions);
    refreshTailerWatchedSessions();
    await postEvent({
      type: 'session.watch.updated',
      hostId: HOST_ID,
      requestId,
      sessionId: requestedSessionId,
      watched: false,
      stale: watchResult.stale,
      replaced: watchResult.replaced,
      watchRevision: command.watchRevision ?? null,
      leaseMs: SESSION_WATCH_TTL_MS,
      expiresAt: watchResult.entry?.expiresAt || null,
      watchedSessionCount: watchedHistorySessions.size,
      error: `history session ${requestedSessionId || '(unknown)'} was not found under CODEX_HOME`,
      timestamp: nowIso(),
    }, { bestEffort: true });
    return;
  }

  const watchResult = upsertSessionWatch(watchedHistorySessions, command, {
    ...found,
    sessionId: found.sessionId,
    nativeThreadId: found.nativeThreadId || found.sessionId,
    conversationKey: command.conversationKey || found.conversationKey || null,
  }, watchOptions);
  refreshTailerWatchedSessions();
  await postEvent({
    type: 'session.watch.updated',
    hostId: HOST_ID,
    requestId,
    sessionId: found.sessionId,
    requestedSessionId: requestedSessionId || null,
    nativeThreadId: found.nativeThreadId || found.sessionId,
    watched: watchResult.accepted,
    activeSessionId: watchResult.entry?.sessionId || null,
    stale: watchResult.stale,
    replaced: watchResult.replaced,
    watchRevision: command.watchRevision ?? null,
    leaseMs: SESSION_WATCH_TTL_MS,
    expiresAt: watchResult.entry?.expiresAt || null,
    watchedSessionCount: watchedHistorySessions.size,
    timestamp: nowIso(),
  }, { bestEffort: true });
}

async function handleSessionUnwatch(command = {}) {
  const result = removeSessionWatch(watchedHistorySessions, command, {
    ownerRevisions: watchedSessionRevisions,
    ttlMs: SESSION_WATCH_TTL_MS,
  });

  refreshTailerWatchedSessions();
  await postEvent({
    type: 'session.watch.updated',
    hostId: HOST_ID,
    requestId: command.requestId || makeId(),
    sessionId: command.sessionId || command.nativeThreadId || null,
    watched: false,
    removed: result.removed,
    stale: result.stale,
    watchRevision: command.watchRevision ?? null,
    watchedSessionCount: watchedHistorySessions.size,
    timestamp: nowIso(),
  }, { bestEffort: true });
}

function pruneExpiredWatchedSessions() {
  return pruneExpiredSessionWatches(watchedHistorySessions, {
    ownerRevisions: watchedSessionRevisions,
  });
}

function uniqueLiveRunners() {
  return Array.from(new Set(Array.from(liveSessions.values()).filter(Boolean)));
}

function resolveLiveTailSessions() {
  const sessions = [];
  for (const runner of uniqueLiveRunners()) {
    const liveSessionId = typeof runner.currentSessionId === 'function'
      ? runner.currentSessionId()
      : runner.sessionId;
    const found = resolveSessionFileFromCandidates({
      sessionId: liveSessionId,
      nativeThreadId: runner.nativeThreadId,
      bridgeSessionId: runner.bridgeSessionId,
      runId: runner.runId,
      conversationKey: runner.conversationKey,
    });
    if (found?.rolloutPath) {
      sessions.push({
        ...found,
        live: true,
      });
    }
  }
  return sessions;
}

function refreshTailerWatchedSessions() {
  pruneExpiredWatchedSessions();
  if (!codexTailer) {
    return { activeSessionCount: 0, watchedSessionCount: 0, liveSessionCount: 0 };
  }
  const liveTailSessions = resolveLiveTailSessions();
  const active = new Map();
  for (const session of watchedHistorySessions.values()) {
    if (session?.rolloutPath) {
      active.set(session.rolloutPath, session);
    }
  }
  for (const session of liveTailSessions) {
    if (session?.rolloutPath) {
      active.set(session.rolloutPath, session);
    }
  }
  const activeSessionCount = codexTailer.setWatchedSessions(Array.from(active.values()));
  return {
    activeSessionCount,
    watchedSessionCount: watchedHistorySessions.size,
    liveSessionCount: liveTailSessions.length,
  };
}

async function maybeReportWatchPerformance(pollMs, result, scope) {
  if (pollMs < WATCH_PERFORMANCE_WARN_MS) {
    return;
  }
  const now = Date.now();
  if (now - lastWatchPerformanceReportAt < WATCH_PERFORMANCE_REPORT_COOLDOWN_MS) {
    return;
  }
  lastWatchPerformanceReportAt = now;
  const severity = pollMs >= WATCH_PERFORMANCE_SLOW_MS ? 'warning' : 'info';
  const activeSessionCount = Number(result?.activeSessionCount ?? scope?.activeSessionCount ?? 0) || 0;
  const emittedEvents = Number(result?.emittedEvents || 0) || 0;
  const postedBatchCount = Number(result?.postedBatchCount || 0) || 0;
  const workload = emittedEvents
    ? `, ${emittedEvents} event(s) in ${postedBatchCount} batch(es)`
    : '';
  const message = severity === 'warning'
    ? `Realtime session sync took ${Math.round(pollMs / 1000)}s for ${activeSessionCount} active session(s)${workload}.`
    : `Realtime session sync is slowing down (${Math.round(pollMs)}ms for ${activeSessionCount} active session(s)${workload}).`;
  await postEvent({
    type: 'watch.performance',
    hostId: HOST_ID,
    severity,
    message,
    pollMs,
    platform: process.platform,
    activeSessionCount,
    emittedEvents,
    postedBatchCount,
    watchedSessionCount: scope?.watchedSessionCount || 0,
    liveSessionCount: scope?.liveSessionCount || 0,
    thresholdMs: severity === 'warning' ? WATCH_PERFORMANCE_SLOW_MS : WATCH_PERFORMANCE_WARN_MS,
    timestamp: nowIso(),
  }, { bestEffort: true });
}

function sessionDetailDiagnosticOptions(fullDiagnostics = false) {
  if (fullDiagnostics) {
    return { maxRows: Infinity };
  }

  const limit = SESSION_DETAIL_DIAGNOSTIC_LIMIT;
  const options = {
    headRows: 0,
    tailRows: limit,
  };
  if (Number.isFinite(limit) && limit > 0) {
    options.maxEntries = limit;
  }
  return options;
}

function normalizeSearchTerms(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);
}

function textMatchesTerms(value, terms) {
  const haystack = String(value || '').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function makeSearchSnippet(text, terms, maxLength = 220) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) {
    return '';
  }
  const lower = source.toLowerCase();
  const indexes = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0);
  const firstIndex = indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, firstIndex - Math.floor(maxLength / 3));
  const end = Math.min(source.length, start + maxLength);
  return `${start > 0 ? '...' : ''}${source.slice(start, end).trim()}${end < source.length ? '...' : ''}`;
}

function sessionSearchHaystack(session) {
  return [
    session?.title,
    session?.cwd,
    session?.sessionId,
    session?.nativeThreadId,
    session?.conversationKey,
    session?.latestUserMessage,
    session?.latestAgentMessage,
  ].filter(Boolean).join('\n');
}

async function searchTranscriptFile(filePath, terms, maxMatches) {
  const matches = [];
  if (!filePath || !fs.existsSync(filePath) || !terms.length || maxMatches <= 0) {
    return matches;
  }

  let entryIndex = 0;
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      const trimmed = String(line || '').trim();
      if (!trimmed) {
        continue;
      }
      let row = null;
      try {
        row = JSON.parse(trimmed);
      } catch (_) {
        continue;
      }
      const entry = makeTranscriptEntry(row, { maxChars: Infinity });
      if (!entry || !['user', 'agent', 'assistant'].includes(String(entry.speaker || '').toLowerCase())) {
        continue;
      }
      const currentIndex = entryIndex;
      entryIndex += 1;
      if (!textMatchesTerms(entry.text || '', terms)) {
        continue;
      }
      matches.push({
        type: 'transcript',
        entryIndex: currentIndex,
        speaker: entry.speaker || 'system',
        timestamp: entry.timestamp || null,
        snippet: makeSearchSnippet(entry.text || '', terms),
      });
      if (matches.length >= maxMatches) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return matches;
}

async function searchDiscoveredSessions(command = {}) {
  const query = String(command.query || '').trim();
  const mode = ['keyword', 'path', 'title'].includes(command.mode) ? command.mode : 'keyword';
  const terms = normalizeSearchTerms(query);
  const maxSessions = Math.max(1, Math.min(200, Number(command.maxSessions || 80) || 80));
  const maxMatchesPerSession = Math.max(1, Math.min(20, Number(command.maxMatchesPerSession || 5) || 5));
  const sessions = discoverCodexSessions({ codexHome: CODEX_HOME });
  const results = [];

  for (const session of sessions) {
    const matches = [];
    if (mode === 'title') {
      if (textMatchesTerms(session.title || '', terms)) {
        matches.push({
          type: 'title',
          entryIndex: -1,
          speaker: 'title',
          timestamp: session.updatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(session.title || '', terms),
        });
      }
    } else if (mode === 'path') {
      if (textMatchesTerms(session.cwd || '', terms)) {
        matches.push({
          type: 'path',
          entryIndex: -1,
          speaker: 'path',
          timestamp: session.updatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(session.cwd || '', terms),
        });
      }
    } else {
      if (textMatchesTerms(sessionSearchHaystack(session), terms)) {
        matches.push({
          type: 'metadata',
          entryIndex: -1,
          speaker: 'session',
          timestamp: session.updatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(sessionSearchHaystack(session), terms),
        });
      }
      if (matches.length < maxMatchesPerSession) {
        matches.push(...await searchTranscriptFile(
          session.rolloutPath,
          terms,
          maxMatchesPerSession - matches.length
        ));
      }
    }
    if (!matches.length) {
      continue;
    }
    results.push({
      hostId: HOST_ID,
      sessionId: session.sessionId,
      conversationKey: session.conversationKey || session.sessionId,
      title: session.title || session.sessionId,
      cwd: session.cwd || null,
      lastUpdatedAt: session.updatedAt || session.createdAt || null,
      live: false,
      matchCount: matches.length,
      matches,
    });
    if (results.length >= maxSessions) {
      break;
    }
  }
  return {
    query,
    mode,
    results,
    scannedSessions: sessions.length,
    truncated: results.length >= maxSessions,
  };
}

async function handleSessionDetail(command) {
  const requestId = command.requestId || makeId();
  const requestedSessionId = String(command.sessionId || command.nativeThreadId || '').trim();
  try {
    const session = resolveDiscoveredSession(command);
    if (!session || !session.rolloutPath || !fs.existsSync(session.rolloutPath)) {
      throw new Error(`history session ${requestedSessionId || '(unknown)'} was not found under CODEX_HOME`);
    }

    const fullTranscript = command.fullTranscript === true || command.full === true;
    const fullDiagnostics = command.fullDiagnostics === true || command.diagnostics === 'full';
    const transcript = fullTranscript
      ? extractSessionTranscript(session.rolloutPath, { maxChars: Infinity })
      : (Array.isArray(session.transcriptPreview) ? session.transcriptPreview : []);
    const diagnostics = extractSessionDiagnostics(session.rolloutPath, sessionDetailDiagnosticOptions(fullDiagnostics));

    await postEvent({
      type: 'session.detailed',
      hostId: HOST_ID,
      sessionId: requestedSessionId || session.sessionId,
      nativeThreadId: session.nativeThreadId || session.sessionId,
      requestId,
      session: {
        sessionId: session.sessionId,
        nativeThreadId: session.nativeThreadId || session.sessionId,
        title: session.title || session.sessionId,
        cwd: session.cwd || null,
        source: session.source || 'rollout',
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        messageCount: session.messageCount || transcript.length || 0,
        latestUserMessage: session.latestUserMessage || null,
        latestAgentMessage: session.latestAgentMessage || null,
        conversationKey: session.conversationKey || session.sessionId,
      },
      transcript,
      diagnostics,
      fullTranscript,
      fullDiagnostics,
      timestamp: nowIso(),
    }, { retryOnTransient: true });
  } catch (error) {
    await postEvent({
      type: 'session.detailed',
      hostId: HOST_ID,
      sessionId: requestedSessionId,
      requestId,
      error: error.message || 'failed to load session detail',
      timestamp: nowIso(),
    }, { bestEffort: true });
  }
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
    for (const letter of WINDOWS_DRIVE_PROBE_LETTERS) {
      const code = letter.charCodeAt(0);
      if (code < 65 || code > 90) {
        continue;
      }
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
  const raw = normalizeRemoteFilePath(inputPath);
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

function normalizeRemoteFilePath(value) {
  return String(value || '')
    .trim()
    .replace(/^[\\/]+([A-Za-z]:[\\/])/, '$1');
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
    '.apk': 'application/vnd.android.package-archive',
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
    '.pps': 'application/vnd.ms-powerpoint',
    '.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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

function resolveCommandCwd(command = {}) {
  const runner = findRunnerForCommand(liveSessions, command);
  const cwd = String(command.cwd || command.targetDirectory || runner?.cwd || MANAGED_CWD || '').trim();
  return resolveManagedCwd(cwd || MANAGED_CWD);
}

function resolveRemoteFilePath(inputPath, baseCwd) {
  const raw = normalizeRemoteFilePath(inputPath);
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
  const target = normalizeRemoteFilePath(cwd);
  if (!target) {
    return MANAGED_CWD;
  }

  return path.isAbsolute(target) ? target : path.resolve(MANAGED_CWD, target);
}

async function failManagedSession(sessionId, cwd, message, state = 'failed', runId = null) {
  let diagnosticDeliveryError = null;
  try {
    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId,
      runId,
      message,
      timestamp: nowIso(),
    });
  } catch (error) {
    diagnosticDeliveryError = error;
    logAgentTransient('[agent] failed to deliver managed Session failure diagnostic:', error);
  }

  try {
    await postEvent({
      type: 'session.state_changed',
      hostId: HOST_ID,
      sessionId,
      runId,
      state,
      live: false,
      timestamp: nowIso(),
    });
  } catch (terminalDeliveryError) {
    terminalDeliveryError.retryCommand = true;
    terminalDeliveryError.code = terminalDeliveryError.code || 'session_terminal_delivery_failed';
    if (diagnosticDeliveryError) {
      terminalDeliveryError.diagnosticDeliveryError = diagnosticDeliveryError;
    }
    throw terminalDeliveryError;
  }
}

async function postSessionCommandFailure(command, error, operation, runner = null) {
  await postEvent({
    type: 'session.command_failed',
    hostId: HOST_ID,
    sessionId: command.requestedSessionId || command.sessionId || runner?.sessionId || null,
    runId: runner?.runId || command.runId || null,
    operation,
    code: error?.code || 'session_command_failed',
    error: error?.message || String(error || 'Session command failed.'),
    canRebind: Boolean(error?.canRebind),
    timestamp: nowIso(),
  }, { bestEffort: true });
}

async function failShutdownCancelledManagedSession(command, sessionId, runId, cwd, runner = null) {
  if (hostAgentShutdownSuppressesTerminalEvents()) return false;
  const error = new Error('Managed Session start was cancelled because the Host Agent is shutting down.');
  error.code = 'session_start_cancelled_host_shutdown';
  error.failureState = 'failed:host-shutdown';
  await postSessionCommandFailure(command, error, 'start', runner);
  try {
    await failManagedSession(
      sessionId,
      cwd,
      error.message,
      error.failureState,
      runId
    );
  } catch (terminalDeliveryError) {
    terminalDeliveryError.shutdownTerminalDelivery = true;
    throw terminalDeliveryError;
  }
  return true;
}

async function startManagedSession(command) {
  const bridgeSessionId = command.sessionId || makeId();
  const runId = command.runId || makeId();
  let cwd = null;
  let announcedSessionId = bridgeSessionId;
  let runner = null;
  let startHandle = null;
  let shutdownFailurePublished = false;
  let startCompletionError = null;
  const removeRunnerIndexes = () => {
    if (!runner) return;
    for (const [key, candidate] of liveSessions.entries()) {
      if (candidate === runner) liveSessions.delete(key);
    }
  };
  const publishShutdownFailureOnce = async () => {
    if (shutdownFailurePublished) return true;
    const published = await failShutdownCancelledManagedSession(
      command,
      bridgeSessionId,
      runId,
      cwd,
      runner
    );
    shutdownFailurePublished = published;
    return published;
  };
  const cancelStartForShutdown = async () => {
    if (runner) {
      await abortUnconfirmedRunner(runner).catch((abortError) => {
        logAgentError('[agent] failed to stop shutdown-cancelled managed runner:', abortError.message);
      });
      removeRunnerIndexes();
    }
    try {
      await publishShutdownFailureOnce();
    } catch (error) {
      if (error?.shutdownTerminalDelivery) startCompletionError = error;
      throw error;
    }
    return bridgeSessionId;
  };
  try {
    startHandle = managedSessionStartGate.beginStart();
    runner = command.runId
      ? findRunnerForCommand(liveSessions, { runId: command.runId })
      : null;
    const replayedSessionId = await replayManagedSessionStart({
      liveSessions,
      command,
      hostId: HOST_ID,
      postEvent,
    });
    if (replayedSessionId) return replayedSessionId;
    runner = null;

    const createdAt = command.createdAt || nowIso();
    cwd = resolveManagedCwd(command.cwd || MANAGED_CWD);
    const runtime = resolveManagedRuntime(command, {
      defaultRuntime: MANAGED_RUNTIME,
      defaultCommand: MANAGED_COMMAND,
      defaultArgs: MANAGED_ARGS,
    });
    const bootstrap = buildResumeBootstrap(command);
    const title = command.label || command.cwd || bridgeSessionId;
    const apiConfig = normalizeApiConfig(command.apiConfig);
    const apiBinding = deriveRunBinding({
      apiBinding: command.apiBinding,
      apiConfig,
      env: process.env,
      codexHome: CODEX_HOME,
      expectedBinding: command.expectedBinding,
      allowUnavailable: true,
    });

    if (!fs.existsSync(cwd)) {
      const error = new Error(`workspace path does not exist: ${cwd}`);
      error.code = 'session_workspace_missing';
      error.failureState = 'failed:missing-workspace';
      throw error;
    }

    let cwdStats = null;
    try {
      cwdStats = fs.statSync(cwd);
    } catch (cause) {
      const error = new Error(`failed to inspect workspace path: ${cause.message}`);
      error.code = 'session_workspace_stat_failed';
      error.failureState = 'failed:workspace-stat-error';
      throw error;
    }

    if (!cwdStats.isDirectory()) {
      const error = new Error(`workspace path is not a directory: ${cwd}`);
      error.code = 'session_workspace_not_directory';
      error.failureState = 'failed:not-a-directory';
      throw error;
    }

    startHandle.assertCanSpawn();
    runner = await startManagedRuntimeSession({
      runtime,
      hostId: HOST_ID,
      sessionId: bridgeSessionId,
      bridgeSessionId,
      runId,
      title,
      cwd,
      launchMode: command.launchMode || null,
      nativeThreadId: command.nativeThreadId || null,
      rebindNativeThreadId: command.rebindNativeThreadId || null,
      explicitRebind: command.explicitRebind === true,
      codexHome: CODEX_HOME,
      apiConfig,
      apiBinding,
      bootstrap,
      originSessionId: command.originSessionId || null,
      sourceSessionId: command.sourceSessionId || null,
      conversationKey: command.conversationKey || command.originSessionId || bridgeSessionId,
      postEvent,
      onRunnerCreated: (createdRunner) => {
        runner = createdRunner;
        startHandle.setRunner(createdRunner);
      },
      onTerminated: () => {
        removeRunnerIndexes();
      },
    });
    startHandle.setRunner(runner);
    if (managedSessionStartGate.isShuttingDown()) {
      return await cancelStartForShutdown();
    }
    runner.createdAt = runner.createdAt || createdAt;
    announcedSessionId = runner.sessionId || bridgeSessionId;
    liveSessions.set(bridgeSessionId, runner);
    liveSessions.set(announcedSessionId, runner);
    liveSessions.set(runId, runner);

    if (managedSessionStartGate.isShuttingDown()) {
      return await cancelStartForShutdown();
    }

    await postEvent(buildManagedSessionStartedEvent({
      hostId: HOST_ID,
      runner,
      command: {
        ...command,
        sessionId: bridgeSessionId,
        runId,
        createdAt,
        label: title,
        cwd,
        apiBinding: runner.apiBinding || apiBinding || null,
      },
    }));
    if (managedSessionStartGate.isShuttingDown()) {
      return await cancelStartForShutdown();
    }
  } catch (error) {
    if (error?.shutdownTerminalDelivery) {
      startCompletionError = error;
      throw error;
    }
    if (error?.code === 'host_agent_shutting_down' || managedSessionStartGate.isShuttingDown()) {
      return await cancelStartForShutdown();
    }
    if (retainRunnerForStartRetry(liveSessions, runner, {
      ...command,
      sessionId: bridgeSessionId,
      bridgeSessionId,
      runId,
    }, error)) {
      throw error;
    }
    if (error?.retryCommand) throw error;
    if (runner) {
      await abortUnconfirmedRunner(runner).catch((abortError) => {
        logAgentError('[agent] failed to stop unconfirmed managed runner:', abortError.message);
      });
      removeRunnerIndexes();
    }
    await postSessionCommandFailure(command, error, 'start');
    await failManagedSession(
      bridgeSessionId,
      cwd,
      `failed to spawn managed session: ${error.message}`,
      error.failureState || 'failed:spawn-error',
      runId
    );
    return bridgeSessionId;
  } finally {
    startHandle?.finish(startCompletionError);
  }

  return announcedSessionId;
}

async function handleCommand(command) {
  if (!command || !command.type) {
    return;
  }

  if (command.type === 'host.shutdown') {
    hostAgentShutdownRetryPending = true;
    const result = await shutdownHostAgent('relay-command');
    if (result?.timedOut || result?.errors?.length) {
      const error = new Error(
        result.timedOut
          ? 'Host Agent shutdown timed out; command remains retryable.'
          : `Host Agent shutdown failed with ${result.errors.length} runner stop error(s).`
      );
      error.code = 'host_shutdown_incomplete';
      error.retryCommand = true;
      throw error;
    }
    hostAgentShutdownRetryPending = false;
    return;
  }

  if (command.type === 'session.start') {
    await startManagedSession(command);
    return;
  }

  if (command.type === 'host.import') {
    sendDiscovery().catch((error) => {
      logAgentError('[agent] discovery refresh failed:', error.message);
    });
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

  if (command.type === 'host.api_test') {
    const result = await testApiProfile(command.apiConfig, {
      timeoutMs: command.timeoutMs,
      cursor: command.cursor,
      limit: command.limit,
      includeLimit: command.includeLimit === true,
    });
    await postEvent({
      type: 'host.api_tested',
      hostId: HOST_ID,
      requestId: command.requestId || makeId(),
      result,
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'host.api_catalog') {
    const result = await testApiProfile(command.apiConfig, {
      timeoutMs: command.timeoutMs,
      cursor: command.cursor,
      limit: command.limit,
      includeLimit: true,
    });
    await postEvent({
      type: 'host.api_cataloged',
      hostId: HOST_ID,
      requestId: command.requestId || makeId(),
      bindingFingerprint: command.bindingFingerprint || null,
      runId: command.runId || null,
      result,
      timestamp: nowIso(),
    });
    return;
  }

  if (command.type === 'host.binding_preflight') {
    try {
      const result = attestHostEnvironmentBinding({
        env: process.env,
        expectedBinding: command.expectedBinding,
      });
      await postEvent({
        type: 'host.binding_preflighted',
        hostId: HOST_ID,
        requestId: command.requestId || makeId(),
        ok: true,
        binding: result.binding,
        timestamp: nowIso(),
      });
    } catch (error) {
      await postEvent({
        type: 'host.binding_preflighted',
        hostId: HOST_ID,
        requestId: command.requestId || makeId(),
        ok: false,
        code: error.code || 'session_api_binding_unavailable',
        error: error.message,
        canRebind: Boolean(error.canRebind),
        timestamp: nowIso(),
      });
    }
    return;
  }

  if (command.type === 'host.skills.inventory.refresh') {
    hostSkillInventory.addWorkspaceRoots(command.workspaceRoots || []);
    await hostSkillInventory.refresh({
      force: true,
      publishUnchanged: true,
      publishContext: { requestId: command.requestId || null },
    });
    return;
  }

  if (command.type === 'host.skills.artifact.export') {
    await handleHostSkillArtifactCommand(command);
    return;
  }

  if (command.type === 'host.skills.deployment.apply') {
    await handleHostSkillDeploymentCommand(command);
    return;
  }

  if (
    command.type === 'host.skills.list'
    || command.type === 'host.skills.install'
    || command.type === 'host.skills.uninstall'
  ) {
    await handleHostSkillsCommand(command);
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

  if (command.type === 'session.watch') {
    await handleSessionWatch(command);
    return;
  }

  if (command.type === 'session.unwatch') {
    await handleSessionUnwatch(command);
    return;
  }

  if (command.type === 'session.detail') {
    await handleSessionDetail(command);
    return;
  }

  if (command.type === 'session.search') {
    try {
      const result = await searchDiscoveredSessions(command);
      await postEvent({
        type: 'session.searched',
        hostId: HOST_ID,
        requestId: command.requestId || makeId(),
        query: result.query,
        mode: result.mode,
        results: result.results,
        scannedSessions: result.scannedSessions,
        truncated: result.truncated,
        timestamp: nowIso(),
      }, { retryOnTransient: true });
    } catch (error) {
      await postEvent({
        type: 'session.searched',
        hostId: HOST_ID,
        requestId: command.requestId || makeId(),
        query: command.query || '',
        mode: command.mode || 'keyword',
        error: error.message || 'session search failed',
        timestamp: nowIso(),
      }, { bestEffort: true });
    }
    return;
  }

  const runner = findRunnerForCommand(liveSessions, command);
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

    if (command.type === 'session.skills_list' && command.requestId) {
      await postEvent({
        type: 'session.skills_listed',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId,
        error: 'session is not live on this host-agent; resume or restart the session before listing skills',
        timestamp: nowIso(),
      });
      return;
    }

    if (command.type === 'session.goal' && command.requestId) {
      await postEvent({
        type: 'session.goal_result',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId,
        error: 'session is not live on this host-agent; resume or restart the session before using native Goal controls',
        timestamp: nowIso(),
      });
      return;
    }

    if (command.type === 'session.stop') {
      if (!shouldPublishMissingRunnerStop(command)) return;
      await postEvent({
        type: 'session.state_changed',
        hostId: HOST_ID,
        sessionId: command.requestedSessionId || command.sessionId,
        runId: command.runId || null,
        state: 'history-only',
        live: false,
        timestamp: nowIso(),
      });
      return;
    }

    if (command.type === 'session.input') {
      await postEvent({
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: command.requestedSessionId || command.sessionId,
        runId: command.runId || null,
        patch: {
          activeTurnId: null,
          busy: false,
          phase: 'error',
          currentTurnStatus: 'failed',
          queuedCommandId: null,
          pendingInputSummary: null,
          lastCodexError: 'session is not live on this host-agent; wait for the session to finish starting, then resend',
          runId: command.runId || null,
        },
        timestamp: nowIso(),
      }, { bestEffort: true });
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
      await postEvent({
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        runId: runner.runId || command.runId || null,
        patch: {
          busy: true,
          phase: 'submitting-turn',
          currentTurnStatus: 'submitting',
          queuedCommandId: command.id || null,
          pendingInputSummary: String(command.text || '').slice(0, 240),
          lastError: null,
          lastCodexError: null,
          runId: runner.runId || command.runId || null,
        },
        timestamp: nowIso(),
      }, { bestEffort: true });
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
        planFallback: command.planFallback || null,
        serviceTier: command.serviceTier || null,
        personality: command.personality || null,
        apiConfig: normalizeApiConfig(command.apiConfig),
        apiBinding: command.apiBinding || null,
      });
    } catch (error) {
      await postSessionCommandFailure(command, error, 'input', runner);
      await postEvent({
        type: 'session.runtime_updated',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        runId: runner.runId || command.runId || null,
        patch: {
          activeTurnId: null,
          busy: false,
          phase: 'error',
          currentTurnStatus: 'failed',
          pendingInputSummary: null,
          lastCodexError: error.message || String(error),
          runId: runner.runId || command.runId || null,
        },
        timestamp: nowIso(),
      }, { bestEffort: true });
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
          complete: !result?.nextCursor,
          truncated: false,
          bindingFingerprint: result?.bindingFingerprint || null,
          runId: result?.runId || runner.runId || null,
          timestamp: nowIso(),
        });
      } catch (error) {
        await postSessionCommandFailure(command, error, 'model_list', runner);
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

  if (command.type === 'session.skills_list') {
    if (typeof runner.listSkills === 'function') {
      try {
        const result = await runner.listSkills({
          cwd: command.cwd || null,
          forceReload: command.forceReload === true,
        });
        await postEvent({
          type: 'session.skills_listed',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          requestId: command.requestId || makeId(),
          data: Array.isArray(result?.data) ? result.data : [],
          timestamp: nowIso(),
        });
      } catch (error) {
        await postEvent({
          type: 'session.skills_listed',
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
          message: `Unable to list Codex skills: ${error.message}`,
          timestamp: nowIso(),
        });
      }
      return;
    }

    await postEvent({
      type: 'session.skills_listed',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      requestId: command.requestId || makeId(),
      error: 'This runner does not support skill listing.',
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
      try {
        await runner.compactThread({
          apiConfig: normalizeApiConfig(command.apiConfig),
          apiBinding: command.apiBinding || null,
        });
      } catch (error) {
        await postSessionCommandFailure(command, error, 'compact', runner);
        await postEvent({
          type: 'session.error',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          message: `Unable to compact Codex thread: ${error.message}`,
          timestamp: nowIso(),
        });
      }
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

  if (command.type === 'session.goal') {
    try {
      let result = null;
      const action = String(command.action || '').trim() || 'get';
      if (action === 'get') {
        if (typeof runner.getGoal !== 'function') {
          throw new Error('This runner does not support native Codex goals.');
        }
        result = await runner.getGoal();
      } else if (action === 'set') {
        if (typeof runner.setGoal !== 'function') {
          throw new Error('This runner does not support native Codex goals.');
        }
        result = await runner.setGoal({
          objective: command.objective,
          status: command.status,
          tokenBudget: command.tokenBudget,
        });
      } else if (action === 'clear') {
        if (typeof runner.clearGoal !== 'function') {
          throw new Error('This runner does not support native Codex goals.');
        }
        const clearResult = await runner.clearGoal();
        await postEvent({
          type: 'session.goal_result',
          hostId: HOST_ID,
          sessionId: command.sessionId,
          requestId: command.requestId || makeId(),
          goal: null,
          result: clearResult || { cleared: true },
          timestamp: nowIso(),
        });
        return;
      } else {
        throw new Error('Unknown goal action.');
      }

      await postEvent({
        type: 'session.goal_result',
        hostId: HOST_ID,
        sessionId: command.sessionId,
        requestId: command.requestId || makeId(),
        goal: result || null,
        result,
        timestamp: nowIso(),
      });
    } catch (error) {
      await postEvent({
        type: 'session.goal_result',
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
        message: `Unable to run native Codex goal action: ${error.message}`,
        timestamp: nowIso(),
      });
    }
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
    try {
      await stopRunnerOnce(runner, {
        suppressTerminalEvent: command.suppressTerminalEvent === true,
      });
    } catch (cause) {
      const stopError = cause instanceof Error
        ? cause
        : new Error(String(cause || 'Managed Session stop failed.'));
      stopError.retryCommand = true;
      stopError.code = stopError.code || 'session_stop_incomplete';
      throw stopError;
    }
    return;
  }
}

async function postCommandFailure(command, error) {
  const message = String(error?.message || error || `failed to handle ${command?.type || 'command'}`);
  logAgentError(`[agent] command ${command?.id || '(unknown)'} ${command?.type || '(unknown)'} failed:`, message);

  if (command?.type === 'session.model_list' && command.requestId) {
    await postEvent({
      type: 'session.model_listed',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      requestId: command.requestId,
      error: message,
      timestamp: nowIso(),
    }, { bestEffort: true });
    return;
  }

  if (command?.type === 'session.skills_list' && command.requestId) {
    await postEvent({
      type: 'session.skills_listed',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      requestId: command.requestId,
      error: message,
      timestamp: nowIso(),
    }, { bestEffort: true });
    return;
  }

  if (command?.sessionId) {
    await postEvent({
      type: 'session.error',
      hostId: HOST_ID,
      sessionId: command.sessionId,
      message: `Unable to handle ${command.type || 'command'}: ${message}`,
      timestamp: nowIso(),
    }, { bestEffort: true });
  }
}

async function processPolledCommand(command, expectedRelayInstanceId = '') {
  const commandId = Number(command?.id || 0);
  try {
    await handleCommand(command);
  } catch (error) {
    if (error?.retryCommand) return false;
    if (command?.type === 'host.skills.deployment.apply') {
      logAgentTransient('[agent] will retry deployment result delivery:', error);
      return false;
    }
    await postCommandFailure(command, error);
  }
  if (
    expectedRelayInstanceId
    && relayInstanceId
    && relayInstanceId !== expectedRelayInstanceId
  ) {
    // A response from the previous Relay epoch may contain commands that have
    // already been acknowledged or replaced. Do not advance the new cursor
    // with an old command id.
    lastCommandId = 0;
    return false;
  }
  lastCommandId = Math.max(lastCommandId, commandId);
  return true;
}

async function acknowledgeCommandsBeforeShutdown() {
  const throughId = Number(lastCommandId || 0);
  if (throughId <= 0) return true;
  const result = await fetchJson(
    `${RELAY_URL}/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${Number.MAX_SAFE_INTEGER}&ack=${throughId}&relayInstanceId=${encodeURIComponent(relayInstanceId || '')}`,
    {
      retryOnTransient: true,
      headers: managedAgentRequestHeaders(),
    }
  );
  if (observeRelayInstance(result.body)) {
    await ensureHostRegistration();
    return false;
  }
  return true;
}

async function pollCommandsLoop() {
  while (true) {
    if (managedSessionStartGate.isShuttingDown() && !hostAgentShutdownRetryPending) {
      return;
    }
    let requestLeaseId = '';
    try {
      const headers = managedAgentRequestHeaders();
      requestLeaseId = String(headers['X-Remote-Codex-Agent-Lease'] || '').trim();
      const result = await fetchJson(`${RELAY_URL}/api/agent/commands?hostId=${encodeURIComponent(HOST_ID)}&after=${lastCommandId}&ack=${lastCommandId}&relayInstanceId=${encodeURIComponent(relayInstanceId || '')}`, {
        retryOnTransient: true,
        headers,
      });
      if (observeRelayInstance(result.body)) {
        await ensureHostRegistration();
      }
      const batchRelayInstanceId = String(
        result.body?.relayInstanceId || relayInstanceId || ''
      ).trim();
      const commands = (Array.isArray(result.body && result.body.commands)
        ? result.body.commands
        : [])
        .slice()
        .sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0));
      for (const command of commands) {
        if (
          batchRelayInstanceId
          && relayInstanceId
          && relayInstanceId !== batchRelayInstanceId
        ) {
          lastCommandId = 0;
          await ensureHostRegistration();
          break;
        }
        if (
          command?.type === 'host.shutdown'
          && !(await acknowledgeCommandsBeforeShutdown())
        ) {
          break;
        }
        const processed = await processPolledCommand(command, batchRelayInstanceId);
        if (!processed) {
          break;
        }
        if (command?.type === 'host.shutdown') {
          return;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      try {
        if (await recoverAgentLeaseForRequest(error, requestLeaseId)) {
          continue;
        }
      } catch (recoveryError) {
        error = recoveryError;
      }
      if (isRelayHostDismissedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      if (isRelayOwnershipRevokedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      logAgentTransient('[agent] command poll failed:', error);
      await sleep(Math.max(POLL_INTERVAL_MS, 3000));
    }
  }
}

async function discoveryLoop() {
  while (true) {
    if (managedSessionStartGate.isShuttingDown()) {
      return;
    }
    try {
      await sendDiscovery();
      await sleep(DISCOVERY_INTERVAL_MS);
    } catch (error) {
      if (isRelayHostDismissedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      if (isRelayOwnershipRevokedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      logAgentTransient('[agent] discovery failed:', error);
      await sleep(Math.max(DISCOVERY_INTERVAL_MS, 3000));
    }
  }
}

async function codexTailLoop() {
  if (!codexTailer) {
    return;
  }

  while (true) {
    if (managedSessionStartGate.isShuttingDown()) {
      return;
    }
    try {
      const scope = refreshTailerWatchedSessions();
      const startedAt = Date.now();
      const result = await codexTailer.poll();
      const pollMs = Date.now() - startedAt;
      await maybeReportWatchPerformance(pollMs, result, scope);
      if (result.newSessionCount > 0) {
        await sendDiscovery();
      }
      await sleep(CODEX_TAIL_INTERVAL_MS);
    } catch (error) {
      if (isRelayHostDismissedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      if (isRelayOwnershipRevokedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      logAgentTransient('[agent] codex tail failed:', error);
      await sleep(Math.max(CODEX_TAIL_INTERVAL_MS, 3000));
    }
  }
}

async function heartbeatLoop() {
  while (true) {
    if (managedSessionStartGate.isShuttingDown() && !hostAgentShutdownRetryPending) {
      return;
    }
    const requestLeaseId = String(agentLeaseId || '').trim();
    try {
      pruneExpiredWatchedSessions();
      await heartbeat();
      await sleep(5000);
    } catch (error) {
      try {
        if (await recoverAgentLeaseForRequest(error, requestLeaseId)) {
          continue;
        }
      } catch (recoveryError) {
        error = recoveryError;
      }
      if (isRelayHostDismissedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      if (isRelayOwnershipRevokedError(error)) {
        await shutdownForRelayOwnershipLoss(error);
        return;
      }
      logAgentTransient('[agent] heartbeat failed:', error);
      await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStartupDiscovery() {
  await retryStartupStep('send initial discovery', sendDiscovery);
}

async function runStartupTailPrime() {
  if (!codexTailer) {
    return;
  }
  try {
    const result = codexTailer.prime();
    console.log(`[agent] codex tail primed ${result.sessionCount} session(s)`);
  } catch (error) {
    logAgentError('[agent] codex tail prime failed:', error.message);
  }
}

async function runStartupAutoStart() {
  if (!AUTO_START_SESSION) {
    return;
  }
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

async function main() {
  console.log(`[agent] host ${HOST_ID} connecting to ${RELAY_URL}`);
  console.log(`[agent] codex home ${CODEX_HOME}`);
  ensureManagedAgentOwnershipMarker();

  const overlayCleanup = CLEAN_LEGACY_MANAGED_OVERLAYS
    ? cleanupStaleApiProfileCodexHomes(CODEX_HOME, {
      // This opt-in is an operator attestation that all previous Agents and
      // app-servers using this CODEX_HOME have already stopped.
      legacyOverlayIsInactive: () => true,
    })
    : cleanupStaleApiProfileCodexHomes(CODEX_HOME);
  if (overlayCleanup.removed > 0) {
    logAgentNotice(`[agent] removed ${overlayCleanup.removed} stale managed Codex overlay(s)`);
  }
  for (const diagnostic of overlayCleanup.diagnostics || []) {
    logAgentNotice('[agent] managed Codex overlay janitor:', diagnostic.message);
  }
  for (const error of overlayCleanup.errors) {
    logAgentError('[agent] managed Codex overlay janitor:', error);
  }

  await retryStartupStep('register host', ensureHostRegistration, 12);
  const heartbeatTask = heartbeatLoop();
  hostSkillInventory.start();
  await runStartupDiscovery();

  const loops = [pollCommandsLoop(), heartbeatTask, discoveryLoop(), codexTailLoop()];
  void runStartupTailPrime();
  void runStartupAutoStart();

  await Promise.all(loops);
}

function stopHostSkillInventory() {
  if (hostSkillInventory) {
    hostSkillInventory.stop();
  }
}

const managedSessionShutdownStopOptions = {};
let hostAgentShutdownReason = null;
let hostAgentShutdownRetryPending = false;
let ownershipRevocationShutdownPromise = null;
const shutdownManagedSessions = createManagedSessionShutdown({
  liveSessions,
  startGate: managedSessionStartGate,
  stopInventory: stopHostSkillInventory,
  graceTimeoutMs: AGENT_SHUTDOWN_GRACE_MS,
  stopOptions: managedSessionShutdownStopOptions,
  log: (message) => logAgentError('[agent] shutdown:', message),
  exit: (code) => {
    if (hostAgentShutdownSuppressesTerminalEvents() || !agentLeaseId) {
      process.exit(code);
      return;
    }
    void releaseAgentLease().finally(() => process.exit(code));
  },
});

function hostAgentShutdownSuppressesTerminalEvents() {
  return hostAgentShutdownReason === 'ownership-revoked';
}

function shutdownHostAgent(reason = 'SIGTERM') {
  const requestedReason = String(reason || 'SIGTERM');
  if (!hostAgentShutdownReason) {
    hostAgentShutdownReason = requestedReason;
    if (hostAgentShutdownSuppressesTerminalEvents()) {
      managedSessionShutdownStopOptions.suppressTerminalEvent = true;
    }
  } else if (
    requestedReason === 'ownership-revoked'
    && !hostAgentShutdownSuppressesTerminalEvents()
  ) {
    hostAgentShutdownReason = 'ownership-revoked';
    managedSessionShutdownStopOptions.suppressTerminalEvent = true;
    shutdownManagedSessions.upgradeStopOptions({ suppressTerminalEvent: true })
      .then((result) => {
        if (result.errors.length) {
          logAgentError(`[agent] shutdown: suppression upgrade had ${result.errors.length} runner stop error(s).`);
        }
      })
      .catch((error) => {
        logAgentError('[agent] shutdown: failed to upgrade terminal suppression:', error.message);
      });
  }
  return shutdownManagedSessions(hostAgentShutdownReason);
}

function isCompletedHostAgentShutdown(result) {
  return Boolean(
    result
    && result.timedOut !== true
    && (!Array.isArray(result.errors) || result.errors.length === 0)
  );
}

function retryOwnershipRevokedShutdown() {
  if (ownershipRevocationShutdownPromise) {
    return ownershipRevocationShutdownPromise;
  }

  // A Relay-command shutdown keeps polling alive so that command can be
  // retried. Ownership loss is terminal for this instance, so it supersedes
  // that retry mode and lets the other Agent loops wind down.
  hostAgentShutdownRetryPending = false;
  const retry = async () => {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const result = await shutdownHostAgent('ownership-revoked');
        if (isCompletedHostAgentShutdown(result)) {
          return result;
        }
        const problem = result?.timedOut
          ? 'timed out'
          : `${Array.isArray(result?.errors) ? result.errors.length : 'unknown'} runner stop error(s)`;
        logAgentError(
          `[agent] ownership-revoked shutdown ${problem}; retrying in ${OWNERSHIP_REVOKED_SHUTDOWN_RETRY_MS}ms (attempt ${attempt})`
        );
      } catch (error) {
        logAgentError(
          `[agent] ownership-revoked shutdown failed: ${error?.message || error}; retrying in ${OWNERSHIP_REVOKED_SHUTDOWN_RETRY_MS}ms (attempt ${attempt})`
        );
      }
      await sleep(OWNERSHIP_REVOKED_SHUTDOWN_RETRY_MS);
    }
  };

  ownershipRevocationShutdownPromise = retry().finally(() => {
    ownershipRevocationShutdownPromise = null;
  });
  return ownershipRevocationShutdownPromise;
}

function shutdownForRelayOwnershipLoss(error) {
  if (isRelayHostDismissedError(error)) {
    logAgentNotice(`[agent] Host ${HOST_ID} was dismissed by the Relay; stopping this Agent instance`);
  } else {
    logAgentError(`[agent] Relay ownership was revoked (${error?.body?.code || 'unknown'}); stopping this Agent instance`);
  }
  return retryOwnershipRevokedShutdown();
}

function handleShutdownSignal(signal) {
  logAgentNotice(`[agent] received ${signal}; stopping`);
  return shutdownHostAgent(signal);
}

process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.once('exit', () => {
  stopHostSkillInventory();
  removeManagedAgentOwnershipMarker();
});

async function retryStartupStep(label, task, attempts = 8) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      lastError = error;
      if (isRelayHostDismissedError(error) || isRelayOwnershipRevokedError(error)) {
        throw error;
      }
      if (attempt >= attempts) {
        break;
      }
      const delay = isPreLeaseAgentInstanceConflict(error)
        ? Math.min(5000, Math.max(500, Number(error?.body?.retryAfterMs || 0) || 500))
        : Math.min(5000, 300 * attempt * attempt);
      logAgentError(`[agent] ${label} failed (${attempt}/${attempts}): ${error.message}`);
      await sleep(delay);
    }
  }
  throw lastError;
}

main().catch(async (error) => {
  if (isRelayHostDismissedError(error)) {
    await shutdownForRelayOwnershipLoss(error);
    return;
  }
  if (isRelayOwnershipRevokedError(error)) {
    await shutdownForRelayOwnershipLoss(error);
    return;
  }
  console.error('[agent] fatal:', error);
  process.exit(1);
});
