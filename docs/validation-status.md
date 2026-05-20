# Validation Status

This document tracks what we have actually verified versus what is still design intent.

## Verified locally

| Area | Evidence | Notes |
| --- | --- | --- |
| Relay health and basic APIs | `GET /health`, `/api/hosts`, `/api/stats` on `8797` | Running local preview has been restarted and queried repeatedly |
| Host registration and heartbeat | Local `host-agent` appears as `latest-preview-8797` | Host advertises discovery, managed sessions, directory browse, structured status, requests, interrupt |
| Passive Codex discovery | Local `~/.codex/sessions` imported and grouped by `cwd` | Verified on Windows user Codex history |
| Managed session smoke test | `npm run test:managed` passes | Uses demo runner and validates relay -> agent -> live session -> SSE output |
| SSE session stream | Test subscribes to `/api/sessions/:id/events` and receives output | Demo runner path verified |
| Real Codex app-server bridge | Local preview has run with `demoMode: false` and returned real model text | Needs automated test coverage because it depends on Codex backend/network |
| Directory browser | UI can request host directory listings through relay/agent | Local Windows host path verified |
| Runtime status UI | Runtime panel and status modal render connection, phase, turn, token/rate-limit/request data | Depends on events emitted by Codex app-server |
| Interrupt/steer/compact/shell command controls | UI and relay command routes are wired | Individual Codex backend behaviors still need dedicated tests |
| Connector persistence API | `/api/connectors` returns saved profiles from relay storage | Stored under `tmp/connectors.json` |
| HPC connector command generation | `shared/connectors.js` generates `tmux` bootstrap commands | Command format verified locally, not yet run on HPC |
| HPC connector actions | Relay can run SSH smoke/status/bootstrap actions | Supports key/agent auth and local saved password auth; OTP/SSO/captcha still manual |

## Partially verified

| Area | Verified part | Missing part |
| --- | --- | --- |
| Resume from history | UI can start a managed session using prior transcript preview | Not the same old process unless it was already managed/live |
| Request/approval UI | Relay and UI can display and respond to structured request objects | Needs more real Codex request fixtures and edge-case coverage |
| Thinking trace UI | UI can render structured reasoning/plan diagnostics in the chat flow | Codex does not emit structured thinking every turn |
| Real app-server runner | Can start/resume threads and stream model output locally | Needs stable automated integration harness and failure-mode tests |
| HPC onboarding | Connector model, generated manual command, and non-interactive SSH actions exist | Needs real login node validation, gateway cases, remote install/sync, and agent packaging |
| Android readiness | PWA-style mobile UI and manifest exist | Native Android wrapper, notifications, and background reconnect are not implemented |

## Not done yet

- User authentication and device approval.
- Multi-user authorization and host ownership.
- Durable relay session store; relay session state is mostly in memory.
- Real SSH runner with keyboard-interactive prompts.
- Real gateway launcher service.
- `tmux` runtime that can attach to an existing pane and keep a Codex CLI PTY alive.
- HPC scheduler integration for compute-node jobs.
- Native Android app.
- Notifications.
- File browser/editor from phone.
- Full audit log and approval history.
- Production TLS/deployment story.

## Current safest product path

1. Keep using outbound host agents for active control.
2. Use SSH/gateway only to bootstrap the agent.
3. Keep HPC live sessions in `tmux`.
4. Add an explicit onboarding status flow: saved connector -> manual SSH -> tmux bootstrap -> host online -> start Codex.
5. Add SSH runner later only if the manual bootstrap flow is too painful.
