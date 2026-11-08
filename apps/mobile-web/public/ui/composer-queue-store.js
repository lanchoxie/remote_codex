(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexComposerQueueStore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const VERSION = 1;
  const DEFAULT_KEY = 'remote-codex:composer-queue:v1';
  const DROP_KEYS = new Set([
    'fileObject', 'blob', 'previewObjectUrl', 'previewUrl', 'objectUrl',
    'element', 'node', 'dom', 'target', 'event', 'stream',
  ]);
  const RECOVERABLE_STATUSES = new Set([
    'queued', 'failed', 'input_unknown', 'steer_unknown', 'guide_pending', 'recovery_required',
  ]);
  const FINISHED_STATUSES = new Set(['guided', 'sent']);
  const MAX_DEPTH = 8;
  const MAX_ARRAY = 200;
  const MAX_STRING = 512 * 1024;
  const MAX_BASE64 = 1024 * 1024;

  function text(value) { return String(value == null ? '' : value); }
  function hasRemoteFileReference(file) {
    if (text(file?.remotePath || file?.fileId || '').trim()) return true;
    // A composer upload's `path` can be a local browser path. Uploaded-file
    // payloads use `path` only after the Host has returned the remote ref.
    return file?.type !== 'uploadFile' && Boolean(text(file?.path || '').trim());
  }
  function cloneSafe(value, depth = 0, key = '') {
    if (depth > MAX_DEPTH || DROP_KEYS.has(key)) return undefined;
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (key === 'dataBase64' && value.length > MAX_BASE64) return undefined;
      return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    }
    if (typeof value !== 'object') return undefined;
    if (typeof value?.byteLength === 'number' && !Array.isArray(value)) return undefined;
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY).map((entry) => cloneSafe(entry, depth + 1, '')).filter((entry) => entry !== undefined);
    }
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (DROP_KEYS.has(childKey)) continue;
      const safe = cloneSafe(childValue, depth + 1, childKey);
      if (safe !== undefined) result[childKey] = safe;
    }
    return result;
  }
  function normalizeAttachment(attachment) {
    const safe = cloneSafe(attachment) || {};
    const hadLocalFile = Boolean(attachment?.fileObject || attachment?.blob);
    const hasReference = hasRemoteFileReference(attachment) || Boolean(text(attachment?.dataBase64 || '').trim());
    if (hadLocalFile && !hasReference) {
      safe.recoveryRequired = true;
      safe.recoveryReason = 'local_file_unavailable';
    }
    return safe;
  }
  function normalizePayload(payload) {
    const safe = cloneSafe(payload) || {};
    const draft = payload?.composerDraft;
    if (draft && typeof draft === 'object') {
      safe.composerDraft = cloneSafe(draft) || {};
      if (Array.isArray(draft.attachments)) {
        safe.composerDraft.attachments = draft.attachments.map(normalizeAttachment);
      }
    }
    if (Array.isArray(payload?.uploadedFiles)) safe.uploadedFiles = payload.uploadedFiles.map(normalizeAttachment);
    if (Array.isArray(payload?.inlineFiles)) safe.inlineFiles = payload.inlineFiles.map((file) => cloneSafe(file) || {});
    return safe;
  }
  function itemNeedsRecovery(item) {
    const attachments = [
      ...(Array.isArray(item?.payload?.composerDraft?.attachments) ? item.payload.composerDraft.attachments : []),
      ...(Array.isArray(item?.payload?.uploadedFiles) ? item.payload.uploadedFiles : []),
    ];
    return attachments.some((file) => file?.recoveryRequired === true);
  }
  function serializeItem(item) {
    if (!item || !text(item.id).trim() || !text(item.sessionKey).trim()) return null;
    const status = text(item.status || 'queued').trim() || 'queued';
    if (FINISHED_STATUSES.has(status)) return null;
    const payload = normalizePayload(item.payload || {});
    const result = {
      id: text(item.id), sessionKey: text(item.sessionKey), hostId: text(item.hostId), sessionId: text(item.sessionId),
      text: text(item.text || payload.displayText || payload.composerDraft?.text),
      payload, createdAt: text(item.createdAt || new Date().toISOString()), sentAt: item.sentAt || null,
      status: RECOVERABLE_STATUSES.has(status) ? status : 'recovery_required',
      error: text(item.error),
      inputRequest: item.inputRequest ? cloneSafe(item.inputRequest) : null,
      steerOperation: item.steerOperation ? cloneSafe(item.steerOperation) : null,
    };
    if (itemNeedsRecovery(result) && result.status === 'queued') {
      result.status = 'recovery_required';
      result.error = 'The queued text was restored, but a browser-local attachment must be selected again before sending.';
    }
    if (item.sending || item.forceSending || status === 'sending' || status === 'forceSending') {
      result.status = 'recovery_required';
      result.error = 'The previous page closed while this message was being sent. Check the result before retrying.';
    }
    return result;
  }
  function normalizeLoadedItem(raw) {
    const item = serializeItem(raw);
    if (!item) return null;
    item.sending = false;
    item.forceSending = false;
    item.editing = false;
    if (!item.payload || typeof item.payload !== 'object') item.payload = { text: item.text, displayText: item.text };
    if (item.status === 'recovery_required' && !item.error) {
      item.error = 'This queued message needs attention before it can be sent.';
    }
    return item;
  }
  function createQueueStore(options = {}) {
    const storage = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const key = text(options.key || DEFAULT_KEY);
    const logger = options.logger || console;
    function save(items) {
      if (!storage?.setItem) return { ok: false, warning: 'storage_unavailable' };
      try {
        const record = { version: VERSION, savedAt: new Date().toISOString(), items: items.map(serializeItem).filter(Boolean) };
        storage.setItem(key, JSON.stringify(record));
        return { ok: true, count: record.items.length };
      } catch (error) {
        logger.warn?.('[queue] unable to persist queue; keeping in-memory state', error);
        return { ok: false, warning: 'storage_write_failed', error };
      }
    }
    function load() {
      if (!storage?.getItem) return { items: [], warning: 'storage_unavailable' };
      let raw;
      try { raw = storage.getItem(key); } catch (error) { return { items: [], warning: 'storage_read_failed', error }; }
      if (!raw) return { items: [] };
      try {
        const record = JSON.parse(raw);
        if (!record || record.version !== VERSION || !Array.isArray(record.items)) return { items: [], warning: 'storage_format_invalid' };
        const items = record.items.map(normalizeLoadedItem).filter(Boolean);
        return { items, savedAt: record.savedAt || null };
      } catch (error) {
        logger.warn?.('[queue] ignoring corrupt persisted queue', error);
        return { items: [], warning: 'storage_read_failed', error };
      }
    }
    return Object.freeze({ key, save, load, serializeItem, normalizeLoadedItem });
  }
  return Object.freeze({ VERSION, DEFAULT_KEY, createQueueStore, serializeItem, normalizeLoadedItem });
}));
