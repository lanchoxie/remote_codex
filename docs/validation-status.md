# Validation Status

This document tracks what we have actually verified versus what is still design intent.

## Verified locally

| Area | Evidence | Notes |
| --- | --- | --- |
| Relay health and basic APIs | `GET /health` on stable `8797`; current-source `GET /health` and `/app.js` on isolated `8897` | Session API development leaves `8797` untouched. The `8897` process uses an explicit dedicated `RELAY_STATE_ROOT`, isolated temporary cwd, Store, and every other Relay-owned state path; auth and the local-agent watchdog are disabled there |
| Session API binding and targeted settings | `npm run test:session-api-model`, `npm run test:managed`, `npm run test:realtime-sync`, `node scripts/test-composer-model-inference.js`, `node scripts/test-session-detail-local-history.js`, and `node scripts/test-mobile-realtime-resume.js` pass on 2026-07-17 | Covers immutable run binding, lifecycle CAS, recoverable Stop intent, late-event control blocking, durable-parent replacement Stop, Rebind and alias-safe transcript-fallback single-flight, restart/discovery convergence, run-scoped Host events, pending-catalog ownership, canonical failed-run fallback, UI response guards, and dynamic model/reasoning controls. The latest isolated realtime run completed in 25 ms for 120 diagnostics over 4000 entries. Production `8797` was not restarted |
| Relay state ownership and Session Store recovery | `node scripts/test-relay-state-lock.js` and `node scripts/test-session-record-store.js` pass on 2026-07-17 | A named OS-owned IPC lock rejects a second Relay process targeting the same resolved `RELAY_STATE_ROOT` and is released after owner exit/crash. Store coverage includes the non-primary-port state-root guard, identity/high-water sentinel, missing-artifact and rollback rejection, dual-snapshot/contiguous-WAL recovery, mutation fail-closed behavior, and in-place secret scrubbing |
| Isolated historical provenance reconstruction | `node scripts/test-target-session-reconstruction.js` and the explicit `scripts/repair-session-provenance.js` CLI pass on 2026-07-17 | The `人类可能进程探索` rollout remained byte-identical at SHA-256 `E89DA3FD44957CFA79BDAA61C44E95CB7F71F18761115C6564ECD3A10E94423A`; 17 raw rows map to transcript entries and 12 remain after correct UTF-8-safe UI deduplication. The other 5 are duplicate emissions: 3 repeated user rows and 2 repeated agent rows; `task_complete` metadata is excluded. The isolated Store records the verified Asxs binding and `gpt-5.6-sol` / `ultra` selection under `tmp/session-api-target-verification`. This does not claim a production resume and did not contact `8797` |
| Host registration and heartbeat | Local `host-agent` appears as `latest-preview-8797` | Host advertises discovery, managed sessions, directory browse, structured status, requests, interrupt |
| Passive Codex discovery | Local `~/.codex/sessions` imported and grouped by `cwd` | Verified on Windows user Codex history |
| Managed session smoke test | `npm run test:managed` passes | Uses demo runner and validates relay -> agent -> live session -> SSE output |
| SSE session stream | Test subscribes to `/api/sessions/:id/events` and receives output | Demo runner path verified |
| Assistant message notification consistency | `npm run test:notifications` passes on 2026-07-17 | Covers stable live/rollout identity, UTF-8 cursor/partial-row/replacement handling, pending discovery acknowledgement, durable Relay sequence and alias merge, paged catch-up, SSE replay/reset, v2 receipt migration, strict read eligibility, deterministic durable outbox, cross-tab election, and adjacent realtime batching |
| Transcript and Thinking stability | `npm run test:transcript` passes on 2026-07-17 | Covers exact delta whitespace, 75 ms runner coalescing and terminal flush, canonical activity snapshots/revisions, keyed browser patching, independent outer/Thinking scroll ownership and anchor restoration, local Markdown-It plus DOMPurify rendering, ordered-list block structure, and render performance budgets |
| Real Codex app-server bridge | Local preview has run with `demoMode: false` and returned real model text | Needs automated test coverage because it depends on Codex backend/network |
| Raspberry Pi 5 managed app-server | A fresh real session on Host `raspberrypi` reached `connection: ready`, `phase: idle`, and `startupStep: ready`, then stopped to `history-only`/closed on 2026-07-14 | Root cause was the missing `@openai/codex-linux-arm64` optional package; the exact 0.144.3 platform package was SHA-256 verified and installed without restarting Relay or Host-agent. Automatic architecture/package preflight remains P1-013 |
| Directory browser | UI can request host directory listings through relay/agent | Local Windows host path verified |
| Runtime status UI | Runtime panel and status modal render connection, phase, turn, token/rate-limit/request data | Depends on events emitted by Codex app-server |
| Interrupt/steer/compact/shell command controls | UI and relay command routes are wired | Individual Codex backend behaviors still need dedicated tests |
| Connector persistence API | `/api/connectors` returns saved profiles from relay storage | Stored under `tmp/connectors.json` |
| HPC connector command generation | `shared/connectors.js` generates `tmux` bootstrap commands | Command format verified locally, not yet run on HPC |
| HPC connector actions | Relay can run SSH smoke/status/bootstrap actions; `scripts/test-remote-codex-env-resolution.js` passes | Non-bootstrap responses no longer reference bootstrap-only deployment state; an isolated failed smoke action returned HTTP 200 with `ssh_failed` and its own multiplex fallback. Production `8797` needs a later normal restart to load that code. OTP/SSO/captcha remain manual |
| Multi-scope skill discovery | `scripts/test-skill-inventory-discovery.js` passes | Covers user, system, project, shared, CC Switch, explicit plugin roots, configured-root junctions, source locks, bounded GitHub remote/HEAD inference, hashing limits, and revision stability |
| Host skill inventory service | `scripts/test-host-skill-inventory-service.js` passes | Covers revision dedupe, workspace-root updates, concurrent refresh sharing, and explicit unchanged publication |
| Cached Skills API | `scripts/test-skills-inventory-api.js` passes | Five reads with three unresponsive registered Hosts had a 5 ms maximum in the final full-suite run; refresh returned 202, queued per-Host roots, emitted SSE, rejected invalid instance hashes without replacing the prior cache, and survived relay restart |
| Complete Skill artifact format | `scripts/test-skill-artifact.js` passes | Covers deterministic complete-directory archives, binary assets, portable executable metadata, inventory-hash equality, bounded traversal, escaping links, tampering, truncation, unsafe manifest paths, safe extraction, existing-target rejection, expected-hash verification, and failure cleanup |
| Persistent Skill registry | `scripts/test-skill-registry-service.js` passes | Covers fsynced atomic metadata/archive publication, semantic fail-closed loading, canonical keys/links, content deduplication, retire/restore, shared Artifacts, revision conflicts, `gc-pending`, restart-safe manual retry, unlink failure, collection, and same-hash rehydration |
| Host Skill Adopt | `scripts/test-host-skill-adopt.js` and `scripts/test-skills-adopt-api.js` pass; isolated preview on `57890` adopted the real project `grill-me` instance | Covers exact inventory/hash binding, readonly owner rejection, complete export, one-time upload binding, concurrency limits, raw streaming upload, SSE, failure state, deduplication, Relay restart recovery, and the actual Host-agent upload path. The real Artifact ID matched inventory hash `sha256:1656fc930a6d18d1ca912396bad7050b609c18a34e3862be638ec3963cb1636e` |
| GitHub Skill import | `scripts/test-github-skill-import.js` passes | Uses isolated HTTP fixtures for locator/ref/subpath normalization, recursive binary content, Git Blob fallback, path/submodule/link rejection, API truncation detection, redirect/HTTP failures, byte/file/depth limits, background API state, and concurrency limits |
| Host managed Skill deployment | `scripts/test-host-skill-deployment.js` passes | Covers bounded authenticated streaming download, cache/hash verification and GC, user/project paths and consent, canonical IDs, ancestor/cache junction rejection, semantic fail-closed state, durable result outbox, atomic replacement/verified rollback, missing Disable, idempotency, and unmanaged/link/readonly/drift rejection |
| Durable Skill desired/applied state | `scripts/test-skill-deployment-service.js` and `scripts/test-skills-deployment-api.js` pass | Covers fsynced semantic fail-closed snapshots, request fingerprints/409, exact retry before mutable retire/remove/GC/workspace checks, journaled applied state bound to its successful deployment/tombstone source, repeated journal-truncate failure with replay-safe tombstone retention, persisted monotonic generations, equal-timestamp late results, exposed legacy Unknown/exact/Skill-wide uncertainty, pruned legacy cleanup-failure recovery without contaminating newer success, superseded-running retention, restart-safe cleanup-failure ordering, applied-source tombstone retention, independent Host results, offline reconciliation, authenticated raw download, incremental SSE, and coalesced inventory refresh |
| Skill Library lifecycle and source refresh | `scripts/test-skills-lifecycle-api.js` and `scripts/test-github-skill-import.js` pass | Covers retire/restore, active/retired/applied-uncertain cleanup authorization, desired/applied/nonterminal/managed/adopted inventory blockers, case-canonical adopted IDs, renamed local Skill IDs with exact source/hash, malformed/stale/incomplete/corrupt inventory handling, two-stage GC and restart, manual GitHub refresh dedupe/new versions/failure preservation/in-flight reuse/concurrency limits, and no automatic Host deployment |
| Skill source automation and audit | `npm run test:skills-phase5` passes on 2026-07-17 | Covers manual/hourly/daily/weekly refresh policy, manual/enabled-hosts rollout policy, Registry revision CAS, scheduled refresh, changed-Artifact rollout only to existing Enabled Host/scope rows, deterministic requests, secret-redacted append-only hash-chain audit, audit paging, lifecycle/deployment/Host-result integration, row-local UI drafts/error recovery, and the bounded Recent Audit view |
| Skills desired-state UI | `scripts/test-skills-manager-ui.js` and `scripts/test-slash-skills-cache.js` pass | Covers exact Artifact/scope matching, exact/Skill-wide/Unknown uncertainty cleanup rows, old/retired cleanup Host intersection, failed Remove retry, multi-version `gc-pending` precedence with independent Restore eligibility, hidden-selection invalidation, explicit enable/disable/remove/all-Hosts actions, independently confirmed all-Host project scope, stale-Host rejection, durable desired rows, partial-GC/SSE ordering, incremental/coalesced deployment SSE, auth reconnect, affected-Host-only composer cache invalidation, same-hash logical row merge, source aggregation, and representative-instance selection |
| Phase 3 isolated preview | Relay/Host at `http://127.0.0.1:57890` with state under `tmp/skills-phase2-preview` | The real `grill-me` Artifact re-adopted identical content into the new canonical ownership state without rewriting activation, Disable retained cache, Remove cleared activation/ownership/cache, an offline enable stayed `pending` with zero attempts, and Host registration reconciled it to `succeeded` on attempt one with persisted `startedAt`. Production `8797` was not touched |
| Phase 4A isolated preview | Relay/Host at `http://127.0.0.1:57890` on 2026-07-14 | Loaded the pre-generation deployment state with 8 deployments, one desired/applied reference, and an online Host. `grill-me` Retire/Restore advanced Registry revision 2 -> 3 -> 4 and preserved desired/applied/Host-inventory blockers. GC collected nothing while referenced. Manual GitHub Refresh completed at revision 6, created a second immutable Artifact/version, and left deployments at exactly 8, proving no Host rollout. Five cached reads measured 46/4/2/2/3 ms (4 ms warmed maximum). Production `8797` was not restarted |
| Skills compatibility regression | `scripts/test-host-agent-skills-manager.js`, `scripts/test-skills-manager-api.js`, `scripts/test-skills-manager-ui.js`, and `npm run test:managed` pass | Legacy list/actions remain wired for old Hosts; Phase 3 Hosts reject legacy install/uninstall bypass with HTTP 409 |
| Full JavaScript regression | 79/79 `node --check` and 51/51 `scripts/test-*.js` passed on 2026-07-14 | Includes managed Relay/Host/SSE, 23 ms realtime sync in the full run (19 ms dedicated rerun), Skills Phases 1-4A, executable UI merge/state tests, Windows startup, and session lifecycle tests |

## Session API requirement audit

| Requirement | Executable evidence |
| --- | --- |
| Browser Host default affects fresh Sessions only | `scripts/test-session-api-ui.js` verifies Fresh uses the Host default, Resume uses canonical runtime configuration, settings changes do not drive stop/restart, and live input/compact omit `apiConfig` |
| Every run has immutable API identity | `scripts/test-session-provenance.js` covers fresh, resume, fork, mismatch, explicit Rebind, failed candidates, lifecycle CAS, Stop intent/cancellation, derived fallback locking, delayed events, and parent-run restoration |
| Profile, Host environment, and unknown bindings stay distinct | `scripts/test-session-api-host-runner.js`, `scripts/test-session-api-relay.js`, and `scripts/test-session-api-ui.js` cover profile matching, Host attestation, exact run-ID routing, replayed confirmation, rejected-runner cleanup, missing/deleted profiles, canonical null, compatibility Hosts, and fail-closed unknown state |
| Model availability and reasoning capability are dynamic and binding-scoped | `scripts/test-model-catalog-service.js` covers live/provider/override/last-known-good evidence, complete versus truncated authority, `session_model_unavailable`, unknown capability, and advertised `max`/`ultra` values |
| Native resume failure never silently substitutes transcript replay | `scripts/test-session-api-relay.js` verifies structured native failure, separately confirmed `transcript_fallback` lineage, source-run CAS, and durable cross-client fallback single-flight |
| Durable recovery does not expose secrets or overwrite stronger state | `scripts/test-session-record-store.js`, `scripts/test-session-provenance.js`, `scripts/test-session-api-relay.js`, and `scripts/test-target-session-reconstruction.js` cover recursive/current/historical secret stripping, diagnostic load/write sanitization, WAL short-write fail-closed behavior, checksummed snapshot recovery, sentinel identity/high-water rollback detection, active/verified conflict rejection, alias collision rejection, and source-rollout immutability |
| Pending and delayed responses retain run ownership | `scripts/test-session-api-relay.js` and `scripts/test-session-api-ui.js` cover pending Rebind catalog identity, Stop/Rebind/discovery CAS, recoverable Stop intent, missing-run-ID rejection, parent terminal handling, canonical failed-candidate fallback, stale start suppression, runtime-config run guards, model response Host/Session/run/binding guards, and slow full-refresh reconciliation after newer SSE run state |
| Bounded JSONL reads preserve UTF-8 and transcript identity | `scripts/test-jsonl-utf8-chunks.js` covers multibyte boundaries for finite head and tail reads; the target reconstruction verifies 17 raw rows become 12 unique transcript entries after excluding `task_complete` metadata |

## Partially verified

| Area | Verified part | Missing part |
| --- | --- | --- |
| Resume from history | Store-backed managed resume/fork/rebind and failure classification have automated Relay/UI coverage | Real provider/native-thread continuity still needs an explicitly authorized production run; imported history with unknown binding requires Rebind, and transcript fallback creates a labeled new native thread |
| Request/approval UI | Relay and UI can display and respond to structured request objects | Needs more real Codex request fixtures and edge-case coverage |
| Thinking trace UI | UI can render structured reasoning/plan diagnostics in the chat flow | Codex does not emit structured thinking every turn |
| Real app-server runner | Can start/resume threads and stream model output locally | Needs stable automated integration harness and failure-mode tests |
| HPC onboarding | Connector model, generated manual command, and non-interactive SSH actions exist | Needs real login node validation, gateway cases, remote install/sync, and agent packaging |
| Android readiness | PWA-style mobile UI, manifest, and foreground browser notifications exist | Native Android wrapper, background Web Push, and background reconnect are not implemented |
| Skills inventory/deployment matrix | Static UI contracts, JavaScript syntax, Relay API, and isolated Agent flows pass | The in-app browser runtime returned an empty browser list, so desktop/mobile screenshots, live control interaction, and overflow inspection remain to be captured |
| Real local skill inventory | Read-only scan found 48 instances across all six scopes and resolved the current project's `grill-me` GitHub source | Presentation proof reduces 28 byte-identical Superpowers user/shared instances to 14 logical rows and merges five Local/CC Switch same-hash groups without deleting provenance. Two `ppt-master` copies exceed the 10,000-file hash budget and remain P1-012 scan errors |

## Not done yet

- User authentication and device approval.
- Multi-user authorization and host ownership.
- A fully durable relay control plane. Canonical Session records, aliases, run
  bindings, selections, catalog cache, and notification state are durable, but
  Host presence, command delivery, live projections, transcript caches, and
  distributed failover remain memory-backed or separate stores.
- Real SSH runner with keyboard-interactive prompts.
- Real gateway launcher service.
- `tmux` runtime that can attach to an existing pane and keep a Codex CLI PTY alive.
- HPC scheduler integration for compute-node jobs.
- Native Android app.
- Background Web Push and native Android notifications.
- File browser/editor from phone.
- Cross-subsystem operator audit and approval history; Skills now has a
  dedicated hash-chained audit log.
- Production TLS/deployment story.
- Skill source credentials beyond the existing GitHub token integration, plus
  audit-log retention/rotation policy.

## Current safest product path

1. Keep using outbound host agents for active control.
2. Use SSH/gateway only to bootstrap the agent.
3. Keep HPC live sessions in `tmux`.
4. Add an explicit onboarding status flow: saved connector -> manual SSH -> tmux bootstrap -> host online -> start Codex.
5. Add SSH runner later only if the manual bootstrap flow is too painful.
