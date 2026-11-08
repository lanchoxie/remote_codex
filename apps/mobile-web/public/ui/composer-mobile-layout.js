(function initComposerMobileLayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RemoteCodexComposerMobileLayout = api;
    root.RemoteCodexComposerMobileLayoutController = api.createComposerMobileLayout({
      document: root.document,
      window: root,
    });
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const MOBILE_QUERY = '(max-width: 720px)';
  const INPUT_MIN_HEIGHT = 56;
  const INPUT_MAX_HEIGHT = 192;

  function createComposerMobileLayout(options = {}) {
    const document = options.document || globalThis.document;
    const window = options.window || document?.defaultView || globalThis.window;
    const settings = document?.getElementById('composer-next-turn-settings');
    const input = document?.getElementById('input-text');
    const composer = document?.getElementById('input-form');
    if (!settings || !input || !window) return Object.freeze({ destroy() {} });

    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_QUERY)
      : null;
    let isMobile = media ? media.matches : Number(window.innerWidth) <= 720;
    const resizeObserver = typeof window.ResizeObserver === 'function' && composer
      ? new window.ResizeObserver(() => updateDockSpace())
      : null;

    function updateDockSpace() {
      if (!isMobile || !composer) {
        document.documentElement.style.removeProperty('--mobile-composer-height');
        return;
      }
      const height = Math.ceil(composer.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--mobile-composer-height', `${height}px`);
    }

    function resizeInput() {
      if (!isMobile) {
        input.style.removeProperty('height');
        input.style.removeProperty('overflow-y');
        updateDockSpace();
        return;
      }
      input.style.height = 'auto';
      const viewportHeight = Math.max(INPUT_MIN_HEIGHT, Number(window.innerHeight) || 800);
      const maxHeight = Math.min(INPUT_MAX_HEIGHT, Math.round(viewportHeight * 0.32));
      const contentHeight = Math.max(INPUT_MIN_HEIGHT, input.scrollHeight || INPUT_MIN_HEIGHT);
      input.style.height = `${Math.min(contentHeight, maxHeight)}px`;
      input.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
      updateDockSpace();
    }

    function syncViewport(event) {
      const nextIsMobile = typeof event?.matches === 'boolean'
        ? event.matches
        : media ? media.matches : Number(window.innerWidth) <= 720;
      if (nextIsMobile !== isMobile) {
        isMobile = nextIsMobile;
      }
      resizeInput();
    }

    settings.open = false;
    input.addEventListener('input', resizeInput);
    input.addEventListener('focus', resizeInput);
    window.addEventListener('resize', resizeInput);
    settings.addEventListener('toggle', updateDockSpace);
    resizeObserver?.observe(composer);
    if (media?.addEventListener) media.addEventListener('change', syncViewport);
    else media?.addListener?.(syncViewport);
    resizeInput();

    return Object.freeze({
      resizeInput,
      destroy() {
        input.removeEventListener('input', resizeInput);
        input.removeEventListener('focus', resizeInput);
        window.removeEventListener('resize', resizeInput);
        settings.removeEventListener('toggle', updateDockSpace);
        resizeObserver?.disconnect();
        document.documentElement.style.removeProperty('--mobile-composer-height');
        if (media?.removeEventListener) media.removeEventListener('change', syncViewport);
        else media?.removeListener?.(syncViewport);
      },
    });
  }

  return Object.freeze({ createComposerMobileLayout, MOBILE_QUERY, INPUT_MIN_HEIGHT, INPUT_MAX_HEIGHT });
}));
