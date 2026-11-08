'use strict';

const assert = require('assert/strict');
const storeApi = require('../apps/mobile-web/public/ui/composer-queue-store');

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => values.delete(key),
    values,
  };
}

async function main() {
  const storage = memoryStorage();
  const store = storeApi.createQueueStore({ storage, logger: { warn() {} } });
  const remote = {
    id: 'remote', sessionKey: 'host::session', hostId: 'host', sessionId: 'session', text: 'remote file',
    payload: { text: 'remote file', uploadedFiles: [{ name: 'a.xyz', remotePath: '/tmp/a.xyz', fileObject: { ignored: true } }] },
    status: 'queued', createdAt: '2026-10-09T00:00:00.000Z', sending: false, forceSending: false,
  };
  const local = {
    id: 'local', sessionKey: 'host::session', hostId: 'host', sessionId: 'session', text: 'local file',
    payload: { text: 'local file', composerDraft: { text: 'local file', attachments: [{ type: 'uploadFile', name: 'b.xyz', fileObject: { size: 4 } }] } },
    status: 'queued', createdAt: '2026-10-09T00:00:00.000Z', sending: false, forceSending: false,
  };
  const sending = { ...remote, id: 'sending', sending: true };
  const guided = { ...remote, id: 'guided', status: 'guided' };
  assert.equal(store.save([remote, local, sending, guided]).ok, true);
  const loaded = store.load();
  assert.equal(loaded.items.length, 3, 'completed Guide entries are not restored');
  assert.equal(loaded.items.find((item) => item.id === 'remote').status, 'queued');
  assert.equal(loaded.items.find((item) => item.id === 'sending').status, 'recovery_required');
  const localRestored = loaded.items.find((item) => item.id === 'local');
  assert.equal(localRestored.status, 'recovery_required');
  assert.equal(localRestored.payload.composerDraft.attachments[0].fileObject, undefined);
  assert.equal(localRestored.payload.composerDraft.attachments[0].recoveryRequired, true);
  assert.equal(loaded.items.find((item) => item.id === 'remote').payload.uploadedFiles[0].remotePath, '/tmp/a.xyz');

  storage.setItem(store.key, '{bad json');
  assert.equal(store.load().warning, 'storage_read_failed');
  const quota = storeApi.createQueueStore({ storage: { setItem() { throw new Error('quota'); } }, logger: { warn() {} } });
  assert.equal(quota.save([remote]).ok, false, 'quota failure fails closed without throwing');
  console.log('composer queue store: safe attachment filtering, recovery statuses, completed filtering and storage failures passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
