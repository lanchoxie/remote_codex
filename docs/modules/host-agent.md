# Host Agent Module

Path: `apps/host-agent`

## Purpose

The host agent runs on each controllable machine. It is the only module that should touch local Codex history, local directories, or local Codex processes.

## Entry point

`apps/host-agent/agent.js`

Important environment variables:

- `RELAY_URL`
- `HOST_ID`
- `HOST_LABEL`
- `CODEX_HOME`
- `AUTO_START_SESSION`
- `MANAGED_COMMAND`
- `MANAGED_CWD`
- `POLL_INTERVAL_MS`
- `DISCOVERY_INTERVAL_MS`
- `CODEX_BIN`
- `AGENTS_HOME`
- `CC_SWITCH_HOME`
- `SKILL_PLUGIN_ROOTS`
- `SKILL_ARTIFACT_TEMP_ROOT`
- `REMOTE_CODEX_STATE_ROOT`
- `CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_SCAN`
- `CODEX_ASSISTANT_CURSOR_MAX_BYTES_PER_DISCOVERY`
- `AGENT_CLEAN_LEGACY_MANAGED_OVERLAYS` (one-time recovery attestation only)

## Responsibilities

- Register with relay.
- Send heartbeats.
- Discover local Codex history through `shared/codex-discovery.js`.
- Poll relay commands.
- Start managed sessions.
- Browse directories on the host.
- Forward prompt input and control commands to the runtime.
- Post runtime, transcript, diagnostic, request, and alert events back to relay.
- Publish bounded, resumable assistant-observation cursors with discovery.
- Maintain and publish a versioned, multi-scope skill inventory.
- Export an exact discovered Skill instance as a complete, deterministic
  artifact for Relay adoption.
- Apply validated Registry Artifacts as durable user/project desired state.

## Relay-managed Agent lifecycle

When the Relay launches a local Agent, it assigns a random instance ID and
ownership token and records them with the Agent PID in a private owner marker.
Register, heartbeat, command-poll, and event requests all attest that same
PID/instance/token tuple. A restarted Relay can reclaim the still-running Agent
only after the marker and request attestation agree. If ownership is replaced
or revoked, the old Agent shuts itself down and suppresses its terminal Session
events so it cannot overwrite state produced by the replacement instance.

Command delivery is monotonic. The Agent sorts every polled batch by command
ID, stops at the first retryable failure, and never selects a later
`host.shutdown` out of order. Immediately before it executes a shutdown that it
actually reached, it sends one authenticated final acknowledgement for all
earlier successful commands. Relay removal of the shutdown command itself is
exact, so a forced exit cannot acknowledge an earlier blocked `session.start`,
while a graceful restart does not replay earlier successful input or probes.

Host shutdown closes the managed-start gate synchronously. The gate tracks a
runtime from construction through its authoritative terminal delivery, gives
in-flight starts precedence over the live-session index, and waits for the
start handler's completion before allowing the Agent to exit. Pending starts
publish one `failed:host-shutdown` result; starts owned by a revoked Agent stay
silent. Unique live runners stop concurrently. A timeout, runner stop error, or
terminal-delivery failure keeps the Agent root process alive so the Relay or
launcher can terminate the complete process tree instead of orphaning an
app-server.

Generic process runtimes wait for the real child `spawn` or `error` handshake.
Stop waits for a confirmed child exit and never fabricates a terminal event.
Diagnostic and authoritative state delivery are independent; failure to post
the state is retryable and prevents command acknowledgement. Terminal
suppression is monotonic, so a later ownership revocation can still silence a
stop that began for an ordinary request.

## Assistant observation cursor

`shared/codex-assistant-cursor.js` incrementally scans each discovered rollout
by UTF-8 byte offset. It parses only newline-complete JSONL rows, retains a
partial multibyte row for the next scan, applies per-file and per-discovery byte
budgets, and rotates the starting Session so a large rollout cannot starve the
others. File replacement, same-size rewrite, truncation, parse uncertainty,
and unread bytes are reported explicitly instead of asserting a false complete
projection.

Normalized assistant observations are keyed by stable source identity. Live
tail delivery records the same identities so a later discovery pass does not
reintroduce them. Newly scanned observations remain pending and are resent on
the next discovery if Relay delivery fails; the Agent acknowledges them only
after the complete `session.discovery` event succeeds. `task_complete` metadata
and internal response items do not become transcript or notification messages.

## Skill inventory

`apps/host-agent/skill-inventory-service.js` owns each Host's last scanned
snapshot. `shared/skill-inventory.js` owns discovery, frontmatter parsing,
source inference, deterministic directory hashing, and inventory revisions.

The Host scans only explicit or well-known roots:

- `<CODEX_HOME>/skills` for user skills, excluding `.system`;
- `<CODEX_HOME>/skills/.system` as readonly system skills;
- `<workspace>/.agents/skills` for project-scoped skills;
- `<AGENTS_HOME>/skills` for shared skills;
- `<CC_SWITCH_HOME>/skills` for CC Switch compatibility;
- roots explicitly listed in `SKILL_PLUGIN_ROOTS` as readonly plugin skills.

Workspace roots come only from `WORKSPACE_ROOTS`, `MANAGED_CWD`, and `cwd`
values reported by known imported or live sessions. The scanner never walks an
arbitrary drive to find projects. Junctions and symbolic links are resolved
against the complete configured-root allowlist, so standard links between
`.agents` and `.codex` work while links into an unrelated directory are
rejected.

Directory hashes use bounded entry, depth, file-count, and byte budgets. They
exclude timestamps, ownership, and raw platform mode differences. The portable
executable bit is derived consistently from shebangs, executable binary magic,
and Windows command extensions so the same artifact hashes identically on
Windows and Linux.

Filesystem watchers invalidate existing roots and debounce a rescan for 500
ms. A 30-second full scan is the fallback for platforms or nested changes that
watchers miss. Concurrent refresh requests share one in-flight scan, and a new
revision is published only after normalized inventory content changes. An
explicit `host.skills.inventory.refresh` command can request an unchanged
snapshot as an acknowledgement.

The Host advertises `hostSkillInventoryV2` and `hostSkillArtifactsV1`, reports `codexHome` and
`skillsRevision` during registration and heartbeat, and emits
`host.skills.inventory`. The older `host.skills.list` response remains a
compatibility projection of enabled user-scope instances from the same
inventory; it is no longer a second filesystem scanner.

`apps/host-agent/skill-artifact-service.js` implements Phase 2 adoption. A
`host.skills.artifact.export` command contains an `instanceId`, its expected
observed hash, and a one-time Relay upload path/token. The service forces a new
inventory scan, requires exactly one matching non-readonly instance, rejects a
changed hash and plugin/system ownership, packages every file through
`shared/skill-artifact.js`, uploads the raw archive, and deletes staging data in
both success and failure paths. It emits `host.skills.artifact.result` after the
Relay accepts the independently validated artifact.

Adoption is read-only with respect to the original Host directory. It records
the content centrally but does not enable, disable, relocate, or remove the
instance.

## Managed Skill deployment

`apps/host-agent/skill-deployment-service.js` owns Phase 3 Host mutations. The
Host advertises `hostSkillDeploymentV1`, consumes
`host.skills.deployment.apply`, and emits one
`host.skills.deployment.result` per Host operation.

Managed metadata defaults to `<REMOTE_CODEX_STATE_ROOT>/skills/state.json`,
where `REMOTE_CODEX_STATE_ROOT` defaults to `~/.remote-codex`. Immutable
archives and extracted content use the content-addressed paths
`skills/artifacts/<sha256>.rcskill` and
`skills/artifacts/<sha256>/content`. State publication uses a temporary file
and atomic rename. Ownership metadata stays outside the Skill directory, so it
does not change the portable Artifact hash.

The state loader is fail-closed: only a missing file initializes empty state.
Invalid JSON, versions, Host ownership, scope metadata, canonical Skill IDs,
activation keys, activation paths, and pending result events stop startup
instead of silently erasing ownership. Skill IDs are canonical lowercase
portable directory names. The state/cache ancestry and every activation
ancestor from `CODEX_HOME` or the exact workspace root are checked for
links/junctions and real-path escape before writes or garbage collection.

An uncached enable streams the raw archive from
`GET /api/agent/skills/artifacts/:artifactId`, enforces its declared size,
validates every archive entry and hash, extracts into a new temporary
directory, and re-hashes the complete directory before publishing the cache.
Non-2xx response bodies are bounded, partial/aborted downloads are deleted,
and the download completes only after the output handle closes. Cleanup also
destroys and waits for a write stream whose `open` event has not fired, so an
early socket abort cannot create a late partial archive after rejection.
User scope activates at `<CODEX_HOME>/skills/<skillId>`. Project scope activates
at `<cwd>/.agents/skills/<skillId>` only when `confirmProjectWrite` is true and
`cwd` exactly matches a workspace already known to the Host inventory.

Activation copies the immutable cache to same-volume staging, validates the
staged hash, moves an existing managed version to backup, atomically renames
staging into place, validates the result, and restores backup on any failure.
If direct cleanup fails, the failed activation is displaced into the unscanned
same-volume staging directory before backup restore; the restored hash is
verified and rollback failures are reported explicitly.
Identical content is idempotent and can be adopted into Host ownership without
rewriting files. Before ownership is recorded, a verified copy is published to
the content-addressed cache; Disable can therefore retain it and an offline
Enable can restore it without a Relay download. Different unmanaged content,
links/junctions, readonly
content, and managed content whose observed hash drifted are never overwritten
or removed.

Disable records durable disabled ownership even when the activation was
already missing, removes only a safe managed activation, and retains the Host cache.
Remove from Host performs the same safe deactivation, deletes its ownership
record, and removes the cached Artifact only when no other managed activation
references it. The cache ancestry is revalidated immediately before those
direct deletes, including when a link/junction is introduced after process
startup. Successful replacement also mark-and-sweeps unreferenced older
Artifact caches. Host mutation only invalidates the local inventory cache; it
does not block result delivery on a filesystem rescan. Relay queues one
coalesced authoritative inventory refresh after the first accepted success.

Deployment results use a durable Host outbox in the same state file. The Host
persists the exact success or failure event before POST, reuses it after an
ambiguous response or restart, and never reruns the local mutation while that
event is pending. Relay removes the matching deployment command before its
2xx response; only then does the Host clear the outbox. Redirects and all other
non-2xx responses leave the command unacknowledged.

Phase 3 agents reject legacy `host.skills.install` and
`host.skills.uninstall` mutations even if an old Relay queued them before the
Host advertised `hostSkillDeploymentV1`. Read-only legacy listing remains
available for compatibility.

## Runtimes

### Codex app-server runtime

Path: `apps/host-agent/codex-app-server-runner.js`

Uses Codex `app-server` JSON-RPC style protocol and maps structured Codex events into relay events.

### Run API binding

Modern Hosts advertise `bindingPreflight`, `runApiBinding`, `apiCatalog`, and
`modelList`. Every managed `session.start` carries a `runId` and an
`expectedBinding`:

- a profile-bound launch receives credentials only in the transient command,
  builds the isolated runner environment, and attests the same secret-free
  profile/provider/endpoint identity. Non-secret Base URL query parameters are
  preserved for the actual provider request and attestation; fragments are
  discarded;
- a `host_environment` launch computes a safe provider/endpoint attestation
  from the Host Codex environment and must match the saved binding;
- an unknown or mismatched binding is rejected before the Session is published
  as live.

The runner owns the immutable binding for its lifetime. Subsequent input and
compact commands carry the expected run binding but do not reapply a browser
Host default or replace the runner's API configuration. Conflicting commands
are rejected. Successful app-server start and turn/model confirmation events
report effective binding and model/reasoning selection back to the Relay.

Runner lookup is run-targeted. When a command includes `runId`, the Host accepts
only a runner with that exact ID; a stale run cannot reach a newer process
through a reused bridge/native Session alias. Legacy commands without `runId`
retain alias lookup only for compatibility. The `session.started` confirmation
always echoes the run ID and the Host's secret-free effective attestation, so
Relay can atomically confirm the planned run before publishing it as usable.

Command delivery is replay-safe. If the same `session.start` is polled again
for an already running `runId`, the Host resends its attested `session.started`
confirmation instead of spawning another app-server. A transient confirmation
delivery failure leaves the command unacknowledged and does not stop the
existing runner. Conversely, a runner whose confirmation is rejected is
stopped with terminal suppression and removed from every alias. Relay can also
send a suppressed run-targeted stop for a late orphan/stale start without
letting that stop close the current run.

`session.stop` waits for the runner's terminal outcome to be posted before the
Host considers the operation complete. A missing-runner stop publishes
`history-only` only for an ordinary user stop; reconciliation/stale-run stops
with `suppressTerminalEvent` stay silent, preventing an obsolete terminal event
from overwriting the live run projection.

API keys are not included in Host events, Session provenance, diagnostics, or
model catalog cache. Changing provider or endpoint requires an explicit Relay
Rebind that creates a new run; rotating credentials within the same identity
is resolved when that new run starts.

Managed app-server sessions use an isolated Codex home under
`<CODEX_HOME>/.remote-codex-managed/<session-profile>/.codex` instead of
writing runtime state directly into the user's primary `CODEX_HOME`. This keeps
remote-control sessions from corrupting or contending with an interactive Codex
TUI running on the same HPC account. The runner copies small identity/config
files, links read-mostly history/skill directories, and lets Codex rebuild
`state_*.sqlite` and `logs_*.sqlite` per managed session.

Overlay creation resolves the real `CODEX_HOME`, permits a legitimate linked
base home, but rejects a linked/junction `.remote-codex-managed` root or any
real-path escape before writing `auth.json`. Constructor failures remove a
newly owned overlay, and a spawn-marker write failure enters the controlled
startup-failure path rather than escaping an EventEmitter callback. Cleanup is
retryable, requires the original ownership token, and does not remove an
overlay while its child exit remains unconfirmed.

Each new overlay has a private ownership marker containing a random ownership
token, the Host Agent PID, the spawned app-server PID, and a bounded child
state. The runner records `spawning` before process creation, records the child
PID after spawn, and removes only the directory whose marker still matches its
in-memory ownership token. Normal Stop, failed startup, Relay-requested Host
shutdown, and process signal shutdown all run that ownership-checked cleanup.
At Host startup the janitor removes a structured overlay only when both its
recorded owner and child are confirmed dead; live or ambiguous ownership fails
closed.

An immediately preceding build wrote only the random token into the marker.
Those legacy markers contain no PID or child state, so age or marker contents
cannot prove that their Agent and app-server have stopped. Startup therefore
classifies them as `legacy-unattributed`, preserves them by default, and emits
only aggregate counts. The diagnostic never includes the overlay path, marker
token, or credentials.

Legacy cleanup requires an explicit one-time operator attestation. First stop
and verify that no older Host Agent or Codex app-server is using the same
`CODEX_HOME`. Then start the Host once with
`AGENT_CLEAN_LEGACY_MANAGED_OVERLAYS=true`; the janitor revalidates that each
marker is still a strict token-only legacy marker immediately before removing
its directory. Unset the variable after that start. Do not keep it enabled in
normal service configuration or use it while an old Agent/app-server may still
be alive.

If an isolated app-server home reports a corrupted SQLite state database, the
runner moves only `state_*.sqlite*` and `logs_*.sqlite*` into a
`broken-sqlite-backup-*` directory and retries startup once. It must not delete
the user's primary `.codex` directory or the `sessions/` history tree.

The SQLite retry reuses an overlay only after the first child has confirmed
exit. If bounded TERM and KILL attempts produce no exit confirmation, the
factory surfaces the stop failure as `processTreeFallbackRequired`, leaves the
durable start command unacknowledged, and retains the runner under its Session
and run IDs. Command replay cannot emit `session.started` for that runner. Its
credential overlay remains owned and intact until a real exit, and a later Host
shutdown stop error keeps the Agent root alive for Relay or launcher
process-tree fallback.

Codex's npm launcher also requires the optional package matching the Host OS
and CPU architecture. On 2026-07-14 the Raspberry Pi 5 Host (`linux/aarch64`)
had `@openai/codex@0.144.3`, but its global install omitted
`@openai/codex-linux-arm64`. The launcher existed, so path discovery passed,
then every fresh and resumed app-server process exited with code 1 before the
protocol became ready. Reinstalling the top-level package with optional
dependencies did not repair that incomplete install, and direct npm download
on the Host reset its connection.

The incident was repaired by downloading the exact official
`@openai/codex@0.144.3-linux-arm64` archive on the control machine, verifying
SHA-256
`33384d62153cad2b197eaff2204c1da3d3e0c317c856cc14aa540254b25c69df`,
uploading it through Relay's chunked file transfer, and atomically publishing
it as the sibling global package `@openai/codex-linux-arm64`. `codex --version`
then returned `codex-cli 0.144.3`. A real Relay-managed session subsequently
reached `connection: ready`, `phase: idle`, and `startupStep: ready`; after an
explicit stop it reached `history-only` with a closed runtime.

This repairs the affected Host, but package compatibility is not yet an
automatic invariant. Host registration does not report `process.arch`, the
Relay bootstrap fallback only carries a Linux x86-64 runtime, and executable
resolution does not require a successful `codex --help`/`app-server --help`
probe. Those systemic checks remain tracked as P1 rather than being hidden by
the successful one-Host repair.

Currently handles:

- thread start/resume/fork style lifecycle;
- turn start;
- interrupt;
- steer;
- compact;
- shell command;
- request responses;
- token usage;
- rate limits;
- reasoning/plan diagnostics when emitted;
- warnings and errors.

Reasoning deltas are joined byte-for-byte by one activity aggregator per run.
It coalesces updates for 75 ms and flushes a final full snapshot on item/turn
completion, interrupt, error, stop, and process exit. The runner does not trim
deltas or insert separator newlines, so the Relay/browser can replace one keyed
Thinking activity without changing Codex's whitespace.

### Demo runtime

Path: `apps/host-agent/demo-session.js`

Used by `npm run test:managed`. It proves the transport path without requiring a real Codex backend.

## Known gaps

- No `tmux` runtime yet.
- No SSH runner.
- No process registry that survives agent restart.
- No attach-to-existing-PTY implementation.
- Real Codex app-server path needs automated integration tests.
- Host registration and bootstrap do not yet enforce an architecture-matched
  Codex platform package or a successful app-server load probe (P1-013).
- Activation stage/backup/tombstone names are deliberately outside inventory
  scanning, but Phase 3 does not yet have a complete crash journal for every
  process/power-loss point. Leftovers remain contained for manual recovery;
  a later lifecycle phase should add startup transaction recovery/compaction.
- Historical project ownership records are retained when their workspace is
  not in the current discovery set. They are inert: every new mutation still
  requires an exact current workspace root and recomputes the activation path.
