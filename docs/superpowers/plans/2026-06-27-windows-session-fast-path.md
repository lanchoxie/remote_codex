# Windows Session Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows local sessions become responsive like Linux/HPC by starting heartbeat and command polling before slow history restore, adding watchdog startup grace, and preserving export dialog correctness.

**Architecture:** Keep the existing relay and host-agent architecture. Move startup discovery/tail priming to background tasks after host registration, add a relay startup-grace constant for local-agent watchdogs, and keep export dialog date state as ISO date strings.

**Tech Stack:** Node.js CommonJS scripts, PowerShell Windows launcher, static mobile web JavaScript, no new dependencies.

## Global Constraints

- Preserve existing session data and diagnostics files.
- Do not redesign `apps/relay/server.js`.
- Do not change Linux/HPC remote-agent deployment behavior except through shared safe fixes.
- Write or use a failing test before production changes.
- Keep each change scoped to the file responsible for the behavior.

---

### Task 1: Startup Watchdog Test Coverage

**Files:**
- Modify: `scripts/test-local-agent-startup-watchdog.js`

**Interfaces:**
- Consumes: source text from `apps/host-agent/agent.js`, `apps/relay/server.js`, `scripts/start-windows.ps1`.
- Produces: assertions that enforce startup loops before discovery and watchdog startup grace.

- [ ] **Step 1: Confirm current red test**

Run:

```powershell
node scripts\test-local-agent-startup-watchdog.js
```

Expected: FAIL with `host-agent must start heartbeats before initial discovery scans Codex history`.

- [ ] **Step 2: Strengthen the test for command polling**

Add an assertion that `pollCommandsLoop()` also appears before initial discovery in `main()`.

Expected test fragment:

```js
const pollStartIndex = agent.indexOf('pollCommandsLoop()', mainIndex);
assert(pollStartIndex >= 0, 'host-agent should start pollCommandsLoop() during startup');
assert(
  pollStartIndex < discoveryIndex,
  'host-agent must start command polling before initial discovery scans Codex history'
);
```

- [ ] **Step 3: Run test to verify it still fails for startup order**

Run:

```powershell
node scripts\test-local-agent-startup-watchdog.js
```

Expected: FAIL with a startup-order message.

### Task 2: Host Agent Startup Fast Path

**Files:**
- Modify: `apps/host-agent/agent.js`
- Test: `scripts/test-local-agent-startup-watchdog.js`

**Interfaces:**
- Consumes: existing functions `registerHost`, `sendDiscovery`, `pollCommandsLoop`, `discoveryLoop`, `heartbeatLoop`, `codexTailLoop`, `retryStartupStep`.
- Produces: startup order where command polling and heartbeat begin before initial discovery.

- [ ] **Step 1: Implement background startup helpers**

Add small helpers near `main()`:

```js
async function runStartupDiscovery() {
  await retryStartupStep('send initial discovery', sendDiscovery);
}

async function runStartupTailPrime() {
  if (!codexTailer) {
    return;
  }
  try {
    const result = codexTailer.prime();
    console.log(`[agent] codex tail primed ${result.sessionCount} session(s)`);
  } catch (error) {
    logAgentError('[agent] codex tail prime failed:', error.message);
  }
}
```

- [ ] **Step 2: Start polling/heartbeat before discovery**

Change `main()` so it registers the host, creates the loop promises, starts background discovery/tail prime, then awaits loops:

```js
await retryStartupStep('register host', registerHost);

const loops = [pollCommandsLoop(), discoveryLoop(), heartbeatLoop(), codexTailLoop()];

void runStartupDiscovery();
void runStartupTailPrime();

if (AUTO_START_SESSION) {
  void (async () => {
    try {
      await startManagedSession({ ... });
    } catch (error) {
      console.error('[agent] auto-start session failed:', error.message);
    }
  })();
}

await Promise.all(loops);
```

Preserve the existing `AUTO_START_SESSION` payload exactly.

- [ ] **Step 3: Run startup watchdog test**

Run:

```powershell
node scripts\test-local-agent-startup-watchdog.js
```

Expected: it may still fail on missing relay startup grace, but not on host-agent startup order.

- [ ] **Step 4: Run syntax check**

Run:

```powershell
node --check apps\host-agent\agent.js
```

Expected: no output and exit code 0.

### Task 3: Relay Watchdog Startup Grace

**Files:**
- Modify: `apps/relay/server.js`
- Test: `scripts/test-local-agent-startup-watchdog.js`

**Interfaces:**
- Consumes: existing `LOCAL_AGENT_OFFLINE_RESTART_MS`, `localAgentWatchdogTick()`.
- Produces: `LOCAL_AGENT_STARTUP_GRACE_MS` environment-driven startup grace.

- [ ] **Step 1: Add startup grace constant**

Near local-agent watchdog constants, add:

```js
const LOCAL_AGENT_STARTUP_GRACE_MS = Number(process.env.RELAY_LOCAL_AGENT_STARTUP_GRACE_MS || 5 * 60 * 1000);
```

- [ ] **Step 2: Use startup grace before stale heartbeat checks**

Change:

```js
if (startedAgeMs < LOCAL_AGENT_OFFLINE_RESTART_MS) {
  continue;
}
```

to:

```js
if (startedAgeMs < LOCAL_AGENT_STARTUP_GRACE_MS) {
  continue;
}
```

- [ ] **Step 3: Improve startup log**

Change the watchdog startup log to mention both stale heartbeat and startup grace.

- [ ] **Step 4: Run startup watchdog test**

Run:

```powershell
node scripts\test-local-agent-startup-watchdog.js
```

Expected: it may still fail on Windows launcher missing `RELAY_LOCAL_AGENT_STARTUP_GRACE_MS`.

- [ ] **Step 5: Run syntax check**

Run:

```powershell
node --check apps\relay\server.js
```

Expected: no output and exit code 0.

### Task 4: Windows Launcher Startup Grace

**Files:**
- Modify: `scripts/start-windows.ps1`
- Test: `scripts/test-local-agent-startup-watchdog.js`, `scripts/test-start-windows-script.js`

**Interfaces:**
- Consumes: relay environment variables set before launching `node apps/relay/server.js`.
- Produces: `RELAY_LOCAL_AGENT_STARTUP_GRACE_MS` set for local Windows relay launches.

- [ ] **Step 1: Set startup grace in relay command**

In the relay launch command block, add:

```ps1
`$env:RELAY_LOCAL_AGENT_STARTUP_GRACE_MS = '300000'
```

Keep `RELAY_LOCAL_AGENT_WATCHDOG_ENABLED` enabled.

- [ ] **Step 2: Run startup watchdog test**

Run:

```powershell
node scripts\test-local-agent-startup-watchdog.js
```

Expected: PASS with `local-agent startup watchdog assertions passed`.

- [ ] **Step 3: Run Windows launcher test**

Run:

```powershell
node scripts\test-start-windows-script.js
```

Expected: PASS with `start-windows script assertions passed`.

### Task 5: Export Dialog Regression Guard

**Files:**
- Modify: `apps/mobile-web/public/app.js`
- Test: `scripts/test-export-dialog.js`

**Interfaces:**
- Consumes: `getExportSelectableDays()`, `exportSelectedDaysToRanges()`, `exportSelectedSessionHistory()`.
- Produces: zip download links and date select-all behavior.

- [ ] **Step 1: Confirm export dialog test**

Run:

```powershell
npm run test:export-dialog
```

Expected: PASS with `export dialog assertions passed`.

- [ ] **Step 2: Verify date select-all disabled state uses strings**

Ensure this code uses `selectedDays.has(day)`:

```js
dateSelectAllButton.disabled = !selectableDays.length || selectableDays.every((day) => selectedDays.has(day));
```

- [ ] **Step 3: Verify zip download name**

Ensure `exportSelectedSessionHistory()` sets `.zip` for `zip` and `bundle`.

- [ ] **Step 4: Run syntax and export tests**

Run:

```powershell
node --check apps\mobile-web\public\app.js
npm run test:export-dialog
```

Expected: both pass.

### Task 6: Final Verification

**Files:**
- Verify: `apps/host-agent/agent.js`
- Verify: `apps/relay/server.js`
- Verify: `apps/mobile-web/public/app.js`
- Verify: `scripts/start-windows.ps1`

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check apps\host-agent\agent.js
node --check apps\relay\server.js
node --check apps\mobile-web\public\app.js
```

Expected: all exit 0.

- [ ] **Step 2: Run targeted tests**

Run:

```powershell
node scripts\test-local-agent-startup-watchdog.js
node scripts\test-start-windows-script.js
npm run test:export-dialog
```

Expected: all pass.

- [ ] **Step 3: Optional managed smoke**

Run:

```powershell
npm run test:managed
```

Expected: pass. If it fails due to existing environment assumptions, capture the exact failure.

- [ ] **Step 4: Review diff**

Run:

```powershell
git -c safe.directory=D:/project/cursor_english_dev/remote_codex -c core.quotepath=false diff -- apps/host-agent/agent.js apps/relay/server.js scripts/start-windows.ps1 apps/mobile-web/public/app.js scripts/test-local-agent-startup-watchdog.js scripts/test-export-dialog.js package.json docs/superpowers/specs/2026-06-27-windows-session-fast-path-design.md docs/superpowers/plans/2026-06-27-windows-session-fast-path.md
```

Expected: diff only contains the scoped changes from this plan and earlier export-dialog guard work.

