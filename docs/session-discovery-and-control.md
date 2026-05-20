# Session Discovery And Control

## Local observation from this machine

Checked on 2026-05-18.

Observed patterns:

- home-level Codex state exists under `C:\Users\<user>\.codex`;
- session files exist under `~/.codex/sessions/YYYY/MM/DD/`;
- a recent rollout file begins with a `session_meta` record;
- that metadata includes fields such as `id`, `cwd`, `originator`,
  `cli_version`, and `source`;
- `~/.codex` also contains other sensitive files and internal databases.

Implication:

- `~/.codex` is useful as a local discovery source;
- `~/.codex` is not a safe or stable remote API.

## Why reading `.codex` is not enough

There are two different jobs:

### Job A: discover sessions

We can do this by scanning metadata.

### Job B: continue an active conversation

We cannot do this by appending to a JSONL file.
To continue a live Codex session, something on the host must still own the
running process and its terminal I/O.

So the system needs both:

- a metadata scanner;
- a live process bridge.

## Recommended host-agent responsibilities

The host agent should provide four services.

### 1. Session scanner

Reads local metadata and builds a safe summary:

- session id;
- cwd;
- last updated time;
- host id;
- source;
- live or archived state.

### 2. Session launcher

Starts managed sessions using a wrapper command, for example:

- create PTY or `tmux` session;
- launch `codex`;
- capture stdout/stderr;
- register the session in the agent's own registry.

### 3. Session attach bridge

For a managed session, the agent should be able to:

- send text input;
- read output incrementally;
- stop or detach cleanly;
- reconnect later.

### 4. Policy guard

Before forwarding risky instructions, the agent can require:

- human approval;
- host allowlist checks;
- workspace path restrictions.

## Discovery algorithm

## Minimal passive import

1. Read `~/.codex/session_index.jsonl`.
2. For each recent session id, locate the corresponding rollout file.
3. Read only the first record or other narrow metadata records.
4. Extract `id`, `cwd`, and timestamps.
5. Group sessions by `cwd`.
6. Mark them `imported`.

This gives us a directory-centric session list for the mobile UI.

## Better active registry

For sessions started by our agent, keep an agent-owned registry such as:

```json
{
  "host_id": "hpc-login-01",
  "session_id": "019e3b20-347f-7511-b182-5c698acfcf03",
  "cwd": "/home/user/projectA",
  "runtime": {
    "kind": "tmux",
    "name": "codex-projectA"
  },
  "state": "running",
  "pid": 182341,
  "created_at": "2026-05-18T20:47:06Z",
  "last_heartbeat_at": "2026-05-18T21:05:12Z",
  "source": "managed"
}
```

This registry should be the source of truth for anything the app can actively
control.

## How to keep sessions alive

## On HPC

Prefer:

- `tmux` on the login node for interactive long-lived Codex sessions;
- optional scheduler integration later if a workflow needs a compute allocation.

Practical note:

- many HPC systems do not allow inbound connections to compute nodes;
- a login node or a service node is usually the right place for the long-lived
  agent;
- if a Codex-driven workflow launches jobs, the agent still stays on the login
  node and only monitors job state.

## On a normal PC

Prefer:

- a background host agent;
- a managed PTY on Windows or Linux;
- optional OS auto-start for continuity.

## Network patterns and when each works

## Pattern 1: phone directly reaches HPC

Works when:

- campus VPN is available on mobile;
- the HPC login node accepts your SSH path;
- you are okay with the app depending on VPN connectivity.

This is acceptable for personal use but less ideal for a polished multi-host
product.

## Pattern 2: phone directly reaches office PC

Usually does not work.

Common blockers:

- NAT;
- no public IP;
- local firewall;
- school network policy.

## Pattern 3: all hosts dial out to a relay

This is the most robust default.

Benefits:

- no inbound port opening on HPC or office PC;
- same flow for all hosts;
- simpler mobile app;
- easier device and host authorization.

## Suggested protocol events

Use a small typed event protocol.

### Host registration

```json
{
  "type": "host.hello",
  "host_id": "office-pc-02",
  "platform": "windows",
  "agent_version": "0.1.0"
}
```

### Session inventory

```json
{
  "type": "session.inventory",
  "host_id": "hpc-login-01",
  "sessions": [
    {
      "session_id": "019e3b20-347f-7511-b182-5c698acfcf03",
      "cwd": "/home/user/projectA",
      "state": "running",
      "source": "managed"
    }
  ]
}
```

### User prompt

```json
{
  "type": "session.input",
  "host_id": "hpc-login-01",
  "session_id": "019e3b20-347f-7511-b182-5c698acfcf03",
  "text": "continue from the previous plan and fix the parser error"
}
```

### Output chunk

```json
{
  "type": "session.output",
  "host_id": "hpc-login-01",
  "session_id": "019e3b20-347f-7511-b182-5c698acfcf03",
  "stream": "stdout",
  "chunk": "reading parser files..."
}
```

## Product decisions I recommend

### Decision 1

Do not promise that every historical Codex session is resumable.

Show two labels in UI:

- `history only`
- `live attach`

### Decision 2

Do not let the phone browse raw remote `.codex` contents.

Only expose sanitized summaries from the host agent.

### Decision 3

Prefer managed sessions for anything important.

If the user wants reliable phone handoff, start the session through the host
agent from the beginning.

## MVP answer to the user's scenario

Yes, we can build a phone app that:

- finds Codex sessions on HPC and PC;
- groups them by host and project directory;
- continues chatting with sessions that are agent-managed;
- keeps work running after the phone disconnects.

The practical implementation is:

- host agent on every target machine;
- relay or tailnet for connectivity;
- `tmux` or PTY ownership for live control;
- `.codex` scanning only for discovery and import.
