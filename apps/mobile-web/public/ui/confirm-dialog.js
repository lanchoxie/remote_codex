(function initConfirmDialog(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexConfirmDialog = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  const copy = {
    en: { title: 'Confirm action', confirm: 'Confirm', cancel: 'Cancel' },
    'zh-CN': { title: '确认操作', confirm: '确认', cancel: '取消' },
  };

  function text(value) { return String(value == null ? '' : value); }
  function words(locale) { return copy[locale === 'en' ? 'en' : 'zh-CN']; }

  function createConfirmDialog(options = {}) {
    const document = options.document || root.document;
    if (!document?.createElement) throw new Error('ConfirmDialog requires a document.');
    const container = options.container || document.body;
    let active = null;
    let restoreFocus = null;

    const overlay = document.createElement('div');
    overlay.className = 'remote-confirm-overlay hidden';
    overlay.setAttribute('aria-hidden', 'true');
    const dialog = document.createElement('section');
    dialog.className = 'remote-confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h2');
    heading.className = 'remote-confirm-title';
    const message = document.createElement('p');
    message.className = 'remote-confirm-message';
    const actions = document.createElement('div');
    actions.className = 'remote-confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-button';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary-button';
    actions.append(cancel, confirm);
    dialog.append(heading, message, actions);
    overlay.appendChild(dialog);
    container.appendChild(overlay);

    function settle(result) {
      if (!active) return;
      const current = active;
      active = null;
      overlay.classList.add('hidden');
      overlay.setAttribute('aria-hidden', 'true');
      document.body?.classList.remove('remote-confirm-open');
      current.resolve(Boolean(result));
      if (restoreFocus?.isConnected && typeof restoreFocus.focus === 'function') {
        restoreFocus.focus({ preventScroll: true });
      }
      restoreFocus = null;
    }

    function onKeyDown(event) {
      if (!active) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        settle(false);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === confirm ? cancel : confirm).focus();
      }
    }
    function onOverlayClick(event) {
      if (event.target === overlay) settle(false);
    }
    cancel.addEventListener('click', () => settle(false));
    confirm.addEventListener('click', () => settle(true));
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);

    function request(requestOptions = {}) {
      if (active) settle(false);
      const locale = requestOptions.locale || options.locale || document.documentElement?.lang || 'en';
      const w = words(locale);
      heading.textContent = text(requestOptions.title || w.title);
      message.textContent = text(requestOptions.message);
      cancel.textContent = text(requestOptions.cancelLabel || w.cancel);
      confirm.textContent = text(requestOptions.confirmLabel || w.confirm);
      dialog.dataset.confirmKind = text(requestOptions.kind || 'default');
      restoreFocus = document.activeElement;
      let resolveRequest;
      const promise = new Promise((resolve) => { resolveRequest = resolve; });
      active = { resolve: resolveRequest };
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
      document.body?.classList.add('remote-confirm-open');
      confirm.focus({ preventScroll: true });
      return promise;
    }

    function destroy() {
      settle(false);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    }

    return Object.freeze({ request, close: () => settle(false), destroy });
  }

  return Object.freeze({ createConfirmDialog, words });
}));
