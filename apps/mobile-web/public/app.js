const state = {
  hosts: [],
  dismissedHosts: [],
  sessions: [],
  stats: null,
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
  streamStatus: new Map(),
  thinkingPanels: new Map(),
  alertWindowOpen: false,
  statusWindowOpen: false,
  connectorManagerOpen: false,
  connectors: [],
  connectorEditorId: null,
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

const el = (id) => document.getElementById(id);

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
    throw new Error(body.error || `request failed: ${response.status}`);
  }
  return body;
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

function dedupeTranscript(entries) {
  const seen = new Set();
  const deduped = [];

  for (const entry of entries || []) {
    if (!entry || !entry.text) {
      continue;
    }

    const normalized = {
      speaker: entry.speaker || 'system',
      text: String(entry.text || ''),
      timestamp: entry.timestamp || null,
      stream: entry.stream || null,
    };
    const key = `${normalized.speaker}|${normalized.timestamp || ''}|${normalized.text}`;
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

function firstNonEmpty(values) {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return null;
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
    state.selectedHostId = state.hosts[0]?.hostId || null;
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

function getAlertsForSession(session) {
  const key = getSessionKey(session);
  return key ? state.alerts.get(key) || [] : [];
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
  el('connector-gateway-otp-source').value = draft.gateway?.otpSource || '';
  el('connector-auth-method').value = draft.auth?.method || 'ssh_key';
  el('connector-auth-key-path').value = draft.auth?.keyPath || '';
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
  el('connector-runbook-summary').textContent = summary;
  el('connector-login-command').textContent = loginCommand || '(no login command yet)';
  el('connector-smoke-command').textContent = smokeCommand || '(no smoke test yet)';
  el('connector-bootstrap-command').textContent = command || '(no command yet)';
  copyButton.disabled = !command;
  copyLoginButton.disabled = !loginCommand;
  copySmokeButton.disabled = !smokeCommand;
  renderConnectorRunbookList(el('connector-plan-steps'), connector?.plan?.steps || [], 'No bootstrap steps yet.');
  renderConnectorRunbookList(el('connector-plan-warnings'), connector?.plan?.warnings || [], 'No MFA or auth warnings.');
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
    switchButton.onclick = (event) => {
      event.stopPropagation();
      setSelectedHost(host.hostId);
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
    item.onclick = () => setSelectedHost(host.hostId);
    hostList.appendChild(item);
  }
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
      selectSession(session);
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

  const groups = state.selectedHostId ? getConversationGroups(state.selectedHostId) : [];
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Import a host or start a managed session to see conversations here.';
    list.appendChild(empty);
    return;
  }

  for (const group of groups) {
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
          <div class="title">${group.title || group.conversationKey}</div>
          <div class="sub">${group.liveCount > 0 ? `${group.liveCount} live` : 'history only'} | ${group.totalCount} variants</div>
        </div>
        <div class="conversation-stats">
          <div class="count">${group.totalCount}</div>
          <div class="label">sessions</div>
        </div>
      </div>
      <div class="path">${group.cwd || '(unknown path)'}</div>
      <div class="conversation-summary">
        <span>${formatTime(group.lastUpdatedAt) || 'No recent activity'}</span>
        <span>${group.liveCount > 0 ? 'Joinable live session' : 'History can be resumed'}</span>
      </div>
      <div class="preview">${preview}</div>
    `;

    const variantRow = document.createElement('div');
    variantRow.className = 'variant-row';
    renderVariantButtons(variantRow, group, state.selectedSessionId);
    item.appendChild(variantRow);

    item.onclick = () => selectConversation(group);
    list.appendChild(item);
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

  composer.classList.toggle('disabled', !session || (!session.live && !canActivateHistory));
  input.disabled = !session || (!session.live && !canActivateHistory);
  if (session?.live) {
    input.placeholder = 'Send a follow-up prompt to the live managed session...';
  } else if (canActivateHistory) {
    input.placeholder = liveSession
      ? 'Type here to resume this history point into a new live branch...'
      : 'Type here to resume this history session as live...';
  } else {
    input.placeholder = 'Join or start a live session first...';
  }
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
  renderOverview();
  renderHostNav();
  renderConversationNav();
  renderSessionDetails();
  renderRuntimePanel();
  renderThinkingPanel();
  renderAlertsWindow();
  renderStatusWindow();
  renderDirectoryPicker();
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
    renderStatusWindow();
  });

  state.eventSource.addEventListener('session.request.resolved', (event) => {
    const payload = JSON.parse(event.data);
    resolveRequestForSession(payload.hostId || session.hostId, payload.sessionId || session.sessionId, payload);
    renderSessionDetails();
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

function setSelectedHost(hostId) {
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

function selectConversation(conversation) {
  if (!conversation) {
    return;
  }

  state.selectedHostId = conversation.hostId;
  state.selectedConversationKey = conversation.conversationKey;
  state.selectedSessionId = conversation.preferredSession?.sessionId || null;
  renderAll();
  showSession().catch(reportError);
}

function selectSession(session) {
  if (!session) {
    return;
  }

  state.selectedHostId = session.hostId;
  state.selectedConversationKey = session.conversationKey || session.originSessionId || session.sessionId;
  state.selectedSessionId = session.sessionId;
  renderAll();
  showSession(session).catch(reportError);
}

async function refresh() {
  const previousKey = getSessionKey(getSelectedSession());

  const [stats, hostsResponse, connectorsResponse] = await Promise.all([
    fetchJson('/api/stats'),
    fetchJson('/api/hosts'),
    fetchJson('/api/connectors'),
  ]);

  state.stats = stats;
  state.hosts = hostsResponse.hosts || [];
  state.dismissedHosts = hostsResponse.dismissedHosts || [];
  state.connectors = connectorsResponse.connectors || [];

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

async function waitForSession(hostId, sessionId, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/sessions`);
    const session = (response.sessions || []).find((item) => item.sessionId === sessionId || item.bridgeSessionId === sessionId) || null;
    if (session && predicate(session)) {
      return session;
    }
    await sleep(400);
  }

  throw new Error('Timed out while waiting for the live session to start.');
}

async function waitForSessionReady(hostId, sessionId, timeoutMs = 12000) {
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
    setSelectedHost(response.host.hostId);
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

async function saveConnectorProfile() {
  const payload = readConnectorForm();
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
  selectSession(liveSession);
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

  if (!hostId) {
    reportError(new Error('Select a host before starting a managed session.'));
    return null;
  }

  if (!cwd) {
    reportError(new Error('No workspace path is available for this conversation.'));
    return null;
  }

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
    selectSession(next);
  }
  if (next && options.initialText) {
    await sendInputToSession(next, options.initialText);
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

async function sendInputToSession(session, text) {
  await fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/input`, {
    method: 'POST',
    body: JSON.stringify({
      hostId: session.hostId,
      text,
    }),
  });
}

async function sendInput(text) {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  if (!session.live) {
    if (!session.cwd) {
      reportError(new Error('This history session does not have a workspace path to activate.'));
      return;
    }
    await resumeFromHistory({ session, initialText: text });
    return;
  }

  await sendInputToSession(session, text);
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

el('use-selected-path-button').addEventListener('click', () => {
  useSelectedSessionPath();
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

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
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
});

el('input-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = el('input-text');
  const text = input.value.trim();
  if (!text) {
    return;
  }

  input.value = '';
  try {
    await sendInput(text);
  } catch (error) {
    reportError(error);
  }
});

refresh().catch(reportError);

setInterval(() => {
  renderRuntimePanel();
  renderThinkingPanel();
  renderStatusWindow();
}, 1000);

setInterval(() => {
  refresh().catch(reportError);
}, 8000);
