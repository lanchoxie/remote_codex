# Developer Guide

## Local workflow

Install dependencies only if the project later gains any. The current prototype uses Node built-ins.

```bash
npm run dev
npm run test:managed
```

Common direct commands:

```bash
PORT=8797 npm run relay
RELAY_URL=http://127.0.0.1:8797 HOST_ID=local npm run agent
```

On Windows PowerShell:

```powershell
$env:PORT = "8797"
npm run relay
```

## Preview

The current local preview convention is:

```text
http://127.0.0.1:8797
```

The relay serves both APIs and the static mobile web UI.

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
- `POST /api/agent/register`
- `POST /api/agent/heartbeat`
- `GET /api/agent/commands`
- `POST /api/agent/events`

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

## Adding a new runtime

A runtime should expose these behaviors to `agent.js`:

- start with `sessionId`, `cwd`, labels, and optional resume metadata;
- accept prompt input;
- optionally interrupt, steer, compact, run shell command, and respond to requests;
- emit transcript, runtime, diagnostic, request, alert, and state events;
- close cleanly when the session stops.

The current real runtime is `codex-app-server-runner.js`. The test runtime is `demo-session.js`.

