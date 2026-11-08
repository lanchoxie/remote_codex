(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexModelReasoning = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const LEVEL_KEYS = [
    'reasoningLevels',
    'supportedReasoningEfforts',
    'supported_reasoning_efforts',
    'supported_reasoning_levels',
  ];
  const DEFAULT_KEYS = ['defaultReasoningEffort', 'default_reasoning_effort', 'default_reasoning_level'];
  const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

  function effortValue(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return EFFORT_PATTERN.test(normalized) ? normalized : null;
  }

  // Parse optional catalog metadata, not user selections. Missing or malformed
  // metadata is unknown; only an actual empty array declares no effort choices.
  // Keep this distinction across normalization, persistence and browser display.
  function parseReasoningMetadata(input) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const key = LEVEL_KEYS.find((name) => Object.prototype.hasOwnProperty.call(raw, name) && Array.isArray(raw[name]));
    const entries = raw[key];
    const levels = raw.reasoningDeclared === false || !Array.isArray(entries) ? [] : [...new Set(entries
      .map((entry) => entry && typeof entry === 'object'
        ? entry.reasoningEffort ?? entry.reasoning_effort ?? entry.effort ?? entry.value
        : entry)
      .map(effortValue)
      .filter(Boolean))];
    const declared = raw.reasoningDeclared !== false
      && Array.isArray(entries)
      && (entries.length === 0 || levels.length > 0);
    const defaultKey = DEFAULT_KEYS.find((name) => Object.prototype.hasOwnProperty.call(raw, name));
    const defaultValue = raw[defaultKey];
    const normalizedDefault = effortValue(defaultValue);
    const defaultDeclared = raw.defaultReasoningEffortDeclared !== false
      && defaultKey !== undefined
      && (defaultValue === null || defaultValue === '' || normalizedDefault !== null);
    return {
      declared,
      levels,
      defaultDeclared,
      defaultReasoningEffort: defaultDeclared ? normalizedDefault : null,
    };
  }

  return { parseReasoningMetadata };
}));
