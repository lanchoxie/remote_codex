class ModelCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelCatalogError';
    this.code = code;
    this.statusCode = Number(details.statusCode || 409);
    Object.assign(this, details);
  }
}

function catalogKey({ hostId, bindingFingerprint, runId, nativeThreadId } = {}) {
  return [
    hostId,
    bindingFingerprint,
    runId || nativeThreadId || '-',
  ].map((value) => encodeURIComponent(String(value || ''))).join('::');
}

function inFlightKey(input = {}) {
  const providerCapability = input.apiConfig ? 'provider' : 'live-only';
  return `${catalogKey(input)}::${providerCapability}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function reasoningMetadata(raw = {}) {
  const hasMetadata = Object.prototype.hasOwnProperty.call(raw, 'reasoningLevels')
    || Object.prototype.hasOwnProperty.call(raw, 'supportedReasoningEfforts')
    || Object.prototype.hasOwnProperty.call(raw, 'supported_reasoning_efforts');
  const values = raw.reasoningLevels
    || raw.supportedReasoningEfforts
    || raw.supported_reasoning_efforts
    || [];
  return {
    declared: hasMetadata,
    levels: uniqueStrings(values.map((value) => value?.reasoningEffort || value?.reasoning_effort || value)),
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
    error: raw.error ? String(raw.error) : null,
    fetchedAt: raw.fetchedAt || raw.fetched_at || null,
    evidenceAuthority: raw.evidenceAuthority || null,
    evidenceComplete: raw.evidenceComplete === true,
    evidenceTruncated: raw.evidenceTruncated === true,
    evidenceNextCursor: raw.evidenceNextCursor || null,
    evidenceFetchedAt: raw.evidenceFetchedAt || null,
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
    capabilityKnown: false,
    capabilitySource: null,
    isDefault: false,
    visible: true,
    selectable: true,
    sources: [],
  };
}

function mergeCatalogSources(rawSources = []) {
  const sources = rawSources.map((source) => normalizeSource(source, source?.source));
  const liveProvesAbsence = sources.some((source) => sourceProvesAbsence(source, 'live'));
  const providerProvesAbsence = sources.some((source) => sourceProvesAbsence(source, 'provider'));
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
      } else if (source.source === 'override') {
        if (model.reasoningDeclared && current.capabilitySource !== 'live') {
          current.reasoningLevels = [...model.reasoningLevels];
          current.capabilityKnown = true;
          current.capabilitySource = 'override';
        }
      } else if (source.source === 'provider') {
        if (!source.error && !source.stale) {
          current.providerAdvertised = true;
          current.availability = 'available';
        }
      } else if (source.source === 'live') {
        if (!source.error && !source.stale) {
          current.cliSupported = true;
          current.visible = model.visible;
          current.isDefault = model.isDefault;
          if (model.reasoningDeclared) {
            current.reasoningLevels = [...model.reasoningLevels];
            current.capabilityKnown = true;
            current.capabilitySource = 'live';
          }
        }
      }
      byId.set(model.id, current);
    }
  }

  for (const model of byId.values()) {
    if (liveProvesAbsence && !model.sources.includes('live')) {
      model.cliSupported = false;
    }
    if (providerProvesAbsence && !model.sources.includes('provider')) {
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
    if (providerProvesAbsence) {
      model.providerAdvertised = false;
      model.availability = 'unavailable';
    }
    model.selectable = model.availability !== 'unavailable' && model.cliSupported !== false;
    return model;
  }

  function validate(selection = {}) {
    const modelId = String(selection.model || '').trim();
    const effort = String(selection.effort || '').trim();
    if (!modelId) {
      return null;
    }
    const model = lookup(modelId);
    if (model.availability === 'unavailable') {
      throw new ModelCatalogError(
        'session_model_unavailable',
        `Model "${modelId}" is not advertised by the current API account.`,
        { model: modelId }
      );
    }
    if (model.cliSupported === false) {
      throw new ModelCatalogError(
        'session_model_unsupported',
        `Model "${modelId}" is not supported by this Session app-server.`,
        { model: modelId }
      );
    }
    if (effort && !model.capabilityKnown) {
      throw new ModelCatalogError(
        'session_effort_unsupported',
        `Reasoning effort for "${modelId}" is unknown; use Auto.`,
        { model: modelId, effort, capabilityUnknown: true }
      );
    }
    if (effort && !model.reasoningLevels.includes(effort)) {
      throw new ModelCatalogError(
        'session_effort_unsupported',
        `Reasoning effort "${effort}" is not supported by "${modelId}".`,
        { model: modelId, effort, reasoningLevels: model.reasoningLevels }
      );
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
    defaultModel: models.find((model) => model.isDefault)?.id || null,
    lookup,
    validate,
    controlsFor(modelId) {
      const model = lookup(modelId);
      return {
        allowAuto: true,
        capabilityKnown: model.capabilityKnown,
        reasoningLevels: model.capabilityKnown ? [...model.reasoningLevels] : [],
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
      const result = Promise.resolve(this.catalogFromCache(cached, 'fresh'));
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
    return record?.catalog?.[key] || null;
  }

  cacheAge(cache) {
    const nowMs = Date.parse(this.now());
    const savedMs = Date.parse(cache.savedAt || '');
    if (!Number.isFinite(nowMs) || !Number.isFinite(savedMs)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, nowMs - savedMs);
  }

  catalogFromCache(cache, cacheState) {
    const catalog = mergeCatalogSources(cache.sources || []);
    catalog.cacheState = cacheState;
    catalog.savedAt = cache.savedAt || null;
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
    const matching = this.overrides.filter((entry) => {
      if (entry.bindingFingerprint && entry.bindingFingerprint !== input.bindingFingerprint) {
        return false;
      }
      if (entry.hostId && entry.hostId !== input.hostId) {
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
      models: matching,
    }, 'override')];
  }

  staleSources(cache) {
    if (!cache) {
      return [];
    }
    const candidatesByOrigin = new Map();
    for (const rawSource of cache.sources || []) {
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

  async load(input, key, cache) {
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
        return normalizeSource({ ...result, source: sourceName }, sourceName);
      } catch (error) {
        return normalizeSource({
          source: sourceName,
          authority: 'advisory',
          complete: false,
          error: error.message || String(error),
          fetchedAt: this.now(),
          models: [],
        }, sourceName);
      }
    }));
    const freshSources = fetched.filter(Boolean);
    const successful = freshSources.filter((source) => !source.error);
    const completeRefreshOrigins = new Set(successful
      .filter((source) => sourceProvesAbsence(source, source.source))
      .map((source) => source.source));
    const fallbackSources = this.staleSources(cache)
      .filter((source) => !completeRefreshOrigins.has(source.originSource));
    const overrides = this.overrideSources(input);
    const sources = [
      ...fallbackSources,
      ...overrides,
      ...freshSources,
    ];
    const catalog = mergeCatalogSources(sources);
    catalog.cacheState = successful.length ? 'refreshed' : cache ? 'stale' : 'miss';
    catalog.savedAt = successful.length ? this.now() : cache?.savedAt || null;

    if (successful.length) {
      const persistedSources = [
        ...fallbackSources,
        ...overrides,
        ...successful,
      ].map((source) => structuredClone(source));
      await this.store.transact('session.model_catalog.saved', (tx) => {
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
          savedAt: catalog.savedAt,
          sources: persistedSources,
        };
        record.updatedAt = this.now();
        tx.markDirty(canonicalKey);
      });
    }
    return catalog;
  }

  validateSelection(catalog, selection) {
    return catalog.validate(selection);
  }
}

module.exports = {
  ModelCatalogError,
  ModelCatalogService,
  catalogKey,
  mergeCatalogSources,
  normalizeModel,
};
