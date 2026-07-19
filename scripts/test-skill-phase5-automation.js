const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SkillAuditLog } = require('../apps/relay/skill-audit-log');
const {
  SkillAutomationService,
  planEnabledHostRollouts,
  sourceRefreshDue,
} = require('../apps/relay/skill-automation-service');

async function main() {
  const now = Date.parse('2026-07-17T00:00:00.000Z');
  assert.strictEqual(sourceRefreshDue({
    kind: 'github', enabled: true, refreshPolicy: 'hourly', lastRefreshAt: '2026-07-16T22:00:00.000Z',
  }, now), true);
  assert.strictEqual(sourceRefreshDue({
    kind: 'github', enabled: true, refreshPolicy: 'manual', lastRefreshAt: '2020-01-01T00:00:00.000Z',
  }, now), false);

  const plans = planEnabledHostRollouts({
    sourceId: 'github:owner/repo:skills/demo',
    skillId: 'demo',
    artifactId: `sha256:${'b'.repeat(64)}`,
    desiredStates: [
      { hostId: 'host-a', skillId: 'demo', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'enabled', scope: 'user' },
      { hostId: 'host-b', skillId: 'demo', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'disabled', scope: 'user' },
      { hostId: 'host-c', skillId: 'other', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'enabled', scope: 'user' },
      { hostId: 'host-d', skillId: 'demo', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'enabled', scope: 'project', scopeId: 'D:/work', cwd: 'D:/work' },
    ],
  });
  assert.deepStrictEqual(plans.flatMap((plan) => plan.targetHostIds).sort(), ['host-a', 'host-d']);
  assert(plans.find((plan) => plan.targetScope === 'project')?.confirmProjectWrite);
  assert.deepStrictEqual(plans, planEnabledHostRollouts({
    sourceId: 'github:owner/repo:skills/demo',
    skillId: 'demo',
    artifactId: `sha256:${'b'.repeat(64)}`,
    desiredStates: [
      { hostId: 'host-a', skillId: 'demo', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'enabled', scope: 'user' },
      { hostId: 'host-b', skillId: 'demo', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'disabled', scope: 'user' },
      { hostId: 'host-c', skillId: 'other', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'enabled', scope: 'user' },
      { hostId: 'host-d', skillId: 'demo', artifactId: `sha256:${'a'.repeat(64)}`, desiredState: 'enabled', scope: 'project', scopeId: 'D:/work', cwd: 'D:/work' },
    ],
  }), 'automatic rollout request IDs must be deterministic');

  const refreshes = [];
  const deployments = [];
  const auditEvents = [];
  const service = new SkillAutomationService({
    now: () => now,
    loadSources: () => [{
      sourceId: 'source-a', kind: 'github', enabled: true, refreshPolicy: 'hourly',
      rolloutPolicy: 'enabled-hosts', lastRefreshAt: '2026-07-16T20:00:00.000Z',
    }],
    scheduleRefresh: async (source) => refreshes.push(source.sourceId),
    loadDesiredStates: () => [{
      hostId: 'host-a', skillId: 'demo', artifactId: `sha256:${'a'.repeat(64)}`,
      desiredState: 'enabled', scope: 'user', scopeId: 'user',
    }],
    dispatchRollout: async (plan) => {
      deployments.push(plan);
      return { deployment: { deploymentId: 'deployment-1' } };
    },
    audit: (type, data) => auditEvents.push({ type, data }),
  });
  assert.strictEqual(await service.tick(), 1);
  assert.deepStrictEqual(refreshes, ['source-a']);
  await service.rolloutAfterRefresh({
    source: { sourceId: 'source-a', rolloutPolicy: 'enabled-hosts' },
    skillId: 'demo',
    artifactId: `sha256:${'b'.repeat(64)}`,
  });
  assert.strictEqual(deployments.length, 1);
  assert(auditEvents.some((event) => event.type === 'skills.rollout.dispatched'));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-audit-'));
  const auditPath = path.join(root, 'audit.jsonl');
  try {
    const log = new SkillAuditLog({
      auditPath,
      now: () => '2026-07-17T00:00:00.000Z',
      idFactory: (() => { let id = 0; return () => `event-${++id}`; })(),
    });
    log.append('skills.source.refresh_scheduled', { sourceId: 'source-a', token: 'must-redact' });
    log.append('skills.rollout.dispatched', { deploymentId: 'deployment-1' });
    const reopened = new SkillAuditLog({ auditPath });
    const page = reopened.query({ afterSequence: 0, limit: 1 });
    assert.strictEqual(page.events.length, 1);
    assert.strictEqual(page.hasMore, true);
    assert.strictEqual(JSON.stringify(page.events).includes('must-redact'), false);
    assert.strictEqual(reopened.query({ afterSequence: 1 }).events[0].previousHash, page.events[0].hash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('Skills Phase 5 automation and audit assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
