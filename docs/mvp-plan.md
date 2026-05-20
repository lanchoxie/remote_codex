# MVP Plan

## Objective

Deliver a first version that proves:

- one phone can connect to multiple hosts;
- each host can advertise Codex sessions by directory;
- a managed session can keep running when the phone disconnects;
- both HPC and PC are supported with the same user model.

## Scope

### In

- host registration;
- device login;
- session discovery;
- managed session launch;
- live prompt and output streaming;
- read-only session history summaries.

### Out for MVP

- full file editing from phone;
- arbitrary shell access;
- direct remote browsing of raw `.codex`;
- automatic reattachment to every historical session;
- compute-node specific scheduler integration.

## Suggested implementation order

1. Build a relay service with user auth, device approval, and WebSocket routing.
2. Build an HPC/Linux host agent with `tmux`-backed managed sessions.
3. Build a Windows host agent with PTY-backed managed sessions.
4. Build a mobile-first web UI that lists hosts and sessions and opens a chat.
5. Add passive `.codex` import to show recent history grouped by `cwd`.
6. Add notifications and approval prompts.

## Minimal data model

### User

- id
- display name

### Device

- id
- user id
- approved at
- last seen at

### Host

- id
- owner user id
- host label
- platform
- online state

### Session

- id
- host id
- cwd
- state
- source
- last updated at

## Success criteria

- a phone sees one HPC host and one PC host online;
- a phone opens a managed session on either host and sends a prompt;
- output streams back live;
- disconnecting the phone does not kill the host session;
- reconnecting the phone shows the same running session.
