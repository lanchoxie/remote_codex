const providerCapabilities = require('../mobile-web/public/provider-capabilities');
const {
  OFFICIAL_OPENAI_BASE_URL,
  normalizeBaseUrl,
} = require('../../shared/api-binding');

function apiConfigError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 422;
  return error;
}

function apiConfigWasSubmitted(input) {
  if (!input || typeof input !== 'object') {
    return false;
  }
  return [
    input.provider,
    input.providerKind,
    input.baseUrl,
    input.apiKey,
    input.profileId,
    input.label,
  ].some((value) => String(value || '').trim());
}

function resolveApiBaseUrl(input = {}) {
  const config = input && typeof input === 'object' ? input : { baseUrl: input };
  const explicit = normalizeApiBaseUrl(config.baseUrl).slice(0, 500);
  if (explicit) {
    return explicit;
  }
  return providerCapabilities.inferProviderKind(config) === 'openai'
    ? OFFICIAL_OPENAI_BASE_URL
    : '';
}

function normalizeApiConfig(input = {}) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  if (!apiConfigWasSubmitted(input)) {
    return null;
  }

  const provider = String(input.provider || '').trim().slice(0, 80);
  const providerKind = providerCapabilities.inferProviderKind(input);
  const explicitBaseUrl = normalizeApiBaseUrl(input.baseUrl).slice(0, 500);
  if (!explicitBaseUrl && providerKind !== 'openai') {
    throw apiConfigError(
      'api_base_url_required',
      `${providerCapabilities.getProviderPolicy(providerKind).label} API profiles require an explicit Base URL.`
    );
  }
  const baseUrl = explicitBaseUrl || OFFICIAL_OPENAI_BASE_URL;
  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey) {
    throw apiConfigError(
      'api_key_required',
      `${providerCapabilities.getProviderPolicy(providerKind).label} API profiles require an explicit API key.`
    );
  }
  const profileId = String(input.profileId || '').trim().slice(0, 120);
  const label = String(input.label || '').trim().slice(0, 120);
  const providerPolicy = providerCapabilities.getProviderPolicy(providerKind);

  return {
    provider: provider || providerPolicy.canonicalProvider,
    providerKind,
    baseUrl,
    apiKey,
    profileId,
    label,
  };
}

function buildApiEnvironment(apiConfig) {
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return {};
  }

  const env = {};
  if (config.apiKey) {
    env.OPENAI_API_KEY = config.apiKey;
  }
  if (config.baseUrl) {
    env.OPENAI_BASE_URL = config.baseUrl;
    env.OPENAI_API_BASE = config.baseUrl;
  }
  return env;
}

function buildApiProcessEnvironment(inheritedEnvironment, apiConfig) {
  const inherited = inheritedEnvironment && typeof inheritedEnvironment === 'object'
    ? inheritedEnvironment
    : {};
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return { ...inherited };
  }

  const env = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (!/^OPENAI_/i.test(name)) {
      env[name] = value;
    }
  }
  return {
    ...env,
    ...buildApiEnvironment(config),
  };
}

function normalizeApiBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    return normalizeBaseUrl(raw.slice(0, 500)) || '';
  } catch (cause) {
    const error = apiConfigError(
      'api_base_url_invalid',
      `Invalid API Base URL: ${cause.message || cause}`
    );
    error.cause = cause;
    throw error;
  }
}

function apiConfigRuntimeKey(apiConfig) {
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return null;
  }
  return [
    normalizeApiBaseUrl(config.baseUrl),
    config.apiKey || '',
  ].join('\n');
}

function apiConfigsRuntimeEqual(left, right) {
  const leftKey = apiConfigRuntimeKey(left);
  const rightKey = apiConfigRuntimeKey(right);
  if (!leftKey && !rightKey) {
    return true;
  }
  return leftKey === rightKey;
}

function describeApiConfig(apiConfig) {
  const config = normalizeApiConfig(apiConfig);
  if (!config) {
    return 'host environment';
  }
  const label = config.label || config.profileId || config.provider || 'API profile';
  const baseUrl = resolveApiBaseUrl(config);
  return `${label} (${baseUrl})`;
}

module.exports = {
  OFFICIAL_OPENAI_BASE_URL,
  apiConfigsRuntimeEqual,
  buildApiEnvironment,
  buildApiProcessEnvironment,
  describeApiConfig,
  normalizeApiBaseUrl,
  normalizeApiConfig,
  resolveApiBaseUrl,
};
