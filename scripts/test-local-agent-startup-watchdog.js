const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const agentPath = path.join(ROOT, 'apps', 'host-agent', 'agent.js');
const relayPath = path.join(ROOT, 'apps', 'relay', 'server.js');
const mobileAppPath = path.join(ROOT, 'apps', 'mobile-web', 'public', 'app.js');
const windowsStartPath = path.join(ROOT, 'scripts', 'start-windows.ps1');

const agent = fs.readFileSync(agentPath, 'utf8');
const relay = fs.readFileSync(relayPath, 'utf8');
const mobileApp = fs.readFileSync(mobileAppPath, 'utf8');
const windowsStart = fs.readFileSync(windowsStartPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sourceSlice(source, startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  assert(startIndex >= 0, `source marker not found: ${startMarker}`);
  assert(endIndex > startIndex, `source end marker not found after ${startMarker}: ${endMarker}`);
  return source.slice(startIndex, endIndex);
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
  pollStartIndex > startupDiscoveryCallIndex,
  'host-agent must restore workspace roots before polling project deployment commands'
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
assert(
  /type:\s*'host\.shutdown'/.test(relay),
  'Relay-managed local-agent Stop must request graceful Agent shutdown through the command channel'
);
assert(
  /LOCAL_AGENT_SHUTDOWN_GRACE_MS/.test(relay) && /shutdownTimer/.test(relay),
  'Relay-managed local-agent Stop must retain a bounded force-kill fallback'
);
assert(
  /restartAfterStop/.test(relay),
  'local-agent Restart must wait for graceful shutdown before spawning its replacement'
);
assert(
  /probeLocalAgentProcessIdentity/.test(relay)
    && /assessLocalAgentOwnershipMarker/.test(relay)
    && /staleOwnershipRecovered/.test(relay),
  'local-agent startup must recover stale ownership through verified process identity assessment'
);
const hostRecoveryCopySource = sourceSlice(
  mobileApp,
  'const HOST_RECOVERY_COPY =',
  'function hostRecoveryCopy'
);
const ownershipPendingDisplaySource = sourceSlice(
  mobileApp,
  'function ownershipPendingDisplay',
  'function setHostRecoveryResult'
);
const localAgentRecoveryIdentitySource = sourceSlice(
  mobileApp,
  'function localAgentRecoveryIdentityReady',
  'async function runLocalAgentAction'
);
const runLocalAgentActionSource = sourceSlice(
  mobileApp,
  'async function runLocalAgentAction',
  'function getHostLifecycleAction'
);
const waitForLocalAgentStoppedSource = sourceSlice(
  mobileApp,
  'async function waitForLocalAgentStopped',
  'async function recoverHostForSwitch'
);
const reportErrorSource = sourceSlice(
  mobileApp,
  'function reportError',
  'async function submitHostImport'
);

assert(
  /local_agent_start/.test(hostRecoveryCopySource)
    && /local_agent_restart/.test(hostRecoveryCopySource)
    && /hpc_connector_restart/.test(hostRecoveryCopySource),
  'Host recovery UI must distinguish local start, local restart, and HPC connector restart'
);
assert(
  /Retry in about/.test(ownershipPendingDisplaySource)
    && /if \(result\?\.status === 'ownership_pending'\)/.test(runLocalAgentActionSource)
    && /status:\s*'ownership_pending'/.test(runLocalAgentActionSource)
    && /ownershipPendingDisplay\(result\)/.test(runLocalAgentActionSource)
    && /return;/.test(runLocalAgentActionSource)
    && !/reportError\(/.test(runLocalAgentActionSource),
  'ownership_pending must remain a visible Host status with retry guidance instead of a Session error'
);
assert(
  /error\?\.hostRecoveryScoped\s*&&\s*error\.hostId/.test(reportErrorSource)
    && reportErrorSource.indexOf('return;') < reportErrorSource.indexOf('appendAlertForSession'),
  'Host-scoped recovery failures must return before Session alert routing'
);
assert(
  /recoveryKind === 'local_agent_restart'/.test(localAgentRecoveryIdentitySource)
    && /currentPid !== referencePid/.test(localAgentRecoveryIdentitySource),
  'local Agent restart must not complete until a running replacement has a different PID'
);
const stopWaitIndex = runLocalAgentActionSource.indexOf('await waitForLocalAgentStopped');
const stopCompletedIndex = runLocalAgentActionSource.indexOf("status: 'completed'", stopWaitIndex);
assert(
  stopWaitIndex >= 0
    && stopCompletedIndex > stopWaitIndex
    && /localAgent\.status === 'stopped'\s*&&\s*!localAgent\.pid/.test(waitForLocalAgentStoppedSource),
  'local Agent stop must stay non-terminal until status is stopped and the PID is gone'
);
assert(
  !/still offline after connector restart/.test(hostRecoveryCopySource),
  'local Agent recovery must not reuse the old connector-restart timeout message'
);

console.log('local-agent startup watchdog assertions passed');
