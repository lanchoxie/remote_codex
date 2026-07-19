const assert = require('assert');

const { createScrollMachine } = require('../apps/mobile-web/public/transcript-scroll');

function fakeScroller({ scrollTop = 0, scrollHeight = 1000, clientHeight = 200, anchors = [] } = {}) {
  const node = {
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => ({ top: 0, bottom: clientHeight }),
    querySelectorAll: () => anchors.map((anchor) => ({
      dataset: { viewportKey: anchor.key },
      offsetTop: anchor.top,
      getBoundingClientRect() {
        return { top: anchor.top - node.scrollTop, bottom: anchor.top - node.scrollTop + 30 };
      },
    })),
  };
  return node;
}

async function main() {
  const followingNode = fakeScroller({ scrollTop: 800 });
  const following = createScrollMachine(followingNode, {
    anchorSelector: '[data-viewport-key]',
    anchorDatasetKey: 'viewportKey',
  });
  const followingSnapshot = following.capture();
  assert.strictEqual(followingSnapshot.mode, 'follow');
  followingNode.scrollHeight = 1300;
  assert.strictEqual(following.restore(followingSnapshot), true);
  assert.strictEqual(followingNode.scrollTop, 1100, 'follow mode should retain the bottom gap');

  const detachedNode = fakeScroller({
    scrollTop: 250,
    anchors: [{ key: 'before', top: 100 }, { key: 'visible', top: 280 }],
  });
  const detached = createScrollMachine(detachedNode, {
    anchorSelector: '[data-viewport-key]',
    anchorDatasetKey: 'viewportKey',
  });
  detached.recordTrustedInteraction();
  const detachedSnapshot = detached.capture();
  assert.strictEqual(detachedSnapshot.mode, 'detached');
  assert.strictEqual(detachedSnapshot.anchorKey, 'visible');
  detachedNode.scrollHeight = 1400;
  detachedNode.querySelectorAll = () => [{
    dataset: { viewportKey: 'visible' },
    getBoundingClientRect: () => ({ top: 130, bottom: 160 }),
  }];
  detached.restore(detachedSnapshot);
  assert.strictEqual(detachedNode.scrollTop, 350, 'detached mode should preserve anchor pixel offset');

  const innerNode = fakeScroller({ scrollTop: 50, scrollHeight: 600, clientHeight: 100 });
  const inner = createScrollMachine(innerNode);
  inner.recordTrustedInteraction();
  assert.strictEqual(inner.state().mode, 'detached');
  assert.strictEqual(following.state().mode, 'follow', 'Thinking state must not alter outer state');

  const userRevision = following.state().userRevision;
  following.withProgrammaticScroll(() => {
    followingNode.scrollTop = 900;
  });
  assert.strictEqual(following.state().userRevision, userRevision);
  assert.strictEqual(following.state().programmaticRevision, 2);
  assert.strictEqual(following.capture().mode, 'follow', 'programmatic movement must not detach follow mode');
  following.detach();
  assert.strictEqual(following.state().mode, 'detached');
  following.establishFollow();
  assert.strictEqual(following.state().mode, 'follow');

  let resolveAsync;
  let restored = false;
  const pending = new Promise((resolve) => { resolveAsync = resolve; });
  const guarded = detached.guardAsync(pending, () => { restored = true; });
  detached.recordTrustedInteraction();
  resolveAsync();
  assert.strictEqual(await guarded, false);
  assert.strictEqual(restored, false, 'a stale async render must lose to newer user input');

  console.log('transcript scroll state assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
