(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexComposerPermissions = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const presets = Object.freeze({
    ask: Object.freeze({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: 'workspaceWrite' }),
    auto: Object.freeze({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxMode: 'workspaceWrite' }),
    readOnly: Object.freeze({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: 'readOnly' }),
    full: Object.freeze({ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'dangerFullAccess' }),
  });
  const copy = {
    en: {
      title: 'Permissions', next: 'Next send', current: 'Host reported', unknown: 'Not reported',
      ask: 'Ask for approval', auto: 'Auto-review', readOnly: 'Read only', full: 'Full access', custom: 'Custom / advanced',
      hint: 'Applies to the next new send. The current turn, Guide and already queued messages remain unchanged. Host restrictions still apply.',
      advanced: 'Advanced settings',
      confirm: 'Full access removes the sandbox and disables approval prompts for the next send in this Session. Continue?',
    },
    'zh-CN': {
      title: '权限', next: '下次发送', current: 'Host 报告', unknown: '尚未报告',
      ask: '请求批准', auto: '自动审查', readOnly: '只读', full: '完全访问', custom: '自定义 / 高级',
      hint: '用于下次新发送。当前轮次、引导和已排队消息保持不变；仍受 Host 限制。',
      advanced: '高级设置',
      confirm: '完全访问会为本 Session 的下次发送移除沙箱限制并关闭审批提示。确定继续？',
    },
  };
  const words = (locale) => copy[locale === 'en' ? 'en' : 'zh-CN'];
  function presetId(options) {
    return Object.keys(presets).find((key) => Object.keys(presets[key]).every((field) => options?.[field] === presets[key][field])) || 'custom';
  }
  function describePermissions(options, locale) {
    const text = words(locale);
    if (!options || !['approvalPolicy', 'approvalsReviewer', 'sandboxMode'].every((key) => options[key])) return text.unknown;
    const id = presetId(options);
    return id !== 'custom' ? text[id] : `${text.custom} (${String(options.approvalPolicy)} / ${String(options.approvalsReviewer)} / ${String(options.sandboxMode)})`;
  }
  function createComposerPermissions({ container, onChange, onAdvanced, confirmFullAccess }) {
    const document = container.ownerDocument;
    container.dataset.i18nSkip = 'true';
    const menu = document.createElement('details');
    menu.className = 'composer-permissions-menu';
    const summary = document.createElement('summary');
    const panel = document.createElement('div');
    panel.className = 'composer-permissions-panel';
    const current = document.createElement('div');
    current.className = 'composer-permissions-current';
    const label = document.createElement('label');
    const caption = document.createElement('span');
    const select = document.createElement('select');
    for (const id of [...Object.keys(presets), 'custom']) {
      const option = document.createElement('option');
      option.value = id;
      option.disabled = id === 'custom';
      select.appendChild(option);
    }
    label.append(caption, select);
    const hint = document.createElement('p');
    const advanced = document.createElement('button');
    advanced.type = 'button';
    advanced.className = 'secondary-button';
    panel.append(current, label, hint, advanced);
    menu.append(summary, panel);
    container.replaceChildren(menu);
    let model = {};
    function update(next = {}) {
      if (model.sessionKey !== next.sessionKey) menu.open = false;
      model = next;
      const text = words(model.locale);
      const nextId = presetId(model.next);
      summary.textContent = `${text.title} · ${text.next}: ${describePermissions(model.next, model.locale)}`;
      current.textContent = `${text.current}: ${describePermissions(model.current, model.locale)}`;
      caption.textContent = text.next;
      select.setAttribute('aria-label', `${text.title} · ${text.next}`);
      for (const option of select.options) option.textContent = text[option.value];
      select.value = nextId;
      select.disabled = !model.sessionKey || model.disabled === true;
      advanced.disabled = !model.sessionKey || model.disabled === true;
      advanced.textContent = text.advanced;
      hint.textContent = text.hint;
    }
    select.addEventListener('change', () => {
      const id = select.value;
      const target = model.sessionKey;
      if (!target || model.disabled || !presets[id]) { update(model); return; }
      if (id === 'full' && presetId(model.next) !== 'full' && !confirmFullAccess?.(words(model.locale).confirm)) {
        update(model);
        return;
      }
      onChange?.(target, { ...presets[id] });
    });
    advanced.addEventListener('click', () => {
      if (!model.sessionKey || model.disabled) return;
      menu.open = false;
      onAdvanced?.(model.sessionKey);
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { menu.open = false; summary.focus(); }
    });
    return Object.freeze({ update });
  }
  return Object.freeze({ presets, presetId, describePermissions, createComposerPermissions });
}));
