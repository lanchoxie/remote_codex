const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(ROOT, 'apps', 'mobile-web', 'public', 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'apps', 'mobile-web', 'public', 'app.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(ROOT, 'apps', 'mobile-web', 'public', 'styles.css'), 'utf8');
const relaySource = fs.readFileSync(path.join(ROOT, 'apps', 'relay', 'server.js'), 'utf8');

function functionBlock(name, nextName) {
  const start = appSource.indexOf(`${name}(`);
  assert(start >= 0, `expected ${name} to exist`);
  const end = nextName ? appSource.indexOf(`${nextName}(`, start + name.length) : -1;
  return appSource.slice(start, end > start ? end : appSource.length);
}

const dom = new JSDOM(indexSource);
const button = dom.window.document.getElementById('open-session-terminal-button');
assert(button, 'Session actions should include an Open Terminal button');
const feedback = dom.window.document.getElementById('open-session-terminal-feedback');
assert(feedback, 'Session actions should include an Open Terminal feedback region');
assert.strictEqual(feedback.hidden, true);
assert.strictEqual(button.type, 'button');
assert(button.hidden, 'Open Terminal should stay hidden until a Session is selected');
assert(button.textContent.includes('>_'));
assert(button.textContent.includes('Terminal'));

assert(appSource.includes('sessionTerminalBusyKeys: new Set()'));
assert(appSource.includes('sessionTerminalFeedback: new Map()'));

const availabilityBlock = functionBlock(
  'function sessionTerminalAvailability',
  'function clearSessionTerminalFeedback'
);
assert(availabilityBlock.includes("String(session.cwd || '').trim()"));
assert(availabilityBlock.includes('if (!host.online)'));
assert(availabilityBlock.includes('host.capabilities?.openTerminalV1 !== true'));

const openBlock = functionBlock('async function openTerminalForSession', 'function renderSessionDetails');
const requestStart = openBlock.indexOf('const result = await fetchJson(');
const requestEnd = openBlock.indexOf(');', requestStart);
const requestBlock = openBlock.slice(requestStart, requestEnd + 2);
assert(requestBlock.includes('/open-terminal`'));
assert(requestBlock.includes("method: 'POST'"));
assert(requestBlock.includes('JSON.stringify({ requestId })'));
assert(!/\bcwd\s*:/.test(requestBlock), 'Browser must not submit a cwd for terminal launch');
assert(!/\b(command|executable)\s*:/.test(requestBlock), 'Browser must not submit a command or executable');
assert(openBlock.indexOf('sessionTerminalBusyKeys.add(sessionKey)') < requestStart);
assert(openBlock.includes('if (!sessionKey || state.sessionTerminalBusyKeys.has(sessionKey)) return false;'));
assert(openBlock.includes('result.hostId !== session.hostId'));
assert(openBlock.includes('result.sessionId !== session.sessionId'));
assert(openBlock.includes('sessionTerminalBusyKeys.delete(sessionKey)'));

const renderBlock = functionBlock('function renderSessionDetails', 'function renderThinkingPanel');
assert(renderBlock.includes("el('open-session-terminal-button')"));
assert(renderBlock.includes("terminalButton.classList.toggle('hidden', !visible)"));
assert(renderBlock.includes('terminalButton.disabled = !availability.enabled || busy'));
assert(renderBlock.includes("? 'Opening...'"));
assert(renderBlock.includes("? 'Opened'"));
assert(renderBlock.includes("? 'Failed'"));
assert(renderBlock.includes("open-session-terminal-feedback"));
assert(renderBlock.includes('terminalButtonFeedback.textContent = feedbackMessage'));

assert(appSource.includes("el('open-session-terminal-button')?.addEventListener('click'"));
assert(appSource.includes('await openTerminalForSession(getSelectedSession())'));
assert(styleSource.includes('.session-terminal-button'));
assert(styleSource.includes('white-space: nowrap'));
assert(styleSource.includes('.detail-actions'));
assert(styleSource.includes('flex-wrap: wrap'));

const relayRouteStart = relaySource.indexOf(
  "url.pathname.match(/^\\/api\\/hosts\\/[^/]+\\/sessions\\/[^/]+\\/open-terminal$/)"
);
assert(relayRouteStart >= 0, 'Relay should expose the selected-Session terminal endpoint');
const relayRouteEnd = relaySource.indexOf(
  "url.pathname.match(/^\\/api\\/hosts\\/[^/]+\\/files\\/uploads$/)",
  relayRouteStart
);
const relayRoute = relaySource.slice(relayRouteStart, relayRouteEnd);
assert(relayRoute.includes("const cwd = String(session.cwd || '').trim()"));
assert(!relayRoute.includes('body.cwd'), 'Relay must ignore browser-provided cwd values');
assert(!relayRoute.includes('body.command'), 'Relay must not accept a browser-provided terminal command');

console.log('open terminal UI contract checks passed');
