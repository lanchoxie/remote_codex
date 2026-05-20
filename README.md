# Mobile Codex Remote Notes

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

## Current prototype

The repository now contains a no-dependency Node prototype with three parts:

- `apps/relay`: in-memory relay and API server;
- `apps/host-agent`: host agent that discovers local `~/.codex` sessions and
  starts one managed session;
- `apps/mobile-web`: mobile-first web UI served by the relay.

What the prototype already does:

- discovers local Codex session metadata from `~/.codex`;
- groups sessions by host and exposes them through the relay API;
- starts one managed live session per host agent on boot;
- lets the browser send input to a live session;
- streams session output back over Server-Sent Events.

Current limitation:

- imported historical sessions are shown as `history only`;
- only managed sessions are interactive;
- the relay keeps state in memory for now;
- the default managed session is a local demo process, not the real Codex CLI.

## Quick start

Requirements:

- Node.js 22 or newer is recommended;
- a local `~/.codex` directory is optional but useful for discovery.

Run the relay and one local demo agent:

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
- [Architecture](docs/mobile-codex-remote-architecture.md)
- [HPC Connectors](docs/hpc-connectors.md)
- [Host Onboarding](docs/host-onboarding.md)
- [Session Discovery And Control](docs/session-discovery-and-control.md)
- [MVP Plan](docs/mvp-plan.md)
