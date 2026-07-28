const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  recoverMissingFileFromBackup,
  replaceFileWithBackup,
} = require('./atomic-file-replace');
const {
  agentLogCommand,
  buildAgentLaunchCommand,
  buildDetachedBootstrapCommand,
  buildCodexBinResolutionCommand,
  buildRemoteStatusCommand,
  buildSshCommandParts,
  connectorControlFileName,
  connectorTmuxSessionName,
  connectorUsesGateway,
  decorateConnector,
  loadConnectors,
  normalizeConnectorRemoteDirectory,
  normalizeConnectorInput,
  requiresInteractiveAuth,
  saveConnectors,
  shellQuote,
} = require('../../shared/connectors');
const {
  linuxRuntimeNames,
  normalizeLinuxArchitecture,
} = require('../../shared/remote-runtime-platform');
const {
  getConnectorSecretStatus,
  loadConnectorSecrets,
  normalizeConnectorSecretsInput,
  saveConnectorSecrets,
} = require('../../shared/connector-secrets');
const {
  extractSessionDiagnostics,
  extractSessionTranscript,
  isInternalApprovalReviewSession,
  isSubagentSession,
  makeTranscriptEntry,
} = require('../../shared/codex-discovery');
const { makeId, nowIso, sessionKey } = require('../../shared/protocol');
const {
  applyStableTagUpdate,
  getLocalUpdateStatus,
  scheduleWindowsRestart,
} = require('../../shared/updater');
const { createSkillArtifactArchive } = require('../../shared/skill-artifact');
const { normalizePortableSkillId } = require('../../shared/skill-id');
const { parseSkillMarkdown } = require('../../shared/skill-inventory');
const { redactSecretText, stripSecrets } = require('../../shared/secret-redaction');
const {
  ActivitySnapshotStore,
  makeActivityRecoveryToken,
} = require('../../shared/activity-snapshot-store');
const {
  canonicalPhysicalPath,
  comparablePhysicalPath,
  physicalPathIsInside,
} = require('../../shared/physical-path');
const {
  OFFICIAL_OPENAI_BASE_URL,
  bindingFingerprint,
  bindingsEqual,
  makeProfileBinding,
  publicBinding,
} = require('../../shared/api-binding');
const { downloadGithubSkill, normalizeGithubSkillSource } = require('./github-skill-source');
const { AgentEventLedger } = require('./agent-event-ledger');
const { InputCommandOutbox } = require('./input-command-outbox');
const { HostAgentLeaseRegistry } = require('./host-agent-lease');
const { ModelCatalogError, ModelCatalogService } = require('./model-catalog-service');
const { RebindCatalogReuseStore } = require('./rebind-catalog-reuse');
const { normalizeApiConfig: normalizeRuntimeApiConfig } = require('../host-agent/runtime-utils');
const providerCapabilities = require('../mobile-web/public/provider-capabilities');
const {
  emptyNotificationState,
  ingestAssistantObservation,
  projectAssistantState,
} = require('./assistant-notification-ledger');
const { acquireRelayStateLock } = require('./relay-state-lock');
const { SessionEventStream } = require('./session-event-stream');
const { writeSseEvent } = require('./sse-writer');
const { SessionContractError, SessionProvenanceService } = require('./session-provenance-service');
const { SessionRecordStore } = require('./session-record-store');
const { SkillAuditLog } = require('./skill-audit-log');
const { SkillAutomationService } = require('./skill-automation-service');
const { SkillDeploymentService } = require('./skill-deployment-service');
const { SkillRegistryService } = require('./skill-registry-service');

const PORT = Number(process.env.PORT || 8787);
const RELAY_INSTANCE_ID = crypto.randomUUID();
const SESSION_EVENT_RING_SIZE = Math.max(
  1,
  Math.min(4096, Number(process.env.SESSION_EVENT_RING_SIZE || 512) || 512)
);
const SESSION_RESET_SSE_MAX_BYTES = Math.max(
  2048,
  Math.min(12 * 1024, Number(process.env.SESSION_RESET_SSE_MAX_BYTES || 8 * 1024) || 8 * 1024)
);
const SESSION_SSE_PAYLOAD_MAX_BYTES = Math.max(512, SESSION_RESET_SSE_MAX_BYTES - 512);
const PRIMARY_RELAY_PORT = 8797;
function enabledEnvironmentFlag(name, defaultValue) {
  const value = process.env[name];
  if (value == null || String(value).trim() === '') {
    return Boolean(defaultValue);
  }
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

const RUN_ID_REQUIRED_SESSION_EVENT_TYPES = new Set([
  'session.command_failed',
  'session.interrupt_result',
  'session.output',
  'session.runtime_updated',
  'session.selection_confirmed',
  'session.started',
  'session.state_changed',
]);
const EXPLICIT_RELAY_STATE_ROOT = String(process.env.RELAY_STATE_ROOT || '').trim();
if (PORT !== PRIMARY_RELAY_PORT && !EXPLICIT_RELAY_STATE_ROOT) {
  throw new Error(
    `Relay port ${PORT} requires an explicit RELAY_STATE_ROOT to avoid sharing primary state.`
  );
}
const RELAY_STATE_ROOT = canonicalPhysicalPath(
  EXPLICIT_RELAY_STATE_ROOT
  || path.join(process.cwd(), 'tmp')
);
// Runtime bundles are read-only inputs, so keep the downloader's legacy cache
// available without treating it as a Relay state location.
const LEGACY_RUNTIME_CACHE_ROOT = path.resolve(process.cwd(), 'tmp');
const PUBLIC_DIR = path.join(__dirname, '..', 'mobile-web', 'public');

function relayOwnedStatePath(name, value) {
  const resolved = canonicalPhysicalPath(value);
  if (!physicalPathIsInside(RELAY_STATE_ROOT, resolved)) {
    throw new Error(`${name} must resolve within RELAY_STATE_ROOT: ${RELAY_STATE_ROOT}`);
  }
  return resolved;
}

const SESSION_COLLECTIONS_PATH = relayOwnedStatePath('SESSION_COLLECTIONS_PATH', process.env.SESSION_COLLECTIONS_PATH || path.join(RELAY_STATE_ROOT, 'session-collections.json'));
const SESSION_METADATA_PATH = relayOwnedStatePath('SESSION_METADATA_PATH', process.env.SESSION_METADATA_PATH || path.join(RELAY_STATE_ROOT, 'session-metadata.json'));
const SESSION_RECORD_STORE_ROOT = relayOwnedStatePath('SESSION_RECORD_STORE_ROOT', process.env.SESSION_RECORD_STORE_ROOT || path.join(RELAY_STATE_ROOT, 'session-record-store'));
if (comparablePhysicalPath(SESSION_RECORD_STORE_ROOT) === comparablePhysicalPath(RELAY_STATE_ROOT)) {
  throw new Error('SESSION_RECORD_STORE_ROOT must be a child directory of RELAY_STATE_ROOT.');
}
const SESSION_LOGS_PATH = relayOwnedStatePath('SESSION_LOGS_PATH', process.env.SESSION_LOGS_PATH || path.join(RELAY_STATE_ROOT, 'session-logs.json'));
const SESSION_DIAGNOSTICS_PATH = relayOwnedStatePath('SESSION_DIAGNOSTICS_PATH', process.env.SESSION_DIAGNOSTICS_PATH || path.join(RELAY_STATE_ROOT, 'session-diagnostics.json'));
const DISMISSED_HOSTS_PATH = relayOwnedStatePath('DISMISSED_HOSTS_PATH', process.env.DISMISSED_HOSTS_PATH || path.join(RELAY_STATE_ROOT, 'dismissed-hosts.json'));
const CODEX_UPDATE_OPERATIONS_PATH = relayOwnedStatePath('CODEX_UPDATE_OPERATIONS_PATH', process.env.CODEX_UPDATE_OPERATIONS_PATH || path.join(RELAY_STATE_ROOT, 'codex-update-operations.json'));
const AGENT_EVENT_LEDGER_PATH = relayOwnedStatePath('AGENT_EVENT_LEDGER_PATH', process.env.AGENT_EVENT_LEDGER_PATH || path.join(RELAY_STATE_ROOT, 'agent-event-ledger.jsonl'));
const INPUT_COMMAND_OUTBOX_PATH = relayOwnedStatePath('INPUT_COMMAND_OUTBOX_PATH', process.env.INPUT_COMMAND_OUTBOX_PATH || path.join(RELAY_STATE_ROOT, 'input-command-outbox.jsonl'));
const CONNECTORS_PATH = relayOwnedStatePath('CONNECTORS_PATH', process.env.CONNECTORS_PATH || path.join(RELAY_STATE_ROOT, 'connectors.json'));
const CONNECTOR_SECRETS_PATH = relayOwnedStatePath('CONNECTOR_SECRETS_PATH', process.env.CONNECTOR_SECRETS_PATH || path.join(RELAY_STATE_ROOT, 'connector-secrets.json'));
const SKILL_FAVORITES_PATH = relayOwnedStatePath('SKILL_FAVORITES_PATH', process.env.SKILL_FAVORITES_PATH || path.join(RELAY_STATE_ROOT, 'skill-favorites.json'));
const SKILL_SOURCES_PATH = relayOwnedStatePath('SKILL_SOURCES_PATH', process.env.SKILL_SOURCES_PATH || path.join(RELAY_STATE_ROOT, 'skill-sources.json'));
const SKILL_LIBRARY_PATH = relayOwnedStatePath('SKILL_LIBRARY_PATH', process.env.SKILL_LIBRARY_PATH || path.join(RELAY_STATE_ROOT, 'skill-library.json'));
const SKILL_INVENTORIES_PATH = relayOwnedStatePath('SKILL_INVENTORIES_PATH', process.env.SKILL_INVENTORIES_PATH || path.join(RELAY_STATE_ROOT, 'skill-inventories.json'));
const SKILL_REGISTRY_PATH = relayOwnedStatePath('SKILL_REGISTRY_PATH', process.env.SKILL_REGISTRY_PATH || path.join(RELAY_STATE_ROOT, 'skill-registry.json'));
const SKILL_ARTIFACT_ROOT = relayOwnedStatePath('SKILL_ARTIFACT_ROOT', process.env.SKILL_ARTIFACT_ROOT || path.join(RELAY_STATE_ROOT, 'skill-artifacts'));
const SKILL_DEPLOYMENTS_PATH = relayOwnedStatePath('SKILL_DEPLOYMENTS_PATH', process.env.SKILL_DEPLOYMENTS_PATH || path.join(RELAY_STATE_ROOT, 'skill-deployments.json'));
const SKILL_AUDIT_PATH = relayOwnedStatePath('SKILL_AUDIT_PATH', process.env.SKILL_AUDIT_PATH || path.join(RELAY_STATE_ROOT, 'skill-audit.jsonl'));
const SSH_KNOWN_HOSTS_PATH = relayOwnedStatePath('SSH_KNOWN_HOSTS_PATH', process.env.SSH_KNOWN_HOSTS_PATH || path.join(RELAY_STATE_ROOT, 'ssh', 'known_hosts'));
const RUNTIME_STAGE_ROOT = path.join(RELAY_STATE_ROOT, 'runtime-stage');
const SKILL_GITHUB_API_BASE_URL = process.env.SKILL_GITHUB_API_BASE_URL || 'https://api.github.com';
const SKILL_GITHUB_TOKEN = process.env.REMOTE_CODEX_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
const RECEIVED_FILES_ROOT = path.join(RELAY_STATE_ROOT, 'received-files');
const RECEIVED_FILES_MANIFEST_PATH = path.join(RECEIVED_FILES_ROOT, 'manifest.json');
const LOCAL_AGENT_LOG_ROOT = path.join(RELAY_STATE_ROOT, 'local-agents');
const LOCAL_AGENT_ENTRYPOINT = path.resolve(__dirname, '..', 'host-agent', 'agent.js');
const LOCAL_AGENT_IDENTITY_ENTRYPOINT = truthyEnv(process.env.RELAY_TEST_CONTROL_ENABLED)
  && String(process.env.RELAY_TEST_LOCAL_AGENT_IDENTITY_ENTRYPOINT || '').trim()
  ? path.resolve(process.env.RELAY_TEST_LOCAL_AGENT_IDENTITY_ENTRYPOINT)
  : LOCAL_AGENT_ENTRYPOINT;
const LOCAL_AGENT_PROCESS_START_TOLERANCE_MS = 5000;
const LOCAL_AGENT_PROCESS_IDENTITY_CACHE_MS = 5000;
const LOCAL_AGENT_PROCESS_IDENTITY_CACHE_LIMIT = 128;
const RELAY_OWNER_PATH = path.join(RELAY_STATE_ROOT, 'relay-owner.json');
const RELAY_REPO_ROOT = canonicalPhysicalPath(path.join(__dirname, '..', '..'));
const RELAY_AUTH_TOKEN_PATH = relayOwnedStatePath('RELAY_AUTH_TOKEN_PATH', process.env.RELAY_AUTH_TOKEN_PATH || path.join(RELAY_STATE_ROOT, 'relay-auth-token.txt'));
const RELAY_AUTH_ACCOUNT_PATH = relayOwnedStatePath('RELAY_AUTH_ACCOUNT_PATH', process.env.RELAY_AUTH_ACCOUNT_PATH || path.join(RELAY_STATE_ROOT, 'relay-auth-account.json'));
const RELAY_CONTROL_TOKEN_PATH = relayOwnedStatePath('RELAY_CONTROL_TOKEN_PATH', process.env.RELAY_CONTROL_TOKEN_PATH || path.join(RELAY_STATE_ROOT, 'relay-control-token.txt'));
const RELAY_AUTH_COOKIE_NAME = PORT === PRIMARY_RELAY_PORT
  ? 'remote_codex_auth'
  : `remote_codex_auth_${PORT}`;
const DEFAULT_COLLECTION_ID = 'default';
const TRASH_COLLECTION_ID = 'trash';
const ASKPASS_MAX_PROMPTS_PER_ACTION = 8;
const MAX_JSON_BODY_BYTES = Number(process.env.RELAY_MAX_JSON_BODY_BYTES || 192 * 1024 * 1024);
const MAX_AGENT_EVENT_BODY_BYTES = Math.max(
  1024 * 1024,
  Math.min(
    MAX_JSON_BODY_BYTES,
    Number(process.env.RELAY_MAX_AGENT_EVENT_BODY_BYTES || 8 * 1024 * 1024) || 8 * 1024 * 1024
  )
);
const MAX_FILE_TRANSFER_BYTES = Number(process.env.RELAY_MAX_FILE_TRANSFER_BYTES || 128 * 1024 * 1024);
const MAX_CHUNKED_FILE_TRANSFER_BYTES = Number(process.env.RELAY_MAX_CHUNKED_FILE_TRANSFER_BYTES || 2 * 1024 * 1024 * 1024);
const SKILL_ARTIFACT_MAX_UPLOAD_BYTES = Math.max(
  1,
  Math.trunc(Number(process.env.SKILL_ARTIFACT_MAX_UPLOAD_BYTES || 272 * 1024 * 1024)) || 272 * 1024 * 1024
);
const SKILL_MAX_ACTIVE_ADOPTIONS = Math.max(
  1,
  Math.min(1000, Math.trunc(Number(process.env.SKILL_MAX_ACTIVE_ADOPTIONS || 100)) || 100)
);
const SKILL_GITHUB_MAX_CONCURRENT_IMPORTS = Math.max(
  1,
  Math.min(16, Math.trunc(Number(process.env.SKILL_GITHUB_MAX_CONCURRENT_IMPORTS || 2)) || 2)
);
const SKILL_OPERATION_HISTORY_LIMIT = Math.max(
  100,
  Math.min(10000, Math.trunc(Number(process.env.SKILL_OPERATION_HISTORY_LIMIT || 1000)) || 1000)
);
const SKILL_DEPLOYMENT_SUMMARY_LIMIT = 100;
const SKILL_DEPLOYMENT_HISTORY_LIMIT = Math.max(
  1,
  Math.min(
    10000,
    Math.trunc(Number(process.env.SKILL_DEPLOYMENT_HISTORY_LIMIT || SKILL_OPERATION_HISTORY_LIMIT))
      || SKILL_OPERATION_HISTORY_LIMIT
  )
);
const SKILL_AUTOMATION_TICK_MS = Math.max(
  1000,
  Number(process.env.SKILL_AUTOMATION_TICK_MS || 5 * 60 * 1000) || 5 * 60 * 1000
);
// Download payloads travel back inside JSON agent events and grow by roughly
// 4/3 when base64-encoded. Keep both a single chunk and the non-chunked path
// below the agent-event request limit with room for the event envelope.
const AGENT_EVENT_BINARY_PAYLOAD_BYTES = Math.max(
  256 * 1024,
  Math.floor(Math.max(0, MAX_AGENT_EVENT_BODY_BYTES - 512 * 1024) * 3 / 4)
);
const FILE_TRANSFER_CHUNK_BYTES = Math.max(
  64 * 1024,
  Math.min(
    Number(process.env.RELAY_FILE_TRANSFER_CHUNK_BYTES || 4 * 1024 * 1024) || 4 * 1024 * 1024,
    AGENT_EVENT_BINARY_PAYLOAD_BYTES
  )
);
const CHUNKED_FILE_TRANSFER_THRESHOLD_BYTES = Math.max(
  1,
  Math.min(
    Number(process.env.RELAY_CHUNKED_FILE_TRANSFER_THRESHOLD_BYTES || 16 * 1024 * 1024) || 16 * 1024 * 1024,
    AGENT_EVENT_BINARY_PAYLOAD_BYTES
  )
);
const CHUNKED_FILE_CACHE_MAX_BYTES = Number(process.env.RELAY_CHUNKED_FILE_CACHE_MAX_BYTES || MAX_FILE_TRANSFER_BYTES);
const RECEIVED_FILE_TTL_MS = Number(process.env.RELAY_RECEIVED_FILE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const SESSION_LOG_ENTRY_LIMIT = Number(process.env.RELAY_SESSION_LOG_ENTRY_LIMIT || 1000);
const SESSION_DIAGNOSTIC_ENTRY_LIMIT = Number(process.env.RELAY_SESSION_DIAGNOSTIC_ENTRY_LIMIT || 10000);
const SESSION_DETAIL_DIAGNOSTIC_LIMIT = Number(process.env.RELAY_SESSION_DETAIL_DIAGNOSTIC_LIMIT || 400);
const PERSIST_DEBOUNCE_MS = Number(process.env.RELAY_PERSIST_DEBOUNCE_MS || 500);
const SESSION_LIST_PREVIEW_LIMIT = Number(process.env.RELAY_SESSION_LIST_PREVIEW_LIMIT || 3);
const SESSION_LIST_TEXT_LIMIT = Number(process.env.RELAY_SESSION_LIST_TEXT_LIMIT || 1200);
const SESSION_LIST_LATEST_TEXT_LIMIT = Number(process.env.RELAY_SESSION_LIST_LATEST_TEXT_LIMIT || 1000);
const RESUME_TRANSCRIPT_MAX_ENTRIES = Number(process.env.RELAY_RESUME_TRANSCRIPT_MAX_ENTRIES || 1000);
const RESUME_TRANSCRIPT_MAX_ENTRY_CHARS = Number(process.env.RELAY_RESUME_TRANSCRIPT_MAX_ENTRY_CHARS || 12000);
const RESUME_TRANSCRIPT_MAX_TOTAL_CHARS = Number(process.env.RELAY_RESUME_TRANSCRIPT_MAX_TOTAL_CHARS || 240000);
const STALE_MANAGED_SESSION_GRACE_MS = Number(process.env.RELAY_STALE_MANAGED_SESSION_GRACE_MS || 2 * 60 * 1000);
const MISSING_MANAGED_DISCOVERY_CONFIRMATION_MS = Math.max(
  0,
  Number(process.env.RELAY_MISSING_MANAGED_DISCOVERY_CONFIRMATION_MS || 5000) || 5000
);
const TEST_MANAGED_DISCOVERY_CLOSE_DELAY_MS = truthyEnv(process.env.RELAY_TEST_CONTROL_ENABLED)
  ? Math.max(0, Number(process.env.RELAY_TEST_MANAGED_DISCOVERY_CLOSE_DELAY_MS || 0) || 0)
  : 0;
const TEST_INPUT_PREPARE_DELAY_MS = truthyEnv(process.env.RELAY_TEST_CONTROL_ENABLED)
  ? Math.max(0, Number(process.env.RELAY_TEST_INPUT_PREPARE_DELAY_MS || 0) || 0)
  : 0;
const SESSION_STOP_FALLBACK_MS = Number(process.env.RELAY_SESSION_STOP_FALLBACK_MS || 15000);
const INPUT_REQUEST_DEDUPE_TTL_MS = Number(process.env.RELAY_INPUT_REQUEST_DEDUPE_TTL_MS || 2 * 60 * 1000);
const INPUT_REQUEST_DEDUPE_LIMIT = Number(process.env.RELAY_INPUT_REQUEST_DEDUPE_LIMIT || 500);
const AGENT_EVENT_BATCH_DEDUPE_LIMIT = Math.max(1, Number(process.env.RELAY_AGENT_EVENT_BATCH_DEDUPE_LIMIT || 10000) || 10000);
// A read-only Rebind preflight may prove the target provider catalog shortly
// before the mutating Rebind request. Keep that proof in memory briefly so the
// final request can re-check the Session expectation without fetching the same
// provider catalog a second time.
const REBIND_CATALOG_REUSE_TTL_MS = Math.max(
  5_000,
  Number(process.env.RELAY_REBIND_CATALOG_REUSE_TTL_MS || 2 * 60 * 1000) || 2 * 60 * 1000
);
const REBIND_CATALOG_REUSE_LIMIT = Math.max(
  32,
  Number(process.env.RELAY_REBIND_CATALOG_REUSE_LIMIT || 512) || 512
);
const HOST_OFFLINE_AFTER_MS = Math.max(
  50,
  Number(process.env.RELAY_HOST_OFFLINE_AFTER_MS || 30_000) || 30_000
);
const HOST_AGENT_LEASE_TTL_MS = Math.max(
  HOST_OFFLINE_AFTER_MS,
  Number(process.env.RELAY_HOST_AGENT_LEASE_TTL_MS || HOST_OFFLINE_AFTER_MS) || HOST_OFFLINE_AFTER_MS
);
const LOCAL_AGENT_WATCHDOG_ENABLED = enabledEnvironmentFlag(
  'RELAY_LOCAL_AGENT_WATCHDOG_ENABLED',
  PORT === PRIMARY_RELAY_PORT
);
const LOCAL_AGENT_START_ENABLED = enabledEnvironmentFlag(
  'RELAY_LOCAL_AGENT_START_ENABLED',
  PORT === PRIMARY_RELAY_PORT
);
if (PORT !== PRIMARY_RELAY_PORT && LOCAL_AGENT_START_ENABLED) {
  if (!String(process.env.RELAY_LOCAL_HOST_ID || '').trim()) {
    throw new Error('Non-primary Relay local Agent opt-in requires RELAY_LOCAL_HOST_ID.');
  }
  for (const name of [
    'LOCAL_CODEX_HOME',
    'REMOTE_CODEX_STATE_ROOT',
    'AGENTS_HOME',
    'CC_SWITCH_HOME',
    'SKILL_ARTIFACT_TEMP_ROOT',
  ]) {
    const value = String(process.env[name] || '').trim();
    if (!value) {
      throw new Error(`Non-primary Relay local Agent opt-in requires ${name}.`);
    }
    if (!physicalPathIsInside(RELAY_STATE_ROOT, value)) {
      throw new Error(`${name} must resolve within RELAY_STATE_ROOT for a non-primary local Agent.`);
    }
  }
}
const LOCAL_AGENT_WATCHDOG_INTERVAL_MS = Number(process.env.RELAY_LOCAL_AGENT_WATCHDOG_INTERVAL_MS || 5000);
const HOST_SESSION_DISCOVERY_REQUEST_COOLDOWN_MS = Math.max(
  20000,
  Number(process.env.RELAY_HOST_SESSION_DISCOVERY_REQUEST_COOLDOWN_MS || 60000) || 60000
);
const LOCAL_AGENT_OFFLINE_RESTART_MS = Number(process.env.RELAY_LOCAL_AGENT_OFFLINE_RESTART_MS || 45000);
const LOCAL_AGENT_STARTUP_GRACE_MS = Number(process.env.RELAY_LOCAL_AGENT_STARTUP_GRACE_MS || 5 * 60 * 1000);
const LOCAL_AGENT_RESTART_COOLDOWN_MS = Number(process.env.RELAY_LOCAL_AGENT_RESTART_COOLDOWN_MS || 10000);
const LOCAL_AGENT_EXIT_RESTART_DELAY_MS = Number(process.env.RELAY_LOCAL_AGENT_EXIT_RESTART_DELAY_MS || 2000);
const LOCAL_AGENT_SHUTDOWN_GRACE_MS = Math.max(
  1000,
  Number(process.env.RELAY_LOCAL_AGENT_SHUTDOWN_GRACE_MS || 12000) || 12000
);
const LOCAL_AGENT_EXIT_POLL_MS = Math.max(
  50,
  Number(process.env.RELAY_LOCAL_AGENT_EXIT_POLL_MS || 100) || 100
);
const LOCAL_AGENT_FORCE_EXIT_WAIT_MS = Math.max(
  1000,
  Number(process.env.RELAY_LOCAL_AGENT_FORCE_EXIT_WAIT_MS || 5000) || 5000
);
const COMMAND_QUEUE_TTL_MS = Number(process.env.RELAY_COMMAND_QUEUE_TTL_MS || 10 * 60 * 1000);
const COMMAND_QUEUE_MAX_LENGTH = Number(process.env.RELAY_COMMAND_QUEUE_MAX_LENGTH || 1000);
const HOST_CODEX_UPDATE_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.HOST_CODEX_UPDATE_TIMEOUT_MS || 12 * 60 * 1000) || 12 * 60 * 1000
);
const ACTIVE_CODEX_UPDATE_STATUSES = new Set([
  'planned',
  'stopping_sessions',
  'updating',
  'checking',
  'installing',
  'verifying',
  'updated',
  'update_failed',
  'resuming',
  'interrupted',
]);
const SKILL_ADOPTION_RETENTION_MS = Number(process.env.SKILL_ADOPTION_RETENTION_MS || 60 * 60 * 1000);
const COMMAND_PRIORITY = Object.freeze({
  high: 0,
  normal: 10,
});
const HIGH_PRIORITY_COMMAND_TYPES = new Set([
  'session.start',
  'host.file_upload',
  'host.file_upload_begin',
  'host.file_upload_chunk',
  'host.file_upload_complete',
  'host.file_upload_abort',
  'host.file_download',
  'host.file_download_info',
  'host.file_download_chunk',
  'session.watch',
  'session.unwatch',
  'session.input',
  'session.interrupt',
  'session.steer',
  'session.request.respond',
]);
let RELAY_AUTH_TOKEN = '';
let RELAY_CONTROL_TOKEN = '';
let relayAuthAccount = null;
let localAgentWatchdogTimer = null;
let relayShutdownPromise = null;
let relayShutdownContext = null;
let relayStateLock = null;
let relayReady = false;
let relayStopping = false;
let relayOwnerMarkerWritten = false;
const relayBackgroundTasks = new Set();
const stopFallbackTimers = new Set();

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeApiConfig(input = {}) {
  try {
    return normalizeRuntimeApiConfig(input);
  } catch (error) {
    throw new SessionContractError(
      error.code || 'session_api_binding_unavailable',
      error.message || 'The submitted API profile is invalid.',
      { statusCode: Number(error.statusCode || 422), canRebind: true }
    );
  }
}

function modelCatalogProviderKind(apiConfig, binding) {
  if (apiConfig) {
    return providerCapabilities.inferProviderKind(apiConfig);
  }
  if (binding?.providerKind) {
    return providerCapabilities.inferProviderKind({ providerKind: binding.providerKind });
  }
  const providerHint = String(binding?.modelProviderHint || '').trim();
  return providerCapabilities.inferProviderKind(providerHint || binding?.provider || '');
}

function modelCatalogInputPolicy(apiConfig, binding) {
  const providerKind = modelCatalogProviderKind(apiConfig, binding);
  const resolvedBinding = apiConfig ? makeProfileBinding(apiConfig) : publicBinding(binding);
  const normalizedBaseUrl = String(resolvedBinding?.normalizedBaseUrl || '').trim();
  const nonOfficialCompatibleEndpoint = resolvedBinding?.kind === 'profile'
    && Boolean(normalizedBaseUrl)
    && (providerKind !== 'openai' || normalizedBaseUrl !== OFFICIAL_OPENAI_BASE_URL);
  return {
    providerKind,
    allowProviderModelsWithoutLive: providerKind === 'custom' || nonOfficialCompatibleEndpoint,
  };
}

function summarizeApiConfig(apiConfig) {
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return null;
  }
  const binding = makeProfileBinding(config);
  return {
    profileId: config.profileId || null,
    label: config.label || config.provider || 'API profile',
    provider: config.provider || null,
    baseUrl: binding.normalizedBaseUrl || null,
  };
}

function rebindCatalogApiConfigFingerprint(apiConfig) {
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return null;
  }
  // Do not expose or persist credentials. The digest still distinguishes a
  // rotated API key, which must not reuse a catalog fetched with the old key.
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: config.provider || null,
    providerKind: config.providerKind || null,
    profileId: config.profileId || null,
    baseUrl: config.baseUrl || null,
    apiKey: config.apiKey || null,
  })).digest('hex');
}

function rebindCatalogSelectionFingerprint(selection = {}, allowUnverifiedEffort = false) {
  return JSON.stringify({
    model: String(selection?.model || '').trim() || null,
    effort: String(selection?.effort || '').trim().toLowerCase() || null,
    allowUnverifiedEffort: allowUnverifiedEffort === true,
  });
}

function loadRelayAuthToken() {
  if (truthyEnv(process.env.RELAY_AUTH_DISABLED)) {
    return '';
  }

  const envToken = String(process.env.RELAY_AUTH_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }

  try {
    const saved = fs.readFileSync(RELAY_AUTH_TOKEN_PATH, 'utf8').trim();
    if (saved) {
      return saved;
    }
  } catch (_) {
    // Missing token file is expected on first run.
  }

  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(RELAY_AUTH_TOKEN_PATH), { recursive: true });
  try {
    fs.writeFileSync(RELAY_AUTH_TOKEN_PATH, `${token}\n`, { encoding: 'utf8', flag: 'wx' });
    return token;
  } catch (_) {
    const saved = fs.readFileSync(RELAY_AUTH_TOKEN_PATH, 'utf8').trim();
    return saved || token;
  }
}

function loadRelayControlToken() {
  try {
    const saved = fs.readFileSync(RELAY_CONTROL_TOKEN_PATH, 'utf8').trim();
    if (saved) {
      return saved;
    }
  } catch (_) {
    // Missing control token is expected on first start.
  }

  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(RELAY_CONTROL_TOKEN_PATH), { recursive: true });
  try {
    fs.writeFileSync(RELAY_CONTROL_TOKEN_PATH, `${token}\n`, { encoding: 'utf8', flag: 'wx' });
    return token;
  } catch (_) {
    const saved = fs.readFileSync(RELAY_CONTROL_TOKEN_PATH, 'utf8').trim();
    if (!saved) {
      throw new Error('Relay control token file is empty.');
    }
    return saved;
  }
}

function writeRelayOwnerMarker() {
  const marker = {
    kind: 'remote-codex-relay-owner',
    version: 1,
    instanceId: RELAY_INSTANCE_ID,
    pid: process.pid,
    port: PORT,
    repoRoot: RELAY_REPO_ROOT,
    stateRoot: RELAY_STATE_ROOT,
    startedAt: nowIso(),
  };
  fs.mkdirSync(path.dirname(RELAY_OWNER_PATH), { recursive: true });
  const tempPath = `${RELAY_OWNER_PATH}.${process.pid}.${RELAY_INSTANCE_ID}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.renameSync(tempPath, RELAY_OWNER_PATH);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
        throw error;
      }
      fs.unlinkSync(RELAY_OWNER_PATH);
      fs.renameSync(tempPath, RELAY_OWNER_PATH);
    }
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function removeRelayOwnerMarker() {
  let marker;
  try {
    marker = JSON.parse(await fs.promises.readFile(RELAY_OWNER_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (
    marker?.kind !== 'remote-codex-relay-owner'
    || marker.instanceId !== RELAY_INSTANCE_ID
    || Number(marker.pid) !== process.pid
  ) {
    throw new Error('Relay ownership marker changed before cleanup.');
  }
  await fs.promises.unlink(RELAY_OWNER_PATH);
}

function loadRelayAuthAccount() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RELAY_AUTH_ACCOUNT_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.username || !parsed.passwordHash) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveRelayAuthAccount(account) {
  fs.mkdirSync(path.dirname(RELAY_AUTH_ACCOUNT_PATH), { recursive: true });
  relayAuthAccount = {
    version: 1,
    username: account.username,
    passwordHash: account.passwordHash,
    createdAt: account.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  fs.writeFileSync(RELAY_AUTH_ACCOUNT_PATH, JSON.stringify(relayAuthAccount, null, 2), 'utf8');
  return relayAuthAccount;
}

function normalizeAuthUsername(value) {
  return String(value || '').trim().slice(0, 64);
}

function validateAuthUsername(username) {
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) {
    throw new Error('username must be 2-64 characters: letters, numbers, dot, underscore, dash, or @');
  }
}

function validateAuthPassword(password) {
  const text = String(password || '');
  if (text.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  if (text.length > 256) {
    throw new Error('password is too long');
  }
}

function hashAuthPassword(password) {
  validateAuthPassword(password);
  const salt = crypto.randomBytes(16);
  const params = {
    N: 16384,
    r: 8,
    p: 1,
    keyLength: 64,
  };
  const key = crypto.scryptSync(String(password), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    algorithm: 'scrypt',
    params,
    salt: salt.toString('base64'),
    hash: key.toString('base64'),
  };
}

function verifyAuthPassword(password, account = relayAuthAccount) {
  if (!account?.passwordHash || account.passwordHash.algorithm !== 'scrypt') {
    return false;
  }
  try {
    const params = account.passwordHash.params || {};
    const keyLength = Number(params.keyLength || 64);
    const expected = Buffer.from(String(account.passwordHash.hash || ''), 'base64');
    if (!expected.length || expected.length !== keyLength) {
      return false;
    }
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(String(account.passwordHash.salt || ''), 'base64'), keyLength, {
      N: Number(params.N || 16384),
      r: Number(params.r || 8),
      p: Number(params.p || 1),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createRelayAuthAccount(username, password) {
  const normalizedUsername = normalizeAuthUsername(username || 'admin');
  validateAuthUsername(normalizedUsername);
  return saveRelayAuthAccount({
    username: normalizedUsername,
    passwordHash: hashAuthPassword(password),
  });
}

function normalizeTrashSourceList(input = []) {
  const seen = new Set();
  const sources = [];
  for (const entry of Array.isArray(input) ? input : []) {
    const collectionId = String(entry?.collectionId || '').trim();
    if (!collectionId || collectionId === DEFAULT_COLLECTION_ID || collectionId === TRASH_COLLECTION_ID || seen.has(collectionId)) {
      continue;
    }
    seen.add(collectionId);
    sources.push({
      collectionId,
      name: String(entry?.name || '').trim() || 'Collection',
    });
  }
  return sources;
}

function normalizeSessionCollectionItem(input = {}) {
  const hostId = String(input.hostId || '').trim();
  const conversationKey = String(input.conversationKey || input.originSessionId || input.sessionId || '').trim();
  const sessionId = String(input.sessionId || '').trim();
  if (!hostId || !conversationKey) {
    return null;
  }

  const item = {
    hostId,
    conversationKey,
    sessionId,
    title: String(input.title || '').trim(),
    cwd: String(input.cwd || '').trim(),
    hostLabel: String(input.hostLabel || '').trim(),
    hostPlatform: String(input.hostPlatform || '').trim(),
    targetHost: String(input.targetHost || '').trim(),
    targetPort: Number(input.targetPort || 0) || null,
    connectorId: String(input.connectorId || '').trim(),
    connectorLabel: String(input.connectorLabel || '').trim(),
    relayUrl: String(input.relayUrl || '').trim(),
    addedAt: input.addedAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
  };
  if (input.trashedAt) {
    item.trashedAt = String(input.trashedAt);
  }
  const trashedFrom = normalizeTrashSourceList(input.trashedFrom);
  if (trashedFrom.length) {
    item.trashedFrom = trashedFrom;
  }
  if (input.discardedAt) {
    item.discardedAt = String(input.discardedAt);
  }
  return item;
}

function collectionItemKey(item) {
  return `${item.hostId}::${item.conversationKey}`;
}

function collectionItemDedupeKeys(item) {
  const keys = [];
  const hostId = String(item?.hostId || '').trim();
  const add = (kind, value) => {
    const text = String(value || '').trim();
    if (hostId && text) {
      keys.push(`${kind}::${hostId}::${text}`);
    }
  };
  add('conversation', item?.conversationKey);
  add('session', item?.sessionId);
  return keys;
}

function collectionItemUpdatedMs(item) {
  const value = Date.parse(item?.updatedAt || item?.addedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function collectionItemsMatch(left, right) {
  if (!left || !right || left.hostId !== right.hostId) {
    return false;
  }
  if (left.conversationKey && right.conversationKey && left.conversationKey === right.conversationKey) {
    return true;
  }
  return Boolean(left.sessionId && right.sessionId && left.sessionId === right.sessionId);
}

function filterCollectionItems(items = [], targetItem = {}) {
  return (Array.isArray(items) ? items : []).filter((entry) => !collectionItemsMatch(entry, targetItem));
}

function stripCollectionItemTrashFields(item = {}) {
  const next = { ...item };
  delete next.trashedAt;
  delete next.trashedFrom;
  delete next.discardedAt;
  return next;
}

function dedupeCollectionItems(items = []) {
  const seen = new Map();
  const next = [];
  for (const item of Array.isArray(items) ? items : []) {
    const dedupeKeys = collectionItemDedupeKeys(item);
    const existingIndex = dedupeKeys
      .map((key) => seen.get(key))
      .find((index) => Number.isInteger(index));
    if (Number.isInteger(existingIndex)) {
      const existing = next[existingIndex];
      if (collectionItemUpdatedMs(item) >= collectionItemUpdatedMs(existing)) {
        next[existingIndex] = item;
      }
      for (const key of [...collectionItemDedupeKeys(existing), ...dedupeKeys]) {
        seen.set(key, existingIndex);
      }
      continue;
    }
    const nextIndex = next.length;
    for (const key of dedupeKeys) {
      seen.set(key, nextIndex);
    }
    next.push(item);
  }
  return next;
}

function looksLikeSessionId(value) {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

function normalizeSessionTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return title.slice(0, 180);
}

function isMeaningfulSessionTitle(title, identities = []) {
  const value = normalizeSessionTitle(title);
  if (!value || looksLikeSessionId(value)) {
    return false;
  }
  return !(identities || []).filter(Boolean).some((identity) => value === String(identity || '').trim());
}

function sessionMetadataKey(hostId, identity) {
  const key = String(identity || '').trim();
  return key ? `${hostId}::${key}` : '';
}

function normalizeSessionMetadataEntry(input = {}) {
  const hostId = String(input.hostId || '').trim();
  const identity = String(input.identity || input.sessionId || input.conversationKey || '').trim();
  const title = normalizeSessionTitle(input.title || '');
  if (!hostId || !identity || !isMeaningfulSessionTitle(title, [identity])) {
    return null;
  }
  return {
    hostId,
    identity,
    title,
    cwd: String(input.cwd || '').trim(),
    source: String(input.source || 'metadata').trim() || 'metadata',
    updatedAt: input.updatedAt || nowIso(),
  };
}

function sessionTitleSourcePriority(source = '') {
  const value = String(source || '').trim().toLowerCase();
  if (value === 'manual' || value === 'user') {
    return 100;
  }
  if (value.startsWith('collection:')) {
    return 80;
  }
  if (value === 'metadata' || value === 'migration') {
    return 60;
  }
  if (value === 'summary' || value === 'generated') {
    return 50;
  }
  return 20;
}

function shouldOverwriteSessionMetadata(existing, nextSource = '') {
  if (!existing) {
    return true;
  }
  return sessionTitleSourcePriority(nextSource) >= sessionTitleSourcePriority(existing.source);
}

function normalizeSessionCollection(input = {}) {
  const collectionId = String(input.collectionId || input.id || makeId()).trim();
  const name = String(input.name || '').trim() || 'Untitled';
  const items = [];

  for (const rawItem of Array.isArray(input.items) ? input.items : []) {
    const item = normalizeSessionCollectionItem(rawItem);
    if (!item) {
      continue;
    }
    items.push(item);
  }

  return {
    collectionId,
    name: collectionId === TRASH_COLLECTION_ID ? 'Trash' : name,
    system: collectionId === DEFAULT_COLLECTION_ID || collectionId === TRASH_COLLECTION_ID || Boolean(input.system),
    items: dedupeCollectionItems(items),
    discardedItems: collectionId === TRASH_COLLECTION_ID
      ? dedupeCollectionItems((Array.isArray(input.discardedItems) ? input.discardedItems : []).map(normalizeSessionCollectionItem).filter(Boolean))
      : [],
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
  };
}

function loadSessionCollections() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_COLLECTIONS_PATH, 'utf8'));
    const collections = Array.isArray(parsed.collections) ? parsed.collections : [];
    const normalized = collections.map(normalizeSessionCollection);
    const rawItemCount = collections.reduce((total, collection) => total + (Array.isArray(collection?.items) ? collection.items.length : 0), 0);
    const normalizedItemCount = normalized.reduce((total, collection) => total + (Array.isArray(collection?.items) ? collection.items.length : 0), 0);
    if (normalizedItemCount !== rawItemCount) {
      saveSessionCollections(normalized);
    }
    return normalized;
  } catch {
    return [];
  }
}

function saveSessionCollections(collections) {
  fs.mkdirSync(path.dirname(SESSION_COLLECTIONS_PATH), { recursive: true });
  fs.writeFileSync(SESSION_COLLECTIONS_PATH, JSON.stringify({
    savedAt: nowIso(),
    collections: collections.map((collection) => ({
      ...collection,
      items: collection.collectionId === DEFAULT_COLLECTION_ID ? [] : collection.items,
      discardedItems: collection.collectionId === TRASH_COLLECTION_ID ? (collection.discardedItems || []) : [],
    })),
  }, null, 2), 'utf8');
}

function loadSkillFavorites() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILL_FAVORITES_PATH, 'utf8'));
    const favorites = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    return new Set(favorites.map((entry) => String(entry || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function saveSkillFavorites(favorites) {
  fs.mkdirSync(path.dirname(SKILL_FAVORITES_PATH), { recursive: true });
  fs.writeFileSync(SKILL_FAVORITES_PATH, JSON.stringify({
    savedAt: nowIso(),
    favorites: Array.from(favorites || []).sort(),
  }, null, 2), 'utf8');
}

function normalizeSkillSource(input = {}) {
  const sourceId = String(input.sourceId || input.id || makeId()).trim();
  const name = String(input.name || input.label || '').trim() || 'Skill source';
  const url = String(input.url || input.path || '').trim();
  const enabled = input.enabled !== false;
  const skills = (Array.isArray(input.skills) ? input.skills : [])
    .map((skill) => normalizeCatalogSkill(skill, sourceId))
    .filter(Boolean);
  return {
    sourceId,
    name,
    url,
    enabled,
    kind: String(input.kind || 'manual').trim() || 'manual',
    skills,
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
  };
}

function loadSkillSources() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILL_SOURCES_PATH, 'utf8'));
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    return sources.map(normalizeSkillSource);
  } catch {
    return [];
  }
}

function saveSkillSources(sources) {
  fs.mkdirSync(path.dirname(SKILL_SOURCES_PATH), { recursive: true });
  fs.writeFileSync(SKILL_SOURCES_PATH, JSON.stringify({
    savedAt: nowIso(),
    sources: sources.map(normalizeSkillSource),
  }, null, 2), 'utf8');
}

function inferSkillIdFromUrl(url, fallback = '') {
  const text = String(url || '').trim();
  const cleanFallback = String(fallback || '').trim();
  try {
    const parsed = new URL(text);
    const parts = parsed.pathname.split('/').map((part) => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1] || cleanFallback;
    return last.replace(/\.git$/i, '').replace(/\.(md|json)$/i, '') || cleanFallback || makeId();
  } catch {
    return cleanFallback || makeId();
  }
}

function normalizeSkillLibraryRecord(input = {}) {
  const sourceUrl = String(input.sourceUrl || input.url || '').trim();
  const skillId = String(input.skillId || input.id || inferSkillIdFromUrl(sourceUrl, input.name)).trim();
  if (!skillId || skillId.includes('/') || skillId.includes('\\')) {
    return null;
  }
  const name = String(input.name || skillId).trim() || skillId;
  const description = String(input.description || '').trim();
  const lastInstalledHostIds = Array.from(new Set(
    (Array.isArray(input.lastInstalledHostIds) ? input.lastInstalledHostIds : [])
      .map((hostId) => String(hostId || '').trim())
      .filter(Boolean)
  ));
  return {
    skillId,
    name,
    description,
    sourceUrl,
    source: String(input.source || input.sourceName || sourceUrl || 'user-link').trim() || 'user-link',
    installed: false,
    readonly: false,
    archived: input.archived === true,
    lastInstalledHostIds,
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso(),
  };
}

function loadSkillLibrary() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SKILL_LIBRARY_PATH, 'utf8'));
    const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
    return skills.map(normalizeSkillLibraryRecord).filter(Boolean);
  } catch {
    return [];
  }
}

function saveSkillLibrary(skills) {
  fs.mkdirSync(path.dirname(SKILL_LIBRARY_PATH), { recursive: true });
  fs.writeFileSync(SKILL_LIBRARY_PATH, JSON.stringify({
    savedAt: nowIso(),
    skills: skills.map(normalizeSkillLibraryRecord).filter(Boolean),
  }, null, 2), 'utf8');
}

const SKILL_INSTANCE_STATES = new Set([
  'enabled',
  'disabled',
  'missing',
  'pending',
  'drifted',
  'conflict',
  'shadowed',
]);

function skillInventoryText(value, maxLength = 4096) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function normalizeHostSkillInstance(input, expectedHostId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('skill inventory instance must be an object');
  }
  const hostId = skillInventoryText(input.hostId || expectedHostId, 160);
  if (!hostId || hostId !== expectedHostId) {
    throw new Error('skill inventory instance hostId does not match inventory host');
  }
  const skillId = skillInventoryText(input.skillId, 240);
  const instanceId = skillInventoryText(input.instanceId, 8192);
  const activationPath = skillInventoryText(input.activationPath || input.installPath, 8192);
  if (!skillId || !instanceId || !activationPath) {
    throw new Error('skill inventory instance requires instanceId, skillId, and activationPath');
  }
  const stateName = skillInventoryText(input.state, 40).toLowerCase();
  const observedHash = skillInventoryText(input.observedHash, 96).toLowerCase();
  const desiredArtifactId = skillInventoryText(input.desiredArtifactId, 96).toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(observedHash)) {
    throw new Error('skill inventory instance observedHash must be a sha256 digest');
  }
  if (desiredArtifactId && !/^sha256:[a-f0-9]{64}$/.test(desiredArtifactId)) {
    throw new Error('skill inventory instance desiredArtifactId must be a sha256 digest');
  }
  return {
    instanceId,
    hostId,
    skillId,
    name: skillInventoryText(input.name || skillId, 512) || skillId,
    description: skillInventoryText(input.description, 4096),
    scope: skillInventoryText(input.scope || 'user', 80) || 'user',
    scopeId: skillInventoryText(input.scopeId || input.scope || 'user', 8192) || 'user',
    cwd: input.cwd ? skillInventoryText(input.cwd, 8192) : null,
    sourceId: skillInventoryText(input.sourceId || `local-host:${hostId}:${activationPath}`, 8192),
    sourceKind: skillInventoryText(input.sourceKind || 'local-host', 80) || 'local-host',
    sourceLocator: skillInventoryText(input.sourceLocator || activationPath, 8192),
    sourceRef: input.sourceRef ? skillInventoryText(input.sourceRef, 512) : null,
    sourcePath: input.sourcePath ? skillInventoryText(input.sourcePath, 8192) : null,
    activationPath,
    realPath: skillInventoryText(input.realPath || activationPath, 8192),
    observedHash,
    desiredArtifactId: desiredArtifactId || null,
    enabled: input.enabled !== false,
    effective: typeof input.effective === 'boolean' ? input.effective : null,
    managed: Boolean(input.managed),
    readonly: Boolean(input.readonly),
    state: SKILL_INSTANCE_STATES.has(stateName)
      ? stateName
      : input.enabled === false ? 'disabled' : 'enabled',
  };
}

function normalizeSkillScanError(input, hostId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const message = skillInventoryText(input.message || input.error, 4096);
  if (!message) {
    return null;
  }
  return {
    hostId,
    scope: skillInventoryText(input.scope, 80),
    scopeId: skillInventoryText(input.scopeId, 8192),
    rootPath: skillInventoryText(input.rootPath, 8192),
    path: skillInventoryText(input.path || input.rootPath, 8192),
    message,
  };
}

function normalizeHostSkillInventory(input, expectedHostId, receivedAt = nowIso()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('skill inventory must be an object');
  }
  const hostId = skillInventoryText(input.hostId || expectedHostId, 160);
  if (!hostId || hostId !== expectedHostId) {
    throw new Error('skill inventory hostId does not match its cache key');
  }
  const revision = skillInventoryText(input.revision, 96).toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) {
    throw new Error('skill inventory revision must be a sha256 digest');
  }
  const scannedAt = skillInventoryText(input.scannedAt, 80);
  if (!scannedAt || !Number.isFinite(Date.parse(scannedAt))) {
    throw new Error('skill inventory scannedAt must be a timestamp');
  }
  if (!Array.isArray(input.instances)) {
    throw new Error('skill inventory instances must be an array');
  }
  if (!Array.isArray(input.scanErrors)) {
    throw new Error('skill inventory scanErrors must be an array');
  }
  const rawInstances = input.instances;
  if (rawInstances.length > 100000) {
    throw new Error('skill inventory contains too many instances');
  }
  const normalizedReceivedAt = Number.isFinite(Date.parse(receivedAt)) ? receivedAt : nowIso();
  const instances = rawInstances.map((instance) => normalizeHostSkillInstance(instance, hostId));
  const scanErrors = input.scanErrors.map((error) => {
    const normalized = normalizeSkillScanError(error, hostId);
    if (!normalized) {
      throw new Error('skill inventory scanErrors contains an invalid entry');
    }
    return normalized;
  });
  const rawReferenceInstances = Array.isArray(input.referenceInstances)
    ? input.referenceInstances
    : rawInstances;
  if (rawReferenceInstances.length > 100000) {
    throw new Error('skill inventory contains too many retained reference instances');
  }
  return {
    hostId,
    revision,
    scannedAt,
    receivedAt: normalizedReceivedAt,
    instances,
    referenceInstances: rawReferenceInstances.map((instance) => (
      normalizeHostSkillInstance(instance, hostId)
    )),
    scanErrors,
    incomplete: input.incomplete === true || scanErrors.length > 0,
  };
}

function loadSkillInventories() {
  const inventories = new Map();
  let source;
  try {
    source = fs.readFileSync(SKILL_INVENTORIES_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return inventories;
    }
    throw new Error(`failed to read persisted Skill inventories: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid persisted Skill inventory JSON: ${error.message}`);
  }
  if (
    !parsed
    || parsed.version !== 1
    || !parsed.inventories
    || typeof parsed.inventories !== 'object'
    || Array.isArray(parsed.inventories)
  ) {
    throw new Error('invalid persisted Skill inventory schema or version');
  }
  for (const [hostId, rawInventory] of Object.entries(parsed.inventories)) {
    try {
      const normalizedHostId = skillInventoryText(hostId, 160);
      if (!normalizedHostId || rawInventory?.hostId !== normalizedHostId) {
        throw new Error('inventory hostId does not match its persisted key');
      }
      inventories.set(normalizedHostId, normalizeHostSkillInventory(
        rawInventory,
        normalizedHostId,
        rawInventory.receivedAt
      ));
    } catch (error) {
      throw new Error(`invalid persisted Skill inventory for ${hostId}: ${error.message}`);
    }
  }
  return inventories;
}

function saveSkillInventories(inventories) {
  fs.mkdirSync(path.dirname(SKILL_INVENTORIES_PATH), { recursive: true });
  const serialized = {};
  for (const [hostId, inventory] of inventories.entries()) {
    serialized[hostId] = inventory;
  }
  const tempPath = `${SKILL_INVENTORIES_PATH}.${process.pid}.${makeId()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({
      version: 1,
      savedAt: nowIso(),
      inventories: serialized,
    }, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, SKILL_INVENTORIES_PATH);
  } finally {
    if (fd != null) {
      fs.closeSync(fd);
    }
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (_) {
      // The completed target remains valid even if temp cleanup is unavailable.
    }
  }
}

function ensureTrashCollection() {
  const existing = state.sessionCollections.get(TRASH_COLLECTION_ID);
  if (existing) {
    const normalized = normalizeSessionCollection({
      ...existing,
      collectionId: TRASH_COLLECTION_ID,
      name: 'Trash',
      system: true,
    });
    if (normalized.name !== existing.name || !existing.system) {
      state.sessionCollections.set(TRASH_COLLECTION_ID, normalized);
    }
    return normalized;
  }
  const collection = normalizeSessionCollection({
    collectionId: TRASH_COLLECTION_ID,
    name: 'Trash',
    system: true,
    items: [],
  });
  state.sessionCollections.set(TRASH_COLLECTION_ID, collection);
  return collection;
}

function findCollectionMembershipsForItem(item) {
  const normalized = normalizeSessionCollectionItem(item);
  if (!normalized) {
    return [];
  }
  const memberships = [];
  for (const collection of state.sessionCollections.values()) {
    if (!collection || collection.collectionId === DEFAULT_COLLECTION_ID || collection.collectionId === TRASH_COLLECTION_ID) {
      continue;
    }
    if ((collection.items || []).some((entry) => collectionItemsMatch(entry, normalized))) {
      memberships.push({
        collectionId: collection.collectionId,
        name: collection.name || 'Collection',
      });
    }
  }
  return memberships;
}

function findDiscardedSessionItem(item) {
  const normalized = normalizeSessionCollectionItem(item);
  if (!normalized) {
    return null;
  }
  const discarded = state.sessionCollections.get(TRASH_COLLECTION_ID)?.discardedItems || [];
  return discarded.find((entry) => collectionItemsMatch(entry, normalized)) || null;
}

function isCollectionItemDiscarded(item) {
  return Boolean(findDiscardedSessionItem(item));
}

function isCollectionItemInTrash(item) {
  const normalized = normalizeSessionCollectionItem(item);
  if (!normalized) {
    return false;
  }
  const trash = ensureTrashCollection();
  return (trash.items || []).some((entry) => collectionItemsMatch(entry, normalized));
}

function isCollectionItemHiddenFromCollections(item) {
  return isCollectionItemInTrash(item) || isCollectionItemDiscarded(item);
}

function moveCollectionItemToTrash(input) {
  const item = normalizeSessionCollectionItem(input);
  if (!item) {
    throw new Error('hostId and conversationKey are required');
  }
  const trash = ensureTrashCollection();
  const previousCollections = findCollectionMembershipsForItem(item);
  const restoredItem = stripCollectionItemTrashFields(item);
  const trashedItem = {
    ...restoredItem,
    trashedAt: nowIso(),
    trashedFrom: previousCollections,
    updatedAt: nowIso(),
  };

  for (const source of previousCollections) {
    const collection = state.sessionCollections.get(source.collectionId);
    if (!collection) {
      continue;
    }
    state.sessionCollections.set(collection.collectionId, {
      ...collection,
      items: filterCollectionItems(collection.items, item),
      updatedAt: nowIso(),
    });
  }

  const nextTrashItems = [
    ...filterCollectionItems(trash.items, item),
    trashedItem,
  ];
  state.sessionCollections.set(TRASH_COLLECTION_ID, {
    ...trash,
    items: dedupeCollectionItems(nextTrashItems),
    updatedAt: nowIso(),
  });
  persistSessionCollections();
  return {
    item: trashedItem,
    previousCollections,
    trash: state.sessionCollections.get(TRASH_COLLECTION_ID),
  };
}

function restoreCollectionItemFromTrash(input) {
  const item = normalizeSessionCollectionItem(input);
  if (!item) {
    throw new Error('hostId and conversationKey are required');
  }
  const trash = ensureTrashCollection();
  const trashItem = (trash.items || []).find((entry) => collectionItemsMatch(entry, item));
  if (!trashItem) {
    throw new Error('trash item not found');
  }

  const restoredCollections = [];
  const restoredItem = stripCollectionItemTrashFields(trashItem);
  for (const source of normalizeTrashSourceList(trashItem.trashedFrom)) {
    const collection = state.sessionCollections.get(source.collectionId);
    if (!collection || collection.collectionId === DEFAULT_COLLECTION_ID || collection.collectionId === TRASH_COLLECTION_ID) {
      continue;
    }
    state.sessionCollections.set(collection.collectionId, {
      ...collection,
      items: dedupeCollectionItems([
        ...filterCollectionItems(collection.items, restoredItem),
        {
          ...restoredItem,
          updatedAt: nowIso(),
        },
      ]),
      updatedAt: nowIso(),
    });
    restoredCollections.push({
      collectionId: collection.collectionId,
      name: collection.name || source.name || 'Collection',
    });
  }

  state.sessionCollections.set(TRASH_COLLECTION_ID, {
    ...trash,
    items: filterCollectionItems(trash.items, item),
    discardedItems: (trash.discardedItems || []).filter((entry) => !collectionItemsMatch(entry, item)),
    updatedAt: nowIso(),
  });
  persistSessionCollections();
  return {
    item: restoredItem,
    restoredCollections,
    trash: state.sessionCollections.get(TRASH_COLLECTION_ID),
  };
}

function emptyTrashCollection() {
  const trash = ensureTrashCollection();
  const trashedItems = Array.isArray(trash.items) ? trash.items : [];
  const discardedAt = nowIso();
  const discardedItems = dedupeCollectionItems([
    ...(Array.isArray(trash.discardedItems) ? trash.discardedItems : []),
    ...trashedItems.map((item) => ({
      ...item,
      discardedAt,
      updatedAt: discardedAt,
    })),
  ]);
  state.sessionCollections.set(TRASH_COLLECTION_ID, {
    ...trash,
    items: [],
    discardedItems,
    updatedAt: nowIso(),
  });
  persistSessionCollections();
  return {
    discardedItems,
    trash: state.sessionCollections.get(TRASH_COLLECTION_ID),
  };
}

function loadSessionMetadata() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_METADATA_PATH, 'utf8'));
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return new Map(entries
      .map(normalizeSessionMetadataEntry)
      .filter(Boolean)
      .map((entry) => [sessionMetadataKey(entry.hostId, entry.identity), entry]));
  } catch {
    return new Map();
  }
}

function saveSessionMetadata() {
  if (
    state.sessionRecordStore
    || fs.existsSync(path.join(SESSION_RECORD_STORE_ROOT, 'snapshot-current.json'))
    || fs.existsSync(path.join(SESSION_RECORD_STORE_ROOT, 'wal-current.jsonl'))
  ) {
    return;
  }
  fs.mkdirSync(path.dirname(SESSION_METADATA_PATH), { recursive: true });
  const entries = Array.from(state.sessionMetadata.values())
    .map(normalizeSessionMetadataEntry)
    .filter(Boolean)
    .sort((a, b) => `${a.hostId}::${a.identity}`.localeCompare(`${b.hostId}::${b.identity}`));
  fs.writeFileSync(SESSION_METADATA_PATH, JSON.stringify({
    savedAt: nowIso(),
    entries,
  }, null, 2), 'utf8');
}

function safePathSegment(value, fallback = 'item') {
  const text = String(value || '').trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return text || fallback;
}

function pathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRemoteFilePath(value) {
  return String(value || '')
    .trim()
    .replace(/^[\\/]+([A-Za-z]:[\\/])/, '$1');
}

function loadReceivedFiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RECEIVED_FILES_MANIFEST_PATH, 'utf8'));
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    return new Map(files
      .filter((file) => file?.fileId && file?.localPath)
      .map((file) => [String(file.fileId), file]));
  } catch {
    return new Map();
  }
}

function saveReceivedFiles() {
  fs.mkdirSync(RECEIVED_FILES_ROOT, { recursive: true });
  fs.writeFileSync(RECEIVED_FILES_MANIFEST_PATH, JSON.stringify({
    savedAt: nowIso(),
    ttlMs: RECEIVED_FILE_TTL_MS,
    root: RECEIVED_FILES_ROOT,
    files: Array.from(state.receivedFiles.values()),
  }, null, 2), 'utf8');
}

function normalizeStoredTranscriptEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const speaker = entry.speaker || 'system';
  const text = cleanStoredTranscriptText(entry.text || '', speaker);
  const files = normalizeFileTransferRefs(entry.files || entry.attachments || []);
  if (!text && !files.length) {
    return null;
  }
  const assistantSeq = Number(entry.assistantSeq);
  const assistantMessageId = String(entry.assistantMessageId || '').trim();
  const clientRequestId = normalizeClientRequestId(entry.clientRequestId);
  const deliveryStatus = ['pending', 'accepted'].includes(String(entry.deliveryStatus || '').trim())
    ? String(entry.deliveryStatus).trim()
    : null;
  return {
    timestamp: entry.timestamp || nowIso(),
    speaker,
    text,
    stream: entry.stream || null,
    source: String(entry.source || '').trim() || null,
    clientRequestId: clientRequestId || null,
    ...(deliveryStatus ? { deliveryStatus } : {}),
    files,
    ...(assistantMessageId ? {
      assistantMessageId,
      assistantSeq: Number.isSafeInteger(assistantSeq) && assistantSeq >= 0
        ? assistantSeq
        : 0,
      assistantAt: entry.assistantAt || null,
      notifiable: entry.notifiable === true,
    } : {}),
  };
}

function stripResumeBootstrapText(value, speaker = '') {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!text) {
    return '';
  }

  const hasPrelude = /Continue this conversation with the following prior context in mind:/i.test(text);
  const requestMatch = text.match(/(?:^|\n)New user request:\s*([\s\S]*)$/i);
  if (!hasPrelude && !requestMatch) {
    return text;
  }

  if (speaker === 'user') {
    return requestMatch ? requestMatch[1].trim() : '';
  }
  return '';
}

function cleanStoredTranscriptText(value, speaker = '') {
  let text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!text || isInternalTranscriptText(text)) {
    return '';
  }

  text = stripResumeBootstrapText(text, speaker).trim();
  if (!text || isInternalTranscriptText(text)) {
    return '';
  }

  text = stripTranscriptWrapperText(text).trim();
  if (!text || isInternalTranscriptText(text)) {
    return '';
  }

  text = stripEnvironmentContextText(text).trim();
  if (String(speaker || '').toLowerCase() === 'user') {
    text = stripIdeContextText(text).trim();
  }

  return isInternalTranscriptText(text) ? '' : text;
}

function stripTranscriptWrapperText(value) {
  let text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!text) {
    return '';
  }

  const wrapperPatterns = [
    /\n?The following is the Codex agent history (?:whose request action you are assessing|added since your last approval assessment)\b[\s\S]*$/i,
    /\n?>>> TRANSCRIPT(?: DELTA)? START\b[\s\S]*$/im,
    /\n?>>> TRANSCRIPT(?: DELTA)? END\b[\s\S]*$/im,
    /\n?>>> APPROVAL REQUEST START\b[\s\S]*$/im,
    /\n?>>> APPROVAL REQUEST END\b[\s\S]*$/im,
    /\n?Reviewed Codex session id:[\s\S]*$/i,
    /\n?The Codex agent has requested the following (?:next action|action below|action):[\s\S]*$/i,
  ];

  for (const pattern of wrapperPatterns) {
    text = text.replace(pattern, '').trim();
  }
  return text;
}

function stripEnvironmentContextText(value) {
  return String(value || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .trim();
}

function stripIdeContextText(value) {
  const text = String(value || '').trim();
  const requestMatch = text.match(/(?:^|\n)## My request for Codex:\s*([\s\S]*)$/i);
  return requestMatch ? requestMatch[1].trim() : text;
}

function isInternalTranscriptText(value) {
  const text = String(value || '').trim();
  if (!text) {
    return true;
  }
  if (/^<user_action\b[\s\S]*<\/user_action>$/i.test(text)) {
    return true;
  }
  if (/^<environment_context>[\s\S]*<\/environment_context>$/i.test(text)) {
    return true;
  }
  if (/^The following is the Codex agent history (?:whose request action you are assessing|added since your last approval assessment)\b/i.test(text)) {
    return true;
  }
  if (/^>>>\s+TRANSCRIPT(?:\s+DELTA)?\s+START\b/im.test(text)) {
    return true;
  }
  if (/^\{\s*"(?:risk_level|outcome|user_authorization)"\s*:/.test(text) && /"outcome"\s*:\s*"(?:allow|deny)"/i.test(text)) {
    return true;
  }
  return false;
}

function canonicalTranscriptText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactTranscriptEntries(entries) {
  const compacted = [];
  for (const entry of sortTranscriptEntries(entries || [])) {
    const previous = compacted[compacted.length - 1];
    if (isAdjacentTranscriptDuplicate(previous, entry)) {
      if (
        previous?.assistantMessageId
        || entry?.assistantMessageId
        || previous?.clientRequestId
        || entry?.clientRequestId
      ) {
        compacted[compacted.length - 1] = mergeAdjacentTranscriptDuplicate(previous, entry);
      }
      continue;
    }
    compacted.push(entry);
  }
  return compacted;
}

function mergeAdjacentTranscriptDuplicate(previous, entry) {
  const identified = (entry?.assistantMessageId || entry?.clientRequestId) ? entry : previous;
  const other = identified === entry ? previous : entry;
  return normalizeStoredTranscriptEntry({
    ...other,
    ...identified,
    files: mergeExportTranscriptFiles(previous?.files, entry?.files),
    source: identified?.source || other?.source || null,
  }) || identified || previous;
}

function isAdjacentTranscriptDuplicate(previous, entry) {
  if (!previous || !entry || previous.speaker !== entry.speaker) {
    return false;
  }
  const previousRequestId = String(previous.clientRequestId || '').trim();
  const entryRequestId = String(entry.clientRequestId || '').trim();
  if (previousRequestId && entryRequestId) {
    return previousRequestId === entryRequestId;
  }
  const previousAssistantId = String(previous.assistantMessageId || '').trim();
  const entryAssistantId = String(entry.assistantMessageId || '').trim();
  if (previousAssistantId || entryAssistantId) {
    if (
      previousAssistantId
      && entryAssistantId
      && previousAssistantId === entryAssistantId
    ) {
      return true;
    }
    if (previousAssistantId && entryAssistantId) {
      return false;
    }
    const previousText = canonicalTranscriptText(previous.text);
    const entryText = canonicalTranscriptText(entry.text);
    const previousTime = Date.parse(previous.timestamp || '');
    const entryTime = Date.parse(entry.timestamp || '');
    const near = Number.isFinite(previousTime)
      && Number.isFinite(entryTime)
      && Math.abs(entryTime - previousTime) <= 5000;
    return Boolean(
      near
      && ['agent', 'assistant'].includes(String(previous.speaker || '').toLowerCase())
      && previousText
      && previousText === entryText
    );
  }
  const previousFiles = (previous.files || []).map((file) => file.path || file.name || '').join(',');
  const entryFiles = (entry.files || []).map((file) => file.path || file.name || '').join(',');

  const previousText = canonicalTranscriptText(previous.text);
  const entryText = canonicalTranscriptText(entry.text);
  if (
    previousFiles === entryFiles
    && previousText
    && entryText
    && previousText === entryText
    && !(previousRequestId || entryRequestId)
  ) {
    return true;
  }

  const previousTime = Date.parse(previous.timestamp || '');
  const entryTime = Date.parse(entry.timestamp || '');
  const near = Number.isFinite(previousTime) && Number.isFinite(entryTime) && Math.abs(entryTime - previousTime) <= 30000;
  if (!near) {
    return false;
  }
  if (previousFiles !== entryFiles) {
    return isInlineTextFileEchoDuplicate(previous, entry);
  }
  if (previousText.length >= 80 && entryText.includes(previousText)) {
    return true;
  }
  if (entryText.length >= 80 && previousText.includes(entryText)) {
    return true;
  }
  return false;
}

function firstTranscriptContentLine(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^Attached (?:history|file|text file contents)\b/i.test(line)) || '';
}

function isInlineTextFileEchoDuplicate(previous, entry) {
  if (String(previous?.speaker || '').toLowerCase() !== 'user') {
    return false;
  }
  const previousText = String(previous.text || '');
  const entryText = String(entry.text || '');
  const previousHasFiles = Array.isArray(previous.files) && previous.files.length > 0;
  const entryHasFiles = Array.isArray(entry.files) && entry.files.length > 0;
  if (previousHasFiles === entryHasFiles) {
    return false;
  }
  const combined = `${previousText}\n${entryText}`;
  if (!/Attached text file contents:/i.test(combined)) {
    return false;
  }
  if (!/Attached (?:history|file):/i.test(combined)) {
    return false;
  }
  const previousFirstLine = canonicalTranscriptText(firstTranscriptContentLine(previousText));
  const entryFirstLine = canonicalTranscriptText(firstTranscriptContentLine(entryText));
  return Boolean(previousFirstLine && entryFirstLine && previousFirstLine === entryFirstLine);
}

function sortTranscriptEntries(entries) {
  return (entries || [])
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareTranscriptEntries(a.entry, b.entry) || a.index - b.index)
    .map((item) => item.entry);
}

function compareTranscriptEntries(a, b) {
  const left = Date.parse(a?.timestamp || '');
  const right = Date.parse(b?.timestamp || '');
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return left - right;
  }
  if (Number.isFinite(left) !== Number.isFinite(right)) {
    return Number.isFinite(left) ? -1 : 1;
  }
  return 0;
}

function loadSessionLogs() {
  try {
    let raw;
    try {
      raw = fs.readFileSync(SESSION_LOGS_PATH, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const recovered = recoverMissingFileFromBackup(SESSION_LOGS_PATH);
      if (!recovered.recovered) return new Map();
      raw = fs.readFileSync(SESSION_LOGS_PATH, 'utf8');
    }
    const parsed = JSON.parse(raw);
    const rawLogs = parsed && typeof parsed.logs === 'object' ? parsed.logs : {};
    const logs = new Map();
    const persistedLogs = {};
    let changed = false;
    for (const [key, entries] of Object.entries(rawLogs)) {
      const rawEntries = Array.isArray(entries) ? entries : [];
      const normalized = (Array.isArray(entries) ? entries : [])
        .map(normalizeStoredTranscriptEntry)
        .filter(Boolean);
      const compacted = compactTranscriptEntries(normalized)
        .slice(-SESSION_LOG_ENTRY_LIMIT);
      if (compacted.length) {
        logs.set(key, compacted);
        persistedLogs[key] = compacted;
      }
      if (JSON.stringify(rawEntries) !== JSON.stringify(compacted)) {
        changed = true;
      }
    }
    if (changed) {
      fs.mkdirSync(path.dirname(SESSION_LOGS_PATH), { recursive: true });
      fs.writeFileSync(SESSION_LOGS_PATH, JSON.stringify({
        savedAt: nowIso(),
        logs: persistedLogs,
      }, null, 2), 'utf8');
    }
    return logs;
  } catch {
    return new Map();
  }
}

function saveSessionLogs() {
  const logs = {};
  for (const [key, entries] of state.sessionLogs.entries()) {
    const normalized = (Array.isArray(entries) ? entries : [])
      .map(normalizeStoredTranscriptEntry)
      .filter(Boolean);
    const compacted = compactTranscriptEntries(normalized)
      .slice(-SESSION_LOG_ENTRY_LIMIT);
    if (compacted.length) {
      logs[key] = compacted;
    }
  }
  fs.mkdirSync(path.dirname(SESSION_LOGS_PATH), { recursive: true });
  const serialized = `${JSON.stringify({
    savedAt: nowIso(),
    logs,
  }, null, 2)}\n`;
  const tempPath = `${SESSION_LOGS_PATH}.${process.pid}.${makeId()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    replaceFileWithBackup(tempPath, SESSION_LOGS_PATH);
    checkpointPersistedInputTranscriptProjections();
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function loadDismissedHosts() {
  try {
    let raw;
    try {
      raw = fs.readFileSync(DISMISSED_HOSTS_PATH, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const recovered = recoverMissingFileFromBackup(DISMISSED_HOSTS_PATH);
      if (!recovered.recovered) {
        return new Set();
      }
      raw = fs.readFileSync(DISMISSED_HOSTS_PATH, 'utf8');
    }
    const parsed = JSON.parse(raw);
    if (Number(parsed?.version) !== 1 || !Array.isArray(parsed.hosts)) {
      throw new Error('invalid dismissed Host state schema');
    }
    const hosts = parsed.hosts.map((value) => String(value || '').trim());
    if (hosts.some((hostId) => !hostId || hostId.length > 160)) {
      throw new Error('invalid dismissed Host id');
    }
    return new Set(hosts);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return new Set();
    }
    throw new Error(`failed to load dismissed Host state: ${error.message || error}`);
  }
}

function saveDismissedHosts() {
  fs.mkdirSync(path.dirname(DISMISSED_HOSTS_PATH), { recursive: true });
  const tempPath = `${DISMISSED_HOSTS_PATH}.${process.pid}.${makeId()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify({
      version: 1,
      savedAt: nowIso(),
      hosts: Array.from(state.dismissedHosts).sort(),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    replaceFileWithBackup(tempPath, DISMISSED_HOSTS_PATH);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function restoreDismissedHost(hostId) {
  const normalized = String(hostId || '').trim();
  if (!normalized || !state.dismissedHosts.delete(normalized)) {
    return false;
  }
  try {
    saveDismissedHosts();
  } catch (error) {
    state.dismissedHosts.add(normalized);
    throw error;
  }
  return true;
}

function normalizeHostCodexRuntime(input) {
  if (!input || typeof input !== 'object') return null;
  const text = (value, max = 1024) => {
    const normalized = String(value == null ? '' : value).trim();
    return normalized ? redactSecretText(normalized).slice(0, max) : null;
  };
  return {
    version: text(input.version, 120),
    rawVersion: text(input.rawVersion, 512),
    source: text(input.source, 80),
    packageManager: text(input.packageManager, 80),
    binPath: text(input.binPath, 2048),
    realPath: text(input.realPath, 2048),
    packageRoot: text(input.packageRoot, 2048),
    platform: text(input.platform, 80),
    arch: text(input.arch, 80),
    probedAt: text(input.probedAt, 80),
    canAutoUpdate: input.canAutoUpdate === true,
    updateReason: text(input.updateReason, 1200),
    error: text(input.error, 1200),
  };
}

function normalizeHostCodexMaintenance(input) {
  if (!input || typeof input !== 'object') return null;
  const operationId = String(input.operationId || '').trim();
  if (!operationId) return null;
  return {
    operationId,
    status: String(input.status || '').trim().toLowerCase() || null,
    message: redactSecretText(String(input.message || '')).slice(0, 2000) || null,
    previousVersion: String(input.previousVersion || '').trim().slice(0, 120) || null,
    version: String(input.version || '').trim().slice(0, 120) || null,
    updaterPid: Number(input.updaterPid || 0) || null,
    startedAt: String(input.startedAt || '').trim() || null,
    updatedAt: String(input.updatedAt || '').trim() || null,
  };
}

function normalizeCodexUpdateSession(input = {}) {
  const sessionId = String(input.sessionId || '').trim();
  if (!sessionId) return null;
  return {
    hostId: String(input.hostId || '').trim() || null,
    sessionId,
    runId: String(input.runId || '').trim() || null,
    bridgeSessionId: String(input.bridgeSessionId || '').trim() || null,
    nativeThreadId: String(input.nativeThreadId || '').trim() || null,
    originSessionId: String(input.originSessionId || '').trim() || null,
    sourceSessionId: String(input.sourceSessionId || '').trim() || null,
    conversationKey: String(input.conversationKey || '').trim() || null,
    title: redactSecretText(String(input.title || '').trim()).slice(0, 512) || null,
    cwd: redactSecretText(String(input.cwd || '').trim()).slice(0, 2048) || null,
    nativeResumeReady: input.nativeResumeReady === true,
    nativeResumeReadyKnown: input.nativeResumeReadyKnown === true,
    bindingFingerprint: String(input.bindingFingerprint || '').trim().slice(0, 256) || null,
    requestedSelection: input.requestedSelection && typeof input.requestedSelection === 'object'
      ? {
        model: String(input.requestedSelection.model || '').trim().slice(0, 256) || null,
        effort: String(input.requestedSelection.effort || '').trim().slice(0, 80) || null,
        summary: String(input.requestedSelection.summary || '').trim().slice(0, 80) || null,
      }
      : null,
    resumeAttempt: Math.max(0, Math.trunc(Number(input.resumeAttempt || 0) || 0)),
    resumeRequestId: String(input.resumeRequestId || '').trim().slice(0, 160) || null,
    status: String(input.status || 'live').trim().toLowerCase().slice(0, 80),
    message: redactSecretText(String(input.message || '')).slice(0, 1200) || null,
  };
}

function normalizeCodexUpdateOperation(input = {}) {
  const hostId = String(input.hostId || '').trim();
  const operationId = String(input.operationId || '').trim();
  if (!hostId || !operationId) return null;
  const rawStatus = String(input.status || 'planned').trim().toLowerCase();
  return {
    operationId,
    hostId,
    status: rawStatus,
    phase: String(input.phase || rawStatus).trim().toLowerCase(),
    message: redactSecretText(String(input.message || '')).slice(0, 2000),
    currentVersion: String(input.currentVersion || '').trim().slice(0, 120) || null,
    targetVersion: String(input.targetVersion || '').trim().slice(0, 120) || null,
    updateSucceeded: typeof input.updateSucceeded === 'boolean' ? input.updateSucceeded : null,
    sessions: (Array.isArray(input.sessions) ? input.sessions : [])
      .map(normalizeCodexUpdateSession)
      .filter(Boolean),
    blockedSessionIds: (Array.isArray(input.blockedSessionIds) ? input.blockedSessionIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
    stopFailures: (Array.isArray(input.stopFailures) ? input.stopFailures : [])
      .map((value) => redactSecretText(String(value || '')).slice(0, 1200))
      .filter(Boolean),
    resumeFailures: (Array.isArray(input.resumeFailures) ? input.resumeFailures : [])
      .map((value) => redactSecretText(String(value || '')).slice(0, 1200))
      .filter(Boolean),
    createdAt: String(input.createdAt || nowIso()).trim() || nowIso(),
    updatedAt: String(input.updatedAt || nowIso()).trim() || nowIso(),
    completedAt: String(input.completedAt || '').trim() || null,
  };
}

function finalizeCodexUpdateWithoutRecovery(operation) {
  if (
    !operation
    || operation.sessions.length > 0
    || !['updated', 'update_failed'].includes(operation.status)
  ) {
    return operation;
  }
  const succeeded = operation.status === 'updated';
  const status = succeeded ? 'completed' : 'failed';
  return {
    ...operation,
    status,
    phase: status,
    message: operation.message || (
      succeeded
        ? 'Codex update completed; no Sessions required recovery.'
        : 'Codex update failed; no Sessions required recovery.'
    ),
    completedAt: operation.completedAt || operation.updatedAt || nowIso(),
  };
}

function loadCodexUpdateOperations() {
  try {
    let raw;
    try {
      raw = fs.readFileSync(CODEX_UPDATE_OPERATIONS_PATH, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const recovered = recoverMissingFileFromBackup(CODEX_UPDATE_OPERATIONS_PATH);
      if (!recovered.recovered) return new Map();
      raw = fs.readFileSync(CODEX_UPDATE_OPERATIONS_PATH, 'utf8');
    }
    const parsed = JSON.parse(raw);
    if (Number(parsed?.version) !== 1 || !Array.isArray(parsed.operations)) {
      throw new Error('invalid Host Codex update state schema');
    }
    return new Map(parsed.operations
      .map((operation) => normalizeCodexUpdateOperation(operation))
      .filter(Boolean)
      .map((operation) => finalizeCodexUpdateWithoutRecovery(operation))
      .map((operation) => [operation.hostId, operation]));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw new Error(`failed to load Host Codex update state: ${error.message || error}`);
  }
}

function saveCodexUpdateOperations() {
  fs.mkdirSync(path.dirname(CODEX_UPDATE_OPERATIONS_PATH), { recursive: true });
  const tempPath = `${CODEX_UPDATE_OPERATIONS_PATH}.${process.pid}.${makeId()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify({
      version: 1,
      savedAt: nowIso(),
      operations: Array.from(state.codexUpdateOperations.values()),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    replaceFileWithBackup(tempPath, CODEX_UPDATE_OPERATIONS_PATH);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_) {
      // The atomic replacement normally consumes the temporary file.
    }
  }
}

function publicCodexUpdateOperation(operation) {
  return operation ? normalizeCodexUpdateOperation(operation) : null;
}

function currentCodexUpdateOperation(hostId) {
  return state.codexUpdateOperations.get(String(hostId || '').trim()) || null;
}

function activeCodexUpdateOperation(hostId) {
  const operation = currentCodexUpdateOperation(hostId);
  return operation && ACTIVE_CODEX_UPDATE_STATUSES.has(operation.status) ? operation : null;
}

function storeCodexUpdateOperation(input) {
  const operation = finalizeCodexUpdateWithoutRecovery(normalizeCodexUpdateOperation({
    ...input,
    updatedAt: nowIso(),
  }));
  if (!operation) throw new Error('invalid Host Codex update operation');
  state.codexUpdateOperations.set(operation.hostId, operation);
  saveCodexUpdateOperations();
  return operation;
}

function reconcileHostCodexMaintenance(hostId, input) {
  const maintenance = normalizeHostCodexMaintenance(input);
  const host = state.hosts.get(hostId);
  if (host) {
    host.codexMaintenance = maintenance;
    state.hosts.set(hostId, host);
  }
  if (!maintenance) return null;
  const operation = currentCodexUpdateOperation(hostId);
  if (!operation || operation.operationId !== maintenance.operationId) return maintenance;
  const updaterActive = ['checking', 'updating', 'installing', 'verifying'].includes(maintenance.status);
  const updaterTerminal = ['updated', 'update_failed'].includes(maintenance.status);
  if (
    updaterActive
    && ['updating', 'checking', 'installing', 'verifying'].includes(operation.status)
    && (
      operation.status !== maintenance.status
      || operation.message !== maintenance.message
    )
  ) {
    patchCodexUpdateOperation(operation, {
      status: maintenance.status,
      phase: maintenance.status,
      message: maintenance.message || `Host updater is ${maintenance.status}.`,
    });
  } else if (
    updaterTerminal
    && ['updating', 'checking', 'installing', 'verifying'].includes(operation.status)
  ) {
    patchCodexUpdateOperation(operation, {
      status: maintenance.status,
      phase: maintenance.status,
      updateSucceeded: maintenance.status === 'updated',
      targetVersion: maintenance.version || null,
      message: maintenance.message || (
        maintenance.status === 'updated'
          ? `Codex ${maintenance.version || 'update'} installed and verified.`
          : 'Codex update failed.'
      ),
    });
  }
  return maintenance;
}

function boundedDiagnosticIdentity(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? redactSecretText(text).slice(0, 512) : null;
}

function normalizeStoredSessionDiagnostic(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const message = redactSecretText(entry.message || '').trim();
  if (!message) {
    return null;
  }
  const data = entry.data == null ? null : stripSecrets(entry.data);
  const detail = entry.detail == null
    ? null
    : typeof entry.detail === 'string'
      ? redactSecretText(entry.detail)
      : stripSecrets(entry.detail);
  const runId = boundedDiagnosticIdentity(entry.runId || data?.runId);
  const turnId = boundedDiagnosticIdentity(entry.turnId || data?.turnId);
  const itemId = boundedDiagnosticIdentity(entry.itemId || data?.itemId || data?.item_id);
  const callId = boundedDiagnosticIdentity(entry.callId || data?.callId || data?.call_id);
  const requestId = boundedDiagnosticIdentity(entry.requestId || data?.requestId || data?.request_id);
  return {
    timestamp: entry.timestamp || nowIso(),
    severity: entry.severity || 'info',
    source: entry.source || 'codex',
    kind: entry.kind || 'event',
    method: entry.method ? redactSecretText(entry.method) : null,
    message,
    detail,
    data,
    runId,
    turnId,
    itemId,
    callId,
    requestId,
    status: boundedDiagnosticIdentity(entry.status || data?.status),
    final: entry.final === true,
  };
}

function loadSessionDiagnostics() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_DIAGNOSTICS_PATH, 'utf8'));
    const rawDiagnostics = parsed && typeof parsed.diagnostics === 'object' ? parsed.diagnostics : {};
    const diagnostics = new Map();
    const persistedDiagnostics = {};
    let changed = false;
    for (const [key, entries] of Object.entries(rawDiagnostics)) {
      const rawEntries = Array.isArray(entries) ? entries : [];
      const compacted = compactSessionDiagnostics(rawEntries
        .map(normalizeStoredSessionDiagnostic)
        .filter(Boolean));
      if (compacted.length) {
        diagnostics.set(key, compacted);
        persistedDiagnostics[key] = compacted;
      }
      if (JSON.stringify(rawEntries) !== JSON.stringify(compacted)) {
        changed = true;
      }
    }
    if (changed) {
      sessionDiagnosticsNeedsNormalization = true;
    }
    return diagnostics;
  } catch {
    return new Map();
  }
}

function buildSessionDiagnosticsSnapshot() {
  const diagnostics = {};
  for (const [key, entries] of state.sessionDiagnostics.entries()) {
    const compacted = compactSessionDiagnostics((Array.isArray(entries) ? entries : [])
      .map(normalizeStoredSessionDiagnostic)
      .filter(Boolean));
    if (compacted.length) {
      diagnostics[key] = compacted;
    }
  }
  return diagnostics;
}

async function writeSessionDiagnosticsSnapshot(diagnostics) {
  await fs.promises.mkdir(path.dirname(SESSION_DIAGNOSTICS_PATH), { recursive: true });
  await fs.promises.writeFile(SESSION_DIAGNOSTICS_PATH, JSON.stringify({
    savedAt: nowIso(),
    diagnostics,
  }, null, 2), 'utf8');
}

async function saveSessionDiagnostics() {
  await writeSessionDiagnosticsSnapshot(buildSessionDiagnosticsSnapshot());
}

let sessionLogsSaveTimer = null;
let sessionLogsSavePending = false;
let sessionLogsSaveError = null;
let sessionDiagnosticsSaveTimer = null;
let sessionDiagnosticsSaveInFlight = null;
let sessionDiagnosticsSavePending = false;
let sessionDiagnosticsSaveError = null;
let sessionDiagnosticsNeedsNormalization = false;

function scheduleSessionLogsSave(delayMs = PERSIST_DEBOUNCE_MS) {
  sessionLogsSavePending = true;
  if (sessionLogsSaveTimer) {
    return;
  }
  sessionLogsSaveTimer = setTimeout(() => {
    sessionLogsSaveTimer = null;
    try {
      saveSessionLogs();
      sessionLogsSavePending = false;
      sessionLogsSaveError = null;
    } catch (error) {
      sessionLogsSaveError = error;
      console.warn(`[relay] failed to save session logs: ${error.message}`);
    }
  }, Math.max(0, Number(delayMs) || 0));
  if (typeof sessionLogsSaveTimer.unref === 'function') {
    sessionLogsSaveTimer.unref();
  }
}

function flushSessionLogsSave() {
  if (!sessionLogsSavePending) {
    return null;
  }
  if (sessionLogsSaveTimer) {
    clearTimeout(sessionLogsSaveTimer);
    sessionLogsSaveTimer = null;
  }
  try {
    saveSessionLogs();
    sessionLogsSavePending = false;
    sessionLogsSaveError = null;
    return null;
  } catch (error) {
    sessionLogsSaveError = error;
    throw error;
  }
}

function scheduleSessionDiagnosticsSave(delayMs = PERSIST_DEBOUNCE_MS) {
  sessionDiagnosticsSavePending = true;
  if (sessionDiagnosticsSaveTimer) {
    return;
  }
  sessionDiagnosticsSaveTimer = setTimeout(() => {
    sessionDiagnosticsSaveTimer = null;
    void flushSessionDiagnosticsSave();
  }, Math.max(0, Number(delayMs) || 0));
  if (typeof sessionDiagnosticsSaveTimer.unref === 'function') {
    sessionDiagnosticsSaveTimer.unref();
  }
}

async function flushSessionDiagnosticsSave() {
  // A save may already be writing an older snapshot while a new event marks
  // the state dirty. Drain both the in-flight write and any pending follow-up
  // before the caller records an event-batch checkpoint.
  while (sessionDiagnosticsSaveInFlight || sessionDiagnosticsSavePending) {
    if (sessionDiagnosticsSaveInFlight) {
      const inFlight = sessionDiagnosticsSaveInFlight;
      await inFlight;
      continue;
    }
    if (sessionDiagnosticsSaveTimer) {
      clearTimeout(sessionDiagnosticsSaveTimer);
      sessionDiagnosticsSaveTimer = null;
    }
    sessionDiagnosticsSavePending = false;
    let saveFailed = false;
    const savePromise = Promise.resolve()
      .then(() => saveSessionDiagnostics())
      .then(() => {
        sessionDiagnosticsSaveError = null;
        sessionDiagnosticsNeedsNormalization = false;
      })
      .catch((error) => {
        sessionDiagnosticsSaveError = error;
        sessionDiagnosticsSavePending = true;
        saveFailed = true;
        console.warn(`[relay] failed to save session diagnostics: ${error.message}`);
      });
    sessionDiagnosticsSaveInFlight = savePromise;
    try {
      await savePromise;
    } finally {
      if (sessionDiagnosticsSaveInFlight === savePromise) {
        sessionDiagnosticsSaveInFlight = null;
      }
    }
    if (saveFailed) {
      // Preserve the dirty bit for the next explicit flush without spinning on
      // a persistent filesystem failure in this call.
      return null;
    }
  }
  return null;
}

async function flushAgentEventBatchPersistence() {
  flushSessionLogsSave();
  await flushSessionDiagnosticsSave();
  if (sessionDiagnosticsSaveError) {
    throw sessionDiagnosticsSaveError;
  }
}

const agentEventLedger = new AgentEventLedger({
  filePath: AGENT_EVENT_LEDGER_PATH,
  limit: AGENT_EVENT_BATCH_DEDUPE_LIMIT,
  autoLoad: false,
});
const inputCommandOutbox = new InputCommandOutbox({
  filePath: INPUT_COMMAND_OUTBOX_PATH,
  commandQueueTtlMs: COMMAND_QUEUE_TTL_MS,
  dedupeTtlMs: INPUT_REQUEST_DEDUPE_TTL_MS,
  entryLimit: Math.max(INPUT_REQUEST_DEDUPE_LIMIT, COMMAND_QUEUE_MAX_LENGTH),
  autoLoad: false,
});

const state = {
  hosts: new Map(),
  hostAgentLeases: new HostAgentLeaseRegistry({ ttlMs: HOST_AGENT_LEASE_TTL_MS }),
  sessions: new Map(),
  sessionAliases: new Map(),
  commandQueues: new Map(),
  subscribers: new Map(),
  sessionEventStream: new SessionEventStream({
    epoch: RELAY_INSTANCE_ID,
    ringSize: SESSION_EVENT_RING_SIZE,
  }),
  activitySnapshots: new ActivitySnapshotStore(),
  dismissedHosts: new Set(),
  sessionLogs: new Map(),
  sessionAlerts: new Map(),
  sessionRuntime: new Map(),
  sessionDiagnostics: new Map(),
  sessionRequests: new Map(),
  pendingDirectoryRequests: new Map(),
  pendingHostProbes: new Map(),
  pendingCodexUpdateRequests: new Map(),
  pendingApiTestRequests: new Map(),
  pendingApiCatalogRequests: new Map(),
  pendingBindingPreflightRequests: new Map(),
  pendingModelRequests: new Map(),
  pendingSkillRequests: new Map(),
  pendingHostSkillRequests: new Map(),
  pendingGoalRequests: new Map(),
  rebindCatalogReuse: new RebindCatalogReuseStore({
    ttlMs: REBIND_CATALOG_REUSE_TTL_MS,
    maxEntries: REBIND_CATALOG_REUSE_LIMIT,
  }),
  goalAutoApproveRequests: new Map(),
  pendingSessionDetailRequests: new Map(),
  pendingSessionSearchRequests: new Map(),
  pendingFileRequests: new Map(),
  chunkedUploads: new Map(),
  sessionDiscoveryRequests: new Map(),
  missingManagedDiscoveryRuns: new Map(),
  inputRequestCache: new Map(),
  inputRequestReservations: new Map(),
  inputRequestsInFlight: new Map(),
  pendingInputProjectionCheckpoints: new Map(),
  inputCommandOutbox,
  agentEventLedger,
  appliedAgentEventBatches: agentEventLedger.applied,
  partialAgentEventBatches: agentEventLedger.partial,
  pendingAgentEventBatches: new Map(),
  pendingUserTranscriptEchoes: new Map(),
  localAgents: new Map(),
  askpassActions: new Map(),
  connectorActionsInFlight: new Map(),
  connectors: new Map(),
  codexUpdateOperations: new Map(),
  connectorSecrets: new Map(),
  sessionCollections: new Map(),
  skillFavorites: new Map(),
  skillSources: new Map(),
  skillLibrary: new Map(),
  skillInventories: new Map(),
  skillRegistry: null,
  skillDeployments: null,
  skillAdoptions: new Map(),
  skillImports: new Map(),
  skillRefreshes: new Map(),
  skillSubscribers: new Set(),
  skillAudit: null,
  skillAutomation: null,
  sessionRecordStore: null,
  provenance: null,
  modelCatalog: null,
  sessionMetadata: new Map(),
  receivedFiles: new Map(),
  // Agents keep their last command id in memory across relay restarts, so use
  // a monotonic-ish epoch instead of restarting command ids at 1.
  nextCommandId: Date.now(),
};

function issueRebindCatalogReuseToken(input = {}) {
  return state.rebindCatalogReuse.issue(input);
}

function consumeRebindCatalogReuseToken(tokenValue, input = {}) {
  return state.rebindCatalogReuse.consume(tokenValue, input);
}

function loadPersistedRelayState() {
  state.agentEventLedger.load();
  const recoveredInputs = state.inputCommandOutbox.load();
  for (const entry of recoveredInputs.pendingCommands) {
    const queue = state.commandQueues.get(entry.hostId) || [];
    if (!queue.some((command) => Number(command?.id || 0) === entry.originalCommandId)) {
      queue.push(entry.command);
    }
    state.commandQueues.set(entry.hostId, pruneCommandQueue(queue));
  }
  for (const cacheRecord of recoveredInputs.cacheRecords) {
    state.inputRequestCache.set(cacheRecord.cacheKey, {
      createdAtMs: cacheRecord.createdAtMs,
      fingerprint: cacheRecord.fingerprint,
      hostId: cacheRecord.hostId,
      scopeKey: cacheRecord.scopeKey,
      clientRequestId: cacheRecord.clientRequestId,
      payload: cacheRecord.payload,
    });
  }
  state.nextCommandId = Math.max(
    state.nextCommandId,
    Number(recoveredInputs.maxCommandId || 0) + 1
  );
  state.dismissedHosts = loadDismissedHosts();
  state.codexUpdateOperations = loadCodexUpdateOperations();
  state.sessionLogs = loadSessionLogs();
  reconcileRecoveredInputTranscriptProjections(recoveredInputs.projectionWork || []);
  state.sessionDiagnostics = loadSessionDiagnostics();
  state.connectorSecrets = loadConnectorSecrets(CONNECTOR_SECRETS_PATH);
  state.skillFavorites = loadSkillFavorites();
  state.skillSources = loadSkillSources();
  state.skillLibrary = loadSkillLibrary();
  state.skillInventories = loadSkillInventories();
  state.skillRegistry = new SkillRegistryService({
    registryPath: SKILL_REGISTRY_PATH,
    artifactRoot: SKILL_ARTIFACT_ROOT,
    now: nowIso,
  });
  state.skillDeployments = new SkillDeploymentService({
    statePath: SKILL_DEPLOYMENTS_PATH,
    now: nowIso,
    historyLimit: SKILL_DEPLOYMENT_HISTORY_LIMIT,
  });
  state.sessionMetadata = loadSessionMetadata();
  state.receivedFiles = loadReceivedFiles();

  state.connectors.clear();
  for (const connector of loadConnectors(CONNECTORS_PATH)) {
    state.connectors.set(connector.connectorId, connector);
  }

  state.sessionCollections.clear();
  for (const collection of loadSessionCollections()) {
    state.sessionCollections.set(collection.collectionId, collection);
  }
  if (!state.sessionCollections.has(DEFAULT_COLLECTION_ID)) {
    state.sessionCollections.set(DEFAULT_COLLECTION_ID, normalizeSessionCollection({
      collectionId: DEFAULT_COLLECTION_ID,
      name: 'Default',
      system: true,
      items: [],
    }));
  }
  ensureTrashCollection();
  seedSessionMetadataFromCollections();
}

function normalizeCatalogSkill(input = {}, sourceId = '') {
  const skillId = String(input.skillId || input.id || input.name || '').trim();
  if (!skillId || skillId.includes('/') || skillId.includes('\\')) {
    return null;
  }
  const name = String(input.name || skillId).trim() || skillId;
  const description = String(input.description || '').trim();
  const source = String(input.source || sourceId || 'custom').trim() || 'custom';
  const markdown = String(input.markdown || input.content || '').trim();
  return {
    skillId,
    name,
    description,
    source,
    sourceId: sourceId || input.sourceId || source,
    installed: false,
    readonly: false,
    trending: Boolean(input.trending),
    score: Number(input.score || input.trendingScore || 0) || 0,
    markdown: markdown || [
      '---',
      `name: ${skillId}`,
      `description: ${description}`,
      '---',
      '',
      `# ${name}`,
      '',
      description || 'Installed from Remote Codex Skills Manager.',
      '',
    ].join('\n'),
  };
}

const BUILTIN_SKILL_CATALOG = [
  {
    skillId: 'systematic-debugging',
    name: 'Systematic Debugging',
    description: 'A disciplined workflow for investigating bugs before changing code.',
    source: 'builtin',
    trending: true,
  },
  {
    skillId: 'test-driven-development',
    name: 'Test Driven Development',
    description: 'Write a failing test first, then implement the minimal passing code.',
    source: 'builtin',
    trending: true,
  },
  {
    skillId: 'verification-before-completion',
    name: 'Verification Before Completion',
    description: 'Run checks and gather evidence before claiming work is done.',
    source: 'builtin',
    trending: true,
  },
].map((skill) => normalizeCatalogSkill(skill, 'builtin')).filter(Boolean);

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function isClientAbortError(error) {
  return error && (
    error.code === 'ECONNRESET'
    || error.code === 'EPIPE'
    || error.message === 'aborted'
    || error.message === 'socket hang up'
  );
}

function readBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    const declaredBytes = Number(req.headers?.['content-length'] || 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      rejected = true;
      reject(new Error(`request body too large; limit is ${maxBytes} bytes`));
      req.destroy();
      return;
    }
    req.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        rejected = true;
        reject(new Error(`request body too large; limit is ${maxBytes} bytes`));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (rejected) {
        return;
      }
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

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) {
      cookies.set(name, decodeURIComponent(value));
    }
  }
  return cookies;
}

function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function getAuthTokenFromRequest(req, url) {
  const authorization = String(req.headers.authorization || '').trim();
  if (/^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, '').trim();
  }
  const headerToken = String(req.headers['x-relay-auth-token'] || '').trim();
  if (headerToken) {
    return headerToken;
  }
  const queryToken = String(url.searchParams.get('authToken') || '').trim();
  if (queryToken) {
    return queryToken;
  }
  return '';
}

function authCookieHeader(maxAgeSeconds) {
  const secure = truthyEnv(process.env.RELAY_AUTH_COOKIE_SECURE) ? '; Secure' : '';
  if (maxAgeSeconds <= 0) {
    return `${RELAY_AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${RELAY_AUTH_COOKIE_NAME}=${encodeURIComponent(currentAuthCookieValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function currentAuthCookieValue() {
  if (!RELAY_AUTH_TOKEN) {
    return '';
  }
  const accountMarker = relayAuthAccount?.passwordHash?.hash || 'no-account';
  return crypto
    .createHmac('sha256', RELAY_AUTH_TOKEN)
    .update(`remote-codex-auth-cookie-v2:${accountMarker}`)
    .digest('base64url');
}

function relayAuthStatus(req, url = null) {
  if (!RELAY_AUTH_TOKEN) {
    return { required: false, authenticated: true };
  }

  const parsedUrl = url || parseUrl(req);
  const token = getAuthTokenFromRequest(req, parsedUrl);
  if (token && constantTimeEqual(token, RELAY_AUTH_TOKEN)) {
    return { required: true, authenticated: true };
  }

  const cookieValue = parseCookies(req).get(RELAY_AUTH_COOKIE_NAME) || '';
  if (cookieValue && constantTimeEqual(cookieValue, currentAuthCookieValue())) {
    return { required: true, authenticated: true };
  }

  return { required: true, authenticated: false };
}

function relayAuthHint() {
  return RELAY_AUTH_TOKEN
    ? `${RELAY_AUTH_TOKEN.slice(0, 4)}...${RELAY_AUTH_TOKEN.slice(-4)}`
    : '';
}

function relayAuthConfig(req, url = null) {
  const status = relayAuthStatus(req, url);
  return {
    authRequired: status.required,
    authenticated: status.authenticated,
    hasAccount: Boolean(relayAuthAccount?.username),
    setupRequired: Boolean(status.required && !relayAuthAccount?.username),
    username: relayAuthAccount?.username || '',
    tokenHint: relayAuthHint(),
    tokenFile: RELAY_AUTH_TOKEN ? RELAY_AUTH_TOKEN_PATH : null,
    accountFile: RELAY_AUTH_TOKEN ? RELAY_AUTH_ACCOUNT_PATH : null,
  };
}

function requestIsPublic(req, url) {
  if (req.method === 'OPTIONS') {
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return true;
  }
  if (url.pathname === '/api/auth/config' || url.pathname === '/api/auth/login' || url.pathname === '/api/auth/setup') {
    return true;
  }
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    return true;
  }
  return false;
}

function authorizeRequest(req, res, url) {
  if (requestIsPublic(req, url)) {
    return true;
  }
  const status = relayAuthStatus(req, url);
  if (status.authenticated) {
    return true;
  }
  sendJson(res, 401, {
    error: relayAuthAccount?.username ? 'relay login is required' : 'relay setup or recovery token is required',
    authRequired: true,
    setupRequired: Boolean(!relayAuthAccount?.username),
  });
  return false;
}

function requestHasLocalRelayControlToken(req) {
  const remoteAddress = String(req.socket?.remoteAddress || '').toLowerCase();
  const loopback = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  if (!loopback || !RELAY_CONTROL_TOKEN) {
    return false;
  }
  const token = String(req.headers['x-relay-control-token'] || '').trim();
  if (!token) {
    return false;
  }
  return constantTimeEqual(token, RELAY_CONTROL_TOKEN);
}

function hostOnline(host) {
  if (!host) {
    return false;
  }
  const lastSeen = host.lastSeenAt ? Date.parse(host.lastSeenAt) : 0;
  return Date.now() - lastSeen < HOST_OFFLINE_AFTER_MS;
}

function hostHeartbeatAgeMs(host) {
  const lastSeen = host?.lastSeenAt ? Date.parse(host.lastSeenAt) : 0;
  return lastSeen ? Date.now() - lastSeen : Number.POSITIVE_INFINITY;
}

function hostHasFreshHeartbeat(host, maxAgeMs = 15_000) {
  return hostHeartbeatAgeMs(host) <= maxAgeMs;
}

function connectorAttachKey(value) {
  return String(value || '').trim().toLowerCase();
}

function attachMatchingConnectorsToHost(host) {
  const hostLabel = connectorAttachKey(host?.label);
  if (!host?.hostId || !hostLabel) {
    return false;
  }

  let changed = false;
  for (const connector of state.connectors.values()) {
    if (connector.hostId || connectorAttachKey(connector.label) !== hostLabel) {
      continue;
    }
    state.connectors.set(connector.connectorId, {
      ...connector,
      hostId: host.hostId,
      updatedAt: nowIso(),
    });
    changed = true;
  }
  if (changed) {
    persistConnectors();
  }
  return changed;
}

function getHostUnavailableError(hostId) {
  const host = state.hosts.get(hostId);
  if (!host) {
    return { statusCode: 404, error: 'host not found' };
  }
  if (!hostOnline(host)) {
    return { statusCode: 409, error: `host ${host.label || hostId} is offline` };
  }
  return null;
}

function normalizeClientRequestId(value) {
  const text = String(value || '').trim().slice(0, 160);
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}

function deterministicLaunchUuid(hostId, clientRequestId, purpose) {
  const digest = crypto.createHash('sha256')
    .update(`remote-codex-launch\0${String(purpose || '')}\0${hostId}\0${clientRequestId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedLaunchCwd(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

function managedLaunchRequestFingerprint(input = {}) {
  const body = input.body || {};
  const requestedSelection = input.requestedSelection || {};
  const apiConfig = input.apiConfig || null;
  return crypto.createHash('sha256').update(JSON.stringify({
    hostId: String(input.hostId || '').trim(),
    targetSessionId: String(input.targetSessionId || '').trim(),
    sourceSessionId: String(input.sourceSessionId || '').trim() || null,
    launchMode: String(input.launchMode || '').trim(),
    cwd: normalizedLaunchCwd(input.cwd),
    conversationKey: String(input.conversationKey || '').trim(),
    originSessionId: String(input.originSessionId || '').trim() || null,
    nativeThreadId: String(input.nativeThreadId || '').trim() || null,
    bindingFingerprint: String(input.bindingFingerprint || '').trim() || null,
    apiConfigFingerprint: rebindCatalogApiConfigFingerprint(apiConfig),
    apiProfile: apiConfig ? {
      profileId: String(apiConfig.profileId || '').trim() || null,
      providerKind: String(apiConfig.providerKind || '').trim().toLowerCase() || null,
      provider: String(apiConfig.provider || '').trim().toLowerCase() || null,
      baseUrl: String(apiConfig.baseUrl || '').trim().replace(/\/+$/, '') || null,
    } : null,
    model: String(requestedSelection.model || '').trim() || null,
    effort: String(requestedSelection.effort || '').trim() || null,
    selectionSource: String(requestedSelection.source || '').trim() || null,
    allowUnverifiedEffort: body.allowUnverifiedEffort === true,
    refreshModels: body.refreshModels === true,
    summary: String(body.summary || '').trim() || null,
    label: String(body.label || '').trim(),
    command: body.command == null ? null : body.command,
    args: Array.isArray(body.args) ? body.args : [],
  })).digest('hex');
}

function inputRequestCacheKey(hostId, sessionId, clientRequestId, runId = '') {
  const requestId = normalizeClientRequestId(clientRequestId);
  return requestId ? `${hostId}::${sessionId}::${requestId}` : '';
}

let inputSubmissionReservationOrdinal = 0;

function nextInputSubmissionReservationOrdinal() {
  inputSubmissionReservationOrdinal += 1;
  return inputSubmissionReservationOrdinal;
}

function inputRequestConflictError(message = '') {
  return new SessionContractError(
    'input_request_id_conflict',
    message || 'The same clientRequestId was reused with different prompt content.',
    { statusCode: 409 }
  );
}

function inputReservationConflictError() {
  return new SessionContractError(
    'session_input_identity_conflict',
    'The Session identity changed while multiple prompts were being prepared. The conflicting prompt was not queued.',
    { statusCode: 409 }
  );
}

function earlierInputReservation(left, right) {
  const leftOrdinal = Number(left?.ordinal || Number.MAX_SAFE_INTEGER);
  const rightOrdinal = Number(right?.ordinal || Number.MAX_SAFE_INTEGER);
  return leftOrdinal <= rightOrdinal ? left : right;
}

function pruneInputRequestCache() {
  const now = Date.now();
  for (const [key, entry] of state.inputRequestCache.entries()) {
    if (!entry?.createdAtMs || now - entry.createdAtMs > INPUT_REQUEST_DEDUPE_TTL_MS) {
      state.inputRequestCache.delete(key);
    }
  }
  while (state.inputRequestCache.size > INPUT_REQUEST_DEDUPE_LIMIT) {
    const oldestKey = state.inputRequestCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    state.inputRequestCache.delete(oldestKey);
  }
}

function getCachedInputRequest(cacheKey, fingerprint = '') {
  if (!cacheKey) {
    return null;
  }
  pruneInputRequestCache();
  const entry = state.inputRequestCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.createdAtMs > INPUT_REQUEST_DEDUPE_TTL_MS) {
    state.inputRequestCache.delete(cacheKey);
    return null;
  }
  if (entry.conflictCode) {
    throw new SessionContractError(
      entry.conflictCode,
      entry.conflictMessage || 'Conflicting input requests were found while the Session identity changed.',
      { statusCode: 409 }
    );
  }
  if (fingerprint && entry.fingerprint && entry.fingerprint !== fingerprint) {
    throw inputRequestConflictError();
  }
  return entry.payload || null;
}

function rememberInputRequest(cacheKey, fingerprint, payload, identity = {}) {
  if (!cacheKey) {
    return;
  }
  pruneInputRequestCache();
  state.inputRequestCache.set(cacheKey, {
    createdAtMs: Date.now(),
    fingerprint,
    payload,
    hostId: String(identity.hostId || '').trim(),
    scopeKey: String(identity.scopeKey || '').trim(),
    clientRequestId: normalizeClientRequestId(identity.clientRequestId) || null,
  });
}

function inputRequestFingerprint(body = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    text: String(body.text || ''),
    displayText: String(body.displayText || ''),
    inputItems: Array.isArray(body.inputItems) ? body.inputItems : [],
    uploadedFiles: Array.isArray(body.uploadedFiles) ? body.uploadedFiles : [],
    inlineFiles: Array.isArray(body.inlineFiles) ? body.inlineFiles : [],
    inlineFileRefs: Array.isArray(body.inlineFileRefs) ? body.inlineFileRefs : [],
    mode: String(body.mode || ''),
    model: String(body.model || ''),
    effort: String(body.effort || ''),
    allowUnverifiedEffort: body.allowUnverifiedEffort === true,
    summary: String(body.summary || ''),
    approvalPolicy: body.approvalPolicy || null,
    approvalsReviewer: String(body.approvalsReviewer || ''),
    sandboxMode: String(body.sandboxMode || ''),
    planFallback: String(body.planFallback || ''),
    serviceTier: String(body.serviceTier || ''),
    personality: String(body.personality || ''),
  })).digest('hex');
}

function reserveInputRequest(cacheKey, fingerprint, identity = {}) {
  const ordinal = nextInputSubmissionReservationOrdinal();
  if (!cacheKey) {
    return {
      owner: true,
      cacheKey: '',
      fingerprint,
      promise: null,
      ordinal,
      hostId: String(identity.hostId || '').trim(),
      scopeKey: String(identity.scopeKey || '').trim(),
      clientRequestId: null,
      keys: new Set(),
    };
  }
  const existing = state.inputRequestsInFlight.get(cacheKey);
  if (existing) {
    if (existing.cancelledError) throw existing.cancelledError;
    if (existing.fingerprint !== fingerprint) {
      throw inputRequestConflictError();
    }
    return { ...existing, owner: false };
  }
  let resolveRequest;
  let rejectRequest;
  const promise = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  promise.catch(() => {});
  const reservation = {
    owner: true,
    cacheKey,
    fingerprint,
    promise,
    resolveRequest,
    rejectRequest,
    createdAtMs: Date.now(),
    ordinal,
    hostId: String(identity.hostId || '').trim(),
    scopeKey: String(identity.scopeKey || '').trim(),
    clientRequestId: normalizeClientRequestId(identity.clientRequestId) || null,
    keys: new Set([cacheKey]),
    cancelledError: null,
    settled: false,
  };
  state.inputRequestsInFlight.set(cacheKey, reservation);
  return reservation;
}

function settleInputRequest(reservation, error, payload = null) {
  if (!reservation?.cacheKey) return;
  if (reservation.settled) return;
  reservation.settled = true;
  for (const key of reservation.keys || [reservation.cacheKey]) {
    if (state.inputRequestsInFlight.get(key) === reservation) {
      state.inputRequestsInFlight.delete(key);
    }
  }
  if (error) reservation.rejectRequest(error);
  else reservation.resolveRequest(payload);
}

function inputRequestPayloadCommandId(entry) {
  const id = Number(entry?.payload?.command?.id || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function migrateInputRequestCacheScope(loserKey, winnerKey) {
  for (const [cacheKey, entry] of Array.from(state.inputRequestCache.entries())) {
    if (!entry || entry.scopeKey !== loserKey || !entry.hostId || !entry.clientRequestId) continue;
    const nextKey = inputRequestCacheKey(entry.hostId, winnerKey, entry.clientRequestId);
    if (!nextKey || nextKey === cacheKey) {
      entry.scopeKey = winnerKey;
      continue;
    }
    const existing = state.inputRequestCache.get(nextKey);
    state.inputRequestCache.delete(cacheKey);
    entry.scopeKey = winnerKey;
    if (!existing || existing === entry) {
      state.inputRequestCache.set(nextKey, entry);
      continue;
    }
    const sameFingerprint = Boolean(
      entry.fingerprint
      && existing.fingerprint
      && entry.fingerprint === existing.fingerprint
    );
    const entryCommandId = inputRequestPayloadCommandId(entry);
    const existingCommandId = inputRequestPayloadCommandId(existing);
    if (sameFingerprint && (!entryCommandId || !existingCommandId || entryCommandId === existingCommandId)) {
      const preferred = existing.payload ? existing : entry;
      preferred.scopeKey = winnerKey;
      preferred.createdAtMs = Math.min(
        Number(existing.createdAtMs || Date.now()),
        Number(entry.createdAtMs || Date.now())
      );
      state.inputRequestCache.set(nextKey, preferred);
      continue;
    }
    state.inputRequestCache.set(nextKey, {
      ...existing,
      scopeKey: winnerKey,
      createdAtMs: Math.min(
        Number(existing.createdAtMs || Date.now()),
        Number(entry.createdAtMs || Date.now())
      ),
      conflictCode: sameFingerprint
        ? 'session_input_identity_conflict'
        : 'input_request_id_conflict',
      conflictMessage: sameFingerprint
        ? 'The same prompt was already queued under conflicting Session identities.'
        : 'The same clientRequestId was reused with different prompt content.',
    });
  }
}

function migrateInputRequestsInFlightScope(loserKey, winnerKey) {
  const reservations = [...new Set(state.inputRequestsInFlight.values())];
  for (const reservation of reservations) {
    if (
      !reservation
      || reservation.scopeKey !== loserKey
      || !reservation.hostId
      || !reservation.clientRequestId
    ) {
      continue;
    }
    const previousKey = reservation.cacheKey;
    const nextKey = inputRequestCacheKey(
      reservation.hostId,
      winnerKey,
      reservation.clientRequestId
    );
    if (!nextKey || nextKey === previousKey) {
      reservation.scopeKey = winnerKey;
      continue;
    }
    const existing = state.inputRequestsInFlight.get(nextKey);
    if (!existing || existing === reservation) {
      if (state.inputRequestsInFlight.get(previousKey) === reservation) {
        state.inputRequestsInFlight.delete(previousKey);
      }
      reservation.cacheKey = nextKey;
      reservation.scopeKey = winnerKey;
      reservation.keys?.add(nextKey);
      state.inputRequestsInFlight.set(nextKey, reservation);
      continue;
    }

    const primary = earlierInputReservation(reservation, existing);
    const secondary = primary === reservation ? existing : reservation;
    const conflict = reservation.fingerprint === existing.fingerprint
      ? inputReservationConflictError()
      : inputRequestConflictError();
    secondary.cancelledError ||= conflict;
    if (state.inputRequestsInFlight.get(previousKey) === reservation) {
      state.inputRequestsInFlight.delete(previousKey);
    }
    for (const key of secondary.keys || []) {
      if (state.inputRequestsInFlight.get(key) === secondary) {
        state.inputRequestsInFlight.delete(key);
      }
    }
    primary.cacheKey = nextKey;
    primary.scopeKey = winnerKey;
    primary.keys?.add(nextKey);
    state.inputRequestsInFlight.set(nextKey, primary);
  }
}

function migrateSessionInputReservationScope(loserKey, winnerKey) {
  const reservation = state.inputRequestReservations.get(loserKey);
  if (!reservation) return;
  const existing = state.inputRequestReservations.get(winnerKey);
  if (!existing || existing === reservation) {
    if (state.inputRequestReservations.get(loserKey) === reservation) {
      state.inputRequestReservations.delete(loserKey);
    }
    reservation.key = winnerKey;
    reservation.keys?.add(winnerKey);
    state.inputRequestReservations.set(winnerKey, reservation);
    return;
  }

  const primary = earlierInputReservation(reservation, existing);
  const secondary = primary === reservation ? existing : reservation;
  secondary.cancelledError ||= inputReservationConflictError();
  if (state.inputRequestReservations.get(loserKey) === reservation) {
    state.inputRequestReservations.delete(loserKey);
  }
  for (const key of secondary.keys || []) {
    if (state.inputRequestReservations.get(key) === secondary) {
      state.inputRequestReservations.delete(key);
    }
  }
  primary.key = winnerKey;
  primary.keys?.add(winnerKey);
  state.inputRequestReservations.set(winnerKey, primary);
}

function migrateInputRequestScope(loserKey, winnerKey) {
  const loser = String(loserKey || '').trim();
  const winner = String(winnerKey || '').trim();
  if (!loser || !winner || loser === winner) return;
  const separator = loser.indexOf('::');
  const winnerSeparator = winner.indexOf('::');
  const hostId = separator > 0 ? loser.slice(0, separator) : '';
  const winnerHostId = winnerSeparator > 0 ? winner.slice(0, winnerSeparator) : '';
  if (hostId && winnerHostId === hostId) {
    state.inputCommandOutbox.migrateScope(hostId, loser, winner);
  }
  migrateInputRequestCacheScope(loser, winner);
  migrateInputRequestsInFlightScope(loser, winner);
  migrateSessionInputReservationScope(loser, winner);
}

function inputSessionScopeKey(hostId, sessionId) {
  return resolveCanonicalConversationKey(hostId, sessionId)
    || resolveSessionKey(hostId, sessionId)
    || sessionKey(hostId, sessionId);
}

function reserveSessionInput(hostId, sessionId, runId, clientRequestId, scopeKey = '', ordinal = 0) {
  const key = scopeKey || inputSessionScopeKey(hostId, sessionId);
  const existing = state.inputRequestReservations.get(key);
  if (existing) {
    return {
      ok: false,
      code: 'session_input_preparing',
      error: 'A prompt for this Session is already being prepared. Wait for it to be queued before trying again.',
      clientRequestId: existing.clientRequestId || null,
    };
  }

  const runtimeKey = resolveSessionKey(hostId, sessionId);
  const runtime = state.sessionRuntime.get(runtimeKey)
    || state.sessionRuntime.get(key)
    || {};
  const phase = String(runtime.phase || '').trim().toLowerCase();
  if (phase === 'stop-failed') {
    return {
      ok: false,
      code: 'session_stop_failed',
      error: 'The previous Stop failed and this runtime cannot accept new prompts. Retry Stop, then Resume the Session.',
      phase,
    };
  }
  const terminalPhase = ['idle', 'completed', 'error', 'interrupted', 'closed', 'stop-failed'].includes(phase);
  const pending = Boolean(
    runtime.busy === true
    || runtime.activeTurnId
    || runtime.waitingOnApproval === true
    || runtime.waitingOnUserInput === true
    || (runtime.queuedCommandId && !terminalPhase)
  );
  if (pending) {
    return {
      ok: false,
      code: 'session_turn_active',
      error: 'Codex is still working on the previous turn. Wait for it to finish or interrupt it before sending another prompt.',
      queuedCommandId: runtime.queuedCommandId || null,
      phase: runtime.phase || null,
      activeTurnId: runtime.activeTurnId || null,
      busy: runtime.busy === true,
    };
  }

  const reservation = {
    ok: true,
    key,
    keys: new Set([key]),
    token: makeId(),
    ordinal: Number(ordinal || 0) || nextInputSubmissionReservationOrdinal(),
    hostId: String(hostId || '').trim(),
    sessionId: String(sessionId || '').trim(),
    runId: String(runId || '').trim() || null,
    runtimeKey,
    runtimeRevision: normalizedRuntimeRevision(runtime),
    runtimeRunId: String(runtime.runId || '').trim() || null,
    clientRequestId: normalizeClientRequestId(clientRequestId) || null,
    cancelledError: null,
  };
  state.inputRequestReservations.set(key, reservation);
  return reservation;
}

function releaseSessionInputReservation(reservation) {
  if (!reservation?.ok || !reservation.key) return false;
  let released = false;
  for (const key of reservation.keys || [reservation.key]) {
    const current = state.inputRequestReservations.get(key);
    if (current?.token !== reservation.token) continue;
    state.inputRequestReservations.delete(key);
    released = true;
  }
  return released;
}

function assertInputSubmissionOwnership(hostId, sessionId, requestReservation, inputReservation) {
  const currentScopeKey = inputSessionScopeKey(hostId, sessionId);
  if (currentScopeKey && currentScopeKey !== inputReservation.key) {
    migrateInputRequestScope(inputReservation.key, currentScopeKey);
  }
  if (requestReservation?.cancelledError) throw requestReservation.cancelledError;
  if (
    requestReservation?.cacheKey
    && state.inputRequestsInFlight.get(requestReservation.cacheKey) !== requestReservation
  ) {
    throw inputReservationConflictError();
  }
  if (inputReservation?.cancelledError) throw inputReservation.cancelledError;
  const current = state.inputRequestReservations.get(inputReservation.key);
  if (!current || current.token !== inputReservation.token) {
    throw inputReservationConflictError();
  }
  return true;
}

function assertInputRuntimeStillAvailable(hostId, sessionId, expectedRunId, inputReservation) {
  const runtimeKey = resolveSessionKey(hostId, sessionId);
  const runtime = state.sessionRuntime.get(runtimeKey)
    || state.sessionRuntime.get(inputReservation?.key)
    || {};
  const phase = String(runtime.phase || '').trim().toLowerCase();
  if (phase === 'stop-failed') {
    throw new SessionContractError(
      'session_stop_failed',
      'The previous Stop failed and this runtime cannot accept new prompts. Retry Stop, then Resume the Session.',
      { statusCode: 409, phase }
    );
  }
  const terminalPhase = ['idle', 'completed', 'error', 'interrupted', 'closed', 'stop-failed'].includes(phase);
  const pending = Boolean(
    runtime.busy === true
    || runtime.activeTurnId
    || runtime.waitingOnApproval === true
    || runtime.waitingOnUserInput === true
    || (runtime.queuedCommandId && !terminalPhase)
  );
  if (pending) {
    throw new SessionContractError(
      'session_turn_active',
      'Codex started another turn while this prompt was being prepared. Wait for it to finish or interrupt it before retrying.',
      {
        statusCode: 409,
        queuedCommandId: runtime.queuedCommandId || null,
        phase: runtime.phase || null,
        activeTurnId: runtime.activeTurnId || null,
        busy: runtime.busy === true,
      }
    );
  }

  const expected = String(expectedRunId || '').trim();
  const capturedRunId = String(inputReservation?.runtimeRunId || '').trim();
  const currentRunId = String(runtime.runId || '').trim();
  const capturedRevision = Number(inputReservation?.runtimeRevision || 0);
  const currentRevision = normalizedRuntimeRevision(runtime);
  if (
    capturedRunId !== currentRunId
    || capturedRevision !== currentRevision
  ) {
    throw new SessionContractError(
      'session_runtime_changed',
      'The Session runtime changed while this prompt was being prepared. Review the current state and retry.',
      {
        statusCode: 409,
        expectedRunId: expected || null,
        capturedRuntimeRunId: capturedRunId || null,
        currentRunId: currentRunId || null,
        expectedRuntimeRevision: capturedRevision || null,
        currentRuntimeRevision: currentRevision || null,
      }
    );
  }
}

function getHostCapabilityError(hostId, capability, message) {
  const hostError = getHostUnavailableError(hostId);
  if (hostError) {
    return hostError;
  }
  const host = state.hosts.get(hostId);
  if (!host?.capabilities?.[capability]) {
    return {
      statusCode: 409,
      error: message || `this host agent needs to be restarted before it can use ${capability}`,
    };
  }
  return null;
}

function hostSupportsCapability(hostId, capability) {
  return Boolean(state.hosts.get(hostId)?.capabilities?.[capability]);
}

function getHostList() {
  ensureLocalRelayHost();
  return Array.from(state.hosts.values()).map((host) => ({
    ...host,
    codexRuntime: normalizeHostCodexRuntime(host.codexRuntime),
    codexMaintenance: normalizeHostCodexMaintenance(host.codexMaintenance),
    codexUpdate: publicCodexUpdateOperation(currentCodexUpdateOperation(host.hostId)),
    online: hostOnline(host),
    localAgentStartEnabled: LOCAL_AGENT_START_ENABLED,
    localAgent: publicLocalAgentRecord(state.localAgents.get(host.hostId)),
    sessionCount: Array.from(state.sessions.values()).filter((session) => session.hostId === host.hostId).length,
    liveSessionCount: Array.from(state.sessions.values()).filter((session) => session.hostId === host.hostId && session.live).length,
    managedLiveSessionCount: getRelayManagedLiveSessions(host.hostId).length,
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function publicSkillHostRecord(host) {
  return {
    hostId: host.hostId,
    label: host.label || host.hostId,
    online: hostOnline(host),
    codexHome: host.codexHome || host.runtime?.codexHome || '',
    skillsRevision: host.skillsRevision || state.skillInventories.get(host.hostId)?.revision || null,
    capabilities: host.capabilities || {},
  };
}

function buildSkillCatalogFromSources() {
  const byId = new Map();
  for (const skill of BUILTIN_SKILL_CATALOG) {
    byId.set(skill.skillId, skill);
  }
  for (const source of state.skillSources.values ? state.skillSources.values() : state.skillSources) {
    if (!source?.enabled) {
      continue;
    }
    for (const skill of source.skills || []) {
      const normalized = normalizeCatalogSkill(skill, source.sourceId);
      if (!normalized) {
        continue;
      }
      byId.set(normalized.skillId, {
        ...normalized,
        source: source.name || normalized.source,
        sourceId: source.sourceId,
      });
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.name).localeCompare(String(b.name)));
}

function skillRegistrySnapshot() {
  return state.skillRegistry.snapshot({ includeManifest: false });
}

function combinedSkillSources(registrySnapshot = skillRegistrySnapshot()) {
  const byId = new Map();
  for (const source of state.skillSources.values ? state.skillSources.values() : state.skillSources) {
    if (source?.sourceId) {
      byId.set(source.sourceId, { ...source });
    }
  }
  for (const source of registrySnapshot.sources || []) {
    if (!source?.sourceId) {
      continue;
    }
    byId.set(source.sourceId, {
      ...(byId.get(source.sourceId) || {}),
      ...source,
      url: source.locator || byId.get(source.sourceId)?.url || '',
      skills: byId.get(source.sourceId)?.skills || [],
      registry: true,
    });
  }
  return Array.from(byId.values()).sort((left, right) => (
    String(left.name || left.sourceId).localeCompare(String(right.name || right.sourceId))
  ));
}

function combinedSkillLibrary(registrySnapshot = skillRegistrySnapshot()) {
  const byId = new Map();
  for (const record of state.skillLibrary || []) {
    if (record?.skillId) {
      byId.set(record.skillId, { ...record });
    }
  }
  for (const record of registrySnapshot.library || []) {
    if (!record?.skillId) {
      continue;
    }
    const existing = byId.get(record.skillId) || {};
    const latestVersion = (record.versions || []).find((version) => (
      version.artifactId === record.latestArtifactId
    )) || record.versions?.[record.versions.length - 1] || null;
    byId.set(record.skillId, {
      ...existing,
      ...record,
      source: latestVersion?.sourceKind || existing.source || 'registry',
      sourceUrl: latestVersion?.sourceLocator || existing.sourceUrl || '',
      installed: false,
      readonly: false,
      archived: record.archived === true,
      retiredAt: record.retiredAt || null,
      registry: true,
    });
  }
  return Array.from(byId.values()).sort((left, right) => (
    String(left.name || left.skillId).localeCompare(String(right.name || right.skillId))
  ));
}

function compareSkillArtifactReferences(left, right) {
  return String(left.artifactId || '').localeCompare(String(right.artifactId || ''))
    || String(left.kind || '').localeCompare(String(right.kind || ''))
    || String(left.skillId || '').localeCompare(String(right.skillId || ''))
    || String(left.hostId || '').localeCompare(String(right.hostId || ''))
    || String(left.scope || '').localeCompare(String(right.scope || ''))
    || String(left.scopeId || '').localeCompare(String(right.scopeId || ''))
    || String(left.deploymentId || '').localeCompare(String(right.deploymentId || ''))
    || String(left.state || '').localeCompare(String(right.state || ''));
}

function canonicalInventorySkillId(value) {
  try {
    return normalizePortableSkillId(value);
  } catch (_) {
    return null;
  }
}

function collectSkillArtifactReferences(registrySnapshot = skillRegistrySnapshot()) {
  const artifacts = Array.isArray(registrySnapshot.artifacts) ? registrySnapshot.artifacts : [];
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const references = [];
  for (const reference of state.skillDeployments.artifactReferences()) {
    if (reference.artifactId) {
      references.push({ ...reference });
      continue;
    }
    for (const artifact of artifacts) {
      const skillIds = Array.isArray(artifact.skillIds)
        ? artifact.skillIds
        : [artifact.skillId].filter(Boolean);
      if (skillIds.includes(reference.skillId)) {
        references.push({ ...reference, artifactId: artifact.artifactId });
      }
    }
  }
  for (const inventory of state.skillInventories.values()) {
    if (inventory?.incomplete) {
      for (const artifact of artifacts) {
        if (artifact.storageState === 'collected') {
          continue;
        }
        references.push({
          kind: 'inventory-uncertain',
          artifactId: artifact.artifactId,
          skillId: null,
          hostId: inventory.hostId,
          scope: null,
          scopeId: null,
          deploymentId: null,
          state: 'scan-error',
        });
      }
    }
    const referenceInstances = Array.isArray(inventory?.referenceInstances)
      ? inventory.referenceInstances
      : Array.isArray(inventory?.instances) ? inventory.instances : [];
    for (const instance of referenceInstances) {
      const desiredArtifactId = String(instance?.desiredArtifactId || '').trim().toLowerCase();
      const observedHash = String(instance?.observedHash || '').trim().toLowerCase();
      const artifactIds = Array.from(new Set(
        (instance?.managed ? [desiredArtifactId, observedHash] : [observedHash])
          .filter((artifactId) => /^sha256:[a-f0-9]{64}$/.test(artifactId))
      ));
      for (const artifactId of artifactIds) {
        const artifact = artifactsById.get(artifactId);
        if (!artifact) {
          continue;
        }
        const instanceSkillId = canonicalInventorySkillId(instance.skillId);
        const skillIds = Array.isArray(artifact.skillIds)
          ? artifact.skillIds
          : [artifact.skillId].filter(Boolean);
        const matchedSkillId = skillIds.find((skillId) => skillId === instanceSkillId) || null;
        if (!instance.managed && !(artifact.sources || []).some((source) => (
          source?.sourceId === instance.sourceId
        ))) {
          continue;
        }
        references.push({
          kind: 'host-inventory',
          artifactId,
          skillId: matchedSkillId,
          hostId: instance.hostId || inventory.hostId,
          scope: instance.scope,
          scopeId: instance.scopeId,
          deploymentId: null,
          state: instance.state || (instance.enabled === false ? 'disabled' : 'enabled'),
        });
      }
    }
  }
  const deduplicated = new Map();
  for (const reference of references) {
    const key = JSON.stringify([
      reference.artifactId || '',
      reference.kind || '',
      reference.skillId || '',
      reference.hostId || '',
      reference.scope || '',
      reference.scopeId || '',
      reference.deploymentId || '',
      reference.state || '',
    ]);
    deduplicated.set(key, reference);
  }
  return Array.from(deduplicated.values()).sort(compareSkillArtifactReferences);
}

function publicSkillArtifact(record) {
  if (!record) {
    return null;
  }
  const { archivePath, ...publicRecord } = record;
  return publicRecord;
}

function publicSkillAdoption(record) {
  if (!record) {
    return null;
  }
  const { uploadToken, ...publicRecord } = record;
  return { ...publicRecord };
}

function publicSkillImport(record) {
  return record ? { ...record } : null;
}

function pruneSkillAdoptions() {
  const cutoff = Date.now() - SKILL_ADOPTION_RETENTION_MS;
  for (const [adoptionId, adoption] of state.skillAdoptions.entries()) {
    const updatedAt = Date.parse(adoption.updatedAt || adoption.createdAt || '');
    if (
      adoption.state !== 'queued'
      && adoption.state !== 'uploading'
      && Number.isFinite(updatedAt)
      && updatedAt < cutoff
    ) {
      state.skillAdoptions.delete(adoptionId);
    }
  }
  while (state.skillAdoptions.size > SKILL_OPERATION_HISTORY_LIMIT) {
    const removable = Array.from(state.skillAdoptions.entries()).find(([, adoption]) => (
      adoption.state !== 'queued' && adoption.state !== 'uploading'
    ));
    if (!removable) {
      break;
    }
    state.skillAdoptions.delete(removable[0]);
  }
}

function publicSkillAdoptions() {
  pruneSkillAdoptions();
  return Array.from(state.skillAdoptions.values())
    .map(publicSkillAdoption)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function pruneSkillImports() {
  const cutoff = Date.now() - SKILL_ADOPTION_RETENTION_MS;
  for (const [importId, record] of state.skillImports.entries()) {
    const updatedAt = Date.parse(record.updatedAt || record.createdAt || '');
    if (
      record.state !== 'queued'
      && record.state !== 'downloading'
      && record.state !== 'validating'
      && Number.isFinite(updatedAt)
      && updatedAt < cutoff
    ) {
      state.skillImports.delete(importId);
    }
  }
  while (state.skillImports.size > SKILL_OPERATION_HISTORY_LIMIT) {
    const removable = Array.from(state.skillImports.entries()).find(([, record]) => (
      record.state !== 'queued' && record.state !== 'downloading' && record.state !== 'validating'
    ));
    if (!removable) {
      break;
    }
    state.skillImports.delete(removable[0]);
  }
}

function publicSkillImports() {
  pruneSkillImports();
  return Array.from(state.skillImports.values())
    .map(publicSkillImport)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function mergeSkillLibraryWithCatalog(catalog, registrySnapshot = null) {
  const byId = new Map((catalog || []).map((skill) => [skill.skillId, skill]));
  for (const record of combinedSkillLibrary(registrySnapshot || skillRegistrySnapshot())) {
    if (!record?.skillId) {
      continue;
    }
    if (record.archived) {
      byId.delete(record.skillId);
      continue;
    }
    const existing = byId.get(record.skillId) || {};
    byId.set(record.skillId, {
      ...record,
      ...existing,
      skillId: record.skillId,
      name: existing.name || record.name,
      description: existing.description || record.description,
      sourceUrl: existing.sourceUrl || record.sourceUrl,
      source: existing.source || record.source,
      lastInstalledHostIds: record.lastInstalledHostIds || [],
      library: true,
    });
  }
  return Array.from(byId.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.name).localeCompare(String(b.name)));
}

function dailySkillDigest(catalog) {
  const today = new Date().toISOString().slice(0, 10);
  const recommendations = (catalog || [])
    .filter((skill) => skill.trending || Number(skill.score || 0) > 0)
    .slice(0, 5)
    .map((skill) => ({
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      score: Number(skill.score || 0) || 0,
    }));
  return {
    date: today,
    title: recommendations.length ? 'Daily skills picks' : 'No skills picks yet',
    recommendations,
  };
}

async function requestHostSkillsList(hostId) {
  const host = state.hosts.get(hostId);
  if (!host || !hostOnline(host)) {
    return [];
  }
  if (!host.capabilities?.hostSkills) {
    return [];
  }
  const requestId = makeId();
  enqueueCommand(hostId, {
    type: 'host.skills.list',
    requestId,
  });
  const result = await awaitHostSkillRequest(requestId, 12000);
  return Array.isArray(result.skills) ? result.skills : [];
}

async function buildSkillsManagerPayload() {
  const hosts = getHostList().map(publicSkillHostRecord);
  const favorites = Array.from(state.skillFavorites);
  const favoriteSet = new Set(favorites);
  const registrySnapshot = skillRegistrySnapshot();
  const catalog = mergeSkillLibraryWithCatalog(buildSkillCatalogFromSources(), registrySnapshot);
  const decorate = (skill) => ({
    ...skill,
    favorite: favoriteSet.has(skill.skillId),
  });
  const cachedInstances = [];
  const inventories = hosts.map((host) => {
    const cached = state.skillInventories.get(host.hostId) || null;
    if (cached) {
      cachedInstances.push(...cached.instances.map((instance) => ({ ...instance })));
    }
    const receivedAtMs = cached?.receivedAt ? Date.parse(cached.receivedAt) : Number.NaN;
    return {
      hostId: host.hostId,
      revision: cached?.revision || null,
      scannedAt: cached?.scannedAt || null,
      receivedAt: cached?.receivedAt || null,
      stale: !cached || !Number.isFinite(receivedAtMs) || Date.now() - receivedAtMs > 60000,
      incomplete: cached?.incomplete === true,
      refreshing: hasPendingSkillRefresh(host.hostId),
      scanErrors: cached?.scanErrors || [],
    };
  });
  const hostById = new Map(hosts.map((host) => [host.hostId, host]));
  const legacyInstalledProjection = cachedInstances
    .filter((instance) => instance.scope === 'user' && instance.enabled !== false)
    .map((instance) => {
      const host = hostById.get(instance.hostId) || {};
      return decorate({
        ...instance,
        installed: true,
        installPath: instance.activationPath,
        codexHome: host.codexHome || '',
        source: instance.sourceKind || instance.sourceId || 'host-inventory',
      });
    });
  return {
    hosts,
    inventories,
    instances: cachedInstances.map(decorate),
    installed: legacyInstalledProjection,
    catalog: catalog.map(decorate),
    favorites,
    sources: combinedSkillSources(registrySnapshot),
    skillLibrary: combinedSkillLibrary(registrySnapshot),
    registryRevision: registrySnapshot.revision,
    artifacts: (registrySnapshot.artifacts || []).map(publicSkillArtifact),
    adoptions: publicSkillAdoptions(),
    imports: publicSkillImports(),
    deployments: state.skillDeployments.deploymentSummaries(SKILL_DEPLOYMENT_SUMMARY_LIMIT),
    desiredSkillStates: state.skillDeployments.desiredStates(),
    appliedSkillStates: state.skillDeployments.appliedStates(),
    dailySkillDigest: dailySkillDigest(catalog),
  };
}

function hasPendingSkillRefresh(hostId) {
  const pending = state.skillRefreshes.get(hostId);
  if (!pending) {
    return false;
  }
  if (Date.now() - pending.queuedAtMs > 60000) {
    state.skillRefreshes.delete(hostId);
    return false;
  }
  return true;
}

function knownSkillWorkspaceRoots(hostId) {
  const roots = [];
  const seen = new Set();
  for (const session of state.sessions.values()) {
    if (session?.hostId !== hostId) {
      continue;
    }
    const cwd = String(session.cwd || '').trim();
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    roots.push(cwd);
  }
  return roots.sort();
}

function skillArtifactSupportsSkill(artifact, skillId) {
  const supported = new Set([
    artifact?.skillId,
    ...(Array.isArray(artifact?.skillIds) ? artifact.skillIds : []),
  ].map((value) => String(value || '').trim()).filter(Boolean));
  return supported.has(String(skillId || '').trim());
}

function queuedSkillDeploymentCommand(hostId, deploymentId) {
  return (state.commandQueues.get(hostId) || []).find((command) => (
    command?.type === 'host.skills.deployment.apply'
    && command.deploymentId === deploymentId
  )) || null;
}

function acknowledgeQueuedSkillDeploymentCommand(hostId, deploymentId) {
  const queue = state.commandQueues.get(hostId) || [];
  const next = queue.filter((command) => !(
    command?.type === 'host.skills.deployment.apply'
    && command.deploymentId === deploymentId
  ));
  state.commandQueues.set(hostId, next);
  return Math.max(0, queue.length - next.length);
}

function broadcastSkillDeploymentUpdated(deploymentId, hostId, result, extra = {}) {
  const deployment = state.skillDeployments.getDeployment(deploymentId);
  if (!deployment && !result) {
    return;
  }
  const { includeDeployment = false, ...eventExtra } = extra;
  broadcastSkillsEvent('skills.deployment.updated', {
    deploymentId,
    hostId,
    result: result || deployment?.results?.find((item) => item.hostId === hostId) || null,
    ...(includeDeployment && deployment ? { deployment } : {}),
    ...eventExtra,
  });
}

function queueSkillDeploymentForHost(deploymentId, hostId, options = {}) {
  const deployment = state.skillDeployments.getDeployment(deploymentId);
  const result = deployment?.results?.find((item) => item.hostId === hostId) || null;
  if (!deployment || !result) {
    throw skillApiError(404, 'Skill deployment result was not found');
  }
  if (result.state !== 'pending' && result.state !== 'queued') {
    return result;
  }
  const host = state.hosts.get(hostId);
  if (!host || !hostOnline(host) || !host.capabilities?.hostSkillDeploymentV1) {
    return result;
  }
  if (queuedSkillDeploymentCommand(hostId, deploymentId)) {
    return result;
  }

  const queued = state.skillDeployments.markQueued(deploymentId, hostId);
  if (queued.state !== 'queued') {
    return queued;
  }
  enqueueCommand(hostId, {
    type: 'host.skills.deployment.apply',
    requestId: makeId(),
    deploymentId,
    action: deployment.action,
    skillId: deployment.skillId,
    artifactId: deployment.artifactId,
    expectedHash: deployment.artifactId,
    downloadPath: `/api/agent/skills/artifacts/${encodeURIComponent(deployment.artifactId)}`,
    targetScope: deployment.targetScope,
    scopeId: deployment.scopeId,
    cwd: deployment.cwd,
    confirmProjectWrite: deployment.confirmProjectWrite,
  });
  if (options.broadcast !== false) {
    broadcastSkillDeploymentUpdated(deploymentId, hostId, queued);
  }
  return queued;
}

function queueSkillDeploymentTargets(deploymentId, options = {}) {
  const deployment = state.skillDeployments.getDeployment(deploymentId);
  if (!deployment) {
    throw skillApiError(404, 'Skill deployment was not found');
  }
  const queueableHostIds = [];
  for (const hostId of deployment.targetHostIds) {
    const result = deployment.results.find((item) => item.hostId === hostId) || null;
    const host = state.hosts.get(hostId);
    if (
      result
      && (result.state === 'pending' || result.state === 'queued')
      && host
      && hostOnline(host)
      && host.capabilities?.hostSkillDeploymentV1
      && !queuedSkillDeploymentCommand(hostId, deploymentId)
    ) {
      queueableHostIds.push(hostId);
    }
  }
  const queuedResults = queueableHostIds.length
    ? state.skillDeployments.markQueuedMany(deploymentId, queueableHostIds)
    : [];
  for (const queued of queuedResults) {
    if (queued.state !== 'queued') {
      continue;
    }
    enqueueCommand(queued.hostId, {
      type: 'host.skills.deployment.apply',
      requestId: makeId(),
      deploymentId,
      action: deployment.action,
      skillId: deployment.skillId,
      artifactId: deployment.artifactId,
      expectedHash: deployment.artifactId,
      downloadPath: `/api/agent/skills/artifacts/${encodeURIComponent(deployment.artifactId)}`,
      targetScope: deployment.targetScope,
      scopeId: deployment.scopeId,
      cwd: deployment.cwd,
      confirmProjectWrite: deployment.confirmProjectWrite,
    });
    if (options.broadcast !== false) {
      broadcastSkillDeploymentUpdated(deploymentId, queued.hostId, queued);
    }
  }
  return state.skillDeployments.getDeployment(deploymentId);
}

function reconcileSkillDeploymentsForHost(hostId, options = {}) {
  const host = state.hosts.get(hostId);
  if (!host || !hostOnline(host) || !host.capabilities?.hostSkillDeploymentV1) {
    return;
  }
  const pendingDeployments = state.skillDeployments.pendingForHost(hostId, {
    includeRunning: options.includeRunning === true,
  })
    .filter((pending) => !queuedSkillDeploymentCommand(hostId, pending.deploymentId));
  if (!pendingDeployments.length) {
    return;
  }
  const queuedEntries = state.skillDeployments.markQueuedBatch(
    pendingDeployments.map((pending) => ({ deploymentId: pending.deploymentId, hostId }))
  );
  for (const entry of queuedEntries) {
    if (entry.result.state !== 'queued') {
      continue;
    }
    const deployment = state.skillDeployments.getDeployment(entry.deploymentId);
    if (!deployment) {
      continue;
    }
    enqueueCommand(hostId, {
      type: 'host.skills.deployment.apply',
      requestId: makeId(),
      deploymentId: deployment.deploymentId,
      action: deployment.action,
      skillId: deployment.skillId,
      artifactId: deployment.artifactId,
      expectedHash: deployment.artifactId,
      downloadPath: `/api/agent/skills/artifacts/${encodeURIComponent(deployment.artifactId)}`,
      targetScope: deployment.targetScope,
      scopeId: deployment.scopeId,
      cwd: deployment.cwd,
      confirmProjectWrite: deployment.confirmProjectWrite,
    });
    broadcastSkillDeploymentUpdated(deployment.deploymentId, hostId, entry.result);
  }
}

function markDeliveredSkillDeploymentCommands(hostId, commands) {
  const targets = [];
  for (const command of Array.isArray(commands) ? commands : []) {
    if (command?.type !== 'host.skills.deployment.apply' || !command.deploymentId) {
      continue;
    }
    const deployment = state.skillDeployments.getDeployment(command.deploymentId);
    const result = deployment?.results?.find((entry) => entry.hostId === hostId);
    if (result?.state === 'queued') {
      targets.push({ deploymentId: command.deploymentId, hostId });
    }
  }
  if (!targets.length) {
    return;
  }
  const runningEntries = state.skillDeployments.markRunningBatch(targets);
  for (const entry of runningEntries) {
    if (entry.result.state === 'running') {
      broadcastSkillDeploymentUpdated(entry.deploymentId, entry.hostId, entry.result, {
        reason: 'running',
      });
    }
  }
}

function retiredSkillCleanupIsAuthorized(input, artifact) {
  const skillId = String(input?.skillId || '').trim().toLowerCase();
  const targetScope = String(input?.targetScope || 'user').trim().toLowerCase();
  const scopeId = targetScope === 'project'
    ? String(input?.scopeId || input?.cwd || '').trim()
    : 'user';
  const targetHostIds = Array.from(new Set(
    (Array.isArray(input?.targetHostIds) ? input.targetHostIds : [])
      .map((hostId) => String(hostId || '').trim())
      .filter(Boolean)
  ));
  if (!targetHostIds.length) {
    return false;
  }
  const references = collectSkillArtifactReferences().filter((reference) => (
    reference.artifactId === artifact.artifactId
    && reference.skillId === skillId
    && reference.scope === targetScope
    && reference.scopeId === scopeId
    && (
      reference.kind === 'desired'
      || reference.kind === 'applied'
      || reference.kind === 'applied-uncertain'
    )
  ));
  return targetHostIds.every((hostId) => references.some((reference) => (
    reference.hostId === hostId
  )));
}

function submitSkillDeploymentRequest(input) {
  let created;
  try {
    created = state.skillDeployments.createDeployment({
      ...input,
      createdBy: input.createdBy || 'relay-api',
    });
  } catch (error) {
    throw skillApiError(error.statusCode || 400, error.message);
  }
  for (const superseded of created.superseded || []) {
    acknowledgeQueuedSkillDeploymentCommand(superseded.hostId, superseded.deploymentId);
    broadcastSkillDeploymentUpdated(
      superseded.deploymentId,
      superseded.hostId,
      superseded.result,
      { reason: 'superseded' }
    );
  }
  const deployment = queueSkillDeploymentTargets(created.deployment.deploymentId, { broadcast: false });
  if (!created.reused) {
    broadcastSkillDeploymentUpdated(deployment.deploymentId, null, null, {
      reason: 'created',
      includeDeployment: true,
    });
  }
  recordSkillAudit('skills.deployment.accepted', {
    deploymentId: deployment.deploymentId,
    requestId: deployment.requestId,
    skillId: deployment.skillId,
    artifactId: deployment.artifactId,
    action: deployment.action,
    targetHostIds: deployment.targetHostIds,
    targetScope: deployment.targetScope,
    scopeId: deployment.scopeId,
    reused: created.reused,
  }, {
    actor: input.createdBy || 'relay-api',
    subject: deployment.skillId,
  });
  return {
    reused: created.reused,
    deployment,
  };
}

function createSkillDeployment(input) {
  if (state.skillDeployments.hasRequestId(input?.requestId)) {
    return submitSkillDeploymentRequest(input);
  }
  let artifact;
  try {
    artifact = state.skillRegistry.getArtifact(input?.artifactId);
  } catch (error) {
    throw skillApiError(400, error.message);
  }
  if (
    !artifact
    || artifact.trustState !== 'validated'
    || artifact.storageState !== 'available'
  ) {
    throw skillApiError(404, 'Validated Skill Artifact was not found');
  }
  if (!skillArtifactSupportsSkill(artifact, input?.skillId)) {
    throw skillApiError(409, 'Skill Artifact does not belong to the requested skillId');
  }
  const action = String(input?.action || '').trim().toLowerCase();
  const activeLibraryArtifact = state.skillRegistry.isActiveLibraryArtifact(
    input?.skillId,
    artifact.artifactId
  );
  if (action === 'enable' && !activeLibraryArtifact) {
    throw skillApiError(409, 'Retired Library Skills cannot be enabled');
  }
  if (
    (action === 'disable' || action === 'remove')
    && !activeLibraryArtifact
    && (
      !state.skillRegistry.libraryHasArtifact(input?.skillId, artifact.artifactId)
      || !retiredSkillCleanupIsAuthorized(input, artifact)
    )
  ) {
    throw skillApiError(409, 'Retired Library Skill cleanup requires an existing Host reference');
  }
  if (String(input?.targetScope || 'user').trim().toLowerCase() === 'project') {
    const cwd = String(input?.cwd || input?.scopeId || '').trim();
    if (input?.confirmProjectWrite !== true) {
      throw skillApiError(400, 'project deployment requires confirmProjectWrite confirmation');
    }
    const targetHostIds = Array.isArray(input?.targetHostIds) ? input.targetHostIds : [];
    for (const hostId of targetHostIds) {
      if (!knownSkillWorkspaceRoots(String(hostId || '').trim()).includes(cwd)) {
        throw skillApiError(409, `project cwd is not an exact known workspace for Host ${hostId}`);
      }
    }
  }

  return submitSkillDeploymentRequest(input);
}

function validateHostSkillDeploymentResult(event, deployment) {
  const expected = {
    skillId: deployment.skillId,
    artifactId: deployment.artifactId,
    action: deployment.action,
    targetScope: deployment.targetScope,
    scopeId: deployment.scopeId,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (String(event[name] == null ? '' : event[name]).trim() !== String(value)) {
      throw new Error(`Skill deployment result ${name} does not match its deployment`);
    }
  }
  if (typeof event.ok !== 'boolean') {
    throw new Error('Skill deployment result ok must be a boolean');
  }
  if (event.ok) {
    const expectedHostState = {
      enable: 'enabled',
      disable: 'disabled',
      remove: 'missing',
    }[deployment.action];
    if (String(event.state || '').trim() !== expectedHostState) {
      throw new Error(`Skill deployment result state must be ${expectedHostState}`);
    }
    if (
      deployment.action === 'enable'
      && String(event.observedHash || '').trim() !== deployment.artifactId
    ) {
      throw new Error('Skill deployment result observedHash does not match its Artifact');
    }
  }
}

function applyHostSkillDeploymentResult(event) {
  const deploymentId = String(event.deploymentId || '').trim();
  const hostId = String(event.hostId || '').trim();
  const host = state.hosts.get(hostId);
  if (!hostId || !host || !host.capabilities?.hostSkillDeploymentV1) {
    throw new Error('Skill deployment result Host is not registered for deployment');
  }
  const deployment = state.skillDeployments.getDeployment(deploymentId);
  if (!deployment) {
    const tombstone = state.skillDeployments.getPrunedDeployment(deploymentId, hostId);
    if (!tombstone) {
      throw new Error('Skill deployment result was not found');
    }
    validateHostSkillDeploymentResult(event, tombstone);
    const recordedState = tombstone.resultStates?.[hostId];
    const replayedState = event.ok === false ? 'failed' : 'succeeded';
    if (recordedState !== 'superseded' && recordedState !== replayedState) {
      throw new Error(`Skill deployment result conflicts with pruned terminal ${recordedState || 'unknown'} state`);
    }
    acknowledgeQueuedSkillDeploymentCommand(hostId, deploymentId);
    return {
      deploymentId,
      hostId,
      state: 'ignored',
      pruned: true,
    };
  }
  const previousResult = deployment.results.find((result) => result.hostId === hostId);
  if (!previousResult) {
    throw new Error('Skill deployment result was not found');
  }
  validateHostSkillDeploymentResult(event, deployment);
  const result = state.skillDeployments.applyResult(event);
  acknowledgeQueuedSkillDeploymentCommand(hostId, deploymentId);
  const newlySucceeded = previousResult.state !== 'succeeded' && result.state === 'succeeded';
  const newlyFailedCleanup = previousResult.state !== 'failed'
    && result.state === 'failed'
    && (deployment.action === 'disable' || deployment.action === 'remove');
  let refresh = null;
  if (newlySucceeded || newlyFailedCleanup) {
    refresh = queueSkillInventoryRefreshes([hostId]);
  }
  broadcastSkillDeploymentUpdated(deploymentId, hostId, result, {
    invalidateHostId: newlySucceeded ? hostId : null,
    refresh,
  });
  recordSkillAudit('skills.deployment.host_result', {
    deploymentId,
    hostId,
    skillId: deployment.skillId,
    artifactId: deployment.artifactId,
    action: deployment.action,
    state: result.state,
    error: result.error || '',
    observedHash: result.observedHash || null,
  }, { actor: `host:${hostId}`, subject: deployment.skillId });
  return result;
}

async function streamSkillArtifactDownload(req, res, artifactId) {
  const hostId = String(req.headers['x-remote-codex-host-id'] || '').trim();
  const host = state.hosts.get(hostId);
  if (!hostId || !host) {
    throw skillApiError(403, 'registered Host identity is required for Skill Artifact download');
  }
  if (!host.capabilities?.hostSkillDeploymentV1) {
    throw skillApiError(409, 'Host does not support Skill deployment');
  }
  let artifact;
  try {
    artifact = state.skillRegistry.getArtifact(artifactId);
  } catch (error) {
    throw skillApiError(400, error.message);
  }
  if (
    !artifact
    || artifact.trustState !== 'validated'
    || artifact.storageState !== 'available'
  ) {
    throw skillApiError(404, 'Validated Skill Artifact was not found');
  }
  const authorized = state.skillDeployments.pendingForHost(hostId).some((deployment) => (
    deployment.artifactId === artifact.artifactId
    && deployment.action === 'enable'
  ));
  if (!authorized) {
    throw skillApiError(403, 'Host has no pending deployment for this Skill Artifact');
  }
  const expectedPath = path.resolve(state.skillRegistry.artifactPath(artifact.artifactId));
  if (path.resolve(artifact.archivePath) !== expectedPath) {
    throw skillApiError(500, 'Skill Artifact registry path is invalid');
  }
  let stats;
  try {
    stats = await fs.promises.stat(expectedPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw skillApiError(404, 'Skill Artifact archive is missing');
    }
    throw error;
  }
  if (!stats.isFile() || stats.size <= 0 || stats.size !== Number(artifact.archiveBytes)) {
    throw skillApiError(500, 'Skill Artifact archive size does not match the Registry');
  }

  res.writeHead(200, {
    'Content-Type': 'application/vnd.remote-codex.skill-artifact',
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${artifact.artifactId.slice(7)}.rcskill"`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Remote-Codex-Artifact-Id': artifact.artifactId,
    'Access-Control-Allow-Origin': '*',
  });
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(expectedPath);
    stream.on('error', reject);
    stream.on('end', resolve);
    req.on('aborted', () => stream.destroy());
    stream.pipe(res);
  });
}

function queueSkillInventoryRefreshes(requestedHostIds) {
  const refreshId = makeId();
  const requested = Array.isArray(requestedHostIds)
    ? requestedHostIds.map((hostId) => String(hostId || '').trim()).filter(Boolean)
    : [];
  const hostIds = Array.from(new Set(requested.length
    ? requested
    : getHostList().map((host) => host.hostId)));
  const hosts = [];
  for (const hostId of hostIds) {
    const host = state.hosts.get(hostId);
    if (!host || !hostOnline(host)) {
      hosts.push({
        hostId,
        state: 'offline',
        error: host ? `host ${host.label || hostId} is offline` : 'host not found',
      });
      continue;
    }
    if (!host.capabilities?.hostSkillInventoryV2) {
      hosts.push({
        hostId,
        state: 'unsupported',
        error: 'host agent does not support skill inventory v2',
      });
      continue;
    }
    if (hasPendingSkillRefresh(hostId)) {
      const pending = state.skillRefreshes.get(hostId);
      hosts.push({
        hostId,
        state: 'queued',
        error: '',
        reused: true,
        refreshId: pending.refreshId,
        requestId: pending.requestId,
      });
      continue;
    }
    const requestId = makeId();
    const workspaceRoots = knownSkillWorkspaceRoots(hostId);
    enqueueCommand(hostId, {
      type: 'host.skills.inventory.refresh',
      requestId,
      refreshId,
      workspaceRoots,
    });
    state.skillRefreshes.set(hostId, {
      hostId,
      refreshId,
      requestId,
      queuedAt: nowIso(),
      queuedAtMs: Date.now(),
    });
    hosts.push({ hostId, state: 'queued', error: '' });
  }
  return { ok: true, refreshId, hosts };
}

function writeSkillsEvent(res, eventName, payload) {
  return writeSseEvent(res, eventName, payload);
}

function broadcastSkillsEvent(eventName, payload) {
  for (const res of Array.from(state.skillSubscribers)) {
    if (!res || res.destroyed || res.writableEnded) {
      state.skillSubscribers.delete(res);
      continue;
    }
    try {
      if (!writeSkillsEvent(res, eventName, payload)) {
        state.skillSubscribers.delete(res);
      }
    } catch (_) {
      state.skillSubscribers.delete(res);
    }
  }
}

function broadcastSkillsInventoryUpdated(payload) {
  broadcastSkillsEvent('skills.inventory.updated', payload);
}

function broadcastSkillsLibraryUpdated(payload) {
  broadcastSkillsEvent('skills.library.updated', payload);
}

function recordSkillAudit(type, data = {}, options = {}) {
  if (!state.skillAudit) {
    return null;
  }
  return state.skillAudit.append(type, data, options);
}

function applyHostSkillInventoryEvent(event) {
  const hostId = skillInventoryText(event.hostId, 160);
  if (!hostId || !state.hosts.has(hostId)) {
    throw new Error('skill inventory event host is not registered');
  }
  const receivedAt = nowIso();
  const previousInventory = state.skillInventories.get(hostId) || null;
  const inventory = normalizeHostSkillInventory(event, hostId, receivedAt);
  if (
    previousInventory
    && Date.parse(inventory.scannedAt) <= Date.parse(previousInventory.scannedAt)
  ) {
    const ignoredPayload = {
      hostId,
      revision: previousInventory.revision,
      scannedAt: previousInventory.scannedAt,
      receivedAt: previousInventory.receivedAt,
      instanceCount: previousInventory.instances.length,
      scanErrors: previousInventory.scanErrors,
      incomplete: previousInventory.incomplete,
      ignored: true,
      reason: 'stale-inventory',
    };
    broadcastSkillsInventoryUpdated(ignoredPayload);
    return ignoredPayload;
  }
  if (inventory.incomplete) {
    const retained = new Map();
    for (const instance of [
      ...(previousInventory?.referenceInstances || previousInventory?.instances || []),
      ...inventory.referenceInstances,
    ]) {
      const key = JSON.stringify([
        instance.instanceId,
        instance.observedHash,
        instance.desiredArtifactId,
        instance.activationPath,
      ]);
      retained.set(key, instance);
    }
    inventory.referenceInstances = Array.from(retained.values());
  }
  const nextInventories = new Map(state.skillInventories);
  nextInventories.set(hostId, inventory);
  const pendingRefresh = state.skillRefreshes.get(hostId);
  if (!pendingRefresh || !event.requestId || pendingRefresh.requestId === event.requestId) {
    state.skillRefreshes.delete(hostId);
  }
  const host = state.hosts.get(hostId);
  host.skillsRevision = inventory.revision;
  host.lastSeenAt = receivedAt;
  state.hosts.set(hostId, host);
  saveSkillInventories(nextInventories);
  state.skillInventories = nextInventories;
  const payload = {
    hostId,
    revision: inventory.revision,
    scannedAt: inventory.scannedAt,
    receivedAt: inventory.receivedAt,
    instanceCount: inventory.instances.length,
    scanErrors: inventory.scanErrors,
    incomplete: inventory.incomplete,
  };
  broadcastSkillsInventoryUpdated(payload);
  return payload;
}

function skillApiError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function findCachedSkillInstance(hostId, instanceId) {
  const inventory = state.skillInventories.get(hostId) || null;
  if (!inventory) {
    throw skillApiError(409, 'Host has no authoritative Skill inventory yet');
  }
  const matches = inventory.instances.filter((instance) => instance.instanceId === instanceId);
  if (!matches.length) {
    throw skillApiError(404, 'Skill instance was not found in the cached Host inventory');
  }
  if (matches.length !== 1) {
    throw skillApiError(409, 'Skill instanceId is ambiguous in the cached Host inventory');
  }
  return matches[0];
}

function updateSkillAdoption(adoptionId, patch) {
  const existing = state.skillAdoptions.get(adoptionId);
  if (!existing) {
    return null;
  }
  const next = {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  };
  state.skillAdoptions.set(adoptionId, next);
  return next;
}

function queueSkillAdoption(input = {}) {
  pruneSkillAdoptions();
  const hostId = skillInventoryText(input.hostId, 160);
  const instanceId = skillInventoryText(input.instanceId, 8192);
  if (!hostId || !instanceId) {
    throw skillApiError(400, 'hostId and instanceId are required');
  }
  const host = state.hosts.get(hostId);
  if (!host) {
    throw skillApiError(404, 'Host was not found');
  }
  if (!hostOnline(host)) {
    throw skillApiError(409, 'Host is offline');
  }
  if (!host.capabilities?.hostSkillArtifactsV1) {
    throw skillApiError(409, 'Host agent does not support complete Skill artifacts');
  }
  const instance = findCachedSkillInstance(hostId, instanceId);
  const scope = String(instance.scope || '').trim().toLowerCase();
  if (instance.readonly || scope === 'plugin' || scope === 'system') {
    throw skillApiError(409, `${scope || 'readonly'} owned Skill instances cannot be adopted`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(instance.observedHash || '').toLowerCase())) {
    throw skillApiError(409, 'Skill instance has no trusted observed hash');
  }
  const existing = Array.from(state.skillAdoptions.values()).find((adoption) => (
    adoption.hostId === hostId
    && adoption.instanceId === instanceId
    && adoption.expectedHash === instance.observedHash
    && (adoption.state === 'queued' || adoption.state === 'uploading')
  ));
  if (existing) {
    return { adoption: existing, reused: true };
  }
  const activeAdoptions = Array.from(state.skillAdoptions.values()).filter((adoption) => (
    adoption.state === 'queued' || adoption.state === 'uploading'
  )).length;
  if (activeAdoptions >= SKILL_MAX_ACTIVE_ADOPTIONS) {
    throw skillApiError(429, 'Too many Skill adoptions are already in progress');
  }

  const adoptionId = makeId();
  const uploadToken = crypto.randomBytes(32).toString('base64url');
  const timestamp = nowIso();
  const adoption = {
    adoptionId,
    hostId,
    instanceId,
    skillId: instance.skillId,
    name: instance.name || instance.skillId,
    description: instance.description || '',
    sourceId: instance.sourceId,
    sourceKind: instance.sourceKind || 'local-host',
    sourceLocator: instance.sourceLocator || instance.activationPath,
    sourceRef: instance.sourceRef || null,
    sourcePath: instance.sourcePath || null,
    scope: instance.scope,
    scopeId: instance.scopeId,
    expectedHash: instance.observedHash,
    state: 'queued',
    artifactId: null,
    error: '',
    uploadToken,
    uploadPath: `/api/agent/skills/adoptions/${encodeURIComponent(adoptionId)}/artifact`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.skillAdoptions.set(adoptionId, adoption);
  enqueueCommand(hostId, {
    type: 'host.skills.artifact.export',
    adoptionId,
    instanceId,
    expectedHash: adoption.expectedHash,
    uploadPath: adoption.uploadPath,
    uploadToken,
  });
  return { adoption, reused: false };
}

async function streamSkillArtifactUpload(req, targetPath, expectedBytes) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const output = await fs.promises.open(targetPath, 'wx');
  let totalBytes = 0;
  try {
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > SKILL_ARTIFACT_MAX_UPLOAD_BYTES || totalBytes > expectedBytes) {
        throw skillApiError(413, 'Skill artifact upload exceeds the declared or configured size limit');
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, null);
        if (!bytesWritten) {
          throw new Error('Unable to write complete Skill artifact upload');
        }
        offset += bytesWritten;
      }
    }
    if (totalBytes !== expectedBytes) {
      throw skillApiError(400, `Skill artifact upload length mismatch: expected ${expectedBytes}, received ${totalBytes}`);
    }
    await output.sync();
  } finally {
    await output.close();
  }
  return totalBytes;
}

async function handleSkillArtifactUpload(req, adoptionId) {
  const adoption = state.skillAdoptions.get(adoptionId);
  if (!adoption) {
    throw skillApiError(404, 'Skill adoption was not found or has expired');
  }
  if (adoption.state !== 'queued') {
    throw skillApiError(409, `Skill adoption is already ${adoption.state}`);
  }
  const uploadToken = String(req.headers['x-remote-codex-upload-token'] || '').trim();
  const hostId = skillInventoryText(req.headers['x-remote-codex-host-id'], 160);
  const instanceDigest = String(req.headers['x-remote-codex-instance-digest'] || '').trim().toLowerCase();
  const expectedInstanceDigest = crypto.createHash('sha256').update(adoption.instanceId).digest('hex');
  if (!constantTimeEqual(uploadToken, adoption.uploadToken)) {
    throw skillApiError(403, 'Invalid or expired Skill artifact upload token');
  }
  if (
    hostId !== adoption.hostId
    || !/^[a-f0-9]{64}$/.test(instanceDigest)
    || !constantTimeEqual(instanceDigest, expectedInstanceDigest)
  ) {
    throw skillApiError(403, 'Skill artifact upload does not match its Host adoption request');
  }
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/vnd.remote-codex.skill-artifact') {
    throw skillApiError(415, 'Skill artifact upload requires the Remote Codex artifact content type');
  }
  const contentLength = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw skillApiError(411, 'Skill artifact upload requires a positive Content-Length');
  }
  if (contentLength > SKILL_ARTIFACT_MAX_UPLOAD_BYTES) {
    throw skillApiError(413, 'Skill artifact upload exceeds the configured size limit');
  }

  updateSkillAdoption(adoptionId, { state: 'uploading', error: '' });
  const incomingRoot = path.join(SKILL_ARTIFACT_ROOT, '.incoming');
  const tempPath = path.join(incomingRoot, `${adoptionId}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await streamSkillArtifactUpload(req, tempPath, contentLength);
    const imported = await state.skillRegistry.importArchive(tempPath, {
      skillId: adoption.skillId,
      name: adoption.name,
      description: adoption.description,
      sourceId: adoption.sourceId,
      sourceKind: adoption.sourceKind,
      sourceLocator: adoption.sourceLocator,
      sourceRef: adoption.sourceRef,
      sourcePath: adoption.sourcePath,
      expectedHash: adoption.expectedHash,
    });
    const completed = updateSkillAdoption(adoptionId, {
      state: 'completed',
      artifactId: imported.artifact.artifactId,
      error: '',
      completedAt: nowIso(),
    });
    broadcastSkillsLibraryUpdated({
      adoptionId,
      hostId: adoption.hostId,
      instanceId: adoption.instanceId,
      skillId: adoption.skillId,
      artifactId: imported.artifact.artifactId,
      state: 'completed',
      deduplicated: imported.deduplicated,
      updatedAt: completed.updatedAt,
    });
    return imported;
  } catch (error) {
    const failed = updateSkillAdoption(adoptionId, {
      state: 'failed',
      error: error.message,
      failedAt: nowIso(),
    });
    broadcastSkillsLibraryUpdated({
      adoptionId,
      hostId: adoption.hostId,
      instanceId: adoption.instanceId,
      skillId: adoption.skillId,
      state: 'failed',
      error: error.message,
      updatedAt: failed.updatedAt,
    });
    throw error;
  } finally {
    await fs.promises.unlink(tempPath).catch((error) => {
      if (error.code !== 'ENOENT') {
        console.warn(`[relay] failed to clean Skill artifact upload ${tempPath}: ${error.message}`);
      }
    });
  }
}

function applyHostSkillArtifactResult(event) {
  const adoptionId = skillInventoryText(event.adoptionId, 240);
  const adoption = state.skillAdoptions.get(adoptionId);
  if (
    !adoption
    || adoption.hostId !== event.hostId
    || adoption.instanceId !== skillInventoryText(event.instanceId, 8192)
  ) {
    return;
  }
  if (event.ok !== false || adoption.state === 'completed') {
    return;
  }
  const failed = updateSkillAdoption(adoptionId, {
    state: 'failed',
    error: skillInventoryText(event.error, 4096) || 'Host failed to export the Skill artifact',
    failedAt: event.timestamp || nowIso(),
  });
  broadcastSkillsLibraryUpdated({
    adoptionId,
    hostId: adoption.hostId,
    instanceId: adoption.instanceId,
    skillId: adoption.skillId,
    state: 'failed',
    error: failed.error,
    updatedAt: failed.updatedAt,
  });
}

function updateSkillImport(importId, patch) {
  const existing = state.skillImports.get(importId);
  if (!existing) {
    return null;
  }
  const next = {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  };
  state.skillImports.set(importId, next);
  return next;
}

async function readImportedSkillMetadata(skillRoot) {
  const markdownPath = path.join(skillRoot, 'SKILL.md');
  const stats = await fs.promises.stat(markdownPath);
  if (!stats.isFile() || stats.size > 1024 * 1024) {
    throw new Error('Imported SKILL.md must be a regular file no larger than 1 MiB');
  }
  return parseSkillMarkdown(await fs.promises.readFile(markdownPath, 'utf8'));
}

function trackRelayBackgroundTask(task) {
  const tracked = Promise.resolve(task).finally(() => {
    relayBackgroundTasks.delete(tracked);
  });
  relayBackgroundTasks.add(tracked);
  return tracked;
}

async function runGithubSkillImport(importId) {
  const record = state.skillImports.get(importId);
  if (!record) {
    return;
  }
  const stagingRoot = path.join(SKILL_ARTIFACT_ROOT, '.imports');
  const destination = path.join(stagingRoot, `${importId}-content`);
  const archivePath = path.join(stagingRoot, `${importId}.rcskill`);
  try {
    updateSkillImport(importId, { state: 'downloading', error: '' });
    const downloaded = await downloadGithubSkill({
      locator: record.locator,
      ref: record.ref,
      subpath: record.subpath,
      destination,
      apiBaseUrl: SKILL_GITHUB_API_BASE_URL,
      token: SKILL_GITHUB_TOKEN,
    });
    updateSkillImport(importId, { state: 'validating' });
    const metadata = await readImportedSkillMetadata(destination);
    const artifact = await createSkillArtifactArchive(destination, archivePath);
    const skillId = path.posix.basename(downloaded.subpath || downloaded.repo);
    const previousArtifactId = state.skillRegistry.getLibraryRecord(skillId)?.latestArtifactId || null;
    const imported = await state.skillRegistry.importArchive(archivePath, {
      skillId,
      name: metadata.name || skillId,
      description: metadata.description || '',
      sourceId: downloaded.sourceId,
      sourceKind: 'github',
      sourceLocator: downloaded.locator,
      sourceRef: downloaded.ref,
      sourcePath: downloaded.sourcePath,
      expectedHash: artifact.contentHash,
    });
    const completed = updateSkillImport(importId, {
      state: 'completed',
      skillId,
      artifactId: imported.artifact.artifactId,
      sourceId: downloaded.sourceId,
      error: '',
      completedAt: nowIso(),
    });
    broadcastSkillsLibraryUpdated({
      importId,
      skillId,
      artifactId: imported.artifact.artifactId,
      sourceId: downloaded.sourceId,
      state: 'completed',
      deduplicated: imported.deduplicated,
      updatedAt: completed.updatedAt,
    });
    recordSkillAudit('skills.source.refresh_completed', {
      importId,
      sourceId: downloaded.sourceId,
      skillId,
      previousArtifactId,
      artifactId: imported.artifact.artifactId,
      changed: previousArtifactId !== imported.artifact.artifactId,
      deduplicated: imported.deduplicated,
    }, { subject: downloaded.sourceId });
    if (previousArtifactId !== imported.artifact.artifactId) {
      await state.skillAutomation?.rolloutAfterRefresh({
        source: state.skillRegistry.getSource(downloaded.sourceId),
        skillId,
        artifactId: imported.artifact.artifactId,
      });
    }
  } catch (error) {
    const refreshSourceId = state.skillImports.get(importId)?.refreshSourceId
      || record.refreshSourceId;
    if (refreshSourceId) {
      await state.skillRegistry.markSourceRefreshFailed(
        refreshSourceId,
        error.message
      ).catch((refreshError) => {
        console.warn(
          `[relay] failed to persist GitHub Skill refresh error for ${refreshSourceId}: ${refreshError.message}`
        );
      });
    }
    const failed = updateSkillImport(importId, {
      state: 'failed',
      error: skillInventoryText(error.message, 4096) || 'GitHub Skill import failed',
      failedAt: nowIso(),
    });
    broadcastSkillsLibraryUpdated({
      importId,
      state: 'failed',
      error: failed.error,
      updatedAt: failed.updatedAt,
    });
    recordSkillAudit('skills.source.refresh_failed', {
      importId,
      sourceId: refreshSourceId || record.sourceId,
      error: failed.error,
    }, { subject: refreshSourceId || record.sourceId });
  } finally {
    await fs.promises.unlink(archivePath).catch((error) => {
      if (error.code !== 'ENOENT') {
        console.warn(`[relay] failed to clean GitHub Skill archive ${archivePath}: ${error.message}`);
      }
    });
    await fs.promises.rm(destination, { recursive: true, force: true }).catch((error) => {
      console.warn(`[relay] failed to clean GitHub Skill staging ${destination}: ${error.message}`);
    });
  }
}

function queueGithubSkillImport(rawSource, options = {}) {
  if (relayStopping) {
    throw skillApiError(503, 'Relay is shutting down and cannot start a Skill import.');
  }
  pruneSkillImports();
  const source = normalizeGithubSkillSource(rawSource);
  const existing = Array.from(state.skillImports.values()).find((record) => (
    record.sourceId === source.sourceId
    && (record.state === 'queued' || record.state === 'downloading' || record.state === 'validating')
  ));
  if (existing) {
    if (options.refreshSourceId) {
      existing.refreshSourceId = options.refreshSourceId;
    }
    if (options.automated) {
      existing.automated = true;
    }
    return { ...existing, reused: true };
  }
  const activeImports = Array.from(state.skillImports.values()).filter((record) => (
    record.state === 'queued' || record.state === 'downloading' || record.state === 'validating'
  )).length;
  if (activeImports >= SKILL_GITHUB_MAX_CONCURRENT_IMPORTS) {
    throw skillApiError(429, 'Too many concurrent GitHub Skill imports are already in progress');
  }
  const importId = makeId();
  const timestamp = nowIso();
  const record = {
    importId,
    kind: 'github',
    locator: source.locator,
    ref: source.ref,
    subpath: source.subpath,
    sourceId: source.sourceId,
    sourcePath: source.sourcePath,
    refreshSourceId: options.refreshSourceId || null,
    automated: options.automated === true,
    state: 'queued',
    skillId: null,
    artifactId: null,
    error: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    reused: false,
  };
  state.skillImports.set(importId, record);
  setImmediate(() => {
    if (relayStopping) {
      return;
    }
    trackRelayBackgroundTask(runGithubSkillImport(importId)).catch((error) => {
      console.warn(`[relay] unhandled GitHub Skill import failure: ${error.message}`);
    });
  });
  return record;
}

async function queueRegistrySkillSourceRefresh(sourceId, options = {}) {
  const source = state.skillRegistry.getSource(sourceId);
  if (!source) {
    throw skillApiError(404, 'Registry Skill source was not found');
  }
  if (source.kind !== 'github') {
    throw skillApiError(409, 'Only GitHub Registry sources support refresh');
  }
  if (source.enabled === false) {
    throw skillApiError(409, 'Disabled Registry Skill sources cannot be refreshed');
  }
  const normalizedSource = normalizeGithubSkillSource({
    kind: 'github',
    locator: source.locator,
    ref: source.ref,
    subpath: source.subpath,
  });
  if (normalizedSource.sourceId !== source.sourceId) {
    throw skillApiError(409, 'Registry GitHub source identity is not canonical');
  }
  let refreshStarted = false;
  try {
    await state.skillRegistry.markSourceRefreshStarted(sourceId, {
      expectedRevision: options.expectedRevision,
    });
    refreshStarted = true;
    const queued = queueGithubSkillImport(normalizedSource, {
      refreshSourceId: sourceId,
      automated: options.automated === true,
    });
    recordSkillAudit('skills.source.refresh_queued', {
      sourceId,
      importId: queued.importId,
      automated: options.automated === true,
      reused: queued.reused === true,
      refreshPolicy: source.refreshPolicy || 'manual',
      rolloutPolicy: source.rolloutPolicy || 'manual',
    }, {
      actor: options.automated ? 'skill-automation' : 'relay-api',
      subject: sourceId,
    });
    return queued;
  } catch (error) {
    if (refreshStarted) {
      await state.skillRegistry.markSourceRefreshFailed(sourceId, error.message).catch((refreshError) => {
        console.warn(`[relay] failed to persist GitHub Skill refresh queue error for ${sourceId}: ${refreshError.message}`);
      });
      error.revision = state.skillRegistry.snapshot({ includeManifest: false }).revision;
    }
    recordSkillAudit('skills.source.refresh_queue_failed', {
      sourceId,
      automated: options.automated === true,
      error: error.message,
    }, {
      actor: options.automated ? 'skill-automation' : 'relay-api',
      subject: sourceId,
    });
    throw error;
  }
}

function findCatalogSkill(skillId) {
  const id = String(skillId || '').trim();
  return mergeSkillLibraryWithCatalog(buildSkillCatalogFromSources()).find((skill) => skill.skillId === id) || null;
}

function upsertSkillLibraryRecord(input) {
  const record = normalizeSkillLibraryRecord(input);
  if (!record) {
    throw new Error('invalid skill library record');
  }
  const existing = (state.skillLibrary || []).find((skill) => skill.skillId === record.skillId) || null;
  const next = {
    ...existing,
    ...record,
    lastInstalledHostIds: Array.from(new Set([
      ...(existing?.lastInstalledHostIds || []),
      ...(record.lastInstalledHostIds || []),
    ])),
    createdAt: existing?.createdAt || record.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  state.skillLibrary = [
    ...(state.skillLibrary || []).filter((skill) => skill.skillId !== next.skillId),
    next,
  ].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  saveSkillLibrary(state.skillLibrary);
  return next;
}

async function runSkillsBatchAction(action, hostIds, skillIds) {
  const results = [];
  for (const hostId of hostIds) {
    const hostError = getHostCapabilityError(
      hostId,
      'hostSkills',
      'this host agent needs to be restarted before it can manage skills'
    );
    if (hostError) {
      for (const skillId of skillIds) {
        results.push({
          ok: false,
          action,
          hostId,
          skillId,
          error: hostError.error,
        });
      }
      continue;
    }
    const requestId = makeId();
    const skills = skillIds.map((skillId) => findCatalogSkill(skillId) || { skillId });
    for (const skill of skills) {
      if (skill?.skillId) {
        upsertSkillLibraryRecord({
          ...skill,
          lastInstalledHostIds: action === 'install' ? [hostId] : (skill.lastInstalledHostIds || []),
        });
      }
    }
    if (action === 'install') {
      enqueueCommand(hostId, {
        type: 'host.skills.install',
        requestId,
        skills,
      });
    } else {
      enqueueCommand(hostId, {
        type: 'host.skills.uninstall',
        requestId,
        skills,
      });
    }
    try {
      const result = await awaitHostSkillRequest(requestId, 60000);
      const hostResults = Array.isArray(result.results) ? result.results : [];
      if (hostResults.length) {
        results.push(...hostResults);
      } else {
        for (const skillId of skillIds) {
          results.push({
            ok: Boolean(result.ok),
            action,
            hostId,
            skillId,
            error: result.error || '',
          });
        }
      }
    } catch (error) {
      for (const skillId of skillIds) {
        results.push({
          ok: false,
          action,
          hostId,
          skillId,
          error: error.message,
        });
      }
    }
  }
  return results;
}

function getSessionsForHost(hostId, options = {}) {
  const optimize = options.optimize !== false;
  const sessions = Array.from(state.sessions.values())
    .filter((session) => session.hostId === hostId)
    .filter((session) => !isInternalApprovalReviewSession(session))
    .filter((session) => !isSubagentSession(session))
    .sort((a, b) => String(b.lastUpdatedAt || '').localeCompare(String(a.lastUpdatedAt || '')));
  return optimize
    ? sessions.map(publicSessionListRecord)
    : sessions.map(sessionWithAssistantProjection);
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
  const prefix = start > 0 ? '...' : '';
  const suffix = end < source.length ? '...' : '';
  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

function sessionSearchHaystack(session) {
  return [
    session?.title,
    session?.cwd,
    session?.sessionId,
    session?.nativeThreadId,
    session?.bridgeSessionId,
    session?.originSessionId,
    session?.sourceSessionId,
    session?.conversationKey,
    session?.latestUserMessage,
    session?.latestAgentMessage,
  ].filter(Boolean).join('\n');
}

function getSearchTranscript(hostId, session) {
  const key = sessionKey(hostId, session.sessionId);
  const storedTranscript = state.sessionLogs.get(key) || [];
  const rolloutTranscript = loadSessionTranscriptFromRollout(session);
  return mergeExportTranscriptEntries([...storedTranscript, ...rolloutTranscript]);
}

function searchTranscriptFileSync(filePath, terms, maxMatches) {
  const matches = [];
  if (!filePath || !fs.existsSync(filePath) || !terms.length || maxMatches <= 0) {
    return matches;
  }
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return matches;
  }
  let entryIndex = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
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
  return matches;
}

function searchSessions(options = {}) {
  const hostId = String(options.hostId || '').trim();
  const query = String(options.query || '').trim();
  const mode = ['keyword', 'path', 'title'].includes(options.mode) ? options.mode : 'keyword';
  const collectionId = String(options.collectionId || '').trim();
  const maxSessions = Math.max(1, Math.min(200, Number(options.maxSessions || 80) || 80));
  const maxMatchesPerSession = Math.max(1, Math.min(20, Number(options.maxMatchesPerSession || 5) || 5));
  const terms = normalizeSearchTerms(query);
  if (!terms.length) {
    return { query, mode, results: [], scannedSessions: 0, truncated: false };
  }

  const allowedKeys = new Set();
  if (collectionId && collectionId !== DEFAULT_COLLECTION_ID) {
    const collection = state.sessionCollections.get(collectionId);
    for (const item of collection?.items || []) {
      if (item.hostId && item.sessionId) {
        allowedKeys.add(sessionKey(item.hostId, item.sessionId));
      }
      if (item.hostId && item.conversationKey) {
        allowedKeys.add(`${item.hostId}::conversation::${item.conversationKey}`);
      }
    }
  }

  const sessions = Array.from(state.sessions.values())
    .filter((session) => !hostId || session.hostId === hostId)
    .filter((session) => !isInternalApprovalReviewSession(session))
    .filter((session) => !isSubagentSession(session))
    .filter((session) => {
      if (!allowedKeys.size) {
        return true;
      }
      return allowedKeys.has(sessionKey(session.hostId, session.sessionId))
        || allowedKeys.has(`${session.hostId}::conversation::${session.conversationKey || session.originSessionId || session.sessionId}`);
    })
    .sort((a, b) => String(b.lastUpdatedAt || '').localeCompare(String(a.lastUpdatedAt || '')));

  const results = [];
  let scannedSessions = 0;
  for (const session of sessions) {
    scannedSessions += 1;
    const matches = [];

    if (mode === 'title') {
      if (textMatchesTerms(session.title || '', terms)) {
        matches.push({
          type: 'title',
          entryIndex: -1,
          speaker: 'title',
          timestamp: session.lastUpdatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(session.title || '', terms),
        });
      }
    } else if (mode === 'path') {
      if (textMatchesTerms(session.cwd || '', terms)) {
        matches.push({
          type: 'path',
          entryIndex: -1,
          speaker: 'path',
          timestamp: session.lastUpdatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(session.cwd || '', terms),
        });
      }
    } else {
      if (textMatchesTerms(sessionSearchHaystack(session), terms)) {
        matches.push({
          type: 'metadata',
          entryIndex: -1,
          speaker: 'session',
          timestamp: session.lastUpdatedAt || session.createdAt || null,
          snippet: makeSearchSnippet(sessionSearchHaystack(session), terms),
        });
      }
      const storedTranscript = (state.sessionLogs.get(sessionKey(session.hostId, session.sessionId)) || [])
        .filter((entry) => ['user', 'agent', 'assistant'].includes(String(entry?.speaker || '').toLowerCase()));
      storedTranscript.forEach((entry, index) => {
        if (matches.length < maxMatchesPerSession && textMatchesTerms(entry.text || '', terms)) {
          matches.push({
            type: 'transcript',
            entryIndex: index,
            speaker: entry.speaker || 'system',
            timestamp: entry.timestamp || null,
            snippet: makeSearchSnippet(entry.text || '', terms),
          });
        }
      });
      if (matches.length < maxMatchesPerSession) {
        matches.push(...searchTranscriptFileSync(
          resolveSessionRolloutPath(session),
          terms,
          maxMatchesPerSession - matches.length
        ));
      }
    }

    if (!matches.length) {
      continue;
    }
    results.push({
      hostId: session.hostId,
      sessionId: session.sessionId,
      conversationKey: session.conversationKey || session.originSessionId || session.sessionId,
      title: session.title || session.sessionId,
      cwd: session.cwd || null,
      lastUpdatedAt: session.lastUpdatedAt || session.updatedAt || null,
      live: Boolean(session.live),
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
    scannedSessions,
    truncated: results.length >= maxSessions,
  };
}

function filterSearchResultsForCollection(results, collectionId) {
  if (!collectionId || collectionId === DEFAULT_COLLECTION_ID) {
    return Array.isArray(results) ? results : [];
  }
  const collection = state.sessionCollections.get(collectionId);
  if (!collection) {
    return [];
  }
  const allowed = new Set();
  for (const item of collection.items || []) {
    if (item.hostId && item.sessionId) {
      allowed.add(sessionKey(item.hostId, item.sessionId));
    }
    if (item.hostId && item.conversationKey) {
      allowed.add(`${item.hostId}::conversation::${item.conversationKey}`);
    }
  }
  return (Array.isArray(results) ? results : []).filter((result) => (
    allowed.has(sessionKey(result.hostId, result.sessionId))
    || allowed.has(`${result.hostId}::conversation::${result.conversationKey || result.sessionId}`)
  ));
}

async function searchSessionsHydrated(options = {}) {
  const hostId = String(options.hostId || '').trim();
  const query = String(options.query || '').trim();
  const mode = ['keyword', 'path', 'title'].includes(options.mode) ? options.mode : 'keyword';
  const maxSessions = Math.max(1, Math.min(200, Number(options.maxSessions || 80) || 80));
  const maxMatchesPerSession = Math.max(1, Math.min(20, Number(options.maxMatchesPerSession || 5) || 5));
  const host = hostId ? state.hosts.get(hostId) : null;
  if (host && hostOnline(host) && host.capabilities?.sessionSearch) {
    const requestId = makeId();
    const pending = awaitSessionSearchRequest(requestId, 60000);
    enqueueCommand(hostId, {
      type: 'session.search',
      requestId,
      query,
      mode,
      maxSessions,
      maxMatchesPerSession,
      collectionId: options.collectionId || '',
    });
    try {
      const remote = await pending;
      if (remote && Array.isArray(remote.results)) {
        remote.results = filterSearchResultsForCollection(remote.results, options.collectionId || '');
        remote.results = remote.results.filter((result) => (
          !isInternalApprovalReviewSession(getSession(hostId, result?.sessionId))
          && !isSubagentSession(getSession(hostId, result?.sessionId))
        ));
        for (const result of remote.results) {
          if (result?.sessionId) {
            const existing = getSession(hostId, result.sessionId);
            upsertSession(hostId, {
              sessionId: result.sessionId,
              title: result.title || result.sessionId,
              cwd: result.cwd || null,
              source: existing?.source || 'imported',
              state: existing?.state || (existing?.live ? 'running' : 'imported'),
              live: Boolean(existing?.live),
              lastUpdatedAt: result.lastUpdatedAt || nowIso(),
              conversationKey: result.conversationKey || result.sessionId,
            });
          }
        }
        return {
          ...remote,
          source: 'host-agent',
        };
      }
    } catch (error) {
      const fallback = searchSessions(options);
      return {
        ...fallback,
        source: 'relay-fallback',
        remoteError: error.message,
      };
    }
  }
  return {
    ...searchSessions(options),
    source: 'relay',
  };
}

function limitListText(value, max = SESSION_LIST_TEXT_LIMIT) {
  const text = String(value || '');
  if (!text || text.length <= max) {
    return text;
  }
  const omitted = text.length - max;
  return `${text.slice(0, max).trimEnd()}\n...[truncated ${omitted} chars for session list]`;
}

function publicTranscriptPreview(entries) {
  return (Array.isArray(entries) ? entries : [])
    .slice(-SESSION_LIST_PREVIEW_LIMIT)
    .map((entry) => ({
      timestamp: entry?.timestamp || null,
      speaker: entry?.speaker || 'system',
      text: limitListText(entry?.text || '', SESSION_LIST_TEXT_LIMIT),
      stream: entry?.stream || null,
      fileCount: Array.isArray(entry?.files) ? entry.files.length : 0,
    }))
    .filter((entry) => entry.text || entry.fileCount);
}

function publicSessionListRecord(session) {
  if (!session || typeof session !== 'object') {
    return session;
  }
  const projected = sessionWithAssistantProjection(session);
  return {
    ...projected,
    latestUserMessage: limitListText(session.latestUserMessage || '', SESSION_LIST_LATEST_TEXT_LIMIT) || null,
    latestAgentMessage: limitListText(session.latestAgentMessage || '', SESSION_LIST_LATEST_TEXT_LIMIT) || null,
    transcriptPreview: publicTranscriptPreview(session.transcriptPreview),
  };
}

function requestHostSessionDiscovery(hostId) {
  const host = state.hosts.get(hostId);
  if (!host || !hostOnline(host)) {
    return false;
  }

  const now = Date.now();
  const lastRequested = state.sessionDiscoveryRequests.get(hostId) || 0;
  if (now - lastRequested < HOST_SESSION_DISCOVERY_REQUEST_COOLDOWN_MS) {
    return false;
  }

  state.sessionDiscoveryRequests.set(hostId, now);
  enqueueCommand(hostId, { type: 'host.import' });
  return true;
}

function normalizeSessionWatchRevision(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function enqueueSessionWatch(hostId, sessionId, body = {}) {
  const session = getSession(hostId, sessionId) || {};
  return enqueueCommand(hostId, {
    type: 'session.watch',
    sessionId,
    requestId: body.requestId || makeId(),
    clientId: body.clientId || null,
    viewId: body.viewId || null,
    watchRevision: normalizeSessionWatchRevision(body.watchRevision),
    nativeThreadId: body.nativeThreadId || session.nativeThreadId || null,
    bridgeSessionId: body.bridgeSessionId || session.bridgeSessionId || null,
    originSessionId: body.originSessionId || session.originSessionId || null,
    sourceSessionId: body.sourceSessionId || session.sourceSessionId || null,
    conversationKey: body.conversationKey || session.conversationKey || null,
  });
}

function enqueueSessionUnwatch(hostId, sessionId, body = {}) {
  const session = getSession(hostId, sessionId) || {};
  return enqueueCommand(hostId, {
    type: 'session.unwatch',
    sessionId,
    requestId: body.requestId || makeId(),
    clientId: body.clientId || null,
    viewId: body.viewId || null,
    watchRevision: normalizeSessionWatchRevision(body.watchRevision),
    nativeThreadId: body.nativeThreadId || session.nativeThreadId || null,
    bridgeSessionId: body.bridgeSessionId || session.bridgeSessionId || null,
    originSessionId: body.originSessionId || session.originSessionId || null,
    sourceSessionId: body.sourceSessionId || session.sourceSessionId || null,
    conversationKey: body.conversationKey || session.conversationKey || null,
  });
}

function getLocalRelayHostId() {
  return legacySafeLocalAgentId(process.env.RELAY_LOCAL_HOST_ID || process.env.HOST_ID || os.hostname() || 'local')
    .toLowerCase();
}

function getLocalRelayHostLabel() {
  const configured = String(process.env.RELAY_LOCAL_HOST_LABEL || process.env.HOST_LABEL || '').trim();
  if (configured) {
    return configured;
  }
  const platformLabel = process.platform === 'win32' ? 'Windows' : process.platform;
  return `${os.hostname() || 'local'} ${platformLabel}`.trim();
}

function ensureLocalRelayHost() {
  if (String(process.env.RELAY_LOCAL_HOST_STUB || 'true').trim().toLowerCase() === 'false') {
    return null;
  }

  const hostId = getLocalRelayHostId();
  if (!hostId || state.dismissedHosts.has(hostId)) {
    return null;
  }

  const existing = state.hosts.get(hostId);
  if (existing) {
    existing.relayLocal = true;
    existing.platform = existing.platform || process.platform;
    existing.label = existing.label || getLocalRelayHostLabel();
    state.hosts.set(hostId, existing);
    return existing;
  }

  const localAgent = state.localAgents.get(hostId);
  const host = {
    hostId,
    label: localAgent?.label || getLocalRelayHostLabel(),
    platform: process.platform,
    capabilities: {},
    registeredAt: nowIso(),
    lastSeenAt: null,
    relayLocal: true,
  };
  state.hosts.set(hostId, host);
  return host;
}

function legacySafeLocalAgentId(value) {
  return String(value || 'local')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'local';
}

function safeLocalAgentId(value) {
  const hostId = String(value || 'local');
  const readable = legacySafeLocalAgentId(hostId).slice(0, 56);
  const digest = crypto.createHash('sha256').update(hostId, 'utf8').digest('hex').slice(0, 16);
  return `${readable}-${digest}`;
}

function localAgentOwnershipMarkerPath(hostId) {
  return path.join(LOCAL_AGENT_LOG_ROOT, `${safeLocalAgentId(hostId)}.owner.json`);
}

function localAgentOwnershipMarkerPaths(hostId) {
  const current = localAgentOwnershipMarkerPath(hostId);
  const legacy = path.join(LOCAL_AGENT_LOG_ROOT, `${legacySafeLocalAgentId(hostId)}.owner.json`);
  return current === legacy ? [current] : [current, legacy];
}

function normalizeLocalAgentProcessMetadata(input) {
  if (!input || input.relayManaged !== true) return null;
  const pid = Math.trunc(Number(input.pid || 0));
  const parentPid = Math.trunc(Number(input.parentPid || 0));
  const instanceId = String(input.instanceId || '').trim();
  const ownershipToken = String(input.ownershipToken || '').trim();
  const relayUrl = String(input.relayUrl || '').trim();
  if (pid <= 0 || !instanceId || !ownershipToken || relayUrl !== getLocalRelayUrl()) {
    return null;
  }
  return {
    relayManaged: true,
    pid,
    parentPid: parentPid > 0 ? parentPid : null,
    instanceId,
    ownershipToken,
    relayUrl,
    startedAt: String(input.startedAt || '').trim() || null,
  };
}

function inspectLocalAgentOwnershipMarkerFile(markerPath, hostId) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (
      marker?.kind === 'remote-codex-local-agent-owner'
      && Number(marker.version) === 1
      && String(marker.hostId || '') === String(hostId || '')
    ) {
      return {
        status: 'present',
        marker: { ...marker, markerPath },
        error: null,
      };
    }
    const error = new Error(`invalid local Agent ownership marker at ${markerPath}`);
    error.code = 'local_agent_ownership_marker_invalid';
    return { status: 'unknown', marker: null, error };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'absent', marker: null, error: null };
    }
    return { status: 'unknown', marker: null, error };
  }
}

function readLocalAgentOwnershipMarkerFile(markerPath, hostId) {
  return inspectLocalAgentOwnershipMarkerFile(markerPath, hostId).marker;
}

function restoreClaimedLocalAgentOwnershipMarker(hostId) {
  let names = [];
  try {
    names = fs.readdirSync(LOCAL_AGENT_LOG_ROOT);
  } catch (_) {
    return false;
  }
  const candidates = [];
  for (const markerPath of localAgentOwnershipMarkerPaths(hostId)) {
    const prefix = `${path.basename(markerPath)}.`;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.stale-claim')) continue;
      const claimPath = path.join(LOCAL_AGENT_LOG_ROOT, name);
      const marker = readLocalAgentOwnershipMarkerFile(claimPath, hostId);
      if (!marker) continue;
      let modifiedAtMs = 0;
      try {
        modifiedAtMs = fs.statSync(claimPath).mtimeMs || 0;
      } catch (_) {
        // Keep a valid claim eligible even if stat metadata is unavailable.
      }
      candidates.push({ claimPath, markerPath, marker, modifiedAtMs });
    }
  }
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  for (const candidate of candidates) {
    try {
      fs.linkSync(candidate.claimPath, candidate.markerPath);
      fs.rmSync(candidate.claimPath, { force: true });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return true;
    }
  }
  return false;
}

function inspectLocalAgentOwnershipMarkerRead(hostId) {
  const markerPaths = localAgentOwnershipMarkerPaths(hostId);
  const scan = () => {
    let unknown = null;
    for (const markerPath of markerPaths) {
      const inspection = inspectLocalAgentOwnershipMarkerFile(markerPath, hostId);
      if (inspection.status === 'present') return inspection;
      if (inspection.status === 'unknown' && !unknown) unknown = inspection;
    }
    return unknown || { status: 'absent', marker: null, error: null };
  };

  const initial = scan();
  if (initial.status === 'present') return initial;
  if (restoreClaimedLocalAgentOwnershipMarker(hostId)) {
    const restored = scan();
    if (restored.status !== 'absent') return restored;
  }
  return initial;
}

function readLocalAgentOwnershipMarker(hostId) {
  return inspectLocalAgentOwnershipMarkerRead(hostId).marker;
}

function writeLocalAgentOwnershipMarker(record) {
  const markerPath = localAgentOwnershipMarkerPath(record.hostId);
  const inspection = inspectUnclaimedLocalAgentOwnershipMarker(record.hostId);
  const existing = inspection.marker;
  if (existing && localAgentOwnershipMarkerMatchesRecord(existing, record)) {
    record.ownershipMarkerPath = existing.markerPath;
    return {
      markerPath: existing.markerPath,
      staleOwnershipRecovered: inspection.staleOwnershipRecovered === true,
    };
  }
  const unresolvedOwnership = !existing
    && !['absent', 'recovered'].includes(inspection.status);
  if (existing || unresolvedOwnership) {
    const error = new Error(
      ['unknown', 'marker_changed'].includes(inspection.status)
        ? `local agent ownership marker identity could not be verified for ${record.hostId}`
        : `live local agent ownership marker already exists for ${record.hostId}`
    );
    error.code = ['unknown', 'marker_changed'].includes(inspection.status)
      ? 'local_agent_ownership_unknown'
      : 'local_agent_ownership_conflict';
    throw error;
  }
  const marker = {
    kind: 'remote-codex-local-agent-owner',
    version: 1,
    hostId: record.hostId,
    pid: record.pid,
    instanceId: record.instanceId,
    ownershipToken: record.ownershipToken,
    ownerRelayPid: process.pid,
    ownerRelayInstanceId: RELAY_INSTANCE_ID,
    relayUrl: record.relayUrl,
    startedAt: record.startedAt,
    processStartedAt: record.startedAt,
    agentEntrypoint: LOCAL_AGENT_ENTRYPOINT,
  };
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tempPath = `${markerPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    // A hard link publishes the complete temp file without overwriting a marker
    // that appeared after the ownership assessment.
    fs.linkSync(tempPath, markerPath);
    fs.rmSync(tempPath, { force: true });
  } catch (error) {
    const racedMarker = readLocalAgentOwnershipMarker(record.hostId);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_) {
      // Best effort cleanup of an incomplete marker write.
    }
    if (racedMarker && localAgentOwnershipMarkerMatchesRecord(racedMarker, record)) {
      record.ownershipMarkerPath = racedMarker.markerPath;
      return {
        markerPath: racedMarker.markerPath,
        staleOwnershipRecovered: inspection.staleOwnershipRecovered === true,
      };
    }
    throw error;
  }
  record.ownershipMarkerPath = markerPath;
  return {
    markerPath,
    staleOwnershipRecovered: inspection.staleOwnershipRecovered === true,
  };
}

function localAgentOwnershipMarkerMatchesSnapshot(marker, snapshot) {
  return Boolean(
    marker
    && snapshot
    && String(marker.markerPath || '') === String(snapshot.markerPath || '')
    && Number(marker.pid || 0) === Number(snapshot.pid || 0)
    && String(marker.instanceId || '') === String(snapshot.instanceId || '')
    && String(marker.ownershipToken || '') === String(snapshot.ownershipToken || '')
    && String(marker.startedAt || '') === String(snapshot.startedAt || '')
    && String(marker.processStartedAt || '') === String(snapshot.processStartedAt || '')
    && String(marker.agentEntrypoint || '') === String(snapshot.agentEntrypoint || '')
    && String(marker.ownerRelayInstanceId || '') === String(snapshot.ownerRelayInstanceId || '')
    && String(marker.relayUrl || '') === String(snapshot.relayUrl || '')
  );
}

function localAgentOwnershipMarkerMatchesRecord(marker, record) {
  return Boolean(
    marker
    && record
    && Number(marker.pid || 0) === Number(record.pid || record.lastPid || 0)
    && String(marker.instanceId || '') === String(record.instanceId || '')
    && String(marker.ownershipToken || '') === String(record.ownershipToken || '')
  );
}

function removeLocalAgentOwnershipMarkerIfUnchanged(snapshot) {
  if (!snapshot?.hostId || !snapshot.markerPath) {
    return { removed: false, changed: false, marker: null };
  }
  const current = readLocalAgentOwnershipMarker(snapshot.hostId);
  if (!localAgentOwnershipMarkerMatchesSnapshot(current, snapshot)) {
    return { removed: false, changed: true, marker: current };
  }
  const claimedPath = `${current.markerPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.stale-claim`;
  try {
    // Rename atomically claims whichever marker is present at deletion time.
    // The claimed content is verified again before it is discarded.
    fs.renameSync(current.markerPath, claimedPath);
  } catch (error) {
    return {
      removed: false,
      changed: ['ENOENT', 'EEXIST'].includes(error?.code),
      marker: readLocalAgentOwnershipMarker(snapshot.hostId),
      error,
    };
  }

  let claimed = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(claimedPath, 'utf8'));
    claimed = { ...parsed, markerPath: current.markerPath };
  } catch (_) {
    claimed = null;
  }
  if (!localAgentOwnershipMarkerMatchesSnapshot(claimed, snapshot)) {
    try {
      fs.linkSync(claimedPath, current.markerPath);
      fs.rmSync(claimedPath, { force: true });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        // A newer marker already occupies the canonical path and wins.
        fs.rmSync(claimedPath, { force: true });
      } else {
        return {
          removed: false,
          changed: true,
          marker: readLocalAgentOwnershipMarker(snapshot.hostId) || claimed,
          error,
        };
      }
    }
    return {
      removed: false,
      changed: true,
      marker: readLocalAgentOwnershipMarker(snapshot.hostId) || claimed,
    };
  }

  try {
    fs.rmSync(claimedPath, { force: true });
  } catch (_) {
    // The canonical ownership path is already clear. A claim-file cleanup
    // failure cannot make that PID authoritative again.
  }
  return {
    removed: true,
    changed: false,
    marker: readLocalAgentOwnershipMarker(snapshot.hostId),
  };
}

function removeLocalAgentOwnershipMarker(record) {
  if (!record?.hostId) return false;
  const marker = readLocalAgentOwnershipMarker(record.hostId);
  if (!localAgentOwnershipMarkerMatchesRecord(marker, record)) return false;
  return removeLocalAgentOwnershipMarkerIfUnchanged(marker).removed;
}

function processIsAlive(pid) {
  const normalizedPid = Math.trunc(Number(pid || 0));
  if (normalizedPid <= 0) return false;
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

let linuxClockTicksPerSecond = null;
let linuxBootTimeMs = null;
const localAgentOwnershipAssessmentCache = new Map();

function windowsPowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function probeWindowsLocalAgentProcessIdentity(pid) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$targetPid = ${pid}`,
    "$result = [ordered]@{ startedAtMs = $null; executable = ''; commandLine = '' }",
    "try { $cim = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $targetPid) -ErrorAction Stop; if ($null -ne $cim) { $result.startedAtMs = ([DateTimeOffset]$cim.CreationDate).ToUnixTimeMilliseconds(); $result.executable = [string]$cim.ExecutablePath; $result.commandLine = [string]$cim.CommandLine } } catch {}",
    "if ($null -eq $result.startedAtMs) { try { $processInfo = Get-Process -Id $targetPid -ErrorAction Stop; $result.startedAtMs = ([DateTimeOffset]$processInfo.StartTime).ToUnixTimeMilliseconds(); try { $result.executable = [string]$processInfo.Path } catch {} } catch {} }",
    '$result | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync(windowsPowerShellPath(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  let parsed = null;
  if (!result.error && result.status === 0) {
    const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      parsed = null;
    }
  }
  const alive = processIsAlive(pid);
  const startedAtMs = Number(parsed?.startedAtMs || 0) || null;
  const executable = String(parsed?.executable || '').trim() || null;
  const commandLine = String(parsed?.commandLine || '').trim() || null;
  return {
    alive,
    startedAtMs,
    executable,
    commandLine,
    verified: Boolean(alive && startedAtMs && commandLine),
  };
}

function readLinuxProcessStartTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) throw new Error(`invalid /proc/${pid}/stat`);
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const ticks = Number(fields[19]);
  if (!Number.isFinite(ticks) || ticks < 0) throw new Error(`invalid process start ticks for ${pid}`);
  return ticks;
}

function getLinuxClockTicksPerSecond() {
  if (linuxClockTicksPerSecond) return linuxClockTicksPerSecond;
  const result = spawnSync('getconf', ['CLK_TCK'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2000,
  });
  const ticks = Number(String(result.stdout || '').trim());
  if (result.error || result.status !== 0 || !Number.isFinite(ticks) || ticks <= 0) {
    throw new Error('Linux clock tick rate is unavailable');
  }
  linuxClockTicksPerSecond = ticks;
  return linuxClockTicksPerSecond;
}

function getLinuxBootTimeMs() {
  if (linuxBootTimeMs) return linuxBootTimeMs;
  const match = fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m);
  if (!match) throw new Error('Linux boot time is unavailable');
  linuxBootTimeMs = Number(match[1]) * 1000;
  return linuxBootTimeMs;
}

function probeLinuxLocalAgentProcessIdentity(pid) {
  if (!processIsAlive(pid)) {
    return {
      alive: false,
      startedAtMs: null,
      executable: null,
      commandLine: null,
      argv: null,
      verified: false,
    };
  }
  let firstStartTicks = null;
  let secondStartTicks = null;
  let startedAtMs = null;
  let executable = null;
  let commandLine = null;
  let argv = null;
  try {
    firstStartTicks = readLinuxProcessStartTicks(pid);
    const commandBuffer = fs.readFileSync(`/proc/${pid}/cmdline`);
    argv = commandBuffer.toString('utf8').split('\0').filter(Boolean);
    commandLine = argv.join(' ').trim() || null;
    executable = String(fs.readlinkSync(`/proc/${pid}/exe`) || '').trim() || null;
    secondStartTicks = readLinuxProcessStartTicks(pid);
    if (firstStartTicks === secondStartTicks) {
      startedAtMs = getLinuxBootTimeMs()
        + (firstStartTicks * 1000 / getLinuxClockTicksPerSecond());
    }
  } catch (_) {
    // Permission and procfs availability failures are reported as unknown.
  }
  const alive = processIsAlive(pid);
  const stableIdentity = firstStartTicks != null
    && secondStartTicks != null
    && firstStartTicks === secondStartTicks;
  return {
    alive,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    executable,
    commandLine,
    argv,
    verified: Boolean(alive && stableIdentity && startedAtMs && commandLine),
  };
}

function probeLocalAgentProcessIdentity(pid) {
  const normalizedPid = Math.trunc(Number(pid || 0));
  if (normalizedPid <= 0 || !processIsAlive(normalizedPid)) {
    return { alive: false, startedAtMs: null, executable: null, commandLine: null, verified: false };
  }
  if (process.platform === 'win32') {
    return probeWindowsLocalAgentProcessIdentity(normalizedPid);
  }
  if (process.platform === 'linux') {
    return probeLinuxLocalAgentProcessIdentity(normalizedPid);
  }
  return {
    alive: processIsAlive(normalizedPid),
    startedAtMs: null,
    executable: null,
    commandLine: null,
    verified: false,
  };
}

function normalizeProcessIdentityPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function windowsCommandLineArguments(commandLine, limit = Number.POSITIVE_INFINITY) {
  const args = [];
  const tokenPattern = /"([^"]*)"|([^\s"]+)/g;
  let match = tokenPattern.exec(String(commandLine || ''));
  while (match && args.length < limit) {
    args.push(match[1] == null ? match[2] : match[1]);
    match = tokenPattern.exec(String(commandLine || ''));
  }
  return args;
}

function processIdentityMatchesLocalAgentEntrypoint(identity) {
  if (process.platform === 'win32') {
    const argv = windowsCommandLineArguments(identity?.commandLine, 3);
    return normalizeProcessIdentityPath(argv[1])
      === normalizeProcessIdentityPath(LOCAL_AGENT_IDENTITY_ENTRYPOINT);
  }
  if (process.platform === 'linux' && Array.isArray(identity?.argv)) {
    return normalizeProcessIdentityPath(identity.argv[1])
      === normalizeProcessIdentityPath(LOCAL_AGENT_IDENTITY_ENTRYPOINT);
  }
  return false;
}

function assessLocalAgentOwnershipMarker(marker) {
  const cacheKey = JSON.stringify([
    String(marker?.markerPath || ''),
    Number(marker?.pid || 0),
    String(marker?.instanceId || ''),
    String(marker?.ownershipToken || ''),
    String(marker?.processStartedAt || marker?.startedAt || ''),
  ]);
  const cached = localAgentOwnershipAssessmentCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < LOCAL_AGENT_PROCESS_IDENTITY_CACHE_MS) {
    return cached.assessment;
  }
  const identity = probeLocalAgentProcessIdentity(marker?.pid);
  let assessment = null;
  if (!identity.alive) {
    assessment = { status: 'stale', identity };
  } else {
    const markerStartedAtMs = Date.parse(marker?.processStartedAt || marker?.startedAt || '');
    const hasStartIdentity = Number.isFinite(markerStartedAtMs) && markerStartedAtMs > 0
      && Number.isFinite(identity.startedAtMs) && identity.startedAtMs > 0;
    const entrypointMatches = processIdentityMatchesLocalAgentEntrypoint(identity);
    if (
      hasStartIdentity
      && Math.abs(identity.startedAtMs - markerStartedAtMs) > LOCAL_AGENT_PROCESS_START_TOLERANCE_MS
    ) {
      assessment = { status: 'pid_reused', identity };
    } else if (identity.commandLine && !entrypointMatches) {
      assessment = { status: 'pid_reused', identity };
    } else if (
      identity.verified
      && hasStartIdentity
      && entrypointMatches
    ) {
      assessment = { status: 'live_agent', identity };
    } else {
      assessment = { status: 'unknown', identity };
    }
  }
  localAgentOwnershipAssessmentCache.set(cacheKey, {
    cachedAt: Date.now(),
    assessment,
  });
  while (localAgentOwnershipAssessmentCache.size > LOCAL_AGENT_PROCESS_IDENTITY_CACHE_LIMIT) {
    localAgentOwnershipAssessmentCache.delete(localAgentOwnershipAssessmentCache.keys().next().value);
  }
  return assessment;
}

function localAgentProcessIsAlive(record) {
  if (!record) return false;
  if (record.process) {
    return record.process.exitCode === null
      && record.process.signalCode === null;
  }
  const marker = readLocalAgentOwnershipMarker(record.hostId);
  if (!localAgentOwnershipMarkerMatchesRecord(marker, record)) return false;
  const assessment = assessLocalAgentOwnershipMarker(marker);
  // An unverifiable identity stays fail-closed: it may still be the adopted
  // Agent, so callers must not delete its marker or start a duplicate.
  return ['live_agent', 'unknown'].includes(assessment.status);
}

function spawnAndWait(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8').trim().slice(-2000),
      stderr: Buffer.concat(stderr).toString('utf8').trim().slice(-2000),
    }));
  });
}

function posixProcessTreePids(rootPid) {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return [rootPid];
  const children = new Map();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const list = children.get(parentPid) || [];
    list.push(pid);
    children.set(parentPid, list);
  }
  const ordered = [];
  const visit = (pid) => {
    for (const childPid of children.get(pid) || []) visit(childPid);
    ordered.push(pid);
  };
  visit(rootPid);
  return ordered;
}

async function forceKillProcessTree(pid) {
  const normalizedPid = Math.trunc(Number(pid || 0));
  if (normalizedPid <= 0 || !processIsAlive(normalizedPid)) return true;
  let terminationFailure = '';
  if (process.platform === 'win32') {
    const taskkill = String(process.env.RELAY_LOCAL_AGENT_TASKKILL_PATH || '').trim()
      || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const result = await spawnAndWait(taskkill, ['/PID', String(normalizedPid), '/T', '/F']);
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').replace(/\s+/g, ' ').trim();
      terminationFailure = `taskkill exited with code ${result.code}${detail ? `: ${detail}` : ''}`;
    }
  } else {
    for (const targetPid of posixProcessTreePids(normalizedPid)) {
      try {
        process.kill(targetPid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  }
  const deadline = Date.now() + LOCAL_AGENT_FORCE_EXIT_WAIT_MS;
  while (processIsAlive(normalizedPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOCAL_AGENT_EXIT_POLL_MS));
  }
  if (processIsAlive(normalizedPid)) {
    throw new Error(
      terminationFailure
      || `process ${normalizedPid} remained alive after process-tree termination`
    );
  }
  return true;
}

function localAgentHasAuthoritativeProcessIdentity(record) {
  return Boolean(
    record?.process
    && Number(record.process.pid || 0) > 0
    && Number(record.process.pid) === Number(record.pid || 0)
    && record.process.exitCode === null
    && record.process.signalCode === null
  );
}

function forceKillLocalAgentRecord(record) {
  if (!localAgentHasAuthoritativeProcessIdentity(record)) {
    const error = new Error(
      'Relay cannot force-kill a recovered local Agent without authoritative ChildProcess identity.'
    );
    error.code = 'local_agent_process_identity_unverified';
    return Promise.reject(error);
  }
  return forceKillProcessTree(record.pid);
}

function localAgentMarkerMatchesMetadata(hostId, metadata) {
  const marker = readLocalAgentOwnershipMarker(hostId);
  return Boolean(
    marker
    && Number(marker.pid || 0) === metadata.pid
    && String(marker.instanceId || '') === metadata.instanceId
    && String(marker.ownershipToken || '') === metadata.ownershipToken
    && String(marker.relayUrl || '') === metadata.relayUrl
  );
}

function createRecoveredLocalAgentRecord(hostId, label, metadata, existing = null) {
  const safeId = safeLocalAgentId(hostId);
  const record = {
    hostId,
    label: String(label || hostId).trim() || hostId,
    status: 'running',
    startedAt: metadata.startedAt || nowIso(),
    updatedAt: nowIso(),
    registeredAt: nowIso(),
    process: null,
    pid: metadata.pid,
    parentPid: metadata.parentPid,
    instanceId: metadata.instanceId,
    ownershipToken: metadata.ownershipToken,
    ownershipMarkerPath: localAgentOwnershipMarkerPath(hostId),
    relayUrl: metadata.relayUrl,
    logPath: path.join(LOCAL_AGENT_LOG_ROOT, `${safeId}.out.log`),
    errorLogPath: path.join(LOCAL_AGENT_LOG_ROOT, `${safeId}.err.log`),
    message: 'recovered Relay-managed local host-agent',
    desiredState: 'running',
    autoRestart: true,
    restartCount: existing?.restartCount || 0,
    lastRestartAt: existing?.lastRestartAt || null,
    nextRestartAt: null,
    restartReason: null,
    restartTimer: null,
    restartAfterStop: false,
    shutdownTimer: null,
    shutdownPollTimer: null,
    shutdownCommandId: null,
    forceKillPromise: null,
    exitCompletionPromise: null,
    recovered: true,
  };
  state.localAgents.set(hostId, record);
  return record;
}

function trackLocalAgentForRelayShutdown(record, signal = 'shutdown') {
  if (!relayShutdownContext || !localAgentProcessIsAlive(record)) return false;
  const added = !relayShutdownContext.records.has(record);
  relayShutdownContext.records.add(record);
  if (added) {
    relayShutdownContext.deadline = Math.max(
      relayShutdownContext.deadline,
      Date.now() + LOCAL_AGENT_SHUTDOWN_GRACE_MS + LOCAL_AGENT_FORCE_EXIT_WAIT_MS + 2000
    );
  }
  stopLocalAgent(record.hostId, {
    disableAutoRestart: true,
    reason: `Relay ${signal} shutdown`,
  });
  return true;
}

function reconcileRegisteredLocalAgent(hostId, label, input) {
  const existing = state.localAgents.get(hostId);
  if (!input || input.relayManaged !== true) {
    const hasLiveRecord = localAgentProcessIsAlive(existing);
    const ownershipInspection = hasLiveRecord
      ? null
      : inspectUnclaimedLocalAgentOwnershipMarker(hostId);
    if (
      hasLiveRecord
      || Boolean(ownershipInspection?.marker)
    ) {
      return {
        ok: false,
        code: 'local_agent_ownership_required',
        message: `Relay-managed Agent ownership attestation is required for ${hostId}.`,
      };
    }
    return { ok: true, adopted: false };
  }
  const metadata = normalizeLocalAgentProcessMetadata(input);
  if (!metadata || !localAgentMarkerMatchesMetadata(hostId, metadata)) {
    return {
      ok: false,
      code: 'local_agent_ownership_mismatch',
      message: `Relay-managed Agent ownership attestation did not match ${hostId}.`,
    };
  }
  if (relayShutdownPromise && !localAgentProcessIsAlive(existing)) {
    const record = createRecoveredLocalAgentRecord(hostId, label, metadata, existing);
    trackLocalAgentForRelayShutdown(record);
    return {
      ok: false,
      code: 'local_agent_ownership_mismatch',
      message: `Relay shutdown has revoked managed Agent ownership for ${hostId}.`,
    };
  }
  if (
    existing
    && existing.instanceId !== metadata.instanceId
    && localAgentProcessIsAlive(existing)
  ) {
    return {
      ok: false,
      code: 'local_agent_instance_conflict',
      message: `A different Relay-managed Agent instance is already active for ${hostId}.`,
    };
  }
  if (existing?.instanceId === metadata.instanceId) {
    existing.pid = metadata.pid;
    existing.parentPid = metadata.parentPid;
    existing.registeredAt = nowIso();
    existing.updatedAt = existing.registeredAt;
    existing.status = existing.desiredState === 'stopped'
      ? (existing.status === 'error' ? 'error' : 'stopping')
      : ['stopping', 'restarting'].includes(existing.status)
        ? existing.status
        : 'running';
    return { ok: true, adopted: false, record: existing };
  }

  const record = createRecoveredLocalAgentRecord(hostId, label, metadata, existing);
  return { ok: true, adopted: true, record };
}

function inspectUnclaimedLocalAgentOwnershipMarker(hostId) {
  let staleOwnershipRecovered = false;
  let recoveredReason = null;
  const maximumMarkers = localAgentOwnershipMarkerPaths(hostId).length;
  for (let attempt = 0; attempt <= maximumMarkers; attempt += 1) {
    const marker = readLocalAgentOwnershipMarker(hostId);
    if (!marker) {
      return {
        status: staleOwnershipRecovered ? 'recovered' : 'absent',
        marker: null,
        identity: null,
        staleOwnershipRecovered,
        recoveredReason,
      };
    }
    const assessment = assessLocalAgentOwnershipMarker(marker);
    if (!['stale', 'pid_reused'].includes(assessment.status)) {
      return {
        ...assessment,
        marker,
        staleOwnershipRecovered,
        recoveredReason,
      };
    }

    const removal = removeLocalAgentOwnershipMarkerIfUnchanged(marker);
    if (!removal.removed) {
      return {
        status: removal.changed ? 'marker_changed' : 'unknown',
        marker: removal.marker || readLocalAgentOwnershipMarker(hostId),
        identity: assessment.identity,
        staleOwnershipRecovered,
        recoveredReason,
        error: removal.error || null,
      };
    }
    staleOwnershipRecovered = true;
    recoveredReason = assessment.status;
  }
  return {
    status: 'unknown',
    marker: readLocalAgentOwnershipMarker(hostId),
    identity: null,
    staleOwnershipRecovered,
    recoveredReason,
  };
}

function agentPollOwnershipAttestation(req) {
  const relayManaged = String(req.headers['x-remote-codex-agent-managed'] || '').trim() === '1';
  if (!relayManaged) return null;
  return {
    pid: Math.trunc(Number(req.headers['x-remote-codex-agent-pid'] || 0)),
    instanceId: String(req.headers['x-remote-codex-agent-instance'] || '').trim(),
    ownershipToken: String(req.headers['x-remote-codex-agent-token'] || '').trim(),
  };
}

function agentLeaseCredentials(req, body = null) {
  return {
    agentInstanceId: String(
      body?.agentInstanceId
      || req.headers['x-remote-codex-agent-instance']
      || ''
    ).trim(),
    leaseId: String(
      body?.agentLeaseId
      || req.headers['x-remote-codex-agent-lease']
      || ''
    ).trim(),
  };
}

function authorizeLocalAgentOwnership(hostId, req) {
  const existing = state.localAgents.get(hostId);
  const hasLiveRecord = localAgentProcessIsAlive(existing);
  const ownershipInspection = hasLiveRecord
    ? null
    : inspectUnclaimedLocalAgentOwnershipMarker(hostId);
  const marker = ownershipInspection?.marker || null;
  const hasLiveOwnership = hasLiveRecord || Boolean(marker);
  const attestation = agentPollOwnershipAttestation(req);
  if (!hasLiveOwnership) {
    return attestation
      ? {
        ok: false,
        code: 'local_agent_ownership_mismatch',
        message: `Relay-managed Agent ownership is no longer active for ${hostId}.`,
      }
      : { ok: true, managedAttestation: false };
  }
  if (!attestation) {
    return {
      ok: false,
      code: 'local_agent_ownership_required',
      message: `Relay-managed Agent ownership attestation is required for ${hostId}.`,
    };
  }
  const expected = hasLiveRecord ? existing : marker;
  const expectedMarker = readLocalAgentOwnershipMarker(hostId);
  const matches = attestation.pid > 0
    && attestation.pid === Number(expected.pid || 0)
    && attestation.instanceId === String(expected.instanceId || '')
    && constantTimeEqual(attestation.ownershipToken, expected.ownershipToken)
    && expectedMarker
    && Number(expectedMarker.pid || 0) === attestation.pid
    && String(expectedMarker.instanceId || '') === attestation.instanceId
    && constantTimeEqual(attestation.ownershipToken, expectedMarker.ownershipToken);
  return matches
    ? { ok: true, managedAttestation: true }
    : {
      ok: false,
      code: 'local_agent_ownership_mismatch',
      message: `Relay-managed Agent ownership attestation did not match ${hostId}.`,
    };
}

function authorizeAgentCommandPoll(hostId, req, options = {}) {
  const localAuthorization = authorizeLocalAgentOwnership(hostId, req);
  if (!localAuthorization.ok) {
    return localAuthorization;
  }
  const credentials = agentLeaseCredentials(req);
  const currentLease = state.hostAgentLeases.current(hostId);
  if (
    localAuthorization.managedAttestation
    && !credentials.leaseId
    && (!currentLease || currentLease.agentInstanceId === credentials.agentInstanceId)
  ) {
    // Compatibility for Relay-managed Agents from before host-wide leases.
    return { ok: true, legacy: true, release: () => {} };
  }
  return state.hostAgentLeases.authorize(
    hostId,
    credentials.agentInstanceId,
    credentials.leaseId,
    options
  );
}

function validateAgentEventBatchScope(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      ok: false,
      code: 'agent_event_batch_empty',
      message: 'Agent event batch must contain at least one event.',
    };
  }
  const hostIds = events.map((event) => String(event?.hostId || '').trim());
  if (hostIds.some((hostId) => !hostId)) {
    return {
      ok: false,
      code: 'agent_event_host_required',
      message: 'Every Agent event must include hostId.',
    };
  }
  const uniqueHostIds = new Set(hostIds);
  if (uniqueHostIds.size !== 1) {
    return {
      ok: false,
      code: 'agent_event_host_mismatch',
      message: 'Every event in an Agent batch must use the same hostId.',
    };
  }
  return { ok: true, hostId: hostIds[0] };
}

function authorizeAgentEventBatch(hostId, req) {
  return authorizeAgentCommandPoll(hostId, req, { hold: true });
}

function getLocalRelayUrl() {
  return `http://127.0.0.1:${PORT}`;
}

function clearLocalAgentRestartTimer(record) {
  if (!record?.restartTimer) {
    return;
  }
  clearTimeout(record.restartTimer);
  record.restartTimer = null;
  record.nextRestartAt = null;
}

function localAgentTimestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldAutoRestartLocalAgent(record) {
  return Boolean(
    LOCAL_AGENT_START_ENABLED
      && LOCAL_AGENT_WATCHDOG_ENABLED
      && record
      && record.autoRestart !== false
      && record.desiredState !== 'stopped'
  );
}

function getLocalAgentRestartDelay(record, requestedDelayMs = 0) {
  const requested = Number(requestedDelayMs) || 0;
  const lastRestartMs = localAgentTimestampMs(record?.lastRestartAt);
  if (!lastRestartMs) {
    return Math.max(0, requested);
  }
  const cooldownLeft = LOCAL_AGENT_RESTART_COOLDOWN_MS - (Date.now() - lastRestartMs);
  return Math.max(0, requested, cooldownLeft);
}

function publicLocalAgentRecord(record) {
  if (!record) {
    return null;
  }
  return {
    hostId: record.hostId,
    label: record.label,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    exitedAt: record.exitedAt || null,
    exitCode: record.exitCode ?? null,
    signal: record.signal || null,
    pid: record.process?.pid || record.pid || null,
    relayUrl: record.relayUrl || getLocalRelayUrl(),
    logPath: record.logPath || null,
    errorLogPath: record.errorLogPath || null,
    message: record.message || '',
    desiredState: record.desiredState || 'running',
    autoRestart: record.autoRestart !== false,
    restartCount: record.restartCount || 0,
    lastRestartAt: record.lastRestartAt || null,
    nextRestartAt: record.nextRestartAt || null,
    restartReason: record.restartReason || null,
  };
}

function markLocalAgentExited(hostId, code, signal) {
  const record = state.localAgents.get(hostId);
  if (!record) {
    return;
  }
  clearLocalAgentShutdownTimer(record);
  record.lastPid = record.pid || record.process?.pid || record.lastPid || null;
  removeLocalAgentOwnershipMarker(record);
  record.process = null;
  record.pid = null;
  record.status = ['stopping', 'restarting'].includes(record.status) || record.desiredState === 'stopped'
    ? 'stopped'
    : 'exited';
  record.exitCode = code;
  record.signal = signal || null;
  record.exitedAt = nowIso();
  record.updatedAt = record.exitedAt;
  record.message = signal ? `local agent exited with signal ${signal}` : `local agent exited with code ${code}`;
}

function clearLocalAgentShutdownTimer(record) {
  if (!record) return;
  if (record.shutdownTimer) {
    clearTimeout(record.shutdownTimer);
    record.shutdownTimer = null;
  }
  if (record.shutdownPollTimer) {
    clearInterval(record.shutdownPollTimer);
    record.shutdownPollTimer = null;
  }
}

function completeLocalAgentExit(record, code, signal) {
  if (!record || record.exitCompletionPromise) {
    return record?.exitCompletionPromise || Promise.resolve();
  }
  record.exitCompletionPromise = Promise.resolve().then(async () => {
    let forceKillError = null;
    if (record.forceKillPromise) {
      forceKillError = await record.forceKillPromise;
    }
    if (state.localAgents.get(record.hostId) !== record) return;
    if (record.shutdownCommandId) {
      removeQueuedCommandById(record.hostId, record.shutdownCommandId, 'host.shutdown');
      record.shutdownCommandId = null;
    }
    const restartAfterStop = record.restartAfterStop === true;
    const restartReason = record.restartReason || 'manual restart';
    const shouldRestart = shouldAutoRestartLocalAgent(record)
      && !['stopping', 'restarting'].includes(record.status);
    state.hostAgentLeases.deleteIfOwned(record.hostId, record.instanceId);
    markLocalAgentExited(record.hostId, code, signal);
    if (forceKillError) {
      record.status = 'error';
      record.message = `local agent exited but process-tree termination failed: ${forceKillError.message || forceKillError}`;
      record.updatedAt = nowIso();
      record.restartAfterStop = false;
      return;
    }
    if (restartAfterStop) {
      record.restartAfterStop = false;
      startLocalAgent({
        hostId: record.hostId,
        label: record.label,
        restart: true,
        reason: restartReason,
      });
    } else if (shouldRestart) {
      scheduleLocalAgentRestart(record.hostId, record.message, LOCAL_AGENT_EXIT_RESTART_DELAY_MS);
    }
  });
  return record.exitCompletionPromise;
}

function monitorLocalAgentExit(record) {
  if (!record || record.shutdownPollTimer) return;
  record.shutdownPollTimer = setInterval(() => {
    if (state.localAgents.get(record.hostId) !== record) {
      clearLocalAgentShutdownTimer(record);
      return;
    }
    if (!localAgentProcessIsAlive(record)) {
      void completeLocalAgentExit(record, record.process?.exitCode ?? null, record.process?.signalCode || null);
    }
  }, LOCAL_AGENT_EXIT_POLL_MS);
  record.shutdownPollTimer.unref?.();
}

function scheduleLocalAgentRestart(hostId, reason, delayMs = 0) {
  const record = state.localAgents.get(hostId);
  if (!shouldAutoRestartLocalAgent(record) || record.restartTimer) {
    return false;
  }

  const delay = getLocalAgentRestartDelay(record, delayMs);
  record.status = 'restarting';
  record.restartReason = reason || 'watchdog';
  record.updatedAt = nowIso();
  record.nextRestartAt = new Date(Date.now() + delay).toISOString();
  record.message = `local agent restart scheduled: ${record.restartReason}`;
  record.restartTimer = setTimeout(() => {
    const latest = state.localAgents.get(hostId);
    if (!shouldAutoRestartLocalAgent(latest)) {
      return;
    }
    clearLocalAgentRestartTimer(latest);
    startLocalAgent({
      hostId: latest.hostId,
      label: latest.label,
      restart: true,
      reason: latest.restartReason || reason || 'watchdog',
    });
  }, delay);
  record.restartTimer.unref?.();
  return true;
}

function stopLocalAgent(hostId, options = {}) {
  const record = state.localAgents.get(hostId);
  const disableAutoRestart = options.disableAutoRestart !== false;
  const restartAfterStop = options.restartAfterStop === true;
  if (record) {
    clearLocalAgentRestartTimer(record);
    if (disableAutoRestart) {
      record.desiredState = 'stopped';
      record.autoRestart = false;
      record.restartAfterStop = false;
    } else if (restartAfterStop) {
      record.desiredState = 'running';
      record.autoRestart = true;
      record.restartAfterStop = true;
      record.restartReason = String(options.reason || 'manual restart');
    }
  }
  if (!localAgentProcessIsAlive(record)) {
    if (record) {
      removeLocalAgentOwnershipMarker(record);
      record.process = null;
      record.lastPid = record.pid || record.lastPid || null;
      record.pid = null;
      record.status = 'stopped';
      record.updatedAt = nowIso();
      record.message = 'local agent is not running';
    }
    return {
      ok: true,
      hostId,
      status: 'stopped',
      message: 'No Relay-managed local agent process is running for this host.',
      localAgent: publicLocalAgentRecord(record),
    };
  }

  if (record.shutdownTimer) {
    return {
      ok: true,
      hostId,
      status: record.status,
      message: 'Local host-agent graceful shutdown is already pending.',
      localAgent: publicLocalAgentRecord(record),
    };
  }

  record.status = restartAfterStop ? 'restarting' : 'stopping';
  record.updatedAt = nowIso();
  record.message = restartAfterStop
    ? 'gracefully stopping local agent before restart'
    : 'gracefully stopping local agent';
  const command = enqueueCommand(hostId, {
    type: 'host.shutdown',
    reason: String(options.reason || (restartAfterStop ? 'relay-managed restart' : 'relay-managed stop')),
  });
  record.shutdownCommandId = command.id;
  const expectedPid = Number(record.pid || record.process?.pid || 0);
  const expectedInstanceId = record.instanceId;
  record.shutdownTimer = setTimeout(() => {
    const current = state.localAgents.get(hostId);
    if (
      current !== record
      || current.instanceId !== expectedInstanceId
      || Number(current.pid || current.process?.pid || 0) !== expectedPid
      || !localAgentProcessIsAlive(current)
    ) {
      return;
    }
    current.message = `graceful shutdown timed out after ${LOCAL_AGENT_SHUTDOWN_GRACE_MS}ms; forcing local agent exit`;
    current.updatedAt = nowIso();
    current.forceKillPromise = forceKillLocalAgentRecord(current).then(() => null, (error) => {
      current.status = 'error';
      current.message = `failed to force local agent process tree exit: ${error.message || error}`;
      current.updatedAt = nowIso();
      return error;
    });
  }, LOCAL_AGENT_SHUTDOWN_GRACE_MS);
  record.shutdownTimer.unref?.();
  monitorLocalAgentExit(record);
  return {
    ok: true,
    hostId,
    status: record.status,
    message: 'Local host-agent graceful shutdown requested.',
    command,
    localAgent: publicLocalAgentRecord(record),
  };
}

function startLocalAgent({ hostId, label, restart = false, reason = '' } = {}) {
  const normalizedHostId = String(hostId || os.hostname() || 'local').trim();
  if (!normalizedHostId) {
    return { ok: false, status: 'invalid_host', message: 'hostId is required' };
  }
  if (!LOCAL_AGENT_START_ENABLED) {
    return {
      ok: false,
      status: 'local_agent_start_disabled',
      message: 'This Relay instance is not allowed to start a local Agent.',
    };
  }
  if (relayShutdownPromise) {
    return { ok: false, status: 'relay_stopping', message: 'Relay is shutting down.' };
  }

  const existing = state.localAgents.get(normalizedHostId);
  let staleOwnershipRecovered = false;
  let existingProcessIsVerifiedLive = localAgentHasAuthoritativeProcessIdentity(existing);
  if (!existingProcessIsVerifiedLive) {
    const ownershipInspection = inspectUnclaimedLocalAgentOwnershipMarker(normalizedHostId);
    staleOwnershipRecovered = ownershipInspection.staleOwnershipRecovered === true;
    if (ownershipInspection.marker) {
      const markerBelongsToExisting = localAgentOwnershipMarkerMatchesRecord(
        ownershipInspection.marker,
        existing
      );
      const adoptedAgentIdentityIsClaimed = markerBelongsToExisting
        && existing?.recovered === true
        && ownershipInspection.status === 'unknown';
      if (
        markerBelongsToExisting
        && (ownershipInspection.status === 'live_agent' || adoptedAgentIdentityIsClaimed)
      ) {
        existingProcessIsVerifiedLive = true;
      } else {
        const retryAfterMs = ownershipInspection.status === 'live_agent' ? 3000 : 5000;
        const message = ownershipInspection.status === 'live_agent'
          ? 'A verified local Agent is still starting and waiting for its register/heartbeat handshake.'
          : ownershipInspection.status === 'marker_changed'
            ? 'Local Agent ownership changed while it was being checked. No replacement was started.'
            : 'Local Agent ownership exists, but its process identity could not be verified. No replacement was started.';
        return {
          ok: true,
          hostId: normalizedHostId,
          status: 'ownership_pending',
          ownershipAssessment: ownershipInspection.status,
          retryAfterMs,
          staleOwnershipRecovered,
          message,
          localAgent: null,
        };
      }
    }
    if (existing && staleOwnershipRecovered) {
      existing.lastPid = existing.pid || existing.lastPid || null;
      existing.process = null;
      existing.pid = null;
      existing.status = 'exited';
      existing.updatedAt = nowIso();
      existing.message = 'Recovered stale local Agent ownership; preparing a replacement.';
    }
  }
  if (existing) {
    clearLocalAgentRestartTimer(existing);
  }
  if (existingProcessIsVerifiedLive) {
    if (!restart) {
      return {
        ok: true,
        hostId: normalizedHostId,
        status: 'already_running',
        message: 'Local host-agent is already managed by this relay.',
        localAgent: publicLocalAgentRecord(existing),
      };
    }
    return stopLocalAgent(normalizedHostId, {
      disableAutoRestart: false,
      restartAfterStop: true,
      reason: reason || 'manual restart',
    });
  }

  fs.mkdirSync(LOCAL_AGENT_LOG_ROOT, { recursive: true });
  const safeId = safeLocalAgentId(normalizedHostId);
  const logPath = path.join(LOCAL_AGENT_LOG_ROOT, `${safeId}.out.log`);
  const errorLogPath = path.join(LOCAL_AGENT_LOG_ROOT, `${safeId}.err.log`);
  const relayUrl = getLocalRelayUrl();
  const instanceId = crypto.randomUUID();
  const ownershipToken = crypto.randomBytes(32).toString('hex');
  const ownershipMarkerPath = localAgentOwnershipMarkerPath(normalizedHostId);
  const stdoutFd = fs.openSync(logPath, 'a');
  const stderrFd = fs.openSync(errorLogPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [LOCAL_AGENT_ENTRYPOINT], {
      cwd: process.cwd(),
      stdio: ['ignore', stdoutFd, stderrFd],
      detached: process.platform === 'win32',
      windowsHide: true,
      env: {
        ...process.env,
        RELAY_URL: relayUrl,
        ...(RELAY_AUTH_TOKEN ? { RELAY_AUTH_TOKEN } : {}),
        HOST_ID: normalizedHostId,
        HOST_LABEL: String(label || normalizedHostId).trim() || normalizedHostId,
        CODEX_HOME: process.env.LOCAL_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        AUTO_START_SESSION: process.env.LOCAL_AGENT_AUTO_START_SESSION || process.env.AUTO_START_SESSION || 'false',
        MANAGED_COMMAND: process.env.LOCAL_AGENT_MANAGED_COMMAND || process.env.MANAGED_COMMAND || 'codex-app-server',
        AGENT_SHUTDOWN_GRACE_MS: String(Math.max(
          Number(process.env.AGENT_SHUTDOWN_GRACE_MS || 0) || 0,
          LOCAL_AGENT_SHUTDOWN_GRACE_MS + LOCAL_AGENT_FORCE_EXIT_WAIT_MS
        )),
        RELAY_MANAGED_LOCAL_AGENT: 'true',
        RELAY_MANAGED_AGENT_INSTANCE_ID: instanceId,
        RELAY_MANAGED_AGENT_TOKEN: ownershipToken,
        RELAY_MANAGED_MARKER_PATH: ownershipMarkerPath,
        RELAY_MANAGED_OWNER_PID: String(process.pid),
        RELAY_MANAGED_OWNER_INSTANCE_ID: RELAY_INSTANCE_ID,
      },
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }

  const previousRestartCount = existing?.restartCount || 0;
  const record = {
    hostId: normalizedHostId,
    label: String(label || normalizedHostId).trim() || normalizedHostId,
    status: 'starting',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    process: child,
    pid: child.pid,
    parentPid: process.pid,
    instanceId,
    ownershipToken,
    ownershipMarkerPath,
    relayUrl,
    logPath,
    errorLogPath,
    message: restart ? `local host-agent is restarting${reason ? `: ${reason}` : ''}` : 'local host-agent is starting',
    desiredState: 'running',
    autoRestart: true,
    restartCount: restart ? previousRestartCount + 1 : previousRestartCount,
    lastRestartAt: restart ? nowIso() : existing?.lastRestartAt || null,
    nextRestartAt: null,
    restartReason: restart ? reason || 'manual restart' : existing?.restartReason || null,
    restartTimer: null,
    restartAfterStop: false,
    shutdownTimer: null,
    shutdownPollTimer: null,
    shutdownCommandId: null,
    forceKillPromise: null,
    exitCompletionPromise: null,
    recovered: false,
  };
  child.on('spawn', () => {
    if (record.desiredState === 'stopped') return;
    record.status = 'running';
    record.updatedAt = nowIso();
    record.message = 'local host-agent is running';
  });
  child.on('error', (error) => {
    record.status = 'error';
    record.updatedAt = nowIso();
    record.message = error.message || 'failed to start local host-agent';
    if (record.autoRestart !== false && record.desiredState !== 'stopped') {
      scheduleLocalAgentRestart(normalizedHostId, `process error: ${record.message}`, LOCAL_AGENT_EXIT_RESTART_DELAY_MS);
    }
  });
  child.on('exit', (code, signal) => {
    if (state.localAgents.get(normalizedHostId) !== record) {
      return;
    }
    void completeLocalAgentExit(record, code, signal);
  });
  state.localAgents.set(normalizedHostId, record);
  try {
    const markerWrite = writeLocalAgentOwnershipMarker(record);
    staleOwnershipRecovered = staleOwnershipRecovered
      || markerWrite.staleOwnershipRecovered === true;
  } catch (error) {
    record.status = 'error';
    record.desiredState = 'stopped';
    record.autoRestart = false;
    record.restartAfterStop = false;
    record.message = `failed to persist local agent ownership: ${error.message || error}`;
    record.updatedAt = nowIso();
    record.forceKillPromise = forceKillProcessTree(child.pid).catch((killError) => {
      record.message = `${record.message}; cleanup failed: ${killError.message || killError}`;
      record.updatedAt = nowIso();
      return killError;
    });
    return {
      ok: false,
      hostId: normalizedHostId,
      status: 'ownership_error',
      message: record.message,
      localAgent: publicLocalAgentRecord(record),
    };
  }

  const host = state.hosts.get(normalizedHostId) || {
    hostId: normalizedHostId,
    label: record.label,
    platform: process.platform,
    capabilities: {},
    registeredAt: nowIso(),
    lastSeenAt: null,
  };
  host.label = record.label || host.label;
  host.platform = host.platform || process.platform;
  restoreDismissedHost(normalizedHostId);
  state.hosts.set(normalizedHostId, host);

  return {
    ok: true,
    hostId: normalizedHostId,
    status: 'starting',
    message: `Starting local host-agent for ${normalizedHostId}.`,
    staleOwnershipRecovered,
    localAgent: publicLocalAgentRecord(record),
  };
}

function localAgentWatchdogTick() {
  if (!LOCAL_AGENT_WATCHDOG_ENABLED) {
    return;
  }
  for (const record of state.localAgents.values()) {
    if (!shouldAutoRestartLocalAgent(record) || record.restartTimer) {
      continue;
    }
    const processDead = !localAgentProcessIsAlive(record) || ['exited', 'error', 'stopped'].includes(record.status);
    if (processDead) {
      scheduleLocalAgentRestart(record.hostId, `watchdog saw ${record.status || 'missing process'}`);
      continue;
    }
    const startedAtMs = localAgentTimestampMs(record.startedAt);
    const startedAgeMs = startedAtMs ? Date.now() - startedAtMs : Number.POSITIVE_INFINITY;
    if (startedAgeMs < LOCAL_AGENT_STARTUP_GRACE_MS) {
      continue;
    }
    const host = state.hosts.get(record.hostId);
    const heartbeatAgeMs = hostHeartbeatAgeMs(host);
    if (heartbeatAgeMs > LOCAL_AGENT_OFFLINE_RESTART_MS) {
      scheduleLocalAgentRestart(record.hostId, `heartbeat stale for ${Math.round(heartbeatAgeMs / 1000)}s`);
    }
  }
}

function resolveSessionKey(hostId, sessionId) {
  const key = sessionKey(hostId, sessionId);
  const seen = new Set();
  let current = key;
  while (state.sessionAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = state.sessionAliases.get(current);
  }
  return current || key;
}

function resolveSessionId(hostId, sessionId) {
  const key = resolveSessionKey(hostId, sessionId);
  const prefix = `${hostId}::`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : sessionId;
}

function rememberSessionAlias(hostId, aliasSessionId, canonicalSessionId) {
  const alias = String(aliasSessionId || '').trim();
  const canonical = String(canonicalSessionId || '').trim();
  if (!hostId || !alias || !canonical || alias === canonical) {
    return;
  }
  const aliasKey = sessionKey(hostId, alias);
  const canonicalKey = resolveSessionKey(hostId, canonical);
  if (aliasKey !== canonicalKey) {
    const previousSessionKey = resolveSessionKey(hostId, alias);
    const previousRealtimeKey = resolveCanonicalConversationKey(hostId, alias);
    state.sessionAliases.set(aliasKey, canonicalKey);
    const nextRealtimeKey = resolveCanonicalConversationKey(hostId, canonical);
    for (const previousKey of new Set([previousSessionKey, previousRealtimeKey])) {
      mergeCanonicalRealtimeKeys(previousKey, nextRealtimeKey);
    }
  }
}

function rememberSessionIdentityAliases(hostId, session) {
  if (!session?.sessionId) {
    return;
  }
  rememberSessionAlias(hostId, session.bridgeSessionId, session.sessionId);
  rememberSessionAlias(hostId, session.nativeThreadId, session.sessionId);
}

function sessionIdentity(hostId, input = {}) {
  return {
    hostId,
    conversationKey: input.conversationKey || null,
    sessionId: input.sessionId || input.nativeThreadId || input.bridgeSessionId || null,
    bridgeSessionId: input.bridgeSessionId || null,
    nativeThreadId: input.nativeThreadId || null,
    originSessionId: input.originSessionId || null,
    sourceSessionId: input.sourceSessionId || null,
  };
}

function resolveCanonicalConversationKey(hostId, input = {}) {
  const identity = typeof input === 'string'
    ? sessionIdentity(hostId, { sessionId: input })
    : sessionIdentity(hostId, input);
  const durable = state.sessionRecordStore?.resolveCanonicalKey(identity);
  if (durable) return durable;
  const sessionId = identity.sessionId || identity.nativeThreadId || identity.bridgeSessionId;
  return sessionId ? resolveSessionKey(hostId, sessionId) : '';
}

function canonicalAliasesFor(identity, canonicalKey) {
  const aliases = state.sessionRecordStore?.readAliasesForCanonicalKey(
    canonicalKey || identity
  ) || [];
  return [...new Set(aliases.filter(Boolean))];
}

function mergeCanonicalRealtimeKeys(loserKey, winnerKey) {
  if (!loserKey || !winnerKey || loserKey === winnerKey) return;
  migrateInputRequestScope(loserKey, winnerKey);
  state.activitySnapshots.mergeCanonicalKey(
    state.sessionEventStream.epoch,
    loserKey,
    winnerKey,
    { includeSnapshot: false }
  );
  state.sessionEventStream.mergeCanonicalKey(loserKey, winnerKey);
}

function compactAssistantProjection(projection) {
  if (!projection) return null;
  return {
    canonicalConversationKey: projection.canonicalConversationKey,
    latestAssistantSeq: Number(projection.latestAssistantSeq || 0),
    latestAssistantId: projection.latestAssistantId || null,
    latestAssistantAt: projection.latestAssistantAt || null,
    projectionRevision: Number(projection.projectionRevision || 0),
    cursorUnknown: projection.cursorUnknown === true,
    aliases: Array.isArray(projection.aliases) ? projection.aliases : [],
  };
}

function assistantProjectionForIdentity(hostId, input = {}, options = {}) {
  const identity = sessionIdentity(hostId, input);
  const canonicalKey = resolveCanonicalConversationKey(hostId, identity);
  if (!canonicalKey) return null;
  const record = state.sessionRecordStore?.readRecord(identity) || {
    hostId,
    conversationKey: canonicalKey.slice(`${hostId}::`.length),
    notification: emptyNotificationState(nowIso()),
  };
  return projectAssistantState(record, {
    canonicalKey,
    aliases: canonicalAliasesFor(identity, canonicalKey),
    afterSeq: options.afterSeq,
    limit: options.limit,
  });
}

function sessionWithAssistantProjection(session) {
  if (!session || typeof session !== 'object') return session;
  const projection = assistantProjectionForIdentity(session.hostId, session, {
    afterSeq: Number.MAX_SAFE_INTEGER,
    limit: 1,
  });
  return {
    ...session,
    assistantProjection: compactAssistantProjection(projection),
  };
}

function ensureCursorNotificationState(record, baselineAt) {
  const empty = emptyNotificationState(baselineAt);
  const existing = record.notification && typeof record.notification === 'object'
    ? record.notification
    : {};
  record.notification = {
    ...empty,
    ...existing,
    ledger: existing.ledger && typeof existing.ledger === 'object'
      ? existing.ledger
      : {},
    sequenceAliases: existing.sequenceAliases && typeof existing.sequenceAliases === 'object'
      ? existing.sequenceAliases
      : {},
    cursorSources: existing.cursorSources && typeof existing.cursorSources === 'object'
      ? existing.cursorSources
      : {},
  };
  return record.notification;
}

function applyAssistantCursorState(tx, canonicalKey, record, cursor, baselineAt) {
  if (!cursor || typeof cursor !== 'object') return false;
  const notification = ensureCursorNotificationState(record, baselineAt);
  const fileIdentity = String(cursor.fileIdentity || '').trim();
  const projectionRevision = Number(cursor.projectionRevision);
  const validRevision = Number.isSafeInteger(projectionRevision) && projectionRevision >= 0;
  let changed = false;

  if (!fileIdentity || !validRevision) {
    if (cursor.cursorUnknown === true && notification.cursorUnknown !== true) {
      notification.cursorUnknown = true;
      notification.unscopedCursorUnknown = true;
      changed = true;
    }
  } else {
    const current = notification.cursorSources[fileIdentity] || null;
    const currentRevision = Number(current?.projectionRevision);
    const stale = Number.isSafeInteger(currentRevision) && projectionRevision < currentRevision;
    if (!stale) {
      const incomingUnknown = cursor.cursorUnknown === true;
      const sameRevisionCompleteWins = current
        && currentRevision === projectionRevision
        && current.cursorUnknown === false
        && incomingUnknown;
      if (!sameRevisionCompleteWins) {
        const next = {
          projectionRevision,
          cursorUnknown: incomingUnknown,
          cursorOffset: Number.isSafeInteger(Number(cursor.cursorOffset))
            ? Number(cursor.cursorOffset)
            : null,
          updatedAt: nowIso(),
        };
        if (
          !current
          || current.projectionRevision !== next.projectionRevision
          || current.cursorUnknown !== next.cursorUnknown
        ) {
          notification.cursorSources[fileIdentity] = next;
          changed = true;
        }
      }
    }
    const cursorUnknown = notification.unscopedCursorUnknown === true
      || Object.values(notification.cursorSources).some((source) => source?.cursorUnknown === true);
    if (notification.cursorUnknown !== cursorUnknown) {
      notification.cursorUnknown = cursorUnknown;
      changed = true;
    }
  }

  if (changed) {
    notification.projectionRevision = Number(notification.projectionRevision || 0) + 1;
    tx.markDirty(canonicalKey);
  }
  return changed;
}

function assistantCursorNeedsMutation(record, cursor) {
  if (!cursor || typeof cursor !== 'object') return false;
  const notification = record?.notification || {};
  const fileIdentity = String(cursor.fileIdentity || '').trim();
  const projectionRevision = Number(cursor.projectionRevision);
  const validRevision = Number.isSafeInteger(projectionRevision) && projectionRevision >= 0;
  if (!fileIdentity || !validRevision) {
    return cursor.cursorUnknown === true && notification.cursorUnknown !== true;
  }
  const current = notification.cursorSources?.[fileIdentity] || null;
  if (!current) return true;
  const currentRevision = Number(current.projectionRevision);
  if (projectionRevision < currentRevision) return false;
  if (
    projectionRevision === currentRevision
    && current.cursorUnknown === false
    && cursor.cursorUnknown === true
  ) {
    return false;
  }
  return projectionRevision !== currentRevision
    || current.cursorUnknown !== (cursor.cursorUnknown === true);
}

async function assignAssistantObservations(hostId, input = {}, observations = [], cursor = null) {
  if (!state.sessionRecordStore) {
    throw new Error('Session record store is unavailable');
  }
  const identity = sessionIdentity(hostId, input);
  if (!identity.sessionId && !identity.nativeThreadId && !identity.bridgeSessionId) {
    throw new TypeError('Assistant observation requires a Session identity');
  }
  const values = (Array.isArray(observations) ? observations : [observations])
    .filter((observation) => observation && typeof observation === 'object');
  const currentRecord = state.sessionRecordStore.readRecord(identity);
  const cursorNeedsMutation = assistantCursorNeedsMutation(currentRecord, cursor);
  if (!values.length && !cursor) {
    return {
      canonicalKey: resolveCanonicalConversationKey(hostId, identity),
      entries: [],
      projection: assistantProjectionForIdentity(hostId, identity),
      changed: false,
    };
  }
  if (!values.length && !cursorNeedsMutation) {
    return {
      canonicalKey: resolveCanonicalConversationKey(hostId, identity),
      entries: [],
      projection: assistantProjectionForIdentity(hostId, identity),
      changed: false,
    };
  }

  const committed = await state.sessionRecordStore.transact(
    'assistant.observations.ingested',
    (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(identity);
      let record = tx.getRecord(canonicalKey);
      const baselineAt = record?.notification?.migrationBaselineAt
        || record?.updatedAt
        || values[0]?.firstObservedAt
        || nowIso();
      const entries = [];
      for (const observation of values) {
        const result = ingestAssistantObservation(tx, {
          canonicalKey,
          lineageKey: `${hostId}::${input.sessionId || input.nativeThreadId || input.bridgeSessionId}`,
          observation,
          baselineAt,
        });
        record = tx.getRecord(canonicalKey);
        entries.push({
          assistantMessageId: result.entry.assistantMessageId,
          assistantSeq: result.entry.assistantSeq,
          assistantAt: result.entry.assistantAt || null,
          notifiable: result.entry.notifiable === true,
          created: result.created === true,
          updated: result.updated === true,
        });
      }
      record ||= tx.ensureRecord(canonicalKey, {
        hostId,
        conversationKey: input.conversationKey || input.sessionId,
        updatedAt: baselineAt,
      });
      const cursorChanged = applyAssistantCursorState(
        tx,
        canonicalKey,
        record,
        cursor,
        baselineAt
      );
      return {
        canonicalKey,
        entries,
        changed: cursorChanged || entries.some((entry) => entry.created || entry.updated),
      };
    }
  );
  return {
    ...committed,
    projection: assistantProjectionForIdentity(hostId, identity),
  };
}

function sessionOwnershipIdentityValues(session = {}) {
  return [
    session.sessionId,
    session.bridgeSessionId,
    session.nativeThreadId,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function findManagedLiveSessionByIdentities(hostId, identities = []) {
  const candidates = new Set(
    identities
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  if (!hostId || !candidates.size) {
    return null;
  }
  for (const session of state.sessions.values()) {
    if (session.hostId !== hostId || session.source !== 'managed' || !session.live) {
      continue;
    }
    const values = sessionOwnershipIdentityValues(session);
    if (values.some((value) => candidates.has(value))) {
      return session;
    }
  }
  return null;
}

function getSession(hostId, sessionId) {
  return state.sessions.get(resolveSessionKey(hostId, sessionId)) || null;
}

function walkLocalFiles(rootDir, visit) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkLocalFiles(filePath, visit);
    } else if (entry.isFile()) {
      visit(filePath);
    }
  }
}

function resolveSessionRolloutPath(session) {
  if (!session) {
    return null;
  }
  const existing = String(session.rolloutPath || '').trim();
  if (existing && fs.existsSync(existing)) {
    return existing;
  }

  const candidates = [];
  if (session.nativeThreadId) {
    candidates.push(String(session.nativeThreadId));
  }
  if (session.sessionId) {
    candidates.push(String(session.sessionId));
  }

  const codexHomes = [
    session.runtime?.codexHome,
    session.codexHome,
    process.env.LOCAL_CODEX_HOME,
    process.env.CODEX_HOME,
    path.join(os.homedir(), '.codex'),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const seen = new Set();
  let found = null;

  for (const codexHome of codexHomes) {
    const sessionsRoot = path.join(codexHome, 'sessions');
    walkLocalFiles(sessionsRoot, (filePath) => {
      if (found || !filePath.endsWith('.jsonl') || seen.has(filePath)) {
        return;
      }
      seen.add(filePath);
      const base = path.basename(filePath);
      if (candidates.some((candidate) => candidate && base.includes(candidate))) {
        found = filePath;
      }
    });
    if (found) {
      break;
    }
  }

  return found;
}

function loadSessionDiagnosticsFromRollout(session, options = {}) {
  const rolloutPath = resolveSessionRolloutPath(session);
  if (!rolloutPath) {
    return [];
  }

  const limit = options.full
    ? Infinity
    : (Object.prototype.hasOwnProperty.call(options, 'limit') ? Number(options.limit) : SESSION_DIAGNOSTIC_ENTRY_LIMIT);
  try {
    const diagnostics = extractSessionDiagnostics(rolloutPath, options.full
      ? { maxRows: Infinity }
      : { tailRows: Math.max(1, Number(limit) || SESSION_DETAIL_DIAGNOSTIC_LIMIT), maxEntries: limit });
    return compactSessionDiagnostics(diagnostics, { limit });
  } catch (_) {
    return [];
  }
}

function compactSessionDiagnostics(entries, options = {}) {
  const limit = Object.prototype.hasOwnProperty.call(options, 'limit')
    ? Number(options.limit)
    : SESSION_DIAGNOSTIC_ENTRY_LIMIT;
  const normalized = [];
  const seen = new Set();
  const sorted = (Array.isArray(entries) ? entries : [])
    .filter(Boolean)
    .sort((a, b) => compareTranscriptEntries(a, b));

  for (const entry of sorted) {
    if (!entry || !entry.message) {
      continue;
    }
    const message = canonicalTranscriptText(entry.message);
    const key = `${entry.timestamp || ''}|${entry.kind || ''}|${entry.method || ''}|${message}|${diagnosticIdentitySignature(entry)}`;
    if (seen.has(key)) {
      continue;
    }

    const previous = normalized[normalized.length - 1];
    const previousTime = Date.parse(previous?.timestamp || '');
    const entryTime = Date.parse(entry.timestamp || '');
    const near = Number.isFinite(previousTime) && Number.isFinite(entryTime) && Math.abs(entryTime - previousTime) <= 2000;
    if (
      previous
      && near
      && String(previous.kind || '') === String(entry.kind || '')
      && String(previous.method || '') === String(entry.method || '')
      && diagnosticIdentitySignature(previous) === diagnosticIdentitySignature(entry)
      && canonicalTranscriptText(previous.message) === message
    ) {
      continue;
    }

    seen.add(key);
    normalized.push(entry);
  }
  return Number.isFinite(limit) && limit > 0 ? normalized.slice(-limit) : normalized;
}

const sessionDiagnosticKeyIndexes = new WeakMap();

function diagnosticIdentitySignature(entry) {
  return [
    entry?.runId || entry?.data?.runId || '',
    entry?.turnId || entry?.data?.turnId || '',
    entry?.itemId || entry?.data?.itemId || entry?.data?.item_id || '',
    entry?.callId || entry?.data?.callId || entry?.data?.call_id || '',
    entry?.requestId || entry?.data?.requestId || entry?.data?.request_id || '',
  ].join('|');
}

function sessionDiagnosticCompactionKey(entry) {
  return `${entry?.timestamp || ''}|${entry?.kind || ''}|${entry?.method || ''}|${canonicalTranscriptText(entry?.message || '')}|${diagnosticIdentitySignature(entry)}`;
}

function getSessionDiagnosticKeyIndex(entries) {
  let index = sessionDiagnosticKeyIndexes.get(entries);
  if (!index) {
    index = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const key = sessionDiagnosticCompactionKey(entry);
      index.set(key, (index.get(key) || 0) + 1);
    }
    sessionDiagnosticKeyIndexes.set(entries, index);
  }
  return index;
}

function diagnosticsAreNearDuplicates(previous, entry) {
  if (!previous || !entry) {
    return false;
  }
  const previousTime = Date.parse(previous.timestamp || '');
  const entryTime = Date.parse(entry.timestamp || '');
  return Number.isFinite(previousTime)
    && Number.isFinite(entryTime)
    && Math.abs(entryTime - previousTime) <= 2000
    && String(previous.kind || '') === String(entry.kind || '')
    && String(previous.method || '') === String(entry.method || '')
    && diagnosticIdentitySignature(previous) === diagnosticIdentitySignature(entry)
    && canonicalTranscriptText(previous.message) === canonicalTranscriptText(entry.message);
}

function appendCompactedSessionDiagnostic(entries, entry, limit = SESSION_DIAGNOSTIC_ENTRY_LIMIT) {
  const existing = Array.isArray(entries) ? entries : [];
  if (!entry || !canonicalTranscriptText(entry.message || '')) {
    return existing;
  }
  const previous = existing[existing.length - 1] || null;
  const previousTime = Date.parse(previous?.timestamp || '');
  const entryTime = Date.parse(entry?.timestamp || '');
  const canAppendInOrder = !previous
    || (Number.isFinite(previousTime) && Number.isFinite(entryTime) && entryTime >= previousTime);

  if (!canAppendInOrder) {
    return compactSessionDiagnostics(mergeByFingerprint(
      [...existing, entry],
      diagnosticFingerprint,
      limit
    ), { limit });
  }

  const index = getSessionDiagnosticKeyIndex(existing);
  const key = sessionDiagnosticCompactionKey(entry);
  if (index.has(key) || diagnosticsAreNearDuplicates(previous, entry)) {
    return existing;
  }

  existing.push(entry);
  index.set(key, (index.get(key) || 0) + 1);
  if (Number.isFinite(limit) && limit > 0 && existing.length > limit) {
    const removed = existing.splice(0, existing.length - limit);
    for (const item of removed) {
      const removedKey = sessionDiagnosticCompactionKey(item);
      const remaining = (index.get(removedKey) || 0) - 1;
      if (remaining > 0) {
        index.set(removedKey, remaining);
      } else {
        index.delete(removedKey);
      }
    }
  }
  return existing;
}

function loadSessionTranscriptFromRollout(session) {
  const rolloutPath = resolveSessionRolloutPath(session);
  if (!rolloutPath) {
    return [];
  }

  try {
    return extractSessionTranscript(rolloutPath, { maxChars: Infinity });
  } catch (_) {
    return [];
  }
}

function mergeExportTranscriptFiles(previousFiles, nextFiles) {
  const merged = [];
  const seen = new Set();
  for (const file of [...(Array.isArray(previousFiles) ? previousFiles : []), ...(Array.isArray(nextFiles) ? nextFiles : [])]) {
    const key = [
      file?.fileId || '',
      file?.path || file?.remotePath || '',
      file?.name || '',
      file?.mime || '',
    ].join('\u0000');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(file);
  }
  return merged;
}

function mergeExportTranscriptEntries(entries) {
  const merged = [];
  for (const entry of sortTranscriptEntries(
    (Array.isArray(entries) ? entries : [])
      .map(normalizeStoredTranscriptEntry)
      .filter(Boolean)
  )) {
    const previous = merged[merged.length - 1];
    if (previous && previous.speaker === entry.speaker) {
      const previousText = canonicalTranscriptText(previous.text);
      const entryText = canonicalTranscriptText(entry.text);
      const previousTime = Date.parse(previous.timestamp || '');
      const entryTime = Date.parse(entry.timestamp || '');
      const near = Number.isFinite(previousTime) && Number.isFinite(entryTime) && Math.abs(entryTime - previousTime) <= 30000;
      if (
        near
        && previousText
        && entryText
        && (
          previousText === entryText
          || previousText.includes(entryText)
          || entryText.includes(previousText)
        )
      ) {
        if (entryText.length > previousText.length) {
          previous.text = entry.text;
        }
        previous.files = mergeExportTranscriptFiles(previous.files, entry.files);
        if (!previous.stream && entry.stream) {
          previous.stream = entry.stream;
        }
        continue;
      }
    }
    merged.push({
      ...entry,
      files: mergeExportTranscriptFiles([], entry.files),
    });
  }
  return compactTranscriptEntries(merged);
}

function getSessionDetail(hostId, sessionId, options = {}) {
  let session = getSession(hostId, sessionId);
  if (!session) {
    return null;
  }

  const effectiveSessionId = session.sessionId || resolveSessionId(hostId, sessionId) || sessionId;
  const key = resolveSessionKey(hostId, effectiveSessionId);
  const storedTranscript = state.sessionLogs.get(key) || session.transcriptPreview || [];
  const rolloutTranscript = options.fullTranscript ? loadSessionTranscriptFromRollout(session) : [];
  const transcript = options.fullTranscript
    ? mergeExportTranscriptEntries([...storedTranscript, ...rolloutTranscript])
    : compactTranscriptEntries(mergeByFingerprint(
      (Array.isArray(storedTranscript) ? storedTranscript : [])
        .map(normalizeStoredTranscriptEntry)
        .filter(Boolean),
      transcriptFingerprint,
      SESSION_LOG_ENTRY_LIMIT
    )).slice(-SESSION_LOG_ENTRY_LIMIT);
  if (!options.fullTranscript && state.sessionLogs.has(key) && transcript.length !== storedTranscript.length) {
    state.sessionLogs.set(key, transcript);
    scheduleSessionLogsSave();
  }
  session = refreshSessionMessageSummaries(hostId, effectiveSessionId, transcript) || session;
  session = maybeInferAndPersistSessionTitle(hostId, effectiveSessionId, transcript) || session;
  const alerts = state.sessionAlerts.get(key) || [];
  const runtime = state.sessionRuntime.get(key) || null;
  const persistedDiagnostics = options.skipDiagnostics ? [] : (state.sessionDiagnostics.get(key) || []);
  const diagnosticLimit = options.fullDiagnostics ? Infinity : SESSION_DETAIL_DIAGNOSTIC_LIMIT;
  const loadRolloutDiagnostics = !(session.live && session.source === 'managed');
  const diagnostics = options.skipDiagnostics
    ? []
    : compactSessionDiagnostics([
      ...(loadRolloutDiagnostics
        ? loadSessionDiagnosticsFromRollout(session, { full: options.fullDiagnostics, limit: diagnosticLimit })
        : []),
      ...persistedDiagnostics,
    ], { limit: diagnosticLimit });
  if (!options.skipDiagnostics && diagnostics.length) {
    state.sessionDiagnostics.set(key, diagnostics);
    if (JSON.stringify(persistedDiagnostics) !== JSON.stringify(diagnostics)) {
      scheduleSessionDiagnosticsSave();
    }
  }
  const requests = state.sessionRequests.get(key) || [];
  pruneReceivedFiles();
  const receivedFileSessionIds = new Set([
    sessionId,
    effectiveSessionId,
    session.bridgeSessionId,
    session.nativeThreadId,
    session.originSessionId,
    session.sourceSessionId,
    session.conversationKey,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  const receivedFiles = Array.from(state.receivedFiles.values())
    .filter((file) => file.hostId === hostId && receivedFileSessionIds.has(String(file.sessionId || '')))
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .map((file) => ({
      fileId: file.fileId,
      hostId: file.hostId,
      sessionId: file.sessionId,
      remotePath: file.remotePath,
      name: file.name,
      mime: file.mime,
      size: file.size,
      receivedAt: file.receivedAt,
      lastAccessedAt: file.lastAccessedAt,
      expiresAt: file.expiresAt,
      url: `/api/received-files/${encodeURIComponent(file.fileId)}`,
    }));
  return {
    session: sessionWithAssistantProjection(session),
    transcript,
    alerts,
    runtime,
    diagnostics,
    requests,
    receivedFiles,
  };
}

function hasUsableLocalSessionTranscriptDetail(detail) {
  const transcript = Array.isArray(detail?.transcript) ? detail.transcript : [];
  return transcript.some((entry) => (
    entry
    && ['user', 'agent', 'assistant'].includes(String(entry.speaker || '').toLowerCase())
    && (entry.text || (Array.isArray(entry.files) && entry.files.length))
  ));
}

function shouldRequestRemoteSessionDetail(host, detail, options = {}) {
  if (options.skipRemoteDetail) {
    return false;
  }
  if (!host || !hostOnline(host) || !host.capabilities?.sessionDetail) {
    return false;
  }
  const session = detail?.session || {};
  if (
    !options.fullTranscript
    && !options.fullDiagnostics
    && !options.forceRemoteDetail
    && hasUsableLocalSessionTranscriptDetail(detail)
  ) {
    return false;
  }
  if (options.forceRemoteDetail || options.fullTranscript || options.fullDiagnostics) {
    return true;
  }
  if (!session.live || session.source !== 'managed') {
    return true;
  }
  return !(Array.isArray(detail.diagnostics) && detail.diagnostics.length);
}

async function requestRemoteSessionDetail(hostId, session, options = {}) {
  const requestId = makeId();
  enqueueCommand(hostId, {
    type: 'session.detail',
    requestId,
    sessionId: session.sessionId,
    bridgeSessionId: session.bridgeSessionId || null,
    nativeThreadId: session.nativeThreadId || null,
    originSessionId: session.originSessionId || null,
    sourceSessionId: session.sourceSessionId || null,
    conversationKey: session.conversationKey || null,
    codexHome: session.runtime?.codexHome || session.codexHome || null,
    fullTranscript: Boolean(options.fullTranscript),
    fullDiagnostics: Boolean(options.fullDiagnostics),
  });
  return awaitSessionDetailRequest(requestId, (options.fullTranscript || options.fullDiagnostics) ? 90000 : 45000);
}

function mergeRemoteSessionDetail(hostId, sessionId, detail, remoteDetail, options = {}) {
  if (!remoteDetail || typeof remoteDetail !== 'object') {
    return detail;
  }

  const remoteSession = remoteDetail.session || {};
  const effectiveSessionId = detail.session?.sessionId || remoteSession.sessionId || resolveSessionId(hostId, sessionId) || sessionId;
  rememberSessionAlias(hostId, sessionId, effectiveSessionId);
  rememberSessionAlias(hostId, remoteSession.sessionId, effectiveSessionId);
  rememberSessionAlias(hostId, remoteSession.nativeThreadId, effectiveSessionId);
  if (remoteSession && typeof remoteSession === 'object') {
    upsertSession(hostId, {
      sessionId: effectiveSessionId,
      title: remoteSession.title || detail.session?.title || effectiveSessionId,
      cwd: remoteSession.cwd || detail.session?.cwd || null,
      source: detail.session?.source || remoteSession.source || 'imported',
      state: detail.session?.state || (detail.session?.live ? 'running' : 'imported'),
      live: Boolean(detail.session?.live),
      createdAt: detail.session?.createdAt || remoteSession.createdAt || null,
      lastUpdatedAt: remoteSession.updatedAt || detail.session?.lastUpdatedAt || nowIso(),
      messageCount: Math.max(Number(detail.session?.messageCount || 0), Number(remoteSession.messageCount || 0)),
      latestUserMessage: remoteSession.latestUserMessage || detail.session?.latestUserMessage || null,
      latestAgentMessage: remoteSession.latestAgentMessage || detail.session?.latestAgentMessage || null,
      originSessionId: detail.session?.originSessionId || remoteSession.originSessionId || null,
      sourceSessionId: detail.session?.sourceSessionId || remoteSession.sourceSessionId || null,
      conversationKey: detail.session?.conversationKey || remoteSession.conversationKey || effectiveSessionId,
      bridgeSessionId: detail.session?.bridgeSessionId || remoteSession.bridgeSessionId || null,
      nativeThreadId: detail.session?.nativeThreadId || remoteSession.nativeThreadId || remoteSession.sessionId || effectiveSessionId,
      runtime: detail.session?.runtime || null,
    });
  }

  const remoteTranscript = (Array.isArray(remoteDetail.transcript) ? remoteDetail.transcript : [])
    .map(normalizeStoredTranscriptEntry)
    .filter(Boolean);
  const acceptRemoteRolloutDiagnostics = !(
    detail.session?.live === true
    && detail.session?.source === 'managed'
  );
  const remoteDiagnostics = acceptRemoteRolloutDiagnostics
    ? (Array.isArray(remoteDetail.diagnostics) ? remoteDetail.diagnostics : [])
      .map(normalizeStoredSessionDiagnostic)
      .filter(Boolean)
    : [];

  if (remoteTranscript.length) {
    setSessionLog(hostId, effectiveSessionId, remoteTranscript, { merge: true });
  }
  if (remoteDiagnostics.length) {
    setSessionDiagnostics(hostId, effectiveSessionId, remoteDiagnostics, { merge: true });
  }

  const transcript = options.fullTranscript
    ? mergeExportTranscriptEntries([...(detail.transcript || []), ...remoteTranscript])
    : compactTranscriptEntries(mergeByFingerprint(
      [...(detail.transcript || []), ...remoteTranscript],
      transcriptFingerprint,
      SESSION_LOG_ENTRY_LIMIT
    )).slice(-SESSION_LOG_ENTRY_LIMIT);
  const diagnosticLimit = options.fullDiagnostics ? Infinity : SESSION_DETAIL_DIAGNOSTIC_LIMIT;
  const diagnostics = compactSessionDiagnostics(
    [...(detail.diagnostics || []), ...remoteDiagnostics],
    { limit: diagnosticLimit }
  );

  return {
    ...detail,
    session: sessionWithAssistantProjection(
      getSession(hostId, effectiveSessionId) || detail.session
    ),
    transcript,
    diagnostics,
    remoteDetail: {
      loaded: Boolean(remoteTranscript.length || remoteDiagnostics.length),
      fullTranscript: Boolean(remoteDetail.fullTranscript),
      fullDiagnostics: Boolean(remoteDetail.fullDiagnostics),
      transcriptCount: remoteTranscript.length,
      diagnosticCount: remoteDiagnostics.length,
    },
  };
}

function refreshSessionDetailControlProjection(hostId, sessionId, detail) {
  const effectiveSessionId = detail?.session?.sessionId || resolveSessionId(hostId, sessionId) || sessionId;
  const current = getSessionDetail(hostId, effectiveSessionId, {
    skipDiagnostics: true,
    skipRemoteDetail: true,
  });
  if (!current) return detail;
  return {
    ...detail,
    session: current.session,
    alerts: current.alerts,
    runtime: current.runtime,
    requests: current.requests,
    receivedFiles: current.receivedFiles,
  };
}

async function getSessionDetailHydrated(hostId, sessionId, options = {}) {
  let detail = getSessionDetail(hostId, sessionId, options);
  if (!detail) {
    return null;
  }

  const host = state.hosts.get(hostId);
  if (!shouldRequestRemoteSessionDetail(host, detail, options)) {
    return detail;
  }

  try {
    const remoteDetail = await requestRemoteSessionDetail(hostId, detail.session, options);
    detail = mergeRemoteSessionDetail(hostId, detail.session?.sessionId || sessionId, detail, remoteDetail, options);
  } catch (error) {
    detail = {
      ...detail,
      remoteDetail: {
        loaded: false,
        error: error.message || 'failed to load remote session history',
      },
    };
  }

  return refreshSessionDetailControlProjection(hostId, sessionId, detail);
}

function exportTimestamp(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString();
}

function exportLineValue(value, fallback = '') {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return text || fallback;
}

function sessionExportBaseName(session) {
  const cwdLeaf = String(session?.cwd || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || 'session';
  const title = exportLineValue(cwdLeaf, 'session');
  const safeTitle = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'session';
  const sessionId = String(session?.sessionId || '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 36);
  return sessionId ? `${safeTitle}-${sessionId}` : safeTitle;
}

function sessionExportTitle(session) {
  const cwd = exportLineValue(session?.cwd || '(unknown path)', '(unknown path)');
  const sessionId = exportLineValue(session?.sessionId || 'unknown-session', 'unknown-session');
  return `${cwd} | ${sessionId}`;
}

function formatExportEntry(entry) {
  const speaker = exportLineValue(entry?.speaker || 'message', 'message');
  const timestamp = exportTimestamp(entry?.timestamp);
  const heading = timestamp ? `### ${speaker} | ${timestamp}` : `### ${speaker}`;
  const text = String(entry?.text || '').trim() || '(empty)';
  const files = Array.isArray(entry?.files) ? entry.files : [];
  const lines = [heading, '', text];
  if (files.length > 0) {
    lines.push('', 'Files:');
    for (const file of files) {
      const name = exportLineValue(file?.name || file?.path || 'file', 'file');
      const remotePath = exportLineValue(file?.path || file?.remotePath || '');
      const size = Number(file?.size || 0) || 0;
      lines.push(`- ${name}${remotePath && remotePath !== name ? ` (${remotePath})` : ''}${size ? `, ${size} bytes` : ''}`);
    }
  }
  return lines.join('\n');
}

function collectTranscriptFiles(transcript) {
  const files = [];
  const seen = new Set();
  for (const entry of Array.isArray(transcript) ? transcript : []) {
    for (const file of Array.isArray(entry?.files) ? entry.files : []) {
      const key = [
        file.fileId || '',
        file.path || file.remotePath || '',
        file.name || '',
        file.mime || '',
      ].join('\u0000');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      files.push({
        ...file,
        speaker: entry.speaker || '',
        timestamp: entry.timestamp || '',
      });
    }
  }
  return files;
}

function formatExportFileLine(file, options = {}) {
  const name = exportLineValue(file?.name || file?.path || file?.remotePath || 'file', 'file');
  const remotePath = exportLineValue(file?.path || file?.remotePath || '');
  const mime = exportLineValue(file?.mime || file?.type || '');
  const size = Number(file?.size || 0) || 0;
  const url = exportLineValue(file?.url || '');
  const pieces = [name];
  if (remotePath && remotePath !== name) {
    pieces.push(`path: ${remotePath}`);
  }
  if (mime) {
    pieces.push(`mime: ${mime}`);
  }
  if (size) {
    pieces.push(`size: ${size} bytes`);
  }
  if (options.includeTimestamp && file?.timestamp) {
    pieces.push(`message: ${exportTimestamp(file.timestamp) || file.timestamp}`);
  }
  if (url) {
    pieces.push(`url: ${url}`);
  }
  return `- ${pieces.join(' | ')}`;
}

function parseExportBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'include'].includes(text)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'omit'].includes(text)) {
    return false;
  }
  return fallback;
}

function exportFileExtension(value) {
  const text = String(value || '').trim().toLowerCase();
  const leaf = text.split(/[\\/]/).filter(Boolean).pop() || '';
  const index = leaf.lastIndexOf('.');
  if (index === -1) {
    return 'no-ext';
  }
  return leaf.slice(index + 1).replace(/^\.+/, '') || 'no-ext';
}

function normalizeExportExtension(value) {
  return String(value || '').trim().toLowerCase().replace(/^\.+/, '') || 'no-ext';
}

function exportFileIdentity(file) {
  return String(file?.fileId || file?.path || file?.remotePath || file?.name || '').trim();
}

function exportFileIdentityValues(file) {
  const values = [
    file?.fileId,
    file?.path,
    file?.remotePath,
    file?.name,
  ];
  for (const value of [file?.path, file?.remotePath]) {
    const leaf = path.basename(String(value || ''));
    if (leaf) {
      values.push(leaf);
    }
  }
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function exportFileIdentityMatches(file, identities = new Set()) {
  return exportFileIdentityValues(file).some((identity) => identities.has(identity));
}

function exportFileIsImage(file) {
  const mime = String(file?.mime || file?.type || '').toLowerCase();
  const ext = exportFileExtension(file?.name || file?.path || file?.remotePath || '');
  return Boolean(file?.isImage) || mime.startsWith('image/') || ['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(ext);
}

function parseExportList(value) {
  return new Set(String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean));
}

function parseExportExtensionList(value) {
  return new Set(Array.from(parseExportList(value), (item) => normalizeExportExtension(item)));
}

function parseExportDate(value, mode = 'start') {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T${mode === 'end' ? '23:59:59.999' : '00:00:00.000'}`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeExportDay(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? '' : text;
  }
  return exportDayKey(text);
}

function addExportDateRange(days, startValue, endValue) {
  const start = normalizeExportDay(startValue);
  const end = normalizeExportDay(endValue || startValue);
  if (!start || !end) {
    return;
  }
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return;
  }
  const minTime = Math.min(startDate.getTime(), endDate.getTime());
  const maxTime = Math.max(startDate.getTime(), endDate.getTime());
  const cursor = new Date(minTime);
  let guard = 0;
  while (cursor.getTime() <= maxTime && guard < 3660) {
    days.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
}

function parseExportDateSelection(value) {
  const days = new Set();
  const items = value instanceof Set || Array.isArray(value)
    ? Array.from(value)
    : String(value || '').split(/[,;\n]+/);
  for (const item of items) {
    const text = String(item || '').trim();
    if (!text) {
      continue;
    }
    const range = text.split('..').map((part) => part.trim()).filter(Boolean);
    addExportDateRange(days, range[0], range[1] || range[0]);
  }
  return days;
}

function normalizeSessionExportOptions(options = {}) {
  const fromDate = parseExportDate(options.fromDate || options.startDate || '', 'start');
  const toDate = parseExportDate(options.toDate || options.endDate || '', 'end');
  const startIndex = Math.max(1, Number(options.startIndex || 1) || 1);
  const endIndex = Math.max(startIndex, Number(options.endIndex || 0) || Number.MAX_SAFE_INTEGER);
  const extensions = options.extensions instanceof Set
    ? new Set(Array.from(options.extensions, (item) => normalizeExportExtension(item)))
    : parseExportExtensionList(options.extensions);
  const fileIds = options.fileIds instanceof Set ? options.fileIds : parseExportList(options.fileIds);
  const selectedDates = parseExportDateSelection(options.selectedDates || options.dates || '');
  return {
    includeThinking: Boolean(options.includeThinking),
    includeImages: options.includeImages !== false,
    includeFiles: options.includeFiles !== false,
    includeAllFiles: options.includeAllFiles !== false,
    filterExtensions: Boolean(options.filterExtensions),
    fromDate,
    toDate,
    startIndex,
    endIndex,
    extensions,
    fileIds,
    selectedDates,
  };
}

function exportFileAllowed(file, exportOptions) {
  const isImage = exportFileIsImage(file);
  if (!exportOptions.includeImages && isImage) {
    return false;
  }
  if (!exportOptions.includeFiles && !isImage) {
    return false;
  }
  const extension = exportFileExtension(file?.name || file?.path || file?.remotePath || '');
  if (exportOptions.filterExtensions && !exportOptions.extensions.has(extension)) {
    return false;
  }
  if (!exportOptions.includeAllFiles) {
    return exportFileIdentityMatches(file, exportOptions.fileIds);
  }
  return true;
}

function filterSessionDetailForExport(detail, exportOptions) {
  const transcript = filterTranscriptForExport(detail.transcript, exportOptions);
  const receivedFiles = (Array.isArray(detail.receivedFiles) ? detail.receivedFiles : [])
    .filter((file) => exportFileAllowed(file, exportOptions));
  return {
    ...detail,
    transcript,
    receivedFiles,
  };
}

function exportDayKey(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString().slice(0, 10);
}

function exportEarliestTimestamp(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function exportLatestTimestamp(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function buildSessionExportSummary(detail) {
  const session = detail?.session || {};
  const transcript = (Array.isArray(detail?.transcript) ? detail.transcript : [])
    .filter((entry) => entry && ['user', 'agent', 'assistant', 'system'].includes(entry.speaker || ''));
  const dayStats = new Map();
  let firstMessageAt = null;
  let lastMessageAt = null;

  for (const entry of transcript) {
    const day = exportDayKey(entry.timestamp);
    if (!day) {
      continue;
    }
    const stats = dayStats.get(day) || {
      date: day,
      messageCount: 0,
      userCount: 0,
      agentCount: 0,
      firstTimestamp: entry.timestamp,
      lastTimestamp: entry.timestamp,
    };
    stats.messageCount += 1;
    if (entry.speaker === 'user') {
      stats.userCount += 1;
    }
    if (entry.speaker === 'agent' || entry.speaker === 'assistant') {
      stats.agentCount += 1;
    }
    stats.firstTimestamp = exportEarliestTimestamp(stats.firstTimestamp, entry.timestamp);
    stats.lastTimestamp = exportLatestTimestamp(stats.lastTimestamp, entry.timestamp);
    dayStats.set(day, stats);
    firstMessageAt = exportEarliestTimestamp(firstMessageAt, entry.timestamp);
    lastMessageAt = exportLatestTimestamp(lastMessageAt, entry.timestamp);
  }

  return {
    session: {
      hostId: session.hostId || null,
      sessionId: session.sessionId || null,
      title: session.title || null,
      createdAt: session.createdAt || null,
      updatedAt: session.lastUpdatedAt || session.updatedAt || null,
      firstMessageAt,
      lastMessageAt,
      messageCount: transcript.length,
    },
    days: Array.from(dayStats.values())
      .sort((a, b) => String(a.date).localeCompare(String(b.date))),
  };
}

function serializeSessionExportOptions(options = {}) {
  const exportOptions = normalizeSessionExportOptions(options);
  return {
    ...exportOptions,
    fromDate: exportOptions.fromDate ? exportOptions.fromDate.toISOString() : null,
    toDate: exportOptions.toDate ? exportOptions.toDate.toISOString() : null,
    selectedDates: Array.from(exportOptions.selectedDates || []),
    extensions: Array.from(exportOptions.extensions || []),
    fileIds: Array.from(exportOptions.fileIds || []),
  };
}

function filterTranscriptForExport(transcript, exportOptions) {
  const hasSelectedDates = Boolean(exportOptions.selectedDates?.size);
  const entries = (Array.isArray(transcript) ? transcript : [])
    .filter((entry) => entry && ['user', 'agent', 'assistant', 'system'].includes(entry.speaker || ''))
    .filter((entry) => {
      if (hasSelectedDates) {
        const day = exportDayKey(entry.timestamp);
        return Boolean(day && exportOptions.selectedDates.has(day));
      }
      if (!exportOptions.fromDate && !exportOptions.toDate) {
        return true;
      }
      const timestamp = Date.parse(entry.timestamp || '');
      if (!Number.isFinite(timestamp)) {
        return false;
      }
      if (exportOptions.fromDate && timestamp < exportOptions.fromDate.getTime()) {
        return false;
      }
      if (exportOptions.toDate && timestamp > exportOptions.toDate.getTime()) {
        return false;
      }
      return true;
    });
  const rangedEntries = (hasSelectedDates || exportOptions.fromDate || exportOptions.toDate)
    ? entries
    : entries.slice(exportOptions.startIndex - 1, exportOptions.endIndex);
  return rangedEntries
    .map((entry) => ({
      ...entry,
      files: (Array.isArray(entry.files) ? entry.files : []).filter((file) => exportFileAllowed(file, exportOptions)),
    }));
}

function formatExportDiagnosticEntry(entry) {
  const kind = exportLineValue(entry?.kind || 'event', 'event');
  const method = exportLineValue(entry?.method || '');
  const timestamp = exportTimestamp(entry?.timestamp);
  const headingParts = [kind];
  if (method) {
    headingParts.push(method);
  }
  if (timestamp) {
    headingParts.push(timestamp);
  }

  const message = String(entry?.message || '').trim() || '(empty)';
  const lines = [`### ${headingParts.join(' | ')}`, '', message];
  const detail = String(entry?.detail || '').trim();
  if (detail) {
    lines.push('', '```text', detail, '```');
  }
  return lines.join('\n');
}

function buildSessionMarkdownExport(detail, options = {}) {
  const exportOptions = normalizeSessionExportOptions(options);
  const { session, transcript, runtime, alerts, diagnostics, requests, receivedFiles } = detail;
  const visibleTranscript = (Array.isArray(transcript) ? transcript : [])
    .filter((entry) => entry && ['user', 'agent', 'assistant', 'system'].includes(entry.speaker || ''));
  const transcriptFiles = collectTranscriptFiles(visibleTranscript);
  const cachedFiles = Array.isArray(receivedFiles) ? receivedFiles : [];
  const lines = [
    `# ${sessionExportTitle(session)}`,
    '',
    '## Metadata',
    '',
    `- Host: ${exportLineValue(session.hostId)}`,
    `- Session: ${exportLineValue(session.sessionId)}`,
    `- Conversation ID: ${exportLineValue(session.conversationKey || session.sessionId)}`,
    `- Title: ${exportLineValue(session.title || '(untitled)')}`,
    `- State: ${exportLineValue(session.state || 'unknown')}`,
    `- Source: ${exportLineValue(session.source || 'unknown')}`,
    `- Live: ${session.live ? 'yes' : 'no'}`,
    `- CWD: ${exportLineValue(session.cwd || '(unknown)')}`,
    `- Created: ${exportTimestamp(session.createdAt) || '(unknown)'}`,
    `- Updated: ${exportTimestamp(session.lastUpdatedAt || session.updatedAt) || '(unknown)'}`,
    `- Exported: ${new Date().toISOString()}`,
    '',
    '## Conversation',
    '',
  ];

  if (visibleTranscript.length > 0) {
    lines.push(...visibleTranscript.map(formatExportEntry).join('\n\n').split('\n'));
  } else {
    lines.push('No transcript entries were captured for this session.');
  }

  lines.push('', '## Images and Files', '');
  if (!transcriptFiles.length && !cachedFiles.length) {
    lines.push('No image or file references were captured for this session.');
  } else {
    if (transcriptFiles.length > 0) {
      lines.push('### Referenced by Messages', '');
      for (const file of transcriptFiles) {
        lines.push(formatExportFileLine(file, { includeTimestamp: true }));
      }
      lines.push('');
    }
    if (cachedFiles.length > 0) {
      lines.push('### Cached Downloads', '');
      for (const file of cachedFiles) {
        lines.push(formatExportFileLine(file));
      }
    }
  }

  lines.push('', '## Runtime Summary', '');
  if (runtime) {
    lines.push(`- Phase: ${exportLineValue(runtime.phase || 'unknown')}`);
    lines.push(`- Connection: ${exportLineValue(runtime.connection || 'unknown')}`);
    lines.push(`- Active turn: ${exportLineValue(runtime.activeTurnId || runtime.turnId || '') || '(none)'}`);
    if (runtime.usage?.last) {
      lines.push(`- Last input tokens: ${Number(runtime.usage.last.inputTokens || 0) || 0}`);
      lines.push(`- Last output tokens: ${Number(runtime.usage.last.outputTokens || 0) || 0}`);
      lines.push(`- Last reasoning tokens: ${Number(runtime.usage.last.reasoningTokens || 0) || 0}`);
    }
  } else {
    lines.push('No runtime snapshot was captured.');
  }

  const importantAlerts = (Array.isArray(alerts) ? alerts : []).filter((alert) => alert?.message);
  if (importantAlerts.length > 0) {
    lines.push('', '## Alerts', '');
    for (const alert of importantAlerts) {
      lines.push(`- ${exportTimestamp(alert.timestamp) || '(unknown time)'} ${exportLineValue(alert.severity || 'info')}: ${exportLineValue(alert.message)}`);
    }
  }

  const pendingRequests = (Array.isArray(requests) ? requests : []).filter((request) => request?.status === 'pending');
  if (pendingRequests.length > 0) {
    lines.push('', '## Pending Requests', '');
    for (const request of pendingRequests) {
      lines.push(`- ${exportLineValue(request.kind || request.method || 'request')}: ${exportLineValue(request.message || request.status || '')}`);
    }
  }

  const diagnosticEntries = Array.isArray(diagnostics) ? diagnostics : [];
  const diagnosticCount = diagnosticEntries.length;
  lines.push('', '## Thinking / Activity', '');
  if (exportOptions.includeThinking) {
    if (diagnosticEntries.length > 0) {
      lines.push(...diagnosticEntries.map(formatExportDiagnosticEntry).join('\n\n').split('\n'));
    } else {
      lines.push('No thinking/activity events were captured for this session.');
    }
  } else {
    lines.push(`${diagnosticCount} thinking/activity event(s) captured but omitted from this export. Re-export with includeThinking=1 to include the full structured timeline.`);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function buildSessionJsonExport(detail, options = {}) {
  const exportOptions = normalizeSessionExportOptions(options);
  return {
    exportedAt: nowIso(),
    version: 1,
    exportOptions: serializeSessionExportOptions(exportOptions),
    ...detail,
    diagnostics: exportOptions.includeThinking ? detail.diagnostics : [],
  };
}

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

const ZIP_CRC32_TABLE = makeCrc32Table();

function crc32Update(crc, chunk) {
  let value = crc >>> 0;
  for (const byte of chunk) {
    value = ZIP_CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function crc32Buffer(buffer) {
  return (crc32Update(0xffffffff, buffer) ^ 0xffffffff) >>> 0;
}

function zipDosDateTime(value = new Date()) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeZipUInt32(buffer, value, offset) {
  if (value > 0xffffffff) {
    throw new Error('zip export does not support files larger than 4 GiB');
  }
  buffer.writeUInt32LE(value >>> 0, offset);
}

function safeZipEntryName(value, fallback = 'file') {
  return safeFileDisplayName(value || fallback, fallback)
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+$/, fallback)
    .slice(0, 160) || fallback;
}

function uniqueZipPath(usedPaths, directory, filename) {
  const safeDirectory = String(directory || '').replace(/^\/+|\/+$/g, '');
  const safeName = safeZipEntryName(filename, 'file');
  const dotIndex = safeName.lastIndexOf('.');
  const base = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const ext = dotIndex > 0 ? safeName.slice(dotIndex) : '';
  let candidate = safeDirectory ? `${safeDirectory}/${safeName}` : safeName;
  let counter = 2;
  while (usedPaths.has(candidate)) {
    candidate = safeDirectory ? `${safeDirectory}/${base}-${counter}${ext}` : `${base}-${counter}${ext}`;
    counter += 1;
  }
  usedPaths.add(candidate);
  return candidate;
}

class ZipStreamWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.entries = [];
  }

  async write(buffer) {
    if (!buffer.length) {
      return;
    }
    this.offset += buffer.length;
    if (!this.stream.write(buffer)) {
      await waitForStreamDrain(this.stream);
    }
  }

  async writeLocalHeader(name, options) {
    const filename = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(30);
    const { time, date } = zipDosDateTime(options.modifiedAt);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(options.flags, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    writeZipUInt32(header, options.crc || 0, 14);
    writeZipUInt32(header, options.compressedSize || 0, 18);
    writeZipUInt32(header, options.uncompressedSize || 0, 22);
    header.writeUInt16LE(filename.length, 26);
    header.writeUInt16LE(0, 28);
    await this.write(header);
    await this.write(filename);
  }

  async addBuffer(name, buffer, modifiedAt = new Date()) {
    const entryName = String(name || 'file');
    const crc = crc32Buffer(buffer);
    const offset = this.offset;
    const flags = 0x0800;
    await this.writeLocalHeader(entryName, {
      flags,
      crc,
      compressedSize: buffer.length,
      uncompressedSize: buffer.length,
      modifiedAt,
    });
    await this.write(buffer);
    this.entries.push({
      name: entryName,
      flags,
      crc,
      compressedSize: buffer.length,
      uncompressedSize: buffer.length,
      offset,
      modifiedAt,
    });
  }

  async addFile(name, filePath, modifiedAt = new Date()) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return;
    }
    if (stat.size > 0xffffffff) {
      throw new Error(`file is too large for zip export: ${filePath}`);
    }
    const entryName = String(name || safeFileDisplayName(filePath));
    const offset = this.offset;
    const flags = 0x0808;
    await this.writeLocalHeader(entryName, {
      flags,
      crc: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      modifiedAt,
    });

    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crc32Update(crc, buffer);
      size += buffer.length;
      await this.write(buffer);
    }
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    writeZipUInt32(descriptor, finalCrc, 4);
    writeZipUInt32(descriptor, size, 8);
    writeZipUInt32(descriptor, size, 12);
    await this.write(descriptor);
    this.entries.push({
      name: entryName,
      flags,
      crc: finalCrc,
      compressedSize: size,
      uncompressedSize: size,
      offset,
      modifiedAt,
    });
  }

  async finalize() {
    const centralDirectoryOffset = this.offset;
    for (const entry of this.entries) {
      const filename = Buffer.from(entry.name, 'utf8');
      const header = Buffer.alloc(46);
      const { time, date } = zipDosDateTime(entry.modifiedAt);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(entry.flags, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      writeZipUInt32(header, entry.crc, 16);
      writeZipUInt32(header, entry.compressedSize, 20);
      writeZipUInt32(header, entry.uncompressedSize, 24);
      header.writeUInt16LE(filename.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      writeZipUInt32(header, entry.offset, 42);
      await this.write(header);
      await this.write(filename);
    }

    const centralDirectorySize = this.offset - centralDirectoryOffset;
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50, 0);
    footer.writeUInt16LE(0, 4);
    footer.writeUInt16LE(0, 6);
    footer.writeUInt16LE(this.entries.length, 8);
    footer.writeUInt16LE(this.entries.length, 10);
    writeZipUInt32(footer, centralDirectorySize, 12);
    writeZipUInt32(footer, centralDirectoryOffset, 16);
    footer.writeUInt16LE(0, 20);
    await this.write(footer);
  }
}

function getSessionCachedFileRecords(session) {
  pruneReceivedFiles();
  const hostId = String(session?.hostId || '');
  const sessionId = String(session?.sessionId || '');
  return Array.from(state.receivedFiles.values())
    .filter((file) => file.hostId === hostId && file.sessionId === sessionId && file.localPath && fs.existsSync(file.localPath))
    .sort((a, b) => String(a.receivedAt || '').localeCompare(String(b.receivedAt || '')));
}

function prepareSessionBundleFiles(detail, exportOptions = normalizeSessionExportOptions()) {
  const usedPaths = new Set(['session.md', 'session.json', 'manifest.json']);
  const allowedIds = new Set();
  const addFileIds = (file) => {
    if (!exportFileAllowed(file, exportOptions)) {
      return;
    }
    for (const identity of exportFileIdentityValues(file)) {
      allowedIds.add(identity);
    }
  };
  for (const file of Array.isArray(detail.receivedFiles) ? detail.receivedFiles : []) {
    addFileIds(file);
  }
  for (const file of collectTranscriptFiles(detail.transcript || [])) {
    addFileIds(file);
  }
  return getSessionCachedFileRecords(detail.session)
    .filter((file) => exportFileIdentityMatches(file, allowedIds))
    .map((file) => ({
    ...file,
    zipPath: uniqueZipPath(usedPaths, 'files', file.name || file.remotePath || file.fileId),
  }));
}

function buildSessionBundleManifest(detail, bundleFiles, options = {}) {
  const exportOptions = normalizeSessionExportOptions(options);
  const referencedFiles = collectTranscriptFiles(detail.transcript || []);
  return {
    exportedAt: nowIso(),
    version: 1,
    exportOptions: serializeSessionExportOptions(exportOptions),
    title: sessionExportTitle(detail.session),
    session: detail.session,
    referencedFiles,
    cachedFiles: bundleFiles.map((file) => ({
      fileId: file.fileId,
      name: file.name,
      remotePath: file.remotePath,
      mime: file.mime,
      size: file.size,
      receivedAt: file.receivedAt,
      expiresAt: file.expiresAt,
      zipPath: file.zipPath,
    })),
    notes: [
      'The files/ directory contains only files already cached by the relay.',
      'Referenced remote files that were not cached are listed in referencedFiles but are not embedded in this zip.',
    ],
  };
}

async function streamSessionZipExport(res, detail, options = {}) {
  const exportOptions = normalizeSessionExportOptions(options);
  const bundleFiles = prepareSessionBundleFiles(detail, exportOptions);
  const manifest = buildSessionBundleManifest(detail, bundleFiles, exportOptions);
  const jsonExport = {
    ...buildSessionJsonExport(detail, exportOptions),
    bundle: {
      manifest,
      cachedFileCount: bundleFiles.length,
    },
  };
  const markdown = buildSessionMarkdownExport(detail, exportOptions);
  const filename = `${sessionExportBaseName(detail.session)}.zip`;

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDispositionValue('attachment', filename),
    'Cache-Control': 'no-store',
  });

  const writer = new ZipStreamWriter(res);
  const exportedAt = new Date();
  await writer.addBuffer('session.md', Buffer.from(markdown, 'utf8'), exportedAt);
  await writer.addBuffer('session.json', Buffer.from(JSON.stringify(jsonExport, null, 2), 'utf8'), exportedAt);
  await writer.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), exportedAt);
  for (const file of bundleFiles) {
    await writer.addFile(file.zipPath, file.localPath, file.receivedAt ? new Date(file.receivedAt) : exportedAt);
  }
  await writer.finalize();
  res.end();
}

function safeFileDisplayName(value, fallback = 'download') {
  const text = String(value || '').trim();
  const leaf = text.split(/[\\/]/).filter(Boolean).pop() || fallback;
  return leaf.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || fallback;
}

function isAmbiguousBareDownloadPath(value) {
  const text = String(value || '').trim();
  return Boolean(text)
    && !/[\\/]/.test(text)
    && !/^[A-Za-z]:/.test(text)
    && !text.startsWith('~');
}

function normalizeFileTransferRefs(rawFiles) {
  const files = [];
  for (const rawFile of Array.isArray(rawFiles) ? rawFiles.slice(0, 16) : []) {
    if (!rawFile || typeof rawFile !== 'object') {
      continue;
    }

    const remotePath = normalizeRemoteFilePath(rawFile.path || rawFile.remotePath || '');
    const name = safeFileDisplayName(rawFile.name || remotePath || 'file');
    if (!remotePath && !rawFile.dataBase64) {
      continue;
    }

    files.push({
      fileId: String(rawFile.fileId || rawFile.id || makeId()).trim(),
      name,
      path: remotePath,
      size: Number(rawFile.size || 0) || 0,
      mime: String(rawFile.mime || rawFile.type || 'application/octet-stream').trim() || 'application/octet-stream',
      isImage: Boolean(rawFile.isImage) || /^image\//i.test(String(rawFile.mime || rawFile.type || '')),
      cached: Boolean(rawFile.cached),
      uploadedAt: rawFile.uploadedAt || rawFile.timestamp || nowIso(),
    });
  }
  return files;
}

function transcriptFingerprint(entry) {
  if (entry.assistantMessageId) {
    return `assistant|${entry.assistantMessageId}`;
  }
  if (entry.clientRequestId) {
    return `request|${entry.speaker || 'system'}|${entry.clientRequestId}`;
  }
  return `${entry.speaker || 'system'}|${entry.timestamp || ''}|${canonicalTranscriptText(entry.text || '')}|${(entry.files || []).map((file) => file.path || file.name || '').join(',')}`;
}

function diagnosticFingerprint(entry) {
  return `${entry.timestamp || ''}|${entry.kind || ''}|${entry.method || ''}|${entry.message || ''}|${entry.detail || ''}|${diagnosticIdentitySignature(entry)}`;
}

function setSessionLog(hostId, sessionId, entries, options = {}) {
  const key = resolveSessionKey(hostId, sessionId);
  const normalized = (Array.isArray(entries) ? entries : [])
    .map(normalizeStoredTranscriptEntry)
    .filter(Boolean);
  const existing = options.merge ? state.sessionLogs.get(key) || [] : [];
  state.sessionLogs.set(
    key,
    compactTranscriptEntries(mergeByFingerprint([...existing, ...normalized], transcriptFingerprint, SESSION_LOG_ENTRY_LIMIT))
      .slice(-SESSION_LOG_ENTRY_LIMIT)
  );
  scheduleSessionLogsSave();
}

function setSessionDiagnostics(hostId, sessionId, entries, options = {}) {
  const key = resolveSessionKey(hostId, sessionId);
  const normalized = (Array.isArray(entries) ? entries : [])
    .map(normalizeStoredSessionDiagnostic)
    .filter(Boolean);
  const existing = options.merge ? state.sessionDiagnostics.get(key) || [] : [];
  const merged = mergeByFingerprint([...existing, ...normalized], diagnosticFingerprint, SESSION_DIAGNOSTIC_ENTRY_LIMIT);
  state.sessionDiagnostics.set(key, compactSessionDiagnostics(merged));
  scheduleSessionDiagnosticsSave();
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
  return sortTranscriptEntries(merged).slice(-limit);
}

function setSessionAlerts(hostId, sessionId, entries) {
  const key = resolveSessionKey(hostId, sessionId);
  const alerts = Array.isArray(entries) ? entries : [];
  state.sessionAlerts.set(key, mergeByFingerprint(alerts, (entry) => `${entry.severity || 'warning'}|${entry.timestamp || ''}|${entry.message || ''}`, 100));
}

function normalizedRuntimeRevision(runtime) {
  const revision = Number(runtime?.runtimeRevision || 0);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function runtimePatchHasStaleRevision(existing, incoming) {
  const existingRevision = normalizedRuntimeRevision(existing);
  const incomingRevision = normalizedRuntimeRevision(incoming);
  if (!existingRevision || !incomingRevision) return false;
  const existingRunId = String(existing?.runId || '').trim();
  const incomingRunId = String(incoming?.runId || '').trim();
  return Boolean(
    existingRunId
    && incomingRunId
    && existingRunId === incomingRunId
    && incomingRevision <= existingRevision
  );
}

function setSessionRuntime(hostId, sessionId, runtime) {
  const key = resolveSessionKey(hostId, sessionId);
  if (!runtime || typeof runtime !== 'object') {
    state.sessionRuntime.delete(key);
    return null;
  }

  const existing = state.sessionRuntime.get(key) || {};
  if (runtimePatchHasStaleRevision(existing, runtime)) {
    return existing;
  }
  const next = {
    ...existing,
    ...runtime,
    updatedAt: runtime.updatedAt || nowIso(),
  };
  state.sessionRuntime.set(key, next);
  return next;
}

function appendSessionDiagnostic(hostId, sessionId, entry) {
  const key = resolveSessionKey(hostId, sessionId);
  const existing = state.sessionDiagnostics.get(key) || [];
  const nextEntry = normalizeStoredSessionDiagnostic({
    timestamp: entry.timestamp || nowIso(),
    severity: entry.severity || 'info',
    source: entry.source || 'codex',
    kind: entry.kind || 'event',
    method: entry.method || null,
    message: entry.message || '',
    detail: entry.detail || null,
    data: entry.data || null,
    runId: entry.runId || entry.data?.runId || null,
    turnId: entry.turnId || entry.data?.turnId || null,
    itemId: entry.itemId || entry.data?.itemId || null,
    callId: entry.callId || entry.data?.callId || null,
    requestId: entry.requestId || entry.data?.requestId || null,
    status: entry.status || entry.data?.status || null,
    final: entry.final === true,
  });
  if (!nextEntry) {
    return null;
  }
  state.sessionDiagnostics.set(key, appendCompactedSessionDiagnostic(existing, nextEntry));
  scheduleSessionDiagnosticsSave();
  return nextEntry;
}

function emitSessionDiagnostic(hostId, sessionId, entry) {
  const effectiveSessionId = resolveSessionId(hostId, sessionId);
  const nextEntry = appendSessionDiagnostic(hostId, effectiveSessionId, entry);
  if (!nextEntry) {
    return null;
  }
  const payload = {
    ...nextEntry,
    hostId,
    sessionId: effectiveSessionId,
  };
  broadcastSessionEvent(hostId, effectiveSessionId, 'session.diagnostic', payload);
  return payload;
}

function emitSessionRuntimePatch(hostId, sessionId, patch = {}) {
  const effectiveSessionId = resolveSessionId(hostId, sessionId);
  const existing = state.sessionRuntime.get(resolveSessionKey(hostId, effectiveSessionId)) || {};
  if (runtimePatchHasStaleRevision(existing, patch)) {
    return existing;
  }
  const timestamp = patch.updatedAt || nowIso();
  const runtime = setSessionRuntime(hostId, effectiveSessionId, {
    ...patch,
    updatedAt: timestamp,
  });
  upsertSession(hostId, {
    sessionId: effectiveSessionId,
    runtime,
    lastUpdatedAt: timestamp,
  });
  broadcastSessionEvent(hostId, effectiveSessionId, 'session.runtime_updated', {
    hostId,
    sessionId: effectiveSessionId,
    patch,
    timestamp,
  });
  return runtime;
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
    availableDecisions: entry.availableDecisions || entry.payload?.availableDecisions || [],
    response: entry.response || null,
    runId: entry.runId || null,
    turnId: entry.turnId || null,
    itemId: entry.itemId || null,
    callId: entry.callId || null,
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

function findSessionRequest(hostId, sessionId, requestId) {
  const effectiveSessionId = resolveSessionId(hostId, sessionId);
  const request = (state.sessionRequests.get(sessionKey(hostId, effectiveSessionId)) || [])
    .find((item) => String(item.requestId || '') === String(requestId || '')) || null;
  return { effectiveSessionId, request };
}

function claimSessionRequestResponse(hostId, sessionId, requestId, response, options = {}) {
  const { effectiveSessionId, request } = findSessionRequest(hostId, sessionId, requestId);
  if (!request) {
    return {
      ok: false,
      statusCode: 409,
      error: 'This Codex request is no longer available.',
      code: 'session_request_not_found',
      effectiveSessionId,
    };
  }

  const session = getSession(hostId, effectiveSessionId);
  const requestRunId = String(request.runId || '').trim();
  const currentRunId = String(session?.runId || '').trim();
  const submittedRunId = String(options.runId || '').trim();
  if (
    (submittedRunId && requestRunId && submittedRunId !== requestRunId)
    || (requestRunId && currentRunId && requestRunId !== currentRunId)
  ) {
    return {
      ok: false,
      statusCode: 409,
      error: 'This approval belongs to an earlier Session run.',
      code: 'session_request_stale_run',
      effectiveSessionId,
      request,
    };
  }

  if (request.status !== 'pending') {
    return {
      ok: true,
      duplicate: true,
      effectiveSessionId,
      request,
    };
  }

  const responding = emitSessionRequest(hostId, effectiveSessionId, {
    ...request,
    status: 'responding',
    updatedAt: nowIso(),
    response: response || null,
  });
  return {
    ok: true,
    claimed: true,
    effectiveSessionId,
    request: responding,
  };
}

function goalAutoApproveKey(hostId, sessionId) {
  return sessionKey(hostId, resolveSessionId(hostId, sessionId));
}

function getGoalAutoApproveState(hostId, sessionId) {
  return state.goalAutoApproveRequests.get(goalAutoApproveKey(hostId, sessionId)) || null;
}

function isGoalAutoApproveEnabled(hostId, sessionId) {
  const stored = getGoalAutoApproveState(hostId, sessionId);
  if (!stored?.enabled) {
    return false;
  }
  const runtime = state.sessionRuntime.get(goalAutoApproveKey(hostId, sessionId)) || {};
  const goal = runtime.goal || null;
  const goalStatus = String(goal?.status || '').toLowerCase();
  return Boolean(goal && !['complete', 'completed', 'blocked', 'cancelled', 'canceled'].includes(goalStatus));
}

function setGoalAutoApproveState(hostId, sessionId, patch = {}) {
  const key = goalAutoApproveKey(hostId, sessionId);
  const previous = state.goalAutoApproveRequests.get(key) || {};
  const next = {
    enabled: Boolean(patch.enabled),
    updatedAt: patch.updatedAt || nowIso(),
    scope: 'goal',
    requestId: patch.requestId || previous.requestId || null,
  };
  if (!next.enabled) {
    state.goalAutoApproveRequests.delete(key);
    return { ...next, enabled: false };
  }
  state.goalAutoApproveRequests.set(key, next);
  return next;
}

function clearGoalAutoApproveState(hostId, sessionId) {
  state.goalAutoApproveRequests.delete(goalAutoApproveKey(hostId, sessionId));
}

function maybeClearGoalAutoApproveForRuntime(hostId, sessionId, runtime = {}) {
  const goal = runtime?.goal;
  const goalStatus = String(goal?.status || '').toLowerCase();
  if (goal === null || ['complete', 'completed', 'blocked', 'cancelled', 'canceled'].includes(goalStatus)) {
    clearGoalAutoApproveState(hostId, sessionId);
  }
}

function sessionIdentityPatch(hostId, sessionId) {
  const session = getSession(hostId, sessionId);
  return {
    nativeThreadId: session?.nativeThreadId || null,
    bridgeSessionId: session?.bridgeSessionId || null,
    originSessionId: session?.originSessionId || null,
    sourceSessionId: session?.sourceSessionId || null,
    conversationKey: session?.conversationKey || null,
    runId: session?.runId || null,
  };
}

function maybeAutoApproveSessionRequest(hostId, sessionId, requestEntry) {
  if (!isGoalAutoApproveEnabled(hostId, sessionId)) {
    return false;
  }
  const method = String(requestEntry?.method || '');
  if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
    return false;
  }
  const requestId = String(requestEntry?.requestId || '').trim();
  if (!requestId) {
    return false;
  }
  const response = {
    decision: 'accept',
    autoApproved: true,
    scope: 'goal',
  };
  const claim = claimSessionRequestResponse(hostId, sessionId, requestId, response, {
    runId: requestEntry?.runId || null,
  });
  if (!claim.claimed) {
    return false;
  }
  enqueueCommand(hostId, {
    type: 'session.request.respond',
    sessionId: claim.effectiveSessionId,
    requestId,
    response,
    ...sessionIdentityPatch(hostId, claim.effectiveSessionId),
  });
  return true;
}

function resolveSessionRequest(hostId, sessionId, requestId, patch = {}) {
  const key = sessionKey(hostId, sessionId);
  const existing = (state.sessionRequests.get(key) || [])
    .find((item) => String(item.requestId || '') === String(requestId || ''));
  const resolved = upsertSessionRequest(hostId, sessionId, {
    requestId,
    createdAt: existing?.createdAt || patch.createdAt || nowIso(),
    status: patch.status || 'resolved',
    updatedAt: patch.updatedAt || nowIso(),
    kind: patch.kind ?? existing?.kind ?? 'request',
    method: patch.method ?? existing?.method ?? null,
    title: patch.title ?? existing?.title ?? null,
    message: patch.message ?? existing?.message ?? null,
    summary: patch.summary ?? existing?.summary ?? null,
    payload: patch.payload ?? existing?.payload ?? null,
    availableDecisions: patch.availableDecisions ?? existing?.availableDecisions ?? [],
    response: patch.response ?? existing?.response ?? null,
    runId: patch.runId ?? existing?.runId ?? null,
    turnId: patch.turnId ?? existing?.turnId ?? null,
    itemId: patch.itemId ?? existing?.itemId ?? null,
    callId: patch.callId ?? existing?.callId ?? null,
  });
  const payload = {
    ...resolved,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.request.resolved', payload);
  return payload;
}

function resolvePendingSessionRequests(hostId, sessionId, patch = {}) {
  const key = sessionKey(hostId, sessionId);
  const requests = state.sessionRequests.get(key) || [];
  const pending = requests.filter((item) => ['pending', 'responding'].includes(item.status));
  for (const request of pending) {
    resolveSessionRequest(hostId, sessionId, request.requestId, {
      status: patch.status || 'expired',
      updatedAt: patch.updatedAt || nowIso(),
      message: patch.message || request.message || 'Request closed because the Codex turn is no longer active.',
      summary: patch.summary ?? request.summary ?? null,
      response: patch.response || {
        status: patch.status || 'expired',
        reason: patch.message || 'Request closed because the Codex turn is no longer active.',
      },
    });
  }
}

function appendSessionLog(hostId, sessionId, entry) {
  const key = sessionKey(hostId, sessionId);
  const existing = compactTranscriptEntries(state.sessionLogs.get(key) || []);
  const nextEntry = normalizeStoredTranscriptEntry(entry);
  if (!nextEntry) {
    return null;
  }
  if (nextEntry.assistantMessageId) {
    const existingIndex = existing.findIndex((candidate) => (
      candidate.assistantMessageId === nextEntry.assistantMessageId
    ));
    if (existingIndex >= 0) {
      const previous = existing[existingIndex];
      const previousIsRollout = previous.source === 'codex-jsonl';
      const incomingIsRollout = nextEntry.source === 'codex-jsonl';
      const merged = normalizeStoredTranscriptEntry(
        previousIsRollout && !incomingIsRollout
          ? { ...nextEntry, ...previous }
          : { ...previous, ...nextEntry }
      );
      existing[existingIndex] = merged;
      state.sessionLogs.set(
        key,
        compactTranscriptEntries(existing).slice(-SESSION_LOG_ENTRY_LIMIT)
      );
      const session = getSession(hostId, sessionId);
      if (session) {
        session.messageCount = Math.max(Number(session.messageCount || 0), state.sessionLogs.get(key)?.length || 0);
        session.lastUpdatedAt = merged.timestamp || nowIso();
        state.sessions.set(key, session);
      }
      scheduleSessionLogsSave();
      return merged;
    }
  }
  const adjacent = existing[existing.length - 1] || null;
  if (isAdjacentTranscriptDuplicate(adjacent, nextEntry)) {
    if (
      adjacent?.assistantMessageId
      || nextEntry.assistantMessageId
      || adjacent?.clientRequestId
      || nextEntry.clientRequestId
    ) {
      const merged = mergeAdjacentTranscriptDuplicate(adjacent, nextEntry);
      existing[existing.length - 1] = merged;
      state.sessionLogs.set(key, existing.slice(-SESSION_LOG_ENTRY_LIMIT));
      scheduleSessionLogsSave();
      return merged;
    }
    return null;
  }
  existing.push(nextEntry);
  state.sessionLogs.set(
    key,
    compactTranscriptEntries(mergeByFingerprint(existing, transcriptFingerprint, SESSION_LOG_ENTRY_LIMIT))
      .slice(-SESSION_LOG_ENTRY_LIMIT)
  );
  const session = getSession(hostId, sessionId);
  if (session) {
    session.messageCount = Math.max(Number(session.messageCount || 0), state.sessionLogs.get(key)?.length || 0);
    session.lastUpdatedAt = nextEntry.timestamp || nowIso();
    state.sessions.set(key, session);
  }
  scheduleSessionLogsSave();
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
    transient: entry.transient === true,
    turnId: entry.turnId || null,
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
  if (!nextEntry) {
    return null;
  }
  const payload = {
    ...nextEntry,
    hostId,
    sessionId,
  };
  broadcastSessionEvent(hostId, sessionId, 'session.transcript', payload);
  return payload;
}

const PENDING_USER_TRANSCRIPT_ECHO_TTL_MS = 5 * 60 * 1000;
const PENDING_USER_TRANSCRIPT_ECHO_LIMIT = 16;

function prunePendingUserTranscriptEchoesForKey(key) {
  const records = state.pendingUserTranscriptEchoes.get(key) || [];
  const cutoff = Date.now() - PENDING_USER_TRANSCRIPT_ECHO_TTL_MS;
  const fresh = records.filter((record) => Number(record.createdAt || 0) >= cutoff);
  if (fresh.length) {
    state.pendingUserTranscriptEchoes.set(key, fresh.slice(-PENDING_USER_TRANSCRIPT_ECHO_LIMIT));
  } else {
    state.pendingUserTranscriptEchoes.delete(key);
  }
  return fresh;
}

function recordPendingUserTranscriptEcho(hostId, sessionId, entry) {
  const key = sessionKey(hostId, sessionId);
  const clientRequestId = normalizeClientRequestId(entry?.clientRequestId) || null;
  const fullText = cleanStoredTranscriptText(entry?.fullText || '', 'user');
  const displayText = cleanStoredTranscriptText(entry?.displayText || '', 'user');
  const fullCanonical = canonicalTranscriptText(fullText);
  const displayCanonical = canonicalTranscriptText(displayText);
  if (!clientRequestId && !fullCanonical && !displayCanonical) {
    return;
  }
  const records = prunePendingUserTranscriptEchoesForKey(key);
  records.push({
    createdAt: Date.now(),
    clientRequestId,
    fullCanonical,
    displayCanonical,
    status: 'pending',
  });
  state.pendingUserTranscriptEchoes.set(key, records.slice(-PENDING_USER_TRANSCRIPT_ECHO_LIMIT));
}

function consumePendingUserTranscriptEcho(hostId, sessionId, entry) {
  if (String(entry?.speaker || '').toLowerCase() !== 'user') {
    return false;
  }
  const key = sessionKey(hostId, sessionId);
  const records = prunePendingUserTranscriptEchoesForKey(key);
  if (!records.length) {
    return false;
  }
  const entryCanonical = canonicalTranscriptText(cleanStoredTranscriptText(entry.text || '', 'user'));
  if (!entryCanonical) {
    return false;
  }
  const entryRequestId = normalizeClientRequestId(entry.clientRequestId) || null;
  const index = records.findIndex((record) => {
    if (entryRequestId && record.clientRequestId) {
      return entryRequestId === record.clientRequestId;
    }
    if (entryRequestId) return false;
    return (record.fullCanonical && entryCanonical === record.fullCanonical)
      || (record.displayCanonical && entryCanonical === record.displayCanonical);
  });
  if (index < 0) {
    return false;
  }
  if (records[index].status === 'rejected') {
    return true;
  }
  records.splice(index, 1);
  if (records.length) {
    state.pendingUserTranscriptEchoes.set(key, records);
  } else {
    state.pendingUserTranscriptEchoes.delete(key);
  }
  return true;
}

function markPendingUserTranscriptEchoRejected(hostId, sessionId, clientRequestId, entry = null) {
  const normalizedRequestId = normalizeClientRequestId(clientRequestId) || null;
  if (!normalizedRequestId) return false;
  const key = sessionKey(hostId, sessionId);
  const records = prunePendingUserTranscriptEchoesForKey(key);
  let record = records.find((candidate) => candidate.clientRequestId === normalizedRequestId) || null;
  if (!record) {
    const text = cleanStoredTranscriptText(entry?.text || '', 'user');
    const canonical = canonicalTranscriptText(text);
    record = {
      createdAt: Date.now(),
      clientRequestId: normalizedRequestId,
      fullCanonical: canonical,
      displayCanonical: canonical,
      status: 'rejected',
    };
    records.push(record);
  } else {
    record.status = 'rejected';
    record.createdAt = Date.now();
  }
  state.pendingUserTranscriptEchoes.set(key, records.slice(-PENDING_USER_TRANSCRIPT_ECHO_LIMIT));
  return true;
}

function markUserTranscriptAccepted(hostId, sessionId, clientRequestId) {
  const normalizedRequestId = normalizeClientRequestId(clientRequestId) || null;
  if (!normalizedRequestId) return false;
  const key = resolveSessionKey(hostId, sessionId);
  const existing = state.sessionLogs.get(key) || [];
  let changed = false;
  const next = existing.map((entry) => {
    if (
      entry?.speaker !== 'user'
      || entry.clientRequestId !== normalizedRequestId
      || entry.deliveryStatus === 'accepted'
    ) {
      return entry;
    }
    changed = true;
    return normalizeStoredTranscriptEntry({ ...entry, deliveryStatus: 'accepted' }) || entry;
  });
  if (!changed) return false;
  state.sessionLogs.set(key, next);
  refreshSessionMessageSummaries(hostId, sessionId, next);
  scheduleSessionLogsSave();
  return true;
}

function queueInputTranscriptProjectionCheckpoint(entry) {
  const hostId = String(entry?.hostId || '').trim();
  const commandId = Number(entry?.originalCommandId || entry?.commandId || 0);
  const clientRequestId = normalizeClientRequestId(entry?.clientRequestId);
  const outcome = String(entry?.projectionOutcome || '').trim();
  if (!hostId || !Number.isSafeInteger(commandId) || commandId <= 0 || !clientRequestId || !outcome) {
    return false;
  }
  state.pendingInputProjectionCheckpoints.set(`${hostId}::${commandId}`, {
    hostId,
    commandId,
    clientRequestId,
    outcome,
  });
  return true;
}

function checkpointPersistedInputTranscriptProjections() {
  for (const [key, checkpoint] of state.pendingInputProjectionCheckpoints.entries()) {
    const result = state.inputCommandOutbox.markProjectionApplied(
      checkpoint.hostId,
      checkpoint.commandId,
      checkpoint.clientRequestId,
      checkpoint.outcome
    );
    if (result.recorded || ['duplicate', 'missing'].includes(result.reason)) {
      state.pendingInputProjectionCheckpoints.delete(key);
    }
  }
}

function recoveredInputProjectionSessionIds(entry) {
  const command = entry?.command || {};
  return [...new Set([
    entry?.transcriptProjection?.sessionId,
    entry?.completedSessionId,
    command.requestedSessionId,
    command.sessionId,
    command.bridgeSessionId,
    command.nativeThreadId,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function reconcileRecoveredInputTranscriptProjections(projectionWork = []) {
  let changed = false;
  for (const entry of projectionWork) {
    const requestId = normalizeClientRequestId(entry?.clientRequestId);
    const outcome = String(entry?.projectionOutcome || '').trim();
    const projection = normalizeStoredTranscriptEntry({
      ...(entry?.transcriptProjection || {}),
      speaker: 'user',
      clientRequestId: requestId,
      deliveryStatus: outcome === 'accepted' ? 'accepted' : 'pending',
    });
    if (!requestId || !projection || !['pending', 'accepted', 'acceptance_unknown', 'rejected'].includes(outcome)) {
      continue;
    }
    const sessionIds = recoveredInputProjectionSessionIds(entry);
    let found = false;
    for (const sessionId of sessionIds) {
      const key = resolveSessionKey(entry.hostId, sessionId);
      const entries = state.sessionLogs.get(key) || [];
      found ||= entries.some((candidate) => (
        candidate?.speaker === 'user' && candidate.clientRequestId === requestId
      ));
      if (outcome === 'rejected') {
        const rejectedEntry = entries.find((entry) => (
          entry?.speaker === 'user'
          && entry.clientRequestId === requestId
          && entry.deliveryStatus !== 'accepted'
        )) || null;
        markPendingUserTranscriptEchoRejected(
          entry.hostId,
          sessionId,
          requestId,
          rejectedEntry
        );
      }
      const next = outcome === 'rejected'
        ? entries.filter((entry) => !(
          entry?.speaker === 'user'
          && entry.clientRequestId === requestId
          && entry.deliveryStatus !== 'accepted'
        ))
        : outcome === 'accepted'
          ? entries.map((entry) => (
            entry?.speaker === 'user' && entry.clientRequestId === requestId
              ? normalizeStoredTranscriptEntry({ ...entry, deliveryStatus: 'accepted' }) || entry
              : entry
          ))
          : entries;
      if (JSON.stringify(next) === JSON.stringify(entries)) continue;
      changed = true;
      if (next.length) state.sessionLogs.set(key, next);
      else state.sessionLogs.delete(key);
    }
    if (outcome !== 'rejected' && !found) {
      const sessionId = projection.sessionId || sessionIds[0];
      if (sessionId) {
        const key = resolveSessionKey(entry.hostId, sessionId);
        const entries = state.sessionLogs.get(key) || [];
        state.sessionLogs.set(
          key,
          compactTranscriptEntries([...entries, projection]).slice(-SESSION_LOG_ENTRY_LIMIT)
        );
        changed = true;
      }
    }
    if (outcome === 'pending' || outcome === 'acceptance_unknown') {
      recordPendingUserTranscriptEcho(entry.hostId, projection.sessionId || sessionIds[0], {
        clientRequestId: requestId,
        fullText: entry?.command?.text || projection.text,
        displayText: projection.text,
      });
    }
    queueInputTranscriptProjectionCheckpoint(entry);
  }
  if (projectionWork.length) saveSessionLogs();
  return changed;
}

function rejectPendingUserTranscript(hostId, sessionId, clientRequestId, reason = '') {
  const normalizedRequestId = normalizeClientRequestId(clientRequestId) || null;
  if (!normalizedRequestId) return null;
  const effectiveSessionId = resolveSessionId(hostId, sessionId);
  const key = resolveSessionKey(hostId, effectiveSessionId);
  const existing = state.sessionLogs.get(key) || [];
  const removed = existing.find((entry) => (
    entry?.speaker === 'user'
    && entry.clientRequestId === normalizedRequestId
    && entry.deliveryStatus !== 'accepted'
  )) || null;
  markPendingUserTranscriptEchoRejected(hostId, effectiveSessionId, normalizedRequestId, removed);
  if (!removed) return null;

  const next = existing.filter((entry) => entry !== removed);
  state.sessionLogs.set(key, next);
  scheduleSessionLogsSave();
  const session = refreshSessionMessageSummaries(hostId, effectiveSessionId, next);
  const payload = {
    hostId,
    sessionId: effectiveSessionId,
    speaker: 'user',
    clientRequestId: normalizedRequestId,
    reason: reason || 'input_rejected',
    timestamp: nowIso(),
  };
  broadcastSessionEvent(hostId, effectiveSessionId, 'session.transcript_removed', payload);
  if (session) {
    broadcastSessionEvent(hostId, effectiveSessionId, 'session.snapshot', session);
  }
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

function isBenignSessionWatchNoLiveError(message) {
  return /no live session for command session\.(watch|unwatch)\b/i.test(String(message || ''));
}

function buildResumeTranscript(entries, options = {}) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const maxEntries = Number(options.maxEntries ?? RESUME_TRANSCRIPT_MAX_ENTRIES);
  const maxEntryChars = Number(options.maxEntryChars ?? RESUME_TRANSCRIPT_MAX_ENTRY_CHARS);
  const maxTotalChars = Number(options.maxTotalChars ?? RESUME_TRANSCRIPT_MAX_TOTAL_CHARS);
  const filtered = entries
    .filter((entry) => entry && entry.text && entry.deliveryStatus !== 'pending')
    .map((entry) => ({
      speaker: entry.speaker || 'system',
      text: String(entry.text || ''),
      timestamp: entry.timestamp || null,
    }));

  const source = maxEntries > 0 ? filtered.slice(-maxEntries) : filtered;
  const result = [];
  let totalChars = 0;

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const entry = source[index];
    let text = String(entry.text || '').trim();
    if (!text) {
      continue;
    }
    if (maxEntryChars > 0 && text.length > maxEntryChars) {
      text = text.slice(0, maxEntryChars);
    }
    if (maxTotalChars > 0 && totalChars + text.length > maxTotalChars) {
      const remaining = maxTotalChars - totalChars;
      if (remaining <= 0) {
        break;
      }
      text = text.slice(Math.max(0, text.length - remaining));
    }
    result.unshift({
      speaker: entry.speaker,
      text,
      timestamp: entry.timestamp,
    });
    totalChars += text.length;
  }

  return result;
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

const INTERNAL_OUTPUT_CHANNELS = new Set([
  'analysis',
  'commentary',
  'reasoning',
  'thinking',
  'thought',
  'internal',
]);

function getOutputChannel(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }
  return String(event.phase || event.channel || event.kind || '').trim().toLowerCase();
}

function isInternalOutputEvent(event) {
  return INTERNAL_OUTPUT_CHANNELS.has(getOutputChannel(event));
}

function diagnosticKindForOutputChannel(channel) {
  if (channel === 'analysis' || channel === 'reasoning' || channel === 'thinking' || channel === 'thought') {
    return 'reasoning';
  }
  if (channel === 'commentary') {
    return 'commentary';
  }
  return 'diagnostic';
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
      mergeByFingerprint([...toLogs, ...fromLogs], transcriptFingerprint, SESSION_LOG_ENTRY_LIMIT)
    );
    state.sessionLogs.delete(fromKey);
    scheduleSessionLogsSave();
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
      ...(fromRuntime || {}),
      ...(toRuntime || {}),
      updatedAt: nowIso(),
    });
    state.sessionRuntime.delete(fromKey);
  }

  const fromEchoes = state.pendingUserTranscriptEchoes.get(fromKey) || [];
  const toEchoes = state.pendingUserTranscriptEchoes.get(toKey) || [];
  if (fromEchoes.length || toEchoes.length) {
    const mergedEchoes = new Map();
    for (const record of [...toEchoes, ...fromEchoes]) {
      const identity = record.clientRequestId
        || `${record.fullCanonical || ''}|${record.displayCanonical || ''}`;
      const previous = mergedEchoes.get(identity);
      if (!previous) {
        mergedEchoes.set(identity, { ...record });
        continue;
      }
      mergedEchoes.set(identity, {
        ...(Number(previous.createdAt || 0) > Number(record.createdAt || 0) ? record : previous),
        ...(Number(previous.createdAt || 0) > Number(record.createdAt || 0) ? previous : record),
        status: previous.status === 'rejected' || record.status === 'rejected'
          ? 'rejected'
          : record.status || previous.status || 'pending',
        createdAt: Math.max(Number(previous.createdAt || 0), Number(record.createdAt || 0)),
      });
    }
    state.pendingUserTranscriptEchoes.set(
      toKey,
      Array.from(mergedEchoes.values())
        .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
        .slice(-PENDING_USER_TRANSCRIPT_ECHO_LIMIT)
    );
    state.pendingUserTranscriptEchoes.delete(fromKey);
  }

  const fromDiagnostics = state.sessionDiagnostics.get(fromKey) || [];
  const toDiagnostics = state.sessionDiagnostics.get(toKey) || [];
  if (fromDiagnostics.length || toDiagnostics.length) {
    state.sessionDiagnostics.set(
      toKey,
      mergeByFingerprint(
        [...toDiagnostics, ...fromDiagnostics],
        (entry) => `${entry.timestamp || ''}|${entry.kind || ''}|${entry.method || ''}|${entry.message || ''}|${entry.detail || ''}`,
        SESSION_DIAGNOSTIC_ENTRY_LIMIT
      )
    );
    state.sessionDiagnostics.delete(fromKey);
    scheduleSessionDiagnosticsSave();
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

  const effectiveFromSessionId = resolveSessionId(hostId, fromSessionId);
  const fromKey = resolveSessionKey(hostId, fromSessionId);
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
  rememberSessionAlias(hostId, fromSessionId, toSessionId);
  if (effectiveFromSessionId !== fromSessionId) {
    rememberSessionAlias(hostId, effectiveFromSessionId, toSessionId);
  }
  moveSessionArtifacts(hostId, effectiveFromSessionId, toSessionId);
  if (effectiveFromSessionId !== fromSessionId) {
    moveSessionArtifacts(hostId, fromSessionId, toSessionId);
  }
  const identities = getSessionTitleIdentities(fromSession || toSession, {
    ...patch,
    sessionId: toSessionId,
    bridgeSessionId: fromSessionId,
    nativeThreadId: patch.nativeThreadId || toSessionId,
  });
  const title = resolveSessionTitle(hostId, fromSession || toSession, {
    ...patch,
    sessionId: toSessionId,
    bridgeSessionId: fromSessionId,
    nativeThreadId: patch.nativeThreadId || toSessionId,
  });
  next.title = title || next.title;
  state.sessions.set(toKey, next);
  rememberSessionIdentityAliases(hostId, next);
  rememberSessionTitle(hostId, identities, title, {
    cwd: patch.cwd || fromSession?.cwd || toSession?.cwd || '',
    source: patch.source || fromSession?.source || toSession?.source || 'migration',
  });
  migrateSessionCollectionItems(hostId, effectiveFromSessionId, toSessionId, patch);
  if (effectiveFromSessionId !== fromSessionId) {
    migrateSessionCollectionItems(hostId, fromSessionId, toSessionId, patch);
  }
  return next;
}

function persistConnectors() {
  saveConnectors(Array.from(state.connectors.values()), CONNECTORS_PATH);
}

function persistConnectorSecrets() {
  saveConnectorSecrets(state.connectorSecrets, CONNECTOR_SECRETS_PATH);
}

function persistSessionCollections() {
  saveSessionCollections(Array.from(state.sessionCollections.values()));
}

function getSessionTitleIdentities(existing, patch = {}) {
  const values = [
    patch.sessionId,
    patch.conversationKey,
    patch.originSessionId,
    patch.sourceSessionId,
    patch.bridgeSessionId,
    patch.nativeThreadId,
    existing?.sessionId,
    existing?.conversationKey,
    existing?.originSessionId,
    existing?.sourceSessionId,
    existing?.bridgeSessionId,
    existing?.nativeThreadId,
  ];
  return Array.from(new Set(values
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)));
}

function findSessionMetadataTitle(hostId, identities = []) {
  const entry = findSessionMetadataEntry(hostId, identities);
  return entry?.title || '';
}

function findSessionMetadataEntry(hostId, identities = []) {
  for (const identity of identities) {
    const record = state.provenance?.getSessionRecord({ hostId, sessionId: identity });
    if (record?.title && isMeaningfulSessionTitle(record.title, identities)) {
      return {
        hostId,
        identity,
        title: record.title,
        cwd: record.cwd || '',
        source: record.source || 'metadata',
        updatedAt: record.updatedAt || null,
      };
    }
    const entry = state.sessionMetadata.get(sessionMetadataKey(hostId, identity));
    if (entry?.title && isMeaningfulSessionTitle(entry.title, identities)) {
      return entry;
    }
  }
  return null;
}

function rememberSessionTitle(hostId, identities = [], title, options = {}) {
  const normalizedTitle = normalizeSessionTitle(title);
  const source = String(options.source || 'metadata').trim() || 'metadata';
  const uniqueIdentities = Array.from(new Set((identities || [])
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)));
  if (!hostId || !uniqueIdentities.length || !isMeaningfulSessionTitle(normalizedTitle, uniqueIdentities)) {
    return false;
  }

  let changed = false;
  for (const identity of uniqueIdentities) {
    const key = sessionMetadataKey(hostId, identity);
    const existing = state.sessionMetadata.get(key);
    if (!shouldOverwriteSessionMetadata(existing, source)) {
      continue;
    }
    if (existing?.title === normalizedTitle && existing?.cwd === (options.cwd || existing.cwd || '')) {
      continue;
    }
    state.sessionMetadata.set(key, {
      hostId,
      identity,
      title: normalizedTitle,
      cwd: String(options.cwd || existing?.cwd || '').trim(),
      source,
      updatedAt: nowIso(),
    });
    changed = true;
  }
  if (changed && options.persist !== false) {
    saveSessionMetadata();
  }
  return changed;
}

function persistSessionPresentation(hostId, session, options = {}) {
  if (!state.sessionRecordStore || !session?.sessionId) {
    return Promise.resolve(null);
  }
  return state.sessionRecordStore.transact('session.presentation.updated', (tx) => {
    const concreteIdentity = {
      hostId,
      sessionId: session.sessionId,
      bridgeSessionId: session.bridgeSessionId || null,
      nativeThreadId: session.nativeThreadId || null,
    };
    const canonicalKey = tx.resolveCanonicalKey(concreteIdentity);
    const record = tx.ensureRecord(canonicalKey, {
      hostId,
      conversationKey: session.conversationKey || session.sessionId,
      source: session.source || options.source || 'metadata',
    });
    record.title = normalizeSessionTitle(session.title || record.title || '');
    record.cwd = String(session.cwd || record.cwd || '').trim() || null;
    record.bridgeSessionId ||= session.bridgeSessionId || null;
    record.nativeThreadId ||= session.nativeThreadId || null;
    record.originSessionId ||= session.originSessionId || null;
    record.sourceSessionId ||= session.sourceSessionId || null;
    if (!record.source || record.source === 'metadata') {
      record.source = session.source || options.source || record.source || 'metadata';
    }
    record.updatedAt = nowIso();
    for (const value of [
      session.sessionId,
      record.bridgeSessionId,
      record.nativeThreadId,
    ].filter(Boolean)) {
      tx.setAlias(`${hostId}::${value}`, canonicalKey);
    }
    if (record.conversationKey) {
      const conversationAlias = `${hostId}::${record.conversationKey}`;
      const existingTarget = tx.aliasTarget(conversationAlias);
      if (!existingTarget || existingTarget === canonicalKey) {
        tx.setAlias(conversationAlias, canonicalKey);
      }
    }
    tx.appendDomainEvent({
      type: 'session.presentation.updated',
      canonicalKey,
      source: options.source || session.titleSource || session.source || null,
    });
    tx.markDirty(canonicalKey);
    return structuredClone(record);
  });
}

function resolveSessionTitle(hostId, existing, patch = {}) {
  const identities = getSessionTitleIdentities(existing, patch);
  const explicitTitle = normalizeSessionTitle(patch.title || '');
  const patchSource = String(patch.source || existing?.source || 'session').trim() || 'session';
  const existingManualTitle = normalizeSessionTitle(existing?.title || '');
  if (
    existing?.manualTitle
    && patch.titleSource !== 'manual'
    && patchSource !== 'manual'
    && isMeaningfulSessionTitle(existingManualTitle, identities)
  ) {
    return existingManualTitle;
  }
  const storedEntry = findSessionMetadataEntry(hostId, identities);
  if (
    storedEntry?.title
    && sessionTitleSourcePriority(storedEntry.source) > sessionTitleSourcePriority(patchSource)
    && !(patchSource === 'manual' && isMeaningfulSessionTitle(explicitTitle, identities))
  ) {
    return storedEntry.title;
  }

  if (isMeaningfulSessionTitle(explicitTitle, identities)) {
    rememberSessionTitle(hostId, identities, explicitTitle, {
      cwd: patch.cwd || existing?.cwd || '',
      source: patchSource,
    });
    const nextStoredEntry = findSessionMetadataEntry(hostId, identities);
    if (
      nextStoredEntry?.title
      && sessionTitleSourcePriority(nextStoredEntry.source) > sessionTitleSourcePriority(patchSource)
    ) {
      return nextStoredEntry.title;
    }
    return explicitTitle;
  }

  if (storedEntry?.title) {
    return storedEntry.title;
  }

  const existingTitle = normalizeSessionTitle(existing?.title || '');
  if (isMeaningfulSessionTitle(existingTitle, identities)) {
    rememberSessionTitle(hostId, identities, existingTitle, {
      cwd: patch.cwd || existing?.cwd || '',
      source: existing?.source || patch.source || 'session',
    });
    const nextStoredEntry = findSessionMetadataEntry(hostId, identities);
    if (nextStoredEntry?.title) {
      return nextStoredEntry.title;
    }
    return existingTitle;
  }

  return explicitTitle || existingTitle || patch.sessionId || existing?.sessionId || '';
}

function updateSessionCollectionTitles(hostId, identities = [], title) {
  const normalizedTitle = normalizeSessionTitle(title);
  const identitySet = new Set((identities || [])
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean));
  if (!hostId || !identitySet.size || !normalizedTitle) {
    return false;
  }

  let changed = false;
  for (const collection of state.sessionCollections.values()) {
    if (!collection || !Array.isArray(collection.items)) {
      continue;
    }
    let collectionChanged = false;
    for (const item of collection.items) {
      if (item.hostId !== hostId) {
        continue;
      }
      if (!identitySet.has(item.sessionId) && !identitySet.has(item.conversationKey)) {
        continue;
      }
      if (item.title === normalizedTitle) {
        continue;
      }
      item.title = normalizedTitle;
      item.updatedAt = nowIso();
      collectionChanged = true;
    }
    if (collectionChanged) {
      collection.updatedAt = nowIso();
      changed = true;
    }
  }
  if (changed) {
    persistSessionCollections();
  }
  return changed;
}

function updateSessionTitle(hostId, sessionId, title, options = {}) {
  const session = getSession(hostId, sessionId);
  const normalizedTitle = normalizeSessionTitle(title);
  if (!session || !normalizedTitle) {
    return null;
  }

  const identities = getSessionTitleIdentities(session, {
    sessionId,
    title: normalizedTitle,
  });
  const next = {
    ...session,
    title: normalizedTitle,
    manualTitle: true,
    titleSource: 'manual',
    lastUpdatedAt: options.touch === false ? session.lastUpdatedAt : nowIso(),
  };
  state.sessions.set(sessionKey(hostId, sessionId), next);
  rememberSessionTitle(hostId, identities, normalizedTitle, {
    cwd: session.cwd || '',
    source: options.source || 'manual',
  });
  updateSessionCollectionTitles(hostId, identities, normalizedTitle);
  return next;
}

function refreshSessionMessageSummaries(hostId, sessionId, transcript = []) {
  const session = getSession(hostId, sessionId);
  if (!session) {
    return null;
  }
  const latestUser = [...transcript].reverse().find((entry) => (
    entry.speaker === 'user' && entry.text && entry.deliveryStatus !== 'pending'
  ));
  const latestAgent = [...transcript].reverse().find((entry) => (entry.speaker === 'agent' || entry.speaker === 'assistant') && entry.text);
  const latestUserMessage = latestUser?.text || null;
  const latestAgentMessage = latestAgent?.text || null;
  const messageCount = Array.isArray(transcript) ? transcript.length : Number(session.messageCount || 0);
  if (
    session.latestUserMessage === latestUserMessage
    && session.latestAgentMessage === latestAgentMessage
    && Number(session.messageCount || 0) === messageCount
  ) {
    return session;
  }

  const next = {
    ...session,
    latestUserMessage,
    latestAgentMessage,
    messageCount,
  };
  state.sessions.set(sessionKey(hostId, sessionId), next);
  return next;
}

function maybeInferAndPersistSessionTitle(hostId, sessionId, transcript = []) {
  const session = getSession(hostId, sessionId);
  if (!session) {
    return null;
  }
  const identities = getSessionTitleIdentities(session, { sessionId });
  if (isMeaningfulSessionTitle(session.title, identities)) {
    return session;
  }

  const inferredTitle = inferSessionTitleFromTranscript(session, transcript);
  if (!inferredTitle || !isMeaningfulSessionTitle(inferredTitle, identities)) {
    return session;
  }

  const updated = updateSessionTitle(hostId, sessionId, inferredTitle, {
    source: 'inferred',
    touch: false,
  }) || session;
  persistSessionPresentation(hostId, updated, { source: 'inferred' }).catch((error) => {
    console.error(`[relay] failed to persist inferred Session title: ${error.message || error}`);
  });
  return updated;
}

function inferSessionTitleFromTranscript(session, transcript = []) {
  const candidates = [];
  for (const entry of Array.isArray(transcript) ? transcript : []) {
    if (!entry || entry.speaker !== 'user' || entry.deliveryStatus === 'pending') {
      continue;
    }
    const text = cleanStoredTranscriptText(entry.text || '', 'user');
    if (text && !isWeakTitleSource(text)) {
      candidates.push(text);
    }
  }

  const latestUser = cleanStoredTranscriptText(session?.latestUserMessage || '', 'user');
  if (latestUser && !isWeakTitleSource(latestUser)) {
    candidates.push(latestUser);
  }

  for (const candidate of candidates) {
    const title = summarizeSessionTitle(candidate);
    if (title && !isWeakTitleSource(title)) {
      return title;
    }
  }

  if (isInternalApprovalReviewSession(session)) {
    return 'Approval review';
  }

  const cwdLeaf = path.basename(String(session?.cwd || '').replace(/[\\/]+$/, ''));
  return normalizeSessionTitle(cwdLeaf || '');
}

function isWeakTitleSource(value) {
  const text = canonicalTranscriptText(value).toLowerCase();
  return !text
    || text.length < 3
    || ['ok', 'okay', 'yes', 'no', 'continue', 'please continue'].includes(text)
    || /^(ok|okay|thanks?|thank you)[.!?]*$/i.test(text)
    || /^(please\s+)?continue[.!?]*$/i.test(text);
}

function summarizeSessionTitle(value) {
  let text = cleanStoredTranscriptText(value, 'user')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_\[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return '';
  }

  const firstSentence = text.split(/[.!?\u3002\uff01\uff1f\n]/)[0]?.trim();
  if (firstSentence && firstSentence.length >= 4) {
    text = firstSentence;
  }
  const firstClause = text.split(/[,;\u3001\uff0c\uff1b]/)[0]?.trim();
  if (firstClause && firstClause.length >= 4 && firstClause.length <= 36) {
    text = firstClause;
  }

  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  if (hasCjk) {
    return normalizeSessionTitle(text.slice(0, 24).replace(/[.?!,;:\u3002\uff01\uff1f\u3001\uff0c\uff1b\uff1a]+$/g, ''));
  }

  const words = text.split(/\s+/).filter(Boolean);
  return normalizeSessionTitle(words.slice(0, 8).join(' ').replace(/[.?!,;:]+$/g, ''));
}

function seedSessionMetadataFromCollections() {
  let changed = false;
  for (const collection of state.sessionCollections.values()) {
    if (!collection || collection.collectionId === DEFAULT_COLLECTION_ID || !Array.isArray(collection.items)) {
      continue;
    }
    for (const item of collection.items) {
      changed = rememberSessionTitle(
        item.hostId,
        [item.conversationKey, item.sessionId],
        item.title,
        {
          cwd: item.cwd || '',
          source: `collection:${collection.collectionId}`,
          persist: false,
        }
      ) || changed;
    }
  }
  if (changed) {
    saveSessionMetadata();
  }
}

function migrateSessionCollectionItems(hostId, fromSessionId, toSessionId, patch = {}) {
  const from = String(fromSessionId || '');
  const to = String(toSessionId || '');
  if (!hostId || !from || !to || from === to) {
    return false;
  }

  const nextConversationKey = patch.conversationKey && patch.conversationKey !== from
    ? String(patch.conversationKey)
    : to;
  let changed = false;
  for (const collection of state.sessionCollections.values()) {
    if (!collection || collection.collectionId === DEFAULT_COLLECTION_ID || !Array.isArray(collection.items)) {
      continue;
    }

    let collectionChanged = false;
    const nextItems = [];
    for (const item of collection.items) {
      const shouldMigrate = item?.hostId === hostId
        && (item.sessionId === from || item.conversationKey === from);
      if (!shouldMigrate) {
        nextItems.push(item);
        continue;
      }

      changed = true;
      collectionChanged = true;
      rememberSessionTitle(hostId, [from, to, item.conversationKey, item.sessionId], item.title, {
        cwd: item.cwd || patch.cwd || '',
        source: `collection:${collection.collectionId}`,
      });
      nextItems.push({
        ...item,
        conversationKey: item.conversationKey === from ? nextConversationKey : item.conversationKey,
        sessionId: item.sessionId === from || !item.sessionId ? to : item.sessionId,
        updatedAt: nowIso(),
      });
    }

    if (!collectionChanged) {
      continue;
    }

    state.sessionCollections.set(collection.collectionId, {
      ...collection,
      items: dedupeCollectionItems(nextItems),
      updatedAt: nowIso(),
    });
  }

  if (changed) {
    persistSessionCollections();
  }
  return changed;
}

function getSessionCollectionList() {
  ensureTrashCollection();
  return Array.from(state.sessionCollections.values())
    .map((collection) => {
      if (collection.collectionId === DEFAULT_COLLECTION_ID) {
        return {
          ...collection,
          itemCount: Array.from(state.sessions.values())
            .filter((session) => !isCollectionItemHiddenFromCollections(session))
            .length,
        };
      }
      const items = collection.collectionId === TRASH_COLLECTION_ID
        ? dedupeCollectionItems(collection.items)
        : dedupeCollectionItems(collection.items).filter((item) => !isCollectionItemHiddenFromCollections(item));
      if (items.length !== (collection.items || []).length) {
        state.sessionCollections.set(collection.collectionId, {
          ...collection,
          items,
          updatedAt: nowIso(),
        });
        persistSessionCollections();
      }
      return {
        ...collection,
        items,
        itemCount: items.length,
      };
    })
    .sort((a, b) => {
      if (a.collectionId === DEFAULT_COLLECTION_ID) {
        return -1;
      }
      if (b.collectionId === DEFAULT_COLLECTION_ID) {
        return 1;
      }
      if (a.collectionId === TRASH_COLLECTION_ID) {
        return 1;
      }
      if (b.collectionId === TRASH_COLLECTION_ID) {
        return -1;
      }
      return String(a.name).localeCompare(String(b.name));
    });
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

function buildConnectorActionSecret(connectorId, body) {
  const input = body?.secrets || {};
  const askpass = body?.askpass || {};
  const existing = state.connectorSecrets.get(connectorId) || null;
  const gatewayPassword = typeof input.gatewayPassword === 'string' ? input.gatewayPassword : '';
  const targetPassword = typeof input.targetPassword === 'string' ? input.targetPassword : '';
  const gatewayOtp = typeof input.gatewayOtp === 'string' ? input.gatewayOtp.trim() : '';
  const targetOtp = typeof input.targetOtp === 'string' ? input.targetOtp.trim() : '';
  const askpassActionId = String(askpass.actionId || body?.askpassActionId || '').trim();
  const askpassToken = String(askpass.token || body?.askpassToken || '').trim();

  return {
    connectorId,
    gatewayPassword: gatewayPassword || existing?.gatewayPassword || '',
    targetPassword: targetPassword || existing?.targetPassword || '',
    gatewayOtp,
    targetOtp,
    askpassActionId,
    askpassToken,
    interactiveAskpass: Boolean(askpassActionId && askpassToken),
  };
}

function askpassActionKey(connectorId, actionId) {
  return `${connectorId}::${actionId}`;
}

function registerAskpassAction(connectorId, action, secret) {
  if (!secret?.interactiveAskpass) {
    return null;
  }

  const record = {
    connectorId,
    action,
    actionId: secret.askpassActionId,
    token: secret.askpassToken,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    closed: false,
    cancelled: false,
    maxPrompts: ASKPASS_MAX_PROMPTS_PER_ACTION,
    prompts: new Map(),
  };
  state.askpassActions.set(askpassActionKey(connectorId, secret.askpassActionId), record);
  return record;
}

function getAskpassAction(connectorId, actionId, token) {
  const record = state.askpassActions.get(askpassActionKey(connectorId, actionId));
  if (!record || record.token !== token) {
    return null;
  }
  return record;
}

function closeAskpassAction(record) {
  if (!record) {
    return;
  }
  record.closed = true;
  record.updatedAt = nowIso();
  for (const prompt of record.prompts.values()) {
    if (!prompt.responseReady) {
      prompt.cancelled = true;
      prompt.updatedAt = nowIso();
    }
  }
  setTimeout(() => {
    state.askpassActions.delete(askpassActionKey(record.connectorId, record.actionId));
  }, 60_000).unref?.();
}

function cancelAskpassAction(record) {
  if (!record) {
    return;
  }
  record.cancelled = true;
  closeAskpassAction(record);
}

function createAskpassPrompt({ connectorId, actionId, token, prompt }) {
  const record = getAskpassAction(connectorId, actionId, token);
  if (!record || record.closed || record.cancelled) {
    return null;
  }
  if (record.prompts.size >= record.maxPrompts) {
    cancelAskpassAction(record);
    return null;
  }

  const promptId = makeId();
  const entry = {
    promptId,
    connectorId,
    actionId,
    prompt: String(prompt || 'SSH authentication prompt').trim() || 'SSH authentication prompt',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    responseReady: false,
    response: '',
    cancelled: false,
  };
  record.prompts.set(promptId, entry);
  record.updatedAt = nowIso();
  return entry;
}

function getAskpassPrompt(record, promptId) {
  return record?.prompts?.get(promptId) || null;
}

function publicAskpassPrompt(prompt) {
  return {
    promptId: prompt.promptId,
    connectorId: prompt.connectorId,
    actionId: prompt.actionId,
    prompt: prompt.prompt,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
    status: prompt.cancelled ? 'cancelled' : prompt.responseReady ? 'answered' : 'pending',
  };
}

function getConnectorHost(connector) {
  if (!connector?.hostId) {
    return null;
  }
  const host = state.hosts.get(connector.hostId) || null;
  return host ? { ...host, online: hostOnline(host) } : null;
}

function connectorWithRelayAuth(connector) {
  if (!RELAY_AUTH_TOKEN) {
    return connector;
  }
  return {
    ...connector,
    relayAuthToken: RELAY_AUTH_TOKEN,
  };
}

function decorateConnectorForClient(connector, host = null) {
  const decorated = decorateConnector(connectorWithRelayAuth(connector), host);
  delete decorated.relayAuthToken;
  return decorated;
}

function decorateSingleConnector(connector) {
  const secret = state.connectorSecrets.get(connector.connectorId) || null;
  return {
    ...decorateConnectorForClient(connector, getConnectorHost(connector)),
    secretStatus: getConnectorSecretStatus(secret),
  };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || host.startsWith('127.');
}

function safeRelayOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || isLoopbackHost(url.hostname)) {
      return '';
    }
    return url.origin;
  } catch (_) {
    return '';
  }
}

function localRelayOrigin() {
  const candidates = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal || !entry.address) {
        continue;
      }
      candidates.push(entry.address);
    }
  }

  const preferred = candidates.find((address) => /^10\./.test(address))
    || candidates.find((address) => /^172\.(1[6-9]|2\d|3[0-1])\./.test(address))
    || candidates.find((address) => /^192\.168\./.test(address))
    || candidates[0];

  return preferred ? `http://${preferred}:${PORT}` : '';
}

function connectorWithActionRelayOrigin(connector, actionOrigin) {
  const origin = safeRelayOrigin(actionOrigin) || localRelayOrigin();
  if (!origin) {
    return connector;
  }

  try {
    const relayUrl = new URL(String(connector.relayUrl || ''));
    if (!connector.relayUrl || isLoopbackHost(relayUrl.hostname)) {
      return {
        ...connector,
        relayUrl: origin,
      };
    }
  } catch (_) {
    return {
      ...connector,
      relayUrl: origin,
    };
  }

  return connector;
}

function getConnectorList() {
  const hosts = new Map(getHostList().map((host) => [host.hostId, host]));
  return Array.from(state.connectors.values())
    .map((connector) => ({
      ...decorateConnectorForClient(connector, connector.hostId ? hosts.get(connector.hostId) || null : null),
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
  const input = options.input || null;

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
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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

    if (input && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
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

function connectorOneTimeMethod(method) {
  return method === 'otp' || method === 'manual_captcha';
}

function connectorMethodCanUseAskpass(method) {
  return connectorPasswordMethod(method) || connectorOneTimeMethod(method);
}

function connectorMethodCovered(method, password, oneTimeCode, interactiveAskpass = false) {
  if (!requiresInteractiveAuth(method)) {
    return true;
  }
  if (interactiveAskpass && connectorMethodCanUseAskpass(method)) {
    return true;
  }
  if (method === 'browser_sso') {
    return false;
  }
  if (method === 'password') {
    return Boolean(password);
  }
  if (method === 'keyboard_interactive') {
    return Boolean(password || oneTimeCode);
  }
  if (connectorOneTimeMethod(method)) {
    return Boolean(oneTimeCode);
  }
  return false;
}

function connectorAskpassResponsesForMethod(method, password, oneTimeCode) {
  const responses = [];
  if ((method === 'password' || method === 'keyboard_interactive') && password) {
    responses.push(password);
  }
  if (
    (method === 'password'
      || method === 'keyboard_interactive'
      || connectorOneTimeMethod(method))
    && oneTimeCode
  ) {
    responses.push(oneTimeCode);
  }
  return responses;
}

function connectorAskpassResponses(connector, secret) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  const responses = [];

  if (connectorUsesGateway(connector) && connectorMethodCanUseAskpass(gatewayMethod)) {
    responses.push(...connectorAskpassResponsesForMethod(
      gatewayMethod,
      secret?.gatewayPassword || '',
      secret?.gatewayOtp || ''
    ));
  }

  if (connectorMethodCanUseAskpass(targetMethod)) {
    responses.push(...connectorAskpassResponsesForMethod(
      targetMethod,
      secret?.targetPassword || '',
      secret?.targetOtp || ''
    ));
  }

  return responses.filter(Boolean);
}

function connectorHasAskpassPromptableAuth(connector) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  return Boolean(
    (connectorUsesGateway(connector) && connectorMethodCanUseAskpass(gatewayMethod))
    || connectorMethodCanUseAskpass(targetMethod)
  );
}

function connectorPrefersKeyboardInteractive(connector) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  return [
    connectorUsesGateway(connector) ? gatewayMethod : '',
    targetMethod,
  ].some((method) => ['keyboard_interactive', 'otp', 'manual_captcha'].includes(method));
}

function connectorPreferredAuthentications(connector, secret) {
  if (!connectorUsesAskpass(connector, secret)) {
    return undefined;
  }
  return connectorPrefersKeyboardInteractive(connector)
    ? 'publickey,keyboard-interactive,password'
    : 'publickey,password,keyboard-interactive';
}

function connectorNeedsManualAuth(connector, secret) {
  const gatewayMethod = connector.gateway?.authMethod || 'ssh_key';
  const targetMethod = connector.auth?.method || 'ssh_key';
  const gatewayNeedsSecret = connectorUsesGateway(connector) && requiresInteractiveAuth(gatewayMethod);
  const targetNeedsSecret = requiresInteractiveAuth(targetMethod);
  const gatewayCovered = connectorMethodCovered(
    gatewayMethod,
    secret?.gatewayPassword || '',
    secret?.gatewayOtp || '',
    Boolean(secret?.interactiveAskpass)
  );
  const targetCovered = connectorMethodCovered(
    targetMethod,
    secret?.targetPassword || '',
    secret?.targetOtp || '',
    Boolean(secret?.interactiveAskpass)
  );

  return (gatewayNeedsSecret && !gatewayCovered)
    || (targetNeedsSecret && !targetCovered);
}

function connectorUsesAskpass(connector, secret) {
  return connectorAskpassResponses(connector, secret).length > 0
    || (Boolean(secret?.interactiveAskpass) && connectorHasAskpassPromptableAuth(connector));
}

function ensureAskpassHelper() {
  const helperPath = path.join(RELAY_STATE_ROOT, 'remote-codex-askpass.cmd');
  const helperScriptPath = path.join(RELAY_STATE_ROOT, 'remote-codex-askpass.ps1');
  const psScript = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$promptText = [string]$env:RC_ASKPASS_PROMPT',
    'function Decode-B64([string]$value) {',
    '  if ([string]::IsNullOrWhiteSpace($value)) { return "" }',
    '  try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) } catch { return "" }',
    '}',
    'function Encode-Query([string]$value) {',
    '  return [uri]::EscapeDataString($value)',
    '}',
    'function Try-BrokerPrompt {',
    '  if ([string]::IsNullOrWhiteSpace($env:RC_ASKPASS_RELAY_URL) -or [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_CONNECTOR_ID) -or [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_ACTION_ID) -or [string]::IsNullOrWhiteSpace($env:RC_ASKPASS_TOKEN)) { return $null }',
    '  $timeoutSeconds = 180',
    '  if ($env:RC_ASKPASS_TIMEOUT_SECONDS) { try { $timeoutSeconds = [Math]::Max(10, [int]$env:RC_ASKPASS_TIMEOUT_SECONDS) } catch {} }',
    '  $base = [string]$env:RC_ASKPASS_RELAY_URL',
    '  $headers = @{}',
    '  if (-not [string]::IsNullOrWhiteSpace($env:RC_RELAY_AUTH_TOKEN)) { $headers["Authorization"] = "Bearer $env:RC_RELAY_AUTH_TOKEN" }',
    '  $body = @{ connectorId = [string]$env:RC_ASKPASS_CONNECTOR_ID; actionId = [string]$env:RC_ASKPASS_ACTION_ID; token = [string]$env:RC_ASKPASS_TOKEN; prompt = $promptText } | ConvertTo-Json -Compress',
    '  try { $created = Invoke-RestMethod -Method Post -Uri "$base/api/askpass/prompts" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 8 } catch { exit 1 }',
    '  if (-not $created -or [string]::IsNullOrWhiteSpace([string]$created.promptId)) { exit 1 }',
    '  $promptId = [string]$created.promptId',
    '  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)',
    '  $query = "connectorId=$(Encode-Query $env:RC_ASKPASS_CONNECTOR_ID)&actionId=$(Encode-Query $env:RC_ASKPASS_ACTION_ID)&token=$(Encode-Query $env:RC_ASKPASS_TOKEN)"',
    '  while ([DateTime]::UtcNow -lt $deadline) {',
    '    try { $status = Invoke-RestMethod -Method Get -Uri "$base/api/askpass/prompts/$promptId`?$query" -Headers $headers -TimeoutSec 8 } catch { Start-Sleep -Milliseconds 700; continue }',
    '    if ($status.status -eq "answered") { [Console]::Out.Write([string]$status.response); exit 0 }',
    '    if ($status.status -eq "cancelled" -or $status.status -eq "closed") { exit 1 }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '  exit 1',
    '}',
    '$index = 1',
    'if ($env:RC_ASKPASS_STATE_FILE -and (Test-Path -LiteralPath $env:RC_ASKPASS_STATE_FILE)) { try { $index = [int](Get-Content -LiteralPath $env:RC_ASKPASS_STATE_FILE -TotalCount 1) } catch { $index = 1 } }',
    'if ($index -lt 1) { $index = 1 }',
    '$nextIndex = $index + 1',
    'if ($env:RC_ASKPASS_STATE_FILE) { try { Set-Content -LiteralPath $env:RC_ASKPASS_STATE_FILE -Value ([string]$nextIndex) -NoNewline } catch {} }',
    '$b64 = [Environment]::GetEnvironmentVariable("RC_ASKPASS_PASSWORD_${index}_B64")',
    'if ([string]::IsNullOrWhiteSpace($b64)) { $b64 = $env:RC_ASKPASS_PASSWORD_LAST_B64 }',
    'if ([string]::IsNullOrWhiteSpace($b64)) { $b64 = $env:RC_ASKPASS_PASSWORD_1_B64 }',
    'if ($env:RC_ASKPASS_OTP_B64 -and $promptText -match "(?i)(otp|mfa|verification|authenticator|passcode|one[- _]?time|2fa|two[- _]?factor|totp|google|duo|challenge|token|code)") {',
    '  $b64 = $env:RC_ASKPASS_OTP_B64',
    '} elseif ($env:RC_ASKPASS_PASSWORD_PROMPT_B64 -and $promptText -match "(?i)password") {',
    '  $b64 = $env:RC_ASKPASS_PASSWORD_PROMPT_B64',
    '}',
    '$answer = Decode-B64 $b64',
    'if (-not [string]::IsNullOrWhiteSpace($answer)) { [Console]::Out.Write($answer); exit 0 }',
    'Try-BrokerPrompt | Out-Null',
    'exit 1',
  ].join('\r\n');
  const script = [
    '@echo off',
    'setlocal EnableExtensions',
    'set "RC_ASKPASS_PROMPT=%*"',
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${helperScriptPath.replace(/"/g, '""')}"`,
  ].join('\r\n');
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(helperScriptPath, psScript, 'utf8');
  fs.writeFileSync(helperPath, script, 'utf8');
  return helperPath;
}

function base64Secret(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function buildAskpassEnv(connector, secret) {
  const responses = connectorAskpassResponses(connector, secret);
  const passwordResponses = [
    secret?.gatewayPassword || '',
    secret?.targetPassword || '',
  ].filter(Boolean);
  const otpResponses = [
    secret?.gatewayOtp || '',
    secret?.targetOtp || '',
  ].filter(Boolean);
  const firstResponse = responses[0] || '';
  const lastResponse = responses[responses.length - 1] || firstResponse;
  const statePath = path.join(RELAY_STATE_ROOT, `askpass-state-${connector.connectorId || makeId()}.txt`);

  try {
    fs.rmSync(statePath, { force: true });
  } catch (_) {
    // Best effort. A stale state file only changes which response is tried first.
  }

  const env = {
    SSH_ASKPASS: ensureAskpassHelper(),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || 'remote-codex',
    RC_ASKPASS_STATE_FILE: statePath,
    RC_ASKPASS_PASSWORD_1_B64: base64Secret(firstResponse),
    RC_ASKPASS_PASSWORD_LAST_B64: base64Secret(lastResponse),
    RC_ASKPASS_PASSWORD_PROMPT_B64: base64Secret(passwordResponses[0] || ''),
    RC_ASKPASS_OTP_B64: base64Secret(otpResponses[0] || ''),
  };

  if (secret?.interactiveAskpass) {
    env.RC_ASKPASS_RELAY_URL = `http://127.0.0.1:${PORT}`;
    env.RC_ASKPASS_CONNECTOR_ID = connector.connectorId || secret.connectorId || '';
    env.RC_ASKPASS_ACTION_ID = secret.askpassActionId || '';
    env.RC_ASKPASS_TOKEN = secret.askpassToken || '';
    env.RC_ASKPASS_TIMEOUT_SECONDS = '180';
    if (RELAY_AUTH_TOKEN) {
      env.RC_RELAY_AUTH_TOKEN = RELAY_AUTH_TOKEN;
    }
  }

  responses.slice(0, 8).forEach((response, index) => {
    env[`RC_ASKPASS_PASSWORD_${index + 1}_B64`] = base64Secret(response);
  });

  return env;
}

function remoteShellPath(value) {
  const text = String(value || '~/mobile-codex-remote').trim() || '~/mobile-codex-remote';
  if (text.startsWith('~/')) {
    return `"$HOME/${text.slice(2).replace(/"/g, '\\"')}"`;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function remoteScpPath(value) {
  return String(value || '~/mobile-codex-remote').trim() || '~/mobile-codex-remote';
}

function remoteScpChildPath(base, child) {
  return `${remoteScpPath(base).replace(/\/+$/, '')}/${String(child || '').replace(/^\/+/, '')}`;
}

function makeRemoteDeploymentDirectory(connector) {
  const base = normalizeConnectorRemoteDirectory(connector.bootstrap?.remoteDirectory);
  const id = `deploy-${Date.now()}-${makeId().slice(0, 8)}`.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return remoteScpChildPath(base, `.deployments/${id}`);
}

function connectorWithDeploymentBaseDirectory(connector) {
  return withConnectorRemoteDirectory(
    connector,
    normalizeConnectorRemoteDirectory(connector.bootstrap?.remoteDirectory)
  );
}

function withConnectorRemoteDirectory(connector, remoteDirectory) {
  return {
    ...connector,
    bootstrap: {
      ...(connector.bootstrap || {}),
      remoteDirectory,
    },
  };
}

function localScpPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function sshRunText(run) {
  return [
    run?.stdout,
    run?.stderr,
    run?.error,
    run?.message,
    run?.status,
  ].filter(Boolean).join('\n');
}

function buildScpCommandParts(connector, localSources, remoteDirectory, options = {}) {
  if (!connector.targetHost) {
    return null;
  }

  const args = ['-r'];
  if (options.connectTimeout) {
    args.push('-o', `ConnectTimeout=${options.connectTimeout}`);
  }
  if (options.strictHostKeyChecking) {
    args.push('-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`);
  }
  if (options.userKnownHostsFile) {
    args.push('-o', `UserKnownHostsFile=${options.userKnownHostsFile}`);
  }
  if (options.numberOfPasswordPrompts) {
    args.push('-o', `NumberOfPasswordPrompts=${Math.max(1, Number(options.numberOfPasswordPrompts) || 1)}`);
  }
  if (options.preferredAuthentications) {
    args.push('-o', `PreferredAuthentications=${options.preferredAuthentications}`);
  }
  if (options.controlMaster) {
    args.push('-o', `ControlMaster=${options.controlMaster}`);
  }
  if (options.controlPersist) {
    args.push('-o', `ControlPersist=${options.controlPersist}`);
  }
  if (options.controlPath) {
    args.push('-o', `ControlPath=${options.controlPath}`);
  }
  if (options.streamLocalBindUnlink) {
    args.push('-o', `StreamLocalBindUnlink=${options.streamLocalBindUnlink}`);
  }
  if (connector.auth?.keyPath) {
    args.push('-i', connector.auth.keyPath);
    args.push('-o', 'IdentitiesOnly=yes');
    args.push('-o', 'IdentityAgent=none');
  }

  const gateway = connector.gateway || {};
  const gatewayTarget = connectorUsesGateway(connector) && (gateway.proxyJump
    || (
      gateway.host
        ? `${gateway.username || connector.username ? `${gateway.username || connector.username}@` : ''}${gateway.host}${gateway.port ? `:${gateway.port}` : ''}`
        : ''
    ));

  if (gatewayTarget) {
    args.push('-o', `ProxyJump=${gatewayTarget}`);
  }
  if (connector.targetPort && Number(connector.targetPort) !== 22) {
    args.push('-P', String(connector.targetPort));
  }

  const target = `${connector.username ? `${connector.username}@` : ''}${connector.targetHost}`;
  args.push(...localSources, `${target}:${remoteScpPath(remoteDirectory).replace(/\/+$/, '')}/`);
  return {
    command: 'scp',
    args,
  };
}

function normalizeTarPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function writeTarString(buffer, offset, length, value) {
  const text = Buffer.from(String(value || ''), 'utf8');
  text.copy(buffer, offset, 0, Math.min(text.length, length));
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, '0').slice(-(length - 1));
  writeTarString(buffer, offset, length, `${text}\0`);
}

function splitTarName(name) {
  if (Buffer.byteLength(name) <= 100) {
    return { name, prefix: '' };
  }

  const parts = name.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const suffix = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`tar path is too long: ${name}`);
}

function createTarHeader(name, stats, size, typeFlag = '0') {
  const header = Buffer.alloc(512, 0);
  const splitName = splitTarName(name);
  writeTarString(header, 0, 100, splitName.name);
  writeTarOctal(header, 100, 8, stats?.mode ? stats.mode & 0o777 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor((stats?.mtimeMs || Date.now()) / 1000));
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, typeFlag);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  writeTarString(header, 345, 155, splitName.prefix);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function collectTarEntries(sourcePath, archivePath, entries) {
  const stats = fs.statSync(sourcePath);
  const normalizedArchivePath = normalizeTarPath(archivePath);
  if (!normalizedArchivePath) {
    return;
  }

  if (stats.isDirectory()) {
    entries.push({
      type: 'directory',
      sourcePath,
      archivePath: `${normalizedArchivePath.replace(/\/+$/, '')}/`,
      stats,
    });
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      collectTarEntries(
        path.join(sourcePath, entry.name),
        `${normalizedArchivePath}/${entry.name}`,
        entries
      );
    }
    return;
  }

  if (stats.isFile()) {
    entries.push({
      type: 'file',
      sourcePath,
      archivePath: normalizedArchivePath,
      stats,
    });
  }
}

function createTarArchive(localSources) {
  const tarSources = (localSources || []).map((source) => String(source || '').trim()).filter(Boolean);
  if (tarSources.length > 0) {
    const systemTar = spawnSync('tar', ['-cf', '-', ...tarSources], {
      cwd: process.cwd(),
      encoding: null,
      maxBuffer: 1024 * 1024 * 768,
      windowsHide: true,
    });
    if (systemTar.status === 0 && systemTar.stdout?.length) {
      return systemTar.stdout;
    }
  }

  const entries = [];
  for (const source of tarSources) {
    const sourceText = String(source || '');
    const sourcePath = path.resolve(process.cwd(), sourceText);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`local source does not exist: ${source}`);
    }
    const archivePath = path.isAbsolute(sourceText)
      ? path.basename(sourcePath)
      : normalizeTarPath(sourceText);
    collectTarEntries(sourcePath, archivePath || path.basename(sourcePath), entries);
  }

  const chunks = [];
  for (const entry of entries) {
    if (entry.type === 'directory') {
      chunks.push(createTarHeader(entry.archivePath, entry.stats, 0, '5'));
      continue;
    }
    const data = fs.readFileSync(entry.sourcePath);
    chunks.push(createTarHeader(entry.archivePath, entry.stats, data.length, '0'));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) {
      chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function buildRemoteTarExtractCommand(remoteDirectory, afterCommand = '') {
  const remoteDir = remoteShellPath(remoteDirectory);
  const commands = [
    `mkdir -p ${remoteDir}`,
    `cd ${remoteDir}`,
  ];
  commands.push('tar -xf -');
  if (afterCommand) {
    commands.push(afterCommand);
  }
  return commands.join(' && ');
}

async function runSshTarExtract(connector, secret, localSources, remoteDirectory, afterCommand, stepName, timeoutMs, sshOptions = {}) {
  const archive = createTarArchive(localSources);
  const commandParts = buildConnectorSshActionCommand(
    connector,
    buildRemoteTarExtractCommand(remoteDirectory, afterCommand),
    secret,
    'bootstrap',
    sshOptions
  );
  if (!commandParts) {
    return {
      ok: false,
      status: `${stepName || 'tar_extract'}_not_ready`,
      message: 'Connector does not have enough SSH information to upload files over SSH.',
      step: null,
    };
  }
  const run = await runProcess(commandParts.command, commandParts.args, {
    timeoutMs: authAwareTimeout(timeoutMs || 90_000, secret),
    env: connectorUsesAskpass(connector, secret) ? buildAskpassEnv(connector, secret) : null,
    input: archive,
  });
  return {
    ok: run.exitCode === 0,
    status: run.exitCode === 0 ? 'uploaded' : 'upload_failed',
    message: run.exitCode === 0 ? 'Files uploaded over a single SSH stream.' : 'Unable to upload files over SSH.',
    step: { name: stepName || 'ssh_tar_upload', ...run },
  };
}

function getLocalNodeRuntimeArchive(architecture = 'x64') {
  const runtime = linuxRuntimeNames(architecture);
  if (!runtime) return null;
  const archiveName = runtime.nodeArchiveName;
  const override = runtime.architecture === 'arm64'
    ? process.env.CODEX_NODE_ARM64_RUNTIME_ARCHIVE
    : process.env.CODEX_NODE_RUNTIME_ARCHIVE;
  const candidates = [
    override,
    path.join(process.cwd(), 'runtimes', 'node', archiveName),
    path.join(RELAY_STATE_ROOT, archiveName),
    path.join(LEGACY_RUNTIME_CACHE_ROOT, archiveName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const archivePath = path.resolve(candidate);
    if (!fs.existsSync(archivePath)) {
      continue;
    }
    return {
      archiveName: path.basename(archivePath),
      localPath: localScpPath(path.relative(process.cwd(), archivePath)),
    };
  }

  return null;
}

function copyDirectoryRecursive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function getLocalCodexLinuxSourceDir(architecture = 'x64') {
  const runtime = linuxRuntimeNames(architecture);
  if (!runtime) return null;
  const override = String(
    runtime.architecture === 'arm64'
      ? process.env.CODEX_LINUX_ARM64_RUNTIME_DIR || ''
      : process.env.CODEX_LINUX_RUNTIME_DIR || ''
  ).trim();
  if (override && fs.existsSync(path.join(override, 'codex'))) {
    return path.resolve(override);
  }

  const bundledRuntime = path.join(process.cwd(), 'runtimes', 'codex', runtime.bundledCodexDirectory);
  if (fs.existsSync(path.join(bundledRuntime, 'codex'))) {
    return bundledRuntime;
  }

  const legacyStagedRuntime = path.join(RELAY_STATE_ROOT, runtime.codexDirectoryName);
  if (fs.existsSync(path.join(legacyStagedRuntime, 'codex'))) {
    return legacyStagedRuntime;
  }

  const legacyWorkspaceRuntime = path.join(LEGACY_RUNTIME_CACHE_ROOT, runtime.codexDirectoryName);
  if (fs.existsSync(path.join(legacyWorkspaceRuntime, 'codex'))) {
    return legacyWorkspaceRuntime;
  }

  const cursorExtensions = path.join(os.homedir(), '.cursor', 'extensions');
  if (!fs.existsSync(cursorExtensions)) {
    return null;
  }

  const extensionDirs = fs.readdirSync(cursorExtensions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const entry of extensionDirs) {
    const binDir = path.join(cursorExtensions, entry, 'bin', runtime.cursorPlatformDirectory);
    if (fs.existsSync(path.join(binDir, 'codex'))) {
      return binDir;
    }
  }

  return null;
}

function stageLocalCodexLinuxRuntime(architecture = 'x64') {
  const runtime = linuxRuntimeNames(architecture);
  if (!runtime) return null;
  const sourceDir = getLocalCodexLinuxSourceDir(runtime.architecture);
  if (!sourceDir) {
    return null;
  }

  const sourceCodex = path.join(sourceDir, 'codex');
  const codexStat = fs.statSync(sourceCodex);
  const stageDir = path.join(RUNTIME_STAGE_ROOT, runtime.codexDirectoryName);
  const markerPath = path.join(stageDir, '.source.json');
  const marker = {
    sourceDir,
    codexSize: codexStat.size,
    codexMtimeMs: Math.trunc(codexStat.mtimeMs),
  };

  let staged = false;
  try {
    const current = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    staged = current.sourceDir === marker.sourceDir
      && current.codexSize === marker.codexSize
      && current.codexMtimeMs === marker.codexMtimeMs
      && fs.existsSync(path.join(stageDir, 'codex'));
  } catch {
    staged = false;
  }

  if (!staged) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    for (const name of ['codex', 'rg', 'codex-resources']) {
      const sourcePath = path.join(sourceDir, name);
      const targetPath = path.join(stageDir, name);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      const stats = fs.statSync(sourcePath);
      if (stats.isDirectory()) {
        copyDirectoryRecursive(sourcePath, targetPath);
      } else if (stats.isFile()) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  }

  const localSources = ['codex', 'rg', 'codex-resources']
    .map((name) => path.join(stageDir, name))
    .filter((sourcePath) => fs.existsSync(sourcePath))
    .map((sourcePath) => localScpPath(path.relative(process.cwd(), sourcePath)));

  return {
    sourceDir,
    stageDir,
    localSources,
    remoteRelativeDir: localScpPath(path.relative(process.cwd(), stageDir)),
  };
}

function buildSshActionOptions(connector, action, secret) {
  const useAskpass = connectorUsesAskpass(connector, secret);
  fs.mkdirSync(path.dirname(SSH_KNOWN_HOSTS_PATH), { recursive: true });
  const options = {
    connectTimeout: action === 'bootstrap' ? 12 : 8,
    disableTty: true,
    strictHostKeyChecking: 'accept-new',
    userKnownHostsFile: SSH_KNOWN_HOSTS_PATH,
  };

  if (useAskpass) {
    options.preferredAuthentications = connectorPreferredAuthentications(connector, secret);
    options.numberOfPasswordPrompts = 6;
  } else {
    options.batchMode = true;
  }

  return options;
}

function authAwareTimeout(baseMs, secret) {
  return secret?.interactiveAskpass ? Math.max(baseMs, 180_000) : baseMs;
}

function buildRemoteBootstrapProbeCommand() {
  return [
    'remote_arch="$(uname -m 2>/dev/null || true)"',
    'printf "CODEX_REMOTE_ARCH=%s\\n" "$remote_arch"',
    'if command -v node >/dev/null 2>&1 || command -v nodejs >/dev/null 2>&1; then echo CODEX_REMOTE_NODE_PRESENT; else echo CODEX_REMOTE_NODE_MISSING; fi',
  ].join('; ');
}

async function probeConnectorBootstrapRuntime(connector, secret) {
  const commandParts = buildConnectorSshActionCommand(
    connector,
    buildRemoteBootstrapProbeCommand(),
    secret,
    'bootstrap'
  );
  if (!commandParts) {
    return {
      ok: false,
      status: 'remote_probe_not_ready',
      message: 'Connector does not have enough SSH information to probe the remote architecture.',
      step: null,
    };
  }
  const run = await runProcess(commandParts.command, commandParts.args, {
    timeoutMs: authAwareTimeout(30_000, secret),
    env: connectorUsesAskpass(connector, secret) ? buildAskpassEnv(connector, secret) : null,
  });
  const match = String(run.stdout || '').match(/CODEX_REMOTE_ARCH=([^\s]+)/);
  const architecture = normalizeLinuxArchitecture(match?.[1]);
  if (run.exitCode !== 0 || !architecture) {
    return {
      ok: false,
      status: run.exitCode === 0 ? 'remote_architecture_unsupported' : 'remote_probe_failed',
      message: run.exitCode === 0
        ? `Unsupported remote Linux architecture: ${match?.[1] || 'unknown'}.`
        : 'Unable to probe the remote Linux architecture before bootstrap.',
      step: { name: 'remote_runtime_probe', ...run },
    };
  }
  return {
    ok: true,
    architecture,
    nodeAvailable: String(run.stdout || '').includes('CODEX_REMOTE_NODE_PRESENT'),
    step: { name: 'remote_runtime_probe', ...run },
  };
}

function buildRemotePrepareCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `mkdir -p ${remoteDir}`,
    `test -d ${remoteDir}`,
    'echo CODEX_REMOTE_AGENT_DIR_READY',
  ].join(' && ');
}

function buildRemoteDeploymentCheckCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `test -f ${remoteDir}/apps/host-agent/agent.js && echo CODEX_REMOTE_CHECK_AGENT=ok || echo CODEX_REMOTE_CHECK_AGENT=missing`,
    `test -f ${remoteDir}/shared/protocol.js && echo CODEX_REMOTE_CHECK_SHARED=ok || echo CODEX_REMOTE_CHECK_SHARED=missing`,
    `NODE_BIN="$(command -v node || command -v nodejs || test -x ${remoteDir}/.runtime/node/bin/node && printf '%s\\n' ${remoteDir}/.runtime/node/bin/node || true)"`,
    'test -n "$NODE_BIN" && echo CODEX_REMOTE_CHECK_NODE=$NODE_BIN || echo CODEX_REMOTE_CHECK_NODE=missing',
    'test -n "$NODE_BIN" && "$NODE_BIN" -v 2>/dev/null || true',
    `CODEX_BIN="$(command -v codex || test -x ${remoteDir}/.runtime/codex/codex && printf '%s\\n' ${remoteDir}/.runtime/codex/codex || true)"`,
    'test -n "$CODEX_BIN" && echo CODEX_REMOTE_CHECK_CODEX=$CODEX_BIN || echo CODEX_REMOTE_CHECK_CODEX=missing',
    'command -v tmux >/dev/null && echo CODEX_REMOTE_CHECK_TMUX=$(command -v tmux) || echo CODEX_REMOTE_CHECK_TMUX=missing',
    'tmux -V 2>/dev/null || true',
    'command -v tmux >/dev/null && echo CODEX_REMOTE_CHECK_KEEPALIVE=tmux || echo CODEX_REMOTE_CHECK_KEEPALIVE=nohup',
    `test -f ${remoteDir}/apps/host-agent/agent.js && test -f ${remoteDir}/shared/protocol.js && test -n "$NODE_BIN" && test -n "$CODEX_BIN" && echo CODEX_REMOTE_AGENT_DEPLOYED`,
  ].join('; ');
}

function buildRemoteBundleCheckCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `test -f ${remoteDir}/apps/host-agent/agent.js && echo CODEX_REMOTE_CHECK_AGENT=ok || echo CODEX_REMOTE_CHECK_AGENT=missing`,
    `test -f ${remoteDir}/shared/protocol.js && echo CODEX_REMOTE_CHECK_SHARED=ok || echo CODEX_REMOTE_CHECK_SHARED=missing`,
    `test -f ${remoteDir}/apps/host-agent/agent.js && test -f ${remoteDir}/shared/protocol.js && echo CODEX_REMOTE_BUNDLE_DEPLOYED`,
  ].join('; ');
}

function buildRemoteNodeProbeCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `NODE_BIN="$(command -v node || command -v nodejs || test -x ${remoteDir}/.runtime/node/bin/node && printf '%s\\n' ${remoteDir}/.runtime/node/bin/node || true)"`,
    'test -n "$NODE_BIN" && echo CODEX_REMOTE_NODE_PRESENT=$NODE_BIN || echo CODEX_REMOTE_NODE_MISSING',
  ].join('; ');
}

function buildRemoteCodexProbeCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  const codexHome = remoteShellPath(connector.codexHome || '~/.codex');
  return [
    `REMOTE_CODEX_DIR=${remoteDir}`,
    `CODEX_HOME_DIR=${codexHome}`,
    'CODEX_BIN="$(command -v codex 2>/dev/null || true)"',
    'if [ -z "$CODEX_BIN" ]; then',
    '  for p in "$REMOTE_CODEX_DIR/.runtime/codex/codex" "$CODEX_HOME_DIR/bin/codex" "$CODEX_HOME_DIR/codex" "$CODEX_HOME_DIR/node_modules/.bin/codex"; do',
    '    if [ -x "$p" ]; then CODEX_BIN="$p"; break; fi',
    '  done',
    'fi',
    'if [ -z "$CODEX_BIN" ] && [ -d "$CODEX_HOME_DIR" ]; then',
    '  CODEX_BIN="$(find "$CODEX_HOME_DIR" -maxdepth 5 -type f \\( -name codex -o -name codex.exe -o -name "codex-*" \\) -perm -111 2>/dev/null | head -n 1 || true)"',
    'fi',
    'if [ -z "$CODEX_BIN" ]; then',
    '  for root in "$HOME/.local/bin" "$HOME/bin" "$HOME/.npm-global/bin" "$HOME/.conda/envs" "$HOME/miniconda3/envs" "$HOME/anaconda3/envs" "$HOME/mambaforge/envs" "$HOME/.micromamba/envs" "$HOME/.nvm/versions/node"; do',
    '    if [ -x "$root/codex" ]; then CODEX_BIN="$root/codex"; break; fi',
    '    if [ -d "$root" ]; then',
    '      CODEX_BIN="$(find "$root" -maxdepth 5 -type f \\( -name codex -o -name codex.exe -o -name "codex-*" \\) -perm -111 2>/dev/null | head -n 1 || true)"',
    '      if [ -n "$CODEX_BIN" ]; then break; fi',
    '    fi',
    '  done',
    'fi',
    'test -n "$CODEX_BIN" && echo CODEX_REMOTE_CODEX_PRESENT=$CODEX_BIN || echo CODEX_REMOTE_CODEX_MISSING',
  ].join('\n');
}

function buildRemoteRuntimePrepareCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return `mkdir -p ${remoteDir}/.runtime && echo CODEX_REMOTE_RUNTIME_DIR_READY`;
}

function buildRemoteCodexRuntimePrepareCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return `mkdir -p ${remoteDir}/.runtime/codex && echo CODEX_REMOTE_CODEX_RUNTIME_DIR_READY`;
}

function buildRemoteRuntimeExtractCommand(connector, archiveName) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  const archive = String(archiveName || '').replace(/'/g, '');
  return [
    `mkdir -p ${remoteDir}/.runtime/node`,
    `tar -xJf ${remoteDir}/.runtime/${archive} -C ${remoteDir}/.runtime/node --strip-components=1`,
    `test -x ${remoteDir}/.runtime/node/bin/node`,
    `${remoteDir}/.runtime/node/bin/node -v`,
    'echo CODEX_REMOTE_NODE_RUNTIME_READY',
  ].join(' && ');
}

function buildRemoteCodexRuntimeVerifyCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  return [
    `chmod +x ${remoteDir}/.runtime/codex/codex ${remoteDir}/.runtime/codex/rg ${remoteDir}/.runtime/codex/codex-resources/bwrap 2>/dev/null || true`,
    `test -x ${remoteDir}/.runtime/codex/codex`,
    `CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}" ${remoteDir}/.runtime/codex/codex --help >/dev/null`,
    `echo CODEX_REMOTE_CODEX_RUNTIME_READY=${remoteDir}/.runtime/codex/codex`,
  ].join(' && ');
}

function shellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function buildRemoteCodexResolutionScript(connector, codexRuntimeIncluded, codexRuntimeRelativeDir = '') {
  const lines = [
    buildCodexBinResolutionCommand(connector),
  ];

  const runtimeDir = String(codexRuntimeRelativeDir || '').replace(/[^A-Za-z0-9._/-]/g, '');
  if (codexRuntimeIncluded && runtimeDir) {
    lines.push(
      `if [ -z "$CODEX_BIN" ] && [ -f "${runtimeDir}/codex" ]; then`,
      '  mkdir -p .runtime/codex',
      `  cp -R "${runtimeDir}/." .runtime/codex/`,
      '  chmod +x .runtime/codex/codex .runtime/codex/rg .runtime/codex/codex-resources/bwrap 2>/dev/null || true',
      '  if [ -x .runtime/codex/codex ]; then CODEX_BIN="$PWD/.runtime/codex/codex"; fi',
      'fi'
    );
  }

  return lines.join('\n');
}

function buildRemoteCodexPreflightScript(connector) {
  const codexHome = remoteShellPath(connector.codexHome || '~/.codex');
  return [
    'echo CODEX_REMOTE_PREFLIGHT_BEGIN',
    `CODEX_PREFLIGHT_HOME=${codexHome}`,
    'if [ ! -d "$CODEX_PREFLIGHT_HOME" ]; then echo CODEX_REMOTE_PREFLIGHT_HOME=missing; exit 73; fi',
    'echo CODEX_REMOTE_PREFLIGHT_HOME=ok',
    'if [ ! -f "$CODEX_PREFLIGHT_HOME/auth.json" ] && [ ! -f "$CODEX_PREFLIGHT_HOME/config.toml" ]; then echo CODEX_REMOTE_PREFLIGHT_INIT=missing; exit 73; fi',
    'echo CODEX_REMOTE_PREFLIGHT_INIT=ok',
    'mkdir -p "$CODEX_PREFLIGHT_HOME/sessions" 2>/dev/null || true',
    'if [ ! -d "$CODEX_PREFLIGHT_HOME/sessions" ]; then echo CODEX_REMOTE_PREFLIGHT_SESSIONS=missing; exit 73; fi',
    'if [ ! -w "$CODEX_PREFLIGHT_HOME/sessions" ]; then echo CODEX_REMOTE_PREFLIGHT_SESSIONS=unwritable; exit 73; fi',
    'echo CODEX_REMOTE_PREFLIGHT_SESSIONS=ok',
    'echo CODEX_REMOTE_PREFLIGHT_END',
  ].join('\n');
}

function buildRemoteOneShotAgentLauncherScript(connector, restart, options = {}) {
  const mode = connector.bootstrap?.mode || 'manual_tmux';
  if (mode !== 'manual_tmux') {
    return buildDetachedBootstrapCommand(connector, { restart });
  }

  const tmuxSession = connectorTmuxSessionName(connector);
  const controlRemoteDirectory = normalizeConnectorRemoteDirectory(
    options.controlRemoteDirectory || connector.bootstrap?.remoteDirectory
  );
  const controlLogFile = connectorControlFileName(connector, 'log');
  const controlPidFile = connectorControlFileName(connector, 'pid');
  const controlLogPath = remoteScpChildPath(controlRemoteDirectory, controlLogFile);
  const controlPidPath = remoteScpChildPath(controlRemoteDirectory, controlPidFile);
  const launchCommand = [
    `echo "$$" > ${remoteShellPath(controlPidPath)}`,
    agentLogCommand(
      buildAgentLaunchCommand(connector, { execProcess: true }),
      { logPath: controlLogPath }
    ),
  ].join('\n');
  const launchScriptPath = '.remote-codex-agent-launch.sh';
  const launchScriptCommand = 'sh .remote-codex-agent-launch.sh';
  const refreshExistingAgent = true;
  const restartFlag = refreshExistingAgent ? '1' : '0';
  const tmuxStartCommand = `tmux new-session -d -s ${shellQuote(tmuxSession)} ${shellQuote(launchScriptCommand)}`;
  const tmuxEnsureCommand = tmuxStartCommand;
  const script = [
    'cat > ' + launchScriptPath + " <<'REMOTE_CODEX_AGENT_LAUNCH'",
    '#!/bin/sh',
    launchCommand,
    'REMOTE_CODEX_AGENT_LAUNCH',
    'chmod +x ' + launchScriptPath,
    `control_dir=${remoteShellPath(controlRemoteDirectory)}`,
    'mkdir -p "$control_dir"',
    'control_dir="$(cd "$control_dir" 2>/dev/null && pwd -P)"',
    'test -n "$control_dir" || { echo CODEX_REMOTE_AGENT_CONTROL_DIR_FAILED; exit 74; }',
    `expected_connector_id=${shellQuote(connector.connectorId || '')}`,
    `expected_host_id=${shellQuote(connector.hostId || '')}`,
    `pid_file="$control_dir/${controlPidFile}"`,
    'if [ ! -f "$pid_file" ] && [ -d "$control_dir/.deployments" ]; then',
    '  legacy_pid_file="$control_dir/codex-remote.agent.pid"',
    '  if [ ! -f "$legacy_pid_file" ]; then',
    "    legacy_pid_file=\"$(find \"$control_dir/.deployments\" -maxdepth 8 -type f -name codex-remote.agent.pid -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)\"",
    '  fi',
    '  if [ -n "$legacy_pid_file" ]; then cp "$legacy_pid_file" "$pid_file" 2>/dev/null || true; fi',
    'fi',
    'tracked_agent_tree() {',
    '  tree="$1"',
    '  frontier="$1"',
    '  while [ -n "$frontier" ]; do',
    '    next_frontier=""',
    '    for parent_pid in $frontier; do',
    `      for child_pid in $(ps -eo pid=,ppid= 2>/dev/null | awk -v parent="$parent_pid" '$2 == parent { print $1 }'); do`,
    '        case " $tree " in *" $child_pid "*) ;; *) tree="$tree $child_pid"; next_frontier="$next_frontier $child_pid" ;; esac',
    '      done',
    '    done',
    '    frontier="$next_frontier"',
    '  done',
    '  echo "$tree"',
    '}',
    'is_control_agent_pid() {',
    '  candidate_pid="$1"',
    '  case "$candidate_pid" in ""|*[!0-9]*) return 1 ;; esac',
    '  kill -0 "$candidate_pid" 2>/dev/null || return 1',
    '  candidate_exe="$(readlink -f "/proc/$candidate_pid/exe" 2>/dev/null || true)"',
    '  case "${candidate_exe##*/}" in node|nodejs) ;; *) return 1 ;; esac',
    '  candidate_command="$(tr \'\\000\' \' \' < "/proc/$candidate_pid/cmdline" 2>/dev/null || true)"',
    '  case "$candidate_command" in *apps/host-agent/agent.js*) ;; *) return 1 ;; esac',
    '  candidate_environment="$(tr \'\\000\' \'\\n\' < "/proc/$candidate_pid/environ" 2>/dev/null || true)"',
    '  candidate_connector_id="$(printf "%s\\n" "$candidate_environment" | sed -n "s/^REMOTE_CODEX_CONNECTOR_ID=//p" | head -n 1)"',
    '  candidate_host_id="$(printf "%s\\n" "$candidate_environment" | sed -n "s/^HOST_ID=//p" | head -n 1)"',
    '  if [ -n "$expected_connector_id" ] && [ -n "$candidate_connector_id" ]; then',
    '    [ "$candidate_connector_id" = "$expected_connector_id" ] || return 1',
    '  elif [ -n "$expected_host_id" ] && [ -n "$candidate_host_id" ]; then',
    '    [ "$candidate_host_id" = "$expected_host_id" ] || return 1',
    '  else',
    '    return 1',
    '  fi',
    '  candidate_cwd="$(readlink -f "/proc/$candidate_pid/cwd" 2>/dev/null || true)"',
    '  case "$candidate_cwd" in "$control_dir"|"$control_dir"/*) return 0 ;; *) return 1 ;; esac',
    '}',
    'stop_agent_tree() {',
    '  root_pid="$1"',
    '  agent_pids="$(tracked_agent_tree "$root_pid")"',
    '  for agent_pid in $agent_pids; do kill -TERM "$agent_pid" 2>/dev/null || true; done',
    '  remaining=12',
    '  while [ "$remaining" -gt 0 ]; do',
    '    agent_alive=0',
    '    for agent_pid in $agent_pids; do if kill -0 "$agent_pid" 2>/dev/null; then agent_alive=1; fi; done',
    '    [ "$agent_alive" = "0" ] && break',
    '    sleep 1',
    '    remaining=$((remaining - 1))',
    '  done',
    '  for agent_pid in $agent_pids; do if kill -0 "$agent_pid" 2>/dev/null; then kill -KILL "$agent_pid" 2>/dev/null || true; fi; done',
    '}',
    'stop_tracked_agent() {',
    '  [ -f "$pid_file" ] || return 0',
    '  old_pid="$(cat "$pid_file" 2>/dev/null || true)"',
    '  case "$old_pid" in ""|*[!0-9]*) rm -f "$pid_file"; return 0 ;; esac',
    '  if ! kill -0 "$old_pid" 2>/dev/null; then rm -f "$pid_file"; return 0; fi',
    '  if ! is_control_agent_pid "$old_pid"; then echo CODEX_REMOTE_AGENT_STALE_PID_IGNORED; rm -f "$pid_file"; return 0; fi',
    '  stop_agent_tree "$old_pid"',
    '  rm -f "$pid_file"',
    '}',
    'stop_untracked_control_agents() {',
    '  ps -eo pid=,comm=,args= 2>/dev/null | while read -r candidate_pid candidate_comm candidate_args; do',
    '    case "$candidate_comm" in node|nodejs) ;; *) continue ;; esac',
    '    case "$candidate_args" in *apps/host-agent/agent.js*) ;; *) continue ;; esac',
    '    if is_control_agent_pid "$candidate_pid"; then',
    '      echo "CODEX_REMOTE_AGENT_UNTRACKED_STOPPED=$candidate_pid"',
    '      stop_agent_tree "$candidate_pid"',
    '    fi',
    '  done',
    '}',
    'stop_tracked_agent',
    'stop_untracked_control_agents',
    'if command -v tmux >/dev/null 2>&1; then',
    `  if ${tmuxEnsureCommand}; then`,
    '    echo CODEX_REMOTE_AGENT_TMUX_BOOTSTRAPPED',
    '  else',
    '    echo CODEX_REMOTE_AGENT_LAUNCH_FAILED',
    '    exit 74',
    '  fi',
    'else',
    `  if [ "${restartFlag}" = "1" ] || ! { [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; }; then`,
    `    nohup ${launchScriptCommand} >/dev/null 2>&1 < /dev/null &`,
    '    agent_pid=$!',
    '    echo "$agent_pid" > "$pid_file"',
    '    sleep 1',
    '    if ! kill -0 "$agent_pid" 2>/dev/null; then echo CODEX_REMOTE_AGENT_LAUNCH_FAILED; exit 74; fi',
    '  fi',
    '  echo CODEX_REMOTE_AGENT_NOHUP_BOOTSTRAPPED',
    'fi',
    'echo CODEX_REMOTE_AGENT_BOOTSTRAPPED',
  ];
  return script.join('\n');
}

function buildRemoteOneShotBootstrapCommand(connector, action, payload = {}) {
  const nodeArchive = String(payload.nodeArchiveName || '').replace(/'/g, '');
  const bootstrapCommand = buildRemoteOneShotAgentLauncherScript(
    connector,
    action === 'restart',
    { controlRemoteDirectory: payload.controlRemoteDirectory }
  );
  const script = [
    'echo CODEX_REMOTE_AGENT_DIR_READY',
    'test -f apps/host-agent/agent.js && echo CODEX_REMOTE_CHECK_AGENT=ok || { echo CODEX_REMOTE_CHECK_AGENT=missing; exit 70; }',
    'test -f shared/protocol.js && echo CODEX_REMOTE_CHECK_SHARED=ok || { echo CODEX_REMOTE_CHECK_SHARED=missing; exit 71; }',
    'echo CODEX_REMOTE_BUNDLE_DEPLOYED',
    'NODE_BIN="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"',
    'if [ -z "$NODE_BIN" ] && [ -x .runtime/node/bin/node ]; then NODE_BIN="$PWD/.runtime/node/bin/node"; fi',
    nodeArchive
      ? [
        'if [ -z "$NODE_BIN" ] && [ -f "tmp/' + nodeArchive + '" ]; then',
        '  mkdir -p .runtime/node',
        '  tar -xJf "tmp/' + nodeArchive + '" -C .runtime/node --strip-components=1',
        '  if [ -x .runtime/node/bin/node ]; then NODE_BIN="$PWD/.runtime/node/bin/node"; fi',
        '  test -n "$NODE_BIN" && echo CODEX_REMOTE_NODE_RUNTIME_READY',
        'fi',
      ].join('\n')
      : 'true',
    'test -n "$NODE_BIN" && echo "CODEX_REMOTE_CHECK_NODE=$NODE_BIN" || { echo CODEX_REMOTE_CHECK_NODE=missing; exit 72; }',
    '"$NODE_BIN" -v 2>/dev/null || true',
    buildRemoteCodexResolutionScript(
      connector,
      Boolean(payload.codexRuntimeIncluded),
      payload.codexRuntimeRelativeDir
    ),
    'test -n "$CODEX_BIN" && echo "CODEX_REMOTE_CHECK_CODEX=$CODEX_BIN" || { echo CODEX_REMOTE_CHECK_CODEX=missing; exit 73; }',
    '"$CODEX_BIN" --help >/dev/null 2>&1 && echo CODEX_REMOTE_CODEX_HELP_OK || echo CODEX_REMOTE_CODEX_HELP_WARNING',
    buildRemoteCodexPreflightScript(connector),
    'command -v tmux >/dev/null && echo CODEX_REMOTE_CHECK_TMUX=$(command -v tmux) || echo CODEX_REMOTE_CHECK_TMUX=missing',
    bootstrapCommand,
    'echo CODEX_REMOTE_ONESHOT_BOOTSTRAP_DONE',
  ].filter(Boolean).join('\n');

  return `sh -lc ${shellSingleQuote(script)}`;
}

function collectOneShotBootstrapSources(options = {}) {
  const architecture = normalizeLinuxArchitecture(options.architecture || 'x64');
  if (!architecture) {
    throw new Error(`Unsupported remote Linux architecture: ${options.architecture || 'unknown'}.`);
  }
  const sources = ['apps', 'shared', 'package.json'];
  const nodeRuntime = options.nodeAvailable === true
    ? null
    : getLocalNodeRuntimeArchive(architecture);
  if (nodeRuntime) {
    sources.push(nodeRuntime.localPath);
  }

  const codexRuntime = stageLocalCodexLinuxRuntime(architecture);
  if (codexRuntime?.localSources?.length) {
    sources.push(...codexRuntime.localSources);
  }

  return {
    sources,
    architecture,
    nodeArchiveName: nodeRuntime?.archiveName || '',
    codexRuntimeIncluded: Boolean(codexRuntime?.localSources?.length),
    codexRuntimeRelativeDir: codexRuntime?.remoteRelativeDir || '',
  };
}

function classifyOneShotBootstrapFailure(action, step) {
  const text = sshRunText(step);
  if (step?.timedOut) {
    return { status: 'timeout', message: 'SSH one-shot bootstrap timed out.' };
  }
  if (step?.error) {
    return { status: 'error', message: step.error };
  }
  if (/CODEX_REMOTE_CHECK_AGENT=missing|CODEX_REMOTE_CHECK_SHARED=missing/.test(text)) {
    return { status: 'verify_failed', message: 'Remote bundle uploaded, but the host-agent files did not verify.' };
  }
  if (/CODEX_REMOTE_CHECK_NODE=missing/.test(text)) {
    return { status: 'node_runtime_missing', message: 'No usable Node runtime was found or uploaded for the remote host.' };
  }
  if (/CODEX_REMOTE_CHECK_CODEX=missing/.test(text)) {
    return { status: 'codex_runtime_missing', message: 'No usable Codex CLI was found in PATH, CODEX_HOME, common conda/nvm locations, or the uploaded runtime.' };
  }
  if (/CODEX_REMOTE_PREFLIGHT_(HOME|INIT|SESSIONS)=(missing|unwritable)/.test(text)) {
    return { status: 'codex_init_failed', message: 'Remote Codex CLI was found, but CODEX_HOME is missing, uninitialized, or not writable.' };
  }
  if (/command too long/i.test(text)) {
    return { status: 'launcher_failed', message: 'The remote shell rejected the host-agent launch command as too long.' };
  }
  if (/CODEX_REMOTE_AGENT_LAUNCH_FAILED/.test(text)) {
    return { status: 'launcher_failed', message: 'The remote host-agent launcher failed after the bundle was deployed.' };
  }
  if (/CODEX_REMOTE_CHECK_TMUX=missing/.test(text) && !/CODEX_REMOTE_AGENT_(TMUX|NOHUP)_BOOTSTRAPPED|CODEX_REMOTE_AGENT_BOOTSTRAPPED/.test(text)) {
    return { status: 'launcher_failed', message: 'tmux is missing and the nohup fallback did not confirm that the remote host-agent started.' };
  }
  if (/permission denied/i.test(text)) {
    return { status: 'ssh_failed', message: 'SSH authentication or remote permissions failed during one-shot bootstrap.' };
  }
  return {
    status: action === 'restart' ? 'restart_failed' : 'bootstrap_failed',
    message: action === 'restart'
      ? 'Remote host-agent restart failed during one-shot bootstrap.'
      : 'Remote host-agent bootstrap failed during one-shot bootstrap.',
  };
}

async function runConnectorBootstrapOneShot(connector, action, secret) {
  const baseConnector = connectorWithDeploymentBaseDirectory(connector);
  const probe = await probeConnectorBootstrapRuntime(baseConnector, secret);
  if (!probe.ok) {
    return {
      ok: false,
      status: probe.status,
      message: probe.message,
      remoteDirectory: baseConnector.bootstrap?.remoteDirectory || '',
      connector: baseConnector,
      step: probe.step || null,
      steps: probe.step ? [probe.step] : [],
    };
  }
  const remoteDirectory = makeRemoteDeploymentDirectory(baseConnector);
  const deploymentConnector = withConnectorRemoteDirectory(baseConnector, remoteDirectory);
  let payload;
  try {
    payload = collectOneShotBootstrapSources({
      architecture: probe.architecture,
      nodeAvailable: probe.nodeAvailable,
    });
    payload.controlRemoteDirectory = baseConnector.bootstrap?.remoteDirectory || '~/mobile-codex-remote';
  } catch (error) {
    return {
      ok: false,
      status: 'local_runtime_stage_failed',
      message: `Unable to prepare the local one-shot bootstrap payload: ${error.message}`,
      remoteDirectory,
      connector: baseConnector,
      steps: probe.step ? [probe.step] : [],
    };
  }

  const remoteCommand = buildRemoteOneShotBootstrapCommand(deploymentConnector, action, payload);
  let upload;
  try {
    upload = await runSshTarExtract(
      deploymentConnector,
      secret,
      payload.sources,
      remoteDirectory,
      remoteCommand,
      'oneshot_bootstrap',
      600_000,
      {}
    );
  } catch (error) {
    return {
      ok: false,
      status: 'local_archive_failed',
      message: `Unable to build the local one-shot bootstrap archive: ${error.message}`,
      remoteDirectory,
      connector: baseConnector,
      steps: probe.step ? [probe.step] : [],
      payload: {
        architecture: payload.architecture,
        nodeRuntimeIncluded: Boolean(payload.nodeArchiveName),
        codexRuntimeIncluded: payload.codexRuntimeIncluded,
      },
    };
  }
  const steps = [probe.step, upload.step].filter(Boolean);
  const combinedText = sshRunText(upload.step || upload);
  const ok = upload.ok
    && upload.step?.stdout?.includes('CODEX_REMOTE_AGENT_BOOTSTRAPPED')
    && !/command too long/i.test(combinedText)
    && !/CODEX_REMOTE_AGENT_LAUNCH_FAILED/.test(combinedText);
  const classification = ok
    ? {
      status: action === 'restart' ? 'restarted' : 'bootstrapped',
      message: action === 'restart'
        ? 'Remote host-agent restarted with a single SSH bootstrap stream.'
        : 'Remote host-agent bootstrapped with a single SSH stream.',
    }
    : classifyOneShotBootstrapFailure(action, upload.step || upload);

  return {
    ok,
    ...classification,
    remoteDirectory,
    connector: baseConnector,
    command: decorateSingleConnector(deploymentConnector).plan.sshBootstrapCommand,
    step: upload.step || null,
    steps,
    payload: {
      architecture: payload.architecture,
      nodeRuntimeIncluded: Boolean(payload.nodeArchiveName),
      codexRuntimeIncluded: payload.codexRuntimeIncluded,
    },
  };
}

function buildRemoteDiagnosticCommand(connector = null) {
  const remoteDir = remoteShellPath(connector?.bootstrap?.remoteDirectory);
  const script = [
    'echo CODEX_REMOTE_DIAG_BEGIN',
    'echo SHELL=$SHELL',
    'echo HOME=$HOME',
    `REMOTE_CODEX_DIR=${remoteDir}/.runtime/codex`,
    'uname -a || true',
    'echo --commands--',
    'for c in codex codex.exe node nodejs npm tmux conda module ml; do type "$c" 2>&1 || true; done',
    'echo --codex-paths--',
    'for d in "$REMOTE_CODEX_DIR" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.cursor/extensions" "$HOME/.conda/envs" "$HOME/.nvm/versions/node" "$HOME/.local/bin" "$HOME/bin"; do [ -d "$d" ] && timeout 6s find "$d" -maxdepth 5 -type f \\( -name "codex" -o -name "codex.exe" -o -name "codex-*" \\) -perm -111 2>/dev/null; done | head -80 || true',
    'echo --codex-home-top--',
    'ls -la "${CODEX_HOME:-$HOME/.codex}" 2>/dev/null | head -80 || true',
    'echo --node-paths--',
    'ls -1 /usr/bin/node* /usr/local/bin/node* /opt/*/bin/node* /hpc/*/*/bin/node* 2>/dev/null | head -80 || true',
    'echo --module-node--',
    'module avail node 2>&1 | head -80 || true',
    'echo --module-js--',
    'module avail 2>&1 | grep -i -E "node|javascript|js" | head -80 || true',
    'echo --conda-envs--',
    'conda env list 2>/dev/null | head -80 || true',
    'echo CODEX_REMOTE_DIAG_END',
  ].join('\n');
  return `bash -lc ${shellSingleQuote(script)}`;
}

function buildRemoteAgentLogCommand(connector) {
  const remoteDir = remoteShellPath(connector.bootstrap?.remoteDirectory);
  const logFile = connectorControlFileName(connector, 'log');
  return `cd ${remoteDir} && tail -n 160 ${shellQuote(logFile)} 2>/dev/null || true`;
}

function buildConnectorSshActionCommand(connector, remoteCommand, secret, action = 'bootstrap', sshOptions = {}) {
  return buildSshCommandParts(connector, {
    ...buildSshActionOptions(connector, action, secret),
    ...(sshOptions || {}),
    remoteCommand,
  });
}

function buildConnectorAction(connector, action, secret = null, sshOptions = {}) {
  const baseOptions = buildSshActionOptions(connector, action, secret);
  const env = connectorUsesAskpass(connector, secret)
    ? buildAskpassEnv(connector, secret)
    : null;

  if (action === 'smoke_test') {
    return {
      timeoutMs: authAwareTimeout(12_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: 'echo SSH_OK',
      }),
      displayCommand: decorateSingleConnector(connector).plan.sshSmokeTestCommand,
      env,
    };
  }

  if (action === 'status') {
    return {
      timeoutMs: authAwareTimeout(12_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: buildRemoteStatusCommand(connector),
      }),
      displayCommand: decorateSingleConnector(connector).plan.sshStatusCommand,
      env,
    };
  }

  if (action === 'diagnose') {
    return {
      timeoutMs: authAwareTimeout(20_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: buildRemoteDiagnosticCommand(connector),
      }),
      displayCommand: 'remote environment diagnostic',
      env,
    };
  }

  if (action === 'logs') {
    return {
      timeoutMs: authAwareTimeout(12_000, secret),
      commandParts: buildSshCommandParts(connector, {
        ...baseOptions,
        ...(sshOptions || {}),
        remoteCommand: buildRemoteAgentLogCommand(connector),
      }),
      displayCommand: 'remote host-agent logs',
      env,
    };
  }

  if (action === 'bootstrap') {
    const remoteCommand = buildDetachedBootstrapCommand(connector);
    return {
      timeoutMs: authAwareTimeout(20_000, secret),
      commandParts: remoteCommand
        ? buildSshCommandParts(connector, {
          ...baseOptions,
          ...(sshOptions || {}),
          remoteCommand,
        })
        : null,
      displayCommand: decorateSingleConnector(connector).plan.sshBootstrapCommand,
      remoteCommand,
      env,
    };
  }

  if (action === 'restart') {
    const remoteCommand = buildDetachedBootstrapCommand(connector, { restart: true });
    return {
      timeoutMs: authAwareTimeout(20_000, secret),
      commandParts: remoteCommand
        ? buildSshCommandParts(connector, {
          ...baseOptions,
          ...(sshOptions || {}),
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

async function deployConnectorBundle(connector, secret, sshOptions = {}) {
  const useAskpass = connectorUsesAskpass(connector, secret);
  const makeEnv = () => (useAskpass ? buildAskpassEnv(connector, secret) : null);
  const remoteDirectory = makeRemoteDeploymentDirectory(connector);
  const deploymentConnector = withConnectorRemoteDirectory(connector, remoteDirectory);
  const upload = await runSshTarExtract(
    deploymentConnector,
    secret,
    ['apps', 'shared', 'package.json'],
    remoteDirectory,
    [
      'echo CODEX_REMOTE_AGENT_DIR_READY',
      buildRemoteBundleCheckCommand(deploymentConnector),
    ].join(' && '),
    'upload_bundle',
    120_000,
    sshOptions
  );
  const steps = [];
  if (upload.step) {
    steps.push(upload.step);
  }
  if (!upload.ok) {
    return {
      ok: false,
      status: upload.status,
      message: 'Unable to upload the host-agent bundle over SSH.',
      steps,
    };
  }
  if (!upload.step.stdout.includes('CODEX_REMOTE_AGENT_DIR_READY')) {
    return {
      ok: false,
      status: 'remote_directory_failed',
      message: 'Unable to create or verify the remote agent directory.',
      steps,
    };
  }

  const nodeRuntime = await ensureRemoteNodeRuntime(deploymentConnector, secret, remoteDirectory, makeEnv, steps, sshOptions);
  if (!nodeRuntime.ok) {
    return nodeRuntime;
  }

  const codexRuntime = await ensureRemoteCodexRuntime(deploymentConnector, secret, remoteDirectory, makeEnv, steps, sshOptions);
  if (!codexRuntime.ok) {
    return codexRuntime;
  }

  if (!upload.step.stdout.includes('CODEX_REMOTE_CHECK_AGENT=ok')
    || !upload.step.stdout.includes('CODEX_REMOTE_CHECK_SHARED=ok')
    || !upload.step.stdout.includes('CODEX_REMOTE_BUNDLE_DEPLOYED')) {
    return {
      ok: false,
      status: 'verify_failed',
      message: 'Remote bundle uploaded, but verification failed.',
      steps,
    };
  }

  const checkCommandParts = buildConnectorSshActionCommand(deploymentConnector, buildRemoteDeploymentCheckCommand(deploymentConnector), secret, 'bootstrap', sshOptions);
  if (!checkCommandParts) {
    return {
      ok: false,
      status: 'verify_not_ready',
      message: 'Connector does not have enough SSH information to verify the deployed runtime.',
      steps,
    };
  }
  const check = await runProcess(checkCommandParts.command, checkCommandParts.args, {
    timeoutMs: authAwareTimeout(30_000, secret),
    env: makeEnv(),
  });
  steps.push({ name: 'verify_deployment', ...check });
  if (check.exitCode !== 0 || !check.stdout.includes('CODEX_REMOTE_AGENT_DEPLOYED')) {
    return {
      ok: false,
      status: 'verify_failed',
      message: 'Remote bundle and runtime uploaded, but final verification failed.',
      steps,
    };
  }

  return {
    ok: true,
    status: 'deployed',
    message: 'Remote host-agent bundle is deployed and verified.',
    remoteDirectory,
    connector: deploymentConnector,
    steps,
  };
}

async function ensureRemoteNodeRuntime(connector, secret, remoteDirectory, makeEnv, steps, sshOptions = {}) {
  const probeCommandParts = buildConnectorSshActionCommand(connector, buildRemoteNodeProbeCommand(connector), secret, 'bootstrap', sshOptions);
  if (!probeCommandParts) {
    return {
      ok: false,
      status: 'node_probe_not_ready',
      message: 'Connector does not have enough SSH information to check the remote Node runtime.',
      steps,
    };
  }

  const probe = await runProcess(probeCommandParts.command, probeCommandParts.args, {
    timeoutMs: authAwareTimeout(15_000, secret),
    env: makeEnv(),
  });
  steps.push({ name: 'probe_node_runtime', ...probe });
  if (probe.exitCode === 0 && probe.stdout.includes('CODEX_REMOTE_NODE_PRESENT=')) {
    return { ok: true };
  }

  const archive = getLocalNodeRuntimeArchive();
  if (!archive) {
    return {
      ok: false,
      status: 'node_runtime_missing',
      message: 'No system Node was found on the remote host, and no local Node runtime archive is available in tmp/.',
      steps,
    };
  }

  const upload = await runSshTarExtract(
    connector,
    secret,
    [archive.localPath],
    remoteScpChildPath(remoteDirectory, '.runtime'),
    buildRemoteRuntimeExtractCommand(connector, archive.archiveName),
    'upload_node_runtime',
    240_000,
    sshOptions
  );
  if (upload.step) {
    steps.push(upload.step);
  }
  if (!upload.ok) {
    return {
      ok: false,
      status: 'node_runtime_upload_failed',
      message: 'Unable to upload the Node runtime archive over SSH.',
      steps,
    };
  }
  if (!upload.step.stdout.includes('CODEX_REMOTE_NODE_RUNTIME_READY')) {
    return {
      ok: false,
      status: 'node_runtime_extract_failed',
      message: 'Unable to extract or verify the Node runtime on the remote host.',
      steps,
    };
  }

  return { ok: true };
}

async function ensureRemoteCodexRuntime(connector, secret, remoteDirectory, makeEnv, steps, sshOptions = {}) {
  const probeCommandParts = buildConnectorSshActionCommand(connector, buildRemoteCodexProbeCommand(connector), secret, 'bootstrap', sshOptions);
  if (!probeCommandParts) {
    return {
      ok: false,
      status: 'codex_probe_not_ready',
      message: 'Connector does not have enough SSH information to check the remote Codex CLI.',
      steps,
    };
  }

  const probe = await runProcess(probeCommandParts.command, probeCommandParts.args, {
    timeoutMs: authAwareTimeout(15_000, secret),
    env: makeEnv(),
  });
  steps.push({ name: 'probe_codex_runtime', ...probe });
  if (probe.exitCode === 0 && probe.stdout.includes('CODEX_REMOTE_CODEX_PRESENT=')) {
    return { ok: true };
  }

  const codexRuntime = stageLocalCodexLinuxRuntime();
  if (!codexRuntime || !codexRuntime.localSources.length) {
    return {
      ok: false,
      status: 'codex_runtime_missing',
      message: 'No remote Codex CLI was found in PATH, CODEX_HOME, or common conda/nvm locations, and no local linux-x86_64 Codex runtime is available to deploy.',
      steps,
    };
  }

  const upload = await runSshTarExtract(
    connector,
    secret,
    codexRuntime.localSources,
    remoteScpChildPath(remoteDirectory, '.runtime/codex'),
    buildRemoteCodexRuntimeVerifyCommand(connector),
    'upload_codex_runtime',
    360_000,
    sshOptions
  );
  if (upload.step) {
    steps.push(upload.step);
  }
  if (!upload.ok) {
    return {
      ok: false,
      status: 'codex_runtime_upload_failed',
      message: 'Unable to upload the Codex CLI runtime over SSH.',
      steps,
    };
  }
  if (!upload.step.stdout.includes('CODEX_REMOTE_CODEX_RUNTIME_READY=')) {
    return {
      ok: false,
      status: 'codex_runtime_verify_failed',
      message: 'The Codex CLI runtime uploaded to the remote host, but it did not pass verification.',
      steps,
    };
  }

  return { ok: true };
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
    if (stdout.includes('CODEX_REMOTE_AGENT_PROCESS_RUNNING')) {
      return { ok: true, status: 'remote_agent_running', message: 'Remote host-agent process is running without tmux.' };
    }
    if (stdout.includes('CODEX_REMOTE_AGENT_MISSING') || stdout.includes('CODEX_REMOTE_AGENT_TMUX_MISSING')) {
      return { ok: true, status: 'remote_agent_missing', message: 'Remote host-agent process is not running yet.' };
    }
    return { ok: true, status: 'remote_status_unknown', message: 'Remote status command completed, but no known status marker was returned.' };
  }
  if (action === 'diagnose') {
    const ok = run.exitCode === 0 && stdout.includes('CODEX_REMOTE_DIAG_END');
    return {
      ok,
      status: ok ? 'diagnosed' : 'diagnose_failed',
      message: ok ? 'Remote environment diagnostic completed.' : 'Remote environment diagnostic failed.',
    };
  }
  if (action === 'logs') {
    return {
      ok: run.exitCode === 0,
      status: run.exitCode === 0 ? 'logs_read' : 'logs_failed',
      message: run.exitCode === 0 ? 'Remote host-agent logs captured.' : 'Unable to read remote host-agent logs.',
    };
  }
  if (action === 'bootstrap') {
    const ok = run.exitCode === 0 && stdout.includes('CODEX_REMOTE_AGENT_BOOTSTRAPPED');
    return {
      ok,
      status: ok ? 'bootstrapped' : 'bootstrap_failed',
      message: ok ? 'Remote host-agent bootstrap command completed.' : 'Remote host-agent bootstrap command failed.',
    };
  }
  if (action === 'restart') {
    const ok = run.exitCode === 0 && stdout.includes('CODEX_REMOTE_AGENT_BOOTSTRAPPED');
    return {
      ok,
      status: ok ? 'restarted' : 'restart_failed',
      message: ok ? 'Remote host-agent restarted with the latest bundle.' : 'Remote host-agent restart failed.',
    };
  }

  return { ok: false, status: 'unknown_action', message: 'Unknown connector action.' };
}

async function runConnectorAction(connector, action, secretOverride = null) {
  connector = connectorWithRelayAuth(connector);
  const decorated = decorateSingleConnector(connector);
  const secret = secretOverride || state.connectorSecrets.get(connector.connectorId) || null;
  const manualCommand = decorated.plan.sshLoginCommand;
  const manualBootstrapCommand = decorated.plan.bootstrapCommand;

  if (!['smoke_test', 'status', 'diagnose', 'logs', 'bootstrap', 'restart'].includes(action)) {
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

  if (action === 'bootstrap' || action === 'restart') {
    const bootstrap = await runConnectorBootstrapOneShot(connector, action, secret);
    return {
      httpStatus: 200,
      payload: {
        ok: bootstrap.ok,
        action,
        status: bootstrap.status,
        message: bootstrap.message,
        command: bootstrap.command || manualBootstrapCommand,
        stdout: bootstrap.step?.stdout || '',
        stderr: bootstrap.step?.stderr || '',
        exitCode: bootstrap.step?.exitCode ?? null,
        signal: bootstrap.step?.signal ?? null,
        timedOut: Boolean(bootstrap.step?.timedOut),
        error: bootstrap.step?.error || null,
        remoteDirectory: bootstrap.remoteDirectory,
        deploy: {
          ok: bootstrap.ok,
          status: bootstrap.status,
          message: bootstrap.message,
          remoteDirectory: bootstrap.remoteDirectory,
          payload: bootstrap.payload,
          steps: bootstrap.steps,
        },
        connector: decorateSingleConnector(bootstrap.connector || connector),
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
      multiplexFallback: null,
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
    relay: {
      platform: process.platform,
      hostname: os.hostname(),
      localAgentSupported: LOCAL_AGENT_START_ENABLED,
      localAgentStartEnabled: LOCAL_AGENT_START_ENABLED,
      localRelayUrl: getLocalRelayUrl(),
    },
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

function awaitHostProbe(requestId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingHostProbes.delete(requestId);
      reject(new Error('host health check timed out'));
    }, timeoutMs);

    state.pendingHostProbes.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingHostProbes.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingHostProbes.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitCodexUpdateRequest(requestId, timeoutMs = HOST_CODEX_UPDATE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingCodexUpdateRequests.delete(requestId);
      reject(new Error('Host Codex update timed out while waiting for the Host Agent'));
    }, timeoutMs);
    timer.unref?.();
    state.pendingCodexUpdateRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingCodexUpdateRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingCodexUpdateRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitSessionApiRequest(pendingMap, requestId, label, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMap.delete(requestId);
      reject(new Error(`${label} timed out while waiting for host-agent`));
    }, timeoutMs);

    pendingMap.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        pendingMap.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        pendingMap.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitModelListRequest(requestId, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingModelRequests.delete(requestId);
      reject(new Error('model list request timed out while waiting for host-agent / Codex app-server to respond'));
    }, timeoutMs);

    state.pendingModelRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingModelRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingModelRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitApiCatalogRequest(requestId, timeoutMs = 20000) {
  return awaitSessionApiRequest(
    state.pendingApiCatalogRequests,
    requestId,
    'provider model catalog request',
    timeoutMs
  );
}

function awaitBindingPreflightRequest(requestId, timeoutMs = 12000) {
  return awaitSessionApiRequest(
    state.pendingBindingPreflightRequests,
    requestId,
    'Host API binding preflight',
    timeoutMs
  );
}

function awaitApiTestRequest(requestId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingApiTestRequests.delete(requestId);
      reject(new Error('API test timed out while waiting for host-agent to respond'));
    }, timeoutMs);

    state.pendingApiTestRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingApiTestRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingApiTestRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function modelRequestSessionId(input = {}) {
  return String(
    input.sessionId
    || input.identity?.sessionId
    || input.nativeThreadId
    || input.identity?.nativeThreadId
    || ''
  ).trim();
}

async function requestLiveModelPage(input = {}) {
  const hostId = String(input.hostId || '').trim();
  const sessionId = modelRequestSessionId(input);
  const session = hostId && sessionId ? getSession(hostId, sessionId) : null;
  const host = state.hosts.get(hostId);
  if (!session || !sessionAcceptsLiveControl(hostId, session)) {
    throw new Error('live model catalog is unavailable until the Session runner is active');
  }
  if (!host?.capabilities?.modelList) {
    throw new Error('this Host agent does not support live model metadata');
  }

  const models = [];
  const seenCursors = new Set();
  let cursor = null;
  let complete = false;
  let truncated = false;
  for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
    const requestId = makeId();
    const pending = awaitModelListRequest(requestId);
    enqueueCommand(hostId, {
      type: 'session.model_list',
      sessionId: session.sessionId || sessionId,
      requestId,
      includeHidden: true,
      cursor,
      limit: 200,
      bindingFingerprint: input.bindingFingerprint || null,
      runId: input.liveRunId || input.runId || null,
    });
    const page = await pending;
    if (
      input.bindingFingerprint
      && page.bindingFingerprint
      && page.bindingFingerprint !== input.bindingFingerprint
    ) {
      throw new SessionContractError(
        'session_api_binding_mismatch',
        'Live model metadata belongs to a different Session API binding.',
        { canRebind: true }
      );
    }
    models.push(...(Array.isArray(page.models) ? page.models : []));
    const nextCursor = String(page.nextCursor || '').trim() || null;
    truncated ||= page.truncated === true;
    if (!nextCursor) {
      complete = page.complete !== false && !truncated;
      break;
    }
    if (seenCursors.has(nextCursor)) {
      truncated = true;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (cursor && !complete) {
    truncated = true;
  }
  return {
    source: 'live',
    authority: 'authoritative',
    complete,
    truncated,
    nextCursor: complete ? null : cursor,
    stale: false,
    fetchedAt: nowIso(),
    models,
  };
}

async function requestProviderModelPage(input = {}) {
  const hostId = String(input.hostId || '').trim();
  const host = state.hosts.get(hostId);
  const apiConfig = normalizeApiConfig(input.apiConfig);
  if (!apiConfig) {
    throw new Error('provider model catalog requires the Session API profile credentials');
  }
  if (!host?.capabilities?.apiCatalog) {
    throw new Error('this Host agent does not support provider model catalogs');
  }

  const models = [];
  const seenCursors = new Set();
  let cursor = null;
  let complete = false;
  let truncated = false;
  for (let pageIndex = 0; pageIndex < 32; pageIndex += 1) {
    const requestId = makeId();
    const pending = awaitApiCatalogRequest(requestId);
    enqueueCommand(hostId, {
      type: 'host.api_catalog',
      requestId,
      apiConfig,
      bindingFingerprint: input.bindingFingerprint || null,
      runId: input.runId || null,
      cursor,
      limit: 200,
      timeoutMs: 15000,
    });
    const payload = await pending;
    const result = payload.result || {};
    if (!result.ok || !result.modelPage) {
      const status = Number(result.statusCode || 0);
      const error = new Error(result.error || result.message || `provider model catalog failed${status ? ` (${status})` : ''}`);
      error.statusCode = status;
      throw error;
    }
    const page = result.modelPage;
    models.push(...(Array.isArray(page.models) ? page.models : []));
    const nextCursor = String(page.nextCursor || '').trim() || null;
    truncated ||= page.truncated === true;
    if (!nextCursor) {
      complete = page.complete === true && !truncated;
      break;
    }
    if (seenCursors.has(nextCursor)) {
      truncated = true;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (cursor && !complete) {
    truncated = true;
  }
  return {
    source: 'provider',
    authority: 'authoritative',
    complete,
    truncated,
    nextCursor: complete ? null : cursor,
    stale: false,
    fetchedAt: nowIso(),
    models,
  };
}

async function requestHostBindingPreflight(hostId, expectedBinding = null) {
  const host = state.hosts.get(hostId);
  if (!host?.capabilities?.bindingPreflight) {
    throw new SessionContractError(
      'session_api_binding_unavailable',
      'This Host agent cannot attest its current API binding.',
      { canRebind: true }
    );
  }
  const requestId = makeId();
  const pending = awaitBindingPreflightRequest(requestId);
  enqueueCommand(hostId, {
    type: 'host.binding_preflight',
    requestId,
    expectedBinding: publicBinding(expectedBinding),
  });
  const payload = await pending;
  if (!payload.ok || !payload.binding?.bindingFingerprint) {
    throw new SessionContractError(
      payload.code || 'session_api_binding_unavailable',
      payload.error || 'The Host API binding could not be verified.',
      {
        sessionBinding: publicBinding(expectedBinding),
        submittedBinding: publicBinding(payload.binding),
        canRebind: payload.canRebind !== false,
      }
    );
  }
  return publicBinding(payload.binding);
}

function assertHostSupportsSessionApiRebind(hostId, apiConfig = null) {
  const capabilities = state.hosts.get(hostId)?.capabilities || {};
  const missing = [];
  if (capabilities.sessionApiRebindV1 !== true) missing.push('sessionApiRebindV1');
  if (capabilities.runApiBinding !== true) missing.push('runApiBinding');
  if (capabilities.apiCatalog !== true) missing.push('apiCatalog');
  if (!apiConfig && capabilities.bindingPreflight !== true) missing.push('bindingPreflight');
  if (!missing.length) {
    return true;
  }
  throw new SessionContractError(
    'session_api_rebind_capability_unavailable',
    `Restart or update this Host Agent before binding an existing Session to an API. Missing: ${missing.join(', ')}.`,
    { statusCode: 409, canRebind: false }
  );
}

function assertNoExplicitRebindRuntimeOverride(body = {}) {
  const command = String(body.command || '').trim();
  const args = Array.isArray(body.args) ? body.args.filter((value) => String(value || '').trim()) : [];
  if (!command && !args.length) {
    return true;
  }
  throw new SessionContractError(
    'session_rebind_runtime_override_unsupported',
    'Session Rebind must use the Host Agent default Codex app-server runtime.',
    { statusCode: 400, canRebind: true }
  );
}

function publicModelCatalog(catalog) {
  return {
    models: Array.isArray(catalog?.models) ? catalog.models : [],
    sources: Array.isArray(catalog?.sources) ? catalog.sources : [],
    providerKind: catalog?.providerKind || null,
    defaultModel: catalog?.defaultModel || null,
    cacheState: catalog?.cacheState || 'miss',
    savedAt: catalog?.savedAt || null,
    allowProviderModelsWithoutLive: catalog?.allowProviderModelsWithoutLive === true,
  };
}

function assertFreshProviderCatalog(catalog, submittedBinding) {
  const providerSource = (Array.isArray(catalog?.sources) ? catalog.sources : [])
    .find((source) => source?.source === 'provider' && source.stale !== true);
  if (providerSource && !providerSource.error) {
    return;
  }
  const detail = String(providerSource?.error || '').trim();
  throw new SessionContractError(
    'session_api_binding_unavailable',
    detail
      ? `The selected API profile could not list models: ${detail}`
      : 'The selected API profile did not return a current provider model catalog.',
    {
      submittedBinding: publicBinding(submittedBinding),
      canRebind: true,
    }
  );
}

function awaitSkillListRequest(requestId, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingSkillRequests.delete(requestId);
      reject(new Error('skill list request timed out while waiting for host-agent / Codex app-server to respond'));
    }, timeoutMs);

    state.pendingSkillRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingSkillRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingSkillRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitHostSkillRequest(requestId, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingHostSkillRequests.delete(requestId);
      reject(new Error('host skills request timed out while waiting for host-agent to respond'));
    }, timeoutMs);

    state.pendingHostSkillRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingHostSkillRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingHostSkillRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitGoalRequest(requestId, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingGoalRequests.delete(requestId);
      reject(new Error('goal request timed out while waiting for host-agent / Codex app-server to respond'));
    }, timeoutMs);

    state.pendingGoalRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingGoalRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingGoalRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitSessionDetailRequest(requestId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingSessionDetailRequests.delete(requestId);
      reject(new Error('session detail request timed out while waiting for host-agent to read history'));
    }, timeoutMs);

    state.pendingSessionDetailRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingSessionDetailRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingSessionDetailRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitSessionSearchRequest(requestId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingSessionSearchRequests.delete(requestId);
      reject(new Error('session search timed out while waiting for host-agent to scan history'));
    }, timeoutMs);

    state.pendingSessionSearchRequests.set(requestId, {
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingSessionSearchRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingSessionSearchRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function awaitFileRequest(requestId, timeoutMs = 120000, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingFileRequests.delete(requestId);
      reject(new Error('file transfer request timed out'));
    }, timeoutMs);

    state.pendingFileRequests.set(requestId, {
      suppressAlert: options.suppressAlert === true,
      source: options.source || null,
      resolve: (payload) => {
        clearTimeout(timer);
        state.pendingFileRequests.delete(requestId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timer);
        state.pendingFileRequests.delete(requestId);
        reject(error);
      },
    });
  });
}

function resolvePendingFileRequest(requestId, payload) {
  const pending = state.pendingFileRequests.get(requestId);
  if (pending) {
    pending.resolve(payload);
  }
}

function rejectPendingFileRequest(requestId, message) {
  const pending = state.pendingFileRequests.get(requestId);
  if (pending) {
    pending.reject(new Error(message || 'file transfer failed'));
  }
}

function removeQueuedFileCommand(hostId, requestId) {
  if (!hostId || !requestId) {
    return;
  }
  const queue = state.commandQueues.get(hostId);
  if (!queue?.length) {
    return;
  }
  state.commandQueues.set(
    hostId,
    queue.filter((command) => String(command.requestId || '') !== String(requestId))
  );
}

function validateUploadFiles(rawFiles) {
  const files = [];
  let totalBytes = 0;
  for (const rawFile of Array.isArray(rawFiles) ? rawFiles.slice(0, 8) : []) {
    if (!rawFile || typeof rawFile !== 'object') {
      continue;
    }
    const name = safeFileDisplayName(rawFile.name || 'upload');
    const dataBase64 = String(rawFile.dataBase64 || '').replace(/^data:[^,]+,/, '').trim();
    if (!dataBase64) {
      continue;
    }
    const size = Number(rawFile.size || 0) || Math.floor(dataBase64.length * 0.75);
    if (size > MAX_FILE_TRANSFER_BYTES) {
      throw new Error(`${name} is too large; limit is ${MAX_FILE_TRANSFER_BYTES} bytes per file`);
    }
    totalBytes += size;
    if (totalBytes > MAX_FILE_TRANSFER_BYTES) {
      throw new Error(`uploaded files are too large; total limit is ${MAX_FILE_TRANSFER_BYTES} bytes`);
    }
    files.push({
      fileId: String(rawFile.fileId || rawFile.id || makeId()).trim(),
      name,
      mime: String(rawFile.mime || rawFile.type || 'application/octet-stream').trim() || 'application/octet-stream',
      size,
      dataBase64,
    });
  }
  return files;
}

function validateChunkedUploadMetadata(body = {}) {
  const size = Number(body.size || 0) || 0;
  if (size < 0 || size > MAX_CHUNKED_FILE_TRANSFER_BYTES) {
    throw new Error(`file is too large for chunked transfer (${size} bytes); limit is ${MAX_CHUNKED_FILE_TRANSFER_BYTES} bytes`);
  }
  const name = safeFileDisplayName(body.name || 'upload');
  return {
    fileId: String(body.fileId || body.id || makeId()).trim(),
    name,
    mime: String(body.mime || body.type || 'application/octet-stream').trim() || 'application/octet-stream',
    size,
  };
}

function getChunkedUpload(hostId, uploadId) {
  const upload = state.chunkedUploads.get(uploadId);
  if (!upload || upload.hostId !== hostId) {
    return null;
  }
  return upload;
}

function validateChunkPayload(body = {}) {
  const dataBase64 = String(body.dataBase64 || '').replace(/^data:[^,]+,/, '').trim();
  const estimatedBytes = Math.floor(dataBase64.length * 0.75);
  if (estimatedBytes > FILE_TRANSFER_CHUNK_BYTES + 3) {
    throw new Error(`file chunk is too large; limit is ${FILE_TRANSFER_CHUNK_BYTES} bytes`);
  }
  return {
    index: Number(body.index || 0) || 0,
    offset: Number(body.offset || 0) || 0,
    dataBase64,
  };
}

function waitForStreamDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function requestHostFileDownloadInfo(hostId, sessionId, remotePath, cwd, inline) {
  const requestId = makeId();
  const pending = awaitFileRequest(requestId, 120000, {
    suppressAlert: inline,
    source: 'download-info',
  });
  enqueueCommand(hostId, {
    type: 'host.file_download_info',
    requestId,
    sessionId,
    path: remotePath,
    cwd,
  });
  return pending;
}

async function streamHostFileDownload(res, {
  hostId,
  sessionId,
  remotePath,
  cwd,
  inline,
  info,
}) {
  const filename = safeFileDisplayName(info.name || info.path || remotePath);
  const size = Number(info.size || 0) || 0;
  if (size > MAX_CHUNKED_FILE_TRANSFER_BYTES) {
    throw new Error(`file is too large to stream (${size} bytes); limit is ${MAX_CHUNKED_FILE_TRANSFER_BYTES} bytes`);
  }

  let cachePath = '';
  let cacheFd = null;
  let cacheCommitted = false;
  if (size > 0 && size <= CHUNKED_FILE_CACHE_MAX_BYTES) {
    const cacheDirectory = path.join(RECEIVED_FILES_ROOT, safePathSegment(hostId, 'host'), safePathSegment(sessionId || '', 'session'));
    fs.mkdirSync(cacheDirectory, { recursive: true });
    cachePath = path.resolve(cacheDirectory, `.partial-${makeId()}-${filename}`);
    if (pathInside(RECEIVED_FILES_ROOT, cachePath)) {
      cacheFd = fs.openSync(cachePath, 'w');
    } else {
      cachePath = '';
    }
  }

  res.writeHead(200, {
    'Content-Type': info.mime || 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': contentDispositionValue(inline ? 'inline' : 'attachment', filename),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'X-Codex-Remote-Path': encodeURIComponent(remotePath || ''),
    'X-Codex-Transfer-Mode': 'chunked',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    let offset = 0;
    while (offset < size) {
      if (res.destroyed || res.writableEnded) {
        return;
      }
      const length = Math.min(FILE_TRANSFER_CHUNK_BYTES, size - offset);
      const requestId = makeId();
      const pending = awaitFileRequest(requestId, 120000, {
        suppressAlert: true,
        source: 'download-chunk',
      });
      enqueueCommand(hostId, {
        type: 'host.file_download_chunk',
        requestId,
        sessionId,
        path: remotePath,
        cwd,
        offset,
        length,
      });
      const chunk = await pending;
      const chunkOffset = Number(chunk.offset || 0) || 0;
      const buffer = Buffer.from(String(chunk.dataBase64 || ''), 'base64');
      if (chunkOffset !== offset) {
        throw new Error(`download chunk offset mismatch: expected ${offset}, got ${chunkOffset}`);
      }
      if (!buffer.length && length > 0) {
        throw new Error('download chunk was empty before the file ended');
      }
      if (cacheFd !== null) {
        fs.writeSync(cacheFd, buffer, 0, buffer.length, offset);
      }
      offset += buffer.length;
      if (!res.write(buffer)) {
        await waitForStreamDrain(res);
      }
    }
    if (cacheFd !== null) {
      fs.closeSync(cacheFd);
      cacheFd = null;
      try {
        storeReceivedFileFromPath({
          hostId,
          sessionId: sessionId || '',
          remotePath,
          name: filename,
          mime: info.mime || 'application/octet-stream',
          localPath: cachePath,
          size,
        });
        cacheCommitted = true;
      } catch (error) {
        console.warn(`[relay] failed to cache streamed file ${remotePath}: ${error.message}`);
      }
    }
    res.end();
  } finally {
    if (cacheFd !== null) {
      try {
        fs.closeSync(cacheFd);
      } catch {}
    }
    if (cachePath && !cacheCommitted && fs.existsSync(cachePath)) {
      try {
        fs.unlinkSync(cachePath);
      } catch {}
    }
  }
}

function contentDispositionValue(disposition, filename) {
  const name = safeFileDisplayName(filename || 'download');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function receivedFileIsExpired(record, now = Date.now()) {
  const expiresAt = record?.expiresAt ? Date.parse(record.expiresAt) : 0;
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

function pruneReceivedFiles() {
  const root = path.resolve(RECEIVED_FILES_ROOT);
  let changed = false;
  for (const [fileId, record] of state.receivedFiles) {
    const localPath = record?.localPath ? path.resolve(record.localPath) : '';
    const expired = receivedFileIsExpired(record);
    const missing = !localPath || !fs.existsSync(localPath);
    if (!expired && !missing) {
      continue;
    }
    if (expired && localPath && pathInside(root, localPath) && fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch {
        // The manifest is still updated below; stale files can be retried later.
      }
    }
    state.receivedFiles.delete(fileId);
    changed = true;
  }
  if (changed) {
    saveReceivedFiles();
  }
}

function findReceivedFile(hostId, sessionId, remotePath) {
  pruneReceivedFiles();
  const normalizedHost = String(hostId || '');
  const normalizedSession = String(sessionId || '');
  const normalizedRemotePath = normalizeRemoteFilePath(remotePath);
  for (const record of state.receivedFiles.values()) {
    if (
      record.hostId === normalizedHost
      && record.sessionId === normalizedSession
      && normalizeRemoteFilePath(record.remotePath) === normalizedRemotePath
      && record.localPath
      && fs.existsSync(record.localPath)
    ) {
      return record;
    }
  }
  return null;
}

function storeReceivedFile({ hostId, sessionId, remotePath, name, mime, buffer }) {
  pruneReceivedFiles();
  const fileId = makeId();
  const normalizedRemotePath = normalizeRemoteFilePath(remotePath);
  const filename = safeFileDisplayName(name || normalizedRemotePath || 'download');
  const hostSegment = safePathSegment(hostId, 'host');
  const sessionSegment = safePathSegment(sessionId, 'session');
  const targetDirectory = path.join(RECEIVED_FILES_ROOT, hostSegment, sessionSegment);
  fs.mkdirSync(targetDirectory, { recursive: true });

  const localPath = path.resolve(targetDirectory, `${fileId}-${filename}`);
  if (!pathInside(RECEIVED_FILES_ROOT, localPath)) {
    throw new Error('refusing to cache outside received-files directory');
  }
  fs.writeFileSync(localPath, buffer);

  const expiresAt = new Date(Date.now() + RECEIVED_FILE_TTL_MS).toISOString();
  const existing = findReceivedFile(hostId, sessionId, normalizedRemotePath);
  if (existing?.localPath && pathInside(RECEIVED_FILES_ROOT, existing.localPath) && fs.existsSync(existing.localPath)) {
    try {
      fs.unlinkSync(existing.localPath);
    } catch {
      // The new cache copy is already written; stale files are cleaned by TTL.
    }
    state.receivedFiles.delete(existing.fileId);
  }

  const record = {
    fileId,
    hostId: String(hostId || ''),
    sessionId: String(sessionId || ''),
    remotePath: normalizedRemotePath,
    name: filename,
    mime: String(mime || 'application/octet-stream'),
    size: buffer.length,
    localPath,
    receivedAt: nowIso(),
    lastAccessedAt: nowIso(),
    expiresAt,
  };
  state.receivedFiles.set(fileId, record);
  saveReceivedFiles();
  return record;
}

function storeReceivedFileFromPath({ hostId, sessionId, remotePath, name, mime, localPath, size }) {
  pruneReceivedFiles();
  const sourcePath = path.resolve(localPath || '');
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('received file cache source does not exist');
  }
  const fileId = makeId();
  const normalizedRemotePath = normalizeRemoteFilePath(remotePath);
  const filename = safeFileDisplayName(name || normalizedRemotePath || 'download');
  const hostSegment = safePathSegment(hostId, 'host');
  const sessionSegment = safePathSegment(sessionId, 'session');
  const targetDirectory = path.join(RECEIVED_FILES_ROOT, hostSegment, sessionSegment);
  fs.mkdirSync(targetDirectory, { recursive: true });

  const targetPath = path.resolve(targetDirectory, `${fileId}-${filename}`);
  if (!pathInside(RECEIVED_FILES_ROOT, targetPath)) {
    throw new Error('refusing to cache outside received-files directory');
  }
  if (sourcePath !== targetPath) {
    fs.renameSync(sourcePath, targetPath);
  }

  const existing = findReceivedFile(hostId, sessionId, normalizedRemotePath);
  if (existing?.localPath && pathInside(RECEIVED_FILES_ROOT, existing.localPath) && fs.existsSync(existing.localPath)) {
    try {
      fs.unlinkSync(existing.localPath);
    } catch {
      // The new cache copy is already written; stale files are cleaned by TTL.
    }
    state.receivedFiles.delete(existing.fileId);
  }

  const stats = fs.statSync(targetPath);
  const expiresAt = new Date(Date.now() + RECEIVED_FILE_TTL_MS).toISOString();
  const record = {
    fileId,
    hostId: String(hostId || ''),
    sessionId: String(sessionId || ''),
    remotePath: normalizedRemotePath,
    name: filename,
    mime: String(mime || 'application/octet-stream'),
    size: Number(size || stats.size || 0) || stats.size,
    localPath: targetPath,
    receivedAt: nowIso(),
    lastAccessedAt: nowIso(),
    expiresAt,
  };
  state.receivedFiles.set(fileId, record);
  saveReceivedFiles();
  return record;
}

function serveReceivedFile(res, record, inline) {
  if (!record?.localPath || !fs.existsSync(record.localPath)) {
    sendJson(res, 404, { error: 'received file not found or expired' });
    return;
  }
  record.lastAccessedAt = nowIso();
  state.receivedFiles.set(record.fileId, record);
  saveReceivedFiles();
  const stats = fs.statSync(record.localPath);
  res.writeHead(200, {
    'Content-Type': record.mime || 'application/octet-stream',
    'Content-Length': stats.size,
    'Content-Disposition': contentDispositionValue(inline ? 'inline' : 'attachment', record.name || 'download'),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    'X-Codex-Received-File-Id': record.fileId,
    'X-Codex-Received-Expires-At': record.expiresAt || '',
    'X-Codex-Remote-Path': encodeURIComponent(record.remotePath || ''),
    'Access-Control-Allow-Origin': '*',
  });
  const stream = fs.createReadStream(record.localPath);
  stream.on('error', (error) => {
    res.destroy(error);
  });
  stream.pipe(res);
}

function extensionForImageMime(mime = '') {
  const normalized = String(mime || '').toLowerCase();
  if (normalized === 'image/jpeg') {
    return 'jpg';
  }
  if (normalized === 'image/svg+xml') {
    return 'svg';
  }
  const match = normalized.match(/^image\/([a-z0-9.+-]+)$/);
  return match ? match[1].replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'png' : 'png';
}

function parseDataUrlImage(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) {
    return null;
  }
  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_FILE_TRANSFER_BYTES) {
    return null;
  }
  return { mime, buffer };
}

function cacheInlineImageInputFiles(hostId, sessionId, inputItems = []) {
  const files = [];
  for (const [index, item] of (Array.isArray(inputItems) ? inputItems : []).entries()) {
    if (item?.type !== 'image') {
      continue;
    }
    const parsed = parseDataUrlImage(item.url || item.dataUrl || '');
    if (!parsed) {
      continue;
    }
    const extension = extensionForImageMime(parsed.mime);
    const name = safeFileDisplayName(item.name || `image-${index + 1}.${extension}`, `image-${index + 1}.${extension}`);
    const virtualId = makeId();
    const record = storeReceivedFile({
      hostId,
      sessionId,
      remotePath: `/inline-inputs/${sessionId}/${virtualId}-${name}`,
      name,
      mime: parsed.mime,
      buffer: parsed.buffer,
    });
    files.push({
      fileId: record.fileId,
      name: record.name,
      path: record.remotePath,
      size: record.size,
      mime: record.mime,
      isImage: true,
      cached: true,
      uploadedAt: record.receivedAt,
    });
  }
  return files;
}

function cacheInlineTextFiles(hostId, sessionId, rawFiles = []) {
  const files = [];
  for (const [index, rawFile] of (Array.isArray(rawFiles) ? rawFiles.slice(0, 8) : []).entries()) {
    if (!rawFile || typeof rawFile !== 'object') {
      continue;
    }
    const text = String(rawFile.text || rawFile.content || '');
    if (!text && !rawFile.name) {
      continue;
    }
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length > MAX_FILE_TRANSFER_BYTES) {
      continue;
    }
    const name = safeFileDisplayName(rawFile.name || `attachment-${index + 1}.txt`, `attachment-${index + 1}.txt`);
    const virtualId = makeId();
    const record = storeReceivedFile({
      hostId,
      sessionId,
      remotePath: `/inline-files/${sessionId}/${virtualId}-${name}`,
      name,
      mime: String(rawFile.mime || rawFile.type || 'text/plain; charset=utf-8').trim() || 'text/plain; charset=utf-8',
      buffer,
    });
    files.push({
      fileId: record.fileId,
      name: record.name,
      path: record.remotePath,
      size: record.size,
      mime: record.mime,
      isImage: false,
      cached: true,
      uploadedAt: record.receivedAt,
    });
  }
  return files;
}

function normalizeTurnInputItems(rawItems) {
  const items = [];
  for (const rawItem of Array.isArray(rawItems) ? rawItems.slice(0, 8) : []) {
    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }

    const type = String(rawItem.type || '').trim();
    if (type === 'image') {
      const url = String(rawItem.url || rawItem.dataUrl || '').trim();
      if (url) {
        items.push({
          type: 'image',
          url,
          name: String(rawItem.name || '').trim(),
        });
      }
      continue;
    }

    if (type === 'localImage') {
      const imagePath = String(rawItem.path || '').trim();
      if (imagePath) {
        items.push({
          type: 'localImage',
          path: imagePath,
          name: String(rawItem.name || '').trim(),
        });
      }
      continue;
    }

    if (type === 'mention' || type === 'skill') {
      const name = String(rawItem.name || '').trim();
      const itemPath = String(rawItem.path || '').trim();
      if (name && itemPath) {
        items.push({
          type,
          name,
          path: itemPath,
        });
      }
    }
  }
  return items;
}

function summarizeTurnInput(text, inputItems, files = []) {
  const pieces = [];
  const prompt = String(text || '').trim();
  if (prompt) {
    pieces.push(prompt);
  }

  for (const [index, item] of inputItems.entries()) {
    if (item.type === 'image') {
      pieces.push(`[image ${index + 1}${item.name ? `: ${item.name}` : ''}]`);
    } else if (item.type === 'localImage') {
      pieces.push(`[local image: ${item.path}]`);
    } else if (item.type === 'mention') {
      pieces.push(`[mention: ${item.name}]`);
    } else if (item.type === 'skill') {
      pieces.push(`[skill: ${item.name}]`);
    }
  }

  for (const file of files) {
    const label = file.path || file.name || 'file';
    pieces.push(`[uploaded file: ${label}]`);
  }

  return pieces.join('\n').trim().slice(0, 4000);
}

function normalizeReviewTarget(input = {}) {
  const rawTarget = input.target && typeof input.target === 'object' ? input.target : input;
  const type = String(rawTarget.type || input.targetType || 'uncommittedChanges').trim();

  if (type === 'baseBranch') {
    const branch = String(rawTarget.branch || input.branch || '').trim();
    if (!branch) {
      throw new Error('baseBranch review requires branch');
    }
    return { type, branch };
  }

  if (type === 'commit') {
    const sha = String(rawTarget.sha || input.sha || '').trim();
    if (!sha) {
      throw new Error('commit review requires sha');
    }
    return {
      type,
      sha,
      title: String(rawTarget.title || input.title || '').trim() || null,
    };
  }

  if (type === 'custom') {
    const instructions = String(rawTarget.instructions || input.instructions || '').trim();
    if (!instructions) {
      throw new Error('custom review requires instructions');
    }
    return { type, instructions };
  }

  return { type: 'uncommittedChanges' };
}

function earliestIso(...values) {
  let best = null;
  let bestTime = Infinity;
  for (const value of values) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time) || time >= bestTime) {
      continue;
    }
    bestTime = time;
    best = value;
  }
  return best;
}

function resolveSessionCreatedAt(existing, patch) {
  if (!Object.prototype.hasOwnProperty.call(patch || {}, 'createdAt')) {
    return existing?.createdAt || null;
  }
  if (!patch.createdAt) {
    return existing?.source === 'managed' ? existing.createdAt || null : null;
  }
  return earliestIso(existing?.createdAt, patch.createdAt) || patch.createdAt;
}

function upsertSession(hostId, patch, options = {}) {
  const ownershipIdentities = sessionOwnershipIdentityValues(patch);
  const preserveManagedLive = options.preserveManagedLive !== false;
  const managedLiveMatch = preserveManagedLive && patch.source !== 'managed' && patch.live !== true
    ? findManagedLiveSessionByIdentities(hostId, ownershipIdentities)
    : null;
  const canonicalSessionId = managedLiveMatch?.sessionId || resolveSessionId(hostId, patch.sessionId) || patch.sessionId;
  if (managedLiveMatch && patch.sessionId !== canonicalSessionId) {
    rememberSessionAlias(hostId, patch.sessionId, canonicalSessionId);
  }
  const key = resolveSessionKey(hostId, canonicalSessionId);
  const existing = state.sessions.get(key) || {
    hostId,
    sessionId: canonicalSessionId,
    title: patch.title || canonicalSessionId,
    cwd: patch.cwd || null,
    createdAt: patch.createdAt || null,
    source: patch.source || 'imported',
    state: patch.state || 'unknown',
    live: Boolean(patch.live),
    lastUpdatedAt: nowIso(),
  };

  const next = {
    ...existing,
    ...patch,
    hostId,
    sessionId: canonicalSessionId,
    title: resolveSessionTitle(hostId, existing, patch),
    createdAt: resolveSessionCreatedAt(existing, patch),
    lastUpdatedAt: patch.lastUpdatedAt || nowIso(),
  };

  if (managedLiveMatch && existing.live) {
    next.source = existing.source || 'managed';
    next.state = existing.state || 'running';
    next.live = true;
    next.runtime = existing.runtime || next.runtime || null;
  }

  const patchConversationKey = patch.conversationKey ? String(patch.conversationKey) : '';
  const patchConversationKeyIsIdentity = Boolean(patchConversationKey && patchConversationKey === patch.sessionId);
  const patchHasExplicitLineage = Boolean(
    patch.originSessionId
    || patch.sourceSessionId
    || (patchConversationKey && !patchConversationKeyIsIdentity)
  );
  if (!patch.originSessionId && existing.originSessionId) {
    next.originSessionId = existing.originSessionId;
  }
  if (!patch.sourceSessionId && existing.sourceSessionId) {
    next.sourceSessionId = existing.sourceSessionId;
  }
  if (
    existing.conversationKey
    && (!patchConversationKey || patchConversationKey === patch.sessionId)
    && !patchHasExplicitLineage
  ) {
    next.conversationKey = existing.conversationKey;
  }

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
  rememberSessionIdentityAliases(hostId, next);
  return next;
}

function enqueueCommand(hostId, command, options = {}) {
  const queue = state.commandQueues.get(hostId) || [];
  const next = {
    ...command,
    id: state.nextCommandId++,
    createdAt: nowIso(),
    priority: commandPriority(command),
  };
  if (next.type === 'session.input' && next.clientRequestId) {
    try {
      state.inputCommandOutbox.recordQueued({
        hostId,
        scopeKey: String(options.inputScopeKey || '').trim(),
        clientRequestId: next.clientRequestId,
        fingerprint: String(options.inputFingerprint || '').trim(),
        command: next,
        transcriptProjection: options.transcriptProjection,
      });
    } catch (cause) {
      const error = new SessionContractError(
        cause?.code || 'input_command_persistence_failed',
        String(cause?.code || '').startsWith('input_command_outbox_')
          ? (cause.message || 'The prompt could not be stored in the durable input queue.')
          : 'The prompt could not be stored in the durable input queue. Retry after Relay storage recovers.',
        { statusCode: 503 }
      );
      error.cause = cause;
      throw error;
    }
  }
  queue.push(next);
  state.commandQueues.set(hostId, pruneCommandQueue(queue));
  return next;
}

function commandPriority(command) {
  return HIGH_PRIORITY_COMMAND_TYPES.has(String(command?.type || ''))
    ? COMMAND_PRIORITY.high
    : COMMAND_PRIORITY.normal;
}

function markSessionClosed(hostId, sessionId, stateName = 'history-only') {
  const existing = getSession(hostId, sessionId);
  const next = upsertSession(hostId, {
    sessionId,
    state: stateName,
    live: false,
    runId: existing?.runId || null,
    lastUpdatedAt: nowIso(),
  }, { preserveManagedLive: false });
  const runtime = setSessionRuntime(hostId, sessionId, {
    phase: 'closed',
    connection: 'closed',
    busy: false,
    activeTurnId: null,
    currentTurnStatus: 'closed',
    waitingOnApproval: false,
    waitingOnUserInput: false,
    runId: existing?.runId || null,
    updatedAt: nowIso(),
  });
  broadcastSessionEvent(hostId, sessionId, 'session.runtime_updated', {
    hostId,
    sessionId,
    patch: runtime,
    timestamp: nowIso(),
  });
  broadcastSessionEvent(hostId, sessionId, 'session.snapshot', next);
  return next;
}

function getCurrentSessionRunId(hostId, sessionId) {
  const record = state.provenance?.getSessionRecord({ hostId, sessionId });
  const publishedLive = publishedLiveSessionRun(hostId, sessionId, record);
  if (publishedLive) {
    return publishedLive.runId;
  }
  const durableRun = record?.activeRunId ? record.runs?.[record.activeRunId] : null;
  if (durableRun && ['pending', 'live'].includes(durableRun.status)) {
    return record.activeRunId;
  }
  const session = getSession(hostId, sessionId);
  const runtime = state.sessionRuntime.get(sessionKey(hostId, sessionId))
    || state.sessionRuntime.get(resolveSessionKey(hostId, sessionId))
    || null;
  return session?.runId || runtime?.runId || null;
}

function isStaleSessionRunEvent(event, effectiveSessionId) {
  if (!event?.runId) {
    return false;
  }
  const currentRunId = getCurrentSessionRunId(event.hostId, effectiveSessionId);
  return Boolean(currentRunId && currentRunId !== event.runId);
}

function isDuplicateManagedStartFailureError(event, effectiveSessionId, message) {
  const runId = String(event?.runId || '').trim();
  const session = getSession(event?.hostId, effectiveSessionId);
  const resumeError = session?.resumeError;
  if (
    !runId
    || String(session?.runId || '').trim() !== runId
    || resumeError?.stage !== 'start'
  ) {
    return false;
  }
  const record = state.provenance?.getSessionRecord({
    hostId: event.hostId,
    sessionId: effectiveSessionId,
  });
  if (record?.runs?.[runId]?.status !== 'failed') {
    return false;
  }
  const structuredMessage = String(resumeError.error || '').trim();
  const runtimeMessage = String(message || '').trim();
  return Boolean(
    structuredMessage
    && runtimeMessage
    && (
      runtimeMessage === structuredMessage
      || runtimeMessage.endsWith(structuredMessage)
      || structuredMessage.endsWith(runtimeMessage)
    )
  );
}

function eventTargetsPublishedParentRun(event, effectiveSessionId) {
  const eventRunId = String(event?.runId || '').trim();
  if (!eventRunId) {
    return false;
  }
  const record = state.provenance?.getSessionRecord({
    hostId: event.hostId,
    sessionId: effectiveSessionId,
  });
  const activeRunId = String(record?.activeRunId || '').trim();
  const activeRun = activeRunId ? record?.runs?.[activeRunId] || null : null;
  const projectedRunId = String(getSession(event.hostId, effectiveSessionId)?.runId || '').trim();
  return Boolean(
    activeRun?.status === 'pending'
    && activeRun.parentRunId === eventRunId
    && projectedRunId === activeRunId
  );
}

function sessionAgeMs(session) {
  const timestamp = Date.parse(session?.lastUpdatedAt || session?.createdAt || '');
  return Number.isFinite(timestamp) ? Date.now() - timestamp : Infinity;
}

async function stopSessionRunDurably(hostId, sessionId, runId = null, options = {}) {
  if (!state.provenance) {
    return false;
  }
  const session = getSession(hostId, sessionId);
  const record = state.provenance.getSessionRecord({ hostId, sessionId });
  const effectiveRunId = runId || session?.runId || record?.activeRunId || null;
  if (!effectiveRunId) {
    return false;
  }
  const run = record?.runs?.[effectiveRunId] || null;
  if (!run || ['failed', 'stopped'].includes(run.status)) {
    return false;
  }
  try {
    const stopped = await state.provenance.stopRun({
      identity: {
        hostId,
        sessionId: session?.bridgeSessionId || session?.sessionId || sessionId,
      },
      runId: effectiveRunId,
      commitGuard: options.commitGuard,
    });
    return stopped.guardRejected !== true;
  } catch (error) {
    if (error?.code === 'session_run_not_found') {
      return false;
    }
    throw error;
  }
}

async function closeMissingDiscoveredRun(hostId, sessionId, runId, run, closeToken) {
  const expectedBindingFingerprint = bindingFingerprint(run?.apiBinding);
  try {
    const stopped = await state.provenance.stopRun({
      identity: { hostId, sessionId },
      runId,
      requireExpectedRun: true,
      expectedRunId: runId,
      expectedRunStatus: 'live',
      expectedRunStatusProvided: true,
      expectedBindingFingerprint,
      expectedBindingProvided: Boolean(expectedBindingFingerprint),
      commitGuard: () => claimManagedDiscoveryCloseToken(closeToken),
    });
    if (stopped.guardRejected === true) {
      return false;
    }
  } catch (error) {
    if ([
      'session_run_changed',
      'session_run_not_found',
      'session_run_pending',
      'session_run_state_conflict',
      'session_run_stopping',
    ].includes(error?.code)) {
      return false;
    }
    throw error;
  }

  if (!managedDiscoveryCloseTokenIsCurrent(closeToken)) {
    return false;
  }
  const currentRecord = state.provenance.getSessionRecord({ hostId, sessionId });
  const currentRun = currentRecord?.runs?.[runId] || null;
  if (currentRecord?.activeRunId || currentRun?.status !== 'stopped') {
    return false;
  }
  const projected = getSession(hostId, sessionId);
  if (projected?.runId && projected.runId !== runId) {
    return false;
  }
  markSessionClosed(hostId, sessionId);
  return true;
}

function managedDiscoveryRunKey(hostId, sessionId, runId) {
  return `${hostId}\0${runId || `session:${sessionId}`}`;
}

const RUNLESS_MANAGED_DISCOVERY_PRESENCE = Symbol('runless-managed-discovery-presence');

function noteManagedDiscoveryRunPresence(presence, session, options = {}) {
  if (!session?.live || session.source !== 'managed') {
    return;
  }
  const runId = String(session.runId || session.runtime?.runId || '').trim();
  if (!runId && options.allowRunlessWildcard !== true) {
    return;
  }
  const runToken = runId || RUNLESS_MANAGED_DISCOVERY_PRESENCE;
  for (const identity of sessionOwnershipIdentityValues(session)) {
    const runIds = presence.get(identity) || new Set();
    runIds.add(runToken);
    presence.set(identity, runIds);
  }
}

function managedDiscoveryReportsRun(presence, identities, runId) {
  const normalizedRunId = String(runId || '').trim();
  return identities.some((identity) => {
    const runIds = presence.get(String(identity || '').trim());
    if (!runIds) {
      return false;
    }
    return runIds.has(normalizedRunId)
      || runIds.has(RUNLESS_MANAGED_DISCOVERY_PRESENCE);
  });
}

function managedDiscoveryCloseTokenIsCurrent(token) {
  return Boolean(
    token?.kind === 'closing'
    && token.key
    && state.missingManagedDiscoveryRuns.get(token.key) === token
  );
}

function claimManagedDiscoveryCloseToken(token) {
  if (!managedDiscoveryCloseTokenIsCurrent(token)) {
    return false;
  }
  token.commitStarted = true;
  return true;
}

function invalidateManagedDiscoveryMissingRun(key) {
  const current = state.missingManagedDiscoveryRuns.get(key) || null;
  if (current?.kind === 'closing' && current.commitStarted === true) {
    return false;
  }
  return state.missingManagedDiscoveryRuns.delete(key);
}

function releaseManagedDiscoveryCloseToken(token) {
  if (managedDiscoveryCloseTokenIsCurrent(token)) {
    state.missingManagedDiscoveryRuns.delete(token.key);
  }
}

async function applyConfirmedManagedDiscoveryClose(token, operation) {
  if (!managedDiscoveryCloseTokenIsCurrent(token)) {
    return false;
  }
  if (TEST_MANAGED_DISCOVERY_CLOSE_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, TEST_MANAGED_DISCOVERY_CLOSE_DELAY_MS));
  }
  if (!managedDiscoveryCloseTokenIsCurrent(token)) {
    return false;
  }
  try {
    return await operation();
  } finally {
    releaseManagedDiscoveryCloseToken(token);
  }
}

function noteManagedRunPresent(evaluation, key) {
  evaluation.seen.add(key);
  evaluation.decisions.set(key, null);
  invalidateManagedDiscoveryMissingRun(key);
}

function confirmManagedRunMissing(evaluation, key, discoveryId = '') {
  evaluation.seen.add(key);
  if (evaluation.decisions.has(key)) return evaluation.decisions.get(key);
  const now = Date.now();
  const previous = state.missingManagedDiscoveryRuns.get(key) || null;
  const normalizedDiscoveryId = String(discoveryId || '').trim().slice(0, 512);
  if (previous?.kind === 'closing') {
    evaluation.decisions.set(key, null);
    return null;
  }
  const repeatedSnapshot = Boolean(
    normalizedDiscoveryId
    && previous?.discoveryId
    && previous.discoveryId === normalizedDiscoveryId
  );
  const confirmed = Boolean(
    previous
    && !repeatedSnapshot
    && now - Number(previous.lastMissingAt || 0) >= MISSING_MANAGED_DISCOVERY_CONFIRMATION_MS
  );
  let closeToken = null;
  if (confirmed) {
    closeToken = {
      kind: 'closing',
      key,
      confirmedAt: now,
      discoveryId: normalizedDiscoveryId || null,
    };
    state.missingManagedDiscoveryRuns.set(key, closeToken);
  } else if (!previous) {
    state.missingManagedDiscoveryRuns.set(key, {
      kind: 'missing',
      lastMissingAt: now,
      discoveryId: normalizedDiscoveryId || null,
    });
  }
  evaluation.decisions.set(key, closeToken);
  return closeToken;
}

function pruneManagedDiscoveryMissingRuns(hostId, seen) {
  const prefix = `${hostId}\0`;
  for (const key of state.missingManagedDiscoveryRuns.keys()) {
    if (key.startsWith(prefix) && !seen.has(key)) {
      invalidateManagedDiscoveryMissingRun(key);
    }
  }
}

async function closeManagedSessionsMissingFromDiscovery(hostId, managedRunPresence, options = {}) {
  let closedCount = 0;
  const evaluation = { decisions: new Map(), seen: new Set() };
  const discoveryId = String(options.discoveryId || '').trim();
  for (const session of Array.from(state.sessions.values())) {
    if (session.hostId !== hostId || session.source !== 'managed' || !session.live) {
      continue;
    }
    const record = state.provenance?.getSessionRecord({ hostId, sessionId: session.sessionId });
    const runId = String(session.runId || record?.activeRunId || '').trim();
    const run = runId ? record?.runs?.[runId] || null : null;
    const missingKey = managedDiscoveryRunKey(hostId, session.sessionId, runId);
    if (managedDiscoveryReportsRun(
      managedRunPresence,
      sessionOwnershipIdentityValues(session),
      runId
    )) {
      noteManagedRunPresent(evaluation, missingKey);
      continue;
    }
    if (session.state === 'starting' && sessionAgeMs(session) < STALE_MANAGED_SESSION_GRACE_MS) {
      noteManagedRunPresent(evaluation, missingKey);
      continue;
    }
    const closeToken = confirmManagedRunMissing(evaluation, missingKey, discoveryId);
    if (!closeToken) {
      continue;
    }
    if (run?.status === 'live') {
      const closed = await applyConfirmedManagedDiscoveryClose(closeToken, () => (
        closeMissingDiscoveredRun(hostId, session.sessionId, runId, run, closeToken)
      ));
      if (closed) {
        closedCount += 1;
      }
      continue;
    }
    const closed = await applyConfirmedManagedDiscoveryClose(closeToken, async () => {
      const expectedProjection = session;
      const stopped = await stopSessionRunDurably(hostId, session.sessionId, runId || null, {
        commitGuard: () => claimManagedDiscoveryCloseToken(closeToken),
      });
      if (!managedDiscoveryCloseTokenIsCurrent(closeToken)) {
        return false;
      }
      const currentRecord = state.provenance?.getSessionRecord({
        hostId,
        sessionId: session.sessionId,
      });
      const projected = getSession(hostId, session.sessionId);
      if (runId && currentRecord?.activeRunId) {
        return false;
      }
      if (runId && projected?.runId && projected.runId !== runId) {
        return false;
      }
      if (!runId && projected !== expectedProjection) {
        return false;
      }
      if (runId && !stopped && currentRecord?.runs?.[runId]?.status === 'live') {
        return false;
      }
      markSessionClosed(hostId, session.sessionId);
      return true;
    });
    if (closed) {
      closedCount += 1;
    }
  }
  const snapshot = state.sessionRecordStore?.readSnapshot();
  for (const [canonicalKey, record] of Object.entries(snapshot?.records || {})) {
    if (record?.hostId !== hostId || record.source !== 'managed') {
      continue;
    }
    const runId = String(record.activeRunId || '').trim();
    const run = runId ? record.runs?.[runId] || null : null;
    if (run?.status !== 'live') {
      continue;
    }
    const prefix = `${hostId}::`;
    const canonicalSessionId = canonicalKey.startsWith(prefix)
      ? canonicalKey.slice(prefix.length)
      : '';
    const identities = [
      record.bridgeSessionId,
      record.nativeThreadId,
      record.conversationKey,
      canonicalSessionId,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    if (managedDiscoveryReportsRun(managedRunPresence, identities, runId)) {
      noteManagedRunPresent(evaluation, managedDiscoveryRunKey(hostId, canonicalSessionId, runId));
      continue;
    }
    const sessionId = record.bridgeSessionId
      || record.nativeThreadId
      || record.conversationKey
      || canonicalSessionId;
    if (!sessionId) {
      continue;
    }
    const missingKey = managedDiscoveryRunKey(hostId, canonicalSessionId || sessionId, runId);
    const closeToken = confirmManagedRunMissing(evaluation, missingKey, discoveryId);
    if (!closeToken) {
      continue;
    }
    const closed = await applyConfirmedManagedDiscoveryClose(closeToken, () => (
      closeMissingDiscoveredRun(hostId, sessionId, runId, run, closeToken)
    ));
    if (closed) {
      closedCount += 1;
    }
  }
  pruneManagedDiscoveryMissingRuns(hostId, evaluation.seen);
  if (closedCount > 0) {
    console.log(`[relay] closed ${closedCount} stale managed session(s) for ${hostId} after discovery`);
  }
}

function scheduleStopFallback(hostId, sessionId, options = {}) {
  if (relayStopping) {
    return null;
  }
  const expectedRunId = String(options.runId || getSession(hostId, sessionId)?.runId || '').trim() || null;
  const stopRequestId = String(options.stopRequestId || '').trim() || null;
  const delayMs = Number(options.delayMs || SESSION_STOP_FALLBACK_MS);
  const timer = setTimeout(() => {
    stopFallbackTimers.delete(timer);
    if (relayStopping) {
      return;
    }
    trackRelayBackgroundTask((async () => {
      const session = getSession(hostId, sessionId);
      const runtime = state.sessionRuntime.get(sessionKey(hostId, sessionId)) || null;
      if (expectedRunId && session?.runId && session.runId !== expectedRunId) {
        return;
      }

      const record = state.provenance?.getSessionRecord({ hostId, sessionId });
      const run = expectedRunId ? record?.runs?.[expectedRunId] || null : null;
      if (run?.status === 'stopped') {
        markSessionClosed(hostId, sessionId);
        return;
      }
      if (stopRequestId && run?.stopRequestId !== stopRequestId) {
        return;
      }
      if (!stopRequestId && (!session?.live || (session.state !== 'ending' && runtime?.phase !== 'ending'))) {
        return;
      }

      const delayed = upsertSession(hostId, {
        sessionId: session?.sessionId || sessionId,
        state: 'ending',
        live: true,
        runId: expectedRunId,
        lastUpdatedAt: nowIso(),
      });
      const delayedRuntime = setSessionRuntime(hostId, delayed.sessionId, {
        ...(runtime || {}),
        phase: 'ending',
        connection: 'closing',
        busy: false,
        activeTurnId: null,
        currentTurnStatus: 'stopping',
        waitingOnApproval: false,
        waitingOnUserInput: false,
        pendingInputSummary: null,
        queuedCommandId: null,
        stopDelayed: true,
        stopDelayedAt: nowIso(),
        runId: expectedRunId || runtime?.runId || null,
        updatedAt: nowIso(),
      });
      broadcastSessionEvent(hostId, delayed.sessionId, 'session.runtime_updated', {
        hostId,
        sessionId: delayed.sessionId,
        patch: delayedRuntime,
        timestamp: nowIso(),
      });
      broadcastSessionEvent(hostId, delayed.sessionId, 'session.snapshot', delayed);
      emitSessionAlert(hostId, delayed.sessionId, {
        severity: 'warning',
        source: 'relay',
        message: 'Stop is taking longer than expected. The Session remains unavailable for new prompts until the Host confirms success or failure.',
        timestamp: nowIso(),
      });
    })()).catch((error) => {
      console.error(`[relay] failed to reconcile unconfirmed Stop for ${hostId}/${sessionId}: ${error.message || error}`);
    });
  }, delayMs);
  stopFallbackTimers.add(timer);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

function projectStopFailedSession(hostId, sessionId, options = {}) {
  const timestamp = options.timestamp || nowIso();
  const currentSession = getSession(hostId, sessionId);
  const effectiveSessionId = currentSession?.sessionId || resolveSessionId(hostId, sessionId) || sessionId;
  const runId = String(options.runId || currentSession?.runId || '').trim() || null;
  const message = String(
    options.message
      || 'The Host could not confirm that this Session stopped. Retry Stop, then Resume the Session.'
  );
  const failedSession = upsertSession(hostId, {
    sessionId: effectiveSessionId,
    state: 'stop-failed',
    live: true,
    runId,
    lastUpdatedAt: timestamp,
  }, { preserveManagedLive: false });
  const runtimeKey = resolveSessionKey(hostId, failedSession.sessionId);
  const previousRuntime = state.sessionRuntime.get(runtimeKey)
    || state.sessionRuntime.get(sessionKey(hostId, failedSession.sessionId))
    || {};
  const failedRuntime = setSessionRuntime(hostId, failedSession.sessionId, {
    ...previousRuntime,
    phase: 'stop-failed',
    connection: options.connection || 'unknown',
    busy: false,
    activeTurnId: null,
    currentTurnStatus: 'stop-failed',
    waitingOnApproval: false,
    waitingOnUserInput: false,
    pendingInputSummary: null,
    queuedCommandId: null,
    pendingClientRequestId: null,
    stopDelayed: false,
    lastError: message,
    runId,
    updatedAt: timestamp,
  });
  if (options.broadcast !== false) {
    broadcastSessionEvent(hostId, failedSession.sessionId, 'session.runtime_updated', {
      hostId,
      sessionId: failedSession.sessionId,
      patch: failedRuntime,
      timestamp,
    });
    broadcastSessionEvent(hostId, failedSession.sessionId, 'session.snapshot', failedSession);
  }
  if (options.alert !== false) {
    emitSessionAlert(hostId, failedSession.sessionId, {
      severity: 'error',
      source: options.source || 'runtime',
      message,
      timestamp,
    });
  }
  return { session: failedSession, runtime: failedRuntime };
}

function runtimePatchWithPendingStopPriority(hostId, sessionId, eventRunId, patch = {}) {
  const record = state.provenance?.getSessionRecord({ hostId, sessionId });
  const activeRunId = String(record?.activeRunId || '').trim();
  const activeRun = activeRunId ? record?.runs?.[activeRunId] || null : null;
  const session = getSession(hostId, sessionId);
  const runtime = state.sessionRuntime.get(resolveSessionKey(hostId, sessionId))
    || state.sessionRuntime.get(sessionKey(hostId, sessionId))
    || null;
  const hostUsesDurableRunBinding = state.hosts.get(hostId)?.capabilities?.runApiBinding === true;
  const failedStopProjection = (
    String(session?.state || '').toLowerCase() === 'stop-failed'
    || String(runtime?.phase || '').toLowerCase() === 'stop-failed'
    || String(runtime?.currentTurnStatus || '').toLowerCase() === 'stop-failed'
  );
  if (failedStopProjection) {
    return {
      ...patch,
      phase: 'stop-failed',
      connection: runtime?.connection || 'unknown',
      busy: false,
      activeTurnId: null,
      currentTurnStatus: 'stop-failed',
      waitingOnApproval: false,
      waitingOnUserInput: false,
      pendingInputSummary: null,
      queuedCommandId: null,
      pendingClientRequestId: null,
      lastError: runtime?.lastError || patch.lastError || null,
    };
  }
  const legacyStopProjection = !hostUsesDurableRunBinding && (
    String(session?.state || '').toLowerCase() === 'ending'
    || String(runtime?.phase || '').toLowerCase() === 'ending'
    || String(runtime?.connection || '').toLowerCase() === 'closing'
    || String(runtime?.currentTurnStatus || '').toLowerCase() === 'stopping'
  );
  const pendingStop = Boolean(
    activeRun?.stopRequestId
    || legacyStopProjection
  );
  if (!pendingStop) {
    return patch;
  }
  const pendingStopRunId = String(
    activeRun?.stopRequestId
      ? activeRunId
      : session?.runId || runtime?.runId || activeRunId || ''
  ).trim();
  const normalizedEventRunId = String(eventRunId || patch.runId || '').trim();
  if (normalizedEventRunId && pendingStopRunId && normalizedEventRunId !== pendingStopRunId) {
    return patch;
  }
  return {
    ...patch,
    phase: 'ending',
    connection: 'closing',
    busy: false,
    activeTurnId: null,
    currentTurnStatus: 'stopping',
    waitingOnApproval: false,
    waitingOnUserInput: false,
    pendingInputSummary: null,
    queuedCommandId: null,
  };
}

function beginSessionStop(hostId, sessionId, options = {}) {
  const session = getSession(hostId, sessionId);
  const effectiveSessionId = session?.sessionId || sessionId;
  const targetRunId = String(options.runId || session?.runId || '').trim() || null;
  const previousRuntime = state.sessionRuntime.get(sessionKey(hostId, effectiveSessionId)) || null;
  const previousState = session?.state || null;
  if (session) {
    const next = upsertSession(hostId, {
      sessionId: effectiveSessionId,
      state: 'ending',
      live: true,
      runId: targetRunId,
      lastUpdatedAt: nowIso(),
    });
    setSessionRuntime(hostId, effectiveSessionId, {
      phase: 'ending',
      connection: 'closing',
      busy: false,
      activeTurnId: null,
      currentTurnStatus: 'stopping',
      waitingOnApproval: false,
      waitingOnUserInput: false,
      pendingInputSummary: null,
      queuedCommandId: null,
      runId: targetRunId,
      updatedAt: nowIso(),
    });
    broadcastSessionEvent(hostId, effectiveSessionId, 'session.snapshot', next);
    broadcastSessionEvent(hostId, effectiveSessionId, 'session.runtime_updated', {
      hostId,
      sessionId: effectiveSessionId,
      patch: {
        phase: 'ending',
        connection: 'closing',
        busy: false,
        activeTurnId: null,
        currentTurnStatus: 'stopping',
        waitingOnApproval: false,
        waitingOnUserInput: false,
        pendingInputSummary: null,
        queuedCommandId: null,
      },
      timestamp: nowIso(),
    });
  }

  const command = enqueueCommand(hostId, {
    type: 'session.stop',
    stopRequestId: options.stopRequestId || null,
    sessionId: session?.bridgeSessionId || effectiveSessionId || session?.nativeThreadId,
    requestedSessionId: effectiveSessionId,
    runId: targetRunId,
    bridgeSessionId: session?.bridgeSessionId || null,
    nativeThreadId: session?.nativeThreadId || null,
    originSessionId: session?.originSessionId || null,
    sourceSessionId: session?.sourceSessionId || null,
    conversationKey: session?.conversationKey || null,
  });
  const commands = [command];
  scheduleStopFallback(hostId, effectiveSessionId, {
    runId: targetRunId,
    stopRequestId: options.stopRequestId || null,
    previousState,
    previousRuntime: previousRuntime ? { ...previousRuntime } : null,
  });
  return {
    hostId,
    sessionId: effectiveSessionId,
    command: commands[0] || null,
    commands,
  };
}

function getRelayManagedLiveSessions(hostId = '') {
  const normalizedHostId = String(hostId || '').trim();
  return Array.from(state.sessions.values())
    .filter((session) => session.live && session.source === 'managed')
    .filter((session) => !normalizedHostId || session.hostId === normalizedHostId);
}

function codexUpdateSessionSnapshot(session) {
  const runtimeConfig = sessionRuntimeConfig(session.hostId, session.sessionId) || {};
  return normalizeCodexUpdateSession({
    hostId: session.hostId,
    sessionId: session.sessionId,
    runId: runtimeConfig.runId || session.runId || null,
    bridgeSessionId: session.bridgeSessionId,
    nativeThreadId: session.nativeThreadId,
    originSessionId: session.originSessionId,
    sourceSessionId: session.sourceSessionId,
    conversationKey: session.conversationKey,
    title: session.title,
    cwd: session.cwd,
    nativeResumeReady: runtimeConfig.nativeResumeReady === true,
    nativeResumeReadyKnown: runtimeConfig.nativeResumeReadyKnown === true,
    bindingFingerprint: runtimeConfig.sessionBinding?.bindingFingerprint || null,
    requestedSelection: runtimeConfig.requestedSelection || null,
    status: 'live',
  });
}

function liveUnmanagedSessionsForHost(hostId) {
  return Array.from(state.sessions.values())
    .filter((session) => session.hostId === hostId && session.live && session.source !== 'managed');
}

function assertHostLaunchAllowed(hostId, maintenanceOperationId = '') {
  const operation = activeCodexUpdateOperation(hostId);
  if (!operation) return;
  if (
    operation.status === 'resuming'
    && String(maintenanceOperationId || '').trim() === operation.operationId
  ) {
    return;
  }
  throw new SessionContractError(
    'host_codex_maintenance',
    `Host ${hostId} is in Codex maintenance (${operation.status}).`,
    {
      statusCode: 423,
      operationId: operation.operationId,
      maintenanceStatus: operation.status,
    }
  );
}

function hostCodexUpdateError(code, message, details = {}) {
  return new SessionContractError(code, message, {
    statusCode: details.statusCode || 409,
    ...details,
  });
}

function requireCodexUpdateOperation(hostId, operationId) {
  const operation = currentCodexUpdateOperation(hostId);
  if (!operation || operation.operationId !== String(operationId || '').trim()) {
    throw hostCodexUpdateError(
      'codex_update_operation_not_found',
      'Host Codex update operation was not found.',
      { statusCode: 404 }
    );
  }
  return operation;
}

function patchCodexUpdateOperation(operation, patch = {}) {
  return storeCodexUpdateOperation({
    ...operation,
    ...patch,
    operationId: operation.operationId,
    hostId: operation.hostId,
    createdAt: operation.createdAt,
  });
}

function prepareHostCodexUpdate(hostId) {
  const host = state.hosts.get(hostId);
  if (!host) {
    throw hostCodexUpdateError('host_not_found', 'Host was not found.', { statusCode: 404 });
  }
  if (!hostOnline(host)) {
    throw hostCodexUpdateError('host_offline', `Host ${host.label || hostId} is offline.`);
  }
  if (host.capabilities?.codexUpdateV1 !== true) {
    throw hostCodexUpdateError(
      'codex_update_agent_upgrade_required',
      'Restart this Host Agent with the 8897 development build before updating Codex.'
    );
  }
  const codexRuntime = normalizeHostCodexRuntime(host.codexRuntime);
  if (!codexRuntime?.canAutoUpdate) {
    throw hostCodexUpdateError(
      'codex_update_unsupported',
      codexRuntime?.updateReason || 'This Codex installation cannot be updated automatically.'
    );
  }
  const active = activeCodexUpdateOperation(hostId);
  if (active) {
    throw hostCodexUpdateError(
      'codex_update_in_progress',
      `Codex maintenance ${active.operationId} is already ${active.status}.`,
      { operation: publicCodexUpdateOperation(active) }
    );
  }
  const unmanaged = liveUnmanagedSessionsForHost(hostId);
  if (unmanaged.length) {
    throw hostCodexUpdateError(
      'codex_update_unmanaged_sessions_live',
      `${unmanaged.length} live Session(s) are not Relay-managed and cannot be stopped safely.`,
      { sessionIds: unmanaged.map((session) => session.sessionId) }
    );
  }
  const sessions = getRelayManagedLiveSessions(hostId).map(codexUpdateSessionSnapshot);
  const blockedSessionIds = sessions
    .filter((session) => session.nativeResumeReady !== true)
    .map((session) => session.sessionId);
  if (blockedSessionIds.length) {
    throw hostCodexUpdateError(
      'codex_update_unresumable_sessions',
      `${blockedSessionIds.length} live Session(s) have no native rollout yet and cannot be resumed after update.`,
      { sessions, blockedSessionIds }
    );
  }
  return storeCodexUpdateOperation({
    operationId: makeId(),
    hostId,
    status: 'stopping_sessions',
    phase: 'stopping_sessions',
    message: sessions.length
      ? `Waiting for ${sessions.length} managed Session(s) to stop.`
      : 'No managed Sessions need to be stopped.',
    currentVersion: codexRuntime.version,
    sessions,
    blockedSessionIds: [],
    createdAt: nowIso(),
  });
}

function codexUpdaterIsActive(hostId, operationId) {
  const maintenance = normalizeHostCodexMaintenance(state.hosts.get(hostId)?.codexMaintenance);
  return Boolean(
    maintenance
    && maintenance.operationId === operationId
    && ['checking', 'updating', 'installing', 'verifying'].includes(maintenance.status)
  );
}

function codexUpdateSessionsStillStopping(operation) {
  return operation.sessions.filter((snapshot) => {
    const session = getSession(operation.hostId, snapshot.sessionId);
    if (!session) return false;
    const runtime = state.sessionRuntime.get(resolveSessionKey(operation.hostId, session.sessionId))
      || state.sessionRuntime.get(sessionKey(operation.hostId, session.sessionId))
      || null;
    return String(session.state || '').trim().toLowerCase() === 'ending'
      || String(runtime?.phase || '').trim().toLowerCase() === 'ending'
      || String(runtime?.connection || '').trim().toLowerCase() === 'closing'
      || String(runtime?.currentTurnStatus || '').trim().toLowerCase() === 'stopping';
  });
}

function codexUpdateResumeRequestId(operationId, sessionId, attempt) {
  const digest = crypto.createHash('sha256')
    .update(`${operationId}\0${sessionId}\0${attempt}`)
    .digest('hex')
    .slice(0, 32);
  return `codex-update:${attempt}:${digest}`;
}

function codexUpdateRecoveryState(operation) {
  const pending = [];
  const failures = [];
  for (const snapshot of operation.sessions) {
    const current = getSession(operation.hostId, snapshot.sessionId);
    if (current?.live === true && !codexUpdateSessionsStillStopping({
      ...operation,
      sessions: [snapshot],
    }).length) {
      continue;
    }
    if (['resume_failed', 'left_stopped'].includes(snapshot.status)) {
      failures.push(snapshot);
    } else {
      pending.push(snapshot);
    }
  }
  return { pending, failures };
}

function updateCodexOperationSessionProgress(operation, input = {}) {
  if (!ACTIVE_CODEX_UPDATE_STATUSES.has(operation.status)) {
    throw hostCodexUpdateError(
      'codex_update_invalid_state',
      `Session progress cannot change after operation is ${operation.status}.`
    );
  }
  const sessionId = String(input.sessionId || '').trim();
  const allowedStatuses = new Set([
    'live',
    'stopping',
    'stopped',
    'stop_failed',
    'installing',
    'resuming',
    'resumed',
    'resume_failed',
    'left_stopped',
    'skipped',
  ]);
  const status = String(input.status || '').trim().toLowerCase();
  if (!sessionId || !allowedStatuses.has(status)) {
    throw hostCodexUpdateError(
      'codex_update_session_progress_invalid',
      'A known operation Session and valid progress status are required.',
      { statusCode: 400 }
    );
  }
  const statusRank = new Map([
    ['live', 0],
    ['stopping', 1],
    ['stopped', 2],
    ['stop_failed', 2],
    ['skipped', 2],
    ['installing', 3],
    ['resuming', 4],
    ['resumed', 5],
    ['resume_failed', 5],
    ['left_stopped', 5],
  ]);
  let found = false;
  const sessions = operation.sessions.map((session) => {
    if (session.sessionId !== sessionId) return session;
    found = true;
    const currentStatus = String(session.status || 'live').trim().toLowerCase();
    const retryingRecovery = ['resume_failed', 'left_stopped'].includes(currentStatus)
      && status === 'resuming';
    const returningToLive = ['stop_failed', 'skipped'].includes(currentStatus)
      && status === 'live';
    const currentSession = getSession(operation.hostId, sessionId);
    const retryingExitedResume = currentStatus === 'resumed'
      && status === 'resuming'
      && currentSession?.live !== true;
    if (
      currentStatus === 'resumed' && status !== 'resumed' && !retryingExitedResume
      || (
        !retryingRecovery
        && !retryingExitedResume
        && !returningToLive
        && statusRank.get(status) < statusRank.get(currentStatus)
      )
    ) {
      throw hostCodexUpdateError(
        'codex_update_session_progress_regression',
        `Session ${sessionId} progress cannot move from ${currentStatus} back to ${status}.`
      );
    }
    const startsResumeAttempt = status === 'resuming' && currentStatus !== 'resuming';
    const resumeAttempt = startsResumeAttempt
      ? Math.max(0, Number(session.resumeAttempt || 0)) + 1
      : Math.max(0, Number(session.resumeAttempt || 0));
    const resumeRequestId = startsResumeAttempt
      ? codexUpdateResumeRequestId(operation.operationId, sessionId, resumeAttempt)
      : session.resumeRequestId || null;
    return normalizeCodexUpdateSession({
      ...session,
      status,
      message: input.message || '',
      resumeAttempt,
      resumeRequestId,
    });
  });
  if (!found) {
    throw hostCodexUpdateError(
      'codex_update_session_not_found',
      'Session is not part of this Codex update operation.',
      { statusCode: 404 }
    );
  }
  return patchCodexUpdateOperation(operation, { sessions });
}

function getCommands(hostId, afterId = 0) {
  const queue = pruneCommandQueue(state.commandQueues.get(hostId) || []);
  state.commandQueues.set(hostId, queue);
  return sortCommandsForDelivery(queue.filter((command) => command.id > afterId));
}

function sortCommandsForDelivery(commands) {
  return [...(Array.isArray(commands) ? commands : [])].sort((a, b) => {
    // The host-agent acknowledges commands by the highest processed command id,
    // so delivery must remain monotonic even when commands carry priority.
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
}

function pruneCommandQueue(queue) {
  const now = Date.now();
  const fresh = (Array.isArray(queue) ? queue : []).filter((command) => {
    const created = Date.parse(command?.createdAt || '');
    return !Number.isFinite(created) || now - created <= COMMAND_QUEUE_TTL_MS;
  });
  if (fresh.length <= COMMAND_QUEUE_MAX_LENGTH) {
    return fresh;
  }
  return fresh.slice(fresh.length - COMMAND_QUEUE_MAX_LENGTH);
}

function purgeLegacySkillMutationCommands(queue) {
  return (Array.isArray(queue) ? queue : []).filter((command) => {
    if (command?.type !== 'host.skills.install' && command?.type !== 'host.skills.uninstall') {
      return true;
    }
    const pending = state.pendingHostSkillRequests.get(command.requestId);
    if (pending) {
      pending.reject(new Error(
        'Legacy Skill mutation was cancelled because this Host now uses managed Artifact deployments'
      ));
    }
    return false;
  });
}

function ackCommands(hostId, throughId = 0) {
  const id = Number(throughId || 0) || 0;
  if (!hostId || id <= 0) {
    return 0;
  }
  const queue = state.commandQueues.get(hostId) || [];
  if (queue.some((command) => (
    command?.type === 'session.input'
    && command.clientRequestId
    && Number(command.id || 0) <= id
  ))) {
    state.inputCommandOutbox.ackThrough(hostId, id);
  }
  const next = pruneCommandQueue(queue.filter((command) => Number(command?.id || 0) > id));
  state.commandQueues.set(hostId, next);
  return Math.max(0, queue.length - next.length);
}

function removeQueuedCommandById(hostId, commandId, expectedType = '') {
  const id = Number(commandId || 0) || 0;
  if (!hostId || id <= 0) return 0;
  const queue = state.commandQueues.get(hostId) || [];
  let removed = 0;
  const next = pruneCommandQueue(queue.filter((command) => {
    const matches = Number(command?.id || 0) === id
      && (!expectedType || command?.type === expectedType);
    if (matches) removed += 1;
    return !matches;
  }));
  state.commandQueues.set(hostId, next);
  return removed;
}

function completeQueuedSessionInputFromEvent(event) {
  const isInputFailure = event?.type === 'session.command_failed' && event.operation === 'input';
  const isInputReceipt = event?.type === 'session.runtime_updated'
    && ['accepted', 'acceptance_unknown'].includes(event?.inputOutcome);
  const commandId = Number(event?.commandId || 0);
  const clientRequestId = normalizeClientRequestId(
    isInputFailure ? event?.clientRequestId : event?.commandClientRequestId
  );
  if ((!isInputFailure && !isInputReceipt) || commandId <= 0 || !clientRequestId) {
    return false;
  }
  const completion = state.inputCommandOutbox.markCompleted(event.hostId, commandId, clientRequestId, {
    sessionId: event.sessionId || null,
    outcome: isInputFailure ? 'rejected' : event.inputOutcome,
  });
  if (!completion.recorded && completion.reason === 'missing') {
    return null;
  }
  removeQueuedCommandById(event.hostId, commandId, 'session.input');
  return completion.entry || null;
}

function sendSessionSse(res, event) {
  if (!res || res.destroyed || res.writableEnded) {
    return false;
  }
  try {
    const eventPayload = publicSessionEventPayload(event.eventName, event.payload, {
      optimize: res.sessionPayloadOptimize !== false,
    });
    return writeSseEvent(res, event.eventName, eventPayload, { id: event.id });
  } catch (error) {
    if (!isClientAbortError(error)) {
      console.error(error);
    }
    return false;
  }
}

function boundedSessionResetText(value, max) {
  return boundedSessionSseText(value, max);
}

function boundedSessionSseText(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let bounded = text.slice(0, low);
  if (bounded && /[\uD800-\uDBFF]/.test(bounded.at(-1))) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}

function boundedSessionResetAssistantProjection(projection) {
  const compact = compactAssistantProjection(projection);
  if (!compact) return null;
  return {
    ...compact,
    canonicalConversationKey: boundedSessionResetText(compact.canonicalConversationKey, 512),
    latestAssistantId: boundedSessionResetText(compact.latestAssistantId, 256) || null,
    latestAssistantAt: boundedSessionResetText(compact.latestAssistantAt, 128) || null,
    aliases: (Array.isArray(compact.aliases) ? compact.aliases : [])
      .slice(0, 4)
      .map((alias) => boundedSessionResetText(alias, 128))
      .filter(Boolean),
  };
}

function boundedSessionResetRecord(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    hostId: boundedSessionResetText(session.hostId, 128),
    sessionId: boundedSessionResetText(session.sessionId, 256),
    title: boundedSessionResetText(session.title, 256),
    cwd: boundedSessionResetText(session.cwd, 512) || null,
    cwdLabel: boundedSessionResetText(session.cwdLabel, 256) || null,
    source: boundedSessionResetText(session.source, 64),
    state: boundedSessionResetText(session.state, 128),
    live: session.live === true,
    createdAt: boundedSessionResetText(session.createdAt, 128) || null,
    lastUpdatedAt: boundedSessionResetText(session.lastUpdatedAt, 128) || null,
    messageCount: Math.max(0, Number(session.messageCount || 0)),
    latestUserMessage: boundedSessionResetText(session.latestUserMessage, 256) || null,
    latestAgentMessage: boundedSessionResetText(session.latestAgentMessage, 256) || null,
    rolloutPath: boundedSessionResetText(session.rolloutPath, 512) || null,
    originSessionId: boundedSessionResetText(session.originSessionId, 256) || null,
    sourceSessionId: boundedSessionResetText(session.sourceSessionId, 256) || null,
    conversationKey: boundedSessionResetText(session.conversationKey, 256) || null,
    launchMode: boundedSessionResetText(session.launchMode, 64) || null,
    runId: boundedSessionResetText(session.runId, 256) || null,
    bridgeSessionId: boundedSessionResetText(session.bridgeSessionId, 256) || null,
    nativeThreadId: boundedSessionResetText(session.nativeThreadId, 256) || null,
  };
}

function boundedSessionResetPayload(payload = {}) {
  const assistantProjection = boundedSessionResetAssistantProjection(
    payload.assistantProjection || payload.assistant
  );
  const base = {
    streamEpoch: boundedSessionResetText(payload.streamEpoch, 128),
    streamCounter: Math.max(0, Number(payload.streamCounter || 0)),
    canonicalConversationKey: boundedSessionResetText(payload.canonicalConversationKey, 512),
    assistantProjection,
    assistant: assistantProjection,
    session: boundedSessionResetRecord(payload.session),
    reason: boundedSessionResetText(payload.reason, 128),
    activityCount: Math.max(0, Number(payload.activityCount || 0)),
  };
  const activities = Array.isArray(payload.activities) ? payload.activities : [];
  const complete = {
    ...base,
    activities,
    activitiesTruncated: payload.activitiesTruncated === true,
    detailRecoveryRequired: payload.detailRecoveryRequired === true,
  };
  if (Buffer.byteLength(JSON.stringify(complete), 'utf8') <= SESSION_SSE_PAYLOAD_MAX_BYTES) {
    return complete;
  }
  const truncated = {
    ...base,
    activities: [],
    activitiesTruncated: payload.activitiesTruncated === true || activities.length > 0,
    detailRecoveryRequired: true,
  };
  if (Buffer.byteLength(JSON.stringify(truncated), 'utf8') <= SESSION_SSE_PAYLOAD_MAX_BYTES) {
    return truncated;
  }
  const minimalAssistant = assistantProjection ? {
    canonicalConversationKey: boundedSessionResetText(
      assistantProjection.canonicalConversationKey,
      128
    ),
    latestAssistantSeq: assistantProjection.latestAssistantSeq,
    projectionRevision: assistantProjection.projectionRevision,
    cursorUnknown: assistantProjection.cursorUnknown,
  } : null;
  const minimal = {
    streamEpoch: boundedSessionResetText(payload.streamEpoch, 64),
    streamCounter: Math.max(0, Number(payload.streamCounter || 0)),
    canonicalConversationKey: boundedSessionResetText(payload.canonicalConversationKey, 128),
    assistantProjection: minimalAssistant,
    assistant: minimalAssistant,
    session: payload.session ? {
      hostId: boundedSessionResetText(payload.session.hostId, 64),
      sessionId: boundedSessionResetText(payload.session.sessionId, 128),
      state: boundedSessionResetText(payload.session.state, 32),
      live: payload.session.live === true,
    } : null,
    reason: boundedSessionResetText(payload.reason, 32),
    activityCount: Math.max(0, Number(payload.activityCount || 0)),
    activities: [],
    activitiesTruncated: payload.activitiesTruncated === true || activities.length > 0,
    detailRecoveryRequired: true,
  };
  if (Buffer.byteLength(JSON.stringify(minimal), 'utf8') <= SESSION_SSE_PAYLOAD_MAX_BYTES) {
    return minimal;
  }
  return {
    streamEpoch: boundedSessionResetText(payload.streamEpoch, 32),
    streamCounter: Math.max(0, Number(payload.streamCounter || 0)),
    canonicalConversationKey: boundedSessionResetText(payload.canonicalConversationKey, 64),
    reason: boundedSessionResetText(payload.reason, 24),
    activityCount: Math.max(0, Number(payload.activityCount || 0)),
    activities: [],
    activitiesTruncated: payload.activitiesTruncated === true || activities.length > 0,
    detailRecoveryRequired: true,
  };
}

function boundedSessionActivityPayload(payload = {}) {
  if (
    Buffer.byteLength(JSON.stringify(payload), 'utf8')
    <= SESSION_SSE_PAYLOAD_MAX_BYTES
  ) {
    return payload;
  }
  const targetBytes = SESSION_SSE_PAYLOAD_MAX_BYTES;
  const canonicalConversationKey = String(payload.canonicalConversationKey || '');
  const compact = {
    canonicalConversationKey: Buffer.byteLength(canonicalConversationKey, 'utf8') <= 512
      ? canonicalConversationKey
      : '',
    activityRecoveryToken: makeActivityRecoveryToken(payload.activityKey),
    activityRevision: Number(payload.activityRevision || 0),
    streamEpoch: boundedSessionSseText(payload.streamEpoch, 128),
    text: '',
    activityTruncated: true,
    activityByteLength: Buffer.byteLength(String(payload.text || ''), 'utf8'),
  };
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= targetBytes) {
    return compact;
  }
  compact.canonicalConversationKey = '';
  return compact;
}

function publicSessionEventPayload(eventName, payload, options = {}) {
  if (eventName === 'stream.reset') {
    return boundedSessionResetPayload(payload);
  }
  if (
    options.optimize !== false
    && (eventName === 'session.snapshot' || eventName === 'session.started' || eventName === 'session.state_changed')
  ) {
    return publicSessionListRecord(payload);
  }
  return payload;
}

function publishCanonicalSessionEvent(canonicalKey, eventName, payload) {
  if (!state.sessionEventStream.has(canonicalKey)) {
    state.sessionEventStream.markTombstoneDirty(canonicalKey);
    return null;
  }
  const projectedPayload = eventName === 'session.activity'
    ? boundedSessionActivityPayload(payload)
    : (
      eventName === 'session.snapshot'
      || eventName === 'session.started'
      || eventName === 'session.state_changed'
    ) ? sessionWithAssistantProjection(payload) : payload;
  return state.sessionEventStream.publish(canonicalKey, eventName, projectedPayload);
}

function broadcastSessionEvent(hostId, sessionId, eventName, payload) {
  const canonicalKey = resolveCanonicalConversationKey(hostId, {
    ...(payload && typeof payload === 'object' ? payload : {}),
    sessionId,
  });
  if (!canonicalKey) return null;
  return publishCanonicalSessionEvent(canonicalKey, eventName, payload);
}

function addSessionSubscriber(canonicalKey, res, options = {}) {
  res.sessionPayloadOptimize = options.optimize !== false;
  const unsubscribe = state.sessionEventStream.subscribe({
    canonicalKey,
    cursor: options.cursor,
    send: (event) => sendSessionSse(res, event),
    makeReset: (currentCanonicalKey) => options.makeReset?.(currentCanonicalKey) || {},
  });
  res.sessionStreamUnsubscribe = unsubscribe;
  if (res.destroyed || res.writableEnded) {
    removeSessionSubscriber(res);
  }
  res.once('error', () => {
    removeSessionSubscriber(res);
  });
  res.once('close', () => {
    removeSessionSubscriber(res);
  });
  return unsubscribe;
}

function removeSessionSubscriber(res) {
  const unsubscribe = res?.sessionStreamUnsubscribe;
  res.sessionStreamUnsubscribe = null;
  unsubscribe?.();
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
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function sendSessionContractError(res, error, fallbackStage = 'session-launch') {
  const known = error instanceof SessionContractError || error instanceof ModelCatalogError;
  const statusCode = known ? Number(error.statusCode || 409) : 500;
  sendJson(res, statusCode, {
    code: known ? error.code : 'session_spawn_failed',
    error: error?.message || 'Session launch failed.',
    stage: String(error?.stage || fallbackStage),
    sessionBinding: publicBinding(error?.sessionBinding) || null,
    submittedBinding: publicBinding(error?.submittedBinding) || null,
    expectedRunId: error?.expectedRunId || null,
    expectedRunStatus: error?.expectedRunStatus || null,
    expectedBindingFingerprint: error?.expectedBindingFingerprint || null,
    currentRunId: error?.currentRunId || null,
    currentRunStatus: error?.currentRunStatus || null,
    currentBindingFingerprint: error?.currentBindingFingerprint || null,
    canRebind: Boolean(error?.canRebind),
  });
}

function stageSessionError(error, stage) {
  if (error && !error.stage) {
    error.stage = stage;
  }
  return error;
}

function publicQueuedCommand(command) {
  if (!command) {
    return null;
  }
  const result = { ...command };
  delete result.apiConfig;
  return result;
}

function makeSubmittedProfileBinding(apiConfig) {
  if (!apiConfig) {
    return null;
  }
  try {
    return makeProfileBinding(apiConfig);
  } catch (error) {
    throw new SessionContractError(
      'session_api_binding_unavailable',
      `The submitted API profile is invalid: ${error.message}`,
      { canRebind: true }
    );
  }
}

function sessionRunRecord(hostId, sessionId, options = {}) {
  const record = state.provenance?.getSessionRecord({ hostId, sessionId });
  if (!record) {
    return { record: null, run: null, runId: null };
  }
  const activeRun = record.activeRunId ? record.runs?.[record.activeRunId] : null;
  const successfulRun = record.latestSuccessfulRunId ? record.runs?.[record.latestSuccessfulRunId] : null;
  const usePending = options.includePending === true;
  const publishedLive = usePending && activeRun?.status === 'pending'
    ? publishedLiveSessionRun(hostId, sessionId, record)
    : null;
  if (publishedLive) {
    return { record, run: publishedLive.run, runId: publishedLive.runId };
  }
  const runId = activeRun && (activeRun.status === 'live' || usePending)
    ? record.activeRunId
    : record.latestSuccessfulRunId;
  const run = runId ? record.runs?.[runId] || null : successfulRun || null;
  return { record, run, runId };
}

function sessionCatalogRunRecord(hostId, sessionId) {
  const resolved = sessionRunRecord(hostId, sessionId);
  const record = resolved.record;
  const pendingRunId = record?.activeRunId || null;
  const pendingRun = pendingRunId ? record.runs?.[pendingRunId] || null : null;
  const publishedSession = getSession(hostId, sessionId);
  if (
    pendingRun?.status === 'pending'
    && String(publishedSession?.runId || '').trim() === pendingRunId
  ) {
    return {
      record,
      run: pendingRun,
      runId: pendingRunId,
      catalogRunId: pendingRunId,
      liveRunId: pendingRun.parentRunId || null,
    };
  }
  return {
    ...resolved,
    catalogRunId: resolved.runId,
    liveRunId: resolved.runId,
  };
}

function assertRebindRunExpectation(record, body = {}) {
  const expectedRunId = String(body.expectedRunId || '').trim();
  const expectedBindingProvided = Object.prototype.hasOwnProperty.call(
    body,
    'expectedBindingFingerprint'
  );
  const expectedRunStatus = String(body.expectedRunStatus || '').trim() || null;
  const expectedRunStatusProvided = Object.prototype.hasOwnProperty.call(body, 'expectedRunStatus');
  if (!expectedRunId || !expectedBindingProvided || !expectedRunStatusProvided) {
    throw new SessionContractError(
      'session_run_precondition_required',
      'This Session operation requires the observed run identity and API binding.',
      { statusCode: 428 }
    );
  }

  const activeRunId = String(record?.activeRunId || '').trim() || null;
  const activeRun = activeRunId ? record?.runs?.[activeRunId] || null : null;
  if (activeRun?.status === 'pending') {
    throw new SessionContractError(
      'session_run_pending',
      `Run ${activeRunId} is still pending for this Session.`,
      { statusCode: 409, currentRunId: activeRunId }
    );
  }
  if (activeRun?.stopRequestId) {
    throw new SessionContractError(
      'session_run_stopping',
      `Run ${activeRunId} already has a pending Stop request.`,
      {
        statusCode: 409,
        currentRunId: activeRunId,
        currentRunStatus: 'stopping',
        currentBindingFingerprint: bindingFingerprint(activeRun.apiBinding),
      }
    );
  }

  const currentRunId = activeRun?.status === 'live'
    ? activeRunId
    : String(record?.latestSuccessfulRunId || activeRunId || '').trim() || null;
  const currentRun = currentRunId ? record?.runs?.[currentRunId] || null : null;
  const currentBindingFingerprint = bindingFingerprint(currentRun?.apiBinding);
  const currentRunStatus = String(currentRun?.status || '').trim() || null;
  const expectedBindingFingerprint = String(body.expectedBindingFingerprint || '').trim() || null;
  if (
    !currentRunId
    || currentRunId !== expectedRunId
    || currentBindingFingerprint !== expectedBindingFingerprint
    || currentRunStatus !== expectedRunStatus
  ) {
    throw new SessionContractError(
      'session_run_changed',
      'The Session run changed after it was loaded. Reload it before retrying this operation.',
      {
        statusCode: 409,
        currentRunId,
        currentRunStatus,
        currentBindingFingerprint,
        expectedRunId,
        expectedRunStatus,
        expectedBindingFingerprint,
      }
    );
  }
  return { record, run: currentRun, runId: currentRunId, runStatus: currentRunStatus };
}

function sessionAcceptsLiveControl(hostId, session) {
  if (isSubagentSession(session) || session?.readOnly === true) {
    return false;
  }
  const { run, runId } = sessionRunRecord(hostId, session?.sessionId, { includePending: true });
  if (run?.stopRequestId) {
    return false;
  }
  if (session?.state === 'ending' || session?.state === 'stop-failed') {
    return false;
  }
  if (session?.live) {
    return true;
  }
  const projectedRunId = String(session?.runId || '').trim();
  return Boolean(
    run?.status === 'live'
    && runId
    && (!projectedRunId || projectedRunId === runId)
  );
}

function publishedLiveSessionRun(hostId, sessionId, record) {
  if (!record?.runs) {
    return null;
  }
  const session = getSession(hostId, sessionId);
  const runtime = state.sessionRuntime.get(sessionKey(hostId, sessionId))
    || state.sessionRuntime.get(resolveSessionKey(hostId, sessionId))
    || null;
  for (const runId of [session?.runId, runtime?.runId]) {
    const normalizedRunId = String(runId || '').trim();
    const run = normalizedRunId ? record.runs[normalizedRunId] : null;
    if (run?.status === 'live') {
      return { runId: normalizedRunId, run };
    }
  }
  return null;
}

function sessionRuntimeConfig(hostId, sessionId) {
  const { record, run, runId } = sessionRunRecord(hostId, sessionId);
  if (!record) {
    return null;
  }
  const pendingRun = record.activeRunId && record.activeRunId !== runId
    ? record.runs?.[record.activeRunId] || null
    : null;
  return {
    hostId,
    sessionId,
    canonicalSessionId: record.nativeThreadId || record.bridgeSessionId || record.conversationKey || sessionId,
    runId: runId || null,
    activeRunId: record.activeRunId || null,
    latestSuccessfulRunId: record.latestSuccessfulRunId || null,
    runStatus: run?.stopRequestId ? 'stopping' : run?.status || null,
    nativeResumeReady: run ? run.nativeResumeReady !== false : false,
    nativeResumeReadyKnown: typeof run?.nativeResumeReady === 'boolean',
    apiBinding: publicBinding(run?.apiBinding) || null,
    sessionBinding: publicBinding(run?.apiBinding) || null,
    requestedSelection: run?.requestedSelection || null,
    effectiveSelection: run?.effectiveSelection || null,
    pendingRun: pendingRun ? {
      runId: record.activeRunId,
      status: pendingRun.status || null,
      launchMode: pendingRun.launchMode || null,
      nativeResumeReady: pendingRun.nativeResumeReady !== false,
      nativeResumeReadyKnown: typeof pendingRun.nativeResumeReady === 'boolean',
      sessionBinding: publicBinding(pendingRun.apiBinding),
      requestedSelection: pendingRun.requestedSelection || null,
    } : null,
    provenance: {
      source: record.source || null,
      conversationKey: record.conversationKey || null,
      bridgeSessionId: record.bridgeSessionId || null,
      nativeThreadId: record.nativeThreadId || null,
      originSessionId: record.originSessionId || null,
      sourceSessionId: record.sourceSessionId || null,
      cwd: record.cwd || null,
      title: record.title || '',
    },
    canRebind: true,
  };
}

function validateLiveCommandBinding(session, body = {}) {
  const hostId = String(session?.hostId || body.hostId || '').trim();
  const sessionId = String(session?.sessionId || body.sessionId || '').trim();
  const { record, run, runId } = sessionRunRecord(hostId, sessionId, { includePending: true });
  const sessionBinding = publicBinding(run?.apiBinding);
  if (run?.stopRequestId) {
    throw new SessionContractError(
      'session_run_stopping',
      `Run ${runId} already has a pending Stop request.`,
      {
        statusCode: 409,
        currentRunId: runId,
        currentRunStatus: 'stopping',
        currentBindingFingerprint: sessionBinding?.bindingFingerprint || null,
      }
    );
  }
  const runtimeKind = String(session?.runtime?.adapterId || session?.runtime?.kind || '').trim();
  if (runtimeKind && runtimeKind !== 'codex-app-server') {
    return {
      record,
      run,
      runId: session?.runId || runId || null,
      binding: sessionBinding,
      compatibilityRuntime: true,
    };
  }
  if (!record || !run || run.status !== 'live' || !sessionBinding?.bindingFingerprint) {
    const host = state.hosts.get(hostId);
    if (host?.capabilities?.runApiBinding !== true) {
      return {
        record,
        run,
        runId: session?.runId || runId || null,
        binding: null,
        compatibilityRuntime: true,
      };
    }
    throw new SessionContractError(
      'session_api_binding_unavailable',
      'The live Session run has no verifiable API binding.',
      { sessionBinding, canRebind: true }
    );
  }
  const apiConfig = normalizeApiConfig(body.apiConfig);
  const submittedBinding = makeSubmittedProfileBinding(apiConfig);
  if (submittedBinding && !bindingsEqual(sessionBinding, submittedBinding)) {
    throw new SessionContractError(
      'session_api_binding_mismatch',
      'Command API differs from the live Session run.',
      { sessionBinding, submittedBinding, canRebind: true }
    );
  }
  if (
    submittedBinding?.providerKind
    && sessionBinding?.providerKind
    && submittedBinding.providerKind !== sessionBinding.providerKind
  ) {
    throw new SessionContractError(
      'session_api_binding_mismatch',
      'Command provider policy differs from the live Session run.',
      { sessionBinding, submittedBinding, canRebind: true }
    );
  }
  return { record, run, runId, binding: sessionBinding };
}

async function recordLiveRequestedSelection(hostId, sessionId, runId, body = {}) {
  const model = String(body.model || '').trim() || null;
  const effort = String(body.effort || '').trim() || null;
  if (!runId) {
    throw new SessionContractError(
      'session_run_not_found',
      'Requested selection has no matching Session run.',
      { statusCode: 404 }
    );
  }
  return state.provenance.recordRequestedSelection({
    identity: { hostId, sessionId },
    runId,
    selection: { model, effort, source: 'user' },
  });
}

async function validateLiveRequestedSelection(hostId, sessionId, liveRun, body = {}) {
  const selection = {
    model: String(body.model || '').trim() || null,
    effort: String(body.effort || '').trim() || null,
  };
  if (!selection.model && !selection.effort) {
    return null;
  }
  const catalog = state.modelCatalog.getCached({
    hostId,
    identity: { hostId, sessionId },
    sessionId,
    nativeThreadId: liveRun.record?.nativeThreadId || null,
    bindingFingerprint: liveRun.binding.bindingFingerprint,
    runId: liveRun.runId,
    ...modelCatalogInputPolicy(null, liveRun.binding),
  });
  if (!catalog) {
    return null;
  }
  return state.modelCatalog.validateSelection(catalog, selection, {
    allowUnverifiedEffort: body.allowUnverifiedEffort === true,
  });
}

async function resolveLaunchBinding(hostId, apiConfig, sourceRecord, explicitRebind) {
  if (explicitRebind) {
    assertHostSupportsSessionApiRebind(hostId, apiConfig);
  }
  if (apiConfig) {
    return makeSubmittedProfileBinding(apiConfig);
  }

  const inheritedRunId = sourceRecord?.latestSuccessfulRunId || sourceRecord?.activeRunId || null;
  const inheritedBinding = publicBinding(sourceRecord?.runs?.[inheritedRunId]?.apiBinding);
  if (inheritedBinding?.kind === 'profile' && !explicitRebind) {
    throw new SessionContractError(
      'session_api_binding_unavailable',
      'The API profile bound to this Session must be supplied before it can resume.',
      { sessionBinding: inheritedBinding, canRebind: true }
    );
  }
  if (inheritedBinding?.kind === 'unknown' && !explicitRebind) {
    throw new SessionContractError(
      'session_api_binding_unavailable',
      'This Session has no verifiable API binding. Choose an API before resuming.',
      { sessionBinding: inheritedBinding, canRebind: true }
    );
  }
  return requestHostBindingPreflight(hostId, inheritedBinding?.kind === 'host_environment' ? inheritedBinding : null);
}

async function failPlannedRun(hostId, sessionId, runId, error) {
  if (!state.provenance || !runId) {
    return { transitioned: false, missing: true };
  }
  try {
    return await state.provenance.failRun({
      identity: { hostId, sessionId },
      runId,
      code: error?.code || 'session_spawn_failed',
      message: error?.message || 'Session launch failed.',
    });
  } catch (failError) {
    if (failError?.code === 'session_run_not_found') {
      return { transitioned: false, missing: true };
    }
    console.error(`[relay] failed to persist failed run ${runId}: ${failError.message || failError}`);
    return { transitioned: false, error: failError };
  }
}

function assertIdleBatchRebind(hostId, sourceSessionId, targetSessionId, sourceSession) {
  const preferredSessionId = sourceSession?.sessionId || sourceSessionId || targetSessionId;
  const runtime = state.sessionRuntime.get(resolveSessionKey(hostId, preferredSessionId))
    || state.sessionRuntime.get(sessionKey(hostId, sourceSessionId || targetSessionId))
    || {};
  if (runtime.busy === true || runtime.waitingOnApproval === true || runtime.waitingOnUserInput === true) {
    throw new SessionContractError(
      'session_run_busy',
      'The Session became active after preflight; batch Rebind will not interrupt it.',
      { statusCode: 409 }
    );
  }
}

async function planManagedLaunch(hostId, body = {}, options = {}) {
  assertHostLaunchAllowed(hostId, body.maintenanceOperationId);
  const sourceSessionId = String(
    options.sourceSessionId
    || body.sourceSessionId
    || body.originSessionId
    || ''
  ).trim() || null;
  const launchMode = String(
    options.launchMode
    || body.launchMode
    || (sourceSessionId ? 'resume' : 'fresh')
  ).trim() || 'fresh';
  const rawClientRequestId = options.acceptClientRequestId === true
    ? String(body.clientRequestId || '').trim()
    : '';
  const clientRequestId = normalizeClientRequestId(rawClientRequestId);
  if (rawClientRequestId && clientRequestId !== rawClientRequestId) {
    throw stageSessionError(new SessionContractError(
      'session_request_invalid',
      'clientRequestId must be at most 160 letters, numbers, dots, colons, underscores, or hyphens.',
      { statusCode: 400 }
    ), 'validate-request');
  }
  const sourceDetail = sourceSessionId
    ? getSessionDetail(hostId, sourceSessionId, {
      skipDiagnostics: true,
      skipRemoteDetail: true,
    })
    : null;
  if (sourceSessionId && !sourceDetail?.session) {
    throw stageSessionError(new SessionContractError(
      'session_history_unavailable',
      'Saved Session history is unavailable.',
      { statusCode: 404 }
    ), 'resolve-history');
  }
  if (isSubagentSession(sourceDetail?.session) || sourceDetail?.session?.readOnly === true) {
    throw stageSessionError(new SessionContractError(
      'subagent_session_read_only',
      'Sub-agent sessions are read-only projections. Continue from the parent Session Thinking panel.',
      { statusCode: 409 }
    ), 'resolve-history');
  }

  const cwd = String(body.cwd || sourceDetail?.session?.cwd || '').trim();
  if (!cwd) {
    throw stageSessionError(new SessionContractError(
      'session_cwd_unavailable',
      'The Session working directory is unavailable.',
      { statusCode: 422 }
    ), 'resolve-cwd');
  }

  const targetSessionId = String(options.targetSessionId || body.sessionId || (
    ['resume', 'fresh_rebind'].includes(launchMode)
      ? sourceSessionId
      : clientRequestId
        ? deterministicLaunchUuid(hostId, clientRequestId, 'session')
        : makeId()
  )).trim();
  const runId = String(
    body.runId
    || (clientRequestId ? deterministicLaunchUuid(hostId, clientRequestId, 'run') : makeId())
  ).trim();
  const sourceSession = sourceDetail?.session || null;
  const sourceRecord = sourceSessionId
    ? state.provenance.getSessionRecord({ hostId, sessionId: sourceSessionId })
    : null;
  const sourceRunId = sourceRecord?.latestSuccessfulRunId || sourceRecord?.activeRunId || null;
  const sourceRun = sourceRunId ? sourceRecord?.runs?.[sourceRunId] || null : null;
  if (['resume', 'fork'].includes(launchMode) && sourceRun?.nativeResumeReady === false) {
    const operation = launchMode === 'fork' ? 'forked' : 'resumed';
    throw stageSessionError(new SessionContractError(
      launchMode === 'fork' ? 'session_native_fork_unavailable' : 'session_native_resume_unavailable',
      `This Session has not started its first native turn and cannot be ${operation}. Start a fresh Session instead.`,
      { statusCode: 409 }
    ), 'resolve-history');
  }
  const apiConfig = normalizeApiConfig(body.apiConfig);
  const explicitRebind = options.explicitRebind === true;
  const requireExpectedRun = explicitRebind || options.requireExpectedRun === true;
  if (explicitRebind) {
    assertNoExplicitRebindRuntimeOverride(body);
  }

  let submittedBinding;
  try {
    submittedBinding = await resolveLaunchBinding(hostId, apiConfig, sourceRecord, explicitRebind);
  } catch (error) {
    throw stageSessionError(error, 'resolve-binding');
  }

  const conversationKey = String(
    body.conversationKey
    || sourceSession?.conversationKey
    || sourceSession?.originSessionId
    || sourceSessionId
    || targetSessionId
  ).trim();
  const originSessionId = String(
    body.originSessionId
    || sourceSession?.originSessionId
    || sourceSessionId
    || ''
  ).trim() || null;
  const nativeThreadId = String(
    body.nativeThreadId
    || sourceSession?.nativeThreadId
    || sourceSession?.sessionId
    || ''
  ).trim() || null;
  const identity = {
    hostId,
    sessionId: targetSessionId,
  };
  const hasSubmittedSelection = Object.prototype.hasOwnProperty.call(body, 'model')
    || Object.prototype.hasOwnProperty.call(body, 'effort')
    || Object.prototype.hasOwnProperty.call(body, 'summary');
  const submittedEffort = String(body.effort || '').trim() || null;
  const requestedSelection = hasSubmittedSelection ? {
    model: String(body.model || '').trim() || null,
    effort: submittedEffort,
    summary: String(body.summary || '').trim() || null,
    ...(submittedEffort && body.allowUnverifiedEffort === true ? { allowUnverifiedEffort: true } : {}),
    source: String(body.selectionSource || 'user').trim() || 'user',
  } : undefined;
  const requestFingerprint = clientRequestId ? managedLaunchRequestFingerprint({
    hostId,
    targetSessionId,
    sourceSessionId,
    launchMode,
    cwd,
    conversationKey,
    originSessionId,
    nativeThreadId,
    bindingFingerprint: submittedBinding?.bindingFingerprint,
    apiConfig,
    requestedSelection,
    body,
  }) : '';

  if (explicitRebind && body.requireIdle === true) {
    try {
      assertIdleBatchRebind(hostId, sourceSessionId, targetSessionId, sourceSession);
    } catch (error) {
      throw stageSessionError(error, 'plan-run');
    }
  }

  let planned;
  try {
    planned = await state.provenance.planRun({
      identity,
      sourceIdentity: sourceSessionId ? { hostId, sessionId: sourceSessionId } : null,
      conversationKey,
      runId,
      launchMode,
      clientRequestId,
      requestFingerprint,
      submittedBinding,
      explicitRebind,
      requireExpectedRun,
      expectSourceRun: options.expectSourceRun === true,
      expectedRunId: body.expectedRunId,
      expectedBindingFingerprint: body.expectedBindingFingerprint,
      expectedBindingProvided: Object.prototype.hasOwnProperty.call(
        body,
        'expectedBindingFingerprint'
      ),
      expectedRunStatus: body.expectedRunStatus,
      expectedRunStatusProvided: Object.prototype.hasOwnProperty.call(body, 'expectedRunStatus'),
      requestedSelection,
    });
  } catch (error) {
    throw stageSessionError(error, 'plan-run');
  }

  const planResult = {
    hostId,
    targetSessionId,
    sourceSessionId,
    sourceDetail,
    sourceSession,
    cwd,
    launchMode: planned.run.launchMode || launchMode,
    runId,
    conversationKey,
    originSessionId,
    nativeThreadId,
    apiConfig,
    apiProfile: summarizeApiConfig(apiConfig),
    planned,
    explicitRebind,
    clientRequestId: clientRequestId || null,
    idempotentReplay: planned.idempotentReplay === true,
  };
  if (planResult.idempotentReplay) {
    return { ...planResult, catalog: null };
  }

  const requestedModel = String(planned.run.requestedSelection?.model || '').trim();
  const requestedEffort = String(planned.run.requestedSelection?.effort || '').trim();
  if (
    !explicitRebind
    && planResult.launchMode === 'resume'
    && !requestedModel
    && !requestedEffort
  ) {
    try {
      const catalog = await state.modelCatalog.inheritRunCatalog({
        hostId,
        identity,
        sessionId: targetSessionId,
        nativeThreadId,
        bindingFingerprint: planned.run.apiBinding.bindingFingerprint,
        runId,
        liveRunId: planned.run.parentRunId || null,
        ...modelCatalogInputPolicy(apiConfig, planned.run.apiBinding),
        apiConfig,
      }, planned.run.parentRunId);
      return { ...planResult, catalog };
    } catch (error) {
      await failPlannedRun(hostId, targetSessionId, runId, error);
      throw stageSessionError(error, 'load-model-catalog');
    }
  }

  let catalog;
  try {
    const catalogPolicy = modelCatalogInputPolicy(apiConfig, planned.run.apiBinding);
    const providerKind = catalogPolicy.providerKind;
    const reuseInput = {
      hostId,
      sourceSessionId,
      targetSessionId,
      currentRunId: body.expectedRunId,
      currentRunStatus: body.expectedRunStatus,
      currentBindingFingerprint: body.expectedBindingFingerprint,
      targetBindingFingerprint: planned.run.apiBinding.bindingFingerprint,
      targetProfileId: planned.run.apiBinding.profileId,
      targetProviderKind: providerKind,
      targetApiConfigFingerprint: rebindCatalogApiConfigFingerprint(apiConfig),
      selectionFingerprint: rebindCatalogSelectionFingerprint(
        planned.run.requestedSelection,
        body.allowUnverifiedEffort === true
      ),
    };
    catalog = explicitRebind
      ? consumeRebindCatalogReuseToken(body.modelCatalogReuseToken, reuseInput)
      : null;
    const reusedCatalog = Boolean(catalog);
    if (!catalog) {
      catalog = await state.modelCatalog.get({
        hostId,
        identity,
        sessionId: targetSessionId,
        nativeThreadId,
        bindingFingerprint: planned.run.apiBinding.bindingFingerprint,
        runId,
        liveRunId: planned.run.parentRunId || null,
        ...catalogPolicy,
        apiConfig,
        force: (explicitRebind && Boolean(apiConfig)) || body.refreshModels === true,
      });
    }
    if (explicitRebind && apiConfig) {
      assertFreshProviderCatalog(catalog, planned.run.apiBinding);
    }
    state.modelCatalog.validateSelection(catalog, planned.run.requestedSelection, {
      allowUnverifiedEffort: body.allowUnverifiedEffort === true,
    });
    if (reusedCatalog) {
      await state.modelCatalog.persistCatalog({
        hostId,
        identity,
        sessionId: targetSessionId,
        nativeThreadId,
        bindingFingerprint: planned.run.apiBinding.bindingFingerprint,
        runId,
        liveRunId: planned.run.parentRunId || null,
        providerKind,
      }, catalog, 'session.model_catalog.reused');
    }
  } catch (error) {
    await failPlannedRun(hostId, targetSessionId, runId, error);
    throw stageSessionError(error, 'load-model-catalog');
  }

  return { ...planResult, catalog };
}

async function validateManagedRebind(hostId, sourceSessionId, body = {}) {
  const sourceSession = getSession(hostId, sourceSessionId);
  if (!sourceSession) {
    throw stageSessionError(new SessionContractError(
      'session_history_unavailable',
      'Saved Session history is unavailable.',
      { statusCode: 404 }
    ), 'resolve-history');
  }

  const cwd = String(body.cwd || sourceSession.cwd || '').trim();
  if (!cwd) {
    throw stageSessionError(new SessionContractError(
      'session_cwd_unavailable',
      'The Session working directory is unavailable.',
      { statusCode: 422 }
    ), 'resolve-cwd');
  }

  let observed;
  try {
    observed = assertRebindRunExpectation(
      state.provenance.getSessionRecord({ hostId, sessionId: sourceSessionId }),
      body
    );
  } catch (error) {
    throw stageSessionError(error, 'plan-run');
  }

  const apiConfig = normalizeApiConfig(body.apiConfig);
  assertNoExplicitRebindRuntimeOverride(body);
  let submittedBinding;
  try {
    submittedBinding = await resolveLaunchBinding(hostId, apiConfig, observed.record, true);
    if (!submittedBinding || submittedBinding.kind === 'unknown' || !submittedBinding.bindingFingerprint) {
      throw new SessionContractError(
        'session_api_binding_unavailable',
        'The Session API binding cannot be resolved.',
        {
          sessionBinding: publicBinding(observed.run?.apiBinding),
          submittedBinding: publicBinding(submittedBinding),
          canRebind: true,
        }
      );
    }
  } catch (error) {
    throw stageSessionError(error, 'resolve-binding');
  }

  const proposedRunId = String(body.runId || '').trim() || null;
  if (proposedRunId && observed.record?.runs?.[proposedRunId]) {
    throw stageSessionError(new SessionContractError(
      'session_run_conflict',
      `Run ${proposedRunId} already exists.`
    ), 'plan-run');
  }

  const inheritedRunId = observed.record?.latestSuccessfulRunId
    || observed.record?.activeRunId
    || observed.runId;
  const inheritedRun = inheritedRunId ? observed.record?.runs?.[inheritedRunId] || observed.run : observed.run;
  const hasSubmittedSelection = Object.prototype.hasOwnProperty.call(body, 'model')
    || Object.prototype.hasOwnProperty.call(body, 'effort')
    || Object.prototype.hasOwnProperty.call(body, 'summary');
  const inheritedSelection = inheritedRun?.effectiveSelection || inheritedRun?.requestedSelection || {};
  const selectedEffort = String(
    hasSubmittedSelection ? body.effort || '' : inheritedSelection.effort || ''
  ).trim() || null;
  const requestedSelection = {
    model: String(hasSubmittedSelection ? body.model || '' : inheritedSelection.model || '').trim() || null,
    effort: selectedEffort,
    summary: String(hasSubmittedSelection ? body.summary || '' : inheritedSelection.summary || '').trim() || null,
    ...(selectedEffort && (hasSubmittedSelection
      ? body.allowUnverifiedEffort === true
      : inheritedSelection.allowUnverifiedEffort === true) ? { allowUnverifiedEffort: true } : {}),
    source: String(
      hasSubmittedSelection
        ? body.selectionSource || 'user'
        : inheritedSelection.source || 'inherit'
    ).trim() || 'inherit',
  };

  const validationCatalogRunId = `rebind-validation:${makeId()}`;
  let catalog;
  try {
    catalog = await state.modelCatalog.get({
      hostId,
      identity: { hostId, sessionId: sourceSessionId },
      sessionId: sourceSession.sessionId || sourceSessionId,
      nativeThreadId: String(body.nativeThreadId || sourceSession.nativeThreadId || '').trim() || null,
      bindingFingerprint: submittedBinding.bindingFingerprint,
      runId: validationCatalogRunId,
      liveRunId: inheritedRunId || null,
      ...modelCatalogInputPolicy(apiConfig, submittedBinding),
      apiConfig,
      force: Boolean(apiConfig) || body.refreshModels === true,
      persist: false,
    });
    if (apiConfig) {
      assertFreshProviderCatalog(catalog, submittedBinding);
    }
    state.modelCatalog.validateSelection(catalog, requestedSelection, {
      allowUnverifiedEffort: body.allowUnverifiedEffort === true,
    });
  } catch (error) {
    throw stageSessionError(error, 'load-model-catalog');
  }

  try {
    observed = assertRebindRunExpectation(
      state.provenance.getSessionRecord({ hostId, sessionId: sourceSessionId }),
      body
    );
    if (proposedRunId && observed.record?.runs?.[proposedRunId]) {
      throw new SessionContractError(
        'session_run_conflict',
        `Run ${proposedRunId} already exists.`
      );
    }
  } catch (error) {
    throw stageSessionError(error, 'plan-run');
  }

  const runtime = state.sessionRuntime.get(resolveSessionKey(hostId, sourceSession.sessionId || sourceSessionId))
    || state.sessionRuntime.get(sessionKey(hostId, sourceSessionId))
    || {};
  const busy = runtime.busy === true;
  const waitingOnApproval = runtime.waitingOnApproval === true;
  const waitingOnUserInput = runtime.waitingOnUserInput === true;
  const requiresInterrupt = busy || waitingOnApproval || waitingOnUserInput;
  const modelCatalogReuseToken = issueRebindCatalogReuseToken({
    hostId,
    sourceSessionId,
    targetSessionId: sourceSession.sessionId || sourceSessionId,
    currentRunId: observed.runId,
    currentRunStatus: observed.runStatus,
    currentBindingFingerprint: bindingFingerprint(observed.run?.apiBinding),
    targetBindingFingerprint: submittedBinding.bindingFingerprint,
    targetProfileId: submittedBinding.profileId,
    targetProviderKind: modelCatalogProviderKind(apiConfig, submittedBinding),
    targetApiConfigFingerprint: rebindCatalogApiConfigFingerprint(apiConfig),
    selectionFingerprint: rebindCatalogSelectionFingerprint(
      requestedSelection,
      body.allowUnverifiedEffort === true
    ),
    catalog,
  });
  return {
    ok: true,
    valid: true,
    canExecute: true,
    canExecuteWithoutInterrupt: !requiresInterrupt,
    requiresInterrupt,
    busy,
    waitingOnApproval,
    waitingOnUserInput,
    hostId,
    sessionId: sourceSession.sessionId || sourceSessionId,
    canonicalSessionId: observed.record?.nativeThreadId
      || observed.record?.bridgeSessionId
      || observed.record?.conversationKey
      || sourceSession.sessionId
      || sourceSessionId,
    currentRunId: observed.runId,
    currentRunStatus: observed.runStatus,
    nativeResumeReady: observed.run?.nativeResumeReady !== false,
    nativeResumeReadyKnown: typeof observed.run?.nativeResumeReady === 'boolean',
    launchMode: observed.run?.nativeResumeReady === false ? 'fresh_rebind' : 'resume',
    sessionBinding: publicBinding(observed.run?.apiBinding),
    submittedBinding: publicBinding(submittedBinding),
    requestedSelection,
    codexOptions: {
      model: requestedSelection.model || null,
      effort: requestedSelection.effort || null,
      summary: String(body.summary || '').trim() || null,
      allowUnverifiedEffort: body.allowUnverifiedEffort === true,
    },
    runtime: {
      phase: runtime.phase || null,
      connection: runtime.connection || null,
      activeTurnId: runtime.activeTurnId || null,
      busy,
      waitingOnApproval,
      waitingOnUserInput,
    },
    modelCatalog: publicModelCatalog(catalog),
    modelCatalogReuseToken,
  };
}

async function enqueueManagedLaunch(plan, body = {}) {
  if (plan.explicitRebind) {
    const latestRecord = state.provenance.getSessionRecord({
      hostId: plan.hostId,
      sessionId: plan.targetSessionId,
    });
    const latestRun = latestRecord?.runs?.[plan.runId] || null;
    if (latestRun?.status === 'pending') {
      plan.launchMode = latestRun.launchMode || plan.launchMode;
      plan.planned = {
        ...plan.planned,
        run: latestRun,
        record: latestRecord,
      };
    }
  }
  if (plan.explicitRebind && body.requireIdle === true) {
    try {
      assertIdleBatchRebind(
        plan.hostId,
        plan.sourceSessionId,
        plan.targetSessionId,
        plan.sourceSession
      );
    } catch (error) {
      await failPlannedRun(plan.hostId, plan.targetSessionId, plan.runId, error);
      throw stageSessionError(error, 'plan-run');
    }
  }
  const createdAt = nowIso();
  const resumeTranscript = plan.launchMode === 'transcript_fallback' && plan.sourceDetail
    ? buildResumeTranscript(plan.sourceDetail.transcript)
    : [];
  const requestedSelection = plan.planned.run.requestedSelection || {};
  const parentRunId = String(plan.planned.run.parentRunId || '').trim() || null;
  const parentRun = parentRunId ? plan.planned.record?.runs?.[parentRunId] || null : null;

  if (parentRun?.status === 'live') {
    beginSessionStop(plan.hostId, plan.targetSessionId, { runId: parentRunId });
  } else if (plan.explicitRebind && getSession(plan.hostId, plan.targetSessionId)?.live) {
    beginSessionStop(plan.hostId, plan.targetSessionId);
  }

  upsertSession(plan.hostId, {
    sessionId: plan.targetSessionId,
    cwd: plan.cwd,
    title: body.label || plan.sourceSession?.title || plan.cwd || plan.targetSessionId,
    source: 'managed',
    state: 'starting',
    live: false,
    createdAt,
    originSessionId: plan.originSessionId,
    sourceSessionId: plan.sourceSessionId,
    conversationKey: plan.conversationKey,
    launchMode: plan.launchMode,
    bridgeSessionId: plan.targetSessionId,
    runId: plan.runId,
    nativeThreadId: plan.launchMode === 'fresh_rebind'
      ? null
      : plan.launchMode === 'resume'
        ? plan.nativeThreadId || plan.targetSessionId
        : plan.targetSessionId,
    messageCount: plan.sourceDetail?.transcript?.length || 0,
    apiProfile: plan.apiProfile,
    apiBinding: publicBinding(plan.planned.run.apiBinding),
    requestedSelection,
    codexOptions: {
      model: requestedSelection.model || null,
      effort: requestedSelection.effort || null,
      summary: String(body.summary || '').trim() || null,
      allowUnverifiedEffort: body.allowUnverifiedEffort === true,
    },
  });

  if (plan.sourceDetail && Array.isArray(plan.sourceDetail.transcript)) {
    setSessionLog(plan.hostId, plan.targetSessionId, plan.sourceDetail.transcript);
  }

  const command = enqueueCommand(plan.hostId, {
    type: 'session.start',
    sessionId: plan.targetSessionId,
    bridgeSessionId: plan.targetSessionId,
    runId: plan.runId,
    cwd: plan.cwd,
    label: body.label || plan.sourceSession?.title || plan.cwd || plan.targetSessionId,
    command: plan.explicitRebind ? null : body.command || null,
    args: plan.explicitRebind ? [] : body.args || [],
    createdAt,
    originSessionId: plan.originSessionId,
    sourceSessionId: plan.sourceSessionId,
    conversationKey: plan.conversationKey,
    launchMode: plan.launchMode,
    resumeTranscript,
    nativeThreadId: plan.launchMode === 'fresh_rebind' ? null : plan.nativeThreadId,
    rebindNativeThreadId: plan.explicitRebind ? plan.nativeThreadId : null,
    explicitRebind: plan.explicitRebind === true,
    apiConfig: plan.apiConfig,
    apiBinding: plan.planned.run.apiBinding?.kind === 'profile'
      ? publicBinding(plan.planned.run.apiBinding)
      : null,
    expectedBinding: publicBinding(plan.planned.run.apiBinding),
    model: requestedSelection.model || null,
    effort: requestedSelection.effort || null,
    summary: String(body.summary || '').trim() || null,
    requestedSelection,
  });
  return command;
}

function queuedManagedLaunchCommand(hostId, runId) {
  return (state.commandQueues.get(hostId) || []).find((command) => (
    command?.type === 'session.start'
    && String(command.runId || '') === String(runId || '')
  )) || null;
}

async function handleRequest(req, res) {
  const url = parseUrl(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Auth-Token, X-Remote-Codex-Agent-Instance, X-Remote-Codex-Agent-Lease, X-Remote-Codex-Upload-Token, X-Remote-Codex-Host-Id, X-Remote-Codex-Instance-Digest',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/config') {
    sendJson(res, 200, relayAuthConfig(req, url));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
    const body = await readBody(req);
    if (!RELAY_AUTH_TOKEN) {
      sendJson(res, 409, { error: 'relay auth is disabled' });
      return;
    }
    if (relayAuthAccount?.username) {
      sendJson(res, 409, { error: 'relay account is already configured' });
      return;
    }
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || body.passwordConfirm || '');
    if (password !== confirmPassword) {
      sendJson(res, 400, { error: 'password confirmation does not match' });
      return;
    }
    try {
      createRelayAuthAccount(body.username || 'admin', password);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      ...relayAuthConfig(req, url),
      authenticated: true,
    }, {
      'Set-Cookie': authCookieHeader(30 * 24 * 60 * 60),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    if (!RELAY_AUTH_TOKEN) {
      sendJson(res, 200, relayAuthConfig(req, url));
      return;
    }

    const token = String(body.token || '').trim();
    const username = normalizeAuthUsername(body.username || '');
    const password = String(body.password || '');
    const tokenOk = token && constantTimeEqual(token, RELAY_AUTH_TOKEN);
    const passwordOk = relayAuthAccount?.username
      && constantTimeEqual(username.toLowerCase(), String(relayAuthAccount.username).toLowerCase())
      && verifyAuthPassword(password, relayAuthAccount);
    if (!tokenOk && !passwordOk) {
      sendJson(res, 401, {
        error: relayAuthAccount?.username ? 'invalid username or password' : 'setup is required or recovery token is invalid',
        authRequired: true,
        setupRequired: Boolean(!relayAuthAccount?.username),
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ...relayAuthConfig(req, url),
      authenticated: true,
    }, {
      'Set-Cookie': authCookieHeader(30 * 24 * 60 * 60),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/control/shutdown') {
    if (!requestHasLocalRelayControlToken(req)) {
      sendJson(res, 403, { ok: false, error: 'local Relay control token is required' });
      return;
    }
    sendJson(res, 202, { ok: true, status: 'shutting_down' });
    setImmediate(() => {
      void shutdownRelay('api-control');
    });
    return;
  }

  if (!authorizeRequest(req, res, url)) {
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    sendJson(res, 200, {
      ok: true,
      authRequired: Boolean(RELAY_AUTH_TOKEN),
      authenticated: false,
    }, {
      'Set-Cookie': authCookieHeader(0),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
    if (!relayAuthAccount?.username) {
      sendJson(res, 409, { error: 'relay account is not configured yet' });
      return;
    }
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || '');
    const recoveryToken = String(body.recoveryToken || '').trim();
    const authorizedByPassword = currentPassword && verifyAuthPassword(currentPassword, relayAuthAccount);
    const authorizedByToken = recoveryToken && RELAY_AUTH_TOKEN && constantTimeEqual(recoveryToken, RELAY_AUTH_TOKEN);
    if (!authorizedByPassword && !authorizedByToken) {
      sendJson(res, 401, { error: 'current password or recovery token is required' });
      return;
    }

    const newPassword = String(body.newPassword || body.password || '');
    const confirmPassword = String(body.confirmPassword || body.passwordConfirm || '');
    if (newPassword !== confirmPassword) {
      sendJson(res, 400, { error: 'password confirmation does not match' });
      return;
    }

    try {
      const nextUsername = normalizeAuthUsername(body.username || relayAuthAccount.username);
      validateAuthUsername(nextUsername);
      saveRelayAuthAccount({
        ...relayAuthAccount,
        username: nextUsername,
        passwordHash: hashAuthPassword(newPassword),
        createdAt: relayAuthAccount.createdAt || nowIso(),
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ...relayAuthConfig(req, url),
      authenticated: true,
    }, {
      'Set-Cookie': authCookieHeader(30 * 24 * 60 * 60),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const persistence = state.sessionRecordStore?.readHealth?.() || {
      status: 'starting',
      writable: false,
      revision: 0,
      snapshotError: null,
      error: null,
    };
    const ok = relayReady && persistence.status !== 'failed';
    sendJson(res, ok ? 200 : 503, {
      ok,
      ready: relayReady,
      time: nowIso(),
      authRequired: Boolean(RELAY_AUTH_TOKEN),
      instanceId: RELAY_INSTANCE_ID,
      persistence,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/update/status') {
    try {
      sendJson(res, 200, {
        ok: true,
        update: getLocalUpdateStatus({ rootDir: process.cwd(), fetch: url.searchParams.get('fetch') !== '0' }),
      }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || 'failed to check for updates',
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/update/apply') {
    try {
      const result = applyStableTagUpdate({ rootDir: process.cwd(), fetch: true });
      sendJson(res, 200, {
        ok: true,
        update: result,
      });
    } catch (error) {
      sendJson(res, error.code === 'DIRTY_TRACKED_FILES' ? 409 : 500, {
        ok: false,
        error: error.message || 'failed to apply update',
        code: error.code || 'UPDATE_FAILED',
        trackedChanges: error.trackedChanges || [],
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/update/restart') {
    try {
      const result = scheduleWindowsRestart({ rootDir: process.cwd(), delayMs: 1500 });
      sendJson(res, 202, {
        ok: true,
        restart: result,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || 'failed to schedule restart',
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/hosts') {
    sendJson(res, 200, {
      hosts: getHostList(),
      dismissedHosts: Array.from(state.dismissedHosts.values()).sort(),
    });
    return;
  }

  if (url.pathname.match(/^\/api\/hosts\/[^/]+\/codex-update$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    if (req.method === 'GET') {
      const host = state.hosts.get(hostId);
      if (!host) {
        sendJson(res, 404, { error: 'host not found' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        hostId,
        codexRuntime: normalizeHostCodexRuntime(host.codexRuntime),
        operation: publicCodexUpdateOperation(currentCodexUpdateOperation(hostId)),
      });
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = String(body.action || 'prepare').trim().toLowerCase();
      try {
        if (action === 'prepare') {
          const operation = prepareHostCodexUpdate(hostId);
          sendJson(res, 200, { ok: true, operation: publicCodexUpdateOperation(operation) });
          return;
        }

        const operation = requireCodexUpdateOperation(hostId, body.operationId);
        if (action === 'session-progress') {
          const next = updateCodexOperationSessionProgress(operation, body);
          sendJson(res, 200, { ok: true, operation: publicCodexUpdateOperation(next) });
          return;
        }
        if (action === 'apply') {
          if (['updated', 'update_failed', 'completed', 'failed'].includes(operation.status)) {
            sendJson(res, 200, {
              ok: ['updated', 'completed'].includes(operation.status),
              operation: publicCodexUpdateOperation(operation),
            });
            return;
          }
          if (!['planned', 'stopping_sessions'].includes(operation.status)) {
            throw hostCodexUpdateError(
              'codex_update_invalid_state',
              `Codex update cannot start while operation is ${operation.status}.`
            );
          }
          const remainingManaged = getRelayManagedLiveSessions(hostId);
          const remainingUnmanaged = liveUnmanagedSessionsForHost(hostId);
          if (remainingManaged.length || remainingUnmanaged.length) {
            throw hostCodexUpdateError(
              'codex_update_sessions_live',
              `${remainingManaged.length + remainingUnmanaged.length} Session(s) are still live; Codex was not changed.`,
              {
                managedSessionIds: remainingManaged.map((session) => session.sessionId),
                unmanagedSessionIds: remainingUnmanaged.map((session) => session.sessionId),
              }
            );
          }
          const host = state.hosts.get(hostId);
          if (!host || !hostOnline(host)) {
            throw hostCodexUpdateError('host_offline', 'Host went offline before Codex update started.');
          }
          const requestId = makeId();
          patchCodexUpdateOperation(operation, {
            status: 'updating',
            phase: 'updating',
            message: 'Host Agent is starting the Codex update.',
          });
          const pending = awaitCodexUpdateRequest(requestId);
          enqueueCommand(hostId, {
            type: 'host.codex_update',
            requestId,
            operationId: operation.operationId,
          });
          let result;
          try {
            result = await pending;
          } catch (error) {
            const current = currentCodexUpdateOperation(hostId) || operation;
            if (['updated', 'update_failed'].includes(current.status)) {
              sendJson(res, 200, {
                ok: current.status === 'updated',
                result: {
                  ok: current.status === 'updated',
                  operationId: current.operationId,
                  version: current.targetVersion || null,
                  error: current.status === 'update_failed' ? current.message : null,
                  recovered: true,
                },
                operation: publicCodexUpdateOperation(current),
              });
              return;
            }
            patchCodexUpdateOperation(current, {
              status: 'interrupted',
              phase: 'interrupted',
              message: error.message || 'Host Codex update response was interrupted.',
            });
            throw hostCodexUpdateError(
              'codex_update_timeout',
              error.message || 'Host Codex update timed out.',
              { statusCode: 504 }
            );
          }
          sendJson(res, 200, {
            ok: result.ok === true,
            result,
            operation: publicCodexUpdateOperation(currentCodexUpdateOperation(hostId)),
          });
          return;
        }

        if (action === 'resuming') {
          if (
            operation.sessions.length === 0
            && ['completed', 'failed'].includes(operation.status)
          ) {
            sendJson(res, 200, {
              ok: operation.status === 'completed',
              operation: publicCodexUpdateOperation(operation),
            });
            return;
          }
          if (['updating', 'checking', 'installing', 'verifying'].includes(operation.status)) {
            throw hostCodexUpdateError(
              'codex_update_still_running',
              `Codex update is still ${operation.status}.`
            );
          }
          if (codexUpdaterIsActive(hostId, operation.operationId)) {
            throw hostCodexUpdateError(
              'codex_update_still_running',
              'Host Agent still reports an active Codex updater.'
            );
          }
          const stillStopping = codexUpdateSessionsStillStopping(operation);
          if (stillStopping.length) {
            throw hostCodexUpdateError(
              'codex_update_sessions_still_stopping',
              `${stillStopping.length} Session(s) are still stopping; wait for confirmed process exit before recovery.`,
              { sessionIds: stillStopping.map((session) => session.sessionId) }
            );
          }
          const recoveryOnly = body.recoveryOnly === true;
          if (
            !['updated', 'update_failed', 'resuming'].includes(operation.status)
            && !(recoveryOnly && ['planned', 'stopping_sessions', 'interrupted'].includes(operation.status))
          ) {
            throw hostCodexUpdateError(
              'codex_update_invalid_state',
              `Session recovery cannot start while operation is ${operation.status}.`
            );
          }
          const next = patchCodexUpdateOperation(operation, {
            status: 'resuming',
            phase: 'resuming',
            message: operation.sessions.length
              ? `Resuming ${operation.sessions.length} managed Session(s).`
              : 'No managed Sessions need to be resumed.',
          });
          sendJson(res, 200, { ok: true, operation: publicCodexUpdateOperation(next) });
          return;
        }

        if (action === 'complete') {
          if (operation.status !== 'resuming') {
            if (['completed', 'completed_with_resume_failures', 'failed', 'cancelled'].includes(operation.status)) {
              sendJson(res, 200, {
                ok: operation.status === 'completed',
                operation: publicCodexUpdateOperation(operation),
              });
              return;
            }
            throw hostCodexUpdateError(
              'codex_update_invalid_state',
              `Codex maintenance cannot complete while operation is ${operation.status}.`
            );
          }
          if (codexUpdaterIsActive(hostId, operation.operationId)) {
            throw hostCodexUpdateError(
              'codex_update_still_running',
              'Host Agent still reports an active Codex updater.'
            );
          }
          const stillStopping = codexUpdateSessionsStillStopping(operation);
          if (stillStopping.length) {
            throw hostCodexUpdateError(
              'codex_update_sessions_still_stopping',
              `${stillStopping.length} Session(s) are still stopping; maintenance cannot complete yet.`,
              { sessionIds: stillStopping.map((session) => session.sessionId) }
            );
          }
          const recovery = codexUpdateRecoveryState(operation);
          if (recovery.pending.length) {
            throw hostCodexUpdateError(
              'codex_update_recovery_pending',
              `${recovery.pending.length} Session(s) have not reached a live or explicit recovery-failed state.`,
              { sessionIds: recovery.pending.map((session) => session.sessionId) }
            );
          }
          const resumeFailures = recovery.failures.map((session) => (
            `${session.sessionId}: ${session.message || 'Session remains stopped.'}`
          ));
          const stopFailures = Array.isArray(body.stopFailures) ? body.stopFailures : [];
          const updateSucceeded = operation.updateSucceeded === true;
          const status = updateSucceeded
            ? (resumeFailures.length ? 'completed_with_resume_failures' : 'completed')
            : 'failed';
          const next = patchCodexUpdateOperation(operation, {
            status,
            phase: status,
            message: String(body.message || (
              status === 'completed'
                ? 'Codex update and Session resume completed.'
                : status === 'completed_with_resume_failures'
                  ? 'Codex updated, but some Sessions could not be resumed.'
                  : 'Codex maintenance failed; stopped Sessions were offered for recovery.'
            )),
            stopFailures,
            resumeFailures,
            completedAt: nowIso(),
          });
          sendJson(res, 200, { ok: status === 'completed', operation: publicCodexUpdateOperation(next) });
          return;
        }

        if (action === 'cancel') {
          if (!ACTIVE_CODEX_UPDATE_STATUSES.has(operation.status)) {
            throw hostCodexUpdateError(
              'codex_update_invalid_state',
              `Completed Codex maintenance cannot be changed from ${operation.status} to cancelled.`
            );
          }
          if (
            ['updating', 'checking', 'installing', 'verifying'].includes(operation.status)
            || codexUpdaterIsActive(hostId, operation.operationId)
          ) {
            throw hostCodexUpdateError(
              'codex_update_cannot_cancel',
              'Codex package installation is already running and cannot be cancelled safely.'
            );
          }
          if (body.confirmAbandonStoppedSessions !== true && operation.sessions.some((session) => (
            ['stopping', 'stopped', 'installing', 'resuming', 'resume_failed', 'left_stopped'].includes(session.status)
          ))) {
            throw hostCodexUpdateError(
              'codex_update_recovery_required',
              'Recover or explicitly abandon stopped Sessions before clearing maintenance.'
            );
          }
          const next = patchCodexUpdateOperation(operation, {
            status: 'cancelled',
            phase: 'cancelled',
            message: String(body.message || 'Codex maintenance was cancelled.'),
            completedAt: nowIso(),
          });
          sendJson(res, 200, { ok: true, operation: publicCodexUpdateOperation(next) });
          return;
        }

        sendJson(res, 400, { error: 'action must be prepare, session-progress, apply, resuming, complete, or cancel' });
      } catch (error) {
        sendJson(res, Number(error.statusCode || 500), {
          error: error.message || 'Host Codex update failed',
          code: error.code || 'codex_update_failed',
          operation: error.operation || publicCodexUpdateOperation(currentCodexUpdateOperation(hostId)),
          sessions: error.sessions || undefined,
          blockedSessionIds: error.blockedSessionIds || undefined,
          sessionIds: error.sessionIds || undefined,
          managedSessionIds: error.managedSessionIds || undefined,
          unmanagedSessionIds: error.unmanagedSessionIds || undefined,
        });
      }
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    sendJson(res, 200, getStats());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session-collections') {
    sendJson(res, 200, { collections: getSessionCollectionList() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions/search') {
    const query = String(url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
    if (query.length < 2) {
      sendJson(res, 200, {
        query,
        mode: url.searchParams.get('mode') || 'keyword',
        results: [],
        scannedSessions: 0,
        truncated: false,
      });
      return;
    }
    const payload = await searchSessionsHydrated({
      hostId: url.searchParams.get('hostId') || '',
      collectionId: url.searchParams.get('collectionId') || '',
      mode: url.searchParams.get('mode') || 'keyword',
      query,
      maxSessions: url.searchParams.get('limit') || 80,
      maxMatchesPerSession: url.searchParams.get('matchesPerSession') || 5,
    });
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session-collections') {
    const body = await readBody(req);
    const collection = normalizeSessionCollection({
      name: body.name || 'Untitled',
      items: [],
    });
    state.sessionCollections.set(collection.collectionId, collection);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection });
    return;
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/session-collections\/[^/]+$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    const existing = state.sessionCollections.get(collectionId);
    if (!existing) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    if (collectionId === DEFAULT_COLLECTION_ID) {
      sendJson(res, 409, { error: 'default collection cannot be renamed' });
      return;
    }

    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'collection name is required' });
      return;
    }

    const collection = {
      ...existing,
      name,
      updatedAt: nowIso(),
    };
    state.sessionCollections.set(collectionId, collection);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/session-collections\/[^/]+$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    if (collectionId === DEFAULT_COLLECTION_ID || collectionId === TRASH_COLLECTION_ID) {
      sendJson(res, 409, { error: 'system collection cannot be deleted' });
      return;
    }
    const existed = state.sessionCollections.delete(collectionId);
    if (!existed) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collectionId });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session-collections/trash/preview') {
    const body = await readBody(req);
    const item = normalizeSessionCollectionItem(body.item || body);
    if (!item) {
      sendJson(res, 400, { error: 'hostId and conversationKey are required' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      item,
      previousCollections: findCollectionMembershipsForItem(item),
      discarded: isCollectionItemDiscarded(item),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session-collections/trash/items') {
    const body = await readBody(req);
    try {
      const result = moveCollectionItemToTrash(body.item || body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'failed to move item to trash' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session-collections/trash/items/restore') {
    const body = await readBody(req);
    try {
      const result = restoreCollectionItemFromTrash(body.item || body);
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 404, { error: error.message || 'trash item not found' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session-collections/trash/empty') {
    const result = emptyTrashCollection();
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/session-collections\/[^/]+\/items$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    const collection = state.sessionCollections.get(collectionId);
    if (!collection) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    if (collectionId === DEFAULT_COLLECTION_ID || collectionId === TRASH_COLLECTION_ID) {
      sendJson(res, 409, { error: 'system collection items must use their dedicated actions' });
      return;
    }

    const body = await readBody(req);
    const item = normalizeSessionCollectionItem(body.item || body);
    if (!item) {
      sendJson(res, 400, { error: 'hostId and conversationKey are required' });
      return;
    }

    const existingItems = filterCollectionItems(collection.items, item);
    const next = {
      ...collection,
      items: [...existingItems, item],
      updatedAt: nowIso(),
    };
    rememberSessionTitle(item.hostId, [item.conversationKey, item.sessionId], item.title, {
      cwd: item.cwd || '',
      source: `collection:${collectionId}`,
    });
    state.sessionCollections.set(collectionId, next);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection: next, item });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/session-collections\/[^/]+\/items\/remove$/)) {
    const collectionId = decodeURIComponent(url.pathname.split('/')[3]);
    const collection = state.sessionCollections.get(collectionId);
    if (!collection) {
      sendJson(res, 404, { error: 'collection not found' });
      return;
    }
    if (collectionId === DEFAULT_COLLECTION_ID || collectionId === TRASH_COLLECTION_ID) {
      sendJson(res, 409, { error: 'system collection items must use their dedicated actions' });
      return;
    }

    const body = await readBody(req);
    const item = normalizeSessionCollectionItem(body.item || body);
    if (!item) {
      sendJson(res, 400, { error: 'hostId and conversationKey are required' });
      return;
    }

    const next = {
      ...collection,
      items: filterCollectionItems(collection.items, item),
      updatedAt: nowIso(),
    };
    state.sessionCollections.set(collectionId, next);
    persistSessionCollections();
    sendJson(res, 200, { ok: true, collection: next });
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

  if (req.method === 'GET' && url.pathname.match(/^\/api\/connectors\/[^/]+\/action-prompts$/)) {
    const connectorId = decodeURIComponent(url.pathname.split('/')[3]);
    const actionId = String(url.searchParams.get('actionId') || '').trim();
    const token = String(url.searchParams.get('token') || '').trim();
    const record = getAskpassAction(connectorId, actionId, token);
    if (!record) {
      sendJson(res, 404, { error: 'askpass action not found', prompts: [] });
      return;
    }
    const prompts = Array.from(record.prompts.values())
      .filter((prompt) => !prompt.responseReady && !prompt.cancelled)
      .map(publicAskpassPrompt);
    sendJson(res, 200, { ok: true, prompts, closed: record.closed });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/connectors\/[^/]+\/action-prompts\/[^/]+$/)) {
    const parts = url.pathname.split('/');
    const connectorId = decodeURIComponent(parts[3]);
    const promptId = decodeURIComponent(parts[5]);
    const body = await readBody(req);
    const actionId = String(body.actionId || '').trim();
    const token = String(body.token || '').trim();
    const record = getAskpassAction(connectorId, actionId, token);
    const prompt = getAskpassPrompt(record, promptId);
    if (!prompt) {
      sendJson(res, 404, { error: 'askpass prompt not found' });
      return;
    }
    if (body.cancel) {
      prompt.cancelled = true;
      prompt.responseReady = false;
      prompt.updatedAt = nowIso();
      cancelAskpassAction(record);
      sendJson(res, 200, { ok: true, prompt: publicAskpassPrompt(prompt) });
      return;
    }
    prompt.response = String(body.response || '');
    prompt.responseReady = true;
    prompt.updatedAt = nowIso();
    record.updatedAt = nowIso();
    sendJson(res, 200, { ok: true, prompt: publicAskpassPrompt(prompt) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/askpass/prompts') {
    const body = await readBody(req);
    const prompt = createAskpassPrompt({
      connectorId: String(body.connectorId || '').trim(),
      actionId: String(body.actionId || '').trim(),
      token: String(body.token || '').trim(),
      prompt: String(body.prompt || '').trim(),
    });
    if (!prompt) {
      sendJson(res, 403, { error: 'askpass action not available' });
      return;
    }
    sendJson(res, 200, publicAskpassPrompt(prompt));
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/askpass\/prompts\/[^/]+$/)) {
    const promptId = decodeURIComponent(url.pathname.split('/')[4]);
    const connectorId = String(url.searchParams.get('connectorId') || '').trim();
    const actionId = String(url.searchParams.get('actionId') || '').trim();
    const token = String(url.searchParams.get('token') || '').trim();
    const record = getAskpassAction(connectorId, actionId, token);
    const prompt = getAskpassPrompt(record, promptId);
    if (!prompt) {
      sendJson(res, 404, { status: 'closed' });
      return;
    }
    if (prompt.cancelled || record.closed) {
      sendJson(res, 200, { status: 'cancelled' });
      return;
    }
    if (prompt.responseReady) {
      sendJson(res, 200, { status: 'answered', response: prompt.response });
      return;
    }
    sendJson(res, 200, { status: 'pending' });
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
    const activeAction = state.connectorActionsInFlight.get(connector.connectorId) || null;
    if (activeAction) {
      sendJson(res, 409, {
        ok: false,
        action,
        status: 'connector_action_in_progress',
        error: `Connector action ${activeAction.action || 'unknown'} is already running.`,
        activeAction,
      });
      return;
    }
    const actionLease = {
      action,
      startedAt: nowIso(),
    };
    state.connectorActionsInFlight.set(connector.connectorId, actionLease);
    let askpassRecord = null;
    try {
      upsertConnectorSecretsFromBody(connector.connectorId, body);
      const requestOrigin = body.clientOrigin || (req.headers.host ? `http://${req.headers.host}` : '');
      const actionConnector = (action === 'bootstrap' || action === 'restart')
        ? connectorWithActionRelayOrigin(connector, requestOrigin)
        : connector;
      if ((action === 'bootstrap' || action === 'restart') && actionConnector.hostId) {
        restoreDismissedHost(actionConnector.hostId);
      }
      const actionSecret = buildConnectorActionSecret(connector.connectorId, body);
      askpassRecord = registerAskpassAction(connector.connectorId, action, actionSecret);
      const result = await runConnectorAction(actionConnector, action, actionSecret);
      sendJson(res, result.httpStatus, result.payload);
    } finally {
      closeAskpassAction(askpassRecord);
      if (state.connectorActionsInFlight.get(connector.connectorId) === actionLease) {
        state.connectorActionsInFlight.delete(connector.connectorId);
      }
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    if (!writeSkillsEvent(res, 'ready', { ok: true, time: nowIso() })) {
      return;
    }
    state.skillSubscribers.add(res);
    const ping = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        state.skillSubscribers.delete(res);
        clearInterval(ping);
        return;
      }
      try {
        if (!writeSkillsEvent(res, 'ping', { time: nowIso() })) {
          state.skillSubscribers.delete(res);
          clearInterval(ping);
        }
      } catch (_) {
        state.skillSubscribers.delete(res);
        clearInterval(ping);
      }
    }, 20000);
    ping.unref?.();
    req.on('close', () => {
      clearInterval(ping);
      state.skillSubscribers.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills') {
    try {
      sendJson(res, 200, await buildSkillsManagerPayload());
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills/audit') {
    try {
      sendJson(res, 200, state.skillAudit.query({
        afterSequence: url.searchParams.get('afterSequence'),
        limit: url.searchParams.get('limit'),
        type: url.searchParams.get('type'),
      }));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/deployments') {
    const body = await readBody(req);
    try {
      const created = createSkillDeployment(body);
      sendJson(res, created.reused ? 200 : 202, {
        ok: true,
        reused: created.reused,
        deployment: created.deployment,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  const skillDeploymentStatusMatch = url.pathname.match(/^\/api\/skills\/deployments\/([^/]+)$/);
  if (req.method === 'GET' && skillDeploymentStatusMatch) {
    const deploymentId = decodeURIComponent(skillDeploymentStatusMatch[1]);
    const deployment = state.skillDeployments.getDeployment(deploymentId);
    if (!deployment) {
      sendJson(res, 404, { error: 'Skill deployment was not found' });
      return;
    }
    sendJson(res, 200, { deployment });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/adopt') {
    const body = await readBody(req);
    try {
      const queued = queueSkillAdoption(body);
      sendJson(res, 202, {
        ok: true,
        reused: queued.reused,
        ...publicSkillAdoption(queued.adoption),
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/import') {
    const body = await readBody(req);
    const source = body.source && typeof body.source === 'object' ? body.source : body;
    const kind = String(source.kind || (body.hostId ? 'local-host' : '')).trim().toLowerCase();
    try {
      if (kind === 'github') {
        const queued = queueGithubSkillImport(source);
        sendJson(res, 202, { ok: true, ...publicSkillImport(queued) });
      } else if (kind === 'local-host' || kind === 'cc-switch') {
        const queued = queueSkillAdoption({
          hostId: body.hostId || source.hostId,
          instanceId: body.instanceId || source.instanceId,
        });
        sendJson(res, 202, {
          ok: true,
          importId: queued.adoption.adoptionId,
          kind,
          delegatedTo: 'adoption',
          reused: queued.reused,
          ...publicSkillAdoption(queued.adoption),
        });
      } else {
        throw skillApiError(400, 'source.kind must be github, local-host, or cc-switch');
      }
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  const skillImportStatusMatch = url.pathname.match(/^\/api\/skills\/imports\/([^/]+)$/);
  if (req.method === 'GET' && skillImportStatusMatch) {
    const importId = decodeURIComponent(skillImportStatusMatch[1]);
    const record = state.skillImports.get(importId);
    if (!record) {
      sendJson(res, 404, { error: 'Skill import was not found or has expired' });
      return;
    }
    sendJson(res, 200, { import: publicSkillImport(record) });
    return;
  }

  const skillAdoptionStatusMatch = url.pathname.match(/^\/api\/skills\/adoptions\/([^/]+)$/);
  if (req.method === 'GET' && skillAdoptionStatusMatch) {
    const adoptionId = decodeURIComponent(skillAdoptionStatusMatch[1]);
    const adoption = state.skillAdoptions.get(adoptionId);
    if (!adoption) {
      sendJson(res, 404, { error: 'Skill adoption was not found or has expired' });
      return;
    }
    sendJson(res, 200, { adoption: publicSkillAdoption(adoption) });
    return;
  }

  const skillArtifactUploadMatch = url.pathname.match(/^\/api\/agent\/skills\/adoptions\/([^/]+)\/artifact$/);
  if (req.method === 'PUT' && skillArtifactUploadMatch) {
    const adoptionId = decodeURIComponent(skillArtifactUploadMatch[1]);
    try {
      const imported = await handleSkillArtifactUpload(req, adoptionId);
      sendJson(res, 201, {
        ok: true,
        adoptionId,
        artifactId: imported.artifact.artifactId,
        deduplicated: imported.deduplicated,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  const skillArtifactDownloadMatch = url.pathname.match(/^\/api\/agent\/skills\/artifacts\/([^/]+)$/);
  if (req.method === 'GET' && skillArtifactDownloadMatch) {
    try {
      await streamSkillArtifactDownload(req, res, decodeURIComponent(skillArtifactDownloadMatch[1]));
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, error.statusCode || 500, { error: error.message });
      } else if (!res.destroyed) {
        res.destroy(error);
      }
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/refresh') {
    const body = await readBody(req);
    if (body.hostIds != null && !Array.isArray(body.hostIds)) {
      sendJson(res, 400, { error: 'hostIds must be an array' });
      return;
    }
    sendJson(res, 202, queueSkillInventoryRefreshes(body.hostIds));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/favorites') {
    const body = await readBody(req);
    const skillId = String(body.skillId || '').trim();
    if (!skillId) {
      sendJson(res, 400, { error: 'skillId is required' });
      return;
    }
    const favorite = body.favorite !== false;
    if (favorite) {
      state.skillFavorites.add(skillId);
    } else {
      state.skillFavorites.delete(skillId);
    }
    saveSkillFavorites(state.skillFavorites);
    sendJson(res, 200, {
      ok: true,
      skillId,
      favorite,
      favorites: Array.from(state.skillFavorites).sort(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills/sources') {
    const registrySnapshot = skillRegistrySnapshot();
    sendJson(res, 200, {
      sources: combinedSkillSources(registrySnapshot),
      catalog: buildSkillCatalogFromSources(),
      dailySkillDigest: dailySkillDigest(buildSkillCatalogFromSources()),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/sources') {
    const body = await readBody(req);
    const sources = (Array.isArray(body.sources) ? body.sources : [])
      .map(normalizeSkillSource);
    state.skillSources = sources;
    saveSkillSources(state.skillSources);
    const catalog = buildSkillCatalogFromSources();
    sendJson(res, 200, {
      ok: true,
      sources: state.skillSources,
      catalog,
      dailySkillDigest: dailySkillDigest(catalog),
    });
    return;
  }

  const skillSourceRefreshMatch = url.pathname.match(
    /^\/api\/skills\/sources\/([^/]+)\/refresh$/
  );
  if (req.method === 'POST' && skillSourceRefreshMatch) {
    const body = await readBody(req);
    try {
      const sourceId = decodeURIComponent(skillSourceRefreshMatch[1]);
      const queued = await queueRegistrySkillSourceRefresh(sourceId, {
        expectedRevision: body.expectedRevision,
      });
      sendJson(res, 202, {
        ok: true,
        ...publicSkillImport(queued),
        registryRevision: state.skillRegistry.snapshot({ includeManifest: false }).revision,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.message,
        ...(error.revision == null ? {} : { revision: error.revision }),
      });
    }
    return;
  }

  const skillSourceAutomationMatch = url.pathname.match(
    /^\/api\/skills\/sources\/([^/]+)\/automation$/
  );
  if (req.method === 'POST' && skillSourceAutomationMatch) {
    const body = await readBody(req);
    try {
      const sourceId = decodeURIComponent(skillSourceAutomationMatch[1]);
      const updated = await state.skillRegistry.updateSourceAutomation(sourceId, {
        expectedRevision: body.expectedRevision,
        refreshPolicy: body.refreshPolicy,
        rolloutPolicy: body.rolloutPolicy,
      });
      recordSkillAudit('skills.source.automation_updated', {
        sourceId,
        refreshPolicy: updated.source.refreshPolicy,
        rolloutPolicy: updated.source.rolloutPolicy,
        revision: updated.revision,
        idempotent: updated.idempotent,
      }, { actor: 'relay-api', subject: sourceId });
      broadcastSkillsLibraryUpdated({
        sourceId,
        reason: 'automation-policy',
        refreshPolicy: updated.source.refreshPolicy,
        rolloutPolicy: updated.source.rolloutPolicy,
        registryRevision: updated.revision,
        updatedAt: updated.source.updatedAt,
      });
      sendJson(res, 200, { ok: true, ...updated });
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.message,
        ...(error.revision == null ? {} : { revision: error.revision }),
      });
    }
    return;
  }

  const skillLibraryReferencesMatch = url.pathname.match(
    /^\/api\/skills\/library\/([^/]+)\/references$/
  );
  if (req.method === 'GET' && skillLibraryReferencesMatch) {
    try {
      const skillId = decodeURIComponent(skillLibraryReferencesMatch[1]);
      const libraryRecord = state.skillRegistry.getLibraryRecord(skillId);
      if (!libraryRecord) {
        throw skillApiError(404, 'Library Skill was not found');
      }
      const report = state.skillRegistry.referenceReport({
        artifactIds: libraryRecord.artifactIds,
        references: collectSkillArtifactReferences(),
      });
      sendJson(res, 200, {
        ...report,
        libraryRecord,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.message,
        ...(error.revision == null ? {} : { revision: error.revision }),
      });
    }
    return;
  }

  const skillLibraryLifecycleMatch = url.pathname.match(
    /^\/api\/skills\/library\/([^/]+)\/(retire|restore)$/
  );
  if (req.method === 'POST' && skillLibraryLifecycleMatch) {
    const body = await readBody(req);
    try {
      const skillId = decodeURIComponent(skillLibraryLifecycleMatch[1]);
      const action = skillLibraryLifecycleMatch[2];
      const result = action === 'retire'
        ? await state.skillRegistry.retireSkill(skillId, {
          expectedRevision: body.expectedRevision,
        })
        : await state.skillRegistry.restoreSkill(skillId, {
          expectedRevision: body.expectedRevision,
        });
      const payload = {
        skillId: result.libraryRecord.skillId,
        state: action === 'retire' ? 'retired' : 'restored',
        revision: result.revision,
        idempotent: result.idempotent,
        updatedAt: result.libraryRecord.updatedAt,
      };
      broadcastSkillsLibraryUpdated(payload);
      recordSkillAudit(`skills.library.${action}`, payload, {
        actor: 'relay-api',
        subject: result.libraryRecord.skillId,
      });
      sendJson(res, 200, {
        ok: true,
        ...result,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.message,
        ...(error.revision == null ? {} : { revision: error.revision }),
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/artifacts/gc') {
    const body = await readBody(req);
    try {
      if (body.artifactIds != null && !Array.isArray(body.artifactIds)) {
        throw skillApiError(400, 'artifactIds must be an array');
      }
      const explicitArtifactIds = body.artifactIds != null;
      const result = await state.skillRegistry.collectGarbage({
        artifactIds: explicitArtifactIds ? body.artifactIds : undefined,
        expectedRevision: body.expectedRevision,
        referenceProvider: () => collectSkillArtifactReferences(),
        requireAllUnreferenced: explicitArtifactIds,
      });
      const blocked = explicitArtifactIds && result.blockedArtifactIds.length > 0;
      if (!blocked && (result.collectedArtifactIds.length || result.pendingArtifactIds.length)) {
        broadcastSkillsLibraryUpdated({
          state: 'garbage-collected',
          revision: result.revision,
          collectedArtifactIds: result.collectedArtifactIds,
          pendingArtifactIds: result.pendingArtifactIds,
          updatedAt: nowIso(),
        });
      }
      recordSkillAudit('skills.artifacts.gc', {
        requestedArtifactIds: explicitArtifactIds ? body.artifactIds : null,
        blockedArtifactIds: result.blockedArtifactIds,
        pendingArtifactIds: result.pendingArtifactIds,
        collectedArtifactIds: result.collectedArtifactIds,
        errors: result.errors,
        revision: result.revision,
      }, { actor: 'relay-api' });
      sendJson(res, blocked ? 409 : 200, {
        ok: !blocked && result.errors.length === 0,
        ...result,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, {
        error: error.message,
        ...(error.revision == null ? {} : { revision: error.revision }),
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/skills/library') {
    const registrySnapshot = skillRegistrySnapshot();
    sendJson(res, 200, {
      skills: combinedSkillLibrary(registrySnapshot),
      artifacts: (registrySnapshot.artifacts || []).map(publicSkillArtifact),
      catalog: mergeSkillLibraryWithCatalog(buildSkillCatalogFromSources()),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/library') {
    const body = await readBody(req);
    const incoming = Array.isArray(body.skills) ? body.skills : [body.skill || body];
    const saved = [];
    try {
      for (const entry of incoming) {
        saved.push(upsertSkillLibraryRecord(entry));
      }
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    const catalog = mergeSkillLibraryWithCatalog(buildSkillCatalogFromSources());
    sendJson(res, 200, {
      ok: true,
      saved,
      skills: state.skillLibrary || [],
      catalog,
      dailySkillDigest: dailySkillDigest(catalog),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/skills/actions') {
    const body = await readBody(req);
    const action = String(body.action || '').trim();
    if (action !== 'install' && action !== 'uninstall') {
      sendJson(res, 400, { error: 'action must be install or uninstall' });
      return;
    }
    const hostIds = (Array.isArray(body.hostIds) ? body.hostIds : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    const skillIds = (Array.isArray(body.skillIds) ? body.skillIds : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    if (!hostIds.length || !skillIds.length) {
      sendJson(res, 400, { error: 'hostIds and skillIds are required' });
      return;
    }
    const phase3HostIds = hostIds.filter((hostId) => (
      state.hosts.get(hostId)?.capabilities?.hostSkillDeploymentV1
    ));
    if (phase3HostIds.length) {
      sendJson(res, 409, {
        error: 'Legacy Skill actions are disabled for Phase 3 deployment Hosts; use Artifact deployments',
        hostIds: phase3HostIds,
      });
      return;
    }
    const results = await runSkillsBatchAction(action, hostIds, skillIds);
    sendJson(res, 200, {
      ok: results.every((result) => result.ok),
      action,
      results,
      ...(await buildSkillsManagerPayload()),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/hosts\/[^/]+\/sessions$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const refreshRequested = url.searchParams.get('refresh') === '1';
    const optimize = url.searchParams.get('full') !== '1' && url.searchParams.get('optimize') !== '0';
    const discoveryRequested = refreshRequested ? requestHostSessionDiscovery(hostId) : false;
    sendJson(res, 200, {
      sessions: getSessionsForHost(hostId, { optimize }),
      discoveryRequested,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/probe$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const host = state.hosts.get(hostId);
    if (!host) {
      sendJson(res, 404, { error: 'host not found' });
      return;
    }
    if (!hostOnline(host)) {
      sendJson(res, 409, { error: `host ${host.label || hostId} is offline` });
      return;
    }

    if (!host.capabilities?.hostProbe) {
      sendJson(res, 200, {
        ok: true,
        hostId,
        mode: 'heartbeat',
        message: 'Host is online by heartbeat. Restart its agent to enable active probe checks.',
      });
      return;
    }

    const requestId = makeId();
    enqueueCommand(hostId, {
      type: 'host.probe',
      requestId,
    });

    try {
      const result = await awaitHostProbe(requestId);
      sendJson(res, 200, {
        ok: true,
        hostId,
        mode: 'active',
        ...result,
      });
    } catch (error) {
      const currentHost = state.hosts.get(hostId) || host;
      if (hostHasFreshHeartbeat(currentHost)) {
        sendJson(res, 200, {
          ok: true,
          hostId,
          mode: 'heartbeat-fallback',
          warning: `Active health check timed out, but ${currentHost.label || hostId} has a fresh heartbeat.`,
          heartbeatAgeMs: Math.max(0, Math.round(hostHeartbeatAgeMs(currentHost))),
        });
        return;
      }
      sendJson(res, 504, {
        ok: false,
        hostId,
        error: `host ${host.label || hostId} did not answer the health check: ${error.message}`,
      });
    }
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

    try {
      const result = await awaitDirectoryRequest(requestId);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 504, {
        error: error.message || 'directory listing timed out',
        hostId,
        path: targetPath || null,
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/uploads$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const capabilityError = getHostCapabilityError(
      hostId,
      'chunkedFileTransfer',
      'this host agent needs to be restarted before it can upload large files'
    );
    if (capabilityError) {
      sendJson(res, capabilityError.statusCode, { error: capabilityError.error });
      return;
    }

    const body = await readBody(req);
    let file = null;
    try {
      file = validateChunkedUploadMetadata(body);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    const uploadId = makeId();
    const requestId = makeId();
    const sessionId = String(body.sessionId || '').trim() || null;
    const targetDirectory = String(body.targetDirectory || body.cwd || '').trim() || null;
    const chunkSize = Math.max(1, Math.min(Number(body.chunkSize || FILE_TRANSFER_CHUNK_BYTES) || FILE_TRANSFER_CHUNK_BYTES, FILE_TRANSFER_CHUNK_BYTES));
    const upload = {
      uploadId,
      hostId,
      sessionId,
      targetDirectory,
      file,
      chunkSize,
      receivedBytes: 0,
      createdAt: nowIso(),
    };
    state.chunkedUploads.set(uploadId, upload);

    const pending = awaitFileRequest(requestId, 120000, {
      suppressAlert: false,
      source: 'upload-begin',
    });
    enqueueCommand(hostId, {
      type: 'host.file_upload_begin',
      requestId,
      uploadId,
      fileId: file.fileId,
      sessionId,
      targetDirectory,
      name: file.name,
      mime: file.mime,
      size: file.size,
    });

    try {
      const ready = await pending;
      upload.remotePath = ready.path || null;
      upload.remoteName = ready.name || file.name;
      upload.targetDirectory = ready.targetDirectory || targetDirectory;
      state.chunkedUploads.set(uploadId, upload);
      sendJson(res, 200, {
        ok: true,
        hostId,
        uploadId,
        fileId: file.fileId,
        name: upload.remoteName,
        path: upload.remotePath,
        size: file.size,
        mime: file.mime,
        chunkSize,
      });
    } catch (error) {
      state.chunkedUploads.delete(uploadId);
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/uploads\/[^/]+\/chunks$/)) {
    const parts = url.pathname.split('/');
    const hostId = decodeURIComponent(parts[3]);
    const uploadId = decodeURIComponent(parts[6] || '');
    const upload = getChunkedUpload(hostId, uploadId);
    if (!upload) {
      sendJson(res, 404, { error: 'upload not found or expired' });
      return;
    }

    const body = await readBody(req);
    let chunk = null;
    try {
      chunk = validateChunkPayload(body);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (chunk.offset !== upload.receivedBytes) {
      sendJson(res, 409, { error: `upload offset mismatch: expected ${upload.receivedBytes}, got ${chunk.offset}` });
      return;
    }

    const requestId = makeId();
    const pending = awaitFileRequest(requestId, 120000, {
      suppressAlert: true,
      source: 'upload-chunk',
    });
    enqueueCommand(hostId, {
      type: 'host.file_upload_chunk',
      requestId,
      uploadId,
      sessionId: upload.sessionId,
      index: chunk.index,
      offset: chunk.offset,
      dataBase64: chunk.dataBase64,
    });

    try {
      const result = await pending;
      upload.receivedBytes = Number(result.receivedBytes || 0) || upload.receivedBytes;
      state.chunkedUploads.set(uploadId, upload);
      sendJson(res, 200, {
        ok: true,
        hostId,
        uploadId,
        receivedBytes: upload.receivedBytes,
        size: upload.file.size,
      });
    } catch (error) {
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/uploads\/[^/]+\/complete$/)) {
    const parts = url.pathname.split('/');
    const hostId = decodeURIComponent(parts[3]);
    const uploadId = decodeURIComponent(parts[6] || '');
    const upload = getChunkedUpload(hostId, uploadId);
    if (!upload) {
      sendJson(res, 404, { error: 'upload not found or expired' });
      return;
    }

    const requestId = makeId();
    const pending = awaitFileRequest(requestId, 120000, {
      suppressAlert: false,
      source: 'upload-complete',
    });
    enqueueCommand(hostId, {
      type: 'host.file_upload_complete',
      requestId,
      uploadId,
      sessionId: upload.sessionId,
    });

    try {
      const result = await pending;
      state.chunkedUploads.delete(uploadId);
      sendJson(res, 200, {
        ok: true,
        hostId,
        uploadId,
        files: normalizeFileTransferRefs(result.files || []),
      });
    } catch (error) {
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/uploads\/[^/]+$/)) {
    const parts = url.pathname.split('/');
    const hostId = decodeURIComponent(parts[3]);
    const uploadId = decodeURIComponent(parts[6] || '');
    const upload = getChunkedUpload(hostId, uploadId);
    if (upload) {
      state.chunkedUploads.delete(uploadId);
      enqueueCommand(hostId, {
        type: 'host.file_upload_abort',
        requestId: makeId(),
        uploadId,
        sessionId: upload.sessionId,
      });
    }
    sendJson(res, 200, { ok: true, hostId, uploadId });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/upload$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const capabilityError = getHostCapabilityError(
      hostId,
      'fileTransfer',
      'this host agent needs to be restarted before it can upload files'
    );
    if (capabilityError) {
      sendJson(res, capabilityError.statusCode, { error: capabilityError.error });
      return;
    }

    const body = await readBody(req);
    let files = [];
    try {
      files = validateUploadFiles(body.files || []);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (!files.length) {
      sendJson(res, 400, { error: 'files are required' });
      return;
    }

    const requestId = makeId();
    const pending = awaitFileRequest(requestId);
    enqueueCommand(hostId, {
      type: 'host.file_upload',
      requestId,
      sessionId: String(body.sessionId || '').trim() || null,
      targetDirectory: String(body.targetDirectory || body.cwd || '').trim() || null,
      files,
    });

    try {
      const result = await pending;
      sendJson(res, 200, {
        ok: true,
        hostId,
        requestId,
        files: normalizeFileTransferRefs(result.files || []),
      });
    } catch (error) {
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/received-files\/[^/]+$/)) {
    pruneReceivedFiles();
    const fileId = decodeURIComponent(url.pathname.split('/')[3]);
    const record = state.receivedFiles.get(fileId);
    const inline = url.searchParams.get('inline') === '1' || url.searchParams.get('inline') === 'true';
    serveReceivedFile(res, record, inline);
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/received-files$/)) {
    pruneReceivedFiles();
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = String(url.searchParams.get('hostId') || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    const files = Array.from(state.receivedFiles.values())
      .filter((file) => file.hostId === hostId && file.sessionId === sessionId)
      .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
      .map((file) => ({
        fileId: file.fileId,
        hostId: file.hostId,
        sessionId: file.sessionId,
        remotePath: file.remotePath,
        name: file.name,
        mime: file.mime,
        size: file.size,
        receivedAt: file.receivedAt,
        lastAccessedAt: file.lastAccessedAt,
        expiresAt: file.expiresAt,
        url: `/api/received-files/${encodeURIComponent(file.fileId)}`,
      }));
    sendJson(res, 200, {
      root: RECEIVED_FILES_ROOT,
      ttlMs: RECEIVED_FILE_TTL_MS,
      files,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/hosts\/[^/]+\/files\/download$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const sessionId = String(url.searchParams.get('sessionId') || '').trim() || null;
    const remotePath = normalizeRemoteFilePath(url.searchParams.get('path') || '');
    const inline = url.searchParams.get('inline') === '1' || url.searchParams.get('inline') === 'true';
    const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    if (!remotePath) {
      sendJson(res, 400, { error: 'path is required' });
      return;
    }
    if (isAmbiguousBareDownloadPath(remotePath)) {
      sendJson(res, 400, {
        error: 'remote file path must include a directory or be absolute; bare file names are ambiguous',
      });
      return;
    }

    const cached = !refresh ? findReceivedFile(hostId, sessionId || '', remotePath) : null;
    if (cached) {
      serveReceivedFile(res, cached, inline);
      return;
    }

    const capabilityError = getHostCapabilityError(
      hostId,
      'fileTransfer',
      'this host agent needs to be restarted before it can download files'
    );
    if (capabilityError) {
      sendJson(res, capabilityError.statusCode, { error: capabilityError.error });
      return;
    }

    try {
      const cwd = String(url.searchParams.get('cwd') || '').trim() || null;
      const forcedChunked = url.searchParams.get('chunked') === '1'
        || url.searchParams.get('chunked') === 'true';
      const supportsChunked = hostSupportsCapability(hostId, 'chunkedFileTransfer');
      if (forcedChunked && !supportsChunked) {
        throw new Error('this host agent needs to be restarted before it can stream large file downloads');
      }

      if (supportsChunked) {
        const info = await requestHostFileDownloadInfo(hostId, sessionId, remotePath, cwd, inline);
        const chunked = forcedChunked || (Number(info.size || 0) || 0) > CHUNKED_FILE_TRANSFER_THRESHOLD_BYTES;
        if (chunked) {
          await streamHostFileDownload(res, {
            hostId,
            sessionId,
            remotePath,
            cwd,
            inline,
            info,
          });
          return;
        }
      }

      const requestId = makeId();
      const pending = awaitFileRequest(requestId, 120000, {
        suppressAlert: inline,
        source: inline ? 'inline-preview' : 'download',
      });
      enqueueCommand(hostId, {
        type: 'host.file_download',
        requestId,
        sessionId,
        path: remotePath,
        cwd,
      });

      const result = await pending;
      const dataBase64 = String(result.dataBase64 || '');
      const buffer = Buffer.from(dataBase64, 'base64');
      const filename = safeFileDisplayName(result.name || result.path || remotePath);
      const received = storeReceivedFile({
        hostId,
        sessionId: sessionId || '',
        remotePath,
        name: filename,
        mime: result.mime || 'application/octet-stream',
        buffer,
      });
      serveReceivedFile(res, received, inline);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (
    req.method === 'GET'
    && url.pathname.match(/^\/api\/sessions\/[^/]+\/(?:assistant-messages|assistant-projection)$/)
  ) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = String(url.searchParams.get('hostId') || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const session = getSession(hostId, sessionId) || { sessionId };
    const projection = assistantProjectionForIdentity(hostId, session, {
      afterSeq: url.searchParams.get('afterSeq'),
      limit: url.searchParams.get('limit'),
    });
    sendJson(res, 200, projection);
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/activities$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = String(url.searchParams.get('hostId') || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const session = getSession(hostId, sessionId) || { sessionId };
    const canonicalConversationKey = resolveCanonicalConversationKey(hostId, session);
    const activityRecoveryToken = String(url.searchParams.get('activityToken') || '').trim();
    if (activityRecoveryToken) {
      if (activityRecoveryToken.length > 128) {
        sendJson(res, 400, { error: 'activityToken is invalid' });
        return;
      }
      const activity = state.activitySnapshots.activityByRecoveryToken(
        canonicalConversationKey,
        activityRecoveryToken
      );
      const summary = state.activitySnapshots.summary(canonicalConversationKey);
      sendJson(res, 200, {
        canonicalConversationKey,
        streamEpoch: state.sessionEventStream.epoch,
        activities: activity ? [activity] : [],
        targeted: true,
        revision: summary.revision,
        totalCount: summary.count,
        totalBytes: summary.totalBytes,
      });
      return;
    }
    const page = state.activitySnapshots.snapshotPage(canonicalConversationKey, {
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
      maxBytes: url.searchParams.get('maxBytes'),
      expectedRevision: url.searchParams.get('revision'),
    });
    sendJson(res, 200, {
      canonicalConversationKey,
      streamEpoch: state.sessionEventStream.epoch,
      ...page,
    }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/detail$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    const fullTranscript = url.searchParams.get('full') === '1' || url.searchParams.get('fullTranscript') === '1';
    const fullDiagnostics = url.searchParams.get('fullDiagnostics') === '1' || url.searchParams.get('diagnostics') === 'full';
    const forceRemoteDetail = url.searchParams.get('remote') === '1';
    const detail = await getSessionDetailHydrated(hostId, sessionId, {
      fullTranscript,
      fullDiagnostics,
      forceRemoteDetail,
      skipRemoteDetail: !fullTranscript && !fullDiagnostics && !forceRemoteDetail,
    });
    if (!detail) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }

    sendJson(res, 200, detail);
    return;
  }

  if ((req.method === 'POST' || req.method === 'DELETE') && url.pathname.match(/^\/api\/sessions\/[^/]+\/watch$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = String(url.searchParams.get('hostId') || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    const command = req.method === 'POST'
      ? enqueueSessionWatch(hostId, sessionId, body)
      : enqueueSessionUnwatch(hostId, sessionId, {
        clientId: url.searchParams.get('clientId') || '',
        viewId: url.searchParams.get('viewId') || '',
        watchRevision: url.searchParams.get('watchRevision'),
      });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/sessions\/[^/]+\/title$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = String(body.hostId || url.searchParams.get('hostId') || '').trim();
    const title = normalizeSessionTitle(body.title || '');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    if (!title) {
      sendJson(res, 400, { error: 'title is required' });
      return;
    }

    const session = updateSessionTitle(hostId, sessionId, title, {
      source: 'manual',
    });
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }

    await persistSessionPresentation(hostId, session, { source: 'manual' });
    broadcastSessionEvent(hostId, sessionId, 'session.snapshot', session);
    sendJson(res, 200, { ok: true, session });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/export-summary$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    const detail = await getSessionDetailHydrated(hostId, sessionId, { fullTranscript: true, fullDiagnostics: true });
    if (!detail) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }

    sendJson(res, 200, buildSessionExportSummary(detail));
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/export$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    const format = String(url.searchParams.get('format') || 'markdown').trim().toLowerCase();
    const exportOptions = {
      includeThinking: parseExportBoolean(url.searchParams.get('includeThinking'), false),
      includeImages: parseExportBoolean(url.searchParams.get('includeImages'), true),
      includeFiles: parseExportBoolean(url.searchParams.get('includeFiles'), true),
      includeAllFiles: parseExportBoolean(url.searchParams.get('includeAllFiles'), true),
      filterExtensions: parseExportBoolean(url.searchParams.get('filterExtensions'), false),
      fromDate: url.searchParams.get('fromDate') || '',
      toDate: url.searchParams.get('toDate') || '',
      selectedDates: url.searchParams.get('dates') || url.searchParams.get('selectedDates') || '',
      startIndex: Number(url.searchParams.get('startIndex') || 1) || 1,
      endIndex: Number(url.searchParams.get('endIndex') || 0) || Number.MAX_SAFE_INTEGER,
      extensions: parseExportExtensionList(url.searchParams.get('extensions')),
      fileIds: parseExportList(url.searchParams.get('fileIds')),
    };
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    const detail = await getSessionDetailHydrated(hostId, sessionId, { fullTranscript: true, fullDiagnostics: true });
    if (!detail) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }

    const exportDetail = filterSessionDetailForExport(detail, normalizeSessionExportOptions(exportOptions));

    if (format === 'json') {
      const body = JSON.stringify(buildSessionJsonExport(exportDetail, exportOptions), null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': contentDispositionValue('attachment', `${sessionExportBaseName(exportDetail.session)}.json`),
      });
      res.end(body);
      return;
    }

    if (format === 'zip' || format === 'bundle') {
      await streamSessionZipExport(res, exportDetail, exportOptions);
      return;
    }

    if (!['md', 'markdown'].includes(format)) {
      sendJson(res, 400, { error: 'format must be markdown, json, or zip' });
      return;
    }

    const body = buildSessionMarkdownExport(exportDetail, exportOptions);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition': contentDispositionValue('attachment', `${sessionExportBaseName(exportDetail.session)}.md`),
    });
    res.end(body);
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/local-agent$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const action = String(body.action || '').trim().toLowerCase();
    const existingHost = state.hosts.get(hostId);
    const localDefaultLabel = hostId === getLocalRelayHostId() ? getLocalRelayHostLabel() : hostId;
    const existingLabel = String(existingHost?.label || '').trim();
    const label = String(body.label || (existingLabel && existingLabel !== hostId ? existingLabel : '') || localDefaultLabel).trim() || localDefaultLabel;
    if (!['start', 'restart', 'stop', 'status'].includes(action)) {
      sendJson(res, 400, { error: 'action must be start, restart, stop, or status' });
      return;
    }

    if (action === 'status') {
      sendJson(res, 200, {
        ok: true,
        action,
        hostId,
        host: state.hosts.get(hostId) || null,
        localAgent: publicLocalAgentRecord(state.localAgents.get(hostId)),
      });
      return;
    }

    if (!LOCAL_AGENT_START_ENABLED && action !== 'stop') {
      sendJson(res, 403, {
        ok: false,
        status: 'local_agent_start_disabled',
        message: 'This Relay instance is not allowed to start a local Agent.',
      });
      return;
    }

    const result = action === 'stop'
      ? stopLocalAgent(hostId)
      : startLocalAgent({ hostId, label, restart: action === 'restart' });
    sendJson(res, result.ok === false ? 400 : 200, { ...result, action });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/hosts/import') {
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }

    restoreDismissedHost(hostId);
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
    restoreDismissedHost(hostId);
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
    const localAgent = state.localAgents.get(hostId);
    if (localAgent) {
      stopLocalAgent(hostId, {
        disableAutoRestart: true,
        reason: 'host dismissed by operator',
      });
    }
    state.dismissedHosts.add(hostId);
    saveDismissedHosts();
    state.hosts.delete(hostId);
    // Keep a live Relay-managed Agent lease until its shutdown handshake exits.
    // Its next heartbeat/register receives the dismissal signal and the Agent
    // then exits; completeLocalAgentExit removes the lease. Remote hosts have
    // no local process to wait for, so their lease can be discarded now.
    if (!localAgent || !localAgentProcessIsAlive(localAgent)) {
      state.hostAgentLeases.delete(hostId);
    }
    state.commandQueues.delete(hostId);
    const removedCanonicalKeys = new Set();
    for (const key of Array.from(state.sessions.keys())) {
      if (key.startsWith(`${hostId}::`)) {
        const session = state.sessions.get(key);
        const canonicalKey = resolveCanonicalConversationKey(hostId, session || key.slice(hostId.length + 2));
        if (canonicalKey) removedCanonicalKeys.add(canonicalKey);
        state.sessions.delete(key);
        state.sessionLogs.delete(key);
        state.sessionAlerts.delete(key);
        state.sessionRuntime.delete(key);
        state.sessionDiagnostics.delete(key);
        state.sessionRequests.delete(key);
      }
    }
    for (const key of Array.from(state.sessionAliases.keys())) {
      if (key.startsWith(`${hostId}::`)) {
        state.sessionAliases.delete(key);
      }
    }
    for (const canonicalKey of removedCanonicalKeys) {
      state.activitySnapshots.deleteConversation(canonicalKey);
    }
    saveSessionLogs();
    scheduleSessionDiagnosticsSave(0);
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
      sendJson(res, 200, {
        ok: true,
        dismissed: true,
        shutdown: true,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }
    const localAgentRegistration = reconcileRegisteredLocalAgent(
      body.hostId,
      body.label,
      body.agentProcess
    );
    if (!localAgentRegistration.ok) {
      sendJson(res, 409, {
        error: localAgentRegistration.message,
        code: localAgentRegistration.code,
      });
      return;
    }
    const leaseRegistration = state.hostAgentLeases.register(
      body.hostId,
      body.agentInstanceId
    );
    if (!leaseRegistration.ok) {
      sendJson(res, 409, {
        error: leaseRegistration.message,
        code: leaseRegistration.code,
        retryAfterMs: leaseRegistration.retryAfterMs || null,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }

    const existingHost = state.hosts.get(body.hostId);
    const host = {
      hostId: body.hostId,
      label: body.label || body.hostId,
      platform: body.platform || process.platform,
      codexHome: body.codexHome || existingHost?.codexHome || '',
      codexRuntime: normalizeHostCodexRuntime(body.codexRuntime) || existingHost?.codexRuntime || null,
      codexMaintenance: normalizeHostCodexMaintenance(body.codexMaintenance) || null,
      skillsRevision: body.skillsRevision || state.skillInventories.get(body.hostId)?.revision || existingHost?.skillsRevision || null,
      capabilities: body.capabilities || {},
      registeredAt: existingHost?.registeredAt || nowIso(),
      lastSeenAt: nowIso(),
    };
    state.hosts.set(body.hostId, host);
    reconcileHostCodexMaintenance(body.hostId, body.codexMaintenance);
    attachMatchingConnectorsToHost(host);
    const registeredQueue = pruneCommandQueue(state.commandQueues.get(body.hostId) || []);
    state.commandQueues.set(
      body.hostId,
      host.capabilities?.hostSkillDeploymentV1
        ? purgeLegacySkillMutationCommands(registeredQueue)
        : registeredQueue
    );
    reconcileSkillDeploymentsForHost(body.hostId, { includeRunning: true });
    const publicLease = state.hostAgentLeases.publicLease(leaseRegistration.lease);
    sendJson(res, 200, {
      ok: true,
      host,
      relayInstanceId: RELAY_INSTANCE_ID,
      agentLeaseId: publicLease?.leaseId || null,
      agentLeaseExpiresAt: publicLease?.expiresAt || null,
      agentLeaseTtlMs: publicLease?.ttlMs || null,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/heartbeat') {
    const body = await readBody(req);
    if (state.dismissedHosts.has(body.hostId)) {
      sendJson(res, 200, {
        ok: true,
        dismissed: true,
        shutdown: true,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }
    if (body.hostId) {
      const localAgentRegistration = reconcileRegisteredLocalAgent(
        body.hostId,
        body.label,
        body.agentProcess
      );
      if (!localAgentRegistration.ok) {
        sendJson(res, 409, {
          error: localAgentRegistration.message,
          code: localAgentRegistration.code,
        });
        return;
      }
    }
    const leaseCredentials = agentLeaseCredentials(req, {
      agentInstanceId: body.agentInstanceId,
      agentLeaseId: body.agentLeaseId,
    });
    const leaseHeartbeat = state.hostAgentLeases.heartbeat(
      body.hostId,
      body.agentInstanceId,
      leaseCredentials.leaseId
    );
    if (!leaseHeartbeat.ok) {
      sendJson(res, 409, {
        error: leaseHeartbeat.message,
        code: leaseHeartbeat.code,
        retryAfterMs: leaseHeartbeat.retryAfterMs || null,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }
    const host = state.hosts.get(body.hostId);
    const hostWasKnown = Boolean(host);
    if (host) {
      host.label = body.label || host.label || body.hostId;
      host.platform = body.platform || host.platform || 'unknown';
      host.codexHome = body.codexHome || host.codexHome || '';
      host.codexRuntime = normalizeHostCodexRuntime(body.codexRuntime) || host.codexRuntime || null;
      host.codexMaintenance = normalizeHostCodexMaintenance(body.codexMaintenance);
      host.skillsRevision = body.skillsRevision || state.skillInventories.get(body.hostId)?.revision || host.skillsRevision || null;
      host.capabilities = body.capabilities || host.capabilities || {};
      host.lastSeenAt = nowIso();
      state.hosts.set(body.hostId, host);
      reconcileHostCodexMaintenance(body.hostId, body.codexMaintenance);
      attachMatchingConnectorsToHost(host);
    } else if (body.hostId) {
      const nextHost = {
        hostId: body.hostId,
        label: body.label || body.hostId,
        platform: body.platform || 'unknown',
        codexHome: body.codexHome || '',
        codexRuntime: normalizeHostCodexRuntime(body.codexRuntime),
        codexMaintenance: normalizeHostCodexMaintenance(body.codexMaintenance),
        skillsRevision: body.skillsRevision || state.skillInventories.get(body.hostId)?.revision || null,
        capabilities: body.capabilities || {},
        registeredAt: nowIso(),
        lastSeenAt: nowIso(),
      };
      state.hosts.set(body.hostId, nextHost);
      reconcileHostCodexMaintenance(body.hostId, body.codexMaintenance);
      attachMatchingConnectorsToHost(nextHost);
    }
    if (body.hostId) {
      reconcileSkillDeploymentsForHost(body.hostId, { includeRunning: !hostWasKnown });
    }
    const publicLease = state.hostAgentLeases.publicLease(leaseHeartbeat.lease);
    sendJson(res, 200, {
      ok: true,
      relayInstanceId: RELAY_INSTANCE_ID,
      agentLeaseId: publicLease?.leaseId || null,
      agentLeaseExpiresAt: publicLease?.expiresAt || null,
      agentLeaseTtlMs: publicLease?.ttlMs || null,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/release') {
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const releaseAuthorization = authorizeAgentCommandPoll(hostId, req);
    if (!releaseAuthorization.ok) {
      sendJson(res, 409, {
        error: releaseAuthorization.message,
        code: releaseAuthorization.code,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }
    const credentials = agentLeaseCredentials(req, body);
    const released = state.hostAgentLeases.release(
      hostId,
      credentials.agentInstanceId,
      credentials.leaseId
    );
    if (!released.ok) {
      sendJson(res, 409, {
        error: released.message,
        code: released.code,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      released: released.released,
      relayInstanceId: RELAY_INSTANCE_ID,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent/commands') {
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const pollAuthorization = authorizeAgentCommandPoll(hostId, req);
    if (!pollAuthorization.ok) {
      sendJson(res, 409, {
        error: pollAuthorization.message,
        code: pollAuthorization.code,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }

    const clientRelayInstanceId = String(url.searchParams.get('relayInstanceId') || '').trim();
    const cursorBelongsToRelay = !clientRelayInstanceId || clientRelayInstanceId === RELAY_INSTANCE_ID;
    const after = cursorBelongsToRelay ? Number(url.searchParams.get('after') || '0') : 0;
    const ack = cursorBelongsToRelay
      ? Number(url.searchParams.get('ack') || url.searchParams.get('lastProcessed') || '0')
      : 0;
    const acked = ackCommands(hostId, ack);
    const commands = getCommands(hostId, after);
    markDeliveredSkillDeploymentCommands(hostId, commands);
    sendJson(res, 200, { commands, acked, relayInstanceId: RELAY_INSTANCE_ID });
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
    if (!hostOnline(host)) {
      sendJson(res, 409, { error: `host ${host.label || hostId} is offline` });
      return;
    }
    try {
      const plan = await planManagedLaunch(hostId, body, { acceptClientRequestId: true });
      const command = plan.idempotentReplay
        ? queuedManagedLaunchCommand(hostId, plan.runId)
        : await enqueueManagedLaunch(plan, body);
      sendJson(res, 200, {
        ok: true,
        idempotentReplay: plan.idempotentReplay === true,
        sessionId: plan.targetSessionId,
        bridgeSessionId: plan.targetSessionId,
        runId: plan.runId,
        nativeThreadId: plan.launchMode === 'resume' ? plan.nativeThreadId : null,
        originSessionId: plan.originSessionId,
        sourceSessionId: plan.sourceSessionId,
        conversationKey: plan.conversationKey,
        launchMode: plan.launchMode,
        sessionBinding: publicBinding(plan.planned.run.apiBinding),
        requestedSelection: plan.planned.run.requestedSelection,
        command: publicQueuedCommand(command),
      });
    } catch (error) {
      sendSessionContractError(res, error, 'queue-launch');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/runtime-config$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = String(url.searchParams.get('hostId') || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const runtimeConfig = sessionRuntimeConfig(hostId, sessionId);
    if (!runtimeConfig) {
      sendSessionContractError(res, new SessionContractError(
        'session_history_unavailable',
        'Saved Session history is unavailable.',
        { statusCode: 404 }
      ), 'load-runtime-config');
      return;
    }
    sendJson(res, 200, runtimeConfig);
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/models$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    try {
      const { record, run, runId, catalogRunId, liveRunId } = sessionCatalogRunRecord(hostId, sessionId);
      if (!record || !run) {
        throw new SessionContractError(
          'session_history_unavailable',
          'Saved Session runtime configuration is unavailable.',
          { statusCode: 404 }
        );
      }
      const binding = publicBinding(run.apiBinding);
      if (!binding?.bindingFingerprint) {
        throw new SessionContractError(
          'session_api_binding_unavailable',
          'The Session API binding cannot be resolved.',
          { sessionBinding: binding, canRebind: true }
        );
      }
      const session = getSession(hostId, sessionId);
      const catalog = await state.modelCatalog.get({
        hostId,
        identity: { hostId, sessionId },
        sessionId,
        nativeThreadId: record.nativeThreadId || null,
        bindingFingerprint: binding.bindingFingerprint,
        runId: catalogRunId,
        liveRunId,
        ...modelCatalogInputPolicy(null, binding),
        force: run.status === 'live' && sessionAcceptsLiveControl(hostId, session),
      });
      sendJson(res, 200, {
        hostId,
        sessionId,
        runId,
        sessionBinding: binding,
        ...publicModelCatalog(catalog),
      });
    } catch (error) {
      sendSessionContractError(res, error, 'load-model-catalog');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/models\/refresh$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    try {
      const { record, run, runId, catalogRunId, liveRunId } = sessionCatalogRunRecord(hostId, sessionId);
      if (!record || !run) {
        throw new SessionContractError(
          'session_history_unavailable',
          'Saved Session runtime configuration is unavailable.',
          { statusCode: 404 }
        );
      }
      const sessionBinding = publicBinding(run.apiBinding);
      const apiConfig = normalizeApiConfig(body.apiConfig);
      const submittedBinding = makeSubmittedProfileBinding(apiConfig);
      if (submittedBinding && !bindingsEqual(sessionBinding, submittedBinding)) {
        throw new SessionContractError(
          'session_api_binding_mismatch',
          'The submitted API profile does not match this Session.',
          { sessionBinding, submittedBinding, canRebind: true }
        );
      }
      if (
        submittedBinding?.providerKind
        && sessionBinding?.providerKind
        && submittedBinding.providerKind !== sessionBinding.providerKind
      ) {
        throw new SessionContractError(
          'session_api_binding_mismatch',
          'Submitted provider policy differs from the live Session run.',
          { sessionBinding, submittedBinding, canRebind: true }
        );
      }
      // Browser credentials may have rotated; a live refresh can only trust the
      // model metadata reported by the already-running app-server.
      const catalog = await state.modelCatalog.get({
        hostId,
        identity: { hostId, sessionId },
        sessionId,
        nativeThreadId: record.nativeThreadId || null,
        bindingFingerprint: sessionBinding?.bindingFingerprint,
        runId: catalogRunId,
        liveRunId,
        ...modelCatalogInputPolicy(null, sessionBinding),
        force: true,
      });
      sendJson(res, 200, {
        hostId,
        sessionId,
        runId,
        sessionBinding,
        ...publicModelCatalog(catalog),
      });
    } catch (error) {
      sendSessionContractError(res, error, 'refresh-model-catalog');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/rebind\/validate$/)) {
    const sourceSessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }
    try {
      sendJson(res, 200, await validateManagedRebind(hostId, sourceSessionId, body));
    } catch (error) {
      sendSessionContractError(res, error, 'validate-rebind');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/rebind$/)) {
    const sourceSessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }
    try {
      const currentRun = sessionRunRecord(hostId, sourceSessionId).run;
      const launchMode = currentRun?.nativeResumeReady === false ? 'fresh_rebind' : 'resume';
      const plan = await planManagedLaunch(hostId, body, {
        sourceSessionId,
        targetSessionId: sourceSessionId,
        launchMode,
        explicitRebind: true,
      });
      const command = await enqueueManagedLaunch(plan, body);
      sendJson(res, 200, {
        ok: true,
        sessionId: plan.targetSessionId,
        bridgeSessionId: plan.targetSessionId,
        runId: plan.runId,
        nativeThreadId: plan.launchMode === 'resume' ? plan.nativeThreadId : null,
        originSessionId: plan.originSessionId,
        sourceSessionId: plan.sourceSessionId,
        conversationKey: plan.conversationKey,
        launchMode: plan.launchMode,
        sessionBinding: publicBinding(plan.planned.run.apiBinding),
        requestedSelection: plan.planned.run.requestedSelection,
        modelCatalog: plan.catalog ? {
          hostId,
          sessionId: plan.targetSessionId,
          runId: plan.runId,
          sessionBinding: publicBinding(plan.planned.run.apiBinding),
          ...publicModelCatalog(plan.catalog),
        } : null,
        command: publicQueuedCommand(command),
      });
    } catch (error) {
      sendSessionContractError(res, error, 'rebind-session');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/transcript-fallback$/)) {
    const sourceSessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }
    try {
      const sourceDetail = getSessionDetail(hostId, sourceSessionId, {
        skipDiagnostics: true,
        skipRemoteDetail: true,
      });
      if (!sourceDetail?.session || !buildResumeTranscript(sourceDetail.transcript).length) {
        throw new SessionContractError(
          'session_history_unavailable',
          'Transcript fallback requires non-empty saved history.',
          { statusCode: 422 }
        );
      }
      const plan = await planManagedLaunch(hostId, body, {
        sourceSessionId,
        targetSessionId: String(body.sessionId || makeId()),
        launchMode: 'transcript_fallback',
        requireExpectedRun: true,
        expectSourceRun: true,
      });
      const command = await enqueueManagedLaunch(plan, body);
      sendJson(res, 200, {
        ok: true,
        sessionId: plan.targetSessionId,
        bridgeSessionId: plan.targetSessionId,
        runId: plan.runId,
        nativeThreadId: null,
        originSessionId: plan.originSessionId,
        sourceSessionId: plan.sourceSessionId,
        conversationKey: plan.conversationKey,
        launchMode: plan.launchMode,
        sessionBinding: publicBinding(plan.planned.run.apiBinding),
        requestedSelection: plan.planned.run.requestedSelection,
        command: publicQueuedCommand(command),
      });
    } catch (error) {
      sendSessionContractError(res, error, 'transcript-fallback');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/hosts\/[^/]+\/api-test$/)) {
    const hostId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const host = state.hosts.get(hostId);
    if (!host?.capabilities?.apiTest) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can test API profiles' });
      return;
    }

    const body = await readBody(req);
    let apiConfig;
    try {
      apiConfig = normalizeApiConfig(body.apiConfig);
    } catch (error) {
      sendSessionContractError(res, error, 'validate-api-profile');
      return;
    }
    if (!apiConfig) {
      sendJson(res, 400, { error: 'API Base URL or API Key is required before testing this host' });
      return;
    }

    const requestId = makeId();
    const pending = awaitApiTestRequest(requestId);
    enqueueCommand(hostId, {
      type: 'host.api_test',
      requestId,
      apiConfig,
      timeoutMs: Number(body.timeoutMs || 15000) || 15000,
      cursor: String(body.cursor || '').trim() || null,
      limit: Math.max(1, Math.min(500, Number(body.limit || 200) || 200)),
      includeLimit: body.includeLimit === true,
    });

    try {
      const payload = await pending;
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(res, 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/skills$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }
    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!sessionAcceptsLiveControl(hostId, session)) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }
    const host = state.hosts.get(hostId);
    if (!host?.capabilities?.skillList) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can list Codex skills' });
      return;
    }

    const requestId = makeId();
    const pending = awaitSkillListRequest(requestId);
    enqueueCommand(hostId, {
      type: 'session.skills_list',
      sessionId,
      requestId,
      cwd: session.cwd || null,
      forceReload: url.searchParams.get('forceReload') === 'true',
    });

    try {
      const payload = await pending;
      sendJson(res, 200, payload);
    } catch (error) {
      const statusCode = /not live|no live session/i.test(error.message || '') ? 409 : 504;
      sendJson(res, statusCode, { error: error.message });
    }
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
    const effectiveSessionId = session?.sessionId || resolveSessionId(hostId, sessionId) || sessionId;
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (isSubagentSession(session) || session.readOnly === true) {
      sendSessionContractError(
        res,
        new SessionContractError(
          'subagent_session_read_only',
          'Sub-agent sessions are read-only projections. Continue from the parent Session Thinking panel.',
          { statusCode: 409 }
        ),
        'validate-subagent-session'
      );
      return;
    }
    const inputFingerprint = inputRequestFingerprint(body);
    const rawInputRequestId = String(body.clientRequestId || '').trim();
    const providedInputRequestId = normalizeClientRequestId(rawInputRequestId);
    if (rawInputRequestId && providedInputRequestId !== rawInputRequestId) {
      sendJson(res, 400, {
        error: 'clientRequestId must be at most 160 letters, numbers, dots, colons, underscores, or hyphens.',
      });
      return;
    }
    const normalizedInputRequestId = providedInputRequestId || makeId();
    let inputScopeKey = resolveCanonicalConversationKey(hostId, session || sessionId)
      || inputSessionScopeKey(hostId, effectiveSessionId);
    let inputCacheKey = inputRequestCacheKey(
      hostId,
      inputScopeKey,
      normalizedInputRequestId
    );
    try {
      const cachedInput = getCachedInputRequest(inputCacheKey, inputFingerprint);
      if (cachedInput) {
        sendJson(res, 200, cachedInput);
        return;
      }
    } catch (error) {
      sendSessionContractError(res, error, 'dedupe-input-request');
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }
    const inputSessionRuntime = state.sessionRuntime.get(
      resolveSessionKey(hostId, session.sessionId || sessionId)
    ) || state.sessionRuntime.get(sessionKey(hostId, session.sessionId || sessionId)) || null;
    if (
      String(session.state || '').trim().toLowerCase() === 'stop-failed'
      || String(inputSessionRuntime?.phase || '').trim().toLowerCase() === 'stop-failed'
    ) {
      sendSessionContractError(
        res,
        new SessionContractError(
          'session_stop_failed',
          'The previous Stop failed and this runtime cannot accept new prompts. Retry Stop, then Resume the Session.',
          { statusCode: 409 }
        ),
        'validate-live-command'
      );
      return;
    }
    if (!sessionAcceptsLiveControl(hostId, session)) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }

    let liveRun;
    try {
      liveRun = validateLiveCommandBinding(session, body);
    } catch (error) {
      sendSessionContractError(res, error, 'validate-live-command');
      return;
    }
    const validatedInputScopeKey = resolveCanonicalConversationKey(hostId, liveRun.record || session)
      || inputSessionScopeKey(hostId, effectiveSessionId);
    if (validatedInputScopeKey !== inputScopeKey) {
      migrateInputRequestScope(inputScopeKey, validatedInputScopeKey);
      inputScopeKey = validatedInputScopeKey;
      inputCacheKey = inputRequestCacheKey(
        hostId,
        inputScopeKey,
        normalizedInputRequestId,
        liveRun.runId
      );
      try {
        const migratedCachedInput = getCachedInputRequest(inputCacheKey, inputFingerprint);
        if (migratedCachedInput) {
          sendJson(res, 200, migratedCachedInput);
          return;
        }
      } catch (error) {
        sendSessionContractError(res, error, 'dedupe-input-request');
        return;
      }
    }

    const text = String(body.text || '');
    const inputItems = normalizeTurnInputItems(body.inputItems || body.attachments || []);
    const uploadedFiles = normalizeFileTransferRefs(body.uploadedFiles || body.files || []);
    const hasDisplayText = Object.prototype.hasOwnProperty.call(body, 'displayText');
    const displayText = hasDisplayText ? String(body.displayText || '') : text;
    const transcriptText = summarizeTurnInput(displayText, inputItems, uploadedFiles)
      || summarizeTurnInput(text, inputItems, uploadedFiles);
    if (!transcriptText) {
      sendJson(res, 400, { error: 'text or inputItems are required' });
      return;
    }
    const host = state.hosts.get(hostId);
    const hasImageInputItems = inputItems.some((item) => item.type === 'image' || item.type === 'localImage');
    if (hasImageInputItems && !host?.capabilities?.imageInput) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can receive image inputs' });
      return;
    }
    const advancedTurnControlRequested = Boolean(
      String(body.model || '').trim()
      || String(body.effort || '').trim()
      || String(body.summary || '').trim()
      || String(body.serviceTier || '').trim()
      || String(body.personality || '').trim()
      || String(body.mode || '').trim() === 'plan'
      || (String(body.sandboxMode || '').trim() && String(body.sandboxMode || '').trim() !== 'workspaceWrite')
      || (String(body.approvalsReviewer || '').trim() && String(body.approvalsReviewer || '').trim() !== 'user')
      || (String(body.approvalPolicy || '').trim() && String(body.approvalPolicy || '').trim() !== 'on-request')
    );
    if (advancedTurnControlRequested && !host?.capabilities?.turnControls) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can use Codex turn controls' });
      return;
    }
    let requestReservation;
    try {
      requestReservation = reserveInputRequest(inputCacheKey, inputFingerprint, {
        hostId,
        scopeKey: inputScopeKey,
        clientRequestId: normalizedInputRequestId,
      });
    } catch (error) {
      sendSessionContractError(res, error, 'reserve-input-request');
      return;
    }
    if (!requestReservation.owner) {
      try {
        sendJson(res, 200, await requestReservation.promise);
      } catch (error) {
        sendSessionContractError(res, error, 'replay-input-request');
      }
      return;
    }
    try {
      assertHostLaunchAllowed(hostId);
    } catch (error) {
      settleInputRequest(requestReservation, error);
      sendSessionContractError(res, error, 'validate-host-maintenance');
      return;
    }
    const inputReservation = reserveSessionInput(
      hostId,
      effectiveSessionId,
      liveRun.runId,
      normalizedInputRequestId,
      inputScopeKey,
      requestReservation.ordinal
    );
    if (!inputReservation.ok) {
      const error = new SessionContractError(
        inputReservation.code || 'session_input_rejected',
        inputReservation.error || 'The Session cannot accept another prompt yet.',
        { statusCode: 409, ...inputReservation }
      );
      settleInputRequest(requestReservation, error);
      sendSessionContractError(res, error, 'reserve-session-input');
      return;
    }
    let acceptedResponsePayload = null;
    try {
      if (TEST_INPUT_PREPARE_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, TEST_INPUT_PREPARE_DELAY_MS));
      }
      if (!liveRun.compatibilityRuntime) {
        await validateLiveRequestedSelection(hostId, effectiveSessionId, liveRun, body);
        await recordLiveRequestedSelection(hostId, effectiveSessionId, liveRun.runId, body);
      }
      assertInputSubmissionOwnership(
        hostId,
        effectiveSessionId,
        requestReservation,
        inputReservation
      );
      assertInputRuntimeStillAvailable(
        hostId,
        effectiveSessionId,
        liveRun.runId,
        inputReservation
      );
      const inlineImageFiles = cacheInlineImageInputFiles(hostId, sessionId, inputItems);
      const inlineTextFiles = cacheInlineTextFiles(hostId, sessionId, body.inlineFiles || body.inlineFileRefs || []);
      const transcriptFiles = normalizeFileTransferRefs([...uploadedFiles, ...inlineImageFiles, ...inlineTextFiles]);
      const transcriptTimestamp = nowIso();
      const command = enqueueCommand(hostId, {
      type: 'session.input',
      clientRequestId: normalizedInputRequestId,
      sessionId: session.sessionId || sessionId,
      requestedSessionId: sessionId,
      bridgeSessionId: session.bridgeSessionId || null,
      nativeThreadId: session.nativeThreadId || null,
      originSessionId: session.originSessionId || null,
      sourceSessionId: session.sourceSessionId || null,
      conversationKey: session.conversationKey || null,
      runId: liveRun.runId,
      apiBinding: liveRun.binding,
      expectedBinding: liveRun.binding,
      text,
      inputItems,
      mode: String(body.mode || '').trim() || null,
      model: String(body.model || '').trim() || null,
      effort: String(body.effort || '').trim() || null,
      summary: String(body.summary || '').trim() || null,
      approvalPolicy: typeof body.approvalPolicy === 'object' ? body.approvalPolicy : String(body.approvalPolicy || '').trim() || null,
      approvalsReviewer: String(body.approvalsReviewer || '').trim() || null,
      sandboxMode: String(body.sandboxMode || '').trim() || null,
      planFallback: String(body.planFallback || '').trim() || null,
      serviceTier: String(body.serviceTier || '').trim() || null,
      personality: String(body.personality || '').trim() || null,
      }, {
        inputScopeKey: requestReservation.scopeKey || inputReservation.key,
        inputFingerprint,
        transcriptProjection: {
          sessionId: effectiveSessionId,
          text: transcriptText,
          files: transcriptFiles,
          timestamp: transcriptTimestamp,
          clientRequestId: normalizedInputRequestId,
          deliveryStatus: 'pending',
        },
      });
      acceptedResponsePayload = {
        ok: true,
        clientRequestId: command.clientRequestId || null,
        command,
      };
      rememberInputRequest(requestReservation.cacheKey, inputFingerprint, acceptedResponsePayload, {
        hostId,
        scopeKey: requestReservation.scopeKey || inputReservation.key,
        clientRequestId: normalizedInputRequestId,
      });
      recordPendingUserTranscriptEcho(hostId, effectiveSessionId, {
        clientRequestId: normalizedInputRequestId,
        fullText: text,
        displayText: transcriptText,
      });

      emitTranscriptEntry(hostId, effectiveSessionId, {
        speaker: 'user',
        clientRequestId: normalizedInputRequestId,
        deliveryStatus: 'pending',
        text: transcriptText,
        files: transcriptFiles,
        timestamp: transcriptTimestamp,
      });
      queueInputTranscriptProjectionCheckpoint({
        hostId,
        originalCommandId: command.id,
        clientRequestId: normalizedInputRequestId,
        projectionOutcome: 'pending',
      });
      const next = upsertSession(hostId, {
        sessionId: effectiveSessionId,
        apiProfile: session.apiProfile || null,
        apiBinding: liveRun.binding,
        requestedSelection: {
          model: String(body.model || '').trim() || null,
          effort: String(body.effort || '').trim() || null,
          source: 'user',
        },
        codexOptions: {
          model: String(body.model || '').trim() || null,
          effort: String(body.effort || '').trim() || null,
          allowUnverifiedEffort: body.allowUnverifiedEffort === true,
          summary: String(body.summary || '').trim() || null,
          mode: String(body.mode || '').trim() || null,
          approvalPolicy: typeof body.approvalPolicy === 'object' ? body.approvalPolicy : String(body.approvalPolicy || '').trim() || null,
          approvalsReviewer: String(body.approvalsReviewer || '').trim() || null,
          sandboxMode: String(body.sandboxMode || '').trim() || null,
          serviceTier: String(body.serviceTier || '').trim() || null,
          personality: String(body.personality || '').trim() || null,
        },
        lastUpdatedAt: nowIso(),
      });
      broadcastSessionEvent(hostId, effectiveSessionId, 'session.snapshot', next);

      emitSessionRuntimePatch(hostId, effectiveSessionId, {
        phase: 'queued-turn',
        busy: true,
        currentTurnStatus: 'queued',
        queuedCommandId: command.id,
        pendingClientRequestId: normalizedInputRequestId,
        clientRequestId: normalizedInputRequestId,
        queuedInputAt: command.createdAt,
        pendingInputSummary: transcriptText.slice(0, 240),
        lastError: null,
        lastCodexError: null,
        runId: liveRun.runId || null,
      });
      emitSessionDiagnostic(hostId, effectiveSessionId, {
        severity: 'info',
        source: 'relay',
        kind: 'control',
        method: 'session.input/queued',
        message: `Queued Codex turn command ${command.id}.`,
        data: {
          commandId: command.id,
          clientRequestId: command.clientRequestId || null,
          mode: String(body.mode || '').trim() || null,
          inputTypes: inputItems.map((item) => item.type),
        },
      });
      settleInputRequest(requestReservation, null, acceptedResponsePayload);
      sendJson(res, 200, acceptedResponsePayload);
      return;
    } catch (error) {
      if (acceptedResponsePayload) {
        console.error(
          `[relay] input command ${acceptedResponsePayload.command?.id || '(unknown)'} was durably queued but its UI projection failed: ${error.message || error}`
        );
        settleInputRequest(requestReservation, null, acceptedResponsePayload);
        sendJson(res, 200, acceptedResponsePayload);
        return;
      }
      settleInputRequest(requestReservation, error);
      sendSessionContractError(res, error, 'queue-input-request');
    } finally {
      releaseSessionInputReservation(inputReservation);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/review$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!sessionAcceptsLiveControl(hostId, session)) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }

    const host = state.hosts.get(hostId);
    if (!host?.capabilities?.review) {
      sendJson(res, 409, { error: 'this host agent needs to be restarted before it can run Codex reviews' });
      return;
    }

    let target = null;
    try {
      target = normalizeReviewTarget(body);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    const delivery = String(body.delivery || 'inline').trim() === 'detached' ? 'detached' : 'inline';
    const command = enqueueCommand(hostId, {
      type: 'session.review_start',
      sessionId,
      target,
      delivery,
    });
    emitSessionDiagnostic(hostId, sessionId, {
      severity: 'info',
      source: 'ui',
      kind: 'control',
      method: 'review/start',
      message: `Review requested: ${target.type}`,
      data: {
        target,
        delivery,
      },
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/stop-all') {
    const body = await readBody(req);
    const hostId = String(body.hostId || '').trim();
    const candidates = getRelayManagedLiveSessions(hostId);
    const results = [];

    for (const session of candidates) {
      const hostError = getHostUnavailableError(session.hostId);
      if (hostError) {
        results.push({
          hostId: session.hostId,
          sessionId: session.sessionId,
          skipped: true,
          error: hostError.error,
        });
        continue;
      }

      let stopRequestId = null;
      let stopRunId = session.runId || null;
      const host = state.hosts.get(session.hostId);
      if (host?.capabilities?.runApiBinding === true) {
        stopRequestId = makeId();
        try {
          const prepared = await state.provenance.requestStopRun({
            identity: { hostId: session.hostId, sessionId: session.sessionId },
            runId: stopRunId,
            stopRequestId,
          });
          stopRunId = prepared.runId;
        } catch (error) {
          results.push({
            hostId: session.hostId,
            sessionId: session.sessionId,
            skipped: true,
            error: error.message || 'Session Stop could not be prepared.',
          });
          continue;
        }
      }
      const stop = beginSessionStop(session.hostId, session.sessionId, {
        runId: stopRunId,
        stopRequestId,
      });
      results.push({
        hostId: session.hostId,
        sessionId: session.sessionId,
        skipped: false,
        commandCount: stop.commands.length,
        commands: stop.commands,
      });
    }

    sendJson(res, 200, {
      ok: true,
      hostId: hostId || null,
      requested: candidates.length,
      stopped: results.filter((entry) => !entry.skipped).length,
      skipped: results.filter((entry) => entry.skipped).length,
      results,
    });
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
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    let expectedRunId = String(body.expectedRunId || '').trim() || null;
    let stopRequestId = null;
    const host = state.hosts.get(hostId);
    if (host?.capabilities?.runApiBinding === true) {
      stopRequestId = makeId();
      try {
        const prepared = await state.provenance.requestStopRun({
          identity: { hostId, sessionId },
          requireExpectedRun: true,
          expectedRunId,
          expectedBindingFingerprint: body.expectedBindingFingerprint,
          expectedBindingProvided: Object.prototype.hasOwnProperty.call(
            body,
            'expectedBindingFingerprint'
          ),
          expectedRunStatus: body.expectedRunStatus,
          expectedRunStatusProvided: Object.prototype.hasOwnProperty.call(body, 'expectedRunStatus'),
          stopRequestId,
        });
        expectedRunId = prepared.runId;
      } catch (error) {
        sendSessionContractError(res, error, 'stop-session');
        return;
      }
    }

    const stop = beginSessionStop(hostId, sessionId, {
      runId: expectedRunId,
      stopRequestId,
    });
    sendJson(res, 200, { ok: true, command: stop.command, commands: stop.commands });
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
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!sessionAcceptsLiveControl(hostId, session)) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }
    const effectiveSessionId = session.sessionId || resolveSessionId(hostId, sessionId) || sessionId;
    const runtime = state.sessionRuntime.get(resolveSessionKey(hostId, effectiveSessionId)) || session.runtime || {};
    const currentRunId = String(session.runId || runtime.runId || '').trim();
    const expectedRunId = String(body.expectedRunId || '').trim();
    if (expectedRunId && currentRunId && expectedRunId !== currentRunId) {
      sendSessionContractError(res, new SessionContractError(
        'session_run_changed',
        'The Session run changed before Interrupt could be queued.',
        { statusCode: 409, expectedRunId, currentRunId }
      ), 'interrupt-session');
      return;
    }
    const rawInterruptRequestId = String(body.interruptRequestId || '').trim();
    const providedInterruptRequestId = normalizeClientRequestId(rawInterruptRequestId);
    if (rawInterruptRequestId && providedInterruptRequestId !== rawInterruptRequestId) {
      sendJson(res, 400, { error: 'interruptRequestId is invalid.' });
      return;
    }
    const interruptRequestId = providedInterruptRequestId || makeId();
    const command = enqueueCommand(hostId, {
      type: 'session.interrupt',
      interruptRequestId,
      sessionId: effectiveSessionId,
      bridgeSessionId: session?.bridgeSessionId || null,
      nativeThreadId: session?.nativeThreadId || null,
      originSessionId: session?.originSessionId || null,
      sourceSessionId: session?.sourceSessionId || null,
      conversationKey: session?.conversationKey || null,
      runId: currentRunId || null,
      expectedTurnId: String(body.expectedTurnId || runtime.activeTurnId || '').trim() || null,
      expectedClientRequestId: normalizeClientRequestId(
        body.expectedClientRequestId
        || runtime.clientRequestId
        || runtime.pendingClientRequestId
      ) || null,
    });
    sendJson(res, 200, { ok: true, interruptRequestId, command });
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
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const text = String(body.text || '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return;
    }

    const session = getSession(hostId, sessionId);
    const command = enqueueCommand(hostId, {
      type: 'session.steer',
      sessionId,
      bridgeSessionId: session?.bridgeSessionId || null,
      nativeThreadId: session?.nativeThreadId || null,
      originSessionId: session?.originSessionId || null,
      sourceSessionId: session?.sourceSessionId || null,
      conversationKey: session?.conversationKey || null,
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
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!sessionAcceptsLiveControl(hostId, session)) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }
    let liveRun;
    try {
      liveRun = validateLiveCommandBinding(session, body);
    } catch (error) {
      sendSessionContractError(res, error, 'validate-live-command');
      return;
    }
    const command = enqueueCommand(hostId, {
      type: 'session.compact',
      sessionId: session.sessionId || sessionId,
      bridgeSessionId: session?.bridgeSessionId || null,
      nativeThreadId: session?.nativeThreadId || null,
      originSessionId: session?.originSessionId || null,
      sourceSessionId: session?.sourceSessionId || null,
      conversationKey: session?.conversationKey || null,
      runId: liveRun.runId,
      apiBinding: liveRun.binding,
      expectedBinding: liveRun.binding,
    });
    sendJson(res, 200, { ok: true, command });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/goal$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (!sessionAcceptsLiveControl(hostId, session)) {
      sendJson(res, 409, { error: 'session is not live' });
      return;
    }

    const action = String(body.action || '').trim() || 'get';
    if (!['get', 'set', 'clear'].includes(action)) {
      sendJson(res, 400, { error: 'action must be get, set, or clear' });
      return;
    }
    const tokenBudget = Number(body.tokenBudget);
    const requestId = makeId();
    const pending = awaitGoalRequest(requestId);
    enqueueCommand(hostId, {
      type: 'session.goal',
      sessionId,
      requestId,
      action,
      ...sessionIdentityPatch(hostId, sessionId),
      objective: Object.prototype.hasOwnProperty.call(body, 'objective') ? String(body.objective || '').trim() : undefined,
      status: Object.prototype.hasOwnProperty.call(body, 'status') ? String(body.status || '').trim() : undefined,
      tokenBudget: Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.floor(tokenBudget) : undefined,
    });

    try {
      const payload = await pending;
      if (action === 'clear' || payload.goal === null) {
        clearGoalAutoApproveState(hostId, sessionId);
      } else if (payload.goal) {
        maybeClearGoalAutoApproveForRuntime(hostId, sessionId, {
          ...(state.sessionRuntime.get(goalAutoApproveKey(hostId, sessionId)) || {}),
          goal: payload.goal,
        });
      }
      sendJson(res, 200, { ok: true, goal: payload.goal || null, result: payload.result || null });
    } catch (error) {
      sendJson(res, /not live|no live session/i.test(error.message || '') ? 409 : 504, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/goal-auto-approve$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = String(url.searchParams.get('hostId') || '').trim();
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const stored = getGoalAutoApproveState(hostId, sessionId);
    sendJson(res, 200, {
      ok: true,
      enabled: isGoalAutoApproveEnabled(hostId, sessionId),
      state: stored ? { ...stored, enabled: isGoalAutoApproveEnabled(hostId, sessionId) } : null,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/sessions\/[^/]+\/goal-auto-approve$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const body = await readBody(req);
    const hostId = body.hostId;
    if (!hostId) {
      sendJson(res, 400, { error: 'hostId is required' });
      return;
    }
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }
    const session = getSession(hostId, sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    const runtime = state.sessionRuntime.get(goalAutoApproveKey(hostId, sessionId)) || {};
    if (body.enabled !== false && !runtime.goal) {
      sendJson(res, 409, { error: 'goal auto-approve requires an active goal' });
      return;
    }
    const next = setGoalAutoApproveState(hostId, sessionId, {
      enabled: body.enabled !== false,
      requestId: body.requestId || null,
    });
    sendJson(res, 200, {
      ok: true,
      enabled: isGoalAutoApproveEnabled(hostId, sessionId),
      state: next,
    });
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
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
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
    const hostError = getHostUnavailableError(hostId);
    if (hostError) {
      sendJson(res, hostError.statusCode, { error: hostError.error });
      return;
    }

    const claim = claimSessionRequestResponse(hostId, sessionId, requestId, body.response || null, {
      runId: body.runId || null,
    });
    if (!claim.ok) {
      sendJson(res, claim.statusCode || 409, {
        error: claim.error,
        code: claim.code,
      });
      return;
    }
    if (claim.duplicate) {
      sendJson(res, 200, {
        ok: true,
        duplicate: true,
        status: claim.request?.status || 'resolved',
      });
      return;
    }

    const effectiveSessionId = claim.effectiveSessionId;
    const session = getSession(hostId, effectiveSessionId);
    const command = enqueueCommand(hostId, {
      type: 'session.request.respond',
      sessionId: effectiveSessionId,
      requestId,
      response: body.response || null,
      nativeThreadId: session?.nativeThreadId || null,
      bridgeSessionId: session?.bridgeSessionId || null,
      originSessionId: session?.originSessionId || null,
      sourceSessionId: session?.sourceSessionId || null,
      conversationKey: session?.conversationKey || null,
      runId: session?.runId || null,
    });
    sendJson(res, 200, {
      ok: true,
      status: 'responding',
      command,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/sessions\/[^/]+\/events$/)) {
    const sessionId = decodeURIComponent(url.pathname.split('/')[3]);
    const hostId = url.searchParams.get('hostId');
    const optimize = url.searchParams.get('full') !== '1' && url.searchParams.get('optimize') !== '0';
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
    const identity = sessionIdentity(hostId, {
      ...(getSession(hostId, sessionId) || {}),
      sessionId,
    });
    const canonicalKey = resolveCanonicalConversationKey(hostId, identity);
    const cursorHeader = Array.isArray(req.headers['last-event-id'])
      ? req.headers['last-event-id'][0]
      : req.headers['last-event-id'];
    const cursor = String(
      cursorHeader
      || url.searchParams.get('lastEventId')
      || url.searchParams.get('cursor')
      || ''
    ).trim();
    addSessionSubscriber(canonicalKey, res, {
      optimize,
      cursor,
      makeReset: (currentCanonicalKey) => {
        const currentSession = getSession(hostId, sessionId);
        const activitySummary = state.activitySnapshots.summary(currentCanonicalKey);
        return {
          session: boundedSessionResetRecord(currentSession),
          assistantProjection: boundedSessionResetAssistantProjection(
            currentSession?.assistantProjection
          ),
          activities: [],
          activitiesTruncated: activitySummary.count > 0,
          activityCount: activitySummary.count,
        };
      },
    });
    if (
      res.destroyed
      || res.writableEnded
      || !state.sessionEventStream.has(canonicalKey)
    ) {
      removeSessionSubscriber(res);
      return;
    }
    const stream = state.sessionEventStream.ensure(canonicalKey);
    if (!writeSseEvent(res, 'ready', {
      ok: true,
      hostId,
      sessionId,
      canonicalConversationKey: canonicalKey,
      streamEpoch: state.sessionEventStream.epoch,
      cursor: `${stream.cursorEpoch}:${stream.counter}`,
    })) {
      removeSessionSubscriber(res);
      return;
    }

    const ping = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(ping);
        removeSessionSubscriber(res);
        return;
      }
      if (!writeSseEvent(res, 'ping', { time: nowIso() })) {
        clearInterval(ping);
        removeSessionSubscriber(res);
      }
    }, 20_000);
    ping.unref?.();

    req.on('close', () => {
      clearInterval(ping);
      removeSessionSubscriber(res);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/events') {
    const body = await readBody(req, MAX_AGENT_EVENT_BODY_BYTES);
    const events = Array.isArray(body.events) ? body.events : body.event ? [body.event] : [];
    const batchScope = validateAgentEventBatchScope(events);
    if (!batchScope.ok) {
      sendJson(res, 400, { error: batchScope.message, code: batchScope.code });
      return;
    }
    const eventAuthorization = authorizeAgentEventBatch(batchScope.hostId, req);
    if (!eventAuthorization.ok) {
      sendJson(res, 409, {
        error: eventAuthorization.message,
        code: eventAuthorization.code,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    }
    try {
      const batchKey = makeAgentEventBatchKey(body.batchId, events);
      const batchDigest = batchKey ? makeAgentEventBatchDigest(events) : null;
      const appliedBatch = batchKey ? state.appliedAgentEventBatches.get(batchKey) : null;
      if (appliedBatch && appliedBatch.digest !== batchDigest) {
        sendJson(res, 409, {
          error: 'Agent event batch ID was reused with different events.',
          code: 'agent_event_batch_id_conflict',
          relayInstanceId: RELAY_INSTANCE_ID,
        });
        return;
      }
      if (appliedBatch) {
        sendJson(res, 200, {
          ok: true,
          count: events.length,
          duplicate: true,
          relayInstanceId: RELAY_INSTANCE_ID,
        });
        return;
      }
      const partialBatch = batchKey ? state.partialAgentEventBatches.get(batchKey) : null;
      if (partialBatch && partialBatch.digest !== batchDigest) {
        sendJson(res, 409, {
          error: 'Agent event batch ID was reused with different events.',
          code: 'agent_event_batch_id_conflict',
          relayInstanceId: RELAY_INSTANCE_ID,
        });
        return;
      }
      const pendingBatch = batchKey ? state.pendingAgentEventBatches.get(batchKey) : null;
      if (pendingBatch && pendingBatch.digest !== batchDigest) {
        sendJson(res, 409, {
          error: 'Agent event batch ID is already applying different events.',
          code: 'agent_event_batch_id_conflict',
          relayInstanceId: RELAY_INSTANCE_ID,
        });
        return;
      }
      let application = pendingBatch?.promise || null;
      const duplicate = Boolean(pendingBatch);
      if (!application) {
        application = (async () => {
          let appliedCount = Math.max(
            0,
            Math.min(events.length, Number(partialBatch?.appliedCount || 0))
          );
          try {
            for (let index = appliedCount; index < events.length; index += 1) {
              const event = events[index];
              await applyAgentEvent(event);
              appliedCount = index + 1;
            }
            if (batchKey) {
              // The dedupe checkpoint must never outrun transcript/diagnostic
              // persistence. Otherwise a restart could discard an accepted
              // event whose response was lost before its deferred save ran.
              await flushAgentEventBatchPersistence();
              rememberAppliedAgentEventBatch(batchKey, batchDigest);
            }
          } catch (error) {
            if (batchKey && appliedCount > 0) {
              try {
                // Keep the in-flight batch registered until this durable
                // checkpoint attempt settles. Concurrent retries must join the
                // same Promise instead of reapplying the accepted prefix.
                await flushAgentEventBatchPersistence();
                rememberPartialAgentEventBatch(batchKey, batchDigest, appliedCount);
              } catch (checkpointError) {
                if (checkpointError !== error && !checkpointError.cause) {
                  checkpointError.cause = error;
                }
                return { ok: false, error: checkpointError, appliedCount };
              }
            }
            return { ok: false, error, appliedCount };
          }
          return { ok: true, appliedCount };
        })();
        if (batchKey) {
          state.pendingAgentEventBatches.set(batchKey, { digest: batchDigest, promise: application });
        }
      }
      const outcome = await application;
      if (
        !duplicate
        && batchKey
        && state.pendingAgentEventBatches.get(batchKey)?.promise === application
      ) {
        state.pendingAgentEventBatches.delete(batchKey);
      }
      if (!outcome.ok) {
        sendJson(res, 409, {
          error: outcome.error?.message || 'Agent event batch application failed.',
          code: 'agent_event_batch_apply_failed',
          appliedCount: outcome.appliedCount,
          failedEventIndex: outcome.appliedCount,
          relayInstanceId: RELAY_INSTANCE_ID,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        count: events.length,
        duplicate,
        relayInstanceId: RELAY_INSTANCE_ID,
      });
      return;
    } finally {
      eventAuthorization.release?.();
    }
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

function makeAgentEventBatchKey(batchId, events) {
  const normalizedBatchId = String(batchId || '').trim().slice(0, 512);
  if (!normalizedBatchId || !Array.isArray(events) || !events.length) {
    return null;
  }
  const hostScope = Array.from(new Set(events
    .map((event) => String(event?.hostId || '').trim())
    .filter(Boolean)))
    .sort()
    .join(',');
  return `${hostScope}|${normalizedBatchId}`;
}

function makeAgentEventBatchDigest(events) {
  return crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

function rememberAppliedAgentEventBatch(batchKey, digest) {
  state.agentEventLedger.recordApplied(batchKey, digest);
}

function rememberPartialAgentEventBatch(batchKey, digest, appliedCount) {
  if (!batchKey || !digest || !Number.isSafeInteger(appliedCount) || appliedCount <= 0) {
    return;
  }
  state.agentEventLedger.recordPartial(batchKey, digest, appliedCount);
}

async function commitStartedSessionProvenance(event, currentSession = null) {
  const bridgeSessionId = String(
    event.bridgeSessionId
    || currentSession?.bridgeSessionId
    || currentSession?.sessionId
    || event.sessionId
    || ''
  ).trim();
  const nativeThreadId = String(event.nativeThreadId || event.sessionId || '').trim() || null;
  const lookupSessionId = bridgeSessionId || nativeThreadId;
  let record = state.provenance.getSessionRecord({ hostId: event.hostId, sessionId: lookupSessionId });
  const host = state.hosts.get(event.hostId);
  const compatibilityRunId = host?.capabilities?.runApiBinding === true
    ? null
    : currentSession?.runId;
  let runId = String(event.runId || record?.activeRunId || compatibilityRunId || '').trim() || null;
  let run = runId ? record?.runs?.[runId] || null : null;
  const effectiveBinding = publicBinding(event.effectiveBinding);

  if (
    host?.capabilities?.runApiBinding !== true
    && run?.apiBinding?.bindingFingerprint
    && !effectiveBinding?.bindingFingerprint
  ) {
    throw new SessionContractError(
      'session_api_binding_attestation_unsupported',
      'This Host agent cannot attest the effective API binding for a newly started Session. Restart or upgrade the Host agent before launching it.',
      { sessionBinding: publicBinding(run.apiBinding), canRebind: true }
    );
  }

  if (!run && effectiveBinding?.bindingFingerprint) {
    runId ||= makeId();
    const planned = await state.provenance.planRun({
      identity: { hostId: event.hostId, sessionId: bridgeSessionId || nativeThreadId },
      conversationKey: event.conversationKey || bridgeSessionId || nativeThreadId,
      runId,
      launchMode: event.launchMode || 'fresh',
      submittedBinding: effectiveBinding,
      requestedSelection: event.effectiveSelection ? {
        model: event.effectiveSelection.model || null,
        effort: event.effectiveSelection.effort || null,
        source: 'host-confirmed',
      } : undefined,
    });
    record = planned.record;
    run = planned.run;
  }

  if (host?.capabilities?.runApiBinding && !effectiveBinding?.bindingFingerprint) {
    throw new SessionContractError(
      'session_api_binding_unavailable',
      'The Host did not confirm the effective API binding for this run.',
      { sessionBinding: publicBinding(run?.apiBinding), canRebind: true }
    );
  }

  if (!run) {
    const merged = await state.provenance.mergeDiscovery({
      hostId: event.hostId,
      sessionId: bridgeSessionId || nativeThreadId,
      bridgeSessionId: event.bridgeSessionId || null,
      nativeThreadId,
      conversationKey: event.conversationKey || bridgeSessionId || nativeThreadId,
      originSessionId: event.originSessionId || null,
      sourceSessionId: event.sourceSessionId || null,
      source: 'managed',
      title: event.title || currentSession?.title || nativeThreadId || bridgeSessionId,
      cwd: event.cwd || currentSession?.cwd || null,
      selection: event.effectiveSelection || null,
    });
    return {
      record: merged.record,
      runId: event.runId || currentSession?.runId || merged.record.latestSuccessfulRunId || null,
      run: merged.record.runs?.[merged.record.latestSuccessfulRunId] || null,
      compatibilityUnknownBinding: true,
    };
  }

  if (host?.capabilities?.runApiBinding !== true && !run.apiBinding?.bindingFingerprint) {
    return {
      record,
      runId,
      run,
      compatibilityUnknownBinding: true,
    };
  }

  if (run.status === 'live' && record.activeRunId === runId) {
    if (!bindingsEqual(run.apiBinding, effectiveBinding || run.apiBinding)) {
      throw new SessionContractError(
        'session_api_binding_mismatch',
        'Host API attestation does not match the live run binding.',
        {
          sessionBinding: run.apiBinding,
          submittedBinding: effectiveBinding,
          canRebind: true,
        }
      );
    }
    if (
      host?.capabilities?.nativeResumeReadiness === true
      && event.runtime?.nativeResumeReady === true
      && run.nativeResumeReady !== true
    ) {
      const readiness = await state.provenance.confirmNativeResumeReady({
        identity: { hostId: event.hostId, sessionId: bridgeSessionId || lookupSessionId },
        runId,
      });
      record = readiness.record;
      run = record.runs?.[runId] || run;
    }
    return {
      record,
      runId,
      run,
      compatibilityUnknownBinding: false,
    };
  }

  const confirmed = await state.provenance.confirmRun({
    identity: {
      hostId: event.hostId,
      sessionId: bridgeSessionId || lookupSessionId,
      bridgeSessionId: event.bridgeSessionId || bridgeSessionId || null,
      nativeThreadId,
      conversationKey: event.conversationKey || null,
    },
    runId,
    bridgeSessionId: event.bridgeSessionId || bridgeSessionId || null,
    nativeThreadId,
    originSessionId: event.originSessionId || currentSession?.originSessionId || null,
    sourceSessionId: event.sourceSessionId || currentSession?.sourceSessionId || null,
    cwd: event.cwd || currentSession?.cwd || null,
    title: event.title || currentSession?.title || '',
    effectiveBinding: effectiveBinding || run.apiBinding,
    launchMode: event.launchMode || null,
    nativeResumeReady: host?.capabilities?.nativeResumeReadiness === true
      ? event.runtime?.nativeResumeReady === true
      : true,
    effectiveSelection: event.effectiveSelection || {
      model: event.model || null,
      effort: event.effort || null,
    },
  });
  return {
    record: confirmed.record,
    runId,
    run: confirmed.record.runs?.[runId] || null,
    compatibilityUnknownBinding: false,
  };
}

function sessionCanTranscriptFallback(hostId, sessionId) {
  const detail = getSessionDetail(hostId, sessionId, {
    skipDiagnostics: true,
    skipRemoteDetail: true,
  });
  return buildResumeTranscript(detail?.transcript || []).length > 0;
}

function sessionDiscoveryNeedsCommit(record, input = {}) {
  if (!record) {
    return true;
  }
  for (const field of ['bridgeSessionId', 'nativeThreadId', 'originSessionId', 'sourceSessionId']) {
    if (input[field] && !record[field]) {
      return true;
    }
  }
  const sourceRank = { managed: 100, manual: 90, metadata: 70, imported: 50, rollout: 40, vscode: 30 };
  const incomingRank = sourceRank[input.source] || 0;
  const existingRank = sourceRank[record.source] || 0;
  if (incomingRank > existingRank) {
    return true;
  }
  if (incomingRank >= existingRank) {
    if (input.conversationKey && input.conversationKey !== record.conversationKey) {
      return true;
    }
    if (input.title && input.title !== record.title) {
      return true;
    }
    if (input.cwd && input.cwd !== record.cwd) {
      return true;
    }
  }
  return false;
}

function managedDiscoveryTargetsStaleRun(host, session, current, record) {
  if (
    !current
    || current.source !== 'managed'
    || (!current.live && current.state !== 'starting')
  ) {
    return false;
  }
  const discoveredRunId = String(session.runId || session.runtime?.runId || '').trim();
  if (!discoveredRunId) {
    // History rows carry assistant cursors but no run scope. They remain safe to merge
    // while the separately emitted live runner row protects the current projection.
    return false;
  }
  const activeRunId = String(record?.activeRunId || '').trim();
  const activeRun = activeRunId ? record?.runs?.[activeRunId] || null : null;
  const currentRunId = ['pending', 'live'].includes(activeRun?.status)
    ? activeRunId
    : String(current.runId || '').trim();
  if (!currentRunId) {
    return false;
  }
  if (discoveredRunId !== currentRunId) {
    return true;
  }
  return Boolean(
    host?.capabilities?.runApiBinding === true
    && session.live
    && (activeRunId !== discoveredRunId || activeRun?.status !== 'live')
  );
}

async function applyAgentEvent(event) {
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

  if (event.type === 'host.skills.inventory') {
    applyHostSkillInventoryEvent(event);
    return;
  }

  if (event.type === 'host.skills.artifact.result') {
    applyHostSkillArtifactResult(event);
    return;
  }

  if (event.type === 'host.skills.deployment.result') {
    applyHostSkillDeploymentResult(event);
    return;
  }

  if (event.type === 'session.activity_snapshot') {
    const activityIdentity = sessionIdentity(event.hostId, event);
    const canonicalKey = resolveCanonicalConversationKey(event.hostId, activityIdentity);
    const activityRevision = Number(event.activityRevision);
    if (!canonicalKey || !Number.isSafeInteger(activityRevision) || activityRevision <= 0) {
      return;
    }
    const accepted = state.activitySnapshots.accept(
      state.sessionEventStream.epoch,
      canonicalKey,
      stripSecrets(event)
    );
    if (accepted) {
      publishCanonicalSessionEvent(canonicalKey, 'session.activity', {
        ...accepted,
        streamEpoch: state.sessionEventStream.epoch,
      });
    }
    return;
  }

  if (event.type === 'session.watch.updated') {
    const effectiveSessionId = (event.sessionId || event.nativeThreadId)
      ? resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId)
      : null;
    if (effectiveSessionId) {
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.watch.updated', {
        ...event,
        sessionId: effectiveSessionId,
        timestamp: event.timestamp || nowIso(),
      });
    }
    return;
  }

  if (event.type === 'session.discovery') {
    if (host) {
      host.lastDiscoveryAt = nowIso();
      state.hosts.set(event.hostId, host);
    }
    const sessions = Array.isArray(event.sessions) ? event.sessions : [];
    const discoveryPublishesLive = (session, record = null) => {
      if (!session?.live) {
        return false;
      }
      if (host?.capabilities?.runApiBinding !== true) {
        return true;
      }
      const durableRecord = record || state.provenance.getSessionRecord({
        hostId: event.hostId,
        sessionId: session.sessionId,
      });
      const runId = String(session.runId || session.runtime?.runId || '').trim();
      const run = runId ? durableRecord?.runs?.[runId] || null : null;
      return Boolean(
        runId
        && durableRecord?.activeRunId === runId
        && run?.status === 'live'
        && run.apiBinding?.bindingFingerprint
      );
    };
    const publishedLiveSessionIds = new Set();
    const managedRunPresence = new Map();
    for (const discoveredSession of sessions) {
      noteManagedDiscoveryRunPresence(managedRunPresence, discoveredSession, {
        allowRunlessWildcard: host?.capabilities?.runApiBinding !== true,
      });
      if (!discoveryPublishesLive(discoveredSession)) {
        continue;
      }
      for (const identity of sessionOwnershipIdentityValues(discoveredSession)) {
        publishedLiveSessionIds.add(identity);
      }
    }
    for (const session of sessions) {
      if (!session || !session.sessionId) {
        continue;
      }
      const existing = getSession(event.hostId, session.sessionId);
      const subagent = isSubagentSession(session);
      const discoverySource = subagent
        ? 'subagent'
        : session.source === 'managed'
        ? 'managed'
        : session.source === 'vscode'
          ? 'vscode'
          : 'rollout';
      const discoveryInput = {
        hostId: event.hostId,
        sessionId: session.sessionId,
        bridgeSessionId: session.bridgeSessionId || existing?.bridgeSessionId || null,
        nativeThreadId: session.nativeThreadId || existing?.nativeThreadId || session.sessionId,
        conversationKey: session.conversationKey || existing?.conversationKey || session.sessionId,
        originSessionId: session.originSessionId || existing?.originSessionId || null,
        sourceSessionId: session.sourceSessionId || existing?.sourceSessionId || null,
        source: discoverySource,
        title: session.title || existing?.title || session.sessionId,
        cwd: session.cwd || existing?.cwd || null,
        createdAt: session.createdAt || existing?.createdAt || null,
        apiProfile: session.apiProfile || existing?.apiProfile || null,
        selection: session.codexOptions || existing?.codexOptions || null,
        modelProviderHint: session.modelProvider || session.modelProviderHint || null,
        subagent: subagent || existing?.subagent === true,
        readOnly: subagent || existing?.readOnly === true,
        threadSource: session.threadSource || existing?.threadSource || null,
        parentThreadId: session.parentThreadId || existing?.parentThreadId || null,
        forkedFromId: session.forkedFromId || existing?.forkedFromId || null,
        agentPath: session.agentPath || existing?.agentPath || null,
        agentNickname: session.agentNickname || existing?.agentNickname || null,
        agentRole: session.agentRole || existing?.agentRole || null,
        multiAgentVersion: session.multiAgentVersion || existing?.multiAgentVersion || null,
        subagentSource: session.subagentSource || existing?.subagentSource || null,
      };
      const storedDiscovery = state.provenance.getSessionRecord({
        hostId: event.hostId,
        sessionId: session.sessionId,
      });
      const suppressStaleRunSideEffects = managedDiscoveryTargetsStaleRun(
        host,
        session,
        existing,
        storedDiscovery
      );
      const cursor = session.assistantCursor && typeof session.assistantCursor === 'object'
        ? session.assistantCursor
        : null;
      let mergedDiscovery = { record: storedDiscovery };
      let assignedAssistant = null;
      if (!suppressStaleRunSideEffects) {
        const priorCanonicalKeys = [...new Set([
          session.sessionId,
          session.bridgeSessionId,
          session.nativeThreadId,
        ].filter(Boolean).map((identityValue) => (
          resolveCanonicalConversationKey(event.hostId, identityValue)
        )))];
        mergedDiscovery = sessionDiscoveryNeedsCommit(storedDiscovery, discoveryInput)
          ? await state.provenance.mergeDiscovery(discoveryInput)
          : { record: storedDiscovery };
        const canonicalKey = mergedDiscovery.canonicalKey
          || resolveCanonicalConversationKey(event.hostId, discoveryInput);
        for (const priorCanonicalKey of priorCanonicalKeys) {
          mergeCanonicalRealtimeKeys(priorCanonicalKey, canonicalKey);
        }
        assignedAssistant = cursor
          ? await assignAssistantObservations(
            event.hostId,
            discoveryInput,
            cursor.observations || [],
            cursor
          )
          : null;
        if (assignedAssistant?.changed) {
          publishCanonicalSessionEvent(
            assignedAssistant.canonicalKey,
            'session.assistant_projection',
            assignedAssistant.projection
          );
        }
      }
      const assistantProjectionIdentity = suppressStaleRunSideEffects
        ? existing || { sessionId: session.sessionId }
        : discoveryInput;
      const assistantProjection = compactAssistantProjection(
        assignedAssistant?.projection
        || assistantProjectionForIdentity(event.hostId, assistantProjectionIdentity, {
          afterSeq: Number.MAX_SAFE_INTEGER,
          limit: 1,
        })
      );
      const current = getSession(event.hostId, session.sessionId) || existing;
      const publishDiscoveredLive = discoveryPublishesLive(session, mergedDiscovery.record);
      const isCurrentlyLive = publishDiscoveredLive
        && sessionOwnershipIdentityValues(session).some((identity) => publishedLiveSessionIds.has(identity));
      const preserveManagedState = !subagent && current
        && current.source === 'managed'
        && (current.live || current.state === 'starting')
        && (
          isCurrentlyLive
          || !publishDiscoveredLive
          || (current.state === 'starting' && sessionAgeMs(current) < STALE_MANAGED_SESSION_GRACE_MS)
        );
      const discoveredCreatedAt = session.createdAt || null;
      const discoveredConversationKey = session.conversationKey && session.conversationKey !== session.sessionId
        ? session.conversationKey
        : '';
      const next = upsertSession(event.hostId, {
        sessionId: session.sessionId,
        title: preserveManagedState
          ? current.title || session.sessionId
          : mergedDiscovery.record?.title || session.title || session.sessionId,
        cwd: preserveManagedState ? current.cwd || null : mergedDiscovery.record?.cwd || session.cwd || null,
        source: preserveManagedState ? current.source : discoverySource,
        state: subagent ? 'subagent' : (preserveManagedState ? current.state : (publishDiscoveredLive ? 'running' : 'imported')),
        live: subagent ? false : (preserveManagedState ? current.live : publishDiscoveredLive),
        subagent: subagent || existing?.subagent === true,
        readOnly: subagent || existing?.readOnly === true,
        threadSource: session.threadSource || existing?.threadSource || null,
        parentThreadId: session.parentThreadId || existing?.parentThreadId || null,
        forkedFromId: session.forkedFromId || existing?.forkedFromId || null,
        agentPath: session.agentPath || existing?.agentPath || null,
        agentNickname: session.agentNickname || existing?.agentNickname || null,
        agentRole: session.agentRole || existing?.agentRole || null,
        multiAgentVersion: session.multiAgentVersion || existing?.multiAgentVersion || null,
        subagentSource: session.subagentSource || existing?.subagentSource || null,
        createdAt: preserveManagedState ? current.createdAt || discoveredCreatedAt : discoveredCreatedAt,
        lastUpdatedAt: preserveManagedState ? current.lastUpdatedAt || nowIso() : session.updatedAt || nowIso(),
        messageCount: Math.max(Number(current?.messageCount || 0), Number(session.messageCount || 0), Array.isArray(session.transcriptPreview) ? session.transcriptPreview.length : 0),
        latestUserMessage: preserveManagedState
          ? current.latestUserMessage || null
          : session.latestUserMessage || current?.latestUserMessage || null,
        latestAgentMessage: preserveManagedState
          ? current.latestAgentMessage || null
          : session.latestAgentMessage || current?.latestAgentMessage || null,
        transcriptPreview: preserveManagedState
          ? current.transcriptPreview || []
          : Array.isArray(session.transcriptPreview) && session.transcriptPreview.length
            ? session.transcriptPreview
            : (current?.transcriptPreview || []),
        assistantProjection,
        rolloutPath: preserveManagedState
          ? current.rolloutPath || null
          : session.rolloutPath || current?.rolloutPath || null,
        originSessionId: preserveManagedState
          ? current.originSessionId || null
          : session.originSessionId || current?.originSessionId || null,
        sourceSessionId: preserveManagedState
          ? current.sourceSessionId || null
          : session.sourceSessionId || current?.sourceSessionId || null,
        conversationKey: preserveManagedState
          ? current.conversationKey || current.originSessionId || current.sourceSessionId || session.sessionId
          : discoveredConversationKey
            || session.originSessionId
            || current?.conversationKey
            || current?.originSessionId
            || current?.sourceSessionId
            || session.sessionId,
        launchMode: preserveManagedState
          ? current.launchMode || null
          : session.launchMode || null,
        runtime: preserveManagedState ? current.runtime || null : session.runtime || current?.runtime || null,
        runId: preserveManagedState
          ? current.runId || null
          : session.runId || session.runtime?.runId || current?.runId || null,
        bridgeSessionId: preserveManagedState
          ? current.bridgeSessionId || null
          : session.bridgeSessionId || current?.bridgeSessionId || null,
        nativeThreadId: preserveManagedState
          ? current.nativeThreadId || current.sessionId
          : current?.nativeThreadId || session.nativeThreadId || session.sessionId,
      });
      if (!preserveManagedState && !next.live && Array.isArray(session.transcriptPreview)) {
        setSessionLog(event.hostId, next.sessionId, session.transcriptPreview, { merge: true });
      }
      broadcastSessionEvent(event.hostId, next.sessionId, 'session.snapshot', next);
    }
    await closeManagedSessionsMissingFromDiscovery(event.hostId, managedRunPresence, {
      discoveryId: event.discoveryId || null,
    });
    return;
  }

  if (event.type === 'watch.performance') {
    const targets = event.sessionId
      ? [getSession(event.hostId, event.sessionId)].filter(Boolean)
      : Array.from(state.sessions.values()).filter((session) => session.hostId === event.hostId && session.live);
    const message = event.message || 'Realtime session sync is slow. Close idle live conversations to reduce Windows-side history work.';
    for (const session of targets.slice(0, 20)) {
      emitSessionAlert(event.hostId, session.sessionId, {
        severity: event.severity || 'warning',
        source: 'watch.performance',
        message,
        timestamp: event.timestamp || nowIso(),
      });
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

  if (event.type === 'host.codex_probed') {
    const host = state.hosts.get(event.hostId);
    if (host) {
      host.codexRuntime = normalizeHostCodexRuntime(event.codexRuntime) || host.codexRuntime || null;
      host.lastSeenAt = nowIso();
      state.hosts.set(event.hostId, host);
    }
    return;
  }

  if (event.type === 'host.codex_update_progress' && event.operationId) {
    const host = state.hosts.get(event.hostId);
    if (host && event.codexRuntime) {
      host.codexRuntime = normalizeHostCodexRuntime(event.codexRuntime) || host.codexRuntime || null;
      state.hosts.set(event.hostId, host);
    }
    const operation = currentCodexUpdateOperation(event.hostId);
    if (
      operation?.operationId === event.operationId
      && ['updating', 'checking', 'installing', 'verifying'].includes(operation.status)
    ) {
      const phase = String(event.phase || 'updating').trim().toLowerCase();
      patchCodexUpdateOperation(operation, {
        status: ACTIVE_CODEX_UPDATE_STATUSES.has(phase) ? phase : 'updating',
        phase,
        message: redactSecretText(String(event.message || 'Updating Codex.')).slice(0, 2000),
      });
    }
    return;
  }

  if (event.type === 'host.codex_updated' && event.operationId) {
    const codexRuntime = normalizeHostCodexRuntime(event.codexRuntime);
    const host = state.hosts.get(event.hostId);
    if (host) {
      host.codexRuntime = codexRuntime || host.codexRuntime || null;
      host.lastSeenAt = nowIso();
      state.hosts.set(event.hostId, host);
    }
    const operation = currentCodexUpdateOperation(event.hostId);
    if (
      operation?.operationId === event.operationId
      && ['updating', 'checking', 'installing', 'verifying', 'interrupted'].includes(operation.status)
    ) {
      patchCodexUpdateOperation(operation, {
        status: event.ok === true ? 'updated' : 'update_failed',
        phase: event.ok === true ? 'updated' : 'update_failed',
        updateSucceeded: event.ok === true,
        targetVersion: String(event.version || codexRuntime?.version || '').trim() || null,
        message: event.ok === true
          ? `Codex ${event.version || codexRuntime?.version || 'update'} installed and verified.`
          : redactSecretText(String(event.error || 'Codex update failed.')).slice(0, 2000),
      });
    }
    const pending = state.pendingCodexUpdateRequests.get(event.requestId);
    if (pending) {
      pending.resolve({
        ok: event.ok === true,
        operationId: event.operationId,
        previousVersion: event.previousVersion || null,
        version: event.version || codexRuntime?.version || null,
        changed: event.changed === true,
        code: event.code || null,
        error: event.error || null,
        codexRuntime,
      });
    }
    return;
  }

  if (event.type === 'host.probe' && event.requestId) {
    const host = state.hosts.get(event.hostId);
    if (host && event.codexRuntime) {
      host.codexRuntime = normalizeHostCodexRuntime(event.codexRuntime) || host.codexRuntime || null;
      state.hosts.set(event.hostId, host);
    }
    const pending = state.pendingHostProbes.get(event.requestId);
    if (pending) {
      pending.resolve({
        requestId: event.requestId,
        answeredAt: event.timestamp || nowIso(),
        label: event.label || null,
        platform: event.platform || null,
        capabilities: event.capabilities || null,
        codexRuntime: normalizeHostCodexRuntime(event.codexRuntime),
      });
    }
    return;
  }

  if (event.type === 'host.api_tested' && event.requestId) {
    const pending = state.pendingApiTestRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          hostId: event.hostId,
          requestId: event.requestId,
          result: event.result || null,
          timestamp: event.timestamp || nowIso(),
        });
      }
    }
    return;
  }

  if (event.type === 'host.api_cataloged' && event.requestId) {
    const pending = state.pendingApiCatalogRequests.get(event.requestId);
    if (pending) {
      pending.resolve({
        hostId: event.hostId,
        requestId: event.requestId,
        bindingFingerprint: event.bindingFingerprint || null,
        runId: event.runId || null,
        result: event.result || null,
        timestamp: event.timestamp || nowIso(),
      });
    }
    return;
  }

  if (event.type === 'host.binding_preflighted' && event.requestId) {
    const pending = state.pendingBindingPreflightRequests.get(event.requestId);
    if (pending) {
      pending.resolve({
        ok: event.ok === true,
        code: event.code || null,
        error: event.error || null,
        binding: publicBinding(event.binding),
        canRebind: Boolean(event.canRebind),
        timestamp: event.timestamp || nowIso(),
      });
    }
    return;
  }

  if (event.type === 'host.skills.result' && event.requestId) {
    const pending = state.pendingHostSkillRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          hostId: event.hostId,
          requestId: event.requestId,
          action: event.action || '',
          ok: event.ok !== false,
          skills: Array.isArray(event.skills) ? event.skills : [],
          results: Array.isArray(event.results) ? event.results : [],
          timestamp: event.timestamp || nowIso(),
        });
      }
    }
    return;
  }

  if (event.type === 'session.detailed' && event.requestId) {
    const pending = state.pendingSessionDetailRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          hostId: event.hostId,
          sessionId: event.sessionId || null,
          nativeThreadId: event.nativeThreadId || null,
          session: event.session || null,
          transcript: Array.isArray(event.transcript) ? event.transcript : [],
          diagnostics: Array.isArray(event.diagnostics) ? event.diagnostics : [],
          fullTranscript: Boolean(event.fullTranscript),
          fullDiagnostics: Boolean(event.fullDiagnostics),
          timestamp: event.timestamp || nowIso(),
        });
      }
    }
    return;
  }

  if (event.type === 'session.searched' && event.requestId) {
    const pending = state.pendingSessionSearchRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          hostId: event.hostId,
          query: event.query || '',
          mode: event.mode || 'keyword',
          results: Array.isArray(event.results) ? event.results : [],
          scannedSessions: Number(event.scannedSessions || 0) || 0,
          truncated: Boolean(event.truncated),
          timestamp: event.timestamp || nowIso(),
        });
      }
    }
    return;
  }

  if (event.type === 'session.model_listed' && event.requestId) {
    const pending = state.pendingModelRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          models: Array.isArray(event.models) ? event.models : [],
          nextCursor: event.nextCursor || null,
          complete: event.complete !== false,
          truncated: event.truncated === true,
          bindingFingerprint: event.bindingFingerprint || null,
          runId: event.runId || null,
          hostId: event.hostId,
          sessionId: event.sessionId || null,
        });
      }
    }
    return;
  }

  if (event.type === 'session.skills_listed' && event.requestId) {
    const pending = state.pendingSkillRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          data: Array.isArray(event.data) ? event.data : [],
          hostId: event.hostId,
          sessionId: event.sessionId || null,
        });
      }
    }
    return;
  }

  if (event.type === 'session.goal_result' && event.requestId) {
    const pending = state.pendingGoalRequests.get(event.requestId);
    if (pending) {
      if (event.error) {
        pending.reject(new Error(event.error));
      } else {
        pending.resolve({
          goal: event.goal || null,
          result: event.result || null,
          hostId: event.hostId,
          sessionId: event.sessionId || null,
        });
      }
    }
    if (!event.error && event.sessionId) {
      const runtimeKey = sessionKey(event.hostId, event.sessionId);
      const current = state.sessionRuntime.get(runtimeKey) || {};
      const runtime = {
        ...current,
        goal: event.goal || null,
        updatedAt: event.timestamp || nowIso(),
      };
      state.sessionRuntime.set(runtimeKey, runtime);
      upsertSession(event.hostId, {
        sessionId: event.sessionId,
        runtime,
        lastUpdatedAt: event.timestamp || nowIso(),
      });
      broadcastSessionEvent(event.hostId, event.sessionId, 'session.runtime_updated', {
        sessionId: event.sessionId,
        runtime,
        timestamp: event.timestamp || nowIso(),
      });
    }
    return;
  }

  if (event.type === 'file.upload.ready' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      uploadId: event.uploadId || null,
      fileId: event.fileId || null,
      targetDirectory: event.targetDirectory || null,
      name: event.name || null,
      path: event.path || null,
      size: event.size || 0,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.upload.chunk' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      uploadId: event.uploadId || null,
      offset: event.offset || 0,
      length: event.length || 0,
      receivedBytes: event.receivedBytes || 0,
      size: event.size || 0,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.upload.aborted' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      uploadId: event.uploadId || null,
      aborted: true,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.uploaded' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      files: Array.isArray(event.files) ? event.files : [],
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.download.info' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      name: event.name || null,
      path: event.path || null,
      size: event.size || 0,
      mime: event.mime || 'application/octet-stream',
      isImage: Boolean(event.isImage),
      mtimeMs: event.mtimeMs || 0,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.downloaded' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      name: event.name || null,
      path: event.path || null,
      size: event.size || 0,
      mime: event.mime || 'application/octet-stream',
      dataBase64: event.dataBase64 || '',
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.download.chunk' && event.requestId) {
    removeQueuedFileCommand(event.hostId, event.requestId);
    resolvePendingFileRequest(event.requestId, {
      hostId: event.hostId,
      sessionId: event.sessionId || null,
      path: event.path || null,
      offset: event.offset || 0,
      length: event.length || 0,
      size: event.size || 0,
      dataBase64: event.dataBase64 || '',
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'file.error' && event.requestId) {
    const pendingFileRequest = state.pendingFileRequests.get(event.requestId) || null;
    removeQueuedFileCommand(event.hostId, event.requestId);
    rejectPendingFileRequest(event.requestId, event.message || 'file transfer failed');
    if (event.sessionId && !pendingFileRequest?.suppressAlert) {
      emitSessionAlert(event.hostId, event.sessionId, {
        severity: 'error',
        source: 'file-transfer',
        message: event.message || 'file transfer failed',
        timestamp: event.timestamp || nowIso(),
      });
    }
    return;
  }

  const sessionId = event.sessionId;
  if (!sessionId) {
    return;
  }
  const eventHost = state.hosts.get(event.hostId);
  if (
    eventHost?.capabilities?.runApiBinding === true
    && RUN_ID_REQUIRED_SESSION_EVENT_TYPES.has(event.type)
    && !String(event.runId || '').trim()
  ) {
    emitSessionDiagnostic(event.hostId, sessionId, {
      severity: 'warning',
      source: 'relay',
      kind: 'lifecycle',
      method: `${event.type}/missing-run-id`,
      message: `Ignored ${event.type} from a binding-aware Host because runId was missing.`,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }
  const terminalInputCompletion = completeQueuedSessionInputFromEvent(event);
  const terminalInputMatched = Boolean(terminalInputCompletion);
  if (
    event.type === 'session.command_failed'
    && event.operation === 'input'
    && event.clientRequestId
    && (terminalInputMatched || !event.commandId)
  ) {
    rejectPendingUserTranscript(
      event.hostId,
      resolveSessionId(event.hostId, sessionId),
      event.clientRequestId,
      event.code || 'input_rejected'
    );
  } else if (
    event.type === 'session.runtime_updated'
    && terminalInputMatched
    && event.inputOutcome === 'accepted'
    && event.commandClientRequestId
  ) {
    markUserTranscriptAccepted(
      event.hostId,
      resolveSessionId(event.hostId, sessionId),
      event.commandClientRequestId
    );
  }
  if (terminalInputCompletion) {
    queueInputTranscriptProjectionCheckpoint(terminalInputCompletion);
    scheduleSessionLogsSave(0);
  }

  if (event.type === 'session.command_failed') {
    const effectiveSessionId = resolveSessionId(event.hostId, sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    const currentSession = getSession(event.hostId, effectiveSessionId) || getSession(event.hostId, sessionId);
    const code = String(event.code || 'session_command_failed').trim() || 'session_command_failed';
    const message = String(event.error || event.message || 'Session command failed.');
    if (event.operation === 'start' && event.runId) {
      const failedRun = await failPlannedRun(
        event.hostId,
        currentSession?.bridgeSessionId || currentSession?.sessionId || sessionId,
        event.runId,
        { code, message }
      );
      const eventHost = state.hosts.get(event.hostId);
      if (eventHost?.capabilities?.runApiBinding === true && failedRun?.transitioned !== true) {
        return;
      }
      const failedSession = upsertSession(event.hostId, {
        sessionId: currentSession?.sessionId || effectiveSessionId,
        state: `failed:${code}`,
        live: false,
        runId: event.runId,
        resumeError: {
          code,
          error: message,
          stage: event.operation || 'start',
          canRebind: Boolean(event.canRebind),
          canTranscriptFallback: sessionCanTranscriptFallback(event.hostId, effectiveSessionId),
        },
        lastUpdatedAt: event.timestamp || nowIso(),
      }, { preserveManagedLive: false });
      broadcastSessionEvent(event.hostId, failedSession.sessionId, 'session.state_changed', failedSession);
      broadcastSessionEvent(event.hostId, failedSession.sessionId, 'session.snapshot', failedSession);
    }
    if (event.operation === 'stop') {
      const record = state.provenance?.getSessionRecord({
        hostId: event.hostId,
        sessionId: currentSession?.sessionId || effectiveSessionId,
      });
      const run = event.runId ? record?.runs?.[event.runId] || null : null;
      if (run?.status === 'stopped') return;
      const stopRequestId = String(event.stopRequestId || run?.stopRequestId || '').trim();
      if (stopRequestId && event.runId) {
        const cancelled = await state.provenance.cancelStopRun({
          identity: { hostId: event.hostId, sessionId: currentSession?.sessionId || effectiveSessionId },
          runId: event.runId,
          stopRequestId,
        });
        if (cancelled.transitioned !== true) return;
      }
      projectStopFailedSession(
        event.hostId,
        currentSession?.sessionId || effectiveSessionId,
        {
          runId: event.runId || currentSession?.runId || null,
          message,
          connection: 'ready',
          timestamp: event.timestamp || nowIso(),
          alert: false,
        }
      );
    }
    const transientInputConflict = event.operation === 'input'
      && ['session_turn_active', 'session_input_preparing'].includes(code);
    emitSessionAlert(event.hostId, effectiveSessionId, {
      severity: transientInputConflict ? 'warning' : 'error',
      source: 'runtime',
      message,
      transient: transientInputConflict,
      turnId: event.turnId || null,
      timestamp: event.timestamp || nowIso(),
    });
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.command_failed', {
      ...event,
      code,
      error: message,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'session.interrupt_result') {
    const effectiveSessionId = resolveSessionId(event.hostId, sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    const status = ['accepted', 'pending', 'no_active', 'failed'].includes(event.status)
      ? event.status
      : 'failed';
    const payload = {
      ...event,
      hostId: event.hostId,
      sessionId: effectiveSessionId,
      status,
      timestamp: event.timestamp || nowIso(),
    };
    if (status === 'failed') {
      emitSessionAlert(event.hostId, effectiveSessionId, {
        severity: 'error',
        source: 'runtime',
        message: event.error || 'Codex turn interruption failed.',
        timestamp: payload.timestamp,
      });
    }
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.interrupt_result', payload);
    return;
  }

  if (event.type === 'session.selection_confirmed') {
    const effectiveSessionId = resolveSessionId(event.hostId, sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    const currentSession = getSession(event.hostId, effectiveSessionId) || getSession(event.hostId, sessionId);
    const liveRun = sessionRunRecord(event.hostId, currentSession?.sessionId || effectiveSessionId, { includePending: true });
    if (!liveRun.run || !liveRun.runId) {
      return;
    }
    const confirmedBinding = publicBinding(event.effectiveBinding);
    if (confirmedBinding && !bindingsEqual(liveRun.run.apiBinding, confirmedBinding)) {
      emitSessionAlert(event.hostId, effectiveSessionId, {
        severity: 'error',
        source: 'runtime',
        message: 'Host selection confirmation used a different API binding than the live Session run.',
        timestamp: event.timestamp || nowIso(),
      });
      return;
    }
    const confirmedRunId = event.runId || liveRun.runId;
    let confirmed;
    try {
      confirmed = await state.provenance.confirmEffectiveSelection({
        identity: {
          hostId: event.hostId,
          sessionId: currentSession?.bridgeSessionId || currentSession?.sessionId || effectiveSessionId,
        },
        runId: confirmedRunId,
        selection: {
          model: event.model || null,
          effort: event.effort || null,
        },
      });
    } catch (error) {
      if (['session_run_not_found', 'session_run_state_conflict'].includes(error?.code)) {
        return;
      }
      throw error;
    }
    if (eventTargetsPublishedParentRun(event, effectiveSessionId)) {
      return;
    }
    if (getCurrentSessionRunId(event.hostId, effectiveSessionId) !== confirmedRunId) {
      return;
    }
    const next = upsertSession(event.hostId, {
      sessionId: currentSession?.sessionId || effectiveSessionId,
      runId: confirmedRunId,
      activeRunId: confirmedRunId,
      apiBinding: publicBinding(liveRun.run.apiBinding),
      effectiveSelection: confirmed.selection,
      lastUpdatedAt: event.timestamp || nowIso(),
    });
    broadcastSessionEvent(event.hostId, next.sessionId, 'session.selection_confirmed', {
      hostId: event.hostId,
      sessionId: next.sessionId,
      runId: confirmedRunId,
      selection: confirmed.selection,
      timestamp: event.timestamp || nowIso(),
    });
    broadcastSessionEvent(event.hostId, next.sessionId, 'session.snapshot', next);
    return;
  }

  if (event.type === 'session.started') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    const bridgeSessionId = event.bridgeSessionId && event.bridgeSessionId !== effectiveSessionId
      ? event.bridgeSessionId
      : null;
    const bridgeSession = bridgeSessionId
      ? (state.sessions.get(sessionKey(event.hostId, bridgeSessionId)) || getSession(event.hostId, bridgeSessionId))
      : null;
    const currentSession = getSession(event.hostId, effectiveSessionId);
    const plannedSessionId = bridgeSession?.sessionId
      || event.bridgeSessionId
      || currentSession?.bridgeSessionId
      || currentSession?.sessionId
      || effectiveSessionId;
    const startedRecord = state.provenance.getSessionRecord({
      hostId: event.hostId,
      sessionId: plannedSessionId,
    });
    const durableActiveRunId = String(startedRecord?.activeRunId || '').trim();
    const durableActiveRun = durableActiveRunId
      ? startedRecord?.runs?.[durableActiveRunId] || null
      : null;
    const announcedRunId = String(event.runId || '').trim();
    const boundNativeThreadId = String(startedRecord?.nativeThreadId || '').trim();
    const announcedNativeThreadId = String(event.nativeThreadId || effectiveSessionId || '').trim();
    if (
      announcedRunId
      && durableActiveRunId === announcedRunId
      && durableActiveRun?.status === 'live'
      && boundNativeThreadId
      && announcedNativeThreadId
      && boundNativeThreadId !== announcedNativeThreadId
    ) {
      appendSessionDiagnostic(event.hostId, boundNativeThreadId, {
        severity: 'info',
        source: 'relay',
        kind: 'lifecycle',
        method: 'session.started/ignored-duplicate-native',
        message: `Ignored duplicate start for run ${announcedRunId} from native thread ${announcedNativeThreadId}; the run is already bound to ${boundNativeThreadId}.`,
        data: {
          runId: announcedRunId,
          acceptedNativeThreadId: boundNativeThreadId,
          ignoredNativeThreadId: announcedNativeThreadId,
          bridgeSessionId: event.bridgeSessionId || startedRecord?.bridgeSessionId || null,
        },
        timestamp: event.timestamp || nowIso(),
      });
      return;
    }
    const currentRunId = ['pending', 'live'].includes(durableActiveRun?.status)
      ? durableActiveRunId
      : bridgeSession?.runId || currentSession?.runId || null;
    if (event.runId && currentRunId && event.runId !== currentRunId) {
      const staleRun = startedRecord?.runs?.[event.runId] || null;
      emitSessionDiagnostic(event.hostId, effectiveSessionId, {
        severity: 'info',
        source: 'relay',
        kind: 'lifecycle',
        method: 'session.started/ignored-stale-run',
        message: `Ignored stale start update from run ${event.runId}.`,
        data: {
          eventRunId: event.runId,
          currentRunId,
          eventRunStatus: staleRun?.status || null,
        },
        timestamp: event.timestamp || nowIso(),
      });
      if (
        staleRun
        && (
          ['pending', 'failed'].includes(staleRun.status)
          || startedRecord.activeRunId !== event.runId
        )
      ) {
        enqueueCommand(event.hostId, {
          type: 'session.stop',
          sessionId: effectiveSessionId,
          requestedSessionId: plannedSessionId,
          bridgeSessionId: event.bridgeSessionId || plannedSessionId,
          nativeThreadId: event.nativeThreadId || effectiveSessionId,
          runId: event.runId,
          suppressTerminalEvent: true,
          reason: 'stale-session-started',
        });
      }
      return;
    }
    const startedPresenceRunId = String(event.runId || currentRunId || '').trim();
    if (
      startedPresenceRunId
      && durableActiveRunId === startedPresenceRunId
      && ['pending', 'live'].includes(durableActiveRun?.status)
    ) {
      invalidateManagedDiscoveryMissingRun(
        managedDiscoveryRunKey(event.hostId, plannedSessionId, startedPresenceRunId)
      );
    }
    let confirmedProvenance;
    try {
      confirmedProvenance = await commitStartedSessionProvenance(
        event,
        bridgeSession || currentSession
      );
    } catch (error) {
      const failureSessionId = bridgeSession?.sessionId || event.bridgeSessionId || effectiveSessionId;
      const failedRun = await failPlannedRun(event.hostId, failureSessionId, event.runId || currentRunId, error);
      const eventHost = state.hosts.get(event.hostId);
      const wouldOverwriteLiveProjection = Boolean(bridgeSession?.live || currentSession?.live);
      const rejectedRunId = event.runId || currentRunId || null;
      const rejectedRecord = rejectedRunId ? state.provenance.getSessionRecord({
        hostId: event.hostId,
        sessionId: failureSessionId,
      }) : null;
      const rejectedRun = rejectedRunId ? rejectedRecord?.runs?.[rejectedRunId] || null : null;
      if ((failedRun?.transitioned === true || rejectedRun?.status === 'failed') && rejectedRunId) {
        enqueueCommand(event.hostId, {
          type: 'session.stop',
          sessionId: effectiveSessionId,
          requestedSessionId: failureSessionId,
          bridgeSessionId: event.bridgeSessionId || failureSessionId,
          nativeThreadId: event.nativeThreadId || effectiveSessionId,
          runId: rejectedRunId,
          suppressTerminalEvent: true,
          reason: 'start-confirmation-rejected',
        });
      }
      if (
        eventHost?.capabilities?.runApiBinding === true
        && failedRun?.transitioned !== true
        && (failedRun?.missing !== true || wouldOverwriteLiveProjection)
      ) {
        return;
      }
      const failed = upsertSession(event.hostId, {
        sessionId: failureSessionId,
        state: `failed:${error.code || 'session_spawn_failed'}`,
        live: false,
        runId: event.runId || currentRunId || null,
        resumeError: {
          code: error.code || 'session_spawn_failed',
          error: error.message || 'Session start confirmation failed.',
          stage: 'confirm-start',
          canRebind: Boolean(error.canRebind),
          canTranscriptFallback: sessionCanTranscriptFallback(event.hostId, failureSessionId),
        },
        lastUpdatedAt: event.timestamp || nowIso(),
      }, { preserveManagedLive: false });
      emitSessionAlert(event.hostId, failureSessionId, {
        severity: 'error',
        source: 'runtime',
        message: error.message || 'Session start confirmation failed.',
        timestamp: event.timestamp || nowIso(),
      });
      broadcastSessionEvent(event.hostId, failureSessionId, 'session.state_changed', failed);
      broadcastSessionEvent(event.hostId, failureSessionId, 'session.snapshot', failed);
      return;
    }
    const runId = confirmedProvenance.runId || event.runId || bridgeSession?.runId || currentSession?.runId || null;
    const confirmedRun = confirmedProvenance.run || confirmedProvenance.record?.runs?.[runId] || null;
    if (
      runId
      && confirmedProvenance.record?.activeRunId === runId
      && confirmedRun?.status === 'live'
    ) {
      invalidateManagedDiscoveryMissingRun(
        managedDiscoveryRunKey(event.hostId, plannedSessionId, runId)
      );
    }
    const confirmedBinding = publicBinding(confirmedRun?.apiBinding);
    const apiProfile = confirmedBinding?.kind === 'profile' ? {
      profileId: confirmedBinding.profileId || null,
      label: confirmedBinding.label || confirmedBinding.provider || 'API profile',
      provider: confirmedBinding.provider || null,
      baseUrl: confirmedBinding.normalizedBaseUrl || null,
    } : bridgeSession?.apiProfile || currentSession?.apiProfile || null;
    const inheritedOriginSessionId = event.originSessionId
      || bridgeSession?.originSessionId
      || currentSession?.originSessionId
      || null;
    const inheritedSourceSessionId = event.sourceSessionId
      || bridgeSession?.sourceSessionId
      || currentSession?.sourceSessionId
      || null;
    const eventConversationKey = event.conversationKey && event.conversationKey !== effectiveSessionId
      ? event.conversationKey
      : '';
    const inheritedConversationKey = eventConversationKey
      || event.originSessionId
      || bridgeSession?.conversationKey
      || currentSession?.conversationKey
      || inheritedOriginSessionId
      || inheritedSourceSessionId
      || event.bridgeSessionId
      || effectiveSessionId;
    const next = event.bridgeSessionId && event.bridgeSessionId !== effectiveSessionId
      ? migrateSessionIdentity(event.hostId, event.bridgeSessionId, effectiveSessionId, {
        title: event.title || effectiveSessionId,
        cwd: event.cwd || null,
        source: event.source || 'managed',
        state: 'running',
        live: true,
        createdAt: event.createdAt || bridgeSession?.createdAt || currentSession?.createdAt || nowIso(),
        messageCount: bridgeSession?.messageCount || currentSession?.messageCount || 0,
        runtime: event.runtime || null,
        runId,
        originSessionId: inheritedOriginSessionId,
        sourceSessionId: inheritedSourceSessionId,
        conversationKey: inheritedConversationKey,
        launchMode: event.launchMode || null,
        nativeThreadId: event.nativeThreadId || effectiveSessionId,
        apiProfile,
        apiBinding: confirmedBinding,
        activeRunId: confirmedProvenance.record?.activeRunId || runId,
        latestSuccessfulRunId: confirmedProvenance.record?.latestSuccessfulRunId || runId,
        requestedSelection: confirmedRun?.requestedSelection || null,
        effectiveSelection: confirmedRun?.effectiveSelection || null,
      })
      : upsertSession(event.hostId, {
        sessionId: effectiveSessionId,
        title: event.title || effectiveSessionId,
        cwd: event.cwd || null,
        source: event.source || 'managed',
        state: 'running',
        live: true,
        createdAt: event.createdAt || currentSession?.createdAt || nowIso(),
        messageCount: currentSession?.messageCount || 0,
        runtime: event.runtime || null,
        runId,
        originSessionId: inheritedOriginSessionId,
        sourceSessionId: inheritedSourceSessionId,
        conversationKey: inheritedConversationKey,
        launchMode: event.launchMode || null,
        bridgeSessionId: event.bridgeSessionId || null,
        nativeThreadId: event.nativeThreadId || effectiveSessionId,
        apiProfile,
        apiBinding: confirmedBinding,
        activeRunId: confirmedProvenance.record?.activeRunId || runId,
        latestSuccessfulRunId: confirmedProvenance.record?.latestSuccessfulRunId || runId,
        requestedSelection: confirmedRun?.requestedSelection || null,
        effectiveSelection: confirmedRun?.effectiveSelection || null,
        lastUpdatedAt: nowIso(),
      });
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.started', next);
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.snapshot', next);
    return;
  }

  if (event.type === 'session.output') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    if (eventTargetsPublishedParentRun(event, effectiveSessionId)) {
      if (event.stream === 'stderr') {
        const alert = buildAlertFromOutput(event);
        if (alert) {
          emitSessionAlert(event.hostId, effectiveSessionId, alert);
        }
        return;
      }
      const outputChannel = getOutputChannel(event);
      if (isInternalOutputEvent(event)) {
        emitSessionDiagnostic(event.hostId, effectiveSessionId, {
          timestamp: event.timestamp || nowIso(),
          severity: 'info',
          source: event.source || 'codex',
          kind: diagnosticKindForOutputChannel(outputChannel),
          method: event.method || `session.output/${outputChannel || 'internal'}`,
          message: event.chunk || '',
          data: {
            stream: event.stream || 'stdout',
            text: event.chunk || '',
            phase: event.phase || null,
            channel: event.channel || null,
          },
        });
        return;
      }
      if (classifyOutputSpeaker(event.chunk || '', event.stream || 'stdout') === 'agent') {
        emitTranscriptEntry(event.hostId, effectiveSessionId, {
          speaker: 'agent',
          clientRequestId: event.clientRequestId || null,
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
      }
      return;
    }
    const existingSession = getSession(event.hostId, effectiveSessionId);
    const liveState = existingSession?.state === 'ending' ? 'ending' : 'running';
    const next = upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      state: liveState,
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

    const outputChannel = getOutputChannel(event);
    if (isInternalOutputEvent(event)) {
      emitSessionDiagnostic(event.hostId, effectiveSessionId, {
        timestamp: event.timestamp || nowIso(),
        severity: 'info',
        source: event.source || 'codex',
        kind: diagnosticKindForOutputChannel(outputChannel),
        method: event.method || `session.output/${outputChannel || 'internal'}`,
        message: event.chunk || '',
        data: {
          stream: event.stream || 'stdout',
          text: event.chunk || '',
          phase: event.phase || null,
          channel: event.channel || null,
        },
      });
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.snapshot', next);
      return;
    }

    const speaker = classifyOutputSpeaker(event.chunk || '', event.stream || 'stdout');
    if (speaker === 'agent') {
      const snapshot = upsertSession(event.hostId, {
        sessionId: effectiveSessionId,
        state: liveState,
        live: true,
        latestAgentMessage: event.chunk || null,
        lastUpdatedAt: nowIso(),
      });
      emitTranscriptEntry(event.hostId, effectiveSessionId, {
        speaker,
        clientRequestId: event.clientRequestId || null,
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

  if (event.type === 'session.transcript') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    let normalizedTranscript = normalizeStoredTranscriptEntry({
      speaker: event.speaker || 'system',
      text: event.text || '',
      stream: event.stream || null,
      source: event.source || null,
      clientRequestId: event.clientRequestId || null,
      files: event.files || event.attachments || [],
      timestamp: event.timestamp || nowIso(),
    });
    if (!normalizedTranscript) {
      return;
    }
    const speaker = normalizedTranscript.speaker || 'system';
    let assignedAssistant = null;
    if (
      (speaker === 'agent' || speaker === 'assistant')
      && event.assistantObservation
      && typeof event.assistantObservation === 'object'
    ) {
      assignedAssistant = await assignAssistantObservations(
        event.hostId,
        {
          ...event,
          sessionId: effectiveSessionId,
        },
        [event.assistantObservation]
      );
      const assignedEntry = assignedAssistant.entries[0];
      if (!assignedEntry) {
        throw new Error('Assistant transcript identity assignment did not produce a durable entry');
      }
      if (assignedAssistant.changed) {
        publishCanonicalSessionEvent(
          assignedAssistant.canonicalKey,
          'session.assistant_projection',
          assignedAssistant.projection
        );
      }
      normalizedTranscript = normalizeStoredTranscriptEntry({
        ...normalizedTranscript,
        ...assignedEntry,
        source: event.source || normalizedTranscript.source || null,
        clientRequestId: event.clientRequestId || normalizedTranscript.clientRequestId || null,
      });
    }
    if (consumePendingUserTranscriptEcho(event.hostId, effectiveSessionId, normalizedTranscript)) {
      return;
    }
    const existing = getSession(event.hostId, effectiveSessionId);
    const next = upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      source: existing?.source || (event.source === 'codex-jsonl' ? 'imported' : 'managed'),
      state: existing?.state || 'imported',
      live: existing?.live || false,
      latestUserMessage: speaker === 'user' ? normalizedTranscript.text || null : existing?.latestUserMessage || null,
      latestAgentMessage: (speaker === 'agent' || speaker === 'assistant') ? normalizedTranscript.text || null : existing?.latestAgentMessage || null,
      nativeThreadId: existing?.nativeThreadId || event.nativeThreadId || effectiveSessionId,
      assistantProjection: compactAssistantProjection(
        assignedAssistant?.projection
        || assistantProjectionForIdentity(event.hostId, {
          ...event,
          sessionId: effectiveSessionId,
        }, {
          afterSeq: Number.MAX_SAFE_INTEGER,
          limit: 1,
        })
      ),
      lastUpdatedAt: normalizedTranscript.timestamp || nowIso(),
    });
    emitTranscriptEntry(event.hostId, effectiveSessionId, normalizedTranscript);
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.snapshot', getSession(event.hostId, effectiveSessionId) || next);
    return;
  }

  if (event.type === 'session.state_changed') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    const existingSession = getSession(event.hostId, effectiveSessionId);
    const existingRuntime = state.sessionRuntime.get(sessionKey(event.hostId, effectiveSessionId)) || null;
    const existingRunId = existingSession?.runId || existingRuntime?.runId || null;
    if (event.runId && existingRunId && event.runId !== existingRunId) {
      const replacementRecord = state.provenance.getSessionRecord({
        hostId: event.hostId,
        sessionId: existingSession?.bridgeSessionId || existingSession?.sessionId || effectiveSessionId,
      });
      const replacementRun = replacementRecord?.activeRunId
        ? replacementRecord.runs?.[replacementRecord.activeRunId] || null
        : null;
      const terminalNamedRun = replacementRecord?.runs?.[event.runId] || null;
      if (
        event.live === false
        && terminalNamedRun?.status === 'live'
        && (
          replacementRecord.activeRunId === event.runId
          || (
            replacementRun?.status === 'pending'
            && replacementRun.parentRunId === event.runId
          )
        )
      ) {
        await state.provenance.stopRun({
          identity: {
            hostId: event.hostId,
            sessionId: existingSession?.bridgeSessionId || existingSession?.sessionId || effectiveSessionId,
          },
          runId: event.runId,
        });
        emitSessionDiagnostic(event.hostId, effectiveSessionId, {
          severity: 'info',
          source: 'relay',
          kind: 'lifecycle',
          method: 'session.state_changed/replacement-parent-stopped',
          message: `Recorded terminal state for parent run ${event.runId} without replacing pending run ${replacementRecord.activeRunId}.`,
          timestamp: event.timestamp || nowIso(),
        });
        return;
      }
      emitSessionDiagnostic(event.hostId, effectiveSessionId, {
        severity: 'info',
        source: 'relay',
        kind: 'lifecycle',
        method: 'session.state_changed/ignored-stale-run',
        message: `Ignored stale state update from run ${event.runId}.`,
        data: {
          eventRunId: event.runId,
          currentRunId: existingRunId,
          state: event.state || null,
          live: typeof event.live === 'boolean' ? event.live : null,
        },
        timestamp: event.timestamp || nowIso(),
      });
      return;
    }
    const terminalRunId = event.runId || existingRunId || null;
    const terminalRecord = terminalRunId ? state.provenance.getSessionRecord({
      hostId: event.hostId,
      sessionId: existingSession?.bridgeSessionId || existingSession?.sessionId || effectiveSessionId,
    }) : null;
    const terminalRun = terminalRunId ? terminalRecord?.runs?.[terminalRunId] || null : null;
    if (event.live === false && terminalRun?.status === 'failed') {
      emitSessionDiagnostic(event.hostId, effectiveSessionId, {
        severity: 'info',
        source: 'relay',
        kind: 'lifecycle',
        method: 'session.state_changed/ignored-failed-run-terminal',
        message: `Ignored terminal state ${event.state || 'unknown'} after run ${terminalRunId} had already failed.`,
        data: {
          runId: terminalRunId,
          failedCode: terminalRun.error?.code || null,
          terminalState: event.state || null,
        },
        timestamp: event.timestamp || nowIso(),
      });
      return;
    }
    if (event.live === false && (event.runId || existingRunId)) {
      try {
        await state.provenance.stopRun({
          identity: {
            hostId: event.hostId,
            sessionId: existingSession?.bridgeSessionId || existingSession?.sessionId || effectiveSessionId,
          },
          runId: event.runId || existingRunId,
        });
      } catch (error) {
        if (error?.code !== 'session_run_not_found') {
          throw error;
        }
      }
    }
    const wasEnding = existingSession?.state === 'ending' || existingRuntime?.phase === 'ending';
    const next = upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      state: event.state || 'unknown',
      live: typeof event.live === 'boolean' ? event.live : true,
      runId: event.runId || existingRunId || null,
      lastUpdatedAt: nowIso(),
    }, { preserveManagedLive: event.live !== false });

    if (event.live === false) {
      const runtime = setSessionRuntime(event.hostId, effectiveSessionId, {
        phase: 'closed',
        connection: 'closed',
        busy: false,
        activeTurnId: null,
        currentTurnStatus: 'closed',
        waitingOnApproval: false,
        waitingOnUserInput: false,
        runId: event.runId || existingRunId || null,
        updatedAt: event.timestamp || nowIso(),
      });
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.runtime_updated', {
        hostId: event.hostId,
        sessionId: effectiveSessionId,
        patch: runtime,
        timestamp: event.timestamp || nowIso(),
      });
    }

    const nextState = String(next.state || '');
    const isExitState = /^exited:/i.test(nextState);
    const isCleanExit = /^exited:0:/i.test(nextState);
    const isStoppedState = /^(history-only|stopped|closed)$/i.test(nextState);
    if (isStoppedState) {
      emitSessionAlert(event.hostId, effectiveSessionId, {
        severity: 'info',
        source: 'runtime',
        message: 'Session stopped successfully. History is still available and can be resumed.',
        timestamp: event.timestamp || nowIso(),
      });
    } else if (/^failed:/i.test(nextState) || (isExitState && !isCleanExit && !wasEnding)) {
      emitSessionAlert(event.hostId, effectiveSessionId, {
        severity: 'error',
        source: 'runtime',
        message: `Session state changed: ${nextState}`,
        timestamp: event.timestamp || nowIso(),
      });
    }

    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.state_changed', next);
    return;
  }

  if (event.type === 'session.runtime_updated') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    if (
      event.patch?.nativeResumeReady === true
      && event.runId
      && state.hosts.get(event.hostId)?.capabilities?.nativeResumeReadiness === true
    ) {
      await state.provenance.confirmNativeResumeReady({
        identity: { hostId: event.hostId, sessionId: effectiveSessionId },
        runId: event.runId,
      });
    }
    if (eventTargetsPublishedParentRun(event, effectiveSessionId)) {
      return;
    }
    const existing = getSession(event.hostId, effectiveSessionId);
    if (
      event.source === 'codex-jsonl'
      && existing?.live === true
      && existing?.source === 'managed'
    ) {
      // The app-server runner owns live control state. Rollout tail state is
      // retained for history/recovery only and must not revive or hide a live
      // error, Stop, or completed turn on legacy Hosts.
      return;
    }
    const runtimePatch = runtimePatchWithPendingStopPriority(
      event.hostId,
      effectiveSessionId,
      event.runId,
      event.patch || {}
    );
    const existingRuntime = state.sessionRuntime.get(resolveSessionKey(event.hostId, effectiveSessionId)) || {};
    const incomingRuntime = {
      ...runtimePatch,
      runId: event.runId || runtimePatch.runId || existing?.runId || null,
      updatedAt: event.timestamp || nowIso(),
    };
    if (runtimePatchHasStaleRevision(existingRuntime, incomingRuntime)) {
      return;
    }
    upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      title: existing?.title || effectiveSessionId,
      source: existing?.source || (event.source === 'codex-jsonl' ? 'imported' : 'managed'),
      state: existing?.state || (event.patch?.phase || 'imported'),
      live: Boolean(existing?.live),
      runId: event.runId || existing?.runId || event.patch?.runId || null,
      lastUpdatedAt: event.timestamp || nowIso(),
      nativeThreadId: existing?.nativeThreadId || event.nativeThreadId || effectiveSessionId,
    });
    const runtime = setSessionRuntime(event.hostId, effectiveSessionId, incomingRuntime);
    const runtimeClientRequestId = normalizeClientRequestId(
      runtime?.clientRequestId
      || runtime?.pendingClientRequestId
      || event.clientRequestId
      || event.patch?.clientRequestId
    );
    if (runtimeClientRequestId && runtime?.activeTurnId && runtime?.busy !== false) {
      markUserTranscriptAccepted(event.hostId, effectiveSessionId, runtimeClientRequestId);
    }
    maybeClearGoalAutoApproveForRuntime(event.hostId, effectiveSessionId, runtime);
    const phase = String(runtime?.phase || '').toLowerCase();
    const turnIsInactive = !runtime?.activeTurnId
      && !runtime?.busy
      && !runtime?.waitingOnApproval
      && !runtime?.waitingOnUserInput
      && ['idle', 'error', 'interrupted', 'closed', 'quota-exhausted'].includes(phase);
    if (turnIsInactive) {
      resolvePendingSessionRequests(event.hostId, effectiveSessionId, {
        status: phase === 'error' || phase === 'quota-exhausted' ? 'failed' : 'expired',
        updatedAt: event.timestamp || nowIso(),
        message: `Request closed because the session runtime is ${phase}.`,
      });
    }
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.runtime', {
      ...(runtime || {}),
      hostId: event.hostId,
      sessionId: effectiveSessionId,
    });
    return;
  }

  if (event.type === 'session.review_started') {
    const effectiveSessionId = event.sessionId || event.nativeThreadId || sessionId;
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    emitSessionDiagnostic(event.hostId, effectiveSessionId, {
      severity: 'info',
      source: 'codex',
      kind: 'control',
      method: 'review/start',
      message: `Review started${event.reviewThreadId ? `: ${event.reviewThreadId}` : ''}`,
      data: {
        reviewThreadId: event.reviewThreadId || null,
        turnId: event.turnId || null,
        target: event.target || null,
        delivery: event.delivery || null,
      },
      turnId: event.turnId || null,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'session.diagnostic') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    const existing = getSession(event.hostId, effectiveSessionId);
    upsertSession(event.hostId, {
      sessionId: effectiveSessionId,
      title: existing?.title || effectiveSessionId,
      source: existing?.source || (event.source === 'codex-jsonl' ? 'imported' : 'managed'),
      state: existing?.state || 'imported',
      live: Boolean(existing?.live),
      runId: event.runId || existing?.runId || null,
      lastUpdatedAt: event.timestamp || nowIso(),
      nativeThreadId: existing?.nativeThreadId || event.nativeThreadId || effectiveSessionId,
    });
    emitSessionDiagnostic(event.hostId, effectiveSessionId, {
      severity: event.severity || 'info',
      source: event.source || 'codex',
      kind: event.kind || 'event',
      method: event.method || null,
      message: event.message || '',
      detail: event.detail || null,
      data: event.data || null,
      runId: event.runId || event.data?.runId || null,
      turnId: event.turnId || event.data?.turnId || null,
      itemId: event.itemId || event.data?.itemId || null,
      callId: event.callId || event.data?.callId || null,
      requestId: event.requestId || event.data?.requestId || null,
      status: event.status || event.data?.status || null,
      final: event.final === true,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'session.request') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    const requestEntry = {
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
      availableDecisions: event.availableDecisions || event.payload?.availableDecisions || [],
      response: event.response || null,
      runId: event.runId || event.payload?.runId || null,
      turnId: event.turnId || event.payload?.turnId || null,
      itemId: event.itemId || event.payload?.itemId || null,
      callId: event.callId || event.payload?.callId || null,
    };
    emitSessionRequest(event.hostId, effectiveSessionId, requestEntry);
    maybeAutoApproveSessionRequest(event.hostId, effectiveSessionId, requestEntry);
    return;
  }

  if (event.type === 'session.request.resolved') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    resolveSessionRequest(event.hostId, effectiveSessionId, event.requestId, {
      status: event.status || 'resolved',
      updatedAt: event.timestamp || nowIso(),
      response: event.response || null,
      summary: event.summary || null,
      message: event.message || null,
    });
    return;
  }

  if (event.type === 'session.error') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    const message = event.message || 'session error';
    if (isBenignSessionWatchNoLiveError(message)) {
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.watch.updated', {
        hostId: event.hostId,
        sessionId: effectiveSessionId,
        watched: false,
        error: message,
        compatibilityDowngrade: true,
        timestamp: event.timestamp || nowIso(),
      });
      return;
    }
    if (/no live session for command session\.(model_list|stop)/i.test(message)) {
      markSessionClosed(event.hostId, effectiveSessionId);
      return;
    }
    if (isDuplicateManagedStartFailureError(event, effectiveSessionId, message)) {
      emitSessionDiagnostic(event.hostId, effectiveSessionId, {
        severity: 'info',
        source: 'relay',
        kind: 'lifecycle',
        method: 'session.error/suppressed-duplicate-start-failure',
        message: `Suppressed duplicate runtime error after the structured start failure for run ${event.runId}.`,
        detail: message,
        data: {
          runId: event.runId,
          duplicateOf: 'session.command_failed',
        },
        timestamp: event.timestamp || nowIso(),
      });
      broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.error', {
        ...event,
        duplicateAlertSuppressed: true,
        timestamp: event.timestamp || nowIso(),
      });
      return;
    }

    emitSessionAlert(event.hostId, effectiveSessionId, {
      severity: 'error',
      source: 'runtime',
      message,
      timestamp: event.timestamp || nowIso(),
    });
    broadcastSessionEvent(event.hostId, effectiveSessionId, 'session.error', {
      ...event,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }

  if (event.type === 'session.alert') {
    const effectiveSessionId = resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId || sessionId);
    if (isStaleSessionRunEvent(event, effectiveSessionId)) {
      return;
    }
    emitSessionAlert(event.hostId, effectiveSessionId, {
      severity: event.severity || 'warning',
      source: event.source || 'runtime',
      message: event.message || '',
      transient: event.transient === true,
      turnId: event.turnId || null,
      timestamp: event.timestamp || nowIso(),
    });
    return;
  }
}

const activeRelayRequests = new Set();
const server = http.createServer((req, res) => {
  req.on('error', (error) => {
    if (!isClientAbortError(error)) {
      console.error(error);
    }
  });
  if (!relayReady) {
    sendJson(res, 503, {
      ok: false,
      status: 'starting',
      error: 'Relay startup is not complete.',
    });
    return;
  }
  const handling = handleRequest(req, res)
    .catch((error) => {
      if (isClientAbortError(error) || req.destroyed || res.destroyed) {
        return;
      }
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: error.message || 'internal error' });
        return;
      }
      res.destroy(error);
    })
    .finally(() => {
      activeRelayRequests.delete(handling);
    });
  activeRelayRequests.add(handling);
});

function hydrateSessionMetadataCacheFromStore() {
  const snapshot = state.sessionRecordStore?.readSnapshot();
  if (!snapshot) {
    return;
  }
  const cache = new Map(state.sessionMetadata);
  const canonicalSessions = new Map();
  for (const [canonicalKey, record] of Object.entries(snapshot.records || {})) {
    if (!record?.hostId || !record.title || state.dismissedHosts.has(record.hostId)) {
      continue;
    }
    const identities = getSessionTitleIdentities(null, record);
    for (const identity of identities) {
      cache.set(sessionMetadataKey(record.hostId, identity), {
        hostId: record.hostId,
        identity,
        title: record.title,
        cwd: record.cwd || '',
        source: record.source || 'metadata',
        updatedAt: record.updatedAt || nowIso(),
      });
    }
    const sessionId = String(
      record.nativeThreadId
      || record.bridgeSessionId
      || record.conversationKey
      || canonicalKey.slice(`${record.hostId}::`.length)
    ).trim();
    if (!sessionId) {
      continue;
    }
    canonicalSessions.set(canonicalKey, { hostId: record.hostId, sessionId });
    const runId = record.activeRunId || record.latestSuccessfulRunId || null;
    const run = runId ? record.runs?.[runId] || null : null;
    const binding = publicBinding(run?.apiBinding);
    const key = sessionKey(record.hostId, sessionId);
    if (!state.sessions.has(key)) {
      state.sessions.set(key, {
        hostId: record.hostId,
        sessionId,
        title: record.title || sessionId,
        cwd: record.cwd || null,
        source: record.source || 'imported',
        state: 'history-only',
        live: false,
        createdAt: run?.createdAt || record.updatedAt || null,
        lastUpdatedAt: record.updatedAt || run?.endedAt || run?.createdAt || nowIso(),
        originSessionId: record.originSessionId || null,
        sourceSessionId: record.sourceSessionId || null,
        conversationKey: record.conversationKey || sessionId,
        bridgeSessionId: record.bridgeSessionId || null,
        nativeThreadId: record.nativeThreadId || sessionId,
        runId,
        activeRunId: record.activeRunId || null,
        latestSuccessfulRunId: record.latestSuccessfulRunId || null,
        apiBinding: binding,
        apiProfile: binding?.kind === 'profile' ? {
          profileId: binding.profileId || null,
          label: binding.label || binding.provider || 'API profile',
          provider: binding.provider || null,
          baseUrl: binding.normalizedBaseUrl || null,
        } : null,
        requestedSelection: run?.requestedSelection || null,
        effectiveSelection: run?.effectiveSelection || null,
        messageCount: 0,
      });
    }
  }
  for (const [aliasKey, canonicalKey] of Object.entries(snapshot.aliases || {})) {
    const target = canonicalSessions.get(canonicalKey);
    if (!target) {
      continue;
    }
    const prefix = `${target.hostId}::`;
    if (!aliasKey.startsWith(prefix)) {
      continue;
    }
    const aliasSessionId = aliasKey.slice(prefix.length);
    rememberSessionAlias(target.hostId, aliasSessionId, target.sessionId);
    if (aliasSessionId !== target.sessionId) {
      moveSessionArtifacts(target.hostId, aliasSessionId, target.sessionId);
    }
  }
  for (const session of state.sessions.values()) {
    const key = resolveSessionKey(session.hostId, session.sessionId);
    session.messageCount = Math.max(
      Number(session.messageCount || 0),
      state.sessionLogs.get(key)?.length || 0
    );
  }
  state.sessionMetadata = cache;
}

async function reconcilePendingSessionRunsAfterRestart() {
  const snapshot = state.sessionRecordStore?.readSnapshot();
  let reconciled = 0;
  for (const [canonicalKey, record] of Object.entries(snapshot?.records || {})) {
    const runId = record?.activeRunId || null;
    const run = runId ? record.runs?.[runId] || null : null;
    if (!run || run.status !== 'pending') {
      continue;
    }
    const prefix = `${record.hostId}::`;
    const sessionId = canonicalKey.startsWith(prefix)
      ? canonicalKey.slice(prefix.length)
      : record.bridgeSessionId || record.nativeThreadId;
    await state.provenance.failRun({
      identity: { hostId: record.hostId, sessionId },
      runId,
      code: 'session_relay_restarted',
      message: 'Relay restarted before the Host confirmed this Session run.',
    });
    reconciled += 1;
  }
  if (reconciled > 0) {
    console.warn(`[relay] reconciled ${reconciled} pending Session run(s) after restart`);
  }
}

async function reconcileStopRequestsAfterRestart() {
  const snapshot = state.sessionRecordStore?.readSnapshot();
  let reconciled = 0;
  for (const [canonicalKey, record] of Object.entries(snapshot?.records || {})) {
    for (const [runId, run] of Object.entries(record?.runs || {})) {
      if (!run?.stopRequestId) {
        continue;
      }
      const prefix = `${record.hostId}::`;
      const sessionId = canonicalKey.startsWith(prefix)
        ? canonicalKey.slice(prefix.length)
        : record.bridgeSessionId || record.nativeThreadId;
      const result = await state.provenance.cancelStopRun({
        identity: { hostId: record.hostId, sessionId },
        runId,
        stopRequestId: run.stopRequestId,
      });
      if (result.transitioned) {
        projectStopFailedSession(record.hostId, sessionId, {
          runId,
          message: 'Relay restarted before the Host confirmed this Stop. The Session remains blocked to avoid sending into an unknown runtime; retry Stop, then Resume it.',
          connection: 'unknown',
          broadcast: false,
          source: 'relay',
        });
        reconciled += 1;
      }
    }
  }
  if (reconciled > 0) {
    console.warn(`[relay] marked ${reconciled} unconfirmed Session Stop request(s) as stop-failed after restart`);
  }
}

function listenRelayServer() {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT);
  });
}

async function startRelay() {
  relayStateLock = await acquireRelayStateLock(RELAY_STATE_ROOT);
  try {
    await listenRelayServer();
    writeRelayOwnerMarker();
    relayOwnerMarkerWritten = true;
    RELAY_CONTROL_TOKEN = loadRelayControlToken();
    RELAY_AUTH_TOKEN = loadRelayAuthToken();
    relayAuthAccount = loadRelayAuthAccount();
    loadPersistedRelayState();
    state.sessionRecordStore = await SessionRecordStore.open({
      rootDir: SESSION_RECORD_STORE_ROOT,
      legacyMetadataPath: SESSION_METADATA_PATH,
      now: nowIso,
    });
    state.provenance = new SessionProvenanceService({
      store: state.sessionRecordStore,
      now: nowIso,
    });
    await reconcileStopRequestsAfterRestart();
    await reconcilePendingSessionRunsAfterRestart();
    state.modelCatalog = new ModelCatalogService({
      store: state.sessionRecordStore,
      fetchLivePage: requestLiveModelPage,
      fetchProviderPage: requestProviderModelPage,
      overrides: [{
        ...providerCapabilities.createAdvisoryOverrideSource('openai'),
        providerKind: 'openai',
      }],
      now: nowIso,
    });
    state.skillAudit = new SkillAuditLog({
      auditPath: SKILL_AUDIT_PATH,
      now: nowIso,
    });
    state.skillAutomation = new SkillAutomationService({
      tickIntervalMs: SKILL_AUTOMATION_TICK_MS,
      loadSources: () => state.skillRegistry.snapshot({ includeManifest: false }).sources,
      scheduleRefresh: (source) => queueRegistrySkillSourceRefresh(source.sourceId, {
        automated: true,
      }),
      loadDesiredStates: () => state.skillDeployments.desiredStates(),
      dispatchRollout: (request) => createSkillDeployment(request),
      audit: (type, data, options) => recordSkillAudit(type, data, options),
    });
    hydrateSessionMetadataCacheFromStore();

    if (LOCAL_AGENT_WATCHDOG_ENABLED) {
      localAgentWatchdogTimer = setInterval(localAgentWatchdogTick, LOCAL_AGENT_WATCHDOG_INTERVAL_MS);
      localAgentWatchdogTimer.unref?.();
    }
    relayReady = true;
    state.skillAutomation.start();
    if (sessionDiagnosticsNeedsNormalization) {
      scheduleSessionDiagnosticsSave(0);
    }
    console.log(`relay listening on http://127.0.0.1:${PORT}`);
    if (LOCAL_AGENT_WATCHDOG_ENABLED) {
      console.log(`local agent watchdog enabled; startup grace ${Math.round(LOCAL_AGENT_STARTUP_GRACE_MS / 1000)}s, restart after ${Math.round(LOCAL_AGENT_OFFLINE_RESTART_MS / 1000)}s stale heartbeat`);
    }
    if (RELAY_AUTH_TOKEN) {
      console.log(`relay auth enabled; token file: ${RELAY_AUTH_TOKEN_PATH}`);
      console.log(relayAuthAccount?.username
        ? `relay web login enabled for user: ${relayAuthAccount.username}`
        : `relay web login setup pending; account file: ${RELAY_AUTH_ACCOUNT_PATH}`);
    } else {
      console.warn('relay auth disabled by RELAY_AUTH_DISABLED');
    }
  } catch (error) {
    relayReady = false;
    state.skillAutomation?.stop();
    const cleanupErrors = [];
    await closeRelayServer().catch((cleanupError) => cleanupErrors.push(cleanupError));
    await state.sessionRecordStore?.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
    state.sessionRecordStore = null;
    if (relayOwnerMarkerWritten) {
      try {
        await removeRelayOwnerMarker();
        relayOwnerMarkerWritten = false;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    const lock = relayStateLock;
    if (lock) {
      try {
        await lock.release();
        if (relayStateLock === lock) {
          relayStateLock = null;
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) {
      error.cleanupErrors = cleanupErrors.map((cleanupError) => cleanupError.message || String(cleanupError));
    }
    throw error;
  }
}

async function forceTrackedLocalAgent(record) {
  if (record.forceKillPromise) {
    const error = await record.forceKillPromise;
    if (error) throw error;
    return true;
  }
  return forceKillLocalAgentRecord(record);
}

async function joinRelayShutdownAgents(context) {
  let forceKillFailures = 0;
  while (true) {
    for (const record of state.localAgents.values()) {
      trackLocalAgentForRelayShutdown(record, context.signal);
    }
    let survivors = Array.from(context.records).filter(localAgentProcessIsAlive);
    while (survivors.length && Date.now() < context.deadline) {
      await new Promise((resolve) => setTimeout(resolve, LOCAL_AGENT_EXIT_POLL_MS));
      for (const record of state.localAgents.values()) {
        trackLocalAgentForRelayShutdown(record, context.signal);
      }
      survivors = Array.from(context.records).filter(localAgentProcessIsAlive);
    }
    if (!survivors.length) {
      return { ok: true, remainingAgentTrees: 0, forceKillFailures };
    }

    const forceKillResults = await Promise.allSettled(
      survivors.map((record) => forceTrackedLocalAgent(record))
    );
    forceKillFailures += forceKillResults.filter((result) => result.status === 'rejected').length;
    const remainingSurvivors = Array.from(context.records).filter(localAgentProcessIsAlive);
    if (remainingSurvivors.length) {
      return {
        ok: false,
        remainingAgentTrees: remainingSurvivors.length,
        forceKillFailures,
      };
    }
  }
}

function closeRelayServer() {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, 2000);
    forceCloseTimer.unref?.();
    server.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

async function flushRelayPersistence() {
  const errors = [];
  if (sessionLogsSaveTimer) {
    clearTimeout(sessionLogsSaveTimer);
    sessionLogsSaveTimer = null;
  }
  try {
    saveSessionLogs();
  } catch (error) {
    errors.push(error);
  }

  if (sessionDiagnosticsSaveTimer) {
    clearTimeout(sessionDiagnosticsSaveTimer);
    sessionDiagnosticsSaveTimer = null;
  }
  sessionDiagnosticsSavePending = true;
  try {
    await flushSessionDiagnosticsSave();
    if (sessionDiagnosticsSaveError) {
      throw sessionDiagnosticsSaveError;
    }
  } catch (error) {
    errors.push(error);
  }

  try {
    await state.sessionRecordStore?.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Relay persistence did not close cleanly.');
  }
}

async function quiesceRelayBackgroundTasks() {
  const automationTick = state.skillAutomation?.tickPromise;
  if (automationTick) {
    await automationTick;
  }
  while (relayBackgroundTasks.size) {
    await Promise.allSettled(Array.from(relayBackgroundTasks));
  }
  await state.skillRegistry?.mutationTail;
}

async function shutdownRelay(signal = 'SIGTERM') {
  if (relayShutdownPromise) return relayShutdownPromise;
  relayShutdownPromise = Promise.resolve().then(async () => {
    relayStopping = true;
    state.skillAutomation?.stop();
    for (const timer of stopFallbackTimers) {
      clearTimeout(timer);
    }
    stopFallbackTimers.clear();
    if (localAgentWatchdogTimer) {
      clearInterval(localAgentWatchdogTimer);
      localAgentWatchdogTimer = null;
    }
    relayShutdownContext = {
      signal,
      records: new Set(),
      deadline: Date.now() + LOCAL_AGENT_SHUTDOWN_GRACE_MS + LOCAL_AGENT_FORCE_EXIT_WAIT_MS + 2000,
    };
    for (const record of state.localAgents.values()) {
      trackLocalAgentForRelayShutdown(record, signal);
    }

    let joined = await joinRelayShutdownAgents(relayShutdownContext);
    if (!joined.ok) {
      console.error(
        `[relay] ${signal} shutdown could not confirm ${joined.remainingAgentTrees} local Agent process tree(s) exited${joined.forceKillFailures ? `; ${joined.forceKillFailures} force-kill operation(s) failed` : ''}. Relay will remain alive for launcher/service fallback.`
      );
      process.exitCode = 1;
      return {
        ok: false,
        signal,
        remainingAgentTrees: joined.remainingAgentTrees,
        forceKillFailures: joined.forceKillFailures,
      };
    }

    relayReady = false;
    await closeRelayServer();
    await Promise.allSettled(Array.from(activeRelayRequests));
    joined = await joinRelayShutdownAgents(relayShutdownContext);
    if (!joined.ok) {
      console.error(
        `[relay] ${signal} shutdown could not confirm ${joined.remainingAgentTrees} late local Agent process tree(s) exited. Relay will remain alive for launcher/service fallback.`
      );
      process.exitCode = 1;
      return {
        ok: false,
        signal,
        remainingAgentTrees: joined.remainingAgentTrees,
        forceKillFailures: joined.forceKillFailures,
      };
    }
    await quiesceRelayBackgroundTasks();
    try {
      await flushRelayPersistence();
    } catch (error) {
      console.error(`[relay] ${signal} shutdown persistence failed: ${error.stack || error}`);
      relayStateLock?.hold?.();
      process.exitCode = 1;
      return {
        ok: false,
        signal,
        persistenceError: error.message || String(error),
      };
    }
    await removeRelayOwnerMarker();
    relayOwnerMarkerWritten = false;
    const lock = relayStateLock;
    await lock?.release();
    if (relayStateLock === lock) {
      relayStateLock = null;
    }
    process.exit(0);
  }).catch((error) => {
    console.error(`[relay] ${signal} shutdown failed: ${error.stack || error}`);
    relayStateLock?.hold?.();
    process.exitCode = 1;
    return {
      ok: false,
      signal,
      error: error.message || String(error),
    };
  });
  return relayShutdownPromise;
}

process.once('SIGINT', () => {
  void shutdownRelay('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdownRelay('SIGTERM');
});
if (truthyEnv(process.env.RELAY_TEST_CONTROL_ENABLED) && typeof process.on === 'function') {
  process.on('message', (message) => {
    if (message?.type === 'remote-codex:test:shutdown') {
      void shutdownRelay('test-control');
    }
  });
}

startRelay().catch((error) => {
  console.error(`[relay] startup failed: ${error.stack || error}`);
  process.exitCode = 1;
});
