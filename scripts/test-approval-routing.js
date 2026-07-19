const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const runner = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

const requestHandlerStart = relay.indexOf("if (event.type === 'session.request')");
const requestHandlerEnd = relay.indexOf("if (event.type === 'session.request.resolved')", requestHandlerStart);
assert(requestHandlerStart >= 0 && requestHandlerEnd > requestHandlerStart, 'relay should have a bounded session.request handler');
const requestHandler = relay.slice(requestHandlerStart, requestHandlerEnd);
assertContains(
  requestHandler,
  'emitSessionRequest(event.hostId, effectiveSessionId, requestEntry);',
  'session.request events should be stored and broadcast on the canonical effective session id'
);
assert(
  !requestHandler.includes('emitSessionRequest(event.hostId, sessionId, {'),
  'session.request events must not be stored on the raw event session id when an alias resolves to a canonical session id'
);

const respondRouteStart = relay.indexOf("url.pathname.match(/^\\/api\\/sessions\\/[^/]+\\/requests\\/[^/]+\\/respond$/)");
const respondRouteEnd = relay.indexOf("if (req.method === 'GET' && url.pathname.match(/^\\/api\\/sessions\\/[^/]+\\/events$/)", respondRouteStart);
assert(respondRouteStart >= 0 && respondRouteEnd > respondRouteStart, 'relay should have a bounded request respond route');
const respondRoute = relay.slice(respondRouteStart, respondRouteEnd);
assertContains(
  respondRoute,
  'const session = getSession(hostId, sessionId);',
  'respond route should look up the selected session before enqueueing approval responses'
);
for (const identityField of ['nativeThreadId', 'bridgeSessionId', 'originSessionId', 'sourceSessionId', 'conversationKey', 'runId']) {
  assertContains(
    respondRoute,
    `${identityField}: session?.${identityField} || null`,
    `respond route should forward ${identityField} so host-agent can match the correct live runner`
  );
}

assertContains(
  relay,
  'goalAutoApproveRequests: new Map()',
  'relay should keep goal-scoped auto-approve state outside global permanent preferences'
);
assertContains(
  relay,
  'function isGoalAutoApproveEnabled(hostId, sessionId)',
  'relay should expose a helper for checking goal-scoped auto-approve state'
);
assertContains(
  relay,
  "url.pathname.match(/^\\/api\\/sessions\\/[^/]+\\/goal-auto-approve$/)",
  'relay should provide an endpoint for toggling goal-scoped auto-approve'
);
assertContains(
  relay,
  'maybeAutoApproveSessionRequest(event.hostId, effectiveSessionId, requestEntry);',
  'relay should auto-approve eligible approval requests after storing them on the canonical session id'
);
assertContains(
  runner,
  'autoApproved: Boolean(response?.autoApproved)',
  'runner should preserve auto-approval metadata in resolved request diagnostics'
);

assertContains(
  app,
  'respondToSessionRequest(session, request, { decision: \'accept\', autoApproveGoal: true })',
  'approval popup should expose a goal-scoped auto-approve action'
);
assertContains(
  app,
  "fetchJson(`/api/sessions/${encodeURIComponent(session.sessionId)}/goal-auto-approve`",
  'frontend should call the goal auto-approve endpoint'
);

console.log('approval routing assertions passed');
