const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'apps/relay/server.js'), 'utf8');

function mustContain(needle, message) {
  assert(server.includes(needle), `${message}\nMissing: ${needle}`);
}

mustContain('SKILL_FAVORITES_PATH', 'relay should persist favorite skills');
mustContain('loadSkillFavorites', 'relay should load skill favorites');
mustContain('saveSkillFavorites', 'relay should save skill favorites');
mustContain('pendingHostSkillRequests', 'relay should track host skills requests');
mustContain('awaitHostSkillRequest', 'relay should await host skills responses');
mustContain("url.pathname === '/api/skills'", 'relay should expose GET /api/skills');
mustContain("url.pathname === '/api/skills/favorites'", 'relay should expose favorites endpoint');
mustContain("url.pathname === '/api/skills/actions'", 'relay should expose batch actions endpoint');
mustContain('Legacy Skill actions are disabled for Phase 3 deployment Hosts', 'legacy actions must not bypass Phase 3 ownership');
mustContain("type: 'host.skills.list'", 'relay should request host skill scans');
mustContain("type: 'host.skills.install'", 'relay should request host skill installs');
mustContain("type: 'host.skills.uninstall'", 'relay should request host skill uninstalls');
mustContain("event.type === 'host.skills.result'", 'relay should handle host skills result events');
mustContain('SKILL_INVENTORIES_PATH', 'relay should persist host skill inventories');
mustContain("url.pathname === '/api/skills/refresh'", 'relay should expose async skill refresh');
mustContain("url.pathname === '/api/skills/events'", 'relay should expose Skills SSE');
mustContain("event.type === 'host.skills.inventory'", 'relay should consume host inventory events');
mustContain('skills.inventory.updated', 'relay should broadcast inventory revisions');
mustContain('SKILL_REGISTRY_PATH', 'relay should persist the content-addressed Skill registry');
mustContain("url.pathname === '/api/skills/adopt'", 'relay should expose inventory-bound adoption');
mustContain("url.pathname === '/api/skills/import'", 'relay should expose source import');
mustContain('host.skills.artifact.export', 'relay should queue complete-directory Host export');
mustContain('skills.library.updated', 'relay should broadcast artifact library changes');
mustContain('includeManifest: false', 'cached Skills payload should not clone full artifact manifests');

const payloadStart = server.indexOf('async function buildSkillsManagerPayload()');
const payloadEnd = server.indexOf('\nfunction hasPendingSkillRefresh', payloadStart);
assert(payloadStart >= 0 && payloadEnd > payloadStart, 'could not isolate buildSkillsManagerPayload source');
assert(
  !server.slice(payloadStart, payloadEnd).includes('requestHostSkillsList('),
  'GET /api/skills payload must not wait for host skill requests'
);

const inventorySaveStart = server.indexOf('function saveSkillInventories(');
const inventorySaveEnd = server.indexOf('\nfunction ensureTrashCollection', inventorySaveStart);
const inventorySaveSource = server.slice(inventorySaveStart, inventorySaveEnd);
assert(inventorySaveSource.includes('fs.fsyncSync(fd)'), 'inventory snapshots must fsync before rename');

const inventoryApplyStart = server.indexOf('function applyHostSkillInventoryEvent(');
const inventoryApplyEnd = server.indexOf('\nfunction skillApiError', inventoryApplyStart);
const inventoryApplySource = server.slice(inventoryApplyStart, inventoryApplyEnd);
assert(
  inventoryApplySource.indexOf('saveSkillInventories(nextInventories)')
    < inventoryApplySource.indexOf('state.skillInventories = nextInventories'),
  'inventory cache must publish in memory only after durable save succeeds'
);

console.log('skills manager API contract ok');
