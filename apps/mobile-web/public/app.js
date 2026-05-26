const state = {
  hosts: [],
  dismissedHosts: [],
  sessions: [],
  stats: null,
  auth: {
    ready: false,
    required: false,
    authenticated: true,
    hasAccount: false,
    setupRequired: false,
    username: '',
    tokenHint: '',
    tokenFile: '',
    accountFile: '',
    accountOpen: false,
    error: '',
    accountError: '',
  },
  selectedHostId: null,
  selectedConversationKey: null,
  selectedSessionId: null,
  eventSource: null,
  eventSourceKey: null,
  transcripts: new Map(),
  alerts: new Map(),
  runtime: new Map(),
  diagnostics: new Map(),
  requests: new Map(),
  receivedFiles: new Map(),
  receivedFilesLoadingKeys: new Set(),
  streamStatus: new Map(),
  thinkingPanels: new Map(),
  alertWindowOpen: false,
  statusWindowOpen: false,
  connectorManagerOpen: false,
  connectors: [],
  connectorEditorId: null,
  connectorActionResults: new Map(),
  connectorActionBusy: null,
  sessionCollections: [],
  selectedCollectionId: 'default',
  sessionSearchQuery: '',
  sessionSearchMode: 'keyword',
  overviewCollapsed: false,
  newSessionCollapsed: false,
  hostSwitchBusyId: null,
  codexControls: {
    modelOptionsBySession: new Map(),
    modelOptionsLoadingKeys: new Set(),
    attachments: [],
    modelsLoading: false,
  },
  slashMenu: {
    open: false,
    query: '',
    selectedIndex: 0,
  },
  directoryPicker: {
    open: false,
    hostId: null,
    currentPath: '',
    parentPath: null,
    roots: [],
    directories: [],
    loading: false,
    error: null,
  },
};

const MAX_COMPOSER_IMAGES = 4;
const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_COMPOSER_TEXT_FILES = 4;
const MAX_COMPOSER_TEXT_FILE_BYTES = 768 * 1024;
const MAX_COMPOSER_UPLOAD_FILES = 8;
const MAX_COMPOSER_UPLOAD_FILE_BYTES = 16 * 1024 * 1024;
const MAX_COMPOSER_UPLOAD_TOTAL_BYTES = 24 * 1024 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
  'bat',
  'cmd',
  'css',
  'csv',
  'html',
  'js',
  'json',
  'jsonl',
  'jsx',
  'log',
  'md',
  'markdown',
  'ps1',
  'py',
  'sh',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);
const IMAGE_FILE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
const DOWNLOADABLE_FILE_EXTENSIONS = new Set([
  ...IMAGE_FILE_EXTENSIONS,
  'c',
  'cpp',
  'cs',
  'css',
  'csv',
  'doc',
  'docx',
  'go',
  'ipynb',
  'java',
  'js',
  'jsx',
  'h',
  'hpp',
  'mjs',
  'ps1',
  'py',
  'r',
  'rs',
  'sh',
  'sql',
  'toml',
  'ts',
  'tsx',
  'gz',
  'h5',
  'hdf5',
  'html',
  'json',
  'jsonl',
  'log',
  'md',
  'mov',
  'mp4',
  'npy',
  'npz',
  'parquet',
  'pdf',
  'pkl',
  'tar',
  'tgz',
  'txt',
  'webm',
  'xlsx',
  'xml',
  'xz',
  'yaml',
  'yml',
  'zip',
]);

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || `request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    error.url = url;
    if (response.status === 401 && body?.authRequired && !options.skipAuthHandling) {
      requireRelayLogin(error.message);
    }
    throw error;
  }
  return body;
}

function authAllowsRequests() {
  return !state.auth.required || state.auth.authenticated;
}

function renderAuthGate() {
  const gate = el('auth-gate');
  if (!gate) {
    return;
  }
  const locked = state.auth.required && !state.auth.authenticated;
  gate.classList.toggle('hidden', !locked);
  gate.setAttribute('aria-hidden', locked ? 'false' : 'true');

  const title = el('auth-title');
  if (title) {
    title.textContent = state.auth.setupRequired ? 'Set admin account' : 'Sign in';
  }

  const subtitle = el('auth-subtitle');
  if (subtitle) {
    subtitle.textContent = state.auth.setupRequired
      ? 'Create the browser login. The password is stored as a local scrypt hash, not plaintext.'
      : 'Use your relay account. The recovery token is still available for emergency access.';
  }

  const usernameInput = el('auth-username-input');
  if (usernameInput && document.activeElement !== usernameInput && !usernameInput.value) {
    usernameInput.value = state.auth.username || 'admin';
  }

  el('auth-password-confirm-input')?.classList.toggle('hidden', !state.auth.setupRequired);
  el('auth-recovery-details')?.classList.toggle('hidden', state.auth.setupRequired);

  const hint = el('auth-token-hint');
  if (hint) {
    if (!state.auth.required) {
      hint.textContent = 'Relay auth is disabled.';
    } else if (state.auth.setupRequired) {
      hint.textContent = `Account file: ${state.auth.accountFile || 'tmp/relay-auth-account.json'}. Recovery token: ${state.auth.tokenHint || '(new token)'}.`;
    } else {
      hint.textContent = `Signed account: ${state.auth.username || 'admin'}. Recovery token file: ${state.auth.tokenFile || 'tmp/relay-auth-token.txt'}.`;
    }
  }

  const error = el('auth-error');
  if (error) {
    error.textContent = state.auth.error || '';
  }

  const accountButton = el('account-button');
  if (accountButton) {
    accountButton.hidden = !state.auth.required || !state.auth.authenticated || !state.auth.hasAccount;
  }

  const logoutButton = el('logout-button');
  if (logoutButton) {
    logoutButton.hidden = !state.auth.required || !state.auth.authenticated;
  }

  renderAccountDialog();
}

function renderAccountDialog() {
  const dialog = el('account-dialog');
  if (!dialog) {
    return;
  }
  const open = state.auth.accountOpen;
  dialog.classList.toggle('hidden', !open);
  dialog.setAttribute('aria-hidden', open ? 'false' : 'true');
  const usernameInput = el('account-username-input');
  if (usernameInput && open && document.activeElement !== usernameInput && !usernameInput.value) {
    usernameInput.value = state.auth.username || 'admin';
  }
  const error = el('account-error');
  if (error) {
    error.textContent = state.auth.accountError || '';
  }
}

function requireRelayLogin(message = '') {
  state.auth.required = true;
  state.auth.authenticated = false;
  state.auth.error = message || 'Relay login is required.';
  closeStream();
  renderAuthGate();
}

function applyAuthConfig(config = {}) {
  state.auth.ready = true;
  state.auth.required = Boolean(config.authRequired);
  state.auth.authenticated = !state.auth.required || Boolean(config.authenticated);
  state.auth.hasAccount = Boolean(config.hasAccount);
  state.auth.setupRequired = Boolean(config.setupRequired);
  state.auth.username = config.username || state.auth.username || '';
  state.auth.tokenHint = config.tokenHint || '';
  state.auth.tokenFile = config.tokenFile || 'tmp/relay-auth-token.txt';
  state.auth.accountFile = config.accountFile || 'tmp/relay-auth-account.json';
}

async function refreshAuthState() {
  const config = await fetchJson('/api/auth/config', { skipAuthHandling: true });
  applyAuthConfig(config);
  if (state.auth.authenticated) {
    state.auth.error = '';
  }
  renderAuthGate();
  return state.auth.authenticated;
}

async function setupRelayAccount(username, password, confirmPassword) {
  const response = await fetchJson('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password, confirmPassword }),
    skipAuthHandling: true,
  });
  applyAuthConfig(response);
  state.auth.error = '';
  renderAuthGate();
  await refresh();
}

async function loginRelay(credentials) {
  const response = await fetchJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
    skipAuthHandling: true,
  });
  applyAuthConfig(response);
  state.auth.error = '';
  renderAuthGate();
  await refresh();
}

async function changeRelayPassword(payload) {
  const response = await fetchJson('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(payload),
    skipAuthHandling: true,
  });
  applyAuthConfig(response);
  state.auth.accountOpen = false;
  state.auth.accountError = '';
  renderAuthGate();
}

async function logoutRelay() {
  await fetchJson('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify({}),
    skipAuthHandling: true,
  }).catch(() => null);
  state.auth.required = true;
  state.auth.authenticated = false;
  state.auth.accountOpen = false;
  state.auth.error = 'Logged out.';
  closeStream();
  renderAuthGate();
}

function makeSessionKey(hostId, sessionId) {
  return `${hostId}::${sessionId}`;
}

function getSessionKey(session) {
  return session ? makeSessionKey(session.hostId, session.sessionId) : null;
}

function parseSessionTime(session) {
  const value = Date.parse(session?.lastUpdatedAt || session?.updatedAt || 0);
  return Number.isFinite(value) ? value : 0;
}

function compareSessions(a, b) {
  if (a.live !== b.live) {
    return a.live ? -1 : 1;
  }
  const delta = parseSessionTime(b) - parseSessionTime(a);
  if (delta !== 0) {
    return delta;
  }
  return String(a.title || a.sessionId).localeCompare(String(b.title || b.sessionId));
}

function truncatePreview(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function basename(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || text;
}

function formatTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

function formatElapsedSince(value, now = Date.now()) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  return formatDuration(now - timestamp);
}

function prettyStatusLabel(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const map = {
    idle: 'Idle',
    active: 'Thinking',
    thinking: 'Thinking',
    planning: 'Planning',
    reviewing: 'Reviewing',
    reconnecting: 'Reconnecting',
    retrying: 'Retrying',
    interrupted: 'Interrupted',
    error: 'Error',
    closed: 'Closed',
    booting: 'Booting',
    'waiting-approval': 'Waiting Approval',
    'waiting-user-input': 'Waiting Input',
    'running-shell-command': 'Running Shell Command',
    compacting: 'Compacting',
    'quota-exhausted': 'Quota Exhausted',
  };

  if (map[text]) {
    return map[text];
  }

  return text
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function connectorKindLabel(value) {
  return {
    outbound_agent: 'Outbound Agent',
    ssh_jump: 'SSH Jump',
    gateway_agent: 'Gateway Sidecar',
    reverse_tunnel: 'Reverse Tunnel',
    manual_only: 'Manual Only',
  }[value] || 'Connector';
}

function authMethodLabel(value) {
  return {
    ssh_key: 'SSH Key',
    ssh_agent: 'SSH Agent',
    password: 'Password',
    keyboard_interactive: 'Keyboard-Interactive',
    otp: 'OTP / MFA',
    browser_sso: 'Browser SSO',
    manual_captcha: 'Manual Captcha',
  }[value] || 'Auth';
}

function bootstrapModeLabel(value) {
  return {
    manual_tmux: 'Manual + tmux',
    manual_systemd: 'Manual + systemd',
    ssh_exec: 'SSH Exec',
    gateway_launcher: 'Gateway Launcher',
    manual_only: 'Manual Only',
  }[value] || 'Bootstrap';
}

function describeRuntimeStatus(runtime, stream, session) {
  const connection = stream?.connection || runtime?.connection || (session?.live ? 'connecting' : 'history only');
  const phase = prettyStatusLabel(runtime?.phase || session?.state || 'unknown');
  const turn = runtime?.currentTurnStatus ? prettyStatusLabel(runtime.currentTurnStatus) : (runtime?.activeTurnId ? 'Active' : 'Idle');
  const busy = runtime?.busy ? 'Busy' : 'Idle';
  return {
    connection,
    phase,
    turn,
    busy,
  };
}

function getRuntimeElapsedAnchor(runtime) {
  return runtime?.busy && runtime?.busyStartedAt
    ? runtime.busyStartedAt
    : runtime?.phaseStartedAt || runtime?.updatedAt || null;
}

function getStreamElapsedAnchor(stream) {
  return stream?.connectionChangedAt || stream?.lastPingAt || null;
}

function limitText(value, max = 220) {
  const text = String(value || '');
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function summarizeData(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }
  if (typeof value === 'string') {
    return limitText(value, 220);
  }
  try {
    return limitText(JSON.stringify(value), 320);
  } catch (_) {
    return limitText(String(value), 220);
  }
}

function formatThinkingValue(value, depth = 0) {
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
      .map((item) => formatThinkingValue(item, depth + 1))
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
      return summarizeData(value);
    }

    return Object.entries(value)
      .map(([key, item]) => {
        const normalized = formatThinkingValue(item, depth + 1);
        return normalized ? `${key}: ${normalized}` : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return String(value).trim();
}

function normalizeThinkingMessage(entry) {
  if (!entry) {
    return '';
  }

  const candidates = [
    entry.message,
    entry.detail,
    entry.data?.text,
    entry.data?.content,
    entry.data?.summary,
    entry.data?.plan,
    entry.data?.delta,
    entry.data?.rawPlan,
  ];

  for (const candidate of candidates) {
    const text = formatThinkingValue(candidate);
    if (text) {
      return text;
    }
  }

  return '';
}

function getLatestFormalAgentMessage(session) {
  if (!session) {
    return 'No recent agent reply captured.';
  }

  const transcript = getTranscriptForSession(session)
    .filter((entry) => entry && (entry.speaker === 'agent' || entry.speaker === 'assistant') && entry.text);
  const latest = transcript[transcript.length - 1];
  const fallback = String(session.latestAgentMessage || '').trim();
  if (fallback && fallback !== '[object Object]' && !/^\s*[\[{]/.test(fallback)) {
    return latest?.text || fallback;
  }
  return latest?.text || 'No recent agent reply captured.';
}

function buildThinkingEntriesForSession(session) {
  if (!session) {
    return [];
  }

  const transcript = getTranscriptForSession(session)
    .filter((entry) => entry && (entry.speaker === 'user' || entry.speaker === 'agent' || entry.speaker === 'assistant'));
  const diagnostics = getDiagnosticsForSession(session)
    .filter((entry) => entry && (entry.kind === 'reasoning' || entry.kind === 'plan'));

  const transcriptTimes = transcript.map((entry) => Date.parse(entry.timestamp || '')).map((value) => (Number.isFinite(value) ? value : null));
  const segments = [];

  for (let index = 0; index < transcript.length; index += 1) {
    const entry = transcript[index];
    if (entry.speaker !== 'user') {
      continue;
    }

    const startTime = transcriptTimes[index];
    if (!Number.isFinite(startTime)) {
      continue;
    }

    let replyTime = Infinity;
    for (let nextIndex = index + 1; nextIndex < transcript.length; nextIndex += 1) {
      const nextEntry = transcript[nextIndex];
      if (nextEntry.speaker === 'agent' || nextEntry.speaker === 'assistant') {
        const nextTime = transcriptTimes[nextIndex];
        if (Number.isFinite(nextTime)) {
          replyTime = nextTime;
        }
        break;
      }
      if (nextEntry.speaker === 'user') {
        const nextTime = transcriptTimes[nextIndex];
        if (Number.isFinite(nextTime)) {
          replyTime = nextTime;
        }
        break;
      }
    }

    const windowEntries = diagnostics
      .filter((diag) => {
        const diagTime = Date.parse(diag.timestamp || '');
        return Number.isFinite(diagTime) && diagTime >= startTime && diagTime <= replyTime;
      })
      .sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));

    const merged = [];
    for (const diag of windowEntries) {
      const text = normalizeThinkingMessage(diag);
      if (!text) {
        continue;
      }
      const previous = merged[merged.length - 1];
      if (previous && previous.kind === diag.kind && previous.text === text) {
        continue;
      }
      merged.push({
        kind: diag.kind || 'thinking',
        method: diag.method || null,
        text,
        timestamp: diag.timestamp || null,
      });
    }

    if (merged.length) {
      segments.push({
        userTimestamp: entry.timestamp || null,
        userText: entry.text || '',
        entries: merged,
      });
    }
  }

  return segments;
}

function shortId(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  return text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text;
}

function normalizeTranscriptFiles(rawFiles) {
  const files = [];
  const seen = new Set();
  for (const rawFile of Array.isArray(rawFiles) ? rawFiles : []) {
    if (!rawFile || typeof rawFile !== 'object') {
      continue;
    }
    const pathValue = String(rawFile.path || rawFile.remotePath || '').trim();
    const name = String(rawFile.name || basename(pathValue) || 'file').trim();
    if (!pathValue && !name) {
      continue;
    }
    const key = `${pathValue}|${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const mime = String(rawFile.mime || rawFile.type || '').trim();
    files.push({
      fileId: String(rawFile.fileId || rawFile.id || key),
      name,
      path: pathValue,
      size: Number(rawFile.size || 0) || 0,
      mime,
      isImage: Boolean(rawFile.isImage) || /^image\//i.test(mime) || IMAGE_FILE_EXTENSIONS.has(fileExtension(name || pathValue)),
    });
  }
  return files;
}

function dedupeTranscript(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries || []) {
    const files = normalizeTranscriptFiles(entry?.files || entry?.attachments || []);
    if (!entry || (!entry.text && !files.length)) {
      continue;
    }

    const normalized = {
      speaker: entry.speaker || 'system',
      text: String(entry.text || ''),
      timestamp: entry.timestamp || null,
      stream: entry.stream || null,
      files,
    };
    const key = `${normalized.speaker}|${normalized.timestamp || ''}|${normalized.text}|${files.map((file) => file.path || file.name).join(',')}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(-200);
}

function getRunnerSummary(session) {
  if (!session) {
    return {
      label: 'Unknown',
      warning: null,
    };
  }

  if (session.source !== 'managed') {
    return {
      label: 'Imported History',
      warning: 'This session is imported from .codex history only. It does not have a live process until you resume or fork it.',
    };
  }

  const runtimeCommand = String(session.runtime?.command || '');
  const runtimeArgs = Array.isArray(session.runtime?.args) ? session.runtime.args : [];
  const runtimeKind = String(session.runtime?.kind || '');
  const joined = [runtimeCommand, ...runtimeArgs].join(' ').toLowerCase();

  if (joined.includes('demo-session.js') || runtimeCommand.toLowerCase().includes('demo')) {
    return {
      label: 'Demo Runner',
      warning: 'This managed session is still using the local demo runner. Transport works, but agent text and action buttons are simulated rather than coming from a real Codex model.',
    };
  }

  if (runtimeKind === 'codex_app_server' || (joined.includes('codex') && joined.includes('app-server'))) {
    const strategy = session.runtime?.resumeStrategy;
    const warning = strategy === 'transcript_fallback'
      ? 'This live session had to fall back to history transcript bootstrapping because the original native Codex thread was not available.'
      : null;
    return {
      label: 'Codex App Server',
      warning,
    };
  }

  if (joined.includes('codex') && joined.includes('remote-control')) {
    return {
      label: 'Codex Remote Control',
      warning: 'This session is backed by Codex remote-control. Structured runtime events should be available, but this integration may still be incomplete.',
    };
  }

  return {
    label: runtimeCommand ? basename(runtimeCommand) : 'Managed Runner',
    warning: runtimeCommand
      ? `This session is managed by ${basename(runtimeCommand)}. Structured Codex events depend on the runner integration.`
      : 'This managed session does not expose a runtime command yet.',
  };
}

function getHost(hostId) {
  return state.hosts.find((host) => host.hostId === hostId) || null;
}

async function verifyHostAvailable(hostId) {
  const host = getHost(hostId);
  if (!host) {
    throw new Error(`Host ${hostId || '(unknown)'} is not registered.`);
  }
  if (!host.online) {
    throw new Error(`Host ${host.label || host.hostId} is offline. Start its agent or restart the HPC connector first.`);
  }

  const result = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/probe`, {
    method: 'POST',
  });
  if (!result?.ok) {
    throw new Error(result?.error || `Host ${host.label || host.hostId} did not answer the health check.`);
  }
  return result;
}

function getSessionsForHost(hostId) {
  return state.sessions.filter((session) => session.hostId === hostId);
}

function getRecentDirectories(hostId, limit = 8) {
  const seen = new Set();
  const recent = [];

  for (const session of getSessionsForHost(hostId).sort(compareSessions)) {
    const cwd = String(session.cwd || '').trim();
    if (!cwd || seen.has(cwd)) {
      continue;
    }

    seen.add(cwd);
    recent.push({
      path: cwd,
      title: session.title || pathLeaf(cwd) || cwd,
      live: Boolean(session.live),
      updatedAt: session.lastUpdatedAt || session.updatedAt || null,
    });

    if (recent.length >= limit) {
      break;
    }
  }

  return recent;
}

function getConversationGroups(hostId) {
  const groups = new Map();

  for (const session of getSessionsForHost(hostId)) {
    const conversationKey = session.conversationKey || session.originSessionId || session.sessionId;
    const group = groups.get(conversationKey) || {
      hostId,
      conversationKey,
      sessions: [],
    };

    group.sessions.push({
      ...session,
      conversationKey,
    });
    groups.set(conversationKey, group);
  }

  return Array.from(groups.values())
    .map((group) => {
      group.sessions.sort(compareSessions);
      group.totalCount = group.sessions.length;
      group.liveCount = group.sessions.filter((session) => session.live).length;
      group.preferredSession = group.sessions.find((session) => session.live) || group.sessions[0] || null;
      group.cwd = group.preferredSession?.cwd || group.sessions.find((session) => session.cwd)?.cwd || null;
      group.title = group.preferredSession?.title || group.sessions[0]?.title || group.conversationKey;
      group.lastUpdatedAt = group.sessions[0]?.lastUpdatedAt || null;
      group.latestUserMessage = firstNonEmpty(group.sessions.map((session) => session.latestUserMessage));
      group.latestAgentMessage = firstNonEmpty(group.sessions.map((session) => session.latestAgentMessage));
      return group;
    })
    .sort((a, b) => {
      const delta = parseSessionTime({ lastUpdatedAt: b.lastUpdatedAt }) - parseSessionTime({ lastUpdatedAt: a.lastUpdatedAt });
      if (delta !== 0) {
        return delta;
      }
      return String(a.title || a.conversationKey).localeCompare(String(b.title || b.conversationKey));
    });
}

function getAllConversationGroups() {
  return state.hosts.flatMap((host) => getConversationGroups(host.hostId));
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return null;
}

function getConversationSearchText(group) {
  const titleValues = [
    group.title,
    ...(group.sessions || []).map((session) => session.title),
  ];
  const pathValues = [
    group.cwd,
    ...(group.sessions || []).map((session) => session.cwd),
  ];
  if (state.sessionSearchMode === 'title') {
    return titleValues.filter(Boolean).join(' ').toLowerCase();
  }
  if (state.sessionSearchMode === 'path') {
    return pathValues.filter(Boolean).join(' ').toLowerCase();
  }

  return [
    ...titleValues,
    ...pathValues,
    group.conversationKey,
    group.latestUserMessage,
    group.latestAgentMessage,
    ...(group.sessions || []).flatMap((session) => [
      session.sessionId,
      session.nativeThreadId,
      session.bridgeSessionId,
      session.latestUserMessage,
      session.latestAgentMessage,
      ...(Array.isArray(session.transcriptPreview) ? session.transcriptPreview.map((entry) => entry.text) : []),
      ...(state.transcripts.get(makeSessionKey(session.hostId, session.sessionId)) || []).map((entry) => entry.text),
    ]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function filterConversationGroups(groups) {
  const query = String(state.sessionSearchQuery || '').trim().toLowerCase();
  if (!query) {
    return groups;
  }

  const terms = query.split(/\s+/).filter(Boolean);
  return groups.filter((group) => {
    const haystack = getConversationSearchText(group);
    return terms.every((term) => haystack.includes(term));
    });
}

function getSelectedCollection() {
  return state.sessionCollections.find((collection) => collection.collectionId === state.selectedCollectionId)
    || state.sessionCollections[0]
    || { collectionId: 'default', name: 'Default', system: true, items: [] };
}

function getConversationGroupsForCollection(collection = getSelectedCollection()) {
  if (!collection || collection.collectionId === 'default') {
    return state.selectedHostId ? getConversationGroups(state.selectedHostId) : [];
  }

  const allGroups = getAllConversationGroups();
  const groupMap = new Map(allGroups.map((group) => [`${group.hostId}::${group.conversationKey}`, group]));
  return (collection.items || [])
    .map((item) => {
      const key = `${item.hostId}::${item.conversationKey}`;
      const group = groupMap.get(key) || findCollectionConversationGroup(allGroups, item);
      if (group) {
        return {
          ...group,
          collectionItem: item,
        };
      }

      return {
        hostId: item.hostId,
        hostLabel: item.hostLabel,
        conversationKey: item.conversationKey,
        sessions: [],
        totalCount: item.sessionId ? 1 : 0,
        liveCount: 0,
        preferredSession: null,
        cwd: item.cwd || null,
        title: item.title || item.conversationKey,
        lastUpdatedAt: item.updatedAt || item.addedAt || null,
        latestUserMessage: null,
        latestAgentMessage: null,
        collectionOnly: true,
        collectionItem: item,
      };
    })
    .sort((a, b) => {
      const delta = parseSessionTime({ lastUpdatedAt: b.lastUpdatedAt }) - parseSessionTime({ lastUpdatedAt: a.lastUpdatedAt });
      if (delta !== 0) {
        return delta;
      }
      return String(a.title || a.conversationKey).localeCompare(String(b.title || b.conversationKey));
    });
}

function findCollectionConversationGroup(groups, item) {
  if (!item || !item.hostId) {
    return null;
  }

  const candidates = groups.filter((group) => group.hostId === item.hostId);
  const identities = [
    item.conversationKey,
    item.sessionId,
  ].filter(Boolean).map(String);

  if (identities.length) {
    const exact = candidates.find((group) => {
      const values = getConversationIdentityValues(group);
      return identities.some((identity) => values.has(identity));
    });
    if (exact) {
      return exact;
    }
  }

  const itemPath = normalizeConversationPath(item.cwd);
  if (!itemPath) {
    return null;
  }

  const itemTitle = normalizeConversationTitle(item.title);
  return candidates.find((group) => {
    if (normalizeConversationPath(group.cwd) !== itemPath) {
      return false;
    }
    if (!itemTitle) {
      return true;
    }
    const groupTitles = [
      group.title,
      ...(group.sessions || []).map((session) => session.title),
    ].map(normalizeConversationTitle).filter(Boolean);
    return groupTitles.includes(itemTitle);
  }) || candidates.find((group) => normalizeConversationPath(group.cwd) === itemPath) || null;
}

function getConversationIdentityValues(group) {
  const values = new Set();
  const add = (value) => {
    if (value) {
      values.add(String(value));
    }
  };

  add(group.conversationKey);
  for (const session of group.sessions || []) {
    add(session.sessionId);
    add(session.conversationKey);
    add(session.originSessionId);
    add(session.sourceSessionId);
    add(session.bridgeSessionId);
    add(session.nativeThreadId);
  }
  return values;
}

function normalizeConversationPath(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function normalizeConversationTitle(value) {
  return String(value || '').trim().toLowerCase();
}

function getHostSnapshotForCollection(hostId) {
  const host = getHost(hostId) || {};
  const connector = state.connectors.find((item) => item.hostId === hostId) || null;
  return {
    hostLabel: host.label || hostId,
    hostPlatform: host.platform || '',
    targetHost: connector?.targetHost || '',
    targetPort: connector?.targetPort || null,
    connectorId: connector?.connectorId || '',
    connectorLabel: connector?.label || '',
    relayUrl: connector?.relayUrl || '',
  };
}

function buildCollectionItemFromConversation(group) {
  const session = group.preferredSession || group.sessions?.[0] || null;
  return {
    hostId: group.hostId,
    conversationKey: group.conversationKey,
    sessionId: session?.sessionId || group.collectionItem?.sessionId || '',
    title: group.title || session?.title || group.conversationKey,
    cwd: group.cwd || session?.cwd || '',
    ...getHostSnapshotForCollection(group.hostId),
  };
}

async function refreshSessionCollections() {
  const response = await fetchJson('/api/session-collections');
  state.sessionCollections = response.collections || [];
  if (!state.sessionCollections.some((collection) => collection.collectionId === state.selectedCollectionId)) {
    state.selectedCollectionId = state.sessionCollections[0]?.collectionId || 'default';
  }
}

async function createSessionCollection(name) {
  const response = await fetchJson('/api/session-collections', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  await refreshSessionCollections();
  state.selectedCollectionId = response.collection?.collectionId || state.selectedCollectionId;
  renderAll();
}

async function addConversationToCollection(collectionId, group) {
  if (!collectionId || collectionId === 'default') {
    return;
  }
  await fetchJson(`/api/session-collections/${encodeURIComponent(collectionId)}/items`, {
    method: 'POST',
    body: JSON.stringify({ item: buildCollectionItemFromConversation(group) }),
  });
  await refreshSessionCollections();
  renderAll();
}

async function removeConversationFromCollection(collectionId, group) {
  if (!collectionId || collectionId === 'default') {
    return;
  }
  await fetchJson(`/api/session-collections/${encodeURIComponent(collectionId)}/items/remove`, {
    method: 'POST',
    body: JSON.stringify({ item: buildCollectionItemFromConversation(group) }),
  });
  await refreshSessionCollections();
  renderAll();
}

function getLiveSessionForConversation(conversation) {
  return conversation?.sessions.find((session) => session.live) || null;
}

function getSelectedConversation() {
  if (!state.selectedHostId || !state.selectedConversationKey) {
    return null;
  }

  return getConversationGroups(state.selectedHostId)
    .find((group) => group.conversationKey === state.selectedConversationKey) || null;
}

function getSelectedSession() {
  const conversation = getSelectedConversation();
  if (!conversation) {
    return null;
  }

  return conversation.sessions.find((session) => session.sessionId === state.selectedSessionId)
    || conversation.preferredSession
    || null;
}

function ensureSelections() {
  if (!state.selectedHostId || !getHost(state.selectedHostId)) {
    const fallbackHost = state.hosts.find((host) => host.online) || state.hosts[0] || null;
    state.selectedHostId = fallbackHost?.hostId || null;
  }

  if (!state.selectedHostId) {
    state.selectedConversationKey = null;
    state.selectedSessionId = null;
    return;
  }

  const groups = getConversationGroups(state.selectedHostId);
  if (!groups.length) {
    state.selectedConversationKey = null;
    state.selectedSessionId = null;
    return;
  }

  let conversation = groups.find((group) => group.conversationKey === state.selectedConversationKey) || null;
  if (!conversation) {
    conversation = groups[0];
    state.selectedConversationKey = conversation.conversationKey;
  }

  const session = conversation.sessions.find((item) => item.sessionId === state.selectedSessionId) || conversation.preferredSession;
  state.selectedSessionId = session?.sessionId || null;
}

function mergeSession(session) {
  if (!session || !session.hostId || !session.sessionId) {
    return null;
  }

  const key = makeSessionKey(session.hostId, session.sessionId);
  const index = state.sessions.findIndex((item) => makeSessionKey(item.hostId, item.sessionId) === key);
  if (index === -1) {
    state.sessions.push(session);
    return session;
  }

  state.sessions[index] = {
    ...state.sessions[index],
    ...session,
  };
  return state.sessions[index];
}

function setTranscriptForSession(hostId, sessionId, transcript) {
  const key = makeSessionKey(hostId, sessionId);
  state.transcripts.set(key, dedupeTranscript(transcript));
}

function appendTranscriptEntry(hostId, sessionId, entry) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.transcripts.get(key) || [];
  state.transcripts.set(key, dedupeTranscript([...existing, entry]));
}

function dedupeAlerts(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries || []) {
    if (!entry || !entry.message) {
      continue;
    }

    const normalized = {
      timestamp: entry.timestamp || null,
      severity: entry.severity || 'warning',
      source: entry.source || 'runtime',
      message: String(entry.message || ''),
      sessionId: entry.sessionId || null,
      hostId: entry.hostId || null,
    };
    const key = `${normalized.severity}|${normalized.timestamp || ''}|${normalized.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(-100);
}

function setAlertsForSession(hostId, sessionId, alerts) {
  const key = makeSessionKey(hostId, sessionId);
  state.alerts.set(key, dedupeAlerts(alerts));
}

function appendAlertForSession(hostId, sessionId, alert) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.alerts.get(key) || [];
  state.alerts.set(key, dedupeAlerts([...existing, alert]));
}

function shouldDisplayAlert(entry) {
  const message = String(entry?.message || '');
  return !(
    /codex_app_server: failed to initialize sqlite state db/i.test(message)
    || /Codex could not find bubblewrap on PATH/i.test(message)
    || /sandbox prerequisites/i.test(message)
    || /concepts\/sandboxing#prerequisites/i.test(message)
  );
}

function isStaleStartupFailureAlert(entry, session) {
  if (!session?.live) {
    return false;
  }

  const message = String(entry?.message || '');
  if (!/runner: no pipe-in provided|codex app-server exited early|failed to spawn managed session|failed:spawn-error|exited:1:null/i.test(message)) {
    return false;
  }

  const runtime = getRuntimeForSession(session) || session.runtime || null;
  const recoveredAt = Date.parse(runtime?.updatedAt || session.lastUpdatedAt || '');
  const alertAt = Date.parse(entry?.timestamp || '');
  return !Number.isFinite(recoveredAt) || !Number.isFinite(alertAt) || alertAt < recoveredAt;
}

function getAlertsForSession(session) {
  const key = getSessionKey(session);
  return key
    ? (state.alerts.get(key) || [])
      .filter(shouldDisplayAlert)
      .filter((entry) => !isStaleStartupFailureAlert(entry, session))
    : [];
}

function getTranscriptForSession(session) {
  const key = getSessionKey(session);
  return key ? state.transcripts.get(key) || [] : [];
}

function setRuntimeForSession(hostId, sessionId, runtime) {
  const key = makeSessionKey(hostId, sessionId);
  if (!runtime || typeof runtime !== 'object') {
    state.runtime.delete(key);
    return;
  }

  const previous = state.runtime.get(key) || {};
  const updatedAt = runtime.updatedAt || new Date().toISOString();
  const next = {
    ...previous,
    ...runtime,
    updatedAt,
  };

  if (Object.prototype.hasOwnProperty.call(runtime, 'phase')) {
    next.phaseStartedAt = runtime.phase !== previous.phase
      ? updatedAt
      : previous.phaseStartedAt || updatedAt;
  } else {
    next.phaseStartedAt = previous.phaseStartedAt || (next.phase ? updatedAt : null);
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'busy')) {
    next.busyStartedAt = runtime.busy
      ? (previous.busy ? previous.busyStartedAt || updatedAt : updatedAt)
      : null;
  } else {
    next.busyStartedAt = previous.busyStartedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'activeTurnId')) {
    next.turnStartedAt = runtime.activeTurnId
      ? (runtime.activeTurnId !== previous.activeTurnId ? updatedAt : previous.turnStartedAt || updatedAt)
      : null;
  } else {
    next.turnStartedAt = previous.turnStartedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'connection')) {
    next.runtimeConnectionStartedAt = runtime.connection !== previous.connection
      ? updatedAt
      : previous.runtimeConnectionStartedAt || updatedAt;
  } else {
    next.runtimeConnectionStartedAt = previous.runtimeConnectionStartedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'reasoningSummary') && runtime.reasoningSummary) {
    next.reasoningUpdatedAt = updatedAt;
  } else {
    next.reasoningUpdatedAt = previous.reasoningUpdatedAt || null;
  }

  if (Object.prototype.hasOwnProperty.call(runtime, 'planSummary') && runtime.planSummary) {
    next.planUpdatedAt = updatedAt;
  } else {
    next.planUpdatedAt = previous.planUpdatedAt || null;
  }

  state.runtime.set(key, next);
}

function patchRuntimeForSession(hostId, sessionId, patch) {
  setRuntimeForSession(hostId, sessionId, patch);
}

function getRuntimeForSession(session) {
  const key = getSessionKey(session);
  return key ? state.runtime.get(key) || null : null;
}

function dedupeDiagnostics(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries || []) {
    if (!entry) {
      continue;
    }

    const normalized = {
      timestamp: entry.timestamp || null,
      severity: entry.severity || 'info',
      source: entry.source || 'codex',
      kind: entry.kind || 'event',
      method: entry.method || null,
      message: String(entry.message || ''),
      detail: entry.detail || null,
      data: entry.data || null,
      turnId: entry.turnId || entry.data?.turnId || null,
    };
    const key = `${normalized.timestamp || ''}|${normalized.kind}|${normalized.method || ''}|${normalized.message}|${normalized.detail || ''}|${normalized.turnId || ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }

  return deduped.slice(-200);
}

function setDiagnosticsForSession(hostId, sessionId, diagnostics) {
  const key = makeSessionKey(hostId, sessionId);
  state.diagnostics.set(key, dedupeDiagnostics(diagnostics));
}

function appendDiagnosticForSession(hostId, sessionId, entry) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.diagnostics.get(key) || [];
  state.diagnostics.set(key, dedupeDiagnostics([...existing, entry]));
}

function getDiagnosticsForSession(session) {
  const key = getSessionKey(session);
  return key ? state.diagnostics.get(key) || [] : [];
}

function setRequestsForSession(hostId, sessionId, requests) {
  const key = makeSessionKey(hostId, sessionId);
  const normalized = Array.isArray(requests) ? requests.slice(-40) : [];
  state.requests.set(key, normalized);
}

function upsertRequestForSession(hostId, sessionId, request) {
  const key = makeSessionKey(hostId, sessionId);
  const existing = state.requests.get(key) || [];
  const requestId = String(request.requestId || '');
  const index = existing.findIndex((item) => String(item.requestId || '') === requestId);
  const next = {
    ...request,
    requestId,
  };
  if (index === -1) {
    existing.push(next);
  } else {
    existing[index] = {
      ...existing[index],
      ...next,
    };
  }
  state.requests.set(key, existing.slice(-40));
}

function resolveRequestForSession(hostId, sessionId, request) {
  upsertRequestForSession(hostId, sessionId, request);
}

function getRequestsForSession(session) {
  const key = getSessionKey(session);
  return key ? state.requests.get(key) || [] : [];
}

function setReceivedFilesForSession(hostId, sessionId, files) {
  const key = makeSessionKey(hostId, sessionId);
  state.receivedFiles.set(key, Array.isArray(files) ? files : []);
}

function getReceivedFilesForSession(session) {
  const key = getSessionKey(session);
  return key ? state.receivedFiles.get(key) || [] : [];
}

function isReceivedFilesLoading(session) {
  const key = getSessionKey(session);
  return key ? state.receivedFilesLoadingKeys.has(key) : false;
}

function setStreamStatusForSession(hostId, sessionId, patch) {
  const key = makeSessionKey(hostId, sessionId);
  const previous = state.streamStatus.get(key) || {};
  const changedAt = patch?.changedAt || new Date().toISOString();
  const next = {
    ...previous,
    ...patch,
  };

  if (Object.prototype.hasOwnProperty.call(patch || {}, 'connection')) {
    next.connectionChangedAt = patch.connection !== previous.connection
      ? changedAt
      : previous.connectionChangedAt || changedAt;
  }

  if (patch?.lastPingAt) {
    next.lastEventAt = patch.lastPingAt;
  }

  state.streamStatus.set(key, next);
}

function getStreamStatusForSession(session) {
  const key = getSessionKey(session);
  return key ? state.streamStatus.get(key) || null : null;
}

function getConnector(connectorId) {
  return state.connectors.find((connector) => connector.connectorId === connectorId) || null;
}

function normalizeMatchText(value) {
  return String(value || '').trim().toLowerCase();
}

function getConnectorForHost(hostId) {
  const host = getHost(hostId);
  return state.connectors.find((connector) => connector.hostId === hostId || connector.runtime?.attachedHostId === hostId)
    || state.connectors.find((connector) => {
      if (!host) {
        return false;
      }
      return normalizeMatchText(connector.label) === normalizeMatchText(host.label);
    })
    || null;
}

function syncModalBodyState() {
  const open = Boolean(state.connectorManagerOpen || state.directoryPicker.open || state.statusWindowOpen);
  document.body.classList.toggle('modal-open', open);
}

function buildConnectorDraft() {
  return {
    connectorId: '',
    label: '',
    kind: 'outbound_agent',
    hostId: '',
    relayUrl: window.location.origin,
    targetHost: '',
    targetPort: 22,
    username: '',
    codexHome: '~/.codex',
    workspaceRoots: [],
    notes: '',
    gateway: {
      enabled: false,
      host: '',
      port: 22,
      username: '',
      proxyJump: '',
      authMethod: 'ssh_key',
      otpSource: '',
    },
    auth: {
      method: 'ssh_key',
      keyPath: '',
      agentForwarding: true,
      rememberDevice: false,
      otpSource: '',
    },
    bootstrap: {
      mode: 'manual_tmux',
      remoteDirectory: '~/mobile-codex-remote',
      tmuxSession: 'codex-remote',
      serviceName: 'codex-remote',
      launchCommand: '',
    },
    plan: {
      summary: 'Create a saved HPC connector profile for gateway, bootstrap, and MFA policy.',
      warnings: [],
      recommendations: [],
      bootstrapCommand: '',
    },
    runtime: {
      phase: 'saved',
      phaseLabel: 'Draft',
      interactiveAuth: false,
      attachedHostOnline: false,
    },
    secretStatus: {
      hasGatewayPassword: false,
      hasTargetPassword: false,
    },
  };
}

function renderOverview() {
  const overviewStats = el('overview-stats');
  overviewStats.innerHTML = '';

  const summary = state.stats?.summary || {
    totalHosts: 0,
    onlineHosts: 0,
    totalSessions: 0,
    liveSessions: 0,
  };

  const cards = [
    ['Hosts', summary.totalHosts],
    ['Online', summary.onlineHosts],
    ['Sessions', summary.totalSessions],
    ['Live', summary.liveSessions],
  ];

  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'mini-stat';
    card.innerHTML = `
      <div class="muted">${label}</div>
      <div class="value">${value}</div>
    `;
    overviewStats.appendChild(card);
  }

  const connectorSummary = el('connector-summary');
  if (connectorSummary) {
    const gatewayCount = state.connectors.filter((connector) => connector.runtime?.usesGateway).length;
    const interactiveCount = state.connectors.filter((connector) => connector.runtime?.interactiveAuth).length;
    const attachedCount = state.connectors.filter((connector) => connector.runtime?.attachedHostOnline).length;
    connectorSummary.textContent = state.connectors.length
      ? `${state.connectors.length} saved | ${gatewayCount} via gateway | ${interactiveCount} with MFA/manual auth | ${attachedCount} attached`
      : 'No HPC connector profiles saved yet.';
  }

  const dismissed = el('dismissed-hosts');
  dismissed.innerHTML = '';
  if (state.dismissedHosts.length > 0) {
    const box = document.createElement('div');
    box.className = 'dismissed-list';
    box.textContent = `Removed hosts: ${state.dismissedHosts.join(', ')}`;
    dismissed.appendChild(box);
  }
}

function setConnectorManagerOpen(open) {
  state.connectorManagerOpen = Boolean(open);
  renderConnectorManager();
}

function openConnectorManager(connectorId = null) {
  state.connectorEditorId = connectorId || state.connectorEditorId || state.connectors[0]?.connectorId || null;
  setConnectorManagerOpen(true);
}

function closeConnectorManager() {
  state.connectorManagerOpen = false;
  renderConnectorManager();
}

function populateConnectorForm(connector) {
  const draft = connector || buildConnectorDraft();
  el('connector-id').value = draft.connectorId || '';
  el('connector-label').value = draft.label || '';
  el('connector-kind').value = draft.kind || 'outbound_agent';
  el('connector-host-id').value = draft.hostId || '';
  el('connector-relay-url').value = draft.relayUrl || '';
  el('connector-target-host').value = draft.targetHost || '';
  el('connector-target-port').value = String(draft.targetPort || 22);
  el('connector-username').value = draft.username || '';
  el('connector-codex-home').value = draft.codexHome || '~/.codex';
  el('connector-workspace-roots').value = Array.isArray(draft.workspaceRoots) ? draft.workspaceRoots.join('\n') : '';
  el('connector-notes').value = draft.notes || '';
  el('connector-gateway-enabled').value = draft.gateway?.enabled ? 'true' : 'false';
  el('connector-gateway-host').value = draft.gateway?.host || '';
  el('connector-gateway-port').value = String(draft.gateway?.port || 22);
  el('connector-gateway-username').value = draft.gateway?.username || '';
  el('connector-proxy-jump').value = draft.gateway?.proxyJump || '';
  el('connector-gateway-auth-method').value = draft.gateway?.authMethod || 'ssh_key';
  el('connector-gateway-password').value = '';
  el('connector-gateway-password').placeholder = draft.secretStatus?.hasGatewayPassword
    ? 'Gateway password saved locally; leave blank to keep it'
    : 'Gateway password, saved locally only';
  el('connector-gateway-otp-source').value = draft.gateway?.otpSource || '';
  el('connector-auth-method').value = draft.auth?.method || 'ssh_key';
  el('connector-auth-key-path').value = draft.auth?.keyPath || '';
  el('connector-auth-password').value = '';
  el('connector-auth-password').placeholder = draft.secretStatus?.hasTargetPassword
    ? 'Target password saved locally; leave blank to keep it'
    : 'Target password, saved locally only';
  el('connector-auth-agent-forwarding').value = draft.auth?.agentForwarding ? 'true' : 'false';
  el('connector-auth-remember-device').value = draft.auth?.rememberDevice ? 'true' : 'false';
  el('connector-auth-otp-source').value = draft.auth?.otpSource || '';
  el('connector-bootstrap-mode').value = draft.bootstrap?.mode || 'manual_tmux';
  el('connector-bootstrap-remote-directory').value = draft.bootstrap?.remoteDirectory || '~/mobile-codex-remote';
  el('connector-bootstrap-tmux-session').value = draft.bootstrap?.tmuxSession || 'codex-remote';
  el('connector-bootstrap-service-name').value = draft.bootstrap?.serviceName || 'codex-remote';
  el('connector-bootstrap-launch-command').value = draft.bootstrap?.launchCommand || '';
  el('connector-editor-title').textContent = connector ? connector.label || connector.connectorId : 'New connector';
  el('connector-editor-subtitle').textContent = connector
    ? 'Edit the saved HPC connection recipe. Secrets stay out of the relay.'
    : 'Create a saved HPC connection recipe. Secrets stay out of the relay.';
  const deleteButton = el('delete-connector-button');
  deleteButton.classList.toggle('hidden', !connector?.connectorId);
}

function readConnectorForm() {
  return {
    connectorId: el('connector-id').value.trim(),
    label: el('connector-label').value.trim(),
    kind: el('connector-kind').value,
    hostId: el('connector-host-id').value.trim(),
    relayUrl: el('connector-relay-url').value.trim(),
    targetHost: el('connector-target-host').value.trim(),
    targetPort: Number(el('connector-target-port').value || '22'),
    username: el('connector-username').value.trim(),
    codexHome: el('connector-codex-home').value.trim(),
    workspaceRoots: el('connector-workspace-roots').value.trim().split(/\n+/).map((item) => item.trim()).filter(Boolean),
    notes: el('connector-notes').value.trim(),
    gateway: {
      enabled: el('connector-gateway-enabled').value === 'true',
      host: el('connector-gateway-host').value.trim(),
      port: Number(el('connector-gateway-port').value || '22'),
      username: el('connector-gateway-username').value.trim(),
      proxyJump: el('connector-proxy-jump').value.trim(),
      authMethod: el('connector-gateway-auth-method').value,
      otpSource: el('connector-gateway-otp-source').value.trim(),
    },
    auth: {
      method: el('connector-auth-method').value,
      keyPath: el('connector-auth-key-path').value.trim(),
      agentForwarding: el('connector-auth-agent-forwarding').value === 'true',
      rememberDevice: el('connector-auth-remember-device').value === 'true',
      otpSource: el('connector-auth-otp-source').value.trim(),
    },
    secrets: {
      gatewayPassword: el('connector-gateway-password').value,
      targetPassword: el('connector-auth-password').value,
    },
    bootstrap: {
      mode: el('connector-bootstrap-mode').value,
      remoteDirectory: el('connector-bootstrap-remote-directory').value.trim(),
      tmuxSession: el('connector-bootstrap-tmux-session').value.trim(),
      serviceName: el('connector-bootstrap-service-name').value.trim(),
      launchCommand: el('connector-bootstrap-launch-command').value.trim(),
    },
  };
}

function renderConnectorRunbookList(container, entries, emptyText) {
  container.innerHTML = '';
  const items = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'connector-runbook-item';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  for (const entry of items) {
    const item = document.createElement('div');
    item.className = 'connector-runbook-item';
    item.textContent = entry;
    container.appendChild(item);
  }
}

function renderConnectorRunbook(connector) {
  const command = connector?.plan?.bootstrapCommand || '';
  const smokeCommand = connector?.plan?.sshSmokeTestCommand || '';
  const loginCommand = connector?.plan?.sshLoginCommand || '';
  const summary = connector?.plan?.summary || 'Save a connector to generate its tmux command.';
  const copyButton = el('copy-connector-command-button');
  const copyLoginButton = el('copy-connector-login-button');
  const copySmokeButton = el('copy-connector-smoke-button');
  const runSmokeButton = el('run-connector-smoke-button');
  const runStatusButton = el('run-connector-status-button');
  const runBootstrapButton = el('run-connector-bootstrap-button');
  const runRestartButton = el('run-connector-restart-button');
  const actionResult = el('connector-action-result');
  const actionKey = connector?.connectorId || '';
  const busyAction = state.connectorActionBusy?.connectorId === actionKey
    ? state.connectorActionBusy.action
    : null;
  const actionBusy = Boolean(busyAction);
  const result = actionKey ? state.connectorActionResults.get(actionKey) : null;
  el('connector-runbook-summary').textContent = summary;
  el('connector-login-command').textContent = loginCommand || '(no login command yet)';
  el('connector-smoke-command').textContent = smokeCommand || '(no smoke test yet)';
  el('connector-bootstrap-command').textContent = command || '(no command yet)';
  copyButton.disabled = !command;
  copyLoginButton.disabled = !loginCommand;
  copySmokeButton.disabled = !smokeCommand;
  runSmokeButton.disabled = !connector || actionBusy;
  runStatusButton.disabled = !connector || actionBusy;
  runBootstrapButton.disabled = !connector || actionBusy;
  runRestartButton.disabled = !connector || actionBusy;
  runSmokeButton.textContent = busyAction === 'smoke_test' ? 'Running...' : 'Run Test';
  runStatusButton.textContent = busyAction === 'status' ? 'Checking...' : 'Check Status';
  runBootstrapButton.textContent = busyAction === 'bootstrap' ? 'Starting...' : 'Start Agent';
  runRestartButton.textContent = busyAction === 'restart' ? 'Restarting...' : 'Restart Agent';
  renderConnectorActionResult(actionResult, result, actionBusy);
  renderConnectorRunbookList(el('connector-plan-steps'), connector?.plan?.steps || [], 'No bootstrap steps yet.');
  renderConnectorRunbookList(el('connector-plan-warnings'), connector?.plan?.warnings || [], 'No MFA or auth warnings.');
}

function renderConnectorActionResult(container, result, busy) {
  if (!result && !busy) {
    container.className = 'connector-action-result hidden';
    container.textContent = '';
    return;
  }

  container.className = `connector-action-result ${result?.ok ? 'success' : result ? 'failure' : ''}`.trim();
  const lines = [];
  if (busy) {
    lines.push('Running remote connector action...');
  }
  if (result) {
    lines.push(`${prettyStatusLabel(result.status || result.action || 'Result')}: ${result.message || ''}`.trim());
    if (result.expectedHostId) {
      lines.push(`Expected host: ${result.expectedHostId}`);
    }
    if (result.multiplexFallback) {
      lines.push(`SSH multiplex fallback: ${result.multiplexFallback.reason || 'ControlMaster failed; retried without multiplexing.'}`);
      if (result.multiplexFallback.controlPath) {
        lines.push(`ControlPath: ${result.multiplexFallback.controlPath}`);
      }
    }
    if (typeof result.exitCode !== 'undefined' && result.exitCode !== null) {
      lines.push(`Exit code: ${result.exitCode}`);
    }
    if (result.deploy) {
      lines.push(`deploy: ${prettyStatusLabel(result.deploy.status || 'deploy')} - ${result.deploy.message || ''}`.trim());
      for (const step of result.deploy.steps || []) {
        const stepLines = [`${step.name || 'step'} exit ${step.exitCode}`];
        if (step.stdout) {
          stepLines.push(`stdout:\n${step.stdout}`);
        }
        if (step.stderr) {
          stepLines.push(`stderr:\n${step.stderr}`);
        }
        lines.push(stepLines.join('\n'));
      }
    }
    if (result.stdout) {
      lines.push(`stdout:\n${result.stdout}`);
    }
    if (result.stderr) {
      lines.push(`stderr:\n${result.stderr}`);
    }
    if (result.command && result.status === 'manual_required') {
      lines.push(`manual login:\n${result.command}`);
    }
    if (result.bootstrapCommand && result.status === 'manual_required') {
      lines.push(`manual bootstrap:\n${result.bootstrapCommand}`);
    }
  }

  container.innerHTML = `<pre>${escapeHtml(lines.join('\n\n'))}</pre>`;
}

function renderConnectorManager() {
  const list = el('connector-list');
  const editor = el('connector-editor');
  const overlay = el('connector-manager-overlay');
  const hostMap = new Map(state.hosts.map((host) => [host.hostId, host]));
  list.innerHTML = '';

  if (!state.connectorManagerOpen) {
    overlay.classList.add('hidden');
    editor.classList.add('hidden');
    syncModalBodyState();
    return;
  }

  overlay.classList.remove('hidden');
  editor.classList.remove('hidden');
  syncModalBodyState();

  if (!state.connectors.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No saved connectors yet. Add one for HPC, gateway, or passwordless bootstrap.';
    list.appendChild(empty);
  } else {
    for (const connector of state.connectors) {
      const host = connector.hostId ? hostMap.get(connector.hostId) || null : null;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `connector-card ${connector.connectorId === state.connectorEditorId ? 'active' : ''}`;
      const secretSummary = [
        connector.secretStatus?.hasGatewayPassword ? 'gateway password saved' : '',
        connector.secretStatus?.hasTargetPassword ? 'target password saved' : '',
      ].filter(Boolean).join(' | ') || 'no saved password';
      item.innerHTML = `
        <div class="connector-card-top">
          <div>
            <div class="title">${connector.label}</div>
            <div class="sub">${connectorKindLabel(connector.kind)} | ${connector.authLabel} | ${connector.runtime?.phaseLabel || 'Saved'}</div>
          </div>
          <div class="connector-badge">${connector.runtime?.attachedHostOnline ? 'Live' : 'Saved'}</div>
        </div>
        <div class="connector-meta">${connector.hostId || connector.targetHost || '(unbound target)'}</div>
        <div class="connector-meta">${connector.gatewaySummary} | Gateway ${connector.gatewayAuthLabel || 'Auth'} | Target ${connector.authLabel}</div>
        <div class="connector-meta">${secretSummary}</div>
        <div class="connector-plan">${connector.plan?.summary || 'Saved connector recipe.'}</div>
        <div class="connector-plan">${host ? `Attached host: ${host.label} | ${host.online ? 'online' : 'offline'}` : 'No attached host yet.'}</div>
      `;
      item.onclick = () => {
        state.connectorEditorId = connector.connectorId;
        populateConnectorForm(connector);
        renderConnectorManager();
      };
      list.appendChild(item);
    }
  }

  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  populateConnectorForm(connector || buildConnectorDraft());
  renderConnectorRunbook(connector);
}

function createActionButton(label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-button ${className}`;
  button.textContent = label;
  return button;
}

function renderHostNav() {
  const hostList = el('host-overview-list');
  hostList.innerHTML = '';

  for (const host of state.hosts) {
    const item = document.createElement('div');
    item.className = `host-card ${host.hostId === state.selectedHostId ? 'active' : ''}`;

    const top = document.createElement('div');
    top.className = 'host-card-top';
    top.innerHTML = `
      <div>
        <div class="title">${host.label}</div>
        <div class="sub">${host.platform} | ${host.online ? 'online' : 'offline'} | ${host.sessionCount || 0} dialogs</div>
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'host-actions';

    const switchButton = createActionButton('Switch', 'secondary-button');
    switchButton.disabled = state.hostSwitchBusyId === host.hostId;
    switchButton.textContent = state.hostSwitchBusyId === host.hostId ? 'Checking...' : 'Switch';
    switchButton.onclick = async (event) => {
      event.stopPropagation();
      try {
        await setSelectedHost(host.hostId);
      } catch (error) {
        reportError(error);
      }
    };

    const importButton = createActionButton('Import', 'secondary-button');
    importButton.onclick = async (event) => {
      event.stopPropagation();
      await importHost(host.hostId);
    };

    const deleteButton = createActionButton('Delete', 'danger-button');
    deleteButton.onclick = async (event) => {
      event.stopPropagation();
      await deleteHost(host.hostId);
    };

    actions.append(switchButton, importButton, deleteButton);
    item.append(top, actions);
    item.onclick = () => {
      setSelectedHost(host.hostId).catch(reportError);
    };
    hostList.appendChild(item);
  }
}

function renderHostSwitcher() {
  const switcher = el('host-switcher');
  const selectedHostId = state.selectedHostId || '';
  switcher.innerHTML = '';

  if (!state.hosts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No hosts available';
    switcher.appendChild(option);
    switcher.disabled = true;
    return;
  }

  for (const host of state.hosts) {
    const option = document.createElement('option');
    option.value = host.hostId;
    option.textContent = `${host.label} (${host.online ? 'online' : 'offline'})`;
    switcher.appendChild(option);
  }

  switcher.disabled = Boolean(state.hostSwitchBusyId);
  switcher.value = selectedHostId;
}

function getVariantLabels(sessions) {
  const labels = new Map();
  const counters = {
    live: 0,
    resumeLive: 0,
    forkLive: 0,
    managed: 0,
    resumed: 0,
    fork: 0,
    starting: 0,
  };

  function nextLabel(key, single, multiPrefix) {
    counters[key] += 1;
    return counters[key] === 1 ? single : `${multiPrefix} ${counters[key]}`;
  }

  let liveIndex = 0;

  for (const session of sessions) {
    if (session.source !== 'managed') {
      labels.set(session.sessionId, 'History');
      continue;
    }

    if (session.state === 'starting') {
      labels.set(session.sessionId, nextLabel('starting', 'Starting', 'Starting'));
      continue;
    }

    if (session.launchMode === 'resume') {
      labels.set(
        session.sessionId,
        session.live
          ? nextLabel('resumeLive', 'Resumed Live', 'Resumed Live')
          : nextLabel('resumed', 'Resumed', 'Resumed')
      );
      continue;
    }

    if (session.launchMode === 'fork') {
      labels.set(
        session.sessionId,
        session.live
          ? nextLabel('forkLive', 'Fork Live', 'Fork Live')
          : nextLabel('fork', 'Fork', 'Fork')
      );
      continue;
    }

    if (session.live) {
      liveIndex += 1;
      labels.set(session.sessionId, liveIndex === 1 ? 'Live' : `Live ${liveIndex}`);
      continue;
    }

    labels.set(session.sessionId, nextLabel('managed', 'Managed', 'Managed'));
  }

  return labels;
}

function renderVariantButtons(container, conversation, selectedSessionId) {
  container.innerHTML = '';

  if (!conversation || !conversation.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No variants are available for this conversation yet.';
    container.appendChild(empty);
    return;
  }

  const labels = getVariantLabels(conversation.sessions);
  for (const session of conversation.sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `variant-chip ${session.live ? 'live' : 'history'} ${session.sessionId === selectedSessionId ? 'active' : ''}`.trim();
    button.textContent = labels.get(session.sessionId) || 'Session';
    button.title = `${session.title || session.sessionId}\n${session.sessionId}`;
    button.onclick = (event) => {
      event.stopPropagation();
      selectSession(session).catch(reportError);
    };
    container.appendChild(button);
  }
}

function renderCollectionTabs() {
  const container = el('session-collection-tabs');
  if (!container) {
    return;
  }
  container.innerHTML = '';

  for (const collection of state.sessionCollections) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `collection-tab secondary-button ${collection.collectionId === state.selectedCollectionId ? 'active' : ''}`.trim();
    button.innerHTML = `
      <span>${escapeHtml(collection.name || 'Collection')}</span>
      <span class="collection-count">${collection.itemCount || 0}</span>
    `;
    button.onclick = () => {
      state.selectedCollectionId = collection.collectionId;
      renderAll();
    };
    container.appendChild(button);
  }
}

function renderConversationNav() {
  const list = el('session-list');
  list.innerHTML = '';

  const host = getHost(state.selectedHostId);
  el('selected-host-title').textContent = host ? host.label : 'No host selected';
  el('selected-host-meta').textContent = host ? `${host.platform} | ${host.online ? 'online' : 'offline'}` : '';
  renderHostSwitcher();
  renderCollectionTabs();

  const collection = getSelectedCollection();
  const groups = getConversationGroupsForCollection(collection);
  const visibleGroups = filterConversationGroups(groups);
  const searchInput = el('session-search-input');
  const searchMode = el('session-search-mode');
  const searchSummary = el('session-search-summary');
  if (searchInput && document.activeElement !== searchInput) {
    searchInput.value = state.sessionSearchQuery;
  }
  if (searchMode) {
    searchMode.value = state.sessionSearchMode;
  }
  if (searchSummary) {
    const query = state.sessionSearchQuery.trim();
    const scope = collection.collectionId === 'default'
      ? `Default on ${host?.label || 'selected host'}`
      : collection.name;
    searchSummary.textContent = query
      ? `${visibleGroups.length} of ${groups.length} in ${scope} match "${query}"`
      : groups.length
        ? `${groups.length} conversations in ${scope}`
        : '';
  }

  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = collection.collectionId === 'default'
      ? 'Import a host or start a managed session to see conversations here.'
      : 'This collection is empty. Save a conversation into it from Default.';
    list.appendChild(empty);
    return;
  }
  if (!visibleGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No conversations match this search.';
    list.appendChild(empty);
    return;
  }

  for (const group of visibleGroups) {
    const preview = group.latestUserMessage
      ? `You: ${truncatePreview(group.latestUserMessage)}`
      : group.latestAgentMessage
        ? `Codex: ${truncatePreview(group.latestAgentMessage)}`
        : 'No prompt preview available';

    const item = document.createElement('div');
    item.className = `conversation-card ${group.conversationKey === state.selectedConversationKey ? 'active' : ''}`;
    item.innerHTML = `
      <div class="conversation-card-top">
        <div>
          <div class="title">${escapeHtml(group.title || group.conversationKey)}</div>
          <div class="sub">${escapeHtml(group.hostLabel || getHost(group.hostId)?.label || group.hostId)} | ${group.liveCount > 0 ? `${group.liveCount} live` : 'history only'} | ${group.totalCount} variants</div>
        </div>
        <div class="conversation-stats">
          <div class="count">${group.totalCount}</div>
          <div class="label">sessions</div>
        </div>
      </div>
      <div class="path">${escapeHtml(group.cwd || '(unknown path)')}</div>
      <div class="conversation-summary">
        <span>${escapeHtml(formatTime(group.lastUpdatedAt) || 'No recent activity')}</span>
        <span>${group.liveCount > 0 ? 'Joinable live session' : 'History can be resumed'}</span>
      </div>
      <div class="preview">${escapeHtml(preview)}</div>
    `;

    const variantRow = document.createElement('div');
    variantRow.className = 'variant-row';
    renderVariantButtons(variantRow, group, state.selectedSessionId);
    item.appendChild(variantRow);

    const actions = document.createElement('div');
    actions.className = 'conversation-card-actions';
    const collectionSelect = document.createElement('select');
    collectionSelect.className = 'collection-move-select';
    collectionSelect.innerHTML = '<option value="">Save to collection...</option>';
    for (const target of state.sessionCollections.filter((entry) => entry.collectionId !== 'default')) {
      const option = document.createElement('option');
      option.value = target.collectionId;
      option.textContent = target.name;
      collectionSelect.appendChild(option);
    }
    collectionSelect.disabled = group.collectionOnly || state.sessionCollections.length <= 1;
    collectionSelect.onclick = (event) => event.stopPropagation();
    collectionSelect.onchange = async (event) => {
      event.stopPropagation();
      const targetCollectionId = event.target.value;
      event.target.value = '';
      if (!targetCollectionId) {
        return;
      }
      try {
        await addConversationToCollection(targetCollectionId, group);
      } catch (error) {
        reportError(error);
      }
    };
    actions.appendChild(collectionSelect);
    if (collection.collectionId !== 'default') {
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'secondary-button collection-remove-button';
      removeButton.textContent = 'Remove';
      removeButton.onclick = async (event) => {
        event.stopPropagation();
        try {
          await removeConversationFromCollection(collection.collectionId, group);
        } catch (error) {
          reportError(error);
        }
      };
      actions.appendChild(removeButton);
    }
    item.appendChild(actions);

    item.onclick = () => {
      if (!group.collectionOnly) {
        selectConversation(group).catch(reportError);
      }
    };
    list.appendChild(item);
  }
}

function modelCacheKey(session) {
  return getSessionKey(session) || 'none';
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function fileExtension(name) {
  const text = String(name || '').trim().toLowerCase();
  const index = text.lastIndexOf('.');
  return index === -1 ? '' : text.slice(index + 1);
}

function isTextLikeFile(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('text/')) {
    return true;
  }
  if (type === 'application/json' || type === 'application/x-ndjson' || type === 'application/xml') {
    return true;
  }
  return TEXT_FILE_EXTENSIONS.has(fileExtension(file?.name));
}

function isImageFileRef(file) {
  const mime = String(file?.mime || file?.type || '').toLowerCase();
  return mime.startsWith('image/') || IMAGE_FILE_EXTENSIONS.has(fileExtension(file?.name || file?.path));
}

function formatHostCapabilityName(host) {
  return host?.label || host?.hostId || 'selected host';
}

function isDownloadablePath(value) {
  const text = String(value || '').trim();
  if (!text || /^(https?:|data:|mailto:)/i.test(text)) {
    return false;
  }
  return DOWNLOADABLE_FILE_EXTENSIONS.has(fileExtension(text));
}

function stripPathPunctuation(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[)\].,;:!?]+$/g, '');
}

function decodePathCandidate(value) {
  const cleaned = stripPathPunctuation(value);
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

function extractFileRefsFromText(text) {
  const source = String(text || '');
  const refs = [];
  const addRef = (candidate, label = '') => {
    const pathValue = decodePathCandidate(candidate);
    if (!isDownloadablePath(pathValue)) {
      return;
    }
    if (refs.some((entry) => entry.path === pathValue)) {
      return;
    }
    refs.push({
      name: label || basename(pathValue) || pathValue,
      path: pathValue,
      mime: '',
      size: 0,
      isImage: IMAGE_FILE_EXTENSIONS.has(fileExtension(pathValue)),
    });
  };

  const markdownLinkPattern = /!?\[([^\]]*)\]\(([^)]+)\)/g;
  let match = null;
  while ((match = markdownLinkPattern.exec(source))) {
    addRef(match[2], match[1]);
  }

  const explicitPattern = /remote-codex-file:([^\s"'<>`]+)/g;
  while ((match = explicitPattern.exec(source))) {
    addRef(match[1]);
  }

  const extensionPattern = Array.from(DOWNLOADABLE_FILE_EXTENSIONS).join('|');
  const unixPattern = new RegExp(`(?:~|\\/)[^\\s"'<>\\|` + '`' + `]+?\\.(${extensionPattern})(?=[\\s\\)\\]\\},.;:!?]|$)`, 'gi');
  while ((match = unixPattern.exec(source))) {
    addRef(match[0]);
  }

  const windowsPattern = new RegExp(`[A-Za-z]:\\\\[^\\n"'<>\\|` + '`' + `]+?\\.(${extensionPattern})(?=[\\s\\)\\]\\},.;:!?]|$)`, 'gi');
  while ((match = windowsPattern.exec(source))) {
    addRef(match[0]);
  }

  const relativePattern = new RegExp(
    `(?:^|[\\s\\(\\[\\{])((?:\\.{1,2}[\\\\/])?(?:[A-Za-z0-9_.@+~-]+[\\\\/])*[A-Za-z0-9_.@+~-]+\\.(${extensionPattern}))(?=[\\s\\)\\]\\},.;:!?]|$)`,
    'gi'
  );
  while ((match = relativePattern.exec(source))) {
    addRef(match[1]);
  }

  return refs;
}

function getTranscriptFileRefs(entry) {
  const explicit = normalizeTranscriptFiles(entry?.files || entry?.attachments || []);
  const extracted = extractFileRefsFromText(entry?.text || '');
  const seen = new Set();
  const merged = [];
  for (const file of [...explicit, ...extracted]) {
    const key = file.path || file.name;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(file);
  }
  return merged;
}

function buildHostFileUrl(session, file, inline = false) {
  const params = new URLSearchParams({
    path: file.path || '',
    sessionId: session?.sessionId || '',
  });
  if (session?.cwd) {
    params.set('cwd', session.cwd);
  }
  if (inline) {
    params.set('inline', '1');
  }
  return `/api/hosts/${encodeURIComponent(session.hostId)}/files/download?${params.toString()}`;
}

function buildReceivedFileUrl(file, inline = false) {
  const params = new URLSearchParams();
  if (inline) {
    params.set('inline', '1');
  }
  return `/api/received-files/${encodeURIComponent(file.fileId)}${params.toString() ? `?${params.toString()}` : ''}`;
}

const FALLBACK_REASONING_EFFORTS = [
  { value: 'minimal', label: 'Minimal / 最小' },
  { value: 'low', label: 'Low / 低' },
  { value: 'medium', label: 'Medium / 中' },
  { value: 'high', label: 'High / 高' },
  { value: 'xhigh', label: 'XHigh / 超高' },
];

const REASONING_EFFORT_LABELS = {
  none: 'None / 关闭',
  minimal: 'Minimal / 最小',
  low: 'Low / 低',
  medium: 'Medium / 中',
  high: 'High / 高',
  xhigh: 'XHigh / 超高',
};

function normalizeModelOption(model) {
  const modelId = String(model?.model || model?.id || '').trim();
  if (!modelId) {
    return null;
  }
  return {
    ...model,
    id: String(model?.id || modelId).trim(),
    model: modelId,
    displayName: String(model?.displayName || modelId).trim(),
    description: String(model?.description || '').trim(),
    inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.map(String) : [],
    supportedReasoningEfforts: Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts
      : [],
    defaultReasoningEffort: String(model?.defaultReasoningEffort || '').trim(),
    hidden: Boolean(model?.hidden),
    isDefault: Boolean(model?.isDefault),
    supportsPersonality: model?.supportsPersonality === true,
  };
}

function getModelOptions(session) {
  const seen = new Set();
  const models = [];
  for (const rawModel of state.codexControls.modelOptionsBySession.get(modelCacheKey(session)) || []) {
    const model = normalizeModelOption(rawModel);
    if (!model || seen.has(model.model)) {
      continue;
    }
    seen.add(model.model);
    models.push(model);
  }
  return models;
}

function findModelOption(session, modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) {
    return getModelOptions(session).find((model) => model.isDefault) || null;
  }
  return getModelOptions(session).find((model) => model.model === normalized || model.id === normalized) || null;
}

function inferModelCategory(model) {
  const id = String(model?.model || model?.id || '').toLowerCase();
  if (model?.isDefault) {
    return 'Recommended / 默认推荐';
  }
  if (model?.hidden) {
    return 'Hidden / System';
  }
  if (/mini|nano|small|lite/.test(id)) {
    return 'Small / Fast';
  }
  if (/codex|code/.test(id)) {
    return 'Codex / Coding';
  }
  if (/^gpt[-_.]?\d/.test(id)) {
    return 'GPT / General';
  }
  return 'Other';
}

function modelSelectLabel(model) {
  const badges = [];
  if (model.isDefault) {
    badges.push('default');
  }
  if (model.inputModalities.includes('image')) {
    badges.push('img');
  }
  if (model.defaultReasoningEffort) {
    badges.push(model.defaultReasoningEffort);
  }
  return `${model.displayName || model.model}${badges.length ? ` | ${badges.join(' | ')}` : ''}`;
}

function syncModelSelectFromInput(session) {
  const select = el('codex-model-select');
  const input = el('codex-model-input');
  if (!select || !input) {
    return;
  }
  const value = input.value.trim();
  const matched = value ? findModelOption(session, value) : null;
  select.value = matched ? matched.model : '';
}

function renderComposerModelOptions(session) {
  const datalist = el('codex-model-options');
  const select = el('codex-model-select');
  if (!datalist || !select) {
    return;
  }

  datalist.innerHTML = '';
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  const models = getModelOptions(session);
  const defaultModel = models.find((model) => model.isDefault) || null;
  defaultOption.textContent = defaultModel
    ? `Auto: ${defaultModel.displayName || defaultModel.model}`
    : 'Model: auto/default';
  select.appendChild(defaultOption);

  const grouped = new Map();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.model;
    const effort = model.defaultReasoningEffort ? ` | effort ${model.defaultReasoningEffort}` : '';
    option.label = `${model.displayName || model.model}${model.isDefault ? ' | default' : ''}${effort}${model.description ? ` | ${model.description}` : ''}`;
    datalist.appendChild(option);

    const category = inferModelCategory(model);
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category).push(model);
  }

  for (const [category, categoryModels] of grouped.entries()) {
    const group = document.createElement('optgroup');
    group.label = category;
    for (const model of categoryModels) {
      const option = document.createElement('option');
      option.value = model.model;
      option.textContent = modelSelectLabel(model);
      group.appendChild(option);
    }
    select.appendChild(group);
  }

  syncModelSelectFromInput(session);
}

function supportedEffortValues(model) {
  return (model?.supportedReasoningEfforts || [])
    .map((effort) => String(effort?.reasoningEffort || effort || '').trim())
    .filter(Boolean);
}

function renderReasoningEffortOptions(session) {
  const select = el('codex-effort-select');
  if (!select) {
    return;
  }

  const current = select.value;
  const selectedModel = findModelOption(session, el('codex-model-input')?.value.trim());
  const supported = selectedModel ? supportedEffortValues(selectedModel) : [];
  const options = supported.length
    ? supported.map((value) => ({ value, label: REASONING_EFFORT_LABELS[value] || value }))
    : FALLBACK_REASONING_EFFORTS;

  select.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = selectedModel?.defaultReasoningEffort
    ? `Effort: model default (${selectedModel.defaultReasoningEffort})`
    : 'Effort: default';
  select.appendChild(defaultOption);

  for (const optionSpec of options) {
    const option = document.createElement('option');
    option.value = optionSpec.value;
    option.textContent = optionSpec.label;
    select.appendChild(option);
  }

  select.value = options.some((optionSpec) => optionSpec.value === current) ? current : '';
}

function renderAttachmentChips() {
  const container = el('codex-attachment-chips');
  if (!container) {
    return;
  }

  container.innerHTML = '';
  for (const [index, attachment] of state.codexControls.attachments.entries()) {
    const chip = document.createElement('div');
    chip.className = `attachment-chip ${attachment.type === 'uploadFile' || attachment.type === 'textFile' ? 'file' : ''}`.trim();
    const label = attachment.remotePath
      ? 'Uploaded'
      : attachment.type === 'image'
        ? 'Image'
        : 'File';
    const note = attachment.remotePath ? ` -> ${attachment.remotePath}` : '';
    chip.innerHTML = `
      <span>${escapeHtml(label)}: ${escapeHtml(attachment.name || 'attached file')}${attachment.size ? ` (${escapeHtml(formatBytes(attachment.size))})` : ''}${escapeHtml(note)}</span>
      <button class="attachment-chip-remove" type="button" data-attachment-index="${index}" aria-label="Remove ${escapeHtml(attachment.name || 'attachment')}">x</button>
    `;
    container.appendChild(chip);
  }

  const localPath = el('codex-local-image-path')?.value.trim();
  if (localPath) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip muted';
    chip.innerHTML = `
      <span>Host image: ${escapeHtml(localPath)}</span>
      <button class="attachment-chip-remove" type="button" data-clear-local-image="true" aria-label="Remove host image path">x</button>
    `;
    container.appendChild(chip);
  }

  container.classList.toggle('hidden', container.childElementCount === 0);
}

function renderComposerControls(session, disabled) {
  renderComposerModelOptions(session);
  renderReasoningEffortOptions(session);
  renderAttachmentChips();
  requestModelOptionsForSession(session);

  const controlIds = [
    'codex-model-input',
    'codex-model-select',
    'codex-effort-select',
    'codex-summary-select',
    'codex-mode-select',
    'codex-approval-policy-select',
    'codex-reviewer-select',
    'codex-sandbox-mode-select',
    'codex-personality-select',
    'codex-file-picker-button',
    'codex-image-files',
    'codex-local-image-path',
    'codex-clear-attachments-button',
    'codex-plan-button',
    'codex-send-button',
  ];
  for (const id of controlIds) {
    const node = el(id);
    if (node) {
      node.disabled = disabled;
    }
  }

  const modelButton = el('codex-model-refresh-button');
  if (modelButton) {
    const loadingModels = isModelOptionsLoading(session);
    modelButton.disabled = disabled || !session?.live || loadingModels;
    modelButton.textContent = loadingModels ? 'Loading...' : 'Refresh';
  }

  const reviewButton = el('codex-review-button');
  if (reviewButton) {
    reviewButton.disabled = disabled || !session?.live;
  }
}

function getComposerInputItems(uploadedFiles = []) {
  const inputItems = state.codexControls.attachments
    .filter((attachment) => attachment.type === 'image')
    .map((attachment) => ({
      type: 'image',
      url: attachment.url,
      name: attachment.name || 'image',
    }));
  for (const file of uploadedFiles.filter(isImageFileRef)) {
    if (!file.path) {
      continue;
    }
    inputItems.push({
      type: 'localImage',
      path: file.path,
      name: file.name || basename(file.path),
    });
  }
  const localImagePath = el('codex-local-image-path')?.value.trim();
  if (localImagePath) {
    inputItems.push({
      type: 'localImage',
      path: localImagePath,
      name: basename(localImagePath),
    });
  }
  return inputItems;
}

function getComposerTextFileSections() {
  return state.codexControls.attachments
    .filter((attachment) => attachment.type === 'textFile')
    .map((attachment) => [
      `Attached file: ${attachment.name || 'untitled'}`,
      '```text',
      String(attachment.text || '').replace(/```/g, '` ` `'),
      '```',
    ].join('\n'));
}

function getComposerUploadedFileSections(uploadedFiles = []) {
  if (!uploadedFiles.length) {
    return [];
  }
  return [
    [
      'Files uploaded to the selected host:',
      ...uploadedFiles.map((file) => `- ${file.name || basename(file.path)}: ${file.path}${file.size ? ` (${formatBytes(file.size)})` : ''}`),
      '',
      'Use these remote host paths directly. For images, inspect the attached localImage items; for other files, open/read the paths as needed.',
    ].join('\n'),
  ];
}

function getComposerOptions() {
  return {
    model: el('codex-model-input')?.value.trim() || null,
    effort: el('codex-effort-select')?.value || null,
    summary: el('codex-summary-select')?.value || null,
    mode: el('codex-mode-select')?.value || 'default',
    approvalPolicy: el('codex-approval-policy-select')?.value || 'on-request',
    approvalsReviewer: el('codex-reviewer-select')?.value || 'user',
    sandboxMode: el('codex-sandbox-mode-select')?.value || 'workspaceWrite',
    personality: el('codex-personality-select')?.value || null,
  };
}

function buildPlanPrompt(text, hasAttachments) {
  const request = text || (hasAttachments ? 'Please inspect the attached image(s) and propose a safe next-step plan.' : '');
  return [
    'Plan mode: do not modify files, do not run destructive commands, and do not make irreversible changes.',
    'Analyze the request, list the concrete steps you would take, and call out risks or decisions that need confirmation.',
    '',
    'User request:',
    request,
  ].join('\n').trim();
}

const SLASH_COMMANDS = [
  {
    id: 'plan',
    command: '/plan',
    title: 'Plan Mode',
    category: 'Codex',
    description: 'Turn on plan-only mode for the next message.',
    keywords: ['计划', 'plan mode'],
    run: async () => {
      setSelectValue('codex-mode-select', 'plan');
      focusComposerInput();
    },
  },
  {
    id: 'review',
    command: '/review',
    title: 'Code Review',
    category: 'Codex',
    description: 'Start a Codex review for current workspace changes.',
    keywords: ['代码审查', '审查'],
    run: startReviewForCurrentSession,
  },
  {
    id: 'compact',
    command: '/compact',
    title: 'Compact Context',
    category: 'Codex',
    description: 'Compact the current live Codex thread context.',
    keywords: ['压缩', '上下文'],
    run: compactCurrentThread,
  },
  {
    id: 'status',
    command: '/status',
    title: 'Status',
    category: 'Runtime',
    description: 'Open session status, requests, diagnostics, and usage.',
    keywords: ['状态', 'quota', 'diagnostics'],
    run: async () => setStatusWindowOpen(true),
  },
  {
    id: 'model-gpt-55',
    command: '/gpt-5.5',
    title: 'Model: GPT-5.5',
    category: 'Model',
    description: 'Use GPT-5.5 for the next turn.',
    keywords: ['模型', 'model', 'gpt'],
    run: async () => {
      setInputValue('codex-model-input', 'gpt-5.5');
      focusComposerInput();
    },
  },
  {
    id: 'models',
    command: '/models',
    title: 'Open Model List',
    category: 'Model',
    description: 'Load available model IDs from the selected live session.',
    keywords: ['model list', '模型列表'],
    run: async () => {
      await loadModelOptionsForSelectedSession();
      el('codex-model-select')?.focus();
    },
  },
  {
    id: 'reasoning-xhigh',
    command: '/reasoning',
    title: 'Reasoning: XHigh',
    category: 'Model',
    description: 'Set reasoning effort to xhigh for the next turn.',
    keywords: ['推理', '超高', 'think', 'ultrathink'],
    run: async () => {
      setSelectValue('codex-effort-select', 'xhigh');
      focusComposerInput();
    },
  },
  {
    id: 'personality-friendly',
    command: '/personality',
    title: 'Personality: Friendly',
    category: 'Model',
    description: 'Set Codex personality to friendly for the next turn.',
    keywords: ['个性', 'friendly'],
    run: async () => {
      setSelectValue('codex-personality-select', 'friendly');
      focusComposerInput();
    },
  },
  {
    id: 'personality-pragmatic',
    command: '/pragmatic',
    title: 'Personality: Pragmatic',
    category: 'Model',
    description: 'Set Codex personality to pragmatic for the next turn.',
    keywords: ['个性', 'pragmatic'],
    run: async () => {
      setSelectValue('codex-personality-select', 'pragmatic');
      focusComposerInput();
    },
  },
  {
    id: 'fork',
    command: '/fork',
    title: 'Fork New Branch',
    category: 'Session',
    description: 'Create a new live branch from the selected conversation.',
    keywords: ['派生', 'branch'],
    run: forkNewBranch,
  },
  {
    id: 'upload',
    command: '/upload',
    title: 'Upload File',
    category: 'Files',
    description: 'Open file picker and upload files to the selected host on send.',
    keywords: ['file', 'image', '图片', '文件'],
    run: async () => el('codex-image-files')?.click(),
  },
  {
    id: 'clear-files',
    command: '/clear-files',
    title: 'Clear Files',
    category: 'Files',
    description: 'Remove queued file and image attachments from composer.',
    keywords: ['clear attachments', '清除'],
    run: async () => {
      clearComposerFileAttachments();
      focusComposerInput();
    },
  },
  {
    id: 'shell',
    command: '/shell',
    title: 'Shell Command',
    category: 'Runtime',
    description: 'Open status panel and focus the shell-command control.',
    keywords: ['terminal', '命令', 'shell command'],
    run: async () => {
      setStatusWindowOpen(true);
      window.setTimeout(() => el('shell-command-input')?.focus(), 0);
    },
  },
  {
    id: 'mcp',
    command: '/mcp',
    title: 'MCP Status',
    category: 'Bridge',
    description: 'Ask Codex to inspect MCP status if that host supports MCP.',
    keywords: ['mcp', '服务器状态'],
    insert: 'Please show MCP server status for this Codex environment. If MCP is not available through this relay yet, explain what is missing and how to verify it on the host.',
  },
  {
    id: 'ide-context',
    command: '/ide-context',
    title: 'IDE Context',
    category: 'Bridge',
    description: 'Record that IDE context is not currently tunneled by this relay.',
    keywords: ['ide', '上下文', 'close ide context'],
    insert: 'IDE context is not currently tunneled through this mobile relay. Please rely on the selected workspace files and paths on this host instead.',
  },
  {
    id: 'feedback',
    command: '/feedback',
    title: 'Feedback',
    category: 'Meta',
    description: 'Insert a feedback note template for this remote-control app.',
    keywords: ['反馈'],
    insert: 'Feedback for Mobile Codex Remote:\n- What felt good:\n- What broke or felt confusing:\n- What should be improved next:',
  },
  {
    id: 'memory',
    command: '/memory',
    title: 'Memory',
    category: 'Meta',
    description: 'Ask Codex to draft durable project memory or next-run notes.',
    keywords: ['记忆', 'memory.md'],
    insert: 'Please generate durable project memory for future sessions: summarize stable facts, host setup notes, commands, gotchas, and next steps. If a MEMORY.md or project notes file exists, propose a safe update before editing.',
  },
  {
    id: 'skill-imagegen',
    command: '/imagegen',
    title: 'Skill: Image Gen',
    category: 'Skills',
    description: 'Ask Codex to use Image Gen when available.',
    keywords: ['skill', '图片生成', 'image gen'],
    insert: 'Use the Image Gen skill if it is available in this Codex environment. Generate or edit the requested image, then save the output file in the current workspace and reply with its full path.',
  },
  {
    id: 'skill-openai-docs',
    command: '/openai-docs',
    title: 'Skill: OpenAI Docs',
    category: 'Skills',
    description: 'Use official OpenAI docs when available.',
    keywords: ['skill', 'openai docs', '文档'],
    insert: 'Use the OpenAI Docs skill if it is available. Check official OpenAI documentation before answering, and cite the specific docs used.',
  },
  {
    id: 'skill-plugin-creator',
    command: '/plugin-creator',
    title: 'Skill: Plugin Creator',
    category: 'Skills',
    description: 'Scaffold or update a Codex plugin.',
    keywords: ['skill', 'plugin'],
    insert: 'Use the Plugin Creator skill if it is available. Scaffold or update the requested Codex plugin and list the files changed.',
  },
  {
    id: 'skill-creator',
    command: '/skill-creator',
    title: 'Skill: Skill Creator',
    category: 'Skills',
    description: 'Create or update a Codex skill.',
    keywords: ['skill', '创建 skill'],
    insert: 'Use the Skill Creator skill if it is available. Create or update the requested skill and explain how to test it.',
  },
  {
    id: 'skill-installer',
    command: '/skill-installer',
    title: 'Skill: Skill Installer',
    category: 'Skills',
    description: 'Install curated or repo-hosted Codex skills.',
    keywords: ['skill', 'install', '安装'],
    insert: 'Use the Skill Installer skill if it is available. Install the requested skill source and summarize where it was installed.',
  },
];

function setInputValue(id, value) {
  const node = el(id);
  if (!node) {
    return;
  }
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(id, value) {
  const node = el(id);
  if (!node) {
    return;
  }
  node.value = value;
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

function focusComposerInput() {
  const input = el('input-text');
  if (input) {
    input.focus();
  }
}

function getSlashTokenMatch(input = el('input-text')) {
  if (!input) {
    return null;
  }
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const match = before.match(/(^|[\s\n])\/([\w.-]*)$/);
  if (!match) {
    return null;
  }
  return {
    start: before.length - match[0].length + match[1].length,
    end: caret,
    query: match[2] || '',
  };
}

function getFilteredSlashCommands() {
  const query = String(state.slashMenu.query || '').trim().toLowerCase();
  if (!query) {
    return SLASH_COMMANDS;
  }
  const terms = query.split(/\s+/).filter(Boolean);
  return SLASH_COMMANDS.filter((command) => {
    const haystack = [
      command.command,
      command.title,
      command.category,
      command.description,
      ...(command.keywords || []),
    ].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function hideSlashMenu() {
  state.slashMenu.open = false;
  state.slashMenu.query = '';
  state.slashMenu.selectedIndex = 0;
  renderSlashMenu();
}

function updateSlashMenuFromInput() {
  const input = el('input-text');
  const match = getSlashTokenMatch(input);
  if (!match || input?.disabled || el('input-form')?.classList.contains('disabled')) {
    if (state.slashMenu.open) {
      hideSlashMenu();
    }
    return;
  }

  state.slashMenu.open = true;
  state.slashMenu.query = match.query;
  const commands = getFilteredSlashCommands();
  state.slashMenu.selectedIndex = Math.min(state.slashMenu.selectedIndex, Math.max(0, commands.length - 1));
  renderSlashMenu();
}

function replaceSlashToken(replacement = '') {
  const input = el('input-text');
  const match = getSlashTokenMatch(input);
  if (!input || !match) {
    return;
  }

  const before = input.value.slice(0, match.start);
  const after = input.value.slice(match.end);
  const spacer = replacement && before && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${spacer}${replacement}${replacement && after && !/^\s/.test(after) ? ' ' : ''}${after}`;
  const caret = (before + spacer + replacement).length;
  input.value = next;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function executeSlashCommand(command) {
  if (!command) {
    return;
  }

  if (command.insert) {
    replaceSlashToken(command.insert);
    hideSlashMenu();
    focusComposerInput();
    return;
  }

  replaceSlashToken('');
  hideSlashMenu();
  await command.run();
}

function renderSlashMenu() {
  const menu = el('slash-command-menu');
  if (!menu) {
    return;
  }
  if (!state.slashMenu.open) {
    menu.classList.add('hidden');
    menu.innerHTML = '';
    return;
  }

  const commands = getFilteredSlashCommands();
  menu.classList.remove('hidden');
  menu.innerHTML = '';

  if (!commands.length) {
    const empty = document.createElement('div');
    empty.className = 'slash-command-empty';
    empty.textContent = 'No slash commands match this search.';
    menu.appendChild(empty);
    return;
  }

  commands.forEach((command, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `slash-command-item ${index === state.slashMenu.selectedIndex ? 'active' : ''}`.trim();
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === state.slashMenu.selectedIndex ? 'true' : 'false');
    button.innerHTML = `
      <div class="slash-command-icon">${escapeHtml(command.command)}</div>
      <div class="slash-command-copy">
        <div class="slash-command-title-row">
          <span class="slash-command-title">${escapeHtml(command.title)}</span>
          <span class="slash-command-category">${escapeHtml(command.category)}</span>
        </div>
        <div class="slash-command-description">${escapeHtml(command.description)}</div>
      </div>
    `;
    button.onmouseenter = () => {
      state.slashMenu.selectedIndex = index;
      renderSlashMenu();
    };
    button.onmousedown = (event) => {
      event.preventDefault();
    };
    button.onclick = async () => {
      try {
        await executeSlashCommand(command);
      } catch (error) {
        reportError(error);
      }
    };
    menu.appendChild(button);
  });
}

async function uploadComposerFiles(session) {
  const uploadAttachments = state.codexControls.attachments
    .filter((attachment) => attachment.type === 'uploadFile');
  if (!uploadAttachments.length) {
    return [];
  }
  if (!session?.hostId) {
    throw new Error('Select a host session before uploading files.');
  }

  await verifyHostAvailable(session.hostId);
  const host = getHost(session.hostId);
  if (!host?.capabilities?.fileTransfer) {
    throw new Error(`${formatHostCapabilityName(host)} has not enabled file transfer yet. Restart the relay and this host-agent, then refresh the page. For HPC hosts, use Manage HPC -> Restart Agent.`);
  }

  const reusable = [];
  const pending = [];
  for (const attachment of uploadAttachments) {
    if (
      attachment.remotePath
      && attachment.uploadHostId === session.hostId
      && attachment.uploadCwd === session.cwd
    ) {
      reusable.push({
        fileId: attachment.fileId || attachment.name,
        name: attachment.remoteName || attachment.name,
        path: attachment.remotePath,
        size: attachment.size || 0,
        mime: attachment.mime || '',
        isImage: isImageFileRef(attachment),
      });
      continue;
    }
    pending.push(attachment);
  }

  let uploaded = [];
  if (pending.length) {
    let response = null;
    try {
      response = await fetchJson(`/api/hosts/${encodeURIComponent(session.hostId)}/files/upload`, {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.sessionId,
          targetDirectory: session.cwd || '',
          files: pending.map((attachment) => ({
            fileId: attachment.fileId,
            name: attachment.name,
            mime: attachment.mime || 'application/octet-stream',
            size: attachment.size || 0,
            dataBase64: attachment.dataBase64,
          })),
        }),
      });
    } catch (error) {
      if (error.status === 404 && /\/files\/upload/.test(String(error.url || ''))) {
        throw new Error('The running relay does not have the file upload API yet. Restart the relay/server process, restart the selected host-agent, then refresh the browser.');
      }
      throw error;
    }
    uploaded = normalizeTranscriptFiles(response.files || []);
    for (const [index, file] of uploaded.entries()) {
      const attachment = pending[index];
      if (!attachment) {
        continue;
      }
      attachment.remotePath = file.path;
      attachment.remoteName = file.name;
      attachment.uploadHostId = session.hostId;
      attachment.uploadCwd = session.cwd;
      attachment.mime = file.mime || attachment.mime;
      attachment.size = file.size || attachment.size;
    }
    renderAttachmentChips();
  }

  return [...reusable, ...uploaded];
}

async function buildComposerPayload(rawText, overrides = {}) {
  const session = getSelectedSession();
  const uploadedFiles = await uploadComposerFiles(session);
  const inputItems = getComposerInputItems(uploadedFiles);
  const textFileSections = getComposerTextFileSections();
  const uploadedFileSections = getComposerUploadedFileSections(uploadedFiles);
  const options = {
    ...getComposerOptions(),
    ...overrides,
  };
  const userVisibleText = String(rawText || '').trim();
  let text = userVisibleText;
  const hasOriginalContent = Boolean(text || inputItems.length || textFileSections.length || uploadedFileSections.length);
  if (uploadedFileSections.length || textFileSections.length) {
    text = [
      text,
      ...uploadedFileSections,
      textFileSections.length ? 'Attached text file contents:' : '',
      ...textFileSections,
    ].filter(Boolean).join('\n\n');
  }
  if (!text && inputItems.length) {
    text = 'Please inspect the attached image(s).';
  }
  if (options.mode === 'plan' && hasOriginalContent) {
    text = buildPlanPrompt(text, inputItems.length > 0);
    options.approvalPolicy = 'never';
    options.sandboxMode = 'readOnly';
  }

  return {
    ...options,
    text,
    displayText: userVisibleText || (hasOriginalContent ? 'Please inspect the attached file(s).' : ''),
    inputItems,
    uploadedFiles,
  };
}

function clearComposerFileAttachments() {
  state.codexControls.attachments = [];
  const fileInput = el('codex-image-files');
  if (fileInput) {
    fileInput.value = '';
  }
  renderAttachmentChips();
}

function removeComposerAttachment(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.codexControls.attachments.length) {
    return;
  }
  state.codexControls.attachments.splice(index, 1);
  const fileInput = el('codex-image-files');
  if (fileInput && !state.codexControls.attachments.length) {
    fileInput.value = '';
  }
  renderAttachmentChips();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('failed to read image file'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('failed to read text file'));
    reader.readAsText(file);
  });
}

function dataUrlToBase64(dataUrl) {
  const text = String(dataUrl || '');
  const comma = text.indexOf(',');
  return comma === -1 ? text : text.slice(comma + 1);
}

async function addComposerImageFiles(files) {
  const incoming = Array.from(files || []).filter((file) => file && String(file.type || '').startsWith('image/'));
  if (!incoming.length) {
    return;
  }
  const existingImages = state.codexControls.attachments.filter((attachment) => attachment.type === 'image').length;
  const available = Math.max(0, MAX_COMPOSER_IMAGES - existingImages);
  if (!available) {
    throw new Error(`You can attach up to ${MAX_COMPOSER_IMAGES} images at once.`);
  }

  const selected = incoming.slice(0, available);
  for (const file of selected) {
    if (file.size > MAX_COMPOSER_IMAGE_BYTES) {
      throw new Error(`${file.name} is too large for inline upload; limit is ${formatBytes(MAX_COMPOSER_IMAGE_BYTES)} per image.`);
    }
    const url = await readFileAsDataUrl(file);
    state.codexControls.attachments.push({
      type: 'image',
      url,
      name: file.name,
      size: file.size,
    });
  }
  renderAttachmentChips();
}

async function addComposerTextFiles(files) {
  const incoming = Array.from(files || []).filter((file) => file && isTextLikeFile(file));
  if (!incoming.length) {
    return;
  }
  const existingTextFiles = state.codexControls.attachments.filter((attachment) => attachment.type === 'textFile').length;
  const available = Math.max(0, MAX_COMPOSER_TEXT_FILES - existingTextFiles);
  if (!available) {
    throw new Error(`You can attach up to ${MAX_COMPOSER_TEXT_FILES} text files at once.`);
  }

  const selected = incoming.slice(0, available);
  for (const file of selected) {
    if (file.size > MAX_COMPOSER_TEXT_FILE_BYTES) {
      throw new Error(`${file.name} is too large for inline text upload; limit is ${formatBytes(MAX_COMPOSER_TEXT_FILE_BYTES)} per file.`);
    }
    const text = await readFileAsText(file);
    state.codexControls.attachments.push({
      type: 'textFile',
      text,
      name: file.name,
      size: file.size,
    });
  }
  renderAttachmentChips();
}

async function addComposerFiles(files) {
  const allFiles = Array.from(files || []).filter(Boolean);
  if (!allFiles.length) {
    return;
  }

  const existingUploads = state.codexControls.attachments.filter((attachment) => attachment.type === 'uploadFile').length;
  const available = Math.max(0, MAX_COMPOSER_UPLOAD_FILES - existingUploads);
  if (!available) {
    throw new Error(`You can attach up to ${MAX_COMPOSER_UPLOAD_FILES} files at once.`);
  }
  const selected = allFiles.slice(0, available);
  const totalBytes = state.codexControls.attachments
    .filter((attachment) => attachment.type === 'uploadFile')
    .reduce((sum, attachment) => sum + (Number(attachment.size || 0) || 0), 0)
    + selected.reduce((sum, file) => sum + (Number(file.size || 0) || 0), 0);
  if (totalBytes > MAX_COMPOSER_UPLOAD_TOTAL_BYTES) {
    throw new Error(`Attached files are too large; total limit is ${formatBytes(MAX_COMPOSER_UPLOAD_TOTAL_BYTES)}.`);
  }

  for (const file of selected) {
    if (file.size > MAX_COMPOSER_UPLOAD_FILE_BYTES) {
      throw new Error(`${file.name} is too large for remote upload; limit is ${formatBytes(MAX_COMPOSER_UPLOAD_FILE_BYTES)} per file.`);
    }
    const dataUrl = await readFileAsDataUrl(file);
    state.codexControls.attachments.push({
      type: 'uploadFile',
      fileId: makeClientId(),
      dataBase64: dataUrlToBase64(dataUrl),
      name: file.name || 'upload',
      mime: file.type || 'application/octet-stream',
      size: file.size,
    });
  }
  renderAttachmentChips();
}

function isFileDragEvent(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function setComposerDragActive(active) {
  const composer = el('input-form');
  if (composer) {
    composer.classList.toggle('drag-active', Boolean(active));
  }
}

async function handleComposerDrop(event) {
  if (!isFileDragEvent(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setComposerDragActive(false);

  const composer = el('input-form');
  if (composer?.classList.contains('disabled')) {
    reportError(new Error('Select or start a live session before attaching files.'));
    return;
  }

  try {
    await addComposerFiles(event.dataTransfer?.files);
  } catch (error) {
    reportError(error);
  }
}

function renderSessionDetails() {
  const session = getSelectedSession();
  const conversation = getSelectedConversation();
  const joinButton = el('join-session-button');
  const resumeButton = el('resume-session-button');
  const forkButton = el('fork-session-button');
  const alertsButton = el('toggle-alerts-button');
  const statusButton = el('toggle-status-button');
  const composer = el('input-form');
  const input = el('input-text');
  const runner = getRunnerSummary(session);
  const warningCard = el('session-warning-card');
  const warningText = el('session-warning');
  const alerts = getAlertsForSession(session);
  const pendingRequests = getRequestsForSession(session).filter((request) => request.status === 'pending');
  const runtime = getRuntimeForSession(session);

  el('session-title').textContent = session ? session.title || session.sessionId : 'No session selected';
  el('session-meta').textContent = session
    ? `${session.hostId} | ${conversation?.totalCount || 1} variants | ${session.state || 'unknown'}`
    : '';
  el('session-path').textContent = session?.cwd || '(unknown path)';
  el('session-status').textContent = session
    ? `${session.live ? 'Live' : 'History only'} | ${session.state || 'unknown'}`
    : 'No session selected';
  el('session-runner').textContent = runner.label;
  el('latest-user-message').textContent = session?.latestUserMessage || 'No recent user prompt captured.';
  el('latest-agent-message').textContent = getLatestFormalAgentMessage(session);
  if (runner.warning) {
    warningText.textContent = runner.warning;
    warningCard.classList.remove('hidden');
  } else {
    warningText.textContent = 'No warning.';
    warningCard.classList.add('hidden');
  }
  alertsButton.disabled = !session;
  alertsButton.textContent = alerts.length ? `Alerts (${alerts.length})` : 'Alerts';
  statusButton.disabled = !session;
  statusButton.textContent = pendingRequests.length
    ? `Status (${pendingRequests.length})`
    : runtime?.phase
      ? `Status: ${prettyStatusLabel(runtime.phase)}`
      : 'Status';

  renderVariantButtons(el('session-variants'), conversation, state.selectedSessionId);

  const liveSession = getLiveSessionForConversation(conversation);
  const canActivateHistory = Boolean(session && !session.live && session.cwd);
  const canFork = Boolean(session && session.cwd);
  if (!session) {
    joinButton.disabled = true;
    joinButton.textContent = 'Join Running Session';
    resumeButton.disabled = true;
    resumeButton.textContent = 'Resume From History';
    forkButton.disabled = true;
    forkButton.textContent = 'Fork New Branch';
  } else {
    if (!liveSession) {
      joinButton.disabled = true;
      joinButton.textContent = 'No Running Session';
    } else if (session.live && liveSession.sessionId === session.sessionId) {
      joinButton.disabled = true;
      joinButton.textContent = 'Already Joined';
    } else {
      joinButton.disabled = false;
      joinButton.textContent = 'Join Running Session';
    }

    resumeButton.disabled = !canActivateHistory;
    if (canActivateHistory && liveSession) {
      resumeButton.textContent = 'Resume History Again';
    } else if (canActivateHistory) {
      resumeButton.textContent = 'Resume From History';
    } else {
      resumeButton.textContent = session.live ? 'Already Live' : 'Cannot Resume';
    }

    forkButton.disabled = !canFork;
    forkButton.textContent = session.live ? 'Fork Running Session' : 'Fork New Branch';
  }

  const composerDisabled = !session || (!session.live && !canActivateHistory);
  composer.classList.toggle('disabled', composerDisabled);
  input.disabled = composerDisabled;
  renderComposerControls(session, composerDisabled);
  if (session?.live) {
    input.placeholder = 'Send a follow-up prompt to the live managed session...';
  } else if (canActivateHistory) {
    input.placeholder = liveSession
      ? 'Type here to resume this history point into a new live branch...'
      : 'Type here to resume this history session as live...';
  } else {
    input.placeholder = 'Join or start a live session first...';
  }

  renderApprovalPopup();
}

function createRuntimeChip(container, label, value, tone = 'info') {
  const chip = document.createElement('div');
  chip.className = `runtime-chip ${tone}`.trim();
  chip.innerHTML = `<strong>${label}</strong>${value}`;
  container.appendChild(chip);
}

function renderRuntimePanel() {
  const session = getSelectedSession();
  const runtime = getRuntimeForSession(session) || {};
  const stream = getStreamStatusForSession(session) || {};
  const requests = getRequestsForSession(session).filter((request) => request.status === 'pending');
  const titleEl = el('runtime-panel-title');
  const subtitleEl = el('runtime-panel-subtitle');
  const chipRow = el('runtime-chip-row');
  const interruptButton = el('runtime-interrupt-button');
  const compactButton = el('runtime-compact-button');
  const statusButton = el('runtime-open-status-button');
  const steerInput = el('inline-steer-input');
  const steerSubmit = el('inline-steer-submit-button');
  const shellInput = el('inline-shell-command-input');
  const shellSubmit = el('inline-shell-command-submit-button');

  chipRow.innerHTML = '';

  if (!session) {
    titleEl.textContent = 'No live session attached';
    subtitleEl.textContent = 'Select or start a managed session to see live status, timers, and commands.';
    interruptButton.disabled = true;
    compactButton.disabled = true;
    statusButton.disabled = true;
    steerInput.disabled = true;
    steerSubmit.disabled = true;
    shellInput.disabled = true;
    shellSubmit.disabled = true;
    steerInput.placeholder = 'No active turn to steer';
    shellInput.placeholder = 'No live Codex thread is attached';
    createRuntimeChip(chipRow, 'State', 'No session selected', 'info');
    return;
  }

  const runtimeState = describeRuntimeStatus(runtime, stream, session);
  const connectionSince = formatElapsedSince(getStreamElapsedAnchor(stream) || runtime.runtimeConnectionStartedAt);
  const phaseSince = formatElapsedSince(getRuntimeElapsedAnchor(runtime));
  const pingSince = formatElapsedSince(stream.lastPingAt);
  const connectionTone = runtimeState.connection === 'connected' || runtimeState.connection === 'ready'
    ? 'active'
    : runtimeState.connection === 'reconnecting' || runtimeState.connection === 'connecting'
      ? 'warning'
      : runtimeState.connection === 'disconnected' || runtimeState.connection === 'closed'
        ? 'error'
        : 'info';
  const phaseTone = runtime.phase === 'error' || runtime.phase === 'quota-exhausted'
    ? 'error'
    : runtime.phase === 'waiting-approval' || runtime.phase === 'waiting-user-input' || runtime.phase === 'reconnecting'
      ? 'warning'
      : runtime.busy
        ? 'active'
        : 'info';

  if (session.live) {
    titleEl.textContent = `${session.title || session.sessionId} is live`;
    subtitleEl.textContent = runtime.busy
      ? `${runtimeState.phase} for ${phaseSince || '0s'} | ${prettyStatusLabel(runtimeState.connection)}${connectionSince ? ` for ${connectionSince}` : ''}`
      : `${prettyStatusLabel(runtimeState.connection)}${connectionSince ? ` for ${connectionSince}` : ''} | ${runtimeState.phase}`;
  } else {
    titleEl.textContent = `${session.title || session.sessionId} is history only`;
    subtitleEl.textContent = 'You can resume it, fork it, or open a different live variant from this workspace.';
  }

  createRuntimeChip(chipRow, 'Bridge', prettyStatusLabel(runtimeState.connection), connectionTone);
  createRuntimeChip(
    chipRow,
    'Phase',
    `${runtimeState.phase}${phaseSince ? ` | ${phaseSince}` : ''}`,
    phaseTone
  );
  createRuntimeChip(
    chipRow,
    'Turn',
    runtime.activeTurnId
      ? `${shortId(runtime.activeTurnId)} | ${runtimeState.turn}`
      : runtimeState.turn,
    runtime.activeTurnId ? 'active' : 'info'
  );
  createRuntimeChip(
    chipRow,
    'Requests',
    requests.length ? `${requests.length} pending` : 'None',
    requests.length ? 'warning' : 'info'
  );
  createRuntimeChip(
    chipRow,
    'Processing',
    runtime.busy
      ? `Running for ${formatElapsedSince(runtime.busyStartedAt || runtime.phaseStartedAt || runtime.updatedAt) || '0s'}`
      : `Last update ${formatElapsedSince(runtime.updatedAt) || 'just now'} ago`,
    runtime.busy ? 'active' : 'info'
  );
  if (pingSince) {
    createRuntimeChip(chipRow, 'Heartbeat', `${pingSince} ago`, 'info');
  }
  if (runtime.lastCodexError) {
    createRuntimeChip(chipRow, 'Error', limitText(runtime.lastCodexError, 96), 'error');
  } else if (runtime.rateLimits?.rateLimitReachedType) {
    createRuntimeChip(chipRow, 'API', prettyStatusLabel(runtime.rateLimits.rateLimitReachedType), 'warning');
  }

  interruptButton.disabled = !session.live || !runtime.activeTurnId;
  compactButton.disabled = !session.live || !runtime.threadId;
  statusButton.disabled = false;
  steerInput.disabled = !session.live || !runtime.activeTurnId;
  steerSubmit.disabled = !session.live || !runtime.activeTurnId;
  steerInput.placeholder = runtime.activeTurnId
    ? 'Guide the current live turn without sending a fresh prompt'
    : 'No active turn to steer right now';
  shellInput.disabled = !session.live || !runtime.threadId;
  shellSubmit.disabled = !session.live || !runtime.threadId;
  shellInput.placeholder = runtime.threadId
    ? 'Run a host shell command through thread/shellCommand'
    : 'No live Codex thread is attached';
}

function renderThinkingPanel() {
  const panel = el('thinking-panel');
  if (panel) {
    panel.innerHTML = '';
    panel.classList.add('hidden');
  }
}

function renderAlertsWindow() {
  const session = getSelectedSession();
  const alerts = getAlertsForSession(session);
  const windowEl = el('alerts-window');
  const listEl = el('alerts-list');
  const emptyEl = el('alerts-empty');
  const titleEl = el('alerts-title');
  const fabEl = el('alerts-fab');
  const fabCountEl = el('alerts-fab-count');

  if (!session) {
    windowEl.classList.add('hidden');
    fabEl.classList.add('hidden');
    return;
  }

  titleEl.textContent = `${session.title || session.sessionId} alerts`;
  fabCountEl.textContent = String(alerts.length);
  fabEl.classList.toggle('hidden', state.alertWindowOpen || alerts.length === 0);
  windowEl.classList.toggle('hidden', !state.alertWindowOpen);

  listEl.innerHTML = '';
  if (!alerts.length) {
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  for (const alert of [...alerts].reverse()) {
    const item = document.createElement('div');
    item.className = `alert-item ${alert.severity || 'warning'}`;
    item.innerHTML = `
      <div class="alert-top">
        <span class="alert-severity">${(alert.severity || 'warning').toUpperCase()}</span>
        <span class="alert-time">${formatTime(alert.timestamp)}</span>
      </div>
      <div class="alert-message">${alert.message || ''}</div>
      <div class="alert-source">${alert.source || 'runtime'}</div>
    `;
    listEl.appendChild(item);
  }
}

function describeThreadStatus(runtime) {
  const status = runtime?.threadStatus;
  if (!status || typeof status !== 'object') {
    return 'Unknown';
  }

  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    return flags.length ? `Active (${flags.join(', ')})` : 'Active';
  }

  return status.type || 'Unknown';
}

function formatTokenUsage(runtime) {
  const usage = runtime?.tokenUsage;
  if (!usage?.last || !usage?.total) {
    return 'No token usage reported yet.';
  }

  const lines = [
    `Last turn total: ${usage.last.totalTokens}`,
    `Input: ${usage.last.inputTokens} | Output: ${usage.last.outputTokens} | Reasoning: ${usage.last.reasoningOutputTokens}`,
    `Session total: ${usage.total.totalTokens}`,
  ];

  if (usage.modelContextWindow) {
    lines.push(`Context window: ${usage.modelContextWindow}`);
  }

  return lines.join('\n');
}

function formatRateLimits(runtime) {
  const limits = runtime?.rateLimits;
  if (!limits) {
    return 'No rate limit snapshot yet.';
  }

  const lines = [];
  if (limits.planType) {
    lines.push(`Plan: ${limits.planType}`);
  }
  if (limits.primary) {
    lines.push(`Primary: ${limits.primary.usedPercent}%${limits.primary.windowDurationMins ? ` / ${limits.primary.windowDurationMins} min` : ''}`);
  }
  if (limits.secondary) {
    lines.push(`Secondary: ${limits.secondary.usedPercent}%${limits.secondary.windowDurationMins ? ` / ${limits.secondary.windowDurationMins} min` : ''}`);
  }
  if (limits.rateLimitReachedType) {
    lines.push(`Reached: ${limits.rateLimitReachedType}`);
  }
  if (limits.credits) {
    lines.push(`Credits: ${limits.credits.unlimited ? 'unlimited' : limits.credits.balance || (limits.credits.hasCredits ? 'available' : 'empty')}`);
  }
  return lines.length ? lines.join('\n') : 'No rate limit snapshot yet.';
}

function renderStatusSummaryCard(container, label, value, note = '') {
  const card = document.createElement('div');
  card.className = 'status-summary-card';
  card.innerHTML = `
    <div class="status-summary-label">${label}</div>
    <div class="status-summary-value">${value}</div>
    ${note ? `<div class="status-summary-note">${note}</div>` : ''}
  `;
  container.appendChild(card);
}

async function respondToSessionRequest(session, request, response) {
  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/requests/${encodeURIComponent(request.requestId)}/respond`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      response,
    }),
  });
}

function buildToolAnswerResponse(questionId, answerLabel) {
  return {
    answers: {
      [questionId]: {
        answers: [answerLabel],
      },
    },
  };
}

function buildPermissionsDeclineResponse() {
  return {
    permissions: {
      fileSystem: null,
      network: {
        enabled: false,
      },
    },
    scope: 'turn',
    strictAutoReview: false,
  };
}

function appendApprovalPopupButton(actions, label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className || '';
  button.textContent = label;
  button.onclick = async () => {
    const buttons = Array.from(actions.querySelectorAll('button'));
    buttons.forEach((item) => {
      item.disabled = true;
    });
    try {
      await onClick();
    } catch (error) {
      buttons.forEach((item) => {
        item.disabled = false;
      });
      reportError(error);
    }
  };
  actions.appendChild(button);
  return button;
}

function renderApprovalPopup() {
  const popup = el('approval-popup');
  if (!popup) {
    return;
  }

  const session = getSelectedSession();
  const pendingRequests = getRequestsForSession(session).filter((request) => request.status === 'pending');
  const request = pendingRequests[0] || null;
  if (!session || !request) {
    popup.classList.add('hidden');
    return;
  }

  const title = request.title || request.method || request.kind || 'Codex request';
  const message = request.message || request.summary || 'Codex needs a response before it can continue.';
  const detailText = request.summary && request.summary !== message
    ? request.summary
    : request.payload
      ? summarizeData(request.payload)
      : '';
  const actions = el('approval-popup-actions');

  el('approval-popup-title').textContent = title;
  el('approval-popup-message').textContent = message;
  const detail = el('approval-popup-detail');
  detail.textContent = detailText;
  detail.classList.toggle('hidden', !detailText);
  actions.innerHTML = '';

  if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
    appendApprovalPopupButton(actions, 'Approve', '', async () => {
      await respondToSessionRequest(session, request, { decision: 'accept' });
    });
    appendApprovalPopupButton(actions, 'Decline', 'secondary-button', async () => {
      await respondToSessionRequest(session, request, { decision: 'decline' });
    });
    appendApprovalPopupButton(actions, 'Cancel Turn', 'secondary-button', async () => {
      await respondToSessionRequest(session, request, { decision: 'cancel' });
    });
  } else if (request.method === 'item/permissions/requestApproval') {
    appendApprovalPopupButton(actions, 'Decline Permissions', 'secondary-button', async () => {
      await respondToSessionRequest(session, request, buildPermissionsDeclineResponse());
    });
  } else if (request.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(request.payload?.questions) ? request.payload.questions : [];
    if (questions.length === 1 && Array.isArray(questions[0].options) && questions[0].options.length <= 3) {
      for (const option of questions[0].options) {
        appendApprovalPopupButton(actions, option.label, 'secondary-button', async () => {
          await respondToSessionRequest(session, request, buildToolAnswerResponse(questions[0].id, option.label));
        });
      }
    }
  }

  appendApprovalPopupButton(actions, 'Open Status', 'secondary-button', async () => {
    setStatusWindowOpen(true);
  });

  popup.classList.remove('hidden');
}

async function interruptActiveTurn() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/interrupt`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
    }),
  });
}

async function steerActiveTurn(text) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  const prompt = String(text || '').trim();
  if (!prompt) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      text: prompt,
    }),
  });
}

async function compactCurrentThread() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/compact`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
    }),
  });
}

async function runThreadShellCommand(command) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  const shellCommand = String(command || '').trim();
  if (!shellCommand) {
    return;
  }

  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/shell-command`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      command: shellCommand,
    }),
  });
}

function renderStatusWindow() {
  const overlay = el('status-window-overlay');
  const modal = el('status-window');
  const session = getSelectedSession();

  if (!state.statusWindowOpen || !session) {
    overlay.classList.add('hidden');
    modal.classList.add('hidden');
    syncModalBodyState();
    return;
  }

  overlay.classList.remove('hidden');
  modal.classList.remove('hidden');
  syncModalBodyState();

  const runtime = getRuntimeForSession(session) || {};
  const host = getHost(session.hostId);
  const stream = getStreamStatusForSession(session) || {};
  const alerts = getAlertsForSession(session);
  const diagnostics = getDiagnosticsForSession(session);
  const requests = getRequestsForSession(session);
  const pendingRequests = requests.filter((request) => request.status === 'pending');
  requestReceivedFilesForSession(session);

  el('status-window-title').textContent = `${session.title || session.sessionId} status`;
  const summaryGrid = el('status-summary-grid');
  summaryGrid.innerHTML = '';
  const phaseSince = formatElapsedSince(getRuntimeElapsedAnchor(runtime));
  const bridgeSince = formatElapsedSince(getStreamElapsedAnchor(stream) || runtime.runtimeConnectionStartedAt);

  renderStatusSummaryCard(summaryGrid, 'Host', host?.online ? 'Online' : 'Offline', host?.label || session.hostId);
  renderStatusSummaryCard(
    summaryGrid,
    'Bridge',
    prettyStatusLabel(stream.connection || runtime.connection || (session.live ? 'connecting' : 'history only')),
    [
      bridgeSince ? `For ${bridgeSince}` : '',
      stream.lastPingAt ? `Last ping ${formatElapsedSince(stream.lastPingAt) || '0s'} ago` : '',
    ].filter(Boolean).join(' | ')
  );
  renderStatusSummaryCard(
    summaryGrid,
    'Phase',
    prettyStatusLabel(runtime.phase || session.state || 'unknown'),
    runtime.busy
      ? `Busy for ${phaseSince || '0s'}`
      : phaseSince
        ? `Updated ${phaseSince} ago`
        : 'Idle'
  );
  renderStatusSummaryCard(summaryGrid, 'Thread', describeThreadStatus(runtime), runtime.threadId ? shortId(runtime.threadId) : '');
  renderStatusSummaryCard(
    summaryGrid,
    'Turn',
    runtime.activeTurnId ? shortId(runtime.activeTurnId) : 'none',
    runtime.activeTurnId
      ? `${prettyStatusLabel(runtime.currentTurnStatus || 'inProgress')} | ${formatElapsedSince(runtime.turnStartedAt || runtime.updatedAt) || '0s'}`
      : prettyStatusLabel(runtime.currentTurnStatus || 'idle')
  );
  renderStatusSummaryCard(summaryGrid, 'Runner', getRunnerSummary(session).label, runtime.lastCodexError || '');

  const thinkingRecordCount = buildThinkingEntriesForSession(session).reduce((total, segment) => total + (segment.entries?.length || 0), 0);
  el('status-thinking').textContent = thinkingRecordCount
    ? `${thinkingRecordCount} structured thinking record${thinkingRecordCount === 1 ? '' : 's'} are available in the conversation flow.`
    : 'Structured reasoning and plan history, when available, is shown in the conversation flow.';
  el('status-usage').textContent = formatTokenUsage(runtime);
  el('status-rate-limits').textContent = formatRateLimits(runtime);

  const interruptButton = el('interrupt-turn-button');
  const compactButton = el('compact-thread-button');
  const steerInput = el('steer-input');
  const steerSubmitButton = el('steer-submit-button');
  const shellCommandInput = el('shell-command-input');
  const shellCommandSubmitButton = el('shell-command-submit-button');
  interruptButton.disabled = !session.live || !runtime.activeTurnId;
  interruptButton.textContent = runtime.activeTurnId ? 'Interrupt Active Turn' : 'No Active Turn';
  compactButton.disabled = !session.live || !runtime.threadId;
  compactButton.textContent = runtime.threadId ? 'Compact Context' : 'No Thread';
  steerInput.disabled = !session.live || !runtime.activeTurnId;
  steerSubmitButton.disabled = !session.live || !runtime.activeTurnId;
  steerInput.placeholder = runtime.activeTurnId
    ? 'Ask Codex to adjust the current turn without starting over'
    : 'No active turn to steer right now';
  shellCommandInput.disabled = !session.live || !runtime.threadId;
  shellCommandSubmitButton.disabled = !session.live || !runtime.threadId;
  shellCommandInput.placeholder = runtime.threadId
    ? 'Run a shell command inside the current Codex thread context'
    : 'No live Codex thread is attached';

  const requestList = el('status-requests');
  requestList.innerHTML = '';
  if (!requests.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No pending or recent Codex requests for this session.';
    requestList.appendChild(empty);
  } else {
    for (const request of [...requests].reverse()) {
      const item = document.createElement('div');
      item.className = `status-request-card ${request.status === 'pending' ? 'pending' : 'resolved'}`;

      const title = request.title || request.method || request.kind || 'Request';
      const summary = request.summary || request.message || '';
      item.innerHTML = `
        <div class="status-request-top">
          <div class="status-request-title">${title}</div>
          <div class="status-request-badge">${request.status || 'pending'}</div>
        </div>
        <div class="status-request-copy">${summary || 'No summary provided.'}</div>
        <div class="status-request-meta">${request.method || request.kind || 'request'} | ${formatTime(request.updatedAt || request.createdAt)}</div>
      `;

      if (request.payload) {
        const detail = document.createElement('div');
        detail.className = 'status-request-detail';
        detail.textContent = summarizeData(request.payload);
        item.appendChild(detail);
      }

      if (request.status === 'pending') {
        const actions = document.createElement('div');
        actions.className = 'status-request-actions';

        if (request.method === 'item/tool/requestUserInput') {
          const questions = Array.isArray(request.payload?.questions) ? request.payload.questions : [];
          if (questions.length === 1 && Array.isArray(questions[0].options) && questions[0].options.length) {
            for (const option of questions[0].options) {
              const button = document.createElement('button');
              button.type = 'button';
              button.className = 'secondary-button';
              button.textContent = option.label;
              button.onclick = async () => {
                try {
                  await respondToSessionRequest(session, request, buildToolAnswerResponse(questions[0].id, option.label));
                } catch (error) {
                  reportError(error);
                }
              };
              actions.appendChild(button);
            }
          } else {
            const note = document.createElement('div');
            note.className = 'status-request-note';
            note.textContent = 'This request needs a richer input form. The protocol payload is captured and can be wired next.';
            item.appendChild(note);
          }
        } else if (request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval') {
          const options = [
            ['Accept', { decision: 'accept' }],
            ['Allow This Session', { decision: 'acceptForSession' }],
            ['Decline', { decision: 'decline' }],
            ['Cancel Turn', { decision: 'cancel' }],
          ];
          for (const [label, response] of options) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = label === 'Decline' || label === 'Cancel Turn' ? 'secondary-button' : '';
            button.textContent = label;
            button.onclick = async () => {
              try {
                await respondToSessionRequest(session, request, response);
              } catch (error) {
                reportError(error);
              }
            };
            actions.appendChild(button);
          }
        } else if (request.method === 'item/permissions/requestApproval') {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'secondary-button';
          button.textContent = 'Decline Permissions';
          button.onclick = async () => {
            try {
              await respondToSessionRequest(session, request, buildPermissionsDeclineResponse());
            } catch (error) {
              reportError(error);
            }
          };
          actions.appendChild(button);
        }

        if (actions.childElementCount > 0) {
          item.appendChild(actions);
        }
      }

      requestList.appendChild(item);
    }
  }

  const receivedList = el('status-received-files');
  if (receivedList) {
    receivedList.innerHTML = '';
    const receivedFiles = getReceivedFilesForSession(session);
    if (isReceivedFilesLoading(session)) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Loading received files...';
      receivedList.appendChild(empty);
    } else if (!receivedFiles.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No files have been received into the relay cache for this session yet. Open or Save a file card to receive it.';
      receivedList.appendChild(empty);
    } else {
      for (const file of receivedFiles.slice(0, 20)) {
        const item = document.createElement('div');
        item.className = 'status-request-card resolved';
        const openUrl = buildReceivedFileUrl(file, true);
        const saveUrl = buildReceivedFileUrl(file, false);
        const expires = file.expiresAt ? `Expires ${formatTime(file.expiresAt)}` : 'No expiry reported';
        item.innerHTML = `
          <div class="status-request-top">
            <div class="status-request-title">${escapeHtml(file.name || 'received file')}</div>
            <div class="status-request-badge">${escapeHtml(formatBytes(file.size || 0))}</div>
          </div>
          <div class="status-request-copy">${escapeHtml(file.remotePath || '')}</div>
          <div class="status-request-meta">Received ${formatTime(file.receivedAt)} | ${escapeHtml(expires)}</div>
        `;
        const actions = document.createElement('div');
        actions.className = 'status-request-actions';
        const openLink = document.createElement('a');
        openLink.className = 'secondary-button';
        openLink.href = openUrl;
        openLink.target = '_blank';
        openLink.rel = 'noopener';
        openLink.textContent = 'Open';
        const saveLink = document.createElement('a');
        saveLink.className = 'secondary-button';
        saveLink.href = saveUrl;
        saveLink.download = file.name || 'download';
        saveLink.textContent = 'Save';
        actions.appendChild(openLink);
        actions.appendChild(saveLink);
        item.appendChild(actions);
        receivedList.appendChild(item);
      }
    }
  }

  const alertList = el('status-alerts');
  alertList.innerHTML = '';
  if (!alerts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No warnings or errors have been recorded for this session.';
    alertList.appendChild(empty);
  } else {
    for (const alert of [...alerts].reverse().slice(0, 16)) {
      const item = document.createElement('div');
      item.className = `status-alert-card ${alert.severity || 'warning'}`;
      item.innerHTML = `
        <div class="status-alert-top">
          <span>${(alert.severity || 'warning').toUpperCase()}</span>
          <span>${formatTime(alert.timestamp)}</span>
        </div>
        <div class="status-alert-message">${alert.message || ''}</div>
        <div class="status-alert-source">${alert.source || 'runtime'}</div>
      `;
      alertList.appendChild(item);
    }
  }

  const diagnosticsList = el('status-diagnostics');
  diagnosticsList.innerHTML = '';
  if (!diagnostics.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No structured Codex notifications have been captured for this session yet.';
    diagnosticsList.appendChild(empty);
  } else {
    for (const entry of [...diagnostics].reverse().slice(0, 48)) {
      const item = document.createElement('div');
      item.className = `status-diagnostic-card ${entry.severity || 'info'}`;
      item.innerHTML = `
        <div class="status-diagnostic-top">
          <span>${entry.kind || 'event'}</span>
          <span>${formatTime(entry.timestamp)}</span>
        </div>
        <div class="status-diagnostic-method">${entry.method || entry.source || 'codex'}</div>
        <div class="status-diagnostic-message">${entry.message || ''}</div>
        ${entry.detail ? `<div class="status-diagnostic-detail">${entry.detail}</div>` : ''}
        ${entry.data ? `<div class="status-diagnostic-data">${summarizeData(entry.data)}</div>` : ''}
      `;
      diagnosticsList.appendChild(item);
    }
  }

  el('status-window-subtitle').textContent = `${pendingRequests.length} pending request${pendingRequests.length === 1 ? '' : 's'} | ${diagnostics.length} events captured`;
}

function renderPickerEntries(container, entries, emptyText, onSelect) {
  container.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-entry';
    button.innerHTML = `
      <div class="name">${entry.title || entry.name || pathLeaf(entry.path) || entry.path}</div>
      <div class="path">${entry.path}</div>
    `;
    button.onclick = () => onSelect(entry.path);
    container.appendChild(button);
  }
}

function renderPickerChips(container, entries, activePath, onSelect) {
  container.innerHTML = '';

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No root paths were reported by this host.';
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `picker-chip secondary-button ${entry.path === activePath ? 'active' : ''}`.trim();
    button.textContent = entry.name || entry.path;
    button.onclick = () => {
      browseDirectoryPath(entry.path).catch(reportDirectoryPickerError);
    };
    container.appendChild(button);
  }
}

function renderDirectoryPicker() {
  const overlay = el('directory-picker-overlay');
  const picker = el('directory-picker');
  const host = getHost(state.selectedHostId);
  const pickerHost = el('picker-host');
  const pickerStatus = el('picker-status');
  const pickerCurrentPath = el('picker-current-path');
  const upButton = el('picker-up-button');
  const refreshButton = el('picker-refresh-button');
  const selectButton = el('picker-select-button');

  if (!state.directoryPicker.open) {
    overlay.classList.add('hidden');
    picker.classList.add('hidden');
    syncModalBodyState();
    return;
  }

  overlay.classList.remove('hidden');
  picker.classList.remove('hidden');
  syncModalBodyState();
  pickerHost.textContent = host ? host.label : 'No host selected';
  pickerCurrentPath.textContent = state.directoryPicker.currentPath || '(pick a root or recent directory)';

  if (!host) {
    pickerStatus.textContent = 'Choose a host first, then browse directories on that machine.';
  } else if (state.directoryPicker.loading) {
    pickerStatus.textContent = 'Loading directories from the selected host...';
  } else if (state.directoryPicker.error) {
    pickerStatus.textContent = state.directoryPicker.error;
  } else {
    pickerStatus.textContent = 'Tap a folder to enter it, then use the current directory.';
  }

  upButton.disabled = state.directoryPicker.loading || !state.directoryPicker.parentPath;
  refreshButton.disabled = state.directoryPicker.loading || !host;
  selectButton.disabled = state.directoryPicker.loading || !state.directoryPicker.currentPath;

  renderPickerChips(
    el('picker-roots'),
    state.directoryPicker.roots,
    state.directoryPicker.currentPath,
    (targetPath) => {
      browseDirectoryPath(targetPath).catch(reportDirectoryPickerError);
    }
  );

  renderPickerEntries(
    el('picker-recents'),
    host ? getRecentDirectories(host.hostId) : [],
    'No recent workspace paths were discovered for this host yet.',
    (targetPath) => {
      browseDirectoryPath(targetPath).catch(reportDirectoryPickerError);
    }
  );

  renderPickerEntries(
    el('picker-directories'),
    state.directoryPicker.directories,
    state.directoryPicker.loading
      ? 'Loading...'
      : 'This folder does not have any visible subdirectories.',
    (targetPath) => {
      browseDirectoryPath(targetPath).catch(reportDirectoryPickerError);
    }
  );
}

function buildThinkingMessageElement(session, segment, runtime, stream, isLivePlaceholder = false) {
  const keyBase = getSessionKey(session) || session.sessionId || 'session';
  const stateKey = `${keyBase}::thinking::${segment?.userTimestamp || 'live'}`;
  const details = document.createElement('details');
  details.className = 'thinking-card';
  const defaultOpen = isLivePlaceholder || !segment?.entries?.length;
  if (state.thinkingPanels.has(stateKey) ? state.thinkingPanels.get(stateKey) : defaultOpen) {
    details.open = true;
  }

  details.addEventListener('toggle', () => {
    state.thinkingPanels.set(stateKey, details.open);
  });

  const entries = Array.isArray(segment?.entries) ? segment.entries : [];
  const preview = entries.length
    ? entries[entries.length - 1].text
    : `Codex is ${prettyStatusLabel(runtime.phase || 'thinking').toLowerCase()}...`;
  const meta = entries.length
    ? `${entries.length} record${entries.length === 1 ? '' : 's'}`
    : `${prettyStatusLabel(stream.connection || runtime.connection || 'connected')} | ${prettyStatusLabel(runtime.currentTurnStatus || runtime.phase || 'thinking')}`;

  details.innerHTML = `
    <summary class="thinking-summary">
      <div class="thinking-title-row">
        <div class="thinking-title">Thinking</div>
        <div class="thinking-phase">${entries.length ? `${entries.length} step${entries.length === 1 ? '' : 's'}` : 'Live'}</div>
      </div>
      <div class="thinking-preview">${limitText(preview, 180)}</div>
      <div class="thinking-note">${meta}</div>
    </summary>
  `;

  const content = document.createElement('div');
  content.className = 'thinking-content';

  if (entries.length) {
    const history = document.createElement('div');
    history.className = 'thinking-history-list';
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'thinking-history-item';
      item.innerHTML = `
        <div class="thinking-history-top">
          <span class="thinking-history-kind">${prettyStatusLabel(entry.kind || 'thinking')}</span>
          <span>${formatTime(entry.timestamp)}</span>
        </div>
        <div class="thinking-history-text">${entry.text}</div>
      `;
      history.appendChild(item);
    }
    content.appendChild(history);
  } else {
    const block = document.createElement('div');
    block.className = 'thinking-block';
    block.innerHTML = `
      <div class="thinking-label">Live Turn</div>
      <div class="thinking-text">Codex is still working on this turn. Structured reasoning or plan records have not arrived yet.</div>
    `;
    content.appendChild(block);
  }

  details.appendChild(content);

  const wrapper = document.createElement('div');
  wrapper.className = 'message thinking';

  const metaEl = document.createElement('div');
  metaEl.className = 'message-meta';
  metaEl.textContent = `Codex thinking ${segment?.userTimestamp ? formatTime(segment.userTimestamp) : ''}`.trim();
  wrapper.appendChild(metaEl);
  wrapper.appendChild(details);
  return wrapper;
}

function renderFileCards(container, session, entry) {
  const files = getTranscriptFileRefs(entry);
  if (!session || !files.length) {
    return;
  }

  const list = document.createElement('div');
  list.className = 'message-file-list';
  for (const file of files.slice(0, 8)) {
    if (!file.path) {
      continue;
    }
    const card = document.createElement('div');
    card.className = `message-file-card ${isImageFileRef(file) ? 'image' : ''}`.trim();
    const inlineUrl = buildHostFileUrl(session, file, true);
    const downloadUrl = buildHostFileUrl(session, file, false);
    const name = file.name || basename(file.path) || 'remote file';
    const meta = [
      file.mime || (isImageFileRef(file) ? 'image' : 'file'),
      file.size ? formatBytes(file.size) : '',
      'received on first open/save',
    ].filter(Boolean).join(' | ');

    if (isImageFileRef(file)) {
      const preview = document.createElement('img');
      preview.className = 'message-file-preview';
      preview.loading = 'lazy';
      preview.alt = name;
      preview.src = inlineUrl;
      card.appendChild(preview);
    }

    const body = document.createElement('div');
    body.className = 'message-file-body';
    body.innerHTML = `
      <div class="message-file-name">${escapeHtml(name)}</div>
      <div class="message-file-path">${escapeHtml(file.path)}</div>
      <div class="message-file-meta">${escapeHtml(meta || 'remote file')}</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'message-file-actions';
    const openLink = document.createElement('a');
    openLink.className = 'secondary-button';
    openLink.href = inlineUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    openLink.textContent = 'Open';
    const saveLink = document.createElement('a');
    saveLink.className = 'secondary-button';
    saveLink.href = downloadUrl;
    saveLink.download = name;
    saveLink.textContent = 'Save';
    actions.appendChild(openLink);
    actions.appendChild(saveLink);
    body.appendChild(actions);
    card.appendChild(body);
    list.appendChild(card);
  }

  if (list.childElementCount) {
    container.appendChild(list);
  }
}

function renderTranscript(session = getSelectedSession()) {
  const log = el('session-log');
  log.innerHTML = '';

  if (!session) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select a conversation on the left to inspect it here.';
    log.appendChild(empty);
    return;
  }

  const transcript = getTranscriptForSession(session);
  const visibleTranscript = transcript.filter((entry) => entry.speaker === 'user' || entry.speaker === 'agent' || entry.speaker === 'assistant');
  const thinkingSegments = buildThinkingEntriesForSession(session);
  const thinkingByUserTimestamp = new Map(thinkingSegments.map((segment) => [segment.userTimestamp || '', segment]));
  const runtime = getRuntimeForSession(session) || {};
  const stream = getStreamStatusForSession(session) || {};
  const latestUserEntry = [...visibleTranscript].reverse().find((entry) => entry.speaker === 'user') || null;
  if (!visibleTranscript.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = session.source === 'managed'
      ? 'Waiting for the managed session transcript...'
      : 'No transcript preview was captured for this imported session.';
    log.appendChild(empty);
    return;
  }

  for (const entry of visibleTranscript) {
    const message = document.createElement('div');
    const speaker = entry.speaker === 'assistant' ? 'agent' : entry.speaker;
    message.className = `message ${speaker || 'agent'}`;

    if (speaker !== 'system') {
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.textContent = `${speaker === 'user' ? 'You' : 'Codex'} ${formatTime(entry.timestamp)}`.trim();
      message.appendChild(meta);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = entry.text || '';
    message.appendChild(bubble);
    renderFileCards(message, session, entry);

    log.appendChild(message);

    if (speaker === 'user') {
      const segment = thinkingByUserTimestamp.get(entry.timestamp || '') || null;
      const isLatestUser = latestUserEntry && latestUserEntry.timestamp === entry.timestamp && latestUserEntry.text === entry.text;
      const shouldShowLivePlaceholder = Boolean(
        isLatestUser
        && session.live
        && (runtime.busy || runtime.phase === 'thinking' || runtime.phase === 'planning' || runtime.phase === 'waiting-approval' || runtime.phase === 'waiting-user-input')
      );

      if (segment || shouldShowLivePlaceholder) {
        log.appendChild(buildThinkingMessageElement(session, segment, runtime, stream, shouldShowLivePlaceholder && !segment));
      }
    }
  }

  log.scrollTop = log.scrollHeight;
}

function renderAll() {
  renderAuthGate();
  const sidebar = document.querySelector('.sidebar');
  sidebar?.classList.toggle('overview-collapsed', state.overviewCollapsed);
  el('overview-body')?.classList.toggle('hidden', state.overviewCollapsed);
  el('new-session-body')?.classList.toggle('hidden', state.newSessionCollapsed);
  const overviewButton = el('toggle-overview-button');
  const newSessionButton = el('toggle-new-session-button');
  if (overviewButton) {
    overviewButton.textContent = state.overviewCollapsed ? 'Show' : 'Hide';
  }
  if (newSessionButton) {
    newSessionButton.textContent = state.newSessionCollapsed ? 'Show New' : 'Hide New';
  }
  renderOverview();
  renderHostNav();
  renderConversationNav();
  renderSessionDetails();
  renderRuntimePanel();
  renderThinkingPanel();
  renderAlertsWindow();
  renderStatusWindow();
  renderDirectoryPicker();
  renderSlashMenu();
}

function closeStream() {
  if (state.eventSource) {
    if (state.eventSourceKey) {
      state.streamStatus.set(state.eventSourceKey, {
        ...(state.streamStatus.get(state.eventSourceKey) || {}),
        connection: 'closed',
      });
    }
    state.eventSource.close();
    state.eventSource = null;
    state.eventSourceKey = null;
  }
}

function updateSelectedViews(session) {
  if (!session || session.hostId !== state.selectedHostId) {
    return;
  }

  renderConversationNav();
  renderSessionDetails();
  renderRuntimePanel();
  renderThinkingPanel();
  renderAlertsWindow();
  renderStatusWindow();
}

function subscribeSession(session) {
  const key = getSessionKey(session);
  if (!key || state.eventSourceKey === key) {
    return;
  }

  closeStream();

  const url = `/api/sessions/${encodeURIComponent(session.sessionId)}/events?hostId=${encodeURIComponent(session.hostId)}`;
  state.eventSource = new EventSource(url);
  state.eventSourceKey = key;
  setStreamStatusForSession(session.hostId, session.sessionId, {
    connection: 'connecting',
    lastPingAt: null,
  });
  renderRuntimePanel();
  renderThinkingPanel();

  state.eventSource.addEventListener('open', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: 'connected',
    });
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('ready', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: 'connected',
      lastPingAt: new Date().toISOString(),
    });
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('ping', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: 'connected',
      lastPingAt: new Date().toISOString(),
    });
    renderRuntimePanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('error', () => {
    setStreamStatusForSession(session.hostId, session.sessionId, {
      connection: session.live ? 'reconnecting' : 'disconnected',
    });
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.snapshot', (event) => {
    const payload = JSON.parse(event.data);
    mergeSession(payload);
    if (payload.bridgeSessionId && state.selectedSessionId === payload.bridgeSessionId) {
      state.selectedSessionId = payload.sessionId;
    }
    updateSelectedViews(payload);
  });

  state.eventSource.addEventListener('session.started', (event) => {
    const payload = JSON.parse(event.data);
    mergeSession(payload);
    if (payload.bridgeSessionId && state.selectedSessionId === payload.bridgeSessionId) {
      state.selectedSessionId = payload.sessionId;
    }
    renderAll();
  });

  state.eventSource.addEventListener('session.state_changed', (event) => {
    const payload = JSON.parse(event.data);
    mergeSession(payload);
    renderAll();
  });

  state.eventSource.addEventListener('session.transcript', (event) => {
    const payload = JSON.parse(event.data);
    appendTranscriptEntry(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === key) {
      renderTranscript(selected);
      renderThinkingPanel();
    }
  });

  state.eventSource.addEventListener('session.alert', (event) => {
    const payload = JSON.parse(event.data);
    appendAlertForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    if ((payload.severity || 'warning') === 'error') {
      state.alertWindowOpen = true;
    }
    renderSessionDetails();
    renderAlertsWindow();
  });

  state.eventSource.addEventListener('session.runtime', (event) => {
    const payload = JSON.parse(event.data);
    patchRuntimeForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    renderSessionDetails();
    renderRuntimePanel();
    renderThinkingPanel();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.diagnostic', (event) => {
    const payload = JSON.parse(event.data);
    appendDiagnosticForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.request', (event) => {
    const payload = JSON.parse(event.data);
    upsertRequestForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    state.statusWindowOpen = true;
    renderSessionDetails();
    renderApprovalPopup();
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.request.resolved', (event) => {
    const payload = JSON.parse(event.data);
    resolveRequestForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    renderSessionDetails();
    renderApprovalPopup();
    renderStatusWindow();
  });
}

async function showSession(session = getSelectedSession()) {
  renderSessionDetails();
  renderRuntimePanel();
  renderThinkingPanel();
  renderTranscript(session);

  if (!session) {
    closeStream();
    return;
  }

  if (session.live || session.source === 'managed') {
    subscribeSession(session);
  } else {
    closeStream();
  }

  try {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/detail?hostId=${encodeURIComponent(session.hostId)}`);
    mergeSession(detail.session);
    const existing = getTranscriptForSession(session);
    setTranscriptForSession(session.hostId, session.sessionId, [...detail.transcript, ...existing]);
    setAlertsForSession(session.hostId, session.sessionId, detail.alerts || []);
    setRuntimeForSession(session.hostId, session.sessionId, detail.runtime || null);
    setDiagnosticsForSession(session.hostId, session.sessionId, detail.diagnostics || []);
    setRequestsForSession(session.hostId, session.sessionId, detail.requests || []);

    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === getSessionKey(session)) {
      renderSessionDetails();
      renderRuntimePanel();
      renderThinkingPanel();
      renderAlertsWindow();
      renderStatusWindow();
      renderTranscript(selected);
    }
  } catch (error) {
    appendAlertForSession(session.hostId, session.sessionId, {
      severity: 'error',
      source: 'ui',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
    state.alertWindowOpen = true;

    const selected = getSelectedSession();
    if (selected && getSessionKey(selected) === getSessionKey(session)) {
      renderSessionDetails();
      renderRuntimePanel();
      renderThinkingPanel();
      renderAlertsWindow();
      renderStatusWindow();
    }
  }
}

function applySelectedHost(hostId) {
  if (state.selectedHostId === hostId) {
    return;
  }

  state.selectedHostId = hostId;
  state.selectedConversationKey = null;
  state.selectedSessionId = null;
  ensureSelections();
  renderAll();
  if (state.directoryPicker.open) {
    fetchDirectoryListing(null, hostId).catch(reportDirectoryPickerError);
  }
  showSession().catch(reportError);
}

async function refreshHostAndConnectorSnapshots() {
  const [hostsResponse, connectorsResponse] = await Promise.all([
    fetchJson('/api/hosts'),
    fetchJson('/api/connectors'),
  ]);
  state.hosts = hostsResponse.hosts || [];
  state.dismissedHosts = hostsResponse.dismissedHosts || [];
  state.connectors = connectorsResponse.connectors || [];
  renderAll();
}

async function waitForRecoveredHost(hostId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    await refreshHostAndConnectorSnapshots();
    const host = getHost(hostId);
    if (host?.online) {
      try {
        return await verifyHostAvailable(hostId);
      } catch (error) {
        lastError = error;
      }
    } else {
      lastError = new Error(`Host ${host?.label || hostId} is still offline after connector restart.`);
    }
    await delay(1500);
  }

  throw lastError || new Error(`Timed out while waiting for host ${hostId} to reconnect.`);
}

async function recoverHostForSwitch(hostId, cause) {
  const connector = getConnectorForHost(hostId);
  if (!connector) {
    return false;
  }

  const host = getHost(hostId);
  state.connectorActionResults.set(connector.connectorId, {
    ok: false,
    status: 'recovering_host',
    message: `${host?.label || hostId} is not ready: ${cause?.message || 'health check failed'}. Starting connector ${connector.label || connector.connectorId}...`,
  });
  renderConnectorManager();

  const result = await executeConnectorAction(connector, 'bootstrap', connector, {
    refreshAfter: false,
    selectEditor: false,
    reportMissing: false,
  });
  if (!result) {
    throw new Error(`Recovery for ${host?.label || hostId} was cancelled.`);
  }
  if (!result.ok) {
    throw new Error(`Host ${host?.label || hostId} is unavailable, and connector ${connector.label || connector.connectorId} could not restart it:\n${connectorActionResultSummary(result)}`);
  }

  await waitForRecoveredHost(hostId);
  await refresh();
  return true;
}

async function ensureHostAvailable(hostId) {
  try {
    return await verifyHostAvailable(hostId);
  } catch (error) {
    const recovered = await recoverHostForSwitch(hostId, error);
    if (recovered) {
      return { ok: true, mode: 'connector-recovered' };
    }
    throw error;
  }
}

async function setSelectedHost(hostId, options = {}) {
  if (state.selectedHostId === hostId) {
    return;
  }

  const verify = options.verify !== false;
  state.hostSwitchBusyId = hostId;
  renderAll();

  try {
    if (verify) {
      await ensureHostAvailable(hostId);
    }
    applySelectedHost(hostId);
  } finally {
    state.hostSwitchBusyId = null;
    renderAll();
  }
}

function setSessionSearchQuery(query) {
  state.sessionSearchQuery = String(query || '').trim();
  renderAll();
}

function setSessionSearchMode(mode) {
  state.sessionSearchMode = ['keyword', 'path', 'title'].includes(mode) ? mode : 'keyword';
  renderAll();
}

async function selectConversation(conversation) {
  if (!conversation) {
    return;
  }

  if (state.selectedHostId !== conversation.hostId) {
    await ensureHostAvailable(conversation.hostId);
  }

  state.selectedHostId = conversation.hostId;
  state.selectedConversationKey = conversation.conversationKey;
  state.selectedSessionId = conversation.preferredSession?.sessionId || null;
  renderAll();
  showSession().catch(reportError);
}

async function selectSession(session) {
  if (!session) {
    return;
  }

  if (state.selectedHostId !== session.hostId) {
    await ensureHostAvailable(session.hostId);
  }

  state.selectedHostId = session.hostId;
  state.selectedConversationKey = session.conversationKey || session.originSessionId || session.sessionId;
  state.selectedSessionId = session.sessionId;
  renderAll();
  showSession(session).catch(reportError);
}

async function refresh() {
  if (!authAllowsRequests()) {
    renderAuthGate();
    return;
  }

  const previousKey = getSessionKey(getSelectedSession());

  const [stats, hostsResponse, connectorsResponse, collectionsResponse] = await Promise.all([
    fetchJson('/api/stats'),
    fetchJson('/api/hosts'),
    fetchJson('/api/connectors'),
    fetchJson('/api/session-collections'),
  ]);

  state.stats = stats;
  state.hosts = hostsResponse.hosts || [];
  state.dismissedHosts = hostsResponse.dismissedHosts || [];
  state.connectors = connectorsResponse.connectors || [];
  state.sessionCollections = collectionsResponse.collections || [];
  if (!state.sessionCollections.some((collection) => collection.collectionId === state.selectedCollectionId)) {
    state.selectedCollectionId = state.sessionCollections[0]?.collectionId || 'default';
  }

  const sessionResponses = await Promise.all(
    state.hosts.map((host) => fetchJson(`/api/hosts/${encodeURIComponent(host.hostId)}/sessions`))
  );

  state.sessions = [];
  sessionResponses.forEach((response) => {
    (response.sessions || []).forEach((session) => state.sessions.push(session));
  });

  if (state.connectorEditorId && !getConnector(state.connectorEditorId)) {
    state.connectorEditorId = null;
  }

  ensureSelections();
  renderAll();

  if (state.directoryPicker.open && !getHost(state.selectedHostId || '')) {
    setDirectoryPickerState({
      hostId: null,
      currentPath: '',
      parentPath: null,
      roots: [],
      directories: [],
      loading: false,
      error: 'The selected host is no longer available for browsing.',
    });
  }

  const selected = getSelectedSession();
  const nextKey = getSessionKey(selected);
  if (!nextKey) {
    closeStream();
    renderTranscript(null);
    return;
  }

  const needsStream = Boolean(selected.live || selected.source === 'managed');
  const streamMismatch = needsStream ? state.eventSourceKey !== nextKey : Boolean(state.eventSourceKey);
  if (nextKey !== previousKey || !state.transcripts.has(nextKey) || streamMismatch) {
    await showSession(selected);
  } else {
    renderTranscript(selected);
  }
}

async function waitForSession(hostId, sessionId, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastSession = null;
  while (Date.now() < deadline) {
    const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/sessions`);
    const session = (response.sessions || []).find((item) => item.sessionId === sessionId || item.bridgeSessionId === sessionId) || null;
    lastSession = session || lastSession;
    if (session && predicate(session)) {
      return session;
    }
    await sleep(400);
  }

  const stateText = lastSession?.state ? ` Last state: ${lastSession.state}.` : '';
  throw new Error(`Timed out while waiting for the live session to start.${stateText}`);
}

async function waitForSessionReady(hostId, sessionId, timeoutMs = 60000) {
  return waitForSession(
    hostId,
    sessionId,
    (session) => session.live === true || String(session.state || '').startsWith('failed') || String(session.state || '').startsWith('exited'),
    timeoutMs
  );
}

async function importHost(hostId) {
  await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/import`, { method: 'POST' });
  await refresh();
}

async function importHostById(hostId) {
  const response = await fetchJson('/api/hosts/import', {
    method: 'POST',
    body: JSON.stringify({ hostId }),
  });

  await refresh();
  if (response?.host?.hostId) {
    await setSelectedHost(response.host.hostId);
  }
}

async function deleteHost(hostId) {
  await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });

  if (state.selectedHostId === hostId) {
    state.selectedHostId = null;
    state.selectedConversationKey = null;
    state.selectedSessionId = null;
  }

  for (const key of Array.from(state.transcripts.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.transcripts.delete(key);
    }
  }

  for (const key of Array.from(state.alerts.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.alerts.delete(key);
    }
  }

  for (const key of Array.from(state.runtime.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.runtime.delete(key);
    }
  }

  for (const key of Array.from(state.diagnostics.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.diagnostics.delete(key);
    }
  }

  for (const key of Array.from(state.requests.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.requests.delete(key);
    }
  }

  for (const key of Array.from(state.streamStatus.keys())) {
    if (key.startsWith(`${hostId}::`)) {
      state.streamStatus.delete(key);
    }
  }

  closeStream();
  await refresh();
}

async function saveConnectorProfile(payload = readConnectorForm()) {
  if (!payload.label) {
    reportError(new Error('Connector label is required.'));
    return null;
  }

  const connectorId = payload.connectorId;
  const response = connectorId
    ? await fetchJson(`/api/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    : await fetchJson('/api/connectors', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

  await refresh();
  state.connectorEditorId = response?.connector?.connectorId || connectorId || null;
  renderConnectorManager();
  return response?.connector || null;
}

async function deleteSelectedConnector() {
  const connectorId = el('connector-id').value.trim() || state.connectorEditorId;
  if (!connectorId) {
    return;
  }

  await fetchJson(`/api/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'DELETE',
  });

  state.connectorEditorId = null;
  await refresh();
  renderConnectorManager();
}

async function copyConnectorBootstrapCommand() {
  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  const command = connector?.plan?.bootstrapCommand || '';
  if (!command) {
    return;
  }

  await navigator.clipboard.writeText(command);
}

async function copyConnectorLoginCommand() {
  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  const command = connector?.plan?.sshLoginCommand || '';
  if (!command) {
    return;
  }

  await navigator.clipboard.writeText(command);
}

async function copyConnectorSmokeCommand() {
  const connector = state.connectorEditorId ? getConnector(state.connectorEditorId) : null;
  const command = connector?.plan?.sshSmokeTestCommand || '';
  if (!command) {
    return;
  }

  await navigator.clipboard.writeText(command);
}

function connectorNeedsOneTimePrompt(method, otpSource, context = {}) {
  const normalized = String(method || '').trim();
  if (normalized === 'otp' || normalized === 'manual_captcha') {
    return true;
  }
  if (normalized === 'keyboard_interactive' && String(context.keyPath || '').trim()) {
    return true;
  }
  return Boolean(String(otpSource || '').trim())
    && (normalized === 'password' || normalized === 'keyboard_interactive');
}

function connectorOneTimePromptName(method) {
  return method === 'manual_captcha' ? 'captcha / manual challenge response' : 'OTP / MFA code';
}

function promptConnectorOneTimeCode(scope, method, otpSource, action, options = {}) {
  const promptName = connectorOneTimePromptName(method);
  const actionLabel = {
    smoke_test: 'Test',
    status: 'Status',
    bootstrap: 'Start Agent',
    restart: 'Restart Agent',
    diagnose: 'Diagnose',
    logs: 'Logs',
  }[action] || action || 'SSH';
  const sourceNote = String(otpSource || '').trim()
    ? `\nSource/notes: ${String(otpSource || '').trim()}`
    : '';
  const retryNote = options.retry
    ? `\n\nPrevious authentication failed. The code may have expired; enter a fresh one.`
    : '';
  const attemptNote = options.maxAttempts && options.attempt
    ? `\nAttempt ${options.attempt} of ${options.maxAttempts}.`
    : '';
  const value = window.prompt(
    `${scope} requires a current ${promptName} for ${actionLabel}.${sourceNote}${retryNote}${attemptNote}\n\nThis code is sent once and is not saved.`
  );
  if (value === null) {
    return null;
  }
  const code = String(value).trim();
  if (!code) {
    throw new Error(`${scope} ${promptName} is required for this connector action.`);
  }
  return code;
}

function connectorActionUsesOneTimeCode(payload) {
  const gatewayMethod = payload.gateway?.authMethod || 'ssh_key';
  const targetMethod = payload.auth?.method || 'ssh_key';
  return Boolean(
    (payload.gateway?.enabled && connectorNeedsOneTimePrompt(gatewayMethod, payload.gateway?.otpSource))
    || connectorNeedsOneTimePrompt(targetMethod, payload.auth?.otpSource, {
      keyPath: payload.auth?.keyPath || '',
    })
  );
}

function collectConnectorActionSecrets(payload, action, promptOptions = {}) {
  const secrets = { ...(payload.secrets || {}) };
  const gatewayMethod = payload.gateway?.authMethod || 'ssh_key';
  const targetMethod = payload.auth?.method || 'ssh_key';
  const passthrough = Boolean(promptOptions.interactivePassthrough);

  if (
    payload.gateway?.enabled
    && connectorNeedsOneTimePrompt(gatewayMethod, payload.gateway?.otpSource)
    && !(passthrough && gatewayMethod === 'keyboard_interactive')
  ) {
    const gatewayOtp = promptConnectorOneTimeCode('Gateway', gatewayMethod, payload.gateway?.otpSource, action, promptOptions);
    if (gatewayOtp === null) {
      return null;
    }
    secrets.gatewayOtp = gatewayOtp;
  }

  if (connectorNeedsOneTimePrompt(targetMethod, payload.auth?.otpSource, {
    keyPath: payload.auth?.keyPath || '',
  }) && !(passthrough && targetMethod === 'keyboard_interactive')) {
    const targetOtp = promptConnectorOneTimeCode('Target', targetMethod, payload.auth?.otpSource, action, promptOptions);
    if (targetOtp === null) {
      return null;
    }
    secrets.targetOtp = targetOtp;
  }

  return secrets;
}

function connectorActionFailureText(result) {
  const chunks = [
    result?.status,
    result?.message,
    result?.stdout,
    result?.stderr,
    result?.error,
    result?.deploy?.status,
    result?.deploy?.message,
  ];
  for (const step of result?.deploy?.steps || []) {
    chunks.push(step?.name, step?.stdout, step?.stderr, step?.error);
  }
  return chunks.filter(Boolean).join('\n').toLowerCase();
}

function shouldRetryConnectorOneTimeCode(payload, result) {
  if (!result || result.ok || !connectorActionUsesOneTimeCode(payload)) {
    return false;
  }
  const text = connectorActionFailureText(result);
  return /permission denied.*keyboard-interactive|keyboard-interactive.*permission denied|verification|authenticator|passcode|otp|mfa|token|connection closed/.test(text);
}

function updateConnectorFromActionResult(connectorId, result) {
  if (!result?.connector) {
    return;
  }
  const index = state.connectors.findIndex((item) => item.connectorId === connectorId);
  if (index >= 0) {
    state.connectors[index] = result.connector;
  }
}

function connectorActionResultSummary(result) {
  if (!result) {
    return 'No connector action result was returned.';
  }
  return [
    result.message,
    result.error,
    result.stderr,
    result.deploy?.message,
  ].filter(Boolean).join('\n') || result.status || 'Connector action failed.';
}

function makeConnectorAskpassContext() {
  return {
    actionId: makeClientId(),
    token: `${makeClientId()}-${makeClientId()}`,
  };
}

async function answerConnectorAskpassPrompt(connectorId, askpass, prompt, answer) {
  await fetchJson(`/api/connectors/${encodeURIComponent(connectorId)}/action-prompts/${encodeURIComponent(prompt.promptId)}`, {
    method: 'POST',
    body: JSON.stringify({
      actionId: askpass.actionId,
      token: askpass.token,
      cancel: answer === null,
      response: answer === null ? '' : String(answer),
    }),
  });
}

async function watchConnectorAskpassPrompts(connectorId, askpass, control) {
  const seen = new Set();
  while (!control.done) {
    try {
      const result = await fetchJson(
        `/api/connectors/${encodeURIComponent(connectorId)}/action-prompts?actionId=${encodeURIComponent(askpass.actionId)}&token=${encodeURIComponent(askpass.token)}`
      );
      for (const prompt of result.prompts || []) {
        if (!prompt?.promptId || seen.has(prompt.promptId)) {
          continue;
        }
        seen.add(prompt.promptId);
        const answer = window.prompt(
          `SSH is asking for input:\n\n${prompt.prompt || 'Authentication prompt'}\n\nType the exact response for this prompt. It is sent once and is not saved.`
        );
        await answerConnectorAskpassPrompt(connectorId, askpass, prompt, answer);
        if (answer === null) {
          control.cancelled = true;
          control.done = true;
          return;
        }
      }
    } catch (_) {
      // The action may not be registered yet, or it may have just finished.
    }
    await delay(500);
  }
}

async function executeConnectorAction(connector, action, payload = connector, options = {}) {
  if (!connector?.connectorId) {
    if (options.reportMissing !== false) {
      reportError(new Error('Save or select an HPC connector first.'));
    }
    return null;
  }

  state.connectorActionBusy = {
    connectorId: connector.connectorId,
    action,
  };
  renderConnectorManager();

  try {
    const usePromptPassthrough = true;
    const maxAttempts = usePromptPassthrough ? 1 : connectorActionUsesOneTimeCode(payload) ? 3 : 1;
    let lastResult = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let actionSecrets = null;
      try {
        actionSecrets = collectConnectorActionSecrets(payload, action, {
          retry: attempt > 1,
          attempt,
          maxAttempts,
          interactivePassthrough: usePromptPassthrough,
        });
      } catch (error) {
        reportError(error);
        return lastResult;
      }
      if (!actionSecrets) {
        return lastResult;
      }

      const askpass = makeConnectorAskpassContext();
      const promptControl = { done: false };
      const promptWatcher = watchConnectorAskpassPrompts(connector.connectorId, askpass, promptControl);
      let result = null;
      try {
        result = await fetchJson(`/api/connectors/${encodeURIComponent(connector.connectorId)}/actions`, {
          method: 'POST',
          body: JSON.stringify({
            action,
            clientOrigin: window.location.origin,
            secrets: actionSecrets,
            askpass,
          }),
        });
      } finally {
        promptControl.done = true;
        promptWatcher.catch(() => {});
      }
      lastResult = result;
      state.connectorActionResults.set(connector.connectorId, result);
      updateConnectorFromActionResult(connector.connectorId, result);
      renderConnectorManager();

      const shouldRetry = !promptControl.cancelled
        && attempt < maxAttempts
        && shouldRetryConnectorOneTimeCode(payload, result);
      if (!shouldRetry) {
        if (options.refreshAfter !== false) {
          await refresh();
        }
        if (options.selectEditor !== false) {
          state.connectorEditorId = connector.connectorId;
        }
        renderConnectorManager();
        return result;
      }

      state.connectorActionResults.set(connector.connectorId, {
        ...result,
        ok: false,
        status: 'auth_retry',
        message: `${result.message || 'Authentication failed.'} Requesting a fresh OTP and retrying...`,
      });
      renderConnectorManager();
    }
    return lastResult;
  } finally {
    state.connectorActionBusy = null;
    renderConnectorManager();
  }
}

async function runConnectorAction(action) {
  const payload = readConnectorForm();
  const savedConnector = await saveConnectorProfile(payload);
  return executeConnectorAction(savedConnector?.connectorId ? savedConnector : null, action, payload, {
    refreshAfter: true,
    selectEditor: true,
  });
}

function getOriginSessionId(session) {
  return session.originSessionId || session.conversationKey || session.sessionId;
}

function pathLeaf(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || text;
}

function setDirectoryPickerState(patch) {
  state.directoryPicker = {
    ...state.directoryPicker,
    ...patch,
  };
  renderDirectoryPicker();
}

function reportDirectoryPickerError(error) {
  setDirectoryPickerState({
    loading: false,
    error: error.message,
  });
}

async function fetchDirectoryListing(targetPath = null, hostId = state.selectedHostId) {
  if (!hostId) {
    setDirectoryPickerState({
      open: true,
      hostId: null,
      currentPath: '',
      parentPath: null,
      roots: [],
      directories: [],
      loading: false,
      error: 'Select a host before browsing its directories.',
    });
    return null;
  }

  setDirectoryPickerState({
    open: true,
    hostId,
    loading: true,
    error: null,
  });

  const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
  const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/directories${query}`);
  setDirectoryPickerState({
    open: true,
    hostId,
    currentPath: response.currentPath || '',
    parentPath: response.parentPath || null,
    roots: Array.isArray(response.roots) ? response.roots : [],
    directories: Array.isArray(response.directories) ? response.directories : [],
    loading: false,
    error: null,
  });
  return response;
}

async function openDirectoryPicker() {
  const seedPath = String(el('new-session-cwd').value || '').trim()
    || getSelectedSession()?.cwd
    || state.directoryPicker.currentPath
    || null;
  await fetchDirectoryListing(seedPath);
}

function closeDirectoryPicker() {
  setDirectoryPickerState({ open: false, loading: false, error: null });
}

async function browseDirectoryPath(targetPath) {
  const normalized = String(targetPath || '').trim();
  await fetchDirectoryListing(normalized || null);
}

function applyPickedDirectory() {
  if (!state.directoryPicker.currentPath) {
    return;
  }

  el('new-session-cwd').value = state.directoryPicker.currentPath;
  if (!el('new-session-label').value.trim()) {
    el('new-session-label').value = pathLeaf(state.directoryPicker.currentPath);
  }
  closeDirectoryPicker();
}

function setAlertWindowOpen(open) {
  state.alertWindowOpen = Boolean(open);
  renderAlertsWindow();
}

function toggleAlertWindow() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  setAlertWindowOpen(!state.alertWindowOpen);
}

function setStatusWindowOpen(open) {
  state.statusWindowOpen = Boolean(open);
  renderStatusWindow();
}

function toggleStatusWindow() {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  setStatusWindowOpen(!state.statusWindowOpen);
}

async function joinLiveSession() {
  const conversation = getSelectedConversation();
  const liveSession = getLiveSessionForConversation(conversation);
  if (!liveSession) {
    return;
  }
  await selectSession(liveSession);
}

async function startManagedSession(options = {}) {
  const sourceSession = Object.prototype.hasOwnProperty.call(options, 'session')
    ? options.session
    : getSelectedSession();
  const conversation = getSelectedConversation();
  const launchMode = options.launchMode || (sourceSession ? 'resume' : 'fresh');
  const hostId = options.hostId || sourceSession?.hostId || state.selectedHostId;
  const cwd = String(options.cwd || sourceSession?.cwd || '').trim();
  const label = String(options.label || sourceSession?.title || pathLeaf(cwd) || cwd || '').trim();
  const host = hostId ? getHost(hostId) : null;

  if (!hostId) {
    reportError(new Error('Select a host before starting a managed session.'));
    return null;
  }
  if (host && !host.online) {
    throw new Error(`Host ${host.label || host.hostId} is offline. Start its agent first, then try again.`);
  }

  if (!cwd) {
    reportError(new Error('No workspace path is available for this conversation.'));
    return null;
  }

  await verifyHostAvailable(hostId);

  const body = {
    cwd,
    label: label || cwd,
    launchMode,
  };

  if (options.command) {
    body.command = options.command;
  }

  if (sourceSession?.sessionId) {
    body.sourceSessionId = sourceSession.sessionId;
    body.originSessionId = getOriginSessionId(sourceSession);
    body.conversationKey = conversation?.conversationKey || getOriginSessionId(sourceSession);
    body.nativeThreadId = sourceSession.nativeThreadId || sourceSession.sessionId;
  }

  const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/sessions/start`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const startedSession = await waitForSessionReady(hostId, response.sessionId);
  if (!startedSession.live) {
    const detail = await fetchJson(`/api/sessions/${encodeURIComponent(startedSession.sessionId)}/detail?hostId=${encodeURIComponent(hostId)}`).catch(() => null);
    const alertMessage = Array.isArray(detail?.alerts) ? [...detail.alerts].reverse().find((entry) => entry && entry.message)?.message : null;
    const transcript = Array.isArray(detail?.transcript) ? [...detail.transcript].reverse() : [];
    const systemMessage = transcript.find((entry) => entry.speaker === 'system' && entry.text && !String(entry.text).startsWith('State changed:'))?.text
      || transcript.find((entry) => entry.speaker === 'system' && entry.text)?.text
      || null;
    throw new Error(alertMessage || systemMessage || `Managed session failed to start: ${startedSession.state || 'unknown error'}`);
  }

  await refresh();
  const next = state.sessions.find((item) => item.hostId === hostId && item.sessionId === startedSession.sessionId) || null;
  if (next) {
    await selectSession(next);
  }
  if (next && (options.initialText || options.initialInputOptions?.inputItems?.length)) {
    await sendInputToSession(next, options.initialText || '', options.initialInputOptions || {});
  }
  return next;
}

async function resumeFromHistory(options = {}) {
  const session = options.session || getSelectedSession();
  if (!session) {
    return null;
  }

  if (session.live) {
    return session;
  }

  return startManagedSession({
    ...options,
    session,
    launchMode: 'resume',
  });
}

async function forkNewBranch(options = {}) {
  const session = options.session || getSelectedSession();
  if (!session) {
    return null;
  }

  return startManagedSession({
    ...options,
    session,
    launchMode: 'fork',
  });
}

async function createFreshSession() {
  const hostId = state.selectedHostId;
  if (!hostId) {
    reportError(new Error('Select a host before creating a new session.'));
    return null;
  }

  const cwdInput = el('new-session-cwd');
  const labelInput = el('new-session-label');
  const cwd = cwdInput.value.trim();
  const label = labelInput.value.trim();

  if (!cwd) {
    reportError(new Error('Enter a directory path on the selected host.'));
    return null;
  }

  const next = await startManagedSession({
    hostId,
    cwd,
    label,
    launchMode: 'fresh',
    session: null,
  });

  if (next) {
    labelInput.value = '';
  }

  return next;
}

function useSelectedSessionPath() {
  const session = getSelectedSession();
  if (!session?.cwd) {
    reportError(new Error('The selected session does not have a workspace path to reuse.'));
    return;
  }

  el('new-session-cwd').value = session.cwd;
  if (!el('new-session-label').value.trim() && session.title) {
    el('new-session-label').value = session.title;
  }
}

function getActiveTurnBlocker(session) {
  if (!session?.live) {
    return null;
  }

  const runtime = getRuntimeForSession(session) || session.runtime || {};
  const phase = String(runtime.phase || '').toLowerCase();
  const pendingCount = getRequestsForSession(session).filter((request) => request.status === 'pending').length;
  const activePhase = [
    'thinking',
    'planning',
    'reviewing',
    'waiting-approval',
    'waiting-user-input',
    'retrying',
    'reconnecting',
  ].includes(phase);

  if (!runtime.activeTurnId && !runtime.busy && !runtime.waitingOnApproval && !runtime.waitingOnUserInput && !activePhase) {
    return null;
  }

  if (runtime.waitingOnApproval || phase === 'waiting-approval') {
    return pendingCount
      ? `Codex is waiting for ${pendingCount} approval request. Open Status to approve, decline, or interrupt it before sending another prompt.`
      : 'Codex is waiting for approval. Open Status to approve, decline, or interrupt it before sending another prompt.';
  }

  if (runtime.waitingOnUserInput || phase === 'waiting-user-input') {
    return pendingCount
      ? `Codex is waiting for ${pendingCount} input request. Open Status to answer or interrupt it before sending another prompt.`
      : 'Codex is waiting for user input. Open Status to answer or interrupt it before sending another prompt.';
  }

  return 'Codex is still working on the previous turn. Use Status to steer or interrupt it, then send the next prompt.';
}

function openStatusForActiveTurnBlocker() {
  state.statusWindowOpen = true;
  renderSessionDetails();
  renderRuntimePanel();
  renderStatusWindow();
}

async function sendInputToSession(session, text, options = {}) {
  const blocker = getActiveTurnBlocker(session);
  if (blocker) {
    openStatusForActiveTurnBlocker();
    throw new Error(blocker);
  }

  await verifyHostAvailable(session.hostId);
  try {
    await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/input`, {
      method: 'POST',
      body: JSON.stringify({
        hostId: session.hostId,
        text,
        displayText: options.displayText || text,
        inputItems: Array.isArray(options.inputItems) ? options.inputItems : [],
        uploadedFiles: Array.isArray(options.uploadedFiles) ? options.uploadedFiles : [],
        mode: options.mode || null,
        model: options.model || null,
        effort: options.effort || null,
        summary: options.summary || null,
        approvalPolicy: options.approvalPolicy || null,
        approvalsReviewer: options.approvalsReviewer || null,
        sandboxMode: options.sandboxMode || null,
        serviceTier: options.serviceTier || null,
        personality: options.personality || null,
      }),
    });
  } catch (error) {
    if (/still working on the previous turn/i.test(error.message || '')) {
      openStatusForActiveTurnBlocker();
      throw new Error('Codex is still working on the previous turn. Open Status to approve, decline, steer, or interrupt the active turn before sending another prompt.');
    }
    throw error;
  }
}

async function sendInput(text, options = {}) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  if (!session.live) {
    if (!session.cwd) {
      reportError(new Error('This history session does not have a workspace path to activate.'));
      return;
    }
    await resumeFromHistory({ session, initialText: text, initialInputOptions: options });
    return;
  }

  await sendInputToSession(session, text, options);
}

function isModelOptionsLoading(session) {
  return state.codexControls.modelOptionsLoadingKeys.has(modelCacheKey(session));
}

async function loadModelOptionsForSession(session, options = {}) {
  if (!session?.live) {
    throw new Error('Select a live managed session before loading models.');
  }
  const host = getHost(session.hostId);
  if (!host?.capabilities?.modelList) {
    throw new Error(`${host?.label || session.hostId} does not support model listing yet. Restart its host-agent if needed.`);
  }

  const key = modelCacheKey(session);
  if (!options.force && state.codexControls.modelOptionsBySession.has(key)) {
    return state.codexControls.modelOptionsBySession.get(key) || [];
  }
  if (state.codexControls.modelOptionsLoadingKeys.has(key)) {
    return state.codexControls.modelOptionsBySession.get(key) || [];
  }

  state.codexControls.modelOptionsLoadingKeys.add(key);
  state.codexControls.modelsLoading = state.codexControls.modelOptionsLoadingKeys.size > 0;
  renderSessionDetails();
  try {
    await verifyHostAvailable(session.hostId);
    const includeHidden = options.includeHidden === true ? '&includeHidden=true' : '';
    const response = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/models?hostId=${encodeURIComponent(session.hostId)}&limit=100${includeHidden}`);
    state.codexControls.modelOptionsBySession.set(modelCacheKey(session), Array.isArray(response.models) ? response.models : []);
    return state.codexControls.modelOptionsBySession.get(key) || [];
  } finally {
    state.codexControls.modelOptionsLoadingKeys.delete(key);
    state.codexControls.modelsLoading = state.codexControls.modelOptionsLoadingKeys.size > 0;
    renderSessionDetails();
  }
}

function requestModelOptionsForSession(session) {
  if (!session?.live) {
    return;
  }
  const host = getHost(session.hostId);
  const key = modelCacheKey(session);
  if (
    !host?.capabilities?.modelList
    || state.codexControls.modelOptionsBySession.has(key)
    || isModelOptionsLoading(session)
  ) {
    return;
  }
  loadModelOptionsForSession(session).catch((error) => {
    if (!/model listing/i.test(error.message || '')) {
      reportError(error);
    }
  });
}

async function loadModelOptionsForSelectedSession() {
  return loadModelOptionsForSession(getSelectedSession(), { force: true });
}

async function loadReceivedFilesForSession(session, options = {}) {
  if (!session?.sessionId || !session?.hostId) {
    return [];
  }
  const key = getSessionKey(session);
  if (!key) {
    return [];
  }
  if (!options.force && state.receivedFiles.has(key)) {
    return state.receivedFiles.get(key) || [];
  }
  if (state.receivedFilesLoadingKeys.has(key)) {
    return state.receivedFiles.get(key) || [];
  }

  state.receivedFilesLoadingKeys.add(key);
  renderStatusWindow();
  try {
    const response = await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/received-files?hostId=${encodeURIComponent(session.hostId)}`);
    setReceivedFilesForSession(session.hostId, session.sessionId, response.files || []);
    return getReceivedFilesForSession(session);
  } finally {
    state.receivedFilesLoadingKeys.delete(key);
    renderStatusWindow();
  }
}

function requestReceivedFilesForSession(session) {
  if (!session?.sessionId || !session?.hostId) {
    return;
  }
  const key = getSessionKey(session);
  if (!key || state.receivedFiles.has(key) || state.receivedFilesLoadingKeys.has(key)) {
    return;
  }
  loadReceivedFilesForSession(session).catch(reportError);
}

async function startReviewForCurrentSession() {
  const session = getSelectedSession();
  if (!session?.live) {
    throw new Error('Select a live managed session before starting a review.');
  }

  await verifyHostAvailable(session.hostId);
  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/review`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      target: {
        type: 'uncommittedChanges',
      },
      delivery: 'inline',
    }),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reportError(error) {
  const session = getSelectedSession();
  if (session) {
    appendAlertForSession(session.hostId, session.sessionId, {
      severity: 'error',
      source: 'ui',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
    state.alertWindowOpen = true;
    renderSessionDetails();
    renderAlertsWindow();
    return;
  }

  const log = el('session-log');
  log.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = error.message;
  log.appendChild(empty);
}

el('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('import-host-id');
  const hostId = input.value.trim();
  if (!hostId) {
    return;
  }

  input.value = '';
  try {
    await importHostById(hostId);
  } catch (error) {
    reportError(error);
  }
});

el('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = el('auth-username-input').value.trim();
  const password = el('auth-password-input').value;
  const confirmPassword = el('auth-password-confirm-input').value;
  const token = el('auth-token-input').value.trim();

  try {
    if (state.auth.setupRequired) {
      if (!username || !password || !confirmPassword) {
        throw new Error('Username, password, and confirmation are required.');
      }
      await setupRelayAccount(username, password, confirmPassword);
    } else if (token && !password) {
      await loginRelay({ token });
    } else {
      if (!username || !password) {
        throw new Error('Username and password are required.');
      }
      await loginRelay({ username, password });
    }
    el('auth-password-input').value = '';
    el('auth-password-confirm-input').value = '';
    el('auth-token-input').value = '';
  } catch (error) {
    state.auth.error = error.message || 'Login failed.';
    renderAuthGate();
  }
});

el('account-button').addEventListener('click', () => {
  state.auth.accountOpen = true;
  state.auth.accountError = '';
  el('account-current-password-input').value = '';
  el('account-new-password-input').value = '';
  el('account-confirm-password-input').value = '';
  el('account-recovery-token-input').value = '';
  renderAccountDialog();
});

el('close-account-dialog-button').addEventListener('click', () => {
  state.auth.accountOpen = false;
  renderAccountDialog();
});

el('account-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    state.auth.accountOpen = false;
    renderAccountDialog();
  }
});

el('account-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await changeRelayPassword({
      username: el('account-username-input').value.trim(),
      currentPassword: el('account-current-password-input').value,
      recoveryToken: el('account-recovery-token-input').value.trim(),
      newPassword: el('account-new-password-input').value,
      confirmPassword: el('account-confirm-password-input').value,
    });
    el('account-current-password-input').value = '';
    el('account-new-password-input').value = '';
    el('account-confirm-password-input').value = '';
    el('account-recovery-token-input').value = '';
  } catch (error) {
    state.auth.accountError = error.message || 'Unable to update password.';
    renderAccountDialog();
  }
});

el('logout-button').addEventListener('click', async () => {
  try {
    await logoutRelay();
  } catch (error) {
    reportError(error);
  }
});

el('open-connector-manager-button').addEventListener('click', () => {
  openConnectorManager();
});

el('close-connector-manager-button').addEventListener('click', () => {
  closeConnectorManager();
});

el('connector-manager-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    closeConnectorManager();
  }
});

el('new-connector-button').addEventListener('click', () => {
  state.connectorEditorId = null;
  renderConnectorManager();
});

el('connector-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await saveConnectorProfile();
  } catch (error) {
    reportError(error);
  }
});

el('delete-connector-button').addEventListener('click', async () => {
  try {
    await deleteSelectedConnector();
  } catch (error) {
    reportError(error);
  }
});

el('copy-connector-command-button').addEventListener('click', async () => {
  try {
    await copyConnectorBootstrapCommand();
  } catch (error) {
    reportError(error);
  }
});

el('copy-connector-login-button').addEventListener('click', async () => {
  try {
    await copyConnectorLoginCommand();
  } catch (error) {
    reportError(error);
  }
});

el('copy-connector-smoke-button').addEventListener('click', async () => {
  try {
    await copyConnectorSmokeCommand();
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-smoke-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('smoke_test');
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-status-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('status');
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-bootstrap-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('bootstrap');
  } catch (error) {
    reportError(error);
  }
});

el('run-connector-restart-button').addEventListener('click', async () => {
  try {
    await runConnectorAction('restart');
  } catch (error) {
    reportError(error);
  }
});

el('import-selected-host-button').addEventListener('click', async () => {
  if (!state.selectedHostId) {
    reportError(new Error('No host selected.'));
    return;
  }

  try {
    await importHost(state.selectedHostId);
  } catch (error) {
    reportError(error);
  }
});

el('join-session-button').addEventListener('click', async () => {
  try {
    await joinLiveSession();
  } catch (error) {
    reportError(error);
  }
});

el('resume-session-button').addEventListener('click', async () => {
  try {
    await resumeFromHistory();
  } catch (error) {
    reportError(error);
  }
});

el('fork-session-button').addEventListener('click', async () => {
  try {
    await forkNewBranch();
  } catch (error) {
    reportError(error);
  }
});

el('toggle-alerts-button').addEventListener('click', () => {
  toggleAlertWindow();
});

el('toggle-status-button').addEventListener('click', () => {
  toggleStatusWindow();
});

el('runtime-open-status-button').addEventListener('click', () => {
  setStatusWindowOpen(true);
});

el('close-alerts-button').addEventListener('click', () => {
  setAlertWindowOpen(false);
});

el('alerts-fab').addEventListener('click', () => {
  setAlertWindowOpen(true);
});

el('close-status-window-button').addEventListener('click', () => {
  setStatusWindowOpen(false);
});

el('status-window-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    setStatusWindowOpen(false);
  }
});

el('refresh-status-button').addEventListener('click', async () => {
  try {
    await refresh();
    await loadReceivedFilesForSession(getSelectedSession(), { force: true });
  } catch (error) {
    reportError(error);
  }
});

el('interrupt-turn-button').addEventListener('click', async () => {
  try {
    await interruptActiveTurn();
  } catch (error) {
    reportError(error);
  }
});

el('runtime-interrupt-button').addEventListener('click', async () => {
  try {
    await interruptActiveTurn();
  } catch (error) {
    reportError(error);
  }
});

el('compact-thread-button').addEventListener('click', async () => {
  try {
    await compactCurrentThread();
  } catch (error) {
    reportError(error);
  }
});

el('runtime-compact-button').addEventListener('click', async () => {
  try {
    await compactCurrentThread();
  } catch (error) {
    reportError(error);
  }
});

el('steer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('steer-input');
  const text = input.value.trim();
  if (!text) {
    return;
  }

  input.value = '';
  try {
    await steerActiveTurn(text);
  } catch (error) {
    reportError(error);
  }
});

el('inline-steer-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('inline-steer-input');
  const text = input.value.trim();
  if (!text) {
    return;
  }

  input.value = '';
  try {
    await steerActiveTurn(text);
  } catch (error) {
    reportError(error);
  }
});

el('shell-command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('shell-command-input');
  const command = input.value.trim();
  if (!command) {
    return;
  }

  input.value = '';
  try {
    await runThreadShellCommand(command);
  } catch (error) {
    reportError(error);
  }
});

el('inline-shell-command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('inline-shell-command-input');
  const command = input.value.trim();
  if (!command) {
    return;
  }

  input.value = '';
  try {
    await runThreadShellCommand(command);
  } catch (error) {
    reportError(error);
  }
});

el('new-session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await createFreshSession();
  } catch (error) {
    reportError(error);
  }
});

el('toggle-overview-button').addEventListener('click', () => {
  state.overviewCollapsed = !state.overviewCollapsed;
  renderAll();
});

el('toggle-new-session-button').addEventListener('click', () => {
  state.newSessionCollapsed = !state.newSessionCollapsed;
  renderAll();
});

el('session-search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  setSessionSearchQuery(el('session-search-input').value);
});

el('session-search-input').addEventListener('input', (event) => {
  if (!event.target.value.trim() && state.sessionSearchQuery) {
    setSessionSearchQuery('');
  }
});

el('session-search-mode').addEventListener('change', (event) => {
  setSessionSearchMode(event.target.value);
});

el('clear-session-search-button').addEventListener('click', () => {
  el('session-search-input').value = '';
  setSessionSearchQuery('');
});

el('collection-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('collection-name-input');
  const name = input.value.trim();
  if (!name) {
    return;
  }
  input.value = '';
  try {
    await createSessionCollection(name);
  } catch (error) {
    reportError(error);
  }
});

el('use-selected-path-button').addEventListener('click', () => {
  useSelectedSessionPath();
});

el('host-switcher').addEventListener('change', async (event) => {
  const hostId = event.target.value;
  if (hostId) {
    try {
      await setSelectedHost(hostId);
    } catch (error) {
      event.target.value = state.selectedHostId || '';
      reportError(error);
    }
  }
});

el('browse-directory-button').addEventListener('click', async () => {
  try {
    await openDirectoryPicker();
  } catch (error) {
    reportDirectoryPickerError(error);
  }
});

el('close-directory-picker-button').addEventListener('click', () => {
  closeDirectoryPicker();
});

el('directory-picker-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) {
    closeDirectoryPicker();
  }
});

el('picker-up-button').addEventListener('click', async () => {
  if (!state.directoryPicker.parentPath) {
    return;
  }

  try {
    await browseDirectoryPath(state.directoryPicker.parentPath);
  } catch (error) {
    reportDirectoryPickerError(error);
  }
});

el('picker-refresh-button').addEventListener('click', async () => {
  try {
    await fetchDirectoryListing(state.directoryPicker.currentPath || null);
  } catch (error) {
    reportDirectoryPickerError(error);
  }
});

el('picker-select-button').addEventListener('click', () => {
  applyPickedDirectory();
});

el('codex-model-refresh-button').addEventListener('click', async () => {
  try {
    await loadModelOptionsForSelectedSession();
  } catch (error) {
    reportError(error);
  }
});

el('codex-model-select').addEventListener('change', () => {
  const select = el('codex-model-select');
  const input = el('codex-model-input');
  if (input && select) {
    input.value = select.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
});

el('codex-model-input').addEventListener('input', () => {
  const session = getSelectedSession();
  syncModelSelectFromInput(session);
  renderReasoningEffortOptions(session);
});

el('codex-file-picker-button').addEventListener('click', () => {
  el('codex-image-files')?.click();
});

el('codex-image-files').addEventListener('change', async (event) => {
  try {
    await addComposerFiles(event.target.files);
  } catch (error) {
    reportError(error);
  } finally {
    event.target.value = '';
  }
});

el('codex-local-image-path').addEventListener('input', () => {
  renderAttachmentChips();
});

el('codex-attachment-chips').addEventListener('click', (event) => {
  const removeButton = event.target.closest('.attachment-chip-remove');
  if (!removeButton) {
    return;
  }
  if (removeButton.dataset.clearLocalImage) {
    const input = el('codex-local-image-path');
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  removeComposerAttachment(Number(removeButton.dataset.attachmentIndex));
});

el('codex-clear-attachments-button').addEventListener('click', () => {
  clearComposerFileAttachments();
});

el('codex-plan-button').addEventListener('click', async () => {
  const input = el('input-text');
  try {
    const payload = await buildComposerPayload(input.value, { mode: 'plan' });
    if (!payload.text && !payload.inputItems.length) {
      return;
    }
    await sendInput(payload.text, payload);
    input.value = '';
    clearComposerFileAttachments();
  } catch (error) {
    reportError(error);
  }
});

el('codex-review-button').addEventListener('click', async () => {
  try {
    await startReviewForCurrentSession();
  } catch (error) {
    reportError(error);
  }
});

el('input-text').addEventListener('keydown', (event) => {
  if (state.slashMenu.open) {
    const commands = getFilteredSlashCommands();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.slashMenu.selectedIndex = commands.length
        ? (state.slashMenu.selectedIndex + 1) % commands.length
        : 0;
      renderSlashMenu();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.slashMenu.selectedIndex = commands.length
        ? (state.slashMenu.selectedIndex - 1 + commands.length) % commands.length
        : 0;
      renderSlashMenu();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (commands.length) {
        event.preventDefault();
        executeSlashCommand(commands[state.slashMenu.selectedIndex]).catch(reportError);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideSlashMenu();
      return;
    }
  }

  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    el('input-form').requestSubmit();
  }
});

el('input-text').addEventListener('input', () => {
  updateSlashMenuFromInput();
});

el('input-text').addEventListener('click', () => {
  updateSlashMenuFromInput();
});

el('input-form').addEventListener('dragenter', (event) => {
  if (!isFileDragEvent(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setComposerDragActive(true);
});

el('input-form').addEventListener('dragover', (event) => {
  if (!isFileDragEvent(event)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'copy';
  setComposerDragActive(true);
});

el('input-form').addEventListener('dragleave', (event) => {
  if (!isFileDragEvent(event)) {
    return;
  }
  if (!event.currentTarget.contains(event.relatedTarget)) {
    setComposerDragActive(false);
  }
});

el('input-form').addEventListener('drop', handleComposerDrop);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }

  if (state.slashMenu.open) {
    hideSlashMenu();
  }

  if (state.connectorManagerOpen) {
    closeConnectorManager();
  }

  if (state.directoryPicker.open) {
    closeDirectoryPicker();
  }

  if (state.statusWindowOpen) {
    setStatusWindowOpen(false);
  }

  if (state.auth.accountOpen) {
    state.auth.accountOpen = false;
    renderAccountDialog();
  }
});

el('input-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('input-text');
  try {
    const payload = await buildComposerPayload(input.value);
    if (!payload.text && !payload.inputItems.length) {
      return;
    }
    await sendInput(payload.text, payload);
    input.value = '';
    clearComposerFileAttachments();
  } catch (error) {
    reportError(error);
  }
});

async function boot() {
  try {
    const authenticated = await refreshAuthState();
    if (authenticated) {
      await refresh();
    }
  } catch (error) {
    reportError(error);
  }
}

boot();

setInterval(() => {
  if (!authAllowsRequests()) {
    return;
  }
  renderRuntimePanel();
  renderThinkingPanel();
  renderApprovalPopup();
  renderStatusWindow();
}, 1000);

setInterval(() => {
  if (!authAllowsRequests()) {
    return;
  }
  refresh().catch(reportError);
}, 8000);
