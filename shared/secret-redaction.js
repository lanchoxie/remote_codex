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
  // This also cleans durable Store records. Traverse iteratively so valid JSON
  // is never silently shortened by a display-oriented depth limit or recursion
  // limit. Only references back to an active ancestor are circular.
  const result = {};
  const stack = [{ value, target: result, key: 'value' }];
  const active = new Set();
  const assign = (target, key, child) => {
    Object.defineProperty(target, key, {
      value: child, enumerable: true, configurable: true, writable: true,
    });
  };
  try {
    while (stack.length) {
      const task = stack.pop();
      if (task.exit) {
        seen.delete(task.exit);
        active.delete(task.exit);
        continue;
      }
      const current = task.value;
      const write = (child) => assign(task.target, task.key, child);
      if (typeof current === 'string') {
        write(redactSecretText(current));
        continue;
      }
      if (['bigint', 'symbol', 'function'].includes(typeof current)) {
        write(redactSecretText(String(current)));
        continue;
      }
      if (!current || typeof current !== 'object') {
        write(current);
        continue;
      }
      if (seen.has(current)) {
        write('[Circular]');
        continue;
      }
      seen.add(current);
      active.add(current);
      stack.push({ exit: current });

      if (current instanceof Date) {
        write(Number.isNaN(current.getTime()) ? '[Invalid Date]' : current.toISOString());
        continue;
      }
      if (current instanceof RegExp) { write(current.toString()); continue; }
      if (typeof URL !== 'undefined' && current instanceof URL) {
        write(redactSecretText(current.toString()));
        continue;
      }
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(current)) {
        write(`[Buffer ${current.length} bytes]`);
        continue;
      }
      if (typeof ArrayBuffer !== 'undefined' && current instanceof ArrayBuffer) {
        write(`[ArrayBuffer ${current.byteLength} bytes]`);
        continue;
      }
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(current)) {
        write(`[${current.constructor?.name || 'TypedArray'} ${current.byteLength} bytes]`);
        continue;
      }

      const children = [];
      const queueChild = (target, key, child) => {
        assign(target, key, undefined);
        children.push({ target, key, value: child });
      };
      if (current instanceof Map) {
        const entries = [];
        write({ $map: entries });
        for (const [key, child] of current.entries()) {
          if (typeof key === 'string' && isSecretKey(key)) continue;
          const pair = [];
          entries.push(pair);
          queueChild(pair, 0, key);
          queueChild(pair, 1, child);
        }
      } else if (current instanceof Set) {
        const entries = [];
        write({ $set: entries });
        for (const child of current.values()) queueChild(entries, entries.length, child);
      } else if (current instanceof Error) {
        const error = {
          name: redactSecretText(current.name || 'Error'),
          message: redactSecretText(current.message || ''),
          ...(current.stack ? { stack: redactSecretText(current.stack) } : {}),
        };
        write({ $error: error });
        if (current.cause !== undefined) queueChild(error, 'cause', current.cause);
      } else {
        const array = Array.isArray(current);
        let keys;
        try {
          keys = array
            ? Object.keys(current).filter((key) => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < current.length)
            : Object.keys(current);
        } catch (_) {
          write('[Unserializable object]');
          continue;
        }
        const copy = array ? new Array(current.length) : {};
        write(copy);
        for (const key of keys) {
          if (!array && isSecretKey(key)) continue;
          let child;
          try { child = current[key]; } catch (_) {
            assign(copy, key, '[Unserializable property]');
            continue;
          }
          queueChild(copy, key, child);
        }
      }
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    return result.value;
  } finally {
    for (const current of active) seen.delete(current);
  }
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
