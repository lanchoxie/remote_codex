# Update Report - 2026-06-15

Recommended tag: `v2.4.0`

Baseline checked before this work: local `main` matched `origin/main` at `ad7ad79` (`Add performance mode toggle`). The workspace already contained additional uncommitted feature work; this report covers the reliability and export fixes added on top of that working tree.

## Summary

This update focuses on session reliability, API profile behavior, export completeness, and Windows restart ergonomics. The main bug class was mismatched state between the browser, relay command queue, and host-agent polling: history/detail commands could disappear during agent registration, duplicated Windows processes could race on the same host id, and API keys could be pinged successfully but later omitted from persisted settings.

## Highlights

- Changed API profile behavior so entered API keys are saved by default; the old remember-key checkbox was removed from the normal settings path.
- Added a clearer preflight error when a host API profile has a Base URL but no key.
- Added host-side API profile ping support through relay and host-agent.
- Fixed relay command queues so agent registration no longer clears pending commands.
- Added host-agent command acknowledgement, TTL pruning, and max queue protection.
- Made `scripts/start-windows.ps1` restart existing repo relay/host-agent processes by default; use `-NoRestart` to reuse processes.
- Added one-click copy for the full selected session id in the conversation header.
- Added multi-select export dates with select-all and clear-date controls.
- Added relay support for `dates=` export filters across Markdown, JSON, and Zip bundle exports.
- Improved Zip bundle file inclusion by matching cached files through file id, path, remote path, and filename identities.

## Root Causes Found

- The API key warning came from UI persistence, not from OpenAI changing behavior. Ping used the in-memory key from the settings form, but saving could drop the key when `rememberApiKey` was false. A later reload/restart kept the Base URL but not the key, so Codex app-server reported a missing `OPENAI_API_KEY`.
- Historical session detail failures could happen because `/api/agent/register` deleted the host command queue. If a `session.detail`, resume, model list, or file command was pending during registration, the browser waited until timeout.
- Windows restart could leave multiple same-repo relay/host-agent processes alive. A dry-run found duplicate relay and host-agent PIDs for this repo, which can make host ownership and command delivery flaky.
- Zip image/file export was too strict: the selected transcript reference and cached file record did not always share the same single identity field, so cached images could be omitted.

## Verification

Passed:

- `node --check apps/mobile-web/public/app.js`
- `node --check apps/relay/server.js`
- `node --check apps/host-agent/agent.js`
- `.\scripts\start-windows.ps1 -DryRun -NoBrowser`
- `.\scripts\start-windows.ps1 -DryRun -NoBrowser -NoRestart`

Observed:

- `CODEX_HOME` contains 64 Codex JSONL session files, so missing history is not caused by deleted local session files.
- The repo also has exported Markdown sessions under `docs/sessions/`.
