const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const scriptPath = path.join(ROOT, 'scripts', 'start-windows.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  !/node\s+apps\/host-agent\/agent\.js|node\s+apps\\host-agent\\agent\.js/i.test(script),
  'start-windows.ps1 must not launch host-agent directly; relay should own the single local agent'
);

assert(
  /\/api\/hosts\/[^/]+\/local-agent/.test(script) || /local-agent/.test(script),
  'start-windows.ps1 should start the relay-managed local agent through the relay API'
);

assert(
  /RELAY_LOCAL_AGENT_WATCHDOG_ENABLED/.test(script),
  'start-windows.ps1 should leave relay local-agent watchdog enabled explicitly'
);

console.log('start-windows script assertions passed');
