const assert = require('assert');
const { EventEmitter } = require('events');

process.env.SSE_BACKPRESSURE_MAX_TOTAL_PENDING_BYTES = '65536';
process.env.SSE_BACKPRESSURE_MAX_CONNECTIONS = '4';
const { writeSseEvent } = require('../apps/relay/sse-writer');

const frames = [];
const writable = {
  destroyed: false,
  writableEnded: false,
  write(frame) {
    frames.push(frame);
    return true;
  },
};
assert.strictEqual(writeSseEvent(writable, 'session.snapshot', { ok: true }, { id: 'epoch:1' }), true);
assert.deepStrictEqual(frames, [
  'id: epoch:1\nevent: session.snapshot\ndata: {"ok":true}\n\n',
]);

let ended = 0;
let destroyed = 0;
const slow = new EventEmitter();
Object.assign(slow, {
  destroyed: false,
  writableEnded: false,
  writeCount: 0,
  write() {
    this.writeCount += 1;
    return this.writeCount > 1;
  },
  end() {
    ended += 1;
    this.writableEnded = true;
    this.emit('finish');
  },
  destroy() {
    destroyed += 1;
    this.destroyed = true;
    this.emit('close');
  },
});
assert.strictEqual(
  writeSseEvent(slow, 'session.activity', { text: 'x'.repeat(32 * 1024) }),
  true
);
assert.strictEqual(ended, 0, 'one full write buffer must wait for drain instead of closing');
assert.strictEqual(writeSseEvent(slow, 'ping', { ok: true }), true);
assert.strictEqual(ended, 0, 'events arriving before drain must use the bounded pending queue');
slow.emit('drain');
assert.strictEqual(writeSseEvent(slow, 'ping', { ok: true }), true);
assert.strictEqual(slow.writeCount, 3, 'drain must flush queued frames before accepting new writes');
assert.strictEqual(ended, 0, 'a drained response must remain subscribed');
assert.strictEqual(destroyed, 0, 'the response gets a grace period before forced destruction');

let sustainedEnded = 0;
let sustainedDestroyed = 0;
const sustained = new EventEmitter();
Object.assign(sustained, {
  destroyed: false,
  writableEnded: false,
  write() {
    return false;
  },
  end() {
    sustainedEnded += 1;
    this.writableEnded = true;
    this.emit('finish');
  },
  destroy() {
    sustainedDestroyed += 1;
    this.destroyed = true;
    this.emit('close');
  },
});
assert.strictEqual(writeSseEvent(sustained, 'session.activity', { text: 'large' }), true);
assert.strictEqual(
  writeSseEvent(sustained, 'session.activity', { text: 'x'.repeat(512 * 1024) }),
  false
);
assert.strictEqual(sustainedDestroyed, 1, 'exhausting the pending byte budget must destroy the slow response');
assert.strictEqual(writeSseEvent(sustained, 'ping', { ok: true }), false);
assert.strictEqual(sustainedDestroyed, 1, 'a closing response must reject later writes');

function makeGloballySlowResponse() {
  const response = new EventEmitter();
  Object.assign(response, {
    destroyed: false,
    writableEnded: false,
    ended: 0,
    writeCount: 0,
    write() {
      this.writeCount += 1;
      return false;
    },
    end() {
      this.ended += 1;
      this.writableEnded = true;
      this.emit('finish');
    },
    destroy() {
      this.destroyed = true;
      this.emit('close');
    },
  });
  return response;
}

const globalSlowA = makeGloballySlowResponse();
const globalSlowB = makeGloballySlowResponse();
const globalSlowC = makeGloballySlowResponse();
for (const response of [globalSlowA, globalSlowB, globalSlowC]) {
  assert.strictEqual(writeSseEvent(response, 'ready', { ok: true }), true);
}
assert.strictEqual(writeSseEvent(globalSlowA, 'session.activity', { text: 'a'.repeat(30000) }), true);
assert.strictEqual(writeSseEvent(globalSlowB, 'session.activity', { text: 'b'.repeat(30000) }), true);
assert.strictEqual(
  writeSseEvent(globalSlowC, 'session.activity', { text: 'c'.repeat(30000) }),
  false
);
assert.strictEqual(globalSlowC.destroyed, true, 'the global pending byte budget must reject excess slow clients');
globalSlowA.end();
globalSlowB.end();

const connectionLimited = Array.from({ length: 5 }, () => makeGloballySlowResponse());
for (let index = 0; index < connectionLimited.length; index += 1) {
  assert.strictEqual(
    writeSseEvent(connectionLimited[index], 'ready', { ok: true }),
    index < 4,
    'the global backpressure connection budget must reject excess slow clients'
  );
}
assert.strictEqual(connectionLimited[4].destroyed, true);
assert.strictEqual(connectionLimited[4].writeCount, 0, 'over-cap connections must be rejected before buffering a frame');
for (const response of connectionLimited.slice(0, 4)) response.end();

let thrownWriteDestroyed = false;
const broken = {
  destroyed: false,
  writableEnded: false,
  write() {
    throw new Error('socket closed');
  },
  destroy() {
    thrownWriteDestroyed = true;
  },
};
assert.strictEqual(writeSseEvent(broken, 'ping', {}), false);
assert.strictEqual(thrownWriteDestroyed, true);

console.log('SSE writer assertions passed');
