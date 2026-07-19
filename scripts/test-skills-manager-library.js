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

mustContain(server, 'SKILL_LIBRARY_PATH', 'relay should persist skills even after uninstall');
mustContain(server, 'loadSkillLibrary', 'relay should load saved skill library records');
mustContain(server, 'saveSkillLibrary', 'relay should save skill library records');
mustContain(server, 'normalizeSkillLibraryRecord', 'relay should normalize user-added skill links');
mustContain(server, 'mergeSkillLibraryWithCatalog', 'relay should merge library records into browse catalog');
mustContain(server, "url.pathname === '/api/skills/library'", 'relay should expose skill library API');
mustContain(server, 'sourceUrl', 'skill records should preserve source webpages');
mustContain(server, 'lastInstalledHostIds', 'skill records should remember where they were installed before');

mustContain(html, 'id="skills-github-locator-input"', 'Skills manager should import a real GitHub repository');
mustContain(html, 'id="skills-github-ref-input"', 'Skills manager should select the GitHub ref');
mustContain(html, 'id="skills-github-subpath-input"', 'Skills manager should select a complete Skill directory');
mustContain(html, 'id="skills-import-github-button"', 'Skills manager should queue complete GitHub imports');
mustContain(html, 'id="skills-library-lifecycle-list"', 'Skills manager should show active and retired Library records');
mustContain(html, 'id="skills-collect-unused-button"', 'Skills manager should collect only unused Artifacts explicitly');

mustContain(app, 'skillLibrary', 'client should store skill library records');
mustContain(app, 'importGithubSkill', 'client should import complete Skill content');
mustContain(app, '/api/skills/import', 'client should call the artifact import API');
mustContain(app, 'artifacts', 'client should render persisted artifact-backed library state');
mustContain(app, 'data-skills-retire-library-id', 'client should render Retire for active Registry Library records');
mustContain(app, 'skills-row-actions', 'client should place Retire beside active Registry browse rows');
mustContain(app, 'data-skills-restore-library-id', 'client should render Restore for retired Registry Library records');
mustContain(app, '/api/skills/library/${encodeURIComponent(normalizedSkillId)}/${action}', 'client should call Library lifecycle APIs');
mustContain(app, '/api/skills/artifacts/gc', 'client should call reference-aware Artifact collection');
mustContain(app, "String(artifact?.storageState || 'available')", 'Enable selection should require an available Artifact');
mustContain(app, 'libraryRecord.archived === true', 'Enable selection should reject retired Library records');
mustContain(app, 'libraryRecordHasAvailableArtifact', 'Restore should require at least one retained available Artifact');
mustContain(app, 'expectedRevision: manager.registryRevision', 'lifecycle mutations should carry the exact Registry revision');

mustContain(styles, '.skills-github-import-editor', 'Skills Manager GitHub importer should have responsive styling');
mustContain(styles, '.skills-library-lifecycle-toolbar', 'Skills Manager Library lifecycle toolbar should be responsive');

console.log('skills manager library contract ok');
