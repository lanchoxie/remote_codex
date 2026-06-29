const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const updater = require('../shared/updater');

const REPO_ROOT = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'relay', 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'mobile-web', 'public', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'mobile-web', 'public', 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(REPO_ROOT, 'apps', 'mobile-web', 'public', 'styles.css'), 'utf8');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function makeTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function initRepo() {
  const root = makeTempDir('remote-codex-update-repo');
  run('git', ['init'], root);
  run('git', ['config', 'user.email', 'test@example.com'], root);
  run('git', ['config', 'user.name', 'Update Test'], root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'remote-codex-update-test',
    version: '2.4.3',
  }, null, 2), 'utf8');
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  writeJson(path.join(root, 'tmp', 'session-collections.json'), { collections: [{ collectionId: 'work' }] });
  writeJson(path.join(root, 'tmp', 'connectors.json'), { connectors: [{ connectorId: 'hpc' }] });
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'v2.4.3'], root);
  run('git', ['tag', 'v2.4.3'], root);

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'remote-codex-update-test',
    version: '2.4.4',
  }, null, 2), 'utf8');
  run('git', ['add', 'package.json'], root);
  run('git', ['commit', '-m', 'v2.4.4'], root);
  run('git', ['tag', 'v2.4.4'], root);

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'remote-codex-update-test',
    version: '2.5.0-beta.1',
  }, null, 2), 'utf8');
  run('git', ['add', 'package.json'], root);
  run('git', ['commit', '-m', 'v2.5.0-beta.1'], root);
  run('git', ['tag', 'v2.5.0-beta.1'], root);

  run('git', ['checkout', 'v2.4.3'], root);
  return root;
}

function testStableTagsIgnorePrerelease() {
  assert.strictEqual(updater.selectLatestStableTag([
    'v2.4.3',
    'v2.4.5-beta.1',
    'v2.4.4',
    'v2.5.0-rc.1',
  ]), 'v2.4.4');
}

function testStatusReportsLatestStableTag() {
  const root = initRepo();
  const status = updater.getLocalUpdateStatus({ rootDir: root, fetch: false });
  assert.strictEqual(status.currentVersion, '2.4.3');
  assert.strictEqual(status.currentTag, 'v2.4.3');
  assert.strictEqual(status.latestStableTag, 'v2.4.4');
  assert.strictEqual(status.updateAvailable, true);
  assert.strictEqual(status.dirty, false);
}

function testCleanHeadAheadOfLatestStableDoesNotDowngrade() {
  const root = initRepo();
  run('git', ['checkout', 'v2.4.4'], root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'remote-codex-update-test',
    version: '2.4.5-dev',
  }, null, 2), 'utf8');
  run('git', ['add', 'package.json'], root);
  run('git', ['commit', '-m', 'untagged development build'], root);

  const status = updater.getLocalUpdateStatus({ rootDir: root, fetch: false });
  assert.strictEqual(status.currentTag, '');
  assert.strictEqual(status.latestStableTag, 'v2.4.4');
  assert.strictEqual(status.updateAvailable, false);
}

function testDirtyTrackedFilesBlockUpdate() {
  const root = initRepo();
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"local"}\n', 'utf8');
  assert.throws(
    () => updater.applyStableTagUpdate({ rootDir: root, fetch: false }),
    /tracked files/i,
  );
}

function testUpdateBacksUpDataBeforeCheckout() {
  const root = initRepo();
  const result = updater.applyStableTagUpdate({ rootDir: root, fetch: false });
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.targetTag, 'v2.4.4');
  assert.ok(result.backupDir, 'backupDir should be returned');
  assert.ok(fs.existsSync(path.join(result.backupDir, 'session-collections.json')));
  assert.ok(fs.existsSync(path.join(result.backupDir, 'connectors.json')));
  assert.ok(fs.existsSync(path.join(root, 'tmp', 'session-collections.json')), 'live tmp data should remain');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.version, '2.4.4');
}

function testRestartSchedulingIsDetached() {
  const root = initRepo();
  const result = updater.scheduleWindowsRestart({
    rootDir: root,
    delayMs: 250,
    execute: false,
  });
  assert.strictEqual(result.scheduled, true);
  assert.match(result.command, /start-windows\.ps1/);
  assert.match(result.command, /-Restart/);
  assert.strictEqual(result.detached, true);
}

function testRelayRoutesExist() {
  assert.match(serverSource, /getLocalUpdateStatus/);
  assert.match(serverSource, /applyStableTagUpdate/);
  assert.match(serverSource, /scheduleWindowsRestart/);
  assert.match(serverSource, /\/api\/update\/status/);
  assert.match(serverSource, /\/api\/update\/apply/);
  assert.match(serverSource, /\/api\/update\/restart/);
}

function testSettingsUpdateUiExists() {
  assert.match(htmlSource, /settings-update-section/);
  assert.match(htmlSource, /Untested|Experimental/i);
  assert.match(htmlSource, /check-update-button/);
  assert.match(htmlSource, /apply-update-button/);
  assert.match(htmlSource, /restart-after-update-button/);
  assert.match(appSource, /\/api\/update\/status/);
  assert.match(appSource, /\/api\/update\/apply/);
  assert.match(appSource, /\/api\/update\/restart/);
  assert.match(cssSource, /settings-update-section/);
}

testStableTagsIgnorePrerelease();
testStatusReportsLatestStableTag();
testCleanHeadAheadOfLatestStableDoesNotDowngrade();
testDirtyTrackedFilesBlockUpdate();
testUpdateBacksUpDataBeforeCheckout();
testRestartSchedulingIsDetached();
testRelayRoutesExist();
testSettingsUpdateUiExists();

console.log('software update assertions passed');
