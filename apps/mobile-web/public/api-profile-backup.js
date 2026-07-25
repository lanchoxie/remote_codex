(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexApiProfileBackup = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const BACKUP_FORMAT = 'remote-codex-api-profile-backup';
  const BACKUP_VERSION = 1;
  const PAYLOAD_SCHEMA_VERSION = 1;
  const PBKDF2_ITERATIONS = 600000;
  const PUBLIC_ERROR = 'api_profile_backup_password_or_corrupt';
  const MAX_FILE_BYTES = 1024 * 1024;
  const MAX_PROFILES = 256;
  const MAX_HOST_MAPPINGS = 2048;
  const PROVIDER_KINDS = new Set(['openai', 'anthropic', 'gemini', 'custom']);
  const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

  class BackupError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'BackupError';
      this.code = code;
    }
  }

  function string(value, maximum, field, options = {}) {
    const result = String(value == null ? '' : value);
    const normalized = options.trim === false ? result : result.trim();
    if (normalized.length > maximum) throw new BackupError('api_profile_backup_invalid', `${field} is too long`);
    if (options.required && !normalized) throw new BackupError('api_profile_backup_invalid', `${field} is required`);
    return normalized;
  }

  function normalizeBaseUrl(value) {
    const baseUrl = string(value, 2048, 'API Base URL');
    if (!baseUrl) return '';
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new BackupError('api_profile_backup_invalid', 'API Base URL must be a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BackupError('api_profile_backup_invalid', 'API Base URL must use http or https');
    }
    parsed.hash = '';
    return parsed.toString();
  }

  function inferProviderKind(provider) {
    const normalized = String(provider == null ? '' : provider)
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
    const providerKind = String(value == null ? '' : value).trim().toLowerCase();
    if (!providerKind) return inferProviderKind(provider);
    if (!PROVIDER_KINDS.has(providerKind)) {
      throw new BackupError('api_profile_backup_invalid', `Unsupported API provider kind: ${providerKind}`);
    }
    return providerKind;
  }

  function normalizeSessionDefaults(value) {
    if (value != null && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new BackupError('api_profile_backup_invalid', 'API profile session defaults must be an object');
    }
    const input = value || {};
    const model = string(input.model, 512, 'default model');
    const effort = string(input.effort, 32, 'default reasoning effort');
    if (effort && !REASONING_EFFORT_PATTERN.test(effort)) {
      throw new BackupError('api_profile_backup_invalid', 'Default reasoning effort has an invalid format');
    }
    const rawEffortMode = string(input.effortMode, 16, 'default reasoning effort mode').toLowerCase();
    if (rawEffortMode && rawEffortMode !== 'auto' && rawEffortMode !== 'manual') {
      throw new BackupError('api_profile_backup_invalid', 'Default reasoning effort mode must be auto or manual');
    }
    const effortMode = rawEffortMode || (effort ? 'manual' : 'auto');
    return {
      model,
      effortMode,
      effort: effortMode === 'manual' ? effort : '',
      allowUnverifiedEffort: effortMode === 'manual' && Boolean(effort) && input.allowUnverifiedEffort === true,
      summary: string(input.summary, 64, 'default reasoning summary'),
    };
  }

  function normalizeProfile(value, index) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BackupError('api_profile_backup_invalid', `API profile ${index + 1} must be an object`);
    }
    const provider = string(value.provider, 128, 'API provider', { required: true });
    return {
      profileId: string(value.profileId, 128, 'API profile ID', { required: true }),
      label: string(value.label, 256, 'API profile label', { required: true }),
      provider,
      providerKind: normalizeProviderKind(value.providerKind, provider),
      baseUrl: normalizeBaseUrl(value.baseUrl),
      apiKey: string(value.apiKey, 16384, 'API key', { trim: false }),
      sessionDefaults: normalizeSessionDefaults(value.sessionDefaults),
    };
  }

  function validatePayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BackupError('api_profile_backup_invalid', 'Backup payload must be an object');
    }
    if (value.schemaVersion != null && Number(value.schemaVersion) !== PAYLOAD_SCHEMA_VERSION) {
      throw new BackupError('api_profile_backup_invalid', 'Unsupported backup payload schema');
    }
    if (!Array.isArray(value.apiProfiles) || !value.apiProfiles.length || value.apiProfiles.length > MAX_PROFILES) {
      throw new BackupError('api_profile_backup_invalid', `Backup must contain 1-${MAX_PROFILES} API profiles`);
    }
    const apiProfiles = value.apiProfiles.map(normalizeProfile);
    const ids = new Set();
    for (const profile of apiProfiles) {
      if (ids.has(profile.profileId)) throw new BackupError('api_profile_backup_invalid', `Backup has duplicate API profile ID: ${profile.profileId}`);
      ids.add(profile.profileId);
    }
    const selectedApiProfileId = string(value.selectedApiProfileId, 128, 'selected API profile ID');
    const defaultApiProfileId = string(value.defaultApiProfileId, 128, 'default API profile ID');
    for (const [field, id] of [['selected', selectedApiProfileId], ['default', defaultApiProfileId]]) {
      if (id && !ids.has(id)) throw new BackupError('api_profile_backup_invalid', `${field} API profile references an unknown API profile`);
    }
    const rawMappings = value.hostApiProfiles == null ? {} : value.hostApiProfiles;
    if (!rawMappings || typeof rawMappings !== 'object' || Array.isArray(rawMappings)) {
      throw new BackupError('api_profile_backup_invalid', 'Host API profile mappings must be an object');
    }
    const entries = Object.entries(rawMappings);
    if (entries.length > MAX_HOST_MAPPINGS) throw new BackupError('api_profile_backup_invalid', 'Too many Host API profile mappings');
    const hostApiProfiles = {};
    for (const [rawHostId, rawProfileId] of entries) {
      const hostId = string(rawHostId, 256, 'Host ID', { required: true });
      const profileId = string(rawProfileId, 128, 'Host API profile ID', { required: true });
      if (!ids.has(profileId)) throw new BackupError('api_profile_backup_invalid', `Host mapping references an unknown API profile: ${profileId}`);
      hostApiProfiles[hostId] = profileId;
    }
    return {
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      apiProfiles,
      selectedApiProfileId: selectedApiProfileId || apiProfiles[0].profileId,
      defaultApiProfileId: defaultApiProfileId || apiProfiles[0].profileId,
      hostApiProfiles,
    };
  }

  function encoder() {
    if (typeof TextEncoder === 'undefined') throw new BackupError('api_profile_backup_unsupported', 'TextEncoder is unavailable');
    return new TextEncoder();
  }

  function decoder() {
    if (typeof TextDecoder === 'undefined') throw new BackupError('api_profile_backup_unsupported', 'TextDecoder is unavailable');
    return new TextDecoder('utf-8', { fatal: true });
  }

  function encodeBase64Url(bytes) {
    let base64;
    if (typeof Buffer !== 'undefined') {
      base64 = Buffer.from(bytes).toString('base64');
    } else {
      let binary = '';
      for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
      base64 = btoa(binary);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodeBase64Url(value, field, expectedLength = null) {
    const textValue = String(value || '');
    if (!textValue || !/^[A-Za-z0-9_-]+$/.test(textValue)) {
      throw new BackupError('api_profile_backup_invalid', `${field} is not valid base64url`);
    }
    const padded = `${textValue.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - textValue.length % 4) % 4)}`;
    let result;
    try {
      if (typeof Buffer !== 'undefined') {
        result = new Uint8Array(Buffer.from(padded, 'base64'));
      } else {
        result = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
      }
    } catch {
      throw new BackupError('api_profile_backup_invalid', `${field} is not valid base64url`);
    }
    if (encodeBase64Url(result) !== textValue) {
      throw new BackupError('api_profile_backup_invalid', `${field} is not canonical base64url`);
    }
    if (expectedLength !== null && result.length !== expectedLength) {
      throw new BackupError('api_profile_backup_invalid', `${field} has an invalid length`);
    }
    return result;
  }

  function cryptoApi(options) {
    const api = options?.crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!api?.subtle || typeof api.getRandomValues !== 'function') {
      throw new BackupError('api_profile_backup_unsupported', 'Web Crypto is unavailable');
    }
    return api;
  }

  function normalizePassword(password) {
    return String(password == null ? '' : password).normalize('NFC');
  }

  async function deriveKey(api, password, salt) {
    const raw = encoder().encode(normalizePassword(password));
    const material = await api.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
    return api.subtle.deriveKey({
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt,
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function metadata(envelope) {
    return {
      format: envelope.format,
      version: envelope.version,
      createdAt: envelope.createdAt,
      payloadSchema: envelope.payloadSchema,
      kdf: {
        name: envelope.kdf.name,
        hash: envelope.kdf.hash,
        iterations: envelope.kdf.iterations,
        salt: envelope.kdf.salt,
        passwordEncoding: envelope.kdf.passwordEncoding,
        passwordNormalization: envelope.kdf.passwordNormalization,
      },
      cipher: {
        name: envelope.cipher.name,
        keyLength: envelope.cipher.keyLength,
        iv: envelope.cipher.iv,
        tagLength: envelope.cipher.tagLength,
      },
    };
  }

  function aad(envelope) {
    return encoder().encode(JSON.stringify(metadata(envelope)));
  }

  function parseEnvelope(input) {
    let value = input;
    if (typeof input === 'string') {
      if (encoder().encode(input).length > MAX_FILE_BYTES) throw new BackupError('api_profile_backup_invalid', 'Backup file is too large');
      try {
        value = JSON.parse(input);
      } catch {
        throw new BackupError('api_profile_backup_invalid', 'Backup file is not valid JSON');
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackupError('api_profile_backup_invalid', 'Backup envelope must be an object');
    if (value.format !== BACKUP_FORMAT || Number(value.version) !== BACKUP_VERSION || Number(value.payloadSchema) !== PAYLOAD_SCHEMA_VERSION) {
      throw new BackupError('api_profile_backup_invalid', 'Unsupported API profile backup format');
    }
    if (!value.kdf || value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256') throw new BackupError('api_profile_backup_invalid', 'Unsupported backup KDF');
    if (Number(value.kdf.iterations) !== PBKDF2_ITERATIONS) throw new BackupError('api_profile_backup_invalid', 'Backup uses an unsupported PBKDF2 work factor');
    if (value.kdf.passwordEncoding !== 'UTF-8' || value.kdf.passwordNormalization !== 'NFC') throw new BackupError('api_profile_backup_invalid', 'Unsupported backup password encoding');
    if (!value.cipher || value.cipher.name !== 'AES-GCM' || Number(value.cipher.keyLength) !== 256 || Number(value.cipher.tagLength) !== 128) {
      throw new BackupError('api_profile_backup_invalid', 'Unsupported backup cipher');
    }
    if (!Number.isFinite(Date.parse(String(value.createdAt || '')))) throw new BackupError('api_profile_backup_invalid', 'Backup creation time is invalid');
    decodeBase64Url(value.kdf.salt, 'KDF salt', 16);
    decodeBase64Url(value.cipher.iv, 'cipher IV', 12);
    decodeBase64Url(value.ciphertext, 'ciphertext');
    return metadata(value).format ? { ...metadata(value), ciphertext: value.ciphertext } : null;
  }

  async function encryptBackup(settings, password, options = {}) {
    const api = cryptoApi(options);
    const payload = validatePayload(settings);
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    api.getRandomValues(salt);
    api.getRandomValues(iv);
    const envelope = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: (options.now || (() => new Date().toISOString()))(),
      payloadSchema: PAYLOAD_SCHEMA_VERSION,
      kdf: {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: PBKDF2_ITERATIONS,
        salt: encodeBase64Url(salt),
        passwordEncoding: 'UTF-8',
        passwordNormalization: 'NFC',
      },
      cipher: {
        name: 'AES-GCM',
        keyLength: 256,
        iv: encodeBase64Url(iv),
        tagLength: 128,
      },
    };
    const key = await deriveKey(api, password, salt);
    const ciphertext = await api.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(envelope), tagLength: 128 }, key, encoder().encode(JSON.stringify(payload)));
    return { ...envelope, ciphertext: encodeBase64Url(ciphertext) };
  }

  async function decryptBackup(input, password, options = {}) {
    const envelope = parseEnvelope(input);
    const api = cryptoApi(options);
    try {
      const salt = decodeBase64Url(envelope.kdf.salt, 'KDF salt', 16);
      const iv = decodeBase64Url(envelope.cipher.iv, 'cipher IV', 12);
      const ciphertext = decodeBase64Url(envelope.ciphertext, 'ciphertext');
      const key = await deriveKey(api, password, salt);
      const plaintext = await api.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(envelope), tagLength: 128 }, key, ciphertext);
      return validatePayload(JSON.parse(decoder().decode(plaintext)));
    } catch (error) {
      if (error instanceof BackupError && error.code === 'api_profile_backup_unsupported') throw error;
      throw new BackupError(PUBLIC_ERROR, 'The password is incorrect or the backup is damaged.');
    }
  }

  function previewPayload(value) {
    const payload = validatePayload(value);
    return {
      schemaVersion: payload.schemaVersion,
      apiProfiles: payload.apiProfiles.map(({ apiKey, ...profile }) => ({ ...profile, hasCredential: Boolean(apiKey) })),
      selectedApiProfileId: payload.selectedApiProfileId,
      defaultApiProfileId: payload.defaultApiProfileId,
      hostApiProfiles: { ...payload.hostApiProfiles },
    };
  }

  function identity(profile) {
    return `${profile.provider.toLowerCase()}\0${normalizeBaseUrl(profile.baseUrl).replace(/\/$/, '')}`;
  }

  function planSafeMerge(localValue, importedValue, options = {}) {
    const local = validatePayload(localValue);
    const imported = validatePayload(importedValue);
    const profiles = local.apiProfiles.map((profile) => ({ ...profile }));
    const byId = new Map(profiles.map((profile) => [profile.profileId, profile]));
    const idMap = {};
    const conflicts = [];
    const makeProfileId = options.makeProfileId || (() => `api-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    for (const backup of imported.apiProfiles) {
      const current = byId.get(backup.profileId);
      if (!current) {
        profiles.push({ ...backup });
        byId.set(backup.profileId, profiles.at(-1));
        idMap[backup.profileId] = backup.profileId;
        continue;
      }
      if (identity(current) === identity(backup)) {
        idMap[backup.profileId] = current.profileId;
        let apiKey = current.apiKey;
        if (!apiKey && backup.apiKey) apiKey = backup.apiKey;
        else if (current.apiKey && backup.apiKey && current.apiKey !== backup.apiKey) {
          conflicts.push({ type: 'credential', profileId: backup.profileId });
          if (options.keyConflicts?.[backup.profileId] === 'backup') apiKey = backup.apiKey;
        }
        Object.assign(current, backup, { apiKey });
        continue;
      }
      conflicts.push({ type: 'identity', profileId: backup.profileId });
      if (options.identityConflicts?.[backup.profileId] === 'replace') {
        Object.assign(current, backup);
        idMap[backup.profileId] = backup.profileId;
        continue;
      }
      let copyId;
      do {
        copyId = string(makeProfileId(backup.profileId), 128, 'generated API profile ID', { required: true });
      } while (byId.has(copyId));
      const copy = { ...backup, profileId: copyId };
      profiles.push(copy);
      byId.set(copyId, copy);
      idMap[backup.profileId] = copyId;
    }
    const hostApiProfiles = { ...local.hostApiProfiles };
    for (const [hostId, profileId] of Object.entries(imported.hostApiProfiles)) {
      if (!hostApiProfiles[hostId]) hostApiProfiles[hostId] = idMap[profileId] || profileId;
    }
    const useImportedDefaults = options.useImportedDefaults === true;
    return {
      payload: validatePayload({
        apiProfiles: profiles,
        selectedApiProfileId: useImportedDefaults ? idMap[imported.selectedApiProfileId] || imported.selectedApiProfileId : local.selectedApiProfileId,
        defaultApiProfileId: useImportedDefaults ? idMap[imported.defaultApiProfileId] || imported.defaultApiProfileId : local.defaultApiProfileId,
        hostApiProfiles,
      }),
      idMap,
      conflicts,
    };
  }

  return {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    MAX_FILE_BYTES,
    PBKDF2_ITERATIONS,
    PUBLIC_ERROR,
    BackupError,
    decryptBackup,
    encryptBackup,
    planSafeMerge,
    previewPayload,
    normalizeSessionDefaults,
    validatePayload,
  };
}));
