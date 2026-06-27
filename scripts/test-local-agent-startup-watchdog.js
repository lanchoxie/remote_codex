const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const agentPath = path.join(ROOT, 'apps', 'host-agent', 'agent.js');
const relayPath = path.join(ROOT, 'apps', 'relay', 'server.js');
const windowsStartPath = path.join(ROOT, 'scripts', 'start-windows.ps1');

const agent = fs.readFileSync(agentPath, 'utf8');
const relay = fs.readFileSync(relayPath, 'utf8');
const windowsStart = fs.readFileSync(windowsStartPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const mainIndex = agent.indexOf('async function main()');
const heartbeatStartIndex = agent.indexOf('heartbeatLoop()', mainIndex);
const pollStartIndex = agent.indexOf('pollCommandsLoop()', mainIndex);
const discoveryLoopStartIndex = agent.indexOf('discoveryLoop()', mainIndex);
const startupDiscoveryCallIndex = agent.indexOf('runStartupDiscovery()', mainIndex);
const discoveryIndex = agent.indexOf("retryStartupStep('send initial discovery'");
assert(mainIndex >= 0, 'host-agent main() must exist');
assert(heartbeatStartIndex >= 0, 'host-agent should start heartbeatLoop() during startup');
assert(pollStartIndex >= 0, 'host-agent should start pollCommandsLoop() during startup');
assert(discoveryLoopStartIndex >= 0, 'host-agent should still start discoveryLoop()');
assert(discoveryIndex >= 0, 'host-agent should still send initial discovery');
assert(startupDiscoveryCallIndex >= 0, 'host-agent should start initial discovery as a background startup task');
assert(
  heartbeatStartIndex < discoveryLoopStartIndex,
  'host-agent must start heartbeats before the recurring discovery loop'
);
assert(
  pollStartIndex < discoveryLoopStartIndex,
  'host-agent must start command polling before the recurring discovery loop'
);
assert(
  heartbeatStartIndex < startupDiscoveryCallIndex,
  'host-agent must start heartbeats before initial discovery scans Codex history'
);
assert(
  pollStartIndex < startupDiscoveryCallIndex,
  'host-agent must start command polling before initial discovery scans Codex history'
);

assert(
  /LOCAL_AGENT_STARTUP_GRACE_MS/.test(relay),
  'relay watchdog should have a startup grace separate from stale heartbeat timeout'
);
assert(
  /startedAgeMs\s*<\s*LOCAL_AGENT_STARTUP_GRACE_MS/.test(relay),
  'relay watchdog should use startup grace before judging heartbeat stale'
);
assert(
  /RELAY_LOCAL_AGENT_STARTUP_GRACE_MS/.test(windowsStart),
  'Windows launcher should set a longer local-agent startup grace for cold Codex history scans'
);

console.log('local-agent startup watchdog assertions passed');
