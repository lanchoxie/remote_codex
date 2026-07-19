const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');

function extractFunction(name) {
  const signatures = [`async function ${name}(`, `function ${name}(`];
  const start = signatures.map((signature) => app.indexOf(signature)).find((index) => index >= 0);
  assert(start >= 0, `missing function ${name}`);
  const brace = app.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < app.length; index += 1) {
    const char = app[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

async function main() {
  const requests = [];
  const revisions = [];
  let response = {
    ok: true,
    source: {
      sourceId: 'github:owner/repo:main:skills/demo',
      kind: 'github',
      refreshPolicy: 'daily',
      rolloutPolicy: 'enabled-hosts',
      updatedAt: '2026-07-17T10:00:00.000Z',
    },
    revision: 8,
    idempotent: false,
  };
  let failure = null;
  const sourceId = response.source.sourceId;
  const manager = {
    sources: [{
      sourceId,
      name: 'Demo',
      kind: 'github',
      registry: true,
      refreshPolicy: 'manual',
      rolloutPolicy: 'manual',
    }],
    sourceAutomationDrafts: new Map([[sourceId, {
      refreshPolicy: 'daily',
      rolloutPolicy: 'enabled-hosts',
      dirty: true,
    }]]),
    sourceAutomationStatus: new Map(),
    lifecycleBusyKeys: new Set(),
    registryRevision: 7,
    actionSummary: '',
    auditEvents: [],
    auditLoading: false,
    auditLoaded: false,
    auditError: '',
    auditLatestSequence: 0,
  };
  const context = {
    state: { skillsManager: manager },
    console,
    Map,
    Set,
    JSON,
    encodeURIComponent,
    renderSkillsManager() {},
    renderSkillsAudit() {},
    advanceSkillsRegistryRevision(value) {
      revisions.push(value);
      if (Number.isSafeInteger(Number(value))) manager.registryRevision = Math.max(manager.registryRevision, Number(value));
    },
    async fetchJson(url, options) {
      requests.push({ url, options });
      if (failure) throw failure;
      return typeof response === 'function' ? response(url, options) : response;
    },
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction('normalizeSkillSourceRefreshPolicy'),
    extractFunction('normalizeSkillSourceRolloutPolicy'),
    extractFunction('skillSourceAutomationDraft'),
    extractFunction('updateSkillSourceAutomation'),
    extractFunction('loadSkillsAudit'),
  ].join('\n'), context);

  assert.strictEqual(context.normalizeSkillSourceRefreshPolicy('HOURLY'), 'hourly');
  assert.strictEqual(context.normalizeSkillSourceRefreshPolicy('invalid'), 'manual');
  assert.strictEqual(context.normalizeSkillSourceRolloutPolicy('enabled-hosts'), 'enabled-hosts');
  assert.strictEqual(context.normalizeSkillSourceRolloutPolicy('invalid'), 'manual');

  assert.strictEqual(await context.updateSkillSourceAutomation(sourceId), true);
  assert.strictEqual(requests[0].url, `/api/skills/sources/${encodeURIComponent(sourceId)}/automation`);
  assert.strictEqual(requests[0].options.method, 'POST');
  assert.deepStrictEqual(JSON.parse(requests[0].options.body), {
    expectedRevision: 7,
    refreshPolicy: 'daily',
    rolloutPolicy: 'enabled-hosts',
  });
  assert.strictEqual(manager.sources[0].refreshPolicy, 'daily', 'successful policy should echo immediately');
  assert.strictEqual(manager.sources[0].rolloutPolicy, 'enabled-hosts');
  assert.strictEqual(manager.sourceAutomationDrafts.has(sourceId), false);
  assert.match(manager.sourceAutomationStatus.get(sourceId).message, /saved/i);
  assert.strictEqual(manager.lifecycleBusyKeys.size, 0);
  assert.deepStrictEqual(revisions, [8]);

  manager.sourceAutomationDrafts.set(sourceId, {
    refreshPolicy: 'weekly', rolloutPolicy: 'manual', dirty: true,
  });
  failure = new Error('revision conflict');
  failure.body = { revision: 9 };
  assert.strictEqual(await context.updateSkillSourceAutomation(sourceId), false);
  assert.strictEqual(manager.sources[0].refreshPolicy, 'daily', 'failed policy must not overwrite authoritative echo');
  assert.strictEqual(manager.sourceAutomationDrafts.get(sourceId).refreshPolicy, 'weekly');
  assert.match(manager.sourceAutomationStatus.get(sourceId).message, /revision conflict/i);
  assert.strictEqual(manager.registryRevision, 9);
  assert.strictEqual(manager.lifecycleBusyKeys.size, 0);

  failure = null;
  response = {
    events: [{ sequence: 12, type: 'skills.source.automation_updated' }],
    latestSequence: 12,
    hasMore: false,
  };
  assert.strictEqual(await context.loadSkillsAudit(), true);
  assert.strictEqual(requests.at(-1).url, '/api/skills/audit?limit=50');
  assert.strictEqual(manager.auditEvents[0].sequence, 12);
  assert.strictEqual(manager.auditLatestSequence, 12);
  assert.strictEqual(manager.auditLoaded, true);
  assert.strictEqual(manager.auditError, '');

  response = (url) => url.includes('afterSequence=70')
    ? {
      events: [{ sequence: 120, type: 'skills.source.refresh_queued' }],
      latestSequence: 120,
      hasMore: false,
      nextAfterSequence: 120,
    }
    : {
      events: [{ sequence: 1, type: 'skills.audit.started' }],
      latestSequence: 120,
      hasMore: true,
      nextAfterSequence: 1,
    };
  assert.strictEqual(await context.loadSkillsAudit(), true);
  assert.strictEqual(requests.at(-1).url, '/api/skills/audit?afterSequence=70&limit=50');
  assert.strictEqual(manager.auditEvents[0].sequence, 120, 'audit view should replace the oldest page with the recent window');

  failure = new Error('audit unavailable');
  assert.strictEqual(await context.loadSkillsAudit(), false);
  assert.match(manager.auditError, /audit unavailable/i);
  assert.strictEqual(manager.auditLoading, false);

  console.log('skills manager automation UI assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
