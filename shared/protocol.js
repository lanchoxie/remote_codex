const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sessionKey(hostId, sessionId) {
  return `${hostId}::${sessionId}`;
}

function pick(object, keys) {
  const out = {};
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) {
      out[key] = object[key];
    }
  }
  return out;
}

function normalizeArgs(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value !== 'string') {
    return [];
  }

  const text = value.trim();
  if (!text) {
    return [];
  }

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch (_) {
      // Fall through to simple tokenization.
    }
  }

  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ''));
}

module.exports = {
  makeId,
  nowIso,
  normalizeArgs,
  pick,
  sessionKey,
};
