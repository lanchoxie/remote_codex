# Software Update UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings update panel that can check the latest stable Git tag, apply a guarded update while preserving local data, and optionally restart Windows relay/agent after confirmation.

**Architecture:** Add a small relay-side updater module that owns git status, latest-tag selection, backup creation, update application, and delayed restart scheduling. The relay exposes narrow `/api/update/*` endpoints consumed by a compact Settings section. Browser localStorage remains untouched by server updates.

**Tech Stack:** Node.js CommonJS, built-in `fs`, `path`, and `child_process`; existing static mobile web app; PowerShell restart script on Windows.

## Global Constraints

- Update target defaults to latest stable semver tag, not `origin/main`.
- One-click update must back up local relay data under `tmp/update-backups/YYYYMMDD-HHMMSS/` before changing code.
- Do not modify `tmp/` user data, browser localStorage, `.codex/`, or user session JSONL files during update.
- If tracked files are dirty, block update and report changed files.
- Restart is a separate explicit action after update; do not synchronously kill the relay from the update request.
- No new npm dependencies.

---

### Task 1: Relay Updater Core

**Files:**
- Create: `shared/updater.js`
- Create: `scripts/test-software-update.js`

**Interfaces:**
- Produces:
  - `getLocalUpdateStatus(options): object`
  - `checkForUpdates(options): object`
  - `applyStableTagUpdate(options): object`
  - `scheduleWindowsRestart(options): object`

- [ ] **Step 1: Write failing tests**

Create `scripts/test-software-update.js` with tests that use a temporary git repository and assert:

- stable tag selection ignores beta/rc tags.
- dirty tracked files block update.
- update backs up relay data files before checkout.
- restart scheduling returns a detached command description instead of running inline.

Run: `node scripts\test-software-update.js`
Expected: FAIL because `shared/updater.js` does not exist.

- [ ] **Step 2: Implement updater core**

Create `shared/updater.js` with:

- safe git command wrapper using `spawnSync` with argument arrays.
- semver stable tag parser for `vX.Y.Z`.
- backup copy for existing local data paths.
- update flow: status -> dirty guard -> backup -> `git fetch --tags origin` -> `git checkout <tag>`.
- delayed restart scheduler using detached PowerShell on Windows.

- [ ] **Step 3: Verify**

Run: `node scripts\test-software-update.js`
Expected: PASS.

### Task 2: Relay API

**Files:**
- Modify: `apps/relay/server.js`
- Modify: `scripts/test-software-update.js`

**Interfaces:**
- Produces:
  - `GET /api/update/status`
  - `POST /api/update/apply`
  - `POST /api/update/restart`

- [ ] **Step 1: Extend failing tests**

Add static route assertions to `scripts/test-software-update.js`:

- `server.js` imports updater helpers.
- `GET /api/update/status` exists.
- `POST /api/update/apply` exists.
- `POST /api/update/restart` exists.

Run: `node scripts\test-software-update.js`
Expected: FAIL until routes exist.

- [ ] **Step 2: Add routes**

Add authenticated API routes near other relay JSON APIs:

- status returns current package version, root path, current commit/tag, dirty files, latest stable tag, and update availability.
- apply performs backup/update and returns target tag and backup path.
- restart schedules `scripts/start-windows.ps1 -Restart` and returns accepted status.

- [ ] **Step 3: Verify**

Run: `node scripts\test-software-update.js`
Expected: PASS.

### Task 3: Settings UI

**Files:**
- Modify: `apps/mobile-web/public/index.html`
- Modify: `apps/mobile-web/public/app.js`
- Modify: `apps/mobile-web/public/styles.css`
- Modify: `scripts/test-software-update.js`

**Interfaces:**
- Consumes: Relay update endpoints from Task 2.
- Produces: Settings panel controls and UI state.

- [ ] **Step 1: Extend failing tests**

Add static assertions that:

- Settings dialog contains `settings-update-section`.
- UI has buttons `check-update-button`, `apply-update-button`, and `restart-after-update-button`.
- `app.js` calls `/api/update/status`, `/api/update/apply`, and `/api/update/restart`.
- UI copy mentions backups and restart requirement.

Run: `node scripts\test-software-update.js`
Expected: FAIL until UI exists.

- [ ] **Step 2: Add UI**

Add the update section at the top of the Settings dialog. Add state/render helpers in `app.js`:

- `refreshSoftwareUpdateStatus()`
- `applySoftwareUpdate()`
- `restartAfterSoftwareUpdate()`
- `renderSoftwareUpdatePanel()`

Disable apply when dirty tracked files exist or no update is available.

- [ ] **Step 3: Verify**

Run: `node scripts\test-software-update.js`
Expected: PASS.

### Task 4: Regression Verification

**Files:**
- No new production files unless tests expose a defect.

- [ ] **Step 1: Syntax and targeted tests**

Run:

```powershell
node scripts\test-software-update.js
node --check apps\relay\server.js
node --check apps\mobile-web\public\app.js
npm run test:managed
npm run test:export-dialog
git -c safe.directory=D:/project/cursor_english_dev/remote_codex diff --check
```

Expected: all pass.

- [ ] **Step 2: Manual safety review**

Confirm `git status --short` only shows intended files plus unrelated pre-existing untracked files.
