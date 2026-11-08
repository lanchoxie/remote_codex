(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexManagedSessionLaunchIntent = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function isWindowsPlatform(platform) {
    const value = text(platform).toLowerCase();
    return value === 'win32' || value === 'windows' || value.startsWith('win');
  }

  function normalizeLaunchPath(value, platform = '') {
    const windows = isWindowsPlatform(platform);
    let normalized = text(value);
    const unc = windows && /^[\\/]{2}/.test(normalized);
    if (windows) normalized = normalized.replace(/\\/g, '/');
    normalized = normalized.replace(/\/+/g, '/');
    if (unc) normalized = `/${normalized}`;
    const windowsDriveRoot = windows && /^[a-z]:\/$/i.test(normalized);
    if (normalized.length > 1 && !windowsDriveRoot) normalized = normalized.replace(/\/$/, '');
    return windows ? normalized.toLowerCase() : normalized;
  }

  function sourceSessionIdentity(sourceSession) {
    if (!sourceSession || typeof sourceSession !== 'object') return '';
    return text(
      sourceSession.nativeThreadId
      || sourceSession.bridgeSessionId
      || sourceSession.originSessionId
      || sourceSession.conversationKey
      || sourceSession.sessionId
      || sourceSession.runId
      || sourceSession.activeRunId
    );
  }

  function createLaunchIntentKey({ hostId, hostPlatform, cwd, launchMode, sourceSession } = {}) {
    return JSON.stringify([
      text(hostId),
      normalizeLaunchPath(cwd, hostPlatform),
      text(launchMode) || 'fresh',
      sourceSessionIdentity(sourceSession),
    ]);
  }

  return Object.freeze({
    isWindowsPlatform,
    normalizeLaunchPath,
    sourceSessionIdentity,
    createLaunchIntentKey,
  });
}));
