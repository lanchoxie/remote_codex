const crypto = require('crypto');
const { isSecretQueryKey } = require('./secret-redaction');

const OFFICIAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function normalizedText(value) {
  return String(value || '').trim() || null;
}

function normalizedCompatibilityKey(value) {
  const text = normalizedText(value);
  return text ? text.slice(0, 160).toLowerCase() : null;
}

function normalizedProviderKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return ['openai', 'anthropic', 'gemini', 'custom'].includes(kind) ? kind : null;
}

function normalizeBaseUrl(value) {
  const raw = normalizedText(value);
  if (!raw) {
    return null;
  }
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError(`Unsupported API Base URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new TypeError('API Base URL must not contain credentials');
  }
  for (const key of url.searchParams.keys()) {
    if (isSecretQueryKey(key)) {
      throw new TypeError('API Base URL must not contain credentials');
    }
  }
  url.hash = '';
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function bindingDigest(identity) {
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function persistedDigest(value) {
  const digest = normalizedText(value);
  return digest && /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

function profileBaseUrl(value = {}) {
  const configured = normalizedText(value.normalizedBaseUrl || value.baseUrl);
  if (configured) {
    return configured;
  }
  const rawProviderKind = normalizedText(value.providerKind);
  const officialByKind = normalizedProviderKind(rawProviderKind) === 'openai';
  const officialLegacyLabel = !rawProviderKind
    && String(normalizedText(value.provider) || '').toLowerCase() === 'openai';
  return officialByKind || officialLegacyLabel ? OFFICIAL_OPENAI_BASE_URL : null;
}

function finishBinding(value = {}) {
  const kind = ['profile', 'host_environment', 'unknown'].includes(value.kind)
    ? value.kind
    : 'unknown';
  const rawProvider = normalizedText(value.provider);
  const rawProviderKind = normalizedProviderKind(value.providerKind);
  const rawBaseUrl = normalizedText(value.normalizedBaseUrl || value.baseUrl);
  const canonicalBaseUrl = kind === 'profile'
    ? profileBaseUrl(value)
    : rawBaseUrl || (
      (rawProviderKind === 'openai'
        || (!rawProviderKind && String(rawProvider || '').toLowerCase() === 'openai'))
        ? OFFICIAL_OPENAI_BASE_URL
        : null
    );
  const binding = {
    kind,
    profileId: kind === 'profile' ? normalizedText(value.profileId) : null,
    label: normalizedText(value.label),
    provider: rawProvider,
    providerKind: rawProviderKind,
    normalizedBaseUrl: normalizeBaseUrl(canonicalBaseUrl),
    modelProviderHint: normalizedText(value.modelProviderHint),
    nativeResumeCompatibilityKey: normalizedCompatibilityKey(value.nativeResumeCompatibilityKey),
  };
  if (kind === 'unknown') {
    return {
      ...binding,
      bindingFingerprint: null,
      nativeResumeCompatibilityFingerprint: null,
    };
  }
  // Older Session records may contain only the already-attested digest. Keep
  // that evidence as a fallback when the newer identity fields are absent,
  // while always preferring a digest recomputed from complete identity data.
  const persistedBinding = persistedDigest(value.bindingFingerprint);
  const persistedCompatibility = persistedDigest(value.nativeResumeCompatibilityFingerprint);
  const identity = {
    kind,
    profileId: binding.profileId,
    provider: binding.provider ? binding.provider.toLowerCase() : null,
    normalizedBaseUrl: binding.normalizedBaseUrl,
    modelProviderHint: kind === 'host_environment' ? binding.modelProviderHint : null,
  };
  const compatibilityIdentity = binding.nativeResumeCompatibilityKey
    ? { explicit: binding.nativeResumeCompatibilityKey }
    : {
      kind,
      provider: binding.provider ? binding.provider.toLowerCase() : null,
      normalizedBaseUrl: binding.normalizedBaseUrl,
    };
  // A strict binding may be attested from a profile id or host hint, but
  // native Responses history compatibility cannot be inferred from either
  // field alone. Without a provider/endpoint (or an explicit operator key),
  // two unrelated legacy bindings would collapse into the same compatibility
  // group and could be resumed against the wrong API.
  const legacyDigestOnly = !binding.profileId
    && !binding.provider
    && !binding.normalizedBaseUrl
    && !binding.modelProviderHint
    && !binding.nativeResumeCompatibilityKey;
  const bindingProvable = kind === 'profile'
    ? Boolean(identity.profileId || identity.provider || identity.normalizedBaseUrl)
    : Boolean(
      identity.normalizedBaseUrl
        || binding.nativeResumeCompatibilityKey
    );
  const compatibilityProvable = Boolean(
    binding.nativeResumeCompatibilityKey
      || (compatibilityIdentity.provider && compatibilityIdentity.normalizedBaseUrl)
  );
  return {
    ...binding,
    bindingFingerprint: bindingProvable
      ? bindingDigest(identity)
      : legacyDigestOnly ? persistedBinding : null,
    nativeResumeCompatibilityFingerprint: bindingProvable && compatibilityProvable
      ? bindingDigest(compatibilityIdentity)
      : (legacyDigestOnly
        ? persistedCompatibility
        : null),
  };
}

function makeProfileBinding(apiConfig = {}) {
  return finishBinding({
    kind: 'profile',
    profileId: apiConfig.profileId,
    label: apiConfig.label,
    provider: apiConfig.provider,
    providerKind: apiConfig.providerKind,
    normalizedBaseUrl: apiConfig.normalizedBaseUrl || apiConfig.baseUrl,
    modelProviderHint: apiConfig.modelProviderHint,
    nativeResumeCompatibilityKey: apiConfig.nativeResumeCompatibilityKey,
    bindingFingerprint: apiConfig.bindingFingerprint,
    nativeResumeCompatibilityFingerprint: apiConfig.nativeResumeCompatibilityFingerprint,
  });
}

function makeHostEnvironmentBinding(attestation = {}) {
  return finishBinding({
    kind: 'host_environment',
    label: attestation.label,
    provider: attestation.provider,
    providerKind: attestation.providerKind,
    normalizedBaseUrl: attestation.normalizedBaseUrl || attestation.baseUrl,
    modelProviderHint: attestation.modelProviderHint,
    nativeResumeCompatibilityKey: attestation.nativeResumeCompatibilityKey,
    bindingFingerprint: attestation.bindingFingerprint,
    nativeResumeCompatibilityFingerprint: attestation.nativeResumeCompatibilityFingerprint,
  });
}

function makeUnknownBinding(modelProviderHint = null) {
  return finishBinding({ kind: 'unknown', modelProviderHint });
}

function publicBinding(binding) {
  if (!binding || typeof binding !== 'object') {
    return null;
  }
  try {
    if (binding.kind === 'profile') {
      return makeProfileBinding(binding);
    }
    if (binding.kind === 'host_environment') {
      return makeHostEnvironmentBinding(binding);
    }
  } catch {
    // Persisted bindings are untrusted input after a crash or manual repair.
    // Treat malformed URLs as unverifiable rather than turning a detail or
    // Rebind request into an unrelated 500 response.
    return makeUnknownBinding(binding.modelProviderHint);
  }
  return makeUnknownBinding(binding.modelProviderHint);
}

function bindingFingerprint(binding) {
  return publicBinding(binding)?.bindingFingerprint || null;
}

function nativeResumeCompatibilityFingerprint(binding) {
  return publicBinding(binding)?.nativeResumeCompatibilityFingerprint || null;
}

function resumeBindingsCompatible(left, right) {
  const leftFingerprint = nativeResumeCompatibilityFingerprint(left);
  return Boolean(
    leftFingerprint
    && leftFingerprint === nativeResumeCompatibilityFingerprint(right)
  );
}

/**
 * Decide whether an explicit Rebind may reuse the native Responses rollout.
 * A strict binding fingerprint proves the configured identity; the separate
 * compatibility fingerprint is required before handing old native history to
 * another API profile.
 */
function assessNativeResumeCompatibility(sourceBinding, submittedBinding, sourceRun = null) {
  const sourceCompatibility = nativeResumeCompatibilityFingerprint(sourceBinding);
  const submittedCompatibility = nativeResumeCompatibilityFingerprint(submittedBinding);
  const hasSourceRun = Boolean(sourceRun && typeof sourceRun === 'object');
  const nativeResumeReady = hasSourceRun && sourceRun.nativeResumeReady !== false;
  const nativeResumeReadyKnown = hasSourceRun
    && typeof sourceRun.nativeResumeReady === 'boolean';
  if (!hasSourceRun) {
    return {
      canNativeResume: false,
      nativeResumeReady: false,
      nativeResumeReadyKnown: false,
      reason: 'source_run_unknown',
      incompatible: false,
    };
  }
  if (!nativeResumeReady) {
    return {
      canNativeResume: false,
      nativeResumeReady,
      nativeResumeReadyKnown,
      reason: 'native_resume_not_ready',
      incompatible: false,
    };
  }
  if (!sourceCompatibility) {
    return {
      canNativeResume: false,
      nativeResumeReady,
      nativeResumeReadyKnown,
      reason: 'source_compatibility_unknown',
      incompatible: false,
    };
  }
  if (!submittedCompatibility) {
    return {
      canNativeResume: false,
      nativeResumeReady,
      nativeResumeReadyKnown,
      reason: 'submitted_compatibility_unknown',
      incompatible: true,
    };
  }
  if (sourceCompatibility !== submittedCompatibility) {
    return {
      canNativeResume: false,
      nativeResumeReady,
      nativeResumeReadyKnown,
      reason: 'compatibility_mismatch',
      incompatible: true,
    };
  }
  return {
    canNativeResume: true,
    nativeResumeReady,
    nativeResumeReadyKnown,
    reason: 'compatible',
    incompatible: false,
  };
}

function bindingsEqual(left, right) {
  const leftFingerprint = bindingFingerprint(left);
  return Boolean(leftFingerprint && leftFingerprint === bindingFingerprint(right));
}

module.exports = {
  OFFICIAL_OPENAI_BASE_URL,
  bindingFingerprint,
  bindingsEqual,
  nativeResumeCompatibilityFingerprint,
  assessNativeResumeCompatibility,
  makeHostEnvironmentBinding,
  makeProfileBinding,
  makeUnknownBinding,
  normalizeBaseUrl,
  publicBinding,
  resumeBindingsCompatible,
};
