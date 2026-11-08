(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RemoteCodexTheme = api;
    // Read-only bootstrap prevents a light flash for an already-saved dark theme.
    // The shared settings key also holds API profiles: NEVER write it here.
    let theme;
    try { theme = JSON.parse(root.localStorage.getItem('mobile-codex-remote.ui-settings.v1') || '{}')?.theme; }
    catch (_) { /* Blocked storage or malformed settings uses the default. */ }
    api.apply(root.document, theme);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const THEMES = Object.freeze({
    'minimal-light': Object.freeze({ colorScheme: 'light', browserColor: '#f5f6f4' }),
    'dark-tech': Object.freeze({ colorScheme: 'dark', browserColor: '#171b1e' }),
  });
  function normalize(value) { return value === 'dark-tech' ? value : 'minimal-light'; }
  function apply(document, value) {
    const id = normalize(value);
    if (!document?.documentElement) return id;
    document.documentElement.dataset.theme = id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEMES[id].browserColor);
    return id;
  }
  return Object.freeze({ normalize, apply, themes: THEMES });
}));
