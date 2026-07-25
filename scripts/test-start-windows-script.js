const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const scriptPath = path.join(ROOT, 'scripts', 'start-windows.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');
const relaySource = fs.readFileSync(path.join(ROOT, 'apps', 'relay', 'server.js'), 'utf8');
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
  /function Stop-RelayManagedLocalAgent/.test(script),
  'Windows restart must expose a Relay-managed graceful Host shutdown request'
);
const gracefulStopIndex = script.indexOf('Stop-RelayManagedLocalAgent -Url $url');
const restartBlock = script.slice(script.indexOf('if ($restartRequested)'));
const forcedAgentStopIndex = restartBlock.indexOf('Stop-RepoProcesses -Name "host-agent"');
assert(
  gracefulStopIndex >= 0
    && forcedAgentStopIndex > restartBlock.indexOf('Stop-RelayManagedLocalAgent -Url $url'),
  'Windows restart must attempt graceful Host shutdown before force-killing leftovers'
);
assert(
  /taskkill\.exe/.test(script)
    && /["']\/T["']/.test(script)
    && /["']\/F["']/.test(script),
  'Windows fallback must terminate the complete Host agent process tree'
);
const pathBoundarySource = script.slice(
  script.indexOf('function Test-CommandReferencesPath'),
  script.indexOf('function Test-ProcessOwnedByRepoScript')
);
const repoProcessSelector = script.slice(
  script.indexOf('function Test-ProcessOwnedByRootScript'),
  script.indexOf('function Get-RelayManagedAgentProcess')
);
assert(
  /\$expectedScript = Join-Path \$RepoRoot \$RelativeScript/.test(repoProcessSelector)
    && /Test-CommandReferencesPath -Text \$commandLine -PathValue \$expectedScript/.test(repoProcessSelector)
    && /Get-StrictSetLocationRoot -CommandLine \$parentCommand/.test(repoProcessSelector)
    && /Test-PathEquals -Left \$launcherRoot -Right \$RepoRoot/.test(repoProcessSelector)
    && /Test-ProcessOwnedByRootScript -Process \$Process -RepoRoot \$Root/.test(repoProcessSelector)
    && !/-or\s+-not\s+\$cmdNorm\.Contains/.test(repoProcessSelector),
  'repo process selection must prove checkout ownership from the process or its launcher parent'
);
if (process.platform === 'win32') {
  const boundaryProbe = `${pathBoundarySource}
$Root = 'D:\\repo\\remote_codex'
$root = 'D:\\repo\\remote_codex'
if (-not (Test-CommandReferencesPath -Text 'node D:\\repo\\remote_codex\\apps\\relay\\server.js' -PathValue "$root\\apps\\relay\\server.js")) { exit 11 }
if (-not (Test-CommandReferencesPath -Text "Set-Location -LiteralPath 'D:\\repo\\remote_codex'" -PathValue $root)) { exit 12 }
if (Test-CommandReferencesPath -Text 'node D:\\repo\\remote_codex-dev\\apps\\relay\\server.js' -PathValue $root) { exit 13 }
if (Test-CommandReferencesPath -Text 'node D:\\repo\\remote_codex-old\\apps\\relay\\server.js' -PathValue $root) { exit 14 }
if (Test-CommandReferencesPath -Text 'node D:\\repo\\remote_codex\\.worktrees\\dev\\apps\\relay\\server.js' -PathValue $root) { exit 15 }
if (-not (Test-PathEquals -Left (Get-StrictSetLocationRoot -CommandLine "prefix; Set-Location -LiteralPath 'D:\\repo\\remote_codex'; node app.js") -Right $root)) { exit 16 }
if (Get-StrictSetLocationRoot -CommandLine "prefix; Set-Location -Path 'D:\\repo\\remote_codex'; node app.js") { exit 17 }
if (Get-StrictSetLocationRoot -CommandLine "prefix; \`$env:LOG='D:\\repo\\remote_codex'; node app.js") { exit 18 }
$wrongRoot = Get-StrictSetLocationRoot -CommandLine "prefix; Set-Location -LiteralPath 'D:\\repo\\remote_codex-dev'; node app.js"
if (Test-PathEquals -Left $wrongRoot -Right $root) { exit 19 }
`;
  const boundaryResult = spawnSync(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-Command', boundaryProbe],
    { encoding: 'utf8' }
  );
  assert(
    boundaryResult.status === 0,
    `checkout path-boundary probe failed (${boundaryResult.status}): ${boundaryResult.stderr || boundaryResult.stdout}`
  );
}
assert(
  /\.owner\.json/.test(script)
    && /Get-RelayManagedAgentProcess/.test(script),
  'Windows restart must recover Relay-managed Agents from their ownership marker'
);
const managedAgentSelector = script.slice(
  script.indexOf('function Get-RelayManagedAgentProcess'),
  script.indexOf('function Stop-RepoProcesses')
);
assert(
  /Test-ProcessOwnedByRepoScript -Process \$process -RelativeScript "apps\\host-agent\\agent\.js"/.test(managedAgentSelector)
    && !/-or\s+-not\s+\$commandNorm\.Contains/.test(managedAgentSelector),
  'ownership marker PID selection must require the exact current repo root'
);
assert(
  /\[string\]\$owner\.hostId\s+-ceq\s+\$TargetHostId/.test(managedAgentSelector),
  'ownership marker recovery must compare Host IDs case-sensitively on Windows'
);
assert(
  /\[string\]\$owner\.relayUrl\s+-ceq\s+\$TargetRelayUrl/.test(managedAgentSelector),
  'ownership marker recovery must belong to the exact target Relay URL'
);
assert(
  /if \(\$relayProcesses\.Count -gt 0\)/.test(script),
  'Windows restart must request graceful shutdown even when a recovered Agent is not a direct Relay child'
);

assert(
  /tmp\\relay-\$Port/.test(script) && /\$RelayStateRoot/.test(script),
  'alternate Windows Relay ports must use a common port-isolated state root'
);
assert(
  /`\$env:SESSION_RECORD_STORE_ROOT/.test(script),
  'Windows launcher must explicitly pass the selected Session Store root to Relay'
);

const devScript = fs.readFileSync(path.join(ROOT, 'scripts', 'dev.js'), 'utf8');
const devConfigScript = fs.readFileSync(path.join(ROOT, 'scripts', 'dev-instance-config.js'), 'utf8');
assert(
  /resolveDevInstanceConfig/.test(devScript) && /`relay-\$\{port\}`/.test(devConfigScript),
  'bare npm run dev must derive a port-isolated Relay state root'
);
assert(
  /refuses production port 8797/.test(devConfigScript)
    && /REMOTE_CODEX_DEV_STATE_ROOT/.test(devConfigScript),
  'bare npm run dev must reject the production port and use a dev-specific state override'
);
assert(
  /Get-EnvOrDefault -Name "RELAY_STATE_ROOT"/.test(script)
    && /\$RelayStateEnvironment/.test(script),
  'Windows launcher must honor and pass an explicit RELAY_STATE_ROOT'
);
assert(
  /function Get-PortListenerProcessIds/.test(script)
    && /Get-PortListenerProcessIds -LocalPort \$Port/.test(script),
  'Windows launcher must select Relay processes by the requested listening port'
);
assert(
  (script.match(/Get-NetTCPConnection[^\r\n]+-ErrorAction Stop/g) || []).length >= 2,
  'Windows listener discovery must enter its netstat fallback when Get-NetTCPConnection fails'
);
assert(
  /Get-VerifiedCurrentRelayProcess/.test(script)
    && /remote-codex-relay-owner/.test(script)
    && /\[string\]\$health\.instanceId -cne \[string\]\$owner\.instanceId/.test(script)
    && /Test-PhysicalPathEquals -Left \(\[string\]\$owner\.stateRoot\) -Right \$StateRoot/.test(script),
  'Windows launcher must bind current Relay reuse to the target state root owner and live instance'
);
assert(
  /\$relayListenerIds -contains \[int\]\$_.ParentProcessId/.test(script),
  'Windows launcher may stop only Host agents parented by the target-port Relay'
);

for (const variable of [
  'SESSION_RECORD_STORE_ROOT',
  'SESSION_COLLECTIONS_PATH',
  'SESSION_METADATA_PATH',
  'SESSION_LOGS_PATH',
  'SESSION_DIAGNOSTICS_PATH',
  'CONNECTORS_PATH',
  'CONNECTOR_SECRETS_PATH',
  'SKILL_FAVORITES_PATH',
  'SKILL_SOURCES_PATH',
  'SKILL_LIBRARY_PATH',
  'SKILL_INVENTORIES_PATH',
  'SKILL_REGISTRY_PATH',
  'SKILL_ARTIFACT_ROOT',
  'SKILL_DEPLOYMENTS_PATH',
  'SKILL_AUDIT_PATH',
]) {
  assert(script.includes("`$env:" + variable), `Windows launcher must isolate ${variable}`);
  assert(devConfigScript.includes(variable), `bare npm run dev must isolate ${variable}`);
}
assert(
  /tmp\\windows-start-\$Port/.test(script),
  'alternate Windows Relay ports must not append to the production log'
);
assert(
  /\$configuredRelayStateRoot = if \(\$isProductionPort\)[\s\S]*Get-EnvOrDefault -Name "RELAY_STATE_ROOT"[\s\S]*else \{\s*""\s*\}/.test(script)
    && /if \(\$Port -eq 8797\)[\s\S]*Get-EnvOrDefault -Name \$Name/.test(script),
  'alternate Windows Relay ports must ignore inherited and custom production state roots'
);
assert(
  /RELAY_LOCAL_AGENT_START_ENABLED/.test(script)
    && /\$LocalAgentStartEnabled = \$isProductionPort/.test(script)
    && /if \(\$LocalAgentStartEnabled\)[\s\S]*Start-RelayManagedLocalAgent/.test(script),
  'alternate Windows Relay ports must disable Relay-managed local Agent startup'
);
for (const variable of [
  'REMOTE_CODEX_STATE_ROOT',
  'AGENTS_HOME',
  'CC_SWITCH_HOME',
  'SKILL_ARTIFACT_TEMP_ROOT',
  'RELAY_LOCAL_HOST_ID',
  'RELAY_LOCAL_HOST_LABEL',
]) {
  assert(script.includes("`$env:" + variable), `Windows launcher must set ${variable} per instance`);
}
assert(
  /Remove-Item Env:RELAY_AUTH_TOKEN/.test(script)
    && /`\$env:RELAY_AUTH_DISABLED = 'false'/.test(script),
  'alternate Windows Relay ports must clear inherited production authentication overrides'
);
assert(
  /throw "Port \$Port is already owned by another or unverified process/.test(script),
  'Windows launcher must fail closed instead of reusing an unverified port listener'
);
const siblingTakeoverSource = script.slice(
  script.indexOf('function Get-VerifiedSiblingRelayCandidate'),
  script.indexOf('function Stop-RepoProcesses')
);
assert(
  /\$LocalPort -ne 8797/.test(siblingTakeoverSource)
    && /\$listenerIds\.Count -ne 1/.test(siblingTakeoverSource)
    && /Test-SiblingRepoRoot/.test(siblingTakeoverSource)
    && /Get-StrictSetLocationRoot/.test(siblingTakeoverSource),
  'sibling checkout takeover must be limited to one verified production listener and strict launcher root'
);
assert(
  /\$health\.ok -ne \$true/.test(siblingTakeoverSource)
    && /"\$Url\/api\/hosts"/.test(siblingTakeoverSource)
    && /Get-RelayAuthHeaderForPath -TokenPath \$tokenPath/.test(siblingTakeoverSource),
  'sibling takeover must verify health JSON and authenticate with the active sibling token'
);
assert(
  /\[int\]\$agentProcess\.ParentProcessId -ne \[int\]\$relayProcess\.ProcessId/.test(siblingTakeoverSource)
    && /Test-ProcessOwnedByRootScript[\s\S]*apps\\host-agent\\agent\.js/.test(siblingTakeoverSource),
  'sibling local Agent PID must be a verified child from the exact sibling checkout'
);
assert(
  /function Assert-SiblingRelayCandidateUnchanged/.test(script)
    && /Port \$LocalPort ownership changed during sibling Relay takeover/.test(script)
    && /Sibling Relay process identity changed during takeover/.test(script),
  'sibling takeover must revalidate both port and process identity before stopping anything'
);
assert(
  /function Request-RelayShutdown/.test(script)
    && /\/api\/control\/shutdown/.test(script)
    && /Wait-ProcessExit/.test(script)
    && /Get-RelayControlHeaderForPath/.test(script)
    && /X-Relay-Control-Token/.test(script),
  'Windows restart must request authenticated Relay shutdown and wait for verified exit'
);
assert(
  /\[int\]\$RelayShutdownTimeoutSeconds\s*=\s*120/.test(script)
    && (script.match(/-TimeoutSeconds \$RelayShutdownTimeoutSeconds/g) || []).length >= 2
    && /still closing persistence after \$RelayShutdownTimeoutSeconds seconds/.test(script),
  'Windows restart must allow large Relay snapshots to close without weakening the no-force persistence guard'
);
assert(
  /Current Relay rejected its control token; refusing force restart/.test(script)
    && /Verified sibling Relay rejected its control token; refusing force takeover/.test(script),
  'a present but rejected control token must be a hard failure, never a force-kill fallback'
);
assert(
  /Backed up the current stable Relay token/.test(script)
    && /Adopted the verified active Relay token/.test(script)
    && !/Write-Host[^\r\n]*\$sourceToken/.test(script)
    && !/Write-Host[^\r\n]*\$targetToken/.test(script),
  'sibling takeover must back up and adopt authentication without printing token contents'
);
const stopRepoSource = script.slice(
  script.indexOf('function Stop-RepoProcesses'),
  script.indexOf('function Start-RemoteCodexConsole')
);
assert(
  /is still running after the stop request/.test(stopRepoSource)
    && /throw "Failed to stop \$Name PID/.test(stopRepoSource),
  'process stop failures and surviving PIDs must be hard launcher failures'
);
assert(
  !/Stop-Process\s+-Id\s+\$Candidate\.ParentProcessId/.test(script)
    && !/taskkill[^\r\n]*ParentProcessId/i.test(script),
  'sibling takeover must never terminate the parent PowerShell console'
);
assert(
  /\$RelayServerPath = Join-Path \$Root "apps\\relay\\server\.js"/.test(script)
    && /node \$\(ConvertTo-PsLiteral \$RelayServerPath\)/.test(script),
  'Windows launcher must use an absolute Relay script path so checkout ownership is verifiable'
);
for (const variable of ['RELAY_CONTROL_TOKEN_PATH', 'SSH_KNOWN_HOSTS_PATH']) {
  assert(script.includes("`$env:" + variable), `Windows launcher must isolate ${variable}`);
  assert(devConfigScript.includes(variable), `bare npm run dev must isolate ${variable}`);
}
assert(
  /SSH_KNOWN_HOSTS_PATH[\s\S]*path\.join\(RELAY_STATE_ROOT, 'ssh', 'known_hosts'\)/.test(relaySource)
    && /userKnownHostsFile:\s*SSH_KNOWN_HOSTS_PATH/.test(relaySource)
    && /UserKnownHostsFile=\$\{options\.userKnownHostsFile\}/.test(relaySource),
  'automatic SSH actions must use a Relay-instance-owned known_hosts file'
);
assert(
  !/function getConnectorSshOptions/.test(relaySource)
    && !/sshMultiplexDisabled/.test(relaySource)
    && !/actionMultiplexFallback/.test(relaySource),
  'disabled SSH multiplexing must not leave unreachable fallback state and branches'
);
assert(
  !/process\.env\.RELAY_URL/.test(devScript)
    && /RELAY_URL: config\.relayUrl/.test(devConfigScript),
  'development Agent must never inherit a production Relay URL'
);
assert(
  /const agent = config\.withAgent/.test(devScript)
    && /AUTO_START_SESSION: 'false'/.test(devConfigScript)
    && /RELAY_LOCAL_AGENT_START_ENABLED: 'false'/.test(devConfigScript)
    && /RELAY_LOCAL_HOST_STUB: 'false'/.test(devConfigScript),
  'bare npm run dev must keep the real Agent disabled unless explicitly requested'
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
