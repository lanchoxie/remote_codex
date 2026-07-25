const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const {
  bindingsEqual,
  makeHostEnvironmentBinding,
  makeProfileBinding,
  publicBinding,
} = require('../../shared/api-binding');
const {
  normalizeApiBaseUrl,
  normalizeApiConfig,
  resolveApiBaseUrl,
} = require('./runtime-utils');

function runtimeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeProviderModelPage(body = {}, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 200) || 200));
  const hasData = Array.isArray(body?.data);
  const hasModels = Array.isArray(body?.models);
  if (!hasData && !hasModels) {
    throw runtimeError(
      'provider_model_catalog_invalid',
      'The API response is not a recognizable model catalog. Check whether the Base URL needs /v1.'
    );
  }
  const data = hasData ? body.data : body.models;
  const normalized = data
    .map((item) => {
      const id = String(typeof item === 'string' ? item : item?.id || item?.model || '').trim();
      if (!id) {
        return null;
      }
      const capability = reasoningLevels(item);
      const defaultDeclared = Object.prototype.hasOwnProperty.call(item || {}, 'defaultReasoningEffort')
        || Object.prototype.hasOwnProperty.call(item || {}, 'default_reasoning_effort');
      return {
        id,
        ...(capability.capabilityKnown ? { reasoningLevels: capability.reasoningLevels } : {}),
        ...(defaultDeclared ? {
          defaultReasoningEffort: normalizeReasoningEffort(
            item.defaultReasoningEffort ?? item.default_reasoning_effort
          ),
        } : {}),
      };
    })
    .filter(Boolean);
  if (data.length > 0 && normalized.length === 0) {
    throw runtimeError(
      'provider_model_catalog_invalid',
      'The API model catalog contains no recognizable model IDs.'
    );
  }
  const truncated = normalized.length > limit;
  const models = normalized.slice(0, limit);
  const explicitCursor = body?.next
    || body?.next_cursor
    || (body?.has_more === true ? body?.last_id || body?.lastId : null)
    || body?.after
    || null;
  const nextCursor = explicitCursor || (truncated ? models.at(-1)?.id || null : null);
  return {
    authority: 'authoritative',
    complete: !nextCursor && body?.has_more !== true && !truncated,
    models,
    nextCursor,
    truncated,
  };
}

function classifyProviderModelResponse(statusCode, rawBody, options = {}) {
  const status = Number(statusCode || 0);
  const reachable = status >= 200 && status < 300;
  if (!reachable) {
    return {
      ok: false,
      reachable: false,
      catalogValid: false,
      modelPage: null,
      error: null,
    };
  }

  try {
    const parsed = JSON.parse(String(rawBody || ''));
    const modelPage = normalizeProviderModelPage(parsed, options);
    return {
      ok: true,
      reachable: true,
      catalogValid: true,
      modelPage,
      error: null,
    };
  } catch (_) {
    return {
      ok: false,
      reachable: true,
      catalogValid: false,
      modelPage: null,
      error: 'The API returned HTTP success but not a recognizable model catalog. Check whether the Base URL needs /v1.',
    };
  }
}

function buildProviderModelsUrl(baseUrl, options = {}) {
  const raw = resolveApiBaseUrl({
    baseUrl,
    providerKind: options.providerKind || (String(baseUrl || '').trim() ? 'custom' : 'openai'),
  });
  if (!raw) {
    throw runtimeError('api_base_url_required', 'This API provider requires an explicit Base URL.');
  }
  const url = new URL(raw);
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  const cursor = String(options.cursor || '').trim();
  const limit = Math.max(1, Math.min(500, Number(options.limit || 200) || 200));
  if (cursor) {
    url.searchParams.set('after', cursor);
  }
  if (options.includeLimit === true) {
    url.searchParams.set('limit', String(limit));
  }
  return url.toString();
}

function suggestedProviderV1BaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) {
    return null;
  }
  const url = new URL(raw);
  const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, '');
  if (pathWithoutTrailingSlash) {
    return null;
  }
  url.hash = '';
  url.pathname = '/v1';
  return normalizeApiBaseUrl(url.toString()) || null;
}

function shouldDiagnoseProviderV1(baseUrl, statusCode, classified) {
  if (!suggestedProviderV1BaseUrl(baseUrl)) {
    return false;
  }
  const status = Number(statusCode || 0);
  if (status === 404 || status === 405) {
    return true;
  }
  return status >= 200 && status < 300 && classified?.catalogValid !== true;
}

function summarizeApiTestBody(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.message) {
      return String(parsed.error.message).slice(0, 500);
    }
    if (parsed?.message) {
      return String(parsed.message).slice(0, 500);
    }
    if (Array.isArray(parsed?.data)) {
      return `${parsed.data.length} model${parsed.data.length === 1 ? '' : 's'} returned`;
    }
    return JSON.stringify(parsed).slice(0, 500);
  } catch (_) {
    return text.slice(0, 500);
  }
}

function requestProviderModels(targetUrl, config, options = {}) {
  const parsed = new URL(targetUrl);
  const client = parsed.protocol === 'https:' ? https : http;
  const timeoutMs = Number(options.timeoutMs || 15000) || 15000;
  const maxResponseBytes = Math.max(
    1024,
    Number(options.maxResponseBytes || 5 * 1024 * 1024) || 5 * 1024 * 1024
  );

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const req = client.request(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          Accept: 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let responseBytes = 0;
        res.on('data', (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > maxResponseBytes) {
            finish({
              statusCode: res.statusCode || 0,
              statusMessage: res.statusMessage || '',
              error: `API response exceeded ${maxResponseBytes} bytes`,
            });
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          const raw = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode || 0;
          finish({
            statusCode,
            statusMessage: res.statusMessage || '',
            raw,
            summary: summarizeApiTestBody(raw),
            classified: classifyProviderModelResponse(statusCode, raw, {
              limit: options.limit,
            }),
          });
        });
        res.on('error', (error) => finish({ error: error.message }));
        res.on('aborted', () => finish({ error: 'response aborted' }));
      }
    );
    req.on('error', (error) => finish({ error: error.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`API test timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

function apiTestPayload(config, targetUrl, response, startedAt) {
  const classified = response.classified || {};
  const statusCode = Number(response.statusCode || 0);
  const summary = response.summary || '';
  const statusText = `${statusCode || ''} ${response.statusMessage || ''}`.trim();
  return {
    ok: Boolean(classified.ok),
    reachable: Boolean(classified.reachable),
    catalogValid: Boolean(classified.catalogValid),
    statusCode,
    latencyMs: Date.now() - startedAt,
    url: targetUrl,
    provider: config.provider || null,
    providerKind: config.providerKind || null,
    profileId: config.profileId || null,
    label: config.label || null,
    message: classified.error || summary || statusText,
    error: response.error
      || classified.error
      || (statusCode >= 400 ? (summary || statusText || 'HTTP error') : null),
    modelPage: classified.modelPage || null,
    testedAt: new Date().toISOString(),
  };
}

async function testApiProfile(apiConfig, options = {}) {
  const startedAt = Date.now();
  let config;
  let targetUrl = null;
  try {
    config = normalizeApiConfig(apiConfig);
    if (!config) {
      throw runtimeError('api_config_required', 'An API profile is required before testing.');
    }
    targetUrl = buildProviderModelsUrl(config.baseUrl, {
      ...options,
      providerKind: config.providerKind,
    });
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      catalogValid: false,
      statusCode: 0,
      latencyMs: Date.now() - startedAt,
      url: targetUrl,
      provider: config?.provider || null,
      providerKind: config?.providerKind || null,
      profileId: config?.profileId || null,
      label: config?.label || null,
      message: error.message,
      error: error.message,
      code: error.code || 'api_config_invalid',
      modelPage: null,
      testedAt: new Date().toISOString(),
    };
  }

  const primaryResponse = await requestProviderModels(targetUrl, config, options);
  const result = apiTestPayload(config, targetUrl, primaryResponse, startedAt);
  if (
    result.ok
    || primaryResponse.error
    || !shouldDiagnoseProviderV1(config.baseUrl, primaryResponse.statusCode, primaryResponse.classified)
  ) {
    return result;
  }

  const suggestedBaseUrl = suggestedProviderV1BaseUrl(config.baseUrl);
  const diagnosticUrl = buildProviderModelsUrl(suggestedBaseUrl, {
    ...options,
    providerKind: config.providerKind,
  });
  const diagnosticResponse = await requestProviderModels(diagnosticUrl, config, options);
  if (diagnosticResponse.classified?.ok !== true) {
    result.latencyMs = Date.now() - startedAt;
    result.testedAt = new Date().toISOString();
    return result;
  }

  const recommendation = `A valid model catalog was detected at ${suggestedBaseUrl}. Apply the suggested Base URL and test again.`;
  return {
    ...result,
    ok: false,
    catalogValid: false,
    latencyMs: Date.now() - startedAt,
    message: recommendation,
    error: [result.error, recommendation].filter(Boolean).join(' '),
    modelPage: null,
    suggestedBaseUrl,
    suggestionReason: 'validated_v1_models',
    testedAt: new Date().toISOString(),
  };
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlIdentityString(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return null;
}

function parseTomlProviderKey(value) {
  const raw = String(value || '').trim();
  return parseTomlIdentityString(raw) || (/^[A-Za-z0-9_-]+$/.test(raw) ? raw : null);
}

function readCodexHomeApiIdentity(codexHome) {
  const home = String(codexHome || '').trim();
  if (!home) {
    return null;
  }
  const authPath = path.join(home, 'auth.json');
  const configPath = path.join(home, 'config.toml');
  const hasAuth = fs.existsSync(authPath);
  const hasConfig = fs.existsSync(configPath);
  if (!hasAuth && !hasConfig) {
    return null;
  }

  let configText = '';
  if (hasConfig) {
    try {
      configText = fs.readFileSync(configPath, 'utf8');
    } catch {
      configText = '';
    }
  }
  let selectedProvider = null;
  let currentProvider = null;
  const providers = new Map();
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const section = /^\[\s*model_providers\.([^\]]+)\s*\]$/.exec(line);
    if (section) {
      currentProvider = parseTomlProviderKey(section[1]);
      if (currentProvider && !providers.has(currentProvider)) providers.set(currentProvider, {});
      continue;
    }
    if (/^\[/.test(line)) {
      currentProvider = null;
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1];
    const value = parseTomlIdentityString(assignment[2]);
    if (value === null) continue;
    if (!currentProvider && key === 'model_provider') {
      selectedProvider = value;
    } else if (currentProvider && (key === 'name' || key === 'base_url')) {
      providers.get(currentProvider)[key] = value;
    }
  }

  const providerConfig = selectedProvider ? providers.get(selectedProvider) || {} : {};
  const defaultOpenAi = !selectedProvider && (hasAuth || hasConfig);
  return {
    provider: providerConfig.name || (selectedProvider === 'openai' || defaultOpenAi ? 'OpenAI' : selectedProvider),
    baseUrl: providerConfig.base_url || null,
    modelProviderHint: selectedProvider || (defaultOpenAi ? 'openai' : null),
  };
}

function assertBindingMatch(expectedValue, effectiveValue, message) {
  const expected = publicBinding(expectedValue);
  const effective = publicBinding(effectiveValue);
  if (expected && !bindingsEqual(expected, effective)) {
    throw runtimeError(
      'session_api_binding_mismatch',
      message,
      { expectedBinding: expected, effectiveBinding: effective, canRebind: true }
    );
  }
  return effective;
}

function attestHostEnvironmentBinding(options = {}) {
  const env = options.env || process.env;
  const defaultCodexHome = Object.prototype.hasOwnProperty.call(options, 'env')
    ? null
    : path.join(os.homedir(), '.codex');
  const codexHome = options.codexHome || env.CODEX_HOME || defaultCodexHome;
  const fileIdentity = readCodexHomeApiIdentity(codexHome) || {};
  const baseUrl = env.OPENAI_BASE_URL || env.OPENAI_API_BASE || fileIdentity.baseUrl || null;
  const modelProviderHint = env.CODEX_MODEL_PROVIDER
    || env.REMOTE_CODEX_MODEL_PROVIDER
    || fileIdentity.modelProviderHint
    || null;
  const provider = env.REMOTE_CODEX_API_PROVIDER
    || env.OPENAI_API_PROVIDER
    || fileIdentity.provider
    || (env.OPENAI_API_KEY || baseUrl ? 'OpenAI' : null);
  const binding = makeHostEnvironmentBinding({ provider, baseUrl, modelProviderHint });
  if (!binding.bindingFingerprint) {
    throw runtimeError(
      'session_api_binding_unavailable',
      'The Host environment API identity cannot be safely attested.',
      { canRebind: true }
    );
  }
  const expected = publicBinding(options.expectedBinding);
  if (expected && !bindingsEqual(binding, expected)) {
    throw runtimeError(
      'session_api_binding_mismatch',
      'The current Host environment does not match the Session run binding.',
      { expectedBinding: expected, effectiveBinding: binding, canRebind: true }
    );
  }
  return { ok: true, binding };
}

function deriveRunBinding(options = {}) {
  const explicit = publicBinding(options.apiBinding);
  const normalizedConfig = options.apiConfig ? normalizeApiConfig(options.apiConfig) : null;
  const configured = normalizedConfig ? makeProfileBinding(normalizedConfig) : null;
  if (explicit && configured) {
    assertBindingMatch(explicit, configured, 'Submitted API binding does not match the supplied API configuration.');
  }
  const submitted = explicit || configured;
  if (submitted) {
    if (!submitted.bindingFingerprint) {
      if (options.allowUnavailable) return null;
      throw runtimeError(
        'session_api_binding_unavailable',
        'The submitted API identity cannot be safely attested.',
        { canRebind: true }
      );
    }
    assertBindingMatch(
      options.expectedBinding,
      submitted,
      'Submitted API identity does not match the expected Session run binding.'
    );
    return submitted;
  }
  try {
    return attestHostEnvironmentBinding({
      env: options.env,
      codexHome: options.codexHome,
      expectedBinding: options.expectedBinding,
    }).binding;
  } catch (error) {
    if (options.allowUnavailable && error?.code === 'session_api_binding_unavailable') {
      return null;
    }
    throw error;
  }
}

function assertRunBinding(runBinding, explicitBinding) {
  const expected = publicBinding(runBinding);
  if (!expected || !expected.bindingFingerprint) {
    throw runtimeError(
      'session_api_binding_unavailable',
      'The live run has no verifiable API binding.',
      { canRebind: true }
    );
  }
  if (!explicitBinding) {
    return expected;
  }
  const submitted = publicBinding(explicitBinding);
  if (!bindingsEqual(expected, submitted)) {
    throw runtimeError(
      'session_api_binding_mismatch',
      'Command API identity conflicts with the live run binding.',
      { expectedBinding: expected, submittedBinding: submitted, canRebind: true }
    );
  }
  return expected;
}

function normalizeReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) {
    return null;
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) {
    throw runtimeError('session_effort_invalid', `Invalid reasoning effort "${effort}".`);
  }
  return effort;
}

function reasoningLevels(raw = {}) {
  const hasMetadata = Object.prototype.hasOwnProperty.call(raw, 'reasoningLevels')
    || Object.prototype.hasOwnProperty.call(raw, 'supportedReasoningEfforts')
    || Object.prototype.hasOwnProperty.call(raw, 'supported_reasoning_efforts');
  const entries = raw.reasoningLevels
    || raw.supportedReasoningEfforts
    || raw.supported_reasoning_efforts
    || [];
  return {
    capabilityKnown: hasMetadata,
    reasoningLevels: [...new Set(entries
      .map((entry) => entry?.reasoningEffort || entry?.reasoning_effort || entry)
      .map(normalizeReasoningEffort)
      .filter(Boolean))],
  };
}

function modelCapabilitiesFromList(models = []) {
  const capabilities = new Map();
  for (const raw of Array.isArray(models) ? models : []) {
    const model = String(raw?.id || raw?.model || '').trim();
    if (model) {
      capabilities.set(model, { model, ...reasoningLevels(raw) });
    }
  }
  return capabilities;
}

function validateModelSelection(capabilities, modelValue, effortValue) {
  const model = String(modelValue || '').trim();
  const effort = normalizeReasoningEffort(effortValue);
  if (!effort) {
    return { model: model || null, effort: null };
  }
  const metadata = model && capabilities instanceof Map ? capabilities.get(model) : null;
  if (
    metadata?.capabilityKnown
    && !metadata.reasoningLevels.includes(effort)
  ) {
    throw runtimeError(
      'session_effort_unsupported',
      `Reasoning effort "${effort}" is not supported by "${model}".`,
      { model, effort, reasoningLevels: metadata.reasoningLevels }
    );
  }
  return { model: model || null, effort };
}

function classifyNativeThreadError(launchMode, cause) {
  const mode = String(launchMode || '').trim();
  const code = mode === 'fork'
    ? 'session_native_fork_failed'
    : 'session_native_resume_failed';
  return runtimeError(
    code,
    `${mode === 'fork' ? 'Native fork' : 'Native resume'} failed: ${cause?.message || cause || 'unknown error'}`,
    { cause }
  );
}

function resumeStrategyForLaunchMode(launchMode) {
  return String(launchMode || '').trim() === 'transcript_fallback'
    ? 'transcript_fallback'
    : 'fresh';
}

module.exports = {
  assertRunBinding,
  attestHostEnvironmentBinding,
  buildProviderModelsUrl,
  classifyProviderModelResponse,
  classifyNativeThreadError,
  deriveRunBinding,
  readCodexHomeApiIdentity,
  modelCapabilitiesFromList,
  normalizeProviderModelPage,
  normalizeReasoningEffort,
  resumeStrategyForLaunchMode,
  shouldDiagnoseProviderV1,
  suggestedProviderV1BaseUrl,
  testApiProfile,
  validateModelSelection,
};
