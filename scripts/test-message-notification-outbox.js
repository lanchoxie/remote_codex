const assert = require('assert');

const {
  NotificationOutbox,
  acquireStorageLease,
  alertIdFor,
  drainOutboxWithElection,
  releaseStorageLease,
} = require('../apps/mobile-web/public/message-notification-client');

async function main() {
  const storage = new Map();
  const inApp = new Map();
  const system = new Map();
  const outbox = new NotificationOutbox({
    load: () => JSON.parse(storage.get('outbox') || '{}'),
    save: (value) => storage.set('outbox', JSON.stringify(value)),
    now: () => '2026-07-16T10:00:00.000Z',
  });
  const message = {
    canonicalConversationKey: 'host::native',
    assistantMessageId: 'assistant:sha256:abc',
    assistantSeq: 7,
    assistantAt: '2026-07-16T09:59:00.000Z',
    previewText: 'done',
  };
  const id = alertIdFor(message.canonicalConversationKey, message.assistantMessageId);
  assert.strictEqual(outbox.enqueue(message).alertId, id);
  assert.strictEqual(outbox.enqueue({ ...message, previewText: 'updated' }).alertId, id);
  assert.strictEqual(Object.keys(outbox.all()).length, 1);

  const beforeInApp = new NotificationOutbox({ load: () => ({}), save: () => {} });
  const beforeInAppItem = beforeInApp.enqueue({ ...message, assistantMessageId: 'before-in-app' });
  let beforeInAppSystemCalls = 0;
  let beforeInAppAdvances = 0;
  await assert.rejects(beforeInApp.drain({
    presentInApp: async () => { throw new Error('crash-before-in-app'); },
    presentSystem: async () => {
      beforeInAppSystemCalls += 1;
      return { presented: true };
    },
    advanceNotified: async () => { beforeInAppAdvances += 1; },
  }), /crash-before-in-app/);
  assert.strictEqual(beforeInApp.get(beforeInAppItem.alertId).status, 'pending');
  assert.strictEqual(beforeInAppSystemCalls, 0);
  assert.strictEqual(beforeInAppAdvances, 0);

  const afterInApp = new NotificationOutbox({ load: () => ({}), save: () => {} });
  const afterInAppItem = afterInApp.enqueue({ ...message, assistantMessageId: 'after-in-app' });
  let afterInAppAdvances = 0;
  await assert.rejects(afterInApp.drain({
    presentInApp: async () => {},
    presentSystem: async () => { throw new Error('crash-after-in-app'); },
    advanceNotified: async () => { afterInAppAdvances += 1; },
  }), /crash-after-in-app/);
  assert.strictEqual(afterInApp.get(afterInAppItem.alertId).status, 'pending');
  assert.strictEqual(afterInAppAdvances, 0);

  await assert.rejects(outbox.drain({
    presentInApp: async (item) => inApp.set(item.alertId, item),
    presentSystem: async (item) => {
      system.set(item.alertId, item.alertId);
      return { presented: true };
    },
    advanceNotified: async () => { throw new Error('crash-before-cursor'); },
  }), /crash-before-cursor/);
  assert.strictEqual(inApp.size, 1);
  assert.strictEqual(system.size, 1);
  assert.strictEqual(outbox.get(id).status, 'pending');

  let advanced = 0;
  await outbox.drain({
    presentInApp: async (item) => inApp.set(item.alertId, item),
    presentSystem: async (item) => {
      system.set(item.alertId, item.alertId);
      return { presented: true };
    },
    advanceNotified: async () => { advanced += 1; },
  });
  assert.strictEqual(outbox.get(id).status, 'presented');
  assert.strictEqual(inApp.size, 1);
  assert.strictEqual(system.size, 1);
  assert.strictEqual(advanced, 1);

  const pending = new NotificationOutbox({
    load: () => ({}),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
  });
  pending.enqueue({ ...message, assistantMessageId: 'second' });
  let lockCalls = 0;
  let presentations = 0;
  const navigator = {
    locks: {
      async request(name, options, callback) {
        lockCalls += 1;
        assert.strictEqual(name, 'mobile-codex-remote.notification-outbox');
        assert.strictEqual(options.ifAvailable, true);
        return callback(lockCalls === 1 ? { name } : null);
      },
    },
  };
  const presenters = {
    presentInApp: async () => { presentations += 1; },
    presentSystem: async () => ({ explicitlyUnavailable: true }),
    advanceNotified: async () => {},
  };
  await Promise.all([
    drainOutboxWithElection({ navigator, outbox: pending, presenters }),
    drainOutboxWithElection({ navigator, outbox: pending, presenters }),
  ]);
  assert.strictEqual(presentations, 1, 'only the elected tab may drain the outbox');

  const leaseValues = new Map();
  const leaseStorage = {
    getItem: (key) => leaseValues.get(key) || null,
    setItem: (key, value) => leaseValues.set(key, value),
    removeItem: (key) => leaseValues.delete(key),
  };
  const lease = acquireStorageLease({
    storage: leaseStorage,
    ownerId: 'tab-a',
    nonce: 'lease-a',
    now: () => 1000,
  });
  assert(lease);
  assert.strictEqual(acquireStorageLease({
    storage: leaseStorage,
    ownerId: 'tab-b',
    nonce: 'lease-b',
    now: () => 1001,
  }), null, 'an unexpired lease must exclude a second tab');
  assert.strictEqual(releaseStorageLease({ storage: leaseStorage }, lease), true);

  const fallback = new NotificationOutbox({
    load: () => ({}),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
  });
  fallback.enqueue({ ...message, assistantMessageId: 'lease-message' });
  let fallbackPresentations = 0;
  await drainOutboxWithElection({
    navigator: {},
    storage: leaseStorage,
    ownerId: 'tab-a',
    outbox: fallback,
    presenters: {
      presentInApp: async () => { fallbackPresentations += 1; },
      presentSystem: async () => ({ explicitlyUnavailable: true }),
      advanceNotified: async () => {},
    },
  });
  assert.strictEqual(fallbackPresentations, 1, 'localStorage lease should drain when Web Locks is unavailable');

  const enqueueDuringDrain = new NotificationOutbox({
    load: () => ({}),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
  });
  const firstDuringDrain = enqueueDuringDrain.enqueue({
    ...message,
    assistantMessageId: 'enqueue-during-drain-a',
  });
  let secondDuringDrain = null;
  const duringDrainPresentations = [];
  await enqueueDuringDrain.drain({
    presentInApp: async (item) => { duringDrainPresentations.push(item.assistantMessageId); },
    presentSystem: async (item) => {
      if (item.alertId === firstDuringDrain.alertId) {
        secondDuringDrain = enqueueDuringDrain.enqueue({
          ...message,
          assistantMessageId: 'enqueue-during-drain-b',
        });
      }
      return { explicitlyUnavailable: true };
    },
    advanceNotifiedBatch: async () => {},
  });
  assert.strictEqual(enqueueDuringDrain.get(firstDuringDrain.alertId).status, 'presented');
  assert.strictEqual(enqueueDuringDrain.get(secondDuringDrain.alertId).status, 'presented');
  assert.deepStrictEqual(
    duringDrainPresentations,
    ['enqueue-during-drain-a', 'enqueue-during-drain-b'],
    'a notification enqueued during drain must be handled by the same drain chain'
  );

  const blockedDuringDrain = new NotificationOutbox({
    load: () => ({}),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
  });
  const blockedItem = blockedDuringDrain.enqueue({ ...message, assistantMessageId: 'blocked-old' });
  let freshItem = null;
  const blockedPresentations = [];
  await blockedDuringDrain.drain({
    presentInApp: async (item) => { blockedPresentations.push(item.assistantMessageId); },
    presentSystem: async (item) => {
      if (item.alertId === blockedItem.alertId && !freshItem) {
        freshItem = blockedDuringDrain.enqueue({ ...message, assistantMessageId: 'fresh-during-blocked' });
        return { presented: false };
      }
      return { explicitlyUnavailable: true };
    },
    advanceNotifiedBatch: async () => {},
  });
  assert.strictEqual(blockedDuringDrain.get(blockedItem.alertId).status, 'pending');
  assert.strictEqual(blockedDuringDrain.get(freshItem.alertId).status, 'presented');
  assert.deepStrictEqual(
    blockedPresentations,
    ['blocked-old', 'fresh-during-blocked'],
    'follow-up drain must not repeatedly present an unchanged permission-blocked item'
  );

  const updatedDuringDrain = new NotificationOutbox({
    load: () => ({}),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
  });
  updatedDuringDrain.enqueue({
    ...message,
    assistantMessageId: 'updated-during-drain',
    previewText: 'v1',
  });
  const updatedPreviews = [];
  await updatedDuringDrain.drain({
    presentInApp: async (item) => { updatedPreviews.push(item.previewText); },
    presentSystem: async (item) => {
      if (item.previewText === 'v1') {
        updatedDuringDrain.enqueue({ ...item, previewText: 'v2' });
      }
      return { explicitlyUnavailable: true };
    },
    advanceNotifiedBatch: async () => {},
  });
  assert.deepStrictEqual(
    updatedPreviews,
    ['v1', 'v2'],
    'an alert revision updated during presentation must receive its own follow-up presentation'
  );

  const updatedDuringAdvance = new NotificationOutbox({
    load: () => ({}),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
  });
  updatedDuringAdvance.enqueue({
    ...message,
    assistantMessageId: 'updated-during-advance',
    previewText: 'advance-v1',
  });
  const advancePreviews = [];
  let advanceUpdates = 0;
  await updatedDuringAdvance.drain({
    presentInApp: async (item) => { advancePreviews.push(item.previewText); },
    presentSystem: async () => ({ explicitlyUnavailable: true }),
    advanceNotifiedBatch: async (items) => {
      if (items[0]?.previewText === 'advance-v1' && advanceUpdates === 0) {
        advanceUpdates += 1;
        updatedDuringAdvance.enqueue({
          ...items[0],
          previewText: 'advance-v2',
        });
      }
    },
  });
  assert.deepStrictEqual(
    advancePreviews,
    ['advance-v1', 'advance-v2'],
    'an alert updated while its receipt advances must not mark the newer revision presented'
  );

  let crossTabDurable = {};
  const crossTabRevision = new NotificationOutbox({
    load: () => JSON.parse(JSON.stringify(crossTabDurable)),
    save: (value) => { crossTabDurable = JSON.parse(JSON.stringify(value)); },
    now: () => '2026-07-16T10:00:00.000Z',
  });
  const crossTabItem = crossTabRevision.enqueue({
    ...message,
    assistantMessageId: 'cross-tab-revision',
    previewText: 'cross-v1',
  });
  const crossTabPreviews = [];
  await crossTabRevision.drain({
    presentInApp: async (item) => { crossTabPreviews.push(item.previewText); },
    presentSystem: async (item) => {
      if (item.previewText === 'cross-v1') {
        crossTabDurable.items[crossTabItem.alertId] = {
          ...crossTabDurable.items[crossTabItem.alertId],
          previewText: 'cross-v2',
          revision: 2,
          status: 'pending',
        };
      }
      return { explicitlyUnavailable: true };
    },
    advanceNotifiedBatch: async () => {},
  });
  assert.deepStrictEqual(
    crossTabPreviews,
    ['cross-v1', 'cross-v2'],
    'a newer durable revision discovered while saving must trigger a follow-up drain'
  );
  assert.strictEqual(crossTabDurable.items[crossTabItem.alertId].status, 'presented');
  assert.strictEqual(crossTabDurable.items[crossTabItem.alertId].revision, 2);

  const failureFollowUp = new NotificationOutbox({
    load: () => ({}),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
  });
  failureFollowUp.enqueue({ ...message, assistantMessageId: 'failure-first' });
  let failureSecond = null;
  await assert.rejects(failureFollowUp.drain({
    presentInApp: async (item) => {
      if (item.assistantMessageId === 'failure-first') {
        failureSecond = failureFollowUp.enqueue({ ...message, assistantMessageId: 'failure-second' });
        throw new Error('injected presenter failure with follow-up');
      }
    },
    presentSystem: async () => ({ explicitlyUnavailable: true }),
    advanceNotifiedBatch: async () => {},
  }), /injected presenter failure with follow-up/);
  assert.strictEqual(
    failureFollowUp.get(failureSecond.alertId).status,
    'presented',
    'a failed item must not prevent a newly requested follow-up from draining'
  );

  let retryDurable = {};
  let failPresentedSave = true;
  let retryPresentations = 0;
  let persistErrors = 0;
  const retryPresented = new NotificationOutbox({
    load: () => JSON.parse(JSON.stringify(retryDurable)),
    save: (value) => {
      if (
        failPresentedSave
        && Object.values(value.items || {}).some((item) => item.status === 'presented')
      ) {
        failPresentedSave = false;
        throw new Error('injected presented save failure');
      }
      retryDurable = JSON.parse(JSON.stringify(value));
    },
    runExclusive: (callback) => Promise.resolve().then(callback),
    onPersistError: () => { persistErrors += 1; },
    now: () => '2026-07-16T10:00:00.000Z',
  });
  const retryPresentedItem = retryPresented.enqueue({
    ...message,
    assistantMessageId: 'retry-presented-save',
  });
  await retryPresented.whenIdle();
  await assert.rejects(retryPresented.drain({
    presentInApp: async () => { retryPresentations += 1; },
    presentSystem: async () => ({ explicitlyUnavailable: true }),
    advanceNotifiedBatch: async () => {},
  }), /injected presented save failure/);
  assert.strictEqual(retryPresented.get(retryPresentedItem.alertId).status, 'presented');
  assert.strictEqual(persistErrors, 1, 'ordinary save failures must request a persistence retry');
  await retryPresented.drain({
    presentInApp: async () => { retryPresentations += 1; },
    presentSystem: async () => ({ explicitlyUnavailable: true }),
    advanceNotifiedBatch: async () => {},
  });
  assert.strictEqual(retryPresentations, 1, 'retrying dirty presented state must not present the alert twice');
  assert.strictEqual(
    retryDurable.items[retryPresentedItem.alertId].status,
    'presented',
    'a later drain must durably retry the presented transition'
  );

  const revisionId = alertIdFor('revision-merge', 'revision-message');
  let revisionDurable = {
    version: 1,
    items: {
      [revisionId]: {
        alertId: revisionId,
        canonicalConversationKey: 'revision-merge',
        assistantMessageId: 'revision-message',
        assistantSeq: 1,
        previewText: 'old',
        revision: 1,
        status: 'pending',
      },
    },
  };
  const revisionMerge = new NotificationOutbox({
    load: () => JSON.parse(JSON.stringify(revisionDurable)),
    save: (value) => { revisionDurable = JSON.parse(JSON.stringify(value)); },
  });
  revisionMerge.items[revisionId].status = 'presented';
  revisionMerge.dirty = true;
  revisionDurable.items[revisionId] = {
    ...revisionDurable.items[revisionId],
    previewText: 'new',
    revision: 2,
    status: 'pending',
  };
  revisionMerge.flush();
  assert.strictEqual(revisionMerge.get(revisionId).revision, 2);
  assert.strictEqual(revisionMerge.get(revisionId).status, 'pending');
  assert.strictEqual(revisionMerge.get(revisionId).previewText, 'new');

  let boundedStorage = {
    version: 1,
    items: Object.fromEntries([
      ...Array.from({ length: 4 }, (_, index) => [`presented-${index}`, {
        alertId: `presented-${index}`,
        assistantMessageId: `presented-${index}`,
        assistantSeq: index + 1,
        canonicalConversationKey: 'bounded',
        status: 'presented',
        updatedAt: `2026-07-16T09:0${index}:00.000Z`,
      }]),
      ...Array.from({ length: 2 }, (_, index) => [`pending-${index}`, {
        alertId: `pending-${index}`,
        assistantMessageId: `pending-${index}`,
        assistantSeq: index + 10,
        canonicalConversationKey: 'bounded',
        status: 'pending',
        updatedAt: `2026-07-16T09:1${index}:00.000Z`,
      }]),
    ]),
  };
  const bounded = new NotificationOutbox({
    load: () => JSON.parse(JSON.stringify(boundedStorage)),
    save: (value) => { boundedStorage = JSON.parse(JSON.stringify(value)); },
    now: () => '2026-07-16T10:00:00.000Z',
    presentedLimit: 2,
  });
  assert.strictEqual(Object.values(bounded.all()).filter((item) => item.status === 'presented').length, 2);
  assert.strictEqual(Object.values(bounded.all()).filter((item) => item.status === 'pending').length, 2);
  const reopenedBounded = new NotificationOutbox({
    load: () => JSON.parse(JSON.stringify(boundedStorage)),
    save: () => {},
    now: () => '2026-07-16T10:00:00.000Z',
    presentedLimit: 2,
  });
  assert.strictEqual(
    Object.values(reopenedBounded.all()).filter((item) => item.status === 'presented').length,
    2,
    'presented outbox retention must survive reopening'
  );

  const sharedValues = new Map();
  const sharedOptions = {
    load: () => JSON.parse(sharedValues.get('outbox') || '{}'),
    save: (value) => sharedValues.set('outbox', JSON.stringify(value)),
    now: () => '2026-07-16T10:00:00.000Z',
  };
  const staleTabA = new NotificationOutbox(sharedOptions);
  const staleTabB = new NotificationOutbox(sharedOptions);
  staleTabA.enqueue({ ...message, assistantMessageId: 'tab-a-message' });
  staleTabB.enqueue({ ...message, assistantMessageId: 'tab-b-message' });
  const reopenedShared = new NotificationOutbox(sharedOptions);
  assert.strictEqual(
    Object.keys(reopenedShared.all()).length,
    2,
    'a stale tab enqueue must merge durable outbox items instead of overwriting them'
  );

  let bulkStorage = {};
  let bulkSaves = 0;
  let bulkPersistEvents = 0;
  const bulk = new NotificationOutbox({
    load: () => JSON.parse(JSON.stringify(bulkStorage)),
    save: (value) => {
      bulkSaves += 1;
      bulkStorage = JSON.parse(JSON.stringify(value));
    },
    onPersist: () => { bulkPersistEvents += 1; },
    now: () => '2026-07-16T10:00:00.000Z',
  });
  bulk.batch((target) => {
    for (let index = 0; index < 739; index += 1) {
      target.enqueue({
        canonicalConversationKey: `bulk::${index}`,
        assistantMessageId: `assistant-${index}`,
        assistantSeq: index + 1,
        previewText: `message ${index}`,
        hostId: 'bulk-host',
        sessionId: `bulk-${index}`,
      });
    }
  });
  assert.strictEqual(bulkSaves, 1, '739 pending notifications must persist in one batch');
  assert.strictEqual(bulkPersistEvents, 1, 'a notification batch must broadcast once');
  assert.strictEqual(Object.keys(new NotificationOutbox({ load: () => bulkStorage }).all()).length, 739);
  bulkSaves = 0;
  bulkPersistEvents = 0;
  bulk.batch((target) => {
    for (let index = 0; index < 739; index += 1) {
      target.enqueue({
        canonicalConversationKey: `bulk::${index}`,
        assistantMessageId: `assistant-${index}`,
        assistantSeq: index + 1,
        previewText: `message ${index}`,
        hostId: 'bulk-host',
        sessionId: `bulk-${index}`,
      });
    }
  });
  assert.strictEqual(bulkSaves, 0, 'unchanged pending notifications must not rewrite storage');
  assert.strictEqual(bulkPersistEvents, 0, 'unchanged pending notifications must not broadcast');
  let bulkAdvanced = 0;
  await bulk.drain({
    presentInApp: async () => {},
    presentSystem: async () => ({ explicitlyUnavailable: true }),
    advanceNotifiedBatch: async (items) => { bulkAdvanced += items.length; },
  });
  assert.strictEqual(bulkAdvanced, 739);
  assert(bulkSaves > 0, 'draining notifications must durably persist presented state');
  assert(
    bulkSaves <= Math.ceil(739 / 50),
    `draining 739 notifications must persist by chunk; wrote ${bulkSaves} times`
  );
  assert(
    Object.values(bulk.all()).every((item) => item.status === 'presented'),
    'every successfully advanced notification must become presented'
  );
  assert(
    Object.values(new NotificationOutbox({ load: () => bulkStorage }).all())
      .every((item) => item.status === 'presented'),
    'presented status must survive reopening the outbox'
  );

  console.log('message notification outbox assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
