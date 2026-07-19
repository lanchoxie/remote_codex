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
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'secret-key-that-must-never-appear-in-envelope',
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
  assert.deepStrictEqual(await decryptBackup(JSON.stringify(envelope), password, { crypto: webcrypto }), {
    schemaVersion: 1,
    ...payload,
  });

  await assert.rejects(
    decryptBackup(envelope, password.trim(), { crypto: webcrypto }),
    (error) => error?.code === PUBLIC_ERROR
  );
  const tampered = structuredClone(envelope);
  tampered.ciphertext = `${tampered.ciphertext.slice(0, -1)}${tampered.ciphertext.endsWith('A') ? 'B' : 'A'}`;
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

  const preview = previewPayload(payload);
  assert.strictEqual(preview.apiProfiles[0].hasCredential, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(preview.apiProfiles[0], 'apiKey'), false);
  assert.strictEqual(JSON.stringify(preview).includes('secret-key'), false);

  const local = {
    apiProfiles: [
      { profileId: 'same', label: 'Local', provider: 'openai', baseUrl: 'https://same.test/v1', apiKey: 'local-key' },
      { profileId: 'collision', label: 'Local collision', provider: 'openai', baseUrl: 'https://local.test/v1', apiKey: 'local-collision' },
    ],
    selectedApiProfileId: 'same',
    defaultApiProfileId: 'same',
    hostApiProfiles: { windows: 'same' },
  };
  const imported = {
    apiProfiles: [
      { profileId: 'same', label: 'Backup', provider: 'openai', baseUrl: 'https://same.test/v1/', apiKey: 'backup-key' },
      { profileId: 'collision', label: 'Different identity', provider: 'azure', baseUrl: 'https://azure.test/v1', apiKey: 'azure-key' },
      { profileId: 'new', label: 'New', provider: 'openai', baseUrl: 'https://new.test/v1', apiKey: 'new-key' },
    ],
    selectedApiProfileId: 'collision',
    defaultApiProfileId: 'collision',
    hostApiProfiles: { windows: 'collision', pi5: 'new' },
  };
  let nextId = 0;
  const merged = planSafeMerge(local, imported, {
    makeProfileId: () => `copy-${++nextId}`,
  });
  assert.strictEqual(merged.payload.apiProfiles.find((item) => item.profileId === 'same').apiKey, 'local-key');
  assert.strictEqual(merged.idMap.collision, 'copy-1');
  assert.strictEqual(merged.payload.apiProfiles.find((item) => item.profileId === 'copy-1').apiKey, 'azure-key');
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
  assert.strictEqual(overwrite.payload.apiProfiles.find((item) => item.profileId === 'collision').provider, 'azure');
  assert.strictEqual(overwrite.payload.defaultApiProfileId, 'collision');

  console.log('API profile encrypted backup assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
