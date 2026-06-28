const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

const renderTranscriptStart = app.indexOf('function renderTranscript(');
const renderTranscriptEnd = app.indexOf('function renderLocaleLabels', renderTranscriptStart);
assert(renderTranscriptStart >= 0 && renderTranscriptEnd > renderTranscriptStart, 'app should define renderTranscript before renderLocaleLabels');
const renderTranscriptBody = app.slice(renderTranscriptStart, renderTranscriptEnd);

assertContains(
  app,
  'function hasDetachedThinkingScroller',
  'UI should detect when the user is reading inside a thinking scroller'
);
assertContains(
  renderTranscriptBody,
  'thinkingReaderDetached',
  'transcript rendering should account for nested thinking scroll position'
);
assertContains(
  renderTranscriptBody,
  '|| thinkingReaderDetached',
  'thinking readers should prevent transcript auto-stick-to-bottom'
);

assertContains(
  app,
  'async function resumeSelectedSessionRealtime',
  'mobile resume should explicitly restore the selected live session stream'
);
assertContains(
  app,
  'closeStream({ unwatch: false })',
  'mobile resume should restart SSE without racing against watch/unwatch'
);
assertContains(
  app,
  'state.fullTranscriptLoaded.delete(selectedKey)',
  'mobile resume should force a fresh full detail load for the selected session'
);
assertContains(
  app,
  "document.addEventListener('visibilitychange'",
  'mobile browser visibility restore should trigger realtime resume'
);
assertContains(
  app,
  "window.addEventListener('pageshow'",
  'mobile bfcache/page restore should trigger realtime resume'
);
assertContains(
  app,
  "window.addEventListener('focus'",
  'mobile focus restore should trigger realtime resume'
);

console.log('mobile realtime resume assertions passed');
