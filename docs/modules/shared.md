# Shared Libraries

Path: `shared`

## Purpose

Shared modules hold cross-runtime data helpers and normalization logic. They should stay small and dependency-free until the project has a stronger package boundary.

## Files

### `protocol.js`

Small protocol helpers:

- `makeId()`
- `nowIso()`
- `sessionKey()`
- `pick()`
- `normalizeArgs()`

### `jsonl.js`

Reads JSONL files used by Codex rollout/session history.

### `codex-discovery.js`

Discovers passive Codex history from `CODEX_HOME`, especially rollout JSONL files under `~/.codex/sessions`.

Important distinction:

- discovery can show historical sessions;
- discovery cannot revive a dead process.

### `connectors.js`

Normalizes, serializes, decorates, and persists HPC connector profiles.

Connector data includes:

- route kind;
- target host;
- gateway settings;
- auth mode;
- bootstrap mode;
- workspace roots;
- generated runbook and bootstrap command.

It must not store:

- passwords;
- OTP values;
- captcha answers;
- private key contents.

## Known gaps

- No schema validation library.
- No migration system for connector storage.
- No typed client/server protocol yet.

