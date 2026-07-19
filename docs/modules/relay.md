# Relay Module

Path: `apps/relay/server.js`

## Purpose

The relay is the control plane for the prototype. It keeps track of hosts,
sessions, live event subscribers, pending commands, session logs, alerts,
diagnostics, requests, runtime status, saved HPC connectors, and durable
Session run provenance.

## Current storage

- `RELAY_STATE_ROOT` is the common root for Relay-owned state, received files,
  local-agent logs, askpass state, SSH control sockets, and staged runtimes.
  Non-primary ports refuse to start without an explicit `RELAY_STATE_ROOT` or
  `SESSION_RECORD_STORE_ROOT`; the current-source preview on `8897` therefore
  has a dedicated state root and does not share any state path with `8797`.
  Startup also acquires an OS-owned named IPC socket derived from the resolved
  state root before opening the Session Store. A second process targeting the
  same root fails with `relay_state_locked`; an exited or crashed owner's lock
  is released by the OS so a replacement Relay can take over.
- Host presence, command queues, live projections, subscribers, and runtime
  streams are in memory.
- Canonical Session records, aliases, immutable per-run API bindings, requested
  and effective model selections, catalog cache, and notification state are
  persisted by `apps/relay/session-record-store.js` under
  `tmp/session-record-store` by default. The store uses checksummed current and
  previous snapshots plus a contiguous fsynced WAL and fails closed on an
  unrecoverable revision gap. A checksummed sentinel outside the Store artifact
  directory records Store identity, revision, and assistant-sequence high-water
  marks. Missing artifacts, identity changes, and an internally valid but older
  restore are rejected instead of silently creating or accepting weaker state.
  A WAL append, short write, or fsync failure closes all later mutations in the
  process instead of allowing another transaction to reuse the damaged
  revision. Snapshot and sentinel failures use the same fail-closed rule.
  Recovery normalizes and recursively strips credential fields and secret-like
  error text; if recoverable historical artifacts contain secrets, startup
  rewrites the retained snapshots/WAL into a sanitized generation before use.
  Credential containers, cloud access/secret/account/storage/encryption keys,
  connection strings, authorization text, and secret URL query parameters are
  removed without treating identity fields such as `canonicalKey` as secrets.
- Transcript, diagnostic, and legacy presentation caches remain separate JSON
  stores. Diagnostic `message`, `detail`, and structured `data` are sanitized
  before entering memory or persistence; startup also rewrites retained
  diagnostic files when historical credentials are found.
  `tmp/session-metadata.json` is still retained as migration and reconciliation
  input; it is not the authority for a managed run binding.
- Connector profiles are persisted through `shared/connectors.js` into `tmp/connectors.json`.
- Last-known Host skill inventories are persisted in
  `tmp/skill-inventories.json` by default. Override with
  `SKILL_INVENTORIES_PATH` for isolated tests or deployments.
- Complete Skill registry metadata is persisted in `tmp/skill-registry.json`
  by default, with immutable archives under `tmp/skill-artifacts`. Override
  these with `SKILL_REGISTRY_PATH` and `SKILL_ARTIFACT_ROOT`.
- Skill desired state and independent per-Host results are persisted in
  `tmp/skill-deployments.json` by default. Override with
  `SKILL_DEPLOYMENTS_PATH`. Per-Host terminal updates first fsync to the
  adjacent append-only `.results.jsonl` journal; structural saves compact the
  journal into the atomic JSON snapshot. Replay validates the complete result
  schema and ignores an already-compacted entry only when it exactly matches
  the bounded terminal tombstone.
- Skill policy, refresh, rollout, deployment, Host-result, and Library lifecycle
  events are appended to the hash-chained `skill-audit.jsonl` under
  `RELAY_STATE_ROOT`. Override its location with `SKILL_AUDIT_PATH`.

This is good enough for local iteration, but not production.

## Main responsibilities

- Serve the mobile web UI from `apps/mobile-web/public`.
- Register and heartbeat host agents.
- Queue commands for agents.
- Accept agent events and update session state.
- Serve host/session/stat APIs.
- Provide SSE streams for live sessions.
- Store and decorate HPC connector profiles.
- Serve cached skill inventory state and queue asynchronous per-Host refreshes.
- Plan and confirm managed Session runs before publishing them as usable.
- Serve binding-scoped runtime configuration and dynamic model catalogs.
- Assign durable assistant-message identities and Relay-wide sequences, expose
  paged notification projections, and replay canonical Session SSE events.

## Relay-managed local Agent lifecycle

Each Relay-launched local Agent has a private ownership marker containing its
exact Host ID, PID, random instance ID, random token, Relay URL, and start time.
Marker and log basenames include a stable hash of the original Host ID, so
separator normalization and Windows case folding cannot make two Hosts share a
file. The Windows launcher discovers markers by their contents and also checks
that the process command line belongs to this repository.

Register, heartbeat, command-poll, and Agent-event routes enforce the same
ownership attestation. Missing or mismatched attestation rejects the complete
request before command acknowledgement, event-batch deduplication, or event
application. Ordinary remote Agents remain compatible when no live
Relay-managed ownership exists. A live marker that has not completed its
register/heartbeat handshake is reported as `ownership_pending`; Relay neither
spawns a duplicate nor kills that unverified PID.

Agent event batches retain a stable idempotency key even when they contain one
event. Relay applies an accepted batch in order and remembers the key only
after every event succeeds. Application is ordered at-least-once, not a
cross-reducer transaction: a structured `agent_event_batch_apply_failed`
response reports the completed prefix, leaves the batch pending, and never
causes the Agent to replay the whole batch immediately as legacy singles.
Legacy single-event fallback is limited to HTTP 404/405/415 or an explicit
`agent_event_batch_envelope_unsupported` response from a 400/422 Relay.

Stop and Restart enqueue an ordered `host.shutdown` command and wait for the
owned Agent to close its runners. The Agent final-acks only commands it reached;
Relay removes the shutdown command by exact ID after exit. If graceful shutdown
times out, Relay force-kills only a process represented by its authoritative
`ChildProcess` handle. A recovered marker without that identity fails closed
and is left for launcher/service fallback. Relay itself also remains alive with
a failure status when any Agent tree cannot be confirmed dead; it does not
report success and leave detached app-server processes behind.

Relay SIGINT/SIGTERM disables automatic restart, requests graceful shutdown for
the current managed-Agent set, waits a bounded interval, and applies the same
verified process-tree fallback. A valid managed Agent that first registers
after shutdown has begun receives ownership revocation, is added to the live
shutdown/join set, and must confirm process exit before Relay can close.

## Session API binding and model catalog

The browser's Host mapping is a default for fresh Sessions only. Resume, fork,
live input, and compact are owned by the source Session run. Each managed run
has an immutable, secret-free `apiBinding` whose fingerprint covers profile
identity, provider, and normalized endpoint, but not the API key.

Before a managed start is queued, the Relay resolves history and cwd, resolves
or attests the binding, creates a pending run in `SessionRecordStore`, loads the
binding-scoped model catalog, and validates the requested model and reasoning
level. A capable Host must then confirm the same binding before the run becomes
live. Failed attempts remain audit entries and do not replace the latest
successful run. Older Hosts that do not advertise `runApiBinding` remain on an
explicit compatibility path and cannot manufacture new verified provenance.

Only one pending launch may own a canonical Session at a time. A duplicate
Fresh/Resume/Rebind request fails with `session_run_pending` before a second
Host start is queued. Catalog validation does not replace the existing live
run: a pending Rebind catalog is labeled and cached under the pending run and
binding, while the old run remains available for input until the new start is
confirmed.

Transcript fallback targets a new Session, so it also takes a durable lock on
the source Session while its derived run is pending. Concurrent browser,
multi-tab, or API requests therefore cannot create duplicate fallback runs;
confirm, failure, and restart reconciliation release the source lock. Stored
source-record pointers are resolved through canonical aliases, so discovery
merges cannot strand the lock on a deleted loser record.

Durable provenance and the in-memory UI projection can advance in adjacent
event-loop turns. During that window, runtime configuration, live controls, and
model lookup keep using the canonically live run rather than attaching a source
Session to a pending derived run. A delayed `session.started` for a failed or
superseded run cannot replace the current projection; Relay queues a
run-targeted `session.stop` with terminal-event suppression to close that stale
runner without closing the current run.

Stop and Rebind are compare-and-set lifecycle mutations. Modern clients submit
the canonical `runId`, run status, and binding fingerprint they observed. The
Store validates that tuple inside its serialized transaction, so a delayed
Stop cannot terminate a replacement run and discovery cannot close an old run
after a new pending run wins the queue. A direct Stop first persists a
recoverable intent, then queues the Host command. Only a run-targeted terminal
event makes the run stopped. If confirmation never arrives, Relay clears the
intent and restores the prior live projection; a Relay restart also clears an
unconfirmed intent so Host discovery can determine the real runner state. A
durable Stop intent remains authoritative even if delayed output, start, or
runtime events temporarily project the Session as running. Fallback preserves
newer Host runtime updates instead of restoring stale pre-Stop turn state.

Resume and Rebind replacement also target the durable live parent run rather
than relying on the UI `live` flag. This guarantees that a Relay-restart window
with a history-only projection still queues the parent Stop before the
replacement Start, avoiding an untracked second runner.

Binding-aware Hosts must include `runId` on start, terminal, selection,
runtime, command-failure, and output events. Missing IDs are ignored rather
than being applied to the current replacement run. Authoritative discovery
also reconciles durable live records after restart, even when their in-memory
projection was initially hydrated as history-only.

The main Session-targeted routes are:

- `GET /api/sessions/:id/runtime-config` for the canonical successful run;
- `GET /api/sessions/:id/models` and `POST .../models/refresh` for its catalog;
- `POST /api/sessions/:id/rebind` for an explicit new binding and run;
- `POST /api/sessions/:id/transcript-fallback` for an explicitly confirmed new
  native thread when native resume is unavailable.

Ordinary profile-bound resume must submit the local credentials for the saved
profile identity. A deleted profile, changed provider, or changed endpoint is
rejected with a structured binding error and requires explicit Rebind. A
`host_environment` run is resumed only after Host preflight attests the same
environment. Live input and compact do not reapply the browser Host default or
submit `apiConfig`; the already running app-server owns its binding.
API endpoint identity retains canonically sorted non-secret query parameters
such as Azure `api-version`, drops fragments, and rejects credential-bearing
query fields. Provider-capable model refreshes use a separate in-flight class,
so a concurrent credential-free catalog read cannot absorb a forced refresh.

## Assistant message projection and Session event replay

Host discovery and live transcript events carry stable assistant observations,
not summary hashes. Relay assigns each new stable assistant ID one durable,
monotonic `assistantSeq` in the Session Store. Alias merges preserve ledger
entries, reconcile losing sequence numbers through sequence aliases, and never
let title, runtime, user-message, or total-message-count changes advance the
assistant high-water.

Session list/detail responses include a compact `assistantProjection`.
`GET /api/sessions/:id/assistant-projection` returns the current projection;
`GET /api/sessions/:id/assistant-messages` pages ledger entries with `afterSeq`
and `limit`. Both routes resolve canonical Session aliases and require
`hostId`.

Every canonical Session has a bounded in-memory SSE ring. Event IDs use
`<relay-epoch>:<counter>` and reconnect accepts `Last-Event-ID`, `lastEventId`,
or `cursor`. A valid retained cursor replays only later events. Missing,
malformed, expired, or different-epoch cursors receive `stream.reset` with the
current Session, assistant projection, and Thinking activity snapshots before
incremental delivery resumes. The durable assistant ledger survives Relay
restart; the SSE ring and epoch deliberately do not.

## Important internal maps

- `state.hosts`
- `state.sessions`
- `state.commandQueues`
- `state.subscribers`
- `state.sessionEventStream`
- `state.activitySnapshots`
- `state.sessionLogs`
- `state.sessionAlerts`
- `state.sessionRuntime`
- `state.sessionDiagnostics`
- `state.sessionRequests`
- `state.connectors`
- `state.skillInventories`
- `state.skillRefreshes`
- `state.skillSubscribers`
- `state.skillRegistry`
- `state.skillDeployments`
- `state.skillAdoptions`
- `state.skillImports`
- `state.skillAudit`
- `state.skillAutomation`

## Skills inventory API

`GET /api/skills` is cache-only. It returns Host metadata, one inventory status
record per known Host, normalized instances, the legacy `installed` projection,
catalog data, favorites, sources, and the skill library. It never waits for a
Host command response, so an offline or unresponsive Host cannot delay the
request. A missing or older-than-60-seconds snapshot is marked stale; scan
errors remain Host metadata and are never represented as fake skill rows.

`POST /api/skills/refresh` accepts an optional `hostIds` array. An omitted or
empty array targets all known Hosts. The relay validates each Host independently
and immediately returns HTTP 202 with `queued`, `offline`, or `unsupported`.
Each queued `host.skills.inventory.refresh` command includes only deduplicated
session `cwd` values already known for that Host. The request does not await an
agent response.

`host.skills.inventory` replaces only the sending Host's cached snapshot,
updates its revision, resolves its pending refresh, writes the versioned cache
through a temporary file plus atomic rename, and broadcasts
`skills.inventory.updated`. Every published instance must carry a valid
content SHA-256; malformed instance hashes reject the whole event and retain
the previous cache. Artifact reference matching canonicalizes portable Skill
IDs, so an adopted directory whose on-disk case differs from the Registry ID
still blocks collection. Incomplete scans retain the prior reference instances
and cannot prove that an Artifact disappeared.

`GET /api/skills/events` is an authenticated SSE stream with `ready`,
`skills.inventory.updated`, `skills.library.updated`,
`skills.deployment.updated`, and a 20-second `ping`.
Closed and failed responses are removed from `state.skillSubscribers`.

## Skill artifact registry and Adopt

`apps/relay/skill-registry-service.js` stores content-addressed `.rcskill`
archives by SHA-256. Registry JSON and archive publication both use same-volume
staging plus atomic rename. The Relay independently validates magic, manifest,
sorted relative paths, file hashes, total hash, root `SKILL.md`, file count,
and byte limits before publishing an archive. `GET /api/skills` uses a summary
snapshot and never clones or returns full file manifests or internal archive
paths.

Phase 2 APIs are:

- `POST /api/skills/adopt` queues adoption of one cached Host `instanceId`;
- `GET /api/skills/adoptions/:adoptionId` returns its state;
- `PUT /api/agent/skills/adoptions/:adoptionId/artifact` accepts a bounded raw
  archive with one-time Host/request binding;
- `POST /api/skills/import` queues GitHub import or delegates local/CC Switch
  inventory import to Adopt;
- `GET /api/skills/imports/:importId` returns background import state.

GitHub imports use the bounded adapter in
`apps/relay/github-skill-source.js`. It accepts only explicit GitHub repository
locators, validates every API response remains on the configured API origin
and repository path, rejects links/submodules and unsafe names, stages all
content, then enters the same archive validation path as Host adoption.
`REMOTE_CODEX_GITHUB_TOKEN` or `GITHUB_TOKEN` may provide API authentication;
the token is never returned in source records.

Raw Artifact uploads default to a 272 MiB request limit. Active adoption and
GitHub import counts are bounded by `SKILL_MAX_ACTIVE_ADOPTIONS` and
`SKILL_GITHUB_MAX_CONCURRENT_IMPORTS`; completed operation history is bounded
by `SKILL_OPERATION_HISTORY_LIMIT` and expires after the configured retention
window. Host uploads send a fixed SHA-256 digest of `instanceId`, not the
potentially large instance identifier in an HTTP header.

The older `host.skills.list`, generated single-file install/uninstall commands,
and `/api/skills/actions` remain compatibility routes only for old Hosts.
`/api/skills/actions` rejects every `hostSkillDeploymentV1` Host with HTTP 409
so it cannot bypass Artifact, ownership, readonly, and drift validation. When
a legacy Host upgrades, Relay also purges queued install/uninstall mutations
and resolves their pending callers with an explicit cancellation.

## Skill desired state and deployment

`apps/relay/skill-deployment-service.js` stores one deployment with an
independent result per target Host. `requestId` plus a canonical request
fingerprint makes identical creation idempotent and rejects reuse with changed
Artifact, action, Host set, or scope as HTTP 409. A new
desired state for the same `hostId + skillId + scope + scopeId` supersedes older
pending or queued work without changing results for other Hosts, removes their
queued commands, and publishes an incremental superseded event. Metadata loads
fail closed on invalid JSON or semantic identity mismatch. Skill, Host,
request, and deployment identifiers reject JavaScript prototype-reserved keys;
stored scopes, states, and hashes must already use their canonical form.
Relay consults the durable request index before mutable Registry lifecycle and
workspace checks. An exact retained request therefore returns its original
deployment after Library retirement, successful cleanup, Artifact collection,
or workspace-session disappearance; changed payload still reaches the
fingerprint check and returns HTTP 409.

Phase 3 APIs are:

- `POST /api/skills/deployments` validates that `artifactId` belongs to the
  requested Registry Skill and creates enable, disable, or remove desired
  state;
- `GET /api/skills/deployments/:deploymentId` returns durable per-Host status;
- `GET /api/agent/skills/artifacts/:artifactId` streams the immutable Registry
  archive to an authenticated, registered, deployment-capable Host.

Online capable Hosts are queued immediately in one snapshot write. Offline,
unknown, or old Hosts
remain pending. Command queues remain memory-only, but pending and previously
queued desired work is re-enqueued from durable state whenever a capable Host
registers or heartbeats after Relay restart; all pending Skills for one
reconnecting Host transition in one batch save. One Host failure does not roll
back another Host.

The first command poll that delivers a deployment transitions its Host result
from Queued to Running, persists `startedAt`, and emits one incremental SSE
update. A fresh Host registration can requeue a persisted Running result after
a process restart; routine heartbeats do not duplicate work already in flight.

Project creation requires `confirmProjectWrite: true`, `scopeId === cwd`, and
the exact `cwd` already known from that Host's sessions. The command includes
the expected content hash and authenticated download path. A
`host.skills.deployment.result` validates all deployment metadata and success
state, fsyncs one small journal record, atomically removes the matching command,
and broadcasts an incremental `{deploymentId, hostId, result}` event. Duplicate
terminal results are idempotent; conflicting results are rejected. A first
success queues one coalesced inventory refresh for that Host.

Deployment history has a soft bound: current desired and nonterminal records
are always retained, then the newest terminal summaries fill the configured
limit. Pruned terminal records leave bounded tombstones so a delayed durable
Host outbox result can be acknowledged only when Host, metadata, and terminal
state match. This also closes the snapshot-rename/journal-truncate crash window:
a stale journal line that matches its new tombstone is replay-safe, while a
conflict remains fail-closed. While the result journal is nonempty, tombstone
soft-limit eviction pauses so consecutive truncate failures cannot remove a
target required by the next replay. A later successful truncation lets the next
structural save resume normal soft-limit pruning. Request-index entries are
removed with pruned records.
`GET /api/skills` returns those summaries plus explicit current
`desiredSkillStates`, without Artifact manifests, request fingerprints, or
internal archive paths. `GET /api/skills/deployments/:id` remains authoritative
for retained records.

## Skill Library lifecycle and manual source refresh

Phase 4A separates reversible Library retirement from physical archive
collection. Registry Library records use `archived/retiredAt`; Artifact
metadata uses `available`, `gc-pending`, or `collected`. Retired Skills are
excluded from new Enable requests. Disable/Remove cleanup remains available
only when the requested Host/scope already has a matching desired, applied, or
applied-uncertain reference.

`apps/relay/skill-deployment-service.js` persists a Host-applied projection in
the same fsynced snapshot and result journal as desired state. Successful
Enable/Disable retains the exact Artifact, successful Remove records Missing,
and failed/superseded results cannot erase the prior applied reference. First
deployments and legacy ambiguity use Skill-wide Unknown references. Delivered
commands that are later superseded keep a `superseded-running` reference until
their durable late result arrives. Each new deployment receives a persisted
monotonic generation that is copied into its tombstone, applied mutation, and
result journal. It prevents equal timestamps, clock rollback, or random ID
ordering from letting an older late result overwrite a newer successful
projection. A persisted applied record must match the source deployment or
tombstone identity, successful Host result, action-derived state, Artifact,
scope, and generation or Relay startup fails closed. Tombstones referenced by
applied state outlive the soft history bound; unrelated history remains
bounded. Legacy ordering that cannot be proven retains both possible
Artifacts, and failed cleanup retains Skill-wide uncertainty. The manager API
exposes only nonempty exact uncertainty and true Skill-wide uncertainty so the
UI can offer a cleanup retry. A newer successful Remove clears both forms, and
an older failed cleanup cannot re-contaminate it after restart. Legacy snapshots
whose failed cleanup has already been pruned to a tombstone reconstruct the
Skill-wide blocker during load; generation ordering still protects a newer
successful applied projection.

GC combines those durable references with current desired/nonterminal work and
persisted Host inventory. Managed inventory retains both desired and observed
hashes when they differ. Digest identity remains a GC blocker even when a local
Skill directory name is invalid or no longer matches the Registry ID; adopted
instances additionally require an exact source ID. Such mismatches use a null
canonical Skill ID instead of failing open. Incomplete scans preserve prior
references and block collection conservatively; stale scans are ignored.
Inventory JSON and Registry JSON now fail closed on malformed state, and both
reference snapshots fsync before atomic rename.

Phase 4A APIs are:

- `GET /api/skills/library/:skillId/references` returns stable blockers;
- `POST /api/skills/library/:skillId/retire` retires without deleting bytes;
- `POST /api/skills/library/:skillId/restore` restores retained available
  versions;
- `POST /api/skills/artifacts/gc` collects only unreferenced retired archives;
- `POST /api/skills/sources/:sourceId/refresh` manually refreshes a persisted
  GitHub source through the existing bounded import pipeline.

GC publishes `gc-pending` and prunes only retired links before unlinking, then
publishes `collected`. Relay startup never blindly resumes pending deletion;
the next manual GC reloads all reference stores and recomputes blockers first.
Refresh deduplicates identical content, creates a new immutable version for
changed content, records `lastRefreshAt/lastSuccessAt/lastError`, and never
creates a Host deployment. Registry revision checks protect lifecycle writes
from stale UI state. `skills.library.updated` continues to invalidate cached
manager state.

## Skill source automation and audit

Every persisted GitHub source has a `refreshPolicy` of `manual`, `hourly`,
`daily`, or `weekly`, plus a `rolloutPolicy` of `manual` or `enabled-hosts`.
`POST /api/skills/sources/:sourceId/automation` updates both policies under the
Registry revision CAS. The background scheduler, whose polling interval is
controlled by `SKILL_AUTOMATION_TICK_MS`, queues due sources through the same
bounded refresh/import path used by manual refresh.

An unchanged refresh is deduplicated and creates no deployment. When a changed
Artifact is published under `enabled-hosts`, Relay creates deterministic,
idempotent Enable requests only for Host/scope rows whose existing desired
state is already Enabled for that Skill. It does not enable the Skill on a new
Host, reactivate Disabled rows, or broaden project scope.

The append-only Skill audit log strips secret-shaped fields, chains each entry
to the previous hash, and fails startup on an invalid chain. It records policy
changes, refresh scheduling/results, automatic rollout decisions, accepted
deployments, per-Host results, retire/restore, and Artifact GC. Authenticated
clients page or filter it through `GET /api/skills/audit`; records are bounded
per request, while file retention/rotation remains an operator concern.

Source credentials beyond the existing GitHub token integration and automated
audit-log retention/rotation are not implemented.

## Development notes

- `applyAgentEvent()` is the main event reducer.
- `enqueueCommand()` is the relay-to-agent command path.
- `broadcastSessionEvent()` pushes updates to open SSE clients.
- `getSessionDetail()` is the UI detail read path.
- Connector CRUD uses `normalizeConnectorInput()` and `decorateConnector()`.
- `runConnectorAction()` keeps bootstrap deployment metadata separate from
  ordinary SSH actions. Smoke/status/diagnose/log responses expose only their
  own `actionMultiplexFallback`; referencing the bootstrap-only deployment
  result here previously threw after SSH and left the HTTP request unanswered.

## Known gaps

- Authentication is single-user Relay login only; there is no device approval,
  multi-user authorization, or Host ownership model.
- Host presence, command delivery, live runtime projections, transcript caches,
  and distributed failover are not a fully durable control plane even though
  canonical Session run provenance is durable.
- **P1:** POSIX fallback currently snapshots the Agent descendant tree before
  sending SIGKILL. A child that deliberately creates a new process group during
  that narrow window can escape the snapshot; production supervision should
  use an OS service/cgroup or a dedicated process-group termination contract.
- No distributed relay support.
- No comprehensive cross-subsystem operator audit log. Skills has its own
  hash-chained audit log; other domains still rely on Session Store events,
  diagnostics, and subsystem-specific journals.
