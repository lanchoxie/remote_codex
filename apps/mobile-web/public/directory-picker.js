(function initDirectoryPicker(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexDirectoryPicker = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  const CLOSED_STATE = Object.freeze({
    open: false,
    hostId: null,
    currentPath: '',
    parentPath: null,
    roots: [],
    directories: [],
    loading: false,
    error: null,
  });

  function text(value) {
    return String(value == null ? '' : value);
  }

  function pathLeaf(value) {
    const raw = text(value);
    if (!raw) return '';
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || raw;
  }

  function createDirectoryPickerController(options = {}) {
    const document = options.document || root.document || null;
    const getElement = options.getElement || ((id) => document?.getElementById(id));
    const getState = options.getState || (() => CLOSED_STATE);
    const setState = options.setState || (() => {});
    const getSelectedHost = options.getSelectedHost || (() => null);
    const getRecentDirectories = options.getRecentDirectories || (() => []);
    const fetchJson = options.fetchJson || root.fetch;
    const getOpenSeedPath = options.getOpenSeedPath || (() => null);
    const onApply = typeof options.onApply === 'function' ? options.onApply : () => {};
    const onError = typeof options.onError === 'function' ? options.onError : () => {};
    const syncModalBodyState = typeof options.syncModalBodyState === 'function'
      ? options.syncModalBodyState
      : () => {};
    let bound = false;
    let requestSequence = 0;

    function pickerState() {
      return getState() || CLOSED_STATE;
    }

    function update(patch) {
      setState({ ...pickerState(), ...patch });
      render();
    }

    function renderPickerEntries(container, entries, emptyText, onSelect) {
      if (!container) return;
      container.replaceChildren();
      const list = Array.isArray(entries) ? entries : [];
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
      }
      for (const entry of list) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'picker-entry';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = text(entry?.title || entry?.name || pathLeaf(entry?.path) || entry?.path);
        const path = document.createElement('div');
        path.className = 'path';
        path.textContent = text(entry?.path);
        button.append(name, path);
        button.addEventListener('click', () => onSelect(entry?.path));
        container.appendChild(button);
      }
    }

    function renderPickerChips(container, entries, activePath, onSelect) {
      if (!container) return;
      container.replaceChildren();
      const list = Array.isArray(entries) ? entries : [];
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No root paths were reported by this host.';
        container.appendChild(empty);
        return;
      }
      for (const entry of list) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `picker-chip secondary-button ${entry?.path === activePath ? 'active' : ''}`.trim();
        button.textContent = text(entry?.name || entry?.path);
        button.addEventListener('click', () => onSelect(entry?.path));
        container.appendChild(button);
      }
    }

    function render() {
      const overlay = getElement('directory-picker-overlay');
      const picker = getElement('directory-picker');
      if (!overlay || !picker) return;
      const state = pickerState();
      const host = getSelectedHost();
      if (!state.open) {
        overlay.classList.add('hidden');
        picker.classList.add('hidden');
        syncModalBodyState();
        return;
      }
      overlay.classList.remove('hidden');
      picker.classList.remove('hidden');
      const hostLabel = getElement('picker-host');
      const status = getElement('picker-status');
      const currentPath = getElement('picker-current-path');
      const upButton = getElement('picker-up-button');
      const refreshButton = getElement('picker-refresh-button');
      const selectButton = getElement('picker-select-button');
      if (hostLabel) hostLabel.textContent = host ? text(host.label) : 'No host selected';
      if (currentPath) currentPath.textContent = text(state.currentPath) || '(pick a root or recent directory)';
      if (status) {
        status.textContent = !host
          ? 'Choose a host first, then browse directories on that machine.'
          : state.loading
            ? 'Loading directories from the selected host...'
            : state.error
              ? text(state.error)
              : 'Tap a folder to enter it, then use the current directory.';
      }
      if (upButton) upButton.disabled = Boolean(state.loading || !state.parentPath);
      if (refreshButton) refreshButton.disabled = Boolean(state.loading || !host);
      if (selectButton) selectButton.disabled = Boolean(state.loading || !state.currentPath);

      renderPickerChips(
        getElement('picker-roots'),
        state.roots,
        state.currentPath,
        (targetPath) => browse(targetPath).catch(onError)
      );
      renderPickerEntries(
        getElement('picker-recents'),
        host ? getRecentDirectories(host.hostId) : [],
        'No recent workspace paths were discovered for this host yet.',
        (targetPath) => browse(targetPath).catch(onError)
      );
      renderPickerEntries(
        getElement('picker-directories'),
        state.directories,
        state.loading ? 'Loading...' : 'This folder does not have any visible subdirectories.',
        (targetPath) => browse(targetPath).catch(onError)
      );
      syncModalBodyState();
    }

    async function fetchDirectoryListing(targetPath = null, hostId = getSelectedHost()?.hostId) {
      const sequence = ++requestSequence;
      if (!hostId) {
        update({
          open: true,
          hostId: null,
          currentPath: '',
          parentPath: null,
          roots: [],
          directories: [],
          loading: false,
          error: 'Select a host before browsing its directories.',
        });
        return null;
      }
      update({ open: true, hostId, loading: true, error: null });
      const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
      try {
        const response = await fetchJson(`/api/hosts/${encodeURIComponent(hostId)}/directories${query}`);
        if (sequence !== requestSequence) return null;
        update({
          open: true,
          hostId,
          currentPath: response?.currentPath || '',
          parentPath: response?.parentPath || null,
          roots: Array.isArray(response?.roots) ? response.roots : [],
          directories: Array.isArray(response?.directories) ? response.directories : [],
          loading: false,
          error: null,
        });
        return response;
      } catch (error) {
        if (sequence === requestSequence) update({ loading: false, error: text(error?.message) || 'Directory request failed.' });
        throw error;
      }
    }

    async function open() {
      const seedPath = text(getOpenSeedPath()).trim() || null;
      return fetchDirectoryListing(seedPath);
    }

    function close() {
      ++requestSequence;
      update({ open: false, loading: false, error: null });
    }

    async function browse(targetPath) {
      const normalized = text(targetPath).trim();
      return fetchDirectoryListing(normalized || null);
    }

    function apply() {
      const currentPath = text(pickerState().currentPath).trim();
      if (!currentPath) return false;
      onApply(currentPath);
      close();
      return true;
    }

    function bind() {
      if (bound || !document) return;
      const safe = (task) => Promise.resolve().then(task).catch(onError);
      getElement('close-directory-picker-button')?.addEventListener('click', close);
      getElement('directory-picker-overlay')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) close();
      });
      getElement('picker-up-button')?.addEventListener('click', () => {
        const parentPath = pickerState().parentPath;
        if (parentPath) safe(() => browse(parentPath));
      });
      getElement('picker-refresh-button')?.addEventListener('click', () => {
        safe(() => fetchDirectoryListing(pickerState().currentPath || null));
      });
      getElement('picker-select-button')?.addEventListener('click', apply);
      getElement('browse-directory-button')?.addEventListener('click', () => safe(open));
      bound = true;
    }

    return Object.freeze({
      apply,
      bind,
      browse,
      close,
      fetchDirectoryListing,
      open,
      render,
      setState: update,
    });
  }

  return Object.freeze({
    CLOSED_STATE,
    createDirectoryPickerController,
  });
}));
