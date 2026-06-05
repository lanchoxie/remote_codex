function normalizeApiConfig(input = {}) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const provider = String(input.provider || '').trim().slice(0, 80);
  const baseUrl = normalizeApiBaseUrl(input.baseUrl).slice(0, 500);
  const apiKey = String(input.apiKey || '').trim();
  const profileId = String(input.profileId || '').trim().slice(0, 120);
  const label = String(input.label || '').trim().slice(0, 120);

  if (!baseUrl && !apiKey) {
    return null;
  }

  return {
    provider: provider || 'OpenAI',
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

function normalizeApiBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.replace(/\/+$/, '');
  }

  parsed.hash = '';
  parsed.search = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (/\/responses$/i.test(pathname)) {
    pathname = pathname.replace(/\/responses$/i, '');
  }
  if (!pathname) {
    pathname = '/v1';
  } else {
    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    if (!/^v\d+(?:\.\d+)?$/i.test(lastSegment)) {
      pathname = `${pathname}/v1`;
    }
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/+$/, '');
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
  const baseUrl = normalizeApiBaseUrl(config.baseUrl) || 'default OpenAI base URL';
  return `${label} (${baseUrl})`;
}

module.exports = {
  apiConfigsRuntimeEqual,
  buildApiEnvironment,
  describeApiConfig,
  normalizeApiBaseUrl,
  normalizeApiConfig,
};
