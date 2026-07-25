const crypto = require('crypto');

const SCOPE_FIELDS = Object.freeze([
  'hostId',
  'sourceSessionId',
  'targetSessionId',
  'currentRunId',
  'currentRunStatus',
  'currentBindingFingerprint',
  'targetBindingFingerprint',
  'targetProfileId',
  'targetProviderKind',
  'targetApiConfigFingerprint',
  'selectionFingerprint',
]);

function normalizedScope(input = {}) {
  return {
    hostId: String(input.hostId || '').trim(),
    sourceSessionId: String(input.sourceSessionId || '').trim(),
    targetSessionId: String(input.targetSessionId || input.sourceSessionId || '').trim(),
    currentRunId: String(input.currentRunId || '').trim(),
    currentRunStatus: String(input.currentRunStatus || '').trim(),
    currentBindingFingerprint: String(input.currentBindingFingerprint || '').trim(),
    targetBindingFingerprint: String(input.targetBindingFingerprint || '').trim(),
    targetProfileId: String(input.targetProfileId || '').trim(),
    targetProviderKind: String(input.targetProviderKind || '').trim().toLowerCase(),
    targetApiConfigFingerprint: String(input.targetApiConfigFingerprint || '').trim(),
    selectionFingerprint: String(input.selectionFingerprint || ''),
  };
}

class RebindCatalogReuseStore {
  constructor(options = {}) {
    this.ttlMs = Math.max(1, Number(options.ttlMs || 120_000) || 120_000);
    this.maxEntries = Math.max(1, Number(options.maxEntries || 512) || 512);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.makeToken = typeof options.makeToken === 'function'
      ? options.makeToken
      : () => crypto.randomBytes(24).toString('base64url');
    this.entries = new Map();
  }

  prune(now = this.now()) {
    for (const [token, entry] of this.entries) {
      if (!entry || Number(entry.expiresAtMs || 0) <= now) {
        this.entries.delete(token);
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  issue(input = {}) {
    if (!input.catalog || typeof input.catalog !== 'object') {
      return null;
    }
    const issuedAtMs = this.now();
    this.prune(issuedAtMs);
    let token = '';
    do {
      token = String(this.makeToken() || '').trim();
    } while (!token || this.entries.has(token));
    this.entries.set(token, {
      ...normalizedScope(input),
      catalog: input.catalog,
      issuedAtMs,
      expiresAtMs: issuedAtMs + this.ttlMs,
    });
    this.prune(issuedAtMs);
    return token;
  }

  consume(tokenValue, input = {}) {
    const token = String(tokenValue || '').trim();
    if (!token) return null;
    const now = this.now();
    this.prune(now);
    const entry = this.entries.get(token);
    if (!entry || Number(entry.expiresAtMs || 0) <= now) {
      this.entries.delete(token);
      return null;
    }
    const expected = normalizedScope(input);
    if (!SCOPE_FIELDS.every((field) => entry[field] === expected[field])) {
      return null;
    }
    this.entries.delete(token);
    return entry.catalog;
  }
}

module.exports = {
  RebindCatalogReuseStore,
  normalizedScope,
};
