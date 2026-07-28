# v2.4.9-dev 8897 Cumulative Repair and Session State Handoff

Date: 2026-07-27
Last updated: 2026-07-28

## Purpose

This document is the cumulative 8897 handoff for the repair chain discussed with the
user. It records both the latest conversation-input/runtime synchronization work and
the earlier API/model, Thinking/rendering, Host/Session lifecycle, connector,
launcher, persistence, and performance issues. It is intended for the Agent that
will review, summarize, package, and later promote only the accepted source changes.

Every historical entry below distinguishes observed symptoms, root cause or finding,
implemented solution, source/test evidence, and current status. "Implemented" means
the current development worktree contains code and usually focused tests; it does not
mean every real provider, remote Host, device, or long-running workflow has completed
manual acceptance.

Authorization comes from the active user workflow, not from this document. The
`v2.4.9-dev` source candidate was explicitly authorized for a controlled 8797
production test after its release gate; the production acceptance result remains
external to this handoff.

## Repository Boundaries

- Development source role: `remote_codex-dev`
- Development URL: `http://127.0.0.1:8897`
- Development state: `remote_codex-dev/tmp/relay-8897`
- Production source role: `remote_codex`
- Production URL: `http://127.0.0.1:8797`

All entries were audited against the current `remote_codex-dev` source. Items marked
Implemented have code evidence and the listed tests; Partial, Superseded, and
Unresolved entries are intentionally not completion claims. This handoff edit did not
edit or restart 8797. Some older ledger entries may already have partial or complete
counterparts in production from earlier explicitly authorized repairs; do not infer
either parity or absence. Compare each source hunk explicitly at the later acceptance
gate.

Do not use `superpowers` or any subordinate `superpowers` skill for this repository.

## v2.4.9-dev Delta from v2.4.8

This pre-release is based on the `v2.4.8` source tree. Its primary additions are:

- A durable input-command outbox with request-ID-scoped pending, accepted, and
  rejected transcript projection; crash recovery, canonical scope migration, and
  late-echo suppression prevent duplicate or resurrected prompts.
- Monotonic runtime revisions across Runner, Host Agent, Relay, and browser, plus
  race-safe submission, Stop, and Interrupt targeting for the exact run, turn, and
  client request.
- Stronger per-Session composer recovery: sent-draft snapshots, attachments, browser
  `File` objects, and API-switch/rebind cancellation state survive without leaking to
  another Session.
- Capability-gated Rebind for legacy null/unknown API bindings, with exactly-once
  first input and full rollback when Rebind is cancelled or rejected.
- Structured, expandable Thinking details for commands, tools, file changes, and
  parent/subagent collaboration; retained input/output/diffs expose upstream
  truncation instead of silently clipping content.
- A compact, non-disruptive Approval popup that exposes only Codex-advertised
  decisions and keeps detailed request data behind disclosures.
- Local-Agent ownership recovery that distinguishes stale markers, PID reuse, live
  Agents, and unverifiable identity without killing unrelated processes.
- Host Codex maintenance completion when an update has no Sessions to recover, plus a
  condensed software-update summary.
- Windows managed-overlay cleanup that tolerates transient `EBUSY` locks, retries in
  the background when needed, preserves the primary startup error, and does not turn
  cleanup failure into a terminal Session failure.

Known boundary: Goal persistence is not implemented in this release.
`goals_1.sqlite` remains inside a disposable per-managed-run overlay. Session rollout
history survives through the shared `sessions` entry, but a successful overlay cleanup
can remove Goal objective, status, budget, usage, and continuation-deferral state.
Encrypted collaboration payloads likewise cannot be decrypted by the browser or
Relay; the UI shows available plaintext metadata or an explicit unavailable marker.

## Reported Failure Modes

The fixes target these observed behaviors:

1. A sent message remained in the composer after submission.
2. Relay rejected a message as "previous turn is running", but the rejected message
   appeared later in transcript history and Codex sometimes processed it.
3. Codex was running, but the user message, Queued state, and Thinking placeholder
   were temporarily absent; they appeared together later.
4. Thinking continued to update while Queued, Running, Stopping, or error state
   disappeared or oscillated.
5. Stop sometimes required multiple attempts, and stale runtime events could revive
   an older state.
6. An acceptance-unknown input could not be interrupted reliably. HTTP 200 was
   incorrectly treated as final Interrupt success.
7. Repeated Interrupt clicks could enqueue duplicate operations.
8. SSE reconnect/detail recovery could resurrect a rejected optimistic message.
9. Relay restart could replay a durable command without reconstructing its pending
   user message.
10. Canonical Session identity migration could leave the durable outbox under the old
    scope and allow the same request ID to enqueue twice after restart.
11. Two concurrent inputs could pass preparation when a Host runtime became active
    during an asynchronous model/selection validation window.

## Implemented Behavior

### 1. Stable Input Identity and Provisional Transcript

Files:

- `apps/relay/server.js`
- `apps/mobile-web/public/app.js`

Changes:

- Relay generates a valid stable `clientRequestId` for older clients that omit it.
- A submitted user message is stored with `deliveryStatus: pending` before Host
  acceptance is known.
- Host acceptance changes the matching message to `deliveryStatus: accepted`.
- A definitive Host rejection removes only the message with the matching request ID.
- Relay broadcasts `session.transcript_removed` with that identity.
- The browser restores the matching composer draft and attachments after definitive
  rejection.
- Same-text messages with different request IDs remain independent.
- Rejected request-ID tombstones suppress late SSE, detail, and native transcript
  echoes, so the message cannot reappear.
- Pending user messages are excluded from title inference and transcript-fallback
  resume context.

### 2. Durable Input Outbox and Transcript Projection

Files:

- `apps/relay/input-command-outbox.js`
- `apps/relay/server.js`

Outbox API added or extended:

```js
recordQueued({
  hostId,
  scopeKey,
  clientRequestId,
  fingerprint,
  command,
  transcriptProjection,
})

markCompleted(hostId, commandId, clientRequestId, { sessionId, outcome })
markProjectionApplied(hostId, commandId, clientRequestId, outcome)
migrateScope(hostId, fromScopeKey, toScopeKey)
getRecoveryState() // includes projectionWork
```

Durability rules:

- A queued input WAL record includes a strict, secret-free transcript projection:
  `sessionId`, display `text`, file references, timestamp, request ID, and pending
  delivery status.
- Terminal outcomes are `accepted`, `acceptance_unknown`, or `rejected`.
- `acceptance_unknown` may refine once to `accepted` or `rejected`; accepted and
  rejected cannot conflict.
- A terminal entry is not pruned by the HTTP dedupe TTL until its current transcript
  outcome has been durably projected.
- `session-logs.json` is written through a temporary file, fsynced, and atomically
  replaced before the outbox writes `projection_applied`.
- A crash before the projection checkpoint is safe: startup idempotently reconstructs
  pending/accepted messages or removes rejected messages, persists the Session log,
  then checkpoints the projection.
- Old queued WAL records without a projection derive a compatible projection from the
  stored command and are upgraded during compaction.
- Strict schemas reject credential fields and inline file contents from the outbox.
  Prompt text and normal business paths remain allowed.

### 3. Canonical Scope Migration

Files:

- `apps/relay/input-command-outbox.js`
- `apps/relay/server.js`

Changes:

- `migrateInputRequestScope()` durably calls `InputCommandOutbox.migrateScope()`
  before migrating Relay memory caches and reservations.
- The `migrate_scope` WAL operation is fsynced before in-memory re-keying.
- Host boundaries are preserved.
- Conflicting request IDs, command IDs, fingerprints, or serialized commands fail
  closed rather than using last-write-wins behavior.
- Migration survives compaction and restart, preventing a merge/restart/retry sequence
  from issuing a second Host command.

### 4. Input Preparation Race Closure

File:

- `apps/relay/server.js`

Relevant functions:

- `reserveSessionInput()`
- `assertInputSubmissionOwnership()`
- `assertInputRuntimeStillAvailable()`

Changes:

- The reservation captures the current runtime run ID and monotonic runtime revision.
- After all asynchronous selection/model checks, Relay rechecks ownership, active-turn
  state, run identity, and revision immediately before writing the outbox.
- If another turn became active during preparation, Relay returns a definitive 409 and
  writes no WAL command and no provisional transcript.
- A pre-existing stable bridge/native run-ID mismatch remains compatible; only a
  change during the preparation window is rejected.
- This prevents a revisionless local `queued-turn` projection from overwriting a newer
  Host-authoritative active state.

### 5. Monotonic Runtime Ordering

Files:

- `apps/host-agent/codex-app-server-runner.js`
- `apps/host-agent/agent.js`
- `apps/relay/server.js`
- `apps/mobile-web/public/app.js`

Changes:

- Runner publishes a monotonic `runtimeRevision` for every runtime transition.
- Agent input receipts use the same Runner revision sequence.
- Relay and browser ignore `revision <= current` for the same run.
- `commandClientRequestId` identifies the input command being acknowledged, while
  runtime `clientRequestId` identifies the currently active turn. A busy rejection can
  no longer overwrite the older active-turn identity with the rejected request ID.
- Optimistic Stop rollback uses runtime apply generation and stream generation compare-
  and-swap checks. A later SSE event wins even if it has the same revision or no
  revision.

### 6. Acceptance-Unknown Interrupt Lifecycle

Files:

- `apps/host-agent/codex-app-server-runner.js`
- `apps/host-agent/agent.js`
- `apps/relay/server.js`
- `apps/mobile-web/public/app.js`

Changes:

- A `turn/start` timeout retains the active client request identity.
- Interrupt carries stable targeting fields:
  `interruptRequestId`, `expectedRunId`, `expectedTurnId`, and
  `expectedClientRequestId`.
- Runner retains a pending Interrupt intent until the exact native turn ID becomes
  known, then sends one Interrupt RPC for that turn.
- If the turn completes before `turn/started`, the pending intent is explicitly
  settled without interrupting a later turn.
- Host publishes `session.interrupt_result` with `accepted`, `pending`, `no_active`, or
  `failed`.
- Browser handles this SSE event and keeps the Interrupt lock while status is pending
  or while accepted Interrupt still has an active runtime.
- The operation unlocks only after runtime becomes inactive, or after `no_active` or
  `failed`.
- UI keeps an explicit operation notice instead of treating the Relay HTTP 200 as
  final Host success.

### 7. Per-Session Draft and Attachment Recovery

File:

- `apps/mobile-web/public/app.js`

Changes:

- Composer drafts, attachments, local image paths, active submissions, and sent-draft
  snapshots are keyed by canonical Session identity.
- Sent-draft snapshots are distinct from the current editable composer draft.
- A turn may clear the submission lock after acceptance without destroying the
  snapshot needed by Interrupt or a later definitive failure.
- Draft restoration merges with the Session's current draft instead of overwriting new
  user input.
- Session identity migration moves all draft, snapshot, tombstone, and operation state.
- API-switch cancellation no longer discards typed text or temporary attachments.

### 8. SSE Reset and Authoritative Detail Recovery

File:

- `apps/mobile-web/public/app.js`

Changes:

- `cursor_missing` now requires detail recovery, along with cursor expiration,
  invalidation, or canonical-key changes.
- Runtime transition from inactive to active schedules a transcript render even when
  transcript SSE is late, so a Thinking placeholder appears immediately.
- Full detail recovery reconciles pending user messages by request ID.
- Server transcript is authoritative for persisted entries.
- A local optimistic pending entry absent from authoritative detail is retained only
  for a short grace period when the same request is still tracked by composer and an
  active runtime.
- Rejected or abandoned local pending entries are removed instead of unioned back into
  history.

## Primary Source Files for Packaging

Review and package these source files selectively:

1. `apps/host-agent/codex-app-server-runner.js`
2. `apps/host-agent/agent.js`
3. `apps/relay/input-command-outbox.js`
4. `apps/relay/server.js`
5. `apps/mobile-web/public/app.js`

Do not copy the entire dirty worktree. These files contain other accumulated product
work, so compare development against the intended production baseline and promote
reviewed source changes only.

## Tests Added or Extended

The task chain added or extended coverage in:

- `scripts/test-input-command-outbox.js`
- `scripts/test-session-api-relay.js`
- `scripts/test-session-api-ui.js`
- `scripts/test-session-api-host-runner.js`
- `scripts/test-composer-draft-state.js`
- `scripts/test-diagnostic-render-throttle.js`
- `scripts/test-mobile-realtime-resume.js`
- `scripts/test-runner-turn-runtime-state.js`
- `scripts/test-runner-thinking-snapshots.js`
- `scripts/test-host-agent-command-lifecycle.js`
- `scripts/test-session-event-stream.js`

Important regression cases include:

- Outbox fsync failure leaves a command replayable.
- Projection checkpoint failure does not mutate durable outcome state.
- Rejected completion survives longer than dedupe TTL until projection is checkpointed.
- Old WAL compatibility and compaction.
- Scope migration fsync failure leaves memory unchanged.
- Scope migration, restart, and same-request retry return the original command ID.
- Relay restart reconstructs a pending message missing from `session-logs.json`.
- Relay restart removes a rejected ghost before Session detail is exposed.
- Runtime becomes active during the artificial input preparation delay: 409, no WAL,
  no echo, and active runtime remains unchanged.
- Same text with distinct request IDs: only rejected identity is removed.
- `cursor_missing` causes detail recovery.
- Full detail does not resurrect a removed optimistic entry.
- Interrupt remains locked for pending and accepted-active states.
- Sent draft remains recoverable after active-turn acknowledgement.
- Stop rollback cannot overwrite a later SSE update.
- A legacy history Session whose saved API binding is null/unknown cannot enter
  ordinary Resume; explicit Rebind selects a compatible saved Host profile first or
  the Host environment when no compatible profile exists.
- Legacy Rebind preserves the original first-turn `inputItems` and
  `clientRequestId`, sends them exactly once, and does not carry old model/effort into
  the new run.
- Rebind cancellation or `accepted: false` restores text, selection, attachments,
  browser `File` objects, and the local image path.
- Rebind capability gates reject an old Agent before catalog, plan, Stop, or Start;
  binding fingerprints remain durable across Relay restart.

## Historical Verification Evidence

The following commands were recorded as passing before the later PID-reuse,
Approval/Thinking, Host-maintenance, and overlay-`EBUSY` changes. They are historical
evidence, not the final `v2.4.9-dev` release gate:

```powershell
node --check apps\relay\server.js
node --check apps\relay\input-command-outbox.js
node --check apps\host-agent\agent.js
node --check apps\host-agent\codex-app-server-runner.js
node --check apps\mobile-web\public\app.js

npm run test:session-api-model:unit
npm run test:session-api-model:integration
npm run test:transcript:unit
npm run test:realtime-sync

node scripts\test-diagnostic-render-throttle.js
node scripts\test-host-agent-command-lifecycle.js
node scripts\test-runner-turn-runtime-state.js
node scripts\test-runner-thinking-snapshots.js
node scripts\test-session-event-stream.js

node scripts\test-session-api-ui.js
node scripts\test-composer-draft-state.js
node scripts\test-session-api-relay.js
node scripts\test-session-api-host-runner.js
node scripts\test-dev-instance-isolation.js
node scripts\test-dev-relay-local-agent-guard.js
```

The complete Session API integration suite passed Host/Runner, Host lease, Relay,
state lock, UI, local-Agent graceful shutdown, late shutdown, and target Session
reconstruction assertions. The unit suite, full integration suite, and development
isolation guards also passed after the legacy null/unknown binding repair. Relay
restart coverage confirms that the repaired run binding fingerprint remains durable.

The 8897 browser smoke test confirmed:

- Document loaded completely.
- Development Host selector contained only `<local-dev-host-id>`.
- Selected Host was online.
- History loading completed.
- No visible modal blocked the app.
- Browser console contained no warnings or errors.

## v2.4.9-dev Release Gate

The final clean `v2.4.8`-based release snapshot passed:

- Syntax checks for 15 changed Relay, Host, browser, and shared JavaScript files.
- `test:session-api-model:unit` and `test:session-api-model:integration`, including
  durable outbox, legacy Rebind, PID reuse/adoption, and transient/persistent/primary-
  error overlay cleanup cases.
- `test:transcript`, `test:notifications`, and the included realtime/watch/memory
  suites.
- `test:start-windows`, `test:host-codex-update`, `test:managed`, and
  `test:session-action-layout`.
- Focused Approval idempotency/routing, Local Agent watchdog, Host command lifecycle,
  Runner runtime state, and software-update tests.
- `git diff --check` and an offline lockfile install with zero reported vulnerabilities.

After those tests, 8897 was gracefully restarted from the final source with:

- Health: healthy, ready, and writable.
- Persistence: `ok`.
- Repository role: `remote_codex-dev`.
- State root: `remote_codex-dev/tmp/relay-8897`.
- Development-only Host: `<local-dev-host-id>`, online.
- Host capability `sessionApiRebindV1`: true.

Automated UI contract/layout coverage passed. Final visible provider/device workflows
remain in the manual acceptance checklist and are not claimed complete by this gate.

## Historical 8897 Runtime Snapshot

At the 2026-07-28 handoff update:

- Health: healthy, ready, and writable.
- Persistence: `ok`.
- URL: `http://127.0.0.1:8897`
- Owner repository: `remote_codex-dev`
- Owner state root: `remote_codex-dev\tmp\relay-8897`
- Development Host: `<local-dev-host-id>`
- Development Host online: yes.
- Development Host capability `sessionApiRebindV1`: true.
- Development/production Host ID intersection: none.

Browser acceptance confirmed that the stopped legacy fixture remains visibly marked
as `Unknown API binding` and offers `Rebind & Resume`, with both `Host environment`
and compatible saved profiles available as explicit choices. No real provider Rebind
was executed during this check. The fixture was left unchanged as legacy, stopped,
unknown-binding, and with no pending operation for user acceptance.

The former 8897 `<production-pi5-host-id>` Agent reused the production Host ID and violated the
acceptance isolation rule. It was dismissed only from 8897. Production `<production-pi5-host-id>`
remained online on 8797. Future remote pi5 acceptance must use both:

- Host ID: `<pi5-dev-host-id>` or another development-only ID.
- A development-only `CODEX_HOME` and Agent state directory.

## Worktree and Packaging Warnings

The development worktree is heavily dirty and contains unrelated historical changes.
It is based on `v2.4.7`, while the release baseline is the separate `v2.4.8` commit.
Many files tracked by `v2.4.8` therefore appear untracked in the development branch.
Do not infer packaging scope from plain `git diff`, do not run `git add -A`, and do not
copy or mirror the complete directory. Build the release on `v2.4.8` in a clean
worktree and add only the reviewed source/test manifest plus this handoff and the new
release note. Review every untracked candidate explicitly.

Never package or promote:

- `tmp/` or any Relay/Session state.
- `session-record-store`, WAL data, logs, owner markers, locks, or PID files.
- Auth tokens, API keys, account files, connector secrets, or saved Host recipes.
- Development `CODEX_HOME`.
- `node_modules`.
- Generated acceptance logs.
- Production or development Agent runtime state.

## Manual Acceptance Checklist

Exercise these on isolated 8897 where possible and repeat the critical paths during
the explicitly authorized 8797 production test:

1. Send a prompt: composer clears immediately and user message plus Queued/Thinking
   appears immediately.
2. While a turn is active, attempt a second prompt: definitive rejection removes only
   that prompt, restores its draft/attachments, and refresh does not revive it.
3. Send identical visible text under separate request identities: one rejection must
   not remove the accepted message.
4. Interrupt during submitting/confirmation: only one operation is allowed, pending
   state remains visible, and the lock remains until the matching runtime settles.
5. Stop while runtime/Thinking events continue: Stopping must not disappear and an old
   runtime event must not revive Running.
6. Reconnect/reload after an SSE reset: transcript, Queued/Thinking, and runtime state
   remain aligned.
7. Confirm typed unsent text and attachments survive Session switching and cancelled
   API switching.
8. On a legacy null/unknown-binding history Session, confirm ordinary Resume is not
   used; choose `Rebind & Resume`, verify compatible Host profiles take precedence
   over Host environment, and exercise both cancel and `accepted: false` recovery.
   With a real provider, verify the first text/attachments are sent once under the
   original request identity and that stale model/effort do not cross the Rebind.

The active workflow has authorized a source-only 8797 production test after the
automated release gate. This checklist records manual acceptance; it is not the source
of authorization. Before 8797 testing, create the source backup/tag, report the exact
promoted manifest, restart in a controlled way, and verify health without copying any
development runtime state.

## Cumulative Historical Issue Ledger

Status vocabulary used below:

- **Implemented + automated**: source and focused test coverage exist in the current
  8897 worktree. This label does not claim that every cumulative test was rerun after
  every historical edit. The Historical Verification Evidence section lists commands
  actually recorded as passing for the latest state-synchronization chain. Manual
  acceptance may still be required.
- **Implemented + acceptance required**: the main repair exists, but the real provider,
  Host, browser, network, or long-running behavior still needs 8897 exercise.
- **Partial**: the important failure path was addressed, but a stated edge, cleanup, or
  focused regression test remains.
- **Superseded**: the user later replaced or withdrew the original requirement.
- **Unresolved / operational**: code cannot establish the historical external cause or
  the requested behavior has not been implemented.

### A. API, Model, Rebind, and Reasoning Controls

#### A01. Provider was an ambiguous free-text label

- **Observed symptom:** OpenAI, Anthropic, Gemini, OpenAI-compatible proxies, and
  private APIs could not select distinct capability policy from the API editor.
- **Cause / finding:** the legacy `provider` label also participated in the immutable
  binding identity. Rewriting old labels during migration would make an unchanged
  historical Session look as though its API identity had changed.
- **Implemented solution:** added a `providerKind` select with `openai`, `anthropic`,
  `gemini`, and `custom`; Custom retains a separate label. Migration preserves the old
  identity label, and compatible/Azure/private proxies are not guessed to be official
  OpenAI merely from their name.
- **Files / evidence:** `apps/mobile-web/public/index.html`,
  `apps/mobile-web/public/provider-capabilities.js`, `apps/mobile-web/public/app.js`;
  `scripts/test-provider-capabilities.js`, `scripts/test-session-api-ui.js`.
- **Status:** **Implemented + automated**.

#### A02. Provider-specific reasoning capability source

- **Observed symptom:** the user wanted model-specific Thinking levels, with OpenAI
  implemented first, Anthropic/Gemini extension points, and Custom manual input.
- **Cause / finding:** `/models` normally proves model membership, not reasoning
  metadata. Scraping live documentation in the browser would not be stable runtime
  authority.
- **Implemented solution:** added a versioned provider-capability registry. Exact
  OpenAI model IDs have advisory data, while live Codex/provider metadata wins when
  present. Unknown OpenAI IDs are not matched fuzzily. Anthropic and Gemini expose
  policy hooks only; Custom can use the manual path.
- **Files / evidence:** `apps/mobile-web/public/provider-capabilities.js`,
  `apps/relay/model-catalog-service.js`, `apps/relay/server.js`;
  `scripts/test-provider-capabilities.js`, `scripts/test-model-catalog-service.js`.
- **Status:** OpenAI and Custom are **Implemented + automated**; Anthropic/Gemini
  concrete capability tables and live official-document refresh are **unimplemented**.

#### A03. Incomplete or misspelled Thinking levels

- **Observed symptom:** a fixed selector omitted current levels and could expose values
  such as `xhig`; expected values include `none`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`, and `ultra` where the selected model supports them.
- **Cause / finding:** a global hard-coded list could not represent per-model
  capabilities or changes reported by different Codex versions.
- **Implemented solution:** options are generated from the selected model's catalog.
  Runtime-advertised values override advisory data; an old selected but now invalid
  value remains visible as disabled rather than silently becoming Auto. Manual values
  are normalized and validated, not typo-corrected by guessing.
- **Files / evidence:** `apps/mobile-web/public/app.js`,
  `apps/mobile-web/public/provider-capabilities.js`,
  `apps/relay/model-catalog-service.js`; provider, UI, Host-runner, and Relay Session
  API tests.
- **Status:** **Implemented + automated**, with real-model 8897 acceptance required.

#### A04. Custom model and Thinking manual validation

- **Observed symptom:** private providers needed manual model/effort input plus a check
  that the request was reasonable.
- **Cause / finding:** unknown private models may have no authoritative catalog, but
  accepting arbitrary strings without an explicit trust decision produces opaque
  provider errors.
- **Implemented solution:** Custom unknown models may enter a manual effort that begins
  with a letter, contains lowercase letters/digits/underscore/hyphen, and is at most
  32 characters. Known capabilities must match. Unknown capability requires the
  explicit `Allow unverified effort` choice. UI, Relay catalog, and Host runner each
  validate; Rebind preflight contacts the target catalog.
- **Files / evidence:** `apps/mobile-web/public/app.js`,
  `apps/relay/model-catalog-service.js`, `apps/host-agent/session-api-runtime.js`;
  `scripts/test-session-api-ui.js`, `scripts/test-session-api-relay.js`,
  `scripts/test-session-api-host-runner.js`.
- **Status:** **Implemented + automated**. It is validation in send/Rebind, not a
  separate standalone "test effort" request button.

#### A05. Provider returned 19 models while Session showed six defaults

- **Observed symptom:** API Ping/Fetch could report 19 models, while current Session
  refresh still showed the old six-model list.
- **Cause / finding:** provider `/models` proves account advertisement; live Codex
  `model/list` proves what the current runtime reports. The old UI exposed both without
  ownership or authority, and a profile fetch could not safely overwrite a different
  Session/run selector.
- **Implemented solution:** `ModelCatalogService` merges live, provider, override, and
  last-known-good sources under Host + canonical Session + run + binding fingerprint +
  provider-kind ownership. UI reports provider/live/selectable/hidden counts. Rebind
  returns the target catalog so an older live response cannot replace it. Custom may
  select provider-advertised entries even when live does not enumerate them; other
  providers remain conservative when live gives complete absence evidence.
- **Files / evidence:** `apps/relay/model-catalog-service.js`,
  `apps/relay/rebind-catalog-reuse.js`, `apps/relay/server.js`,
  `apps/mobile-web/public/app.js`; model-catalog and Session API suites.
- **Status:** **Partial / acceptance required**. Catalog ownership is fixed, but
  "provider returned 19, therefore all 19 are selectable" is intentionally not true
  for every non-Custom provider. Validate the user's actual API/Codex pair on 8897.

#### A06. Remote Host could not list models while local Host could

- **Observed symptom:** local Rebind returned models, but remote/HPC Host returned an
  empty or failed catalog.
- **Cause / finding:** the remote path needs a current Agent with `modelList` and
  `apiCatalog`, a Codex app-server supporting `model/list`, network reachability from
  that Host, and a verified run binding. An old Agent/Codex or a blocked endpoint is an
  environment failure, not evidence for a fallback static list.
- **Implemented solution:** model and provider catalog requests execute on the target
  Host and carry run/binding identity. Missing capability and mismatch return
  structured errors rather than fake defaults.
- **Files / evidence:** `apps/host-agent/agent.js`,
  `apps/host-agent/codex-app-server-runner.js`, `apps/relay/server.js`;
  Host-runner and Relay integration tests.
- **Status:** protocol is **Implemented + automated**; real pi5/HPC result is
  **unresolved until a development-only Host is tested on 8897**.

#### A07. Custom Base URL needed `/v1` or fell back to OpenAI

- **Observed symptom:** a Custom OpenAI-compatible endpoint returned HTML without `/v1`;
  after adding it, requests appeared to target the OpenAI default URL.
- **Cause / finding:** empty official-OpenAI defaults, explicit Custom endpoints, and
  inherited `OPENAI_*` environment variables were previously insufficiently
  separated.
- **Implemented solution:** only official OpenAI with an empty Base URL defaults to
  `https://api.openai.com/v1`. Anthropic/Gemini/Custom require an explicit URL. Profile
  runs clear inherited case variants of `OPENAI_*`, then inject only that profile into
  an isolated managed overlay. When root `/models` is invalid HTML/404/405 and the same
  origin's `/v1/models` is positively verified, UI can offer a same-origin `/v1`
  correction; it never silently crosses origin.
- **Files / evidence:** `apps/host-agent/runtime-utils.js`,
  `apps/host-agent/session-api-runtime.js`,
  `apps/host-agent/codex-app-server-runner.js`, `apps/mobile-web/public/app.js`;
  Session API Host/Relay/UI tests.
- **Status:** **Implemented + automated**, with the real Custom endpoint requiring
  8897 acceptance.

#### A08. Global, per-Host, per-API, and New-Session defaults conflicted

- **Observed symptom:** several "default" controls could appear to override one
  another, and a resumed Session could accidentally inherit the current Host default.
- **Cause / finding:** credential/API selection and per-turn model/effort are different
  state. Storing hidden model/effort defaults inside a profile conflicted with current
  Session controls and immutable historical binding.
- **Implemented solution:** a fresh Session uses the Host profile mapping, then the
  browser global profile fallback. Fresh model/effort are Auto unless creation
  explicitly supplies them. Resume uses the saved Session binding. Existing Session
  API changes require explicit Rebind. Per-Session next-turn model/effort stay keyed to
  that Session.
- **Files / evidence:** `apps/mobile-web/public/app.js`,
  `apps/mobile-web/public/index.html`, `shared/api-binding.js`;
  `scripts/test-session-api-ui.js`, `scripts/test-session-provenance.js`.
- **Status:** **Implemented + automated**. Legacy `profile.sessionDefaults` may remain
  in stored/backup schema for compatibility but is no longer an active UI/default.

#### A09. Save current model/effort as an API-wide default

- **Observed symptom / request:** save the current API + model + effort so all future
  Sessions using that API receive them.
- **Cause / finding:** the later user decision removed this duplicated New-Session
  runtime default and retained Host API mapping plus explicit current-Session state.
- **Implemented solution:** API profiles retain provider/URL/key and per-Host mapping;
  model/effort do not become hidden profile defaults. Applying a live configuration to
  other Sessions is an explicit reviewed batch Rebind.
- **Files / evidence:** API settings UI and `resolveFreshSessionSelection()` contracts
  in `apps/mobile-web/public/app.js`; `scripts/test-session-api-ui.js`.
- **Status:** **Superseded by the user's later requirement**.

#### A10. Rebind raced canonical runtime state or hit `no rollout found`

- **Observed symptom:** `Canonical Session runtime configuration changed before
  Rebind could start`; an empty new Session could fail native Resume with `no rollout
  found`.
- **Cause / finding:** Rebind used an aging list projection while async catalog work
  could advance the run. A managed shell has no native rollout before Codex
  materializes its first thread.
- **Implemented solution:** Rebind reloads stable canonical runtime config, freezes the
  selected API/model/effort snapshot, and submits run/status/binding CAS preconditions.
  Catalog validation is idle-gated. Ambiguous HTTP completion is reconciled against
  the exact new run/binding. An explicit same-Session Rebind with no materialized
  rollout uses `fresh_rebind`; ordinary Resume/Fork of an empty stopped shell fails
  early with a structured explanation.
- **Files / evidence:** `apps/mobile-web/public/app.js`,
  `apps/relay/session-provenance-service.js`, `apps/relay/server.js`,
  `apps/host-agent/codex-app-server-runner.js`; provenance, Relay, UI, Host-runner, and
  target reconstruction tests.
- **Status:** **Implemented + automated**, with a real first-turn Rebind acceptance
  case still required on 8897.

#### A11. API switch retained an unavailable old model/effort

- **Observed symptom:** after switching API, the old model remained selected and the
  next request failed with `model ... is not available`.
- **Cause / finding:** the old Session selection was copied before the target catalog
  became authoritative.
- **Implemented solution:** API switch starts with model Auto and effort Auto. After a
  successful Rebind, it uses the response-owned target catalog and chooses provider
  default if selectable, otherwise its first selectable provider entry. It does not
  infer chronology from the model name; "latest" here means provider default/order.
- **Files / evidence:** `switchSessionApiFromComposer()`,
  `preferredModelForApiSwitch()`, and `applySessionSelectionToSessionOptions()` in
  `apps/mobile-web/public/app.js`; `scripts/test-session-api-ui.js`.
- **Status:** **Implemented + automated**.

#### A12. Duplicate settings controls and flashing model selector

- **Observed symptom:** Settings, Rebind, and composer each asked for API/model/effort;
  model options repeatedly flashed/reordered and could fall back to Auto while the
  user interacted.
- **Cause / finding:** several render paths owned overlapping state and replaced whole
  `<select>` contents on refresh.
- **Implemented solution:** composer bottom-right is the current Session API/model/
  Thinking surface. Model/effort affect a later turn without Rebind; API changes use a
  confirmed Rebind. Settings retains binding/catalog/advanced/batch details and removes
  the visible second Fetch Models/model-default UI. `syncSelectOptions()` reconciles
  stable options instead of replacing the control.
- **Files / evidence:** `apps/mobile-web/public/index.html`,
  `apps/mobile-web/public/app.js`, `apps/mobile-web/public/styles.css`;
  `scripts/test-session-api-ui.js`, `scripts/test-session-action-dialog-layout.js`.
- **Status:** **Implemented + automated**. Internal profile-fetch helpers and legacy
  data compatibility remain as cleanup candidates, not visible duplicate UI.

#### A13. Apply current Session settings to other live Sessions

- **Observed symptom / request:** select Hosts and their live Sessions, apply the
  source Session's API/model/effort, restart once, allow child deselection, show full
  rows, and confirm success.
- **Cause / finding:** the old flow read editable/default fields instead of the source
  run, duplicated catalog fetches, clipped long rows, and lacked a terminal summary.
- **Implemented solution:** captures the source canonical profile and current
  selection, excludes the source, groups targets by Host, supports Host select-all and
  child deselection, performs read-only preflight before apply, reuses a short-lived
  catalog proof, requires idle state, and reports per-row plus overall success/partial
  failure. The modal has bounded viewport layout, an independently scrolling list,
  fixed-size checkboxes, and wrapping IDs/paths.
- **Files / evidence:** `apps/mobile-web/public/app.js`,
  `apps/mobile-web/public/index.html`, `apps/mobile-web/public/styles.css`,
  `apps/relay/rebind-catalog-reuse.js`; Session API, reuse, and Playwright dialog layout
  tests.
- **Status:** **Implemented + automated**, with real multi-Host 8897 acceptance needed.

#### A14. "Copy current Session settings" erased prior configuration

- **Observed symptom:** the old button overwrote/cleared edited profile values and its
  purpose was unclear.
- **Cause / finding:** it mixed an editor-copy operation with a live-Session operation.
- **Implemented solution:** removed that workflow. The only replacement is the explicit
  `Apply current Session settings to other live Sessions`, which does not mutate the
  source or API profile editor.
- **Files / evidence:** `apps/mobile-web/public/index.html`,
  `openApplyCurrentSessionSettingsDialog()` in `app.js`;
  `scripts/test-session-api-ui.js`.
- **Status:** **Implemented + automated**.

#### A15. API switch cancellation lost composer text and attachments

- **Observed symptom:** cancelling an API switch made typed text disappear; temporary
  attachments were also at risk.
- **Cause / finding:** Rebind redraw and canonical Session migration previously relied
  on global DOM composer state.
- **Implemented solution:** snapshot and preserve text, selection, File objects,
  previews, local image path, attachments, and Session options by canonical key.
  Cancel/failure/finally remount the newest draft, and identity migration moves all
  state. New edits made while a request is pending win over the older snapshot.
- **Files / evidence:** `apps/mobile-web/public/app.js` and
  `scripts/test-composer-draft-state.js`, plus API switch transaction tests.
- **Status:** **Implemented + automated**; real attachment-cancel UI acceptance remains
  useful.

#### A16. Per-Host API keys and immutable Session binding

- **Observed symptom / question:** whether different Hosts still retain different API
  selections and whether New-Session defaults can conflict with existing Sessions.
- **Cause / finding:** a Host default is only a launch preference; a run's API identity
  must not mutate when browser defaults or credentials change.
- **Implemented solution:** browser storage retains global and per-Host profile mapping.
  The canonical run stores only a secret-free binding fingerprint/provider/endpoint;
  profile credentials are resolved locally for launch. API-key rotation is permitted
  when provider/endpoint/profile identity is unchanged. Input/compact never re-send a
  Host default. Resume, Stop, Rebind, model catalogs, and lifecycle events are run- and
  binding-scoped.
- **Files / evidence:** `shared/api-binding.js`,
  `apps/relay/session-provenance-service.js`, `apps/relay/model-catalog-service.js`,
  Relay/Host/UI Session API code and suites.
- **Status:** **Implemented + automated**. Do not package browser profile storage or
  keys; only source code belongs in promotion.

#### A17. Legacy null/unknown API binding incorrectly used ordinary Resume

- **Observed symptom:** an older stopped history Session with no usable saved API
  binding still displayed and entered the ordinary Resume path. Frontend binding
  validation then rejected the operation because no verifiable API identity could be
  inherited. When activation originated from the composer, cancellation or explicit
  non-acceptance also risked leaving the pending first-message draft cleared.
- **Cause / finding:** legacy records can have a null/unknown binding while still
  retaining a valid Host, canonical Session, and run identity. Ordinary Resume cannot
  prove which credential environment created that run. The previous capability check
  was also too broad: an old or non-app-server Agent could appear generally
  binding-aware without supporting the complete safe Rebind transaction.
- **Implemented solution:** legacy null/unknown history now requires explicit
  `Rebind & Resume`. The chooser prefers a compatible saved profile mapped to the
  selected Host; if none is usable, it offers the Host environment as an explicit
  choice. Relay and browser validate the exact canonical Session, `runId`, live state,
  and target binding fingerprint before continuing. The new run preserves the first
  `inputItems` and `clientRequestId` and submits them exactly once; the old model and
  effort never cross this repair boundary.
- **Cancellation/rejection recovery:** cancellation and `accepted: false` restore the
  original composer text, selection, attachment metadata, browser `File` objects, and
  local image path instead of leaving the draft cleared or partially migrated.
- **Host capability contract:** `sessionApiRebindV1` is advertised only when the
  resolved default managed runtime is `codex-app-server`. Safe Rebind also requires
  `runApiBinding` and `apiCatalog`; Host-environment Rebind additionally requires
  `bindingPreflight`. Relay returns 409 before catalog, `planRun`, Stop, or Start when
  an older Agent lacks any required capability. User-supplied Rebind `command` or
  `args` overrides return 400, and the queued managed command is forced to
  `command: null` and `args: []` so no legacy launch override can bypass binding
  validation.
- **Files / evidence:** `apps/mobile-web/public/app.js`, `apps/relay/server.js`,
  `apps/host-agent/agent.js`, and the managed app-server runtime path;
  `scripts/test-session-api-ui.js`, `scripts/test-composer-draft-state.js`,
  `scripts/test-session-api-relay.js`, and
  `scripts/test-session-api-host-runner.js`. Unit and full integration suites plus
  development isolation guards passed; Relay restart coverage verifies durable
  binding-fingerprint persistence.
- **Status:** **Implemented + automated; user acceptance required**. Browser inspection
  confirmed the legacy fixture shows `Unknown API binding` and `Rebind & Resume`, with
  Host environment and compatible saved profiles visible. No real provider Rebind was
  executed, and the fixture remains legacy/stopped/unknown with no pending operation.

### B. Thinking, Transcript, Alerts, Markdown, and Files

#### B01. Reasoning appeared as one word or delta per row

- **Observed symptom:** reasoning/commentary/plan fragments such as `Review / ing /
  state` appeared on separate lines; one tool lifecycle also appeared as unrelated
  start/output/completed rows.
- **Cause / finding:** app-server emits deltas and lifecycle events, while the old UI
  rendered each diagnostic independently and inserted separators without stable
  activity identity.
- **Implemented solution:** `ThinkingActivityAggregator` groups by stable activity,
  coalesces high-frequency delta for 75 ms, preserves exact whitespace, and publishes
  monotonic revisions. Browser normalization appends deltas, replaces full snapshots,
  gives terminal status precedence, and uses CJK/punctuation-aware text joining.
- **Files / evidence:** `shared/thinking-activity.js`,
  `apps/host-agent/codex-app-server-runner.js`,
  `apps/mobile-web/public/thinking-entry-model.js`, `apps/mobile-web/public/app.js`;
  Thinking aggregator/model/runner/render tests.
- **Status:** **Implemented + automated**.

#### B02. Commands, tool calls, and edited files were not structured

- **Observed symptom:** command, cwd, arguments, output, exit status, tool calls, and
  file edits were mixed into prose and could not be independently expanded.
- **Cause / finding:** protocol variants use different fields and IDs across
  `commandExecution`, process deltas, file changes, patches, MCP tools, searches, and
  subagents.
- **Implemented solution:** normalize reasoning/plan/commentary/tool/command/search/
  file categories and alias their item/call/process identity. Render each operation as
  a disclosure with status and structured fields. File disclosures show add/modify/
  delete, line counts, and diff; `patch_apply_end` stdout can recover updated paths.
  Retained command input, arguments, output, result, and diffs are independently
  expandable, and upstream truncation is disclosed instead of silently clipping.
  Parent/subagent collaboration rows expose available sender, recipients, prompt,
  status, and result metadata in the parent Thinking stream. Encrypted payloads use an
  explicit unavailable placeholder. User-controlled payloads use `textContent`.
- **Files / evidence:** `apps/host-agent/codex-app-server-runner.js`,
  `apps/mobile-web/public/thinking-entry-model.js`, `apps/mobile-web/public/app.js`;
  `scripts/test-thinking-entry-model.js`, `scripts/test-thinking-entry-rendering.js`,
  and Runner snapshot tests.
- **Status:** **Implemented + automated**. The UI cannot decrypt collaboration content
  that Codex exposes only as ciphertext; it shows plaintext metadata when available.

#### B03. Thinking updates closed disclosures or reset nested scroll/focus

- **Observed symptom:** a new event replaced the entire Thinking card, closed expanded
  output/diff, reset nested scroll to zero, or moved keyboard focus.
- **Cause / finding:** entries had no stable render key/version, so revision updates
  could only rebuild a whole subtree.
- **Implemented solution:** keyed narrow patching reuses unchanged DOM and captures/
  restores outer and inner `<details>` state, `pre` scroll offsets, diff scroll, and
  focus. Render versions include the fields that actually affect presentation.
- **Files / evidence:** narrow-patch and state functions in
  `apps/mobile-web/public/app.js`; `scripts/test-thinking-entry-rendering.js` and
  `scripts/test-mobile-thinking-scroll-stability.js`.
- **Status:** **Implemented + automated**.

#### B04. New Thinking content moved the reader's viewport

- **Observed symptom:** while reading an older Thinking entry or transcript message,
  live append, disclosure expansion, or MathJax layout pulled the view to the bottom.
- **Cause / finding:** there was no explicit follow/detached ownership and outer
  transcript, inner Thinking, mobile page flow, and asynchronous restore paths could
  each move scroll position.
- **Implemented solution:** independent outer and per-Thinking scroll state machines
  track follow/detached mode, user revision, raw scroll, bottom offset, visible anchor,
  and viewport offset. Old async restore cannot override a later trusted user scroll.
  New data shows an unread/Bottom indicator when detached. MathJax and narrow/full
  renders restore anchors; Thinking uses `overflow-anchor: none`.
- **Files / evidence:** `apps/mobile-web/public/transcript-scroll.js`,
  `apps/mobile-web/public/app.js`, `apps/mobile-web/public/styles.css`; scroll-state,
  stability, rendering, and performance tests.
- **Status:** **Implemented + automated**, with long real-phone 8897 acceptance advised.

#### B05. Info/Alert surfaces displayed transient noise

- **Observed symptom:** ordinary diagnostics, temporary retries, recovered startup
  errors, harmless stderr, and assistant messages could appear as persistent alerts.
- **Cause / finding:** raw output, diagnostic audit data, and actionable alerts shared
  presentation rules; recovered conditions were not reconciled.
- **Implemented solution:** Relay promotes only important error/retry/quota/approval/
  offline/disk/sandbox text. Browser displays warning/error and filters assistant
  messages, known sandbox/sqlite noise, no-live watch operations, normal SIGTERM,
  recovered startup failures, and recovered transient retries. Clear stores a
  dismissal fingerprint instead of deleting server history. Alert windows are bounded.
- **Files / evidence:** `buildAlertFromOutput()` in `apps/relay/server.js` and
  `shouldDisplayAlert()` plus recovery filters in `apps/mobile-web/public/app.js`;
  diagnostic render-throttle coverage.
- **Status:** **Partial**. The main alert box is narrowed, but Status `Event Timeline`
  deliberately retains a broader 48-event audit and the full filter policy lacks a
  dedicated focused test.

#### B06. Error, Thinking, Running, and Stopping contradicted one another

- **Observed symptom:** an Error remained while Thinking updated; Stopping vanished
  and returned; reconnecting hid a terminal failure; old detail/runtime revived Running.
- **Cause / finding:** different panels inferred activity independently; partial runtime
  patches could erase active fields, client timestamps were not authoritative, and
  optimistic Stop rollback was unguarded.
- **Implemented solution:** central activity/error presentation, merged runtime
  patches, monotonic `runtimeRevision` across Runner/Agent/Relay/browser, stale same-run
  rejection, and apply/stream-generation CAS for rollback. Ending/stopping blocks input,
  terminal errors outrank reconnect warnings, and active runtime creates a Thinking
  placeholder before transcript delivery.
- **Files / evidence:** Runner, Agent, Relay, and `apps/mobile-web/public/app.js`;
  runtime-state, lifecycle, Relay/UI, and mobile-realtime tests.
- **Status:** **Implemented + automated**, with real reconnect/Stop acceptance required.

#### B07. Message remained in composer, duplicated, or returned after rejection

- **Observed symptom:** send left text in the box; one prompt/reply appeared twice; a
  `previous turn is running` rejection later reappeared and could be processed; active
  runtime temporarily had no user row, Queued, or Thinking.
- **Cause / finding:** text was used as identity across optimistic UI, Relay, Host,
  native transcript, and detail/SSE recovery; the optimistic row was not durable and
  rejected late echoes had no tombstone.
- **Implemented solution:** stable `clientRequestId`, durable pending projection,
  accepted/rejected outcomes, identity-targeted removal, draft restoration, rejected
  tombstones, assistant stable identity/sequence, cursor-missing detail recovery, and
  immediate active-runtime placeholder. The complete outbox/revision mechanics are in
  Sections 1-8 of this document.
- **Files / evidence:** `apps/relay/input-command-outbox.js`, `apps/relay/server.js`,
  `apps/mobile-web/public/app.js`, `shared/assistant-message-identity.js`; outbox,
  composer, Session API, realtime, assistant identity, and transcript-state tests.
- **Status:** **Implemented + automated; 8897 acceptance is still mandatory**.

#### B08. Composer draft and attachments leaked or disappeared across Sessions

- **Observed symptom:** switching A/B lost drafts; async paste into A attached to B;
  API cancel lost content; failure recovery overwrote newer input.
- **Cause / finding:** composer state was a global singleton, bridge/native alias merge
  changed keys, active send and editable draft shared cleanup, and file reads did not
  capture their originating Session.
- **Implemented solution:** per-canonical-Session editable draft, active draft, sent
  snapshot, submission, attachments, File/previews, selection, local image path, and
  options. Identity migration moves all maps. Recovery merges instead of overwriting,
  and async files return to their captured Session.
- **Files / evidence:** composer state in `apps/mobile-web/public/app.js` and
  `scripts/test-composer-draft-state.js`.
- **Status:** **Implemented + automated**.

#### B09. Markdown, LaTeX, and matrices did not render reliably

- **Observed symptom:** `\[...\]`, `$$...$$`, inline math, bare `[ \Delta ... ]`,
  multiline matrices/cases, stars, or Chinese `\text{}` were rendered as plain or
  misparsed Markdown.
- **Cause / finding:** the former ad hoc parser did not protect TeX delimiters before
  emphasis/Setext/list tokenization; some model output omitted backslashes around
  display math; MathJax layout is asynchronous.
- **Implemented solution:** vendored Markdown-It 14.1.0 + DOMPurify 3.2.6 with TeX
  inline/block rules ordered before conflicting Markdown rules. Bare brackets are
  normalized only when clear TeX commands exist, excluding code, normal links, and
  Windows paths. HTML/style/events/forms stay disabled. MathJax preserves viewport.
- **Files / evidence:** `apps/mobile-web/public/markdown-renderer.js`, vendor assets,
  `index.html`, `app.js`, `styles.css`; `scripts/test-markdown-renderer.js` and scroll
  stability tests.
- **Status:** **Implemented + automated parser/DOM coverage**; no final MathJax pixel
  screenshot test. The user manually confirmed the corrected matrix rendering.

#### B10. Markdown color/highlight support

- **Observed request:** allow custom color or highlight in message Markdown.
- **Cause / finding:** arbitrary HTML/style would enlarge the sanitizer and layout
  risk; the user explicitly deferred it to avoid regressions.
- **Implemented solution:** none. Renderer intentionally keeps `html: false` and strips
  style/event attributes.
- **Files / evidence:** `apps/mobile-web/public/markdown-renderer.js` sanitizer policy.
- **Status:** **Superseded/deferred by the user**.

#### B11. Generated/downloaded files did not appear as message cards

- **Observed symptom:** assistant said it created a file but no card appeared; the
  download/status window seemed empty; the user asked whether there was a render limit.
- **Cause / finding:** a bare filename has no safe Host directory identity, and guessing
  cwd can open the wrong file. Earlier paths also did not merge explicit attachments,
  qualified text paths, and Relay-cached files. Unlimited image preview is unsafe.
- **Implemented solution:** merge explicit files/attachments, Windows/POSIX absolute or
  directory-qualified text paths, and cached files in an explicitly mentioned
  directory. Do not guess bare filenames. Bound cards to 48 and inline previews to 12
  per message, with a visible overflow explanation; Open/Save remains for retained
  cards. Status lists recent Relay received-file cache.
- **Files / evidence:** file-reference/card functions in
  `apps/mobile-web/public/app.js`, received-file routes in `apps/relay/server.js`,
  `scripts/test-transcript-file-refs.js`.
- **Status:** **Implemented + automated**, with multi-file real download acceptance
  recommended.

#### B12. `read ECONNRESET` during file preview/download became a red alert

- **Observed symptom:** closing/cancelling a preview or download emitted a visible
  `file-transfer` ERROR.
- **Cause / finding:** browser abort, Host read failure, and Relay/Host socket reset
  were previously conflated; internal preview/chunk probes also surfaced alerts.
- **Implemented solution:** classify `ECONNRESET`, `EPIPE`, aborted, and socket-hang-up
  client aborts; suppress internal preview/chunk alerts; stop when response is destroyed
  or ended; clean partial cache; only non-suppressed real `file.error` becomes a Session
  alert. Large transfers use bounded sequential chunks instead of whole-file base64.
- **Files / evidence:** download stream and `isClientAbortError()` paths in
  `apps/relay/server.js`, Host file commands, and high-priority routing tests.
- **Status:** **Partial**. Main protection exists, but no dedicated end-to-end browser
  mid-download abort test was found; HTTP Range resume is not implemented.

#### B13. Mobile transcript Top/Bottom controls did nothing

- **Observed symptom:** clicks fired but the page did not move on mobile after the
  transcript changed to page flow.
- **Cause / finding:** `html/body` height/overflow left `document.scrollingElement`
  without a scroll range, so `window.scrollTo()` targeted the correct API but max scroll
  was zero. A control rail also needed to remain in the hit-test tree.
- **Implemented solution:** mobile/coarse-pointer CSS makes `html, body` height auto,
  min-height 100%, vertical overflow visible, and keeps the floating controls
  touchable. It preserves a single outer scroll owner.
- **Files / evidence:** `apps/mobile-web/public/styles.css`,
  `scripts/test-mobile-thinking-scroll-stability.js`, release/update reports and prior
  headless mobile check.
- **Status:** **Implemented + automated/manual smoke evidence**.

#### B14. Historical transcript/Thinking detail blocked or remained incomplete

- **Observed symptom:** a history-only Session could take a long time or fail to show
  usable local transcript/Thinking while waiting for unavailable remote full history.
- **Cause / finding:** detail hydration treated every source as one blocking path and
  older parsing did not reconstruct structured diagnostics well.
- **Implemented solution:** Host-owned local JSONL can hydrate transcript and
  diagnostics independently; usable local detail returns without waiting for an
  unavailable remote read. Bounded UTF-8-safe reads, stable identity/dedupe, selected
  history watch, and richer diagnostic extraction support later updates.
- **Files / evidence:** `shared/jsonl.js`, `shared/codex-discovery.js`,
  `apps/host-agent/agent.js`, Relay/detail/UI paths;
  `scripts/test-session-detail-local-history.js`, JSONL, target reconstruction, and
  watch tests.
- **Status:** **Implemented + automated**; real very-large remote history remains a
  performance acceptance case.

#### B15. Assistant messages and notifications duplicated or marked read incorrectly

- **Observed symptom:** multiple channels could emit the same assistant response;
  selection/background/Thinking scroll could incorrectly advance unread state.
- **Cause / finding:** summary text/timestamps/message counts are not stable identity,
  and read eligibility was coupled to render/selection side effects.
- **Implemented solution:** stable assistant IDs and Relay sequence ledger, alias-safe
  paging/SSE projection, v2 per-conversation receipts, strict visible/focused/rendered/
  outer-boundary eligibility, deterministic presentation outbox, and cross-tab drainer
  election. Thinking scroll and programmatic/MathJax movement cannot establish read.
- **Files / evidence:** `shared/assistant-message-identity.js`, assistant cursor/ledger,
  `apps/mobile-web/public/message-notification-client.js`, Relay/UI notification paths;
  `npm run test:notifications`.
- **Status:** **Implemented + automated**. Include these files only if the cumulative
  source package is meant to contain the notification consistency work.

#### B16. Approval popup became long, dark, and disruptive

- **Observed symptom:** approval requests opened an oversized dark surface, exposed
  repetitive raw data, and could force the Session details view into the foreground.
- **Cause / finding:** request summary, command/file/permission detail, and available
  decisions were rendered as one flat body, while fallback buttons were invented even
  when Codex did not advertise them.
- **Implemented solution:** render a compact popup summary with expandable command,
  file, permission, and amendment detail; preserve the current Status/detail view;
  expose only decisions supplied by Codex; lock duplicate responses; and provide a
  matching light theme.
- **Files / evidence:** Approval routing and rendering in
  `apps/mobile-web/public/app.js`; `scripts/test-approval-routing.js`,
  `scripts/test-approval-response-idempotency.js`.
- **Status:** **Implemented + automated**. Real sandbox/network amendment variants
  still depend on the decision set emitted by the active Codex version.

### C. Host, Session, Connector, Launcher, Persistence, and Resources

#### C01. Development and production were separated only by port

- **Observed symptom:** development changes/state could affect the stable page even
  when one Relay used 8897 and another used 8797; 8897 once registered the production
  `<production-pi5-host-id>`.
- **Cause / finding:** Web assets load from the checkout on every request, and writable
  Relay/Session/Connector/auth/SSH/Agent/Codex state is not isolated by TCP port.
- **Implemented solution:** mandatory separate checkouts and state roots. Development
  configuration rejects 8797, physical-path overlap (including links), production
  state/auth inheritance, and automatic local-Agent startup. It derives a development
  Host ID and isolated base `CODEX_HOME`/Agent state. Non-primary port state defaults
  below `tmp/relay-<port>`.
- **Files / evidence:** `AGENTS.md`, `scripts/dev-instance-config.js`, `scripts/dev.js`,
  `scripts/start-windows.ps1`, `apps/relay/relay-state-lock.js`; dev-isolation,
  local-Agent guard, launcher, and state-lock tests.
- **Status:** code is **Implemented + automated**. A pi5 acceptance Host still must use
  `<pi5-dev-host-id>` and a development-only home/state; reuse of the production pi5
  Host ID is not accepted.

#### C02. Port conflict and unknown process ownership

- **Observed symptom:** launcher could say no repo Relay/Agent was found while 8797 was
  occupied, or refuse `Port 8797 is already owned by another or unverified process`.
- **Cause / finding:** command-line/parent-process matching alone cannot distinguish a
  sibling checkout, stale marker, PID reuse, or unrelated Node process. Killing an
  unknown listener risks the wrong application and persistence corruption.
- **Implemented solution:** Relay owner marker plus health/instance/port, physical repo
  root, state root, PID, and absolute `server.js` verification. Sibling takeover is
  authenticated and rechecked before/after action. Unknown ownership remains
  fail-closed.
- **Files / evidence:** `scripts/start-windows.ps1`, Relay health/owner publication;
  `scripts/test-start-windows-script.js`, `scripts/test-relay-lifecycle.js`.
- **Status:** **Implemented + automated**. Refusal for an unverified process is a safety
  guarantee, not an error to suppress.

#### C03. Git `dubious ownership` appeared as a product error

- **Observed symptom:** Windows SID mismatch made Git fail and the updater/UI exposed a
  scary error suggesting a global `safe.directory` change.
- **Cause / finding:** repository owner and process user differ; ordinary Git correctly
  refuses. A global exception is broader than needed.
- **Implemented solution:** updater Git calls use per-command
  `-c safe.directory=<repo> -c core.longpaths=true`; global Git config is untouched.
  Update-check failures remain in the update surface rather than Session alerts.
- **Files / evidence:** `shared/updater.js`, `docs/developer-guide.md`;
  `scripts/test-software-update.js` reproduces the failure and checks global config.
- **Status:** **Implemented + automated**.

#### C04. Session Store failed with a WAL revision gap

- **Observed symptom:** production startup reported
  `StoreRecoveryError: WAL revision gap between 19304 and 19301`.
- **Cause / finding:** retained durable artifacts did not prove a contiguous revision
  history. Current evidence cannot determine whether the historical loss came from a
  force kill, copy, two writers, disk failure, or manual state operation. Continuing
  would risk silent Session metadata rollback.
- **Implemented solution:** fail-closed checksummed current/previous snapshots,
  contiguous WAL, fsync-before-visible mutation, Store/revision/assistant high-water
  sentinel, mutation closure after persistence failure, and one OS-owned state-root
  lock. Valid previous-snapshot + contiguous-WAL recovery is supported; genuine gaps
  remain rejected.
- **Files / evidence:** `apps/relay/session-record-store.js`,
  `apps/relay/relay-state-lock.js`; record-store and state-lock tests.
- **Status:** protection is **Implemented + automated**. The exact old 8797 gap recovery
  and data-loss extent are **not established**. Never "fix" it by deleting Store data
  or copying development `tmp`.

#### C05. Node heap OOM and 14-second live synchronization

- **Observed symptom:** Relay reached roughly 4 GiB and crashed; another incident
  measured about 14 seconds for three active Sessions.
- **Cause / finding:** measured hot path performed repeated merge/dedupe/sort/compact
  over up to 10,000 diagnostics for each new event, while Tailer awaited one HTTP call
  per mapped JSONL event. Keeping too many histories tailed also retained unnecessary
  file/event state. The historical OOM cannot be assigned to one proven leak.
- **Implemented solution:** incremental chronological diagnostic fast path, bounded
  64-event batches with stable idempotency IDs, and bounded SSE rings. Tail only live
  Sessions plus history Sessions currently watched by browser leases; switching away
  drops non-live tail state. Discovery metadata and assistant cursor scans are bounded
  and rotated, not full transcript tailing.
- **Files / evidence:** `shared/codex-tail.js`, `shared/agent-event-batch.js`,
  selected-watch modules, Agent and Relay; `docs/realtime-session-sync-performance.md`,
  realtime/watch tests and `test-session-event-stream-memory.js`.
- **Status:** measured performance and watch scope are **Implemented + automated**;
  complete elimination of a production-scale long-lived OOM remains **unproven** and
  needs a soak.

#### C06. Non-live Session updates and the currently viewed history

- **Observed requirement:** continuously maintain live Sessions, also update the one
  history Session the user is viewing, and stop updating it after selection moves away.
- **Cause / finding:** tailing every rollout wastes memory/IO; tailing only live would
  make a visible history appear frozen.
- **Implemented solution:** browser owns a selected-Session watch lease with client/view
  ID and monotonic revision. Host atomically replaces each view's selection, rejects
  stale watch/unwatch, renews before TTL, cleans on pagehide, and unions current watches
  with live runners by rollout path. A new history watch begins at EOF because detail
  hydration owns old content.
- **Files / evidence:** `apps/host-agent/session-watch-registry.js`,
  `apps/mobile-web/public/session-watch-controller.js`, Agent/Tailer/UI integration;
  watch registry/controller/fast-path/routing tests.
- **Status:** **Implemented + automated**.

#### C07. New Session multi-click produced duplicates or variants

- **Observed symptom:** repeated clicks could create multiple Sessions in the same
  directory; the user asked for "Creating Session, do not click repeatedly".
- **Cause / finding:** UI busy state alone is lost on rerender and cannot protect API
  retries/multiple tabs; earlier launch identity was not stable end-to-end.
- **Implemented solution:** UI keeps explicit launch busy state and displays `Creating
  Session...`. Relay derives deterministic Session/run IDs from a stable request,
  returns the existing launch for the same request, and rejects another canonical
  pending run before Host start. Transcript fallback has a durable source lock.
- **Files / evidence:** Session launch code in `apps/mobile-web/public/app.js`,
  `apps/relay/server.js`, `apps/relay/session-provenance-service.js`; Session API UI,
  Relay, and provenance tests.
- **Status:** **Implemented + automated**.

#### C08. Four variants, unexpected Forks, and branch management

- **Observed symptom:** one pi5 workspace showed several `Cannot Resume` variants even
  though the user did not intentionally fork; user asked what a Fork represents and
  how to view main/branches.
- **Cause / finding:** variants can arise from true Fork, repeated launch, transcript
  fallback (new native thread), bridge/native grouping defects, or discovered subagent/
  internal tasks. The historical four entries cannot be classified without their
  provenance records. Fork is still an explicit native `thread/fork`; it was not
  removed from the runtime.
- **Implemented solution:** deterministic/single-flight launches, canonical alias and
  provenance records, source/fork lineage that cannot steal aliases, explicit labels
  for fallback/fork, and filtering of internal/subagent entries from ordinary lists.
  Fork inherits source binding and remains an explicit button outside the primary
  toolbar.
- **Files / evidence:** provenance service, Relay launch logic, discovery, UI;
  provenance/Relay/internal-approval tests.
- **Status:** duplicate-producing defects are **Implemented + automated**; a full branch
  graph/main-vs-forks manager is **not implemented**. Current product exposes variants
  and explicit Fork but not a Git-like branch explorer.

#### C09. Approval review and subagent rollouts became Sessions

- **Observed symptom:** guardian approval/review tasks appeared as normal Sessions.
- **Cause / finding:** all app-server threads can write rollout metadata. Title-only
  filtering would also hide a legitimate user Session named `Approval review`.
- **Implemented solution:** semantic guardian filter uses
  `source.subagent.other === 'guardian'`. Ordinary `thread_spawn` subagents retain
  read-only lineage in discovery but are hidden from normal Relay list/search; direct
  input is rejected as `subagent_session_read_only`. Their available collaboration
  metadata is projected into the parent Session's Thinking stream instead of becoming
  another writable conversation. Same-title user Sessions remain visible.
- **Files / evidence:** `shared/codex-discovery.js`, Relay list/search/input paths;
  `scripts/test-internal-approval-session-filtering.js`,
  `scripts/test-thinking-entry-model.js`.
- **Status:** **Implemented + automated**. Full subagent branch-browsing UI remains
  unimplemented, and encrypted child payloads cannot be decoded locally.

#### C10. Empty new Session showed Cannot Resume / `no rollout found`

- **Observed symptom:** a newly created Session with no first message was stopped or
  switched, then native Resume failed because no rollout existed.
- **Cause / finding:** before the first native thread materializes, Remote Codex may
  have only a managed bridge shell; there is nothing for `thread/resume` to load.
- **Implemented solution:** track native resume readiness and recognize starting,
  empty-shell, and fresh-live-without-history states. Do not offer ordinary Resume/Fork
  for an empty stopped shell or queue attachment/history input into it. Explicit same-
  Session API Rebind may create `fresh_rebind`; otherwise instruct creating a fresh
  Session in the same workspace or first sending a turn while it remains live.
- **Files / evidence:** UI Session predicates, Relay plan, Runner readiness and
  per-run `CODEX_HOME` lookup; Windows new-session recovery, UI, Relay, and Host-runner
  tests.
- **Status:** **Implemented + automated**. The native limitation itself is not removable.

#### C11. Stop required several attempts or a stopped run revived

- **Observed symptom:** running/stopping/stopped oscillated; Stop appeared ineffective;
  a late event revived the run; Resume was slow and then failed.
- **Cause / finding:** in-memory `live` projection was confused with durable live run,
  events were not consistently run-targeted, processes could be declared terminal
  before real exit/delivery, and restart temporarily hydrated live records as history.
- **Implemented solution:** lifecycle events carry `runId`; Stop/Rebind use expected
  run/status/binding CAS. Stop persists recoverable intent before Host command and only
  exact terminal confirmation closes the run. Durable intent outranks late output.
  Unconfirmed intent rolls back without overwriting newer runtime. Resume/Rebind stop
  the durable parent, stale cleanup suppresses terminal projection, and generic runtime
  waits for real spawn/error/exit.
- **Files / evidence:** provenance service, Relay, Agent,
  `apps/host-agent/managed-session-lifecycle.js`, Runner; provenance, Relay, Host,
  runtime-state, and lifecycle tests.
- **Status:** **Implemented + automated**, with slow real provider/SSH latency outside
  code control and real 8897 Stop/Resume acceptance still needed.

#### C12. Relay stopped listening but did not exit cleanly

- **Observed symptom:** Restart refused because persistence might still be closing;
  Relay listener disappeared while its PID remained.
- **Cause / finding:** shutdown can still be flushing Store/snapshots or joining Agent
  and app-server trees. A short timeout followed by force kill can create the same WAL/
  snapshot corruption that recovery is designed to reject.
- **Implemented solution:** managed-Agent graceful shutdown first; authenticated Relay
  control shutdown; wait up to 120 seconds; recover owned non-child Agents by strict
  marker identity; tree-kill only verified Agent processes when required. If Relay is
  no longer listening but still closing, refuse force takeover and instruct retry after
  the named PID exits. Command acknowledgements remain ordered/exact.
- **Files / evidence:** `scripts/start-windows.ps1`, Relay shutdown, Agent managed
  lifecycle; launcher, Relay lifecycle, local-Agent graceful/late-shutdown tests.
- **Status:** **Implemented + automated**. Seeing the safe refusal can still be correct;
  do not weaken it to force-kill persistence.

#### C13. Relay was online but local Host remained offline

- **Observed symptom:** the local Windows Host was offline after Relay start/restart.
- **Cause / finding:** Relay health and Agent heartbeat are separate. Agent may not
  start, may crash, be dismissed, use stale ownership, or be replaced by another same-
  ID instance.
- **Implemented solution:** Relay-owned local Agents receive instance ID, token, PID/
  start/Relay/repo marker; register/heartbeat/poll/events attest the tuple. Revoked old
  Agents exit and suppress terminal events. Process identity probing compares actual
  start time, executable, command line, and the absolute Agent entrypoint. Ownership
  assessment distinguishes `stale`, `pid_reused`, `live_agent`, and `unknown`.
  Stale/PID-reused cleanup revalidates PID, instance ID, and token immediately before
  deleting the marker; a replaced marker is never removed. Unknown identity remains
  fail-closed. A true old Agent may still register with the matching token and be
  adopted. Relay never kills a PID merely because it appeared in an ownership marker,
  so an unrelated process that reused the PID remains alive.
- **Files / evidence:** `apps/relay/host-agent-lease.js`, Relay, Agent, launcher;
  `scripts/test-local-agent-graceful-shutdown.js`,
  `scripts/test-local-agent-startup-watchdog.js`, lease and launcher tests.
- **Status:** local ownership is **Implemented + automated**. The exact historical
  local-Host offline cause is **unknown without its logs**. Remote pi5 is not managed by
  the local watchdog.

#### C14. Host Codex version probe and one-click update

- **Observed requirement:** show each Host's Codex version; update to latest after
  confirming closure of all Host Sessions; remember phases and resume them afterward.
- **Cause / finding:** finding an executable does not prove version, architecture
  optional package, app-server usability, or safe update ownership. Updating an
  extension/bundled/local/unknown binary is unsafe, and an Agent/Relay restart can lose
  an in-memory operation.
- **Implemented solution:** Host reports version/path/source/platform/arch/npm package/
  auto-update eligibility. Only recognized npm-global installs are automatically
  updated with optional packages. UI and Relay snapshot live managed Sessions, reject
  unmaterialized no-rollout Sessions, close start gate, stop, install, verify, resume,
  and show per-Session stages/results. Host append-only update journal and Relay durable
  maintenance operation support recovery-only continuation. Unsupported installs show
  version with disabled Update and reason. When no Sessions need recovery, Relay now
  finalizes `updated` or `update_failed` to a completed/failed terminal maintenance
  result, so later API switches are not blocked by stale maintenance. When Sessions do
  need recovery, maintenance correctly remains active until that recovery settles.
- **Files / evidence:** `shared/codex-installation.js`, Agent update journal/commands,
  Relay maintenance API, Host manager UI; `scripts/test-codex-installation.js`,
  `scripts/test-host-codex-update.js`, `scripts/test-host-codex-update-relay.js`.
- **Status:** code is **Implemented + automated**; real pi5 stop-update-resume remains
  **8897 acceptance required**. The earlier ARM64 optional-package manual repair is not
  proof of this complete workflow.

#### C15. Connector "local address" was unclear

- **Observed symptom:** Connector requested a local/Relay URL; a remote Host configured
  with `127.0.0.1:8797` dialed its own loopback and stayed offline.
- **Cause / finding:** Connector `relayUrl` is the address the target Agent can reach
  outbound. It is neither the browser's local convenience URL nor the model API URL.
- **Implemented solution:** new draft starts from current page origin. Automated action
  repairs empty/invalid/loopback URL using action origin or a private IPv4 when
  possible; explicit non-loopback remains. Launch command injects `RELAY_URL`.
- **Files / evidence:** `shared/connectors.js`, connector action/origin logic in Relay,
  connector UI and environment-resolution tests.
- **Status:** automated action is **Implemented + automated**. Manual copied commands
  still need a saved address reachable from the Host, so the field cannot yet be
  removed. `/v1` belongs to API profiles, not this Connector field.

#### C16. SSH Agent Forwarding (`ssh -A`) was confusing

- **Observed symptom:** generated pi5 commands included `-A`; the user did not know why
  and chose to disable it.
- **Cause / finding:** `-A` forwards the local SSH agent socket so the remote machine can
  reuse loaded keys for another SSH hop. It is unrelated to the Remote Codex Host Agent
  and normally unnecessary for direct pi5 login.
- **Implemented solution:** generated commands include `-A` only when the saved
  `agentForwarding` option is true; saving false removes it from login/test/bootstrap.
- **Files / evidence:** `shared/connectors.js`, Connector form in `index.html`/`app.js`.
- **Status:** option behavior is **implemented**. The Web new-connector draft still
  defaults it to true while the shared model defaults false; changing UI default to
  false is an **unimplemented least-privilege follow-up**.

#### C17. Connector deployment path nested `.deployments` repeatedly

- **Observed symptom:** repeated Start produced
  `<base>/.deployments/deploy-old/.deployments/deploy-new` and unstable PID/log paths.
- **Cause / finding:** a generated deployment directory was persisted as the connector's
  next base directory.
- **Implemented solution:** normalize any first generated deployment suffix back to the
  configured base; repair loaded legacy recipes; persist the base, not the temporary
  deployment connector; create exactly one deployment leaf per run; use stable
  connector-specific control/PID/log files; detect/migrate legacy PID locations; use a
  one-shot upload/start stream to reduce SSH round trips.
- **Files / evidence:** `normalizeConnectorRemoteDirectory()` in `shared/connectors.js`,
  deployment/bootstrap functions in `apps/relay/server.js`;
  `scripts/test-remote-codex-env-resolution.js`.
- **Status:** nested-path defect is **Implemented + automated**. Old remote deployment
  directories are not automatically deleted.

#### C18. pi5 SSH `Connection reset/closed by ... port 22`

- **Observed symptom:** smoke/bootstrap exited 255 after the server reset or closed the
  SSH connection.
- **Cause / finding:** the nested-path defect was real, but an SSH-layer disconnect can
  happen before the remote path executes. Possible causes include sshd/auth/policy,
  connection limits, campus network, or long upload/command interruption. `-A` is not
  proven to be the cause.
- **Implemented solution:** reduced bootstrap round trips, fixed nested base paths,
  allowed Agent forwarding off, and kept manual SSH/tmux as the supported fallback.
  Password/keyboard-interactive/OTP/captcha remain human steps.
- **Files / evidence:** Connector/Relay bootstrap code and `docs/hpc-connectors.md`.
- **Status:** **Unresolved / operational** until verbose/manual SSH at the failure time
  identifies the server/network reason. Do not claim the connection reset is fixed by
  the path repair alone.

#### C19. Host ID, `CODEX_HOME`, and Cursor/desktop interference

- **Observed symptom:** user feared changes caused the Codex Windows App/Cursor to
  crash; development and production Hosts could read the same history; multiple
  app-servers could contend on shared state.
- **Cause / finding:** shared Host ID/home/state and direct managed use of the main
  `CODEX_HOME` can cause identity overlap and sqlite/config contention. Cursor appears
  in discovery/preflight only as a possible Codex binary source; the product should not
  control the Cursor UI process.
- **Implemented solution:** distinct dev Host/home/state plus one owned per-managed-run
  overlay under `.remote-codex-managed`; copy only required config/identity and link
  the permitted shared entries (`sessions`, `skills`, `rules`, `memories`, and
  `generated_images`) through junctions/symlinks. Those shared entries are not
  read-only. SQLite databases and generated API credentials stay per overlay, and
  cleanup validates ownership token, PID, path, and link targets. Detail/watch searches
  the live Runner's actual isolated home. Windows npm shims are shell-wrapped rather
  than direct-spawned.
- **Files / evidence:** dev config, Runner overlay, Agent lookup, Codex discovery/
  preflight; dev isolation, Host-runner, new-session, and preflight tests.
- **Status:** Host/config/credential isolation is **Implemented + automated**. No
  evidence here proves Remote Codex intentionally terminated Cursor; an exact desktop
  crash requires process/event logs. Goal persistence is **not implemented**:
  `goals_1.sqlite` is neither shared nor migrated, so deleting a managed overlay can
  remove Goal state while shared Session rollout history remains.

#### C20. Windows `codex.cmd`/`.bat` preflight and app-server startup failed

- **Observed symptom:** a valid npm-installed Codex shim failed with
  `spawnSync ... codex.cmd EINVAL`, making the Host appear unavailable.
- **Cause / finding:** Windows command shims cannot be executed as native binaries with
  `shell:false`.
- **Implemented solution:** detect `.cmd/.bat` and invoke them through the Windows shell
  wrapper in both preflight and managed app-server startup while retaining direct spawn
  for real executables.
- **Files / evidence:** `shared/codex-preflight.js`, Runner/runtime helpers;
  preflight/startup/launcher tests and v2.4.8 update report.
- **Status:** **Implemented + automated**.

#### C21. External IDS attribution requires endpoint evidence

- **Observed symptom:** an external IDS classified traffic in the Host/Relay network
  context as command injection or a command-line download attempt.
- **Cause / finding:** the audited Connector runs a quoted remote shell over SSH and
  the Host Agent later uses HTTP to reach Relay, but current Connector/Relay source
  does not generate a `curl` or `wget` command. A network-context match alone cannot
  attribute a security event to this product.
- **Implemented solution:** no incident-specific code change is claimed. Connector
  commands use structured builders/quoting and keep secrets out of persisted command
  lines. Operators must correlate timestamp, endpoint process, destination port/path,
  Relay access logs, firewall data, and SSH history.
- **Files / evidence:** `shared/connectors.js`, Relay bootstrap routes,
  `docs/hpc-connectors.md`.
- **Status:** **Unresolved / operational security review**. Source review cannot
  replace endpoint and network forensics.

#### C22. `Start transcript fallback` was confused with Resume

- **Observed symptom / question:** after a native Resume error, UI offered `Start
  transcript fallback`; the user did not know whether it resumed the same Session or
  why it could create another variant.
- **Cause / finding:** native Resume asks Codex to reopen the exact native thread and
  requires its rollout/runtime identity. Transcript fallback cannot restore that native
  thread. It starts a new native thread and provides retained transcript context, so it
  has different continuity, tool state, and provenance semantics.
- **Implemented solution:** native failure stays structured and never silently falls
  back. Fallback is a separate explicitly confirmed action, requires a usable non-empty
  saved transcript/cwd, creates a labeled derived run, preserves source/origin lineage,
  and records `launchMode: transcript_fallback`. Browser has a persistent per-source
  busy key and Relay has a durable source-Session single-flight lock, including alias
  resolution and restart reconciliation, so repeated clicks/tabs cannot create several
  fallbacks. A fallback failure does not replace the last successful source run.
- **Files / evidence:** `apps/relay/session-provenance-service.js`,
  `apps/relay/server.js`, `apps/mobile-web/public/app.js`; Session provenance, Relay,
  UI, and target reconstruction tests.
- **Status:** **Implemented + automated**, with real provider/native failure acceptance
  still needed on 8897. UI must continue to describe it as a new native thread, not a
  successful Resume of the original runtime.

#### C23. Software-update details listed thousands of local files

- **Observed symptom:** the update panel printed every tracked modification and
  untracked path, hiding the package/version information the user actually needed.
- **Cause / finding:** updater safety diagnostics were rendered directly as the
  user-facing summary.
- **Implemented solution:** the visible details are limited to package path, current
  version, current tag, and latest stable tag. The updater still detects tracked
  changes and leaves untracked files alone when deciding whether an update is safe.
- **Files / evidence:** `formatSoftwareUpdateDetails()` in
  `apps/mobile-web/public/app.js`; updater behavior in `shared/updater.js` and
  `scripts/test-software-update.js`.
- **Status:** **Implemented**. A focused UI regression for the condensed four-line
  presentation is still missing.

#### C24. Managed overlay cleanup failed on Windows `EBUSY`

- **Observed symptom:** stopping or aborting a managed Runner attempted to remove its
  overlay and failed while `goals_1.sqlite` was still locked, producing a terminal-
  looking error or replacing the actual startup failure.
- **Cause / finding:** the managed Codex app-server, a descendant, or a short Windows
  filesystem/security-scanner delay can retain a handle after teardown begins.
  Browser clients do not directly open this per-run database.
- **Implemented solution:** synchronous cleanup uses five `rmSync` retries with a
  100 ms delay; persistent locks enter bounded background retries. Cleanup emits one
  warning diagnostic, does not change stopped/history-only state, and remains
  auxiliary metadata when startup already failed. Every outer retry revalidates the
  overlay ownership token and path before deletion.
- **Files / evidence:** overlay cleanup in
  `apps/host-agent/codex-app-server-runner.js`; transient, persistent, and
  primary-error regressions in `scripts/test-session-api-host-runner.js`.
- **Status:** cleanup lifecycle is **Implemented + automated**. This does not persist
  Goal state: successful deletion still removes the overlay-local `goals_1.sqlite`.

### D. Consolidated Status Matrix

| Area | Implementation evidence | 8897 manual acceptance | Remaining / do not overclaim |
| --- | --- | --- | --- |
| Provider dropdown and legacy profile migration | Automated | Basic editor smoke | Anthropic/Gemini model tables are only extension points |
| Dynamic model/reasoning catalog | Automated | Actual local + dev pi5 APIs | Non-Custom provider count may remain below `/models` count by policy |
| Custom model/effort validation | Automated | Real Custom provider send/Rebind | No separate standalone effort-probe button |
| Base URL and `/v1` correction | Automated | Actual Custom OpenAI-compatible endpoint | Never claim every API should auto-append `/v1` |
| Host/global/Fresh/Resume default precedence | Automated | Create + resume from two Hosts | Legacy stored schema fields remain for compatibility |
| Rebind/fresh-rebind/API switch Auto selection | Automated | Empty first-turn Rebind and real provider switch | Native empty shell cannot ordinary Resume |
| Legacy null/unknown binding Rebind | Automated, including restart persistence | Real provider profile and Host-environment Rebind | Fixture/browser state only; no real provider Rebind executed |
| Current Session controls and batch Apply | Automated, including layout | Real multi-Host selection/restart/results | Requires development-only remote Host |
| Thinking aggregation/tool/file/subagent structure | Automated | Long real live turn | Encrypted child payloads remain unavailable locally |
| Thinking/outer viewport stability | Automated | Desktop + phone while detached | Real-device long-session pass still recommended |
| Alert filtering | Main path implemented | Recovered retry/startup cases | Event Timeline stays broad; focused filter test missing |
| Error/Running/Stopping ordering | Automated | Stop/reconnect/error race | External provider/network timing remains variable |
| Input identity/outbox/draft/SSE recovery | Extensive automated coverage | Seven-step checklist above | Production test authorized; acceptance result pending |
| Markdown/LaTeX/matrices | Parser/DOM automated; user confirmed matrix | Several real messages/viewport | No final-pixel MathJax screenshot test |
| File cards and bounded preview | Automated reference extraction | Qualified paths, cached, many files | Bare filenames intentionally do not become cards |
| Download client-abort `ECONNRESET` | Main protection implemented | Small/large/cancel/offline/restart | Dedicated browser-abort integration and Range resume missing |
| 8797/8897 source and state isolation | Automated | Confirm 8897 health/owner paths | dev pi5 still must use unique ID/home/state |
| Port/process/Git ownership safety | Automated | Normal restart and sibling detection | Unknown process remains fail-closed by design |
| Session Store/WAL safety | Automated | Clean isolated restart | Genuine historical gap remains fail-closed; exact incident cause unknown |
| Tail/watch/realtime performance | Automated benchmarks | Long soak with representative histories | Complete production OOM elimination not proven |
| New-Session idempotency and internal-task filtering | Automated | Rapid multi-click and real approval turn | Full fork/subagent branch explorer not built |
| Stop/Resume/Relay graceful shutdown | Automated | Real active Stop, restart, retry after closing | Never force-kill persistence-closing Relay |
| Local Agent ownership/watchdog | Automated, including PID reuse | Restart local dev Agent | Unknown identity is fail-closed; remote pi5 is unmanaged |
| Host Codex probe/update/resume | Automated contracts | Real dev pi5 full operation | Production acceptance pending; unsupported installs stay disabled |
| Connector reachable Relay URL | Implemented | Start dev pi5 from reachable dev URL | Manual command still needs explicit reachable URL |
| Nested deployment directory | Automated | Repeat bootstrap twice | Old remote deployment artifacts are not auto-deleted |
| SSH Agent Forwarding | Toggle works | Login with it disabled | New-connector UI default should be changed to false later |
| pi5 SSH reset/closed | Mitigations only | Verbose/manual SSH and bootstrap | Root cause unresolved |
| External IDS attribution | No code conclusion | Correlate endpoint/network logs | Source similarity alone cannot establish cause |
| Approval popup and response locking | Automated | Real amendment variants | Only Codex-advertised decisions are shown |
| Software-update summary | Behavior covered | Update UI smoke | Focused four-line UI regression missing |
| Managed overlay `EBUSY` cleanup | Automated | Real Windows teardown | Cleanup is nonterminal; lock holder may remain unknown |
| Goal persistence across managed runs | Not implemented | Future 8897 task | Overlay cleanup can remove `goals_1.sqlite` Goal state |
| Assistant notification identity | Automated aggregate suite | Browser/OS notification smoke | Background Web Push is not implemented |

### E. Expanded Source Packaging Map

The five files listed earlier are only the latest input/runtime synchronization core.
A cumulative package for every implemented issue in this ledger must be built by
reviewing the following source groups against the intended production baseline. This
is a review map, not permission to copy all listed files blindly.

#### E01. Browser UI and rendering

- `apps/mobile-web/public/app.js`
- `apps/mobile-web/public/index.html`
- `apps/mobile-web/public/styles.css`
- `apps/mobile-web/public/provider-capabilities.js`
- `apps/mobile-web/public/markdown-renderer.js`
- `apps/mobile-web/public/thinking-entry-model.js`
- `apps/mobile-web/public/transcript-scroll.js`
- `apps/mobile-web/public/transcript-state.js`
- `apps/mobile-web/public/session-watch-controller.js`
- `apps/mobile-web/public/message-notification-client.js`
- `apps/mobile-web/public/api-profile-backup.js` only when API-profile recovery is in
  release scope
- `apps/mobile-web/public/vendor/markdown-it-14.1.0.min.js`
- `apps/mobile-web/public/vendor/dompurify-3.2.6.min.js`

#### E02. Relay services and durable state

- `apps/relay/server.js`
- `apps/relay/input-command-outbox.js`
- `apps/relay/session-provenance-service.js`
- `apps/relay/session-record-store.js`
- `apps/relay/model-catalog-service.js`
- `apps/relay/rebind-catalog-reuse.js`
- `apps/relay/relay-state-lock.js`
- `apps/relay/host-agent-lease.js`
- `apps/relay/session-event-stream.js`
- `apps/relay/sse-writer.js`
- `apps/relay/agent-event-ledger.js`
- `apps/relay/assistant-notification-ledger.js` only when notification consistency is in
  release scope
- `apps/relay/atomic-file-replace.js`

#### E03. Host Agent and runtime

- `apps/host-agent/agent.js`
- `apps/host-agent/codex-app-server-runner.js`
- `apps/host-agent/session-api-runtime.js`
- `apps/host-agent/managed-session-lifecycle.js`
- `apps/host-agent/session-watch-registry.js`
- `apps/host-agent/runtime-utils.js`
- `apps/host-agent/runtime-adapters.js`

#### E04. Shared contracts and discovery

- `shared/api-binding.js`
- `shared/thinking-activity.js`
- `shared/assistant-message-identity.js`
- `shared/codex-assistant-cursor.js`
- `shared/codex-tail.js`
- `shared/codex-discovery.js`
- `shared/codex-preflight.js`
- `shared/codex-installation.js`
- `shared/coalesced-async-task.js`
- `shared/agent-event-batch.js`
- `shared/connectors.js`
- `shared/jsonl.js`
- `shared/physical-path.js`
- `shared/updater.js`

#### E05. Startup, development isolation, and package metadata

- `scripts/start-windows.ps1`
- `scripts/dev.js`
- `scripts/dev-instance-config.js`
- `package.json`
- `package-lock.json` only if dependency resolution is deliberately part of the source
  promotion
- `config/remote-codex.defaults.json` only after verifying it contains no machine-local
  values and its changes are required

#### E06. Focused tests that are easy to omit because they are untracked

At minimum, map each promoted subsystem to its corresponding `scripts/test-*.js` files.
Particularly important cumulative tests include:

- Session API/model: `test-session-provenance.js`, `test-session-record-store.js`,
  `test-model-catalog-service.js`, `test-rebind-catalog-reuse.js`,
  `test-provider-capabilities.js`, `test-composer-model-inference.js`,
  `test-session-api-host-runner.js`, `test-session-api-relay.js`,
  `test-session-api-ui.js`, `test-target-session-reconstruction.js`.
- Input/runtime: `test-input-command-outbox.js`, `test-composer-draft-state.js`,
  `test-host-agent-command-lifecycle.js`, `test-runner-turn-runtime-state.js`,
  `test-mobile-realtime-resume.js`, `test-session-event-stream.js`.
- Thinking/rendering: `test-thinking-activity-aggregator.js`,
  `test-thinking-entry-model.js`, `test-thinking-entry-rendering.js`,
  `test-runner-thinking-snapshots.js`, `test-relay-thinking-activity.js`,
  `test-transcript-state.js`, `test-transcript-scroll-state.js`,
  `test-markdown-renderer.js`, `test-transcript-file-refs.js`,
  `test-mobile-thinking-scroll-stability.js`,
  `test-transcript-render-performance-budget.js`.
- Host/watch/lifecycle: `test-internal-approval-session-filtering.js`,
  `test-windows-new-session-queue-recovery.js`, `test-session-watch-registry.js`,
  `test-session-watch-controller.js`, `test-session-watch-fast-path.js`,
  `test-session-watch-routing.js`, `test-session-watch-batching.js`,
  `test-local-agent-graceful-shutdown.js`, `test-host-agent-instance-lease.js`,
  `test-relay-lifecycle.js`.
- Platform/connectors/update: `test-dev-instance-isolation.js`,
  `test-dev-relay-local-agent-guard.js`, `test-start-windows-script.js`,
  `test-relay-state-lock.js`, `test-codex-preflight.js`,
  `test-remote-codex-env-resolution.js`, `test-codex-installation.js`,
  `test-host-codex-update.js`, `test-host-codex-update-relay.js`,
  `test-software-update.js`, `test-agent-event-batch-transport.js`,
  `test-realtime-session-sync-performance.js`, `test-session-event-stream-memory.js`.

### F. Explicitly Unclosed or Superseded Items

Do not let a later packaging summary turn these into completed claims:

1. Anthropic and Gemini have policy/extension points, not maintained concrete model
   reasoning tables.
2. Provider capability documentation is not fetched live; OpenAI uses a versioned
   advisory snapshot overridden by runtime evidence.
3. Provider 19-model membership does not guarantee 19 selectable non-Custom models.
4. Real remote model listing, `/v1` behavior, batch Apply, first-turn Rebind, Stop/
   Resume, Codex update, and file download still need controlled production acceptance.
5. Full branch/main/subagent visualization is not built. Explicit Fork remains.
6. Alert Event Timeline remains intentionally broader than the compact alert box.
7. File download abort lacks a dedicated end-to-end regression; HTTP Range resume is
   future work.
8. A long representative heap soak has not proved the old 4 GiB OOM impossible.
9. Real SSH reset/closed and any external IDS attribution require endpoint/network logs.
10. New Connector UI still defaults SSH Agent Forwarding on; least-privilege default-off
    is a future change.
11. Markdown custom color/highlight was explicitly deferred.
12. Saving model/effort as an API-wide New-Session default was superseded by per-Host
    API mapping plus explicit current-Session/batch controls.
13. A genuine WAL revision gap remains fail-closed; no automatic destructive repair is
    promised.
14. Goal persistence across Stop/Resume/Rebind is not implemented. `goals_1.sqlite`
    remains overlay-local and may be removed during successful cleanup.
15. Legacy null/unknown binding repair has automated and browser-state evidence, but
    no real provider Rebind has been executed. The acceptance fixture intentionally
    remains legacy, stopped, unknown-binding, and without a pending operation; do not
    treat its visible `Rebind & Resume` choices as proof that provider launch and the
    exactly-once first input completed successfully.
16. Encrypted collaboration payloads cannot be decrypted by Relay/browser; only
    available plaintext metadata and explicit unavailable placeholders are rendered.
17. The condensed software-update details do not yet have a focused UI regression.
18. `v2.4.9-dev` does not publish native runtime assets in this workflow, so runtime
    download defaults remain pinned to the existing `v2.4.8` asset release.

### G. Secret and Machine-State Audit Rules

Before handing the package to another Agent or Git:

- Search all candidate text and diffs for API keys, bearer tokens, Relay auth tokens,
  passwords, OTP notes, connector secrets, cookies, account contents, and private SSH
  material.
- Treat IPs, usernames, local absolute homes, saved connector recipes, Host IDs used in
  production, and deployment commands as machine-local configuration unless a redacted
  fixture is intentionally required by a test.
- Do not stage `tmp/`, `output/`, generated backups, owner markers, locks, PIDs, logs,
  downloaded runtimes, received-file cache, Session Store/WAL/snapshots/sentinels,
  browser API-profile storage, `CODEX_HOME`, or `node_modules`.
- Inspect untracked files explicitly. A plain Git diff omits them.
- Use command-scoped `git -c safe.directory=...`; do not change global Git config.
- Compare and promote reviewed source hunks/files only. The current development
  worktree contains unrelated cumulative product work, so even the packaging map above
  is not a blanket copy list.
