const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const agent = fs.readFileSync('apps/host-agent/agent.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const html = fs.readFileSync('apps/mobile-web/public/index.html', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

assertContains(relay, "'host.file_download'", 'file download commands should be high priority so downloads are not stuck behind history work');
assertContains(relay, "'host.file_download_info'", 'file download info should be high priority');
assertContains(relay, "'host.file_download_chunk'", 'file download chunks should be high priority');

assertContains(relay, "type: 'session.watch'", 'relay should enqueue session.watch when the UI opens a conversation');
assertContains(relay, "type: 'session.unwatch'", 'relay should enqueue session.unwatch when a conversation is no longer open');
assertContains(relay, "event.type === 'watch.performance'", 'relay should turn slow watch telemetry into a visible session warning');
assertContains(
  relay,
  'isBenignSessionWatchNoLiveError(message)',
  'relay should treat old-agent session.watch no-live errors as a benign realtime-watch downgrade, not a user-visible session error'
);
assertContains(
  relay,
  "event.type === 'session.watch.updated'",
  'relay should process session.watch.updated events separately from generic session errors'
);
assertContains(
  relay,
  'resolveSessionId(event.hostId, event.sessionId || event.nativeThreadId)',
  'session.watch.updated handling should not reference the later sessionId binding before it is declared'
);
assertContains(
  app,
  '/no live session for command session\\.(watch|unwatch)\\b/i.test(message)',
  'UI should hide stale old-agent watch/unwatch no-live alerts from the visible session alerts panel'
);

assertContains(agent, "command.type === 'session.watch'", 'host-agent should handle session.watch commands');
assertContains(agent, "command.type === 'session.unwatch'", 'host-agent should handle session.unwatch commands');
assertContains(agent, 'upsertSessionWatch(watchedHistorySessions', 'host-agent should atomically replace each browser view lease');
assertContains(agent, 'ownerRevisions: watchedSessionRevisions', 'host-agent should reject stale watch revisions');
assertContains(agent, 'sessionWatchV2: true', 'host-agent should advertise atomic selected-watch support');
assertContains(agent, 'WATCH_PERFORMANCE_SLOW_MS', 'host-agent should have an explicit slow realtime watch threshold');
assertContains(agent, "type: 'watch.performance'", 'host-agent should report slow realtime watch polling');
const refreshScopeStart = agent.indexOf('function refreshTailerWatchedSessions()');
const refreshScopeEnd = agent.indexOf('\nasync function maybeReportWatchPerformance', refreshScopeStart);
const refreshScope = agent.slice(refreshScopeStart, refreshScopeEnd);
assert(
  refreshScope.indexOf('pruneExpiredWatchedSessions();') < refreshScope.indexOf('if (!codexTailer)'),
  'watch leases must expire even when JSONL tailing is disabled'
);
const heartbeatLoopStart = agent.indexOf('async function heartbeatLoop()');
const heartbeatLoopEnd = agent.indexOf('\nfunction sleep(', heartbeatLoopStart);
assertContains(
  agent.slice(heartbeatLoopStart, heartbeatLoopEnd),
  'pruneExpiredWatchedSessions();',
  'the heartbeat must periodically prune leases when the tail loop is disabled'
);

assertContains(app, 'watchSelectedSession(session)', 'UI should request a watch for the opened conversation');
assertContains(app, 'unwatchSelectedSession', 'UI should release the previous watched conversation');
assertContains(app, 'maintainSelectedSessionWatch()', 'UI should renew the selected session lease even when it is history-only');
assertContains(
  app,
  'capabilities?.sessionWatchV2 === true',
  'UI should fall back to explicit unwatch when a remote Agent does not advertise watch v2'
);
assertContains(app, 'const streamMismatch = state.eventSourceKey !== nextKey', 'every selected session should keep an SSE stream');
assertContains(html, '/session-watch-controller.js', 'UI should load the latest-wins selected watch controller');
assertContains(app, 'historyLoading', 'UI should track history loading while switching conversations');
assertContains(app, 'Loading history...', 'UI should show a loading history state during session switches');

console.log('session watch routing assertions passed');
