const assert = require('assert');
const { HostSkillInventoryService } = require('../apps/host-agent/skill-inventory-service');

async function main() {
  const published = [];
  let scans = 0;
  let revision = 'sha256:one';
  const service = new HostSkillInventoryService({
    hostId: 'host-a',
    codexHome: '/home/test/.codex',
    workspaceRoots: ['/work/a'],
    scan: async (options) => {
      scans += 1;
      assert(options.workspaceRoots.includes('/work/a'));
      return {
        revision,
        scannedAt: `scan-${scans}`,
        instances: [{ instanceId: revision, hostId: 'host-a', skillId: 'fixture' }],
        scanErrors: [],
      };
    },
    publish: async (snapshot) => published.push(snapshot),
  });

  const first = await service.refresh({ force: true });
  assert.strictEqual(first.changed, true);
  assert.strictEqual(first.published, true);
  assert.strictEqual(published.length, 1);

  const second = await service.refresh({ force: true });
  assert.strictEqual(second.changed, false);
  assert.strictEqual(published.length, 1);

  service.addWorkspaceRoots(['/work/b', '/work/a']);
  revision = 'sha256:two';
  const third = await service.refresh({ force: true });
  assert.strictEqual(third.changed, true);
  assert.strictEqual(published.length, 2);
  assert(service.getWorkspaceRoots().includes('/work/b'));
  assert.strictEqual(service.snapshot().revision, 'sha256:two');

  const beforeConcurrentScans = scans;
  await Promise.all([
    service.refresh({ force: true }),
    service.refresh({ force: true }),
    service.refresh({ force: true }),
  ]);
  assert.strictEqual(scans, beforeConcurrentScans + 1, 'concurrent refreshes should share one scan');

  const unchanged = await service.refresh({ force: true, publishUnchanged: true });
  assert.strictEqual(unchanged.changed, false);
  assert.strictEqual(unchanged.published, true);
  assert.strictEqual(published.length, 3);

  let releasePublish;
  let signalPublishStarted;
  const publishStarted = new Promise((resolve) => { signalPublishStarted = resolve; });
  const publishGate = new Promise((resolve) => { releasePublish = resolve; });
  const publishContexts = [];
  let concurrentScans = 0;
  const concurrentService = new HostSkillInventoryService({
    hostId: 'host-concurrent',
    codexHome: '/home/test/.codex',
    scan: async () => {
      concurrentScans += 1;
      return {
        revision: 'sha256:concurrent',
        scannedAt: `concurrent-${concurrentScans}`,
        instances: [],
        scanErrors: [],
      };
    },
    publish: async (_snapshot, context) => {
      publishContexts.push(context);
      if (publishContexts.length === 1) {
        signalPublishStarted();
        await publishGate;
      }
    },
  });
  const backgroundRefresh = concurrentService.refresh({ force: true });
  await publishStarted;
  const explicitRefresh = concurrentService.refresh({
    force: true,
    publishUnchanged: true,
    publishContext: { requestId: 'explicit-request' },
  });
  releasePublish();
  await Promise.all([backgroundRefresh, explicitRefresh]);
  assert(
    publishContexts.some((context) => context?.requestId === 'explicit-request'),
    'an explicit refresh arriving during publication must receive a correlated event'
  );
  concurrentService.stop();

  let managed = false;
  const transformedPublications = [];
  const transformedService = new HostSkillInventoryService({
    hostId: 'host-transformed',
    codexHome: '/home/test/.codex',
    scan: async () => ({
      revision: `sha256:${'a'.repeat(64)}`,
      scannedAt: 'transformed-scan',
      instances: [{
        instanceId: 'managed-fixture',
        hostId: 'host-transformed',
        skillId: 'fixture',
        activationPath: '/home/test/.codex/skills/fixture',
        managed: false,
      }],
      scanErrors: [],
    }),
    transformSnapshot: (snapshot) => ({
      ...snapshot,
      instances: snapshot.instances.map((instance) => ({ ...instance, managed })),
    }),
    publish: async (snapshot) => transformedPublications.push(snapshot),
  });
  const unmanagedSnapshot = await transformedService.refresh({ force: true });
  managed = true;
  transformedService.invalidate();
  const managedSnapshot = await transformedService.refresh({ force: true });
  assert.notStrictEqual(managedSnapshot.snapshot.revision, unmanagedSnapshot.snapshot.revision);
  assert.strictEqual(managedSnapshot.snapshot.instances[0].managed, true);
  assert.strictEqual(transformedPublications.length, 2);
  transformedService.stop();

  service.stop();
  service.stop();
}

main().then(() => console.log('host skill inventory service assertions passed')).catch((error) => {
  console.error(error);
  process.exit(1);
});
