const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'apps/relay/server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'apps/mobile-web/public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/mobile-web/public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'apps/mobile-web/public/styles.css'), 'utf8');

function mustContain(source, needle, message) {
  assert(source.includes(needle), `${message}\nMissing: ${needle}`);
}

mustContain(server, 'SKILL_SOURCES_PATH', 'relay should persist skill source configuration');
mustContain(server, 'loadSkillSources', 'relay should load skill sources');
mustContain(server, 'saveSkillSources', 'relay should save skill sources');
mustContain(server, 'normalizeSkillSource', 'relay should normalize source definitions');
mustContain(server, 'buildSkillCatalogFromSources', 'relay should build catalog from sources');
mustContain(server, "url.pathname === '/api/skills/sources'", 'relay should expose skill sources API');
mustContain(server, 'dailySkillDigest', 'relay should include a daily skill digest in skills payloads');
mustContain(server, 'skillSourceAutomationMatch', 'relay should expose source automation policy updates');
mustContain(server, "url.pathname === '/api/skills/audit'", 'relay should expose the durable Skills audit');

mustContain(html, 'id="skills-source-list"', 'Skills manager should show configured sources');
mustContain(html, 'id="skills-source-name-input"', 'Skills manager should allow naming a source');
mustContain(html, 'id="skills-source-url-input"', 'Skills manager should allow entering a source URL/path');
mustContain(html, 'id="skills-add-source-button"', 'Skills manager should allow adding a source');
mustContain(html, 'id="skills-daily-digest"', 'Skills manager should show daily recommendations');
mustContain(html, 'id="skills-collect-unused-button"', 'Skills manager should expose explicit unused Artifact collection in Sources');
mustContain(html, 'id="skills-audit-section"', 'Sources should expose a recent audit area');
mustContain(html, 'id="skills-load-audit-button"', 'Sources should provide an explicit audit load action');

mustContain(app, 'renderSkillsSources', 'client should render skill sources');
mustContain(app, 'saveSkillsSources', 'client should save skill sources');
mustContain(app, '/api/skills/sources', 'client should call skill sources API');
mustContain(app, 'dailySkillDigest', 'client should store daily skill digest');
mustContain(app, 'function refreshGithubSkillSource', 'client should refresh persisted GitHub Registry sources');
mustContain(app, '/api/skills/sources/${encodeURIComponent(normalizedSourceId)}/refresh', 'client should call source refresh by source ID');
mustContain(app, 'data-skills-refresh-source-id', 'GitHub Registry source rows should expose Refresh');
mustContain(app, "source.registry && String(source.kind || '').trim().toLowerCase() === 'github'", 'only GitHub Registry sources should expose Refresh');
mustContain(app, 'source.lastError', 'source rows should surface the latest refresh error');
mustContain(app, 'source.revision', 'source rows should retain the current revision when a refresh error exists');
mustContain(app, 'lifecycleBusyKeys', 'source refresh should expose a bounded busy state');
mustContain(app, 'error.body?.revision', 'source refresh failures should advance Registry CAS state');
mustContain(app, 'await loadSkillsManager({ message: manager.actionSummary })', 'source refresh failures should reload authoritative lifecycle state');
mustContain(app, 'data-skills-source-refresh-policy', 'configured sources should render refresh policy controls');
mustContain(app, 'data-skills-source-rollout-policy', 'configured sources should render rollout policy controls');
mustContain(app, 'data-skills-save-source-automation-id', 'automation policy changes should require an explicit save');
mustContain(app, 'function updateSkillSourceAutomation', 'client should own a focused automation policy mutation');
mustContain(app, '/automation`', 'client should call the source automation endpoint');
mustContain(app, 'expectedRevision: manager.registryRevision', 'automation writes should carry Registry CAS revision');
mustContain(app, "fetchJson('/api/skills/audit?limit=50')", 'audit UI should load a bounded recent projection');
mustContain(styles, '.skills-source-actions', 'source action groups should retain stable dimensions');
mustContain(styles, '.skills-source-automation', 'source automation controls should have a stable responsive layout');
mustContain(styles, '.skills-audit-list', 'recent audit events should have a dedicated layout');

console.log('skills manager sources contract ok');
