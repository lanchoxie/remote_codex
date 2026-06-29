const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const scriptPath = path.join(ROOT, 'scripts', 'start-windows.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');
const startBatPath = path.join(ROOT, 'Start Remote Codex.bat');
const setupBatPath = path.join(ROOT, 'Setup and Start Remote Codex.bat');

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

assert(
  /\[switch\]\$SkipPreflight/.test(script),
  'start-windows.ps1 should expose -SkipPreflight for advanced users and tests'
);

assert(
  /codex-preflight/.test(script),
  'start-windows.ps1 should run local Codex preflight before launching relay'
);

assert(
  fs.existsSync(startBatPath),
  'repo root should include a double-click Start Remote Codex.bat'
);
assert(
  fs.existsSync(setupBatPath),
  'repo root should include a double-click Setup and Start Remote Codex.bat'
);

const startBat = fs.existsSync(startBatPath) ? fs.readFileSync(startBatPath, 'utf8') : '';
const setupBat = fs.existsSync(setupBatPath) ? fs.readFileSync(setupBatPath, 'utf8') : '';

assert(
  /scripts\\start-windows\.ps1/.test(startBat),
  'Start Remote Codex.bat should call scripts\\start-windows.ps1'
);
assert(
  /download-runtimes\.bat/.test(setupBat),
  'Setup and Start Remote Codex.bat should download runtimes before launch'
);
assert(
  /scripts\\start-windows\.ps1/.test(setupBat),
  'Setup and Start Remote Codex.bat should call scripts\\start-windows.ps1 after setup'
);

console.log('start-windows script assertions passed');
