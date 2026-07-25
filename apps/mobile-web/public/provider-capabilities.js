(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexProviderCapabilities = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const REGISTRY_VERSION = '2026-07-19.1';
  const PROVIDER_KINDS = Object.freeze(['openai', 'anthropic', 'gemini', 'custom']);

  const PROVIDER_OPTIONS = Object.freeze([
    Object.freeze({
      value: 'openai',
      label: 'OpenAI',
      canonicalProvider: 'OpenAI',
      capabilityMode: 'advisory',
      reserved: false,
      allowManualEffortWhenUnknown: false,
    }),
    Object.freeze({
      value: 'anthropic',
      label: 'Anthropic',
      canonicalProvider: 'Anthropic',
      capabilityMode: 'reserved',
      reserved: true,
      allowManualEffortWhenUnknown: false,
    }),
    Object.freeze({
      value: 'gemini',
      label: 'Gemini',
      canonicalProvider: 'Gemini',
      capabilityMode: 'reserved',
      reserved: true,
      allowManualEffortWhenUnknown: false,
    }),
    Object.freeze({
      value: 'custom',
      label: 'Custom',
      canonicalProvider: 'Custom',
      capabilityMode: 'manual',
      reserved: false,
      allowManualEffortWhenUnknown: true,
    }),
  ]);

  const OPENAI_SOURCE = Object.freeze({
    sourceId: 'openai-official-model-capabilities',
    label: 'OpenAI model capability advisory snapshot',
    registryVersion: REGISTRY_VERSION,
    checkedAt: '2026-07-19',
    authority: 'advisory',
    runtimeAuthoritative: true,
    urls: Object.freeze([
      'https://developers.openai.com/api/docs/guides/reasoning',
      'https://developers.openai.com/api/docs/guides/latest-model',
      'https://developers.openai.com/api/docs/models',
    ]),
  });

  // Exact IDs only. Unknown aliases and future snapshots stay unknown until the
  // bundled advisory data is deliberately refreshed.
  const OPENAI_MODEL_RULES = Object.freeze([
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.6-sol']),
      reasoningLevels: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      defaultReasoningEffort: 'low',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.6-terra']),
      reasoningLevels: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      defaultReasoningEffort: 'medium',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.6-luna']),
      reasoningLevels: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
      defaultReasoningEffort: 'medium',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.5']),
      reasoningLevels: Object.freeze(['low', 'medium', 'high', 'xhigh']),
      defaultReasoningEffort: 'medium',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.5-2026-04-23']),
      reasoningLevels: Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']),
      defaultReasoningEffort: 'medium',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.5-pro', 'gpt-5.5-pro-2026-04-23']),
      reasoningLevels: Object.freeze(['medium', 'high', 'xhigh']),
      defaultReasoningEffort: 'high',
    }),
    Object.freeze({
      modelIds: Object.freeze([
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.2',
      ]),
      reasoningLevels: Object.freeze(['low', 'medium', 'high', 'xhigh']),
      defaultReasoningEffort: 'medium',
    }),
    Object.freeze({
      modelIds: Object.freeze([
        'gpt-5.4-2026-03-05',
        'gpt-5.4-mini-2026-03-17',
        'gpt-5.4-nano',
        'gpt-5.4-nano-2026-03-17',
        'gpt-5.2-2025-12-11',
      ]),
      reasoningLevels: Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']),
      defaultReasoningEffort: 'none',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.4-pro', 'gpt-5.4-pro-2026-03-05']),
      reasoningLevels: Object.freeze(['medium', 'high', 'xhigh']),
      defaultReasoningEffort: 'medium',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.3-codex']),
      reasoningLevels: Object.freeze(['low', 'medium', 'high', 'xhigh']),
      defaultReasoningEffort: null,
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5.1', 'gpt-5.1-2025-11-13']),
      reasoningLevels: Object.freeze(['none', 'low', 'medium', 'high']),
      defaultReasoningEffort: 'none',
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5', 'gpt-5-2025-08-07']),
      reasoningLevels: Object.freeze(['minimal', 'low', 'medium', 'high']),
      defaultReasoningEffort: null,
    }),
    Object.freeze({
      modelIds: Object.freeze(['gpt-5-pro', 'gpt-5-pro-2025-10-06']),
      reasoningLevels: Object.freeze(['high']),
      defaultReasoningEffort: 'high',
    }),
  ]);

  const PROVIDER_ALIASES = Object.freeze({
    openai: new Set(['openai', 'open ai', 'openai api', 'official openai']),
    anthropic: new Set(['anthropic', 'claude', 'anthropic claude', 'anthropic api', 'anthropic/claude']),
    gemini: new Set(['gemini', 'google gemini', 'gemini api', 'google ai', 'google/gemini']),
    custom: new Set(['custom']),
  });

  function cloneSource(source) {
    return source ? { ...source, urls: [...(source.urls || [])] } : null;
  }

  function cloneProviderOption(option) {
    return option ? { ...option } : null;
  }

  function listProviderOptions() {
    return PROVIDER_OPTIONS.map(cloneProviderOption);
  }

  function normalizedProviderLabel(value) {
    return String(value == null ? '' : value)
      .trim()
      .toLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  function explicitProviderKind(value) {
    const normalized = normalizedProviderLabel(value);
    return PROVIDER_KINDS.includes(normalized) ? normalized : '';
  }

  function inferProviderKind(input = '') {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const explicit = explicitProviderKind(
        input.providerKind || input.providerType || input.providerFamily
      );
      if (explicit) {
        return explicit;
      }
      input = input.provider || input.providerLabel || input.label || '';
    }

    const normalized = normalizedProviderLabel(input);
    for (const kind of PROVIDER_KINDS) {
      if (PROVIDER_ALIASES[kind].has(normalized)) {
        return kind;
      }
    }
    return 'custom';
  }

  function getProviderOption(input = '') {
    const kind = inferProviderKind(input);
    return cloneProviderOption(PROVIDER_OPTIONS.find((option) => option.value === kind));
  }

  function getProviderPolicy(input = '') {
    const option = getProviderOption(input);
    return {
      providerKind: option.value,
      label: option.label,
      canonicalProvider: option.canonicalProvider,
      capabilityMode: option.capabilityMode,
      reserved: option.reserved,
      allowManualEffortWhenUnknown: option.allowManualEffortWhenUnknown,
      registryVersion: REGISTRY_VERSION,
    };
  }

  function normalizeModelId(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function uniqueEfforts(values = []) {
    const seen = new Set();
    const efforts = [];
    for (const entry of Array.isArray(values) ? values : []) {
      const value = String(
        entry && typeof entry === 'object'
          ? entry.reasoningEffort || entry.reasoning_effort || entry.value || ''
          : entry
      ).trim();
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      efforts.push(value);
    }
    return efforts;
  }

  function runtimeReasoningDeclaration(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const keys = [
      'reasoningLevels',
      'supportedReasoningEfforts',
      'supported_reasoning_efforts',
    ];
    const declaredKey = keys.find((key) => Object.prototype.hasOwnProperty.call(raw, key));
    if (!declaredKey) {
      return null;
    }
    const levels = uniqueEfforts(raw[declaredKey] || []);
    const defaultReasoningEffort = String(
      raw.defaultReasoningEffort || raw.default_reasoning_effort || ''
    ).trim() || null;
    return {
      reasoningLevels: levels,
      defaultReasoningEffort,
    };
  }

  function findOpenAiRule(modelId) {
    const normalized = normalizeModelId(modelId);
    if (!normalized) {
      return null;
    }
    return OPENAI_MODEL_RULES.find((rule) => rule.modelIds.includes(normalized)) || null;
  }

  function getAdvisoryModelCapability(providerInput, modelId) {
    const providerKind = inferProviderKind(providerInput);
    if (providerKind !== 'openai') {
      return null;
    }
    const rule = findOpenAiRule(modelId);
    if (!rule) {
      return null;
    }
    return {
      model: String(modelId || '').trim(),
      providerKind,
      capabilityKnown: true,
      reasoningLevels: [...rule.reasoningLevels],
      defaultReasoningEffort: rule.defaultReasoningEffort || null,
      allowManualEffort: false,
      source: 'advisory',
      authority: 'advisory',
      advisory: true,
      runtimeDeclared: false,
      evidence: cloneSource(OPENAI_SOURCE),
    };
  }

  function unknownCapability(providerInput, modelId) {
    const policy = getProviderPolicy(providerInput);
    return {
      model: String(modelId || '').trim(),
      providerKind: policy.providerKind,
      capabilityKnown: false,
      reasoningLevels: [],
      defaultReasoningEffort: null,
      allowManualEffort: policy.allowManualEffortWhenUnknown,
      source: policy.allowManualEffortWhenUnknown ? 'manual' : 'unknown',
      authority: 'unknown',
      advisory: false,
      runtimeDeclared: false,
      reserved: policy.reserved,
      evidence: null,
    };
  }

  function resolveModelCapability(input = {}) {
    const providerInput = input.providerKind
      || input.providerType
      || input.provider
      || input.apiProfile
      || '';
    const runtime = input.runtimeCapability || input.runtime || input.modelMetadata || null;
    const modelId = input.modelId || input.model || runtime?.model || runtime?.id || '';
    const providerKind = inferProviderKind(providerInput);
    const declared = runtimeReasoningDeclaration(runtime);
    if (declared) {
      return {
        model: String(modelId || '').trim(),
        providerKind,
        capabilityKnown: true,
        reasoningLevels: [...declared.reasoningLevels],
        defaultReasoningEffort: declared.defaultReasoningEffort,
        allowManualEffort: false,
        source: 'runtime',
        authority: 'authoritative',
        advisory: false,
        runtimeDeclared: true,
        reserved: false,
        evidence: null,
      };
    }
    return getAdvisoryModelCapability(providerKind, modelId)
      || unknownCapability(providerKind, modelId);
  }

  function decorateModels(providerInput, models = []) {
    return (Array.isArray(models) ? models : []).map((raw) => {
      const model = raw && typeof raw === 'object' ? raw : { id: raw };
      const modelId = String(model.id || model.model || '').trim();
      const capability = resolveModelCapability({
        providerKind: inferProviderKind(providerInput),
        modelId,
        runtimeCapability: model,
      });
      return {
        ...model,
        id: String(model.id || modelId).trim(),
        reasoningLevels: [...capability.reasoningLevels],
        capabilityKnown: capability.capabilityKnown,
        defaultReasoningEffort: capability.defaultReasoningEffort,
        allowManualEffort: capability.allowManualEffort,
        capabilitySource: capability.source,
        capabilityAuthority: capability.authority,
        capabilityEvidence: capability.evidence ? cloneSource(capability.evidence) : null,
      };
    });
  }

  function listAdvisoryModelCapabilities(providerInput = 'openai') {
    if (inferProviderKind(providerInput) !== 'openai') {
      return [];
    }
    return OPENAI_MODEL_RULES.flatMap((rule) => rule.modelIds.map((modelId) => (
      getAdvisoryModelCapability('openai', modelId)
    )));
  }

  function createAdvisoryOverrideSource(providerInput, modelIds = null) {
    const requestedIds = Array.isArray(modelIds)
      ? [...new Set(modelIds.map((entry) => normalizeModelId(
        entry && typeof entry === 'object' ? entry.id || entry.model : entry
      )).filter(Boolean))]
      : null;
    const capabilities = requestedIds
      ? requestedIds.map((modelId) => getAdvisoryModelCapability(providerInput, modelId)).filter(Boolean)
      : listAdvisoryModelCapabilities(providerInput);
    if (!capabilities.length) {
      return null;
    }
    return {
      source: 'override',
      originSource: 'provider-capability-registry',
      authority: 'capability-only',
      complete: false,
      truncated: false,
      stale: false,
      registryVersion: REGISTRY_VERSION,
      evidence: cloneSource(OPENAI_SOURCE),
      models: capabilities.map((capability) => ({
        id: capability.model,
        reasoningLevels: [...capability.reasoningLevels],
        defaultReasoningEffort: capability.defaultReasoningEffort,
      })),
    };
  }

  return {
    REGISTRY_VERSION,
    PROVIDER_KINDS,
    PROVIDER_OPTIONS,
    OPENAI_SOURCE,
    createAdvisoryOverrideSource,
    decorateModels,
    getAdvisoryModelCapability,
    getProviderOption,
    getProviderPolicy,
    inferProviderKind,
    listAdvisoryModelCapabilities,
    listProviderOptions,
    resolveModelCapability,
    runtimeReasoningDeclaration,
  };
}));
