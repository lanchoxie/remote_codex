'use strict';
const assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const queueUi = require('../apps/mobile-web/public/ui/composer-queue');

async function main() {
  const dom = new JSDOM('<form><div id="queue"></div><input id="outside"></form>');
  const root = dom.window.document.getElementById('queue');
  const calls = [], edits = [], editing = [];
  let failSave = false;
  let release;
  const ui = queueUi.createRenderer({ container: root,
    onAction: (action, id) => { calls.push([action, id]); if (action === 'force') return new Promise(r => { release = r; }); },
    onEdit: (id, text) => { edits.push([id, text]); if (failSave) throw new Error('unsafe payload'); },
    onEditingChange: (id, value) => editing.push([id, value]),
  });
  const a = { id: 'a', sessionKey: 'h::a', text: 'First queued message', status: 'queued', statusLabel: 'Waiting',
    canEdit: true, canForce: true, canGuide: false, canRemove: true };
  const b = { ...a, id: 'b', sessionKey: 'h::b', title: 'Other Session', text: 'Other queued text' };
  let view = { sessionKey: 'h::a', locale: 'en', items: [a], others: [b], firstId: 'a' };
  const update = (extra = {}) => { view = { ...view, ...extra }; ui.update(view); };
  const node = s => root.querySelector(s);
  const click = s => { assert(node(s), s); node(s).click(); };
  update();
  const reload = new dom.window.Event('beforeunload', { cancelable: true });
  dom.window.dispatchEvent(reload);
  assert.equal(reload.defaultPrevented, true, 'warn before reloading an unsent in-memory queue');
  assert(!root.hidden && !root.classList.contains('hidden'));
  assert.match(root.textContent, /First queued message/, 'idle queue stays visible');
  assert.equal(root.querySelectorAll('textarea:not([hidden])').length, 0, 'compact by default');
  click('[data-queue-more-id="a"]');
  assert.equal(node('[data-queue-action="guide"]').disabled, true, 'idle cannot Guide');
  click('[data-queue-action="edit"]');
  const editor = node('textarea');
  assert(!editor.hidden);
  editor.value = 'editing 中文'; editor.focus(); editor.setSelectionRange(4, 6);
  editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(edits.at(-1), ['a', 'editing 中文']);
  update({ items: [{ ...a, text: 'editing 中文', statusLabel: 'New status' }] });
  assert.equal(node('textarea'), editor, 'refresh must reuse editor DOM');
  assert.equal(dom.window.document.activeElement, editor);
  assert.equal(editor.selectionStart, 4);
  editor.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  editor.value = 'composition unfinished';
  update({ items: [{ ...a, text: 'older snapshot' }] });
  assert.equal(editor.value, 'composition unfinished', 'do not overwrite IME text');
  editor.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  assert.equal(node('[data-queue-action="first"]').disabled, true, 'editing blocks top-level first send');
  node('[data-queue-action="first"]').click();
  assert.equal(calls.filter(c => c[0] === 'force').length, 0, 'editing blocks programmatic first send');
  click('[data-queue-action="done"]');
  assert.deepEqual(editing, [['a', true], ['a', false]]);
  assert.equal(editor.hidden, true);

  // Keep a draft visible when an unsafe structured payload rejects saving.
  const unsafe = { ...a, id: 'unsafe', text: 'old', canEdit: true };
  update({ items: [unsafe], others: [b], firstId: '' });
  click('[data-queue-more-id="unsafe"]');
  click('[data-queue-action="edit"]');
  const unsafeEditor = node('textarea');
  failSave = true;
  unsafeEditor.value = 'new draft';
  unsafeEditor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  click('[data-queue-action="done"]');
  assert.equal(unsafeEditor.hidden, false, 'Done failure keeps editor open');
  update({ items: [{ ...unsafe, text: 'old' }, a] });
  assert.equal(unsafeEditor.value, 'new draft', 'failed draft survives refresh');

  click('[data-queue-more-id="a"]');
  root.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(node('.cq-menu').hidden);
  assert.equal(dom.window.document.activeElement, node('[data-queue-more-id="a"]'));
  click('[data-queue-more-id="a"]');
  dom.window.document.getElementById('outside').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert(node('.cq-menu').hidden, 'outside pointer closes menu');

  click('[data-queue-tab="others"]');
  assert.match(root.textContent, /Other queued text/);
  assert.equal(root.querySelector('[data-queue-more-id="b"]')?.hidden, true, 'Others is read-only');
  root.querySelector('[data-queue-more-id="b"]')?.click();
  assert.equal(root.querySelector('.cq-menu')?.hidden, true, 'Others cannot open an action menu');
  click('[data-queue-open-id="b"]');
  assert.deepEqual(calls.at(-1), ['open', 'b']);
  update({ sessionKey: 'h::b', items: [b], others: [a], locale: 'zh-CN', firstId: 'b' });
  assert.match(node('[data-queue-tab="current"]').textContent, /当前/);
  assert.equal(node('[data-queue-tab="current"]').getAttribute('aria-pressed'), 'true');
  click('[data-queue-action="collapse"]');
  assert(node('.cq-list').hidden);
  assert(!node('[data-queue-action="collapse"]').hidden);
  update();
  assert(node('.cq-list').hidden, 'refresh must retain collapse');
  click('[data-queue-action="collapse"]');
  assert(!node('.cq-list').hidden);

  update({ sessionKey: 'h::a', locale: 'en', items: [a], others: [b], firstId: 'a' });
  click('[data-queue-more-id="a"]');
  const force = node('[data-queue-action="force"]');
  force.click(); force.click();
  assert.equal(calls.filter(c => c[0] === 'force').length, 1, 'UI action locks immediately');
  release(); await new Promise(r => setImmediate(r));
  update({ items: [{ ...a, status: 'input_unknown', canEdit: false, canForce: false, canRemove: false, canRetry: true }], firstId: '' });
  click('[data-queue-more-id="a"]');
  assert(node('[data-queue-action="force"]').disabled);
  assert(node('[data-queue-action="edit"]').disabled);
  assert(node('[data-queue-action="remove"]').disabled);
  click('[data-queue-action="retry"]');
  assert.deepEqual(calls.at(-1), ['retry', 'a']);
  update({ items: [{ ...a, text: '<img src=x onerror=alert(1)>', error: '<script>bad</script>' }] });
  assert.equal(root.querySelector('img,script'), null, 'untrusted content is text only');
  update({ items: [], others: [], firstId: '', notice: { title: 'Interrupted', message: 'Waiting for acknowledgement' } });
  assert.match(root.textContent, /Waiting for acknowledgement/);
  update({ notice: null }); assert(root.classList.contains('hidden'));
  const emptyReload = new dom.window.Event('beforeunload', { cancelable: true });
  dom.window.dispatchEvent(emptyReload);
  assert.equal(emptyReload.defaultPrevented, false, 'empty queue does not obstruct reload');
  ui.destroy(); dom.window.close();
  console.log('compact queue UI: edit stability, IME, menus, Others, collapse, locale and action guards passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
