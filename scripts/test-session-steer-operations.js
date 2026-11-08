const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '../apps/relay/session-steer-operations.js');
assert.ok(fs.existsSync(file), 'Steer requires its own bounded operation registry');
const { createSessionSteerOperations } = require(file);
const store = createSessionSteerOperations({ limit: 2 });
const target = { hostId: 'host', sessionId: 'session', requestId: 'request', runId: 'run', expectedTurnId: 'turn', text: 'guide' };
let enqueues = 0;
const enqueue = () => ({ commandId: ++enqueues });
const first = store.begin(target, enqueue);
assert.equal(first.status, 'queued');
assert.equal(first.text, undefined, 'status API must not echo prompt contents');
assert.deepEqual(store.begin(target, enqueue), first);
assert.equal(enqueues, 1);
assert.throws(() => store.begin({ ...target, text: 'changed' }, enqueue), { code: 'steer_request_id_conflict' });
const event = { ...target, commandId: 1, status: 'accepted', turnId: 'turn' };
for (const [key, value] of [['hostId', 'other'], ['sessionId', 'other'], ['runId', 'other'], ['expectedTurnId', 'other'], ['commandId', 44], ['turnId', 'other']]) {
  assert.equal(store.resolve({ ...event, [key]: value }), null, `mismatched ${key} must not acknowledge a different request`);
}
assert.equal(store.get('host', 'request').status, 'queued');
assert.equal(store.resolve(event).status, 'accepted');
assert.equal(store.resolve({ ...event, status: 'rejected' }).status, 'accepted', 'late conflicting result cannot downgrade accepted');
assert.equal(store.begin(target, enqueue).status, 'accepted');
store.begin({ ...target, requestId: 'two' }, enqueue);
assert.throws(() => store.begin({ ...target, requestId: 'three' }, enqueue), { code: 'steer_capacity' });
assert.equal(enqueues, 2);
assert.equal(store.get('other', 'request'), null);
console.log('steer registry identity, idempotence, bounded memory and immutable result tests passed');
