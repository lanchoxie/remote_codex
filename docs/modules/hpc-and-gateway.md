# HPC And Gateway Module

Paths:

- `shared/connectors.js`
- `docs/hpc-connectors.md`
- future `apps/gateway` or `apps/ssh-runner`

## Purpose

This module describes how non-local machines become controllable without making the phone directly own SSH sessions.

## Current model

The implemented model is saved connector profiles plus manual bootstrap.

Flow:

```text
save connector -> SSH manually or via Termux -> run generated tmux command -> host-agent comes online -> control through relay
```

## Connector kinds

- `outbound_agent`: best default; agent runs on target and dials relay.
- `ssh_jump`: target is reached through a bastion or campus gateway.
- `gateway_agent`: a future sidecar on the gateway starts or repairs target agents.
- `reverse_tunnel`: remote side creates an outbound path first.
- `manual_only`: saved runbook without automation.

## Auth modes

- `ssh_key`
- `ssh_agent`
- `password`
- `keyboard_interactive`
- `otp`
- `browser_sso`
- `manual_captcha`

Interactive auth modes should be treated as human bootstrap steps.

## Current implementation

- Connector CRUD API exists.
- Connector profiles persist to `tmp/connectors.json`.
- UI can create/edit/delete connector profiles.
- UI displays generated SSH login commands, non-interactive smoke test commands, bootstrap commands, steps, and warnings.
- Relay can execute non-interactive connector actions: SSH smoke test, tmux status check, and detached host-agent bootstrap.
- UI can run those connector actions and display stdout/stderr/status.
- Generated `manual_tmux` command is designed for a Linux/HPC shell.

## Not implemented yet

- Interactive SSH runner.
- Gateway launcher daemon.
- Password or keyboard-interactive prompt relay.
- Captcha automation.
- Real HPC validation on a campus cluster.
- `tmux` pane attach/control runtime.
- Browser-side SSH execution and live password/MFA prompt handling.

## Recommended next implementation

1. Add a connector onboarding state machine in the UI.
2. Watch for the matching `HOST_ID` to appear online after `Start Agent`.
3. Add a host-agent package/install script for Linux.
4. Add a remote install/sync step for the agent directory.
5. Add `tmux` pane attach/control runtime.
6. Only then consider an interactive SSH runner.
