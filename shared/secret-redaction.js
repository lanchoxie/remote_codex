const SECRET_KEY_SUFFIX_PATTERN = /(?:apikey|token|password|passwd|secret|credential|credentials|authorization|privatekey|signingkey|cookie)$/;

function normalizedKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isSecretKey(value) {
  const key = normalizedKey(value);
  if (!key || key === 'tokenbudget') {
    return false;
  }
  return key === 'auth'
    || key === 'password'
    || key === 'passwd'
    || key === 'secret'
    || key === 'authorization'
    || key === 'proxyauthorization'
    || key === 'cookie'
    || key === 'setcookie'
    || key === 'accesskey'
    || key === 'secretkey'
    || key === 'accountkey'
    || key === 'storagekey'
    || key === 'encryptionkey'
    || key === 'connectionstring'
    || /^(?:aws)?(?:accesskeyid|secretaccesskey)$/.test(key)
    || SECRET_KEY_SUFFIX_PATTERN.test(key);
}

function isSecretQueryKey(value) {
  const key = normalizedKey(value);
  return isSecretKey(value)
    || key === 'key'
    || key === 'sig'
    || key === 'signature'
    || key === 'code'
    || /key$/.test(key)
    || /signature$/.test(key);
}

function redactSecretText(value) {
  let text = String(value);
  text = text.replace(
    /-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/gi,
    '[REDACTED]'
  );
  text = text.replace(
    /\b(?:proxy[-_ ]?authorization|authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;}\]]+/gi,
    '[REDACTED]'
  );
  text = text.replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]');
  text = text.replace(
    /["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|password|private[-_ ]?key|access[-_ ]?key|secret[-_ ]?key|account[-_ ]?key|storage[-_ ]?key|encryption[-_ ]?key|connection[-_ ]?string)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    '[REDACTED]'
  );
  text = text.replace(/([?&])([^=&#\s]+)=([^&#\s]+)/g, (match, prefix, rawKey) => {
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch (_) {
      // Invalid percent encoding remains eligible for normalized raw-key checks.
    }
    return isSecretQueryKey(key) ? `${prefix}${rawKey}=[REDACTED]` : match;
  });
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  text = text.replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, '$1[REDACTED]@');
  return text;
}

function stripSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return redactSecretText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripSecrets(item, seen));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    throw new TypeError('Cannot persist cyclic Session metadata');
  }
  seen.add(value);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isSecretKey(key)) {
      result[key] = stripSecrets(child, seen);
    }
  }
  seen.delete(value);
  return result;
}

function containsSecretField(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (normalizedKey(key) === 'credentials' || isSecretKey(key) || containsSecretField(child, seen)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  containsSecretField,
  isSecretKey,
  isSecretQueryKey,
  redactSecretText,
  stripSecrets,
};
