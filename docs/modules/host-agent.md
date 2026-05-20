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

## Responsibilities

- Register with relay.
- Send heartbeats.
- Discover local Codex history through `shared/codex-discovery.js`.
- Poll relay commands.
- Start managed sessions.
- Browse directories on the host.
- Forward prompt input and control commands to the runtime.
- Post runtime, transcript, diagnostic, request, and alert events back to relay.

## Runtimes

### Codex app-server runtime

Path: `apps/host-agent/codex-app-server-runner.js`

Uses Codex `app-server` JSON-RPC style protocol and maps structured Codex events into relay events.

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

### Demo runtime

Path: `apps/host-agent/demo-session.js`

Used by `npm run test:managed`. It proves the transport path without requiring a real Codex backend.

## Known gaps

- No `tmux` runtime yet.
- No SSH runner.
- No process registry that survives agent restart.
- No attach-to-existing-PTY implementation.
- Real Codex app-server path needs automated integration tests.

