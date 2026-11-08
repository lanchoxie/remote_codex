(function initStructuredText(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexStructuredText = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const TEXT_KEYS = [
    'text', 'output_text', 'outputText', 'input_text', 'inputText',
    'content', 'summary', 'message', 'description', 'title', 'label',
    'delta', 'value', 'step', 'command', 'query', 'path', 'output',
    'stdout', 'stderr', 'reason',
  ];
  const SCALAR_KEYS = ['type', 'status', 'state', 'phase', 'kind', 'name', 'id'];

  function safeJson(value, options = {}) {
    const maxDepth = Number.isSafeInteger(options.maxDepth) ? Math.max(1, options.maxDepth) : 8;
    const maxKeys = Number.isSafeInteger(options.maxKeys) ? Math.max(1, options.maxKeys) : 64;
    const maxItems = Number.isSafeInteger(options.maxItems) ? Math.max(1, options.maxItems) : 64;
    const seen = new WeakSet();
    function clone(input, depth) {
      if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return input;
      if (typeof input === 'undefined') return null;
      if (typeof input !== 'object') return String(input);
      if (seen.has(input)) return '[Circular]';
      if (depth >= maxDepth) return '[Nested value omitted]';
      seen.add(input);
      try {
        if (input instanceof Date) return Number.isNaN(input.getTime()) ? '[Invalid Date]' : input.toISOString();
        if (input instanceof RegExp) return input.toString();
        if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(input)) return `[Buffer ${input.length} bytes]`;
        if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return `[ArrayBuffer ${input.byteLength} bytes]`;
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(input)) {
          return `[${input.constructor?.name || 'TypedArray'} ${input.byteLength} bytes]`;
        }
        if (input instanceof Map) {
          const entries = [];
          let index = 0;
          for (const [key, item] of input.entries()) {
            if (index >= maxItems) break;
            entries.push([clone(key, depth + 1), clone(item, depth + 1)]);
            index += 1;
          }
          if (input.size > maxItems) entries.push(`[${input.size - maxItems} more entries]`);
          return { $map: entries };
        }
        if (input instanceof Set) {
          const items = [];
          let index = 0;
          for (const item of input.values()) {
            if (index >= maxItems) break;
            items.push(clone(item, depth + 1));
            index += 1;
          }
          if (input.size > maxItems) items.push(`[${input.size - maxItems} more items]`);
          return { $set: items };
        }
        if (input instanceof Error) {
          return {
            $error: {
              name: String(input.name || 'Error'),
              message: String(input.message || ''),
              ...(input.stack ? { stack: String(input.stack) } : {}),
              ...(input.cause !== undefined ? { cause: clone(input.cause, depth + 1) } : {}),
            },
          };
        }
        if (Array.isArray(input)) {
          const result = input.slice(0, maxItems).map((item) => clone(item, depth + 1));
          if (input.length > maxItems) result.push(`[${input.length - maxItems} more items]`);
          return result;
        }
        const result = {};
        let keys;
        try { keys = Object.keys(input); } catch (_) { return '[Unserializable object]'; }
        for (const key of keys.slice(0, maxKeys)) {
          try { result[key] = clone(input[key], depth + 1); } catch (_) { result[key] = '[Unserializable property]'; }
        }
        if (keys.length > maxKeys) result._truncatedKeys = true;
        return result;
      } finally {
        seen.delete(input);
      }
    }
    try { return JSON.stringify(clone(value, 0)); } catch (_) { return ''; }
  }

  function toText(value, options = {}) {
    const maxDepth = Number.isSafeInteger(options.maxDepth) ? Math.max(1, options.maxDepth) : 8;
    const maxKeys = Number.isSafeInteger(options.maxKeys) ? Math.max(1, options.maxKeys) : 64;
    const maxItems = Number.isSafeInteger(options.maxItems) ? Math.max(1, options.maxItems) : 64;
    const seen = options.seen instanceof WeakSet ? options.seen : new WeakSet();
    const depth = Number.isSafeInteger(options.depth) ? options.depth : 0;
    if (value === null || typeof value === 'undefined') return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    if (depth >= maxDepth) return safeJson(value, { maxDepth, maxKeys, maxItems });
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.slice(0, maxItems)
          .map((item) => toText(item, { ...options, depth: depth + 1, seen, maxDepth, maxKeys, maxItems }))
          .filter((item) => item && item.trim())
          .join(options.separator || '\n')
          .trim();
      }
      for (const key of TEXT_KEYS) {
        let candidate;
        try {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          candidate = value[key];
        } catch (_) { continue; }
        if (candidate == null) continue;
        const text = toText(candidate, { ...options, depth: depth + 1, seen, maxDepth, maxKeys, maxItems }).trim();
        if (text) return text;
      }
      for (const key of SCALAR_KEYS) {
        let candidate;
        try {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          candidate = value[key];
        } catch (_) { continue; }
        if (candidate == null) continue;
        const text = toText(candidate, { ...options, depth: depth + 1, seen, maxDepth, maxKeys, maxItems }).trim();
        if (text) return text;
      }
      return safeJson(value, { maxDepth, maxKeys, maxItems });
    } finally {
      seen.delete(value);
    }
  }

  function toScalar(value, fallback = '') {
    if (value === null || typeof value === 'undefined' || value === '') return fallback;
    if (typeof value !== 'object') return String(value);
    for (const key of SCALAR_KEYS) {
      let candidate;
      try { candidate = value[key]; } catch (_) { continue; }
      if (candidate == null || candidate === '') continue;
      const text = toScalar(candidate, '').trim();
      if (text) return text;
    }
    return toText(value) || fallback;
  }

  return { safeJson, toScalar, toText };
}));
