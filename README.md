# Mobile Codex Remote Notes

[中文说明 / Chinese README](README.zh-CN.md)

This workspace captures an MVP design for controlling Codex sessions on a PC
and on HPC hosts from a phone.

## Goal

Build a system where:

- a phone can see available Codex sessions on different hosts;
- a phone can continue chatting with a Codex session that is already running;
- a host can keep Codex running even when the phone disconnects;
- HPC and office PCs can both be supported without exposing dangerous local
  files directly to the phone.

## Key conclusion

Reading `~/.codex` is useful for discovery, but it is not enough for control.
To let Codex continue running on another machine, we need a host-side agent that
owns the live Codex process and streams input/output over a secure channel.

## Version 0.2.0: 基础多平台版本

This release is the first usable multi-platform baseline. It is still a local
tooling project, but it can now control local and remote Codex hosts from the
same browser/mobile UI.

The repository contains a no-dependency Node implementation with three parts:

- `apps/relay`: in-memory relay and API server;
- `apps/host-agent`: host agent that discovers `~/.codex` sessions and starts
  managed Codex app-server sessions;
- `apps/mobile-web`: mobile-first web UI served by the relay.

What this version does:

- discovers Codex history from local and HPC `~/.codex` directories;
- connects multiple hosts through outbound agents, including SSH/HPC bootstrap
  flows with gateway/jump-host support;
- supports switching between local PC and HPC hosts from the same UI;
- starts, resumes, and forks managed Codex sessions from selected directories;
- streams live output, status, diagnostics, approval requests, and alerts over
  Server-Sent Events;
- provides host health checks before switching or sending commands;
- supports session search by keyword, path, and title-like metadata;
- supports cross-host session collections/favorites;
- supports directory browsing on remote hosts, including `~` and `/` roots;
- supports Codex app-server controls: model selection, reasoning effort,
  reasoning summaries, approval policy, approval reviewer, sandbox mode,
  plan-only turns, review turns, interrupt, steer, compact, and shell-command
  control;
- supports image input from the browser and host-local image paths;
- supports drag-and-drop image attachments plus drag-and-drop text/code files
  that are embedded into the prompt.

Current limitations:

- the relay is intentionally lightweight and still keeps most runtime state in
  memory;
- imported historical sessions are readable, but need resume/fork to become
  interactive;
- remote hosts must run the matching host-agent version before new controls
  such as model listing, review, and image input are available;
- there is no built-in authentication layer on the relay yet, so do not expose a
  running relay to untrusted networks.

## Quick start

Requirements:

- Node.js 22 or newer is recommended;
- a local `~/.codex` directory is optional but useful for discovery.

Run the relay and one local agent:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:8787
```

Useful scripts:

```bash
npm run relay
npm run agent
npm run test:managed
```

`npm run test:managed` boots a relay plus one agent, waits for a live managed
session, sends one prompt, and verifies that streamed session output contains
the prompt text.

## Sharing with a friend

The safest way to let someone else try this project is to send the GitHub
repository link or a release/tag link, not your running relay URL and not a zip
of your working directory.

Safe to share:

- the GitHub repository URL;
- a clean checkout of the source code;
- public docs and screenshots.

Do not share:

- `tmp/connectors.json`;
- `tmp/connector-secrets.json`;
- `.env` or `.env.local`;
- your running `http://<your-ip>:8797` relay URL unless you intentionally want
  that person to see and control the sessions currently attached to your relay.

Friend experience:

- after cloning the repo, your friend will not have your PC/HPC credentials;
- they will not be able to log in to your host or HPC from the repo alone;
- they need to configure their own hosts, SSH keys, passwords, OTP prompts, and
  Codex account/session state;
- if you expose your live relay on a LAN or public network, the current app has
  no auth wall yet, so anyone who can reach it may be able to control attached
  sessions.

## Android-friendly groundwork

The current mobile web UI includes:

- a narrow-screen layout intended for phones;
- a web app manifest for Android installation experiments;
- a theme color and standalone-capable metadata for PWA-style wrapping.

This is still a browser-first UI, but it gives us a clean bridge into either:

- a PWA for Android;
- a native Android app with a WebView shell at the very beginning;
- or a later fully native client that reuses the same relay APIs.

Useful environment variables for the agent:

- `RELAY_URL`: relay base URL, default `http://127.0.0.1:8787`
- `HOST_ID`: stable host identifier
- `HOST_LABEL`: display name for the host
- `CODEX_HOME`: override the local `.codex` directory
- `AUTO_START_SESSION`: set to `false` to disable the default managed session
- `MANAGED_COMMAND`: set to `demo` or a real command later
- `MANAGED_ARGS_JSON`: JSON array of command arguments
- `MANAGED_CWD`: working directory for the managed session

## Docs

- [Docs Index](docs/README.md)
- [Module Map](docs/module-map.md)
- [Validation Status](docs/validation-status.md)
- [Developer Guide](docs/developer-guide.md)
- [Remodex Comparison](docs/remodex-comparison.md)
- [Architecture](docs/mobile-codex-remote-architecture.md)
- [HPC Connectors](docs/hpc-connectors.md)
- [Host Onboarding](docs/host-onboarding.md)
- [Session Discovery And Control](docs/session-discovery-and-control.md)
- [MVP Plan](docs/mvp-plan.md)
