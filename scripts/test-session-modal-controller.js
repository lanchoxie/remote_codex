'use strict';

const assert = require('assert');
const controllerModule = require('../apps/mobile-web/public/session-modal-controller.js');

function createHarness(selected = { sessionId: 'session-a' }) {
  const state = {
    sessionDetailsOpen: false,
    statusWindowOpen: false,
    alertWindowOpen: false,
  };
  const renders = [];
  const controller = controllerModule.createSessionModalController({
    getSelectedSession: () => selected,
    getState: () => state,
    renderSessionDetails: () => renders.push('details'),
    renderStatusWindow: () => renders.push('status'),
    renderAlertsWindow: () => renders.push('alerts'),
    syncModalBodyState: () => renders.push('sync'),
  });
  return { state, renders, controller };
}

function testExpectedSessionGuardAndNoStickyAlert() {
  let selected = { hostId: 'host-a', sessionId: 'session-a' };
  const state = { sessionDetailsOpen: false, statusWindowOpen: false, alertWindowOpen: false };
  const renders = [];
  const controller = controllerModule.createSessionModalController({
    getSelectedSession: () => selected,
    getState: () => state,
    renderAlertsWindow: () => renders.push('alerts'),
    syncModalBodyState: () => renders.push('sync'),
  });

  assert.strictEqual(
    controller.setAlertOpen(true, {
      expectedSession: { hostId: 'host-a', sessionId: 'session-old' },
    }),
    false,
    'an alert for an old Session must not open the current Session window'
  );
  assert.strictEqual(state.alertWindowOpen, false);
  assert.deepStrictEqual(renders, []);

  selected = null;
  assert.strictEqual(controller.setAlertOpen(true), false, 'alerts must fail closed without a selected Session');
  assert.strictEqual(state.alertWindowOpen, false);
  assert.deepStrictEqual(renders, []);
}

function testDetailsAndStatusShareOneSurface() {
  const harness = createHarness();
  assert.strictEqual(harness.controller.setDetailsOpen(true), true);
  assert.deepStrictEqual(
    harness.state,
    { sessionDetailsOpen: true, statusWindowOpen: false, alertWindowOpen: false }
  );
  assert.deepStrictEqual(harness.renders, ['details', 'status', 'sync']);

  harness.renders.length = 0;
  assert.strictEqual(harness.controller.setStatusOpen(true), true);
  assert.strictEqual(harness.state.sessionDetailsOpen, true);
  assert.strictEqual(harness.state.statusWindowOpen, true);
  assert.deepStrictEqual(harness.renders, ['details', 'status', 'sync']);

  harness.renders.length = 0;
  assert.strictEqual(harness.controller.setStatusOpen(false), true);
  assert.deepStrictEqual(
    harness.state,
    { sessionDetailsOpen: false, statusWindowOpen: false, alertWindowOpen: false }
  );
  assert.deepStrictEqual(harness.renders, ['details', 'status', 'sync']);
}

function testToggleAndAlerts() {
  const harness = createHarness();
  assert.strictEqual(harness.controller.toggleStatus(), true);
  assert.strictEqual(harness.state.statusWindowOpen, true);
  assert.strictEqual(harness.controller.toggleStatus(), true);
  assert.strictEqual(harness.state.statusWindowOpen, false);

  harness.renders.length = 0;
  assert.strictEqual(harness.controller.setAlertOpen(true), true);
  assert.strictEqual(harness.state.alertWindowOpen, true);
  assert.deepStrictEqual(harness.renders, ['alerts', 'sync']);
  assert.strictEqual(harness.controller.setAlertOpen(false), true);
  assert.strictEqual(harness.state.alertWindowOpen, false);
}

function testNoSelectedSessionIsFailClosed() {
  const harness = createHarness(null);
  assert.strictEqual(harness.controller.setDetailsOpen(true), false);
  assert.strictEqual(harness.controller.setStatusOpen(true), false);
  assert.strictEqual(harness.controller.toggleStatus(), false);
  harness.renders.length = 0;
  assert.strictEqual(harness.controller.setAlertOpen(true), false);
  assert.deepStrictEqual(
    harness.state,
    { sessionDetailsOpen: false, statusWindowOpen: false, alertWindowOpen: false }
  );
  assert.deepStrictEqual(harness.renders, []);
}

testDetailsAndStatusShareOneSurface();
testToggleAndAlerts();
testNoSelectedSessionIsFailClosed();
testExpectedSessionGuardAndNoStickyAlert();
console.log('session modal controller assertions passed');
