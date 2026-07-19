const crypto = require('crypto');
const { isSecretQueryKey } = require('./secret-redaction');

function normalizedText(value) {
  return String(value || '').trim() || null;
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

function finishBinding(value = {}) {
  const kind = ['profile', 'host_environment', 'unknown'].includes(value.kind)
    ? value.kind
    : 'unknown';
  const binding = {
    kind,
    profileId: kind === 'profile' ? normalizedText(value.profileId) : null,
    label: normalizedText(value.label),
    provider: normalizedText(value.provider),
    normalizedBaseUrl: normalizeBaseUrl(value.normalizedBaseUrl || value.baseUrl),
    modelProviderHint: normalizedText(value.modelProviderHint),
  };
  if (kind === 'unknown') {
    return { ...binding, bindingFingerprint: null };
  }
  const identity = {
    kind,
    profileId: binding.profileId,
    provider: binding.provider ? binding.provider.toLowerCase() : null,
    normalizedBaseUrl: binding.normalizedBaseUrl,
    modelProviderHint: kind === 'host_environment' ? binding.modelProviderHint : null,
  };
  const provable = kind === 'profile'
    ? Boolean(identity.profileId || identity.provider || identity.normalizedBaseUrl)
    : Boolean(identity.provider || identity.normalizedBaseUrl || identity.modelProviderHint);
  return {
    ...binding,
    bindingFingerprint: provable ? bindingDigest(identity) : null,
  };
}

function makeProfileBinding(apiConfig = {}) {
  return finishBinding({
    kind: 'profile',
    profileId: apiConfig.profileId,
    label: apiConfig.label,
    provider: apiConfig.provider,
    normalizedBaseUrl: apiConfig.normalizedBaseUrl || apiConfig.baseUrl,
    modelProviderHint: apiConfig.modelProviderHint,
  });
}

function makeHostEnvironmentBinding(attestation = {}) {
  return finishBinding({
    kind: 'host_environment',
    label: attestation.label,
    provider: attestation.provider,
    normalizedBaseUrl: attestation.normalizedBaseUrl || attestation.baseUrl,
    modelProviderHint: attestation.modelProviderHint,
  });
}

function makeUnknownBinding(modelProviderHint = null) {
  return finishBinding({ kind: 'unknown', modelProviderHint });
}

function publicBinding(binding) {
  if (!binding || typeof binding !== 'object') {
    return null;
  }
  if (binding.kind === 'profile') {
    return makeProfileBinding(binding);
  }
  if (binding.kind === 'host_environment') {
    return makeHostEnvironmentBinding(binding);
  }
  return makeUnknownBinding(binding.modelProviderHint);
}

function bindingFingerprint(binding) {
  return publicBinding(binding)?.bindingFingerprint || null;
}

function bindingsEqual(left, right) {
  const leftFingerprint = bindingFingerprint(left);
  return Boolean(leftFingerprint && leftFingerprint === bindingFingerprint(right));
}

module.exports = {
  bindingFingerprint,
  bindingsEqual,
  makeHostEnvironmentBinding,
  makeProfileBinding,
  makeUnknownBinding,
  normalizeBaseUrl,
  publicBinding,
};
