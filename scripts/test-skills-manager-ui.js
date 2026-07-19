const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps/mobile-web/public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/mobile-web/public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps/mobile-web/public/styles.css'), 'utf8');

function assertIncludes(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nMissing: ${needle}`
  );
}

function assertNotInPrimaryToolbar(buttonId) {
  const toolbar = getPrimaryToolbar();
  assert(
    !toolbar.includes(`id="${buttonId}"`),
    `${buttonId} should not be present in the primary detail toolbar`
  );
}

function assertInPrimaryToolbar(buttonId) {
  const toolbar = getPrimaryToolbar();
  assert(
    toolbar.includes(`id="${buttonId}"`),
    `${buttonId} should remain available in the primary detail toolbar`
  );
}

function getPrimaryToolbar() {
  const headerStart = html.indexOf('<div class="detail-actions">');
  const headerEnd = html.indexOf('</div>\n        </header>', headerStart);
  assert(headerStart >= 0 && headerEnd > headerStart, 'detail-actions toolbar not found');
  return html.slice(headerStart, headerEnd);
}

assertIncludes(html, 'id="open-skills-manager-button"', 'Skills manager needs a global toolbar entry');
assertIncludes(html, 'id="skills-manager-overlay"', 'Skills manager overlay should exist');
assertIncludes(html, 'id="skills-host-list"', 'Skills manager needs host multi-select UI');
assertIncludes(html, 'id="skills-list"', 'Skills manager needs skill list UI');
assertIncludes(html, 'id="skills-install-selected-button"', 'Skills manager needs batch install button');
assertIncludes(html, 'id="skills-uninstall-selected-button"', 'Skills manager needs batch uninstall button');
assertIncludes(html, 'id="skills-install-selected-button" type="button" class="hidden" hidden', 'legacy single-file install must not be presented as artifact deployment');
assertIncludes(html, 'id="skills-uninstall-selected-button" type="button" class="hidden" hidden', 'legacy single-file uninstall must not be presented as artifact removal');
assertIncludes(html, 'id="skills-inventory-matrix"', 'Skills manager needs a host inventory matrix');
assertIncludes(html, 'id="skills-refresh-selected-button"', 'Skills manager needs targeted refresh');
assertIncludes(html, 'id="skills-github-locator-input"', 'Skills manager needs a GitHub repository locator');
assertIncludes(html, 'id="skills-github-ref-input"', 'Skills manager needs an explicit GitHub ref');
assertIncludes(html, 'id="skills-github-subpath-input"', 'Skills manager needs an explicit GitHub Skill subpath');
assertIncludes(html, 'id="skills-import-github-button"', 'Skills manager needs a GitHub import command');
assertIncludes(html, 'id="skills-library-lifecycle-list"', 'Sources view needs central Library lifecycle rows');
assertIncludes(html, 'id="skills-collect-unused-button"', 'Sources view needs an explicit Artifact collection command');
assertIncludes(html, 'id="skills-configured-sources-title"', 'Sources view needs a distinct configured-sources heading');
assertIncludes(html, 'id="skills-enable-selected-button"', 'Skills manager needs an explicit Enable command');
assertIncludes(html, 'id="skills-enable-all-hosts-button"', 'Skills manager needs Enable on all hosts');
assertIncludes(html, 'id="skills-disable-selected-button"', 'Skills manager needs an explicit Disable command');
assertIncludes(html, 'id="skills-remove-host-button"', 'Skills manager needs an explicit Remove from host command');
assertIncludes(html, 'id="skills-deployment-scope"', 'Skills manager needs a deployment scope segmented control');
assertIncludes(html, 'data-skills-scope="user"', 'Skills manager needs User scope');
assertIncludes(html, 'data-skills-scope="project"', 'Skills manager needs Project scope');
assertIncludes(html, 'id="skills-project-cwd-select"', 'Project deployment needs an exact known workspace selector');
assertIncludes(html, 'id="skills-confirm-project-write"', 'Project deployment needs explicit write confirmation');
assertIncludes(html, 'id="skills-deployment-progress"', 'Skills manager needs persistent per-Host deployment progress');
assertIncludes(html, 'id="advanced-session-actions" class="hidden" hidden aria-hidden="true"', 'Legacy disabled join control should live in a hidden compatibility container');

assertNotInPrimaryToolbar('join-session-button');
assertInPrimaryToolbar('resume-session-button');
assertNotInPrimaryToolbar('fork-session-button');

assertIncludes(app, 'skillsManager', 'Client state should include skillsManager state');
assertIncludes(app, 'loadSkillsManager', 'Client should load skills manager data');
assertIncludes(app, 'renderSkillsManager', 'Client should render skills manager data');
assertIncludes(app, '/api/skills', 'Client should call the skills API');
assertIncludes(app, 'runSkillsManagerAction', 'Client should run batch skills actions');
assertIncludes(app, '/api/skills/actions', 'Client should call the batch skills API');
assertIncludes(app, '/api/skills/favorites', 'Client should persist skill favorites');
assertIncludes(app, 'data-skills-tab', 'Client should handle Skills manager tabs');
assertIncludes(app, '|| state.skillsManager.open', 'Skills manager should participate in modal body locking');
assertIncludes(app, 'closeSkillsManager();', 'Escape should close the Skills manager');
assertIncludes(app, '/api/skills/refresh', 'Client should start asynchronous host refresh');
assertIncludes(app, '/api/skills/events', 'Client should subscribe to Skills SSE');
assertIncludes(app, 'skills.inventory.updated', 'Client should react to inventory revisions');
assertIncludes(app, 'dirty: false', 'Global Skill events need a deferred manager reload marker');
assertIncludes(app, 'function scheduleSkillsManagerReload()', 'Skills manager reloads should be coalesced');
assertIncludes(app, 'function closeSkillsInventoryEvents()', 'Auth transitions must stop global Skill events');
assertIncludes(app, 'renderSkillsInventoryMatrix', 'Client should render host-instance state');
assertIncludes(app, 'instances:', 'Client state should retain normalized skill instances');
assertIncludes(app, 'inventories:', 'Client state should retain host inventory metadata');
assertIncludes(app, 'artifacts:', 'Client state should retain registry artifacts');
assertIncludes(app, 'adoptions:', 'Client state should retain Host adoption progress');
assertIncludes(app, 'imports:', 'Client state should retain source import progress');
assertIncludes(app, 'function adoptSkillInstance', 'Client should expose per-instance Adopt');
assertIncludes(app, '/api/skills/adopt', 'Client should call the adoption API');
assertIncludes(app, 'data-skills-adopt-instance-id', 'Inventory cells should expose explicit Adopt actions');
assertIncludes(app, 'function registeredSkillArtifactForInstance', 'Adopted state should survive transient operation records');
assertIncludes(app, 'function importGithubSkill', 'Client should import a GitHub Skill directory');
assertIncludes(app, '/api/skills/import', 'Client should call the source import API');
assertIncludes(app, 'function refreshGithubSkillSource', 'Client should refresh a persisted GitHub source');
assertIncludes(app, '/api/skills/sources/${encodeURIComponent(normalizedSourceId)}/refresh', 'Source refresh should call the persisted Registry source API');
assertIncludes(app, 'function updateSkillLibraryLifecycle', 'Client should expose Retire and Restore actions');
assertIncludes(app, '/api/skills/library/${encodeURIComponent(normalizedSkillId)}/${action}', 'Library lifecycle actions should address the selected Skill');
assertIncludes(app, 'function collectUnusedSkillArtifacts', 'Client should expose explicit Artifact collection');
assertIncludes(app, '/api/skills/artifacts/gc', 'Artifact collection should call the GC API');
assertIncludes(app, 'lifecycleBusyKeys: new Set()', 'Lifecycle commands need bounded per-row busy state');
assertIncludes(app, 'collectingArtifacts: false', 'Artifact collection needs a bounded busy state');
assertIncludes(app, 'function libraryRecordHasAvailableArtifact(', 'Restore availability should follow retained Artifact bytes');
assertIncludes(app, 'JSON.stringify({ expectedRevision: manager.registryRevision })', 'Lifecycle mutations must preserve Registry revision zero');
assertIncludes(app, 'function skillsRegistryResponseRevision(', 'Registry payloads need monotonic revision parsing');
assertIncludes(app, 'applyRegistryPayload', 'Skills reloads must guard Registry-backed fields from stale responses');
assertIncludes(app, 'data-skills-retire-library-id', 'Active Library rows should expose Retire');
assertIncludes(app, 'data-skills-restore-library-id', 'Retired Library rows should expose Restore');
assertIncludes(app, 'data-skills-refresh-source-id', 'GitHub Registry sources should expose Refresh');
assert(
  !app.includes('formatDateTime('),
  'Library lifecycle rows must use an existing time formatter'
);
assertIncludes(app, 'skills.library.updated', 'Client should react to artifact library events');
assertIncludes(app, 'deployments:', 'Client state should retain durable deployment summaries');
assertIncludes(app, 'desiredSkillStates:', 'Client state should retain durable desired Skill ownership');
assertIncludes(app, 'appliedSkillStates:', 'Client state should retain durable applied Skill ownership');
assertIncludes(app, 'selectedCleanupKeys: new Set()', 'Retired Artifact cleanup needs row-specific selections');
assertIncludes(app, 'function latestRegistryArtifactForSkill', 'Deployment selection must resolve a Registry Artifact');
assertIncludes(app, 'function instanceMatchesRegistryArtifact(', 'Registry rows must match Host instances by Artifact identity');
assertIncludes(app, 'data-skills-deploy-skill-id', 'Only Artifact-backed rows should expose deployment selection');
assertIncludes(app, 'data-skills-cleanup-row-key', 'Referenced retired Artifact rows should expose cleanup selection');
assertIncludes(app, 'function skillsManagedReferenceRows(', 'Cleanup rows should merge desired and applied references');
assertIncludes(app, 'function skillsDeploymentSnapshotsForAction(', 'Deployment actions should resolve Enable and cleanup targets separately');
assertIncludes(app, 'function deploySelectedSkills', 'Client should submit desired-state deployments');
assertIncludes(app, '/api/skills/deployments', 'Client should call the deployment API');
assertIncludes(app, "action: 'enable'", 'Client should submit Enable desired state');
assertIncludes(app, "action: 'disable'", 'Client should submit Disable desired state');
assertIncludes(app, "action: 'remove'", 'Client should submit Remove-from-Host desired state');
assertIncludes(app, 'confirmProjectWrite', 'Client should send explicit project confirmation');
assertIncludes(app, 'projectWriteConfirmationKey', 'Project confirmation must bind to Host and cwd context');
assertIncludes(app, 'function resetSkillsProjectWriteConfirmation()', 'Project consent must be explicitly invalidated');
assertIncludes(app, 'function skillsProjectConfirmationKey(', 'Project consent needs a canonical context key');
assertIncludes(app, 'const targetHostIds = Object.freeze', 'Each deployment batch needs a stable Host snapshot');
assertIncludes(app, 'const knownSkillsHostIds = new Set', 'Skills reload should discard Host selections that no longer exist');
assertIncludes(
  app,
  'knownSkillsHostIds.has(state.selectedHostId)',
  'A deleted global Host selection must not be reintroduced into Skills targets'
);
assertIncludes(app, "source.addEventListener('skills.deployment.updated'", 'Client should consume deployment SSE');
assertIncludes(app, 'function mergeSkillsDeploymentUpdate(', 'Incremental deployment SSE must merge per-Host results');
assertIncludes(app, 'deploymentVersion', 'HTTP loads must not overwrite newer deployment SSE state');
assertIncludes(app, 'desiredVersion', 'HTTP loads must not overwrite newer desired-state updates');
assertIncludes(app, 'function scheduleSkillsManagerRender()', 'Deployment SSE rendering must be coalesced');
assert(
  !app.includes('manager.hosts.length ? manager.hosts : state.hosts'),
  'Skills deployment UI must not revive stale global Hosts when authoritative Skills Hosts are empty'
);
assertIncludes(css, '.skills-inventory-state.state-queued', 'Matrix should style queued deployment state');
assertIncludes(css, '.skills-inventory-state.state-running', 'Matrix should style running deployment state');
assertIncludes(css, '.skills-deployment-progress', 'Deployment progress should have stable layout styling');
assertIncludes(css, '.skills-library-lifecycle-toolbar', 'Library lifecycle controls should have stable layout styling');
assertIncludes(css, '.skills-source-actions', 'Source lifecycle buttons should have stable layout styling');
assertIncludes(css, '.skills-row-actions', 'Active Registry row actions should have stable layout styling');
assertIncludes(css, 'overflow-wrap: anywhere', 'Long source and Skill names should not overflow narrow layouts');

const skillsListClickStart = app.indexOf("el('skills-list')?.addEventListener('click'");
const skillsListClickEnd = app.indexOf("el('skills-inventory-matrix')?.addEventListener('click'", skillsListClickStart);
assert(skillsListClickStart >= 0 && skillsListClickEnd > skillsListClickStart, 'Skills list click handler not found');
const skillsListClickHandler = app.slice(skillsListClickStart, skillsListClickEnd);
assertIncludes(
  skillsListClickHandler,
  'data-skills-retire-library-id',
  'Active Registry browse rows should route Retire actions'
);
assertIncludes(
  skillsListClickHandler,
  'updateSkillLibraryLifecycle',
  'Active Registry browse rows should share the confirmed lifecycle action'
);

const libraryEventStart = app.indexOf("source.addEventListener('skills.library.updated'");
const libraryEventEnd = app.indexOf('\n  });', libraryEventStart);
assert(libraryEventStart >= 0 && libraryEventEnd > libraryEventStart, 'Skills library SSE handler not found');
assert(
  !app.slice(libraryEventStart, libraryEventEnd).includes('clearSkillOptionsCacheForHosts'),
  'Adopt/import changes central library only and must not invalidate live slash Skills'
);
assertIncludes(
  app.slice(libraryEventStart, libraryEventEnd),
  'scheduleSkillsManagerReload();',
  'Library events should mark the closed manager dirty instead of forcing an immediate full reload'
);
assertIncludes(
  app.slice(libraryEventStart, libraryEventEnd),
  'skillsLibraryEventSummary(payload, manager.actionSummary)',
  'Library SSE must merge its summary without erasing a partial GC result'
);
const inventoryEventStart = app.indexOf("source.addEventListener('skills.inventory.updated'");
const inventoryEventEnd = app.indexOf('\n  });', inventoryEventStart);
assertIncludes(
  app.slice(inventoryEventStart, inventoryEventEnd),
  'scheduleSkillsManagerReload();',
  'Inventory events should coalesce full Skills payload reloads'
);

const deploymentEventStart = app.indexOf("source.addEventListener('skills.deployment.updated'");
const deploymentEventEnd = app.indexOf('\n  });', deploymentEventStart);
assert(deploymentEventStart >= 0 && deploymentEventEnd > deploymentEventStart, 'Skills deployment SSE handler not found');
const deploymentEventHandler = app.slice(deploymentEventStart, deploymentEventEnd);
assertIncludes(
  deploymentEventHandler,
  'clearSkillOptionsCacheForHosts([hostId])',
  'Successful deployment should invalidate only the affected Host slash-Skill cache'
);
assertIncludes(
  deploymentEventHandler,
  "loadSkillOptionsForSession(selected, { force: true })",
  'Successful deployment should force app-server Skill refresh for the selected live Host'
);
assertIncludes(app, 'SKILLS_DEPLOYMENT_SUMMARY_LIMIT', 'Client deployment SSE history must be bounded');
const upsertStart = app.indexOf('function boundSkillsDeployments(');
const upsertEnd = app.indexOf('\n}', upsertStart);
assertIncludes(
  app.slice(upsertStart, upsertEnd),
  'activeDeployments',
  'Deployment history trimming must retain non-terminal work'
);
const renderManagerStart = app.indexOf('function renderSkillsManager()');
const renderManagerEnd = app.indexOf('\n}', renderManagerStart);
assertIncludes(
  app.slice(renderManagerStart, renderManagerEnd),
  'if (!manager.open)',
  'Closed Skills Manager must skip hidden DOM reconstruction'
);

const refreshStart = app.indexOf('async function performRefresh(');
const refreshEnd = app.indexOf('\nfunction ', refreshStart + 1);
assertIncludes(
  app.slice(refreshStart, refreshEnd),
  'openSkillsInventoryEvents();',
  'Skills SSE should start for the authenticated app, not only while the manager is open'
);
const closeManagerStart = app.indexOf('function closeSkillsManager()');
const closeManagerEnd = app.indexOf('\n}', closeManagerStart);
assert(
  !app.slice(closeManagerStart, closeManagerEnd).includes('.events.close()'),
  'Closing Skills Manager must keep global Skill events alive for slash cache invalidation'
);
assertIncludes(
  app.slice(closeManagerStart, closeManagerEnd),
  'clearSkillsCleanupSelection();',
  'Closing Skills Manager must discard hidden destructive cleanup selections'
);
const skillsTabHandlerStart = app.indexOf("document.querySelectorAll('[data-skills-tab]').forEach");
const skillsTabHandlerEnd = app.indexOf("document.querySelectorAll('[data-skills-scope]').forEach", skillsTabHandlerStart);
assert(skillsTabHandlerStart >= 0 && skillsTabHandlerEnd > skillsTabHandlerStart, 'Skills tab handler not found');
assertIncludes(
  app.slice(skillsTabHandlerStart, skillsTabHandlerEnd),
  'clearSkillsCleanupSelection();',
  'Switching Skills tabs must discard cleanup selections hidden outside Installed'
);
const reconnectStart = app.indexOf('function scheduleSkillsInventoryEventsReconnect()');
const reconnectEnd = app.indexOf('\n}', reconnectStart);
assert(
  !app.slice(reconnectStart, reconnectEnd).includes('!manager.open'),
  'Skills SSE reconnect must not depend on the manager modal being open'
);
assertIncludes(
  app.slice(reconnectStart, reconnectEnd),
  'authAllowsRequests()',
  'Skills SSE must not reconnect while Relay auth is locked'
);
const requireLoginStart = app.indexOf('function requireRelayLogin(');
const requireLoginEnd = app.indexOf('\n}', requireLoginStart);
assertIncludes(
  app.slice(requireLoginStart, requireLoginEnd),
  'closeSkillsInventoryEvents();',
  'A 401 must close the global Skills SSE connection'
);
const cellStatusStart = app.indexOf('function skillsDeploymentCellStatus(');
const cellStatusEnd = app.indexOf('\n}', cellStatusStart);
const cellStatusSource = app.slice(cellStatusStart, cellStatusEnd);
assertIncludes(
  cellStatusSource,
  "deployment.action === 'enable'",
  'A completed Enable must defer to fresh authoritative inventory state'
);
assertIncludes(
  cellStatusSource,
  'return fallback;',
  'Terminal deployment state must not permanently override later inventory drift or deletion'
);

function extractFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert(start >= 0, `function ${name} not found`);
  const next = app.indexOf('\nfunction ', start + 1);
  return app.slice(start, next >= 0 ? next : app.length);
}

const registryRevisionContext = {
  state: { skillsManager: { registryRevision: 7 } },
};
vm.createContext(registryRevisionContext);
vm.runInContext([
  extractFunction('skillsRegistryResponseRevision'),
  extractFunction('skillsRegistryPayloadCanApply'),
].join('\n'), registryRevisionContext);
assert.strictEqual(registryRevisionContext.skillsRegistryResponseRevision({ registryRevision: 8 }), 8);
assert.strictEqual(registryRevisionContext.skillsRegistryResponseRevision({ registry: { revision: 9 } }), 9);
assert.strictEqual(registryRevisionContext.skillsRegistryResponseRevision({}), null);
assert.strictEqual(
  registryRevisionContext.skillsRegistryPayloadCanApply({ registryRevision: 6 }),
  false,
  'an older Registry payload must not overwrite a newer lifecycle mutation'
);
assert.strictEqual(
  registryRevisionContext.skillsRegistryPayloadCanApply({ registryRevision: 7 }),
  true,
  'an equal Registry revision is safe to apply'
);
assert.strictEqual(
  registryRevisionContext.skillsRegistryPayloadCanApply({}),
  true,
  'legacy Relay payloads without a Registry revision remain compatible'
);

const lifecycleArtifactId = `sha256:${'e'.repeat(64)}`;
const lifecycleContext = {
  state: {
    skillsManager: {
      skillLibrary: [{
        skillId: 'lifecycle-fixture',
        latestArtifactId: lifecycleArtifactId,
        archived: false,
        versions: [{ artifactId: lifecycleArtifactId }],
      }],
      artifacts: [{
        artifactId: lifecycleArtifactId,
        skillIds: ['lifecycle-fixture'],
        trustState: 'validated',
        storageState: 'available',
      }],
    },
  },
};
vm.createContext(lifecycleContext);
vm.runInContext([
  extractFunction('libraryRecordArtifactIds'),
  extractFunction('libraryRecordArtifactStorageState'),
  extractFunction('latestRegistryArtifactForSkill'),
].join('\n'), lifecycleContext);
assert.strictEqual(
  lifecycleContext.libraryRecordArtifactIds(null).size,
  0,
  'a missing Library record must yield no Artifact links instead of breaking manager rendering'
);
assert.strictEqual(
  lifecycleContext.latestRegistryArtifactForSkill('lifecycle-fixture').artifactId,
  lifecycleArtifactId,
  'an active available Registry version should remain selectable for Enable'
);
lifecycleContext.state.skillsManager.skillLibrary[0].archived = true;
assert.strictEqual(
  lifecycleContext.latestRegistryArtifactForSkill('lifecycle-fixture'),
  null,
  'a retired Library Skill must not be selectable for Enable'
);
lifecycleContext.state.skillsManager.skillLibrary[0].archived = false;
lifecycleContext.state.skillsManager.artifacts[0].storageState = 'gc-pending';
assert.strictEqual(
  lifecycleContext.latestRegistryArtifactForSkill('lifecycle-fixture'),
  null,
  'a gc-pending Artifact must not be selectable for Enable'
);
lifecycleContext.state.skillsManager.artifacts[0].storageState = 'collected';
assert.strictEqual(
  lifecycleContext.latestRegistryArtifactForSkill('lifecycle-fixture'),
  null,
  'a collected Artifact must not be selectable for Enable'
);
vm.runInContext(extractFunction('libraryRecordHasAvailableArtifact'), lifecycleContext);
lifecycleContext.state.skillsManager.artifacts[0].storageState = 'available';
assert.strictEqual(
  lifecycleContext.libraryRecordHasAvailableArtifact(
    lifecycleContext.state.skillsManager.skillLibrary[0]
  ),
  true,
  'a retained available Library version should be restorable'
);
lifecycleContext.state.skillsManager.artifacts[0].storageState = 'collected';
assert.strictEqual(
  lifecycleContext.libraryRecordHasAvailableArtifact(
    lifecycleContext.state.skillsManager.skillLibrary[0]
  ),
  false,
  'a retired Library record with only collected Artifacts should not expose Restore'
);

const lifecycleStorageContext = {
  state: {
    skillsManager: {
      artifacts: [{ artifactId: lifecycleArtifactId, storageState: 'gc-pending' }],
    },
  },
};
vm.createContext(lifecycleStorageContext);
vm.runInContext([
  extractFunction('libraryRecordArtifactIds'),
  extractFunction('libraryRecordArtifactStorageState'),
].join('\n'), lifecycleStorageContext);
assert.strictEqual(
  lifecycleStorageContext.libraryRecordArtifactStorageState({
    versions: [{ artifactId: lifecycleArtifactId }],
  }),
  'gc-pending',
  'a pending unlink must not be displayed as collected'
);
const unrelatedPendingArtifactId = `sha256:${'9'.repeat(64)}`;
lifecycleStorageContext.state.skillsManager.artifacts = [{
  artifactId: lifecycleArtifactId,
  skillId: 'lifecycle-fixture',
  skillIds: ['lifecycle-fixture'],
  sources: [{ sourceId: 'github:lifecycle-fixture' }],
  storageState: 'gc-pending',
}, {
  artifactId: unrelatedPendingArtifactId,
  skillId: 'unrelated-fixture',
  skillIds: ['unrelated-fixture'],
  sources: [{ sourceId: 'github:unrelated-fixture' }],
  storageState: 'gc-pending',
}];
const prunedRetiredLibraryRecord = {
  skillId: 'lifecycle-fixture',
  archived: true,
  artifactIds: [],
  versions: [],
};
assert.strictEqual(
  lifecycleStorageContext.libraryRecordArtifactStorageState(prunedRetiredLibraryRecord),
  'gc-pending',
  'a pruned retired version must recover gc-pending state from its Artifact tombstone association'
);
lifecycleStorageContext.state.skillsManager.artifacts[0].storageState = 'collected';
assert.strictEqual(
  lifecycleStorageContext.libraryRecordArtifactStorageState(prunedRetiredLibraryRecord),
  'collected',
  'a collected tombstone must not inherit pending state from an unrelated Artifact'
);
const retainedAvailableArtifactId = `sha256:${'8'.repeat(64)}`;
lifecycleStorageContext.state.skillsManager.artifacts = [{
  artifactId: retainedAvailableArtifactId,
  skillId: 'lifecycle-fixture',
  skillIds: ['lifecycle-fixture'],
  storageState: 'available',
}, {
  artifactId: lifecycleArtifactId,
  skillId: 'lifecycle-fixture',
  skillIds: ['lifecycle-fixture'],
  storageState: 'gc-pending',
}];
const partiallyPrunedRetiredRecord = {
  skillId: 'lifecycle-fixture',
  archived: true,
  artifactIds: [retainedAvailableArtifactId],
  versions: [{ artifactId: retainedAvailableArtifactId }],
};
assert.strictEqual(
  lifecycleStorageContext.libraryRecordArtifactStorageState(partiallyPrunedRetiredRecord),
  'gc-pending',
  'a failed pending unlink must remain visible when another retired version is still available'
);
vm.runInContext(extractFunction('libraryRecordHasAvailableArtifact'), lifecycleStorageContext);
assert.strictEqual(
  lifecycleStorageContext.libraryRecordHasAvailableArtifact(partiallyPrunedRetiredRecord),
  true,
  'a pending older version must not hide Restore when a linked version remains available'
);

const collectionMessageContext = {};
vm.createContext(collectionMessageContext);
vm.runInContext([
  extractFunction('skillsLibraryEventSummary'),
  extractFunction('skillArtifactCollectionMessage'),
].join('\n'), collectionMessageContext);
const partialGcResult = {
  ok: false,
  collectedArtifactIds: [],
  pendingArtifactIds: [lifecycleArtifactId],
  errors: [{ artifactId: lifecycleArtifactId, error: 'unlink failed' }],
};
assert.match(
  collectionMessageContext.skillArtifactCollectionMessage(partialGcResult),
  /incomplete.*1 pending.*1 error/i,
  'HTTP 200 partial GC failure must remain visible and retryable'
);
const garbageCollectedEvent = {
  state: 'garbage-collected',
  collectedArtifactIds: [],
  pendingArtifactIds: [lifecycleArtifactId],
};
let gcEventBeforePostSummary = 'Collecting unused Artifacts...';
gcEventBeforePostSummary = collectionMessageContext.skillsLibraryEventSummary(
  garbageCollectedEvent,
  gcEventBeforePostSummary
);
gcEventBeforePostSummary = collectionMessageContext.skillArtifactCollectionMessage(partialGcResult);
assert.match(
  gcEventBeforePostSummary,
  /incomplete.*1 pending.*1 error/i,
  'a garbage-collected SSE arriving before POST must not prevent the partial response summary'
);
let gcEventAfterPostSummary = collectionMessageContext.skillArtifactCollectionMessage(partialGcResult);
gcEventAfterPostSummary = collectionMessageContext.skillsLibraryEventSummary(
  garbageCollectedEvent,
  gcEventAfterPostSummary
);
assert.match(
  gcEventAfterPostSummary,
  /incomplete.*1 pending.*1 error/i,
  'a garbage-collected SSE arriving after POST must not erase the partial response summary'
);

const cleanupArtifactId = `sha256:${'f'.repeat(64)}`;
const cleanupContext = {
  state: {
    skillsManager: {
      selectedSkillIds: new Set(['active-fixture']),
      selectedCleanupKeys: new Set(),
      selectedHostIds: new Set(['host-a', 'host-c']),
      deploymentScope: 'user',
      projectCwd: '',
      skillLibrary: [{
        skillId: 'active-fixture',
        latestArtifactId: lifecycleArtifactId,
        archived: false,
        versions: [{ artifactId: lifecycleArtifactId }],
      }, {
        skillId: 'retired-fixture',
        latestArtifactId: cleanupArtifactId,
        archived: true,
        versions: [{ artifactId: cleanupArtifactId }],
      }],
      artifacts: [{
        artifactId: lifecycleArtifactId,
        skillIds: ['active-fixture'],
        trustState: 'validated',
        storageState: 'available',
      }, {
        artifactId: cleanupArtifactId,
        skillIds: ['retired-fixture'],
        trustState: 'validated',
        storageState: 'available',
      }],
      desiredSkillStates: [{
        hostId: 'host-a',
        skillId: 'retired-fixture',
        artifactId: cleanupArtifactId,
        scope: 'user',
        scopeId: 'user',
        desiredState: 'disabled',
      }],
      appliedSkillStates: [{
        hostId: 'host-b',
        skillId: 'retired-fixture',
        artifactId: cleanupArtifactId,
        scope: 'user',
        scopeId: 'user',
        appliedState: 'enabled',
      }, {
        hostId: 'host-c',
        skillId: 'retired-fixture',
        artifactId: cleanupArtifactId,
        scope: 'user',
        scopeId: 'user',
        appliedState: 'missing',
      }],
    },
  },
};
vm.createContext(cleanupContext);
vm.runInContext([
  extractFunction('libraryRecordArtifactIds'),
  extractFunction('latestRegistryArtifactForSkill'),
  extractFunction('skillsDesiredRowKey'),
  extractFunction('skillsManagedReferenceRows'),
  extractFunction('skillsCleanupRowCanDeploy'),
  extractFunction('skillsDeploymentSnapshotsForAction'),
].join('\n'), cleanupContext);
const cleanupRows = cleanupContext.skillsManagedReferenceRows();
assert.strictEqual(cleanupRows.size, 1, 'missing applied state must not retain a cleanup row');
const cleanupRow = Array.from(cleanupRows.values())[0];
assert.deepStrictEqual(
  Array.from(cleanupRow.referenceHostIds).sort(),
  ['host-a', 'host-b'],
  'cleanup rows should merge exact desired and applied Host references'
);
cleanupContext.state.skillsManager.selectedCleanupKeys.add(cleanupRow.key);
assert.deepStrictEqual(
  Array.from(
    cleanupContext.skillsDeploymentSnapshotsForAction('enable', ['host-a', 'host-c']),
    (entry) => entry.skillId
  ),
  ['active-fixture'],
  'Enable must ignore retired cleanup selections'
);
const disableSnapshots = cleanupContext.skillsDeploymentSnapshotsForAction('disable', ['host-a', 'host-c']);
assert.strictEqual(disableSnapshots.length, 2, 'Disable should include active and referenced retired targets');
const retiredCleanup = disableSnapshots.find((entry) => entry.skillId === 'retired-fixture');
assert.deepStrictEqual(
  Array.from(retiredCleanup.targetHostIds),
  ['host-a'],
  'retired cleanup must target only selected Hosts with an exact retained reference'
);
cleanupContext.state.skillsManager.skillLibrary[1].archived = false;
assert.strictEqual(
  cleanupContext.skillsCleanupRowCanDeploy(cleanupRow),
  false,
  'restoring an Artifact as the active latest version must make its hidden cleanup row ineligible'
);
assert.deepStrictEqual(
  Array.from(
    cleanupContext.skillsDeploymentSnapshotsForAction('remove', ['host-a']),
    (entry) => entry.skillId
  ),
  ['active-fixture'],
  'action snapshot generation must reject a stale cleanup key after Library Restore'
);
const reconciledCleanupSelection = new Set(
  Array.from(cleanupContext.state.skillsManager.selectedCleanupKeys)
    .filter((key) => cleanupContext.skillsCleanupRowCanDeploy(cleanupRows.get(key)))
);
assert.strictEqual(
  reconciledCleanupSelection.size,
  0,
  'the reload reconciliation must clear cleanup keys whose rows became active latest'
);

const missingDesiredReference = {
  deploymentId: 'remove-fixture',
  hostId: 'host-a',
  skillId: 'retired-fixture',
  artifactId: cleanupArtifactId,
  scope: 'user',
  scopeId: 'user',
  desiredState: 'missing',
};
const missingDesiredContext = {
  state: {
    skillsManager: {
      skillLibrary: [{
        skillId: 'retired-fixture',
        latestArtifactId: cleanupArtifactId,
        archived: true,
        artifactIds: [cleanupArtifactId],
        versions: [{ artifactId: cleanupArtifactId }],
      }],
      artifacts: [{
        artifactId: cleanupArtifactId,
        skillIds: ['retired-fixture'],
        trustState: 'validated',
        storageState: 'available',
      }],
      desiredSkillStates: [missingDesiredReference],
      appliedSkillStates: [],
      deployments: [{
        deploymentId: 'remove-fixture',
        skillId: 'retired-fixture',
        artifactId: cleanupArtifactId,
        action: 'remove',
        desiredState: 'missing',
        targetScope: 'user',
        scopeId: 'user',
        targetHostIds: ['host-a'],
        results: [{ hostId: 'host-a', state: 'pending' }],
      }],
    },
  },
};
vm.createContext(missingDesiredContext);
vm.runInContext([
  extractFunction('libraryRecordArtifactIds'),
  extractFunction('skillsDesiredRowKey'),
  extractFunction('skillsManagedReferenceRows'),
].join('\n'), missingDesiredContext);
for (const removeState of ['pending', 'queued', 'running', 'failed']) {
  missingDesiredContext.state.skillsManager.deployments[0].results[0].state = removeState;
  const rows = missingDesiredContext.skillsManagedReferenceRows();
  assert.strictEqual(
    rows.size,
    1,
    `${removeState} Remove must retain the exact desired missing reference for cleanup retry`
  );
  assert(rows.values().next().value.referenceHostIds.has('host-a'));
}
missingDesiredContext.state.skillsManager.deployments[0].results[0].state = 'succeeded';
assert.strictEqual(
  missingDesiredContext.skillsManagedReferenceRows().size,
  0,
  'a successful exact Remove may release its desired missing reference'
);
missingDesiredContext.state.skillsManager.deployments[0].results[0].state = 'failed';
missingDesiredContext.state.skillsManager.deployments[0].artifactId = lifecycleArtifactId;
assert.strictEqual(
  missingDesiredContext.skillsManagedReferenceRows().size,
  1,
  'success or failure from a different Artifact must not settle the exact desired reference'
);
missingDesiredContext.state.skillsManager.deployments[0].artifactId = cleanupArtifactId;
missingDesiredContext.state.skillsManager.appliedSkillStates = [{
  hostId: 'host-a',
  skillId: 'retired-fixture',
  artifactId: null,
  scope: 'user',
  scopeId: 'user',
  appliedState: 'missing',
}];
assert.strictEqual(
  missingDesiredContext.skillsManagedReferenceRows().size,
  0,
  'an exact applied missing state proves cleanup complete even if Remove reported failure'
);
missingDesiredContext.state.skillsManager.appliedSkillStates[0].uncertainArtifactIds = [cleanupArtifactId];
assert.strictEqual(
  missingDesiredContext.skillsManagedReferenceRows().size,
  1,
  'exact applied uncertainty must remain available as a cleanup retry row'
);
missingDesiredContext.state.skillsManager.appliedSkillStates[0].uncertainArtifactIds = [];
missingDesiredContext.state.skillsManager.appliedSkillStates[0].skillWideUncertain = true;
assert.strictEqual(
  missingDesiredContext.skillsManagedReferenceRows().size,
  1,
  'Skill-wide cleanup uncertainty must expand available Library Artifacts into retry rows'
);
missingDesiredContext.state.skillsManager.appliedSkillStates[0].skillWideUncertain = false;
missingDesiredContext.state.skillsManager.appliedSkillStates[0].appliedState = 'unknown';
assert.strictEqual(
  missingDesiredContext.skillsManagedReferenceRows().size,
  1,
  'an unknown applied projection must expose every available Library Artifact for cleanup'
);
missingDesiredContext.state.skillsManager.appliedSkillStates[0].appliedState = 'missing';
missingDesiredContext.state.skillsManager.appliedSkillStates[0].scope = 'project';
missingDesiredContext.state.skillsManager.appliedSkillStates[0].scopeId = '/different-scope';
assert.strictEqual(
  missingDesiredContext.skillsManagedReferenceRows().size,
  1,
  'applied missing from another exact scope must not release the desired reference'
);

const allHostProjectPrompts = [];
const allHostProjectSessions = {
  'host-a': [{ cwd: 'C:/shared-project' }, { cwd: 'C:/host-a-only' }],
  'host-b': [{ cwd: 'C:/shared-project' }],
};
const allHostProjectContext = {
  state: {
    skillsManager: {
      deploymentScope: 'project',
      projectCwd: 'C:/shared-project',
      confirmProjectWrite: true,
      projectWriteConfirmationKey: '',
    },
  },
  getSessionsForHost(hostId) {
    return allHostProjectSessions[hostId] || [];
  },
  window: {
    confirm(message) {
      allHostProjectPrompts.push(message);
      return true;
    },
  },
};
vm.createContext(allHostProjectContext);
vm.runInContext([
  extractFunction('skillsProjectWorkspaceOptions'),
  extractFunction('skillsProjectConfirmationKey'),
  extractFunction('skillsDeploymentWorkspaceReady'),
  extractFunction('skillsDeploymentScopeReady'),
  extractFunction('confirmSkillsAllHostsProjectWrite'),
].join('\n'), allHostProjectContext);
const selectedHostConfirmationKey = allHostProjectContext.skillsProjectConfirmationKey(
  ['host-a'],
  'C:/shared-project'
);
allHostProjectContext.state.skillsManager.projectWriteConfirmationKey = selectedHostConfirmationKey;
const allHostAuthorization = allHostProjectContext.confirmSkillsAllHostsProjectWrite([
  'host-a',
  'host-b',
]);
const expectedAllHostConfirmationKey = allHostProjectContext.skillsProjectConfirmationKey(
  ['host-a', 'host-b'],
  'C:/shared-project'
);
assert.strictEqual(allHostAuthorization.confirmProjectWrite, true);
assert.strictEqual(allHostAuthorization.confirmationKey, expectedAllHostConfirmationKey);
assert.notStrictEqual(allHostAuthorization.confirmationKey, selectedHostConfirmationKey);
assert.strictEqual(
  allHostProjectContext.state.skillsManager.projectWriteConfirmationKey,
  selectedHostConfirmationKey,
  'all-host confirmation must not overwrite or reuse selected-host consent'
);
assert.strictEqual(allHostProjectPrompts.length, 1);
assert.match(allHostProjectPrompts[0], /C:\/shared-project/);
assert.match(allHostProjectPrompts[0], /2 Hosts/i);
assert.strictEqual(
  allHostProjectContext.skillsDeploymentScopeReady(
    ['host-a', 'host-b'],
    allHostAuthorization
  ),
  true,
  'the independently confirmed all-host intersection should be deployable'
);
assert.strictEqual(
  allHostProjectContext.skillsDeploymentScopeReady(['host-a', 'host-b']),
  false,
  'selected-host confirmation must not authorize the all-host target set'
);
allHostProjectContext.state.skillsManager.projectCwd = 'C:/host-a-only';
assert.strictEqual(
  allHostProjectContext.skillsDeploymentWorkspaceReady(['host-a', 'host-b']),
  false,
  'all-host Project Enable must require a cwd in the exact all-host intersection'
);
assert.strictEqual(
  allHostProjectContext.confirmSkillsAllHostsProjectWrite(['host-a', 'host-b']),
  null,
  'an invalid all-host cwd must not produce project write authorization'
);
assert.strictEqual(allHostProjectPrompts.length, 1, 'invalid all-host cwd must not prompt');

const refreshBusyContext = {
  state: {
    skillsManager: {
      imports: [{
        importId: 'refresh-job',
        refreshSourceId: 'github:owner/repo:main:skills/demo',
        state: 'validating',
      }],
    },
  },
};
vm.createContext(refreshBusyContext);
vm.runInContext(extractFunction('activeSkillSourceRefresh'), refreshBusyContext);
assert.strictEqual(
  refreshBusyContext.activeSkillSourceRefresh('github:owner/repo:main:skills/demo').importId,
  'refresh-job',
  'Source Refresh must stay busy until its background import reaches a terminal state'
);

const artifactContext = {};
vm.createContext(artifactContext);
vm.runInContext([
  extractFunction('instanceMatchesRegistryArtifact'),
  extractFunction('skillsDesiredRowKey'),
  extractFunction('desiredSkillsRowKeyForInstance'),
].join('\n'), artifactContext);
assert.strictEqual(artifactContext.instanceMatchesRegistryArtifact({
  managed: true,
  desiredArtifactId: `sha256:${'a'.repeat(64)}`,
  observedHash: `sha256:${'b'.repeat(64)}`,
}, `sha256:${'a'.repeat(64)}`), true);
assert.strictEqual(artifactContext.instanceMatchesRegistryArtifact({
  managed: true,
  desiredArtifactId: `sha256:${'b'.repeat(64)}`,
}, `sha256:${'a'.repeat(64)}`), false);
const oldArtifactId = `sha256:${'b'.repeat(64)}`;
const oldDesired = {
  hostId: 'host-a',
  skillId: 'fixture',
  artifactId: oldArtifactId,
  scope: 'user',
  scopeId: 'user',
  updatedAt: '2026-07-13T00:00:00.000Z',
};
assert.strictEqual(
  artifactContext.desiredSkillsRowKeyForInstance({
    hostId: 'host-a',
    skillId: 'fixture',
    managed: true,
    desiredArtifactId: oldArtifactId,
    scope: 'user',
    scopeId: 'user',
  }, [oldDesired]),
  artifactContext.skillsDesiredRowKey(oldDesired),
  'an instance for an older desired Artifact must route to its desired row'
);

const instanceMergeContext = {};
vm.createContext(instanceMergeContext);
vm.runInContext([
  extractFunction('skillsInventoryInstanceRowKey'),
  extractFunction('skillsInventorySourceSummary'),
  extractFunction('preferredSkillInstance'),
].join('\n'), instanceMergeContext);
const identicalHash = `sha256:${'c'.repeat(64)}`;
const localPdf = {
  instanceId: 'local-pdf',
  skillId: 'pdf',
  observedHash: identicalHash,
  sourceKind: 'local-host',
  sourceLocator: 'C:/Users/test/.codex/skills/pdf',
  scope: 'user',
  scopeId: 'user',
  readonly: false,
  enabled: true,
  state: 'enabled',
};
const ccSwitchPdf = {
  instanceId: 'cc-switch-pdf',
  skillId: 'pdf',
  observedHash: identicalHash,
  sourceKind: 'cc-switch',
  sourceLocator: 'C:/Users/test/.cc-switch/skills/pdf',
  scope: 'cc-switch',
  scopeId: 'cc-switch',
  readonly: false,
  enabled: true,
  state: 'enabled',
};
assert.strictEqual(
  instanceMergeContext.skillsInventoryInstanceRowKey(localPdf),
  instanceMergeContext.skillsInventoryInstanceRowKey(ccSwitchPdf),
  'byte-identical Local and CC Switch activations must share one logical row'
);
assert.notStrictEqual(
  instanceMergeContext.skillsInventoryInstanceRowKey(localPdf),
  instanceMergeContext.skillsInventoryInstanceRowKey({
    ...ccSwitchPdf,
    observedHash: `sha256:${'d'.repeat(64)}`,
  }),
  'different content hashes must remain separate rows'
);
assert.notStrictEqual(
  instanceMergeContext.skillsInventoryInstanceRowKey({ ...localPdf, observedHash: '' }),
  instanceMergeContext.skillsInventoryInstanceRowKey({ ...ccSwitchPdf, observedHash: '' }),
  'hashless instances must retain their physical source identity'
);
const duplicateSourceSummary = instanceMergeContext.skillsInventorySourceSummary([
  ccSwitchPdf,
  localPdf,
]);
assert.strictEqual(duplicateSourceSummary.label, 'Local + CC Switch');
assert.strictEqual(duplicateSourceSummary.scopeLabel, 'user + cc-switch');
assert(duplicateSourceSummary.title.includes('.codex/skills/pdf'));
assert(duplicateSourceSummary.title.includes('.cc-switch/skills/pdf'));
assert.strictEqual(
  instanceMergeContext.preferredSkillInstance([
    { ...ccSwitchPdf, readonly: true },
    localPdf,
  ]).instanceId,
  'local-pdf',
  'a writable enabled activation must represent a duplicate row before a readonly copy'
);
assert.strictEqual(
  instanceMergeContext.preferredSkillInstance([
    ccSwitchPdf,
    localPdf,
  ]).instanceId,
  'local-pdf',
  'otherwise-equal duplicates must prefer the directly active user scope'
);
assert.strictEqual(
  instanceMergeContext.preferredSkillInstance([
    localPdf,
    { ...ccSwitchPdf, effective: true },
  ]).instanceId,
  'cc-switch-pdf',
  'an explicitly effective activation must remain authoritative'
);
assert.strictEqual(
  instanceMergeContext.preferredSkillInstance([
    { ...localPdf, enabled: undefined, state: 'disabled' },
    ccSwitchPdf,
  ]).instanceId,
  'cc-switch-pdf',
  'an explicit disabled state must not be treated as enabled when the boolean is absent'
);

const deploymentContext = {
  state: {
    skillsManager: {
      deployments: [{
        deploymentId: 'old-artifact-deployment',
        skillId: 'fixture',
        artifactId: `sha256:${'b'.repeat(64)}`,
        action: 'enable',
        targetHostIds: ['host-a'],
        createdAt: '2026-07-13T00:00:00.000Z',
        results: [{ hostId: 'host-a', state: 'failed', error: 'old Artifact failure' }],
      }],
    },
  },
};
vm.createContext(deploymentContext);
vm.runInContext([
  extractFunction('latestSkillDeploymentForHost'),
  extractFunction('skillsDeploymentCellStatus'),
].join('\n'), deploymentContext);
const fallbackStatus = { label: 'Missing', className: 'missing', error: '' };
assert.strictEqual(
  deploymentContext.skillsDeploymentCellStatus(
    'fixture',
    { hostId: 'host-a', online: true },
    fallbackStatus,
    `sha256:${'a'.repeat(64)}`
  ).className,
  'missing',
  'an old Artifact deployment must not override the latest Artifact row'
);

const historyContext = { SKILLS_DEPLOYMENT_SUMMARY_LIMIT: 100 };
vm.createContext(historyContext);
vm.runInContext([
  extractFunction('skillsDeploymentNewestFirst'),
  extractFunction('boundSkillsDeployments'),
  extractFunction('mergeSkillsDeploymentRecord'),
  extractFunction('mergeSkillsDeploymentLists'),
].join('\n'), historyContext);
const pendingDeployment = {
  deploymentId: 'pending-old',
  createdAt: '2026-01-01T00:00:00.000Z',
  results: [{ hostId: 'host-a', state: 'pending', updatedAt: '2026-01-01T00:00:00.000Z' }],
};
const terminalDeployments = Array.from({ length: 105 }, (_, index) => ({
  deploymentId: `terminal-${index}`,
  createdAt: `2026-07-13T00:${String(index).padStart(2, '0')}:00.000Z`,
  results: [{ hostId: 'host-a', state: 'succeeded', updatedAt: `2026-07-13T00:${String(index).padStart(2, '0')}:00.000Z` }],
}));
const boundedHistory = historyContext.boundSkillsDeployments([pendingDeployment, ...terminalDeployments]);
assert.strictEqual(boundedHistory.length, 100);
assert(boundedHistory.some((deployment) => deployment.deploymentId === 'pending-old'));
const desiredDeploymentStates = terminalDeployments.map((deployment) => ({
  deploymentId: deployment.deploymentId,
}));
const desiredProtectedHistory = historyContext.boundSkillsDeployments(
  [pendingDeployment, ...terminalDeployments],
  desiredDeploymentStates
);
assert.strictEqual(desiredProtectedHistory.length, 106);
assert(terminalDeployments.every((deployment) => (
  desiredProtectedHistory.some((candidate) => candidate.deploymentId === deployment.deploymentId)
)), 'history trimming must retain every deployment referenced by current desired state');
const mergedRace = historyContext.mergeSkillsDeploymentLists([{
  deploymentId: 'race',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:01.000Z',
  results: [{ hostId: 'host-a', state: 'queued', updatedAt: '2026-07-13T00:00:01.000Z' }],
}], [{
  deploymentId: 'race',
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:02.000Z',
  results: [{ hostId: 'host-a', state: 'failed', updatedAt: '2026-07-13T00:00:02.000Z' }],
}]);
assert.strictEqual(mergedRace[0].results[0].state, 'failed');

const scopedDeploymentContext = {
  state: {
    skillsManager: {
      deployments: [{
        deploymentId: 'user-deployment',
        skillId: 'fixture',
        artifactId: oldArtifactId,
        targetScope: 'user',
        scopeId: 'user',
        targetHostIds: ['host-a'],
        createdAt: '2026-07-13T00:00:00.000Z',
      }, {
        deploymentId: 'project-deployment',
        skillId: 'fixture',
        artifactId: oldArtifactId,
        targetScope: 'project',
        scopeId: '/workspace',
        targetHostIds: ['host-a'],
        createdAt: '2026-07-13T00:00:01.000Z',
      }],
    },
  },
};
vm.createContext(scopedDeploymentContext);
vm.runInContext(extractFunction('latestSkillDeploymentForHost'), scopedDeploymentContext);
assert.strictEqual(
  scopedDeploymentContext.latestSkillDeploymentForHost(
    'fixture',
    'host-a',
    oldArtifactId,
    'user',
    'user'
  ).deploymentId,
  'user-deployment',
  'desired rows must not borrow deployment state from another scope'
);

const localMutationContext = {
  SKILLS_DEPLOYMENT_SUMMARY_LIMIT: 100,
  state: {
    skillsManager: {
      deployments: [],
      desiredSkillStates: [],
      deploymentVersion: 3,
      desiredVersion: 5,
    },
  },
};
vm.createContext(localMutationContext);
vm.runInContext([
  extractFunction('skillsDeploymentNewestFirst'),
  extractFunction('skillsDesiredStateKey'),
  extractFunction('skillsDesiredStatesFromDeployment'),
  extractFunction('mergeSkillsDesiredStateLists'),
  extractFunction('boundSkillsDeployments'),
  extractFunction('mergeSkillsDeploymentRecord'),
  extractFunction('upsertSkillsDeployment'),
].join('\n'), localMutationContext);
localMutationContext.upsertSkillsDeployment({
  deploymentId: 'local-post',
  skillId: 'fixture',
  artifactId: oldArtifactId,
  action: 'disable',
  desiredState: 'disabled',
  targetHostIds: ['host-a'],
  targetScope: 'user',
  scopeId: 'user',
  cwd: null,
  createdAt: '2026-07-13T00:00:02.000Z',
  updatedAt: '2026-07-13T00:00:02.000Z',
  results: [{ hostId: 'host-a', state: 'queued' }],
});
assert.strictEqual(localMutationContext.state.skillsManager.deploymentVersion, 4);
assert.strictEqual(localMutationContext.state.skillsManager.desiredVersion, 6);
assert.strictEqual(localMutationContext.state.skillsManager.desiredSkillStates[0].deploymentId, 'local-post');

console.log('skills manager UI contract ok');
