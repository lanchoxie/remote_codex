(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexSessionSearch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  function context(value = {}) {
    return { query: String(value.query || '').trim(), mode: value.mode || 'keyword',
      hostId: value.hostId || '', collectionId: value.collectionId || '' };
  }
  function contextKey(value) { return JSON.stringify(context(value)); }
  function createController(options) {
    const later = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    let timer = null, version = 0, key = null;
    let view = { phase: 'idle', results: [], error: '', partial: false };
    const current = () => context(options.getContext());
    const publish = (notify = true) => { if (notify) options.onChange?.(view); return view; };
    function valid(revision, ctx) { return revision === version && contextKey(current()) === contextKey(ctx); }
    async function execute(revision, ctx) {
      timer = null;
      if (!valid(revision, ctx)) return;
      view = { ...view, phase: 'searching' };
      publish();
      try {
        const response = await options.request(ctx);
        if (!valid(revision, ctx)) return;
        const results = Array.isArray(response?.results) ? response.results : [];
        view = { phase: 'ready', results, error: '',
          partial: Boolean(response?.remoteError || response?.source === 'relay-fallback' || response?.source === 'relay'),
          remoteError: String(response?.remoteError || ''), truncated: response?.truncated === true };
        options.onResults?.(results);
      } catch (error) {
        if (!valid(revision, ctx)) return;
        view = { phase: 'error', results: [], error: String(error?.message || error), partial: false };
      }
      publish();
    }
    function schedule({ immediate = false, notify = true } = {}) {
      if (timer !== null) cancel(timer);
      timer = null;
      const revision = ++version, ctx = current();
      key = contextKey(ctx);
      const phase = !ctx.query ? 'idle' : ctx.mode !== 'keyword' ? 'local' : ctx.query.length < 2 ? 'short' : 'pending';
      view = { phase, results: [], error: '', partial: false };
      publish(notify);
      if (phase !== 'pending') return Promise.resolve(view);
      if (immediate) return execute(revision, ctx);
      timer = later(() => execute(revision, ctx), options.debounceMs ?? 900);
      return Promise.resolve(view);
    }
    return { schedule, snapshot: () => view,
      sync: () => { if (key !== contextKey(current())) schedule({ notify: false }); return view; },
      dispose: () => { ++version; if (timer !== null) cancel(timer); timer = null; },
    };
  }
  // Center the highlighted word, not the midpoint of an arbitrarily long message.
  // Only move the selected transcript's scroll owner; never rebuild DOM.
  function centerHighlight(message, owner, win = message?.ownerDocument?.defaultView) {
    if (!message?.isConnected || !owner || !win) return false;
    const target = message.querySelector('.bubble mark') || message;
    const rect = target.getClientRects?.()[0] || target.getBoundingClientRect();
    const doc = message.ownerDocument;
    const page = owner === doc.scrollingElement || owner === doc.documentElement || owner === doc.body;
    const viewport = page ? { top: 0, bottom: win.innerHeight } : owner.getBoundingClientRect();
    const next = owner.scrollTop + (rect.top + rect.bottom - viewport.top - viewport.bottom) / 2;
    const height = page ? win.innerHeight : owner.clientHeight;
    const scrollHeight = page ? Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) : owner.scrollHeight;
    const top = Math.max(0, Math.min(next, Math.max(0, scrollHeight - height)));
    if (page) win.scrollTo({ top, behavior: 'instant' });
    else if (owner.scrollTo) owner.scrollTo({ top, behavior: 'instant' });
    else owner.scrollTop = top;
    return true;
  }
  return { createController, centerHighlight, contextKey };
}));
