# Remodex Comparison

This note captures what we can borrow from
`Emanuele-web04/remodex` while keeping this project focused on browser-first
control of Codex sessions across PCs and HPC hosts.

## What Remodex gets right

- The phone is a thin remote client, not the owner of the local Codex process.
- A host-side bridge owns the live runtime and forwards messages through a
  relay.
- Pairing and trusted reconnect matter as much as raw transport.
- Self-hosting and background host service setup are first-class concerns.

## What already maps to this repo

- `apps/host-agent` already plays the same basic role as a bridge process.
- `apps/relay` already behaves like the rendezvous and fan-out layer.
- `apps/mobile-web` is already a thin remote client that can become a PWA or
  native wrapper later.

The biggest gap is not architecture direction. The gap is connection maturity:
pairing, trust, background service management, and stronger live transport.

## Concrete ideas to borrow

### 1. Pair the phone to a host explicitly

Add a one-time pairing flow instead of assuming the phone already knows a relay
and host. The simplest version for this repo is:

- host agent requests a short-lived pairing code from the relay;
- mobile UI enters or scans the code;
- relay binds the mobile client to the host identity and returns a trusted
  device record.

Later we can upgrade the same flow to QR-based pairing that includes relay URL,
host label, and a short-lived token.

### 2. Keep the host agent as the real control point

Remodex reinforces the design choice we already made in
`mobile-codex-remote-architecture.md`: the phone should not read remote Codex
state directly from disk. The host agent should continue to own:

- process lifetime;
- workspace browsing;
- shell/tool execution;
- approval responses;
- session resume and branch creation.

### 3. Strengthen the live transport

Our current model is practical for the MVP:

- agent polls the relay for commands;
- mobile client consumes session output over SSE.

For a stronger phone-to-PC experience, the next transport step should be:

- keep SSE for simple read-only streaming if we want;
- add a bidirectional low-latency channel for live control, ideally WebSocket,
  between host agent and relay and later between relay and mobile clients.

That would reduce lag for typing, interrupts, steering, approvals, and status
updates.

### 4. Make host presence durable

Remodex treats long-lived host presence as a product feature, not a manual dev
step. We should do the same and add packaging for:

- Windows background service or scheduled task for office PCs;
- `systemd` or `tmux` flow for Linux hosts;
- `launchd` only if a Mac host becomes a real target.

This is especially important for the "phone disconnects, Codex keeps running"
goal.

### 5. Add trusted-device and revocation concepts

The current relay is mostly transport and memory state. A safer mobile
connection story should eventually add:

- trusted device list per host or per account;
- explicit revoke action;
- last-seen metadata for paired devices;
- approval prompts when a new phone pairs to a host.

### 6. Keep SSH and HPC bootstrap separate from live chat transport

This is where our scope differs from Remodex. For HPC, we should still use:

- SSH, gateway, and MFA only to bootstrap or repair the host agent;
- outbound agent-to-relay connection for the ongoing live session.

That stays aligned with our current safest path and avoids turning the phone
into an SSH terminal emulator.

## Suggested implementation path for phone-to-PC connectivity

### Phase 1: reliable browser-first remote access

- Keep the current relay and host-agent split.
- Put the relay behind a stable HTTPS endpoint or a private network overlay.
- Keep the phone client as mobile web or PWA.
- Preserve outbound connections from hosts to relay so NAT traversal stays
  simple.

### Phase 2: pairing and better live control

- Add pairing code or QR flow.
- Add trusted-device records in relay storage.
- Upgrade agent command transport from polling to a push-capable channel.
- Surface host online/offline, reconnecting, and approval-needed states in the
  mobile UI.

### Phase 3: durable host runtime

- Package the host agent as a background service.
- Add reconnect and backoff behavior that survives relay restarts.
- Add device revocation and session handoff rules.

### Phase 4: HPC adaptation

- Reuse the same relay, pairing, and trusted-device model.
- Keep connector profiles for gateway, jump host, and MFA specifics.
- Treat SSH as onboarding and repair, not the main chat path.

## What not to copy verbatim

- Native iOS assumptions if we still want the browser-first path to lead.
- Single-machine assumptions; we need multi-host inventory and HPC awareness.
- Any design that exposes raw host files to the phone before pairing, trust,
  and approval layers exist.

## References

- Repository: <https://github.com/Emanuele-web04/remodex>
- Self-hosting notes: <https://github.com/Emanuele-web04/remodex/blob/main/Docs/self-hosting.md>
- Relay notes: <https://github.com/Emanuele-web04/remodex/blob/main/relay/README.md>
