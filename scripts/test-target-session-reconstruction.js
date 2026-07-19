const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { repairIsolatedProvenance } = require('./repair-session-provenance');

const rolloutPath = process.env.TARGET_ROLLOUT_PATH
  || 'C:/Users/xiety/.codex/sessions/2026/07/13/rollout-2026-07-13T03-21-11-019f57c6-ad18-7062-87f7-15a61dad9d06.jsonl';
assert(fs.existsSync(rolloutPath), `target rollout missing: ${rolloutPath}`);
const before = crypto.createHash('sha256').update(fs.readFileSync(rolloutPath)).digest('hex');
const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'target-session-provenance-'));
const baseRepairOptions = {
  rolloutPath,
  hostId: 'illuin',
  sessionId: '019f57c6-ad18-7062-87f7-15a61dad9d06',
  bridgeSessionId: 'a87751e9-db8f-4a18-896f-ae1b38364ab8',
  apiProfile: {
    profileId: 'api-1781276986738-5ca8cb31040658',
    label: 'Asxs',
    provider: 'OpenAI',
    baseUrl: 'https://api.asxs.top/v1',
  },
  selection: { model: 'gpt-5.6-sol', effort: 'ultra' },
};

repairIsolatedProvenance({ ...baseRepairOptions, outputRoot }).then(async (report) => {
  const after = crypto.createHash('sha256').update(fs.readFileSync(rolloutPath)).digest('hex');
  assert.strictEqual(after, before, 'source rollout must remain byte-identical');
  assert.strictEqual(report.transcriptCount, 17, 'task_complete metadata must not inflate the raw transcript count');
  assert.strictEqual(report.deduplicatedTranscriptCount, 12);
  assert.strictEqual(report.record.bridgeSessionId, 'a87751e9-db8f-4a18-896f-ae1b38364ab8');
  assert.strictEqual(report.record.nativeThreadId, '019f57c6-ad18-7062-87f7-15a61dad9d06');
  assert.strictEqual(report.run.apiBinding.profileId, 'api-1781276986738-5ca8cb31040658');
  assert.deepStrictEqual(report.run.effectiveSelection, {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    confirmedAt: null,
  });
  assert.strictEqual(report.fullTranscript, true);
  assert.strictEqual(JSON.stringify(report).includes('apiKey'), false, 'repair report must remain secret-free');
  const secretOutputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'target-session-secret-rejection-'));
  await assert.rejects(
    repairIsolatedProvenance({
      ...baseRepairOptions,
      outputRoot: secretOutputRoot,
      apiProfile: {
        profileId: 'api-1781276986738-5ca8cb31040658',
        provider: 'OpenAI',
        baseUrl: 'https://api.asxs.top/v1',
        apiKey: 'must-not-be-accepted',
      },
    }),
    /does not accept API keys/
  );
  const nestedSecretOutputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'target-session-nested-secret-rejection-'));
  await assert.rejects(
    repairIsolatedProvenance({
      ...baseRepairOptions,
      outputRoot: nestedSecretOutputRoot,
      apiProfile: {
        profileId: 'api-1781276986738-5ca8cb31040658',
        provider: 'OpenAI',
        baseUrl: 'https://api.asxs.top/v1',
        transport: {
          credentials: {
            clientSecret: 'nested-secret-must-not-be-accepted',
          },
        },
      },
    }),
    (error) => /does not accept .*credentials/.test(error.message)
      && !error.message.includes('nested-secret-must-not-be-accepted'),
    'repair must reject nested credential fields without reflecting secret values'
  );
  assert.strictEqual(fs.existsSync(path.join(nestedSecretOutputRoot, 'wal-current.jsonl')), false);
  assert.strictEqual(fs.existsSync(path.join(nestedSecretOutputRoot, 'snapshot-current.json')), false);

  const invalidBindingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'target-session-invalid-binding-'));
  await assert.rejects(
    repairIsolatedProvenance({
      ...baseRepairOptions,
      outputRoot: invalidBindingRoot,
      apiProfile: {},
    }),
    /binding identity is incomplete/
  );
  assert.strictEqual(fs.existsSync(path.join(invalidBindingRoot, 'wal-current.jsonl')), false);
  assert.strictEqual(fs.existsSync(path.join(invalidBindingRoot, 'snapshot-current.json')), false);

  const concurrentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'target-session-concurrent-repair-'));
  const concurrentResults = await Promise.allSettled([
    repairIsolatedProvenance({ ...baseRepairOptions, outputRoot: concurrentRoot }),
    repairIsolatedProvenance({ ...baseRepairOptions, outputRoot: concurrentRoot }),
  ]);
  assert.strictEqual(concurrentResults.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejectedConcurrent = concurrentResults.find((entry) => entry.status === 'rejected');
  assert(rejectedConcurrent, 'one concurrent repair must be rejected');
  assert(/already in progress/.test(rejectedConcurrent.reason?.message || ''));

  await assert.rejects(
    repairIsolatedProvenance({
      ...baseRepairOptions,
      outputRoot,
    }),
    /refusing to overwrite existing isolated store/
  );
  console.log(`target Session isolated reconstruction passed: ${outputRoot}`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
