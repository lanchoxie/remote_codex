# Module Map

The project is intentionally split into small runtime modules so PC, HPC, gateway, and Android work can evolve independently.

## Runtime graph

```text
mobile-web
  -> relay API / SSE
    -> host-agent command polling
      -> Codex app-server runner or demo runner
        -> local Codex session, cwd, files, tools
```

For HPC, SSH or a gateway should bootstrap the `host-agent`; the active control path should still be:

```text
phone -> relay -> HPC host-agent -> Codex on HPC
```

## Modules

| Module | Path | Current role | Status |
| --- | --- | --- | --- |
| Mobile Web UI | `apps/mobile-web/public` | Host/session navigation, chat, runtime status, connector manager | Prototype working locally |
| Relay | `apps/relay/server.js` | HTTP API, SSE stream, host inventory, session state, connector persistence | Prototype working locally |
| Host Agent | `apps/host-agent/agent.js` | Registers host, imports `.codex`, polls relay commands, starts sessions | Prototype working locally |
| Codex App Server Runner | `apps/host-agent/codex-app-server-runner.js` | Bridges Codex app-server protocol into relay events | Local real-Codex path tested, needs broader coverage |
| Demo Runner | `apps/host-agent/demo-session.js` | Deterministic fake session for tests | Verified by `npm run test:managed` |
| Session Discovery | `shared/codex-discovery.js` | Reads local `~/.codex/sessions` metadata and transcript previews | Verified on local Windows Codex history |
| Connector Model | `shared/connectors.js` | Saved HPC/gateway/auth/bootstrap profiles and generated commands | API/UI implemented, real HPC not verified |
| Protocol Helpers | `shared/protocol.js` | IDs, timestamps, session keys, argument parsing | Used across relay and agent |
| JSONL Helpers | `shared/jsonl.js` | Reads Codex rollout JSONL files | Used by discovery |
| Dev Scripts | `scripts` | Local dev launch and managed-session smoke test | `test:managed` verified |

## Boundary rules

- The phone UI never reads remote `.codex` files directly.
- The relay should route commands and store minimal metadata, not host secrets.
- The host agent owns all local filesystem, directory browsing, and Codex process access.
- Imported history is not the same as a live process.
- A historical session can be resumed as a new live branch, but only a managed live session can be joined as the same running process.
- HPC SSH/gateway flows should bootstrap or repair the agent, not become the primary chat transport.

## Suggested future split

If this grows past the current no-dependency prototype:

- extract the relay API into a typed server package;
- move runner implementations behind a stable `SessionRuntime` interface;
- make `mobile-web` consume a typed client SDK;
- split connector storage from relay memory into a real database;
- add a separate gateway service only after manual `tmux` onboarding is stable.

