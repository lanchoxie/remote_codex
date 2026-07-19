# Realtime Session Sync Performance Fix

Date: 2026-07-11

## Incident

The host agent reported:

```text
Realtime session sync is slowing down (14025ms for 3 active sessions)
```

The warning measured the complete `CodexSessionTailer.poll()` path, including
reading new JSONL rows, mapping rows to session events, sending the events to
the relay, and waiting for relay responses.

Before changing the implementation, the full working tree was copied to:

```text
sol_ultra/snapshot-20260711-191405
```

The snapshot includes `.git` and `tmp` and is the pre-fix baseline.

## Investigation

The investigation separated local JSONL work from transport and relay ingest.

### JSONL parsing was not the bottleneck

A recent rollout sample contained 759 rows and produced 557 events. Reading
the file, parsing JSON, and mapping the rows took approximately 14 ms.

### Relay diagnostic append was quadratic at this scale

Every `session.diagnostic` event called `appendSessionDiagnostic()`. The old
path appended one item and then ran two full merge, dedupe, sort, and compact
passes over as many as 10,000 retained diagnostics.

An isolated profile replaying 294 diagnostics over 9,536 stored diagnostics
took 14,409 ms. This closely reproduced the 14,025 ms production warning and
identified the dominant cause.

### Transport amplified the delay

The tailer also awaited one HTTP request for every generated event. An empty
relay event request had a median round-trip time of about 11.7 ms. Sending 557
events sequentially therefore projected to roughly 6.5 seconds even when the
relay did almost no work.

## Implementation

### Incremental diagnostic compaction

`apps/relay/server.js` now uses an incremental fast path when a diagnostic is
chronologically newer than the current last entry.

- A `WeakMap` associates each diagnostics array with a key-count index.
- Exact duplicates are checked in constant time after the index is built.
- The existing two-second near-duplicate rule is checked against the last
  retained entry.
- Retention removes entries and their key counts from the head when the array
  exceeds 10,000 items.
- Out-of-order timestamps still use the original full compaction path. This
  preserves ordering and dedupe behavior for the exceptional case.
- Empty messages are normalized and rejected consistently before storage and
  SSE broadcast.

This changes normal in-order ingest from repeatedly processing the entire
history to processing only the incoming item.

### Bounded event batching

`shared/codex-tail.js` now queues mapped events and posts ordered batches of at
most 64 events through the relay's existing `{ events: [...] }` envelope.

The queue preserves ordering across files and sessions. A read offset is
advanced only after all complete lines in that file delta have been parsed and
queued. Confirmed batches are removed from the queue; failed batches remain in
memory and are retried before new file content is read.

### Idempotent retry

Each queued batch receives a stable batch ID. The same ID is reused if the
request fails or its response is lost.

`apps/relay/server.js` keeps a bounded in-memory set of recently applied batch
IDs. A repeated ID is acknowledged without applying its events again. This
prevents an older runtime patch from being replayed over newer runtime state
after an ambiguous network response.

The host agent also supports rolling upgrades, but fallback is deliberately
narrow. HTTP `404`, `405`, or `415`, and `400`/`422` responses carrying the
explicit `agent_event_batch_envelope_unsupported` code, resend events in order
through the legacy single-event envelope. Generic validation/application
errors and ambiguous success counts remain batch failures: the Relay may have
applied a prefix, so replaying the whole batch as singles would duplicate
side-effects. Batch application remains ordered at-least-once rather than a
cross-event transaction.

## Performance Results

Final verification runs produced the following results:

| Workload | Before | After |
| --- | ---: | ---: |
| 120 incoming diagnostics over 4,000 stored | 1,682 ms | 13-18 ms |
| 294 incoming diagnostics over 9,536 stored | 14,409 ms | 26-37 ms |
| 120 incoming diagnostics over 9,950 stored | not separately measured | 25-30 ms |
| 558 events across 3 sessions with 15 ms simulated request latency | projected seconds when sequential | 183-195 ms in 9 batches |

The retention-boundary test also verifies that the 10,000-entry limit remains
intact.

## Regression Coverage

The focused suite is available as:

```powershell
npm run test:realtime-sync
```

It runs:

- `scripts/test-agent-event-batch-transport.js`
- `scripts/test-session-watch-batching.js`
- `scripts/test-realtime-session-sync-performance.js`

The tests cover bounded batches, cross-batch ordering, failed-batch retry,
stable idempotency IDs, replay suppression, old-relay fallback, duplicate and
out-of-order diagnostics, blank diagnostic filtering, and the retention limit.

Final repository verification after the fix:

- 58/58 JavaScript syntax checks passed.
- 39/39 `scripts/test-*.js` scripts passed.
- The managed relay, host-agent, and SSE integration passed.
- `git diff --check` passed.

## Deployment

Both the relay and host agent must be restarted before running processes use
the new protocol and hot path. During the repair they were intentionally not
restarted automatically, to avoid interrupting active sessions.

## Remaining P1 Work

This fix addresses the observed 14-second realtime synchronization path. It
does not close these separate durability and persistence issues:

- Diagnostics persistence still serializes and rewrites a large full snapshot
  on the relay. This is tracked as P1-005 in `sol_ultra/ISSUES.md`.
- Pending tail batches and offsets are memory-only. An agent process crash can
  still lose unconfirmed events. This is tracked as P1-007.

## Changed Files

- `apps/relay/server.js`
- `apps/host-agent/agent.js`
- `shared/codex-tail.js`
- `shared/agent-event-batch.js`
- `scripts/test-agent-event-batch-transport.js`
- `scripts/test-session-watch-batching.js`
- `scripts/test-realtime-session-sync-performance.js`
- `package.json`
