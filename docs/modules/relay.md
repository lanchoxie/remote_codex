# Relay Module

Path: `apps/relay/server.js`

## Purpose

The relay is the control plane for the prototype. It keeps track of hosts, sessions, live event subscribers, pending commands, session logs, alerts, diagnostics, requests, runtime status, and saved HPC connectors.

## Current storage

- Hosts, sessions, commands, runtime data, and logs are in memory.
- Connector profiles are persisted through `shared/connectors.js` into `tmp/connectors.json`.

This is good enough for local iteration, but not production.

## Main responsibilities

- Serve the mobile web UI from `apps/mobile-web/public`.
- Register and heartbeat host agents.
- Queue commands for agents.
- Accept agent events and update session state.
- Serve host/session/stat APIs.
- Provide SSE streams for live sessions.
- Store and decorate HPC connector profiles.

## Important internal maps

- `state.hosts`
- `state.sessions`
- `state.commandQueues`
- `state.subscribers`
- `state.sessionLogs`
- `state.sessionAlerts`
- `state.sessionRuntime`
- `state.sessionDiagnostics`
- `state.sessionRequests`
- `state.connectors`

## Development notes

- `applyAgentEvent()` is the main event reducer.
- `enqueueCommand()` is the relay-to-agent command path.
- `broadcastSessionEvent()` pushes updates to open SSE clients.
- `getSessionDetail()` is the UI detail read path.
- Connector CRUD uses `normalizeConnectorInput()` and `decorateConnector()`.

## Known gaps

- No user auth.
- No durable session database.
- No per-host ownership model.
- No distributed relay support.
- No audit log beyond in-memory diagnostics.

