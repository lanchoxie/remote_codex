const assert = require('assert');
const { createController } = require('../apps/mobile-web/public/ui/session-search');
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
(async () => {
  let ctx = { query: '生肖', mode: 'keyword', hostId: 'a', collectionId: 'default' };
  let timer, calls = [], views = [], merged = [];
  const controller = createController({ getContext: () => ctx,
    setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => { timer = null; },
    request: value => { const d = deferred(); calls.push({ ...d, value }); return d.promise; },
    onChange: view => views.push(view), onResults: results => merged.push(...results),
  });
  await controller.schedule();
  assert.equal(controller.snapshot().phase, 'pending', 'two Chinese characters eligible; feedback is immediate');
  assert.equal(calls.length, 0, 'keep debounce to avoid redundant history scans');
  const first = timer();
  assert.equal(controller.snapshot().phase, 'searching');
  ctx.query = 'new query';
  await controller.schedule();
  calls[0].resolve({ results: [{ sessionId: 'old' }] }); await first;
  assert.equal(merged.length, 0, 'old response cannot overwrite during the NEW debounce window');
  const second = timer();
  calls[1].reject(new Error('offline')); await second;
  assert.equal(controller.snapshot().phase, 'error', 'failure stops loading and is visible');
  assert.equal(controller.snapshot().error, 'offline');
  const retry = controller.schedule({ immediate: true });
  calls[2].resolve({ results: [], source: 'relay-fallback', remoteError: 'remote timeout' }); await retry;
  assert.equal(controller.snapshot().partial, true, 'cached fallback is not reported as full-history success');
  const third = controller.schedule({ immediate: true });
  ctx.hostId = 'b';
  calls[3].resolve({ results: [{ sessionId: 'wrong-host' }] }); await third;
  assert.equal(merged.length, 0, 'host changes fence results even before next render');
  controller.sync(); assert.equal(controller.snapshot().phase, 'pending');
  const fourth = timer();
  ctx.collectionId = 'work'; controller.sync();
  calls[4].resolve({ results: [{ sessionId: 'wrong-collection' }] }); await fourth;
  assert.equal(merged.length, 0);
  ctx.query = ''; controller.sync();
  assert.equal(controller.snapshot().phase, 'idle'); assert.equal(timer, null);
  ctx.query = '字'; await controller.schedule(); assert.equal(controller.snapshot().phase, 'short');
  ctx.mode = 'title'; await controller.schedule(); assert.equal(controller.snapshot().phase, 'local');
  assert.equal(calls.length, 5, 'local modes and short queries do not request full history');
  controller.dispose();
  console.log('session search controller: immediate feedback, double-character search, stale fencing, errors and fallback passed');
})().catch(e => { console.error(e); process.exitCode=1; });
