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

- passwords;
- OTP codes;
- captcha answers;
- long-lived session cookies.

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

The connector editor now generates two useful commands:

- `SSH Login`: an interactive login command that you can paste into a terminal or Termux;
- `SSH Smoke Test`: a non-interactive `BatchMode=yes` command that checks whether passwordless SSH actually works.

Use the smoke test when you want a quick "does this key-based path connect?" check.
If it succeeds, the path is effectively passwordless for that host combination.
If it fails and the login command still prompts for a password or MFA, the profile is saved but not yet passwordless.

The app does not execute these checks for you yet. It only stores the recipe and generates the commands.

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
