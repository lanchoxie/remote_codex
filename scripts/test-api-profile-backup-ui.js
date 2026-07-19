const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'apps/mobile-web/public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'apps/mobile-web/public/index.html'), 'utf8');

for (const id of [
  'export-api-profiles-button',
  'import-api-profiles-button',
  'api-profile-backup-file',
  'api-profile-backup-password',
  'api-profile-backup-password-confirm',
  'api-profile-backup-preview',
  'api-profile-backup-conflicts',
  'api-profile-backup-apply-button',
]) {
  assert(html.includes(`id="${id}"`), `missing API profile backup control: ${id}`);
}

assert(
  html.indexOf('/api-profile-backup.js') < html.indexOf('/app.js'),
  'backup crypto module must load before app.js'
);

function functionSource(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`function ${nextName}(`, start + 1);
  assert(start >= 0 && end > start, `unable to find ${name}`);
  return app.slice(start, end);
}

const preview = functionSource('renderApiProfileBackupPreview', 'renderApiProfileBackupConflicts');
assert(!preview.includes('.apiKey'), 'preview rendering must not access or display API key text');
assert(preview.includes('hasCredential'), 'preview should expose only credential presence');

const commit = functionSource('commitImportedApiProfiles', 'populateSettingsForm');
const conflictOptions = functionSource('selectedApiProfileConflictOptions', 'commitImportedApiProfiles');
assert.strictEqual(
  (commit.match(/localStorage\.setItem/g) || []).length,
  1,
  'import commit must use one localStorage write'
);
assert(commit.includes('planSafeMerge('));
assert(conflictOptions.includes('identityConflicts'));
assert(conflictOptions.includes('keyConflicts'));
assert(commit.indexOf('localStorage.setItem') < commit.indexOf('Object.assign(state.ui'),
  'in-memory settings must change only after durable storage succeeds');

console.log('API profile encrypted backup UI assertions passed');
