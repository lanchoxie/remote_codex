const assert = require('assert');
const { webcrypto } = require('crypto');

const {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PBKDF2_ITERATIONS,
  PUBLIC_ERROR,
  decryptBackup,
  encryptBackup,
  planSafeMerge,
  previewPayload,
  validatePayload,
} = require('../apps/mobile-web/public/api-profile-backup');

async function main() {
  const payload = {
    apiProfiles: [
      {
        profileId: 'asxs',
        label: 'Asxs API',
        provider: 'openai-compatible',
        providerKind: 'custom',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'secret-key-that-must-never-appear-in-envelope',
        sessionDefaults: {
          model: 'private-reasoner',
          effortMode: 'manual',
          effort: 'ultra_custom',
          allowUnverifiedEffort: true,
          summary: 'concise',
          ignoredNestedField: 'must-not-survive',
        },
        ignoredProfileField: 'must-not-survive',
      },
      {
        profileId: 'azure',
        label: 'Azure',
        provider: 'azure',
        baseUrl: 'https://example.openai.azure.com/openai?api-version=2026-01-01',
        apiKey: '',
      },
    ],
    selectedApiProfileId: 'asxs',
    defaultApiProfileId: 'asxs',
    hostApiProfiles: { windows: 'asxs', pi5: 'azure' },
  };
  const password = '  密码 with spaces  ';
  const envelope = await encryptBackup(payload, password, {
    crypto: webcrypto,
    now: () => '2026-07-17T00:00:00.000Z',
  });
  assert.strictEqual(envelope.format, BACKUP_FORMAT);
  assert.strictEqual(envelope.version, BACKUP_VERSION);
  assert.strictEqual(envelope.kdf.iterations, PBKDF2_ITERATIONS);
  assert.strictEqual(JSON.stringify(envelope).includes(payload.apiProfiles[0].apiKey), false);
  const decrypted = await decryptBackup(JSON.stringify(envelope), password, { crypto: webcrypto });
  assert.deepStrictEqual(decrypted, {
    schemaVersion: 1,
    apiProfiles: [
      {
        profileId: 'asxs',
        label: 'Asxs API',
        provider: 'openai-compatible',
        providerKind: 'custom',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'secret-key-that-must-never-appear-in-envelope',
        sessionDefaults: {
          model: 'private-reasoner',
          effortMode: 'manual',
          effort: 'ultra_custom',
          allowUnverifiedEffort: true,
          summary: 'concise',
        },
      },
      {
        profileId: 'azure',
        label: 'Azure',
        provider: 'azure',
        providerKind: 'custom',
        baseUrl: 'https://example.openai.azure.com/openai?api-version=2026-01-01',
        apiKey: '',
        sessionDefaults: {
          model: '',
          effortMode: 'auto',
          effort: '',
          allowUnverifiedEffort: false,
          summary: '',
        },
      },
    ],
    selectedApiProfileId: 'asxs',
    defaultApiProfileId: 'asxs',
    hostApiProfiles: { windows: 'asxs', pi5: 'azure' },
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(decrypted.apiProfiles[0], 'ignoredProfileField'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(decrypted.apiProfiles[0].sessionDefaults, 'ignoredNestedField'), false);

  await assert.rejects(
    decryptBackup(envelope, password.trim(), { crypto: webcrypto }),
    (error) => error?.code === PUBLIC_ERROR
  );
  const tampered = structuredClone(envelope);
  tampered.ciphertext = `${tampered.ciphertext.startsWith('A') ? 'B' : 'A'}${tampered.ciphertext.slice(1)}`;
  await assert.rejects(
    decryptBackup(tampered, password, { crypto: webcrypto }),
    (error) => error?.code === PUBLIC_ERROR
  );
  const maliciousWorkFactor = structuredClone(envelope);
  maliciousWorkFactor.kdf.iterations += 1;
  await assert.rejects(
    decryptBackup(maliciousWorkFactor, password, { crypto: webcrypto }),
    /unsupported PBKDF2 work factor/
  );

  assert.throws(() => validatePayload({
    ...payload,
    apiProfiles: [...payload.apiProfiles, { ...payload.apiProfiles[0] }],
  }), /duplicate API profile ID/);
  assert.throws(() => validatePayload({
    ...payload,
    apiProfiles: [{ ...payload.apiProfiles[0], baseUrl: 'file:///secrets' }],
    hostApiProfiles: {},
  }), /http or https/);
  assert.throws(() => validatePayload({
    ...payload,
    hostApiProfiles: { windows: 'missing' },
  }), /unknown API profile/);
  assert.throws(() => validatePayload({
    ...payload,
    apiProfiles: [{ ...payload.apiProfiles[0], providerKind: 'unknown-provider' }],
    hostApiProfiles: {},
  }), /Unsupported API provider kind/);
  assert.throws(() => validatePayload({
    ...payload,
    apiProfiles: [{
      ...payload.apiProfiles[0],
      sessionDefaults: { effortMode: 'manual', effort: 'NOT VALID' },
    }],
    hostApiProfiles: {},
  }), /invalid format/);

  const legacy = validatePayload({
    apiProfiles: [{
      profileId: 'legacy',
      label: 'Legacy Claude',
      provider: 'Claude',
      baseUrl: 'https://legacy.example.test/v1',
      apiKey: '',
    }],
  });
  assert.strictEqual(legacy.apiProfiles[0].providerKind, 'anthropic');
  assert.deepStrictEqual(legacy.apiProfiles[0].sessionDefaults, {
    model: '',
    effortMode: 'auto',
    effort: '',
    allowUnverifiedEffort: false,
    summary: '',
  });

  const preview = previewPayload(payload);
  assert.strictEqual(preview.apiProfiles[0].hasCredential, true);
  assert.strictEqual(preview.apiProfiles[0].providerKind, 'custom');
  assert.strictEqual(preview.apiProfiles[0].sessionDefaults.effort, 'ultra_custom');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(preview.apiProfiles[0], 'apiKey'), false);
  assert.strictEqual(JSON.stringify(preview).includes('secret-key'), false);

  const local = {
    apiProfiles: [
      {
        profileId: 'same',
        label: 'Local',
        provider: 'openai',
        providerKind: 'openai',
        baseUrl: 'https://same.test/v1',
        apiKey: 'local-key',
        sessionDefaults: { model: 'local-model', effortMode: 'auto', summary: 'auto' },
      },
      { profileId: 'collision', label: 'Local collision', provider: 'openai', baseUrl: 'https://local.test/v1', apiKey: 'local-collision' },
    ],
    selectedApiProfileId: 'same',
    defaultApiProfileId: 'same',
    hostApiProfiles: { windows: 'same' },
  };
  const imported = {
    apiProfiles: [
      {
        profileId: 'same',
        label: 'Backup',
        provider: 'openai',
        providerKind: 'openai',
        baseUrl: 'https://same.test/v1/',
        apiKey: 'backup-key',
        sessionDefaults: { model: 'backup-model', effortMode: 'manual', effort: 'high', summary: 'detailed' },
      },
      {
        profileId: 'collision',
        label: 'Different identity',
        provider: 'azure',
        providerKind: 'custom',
        baseUrl: 'https://azure.test/v1',
        apiKey: 'azure-key',
        sessionDefaults: {
          model: 'azure-model',
          effortMode: 'manual',
          effort: 'vendor_high',
          allowUnverifiedEffort: true,
          summary: 'concise',
        },
      },
      {
        profileId: 'new',
        label: 'New',
        provider: 'openai',
        providerKind: 'openai',
        baseUrl: 'https://new.test/v1',
        apiKey: 'new-key',
        sessionDefaults: { model: 'gpt-5.4', effortMode: 'manual', effort: 'xhigh', summary: 'auto' },
      },
    ],
    selectedApiProfileId: 'collision',
    defaultApiProfileId: 'collision',
    hostApiProfiles: { windows: 'collision', pi5: 'new' },
  };
  let nextId = 0;
  const merged = planSafeMerge(local, imported, {
    makeProfileId: () => `copy-${++nextId}`,
  });
  const mergedSame = merged.payload.apiProfiles.find((item) => item.profileId === 'same');
  assert.strictEqual(mergedSame.apiKey, 'local-key');
  assert.strictEqual(mergedSame.label, 'Backup');
  assert.strictEqual(mergedSame.sessionDefaults.model, 'backup-model');
  assert.strictEqual(merged.idMap.collision, 'copy-1');
  assert.strictEqual(merged.payload.apiProfiles.find((item) => item.profileId === 'copy-1').apiKey, 'azure-key');
  assert.strictEqual(merged.payload.apiProfiles.find((item) => item.profileId === 'copy-1').providerKind, 'custom');
  assert.strictEqual(merged.payload.apiProfiles.find((item) => item.profileId === 'copy-1').sessionDefaults.effort, 'vendor_high');
  assert.strictEqual(merged.payload.apiProfiles.find((item) => item.profileId === 'new').sessionDefaults.model, 'gpt-5.4');
  assert.strictEqual(merged.payload.hostApiProfiles.windows, 'same', 'safe merge preserves an existing local Host mapping');
  assert.strictEqual(merged.payload.hostApiProfiles.pi5, 'new');
  assert.strictEqual(merged.payload.defaultApiProfileId, 'same');
  assert.deepStrictEqual(merged.conflicts.map((item) => item.type).sort(), ['credential', 'identity']);

  const overwrite = planSafeMerge(local, imported, {
    keyConflicts: { same: 'backup' },
    identityConflicts: { collision: 'replace' },
    useImportedDefaults: true,
    makeProfileId: () => 'unused',
  });
  assert.strictEqual(overwrite.payload.apiProfiles.find((item) => item.profileId === 'same').apiKey, 'backup-key');
  assert.strictEqual(overwrite.payload.apiProfiles.find((item) => item.profileId === 'same').sessionDefaults.model, 'backup-model');
  assert.strictEqual(overwrite.payload.apiProfiles.find((item) => item.profileId === 'collision').provider, 'azure');
  assert.strictEqual(overwrite.payload.apiProfiles.find((item) => item.profileId === 'collision').providerKind, 'custom');
  assert.strictEqual(overwrite.payload.apiProfiles.find((item) => item.profileId === 'collision').sessionDefaults.model, 'azure-model');
  assert.strictEqual(overwrite.payload.defaultApiProfileId, 'collision');

  const upgradedLegacy = planSafeMerge({
    apiProfiles: [{
      profileId: 'legacy-metadata',
      label: 'Legacy gateway',
      provider: 'gateway',
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'local-key',
    }],
  }, {
    apiProfiles: [{
      profileId: 'legacy-metadata',
      label: 'Gemini gateway',
      provider: 'gateway',
      providerKind: 'gemini',
      baseUrl: 'https://gateway.test/v1/',
      apiKey: 'backup-key',
      sessionDefaults: {
        model: 'gemini-2.5-pro',
        effortMode: 'manual',
        effort: 'high',
        summary: 'auto',
      },
    }],
  });
  const upgradedProfile = upgradedLegacy.payload.apiProfiles[0];
  assert.strictEqual(upgradedProfile.label, 'Gemini gateway');
  assert.strictEqual(upgradedProfile.providerKind, 'gemini');
  assert.deepStrictEqual(upgradedProfile.sessionDefaults, {
    model: 'gemini-2.5-pro',
    effortMode: 'manual',
    effort: 'high',
    allowUnverifiedEffort: false,
    summary: 'auto',
  });
  assert.strictEqual(upgradedProfile.apiKey, 'local-key', 'metadata merge must not bypass credential conflict policy');
  assert.deepStrictEqual(upgradedLegacy.conflicts, [{ type: 'credential', profileId: 'legacy-metadata' }]);

  console.log('API profile encrypted backup assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
