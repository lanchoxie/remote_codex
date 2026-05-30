# HPC Connectors

This project treats HPC access as a saved connector profile, not as ad-hoc phone-side SSH.

## Recommended model

- save one connector per HPC path;
- keep the profile on the relay;
- let the target machine run a host agent that dials out to the relay;
- use `tmux` or a user service so the live session survives disconnects.

## What a connector stores

- label and host binding;
- target host and user;
- optional gateway / jump host details;
- auth mode;
- bootstrap recipe;
- workspace roots and notes.

## What it must not store

- OTP codes;
- captcha answers;
- long-lived session cookies.

Passwords are not stored in `tmp/connectors.json`. If the user explicitly saves
one for local automation, it is kept in the local-only
`tmp/connector-secrets.json` file, which is ignored by Git and should be treated
as sensitive machine-local state.

## Password prompts

The current prototype does not start an SSH login inside the browser.

If both the gateway and the target login node require passwords, run the
generated `SSH Login` command in a terminal or Termux. OpenSSH will prompt for
the gateway password first and then the target password. After you land on the
target host, run the generated `tmux Bootstrap` command there.

A future integrated SSH runner can surface keyboard-interactive prompts in the
mobile UI, but those secrets should still be one-time inputs and must not be
saved by the relay.

## Connectivity checks

The connector editor now generates two useful commands and can run the
non-interactive path from the relay machine:

- `SSH Login`: an interactive login command that you can paste into a terminal or Termux;
- `SSH Smoke Test`: a non-interactive `BatchMode=yes` command that checks whether passwordless SSH actually works.
- `Run Test`: executes the smoke test from the relay machine.
- `Check Status`: checks whether the configured remote tmux agent is already running.
- `Start Agent`: runs the detached remote bootstrap command over SSH.

Use the smoke test when you want a quick "does this key-based path connect?" check.
If it succeeds, the path is effectively passwordless for that host combination.
If it fails and the login command still prompts for a password or MFA, the profile is saved but not yet passwordless.

For key-based paths, executable actions use `BatchMode=yes`. For saved password
paths, the relay uses the local OpenSSH askpass mechanism so the password does
not appear in the command line. OTP, browser SSO, and captcha flows still stay
manual: run `SSH Login`, finish the prompt yourself, then run the generated
`tmux Bootstrap` command on the target.

## Auth modes

- `ssh_key` and `ssh_agent`: best for automation;
- `password` and `keyboard_interactive`: treat as bootstrap-only;
- `otp`, `browser_sso`, `manual_captcha`: require a human step, then keep the agent alive afterward.

## Gateway patterns

- `ssh_jump`: use a bastion or campus gateway, then reach the login node;
- `gateway_agent`: keep a launcher on the gateway and hand off to the final host;
- `reverse_tunnel`: use an outbound path when inbound SSH is not possible.

## Best default for HPC

Start the host agent on the login node, point it at the relay, and keep it inside `tmux`.

That gives the phone a stable control path without needing the phone to understand campus networking.

## Automated bootstrap prerequisites

For `Start Agent` to work, the relay machine must have:

- the `ssh` executable available;
- key-based or agent-based access to the final login node;
- or a saved local password secret for password / keyboard-interactive auth;
- any configured gateway reachable through `ProxyJump`;
- the project already present at the connector's remote directory;
- `node` available on the remote host, or a local Node runtime archive in `tmp/` for upload;
- `tmux` is preferred for the default `manual_tmux` mode, but the one-shot bootstrap falls back to a detached `nohup` agent process with `codex-remote.agent.pid` when `tmux` is unavailable.
