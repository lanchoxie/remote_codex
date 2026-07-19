# Mobile Web Module

Path: `apps/mobile-web/public`

## Purpose

The mobile web module is the phone-first control UI. It is currently a static no-build frontend served by the relay.

## Files

- `index.html`: layout and modal structure.
- `styles.css`: responsive mobile/desktop styling.
- `app.js`: state, API client, rendering, SSE handling, and user actions.
- `markdown-renderer.js`: local CommonMark rendering and HTML sanitization.
- `message-notification-client.js`: v2 receipts, alias reconciliation, read
  eligibility, deterministic alert outbox, and cross-tab drainer election.
- `transcript-state.js`: keyed transcript and Thinking activity reconciliation.
- `transcript-scroll.js`: independent outer transcript and Thinking scroll
  ownership, follow state, and anchor restoration.
- `manifest.json`: PWA metadata.

## Main UI areas

- Overview and host list.
- Selected host session list.
- New session in directory.
- Directory picker.
- Conversation detail and variants.
- Live runtime panel.
- Chat transcript with in-flow thinking cards.
- Bottom composer inside the transcript panel.
- Alerts window.
- Full status modal.
- HPC connector manager.
- Skills Manager with a cached Host/inventory matrix.

## Data flow

1. `refresh()` loads stats, hosts, connectors, and sessions.
2. Selecting a live session opens an SSE stream through `subscribeSession()`.
3. SSE events update transcript, alerts, runtime, diagnostics, and requests.
4. User actions call relay APIs.

Full refreshes are single-flight. The client snapshots Session object identities
when the request starts and reconciles the returned list instead of clearing the
table. A Session changed or added by SSE while the request is in flight is kept
unless the response carries a strictly newer timestamp, so an old run list
cannot roll a confirmed `session.started` event back to its parent run.

## Transcript rendering and scroll ownership

Assistant text is rendered by the local Markdown-It vendor bundle and sanitized
with DOMPurify. This preserves CommonMark block structure, including ordered
lists separated by blank lines, without network-loaded parsers. If either
dependency is unavailable, the UI displays escaped plain text; it does not
fall back to the former ad hoc Markdown parser.

Thinking activity is keyed by canonical activity ID and revision. Full
snapshots replace the matching activity in place, while stale revisions and
alias duplicates are ignored. Exact reasoning whitespace is retained across
coalesced snapshots and `stream.reset` recovery.

The outer transcript and each scrollable Thinking body own separate follow and
user-interaction state. Trusted interaction with one does not detach the other.
Programmatic render, syntax/MathJax layout changes, and snapshot replacement
restore anchors without being mistaken for user scrolling; selecting a Session
establishes outer follow only after the current render completes.

## Assistant message notifications

Unread state comes only from the Relay's stable assistant projection. Session
list rows provide the compact high-water and the browser pages
`GET /api/sessions/:id/assistant-messages?hostId=...&afterSeq=...&limit=100`
before applying a newer sequence. `session.assistant_projection` updates the
same projection over SSE; `stream.reset` restores it together with the process
epoch/cursor state. Transcript text, summary text, timestamps, and message
counts are never used as message identity.

Each browser stores v2 receipts by canonical conversation key. Alias receipts
merge their high-water cursors and retain stable-ID exceptions for interleaved
messages; Relay sequence aliases normalize losing merge sequences. The old v1
string marker is consumed only by conservative one-time migration. An exact
retained legacy marker may map to its sequence; an ambiguous marker baselines
at the Relay high-water so migration does not invent an alert.

Read advancement is separate from alert presentation. It requires the exact
selected Session, a visible document, a focused window, the current completed
render, the outer transcript at its reading boundary, and follow mode
established by Session selection or trusted outer interaction. Selection does
not mark read before rendering. Thinking-card scrolling, hidden refreshes,
MathJax/restoration movement, and other programmatic scrolling cannot establish
eligibility. Receipts for another Session are never advanced as a side effect.
The explicit Mark all read command advances read receipts but does not remove a
pending alert from the presentation outbox.

Every notifiable stable assistant ID is persisted in a deterministic outbox.
The in-app alert is upserted by `alertId`; an OS notification, when permission
is already granted, uses the same value as its `tag`. The notified cursor moves
only after in-app presentation and OS presentation or explicit OS
unavailability. Web Locks elect one tab to drain; browsers without Web Locks
use a verified expiring localStorage lease. A BroadcastChannel prompts other
tabs to reload durable state. Clearing visible alerts only records dismissal
fingerprints and never changes transcript read state.

## Session-targeted API and models

API ownership is split deliberately:

- `New Session default (this browser)` is a browser-local per-Host choice used
  only for fresh Sessions.
- `Session API` comes from the canonical run returned by
  `GET /api/sessions/:id/runtime-config`.

Selecting a Session reloads its runtime configuration. Resume and fork resolve
the saved `profileId` against local browser credentials and never substitute
the current Host default. If runtime configuration cannot be verified, the UI
fails closed instead of using a sidebar/list projection. If the saved profile
was removed, or its provider/Base URL identity changed, ordinary Resume is
blocked and the user must use the explicit Rebind control. API key rotation is
allowed when the profile identity is unchanged.

Saving Host API mappings does not stop or restart existing Sessions. Existing
Sessions retain their run binding. Live input and compact omit `apiConfig`
because the live runner already owns that binding.

The model selector stores the full binding/run-scoped catalog response rather
than a global hard-coded list. An explicit refresh uses
`POST /api/sessions/:id/models/refresh`. Reasoning choices come only from the
selected model's advertised `reasoningLevels`, including provider-specific
values such as `max` and `ultra`; unknown capability exposes only Auto.

Structured resume failures retain `code`, `stage`, binding details, Rebind
eligibility, and transcript-fallback eligibility. A failed candidate run does
not replace the last successful runtime configuration shown for the Session.
Terminal candidate events proactively reload canonical runtime configuration,
and rejected model responses enter a retry cooldown instead of creating a
render-driven request loop.

Rebind is single-flight per Session in the browser. Its busy key is retained
outside the rendered button, so a re-render cannot re-enable the control while
the request is pending and repeated clicks cannot create competing launches.
Relay independently rejects a second pending run, so this UI guard is an
ergonomic layer rather than the only correctness boundary.

Stop and Rebind load canonical runtime configuration immediately before the
request and submit its `runId`, status, and binding fingerprint as a lifecycle
precondition. Stop is disabled while Rebind is busy and rechecks after the
canonical load. A late Rebind HTTP response cannot overwrite a newer
`session.started` SSE state. Transcript fallback uses its own persistent
per-Session busy key across renders and the Relay independently enforces a
durable source-Session single-flight.

Runtime-config and model responses are applied only to the request's captured
Host, Session, run, and binding fingerprint. The UI also verifies that the
Session has not advanced before caching the response. A response for run A is
discarded after run B starts, including retry/cache bookkeeping, and canonical
`apiBinding: null` clears an older sidebar projection. Pending Rebind catalogs
therefore remain owned by the pending run; an old successful-run catalog cannot
appear under the new API, and a delayed response cannot roll the selector back.

## Skills Manager

The authenticated app keeps one `/api/skills/events` EventSource so Host Skill
changes also invalidate the composer `/` cache while the manager is closed.
Opening Skills Manager loads cached `GET /api/skills` data immediately. The Installed view uses
Registry Artifact rows first and adds unresolved discovered rows that can be
adopted. It renders one stable column per known Host. Host headers show Fresh,
Refreshing, Stale, Offline, or scan error state. Cells show Enabled, Disabled,
Readonly, Drifted, Shadowed, Conflict, Missing, Pending, Queued, Running,
Failed, or Offline.

Refresh All and Refresh Selected call `POST /api/skills/refresh`; neither waits
for a Host scan. `skills.inventory.updated` removes that Host from the pending
set and invalidates only that Host's composer skill cache. When the manager is
closed, inventory/library events only mark its payload dirty; reopening performs
one coalesced load instead of one full request per event. Logout and 401 close
the EventSource and retry timer. Reconnect conservatively clears Host slash
caches, refreshes the selected live session, and catches up the manager.

Phase 2 adds `Adopt` to eligible online Host cells. Readonly, plugin, system,
managed, offline, and old-agent cells do not expose that action. Queued,
uploading, completed, and failed adoption states remain attached to the exact
`hostId + instanceId`; adoption adds a complete artifact to the central
library without mutating or enabling the original Host directory.

Browse and Sources expose a GitHub import control with repository locator, ref,
and Skill directory subpath. Imports run asynchronously and report through
`skills.library.updated`. That event reloads manager data but deliberately does
not invalidate composer `/` caches because central library membership does not
change a live Host's effective skills. The old generated-`SKILL.md`
install/uninstall buttons retain compatibility IDs but remain hidden.

Phase 3 makes only validated Artifact-backed rows selectable for deployment.
Host checkboxes define a stable target snapshot; Enable on all hosts snapshots
the complete current Host list. Enable, Disable, and Remove from host use
explicit labels and submit one `POST /api/skills/deployments` request per
selected Skill, so partial failures remain independent.

The scope segmented control defaults to User. Project mode offers only an exact
workspace path shared by all selected Hosts and requires the explicit Confirm
project write checkbox. Confirmation is bound to the sorted target Host set and
cwd, and is cleared by any Host, scope, cwd, modal, or successful-submit change.
Enable on all hosts recomputes the all-Host workspace intersection and asks for
its own target-set/cwd confirmation at click time; selected-Host consent cannot
silently authorize the broader command.
Recent deployments retain fixed-size per-Host Pending,
Queued, Running, Succeeded, or Failed results while the matrix overlays the
latest desired-state result on observed inventory.

Creation SSE carries one full deployment; queue/result/supersede SSE carries
only the changed Host result. The client merges by `updatedAt`, keeps all active
records and every deployment referenced by current desired state plus a bounded
terminal history, and coalesces rendering. Deployment and desired-state
versions advance for both SSE and local POST responses, so a concurrent older
`/api/skills` response cannot overwrite either newer state.
Registry rows match managed instances by desired Artifact and unmanaged
instances by observed hash, so an old same-name Artifact cannot mark the latest
row Enabled. Explicit durable desired-state rows route instances by Host,
Artifact, scope, and scope ID; they keep disabled older Artifacts visible
without pretending their directories still exist or borrowing status from a
different project/user scope.

The Relay inventory remains lossless: Local, project, shared, CC Switch,
plugin, and system activations are all retained with their physical instance
IDs. The matrix projects byte-identical activations into one logical row using
`skillId + observedHash`, aggregates labels such as `Local + CC Switch`, and
keeps every underlying instance for status and Adopt actions. Hashless entries
and different hashes remain separate. Superpowers therefore keeps its distinct
invocable child Skills while duplicate user/shared junctions no longer create
duplicate rows.

`skills.deployment.updated` updates progress without a full manager reload. A
successful result invalidates only the affected Host's composer `/` cache; if
the currently selected session is live on that Host, the client immediately
requests `skills/list` with `forceReload: true`. The later inventory event
refreshes the matrix from authoritative Host state.

The composer `/` menu still treats the live Codex app-server as execution
authority. It calls the current `session.skills_list` path with the session's
real `cwd` and `forceReload` when that Host's skill cache was invalidated, then
attaches the exact Host-returned skill `name` and `path`. Relay inventory is a
management preview, not a replacement for app-server scope resolution.

The Sources view also owns explicit Phase 4A lifecycle commands. Active
Registry rows expose Retire from Library; retired rows with an available
version expose Restore. Pruned `gc-pending` and collected Artifact tombstones
remain associated by exact Skill ID, so a failed unlink is shown as Collection
pending rather than Collected or Unavailable.
GitHub Registry sources expose manual Refresh with revision/error state, and
Collect unused runs reference-aware Artifact GC after confirmation. All
lifecycle writes include the latest Registry revision. Both successful and
synchronous failed writes reload authoritative `/api/skills` state, while
`skills.library.updated` covers asynchronous import completion. Refresh and
Restore never enqueue Host deployments, and archived or non-available
Artifacts cannot enter Enable selection.

Disable and Remove can also select an exact retained Artifact/scope row after
that version or its Library record is retired. The action intersects selected
Hosts with exact desired/applied references; a pending, queued, running, or
failed Remove keeps its `desiredState: missing` row available for retry, while
a successful deployment or exact applied Missing releases it only when no
uncertainty remains. Exact uncertain Artifact IDs produce exact cleanup rows;
Skill-wide uncertainty and Unknown applied state expand the Skill's available
Library Artifacts. A successful retry clears those rows. Restoring an Artifact
as the active latest version invalidates the old cleanup selection at both
reload and action-snapshot time. Cleanup selections are also cleared when the
manager closes or changes tabs, so a hidden checkbox cannot remain armed.

For retired Skills with several versions, a pruned version in `gc-pending`
takes display precedence over another retained `available` version. Restore
remains enabled when a linked available version still exists, so collection
failure and reversibility are both visible.

Source Refresh stays busy until its background import reaches a terminal
state, and disabled sources cannot be refreshed. Artifact collection reports
HTTP 200 partial failures as incomplete with collected/pending/error counts.
The Library SSE reducer preserves that POST summary regardless of whether the
`garbage-collected` event arrives before or after the response.

Phase 5 exposes automation policy only for configured GitHub Registry sources,
matching Relay validation. Each source row keeps an explicit draft for Refresh
(`manual`, `hourly`, `daily`, or `weekly`) and Rollout (`manual` or
`enabled-hosts`); Save policy submits both values with the current Registry
revision to `POST /api/skills/sources/:id/automation`. A successful response is
echoed into that exact source row, while a failed CAS retains the draft, adopts
the returned revision, and shows a row-local error. Non-GitHub sources display
the policies disabled rather than offering a write the Relay would reject.
Sources also provides an explicit Recent Audit loader. It reads the bounded
`GET /api/skills/audit` projection and, when the first page is older, requests
the latest 50-event window for inspection.

## Important functions

- `refresh()`
- `renderAll()`
- `renderHostNav()`
- `renderConversationNav()`
- `renderSessionDetails()`
- `renderRuntimePanel()`
- `renderTranscript()`
- `renderStatusWindow()`
- `renderDirectoryPicker()`
- `renderConnectorManager()`
- `renderSkillsManager()`
- `renderSkillsInventoryMatrix()`
- `refreshSkillsInventory()`
- `deploySelectedSkills()`
- `startManagedSession()`
- `sendInput()`

## Known gaps

- No authentication UI.
- No native Android shell.
- No background Web Push subscription; OS notifications are foreground
  browser notifications drained from the durable local outbox.
- No offline queue.
- No full request-user-input form builder for every possible Codex request shape.
- No file editor.
