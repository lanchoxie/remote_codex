# Mobile Web Module

Path: `apps/mobile-web/public`

## Purpose

The mobile web module is the phone-first control UI. It is currently a static no-build frontend served by the relay.

## Files

- `index.html`: layout and modal structure.
- `styles.css`: responsive mobile/desktop styling.
- `app.js`: state, API client, rendering, SSE handling, and user actions.
- `manifest.json`: PWA metadata.

## Main UI areas

- Overview and host list.
- Selected host session list.
- New session in directory.
- Directory picker.
- Conversation detail and variants.
- Live runtime panel.
- Chat transcript with in-flow thinking cards.
- Bottom composer inside the transcript panel.
- Alerts window.
- Full status modal.
- HPC connector manager.

## Data flow

1. `refresh()` loads stats, hosts, connectors, and sessions.
2. Selecting a live session opens an SSE stream through `subscribeSession()`.
3. SSE events update transcript, alerts, runtime, diagnostics, and requests.
4. User actions call relay APIs.

## Important functions

- `refresh()`
- `renderAll()`
- `renderHostNav()`
- `renderConversationNav()`
- `renderSessionDetails()`
- `renderRuntimePanel()`
- `renderTranscript()`
- `renderStatusWindow()`
- `renderDirectoryPicker()`
- `renderConnectorManager()`
- `startManagedSession()`
- `sendInput()`

## Known gaps

- No authentication UI.
- No native Android shell.
- No push notifications.
- No offline queue.
- No full request-user-input form builder for every possible Codex request shape.
- No file editor.

