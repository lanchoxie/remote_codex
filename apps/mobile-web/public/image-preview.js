(function initImagePreview(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexImagePreview = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  const CLOSED_STATE = Object.freeze({
    open: false,
    src: '',
    title: '',
    subtitle: '',
    downloadUrl: '',
  });

  function text(value) {
    return String(value == null ? '' : value);
  }

  function createImagePreviewController(options = {}) {
    const document = options.document || root.document || null;
    const getElement = options.getElement || ((id) => document?.getElementById(id));
    const getState = options.getState || (() => CLOSED_STATE);
    const setState = options.setState || (() => {});
    const syncModalBodyState = typeof options.syncModalBodyState === 'function'
      ? options.syncModalBodyState
      : () => {};
    let bound = false;

    function render() {
      const overlay = getElement('image-preview-overlay');
      if (!overlay) return;

      const preview = getState() || CLOSED_STATE;
      const isOpen = Boolean(preview.open && preview.src);
      overlay.classList.toggle('hidden', !isOpen);
      overlay.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

      const image = getElement('image-preview-img');
      if (image) {
        image.src = isOpen ? text(preview.src) : '';
        image.alt = text(preview.title) || 'Image preview';
      }

      const title = getElement('image-preview-title');
      if (title) title.textContent = text(preview.title) || 'Image preview';

      const subtitle = getElement('image-preview-subtitle');
      if (subtitle) subtitle.textContent = text(preview.subtitle);

      const openLink = getElement('image-preview-open-link');
      if (openLink) {
        openLink.href = isOpen ? text(preview.src) : '#';
        openLink.classList.toggle('hidden', !isOpen);
      }

      const saveLink = getElement('image-preview-save-link');
      if (saveLink) {
        saveLink.href = isOpen ? (text(preview.downloadUrl) || text(preview.src)) : '#';
        saveLink.download = text(preview.title) || 'image';
        saveLink.classList.toggle('hidden', !isOpen);
      }

      syncModalBodyState();
    }

    function open(input = {}) {
      const src = text(input.src).trim();
      if (!src) return false;
      setState({
        open: true,
        src,
        title: text(input.title) || 'Image preview',
        subtitle: text(input.subtitle),
        downloadUrl: text(input.downloadUrl) || src,
      });
      render();
      return true;
    }

    function close() {
      setState({ ...CLOSED_STATE });
      render();
    }

    function bind() {
      if (bound || !document) return;
      const overlay = getElement('image-preview-overlay');
      const closeButton = getElement('image-preview-close-button');
      if (overlay) {
        overlay.addEventListener('click', (event) => {
          if (event.target === event.currentTarget) close();
        });
      }
      if (closeButton) closeButton.addEventListener('click', close);
      bound = true;
    }

    return Object.freeze({
      bind,
      close,
      isOpen: () => Boolean(getState()?.open && getState()?.src),
      open,
      render,
    });
  }

  return Object.freeze({
    CLOSED_STATE,
    createImagePreviewController,
  });
}));
