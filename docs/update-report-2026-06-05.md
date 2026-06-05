# Update Report - 2026-06-05

Baseline: `origin/main` at `f9a40cd` (`Improve session history, transfers, and connector UX`)

## Summary

This update expands Mobile Codex Remote into a fuller desktop/mobile control plane for Codex app-server sessions. The main focus is reliable long-session work: better history export/import, stronger attachment and file transfer handling, session-isolated composer state, model/skill list resilience, and safer managed Codex runtime startup.

## Highlights

- Added conversation export to Markdown, JSON, and Zip bundle.
- Added conversation import from the current session or multiple other sessions.
- Added per-session import options for thinking/activity, images, and files.
- Fixed inline image and local text attachment visibility by caching them through the relay and preserving file refs.
- Fixed composer `Sending...` state leaking across conversations.
- Added stale composer submission cleanup and input request dedupe.
- Added request-user-input UI for model choice/custom input prompts.
- Added model and skill list retry cooldowns and longer app-server list request timeouts.
- Added managed runtime adapters and shared runtime API-profile utilities.
- Added isolated Codex homes for managed app-server sessions to avoid SQLite/auth/config collisions with interactive Codex.
- Added best-effort SQLite state quarantine/retry on app-server startup.
- Added full transcript extraction from Codex rollout JSONL.
- Improved transcript dedupe and filtering of internal context/action records.
- Added image preview, export dialog, history import dialog, multi-session action dialog, and mobile transcript/read-state improvements.
- Rewrote English and Chinese README files with full features, install/start instructions, Windows launcher usage, HPC setup, API profiles, troubleshooting, and limitations.

## User-Facing Changes

### Browser UI

- Composer now supports importing history using `Current` and `Others`.
- `Current` attaches the selected conversation export directly.
- `Others` opens a multi-select dialog where each source conversation can include or omit thinking, images, and files.
- Export dialog supports date ranges, thinking/activity, images, non-image files, extensions, and selected file IDs.
- Attachments now preserve cached file metadata so sent images/text files appear as file cards instead of plain placeholders.
- Session switching no longer carries over another conversation's pending send state.

### Relay And File Transfer

- Inline images are cached into `tmp/received-files` and included in transcript file refs.
- Inline text files are cached and included in transcript file refs.
- Chunked upload and received-file display paths were tightened for larger browser-to-host transfers.
- Export endpoints can produce filtered Markdown, JSON, and Zip bundles.
- Session details can backfill richer transcript data from Codex rollout files.

### Host Agent And Runtime

- Host agent now has runtime adapter support for Codex app-server, demo runtime, and process runtime.
- API profile normalization/environment creation moved to shared host-agent utilities.
- Managed app-server sessions get isolated Codex home overlays.
- Startup can retry after moving corrupted Codex SQLite state files aside.
- Relay-facing fetch calls have transient retry and timeout handling.

### Documentation

- `README.md` and `README.zh-CN.md` were rewritten as current full guides.
- Windows one-click launcher documentation was added for `start-windows.bat` and `scripts/start-windows.ps1`.
- Developer and host-agent module documentation were updated.

## Verification

Performed before this push:

- `node --check apps/relay/server.js`
- `node --check apps/host-agent/agent.js`
- `node --check apps/host-agent/codex-app-server-runner.js`
- `node --check apps/host-agent/runtime-adapters.js`
- `node --check apps/host-agent/runtime-utils.js`
- `node --check apps/mobile-web/public/app.js`

Blocked by local environment:

- `npm run test:managed` could not start because npm reported `ENOSPC: no space left on device`.

Recommended checks after freeing local disk space:

```bash
node --check apps/relay/server.js
node --check apps/host-agent/agent.js
node --check apps/host-agent/codex-app-server-runner.js
node --check apps/host-agent/runtime-adapters.js
node --check apps/host-agent/runtime-utils.js
node --check apps/mobile-web/public/app.js
npm run test:managed
```

Manual smoke checks:

- Start with `start-windows.bat` on Windows.
- Open the browser UI on desktop and phone-width viewport.
- Send images and local text files and confirm message file cards render.
- Use `Current` and `Others` history import.
- Export Markdown and Zip bundle.
- Switch sessions while sending and confirm pending state stays isolated.
- Refresh model and skill lists manually.
- Trigger plan-mode request-user-input and respond through the popup/form.

## Notes

Relay-level compact prelude injection remains disabled. Context continuity should come from Codex app-server's native compact flow or from explicit conversation-history imports attached by the user.
