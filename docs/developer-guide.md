# Developer Guide

## Local workflow

Production verification and development must use separate checkouts (or Git
worktrees). The relay reads mobile web assets from its checkout for every HTTP
request, so a second port and a second state directory alone do not isolate a
running production UI from source edits.

Recommended topology:

| Instance | Checkout | Port | Relay state | Agent |
| --- | --- | ---: | --- | --- |
| Production | stable, not edited while running | `8797` | production-only | real production Agent |
| UI development | editable worktree | `8897` | `tmp/relay-8897` in the development worktree | disabled by default |
| E2E development | editable worktree | `8897` | development-only | explicitly enabled with isolated Agent state |

Create the development worktree from the stable checkout. Use command-scoped
`safe.directory` when Windows reports a repository ownership mismatch; do not
change the global Git configuration.

```powershell
git -c safe.directory=D:/project/remote_codex-prod worktree add D:\project\remote_codex-dev -b dev/local
Set-Location D:\project\remote_codex-dev
$env:REMOTE_CODEX_DEV_PORT = "8897"
$env:REMOTE_CODEX_PRODUCTION_STATE_ROOT = "D:\project\remote_codex-prod\tmp"
npm run dev
```

`npm run dev` refuses production port `8797`, creates a port-specific Relay
state root, ignores inherited production paths and credentials, and starts no
Agent by default. To exercise Agent flows, opt in explicitly:

```powershell
$env:REMOTE_CODEX_DEV_PORT = "8897"
$env:REMOTE_CODEX_DEV_WITH_AGENT = "true"
npm run dev
```

The development Agent uses its own `CODEX_HOME`, Remote Codex state, Host ID,
owner marker, and Relay URL. Relay auth files, connectors, session data, skill
state, SSH known-hosts data, logs, and browser auth cookies are also isolated by
state root or port. Never override those development paths to point at the
production state tree. Physical paths are checked after resolving Windows
junctions and symbolic links, so aliases to the production tree are rejected.

The Windows production launcher starts a real local Agent only on port `8797`.
On any other port it clears inherited production auth, ignores generic
production state variables, and disables Relay-managed Agent startup. Use
`npm run dev` for development, including isolated Agent testing.

Start production only from the stable checkout:

```powershell
.\start-windows.bat
```

For ordinary development and focused validation:

```bash
npm run dev
npm run test:managed
```

## Preview

The production preview convention is:

```text
http://127.0.0.1:8797
```

The recommended development preview is:

```text
http://127.0.0.1:8897
```

The relay serves both APIs and the static mobile web UI.

## Git workflow

- Keep `main` in a demoable state.
- Use one focused branch per change, such as `feat/mobile-status`, `fix/agent-heartbeat`, or `docs/remodex-notes`.
- Prefer small commits that describe one behavior change at a time.
- Run `npm run test:managed` before merging code that changes the relay, host agent, or session transport.
- Do not commit local secrets or runtime state such as `tmp/connectors.json`, local `.env` files, OTP values, or private keys.
- Treat `protocol_dump/` and `tmp/app-server-schema/` as versioned reference artifacts for now; if we later automate regeneration, document the refresh flow in the same change.

## Test coverage

`npm run test:managed` starts:

- a relay on port `8792`;
- one host agent;
- one demo managed session;
- an SSE subscription;
- one prompt round trip.

It validates the core transport path, but not real Codex backend behavior.

## API shape

The relay is a no-dependency HTTP server. Important routes:

- `GET /health`
- `GET /api/stats`
- `GET /api/hosts`
- `POST /api/hosts/import`
- `DELETE /api/hosts/:hostId`
- `GET /api/hosts/:hostId/sessions`
- `POST /api/hosts/:hostId/sessions/start`
- `GET /api/hosts/:hostId/directories`
- `GET /api/sessions/:sessionId/detail?hostId=...`
- `GET /api/sessions/:sessionId/events?hostId=...`
- `POST /api/sessions/:sessionId/input`
- `POST /api/sessions/:sessionId/interrupt`
- `POST /api/sessions/:sessionId/steer`
- `POST /api/sessions/:sessionId/compact`
- `POST /api/sessions/:sessionId/shell-command`
- `POST /api/sessions/:sessionId/requests/:requestId/respond`
- `GET /api/connectors`
- `POST /api/connectors`
- `PATCH /api/connectors/:connectorId`
- `DELETE /api/connectors/:connectorId`
- `POST /api/connectors/:connectorId/actions`
- `POST /api/agent/register`
- `POST /api/agent/heartbeat`
- `GET /api/agent/commands`
- `POST /api/agent/events`

Connector action payloads use:

```json
{ "action": "smoke_test" }
```

Supported actions:

- `smoke_test`: runs a non-interactive `ssh` check with `BatchMode=yes`.
- `status`: checks the remote tmux agent session when the connector can use non-interactive SSH.
- `bootstrap`: starts the remote host agent through SSH when the connector can use non-interactive SSH.

Saved connector passwords are kept out of connector profiles. They live in the
ignored `<RELAY_STATE_ROOT>/connector-secrets.json` file and are used only by
connector actions on the relay machine.

## Event model

Host agents poll `/api/agent/commands` and post events to `/api/agent/events`.

Session subscribers use Server-Sent Events from `/api/sessions/:sessionId/events`.

Important event names:

- `session.snapshot`
- `session.started`
- `session.state_changed`
- `session.transcript`
- `session.alert`
- `session.runtime`
- `session.diagnostic`
- `session.request`
- `session.request.resolved`

## Coding conventions

- Keep relay state changes in `apps/relay/server.js` until a real store is introduced.
- Keep host-local filesystem/process actions inside `apps/host-agent`.
- Keep UI state in `apps/mobile-web/public/app.js`.
- Put cross-module normalization and small data models in `shared`.
- Do not store passwords, OTP codes, captcha answers, or private keys in connector profiles.
- Treat imported Codex history as read-only metadata unless a live runtime owns the process.

## Managed Codex State Safety

Managed Codex app-server sessions must not write directly into the host user's
primary `CODEX_HOME` state databases. This is especially important on HPC
systems, where the same user may already have an interactive Codex TUI running
inside tmux and where shared filesystems can make SQLite locking fragile.

The Codex app-server runner therefore creates one isolated Codex home per
managed session under:

```text
<base CODEX_HOME>/.remote-codex-managed/<session-profile>/.codex
```

The isolated home copies small identity/config files such as `auth.json`,
`config.toml`, `installation_id`, and `cap_sid`, and links shared read-mostly
directories such as `sessions`, `skills`, `rules`, `memories`, and
`generated_images`. It intentionally does not share Codex runtime SQLite files
such as `state_*.sqlite` or `logs_*.sqlite`; those are rebuilt per managed
session.

If app-server startup reports a corrupted Codex state database, the runner may
move only `state_*.sqlite*` and `logs_*.sqlite*` from the isolated home into a
`broken-sqlite-backup-*` directory and retry once. Never delete the whole
primary `~/.codex` directory as a recovery step. The durable conversation
history is expected to remain in `sessions/` and `session_index.jsonl`.

API profile switching follows the same isolation rule. The runner writes the
selected profile into the isolated home and passes the generated
`modelProvider` explicitly when starting, resuming, or forking a thread.
Changing an API profile affects newly started managed sessions; an already
running Codex app-server process keeps the API settings it started with.

## Adding a new runtime

A runtime should expose these behaviors to `agent.js`:

- start with `sessionId`, `cwd`, labels, and optional resume metadata;
- accept prompt input;
- optionally interrupt, steer, compact, run shell command, and respond to requests;
- emit transcript, runtime, diagnostic, request, alert, and state events;
- close cleanly when the session stops.

The current real runtime is `codex-app-server-runner.js`. The test runtime is `demo-session.js`.
