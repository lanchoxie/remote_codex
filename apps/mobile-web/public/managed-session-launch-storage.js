(function init(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexManagedSessionLaunchStorage = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  const DATABASE_NAME = 'remote-codex-managed-launch.v1';
  const LEGACY_LEDGER_KEY = 'mobile-codex-remote.session-launch-receipts.v1';
  const CHANGE_KEY = 'remote-codex:managed-launch-change:v1';
  const MAX_CLICK_AGE_MS = 24 * 60 * 60 * 1000;
  const COMPLETED_RETENTION_MS = 7 * MAX_CLICK_AGE_MS;

  function storageError(message, code = 'cross-tab-lock-unavailable') {
    return Object.assign(new Error(message), { code });
  }

  function createLaunchStorage(options = {}) {
    const indexedDB = options.indexedDB || root.indexedDB;
    const navigator = options.navigator || root.navigator;
    const storage = options.storage || root.localStorage;
    const listeners = new Set();
    let databasePromise = null;

    function database() {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise((resolve, reject) => {
        if (!indexedDB?.open) {
          reject(storageError('Session coordination requires browser IndexedDB storage.'));
          return;
        }
        const request = indexedDB.open(options.databaseName || DATABASE_NAME, 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('ledger')) db.createObjectStore('ledger');
          const intents = db.objectStoreNames.contains('intents')
            ? request.transaction.objectStore('intents') : db.createObjectStore('intents');
          if (!intents.indexNames.contains('completedAtMs')) intents.createIndex('completedAtMs', 'completedAtMs');
        };
        request.onerror = () => reject(storageError('Session coordination storage could not be opened.'));
        request.onblocked = () => reject(storageError('Session coordination storage is blocked by another page.'));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); databasePromise = null; };
          resolve(db);
        };
      }).catch((error) => { databasePromise = null; throw error; });
      return databasePromise;
    }

    // Callbacks must be synchronous. No network request, timer, async callback,
    // or busy keepalive can extend these short atomic transactions.
    async function mutate(storeName, key, update, linkedStores = []) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([storeName, ...linkedStores], 'readwrite');
        const store = tx.objectStore(storeName);
        let result;
        let failure;
        let changed = false;
        tx.oncomplete = () => resolve({ result, changed });
        tx.onabort = () => reject(failure || storageError('Session coordination storage transaction failed.', 'launch-storage-failed'));
        tx.onerror = () => { /* onabort carries the transaction failure. */ };
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const mutation = update(request.result, tx);
            if (!mutation || typeof mutation.then === 'function') throw new TypeError('Launch storage mutations must be synchronous.');
            result = mutation.result;
            if (Object.prototype.hasOwnProperty.call(mutation, 'value')) {
              changed = request.result !== mutation.value;
              if (changed) store.put(mutation.value, key);
            }
          } catch (error) { failure = error; tx.abort(); }
        };
      });
    }

    function notify() {
      // Other tabs re-read IndexedDB. Keep the legacy ledger untouched so a
      // failed migration cannot erase browser receipts from the previous build.
      try { storage.setItem(CHANGE_KEY, `${Date.now()}:${Math.random()}`); } catch (_) { /* IndexedDB is authoritative. */ }
    }

    async function mutateLedger(update) {
      let completedIntent = false;
      const mutation = await mutate('ledger', 'current', (saved, tx) => {
        const raw = saved === undefined ? storage.getItem(LEGACY_LEDGER_KEY) : saved;
        const next = update(raw == null ? null : raw);
        if (!next || typeof next.then === 'function') throw new TypeError('Ledger mutations must be synchronous.');
        // Terminal receipts and their intent tombstones commit together. Closing
        // a page after this transaction cannot leave an unknown orphan intent.
        const intents = tx.objectStore('intents');
        for (const receipt of next.completedReceipts || []) {
          if (!receipt.intentKey || !receipt.clientRequestId) continue;
          const request = intents.get(receipt.intentKey);
          request.onsuccess = () => {
            const savedIntent = request.result;
            if (savedIntent?.clientRequestId !== receipt.clientRequestId || savedIntent.completedAtMs) return;
            intents.put({ ...savedIntent, completedAtMs: Date.now() }, receipt.intentKey);
            completedIntent = true;
          };
        }
        return { value: next.raw, result: next.result };
      }, ['intents']);
      if (mutation.changed) notify();
      if (completedIntent) void pruneCompletedIntents().catch(() => {});
      return mutation.result;
    }

    async function readLedger() {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('ledger', 'readonly');
        const request = tx.objectStore('ledger').get('current');
        request.onsuccess = () => {
          try { resolve(request.result === undefined ? storage.getItem(LEGACY_LEDGER_KEY) : request.result); }
          catch (error) { reject(error); }
        };
        request.onerror = () => reject(request.error);
      });
    }

    async function claimIntent(intentKey, proposedId, startedAtMs, expectation = null) {
      if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs > MAX_CLICK_AGE_MS || startedAtMs > Date.now() + 60_000) {
        throw storageError('This queued Session action is too old. Start a new action from the current page.', 'launch-intent-stale');
      }
      const result = await mutate('intents', intentKey, (saved) => {
        if (saved !== undefined) {
          if (saved?.version !== 1 || typeof saved.clientRequestId !== 'string' || !saved.clientRequestId) {
            throw storageError('A saved Session submission needs recovery; it was not overwritten.', 'launch-submission-invalid');
          }
          // Unknown submissions never expire. A completed tombstone also
          // captures a click queued before completion in another/background tab.
          if (!saved.completedAtMs || startedAtMs <= saved.completedAtMs) return { result: saved };
        }
        const clientRequestId = String(proposedId || '').trim();
        if (!clientRequestId) throw new TypeError('A stable Session request ID is required.');
        const value = { version: 1, clientRequestId, startedAtMs, completedAtMs: null, expectation };
        return { value, result: value };
      });
      return result.result;
    }

    async function completeIntent(intentKey, clientRequestId) {
      if (!intentKey || !clientRequestId) return false;
      const result = await mutate('intents', intentKey, (saved) => {
        if (saved?.clientRequestId !== clientRequestId || saved.completedAtMs) return { result: false };
        return { value: { ...saved, completedAtMs: Date.now() }, result: true };
      });
      if (result.result) void pruneCompletedIntents().catch(() => {});
      return result.result;
    }

    async function pruneCompletedIntents() {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('intents', 'readwrite');
        const index = tx.objectStore('intents').index('completedAtMs');
        const request = index.openCursor();
        let removed = 0;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || removed >= 32 || Number(cursor.key) >= Date.now() - COMPLETED_RETENTION_MS) return;
          cursor.delete();
          removed += 1;
          cursor.continue();
        };
        tx.oncomplete = () => resolve(removed);
        tx.onabort = () => reject(tx.error);
      });
    }

    function withIntent(name, operation) {
      if (navigator?.locks?.request) return navigator.locks.request(name, { mode: 'exclusive' }, operation);
      // HTTP has no Web Locks. claimIntent supplies the common request ID;
      // Relay idempotency and expected-run fencing protect network submissions.
      // There is deliberately no expiring lease or long IndexedDB transaction.
      return Promise.resolve().then(operation);
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
    const onStorage = (event) => {
      if (event.key === CHANGE_KEY) listeners.forEach((listener) => listener());
    };
    root.addEventListener?.('storage', onStorage);
    function dispose() {
      root.removeEventListener?.('storage', onStorage);
      listeners.clear();
      databasePromise?.then((db) => db.close()).catch(() => {});
      databasePromise = null;
    }
    return Object.freeze({ readLedger, mutateLedger, claimIntent, completeIntent, withIntent, subscribe, dispose });
  }
  return Object.freeze({ createLaunchStorage, DATABASE_NAME, LEGACY_LEDGER_KEY });
}));
