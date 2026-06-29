# Install Preflight Runtime Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-friendly Windows setup path that downloads runtime bundles, starts Remote Codex, and blocks local/remote session creation when Codex is not installed or initialized.

**Architecture:** Keep setup as small scripts plus relay/connector preflight checks. Runtime download writes only to `tmp/` caches used by existing bootstrap code. Codex install-helper UI is planned next, with config surfaced through a checked-in defaults file and ignored local override.

**Tech Stack:** PowerShell, Windows batch wrappers, Node.js built-in modules, existing relay and connector actions.

## Global Constraints

- Do not commit secrets, API profiles, connector passwords, or local `tmp` state.
- Runtime binaries remain downloaded/generated artifacts, not source-controlled.
- Startup checks should explain the exact missing item instead of silently starting sessions.
- Remote checks must reuse existing SSH connector actions and askpass flow.
- Keep automatic Codex installation out of this first implementation; show install guidance and configurable paths instead.

---

### Task 1: Runtime Download Entrypoints

**Files:**
- Create: `download-runtimes.bat`
- Create: `scripts/download-runtimes.ps1`
- Modify: `scripts/test-runtime-bundle-paths.js`

**Interfaces:**
- Produces: `scripts/download-runtimes.ps1` with parameters `-Repo`, `-Tag`, `-OutDir`, `-Force`, `-DryRun`.
- Produces: `download-runtimes.bat` that calls the PowerShell script from repo root.

- [ ] Write failing assertions in `scripts/test-runtime-bundle-paths.js` for `download-runtimes.bat`, `scripts/download-runtimes.ps1`, manifest support, and expected tmp output paths.
- [ ] Run `node scripts\test-runtime-bundle-paths.js` and verify it fails because the files are missing.
- [ ] Create `download-runtimes.bat` and `scripts/download-runtimes.ps1`.
- [ ] Run `node scripts\test-runtime-bundle-paths.js` and verify it passes.

### Task 2: Setup And Start Entrypoints

**Files:**
- Create: `Start Remote Codex.bat`
- Create: `Setup and Start Remote Codex.bat`
- Modify: `scripts/start-windows.ps1`
- Modify: `scripts/test-start-windows-script.js`

**Interfaces:**
- Consumes: `scripts/download-runtimes.ps1`.
- Produces: startup preflight call guarded by `-SkipPreflight`.

- [ ] Add failing assertions for the two root bat files and `-SkipPreflight`.
- [ ] Run `npm run test:start-windows` and verify it fails.
- [ ] Add the bat files and script parameter.
- [ ] Run `npm run test:start-windows` and verify it passes.

### Task 3: Local Codex Preflight

**Files:**
- Create: `shared/codex-preflight.js`
- Create: `scripts/test-codex-preflight.js`
- Modify: `package.json`
- Modify: `scripts/start-windows.ps1`

**Interfaces:**
- Produces: `checkLocalCodexPreflight(options)` returning `{ ok, checks, errors, warnings }`.
- Produces: `node scripts/test-codex-preflight.js`.

- [ ] Write tests for missing `codex`, missing `CODEX_HOME`, missing initialization files, and a valid initialized home.
- [ ] Run `node scripts\test-codex-preflight.js` and verify it fails.
- [ ] Implement `shared/codex-preflight.js`.
- [ ] Add `test:codex-preflight` to `package.json`.
- [ ] Wire `scripts/start-windows.ps1` to call `node -e` or a tiny script before starting relay unless `-SkipPreflight`.
- [ ] Run `node scripts\test-codex-preflight.js` and `npm run test:start-windows`.

### Task 4: Remote Codex Preflight

**Files:**
- Modify: `apps/relay/server.js`
- Modify: `shared/connectors.js`
- Modify: `scripts/test-remote-codex-env-resolution.js`

**Interfaces:**
- Consumes: `buildCodexBinResolutionCommand(connector)`.
- Produces: remote diagnostic markers `CODEX_REMOTE_PREFLIGHT_BEGIN`, `CODEX_REMOTE_PREFLIGHT_CODEX`, `CODEX_REMOTE_PREFLIGHT_HOME`, `CODEX_REMOTE_PREFLIGHT_END`.

- [ ] Add failing assertions that remote diagnose/preflight checks Codex CLI, `CODEX_HOME`, initialization files, and writable session directory.
- [ ] Run `npm run test:remote-codex-env` and verify it fails.
- [ ] Extend remote diagnostic command and bootstrap classification with explicit Codex init errors.
- [ ] Run `npm run test:remote-codex-env` and `npm run test:managed`.

### Task 5: Config File Skeleton

**Files:**
- Create: `config/remote-codex.defaults.json`
- Modify: `.gitignore`
- Modify: `README.md`
- Create: `scripts/test-install-config.js`
- Modify: `package.json`

**Interfaces:**
- Produces: defaults for `runtimeReleaseRepo`, `runtimeReleaseTag`, `localCodexHome`, `remoteCodexHome`, `remoteCodexBinHints`.
- Reserves ignored local override path `config/remote-codex.local.json`.

- [ ] Write failing test that defaults exist and local override is ignored.
- [ ] Run `node scripts\test-install-config.js` and verify it fails.
- [ ] Add defaults, ignore local override, and document the next-step install helper.
- [ ] Run `node scripts\test-install-config.js`.

### Task 6: Verification And Release Prep

**Files:**
- Modify only files already touched by tasks above.

- [ ] Run `node --check apps\relay\server.js`.
- [ ] Run `node --check shared\connectors.js`.
- [ ] Run `npm run test:remote-codex-env`.
- [ ] Run `npm run test:codex-preflight`.
- [ ] Run `npm run test:start-windows`.
- [ ] Run `npm run test:managed`.
- [ ] Run `npm run test:export-dialog`.
- [ ] Run `git -c safe.directory=D:/project/cursor_english_dev/remote_codex diff --check`.
- [ ] Commit and push.
