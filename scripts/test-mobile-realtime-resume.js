const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

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
  'function getThinkingScrollMachine',
  'thinking scrollers should retain their own independent scroll machines'
);
assertContains(
  renderTranscriptBody,
  'isTranscriptPinnedAcrossScrollTargets()',
  'transcript rendering should evaluate the outer transcript boundary'
);
assertContains(
  app,
  'noteMessageReadThinkingScroll(session);',
  'thinking movement should be isolated from message read eligibility'
);
assert(!renderTranscriptBody.includes('thinkingReaderDetached'), 'thinking scroll must not detach the outer transcript reader');

assertContains(
  app,
  'ACTIVITY_CANONICAL_ALIAS_LIMIT = 512',
  'canonical session aliases should have an explicit client memory bound'
);
const canonicalAliasStart = app.indexOf('function rememberActivityCanonicalAlias(');
const canonicalAliasEnd = app.indexOf('\nfunction rememberActivityCanonicalKey(', canonicalAliasStart);
assert(canonicalAliasStart >= 0 && canonicalAliasEnd > canonicalAliasStart, 'canonical alias LRU helper is missing');
const canonicalAliasSource = app.slice(canonicalAliasStart, canonicalAliasEnd);
assertContains(
  canonicalAliasSource,
  'state.activityCanonicalKeysBySession.delete(key)',
  'reading or replacing a canonical alias should refresh its LRU position'
);
assertContains(
  canonicalAliasSource,
  'state.activityCanonicalKeysBySession.size > ACTIVITY_CANONICAL_ALIAS_LIMIT',
  'canonical alias retention should enforce its configured limit'
);
const aliasContext = vm.createContext({
  ACTIVITY_CANONICAL_ALIAS_LIMIT: 512,
  state: { activityCanonicalKeysBySession: new Map() },
});
vm.runInContext(canonicalAliasSource, aliasContext);
for (let index = 0; index < 512; index += 1) {
  aliasContext.rememberActivityCanonicalAlias(`session-${index}`, `canonical-${index}`);
}
aliasContext.rememberActivityCanonicalAlias('session-0', 'canonical-0');
aliasContext.rememberActivityCanonicalAlias('session-512', 'canonical-512');
assert.strictEqual(aliasContext.state.activityCanonicalKeysBySession.size, 512);
assert.strictEqual(aliasContext.state.activityCanonicalKeysBySession.has('session-0'), true);
assert.strictEqual(aliasContext.state.activityCanonicalKeysBySession.has('session-1'), false);
assertContains(
  app,
  'onConversationRemoved: (canonicalKey) => forgetActivityCanonicalConversation(canonicalKey)',
  'projection eviction and clear should remove matching aliases and resume cursors'
);
const forgetCanonicalStart = app.indexOf('function forgetActivityCanonicalConversation(');
const forgetCanonicalEnd = app.indexOf('\nfunction rememberActivityCanonicalAlias(', forgetCanonicalStart);
assert(forgetCanonicalStart >= 0 && forgetCanonicalEnd > forgetCanonicalStart, 'canonical cleanup helper is missing');
const forgetCanonicalSource = app.slice(forgetCanonicalStart, forgetCanonicalEnd);
assertContains(
  forgetCanonicalSource,
  'state.eventCursorByCanonical.delete(normalized)',
  'projection eviction should invalidate the cursor whose retained activity state disappeared'
);
assertContains(
  forgetCanonicalSource,
  'state.activityCanonicalKeysBySession.delete(sessionKey)',
  'projection eviction should remove every session alias for the canonical conversation'
);
const cleanupContext = vm.createContext({
  state: {
    eventCursorByCanonical: new Map([
      ['canonical-a', 'cursor-a'],
      ['canonical-b', 'cursor-b'],
    ]),
    activityCanonicalKeysBySession: new Map([
      ['session-a', 'canonical-a'],
      ['session-a-alias', 'canonical-a'],
      ['session-b', 'canonical-b'],
    ]),
  },
});
vm.runInContext(forgetCanonicalSource, cleanupContext);
assert.strictEqual(cleanupContext.forgetActivityCanonicalConversation('canonical-a'), true);
assert.strictEqual(cleanupContext.state.eventCursorByCanonical.has('canonical-a'), false);
assert.strictEqual(cleanupContext.state.eventCursorByCanonical.has('canonical-b'), true);
assert.deepStrictEqual(
  [...cleanupContext.state.activityCanonicalKeysBySession.entries()],
  [['session-b', 'canonical-b']]
);
const deleteHostStart = app.indexOf('async function deleteHost(');
const deleteHostEnd = app.indexOf('\nasync function saveConnectorProfile(', deleteHostStart);
assert(deleteHostStart >= 0 && deleteHostEnd > deleteHostStart, 'deleteHost cleanup source is missing');
const deleteHostSource = app.slice(deleteHostStart, deleteHostEnd);
assertContains(
  deleteHostSource,
  'state.activityProjection?.clearConversation(canonicalKey)',
  'deleting a host should release its retained activity projections'
);

assertContains(
  app,
  'async function resumeSelectedSessionRealtime',
  'mobile resume should explicitly restore the selected live session stream'
);
assertContains(
  app,
  'closeStream();',
  'mobile resume should restart SSE independently from the selected watch lease'
);
assertContains(
  app,
  'watchSelectedSession(selected, { force: true, silent: true })',
  'mobile resume should explicitly renew the selected watch lease'
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

assertContains(
  app,
  'STREAM_STALE_RECONNECT_MS',
  'mobile realtime should define a stale SSE threshold'
);
assertContains(
  app,
  'state.streamRecoveryInFlight',
  'mobile realtime resume should guard against overlapping reconnects'
);
assertContains(
  app,
  'function checkSelectedSessionStreamHealth',
  'mobile realtime should proactively check selected live session stream health'
);
assertContains(
  app,
  'stream.lastPingAt',
  'stream health should use the relay ping timestamp'
);
assertContains(
  app,
  'resumeSelectedSessionRealtime().catch(reportError)',
  'stale stream health checks should actively reconnect the selected session'
);
assertContains(
  app,
  'function sessionStreamResetNeedsRecovery',
  'expired stream cursors should trigger selected-session detail recovery'
);
assertContains(
  app,
  "payload.session?.runtime, { source: 'stream', allowStale: true }",
  'stream reset must authoritatively replace stale browser runtime state'
);
assertContains(
  app,
  "reason === 'cursor_expired'",
  'a released event ring should recover missed selected-session detail'
);
assertContains(
  app,
  "reason === 'cursor_missing'",
  'a first EventSource connection must recover events emitted before subscription became active'
);
assertContains(
  app,
  'function sessionStreamResetNeedsDetailRecovery(session)',
  'stream reset detail recovery should distinguish live sessions from loaded history sessions'
);
assertContains(
  app,
  'sessionStreamResetNeedsDetailRecovery(session)',
  'loaded history sessions should not repeat live detail recovery after every cursor reset'
);
assertContains(
  app,
  'reconcileDetailTranscriptForSession(',
  'full detail recovery must reconcile optimistic user echoes against the authoritative Relay transcript'
);
assertContains(
  app,
  "state.eventSource.addEventListener('session.interrupt_result'",
  'Interrupt must remain correlated with the Host terminal acknowledgement instead of HTTP enqueue only'
);
assertContains(
  app,
  'settlePendingInterruptFromInactiveRuntime(runtimeSession, mergedRuntime || runtimePayload)',
  'an accepted Interrupt must remain locked until the matching runtime becomes inactive'
);
assertContains(
  app,
  "reason === 'canonical_key_changed'",
  'canonical merges should reconcile transcript and request detail beyond the reset projection'
);
assertContains(
  app,
  'reconcileSelectedSessionAfterStreamReset(session, {',
  'stream reset recovery should reload detail without replacing the newly established EventSource'
);
const resetRecoveryStart = app.indexOf('async function reconcileSelectedSessionAfterStreamReset(');
const resetRecoveryEnd = app.indexOf('\nfunction updateSelectedViews', resetRecoveryStart);
assert(resetRecoveryStart >= 0 && resetRecoveryEnd > resetRecoveryStart);
const resetRecoverySource = app.slice(resetRecoveryStart, resetRecoveryEnd);
assert(!resetRecoverySource.includes('closeStream('), 'reset detail recovery must keep the current EventSource');
assert(!resetRecoverySource.includes('subscribeSession('), 'reset detail recovery must not create another stream generation');
assertContains(
  resetRecoverySource,
  'while (state.streamDetailRecoveryPendingKey)',
  'overlapping stream resets should queue another detail reconciliation instead of being dropped'
);
assertContains(
  resetRecoverySource,
  'scheduleStreamDetailRecoveryRetry(failedRecoveryKey)',
  'a failed reset reconciliation should remain pending with bounded retry'
);
assertContains(
  resetRecoverySource,
  'state.eventCursorByCanonical.delete(getActivityCanonicalKeyForSession(selected))',
  'a failed reset reconciliation should invalidate its consumed cursor'
);
assertContains(
  resetRecoverySource,
  'if (recoverActivities) {',
  'activity recovery should still run when the detail refresh fails'
);
assertContains(
  app,
  '/activities?',
  'truncated reset activity state should be recovered outside the SSE frame'
);
assertContains(
  app,
  'payload.activitiesTruncated === true',
  'a bounded reset should request the authoritative activity snapshot'
);
assertContains(
  app,
  'activitySnapshotRecoveryTasks: new Map()',
  'large live activity recovery should keep one task per canonical session'
);
assertContains(
  app,
  'ACTIVITY_SNAPSHOT_RECOVERY_DEBOUNCE_MS = 250',
  'large live activity recovery should use a short trailing debounce'
);
assertContains(
  app,
  'ACTIVITY_SNAPSHOT_RECOVERY_MAX_WAIT_MS = 2_000',
  'continuous thinking should refresh its activity snapshot at least every two seconds'
);
const activityRecoveryStart = app.indexOf('async function runActivitySnapshotRecovery(');
const activityRecoveryEnd = app.indexOf('\nasync function reconcileSelectedSessionAfterStreamReset', activityRecoveryStart);
assert(activityRecoveryStart >= 0 && activityRecoveryEnd > activityRecoveryStart);
const activityRecoverySource = app.slice(activityRecoveryStart, activityRecoveryEnd);
assertContains(
  activityRecoverySource,
  'if (task.inFlight) return;',
  'large live activity recovery should allow only one request in flight per canonical session'
);
assertContains(
  activityRecoverySource,
  'loadSessionActivityRecords(task.session, requestedActivities, { signal })',
  'large live activity invalidations should recover only their targeted records'
);
assertContains(
  activityRecoverySource,
  'retryActivitySnapshotRecovery(task)',
  'a failed compact activity recovery should retry instead of losing the consumed event'
);
assertContains(
  activityRecoverySource,
  'ACTIVITY_SNAPSHOT_RECOVERY_DEBOUNCE_MS)',
  'an invalidation received during a snapshot request should schedule one coalesced rerun'
);
assertContains(
  app,
  'state.eventCursorByCanonical.delete(canonicalKey)',
  'switching away from an unrecovered compact activity should force an authoritative reset next time'
);
assertContains(
  app,
  'activityToken: token',
  'compact activity recovery should use the opaque server recovery token'
);
assertContains(
  app,
  'responses.some(({ activity, expectedRevision })',
  'a missing or evicted targeted activity should fall back to an authoritative full snapshot'
);
assertContains(
  app,
  'task.pendingActivities.size > ACTIVITY_SNAPSHOT_RECOVERY_MAX_TARGETS',
  'pending compact recovery tokens should be bounded even while a request is in flight'
);
assertContains(
  app,
  'withStreamRecoveryTimeout',
  'hung detail and activity requests should not block all later reset recovery'
);
assertContains(
  app,
  'sessionDetailRequests: new Map()',
  'initial detail and stream-reset recovery should share one in-flight Session detail request'
);
assertContains(
  app,
  'fetchSharedSessionDetail(session, detailParams, {',
  'showSession should coalesce equivalent full-detail requests'
);
const sharedDetailStart = app.indexOf('function fetchSharedSessionDetail(');
const sharedDetailEnd = app.indexOf('\nfunction authAllowsRequests', sharedDetailStart);
assert(sharedDetailStart >= 0 && sharedDetailEnd > sharedDetailStart, 'shared Session detail helper is missing');
const sharedDetailSource = app.slice(sharedDetailStart, sharedDetailEnd);
assertContains(
  sharedDetailSource,
  'state.sessionDetailRequests.get(requestKey)',
  'equivalent Session detail callers should reuse the active request'
);
assertContains(
  sharedDetailSource,
  'waitForSharedRequestWithSignal(request, options.signal)',
  'a recovery timeout should cancel only its wait on the shared request'
);
assert(
  !sharedDetailSource.includes('fetchJson(\n      `/api/sessions/${encodeURIComponent(session.sessionId)}/detail?${query}`,\n      { signal:'),
  'the recovery AbortSignal must not abort the shared underlying detail request'
);
assertContains(
  app,
  'state.activityProjection.replaceSnapshot(canonicalKey, {',
  'full activity snapshots should remove browser records already evicted by the server'
);
const activityHandlerStart = app.indexOf("state.eventSource.addEventListener('session.activity'");
const activityHandlerEnd = app.indexOf("state.eventSource.addEventListener('session.assistant_projection'", activityHandlerStart);
assert(activityHandlerStart >= 0 && activityHandlerEnd > activityHandlerStart);
const activityHandlerSource = app.slice(activityHandlerStart, activityHandlerEnd);
assertContains(
  activityHandlerSource,
  'if (payload.activityTruncated === true)',
  'the client should recognize compact live activity invalidations'
);
assertContains(
  activityHandlerSource,
  'scheduleActivitySnapshotRecovery(session, event, payload)',
  'the client should recover compact live activity without applying its empty text placeholder'
);
assert(
  activityHandlerSource.indexOf('return;') < activityHandlerSource.indexOf('applyActivityEvent(session, event, payload)'),
  'compact activity invalidations must return before their empty text is applied'
);
assertContains(
  app,
  'setInterval(() => {\n  checkSelectedSessionStreamHealth();',
  'mobile realtime health checks should run periodically'
);

assertContains(
  app,
  'await showSession(selected, { full: true, preserveScroll: true, throwOnError: true })',
  'mobile realtime resume should catch up the selected session without pulling the transcript to the bottom'
);
assertContains(
  app,
  'state.sessionWatchCatchUpRequired = true',
  'pagehide or a long hidden interval should require history detail catch-up'
);
assertContains(
  app,
  'options.forceDetail === true || state.sessionWatchCatchUpRequired',
  'history resume should reload full detail after its watch was released or suspended'
);
assertContains(
  app,
  'const initialTranscriptRenderOptions = {',
  'showSession should centralize its initial transcript scroll behavior'
);
assertContains(
  app,
  'preserveScroll: Boolean(options.preserveScroll)',
  'showSession should be able to preserve transcript scroll during live refreshes'
);

console.log('mobile realtime resume assertions passed');
