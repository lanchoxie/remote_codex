(function init(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexTranscriptScroll = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function createScrollMachine(node, options = {}) {
    if (!node) throw new TypeError('scroll node is required');
    const anchorSelector = String(options.anchorSelector || '[data-viewport-key]');
    const anchorDatasetKey = String(options.anchorDatasetKey || 'viewportKey');
    const bottomTolerance = Math.max(0, finite(options.bottomTolerance, 8));
    let mode = options.initialMode === 'detached' ? 'detached' : 'follow';
    let userRevision = Math.max(0, Math.trunc(finite(options.initialUserRevision)));
    let programmaticRevision = Math.max(0, Math.trunc(finite(options.initialProgrammaticRevision)));
    let programmaticDepth = 0;

    function scrollTop() {
      return finite(options.getScrollTop ? options.getScrollTop(node) : node.scrollTop);
    }

    function scrollHeight() {
      return finite(options.getScrollHeight ? options.getScrollHeight(node) : node.scrollHeight);
    }

    function clientHeight() {
      return finite(options.getClientHeight ? options.getClientHeight(node) : node.clientHeight);
    }

    function setScrollTop(value) {
      if (options.setScrollTop) options.setScrollTop(node, value);
      else node.scrollTop = value;
    }

    function maximumScrollTop() {
      return Math.max(0, scrollHeight() - clientHeight());
    }

    function bottomGap() {
      return Math.max(0, maximumScrollTop() - scrollTop());
    }

    function atBottom() {
      return bottomGap() <= bottomTolerance;
    }

    function anchors() {
      const root = typeof options.anchorRoot === 'function' ? options.anchorRoot(node) : node;
      return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll(anchorSelector) || [])
        : [];
    }

    function containerTop() {
      const rect = options.getViewportRect?.(node) || node.getBoundingClientRect?.();
      return finite(rect?.top);
    }

    function visibleAnchor() {
      const top = containerTop();
      const rect = options.getViewportRect?.(node);
      const bottom = rect ? finite(rect.bottom, top + clientHeight()) : top + clientHeight();
      return anchors().find((candidate) => {
        const rect = candidate.getBoundingClientRect?.();
        return rect && finite(rect.bottom, finite(rect.top)) > top && finite(rect.top) < bottom;
      }) || null;
    }

    function capture() {
      const anchor = mode === 'detached' ? visibleAnchor() : null;
      const anchorRect = anchor?.getBoundingClientRect?.();
      const max = maximumScrollTop();
      return {
        mode,
        anchorKey: anchor?.dataset?.[anchorDatasetKey] || '',
        anchorOffset: anchorRect ? finite(anchorRect.top) - containerTop() : 0,
        bottomGap: bottomGap(),
        scrollTop: scrollTop(),
        proportionalPosition: max > 0 ? scrollTop() / max : 0,
        userRevision,
        programmaticRevision,
      };
    }

    function withProgrammaticScroll(callback) {
      programmaticDepth += 1;
      programmaticRevision += 1;
      try {
        return callback();
      } finally {
        programmaticDepth -= 1;
      }
    }

    function restore(snapshot = {}) {
      if (finite(snapshot.userRevision, -1) !== userRevision) return false;
      mode = snapshot.mode === 'detached' ? 'detached' : 'follow';
      withProgrammaticScroll(() => {
        if (mode === 'follow') {
          setScrollTop(clamp(
            maximumScrollTop() - Math.max(0, finite(snapshot.bottomGap)),
            0,
            maximumScrollTop()
          ));
          return;
        }
        const anchor = anchors().find((candidate) => (
          candidate?.dataset?.[anchorDatasetKey] === snapshot.anchorKey
        ));
        if (anchor?.getBoundingClientRect) {
          const currentOffset = finite(anchor.getBoundingClientRect().top) - containerTop();
          setScrollTop(clamp(
            scrollTop() + currentOffset - finite(snapshot.anchorOffset),
            0,
            maximumScrollTop()
          ));
          return;
        }
        setScrollTop(clamp(
          finite(
            snapshot.scrollTop,
            finite(snapshot.proportionalPosition) * maximumScrollTop()
          ),
          0,
          maximumScrollTop()
        ));
      });
      return true;
    }

    function beginTrustedInteraction() {
      if (programmaticDepth > 0) return false;
      userRevision += 1;
      mode = 'detached';
      return true;
    }

    function settleTrustedInteraction() {
      if (programmaticDepth > 0) return false;
      mode = atBottom() ? 'follow' : 'detached';
      return true;
    }

    function recordTrustedInteraction() {
      if (!beginTrustedInteraction()) return false;
      settleTrustedInteraction();
      return true;
    }

    function establishFollow() {
      mode = 'follow';
      return true;
    }

    function detach() {
      mode = 'detached';
      return true;
    }

    function guardAsync(promise, restoreCallback) {
      const guardedRevision = userRevision;
      return Promise.resolve(promise).then((value) => {
        if (guardedRevision !== userRevision) return false;
        withProgrammaticScroll(() => restoreCallback(value));
        return true;
      });
    }

    return {
      beginTrustedInteraction,
      capture,
      detach,
      establishFollow,
      restore,
      recordTrustedInteraction,
      settleTrustedInteraction,
      withProgrammaticScroll,
      guardAsync,
      state: () => ({ mode, userRevision, programmaticRevision, programmatic: programmaticDepth > 0 }),
    };
  }

  return { createScrollMachine };
}));
