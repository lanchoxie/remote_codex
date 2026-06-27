# Windows Session Fast Path Design

## Problem

Windows local sessions are often unusable while Linux/HPC sessions feel fast. The observed Windows symptoms are:

- The Windows host spends a long time restoring history.
- The Windows local agent repeatedly restarts.
- Conversation input appears to hang or never reaches a live runner.
- Export dialog regressions make selected zip exports and date select-all unreliable.

This is not simply a hardware difference. The current local Windows path lets slow startup/history/diagnostic work block the live conversation path, and the relay watchdog can restart the local agent while it is still doing cold startup work.

## Evidence

Current local-agent startup order in `apps/host-agent/agent.js` starts long discovery work before the heartbeat and command polling loops:

```js
await retryStartupStep('register host', registerHost);
await retryStartupStep('send initial discovery', sendDiscovery);
if (codexTailer) {
  const result = codexTailer.prime();
  console.log(`[agent] codex tail primed ${result.sessionCount} session(s)`);
}
await Promise.all([pollCommandsLoop(), discoveryLoop(), heartbeatLoop(), codexTailLoop()]);
```

The existing startup watchdog test captures the intended behavior and currently fails:

```text
Error: host-agent must start heartbeats before initial discovery scans Codex history
```

The relay watchdog currently has one stale-heartbeat threshold:

```js
const LOCAL_AGENT_OFFLINE_RESTART_MS = Number(process.env.RELAY_LOCAL_AGENT_OFFLINE_RESTART_MS || 45000);
```

It uses that threshold both as an initial process-age delay and as stale-heartbeat restart logic. There is no separate cold-start grace period.

Windows local-agent logs show repeated startup loops:

```text
[agent] host illuin connecting to http://127.0.0.1:8797
[agent] codex home C:\Users\xiety\.codex
[agent] codex tail primed 87/88 session(s)
```

Error logs show relay connectivity symptoms during those loops:

```text
relay request timed out
read ECONNRESET
connect ECONNREFUSED 127.0.0.1:8797
```

Relay state showed the Windows local agent restarted repeatedly, with a recent reason similar to:

```text
heartbeat stale for 47s
```

The local diagnostics store is large and synchronously rewritten:

- `tmp/session-diagnostics.json`: about 38 MB.
- Largest entries are `illuin::*`.
- `saveSessionDiagnostics()` serializes and writes the whole diagnostics map synchronously.

The command path is also serialized per host. Interactive commands such as `session.input` share the same queue as slow commands such as `session.detail`, `session.search`, file transfers, and export-related work.

The export dialog has a date model mismatch:

- `getExportSelectableDays()` returns strings such as `"2026-06-24"`.
- Some render/selection code still treats days as objects with `.date`.

## Goals

1. Windows local sessions should become interactive as soon as the host is registered and a live runner is available.
2. Cold history discovery must not block heartbeat or command polling.
3. The watchdog must not restart a healthy-but-starting local agent during cold history scans.
4. Conversation input, interrupt, and steer commands must not wait behind slow history/detail/search/export work.
5. Export zip and date select-all behavior must be deterministic and covered by tests.
6. Changes must preserve Linux/HPC behavior and avoid broad rewrites.

## Non-Goals

- Do not redesign the full relay server.
- Do not migrate all persisted session state in this pass.
- Do not delete or clear user history.
- Do not change Linux/HPC deployment behavior unless a shared bugfix naturally applies.
- Do not rebuild the mobile UI layout.

## Design Overview

The main design is to split the system into two practical paths:

- Fast path: host registration, heartbeat, command polling, live session input, interrupt, steer.
- Slow path: initial discovery, Codex JSONL tail priming, full detail loading, search, export summary, file operations, diagnostics persistence.

The fast path must start first and remain responsive even when the slow path is busy.

## Phase P0: Startup Fast Path

### Agent Startup

After `registerHost` succeeds, the host agent should immediately start:

- `heartbeatLoop()`
- `pollCommandsLoop()`
- `codexTailLoop()` if available

Initial discovery and tail priming should run as background startup tasks:

- `sendDiscovery()`
- `codexTailer.prime()`
- optional `AUTO_START_SESSION`

Failures in background startup should be logged and surfaced as diagnostics where appropriate, but they must not kill the agent after heartbeat/polling has started.

The intended main shape is:

```js
await retryStartupStep('register host', registerHost);

const loops = [
  pollCommandsLoop(),
  heartbeatLoop(),
  discoveryLoop(),
  codexTailLoop(),
];

void runStartupDiscovery();
void runStartupTailPrime();
void runOptionalAutoStart();

await Promise.all(loops);
```

The exact implementation can keep existing loop functions and should avoid introducing a new framework or scheduler.

### Watchdog Startup Grace

Relay should add a separate startup grace variable:

```js
const LOCAL_AGENT_STARTUP_GRACE_MS = Number(
  process.env.RELAY_LOCAL_AGENT_STARTUP_GRACE_MS || 5 * 60 * 1000
);
```

`localAgentWatchdogTick()` should skip stale-heartbeat restart while:

```js
startedAgeMs < LOCAL_AGENT_STARTUP_GRACE_MS
```

After startup grace expires, existing stale-heartbeat restart behavior can still apply.

### Windows Launcher

`scripts/start-windows.ps1` should set a longer cold-start grace for local Windows agents:

```ps1
$env:RELAY_LOCAL_AGENT_STARTUP_GRACE_MS = '300000'
```

Five minutes is the initial target. If local Codex history is extremely large, this can be raised by environment override without code changes.

## Phase P1: Export Dialog Correctness

The export dialog should use one date representation: ISO date strings.

Required fixes:

- `getExportSelectableDays()` returns `string[]`.
- The select-all handler sets `selectedDays` to `new Set(getExportSelectableDays().filter(Boolean))`.
- The select-all disabled state checks `selectedDays.has(day)`, not `selectedDays.has(day.date)`.
- Export range generation continues to consume date strings.
- Zip export from the dialog must pass `format=zip`.
- The generated download link should have a `.zip` file name for `zip` and `bundle`, `.json` for `json`, and `.md` for markdown.

## Phase P1: Diagnostics Persistence Guardrail

The first diagnostics fix should be intentionally small:

- Keep the existing JSON file format.
- Avoid synchronous full-file writes on hot paths.
- Serialize writes so concurrent saves collapse into one pending save.
- Keep compaction behavior before writing.
- Consider lowering the default diagnostic entry limit only if tests show no expected behavior depends on 10000 entries.

The minimal implementation can replace direct `fs.writeFileSync()` in `saveSessionDiagnostics()` with a queued async write helper. It should not make callers await diagnostics persistence on request paths.

## Phase P2: Interactive Command Priority

Once P0 and P1 are stable, add priority to host command queues.

High-priority commands:

- `session.input`
- `session.interrupt`
- `session.steer`
- `session.request.respond`

Normal or low-priority commands:

- `session.detail`
- `session.search`
- `host.file_download`
- `host.file_upload`
- `host.file_download_chunk`
- `host.file_upload_chunk`
- export/detail support commands
- discovery/import commands

The relay should preserve FIFO order within the same priority. The host agent can keep a single sequential `handleCommand()` implementation as long as polling receives high-priority commands first.

This phase should be separate because it changes cross-cutting command delivery behavior.

## Tests

### Startup and Watchdog

Use and extend `scripts/test-local-agent-startup-watchdog.js`.

Expected assertions:

- `heartbeatLoop()` begins before initial discovery.
- `pollCommandsLoop()` begins before initial discovery.
- `send initial discovery` remains present.
- `LOCAL_AGENT_STARTUP_GRACE_MS` exists in relay.
- `localAgentWatchdogTick()` compares `startedAgeMs` to `LOCAL_AGENT_STARTUP_GRACE_MS`.
- Windows launcher sets `RELAY_LOCAL_AGENT_STARTUP_GRACE_MS`.

### Export Dialog

Use `scripts/test-export-dialog.js`.

Expected assertions:

- `buildSessionExportUrl(session, 'zip')` includes `format=zip`.
- Select-all dates produces one continuous date range when dates are consecutive.
- Dialog export with `format='zip'` clicks a link with `format=zip`.
- Zip dialog export sets a `.zip` download name.
- Markdown export still sets `.md`.

### Syntax and Managed Smoke

Run:

```powershell
node --check apps\host-agent\agent.js
node --check apps\relay\server.js
node --check apps\mobile-web\public\app.js
node scripts\test-local-agent-startup-watchdog.js
npm run test:export-dialog
```

Run `npm run test:managed` after P0/P1 are green, unless the user asks to avoid longer smoke tests.

## Rollout Plan

1. Commit or review the documentation first.
2. Make P0 startup/watchdog changes with failing tests already in place.
3. Verify startup/watchdog tests and syntax checks.
4. Make P1 export dialog fixes with existing export dialog test.
5. Verify export tests and syntax checks.
6. Make diagnostics persistence guardrail only after the fast path is stable.
7. Make command priority as a separate change after Windows local sessions can stay online.

## Risks

- Starting loops earlier changes startup ordering. Commands may arrive before discovery has populated imported sessions. The handler should already reject unavailable sessions gracefully; tests should focus on live-session responsiveness.
- Background discovery failures may become less visible if only logged. Add or preserve diagnostics for startup failures.
- Async diagnostics persistence can lose the last few diagnostic entries on abrupt process exit. This is acceptable compared with blocking live relay requests, but the implementation should flush on process exit if practical.
- Command priority can reorder user-visible effects. Keep it out of P0 unless Windows remains unusable after startup/watchdog fixes.

## Success Criteria

- Windows local agent no longer restarts during cold history restore.
- `/api/hosts` shows the Windows host online with a stable `localAgent.restartCount`.
- A new or live Windows session can receive input while history discovery is still running.
- Date select-all works and produces date ranges in export URLs.
- Selecting zip produces a zip download request and `.zip` filename.
- The targeted tests pass.

