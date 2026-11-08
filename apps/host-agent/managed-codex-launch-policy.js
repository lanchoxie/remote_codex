const DEFAULT_FRESH_INITIALIZE_TIMEOUT_MS = 60_000;
const DEFAULT_RESUME_INITIALIZE_TIMEOUT_MS = 180_000;
const DEFAULT_FRESH_THREAD_OPEN_TIMEOUT_MS = 60_000;
const DEFAULT_RESUME_THREAD_OPEN_TIMEOUT_MS = 180_000;

const RESUME_LAUNCH_MODES = new Set([
  'fork',
  'fresh_rebind',
  'resume',
]);

function positiveTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : null;
}

function initializeTimeoutForLaunchMode(launchMode, env = process.env) {
  const mode = String(launchMode || 'fresh').trim().toLowerCase();
  const legacyOverride = positiveTimeout(env.CODEX_RPC_INITIALIZE_TIMEOUT_MS);
  if (RESUME_LAUNCH_MODES.has(mode)) {
    return positiveTimeout(env.CODEX_RPC_INITIALIZE_RESUME_TIMEOUT_MS)
      || legacyOverride
      || DEFAULT_RESUME_INITIALIZE_TIMEOUT_MS;
  }
  return positiveTimeout(env.CODEX_RPC_INITIALIZE_FRESH_TIMEOUT_MS)
    || legacyOverride
    || DEFAULT_FRESH_INITIALIZE_TIMEOUT_MS;
}

function threadOpenTimeoutForLaunchMode(launchMode, env = process.env) {
  const mode = String(launchMode || 'fresh').trim().toLowerCase();
  const legacyOverride = positiveTimeout(env.CODEX_RPC_THREAD_OPEN_TIMEOUT_MS);
  if (RESUME_LAUNCH_MODES.has(mode)) {
    return positiveTimeout(env.CODEX_RPC_THREAD_OPEN_RESUME_TIMEOUT_MS)
      || legacyOverride
      || DEFAULT_RESUME_THREAD_OPEN_TIMEOUT_MS;
  }
  return positiveTimeout(env.CODEX_RPC_THREAD_OPEN_FRESH_TIMEOUT_MS)
    || legacyOverride
    || DEFAULT_FRESH_THREAD_OPEN_TIMEOUT_MS;
}

module.exports = {
  DEFAULT_FRESH_INITIALIZE_TIMEOUT_MS,
  DEFAULT_FRESH_THREAD_OPEN_TIMEOUT_MS,
  DEFAULT_RESUME_INITIALIZE_TIMEOUT_MS,
  DEFAULT_RESUME_THREAD_OPEN_TIMEOUT_MS,
  initializeTimeoutForLaunchMode,
  threadOpenTimeoutForLaunchMode,
};
