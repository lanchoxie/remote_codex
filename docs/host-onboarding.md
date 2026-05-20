# Host Onboarding

## Purpose

Each controllable machine runs one local host agent.

That agent does two jobs:

- imports local Codex history from that machine's `~/.codex`;
- owns any managed live sessions that the phone can continue chatting with.

This means "importing Codex from different devices" is really:

- install or copy the host agent onto each target machine;
- point every agent at the same relay;
- give each machine a unique `HOST_ID`;
- let each machine scan its own local `CODEX_HOME`.

## Important model distinction

There are two kinds of imported sessions:

- `managed/live`: started by our host agent, so the phone can keep talking to it;
- `imported/history only`: discovered from local `~/.codex`, so the phone can see it but not truly drive it yet.

For HPC and office PCs, this distinction matters a lot.

If you want reliable phone handoff, the session should be started through the
agent from the beginning.

## Windows or office PC

Use one agent process per user account that owns the local Codex sessions.

Example:

```powershell
$env:RELAY_URL = "https://your-relay.example.com"
$env:HOST_ID = "office-pc-01"
$env:HOST_LABEL = "School Office PC"
$env:CODEX_HOME = "$HOME\\.codex"
$env:AUTO_START_SESSION = "false"
node apps/host-agent/agent.js
```

Notes:

- if the office PC is behind NAT, do not expect the phone to connect to it directly;
- let the office PC agent make an outbound connection to the relay instead.

## HPC login node

Use one agent process inside the same Unix account that runs Codex.

Example:

```bash
export RELAY_URL="https://your-relay.example.com"
export HOST_ID="hpc-login-01"
export HOST_LABEL="Campus HPC"
export CODEX_HOME="$HOME/.codex"
export AUTO_START_SESSION="false"
node apps/host-agent/agent.js
```

Notes:

- this agent should usually live on the login node, not on short-lived compute nodes;
- later we should replace the child-process demo runtime with a `tmux` runtime
  so the live session survives reconnects more naturally.
- for saved gateway / MFA / bootstrap recipes, see [HPC Connectors](hpc-connectors.md).

## Personal laptop or home workstation

Same pattern:

```bash
export RELAY_URL="https://your-relay.example.com"
export HOST_ID="home-workstation"
export HOST_LABEL="Home Workstation"
export CODEX_HOME="$HOME/.codex"
node apps/host-agent/agent.js
```

## If one machine has multiple Codex homes

Current MVP assumption:

- one agent maps to one user account and one `CODEX_HOME`.

If one machine needs multiple separate Codex identities, use either:

- multiple agent processes with different `HOST_ID` and `CODEX_HOME`;
- or a future extension where one host agent manages multiple profiles.

## What the stats panel should show

A good first stats panel answers:

- how many hosts are online;
- how many sessions are live;
- how many sessions are only imported history;
- which workspaces are busiest.

That is now the baseline exposed by the relay in `/api/stats`.
