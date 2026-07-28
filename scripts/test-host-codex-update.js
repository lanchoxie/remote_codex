const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  bundledCodexRelativeCandidates,
  codexHomeRelativeCandidates,
  cursorCodexPlatformDirs,
  elfHeaderMatchesArchitecture,
} = require('../apps/host-agent/codex-app-server-runner');

const root = path.resolve(__dirname, '..');
const agent = fs.readFileSync(path.join(root, 'apps', 'host-agent', 'agent.js'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'apps', 'host-agent', 'codex-app-server-runner.js'), 'utf8');
const relay = fs.readFileSync(path.join(root, 'apps', 'relay', 'server.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'apps', 'mobile-web', 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'apps', 'mobile-web', 'public', 'styles.css'), 'utf8');

assert(agent.includes('codexRuntimeV1: true'), 'Host Agent must advertise Codex runtime metadata');
assert(agent.includes('codexUpdateV1: true'), 'Host Agent must advertise controlled Codex updates');
assert(agent.includes("command.type === 'host.codex_update'"), 'Host Agent must handle the fixed update command');
assert(agent.includes('uniqueLiveRunners().length'), 'Host Agent must reject update while managed runners remain');
assert(agent.includes("type: 'host.codex_updated'"), 'Host Agent must report a structured terminal result');
assert(agent.includes('codexUpdateResults'), 'Host Agent must make operation replay idempotent in-process');
assert(agent.includes('finalizeRecoveredCodexMaintenance'), 'Any successful recovered result delivery must release Agent maintenance');
assert(agent.includes('recovered.reported !== true'), 'Terminal journals must seed replay state even after their event was reported');

assert(runner.includes("platform === 'linux'"), 'Runner must choose bundled candidates by platform');
assert(runner.includes("arch === 'arm64'"), 'Runner must include an ARM64-specific bundled candidate');
assert(!runner.includes("path.join('.runtime', 'codex', 'bin', 'linux-x86_64', 'codex'),\n    path.join('.runtime', 'codex', 'linux-x86_64', 'codex')"), 'Runner must not unconditionally prefer x86-64 on Pi5');
const armBundleCandidates = bundledCodexRelativeCandidates('linux', 'arm64');
assert(armBundleCandidates[0].includes('linux-arm64'), 'ARM64-specific bundle must precede the generic binary');
assert(!codexHomeRelativeCandidates('linux', 'arm64').some((candidate) => candidate.includes('x86_64')), 'Pi5 CODEX_HOME candidates must exclude x86 binaries');
assert.deepStrictEqual(cursorCodexPlatformDirs('linux', 'arm64'), ['linux-arm64']);

const makeElfHeader = (machine) => {
  const header = Buffer.alloc(20);
  header[0] = 0x7f;
  header.write('ELF', 1, 'ascii');
  header[5] = 1;
  header.writeUInt16LE(machine, 18);
  return header;
};
assert.strictEqual(elfHeaderMatchesArchitecture(makeElfHeader(183), 'arm64'), true);
assert.strictEqual(elfHeaderMatchesArchitecture(makeElfHeader(62), 'arm64'), false);

assert(relay.includes("path.join(RELAY_STATE_ROOT, 'codex-update-operations.json')"), 'Relay must persist Host maintenance state under its isolated state root');
assert(relay.includes("'host_codex_maintenance'"), 'Relay must gate new Session starts during maintenance');
assert(relay.includes('assertHostLaunchAllowed(hostId, body.maintenanceOperationId)'), 'Session planning must enforce the maintenance gate');
assert(relay.includes("type: 'host.codex_update'"), 'Relay must enqueue a fixed Host update command');
assert(relay.includes("action === 'resuming'"), 'Relay must retain the gate while approved Sessions resume');
assert(relay.includes('blockedSessionIds'), 'Relay must block empty Sessions that cannot resume');
assert(relay.includes('liveUnmanagedSessionsForHost'), 'Relay must fail closed for live unmanaged Sessions');

assert(ui.includes("mode: 'codex-update'"), 'Host update must use the Session confirmation dialog');
assert(ui.includes('waitForSessionStopped(session, 30_000)'), 'UI must wait for confirmed Stop instead of using the restart fallback');
assert(ui.includes('maintenanceOperationId: operation.operationId'), 'Only the maintenance workflow may resume Sessions through the gate');
assert(ui.includes("status: 'left-stopped'"), 'Resume failures must remain visible per Session');
assert(ui.includes('Recover Sessions'), 'Interrupted maintenance must prioritize Session recovery');
assert(ui.includes("action: 'session-progress'"), 'Stop and resume progress must be persisted by Relay');
assert(ui.includes('recoveryOnly: options.recoveryOnly === true'), 'Stop failure recovery must use the recovery-only transition');
assert(ui.includes('progressSession.resumeRequestId'), 'Relay-issued resume attempt ids must make recovery idempotent');
assert(styles.includes('.host-codex-status'), 'Host cards must render bounded Codex status text');
assert(styles.includes('flex-wrap: wrap'), 'Host action buttons must wrap at narrow widths');

console.log('Host Codex update workflow contract assertions passed');
