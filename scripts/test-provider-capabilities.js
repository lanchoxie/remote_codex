const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'apps/mobile-web/public/provider-capabilities.js');
const source = fs.readFileSync(modulePath, 'utf8');
const capabilities = require(modulePath);

assert.match(capabilities.REGISTRY_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
assert.deepStrictEqual([...capabilities.PROVIDER_KINDS], ['openai', 'anthropic', 'gemini', 'custom']);
assert.deepStrictEqual(
  capabilities.listProviderOptions().map((option) => option.value),
  ['openai', 'anthropic', 'gemini', 'custom']
);

assert.strictEqual(capabilities.inferProviderKind('OpenAI'), 'openai');
assert.strictEqual(capabilities.inferProviderKind({ providerKind: 'anthropic', provider: 'ignored' }), 'anthropic');
assert.strictEqual(capabilities.inferProviderKind({ provider: 'Google Gemini' }), 'gemini');
assert.strictEqual(capabilities.inferProviderKind('Anthropic/Claude'), 'anthropic');
assert.strictEqual(capabilities.inferProviderKind('Google/Gemini'), 'gemini');
assert.strictEqual(capabilities.inferProviderKind('openai-compatible'), 'custom');
assert.strictEqual(capabilities.inferProviderKind('Azure OpenAI'), 'custom');
assert.strictEqual(capabilities.inferProviderKind('private-lab-proxy'), 'custom');

const customPolicy = capabilities.getProviderPolicy('custom');
assert.strictEqual(customPolicy.capabilityMode, 'manual');
assert.strictEqual(customPolicy.allowManualEffortWhenUnknown, true);
for (const kind of ['anthropic', 'gemini']) {
  const policy = capabilities.getProviderPolicy(kind);
  assert.strictEqual(policy.capabilityMode, 'reserved');
  assert.strictEqual(policy.reserved, true);
  assert.strictEqual(policy.allowManualEffortWhenUnknown, false);
  assert.strictEqual(capabilities.getAdvisoryModelCapability(kind, 'any-model'), null);
}

const sol = capabilities.getAdvisoryModelCapability('openai', 'gpt-5.6-sol');
assert.deepStrictEqual(sol.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
assert.strictEqual(sol.defaultReasoningEffort, 'low');
assert.strictEqual(sol.authority, 'advisory');
assert.strictEqual(sol.evidence.registryVersion, capabilities.REGISTRY_VERSION);
assert(sol.evidence.urls.every((url) => url.startsWith('https://')));

const terra = capabilities.getAdvisoryModelCapability('openai', 'gpt-5.6-terra');
assert.deepStrictEqual(terra.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
assert.strictEqual(terra.defaultReasoningEffort, 'medium');
const luna = capabilities.getAdvisoryModelCapability('openai', 'gpt-5.6-luna');
assert.deepStrictEqual(luna.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
assert.strictEqual(luna.defaultReasoningEffort, 'medium');
assert.strictEqual(capabilities.getAdvisoryModelCapability('openai', 'gpt-5.6'), null);

const gpt54 = capabilities.getAdvisoryModelCapability('OpenAI', 'GPT-5.4');
assert.deepStrictEqual(gpt54.reasoningLevels, ['low', 'medium', 'high', 'xhigh']);
assert.strictEqual(gpt54.defaultReasoningEffort, 'medium');
assert.strictEqual(
  capabilities.getAdvisoryModelCapability('openai', 'gpt-5.4-unknown-snapshot'),
  null,
  'unknown snapshots must not inherit advisory capabilities by name guessing'
);
assert.strictEqual(capabilities.getAdvisoryModelCapability('openai', 'future-model'), null);

const advisoryResolved = capabilities.resolveModelCapability({
  providerKind: 'openai',
  modelId: 'gpt-5.4',
  runtimeCapability: { id: 'gpt-5.4' },
});
assert.strictEqual(advisoryResolved.source, 'advisory');
assert.strictEqual(advisoryResolved.capabilityKnown, true);

const runtimeResolved = capabilities.resolveModelCapability({
  providerKind: 'openai',
  modelId: 'gpt-5.4',
  runtimeCapability: {
    supportedReasoningEfforts: [
      { reasoningEffort: 'ultra' },
      { reasoningEffort: 'ultra' },
      { reasoningEffort: 'max' },
    ],
    defaultReasoningEffort: 'ultra',
  },
});
assert.deepStrictEqual(runtimeResolved.reasoningLevels, ['ultra', 'max']);
assert.strictEqual(runtimeResolved.defaultReasoningEffort, 'ultra');
assert.strictEqual(runtimeResolved.source, 'runtime');
assert.strictEqual(runtimeResolved.authority, 'authoritative');
assert.strictEqual(runtimeResolved.advisory, false);

const runtimeExplicitlyEmpty = capabilities.resolveModelCapability({
  providerKind: 'openai',
  modelId: 'gpt-5.4',
  runtimeCapability: { reasoningLevels: [] },
});
assert.strictEqual(runtimeExplicitlyEmpty.capabilityKnown, true);
assert.deepStrictEqual(runtimeExplicitlyEmpty.reasoningLevels, []);
assert.strictEqual(runtimeExplicitlyEmpty.defaultReasoningEffort, null);
assert.strictEqual(runtimeExplicitlyEmpty.source, 'runtime');
assert.strictEqual(runtimeExplicitlyEmpty.allowManualEffort, false);

const customUnknown = capabilities.resolveModelCapability({
  providerKind: 'custom',
  modelId: 'private-model',
});
assert.strictEqual(customUnknown.capabilityKnown, false);
assert.deepStrictEqual(customUnknown.reasoningLevels, []);
assert.strictEqual(customUnknown.allowManualEffort, true);
assert.strictEqual(customUnknown.source, 'manual');

const customDeclaredEmpty = capabilities.resolveModelCapability({
  providerKind: 'custom',
  modelId: 'private-model',
  runtimeCapability: { supported_reasoning_efforts: [] },
});
assert.strictEqual(customDeclaredEmpty.capabilityKnown, true);
assert.strictEqual(customDeclaredEmpty.allowManualEffort, false);
assert.strictEqual(customDeclaredEmpty.source, 'runtime');

const rawModels = [
  { id: 'gpt-5.4', providerAdvertised: true },
  { id: 'unmapped-openai-model' },
  {
    id: 'gpt-5.6-sol',
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
  },
];
const decorated = capabilities.decorateModels('openai', rawModels);
assert.deepStrictEqual(decorated[0].reasoningLevels, ['low', 'medium', 'high', 'xhigh']);
assert.strictEqual(decorated[0].capabilitySource, 'advisory');
assert.strictEqual(decorated[1].capabilityKnown, false);
assert.deepStrictEqual(decorated[2].reasoningLevels, []);
assert.strictEqual(decorated[2].capabilitySource, 'runtime');
assert.strictEqual(Object.prototype.hasOwnProperty.call(rawModels[0], 'reasoningLevels'), false);

const override = capabilities.createAdvisoryOverrideSource('openai', [
  'gpt-5.4',
  'gpt-5.4',
  'unknown-model',
]);
assert.strictEqual(override.source, 'override');
assert.strictEqual(override.authority, 'capability-only');
assert.strictEqual(override.complete, false);
assert.deepStrictEqual(override.models.map((model) => model.id), ['gpt-5.4']);
assert.strictEqual(override.evidence.runtimeAuthoritative, true);
assert.strictEqual(capabilities.createAdvisoryOverrideSource('anthropic'), null);
assert.strictEqual(capabilities.createAdvisoryOverrideSource('custom', ['gpt-5.4']), null);

const firstOptions = capabilities.listProviderOptions();
firstOptions[0].label = 'mutated';
assert.strictEqual(capabilities.listProviderOptions()[0].label, 'OpenAI');
sol.reasoningLevels.push('mutated');
assert.deepStrictEqual(
  capabilities.getAdvisoryModelCapability('openai', 'gpt-5.6-sol').reasoningLevels,
  ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
);

assert(!/\bfetch\s*\(/.test(source), 'the bundled registry must not scrape documentation at runtime');
assert(!/XMLHttpRequest/.test(source), 'the bundled registry must not issue browser network requests');

const browserContext = vm.createContext({});
vm.runInContext(source, browserContext, { filename: modulePath });
assert(browserContext.RemoteCodexProviderCapabilities);
assert.strictEqual(browserContext.RemoteCodexProviderCapabilities.inferProviderKind('Claude'), 'anthropic');
assert.deepStrictEqual(
  Array.from(browserContext.RemoteCodexProviderCapabilities.resolveModelCapability({
    provider: 'OpenAI',
    model: 'gpt-5.4',
    runtime: { reasoningLevels: [] },
  }).reasoningLevels),
  []
);

console.log('Provider capability registry assertions passed');
