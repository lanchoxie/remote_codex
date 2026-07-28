const assert = require('assert');
const fs = require('fs');

const relay = fs.readFileSync('apps/relay/server.js', 'utf8');
const app = fs.readFileSync('apps/mobile-web/public/app.js', 'utf8');
const runner = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');
const styles = fs.readFileSync('apps/mobile-web/public/styles.css', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

function functionSource(source, name, nextName = '') {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `expected function ${name} to exist`);
  const end = nextName
    ? source.indexOf(`function ${nextName}(`, start + 1)
    : source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end > start ? end : source.length);
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
  'const claim = claimSessionRequestResponse(hostId, sessionId, requestId, body.response || null,',
  'respond route should atomically claim the pending request before enqueueing an approval response'
);
assertContains(
  respondRoute,
  'const session = getSession(hostId, effectiveSessionId);',
  'respond route should route an accepted response through the canonical Session identity'
);
for (const identityField of ['nativeThreadId', 'bridgeSessionId', 'originSessionId', 'sourceSessionId', 'conversationKey']) {
  assertContains(
    respondRoute,
    `${identityField}: session?.${identityField} || null`,
    `respond route should forward ${identityField} so host-agent can match the correct live runner`
  );
}
assertContains(
  respondRoute,
  'body.runId',
  'respond route should use the runId submitted with the approval request instead of silently retargeting the current Rebind run'
);

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

const lightApprovalStart = styles.indexOf('html[data-theme="minimal-light"] .approval-popup');
assert(lightApprovalStart >= 0, 'light mode must override the approval popup instead of combining dark popup colors with light-theme text');
const lightApprovalEnd = styles.indexOf('}', lightApprovalStart);
const lightApprovalRule = styles.slice(lightApprovalStart, lightApprovalEnd > lightApprovalStart ? lightApprovalEnd + 1 : styles.length);
assertContains(
  lightApprovalRule,
  'background:',
  'light-mode approval popup override should provide a readable light surface'
);

const approvalPopupBody = functionSource(app, 'renderApprovalPopup', 'interruptActiveTurn');
assert(
  !approvalPopupBody.includes("el('approval-popup-message').textContent = message;"),
  'the compact popup must not render an unbounded command message verbatim'
);
const approvalDetailHelperCall = approvalPopupBody.match(/\b(render\w*Approval\w*Detail)\s*\(/);
assert(
  approvalDetailHelperCall,
  'the compact popup should delegate long approval content to a dedicated detail renderer'
);
const approvalDetailHelperBody = functionSource(app, approvalDetailHelperCall[1]);
assertContains(
  approvalDetailHelperBody,
  "document.createElement('details')",
  'approval detail renderer should put the full command or file detail in a collapsible details element'
);
assertContains(
  approvalDetailHelperBody,
  'limitText(',
  'approval detail renderer should keep the always-visible summary bounded'
);
assert(
  !approvalPopupBody.includes("'Open Status'"),
  'the compact approval popup must not stack the large Session Details/Status modal beneath itself'
);
assert(
  !approvalPopupBody.includes('setStatusWindowOpen(true)'),
  'the compact approval popup must not open the combined Session Details/Status surface'
);

assertContains(
  approvalPopupBody,
  'availableDecisions',
  'approval buttons should be derived from the decisions supplied by Codex'
);
for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel']) {
  assert(
    new RegExp(`availableDecisions(?:\\.|\\?\\.)(?:has|includes)\\(['\"]${decision}['\"]\\)`).test(approvalPopupBody),
    `the compact popup should render ${decision} only when it is present in availableDecisions`
  );
}
assert(
  /if\s*\([^)]*goal[^)]*\)\s*\{[\s\S]{0,900}Auto Approve Goal/i.test(approvalPopupBody),
  'Auto Approve Goal should only be rendered behind an explicit active-goal guard'
);
assertContains(
  runner,
  'availableDecisions:',
  'host-agent should preserve Codex availableDecisions on approval request events'
);
assertContains(
  relay,
  'availableDecisions: entry.availableDecisions',
  'Relay should preserve availableDecisions when it stores and broadcasts an approval request'
);

assertContains(
  app,
  'respondingRequestKeys: new Set()',
  'all approval surfaces should share one in-flight request-response lock'
);
assertContains(
  app,
  'function isSessionRequestResponding(',
  'approval surfaces should query the shared responding-request lock through one helper'
);
assertContains(
  approvalPopupBody,
  'isSessionRequestResponding(session, request)',
  'compact approval buttons should stay disabled while the same request response is in flight'
);
const statusWindowBody = functionSource(app, 'renderStatusWindow', 'renderPickerEntries');
assertContains(
  statusWindowBody,
  'isSessionRequestResponding(session, request)',
  'Status approval buttons should share the same in-flight lock as the compact popup'
);
const respondToRequestBody = functionSource(app, 'respondToSessionRequest', 'setGoalAutoApproveForSession');
assertContains(
  respondToRequestBody,
  'respondingRequestKeys',
  'the central request responder should acquire the shared responding-request lock'
);
assertContains(
  respondToRequestBody,
  '.add(',
  'the central request responder should mark a request in flight before posting it'
);
assertContains(
  respondToRequestBody,
  'runId:',
  'approval responses must send the request runId so Relay cannot target a different Rebind run'
);
const resolvedRequestHandlerStart = app.indexOf("state.eventSource.addEventListener('session.request.resolved'");
const resolvedRequestHandlerEnd = app.indexOf('\n  });', resolvedRequestHandlerStart);
assert(
  resolvedRequestHandlerStart >= 0 && resolvedRequestHandlerEnd > resolvedRequestHandlerStart,
  'frontend should have a bounded session.request.resolved listener'
);
const resolvedRequestHandler = app.slice(resolvedRequestHandlerStart, resolvedRequestHandlerEnd);
assertContains(
  resolvedRequestHandler,
  'respondingRequestKeys',
  'the authoritative resolved event should release the shared responding-request lock'
);

const frontendRequestHandlerStart = app.indexOf("state.eventSource.addEventListener('session.request'");
const frontendRequestHandlerEnd = app.indexOf(
  "state.eventSource.addEventListener('session.request.resolved'",
  frontendRequestHandlerStart
);
assert(
  frontendRequestHandlerStart >= 0 && frontendRequestHandlerEnd > frontendRequestHandlerStart,
  'frontend should have a bounded session.request listener'
);
const frontendRequestHandler = app.slice(frontendRequestHandlerStart, frontendRequestHandlerEnd);
assertContains(
  frontendRequestHandler,
  'queuedUiRenders.approvalPopup = true;',
  'selected Session approval requests should display the compact approval popup'
);
assert(
  !frontendRequestHandler.includes('state.sessionDetailsOpen = true;'),
  'approval requests must not force open Session details'
);
assert(
  !frontendRequestHandler.includes('state.statusWindowOpen = false;'),
  'approval requests must preserve the existing status/detail view state'
);

console.log('approval routing assertions passed');
