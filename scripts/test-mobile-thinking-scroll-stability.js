const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const stylesPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'styles.css');
const discoveryPath = path.join(__dirname, '..', 'shared', 'codex-discovery.js');
const app = fs.readFileSync(appPath, 'utf8');
const styles = fs.readFileSync(stylesPath, 'utf8');
const discovery = fs.readFileSync(discoveryPath, 'utf8');

function sliceBetweenSource(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${label} start marker was not found`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${label} end marker was not found`);
  return source.slice(start, end);
}

function sliceBetween(startNeedle, endNeedle, label) {
  return sliceBetweenSource(app, startNeedle, endNeedle, label);
}

function mustContain(source, needle, message) {
  assert(source.includes(needle), `${message}\nMissing: ${needle}`);
}

function cssBlocksFor(selector) {
  const blocks = [];
  let offset = 0;
  while (offset < styles.length) {
    const selectorIndex = styles.indexOf(selector, offset);
    if (selectorIndex < 0) {
      break;
    }
    const braceIndex = styles.indexOf('{', selectorIndex);
    if (braceIndex < 0) {
      break;
    }
    let depth = 0;
    let end = braceIndex;
    for (; end < styles.length; end += 1) {
      const char = styles[end];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    blocks.push(styles.slice(braceIndex + 1, end));
    offset = end + 1;
  }
  return blocks;
}

const thinkingPanel = sliceBetween(
  'function renderThinkingPanel()',
  'function renderAlertsWindow()',
  'renderThinkingPanel'
);
mustContain(
  thinkingPanel,
  'patchThinkingMessageElement(',
  'live thinking updates should patch the existing message in place'
);
assert(
  !thinkingPanel.includes('existingMessage.replaceWith('),
  'live thinking updates should not replace the whole thinking message; that causes mobile flicker'
);

const liveActivitySegment = sliceBetween(
  'function buildLiveActivitySegment(',
  'function getLatestUserTranscriptEntry',
  'buildLiveActivitySegment'
);
assert(
  !liveActivitySegment.includes('.slice(-12)'),
  'live thinking should not cap visible activity to 12 records'
);
mustContain(
  liveActivitySegment,
  'LIVE_THINKING_ACTIVITY_ENTRY_LIMIT',
  'live thinking should use an explicit, high activity-entry limit'
);
const formatThinkingValue = sliceBetween(
  'function formatThinkingValue(',
  'function normalizeThinkingMessage',
  'formatThinkingValue'
);
mustContain(
  formatThinkingValue,
  'joinThinkingTextParts(',
  'frontend thinking arrays should be joined as text fragments instead of one fragment per line'
);
assert(
  !formatThinkingValue.includes("return value\n      .map((item) => formatThinkingValue(item, depth + 1))\n      .filter(Boolean)\n      .join('\\n')"),
  'frontend thinking arrays should not directly join every fragment with a hard newline'
);
mustContain(
  formatThinkingValue,
  "values.join(looksTokenized ? ' ' : '\\n')",
  'frontend thinking arrays should join tokenized fragments with spaces while preserving real multiline blocks'
);
const extractStructuredText = sliceBetweenSource(
  discovery,
  'function extractStructuredText(',
  'function parseJsonObject',
  'extractStructuredText'
);
mustContain(
  extractStructuredText,
  'joinStructuredTextParts(',
  'JSONL reasoning arrays should be joined as text fragments instead of one fragment per line'
);
assert(
  !extractStructuredText.includes("return value\n      .map(extractStructuredText)\n      .filter(Boolean)\n      .join('\\n')"),
  'JSONL reasoning arrays should not directly join every fragment with a hard newline'
);
mustContain(
  extractStructuredText,
  "values.join(looksTokenized ? ' ' : '\\n')",
  'JSONL reasoning arrays should join tokenized fragments with spaces while preserving real multiline blocks'
);

mustContain(
  app,
  'function captureTranscriptScrollSnapshot()',
  'thinking patches should capture transcript scroll before DOM updates'
);
mustContain(
  app,
  'scrollTop: node.scrollTop || 0',
  'transcript scroll snapshots should remember the raw scrollTop, matching the stable v2.3.0 behavior'
);
mustContain(
  app,
  'bottomOffset:',
  'transcript scroll snapshots should remember bottomOffset for bottom-relative restoration'
);
assert(
  !app.includes('function findTranscriptViewportAnchor('),
  'transcript scroll preservation should not choose a DOM anchor; live updates must not pull readers back to a fixed message'
);
assert(
  !app.includes('restoreTranscriptAnchorSnapshot('),
  'transcript scroll restoration should use raw scrollTop/bottomOffset, not anchor-based correction'
);
assert(
  !app.includes('transcriptEntryAnchorKey'),
  'transcript anchor key helpers should not remain after reverting anchor-based scroll restoration'
);
assert(
  !app.includes('data-transcript-anchor-key') && !app.includes('transcriptAnchorKey'),
  'transcript anchor data attributes should not remain after reverting anchor-based scroll restoration'
);
mustContain(
  app,
  'function restoreTranscriptScrollSnapshot(',
  'thinking patches should restore transcript scroll after DOM updates'
);
mustContain(
  app,
  'function captureViewportAnchor(',
  'transcript scroll snapshots should capture the visible element, not only raw scrollTop'
);
mustContain(
  app,
  'function restoreViewportAnchor(',
  'transcript scroll restoration should correct for content height changes above the reader'
);
mustContain(
  app,
  'message.dataset.viewportKey = transcriptViewportKey(entry, fullEntryIndex)',
  'rendered transcript messages should expose stable viewport keys for anchor restoration'
);
mustContain(
  app,
  'wrapper.dataset.viewportKey = stateKey',
  'thinking cards should expose stable outer viewport keys'
);
mustContain(
  app,
  'function restoreTranscriptScrollTargetsToBottom(',
  'opening or bottom-pinned transcripts should scroll the transcript owner to bottom'
);
mustContain(
  app,
  'function getTranscriptScrollOwner(',
  'transcript scrolling should be owned by one explicit outer message container'
);
mustContain(
  app,
  'function shouldUsePageTranscriptScroll(',
  'mobile transcript scrolling should be allowed to use page flow instead of locking the chat log'
);
mustContain(
  app,
  'document.scrollingElement || document.documentElement || document.body',
  'mobile transcript scrolling should preserve the document viewport when the page is the scroll owner'
);
mustContain(
  app,
  'function scrollOwnerTo(',
  'transcript scroll buttons should use a shared scroll helper'
);
mustContain(
  app,
  'isDocumentScrollOwner(node) && typeof window.scrollTo === \'function\'',
  'mobile document scrolling should go through window.scrollTo instead of element.scrollTo'
);
mustContain(
  app,
  'window.scrollTo({ top, behavior })',
  'mobile transcript Up/Bottom controls should work on document scrolling browsers'
);
mustContain(
  app,
  'return shouldUsePageTranscriptScroll() ? getDocumentScrollOwner() : el(\'session-log\')',
  'desktop should keep #session-log as owner while mobile uses the page scroll owner'
);
mustContain(
  app,
  'return [owner]',
  'transcript scroll targets should collapse to the single owner'
);
mustContain(
  app,
  'function getTranscriptJumpTargets()',
  'explicit transcript Up/Bottom actions should discover every possible mobile scroll container'
);
const transcriptJumpTargets = sliceBetween(
  'function getTranscriptJumpTargets()',
  'function scrollTranscriptTo(',
  'getTranscriptJumpTargets'
);
mustContain(
  transcriptJumpTargets,
  "add(el('session-log'))",
  'explicit transcript jumps should still handle #session-log when mobile CSS is stale or overridden'
);
mustContain(
  transcriptJumpTargets,
  "add(document.querySelector('.main'))",
  'explicit transcript jumps should still handle .main when it owns mobile scrolling'
);
mustContain(
  transcriptJumpTargets,
  'add(document.scrollingElement)',
  'explicit transcript jumps should include the browser document scrolling element'
);
mustContain(
  transcriptJumpTargets,
  'getScrollableDistance(node) > 4',
  'explicit transcript jumps should discover scrollable transcript ancestors'
);
const scrollTranscriptToSource = sliceBetween(
  'function scrollTranscriptTo(',
  'function stripResumeBootstrapText',
  'scrollTranscriptTo'
);
mustContain(
  scrollTranscriptToSource,
  'for (const target of getTranscriptJumpTargets())',
  'explicit transcript Up/Bottom actions should scroll all discovered candidates'
);
mustContain(
  scrollTranscriptToSource,
  'Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)',
  'mobile Bottom should finish at the real document maximum instead of trusting one guessed owner'
);
mustContain(
  app,
  "window.addEventListener('scroll', handleTranscriptScrollDetach",
  'mobile page scrolling should update transcript detach state'
);
mustContain(
  app,
  'function preserveThinkingViewportForPatch(',
  'thinking card patches should preserve the internal thinking viewport'
);
mustContain(
  app,
  'restoreThinkingScrollState(patchedStateKey, patchedScroller, { preserveDetached: true, immediate: true })',
  'thinking patches should not force detached thinking readers back to the bottom'
);
const restoreThinkingScrollState = sliceBetween(
  'function restoreThinkingScrollState(',
  'function captureThinkingScrollStates',
  'restoreThinkingScrollState'
);
mustContain(
  restoreThinkingScrollState,
  'options.preserveDetached',
  'thinking scroll restore should distinguish live patches from explicit user-bottom actions'
);
mustContain(
  restoreThinkingScrollState,
  'expectedUserRevision',
  'thinking scroll restore should capture the machine user revision before scheduling async restoration'
);
mustContain(
  restoreThinkingScrollState,
  'machine.state().userRevision !== expectedUserRevision',
  'thinking scroll restore should not overwrite a newer user scroll position with a stale async restore'
);
mustContain(
  restoreThinkingScrollState,
  'machine.restore(saved.machineSnapshot)',
  'thinking scroll restoration should use the independent state machine snapshot'
);
mustContain(
  app,
  'anchor: captureViewportAnchor(scroller, \'[data-thinking-viewport-key]\', \'thinkingViewportKey\')',
  'thinking scroll state should preserve the visible thinking record, not only raw scrollTop'
);
mustContain(
  app,
  'item.dataset.thinkingViewportKey = thinkingEntryViewportKey(entry, index)',
  'thinking history records should expose stable viewport keys'
);
mustContain(
  app,
  'restoreThinkingScrollState(patchedStateKey, patchedScroller, { preserveDetached: true, immediate: true })',
  'thinking patches should restore internal scroll before the next paint to avoid visible jumps'
);
assert(
  !restoreThinkingScrollState.includes('if (saved.atBottom) {\n        scroller.scrollTop = scroller.scrollHeight;\n      }'),
  'live thinking patches should not turn a previously bottom-pinned card into an automatic scroll-to-bottom'
);
const thinkingMessageElement = sliceBetween(
  'function buildThinkingMessageElement(',
  'function patchThinkingMessageElement',
  'buildThinkingMessageElement'
);
mustContain(
  thinkingMessageElement,
  'entries.length > previousEntryCount && savedScroll && details.open',
  'new thinking activity should mark the card unread whenever the card was open before the live patch'
);
assert(
  !thinkingMessageElement.includes('&& !savedScroll.atBottom && details.open'),
  'new thinking activity should show Bottom even if the previous state was bottom-pinned'
);
mustContain(
  thinkingMessageElement,
  'details.appendChild(createThinkingScrollRail(details, stateKey))',
  'thinking Top/Bottom controls should live in the side rail next to collapse instead of inside scroll content'
);
assert(
  !thinkingMessageElement.includes('content.appendChild(createThinkingScrollActions'),
  'thinking Top/Bottom controls should not be part of the scrollable thinking content'
);
const thinkingScrollActions = sliceBetween(
  'function createThinkingScrollActions(',
  'function isMarkdownMathToken',
  'createThinkingScrollActions'
);
assert(
  !thinkingScrollActions.includes('scrollIntoView'),
  'thinking Top/Bottom buttons should only scroll the internal thinking scroller, not the outer transcript'
);
mustContain(
  thinkingScrollActions,
  'Math.max(0, scroller.scrollHeight - scroller.clientHeight)',
  'thinking Bottom should target the real maximum internal scroll position'
);
mustContain(
  styles,
  'overflow-anchor: none',
  'thinking cards should disable browser scroll anchoring while live content grows'
);
const transcriptControlBlocks = cssBlocksFor('.transcript-scroll-controls');
const mobileFloatingTranscriptControls = transcriptControlBlocks.find((block) => (
  block.includes('top: 50dvh !important')
  && block.includes('z-index: 9990 !important')
));
assert(
  mobileFloatingTranscriptControls,
  'expected the final mobile floating transcript controls style block'
);
assert(
  /\bpointer-events\s*:\s*auto\b/.test(mobileFloatingTranscriptControls),
  'mobile floating transcript controls must remain in the touch hit-test tree'
);
assert(
  !/\bpointer-events\s*:\s*none\b/.test(mobileFloatingTranscriptControls),
  'mobile floating transcript controls must not disable pointer events on their parent container'
);
const mainStyleBlocks = cssBlocksFor('.main');
assert(mainStyleBlocks.length >= 2, 'expected base and responsive .main style blocks');
assert(
  styles.includes('/* Mobile transcript page-flow repair */'),
  'mobile layout should document the page-flow transcript repair'
);
mustContain(
  styles,
  'html,\n  body {\n    height: auto;\n    min-height: 100%;\n    overflow-x: clip;\n    overflow-y: visible;\n  }',
  'mobile page flow should keep the root document as the single outer transcript scroll owner'
);
mustContain(
  styles,
  '.detail-header {\n    position: relative;\n    top: auto;',
  'mobile conversation headers should scroll away with the transcript instead of sticking to the top'
);
mustContain(
  styles,
  '.main {\n    height: auto;\n    min-height: auto;\n    overflow: visible;',
  'mobile main should not be locked to a 100dvh internal scroller'
);
mustContain(
  styles,
  '.log {\n    overflow: visible;\n    min-height: 0;',
  'mobile log should let the page own transcript scrolling'
);
mustContain(
  styles,
  '.composer {\n    position: relative;\n    bottom: auto;',
  'mobile composer should stay in normal document flow instead of floating over the transcript'
);
const logStyleBlocks = cssBlocksFor('.log');
assert(logStyleBlocks.some((block) => /\boverflow\s*:\s*auto\b/.test(block)), '#session-log/.log should remain the desktop conversation scroll owner');
const thinkingContentOpenBlocks = cssBlocksFor('.thinking-card[open] .thinking-content');
assert(
  thinkingContentOpenBlocks.some((block) => /\boverflow\s*:\s*auto\b/.test(block)),
  'open thinking cards should keep their own internal scroll owner'
);

const scheduleMathTypeset = sliceBetween(
  'function scheduleMathTypeset(container)',
  'function renderInlineMarkdown(parent, text)',
  'scheduleMathTypeset'
);
mustContain(
  scheduleMathTypeset,
  'const scrollSnapshot = captureTranscriptScrollSnapshot()',
  'async MathJax layout changes should capture the current reader anchor before typesetting'
);
mustContain(
  scheduleMathTypeset,
  'restoreTranscriptScrollSnapshot(scrollSnapshot)',
  'async MathJax layout changes should restore the current reader anchor after typesetting'
);

const sessionRequestHandler = sliceBetween(
  "state.eventSource.addEventListener('session.request'",
  "state.eventSource.addEventListener('session.request.resolved'",
  'session.request handler'
);
mustContain(
  sessionRequestHandler,
  'scheduleTranscriptRender({ preserveScroll: true })',
  'approval request updates should preserve the reader scroll position'
);

const requestResolvedHandler = sliceBetween(
  "state.eventSource.addEventListener('session.request.resolved'",
  '});\n}\n\nasync function showSession',
  'session.request.resolved handler'
);
mustContain(
  requestResolvedHandler,
  'scheduleTranscriptRender({ preserveScroll: true })',
  'approval request resolution should preserve the reader scroll position'
);

const renderTranscript = sliceBetween(
  'function renderTranscript(',
  'function renderLocaleLabels()',
  'renderTranscript'
);
mustContain(
  renderTranscript,
  'isTranscriptPinnedAcrossScrollTargets()',
  'transcript rerenders should decide stick-to-bottom from every active scroll container'
);
mustContain(
  renderTranscript,
  'const scrollSnapshot = captureTranscriptScrollSnapshot()',
  'transcript rerenders should capture all scroll containers before rebuilding the log'
);
mustContain(
  renderTranscript,
  'restoreTranscriptScrollSnapshot(scrollSnapshot)',
  'transcript rerenders should restore non-bottom readers across desktop and mobile containers'
);
mustContain(
  renderTranscript,
  'restoreTranscriptScrollTargetsToBottom()',
  'session switches and bottom-pinned rerenders should bottom every active scroll container'
);
mustContain(
  renderTranscript,
  'if (!shouldStickToBottom && !focus)',
  'non-bottom transcript rerenders should restore the raw viewport even when updates arrive below'
);
assert(
  !renderTranscript.includes('if (!shouldStickToBottom && options.preserveScroll && !focus)'),
  'non-bottom transcript restoration should not depend on the caller remembering preserveScroll'
);
assert(
  !renderTranscript.includes('} else if (activeSearchMatch) {'),
  'plain keyword search matches should not auto-scroll on every transcript rerender'
);
assert(
  !renderTranscript.includes("document.getElementById('focused-transcript-entry')?.scrollIntoView"),
  'only explicit transcript focus requests should call scrollIntoView'
);
assert(
  !renderTranscript.includes('&& !activeSearchMatch'),
  'active keyword matches should not block scroll restoration when no explicit focus was requested'
);

const showSession = sliceBetween(
  'async function showSession(',
  'function buildSessionExportUrl',
  'showSession'
);
assert(
  !showSession.includes('renderTranscript(selected);'),
  'async detail/file follow-up renders should preserve scroll instead of rerendering selected transcripts bare'
);
mustContain(
  showSession,
  'renderTranscript(selected, { preserveScroll: true })',
  'async detail/file follow-up renders should preserve scroll'
);
assert(
  !showSession.includes('navigatorFocus'),
  'history detail loading should not synthesize transcript focus from keyword search state'
);
assert(
  !showSession.includes('const navigatorTarget = !options.focus && getTranscriptSearchTarget(selected);'),
  'opening an unloaded history session under search should not repeatedly chase the first keyword match'
);
mustContain(
  showSession,
  'forceScroll: !options.preserveScroll && !options.focus',
  'opening a session detail should keep bottom behavior unless the caller explicitly preserves scroll'
);

console.log('mobile thinking scroll stability checks passed');
