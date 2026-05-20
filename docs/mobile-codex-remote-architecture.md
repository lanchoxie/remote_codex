# Mobile Codex Remote Architecture

## What we are trying to build

We want one phone app to control Codex sessions running on:

- a personal PC;
- a school office PC;
- an HPC login node or long-lived shell environment;
- optionally an HPC job shell that is kept alive by `tmux` or `screen`.

The phone should be able to:

- list hosts and sessions;
- see which project directory each session belongs to;
- send follow-up prompts;
- stream output back in near real time;
- leave and reconnect later without killing the host-side work.

## Direct answers to the current questions

### 1. Is each Codex under each project directory, maybe inside `.codex`?

Not as the primary storage model on the machine we checked on 2026-05-18.

Observed locally:

- Codex session data is stored under the user home, for example
  `C:\Users\<user>\.codex\...`;
- session rollout files are under
  `~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl`;
- the session metadata includes `cwd`, so the project directory is recorded
  inside the session metadata rather than by creating one `.codex` folder per
  project directory.

That means:

- we can discover "which Codex belongs to which directory" by reading session
  metadata;
- but we should not assume "every project has its own stable `.codex` folder".

### 2. Can a phone chat with Codex and let it continue running on HPC?

Yes, but only if the HPC side runs a long-lived agent or a long-lived terminal
session that the agent can reconnect to.

The important distinction is:

- reading `.codex` history tells us what happened;
- controlling a live Codex session requires owning a PTY, `tmux` pane, or other
  active execution channel.

### 3. Can the same idea work for a normal PC too?

Yes. A PC is easier than HPC because the process usually stays on one host and
we can run a Windows or Linux host agent locally.

### 4. How should the communication work?

The cleanest design is:

`phone app <-> control plane <-> host agent <-> live Codex process`

The phone should not read or write remote `.codex` files directly.

## Recommended architecture

## Components

### Phone app

Responsibilities:

- login and device approval;
- list hosts and sessions;
- open a chat view for one session;
- stream stdout/stderr and structured events;
- send text prompts, stop requests, and limited control actions.

Suggested stack:

- first version: PWA or lightweight mobile web app;
- later: native app if notifications, background sync, and SSH/VPN integration
  matter a lot.

### Control plane

Responsibilities:

- authenticate users and devices;
- keep an inventory of online hosts;
- route session traffic between phone and host agents;
- store only minimal metadata, not raw host secrets;
- keep audit logs and approval events.

Suggested transport:

- HTTPS for auth and metadata APIs;
- WebSocket for live streaming;
- optional gRPC internally if we split services later.

### Host agent

One agent runs on each controllable machine:

- personal PC agent;
- school office PC agent;
- HPC login-node agent.

Responsibilities:

- discover existing Codex sessions from local metadata;
- start new managed Codex sessions;
- attach to live PTY or `tmux` sessions;
- stream output back to the control plane;
- enforce local policy before allowing risky actions.

### Live session runtime

This is the real thing that does the work:

- Windows PC: Codex process attached to ConPTY or another managed terminal;
- Linux/HPC: Codex inside `tmux`, `screen`, or a persistent PTY wrapper.

## Session model

Use two session modes.

### Managed mode

The agent starts Codex itself.

Benefits:

- stable lifecycle;
- easy to send input and capture output;
- easy to reconnect from phone and desktop;
- best choice for new sessions.

### Imported mode

The agent discovers an existing session from `~/.codex` and shows it in the UI,
but may mark it as:

- `history_only` if no live process can be attached;
- `reattachable` if it is tied to a known `tmux` session or PTY wrapper.

This avoids overpromising. Not every old session can be turned back into a live
interactive process.

## Session discovery strategy

We should not rely on a single internal file forever. Use a layered approach.

### Layer 1: wrapper registry

When the agent starts Codex, it writes its own registry, for example:

- host id;
- session id;
- cwd;
- pid;
- PTY handle or `tmux` name;
- created time;
- last heartbeat;
- state.

This becomes the source of truth for managed sessions.

### Layer 2: passive import from `~/.codex`

For sessions not started by the agent, scan:

- `~/.codex/session_index.jsonl`;
- recent `~/.codex/sessions/.../rollout-*.jsonl` files.

Use only selected metadata such as:

- session id;
- cwd;
- update time;
- source;
- cli version.

Do not expose raw config files or credentials.

## Networking options

## Option A: direct access to HPC through campus VPN or SSH

This can work when:

- your phone can join the campus network or VPN;
- the HPC login node is reachable from the phone;
- you are comfortable using SSH from the app backend or from a sidecar service.

Typical path:

`phone -> campus VPN -> HPC login node -> host agent or SSH bridge`

This is feasible for HPC.

## Option B: direct access to school office PC from phone

This usually does not work reliably.

Reasons:

- office PC is often behind NAT;
- inbound ports are blocked;
- the phone does not know how to reach that machine directly;
- even if reachable, exposing a direct control port is risky.

Typical fix:

- the office PC agent makes an outbound connection to a relay;
- the phone also connects to the relay;
- the relay only routes already-authenticated traffic.

Typical path:

`phone -> relay -> office PC agent`

## Option C: one unified model for both HPC and office PC

This is the best default.

Use outbound-only agent connections from all hosts:

- HPC agent connects outward to the relay;
- office PC agent connects outward to the relay;
- personal PC agent connects outward to the relay;
- phone app talks only to the relay.

This removes most NAT problems and keeps the phone app simple.

## Recommended communication design

### Control channel

Use WebSocket with typed events:

- `host.online`
- `host.offline`
- `session.list`
- `session.started`
- `session.output`
- `session.state_changed`
- `session.error`
- `approval.request`
- `approval.result`

### Data flow for a prompt

1. Phone sends a message to one session.
2. Relay authenticates the user and forwards to the right host agent.
3. Host agent writes the message into the live Codex PTY.
4. Host agent reads output chunks and sends them back upstream.
5. Phone app renders a streaming transcript.

### Data flow for discovery

1. Host agent scans its managed registry.
2. Host agent optionally imports recent `~/.codex` session metadata.
3. Host agent publishes a session summary list to the relay.
4. Phone app shows sessions grouped by host and `cwd`.

## Security model

This is the part to keep strict from day one.

- Never expose raw `~/.codex` over the network.
- Never ship `auth.json`, config files, or provider keys to the phone.
- Require device approval for first login from a new phone.
- Issue short-lived tokens for live session streaming.
- Keep host-scoped permissions. A phone user may have access to one HPC host but
  not another.
- Add approval gates for risky actions such as shell execution outside an
  allowed workspace.

## What I would build first

### Phase 1

- one relay service;
- one Linux host agent for HPC;
- one Windows host agent for PC;
- managed sessions only;
- basic chat and output streaming;
- session list grouped by host and directory.

### Phase 2

- passive import of historical `~/.codex` sessions;
- resume into `tmux`-managed sessions;
- file listing and read-only project browsing;
- notifications when a session completes or asks for approval.

### Phase 3

- mobile native app;
- desktop web console;
- richer per-session permissions;
- scheduler awareness for HPC jobs.

## Bottom line

The idea is implementable.

But the stable path is not "mobile directly touches `.codex` on remote hosts".
The stable path is "a host agent owns the live Codex process and only uses
`.codex` as a discovery/import source".
