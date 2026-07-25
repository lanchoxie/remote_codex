const { redactSecretText } = require('../../shared/secret-redaction');

const CATALOG_ERROR_MAX_LENGTH = 400;
const INVALID_HTML_CATALOG_ERROR = 'The API returned an HTML page instead of a recognizable model catalog. Check whether the Base URL needs /v1.';
const EMPTY_CATALOG_ERROR = 'The model catalog request failed without a readable error.';

function normalizeCatalogError(value) {
  const raw = value instanceof Error ? value.message : value;
  const text = redactSecretText(raw == null ? '' : String(raw))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return EMPTY_CATALOG_ERROR;
  }
  if (
    /<!doctype\s+html\b/i.test(text)
    || /<\/?[a-z][^>]*>/i.test(text)
  ) {
    return INVALID_HTML_CATALOG_ERROR;
  }
  if (text.length <= CATALOG_ERROR_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, CATALOG_ERROR_MAX_LENGTH - 3)}...`;
}

class ModelCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelCatalogError';
    this.code = code;
    this.statusCode = Number(details.statusCode || 409);
    Object.assign(this, details);
  }
}

function providerKindForInput(input = {}) {
  return String(input.providerKind || input.apiConfig?.providerKind || '').trim().toLowerCase() || 'unknown';
}

function providerModelsMayBypassLiveCatalog(input = {}) {
  return input.allowProviderModelsWithoutLive === true || providerKindForInput(input) === 'custom';
}

function catalogKey(input = {}) {
  const { hostId, bindingFingerprint, runId, nativeThreadId } = input;
  return [
    hostId,
    bindingFingerprint,
    runId || nativeThreadId || '-',
    providerKindForInput(input),
  ].map((value) => encodeURIComponent(String(value || ''))).join('::');
}

function inFlightKey(input = {}) {
  const providerCapability = input.apiConfig ? 'provider-enabled' : 'live-only';
  const selectionPolicy = providerModelsMayBypassLiveCatalog(input)
    ? 'provider-models-selectable'
    : 'live-models-required';
  return `${catalogKey(input)}::${providerCapability}::${selectionPolicy}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function normalizeReasoningEffort(value, options = {}) {
  const submitted = String(value || '').trim();
  const effort = submitted.toLowerCase();
  if (!effort) {
    return null;
  }
  if (!REASONING_EFFORT_PATTERN.test(effort)) {
    if (options.rejectInvalid === true) {
      throw new ModelCatalogError(
        'session_effort_invalid',
        `Invalid reasoning effort "${submitted}".`,
        {
          statusCode: 422,
          model: options.model || null,
          effort: submitted,
          expectedPattern: REASONING_EFFORT_PATTERN.source,
        }
      );
    }
    return null;
  }
  return effort;
}

function reasoningMetadata(raw = {}) {
  const hasMetadata = typeof raw.reasoningDeclared === 'boolean'
    ? raw.reasoningDeclared
    : Object.prototype.hasOwnProperty.call(raw, 'reasoningLevels')
      || Object.prototype.hasOwnProperty.call(raw, 'supportedReasoningEfforts')
      || Object.prototype.hasOwnProperty.call(raw, 'supported_reasoning_efforts');
  const hasDefault = typeof raw.defaultReasoningEffortDeclared === 'boolean'
    ? raw.defaultReasoningEffortDeclared
    : Object.prototype.hasOwnProperty.call(raw, 'defaultReasoningEffort')
      || Object.prototype.hasOwnProperty.call(raw, 'default_reasoning_effort');
  const values = raw.reasoningLevels
    || raw.supportedReasoningEfforts
    || raw.supported_reasoning_efforts
    || [];
  const defaultValue = raw.defaultReasoningEffort ?? raw.default_reasoning_effort;
  return {
    declared: hasMetadata,
    levels: uniqueStrings(values
      .map((value) => value?.reasoningEffort || value?.reasoning_effort || value)
      .map((value) => normalizeReasoningEffort(value))
      .filter(Boolean)),
    defaultDeclared: hasDefault,
    defaultReasoningEffort: normalizeReasoningEffort(defaultValue),
  };
}

function normalizeModel(raw = {}) {
  const id = String(raw.id || raw.model || raw.slug || '').trim();
  const reasoning = reasoningMetadata(raw);
  return {
    id,
    displayName: String(raw.displayName || raw.display_name || raw.name || '').trim() || null,
    reasoningLevels: reasoning.levels,
    reasoningDeclared: reasoning.declared,
    defaultReasoningEffort: reasoning.defaultReasoningEffort,
    defaultReasoningEffortDeclared: reasoning.defaultDeclared,
    isDefault: Boolean(raw.isDefault || raw.is_default),
    visible: raw.visible !== false && raw.hidden !== true,
  };
}

function normalizeSource(raw = {}, fallbackSource = 'unknown') {
  const source = String(raw.source || fallbackSource);
  const originSource = String(raw.originSource || raw.origin_source || '').trim()
    || (['live', 'provider'].includes(source) ? source : null);
  return {
    source,
    originSource,
    authority: String(raw.authority || 'advisory'),
    complete: raw.complete === true,
    truncated: raw.truncated === true,
    nextCursor: raw.nextCursor || raw.next_cursor || null,
    stale: raw.stale === true,
    error: raw.error == null ? null : normalizeCatalogError(raw.error),
    fetchedAt: raw.fetchedAt || raw.fetched_at || null,
    evidenceAuthority: raw.evidenceAuthority || null,
    evidenceComplete: raw.evidenceComplete === true,
    evidenceTruncated: raw.evidenceTruncated === true,
    evidenceNextCursor: raw.evidenceNextCursor || null,
    evidenceFetchedAt: raw.evidenceFetchedAt || null,
    providerKind: String(raw.providerKind || raw.provider_kind || '').trim().toLowerCase() || null,
    models: (Array.isArray(raw.models) ? raw.models : []).map(normalizeModel).filter((model) => model.id),
  };
}

function lastKnownGoodSource(raw, fallbackOrigin = null) {
  const source = normalizeSource(raw, raw?.source);
  const originSource = source.originSource || fallbackOrigin;
  if (!['live', 'provider'].includes(originSource)) {
    return null;
  }
  const alreadyFallback = source.source === 'last-known-good';
  return normalizeSource({
    ...source,
    source: 'last-known-good',
    originSource,
    authority: 'advisory',
    stale: true,
    complete: false,
    truncated: false,
    nextCursor: null,
    error: null,
    evidenceAuthority: alreadyFallback ? source.evidenceAuthority : source.authority,
    evidenceComplete: alreadyFallback ? source.evidenceComplete : source.complete,
    evidenceTruncated: alreadyFallback ? source.evidenceTruncated : source.truncated,
    evidenceNextCursor: alreadyFallback ? source.evidenceNextCursor : source.nextCursor,
    evidenceFetchedAt: alreadyFallback ? source.evidenceFetchedAt : source.fetchedAt,
  }, 'last-known-good');
}

function lastKnownGoodRank(source) {
  const completeAuthoritative = source.evidenceAuthority === 'authoritative'
    && source.evidenceComplete === true
    && source.evidenceTruncated !== true
    && !source.evidenceNextCursor;
  const fetchedAt = Date.parse(source.evidenceFetchedAt || source.fetchedAt || '');
  return [
    Number(completeAuthoritative),
    source.models.length,
    Number.isFinite(fetchedAt) ? fetchedAt : 0,
  ];
}

function compareLastKnownGood(left, right) {
  const leftRank = lastKnownGoodRank(left);
  const rightRank = lastKnownGoodRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) {
      return rightRank[index] - leftRank[index];
    }
  }
  return 0;
}

function sourceProvesAbsence(source, expectedKind) {
  return source.source === expectedKind
    && source.authority === 'authoritative'
    && source.complete === true
    && source.truncated !== true
    && !source.nextCursor
    && source.stale !== true
    && !source.error;
}

function emptyModel(id) {
  return {
    id,
    displayName: null,
    cliSupported: 'unknown',
    providerAdvertised: 'unknown',
    availability: 'unknown',
    previouslyAdvertised: false,
    reasoningLevels: [],
    defaultReasoningEffort: null,
    capabilityKnown: false,
    capabilitySource: null,
    isDefault: false,
    visible: true,
    selectable: true,
    sources: [],
  };
}

function mergeCatalogSources(rawSources = [], options = {}) {
  const sources = rawSources.map((source) => normalizeSource(source, source?.source));
  const liveProvesAbsence = sources.some((source) => sourceProvesAbsence(source, 'live'));
  const providerProvesAbsence = sources.some((source) => sourceProvesAbsence(source, 'provider'));
  const providerModelsMayBypassLive = options.allowProviderModelsWithoutLive === true;
  const providerEvidenceModelIds = new Set(sources
    .filter((source) => (
      !source.error
      && (source.source === 'provider' || source.originSource === 'provider')
    ))
    .flatMap((source) => source.models.map((model) => model.id)));
  const boundProviderEvidenceProvesAbsence = providerModelsMayBypassLive
    && sources.some((source) => (
      (source.source === 'last-known-good' || source.stale === true)
      && source.originSource === 'provider'
      && source.evidenceAuthority === 'authoritative'
      && source.evidenceComplete === true
      && source.evidenceTruncated !== true
      && !source.evidenceNextCursor
      && !source.error
    ));
  const providerSelectionProvesAbsence = providerProvesAbsence || boundProviderEvidenceProvesAbsence;
  const byId = new Map();

  const orderedSources = [...sources].sort((left, right) => {
    const rank = { 'last-known-good': 0, override: 1, provider: 2, live: 3 };
    return (rank[left.source] ?? -1) - (rank[right.source] ?? -1);
  });

  for (const source of orderedSources) {
    for (const model of source.models) {
      const current = byId.get(model.id) || emptyModel(model.id);
      current.sources = uniqueStrings([...current.sources, source.source]);
      if (model.displayName && (!current.displayName || source.source === 'live')) {
        current.displayName = model.displayName;
      }

      if (source.source === 'last-known-good') {
        current.previouslyAdvertised = true;
        if (!current.reasoningLevels.length) {
          current.reasoningLevels = [...model.reasoningLevels];
        }
        if (!current.defaultReasoningEffort && model.defaultReasoningEffort) {
          current.defaultReasoningEffort = model.defaultReasoningEffort;
        }
      } else if (source.source === 'override') {
        if (model.reasoningDeclared && current.capabilitySource !== 'live') {
          current.reasoningLevels = [...model.reasoningLevels];
          current.defaultReasoningEffort = model.defaultReasoningEffort;
          current.capabilityKnown = true;
          current.capabilitySource = 'override';
        } else if (
          model.defaultReasoningEffortDeclared
          && current.capabilitySource !== 'live'
        ) {
          current.defaultReasoningEffort = model.defaultReasoningEffort;
        }
      } else if (source.source === 'provider') {
        if (!source.error && !source.stale) {
          current.providerAdvertised = true;
          current.availability = 'available';
          if (model.reasoningDeclared && current.capabilitySource !== 'live') {
            current.reasoningLevels = [...model.reasoningLevels];
            current.defaultReasoningEffort = model.defaultReasoningEffort;
            current.capabilityKnown = true;
            current.capabilitySource = 'provider';
          } else if (
            model.defaultReasoningEffortDeclared
            && current.capabilitySource !== 'live'
          ) {
            current.defaultReasoningEffort = model.defaultReasoningEffort;
          }
        }
      } else if (source.source === 'live') {
        if (!source.error && !source.stale) {
          current.cliSupported = true;
          current.visible = model.visible;
          current.isDefault = model.isDefault;
          if (model.reasoningDeclared) {
            current.reasoningLevels = [...model.reasoningLevels];
            current.defaultReasoningEffort = model.defaultReasoningEffort;
            current.capabilityKnown = true;
            current.capabilitySource = 'live';
          } else if (model.defaultReasoningEffortDeclared) {
            current.defaultReasoningEffort = model.defaultReasoningEffort;
          }
        }
      }
      byId.set(model.id, current);
    }
  }

  for (const model of byId.values()) {
    if (
      liveProvesAbsence
      && !model.sources.includes('live')
      && !(providerModelsMayBypassLive && providerEvidenceModelIds.has(model.id))
    ) {
      model.cliSupported = false;
    }
    if (providerSelectionProvesAbsence && !providerEvidenceModelIds.has(model.id)) {
      model.providerAdvertised = false;
      model.availability = 'unavailable';
    }
    model.selectable = model.availability !== 'unavailable' && model.cliSupported !== false;
  }

  function lookup(modelId) {
    const id = String(modelId || '').trim();
    if (byId.has(id)) {
      return structuredClone(byId.get(id));
    }
    const model = emptyModel(id);
    if (liveProvesAbsence) {
      model.cliSupported = false;
    }
    if (providerSelectionProvesAbsence) {
      model.providerAdvertised = false;
      model.availability = 'unavailable';
    }
    model.selectable = model.availability !== 'unavailable' && model.cliSupported !== false;
    return model;
  }

  const defaultModel = [...byId.values()].find((model) => model.isDefault)?.id || null;

  function validate(selection = {}, options = {}) {
    const requestedModelId = String(selection.model || '').trim();
    const modelId = requestedModelId || defaultModel || '';
    const effort = normalizeReasoningEffort(selection.effort, {
      rejectInvalid: true,
      model: modelId || null,
    });
    if (!requestedModelId && !effort) {
      return null;
    }
    const model = modelId ? lookup(modelId) : emptyModel('');
    if (modelId && model.availability === 'unavailable') {
      throw new ModelCatalogError(
        'session_model_unavailable',
        `Model "${modelId}" is not advertised by the current API account.`,
        { model: modelId }
      );
    }
    if (modelId && model.cliSupported === false) {
      throw new ModelCatalogError(
        'session_model_unsupported',
        `Model "${modelId}" is not supported by this Session app-server.`,
        { model: modelId }
      );
    }
    if (effort) {
      if (model.capabilityKnown) {
        if (!model.reasoningLevels.includes(effort)) {
          throw new ModelCatalogError(
            'session_effort_unsupported',
            `Reasoning effort "${effort}" is not supported by "${modelId}".`,
            { model: modelId, effort, reasoningLevels: model.reasoningLevels }
          );
        }
      } else {
        const allowUnverifiedEffort = options.allowUnverifiedEffort === true
          || selection.allowUnverifiedEffort === true;
        if (allowUnverifiedEffort && options.allowManualEffortWhenUnknown === false) {
          throw new ModelCatalogError(
            'session_effort_unsupported',
            'Manual effort values for unknown models are available only for Custom API providers.',
            {
              model: modelId || null,
              effort,
              capabilityUnknown: true,
              providerKind: options.providerKind || 'unknown',
            }
          );
        }
        if (!allowUnverifiedEffort) {
          throw new ModelCatalogError(
            'session_effort_unverified',
            modelId
              ? `Reasoning effort "${effort}" cannot be verified for "${modelId}".`
              : `Reasoning effort "${effort}" cannot be verified because the default model is unknown.`,
            {
              model: modelId || null,
              effort,
              capabilityUnknown: true,
              allowUnverifiedEffort: false,
              defaultModelUsed: !requestedModelId && Boolean(defaultModel),
            }
          );
        }
      }
    }
    return model;
  }

  const models = [...byId.values()]
    .map((model) => structuredClone(model))
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault)
      || String(left.displayName || left.id).localeCompare(String(right.displayName || right.id)));
  return {
    models,
    sources: structuredClone(sources),
    defaultModel,
    lookup,
    validate,
    controlsFor(modelId) {
      const model = lookup(modelId);
      return {
        allowAuto: true,
        capabilityKnown: model.capabilityKnown,
        reasoningLevels: model.capabilityKnown ? [...model.reasoningLevels] : [],
        defaultReasoningEffort: model.defaultReasoningEffort,
      };
    },
  };
}

class ModelCatalogService {
  constructor(options = {}) {
    if (!options.store) {
      throw new TypeError('ModelCatalogService requires a SessionRecordStore');
    }
    this.store = options.store;
    this.fetchLivePage = options.fetchLivePage || null;
    this.fetchProviderPage = options.fetchProviderPage || null;
    this.overrides = Array.isArray(options.overrides) ? options.overrides : [];
    this.now = options.now || (() => new Date().toISOString());
    this.timeoutMs = Math.max(1, Number(options.timeoutMs || 15_000));
    this.staleMs = Math.max(0, Number(options.staleMs || 300_000));
    this.inFlight = new Map();
  }

  get(input = {}) {
    const key = catalogKey(input);
    const requestKey = inFlightKey(input);
    if (!input.hostId || !input.bindingFingerprint) {
      return Promise.reject(new ModelCatalogError(
        'session_api_binding_unavailable',
        'Model catalog requires a Host and API binding fingerprint.'
      ));
    }
    if (this.inFlight.has(requestKey)) {
      return this.inFlight.get(requestKey);
    }
    const cached = this.readCache(input, key);
    if (!input.force && cached && this.cacheAge(cached) <= this.staleMs) {
      const result = Promise.resolve(this.catalogFromCache(cached, 'fresh', input));
      return result;
    }
    const request = this.load(input, key, cached);
    this.inFlight.set(requestKey, request);
    request.then(
      () => { if (this.inFlight.get(requestKey) === request) this.inFlight.delete(requestKey); },
      () => { if (this.inFlight.get(requestKey) === request) this.inFlight.delete(requestKey); }
    );
    return request;
  }

  readCache(input, key) {
    const record = this.store.readRecord(input.identity || {
      hostId: input.hostId,
      sessionId: input.sessionId || input.nativeThreadId,
    });
    const cache = record?.catalog?.[key] || null;
    const providerKind = providerKindForInput(input);
    if (cache?.providerKind && String(cache.providerKind).toLowerCase() !== providerKind) {
      return null;
    }
    return cache;
  }

  cacheAge(cache) {
    const nowMs = Date.parse(this.now());
    const savedMs = Date.parse(cache.savedAt || '');
    if (!Number.isFinite(nowMs) || !Number.isFinite(savedMs)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, nowMs - savedMs);
  }

  catalogFromCache(cache, cacheState, input = {}) {
    const providerKind = providerKindForInput(input);
    const cachedSources = (cache.sources || []).filter((source) => (
      source?.source !== 'override'
      && (!source.providerKind || String(source.providerKind).toLowerCase() === providerKind)
    ));
    const catalog = mergeCatalogSources([
      ...cachedSources,
      ...this.overrideSources(input),
    ], {
      allowProviderModelsWithoutLive: providerModelsMayBypassLiveCatalog(input),
    });
    catalog.cacheState = cacheState;
    catalog.savedAt = cache.savedAt || null;
    catalog.providerKind = providerKind;
    catalog.allowProviderModelsWithoutLive = providerModelsMayBypassLiveCatalog(input);
    return catalog;
  }

  async withTimeout(fetcher, input, sourceName) {
    if (!fetcher) {
      return null;
    }
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fetcher(input)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${sourceName} model catalog timed out after ${this.timeoutMs}ms`)),
            this.timeoutMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  overrideSources(input) {
    const inputProviderKind = providerKindForInput(input);
    const matching = this.overrides.filter((entry) => {
      if (entry.bindingFingerprint && entry.bindingFingerprint !== input.bindingFingerprint) {
        return false;
      }
      if (entry.hostId && entry.hostId !== input.hostId) {
        return false;
      }
      if (entry.providerKind && String(entry.providerKind).toLowerCase() !== inputProviderKind) {
        return false;
      }
      return true;
    });
    if (!matching.length) {
      return [];
    }
    if (matching.some((entry) => Array.isArray(entry.models))) {
      return matching.map((entry) => normalizeSource({
        ...entry,
        source: 'override',
        authority: 'capability-only',
      }, 'override'));
    }
    return [normalizeSource({
      source: 'override',
      authority: 'capability-only',
      complete: false,
      providerKind: inputProviderKind,
      models: matching,
    }, 'override')];
  }

  staleSources(cache, input = {}) {
    if (!cache) {
      return [];
    }
    const providerKind = providerKindForInput(input);
    const candidatesByOrigin = new Map();
    for (const rawSource of cache.sources || []) {
      if (rawSource?.providerKind && String(rawSource.providerKind).toLowerCase() !== providerKind) {
        continue;
      }
      const fallback = lastKnownGoodSource(rawSource);
      if (!fallback) {
        continue;
      }
      if (!candidatesByOrigin.has(fallback.originSource)) {
        candidatesByOrigin.set(fallback.originSource, []);
      }
      candidatesByOrigin.get(fallback.originSource).push(fallback);
    }
    return [...candidatesByOrigin.values()]
      .map((candidates) => [...candidates].sort(compareLastKnownGood)[0]);
  }

  async persistCatalog(input = {}, catalog = null, operation = 'session.model_catalog.saved') {
    const key = catalogKey(input);
    if (!input.hostId || !input.bindingFingerprint || !catalog || typeof catalog !== 'object') {
      throw new ModelCatalogError(
        'session_api_binding_unavailable',
        'A verified model catalog and binding are required before it can be saved.'
      );
    }
    const providerKind = providerKindForInput(input);
    const sources = (Array.isArray(catalog.sources) ? catalog.sources : [])
      .filter((source) => source && !source.error)
      .map((source) => structuredClone(source));
    if (!sources.length) {
      throw new ModelCatalogError(
        'session_api_binding_unavailable',
        'The verified model catalog has no reusable source evidence.'
      );
    }
    const savedAt = catalog.savedAt || this.now();
    await this.store.transact(operation, (tx) => {
      const canonicalKey = tx.resolveCanonicalKey(input.identity || {
        hostId: input.hostId,
        sessionId: input.sessionId || input.nativeThreadId,
      });
      const record = tx.ensureRecord(canonicalKey, {
        hostId: input.hostId,
        conversationKey: input.sessionId || input.nativeThreadId,
      });
      record.catalog ||= {};
      record.catalog[key] = {
        savedAt,
        providerKind,
        sources,
      };
      record.updatedAt = this.now();
      tx.markDirty(canonicalKey);
    });
  }

  async inheritRunCatalog(input = {}, sourceRunId = null) {
    const normalizedSourceRunId = String(sourceRunId || '').trim();
    if (!normalizedSourceRunId || normalizedSourceRunId === String(input.runId || '').trim()) {
      return null;
    }
    const sourceInput = {
      ...input,
      runId: normalizedSourceRunId,
      force: false,
    };
    const cached = this.readCache(sourceInput, catalogKey(sourceInput));
    if (!cached) {
      return null;
    }
    const catalog = this.catalogFromCache(cached, 'inherited', input);
    if (!catalog.sources.some((source) => source && !source.error)) {
      return null;
    }
    await this.persistCatalog(input, catalog, 'session.model_catalog.inherited');
    return catalog;
  }

  async load(input, key, cache) {
    const providerKind = providerKindForInput(input);
    const requests = [
      ['live', this.fetchLivePage],
      ['provider', this.fetchProviderPage],
    ];
    const fetched = await Promise.all(requests.map(async ([sourceName, fetcher]) => {
      if (!fetcher) {
        return null;
      }
      try {
        const result = await this.withTimeout(fetcher, input, sourceName);
        return normalizeSource({
          ...result,
          source: sourceName,
          providerKind: result?.providerKind || providerKind,
        }, sourceName);
      } catch (error) {
        return normalizeSource({
          source: sourceName,
          authority: 'advisory',
          complete: false,
          error: normalizeCatalogError(error),
          fetchedAt: this.now(),
          providerKind,
          models: [],
        }, sourceName);
      }
    }));
    const freshSources = fetched.filter(Boolean);
    const successful = freshSources.filter((source) => !source.error);
    const completeRefreshOrigins = new Set(successful
      .filter((source) => sourceProvesAbsence(source, source.source))
      .map((source) => source.source));
    const fallbackSources = this.staleSources(cache, input)
      .filter((source) => !completeRefreshOrigins.has(source.originSource));
    const overrides = this.overrideSources(input);
    const sources = [
      ...fallbackSources,
      ...overrides,
      ...freshSources,
    ];
    const catalog = mergeCatalogSources(sources, {
      allowProviderModelsWithoutLive: providerModelsMayBypassLiveCatalog(input),
    });
    catalog.cacheState = successful.length ? 'refreshed' : cache ? 'stale' : 'miss';
    catalog.savedAt = successful.length ? this.now() : cache?.savedAt || null;
    catalog.providerKind = providerKind;
    catalog.allowProviderModelsWithoutLive = providerModelsMayBypassLiveCatalog(input);

    if (successful.length && input.persist !== false) {
      const persistedCatalog = {
        ...catalog,
        sources: [
          ...fallbackSources,
          ...overrides,
          ...successful,
        ],
      };
      await this.persistCatalog(input, persistedCatalog);
    }
    return catalog;
  }

  validateSelection(catalog, selection, options = {}) {
    const providerKind = String(options.providerKind || catalog?.providerKind || '')
      .trim()
      .toLowerCase() || 'unknown';
    return catalog.validate(selection, {
      ...options,
      providerKind,
      allowManualEffortWhenUnknown: providerKind === 'custom',
    });
  }
}

module.exports = {
  ModelCatalogError,
  ModelCatalogService,
  catalogKey,
  mergeCatalogSources,
  normalizeCatalogError,
  normalizeModel,
  normalizeReasoningEffort,
  providerKindForInput,
  providerModelsMayBypassLiveCatalog,
};
