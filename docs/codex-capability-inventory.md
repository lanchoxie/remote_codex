# Codex Capability Inventory

This inventory is based on the local `codex.exe` binary and the generated app-server schema in `tmp/app-server-schema/`.

## Confirmed CLI commands

- `codex resume`
- `codex fork`
- `codex remote-control`
- `codex app-server`
- `codex plugin`
- `codex mcp`
- `codex exec`
- `codex review`

## Confirmed app-server thread actions

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/archive`
- `thread/unarchive`
- `thread/read`
- `thread/list`
- `thread/loaded/list`
- `thread/name/set`
- `thread/metadata/update`
- `thread/rollback`
- `thread/compact/start`
- `thread/shellCommand`

## Confirmed app-server turn actions

- `turn/start`
- `turn/steer`
- `turn/interrupt`

## Confirmed structured notifications

- `thread/started`
- `thread/status/changed`
- `thread/tokenUsage/updated`
- `turn/started`
- `turn/completed`
- `item/reasoning/summaryTextDelta`
- `item/plan/delta`
- `item/commandExecution/terminalInteraction`
- `account/rateLimits/updated`
- `warning`
- `error`

## Confirmed server requests

- `item/tool/requestUserInput`
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`

## Implemented in this project today

- Dedicated status modal in the mobile UI
- Live runtime panel in the main conversation view
- Structured runtime state:
  - connection
  - phase
  - busy
  - thread id
  - active turn id
  - token usage
  - rate limits
  - reasoning summary
  - plan summary
- Event timeline from app-server notifications
- Pending request cards for:
  - tool user input
  - command approval
  - file change approval
  - permissions approval
- Interrupt button backed by `turn/interrupt`
- Request response bridge from mobile UI back to Codex
- `turn/steer` control path
- `thread/compact/start` control path
- `thread/shellCommand` control path

## Not exposed in UI yet

- richer multi-question request-user-input forms
- approval presets beyond the simple actions already wired

## Product implication

The mobile app does not need to fake most of the important runtime states. Codex already exposes enough protocol surface for:

- thinking status
- reconnect/retry/error visibility
- quota and token telemetry
- human approvals
- user-input prompts
- turn interruption

The next logical UI controls are:

1. `Steer current turn`
2. `Compact thread`
3. `Run shell command`
4. richer approval and multi-question forms
