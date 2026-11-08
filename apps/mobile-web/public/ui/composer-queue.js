(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexComposerQueue = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const copy = {
    en: { queue: 'Queue', current: 'Current', others: 'Others', more: 'More actions', edit: 'Edit message',
      done: 'Done editing', force: 'Interrupt & Send', first: 'Interrupt & Send First', guide: 'Guide',
      remove: 'Remove', retry: 'Retry same request', check: 'Check result', open: 'Open Session',
      collapse: 'Collapse queue', expand: 'Expand queue', empty: 'No queued messages here.',
      attachment: 'Attachment', editing: 'Editing · auto-send paused', memory: 'Saved in this browser. Local browser files need to be selected again after reload.',
      collapsed: 'List hidden; queued messages still send normally.', error: 'Action failed. The message is retained.' },
    'zh-CN': { queue: '队列', current: '当前会话', others: '其他会话', more: '更多操作', edit: '编辑消息',
      done: '完成编辑', force: '打断并发送', first: '打断并发送第一条', guide: '引导',
      remove: '移除', retry: '重试原请求', check: '查询结果', open: '打开原会话',
      collapse: '收起队列', expand: '展开队列', empty: '这里没有排队消息。',
      attachment: '附件消息', editing: '编辑中 · 暂停自动发送', memory: '已保存在当前浏览器；刷新后浏览器本地文件需要重新选择。',
      collapsed: '列表已收起，排队消息仍会正常发送。', error: '操作失败，消息已保留。' },
  };
  const words = locale => copy[locale === 'en' ? 'en' : 'zh-CN'];

  // View-only data and callbacks: this module never reads Session state or sends HTTP.
  function createRenderer({ container, onAction = () => {}, onEdit = () => {}, onEditingChange = () => {} }) {
    const doc = container.ownerDocument;
    const rows = new Map(), pending = new Set(), errors = new Map();
    let view = { items: [], others: [], sessionKey: '', locale: 'en' };
    let tab = 'current', collapsed = false, destroyed = false;
    const node = (tag, cls, text = '') => {
      const n = doc.createElement(tag); n.className = cls; n.textContent = text; return n;
    };
    const button = (action, text) => {
      const n = node('button', 'cq-button', text); n.type = 'button'; n.dataset.queueAction = action; return n;
    };
    const header = node('div', 'cq-header');
    const title = node('strong', 'cq-title'); title.id = 'composer-turn-notice-title';
    const toggle = button('collapse', ''); toggle.setAttribute('aria-controls', 'composer-steer-queue-list');
    header.append(title, toggle);
    const toolbar = node('div', 'cq-toolbar');
    const current = button('', ''); current.dataset.queueTab = 'current';
    const others = button('', ''); others.dataset.queueTab = 'others';
    const first = button('first', ''); first.id = 'composer-force-send-button';
    toolbar.append(current, others, first);
    const list = node('div', 'cq-list'); list.id = 'composer-steer-queue-list';
    const empty = node('div', 'cq-empty');
    const hint = node('div', 'cq-hint'); hint.id = 'composer-turn-notice-copy';
    const notice = node('div', 'cq-notice'); notice.setAttribute('role', 'status');
    container.classList.add('composer-queue');
    container.removeAttribute('aria-live'); // Do not announce/re-read every editor change.
    container.replaceChildren(header, toolbar, list, empty, hint, notice);

    function allItems() { return [...view.items, ...view.others]; }
    function itemById(id) { return allItems().find(item => item.id === id); }
    function allowed(item, action) {
      if (!item || pending.has(item.id)) return false;
      if (action === 'open') return item.sessionKey !== view.sessionKey && item.canOpen !== false;
      if (item.sessionKey !== view.sessionKey) return false;
      return Boolean(item[{ edit: 'canEdit', force: 'canForce', guide: 'canGuide', remove: 'canRemove',
        retry: 'canRetry', check: 'canCheck' }[action]]);
    }
    function endEdit(row) {
      if (!row.editing) return;
      row.editing = false; row.composing = false; row.editor.hidden = true; row.done.hidden = true;
      onEditingChange(row.id, false);
    }
    function closeMenus(focus = false) {
      for (const row of rows.values()) if (!row.menu.hidden) {
        row.menu.hidden = true; row.more.setAttribute('aria-expanded', 'false');
        if (focus && !row.card.hidden) row.more.focus();
      }
    }
    function createRow(id) {
      const row = { id, editing: false, composing: false };
      row.card = node('article', 'cq-card'); row.card.dataset.queueItemId = id;
      row.line = node('div', 'cq-row');
      row.index = node('span', 'cq-index');
      row.preview = node('span', 'cq-preview');
      row.status = node('span', 'cq-status');
      row.more = button('', '…'); row.more.classList.add('cq-more'); row.more.dataset.queueMoreId = id;
      row.more.setAttribute('aria-expanded', 'false');
      row.open = button('open', ''); row.open.dataset.queueOpenId = id;
      row.line.append(row.index, row.preview, row.status, row.more, row.open);
      row.meta = node('div', 'cq-meta');
      row.editor = node('textarea', 'cq-editor');
      row.editor.dataset.steerQueueText = id; row.editor.rows = 3; row.editor.hidden = true;
      row.done = button('done', ''); row.done.hidden = true;
      row.error = node('div', 'cq-error');
      row.menu = node('div', 'cq-menu'); row.menu.hidden = true;
      // In-flow disclosure avoids clipping or overlaying the input on small screens.
      row.menu.setAttribute('role', 'group');
      row.actions = {};
      for (const action of ['edit', 'guide', 'force', 'retry', 'check', 'remove']) {
        row.actions[action] = button(action, '');
        row.menu.append(row.actions[action]);
      }
      row.card.append(row.line, row.meta, row.editor, row.done, row.error, row.menu);
      return row;
    }
    function refreshRow(row, item, index) {
      const w = words(view.locale), own = item.sessionKey === view.sessionKey;
      if ((!own || !item.canEdit) && row.editing) endEdit(row);
      row.index.textContent = '#' + (index + 1);
      row.preview.textContent = String(item.text || '').replace(/\s+/g, ' ').trim() || w.attachment;
      row.preview.title = String(item.text || '');
      row.status.textContent = row.editing ? w.editing : item.statusLabel || item.status;
      row.status.title = row.status.textContent;
      row.card.dataset.status = item.status;
      row.meta.textContent = [!own && item.title, item.meta].filter(Boolean).join(' · ');
      row.meta.hidden = !row.meta.textContent;
      row.more.hidden = !own; row.open.hidden = own;
      row.more.setAttribute('aria-label', w.more + ' #' + (index + 1));
      row.menu.setAttribute('aria-label', w.more);
      row.open.textContent = w.open; row.open.disabled = !allowed(item, 'open');
      row.editor.setAttribute('aria-label', w.edit + ' #' + (index + 1));
      // Retain the same DOM and native selection/IME throughout runtime refresh.
      if (!row.composing && doc.activeElement !== row.editor && row.editor.value !== item.text) {
        row.editor.value = String(item.text || '');
      }
      row.editor.disabled = !item.canEdit || pending.has(item.id);
      row.done.textContent = w.done;
      row.error.textContent = errors.get(item.id) || item.error || '';
      row.error.hidden = !row.error.textContent;
      for (const [action, control] of Object.entries(row.actions)) {
        control.textContent = w[action];
        control.disabled = !allowed(item, action) || (row.editing && action !== 'edit');
        control.hidden = action === 'retry' ? !item.canRetry : action === 'check' ? !item.canCheck : false;
      }
      row.actions.guide.title = item.guideHint || '';
    }
    function paint() {
      if (destroyed) return;
      const w = words(view.locale);
      const total = view.items.length + view.others.length;
      container.classList.toggle('hidden', !total && !view.notice);
      header.hidden = toolbar.hidden = !total;
      title.textContent = w.queue + ' · ' + total;
      title.title = w.memory;
      toggle.textContent = collapsed ? w.expand : w.collapse;
      toggle.setAttribute('aria-expanded', String(!collapsed));
      current.textContent = w.current + ' (' + view.items.length + ')';
      others.textContent = w.others + ' (' + view.others.length + ')';
      current.setAttribute('aria-pressed', String(tab === 'current'));
      others.setAttribute('aria-pressed', String(tab === 'others'));
      first.textContent = w.first;
      first.hidden = collapsed || tab !== 'current';
      first.disabled = !view.firstId || rows.get(view.firstId)?.editing || !allowed(itemById(view.firstId), 'force');
      list.hidden = collapsed || !total;
      const items = tab === 'others' ? view.others : view.items;
      const valid = new Set(allItems().map(item => item.id));
      for (const [id, row] of rows) if (!valid.has(id)) {
        endEdit(row); row.card.remove(); rows.delete(id); errors.delete(id);
      }
      const visible = new Set(items.map(item => item.id));
      for (const row of rows.values()) row.card.hidden = !visible.has(row.id);
      // Move nodes only if ordering changed. appendChild on every refresh blurs inputs.
      let previous = null;
      items.forEach((item, index) => {
        let row = rows.get(item.id);
        if (!row) { row = createRow(item.id); rows.set(item.id, row); }
        row.card.hidden = false; refreshRow(row, item, index);
        const expected = previous ? previous.nextSibling : list.firstChild;
        if (expected !== row.card) list.insertBefore(row.card, expected);
        previous = row.card;
      });
      empty.textContent = w.empty; empty.hidden = collapsed || items.length > 0 || !total;
      hint.textContent = collapsed ? w.collapsed : w.memory; hint.hidden = !total;
      notice.textContent = view.notice ? [view.notice.title, view.notice.message].filter(Boolean).join(' — ') : '';
      notice.hidden = !view.notice;
    }
    function update(next) {
      const switching = view.sessionKey !== next.sessionKey;
      if (switching) {
        closeMenus(); for (const row of rows.values()) endEdit(row);
        tab = 'current'; collapsed = false;
      }
      view = { ...next, items: next.items || [], others: next.others || [] };
      paint();
    }
    function saveEditor(row) {
      const item = itemById(row.id);
      if (!row.editing || !allowed(item, 'edit')) return false;
      try {
        onEdit(row.id, row.editor.value);
        errors.delete(row.id);
        row.preview.textContent = row.editor.value.replace(/\s+/g, ' ').trim() || words(view.locale).attachment;
      } catch (error) {
        errors.set(row.id, error.message || words(view.locale).error);
        row.error.textContent = errors.get(row.id); row.error.hidden = false;
      }
      return !errors.has(item.id);
    }
    async function click(event) {
      const target = event.target.closest('button');
      if (!target || !container.contains(target) || target.disabled) return;
      event.preventDefault(); // Queue controls must never submit the composer form.
      if (target.dataset.queueTab) {
        closeMenus();
        if (target.dataset.queueTab !== tab) for (const row of rows.values()) endEdit(row);
        tab = target.dataset.queueTab; paint(); return;
      }
      const action = target.dataset.queueAction;
      if (action === 'collapse') {
        closeMenus(); for (const row of rows.values()) endEdit(row);
        collapsed = !collapsed; paint(); return;
      }
      const id = action === 'first' ? view.firstId : target.closest('[data-queue-item-id]')?.dataset.queueItemId;
      const row = rows.get(id), item = itemById(id);
      if (!row || !item) return;
      if (action === 'first' && row.editing) return;
      if (target.dataset.queueMoreId) {
        if (item.sessionKey !== view.sessionKey || row.card.hidden || collapsed) return;
        const opening = row.menu.hidden; closeMenus();
        row.menu.hidden = !opening; row.more.setAttribute('aria-expanded', String(opening)); return;
      }
      if (action === 'done') {
        if (row.composing || !saveEditor(row)) {
          row.editor.hidden = false; row.done.hidden = false; row.editor.focus();
          return;
        }
        endEdit(row); paint(); row.more.focus(); return;
      }
      if (action === 'edit' && allowed(item, 'edit')) {
        closeMenus(); row.editing = true; row.editor.hidden = false; row.done.hidden = false;
        onEditingChange(id, true); paint(); row.editor.focus(); return;
      }
      const resolvedAction = action === 'first' ? 'force' : action;
      if (!allowed(item, resolvedAction)) return;
      closeMenus(); pending.add(id); errors.delete(id); paint();
      try { await onAction(resolvedAction, id, event.isTrusted === true); }
      catch (error) { errors.set(id, error.message || words(view.locale).error); }
      finally { pending.delete(id); paint(); }
    }
    function input(event) {
      const row = rows.get(event.target.dataset.steerQueueText);
      if (row && !row.composing) saveEditor(row);
    }
    function composition(event) {
      const row = rows.get(event.target.dataset.steerQueueText);
      if (!row) return;
      row.composing = event.type === 'compositionstart';
      if (!row.composing) saveEditor(row);
    }
    function keydown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation(); event.preventDefault(); closeMenus(true);
      }
    }
    function outside(event) { if (!container.contains(event.target)) closeMenus(); }
    function beforeUnload(event) {
      // This is a loss warning, not queue persistence. Accepted Guide entries
      // need no warning; unknown/failed delivery must still be retained.
      if (!allItems().some(item => !['guided', 'sent'].includes(item.status))) return;
      event.preventDefault();
      event.returnValue = '';
    }
    container.addEventListener('click', click);
    container.addEventListener('input', input);
    container.addEventListener('compositionstart', composition);
    container.addEventListener('compositionend', composition);
    container.addEventListener('keydown', keydown);
    doc.addEventListener('pointerdown', outside);
    doc.defaultView?.addEventListener('beforeunload', beforeUnload);
    function destroy() {
      destroyed = true;
      for (const row of rows.values()) endEdit(row);
      container.removeEventListener('click', click); container.removeEventListener('input', input);
      container.removeEventListener('compositionstart', composition); container.removeEventListener('compositionend', composition);
      container.removeEventListener('keydown', keydown); doc.removeEventListener('pointerdown', outside);
      doc.defaultView?.removeEventListener('beforeunload', beforeUnload);
      rows.clear(); container.replaceChildren();
    }
    return Object.freeze({ update, destroy });
  }
  return Object.freeze({ createRenderer, words });
}));
