const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  bindingsEqual,
  makeHostEnvironmentBinding,
  makeProfileBinding,
  publicBinding,
} = require('../../shared/api-binding');

function runtimeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeProviderModelPage(body = {}, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 200) || 200));
  const data = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : [];
  const normalized = data
    .map((item) => ({ id: String(item?.id || item?.model || '').trim() }))
    .filter((item) => item.id);
  const truncated = normalized.length > limit;
  const models = normalized.slice(0, limit);
  const explicitCursor = body?.next || body?.next_cursor || body?.after || null;
  const nextCursor = explicitCursor || (truncated ? models.at(-1)?.id || null : null);
  return {
    authority: 'authoritative',
    complete: !nextCursor && body?.has_more !== true && !truncated,
    models,
    nextCursor,
    truncated,
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
  const configured = options.apiConfig ? makeProfileBinding(options.apiConfig) : null;
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
  classifyNativeThreadError,
  deriveRunBinding,
  readCodexHomeApiIdentity,
  modelCapabilitiesFromList,
  normalizeProviderModelPage,
  normalizeReasoningEffort,
  resumeStrategyForLaunchMode,
  validateModelSelection,
};
