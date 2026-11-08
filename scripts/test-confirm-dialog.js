'use strict';

const assert = require('assert/strict');
const { JSDOM } = require('jsdom');
const confirmDialog = require('../apps/mobile-web/public/ui/confirm-dialog');

async function main() {
  const dom = new JSDOM('<!doctype html><html lang="en"><body><button id="origin">Origin</button></body></html>');
  const { document, KeyboardEvent, MouseEvent } = dom.window;
  const origin = document.getElementById('origin');
  origin.focus();
  const controller = confirmDialog.createConfirmDialog({ document });
  const overlay = document.querySelector('.remote-confirm-overlay');
  const dialog = document.querySelector('.remote-confirm-dialog');
  const confirm = dialog.querySelector('.primary-button');
  const cancel = dialog.querySelector('.secondary-button');
  assert(overlay.classList.contains('hidden'), 'dialog starts hidden');

  const accepted = controller.request({
    locale: 'en',
    title: 'Confirm Rebind',
    message: 'Switch this Session?',
    kind: 'session-rebind',
  });
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(confirm.textContent, 'Confirm');
  assert.equal(cancel.textContent, 'Cancel');
  assert.equal(document.activeElement, confirm, 'confirm receives focus');
  confirm.click();
  assert.equal(await accepted, true);
  assert.equal(overlay.classList.contains('hidden'), true);
  assert.equal(document.activeElement, origin, 'focus returns to invoking control');

  const escaped = controller.request({ locale: 'zh-CN', message: '继续吗？' });
  assert.equal(confirm.textContent, '确认');
  assert.equal(cancel.textContent, '取消');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await escaped, false, 'Escape cancels');

  const masked = controller.request({ locale: 'en', message: 'Mask click' });
  overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(await masked, false, 'clicking the mask cancels');

  const first = controller.request({ locale: 'en', message: 'First' });
  const second = controller.request({ locale: 'en', message: 'Second' });
  assert.equal(await first, false, 'a new request closes the previous request');
  cancel.click();
  assert.equal(await second, false);
  controller.destroy();
  assert.equal(document.querySelector('.remote-confirm-overlay'), null);
  dom.window.close();
  console.log('confirm dialog: confirm, cancel, Escape, mask, locale, focus and replacement passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
