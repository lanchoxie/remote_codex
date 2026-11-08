const assert = require('assert');
const { normalizeProviderModelPage, modelCapabilitiesFromList, validateModelSelection } = require('../apps/host-agent/session-api-runtime');
const { normalizeModel, mergeCatalogSources } = require('../apps/relay/model-catalog-service');
const capabilities = require('../apps/mobile-web/public/provider-capabilities');
const { parseReasoningMetadata } = require('../shared/model-reasoning');

const modelId = 'gpt-6-astra';
const fixtures = [
  { name: 'app-server', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra' },
  { name: 'provider snake case', supported_reasoning_efforts: [{ reasoning_effort: 'low' }, { reasoning_effort: 'ultra' }], default_reasoning_effort: 'ultra' },
  { name: 'value entries', reasoningLevels: [{ value: 'low' }, { value: 'ultra' }], defaultReasoningEffort: 'ultra' },
  { name: 'Codex model metadata', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], default_reasoning_level: 'ultra' },
];

for (const fixture of fixtures) {
  const raw = { id: modelId, ...fixture };
  const page = normalizeProviderModelPage({ data: [raw] });
  const relayModel = normalizeModel(page.models[0]);
  const directRelayModel = normalizeModel(raw);
  const browserModel = capabilities.resolveModelCapability({ providerKind: 'openai', modelId, runtimeCapability: raw });
  const hostModel = modelCapabilitiesFromList([raw]).get(modelId);
  for (const result of [relayModel, directRelayModel, browserModel, hostModel]) {
    assert.deepStrictEqual(result.reasoningLevels, ['low', 'ultra'], fixture.name);
  }
  for (const result of [relayModel, directRelayModel, browserModel]) {
    assert.strictEqual(result.defaultReasoningEffort, 'ultra', fixture.name);
  }
  const catalog = mergeCatalogSources([
    capabilities.createAdvisoryOverrideSource('openai', [modelId]),
    { ...page, source: 'provider' },
  ]);
  assert.strictEqual(catalog.lookup(modelId).capabilitySource, 'provider');
  assert.doesNotThrow(() => catalog.validate({ model: modelId, effort: 'ultra' }));
  assert.throws(() => catalog.validate({ model: modelId, effort: 'high' }), /not supported/i);
  assert.doesNotThrow(() => validateModelSelection(modelCapabilitiesFromList([raw]), modelId, 'ultra'));
}

for (const fields of [
  {},
  { reasoningLevels: [], reasoningDeclared: false },
  { supportedReasoningEfforts: null },
  { supportedReasoningEfforts: 'high' },
  { supportedReasoningEfforts: [{}] },
  { supportedReasoningEfforts: ['bad;value'] },
]) {
  const raw = { id: modelId, ...fields };
  const page = normalizeProviderModelPage({ data: [raw, { id: 'other-model' }] });
  assert.strictEqual(page.models.length, 2, 'malformed optional metadata must not discard the model catalog');
  assert.strictEqual(normalizeModel(page.models[0]).reasoningDeclared, false);
  assert.strictEqual(normalizeModel(raw).reasoningDeclared, false);
  assert.strictEqual(modelCapabilitiesFromList([raw]).get(modelId).capabilityKnown, false);
  const resolved = capabilities.resolveModelCapability({ providerKind: 'openai', modelId, runtimeCapability: raw });
  assert.strictEqual(resolved.source, 'advisory');
  const catalog = mergeCatalogSources([
    capabilities.createAdvisoryOverrideSource('openai', [modelId]),
    { ...page, source: 'provider' },
  ]);
  assert.strictEqual(catalog.lookup(modelId).capabilitySource, 'override');
  assert.doesNotThrow(() => catalog.validate({ model: modelId, effort: 'high' }));
}

for (const field of ['reasoningLevels', 'supportedReasoningEfforts', 'supported_reasoning_efforts', 'supported_reasoning_levels']) {
  const raw = { id: modelId, [field]: [] };
  const page = normalizeProviderModelPage({ data: [raw] });
  const catalog = mergeCatalogSources([
    capabilities.createAdvisoryOverrideSource('openai', [modelId]),
    { ...page, source: 'provider' },
  ]);
  assert.strictEqual(catalog.lookup(modelId).capabilitySource, 'provider');
  assert.deepStrictEqual(catalog.lookup(modelId).reasoningLevels, []);
  assert.throws(() => catalog.validate({ model: modelId, effort: 'high' }), /not supported/i);
  assert.throws(() => validateModelSelection(modelCapabilitiesFromList([raw]), modelId, 'high'), /not supported/i);
  assert.strictEqual(capabilities.resolveModelCapability({ providerKind: 'openai', modelId, runtimeCapability: raw }).source, 'runtime');
}

const unknown = normalizeModel({ id: 'unverified-new-model' });
assert.strictEqual(normalizeModel(unknown).reasoningDeclared, false, 'normalization must preserve unknown capability');
assert.strictEqual(capabilities.resolveModelCapability({ providerKind: 'openai', modelId: unknown.id, runtimeCapability: unknown }).capabilityKnown, false);
assert.deepStrictEqual(parseReasoningMetadata({
  supportedReasoningEfforts: null, supported_reasoning_efforts: ['low', 'high'],
}), { declared: true, levels: ['low', 'high'], defaultDeclared: false, defaultReasoningEffort: null }, 'a malformed alias must not mask a valid effort list');
assert.deepStrictEqual(parseReasoningMetadata({
  reasoningLevels: [], supportedReasoningEfforts: ['high'],
}), { declared: true, levels: [], defaultDeclared: false, defaultReasoningEffort: null }, 'explicit empty arrays retain priority');
assert.deepStrictEqual(parseReasoningMetadata({
  reasoningLevels: [' HIGH ', { value: 'high' }, null, { value: 'ultra' }, 'invalid;value'],
  defaultReasoningEffort: ' HIGH ',
}), { declared: true, levels: ['high', 'ultra'], defaultDeclared: true, defaultReasoningEffort: 'high' });
console.log('Model effort metadata passes through Host, Relay, and UI consistently');
