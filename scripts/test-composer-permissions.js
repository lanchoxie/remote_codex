const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const modulePath = path.resolve(__dirname, '../apps/mobile-web/public/ui/composer-permissions.js');
assert.ok(fs.existsSync(modulePath), 'composer permissions must have a focused UI controller');
const { createComposerPermissions, describePermissions, presets } = require(modulePath);
const dom = new JSDOM('<div id="permissions"></div>');
const container = dom.window.document.getElementById('permissions');
const calls = [];
let allowFull = false;
let confirms = 0;
const controller = createComposerPermissions({
  container,
  onChange: (...args) => calls.push(args),
  onAdvanced: () => calls.push(['advanced']),
  confirmFullAccess: () => { confirms++; return allowFull; },
});
assert.equal(describePermissions(null, 'en'), 'Not reported');
assert.match(describePermissions({ approvalPolicy: 'never' }, 'en'), /Not reported/);
controller.update({ sessionKey: '', locale: 'zh-CN', next: presets.ask });
assert.equal(container.querySelector('select').disabled, true);
controller.update({ sessionKey: 'host-a::session-a', locale: 'en', current: presets.ask, next: presets.auto });
const menu = container.querySelector('details');
const select = container.querySelector('select');
menu.open = true;
select.focus();
assert.match(container.textContent, /Host reported:.*Ask for approval/);
assert.match(container.textContent, /Next send/);
assert.match(container.textContent, /queued messages.*unchanged/i);
select.value = 'full';
select.dispatchEvent(new dom.window.Event('change'));
assert.equal(confirms, 1);
assert.equal(calls.length, 0, 'cancel full access must not mutate options');
assert.equal(select.value, 'auto');
allowFull = true;
select.value = 'full';
select.dispatchEvent(new dom.window.Event('change'));
assert.equal(calls.length, 1);
assert.equal(calls[0][0], 'host-a::session-a');
assert.deepEqual(calls[0][1], presets.full);
assert.match(container.textContent, /Host reported:.*Ask for approval/, 'a draft choice cannot claim current runtime changed');
controller.update({ sessionKey: 'host-a::session-a', locale: 'en', current: presets.ask, next: presets.full });
assert.equal(container.querySelector('select'), select, 'runtime refresh must not rebuild focused controls');
assert.equal(menu.open, true);
assert.equal(dom.window.document.activeElement, select);
controller.update({ sessionKey: 'host-b::session-b', locale: 'zh-CN', current: null, next: presets.readOnly });
assert.equal(menu.open, false, 'changing Session closes the previous permission menu');
assert.match(container.textContent, /尚未报告/);
assert.match(container.textContent, /下次发送/);
assert.equal(select.value, 'readOnly');
select.value = 'ask';
select.dispatchEvent(new dom.window.Event('change'));
assert.equal(calls.at(-1)[0], 'host-b::session-b');
assert.equal(presets.auto.sandboxMode, presets.ask.sandboxMode, 'auto-review cannot widen sandbox');
controller.update({ sessionKey: 'host-b::session-b', locale: 'en', disabled: true, next: presets.ask });
select.value = 'full';
select.dispatchEvent(new dom.window.Event('change'));
assert.equal(calls.length, 2, 'disabled event must not apply permissions even programmatically');
console.log('composer permissions state, confirmation, identity and locale tests passed');
const root = path.resolve(__dirname, '../apps/mobile-web/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.ok(html.includes('/ui/composer-permissions.js'), 'permissions controller must be loaded by the application');
const page = new JSDOM(html);
assert.ok(page.window.document.querySelector('#input-form #composer-permissions'), 'permissions entry belongs in the composer');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function extract(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = app.indexOf('\nfunction ', start + 1);
  return app.slice(start, end);
}
const vm = require('vm');
const session = { hostId: 'host', sessionId: 'session', live: true };
const nextOptions = { model: 'test-model', ...presets.ask };
const integrationState = {
  codexControls: { sessionOptionsByKey: new Map([['host::session', nextOptions]]), persistedSessionOptionKeys: new Set() },
};
let persistCount = 0;
const context = vm.createContext({
  window: { RemoteCodexComposerPermissions: require(modulePath), confirm: () => true },
  el: (id) => page.window.document.getElementById(id),
  getSelectedSession: () => session,
  resolveComposerSessionKey: () => 'host::session',
  getComposerOptionsForSession: () => integrationState.codexControls.sessionOptionsByKey.get('host::session'),
  getRuntimeForSession: () => presets.ask,
  currentLocale: () => 'en',
  state: integrationState,
  persistComposerSessionOptions: () => { persistCount++; },
  applyComposerOptionsToControls: () => {},
  openSettingsDialog: () => {},
  renderSettingsDialog: () => {},
});
vm.runInContext(extract('renderComposerPermissions'), context);
context.renderComposerPermissions(session, false);
const wiredSelect = page.window.document.querySelector('#composer-permissions select');
wiredSelect.value = 'auto';
wiredSelect.dispatchEvent(new page.window.Event('change'));
assert.equal(persistCount, 1);
assert.equal(integrationState.codexControls.sessionOptionsByKey.get('host::session').model, 'test-model');
assert.equal(integrationState.codexControls.sessionOptionsByKey.get('host::session').approvalsReviewer, 'auto_review');
assert.equal(integrationState.codexControls.persistedSessionOptionKeys.has('host::session'), true);
assert.match(page.window.document.querySelector('#composer-permissions').textContent, /Host reported: Ask for approval/);
assert.ok(extract('renderComposerControls').includes('renderComposerPermissions'), 'permissions must update when Session/runtime renders');
console.log('composer permissions real application wiring tests passed');
