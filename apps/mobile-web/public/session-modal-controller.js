(function initSessionModalController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexSessionModal = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  function createSessionModalController(options = {}) {
    const getSelectedSession = typeof options.getSelectedSession === 'function'
      ? options.getSelectedSession
      : () => null;
    const getState = typeof options.getState === 'function'
      ? options.getState
      : () => ({});
    const renderSessionDetails = typeof options.renderSessionDetails === 'function'
      ? options.renderSessionDetails
      : () => {};
    const renderStatusWindow = typeof options.renderStatusWindow === 'function'
      ? options.renderStatusWindow
      : () => {};
    const renderAlertsWindow = typeof options.renderAlertsWindow === 'function'
      ? options.renderAlertsWindow
      : () => {};
    const syncModalBodyState = typeof options.syncModalBodyState === 'function'
      ? options.syncModalBodyState
      : () => {};

    function hasSelectedSession() {
      return Boolean(getSelectedSession());
    }

    function renderDetailsSurface() {
      renderSessionDetails();
      renderStatusWindow();
      syncModalBodyState();
    }

    function setDetailsOpen(open) {
      const state = getState();
      const hasSession = hasSelectedSession();
      const shouldOpen = Boolean(open) && hasSession;
      state.sessionDetailsOpen = shouldOpen;
      state.statusWindowOpen = false;
      renderDetailsSurface();
      return hasSession;
    }

    function setStatusOpen(open) {
      const state = getState();
      const hasSession = hasSelectedSession();
      const shouldOpen = Boolean(open) && hasSession;
      // Status is a view inside Session Details. Both flags therefore move
      // together whenever the status surface is opened.
      state.statusWindowOpen = shouldOpen;
      state.sessionDetailsOpen = shouldOpen;
      renderDetailsSurface();
      return hasSession;
    }

    function toggleStatus() {
      if (!hasSelectedSession()) return false;
      const state = getState();
      return setStatusOpen(!(state.sessionDetailsOpen || state.statusWindowOpen));
    }

    function setAlertOpen(open, options = {}) {
      const selected = getSelectedSession();
      const expected = options.expectedSession;
      if (expected && (!selected
        || selected.hostId !== expected.hostId
        || selected.sessionId !== expected.sessionId)) {
        return false;
      }
      if (!selected) {
        return false;
      }
      const state = getState();
      state.alertWindowOpen = Boolean(open);
      if (options.render !== false) {
        renderAlertsWindow();
        syncModalBodyState();
      }
      return true;
    }

    function toggleAlert() {
      if (!hasSelectedSession()) return false;
      const state = getState();
      return setAlertOpen(!state.alertWindowOpen);
    }

    function closeIfNoSelectedSession() {
      if (hasSelectedSession()) return false;
      const state = getState();
      // Called while rendering selection changes; the caller owns rendering.
      state.sessionDetailsOpen = false;
      state.statusWindowOpen = false;
      state.alertWindowOpen = false;
      return true;
    }

    return Object.freeze({
      setDetailsOpen,
      setStatusOpen,
      toggleStatus,
      setAlertOpen,
      toggleAlert,
      closeIfNoSelectedSession,
    });
  }

  return Object.freeze({ createSessionModalController });
}));
