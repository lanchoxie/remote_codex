const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');

const UI_SETTINGS_STORAGE_KEY = 'mobile-codex-remote.ui-settings.v1';
const PROVIDER_KINDS = new Set(['openai', 'anthropic', 'gemini', 'custom']);
const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

function inferProviderKind(provider) {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (['openai', 'open ai', 'openai api', 'official openai'].includes(normalized)) return 'openai';
  if (['anthropic', 'claude', 'anthropic claude', 'anthropic api', 'anthropic/claude'].includes(normalized)) return 'anthropic';
  if (['gemini', 'google gemini', 'gemini api', 'google ai', 'google/gemini'].includes(normalized)) return 'gemini';
  return 'custom';
}

function normalizeProviderKind(value, provider) {
  const providerKind = String(value || '').trim().toLowerCase();
  return PROVIDER_KINDS.has(providerKind) ? providerKind : inferProviderKind(provider);
}

function normalizeSessionDefaults(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const effortCandidate = String(input.effort || '').trim();
  const effort = REASONING_EFFORT_PATTERN.test(effortCandidate) ? effortCandidate : '';
  const requestedMode = String(input.effortMode || '').trim().toLowerCase();
  const effortMode = requestedMode === 'manual' || requestedMode === 'auto'
    ? requestedMode
    : effort ? 'manual' : 'auto';
  return {
    model: String(input.model || '').trim().slice(0, 512),
    effortMode,
    effort: effortMode === 'manual' ? effort : '',
    allowUnverifiedEffort: effortMode === 'manual' && Boolean(effort) && input.allowUnverifiedEffort === true,
    summary: String(input.summary || '').trim().slice(0, 64),
  };
}

function parseTomlString(block, key) {
  const match = String(block || '').match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*$`, 'm'));
  if (!match) {
    return '';
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return '';
  }
}

function parseManagedOverlay(input = {}) {
  const directoryName = String(input.directoryName || '');
  const pathMatch = directoryName.match(/^[0-9a-f-]{36}-(api-.+)-[0-9a-f]{16}$/i);
  if (!pathMatch) {
    return null;
  }

  const blockMatch = String(input.configToml || '').match(
    /# BEGIN remote-codex-api-profile([\s\S]*?)# END remote-codex-api-profile/
  );
  if (!blockMatch) {
    return null;
  }

  let auth;
  try {
    auth = JSON.parse(String(input.authJson || ''));
  } catch {
    return null;
  }
  const apiKey = String(auth?.OPENAI_API_KEY || '');
  const label = parseTomlString(blockMatch[1], 'name');
  const baseUrl = normalizeBaseUrl(parseTomlString(blockMatch[1], 'base_url'));
  if (!apiKey || !label || !baseUrl) {
    return null;
  }

  return {
    profileId: pathMatch[1],
    label,
    provider: 'OpenAI',
    providerKind: 'openai',
    baseUrl,
    apiKey,
    sessionDefaults: normalizeSessionDefaults(),
    modifiedAtMs: Number(input.modifiedAtMs) || 0,
  };
}

function logicalProfileKey(profile) {
  const label = String(profile?.label || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s_-]+/g, '');
  return `${label}\n${normalizeBaseUrl(profile?.baseUrl)}`;
}

function selectRecoverableProfiles(candidates = []) {
  const latestById = new Map();
  for (const candidate of candidates) {
    if (!candidate?.profileId || !candidate?.apiKey || !candidate?.baseUrl) {
      continue;
    }
    const current = latestById.get(candidate.profileId);
    if (!current || Number(candidate.modifiedAtMs) > Number(current.modifiedAtMs)) {
      latestById.set(candidate.profileId, candidate);
    }
  }

  const selected = new Map();
  for (const candidate of latestById.values()) {
    const key = logicalProfileKey(candidate);
    const current = selected.get(key);
    if (!current || Number(candidate.modifiedAtMs) > Number(current.modifiedAtMs)) {
      selected.set(key, {
        ...candidate,
        baseUrl: normalizeBaseUrl(candidate.baseUrl),
      });
    }
  }
  return Array.from(selected.values()).sort(
    (left, right) => Number(right.modifiedAtMs) - Number(left.modifiedAtMs)
  );
}

function discoverRecoverableProfiles(managedRoot) {
  const candidates = [];
  if (!managedRoot || !fs.existsSync(managedRoot)) {
    return candidates;
  }
  for (const entry of fs.readdirSync(managedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const overlayRoot = path.join(managedRoot, entry.name, '.codex');
    const authPath = path.join(overlayRoot, 'auth.json');
    const configPath = path.join(overlayRoot, 'config.toml');
    try {
      const parsed = parseManagedOverlay({
        directoryName: entry.name,
        authJson: fs.readFileSync(authPath, 'utf8'),
        configToml: fs.readFileSync(configPath, 'utf8'),
        modifiedAtMs: Math.max(
          fs.statSync(authPath).mtimeMs,
          fs.statSync(configPath).mtimeMs,
          fs.statSync(path.join(managedRoot, entry.name)).mtimeMs
        ),
      });
      if (parsed) {
        candidates.push(parsed);
      }
    } catch {
      // Incomplete and host-environment overlays are not recovery candidates.
    }
  }
  return selectRecoverableProfiles(candidates);
}

function normalizeStoredProfile(profile = {}) {
  const provider = String(profile.provider || 'OpenAI').trim() || 'OpenAI';
  return {
    profileId: String(profile.profileId || profile.id || '').trim(),
    label: String(profile.label || profile.name || provider || 'API Profile').trim(),
    provider,
    providerKind: normalizeProviderKind(profile.providerKind, provider),
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    apiKey: String(profile.apiKey || ''),
    rememberApiKey: profile.rememberApiKey !== false || Boolean(profile.apiKey),
    sessionDefaults: normalizeSessionDefaults(profile.sessionDefaults),
  };
}

function mergeRecoveredProfiles(existing = {}, recovered = []) {
  const existingProfiles = Array.isArray(existing.apiProfiles)
    ? existing.apiProfiles.map(normalizeStoredProfile).filter((profile) => profile.profileId)
    : [];
  const byId = new Map(existingProfiles.map((profile) => [profile.profileId, profile]));
  const byLogicalKey = new Map(existingProfiles.map((profile) => [logicalProfileKey(profile), profile]));

  for (const candidate of recovered) {
    const normalized = normalizeStoredProfile({ ...candidate, rememberApiKey: true });
    const current = byId.get(normalized.profileId) || byLogicalKey.get(logicalProfileKey(normalized));
    if (current) {
      if (!current.apiKey) {
        current.apiKey = normalized.apiKey;
        current.rememberApiKey = true;
      }
      continue;
    }
    existingProfiles.push(normalized);
    byId.set(normalized.profileId, normalized);
    byLogicalKey.set(logicalProfileKey(normalized), normalized);
  }

  const profileIds = new Set(existingProfiles.map((profile) => profile.profileId));
  const fallbackProfileId = existingProfiles[0]?.profileId || 'default';
  const hostApiProfiles = {};
  for (const [hostId, profileId] of Object.entries(existing.hostApiProfiles || {})) {
    if (profileIds.has(profileId)) {
      hostApiProfiles[hostId] = profileId;
    }
  }

  return {
    locale: existing.locale === 'en' ? 'en' : 'zh-CN',
    theme: existing.theme === 'dark-tech' ? 'dark-tech' : 'minimal-light',
    optimizeSpeedMode: existing.optimizeSpeedMode !== false,
    apiProfiles: existingProfiles,
    selectedApiProfileId: profileIds.has(existing.selectedApiProfileId)
      ? existing.selectedApiProfileId
      : fallbackProfileId,
    defaultApiProfileId: profileIds.has(existing.defaultApiProfileId)
      ? existing.defaultApiProfileId
      : fallbackProfileId,
    hostApiProfiles,
  };
}

function summarizeProfiles(profiles = []) {
  return profiles.map((profile) => ({
    profileId: profile.profileId,
    label: profile.label,
    provider: profile.provider,
    providerKind: normalizeProviderKind(profile.providerKind, profile.provider),
    baseUrl: profile.baseUrl,
    sessionDefaults: normalizeSessionDefaults(profile.sessionDefaults),
    hasKey: Boolean(profile.apiKey),
    keyLength: String(profile.apiKey || '').length,
  }));
}

function selectRecoverableTitles(entries = []) {
  const selected = new Map();
  for (const entry of entries) {
    const hostId = String(entry?.hostId || '').trim();
    const identity = String(entry?.identity || entry?.sessionId || entry?.conversationKey || '').trim();
    const title = String(entry?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!hostId || !identity || !title || title === identity) {
      continue;
    }
    const key = `${hostId}::${identity}`;
    const updatedAtMs = Date.parse(entry.updatedAt || '') || 0;
    const current = selected.get(key);
    if (!current || updatedAtMs >= current.updatedAtMs) {
      selected.set(key, { title, updatedAtMs });
    }
  }
  return Object.fromEntries(Array.from(selected, ([key, value]) => [key, value.title]));
}

function readRecoverableTitles(metadataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return selectRecoverableTitles(parsed.entries || []);
  } catch {
    return {};
  }
}

function isLoopbackAddress(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function startOneTimeRecoveryServer(options) {
  const port = Number(options.port);
  const token = String(options.token || '');
  const allowedOrigin = new URL(options.origin).origin;
  const payload = options.payload;
  const timeoutMs = Number(options.timeoutMs || 180000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || token.length < 16) {
    throw new Error('The one-time recovery server requires a valid port and token.');
  }

  return new Promise((resolve, reject) => {
    let delivered = false;
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close(() => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    };
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      const requestOrigin = String(req.headers.origin || '');
      const authorized = isLoopbackAddress(req.socket.remoteAddress)
        && requestOrigin === allowedOrigin
        && requestUrl.searchParams.get('token') === token;
      const headers = {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        Vary: 'Origin',
      };
      if (!authorized) {
        res.writeHead(403, headers);
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/profiles') {
        if (delivered) {
          res.writeHead(410, headers);
          res.end(JSON.stringify({ error: 'recovery payload already delivered' }));
          return;
        }
        delivered = true;
        res.writeHead(200, headers);
        res.end(JSON.stringify(payload));
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/ack' && delivered) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true }));
        res.once('finish', () => finish());
        return;
      }
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.on('error', finish);
    const timer = setTimeout(() => finish(new Error('The one-time recovery service timed out.')), timeoutMs);
    server.listen(port, '127.0.0.1');
  });
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data || '{}'));
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'CDP command failed'));
      } else {
        pending.resolve(message.result || {});
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close() {
    this.socket.close();
  }
}

async function connectCdp(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP target discovery failed: HTTP ${response.status}`);
  }
  const targets = await response.json();
  const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) {
    throw new Error('No CDP page target is available.');
  }
  return new CdpClient(target.webSocketDebuggerUrl);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePageOrigin(client, origin) {
  const targetUrl = `${new URL(origin).origin}/`;
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: targetUrl });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const evaluated = await client.send('Runtime.evaluate', {
        expression: '({ origin: location.origin, readyState: document.readyState })',
        returnByValue: true,
      });
      const value = evaluated?.result?.value;
      if (
        value?.origin === new URL(origin).origin
        && (value.readyState === 'interactive' || value.readyState === 'complete')
      ) {
        return;
      }
    } catch {
      // Navigation can replace the execution context between polling attempts.
    }
    await delay(50);
  }
  throw new Error(`Timed out while loading ${targetUrl} for browser storage recovery.`);
}

async function writeProfilesToBrowser({ port, origin, recoveredProfiles }) {
  const client = await connectCdp(port);
  const storageId = { securityOrigin: origin, isLocalStorage: true };
  try {
    await ensurePageOrigin(client, origin);
    await client.send('DOMStorage.enable');
    const before = await client.send('DOMStorage.getDOMStorageItems', { storageId });
    const currentEntry = (before.entries || []).find(([key]) => key === UI_SETTINGS_STORAGE_KEY);
    let current = {};
    if (currentEntry?.[1]) {
      try {
        current = JSON.parse(currentEntry[1]);
      } catch {
        current = {};
      }
    }
    const merged = mergeRecoveredProfiles(current, recoveredProfiles);
    await client.send('DOMStorage.setDOMStorageItem', {
      storageId,
      key: UI_SETTINGS_STORAGE_KEY,
      value: JSON.stringify(merged),
    });
    const after = await client.send('DOMStorage.getDOMStorageItems', { storageId });
    const savedEntry = (after.entries || []).find(([key]) => key === UI_SETTINGS_STORAGE_KEY);
    const saved = savedEntry?.[1] ? JSON.parse(savedEntry[1]) : null;
    if (!saved || saved.apiProfiles?.length !== merged.apiProfiles.length) {
      throw new Error('Browser storage verification failed.');
    }
    for (const profile of recoveredProfiles) {
      const restored = saved.apiProfiles.find((item) => item.profileId === profile.profileId)
        || saved.apiProfiles.find((item) => logicalProfileKey(item) === logicalProfileKey(profile));
      if (!restored?.apiKey) {
        throw new Error(`Browser storage verification failed for profile ${profile.label}.`);
      }
    }
    return saved;
  } finally {
    client.close();
  }
}

function parseArgs(argv) {
  const result = {};
  const flags = new Set(['--serve-once', '--write']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      result[argument.slice(2)] = true;
    } else if (argument.startsWith('--')) {
      result[argument.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const managedRoot = path.resolve(args['managed-root'] || path.join(os.homedir(), '.codex', '.remote-codex-managed'));
  const recoveredProfiles = discoverRecoverableProfiles(managedRoot);
  if (!recoveredProfiles.length) {
    throw new Error(`No recoverable managed API profiles were found under ${managedRoot}.`);
  }
  console.log(JSON.stringify({
    mode: args['serve-once'] ? 'serve-once' : args.write ? 'write' : 'dry-run',
    profiles: summarizeProfiles(recoveredProfiles),
  }, null, 2));
  if (args['serve-once']) {
    const port = Number(args.port || 19230);
    const origin = new URL(args.origin || 'http://127.0.0.1:8797').origin;
    const token = String(args.token || crypto.randomBytes(24).toString('hex'));
    const metadataPath = path.resolve(
      args['metadata-path'] || path.join(__dirname, '..', 'tmp', 'session-metadata.json')
    );
    const manualSessionTitles = readRecoverableTitles(metadataPath);
    console.log(JSON.stringify({
      ready: true,
      recoveryUrl: `${origin}/recover-api-profiles.html?port=${port}&token=${encodeURIComponent(token)}`,
      profileCount: recoveredProfiles.length,
      titleCount: Object.keys(manualSessionTitles).length,
    }, null, 2));
    await startOneTimeRecoveryServer({
      port,
      token,
      origin,
      payload: {
        apiProfiles: recoveredProfiles,
        manualSessionTitles,
      },
      timeoutMs: Number(args.timeout || 180000),
    });
    console.log(JSON.stringify({ restored: true, profileCount: recoveredProfiles.length, titleCount: Object.keys(manualSessionTitles).length }));
    return;
  }
  if (!args.write) {
    return;
  }
  const port = Number(args['cdp-port']);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('--cdp-port is required in write mode.');
  }
  const origin = new URL(args.origin || 'http://127.0.0.1:8797').origin;
  const saved = await writeProfilesToBrowser({ port, origin, recoveredProfiles });
  console.log(JSON.stringify({
    restored: true,
    origin,
    profileCount: saved.apiProfiles.length,
    profiles: summarizeProfiles(saved.apiProfiles),
  }, null, 2));
}

module.exports = {
  UI_SETTINGS_STORAGE_KEY,
  discoverRecoverableProfiles,
  ensurePageOrigin,
  logicalProfileKey,
  mergeRecoveredProfiles,
  normalizeSessionDefaults,
  normalizeStoredProfile,
  parseManagedOverlay,
  readRecoverableTitles,
  selectRecoverableTitles,
  selectRecoverableProfiles,
  startOneTimeRecoveryServer,
  summarizeProfiles,
  writeProfilesToBrowser,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[recover-web-api-profiles] ${error.message}`);
    process.exitCode = 1;
  });
}
