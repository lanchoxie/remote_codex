const fs = require('fs');
const path = require('path');

const diagnosticsPath = String(process.env.RELAY_TEST_DIAGNOSTICS_PATH || '').trim();
const diagnosticsMarkerPath = String(process.env.RELAY_TEST_DIAGNOSTICS_MARKER_PATH || '').trim();
const diagnosticsDelayMs = Math.max(
  0,
  Number(process.env.RELAY_TEST_DIAGNOSTICS_DELAY_MS || 0) || 0
);
const diagnosticsFailOnce = process.env.RELAY_TEST_DIAGNOSTICS_FAIL_ONCE === '1';
const dismissedHostsPath = String(process.env.RELAY_TEST_DISMISSED_HOSTS_PATH || '').trim();
const dismissedFailureTrigger = String(process.env.RELAY_TEST_DISMISSED_FAILURE_TRIGGER || '').trim();

const originalPromisesWriteFile = fs.promises.writeFile.bind(fs.promises);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
let diagnosticsAttempts = 0;
let dismissedWriteFailed = false;

function samePath(left, right) {
  return Boolean(left && right && path.resolve(String(left)) === path.resolve(String(right)));
}

fs.promises.writeFile = async function injectedPromisesWriteFile(filePath, ...args) {
  if (samePath(filePath, diagnosticsPath)) {
    diagnosticsAttempts += 1;
    if (diagnosticsMarkerPath) {
      originalWriteFileSync(diagnosticsMarkerPath, `${diagnosticsAttempts}\n`, 'utf8');
    }
    if (diagnosticsFailOnce && diagnosticsAttempts === 1) {
      const error = new Error('injected diagnostics write failure');
      error.code = 'EIO';
      throw error;
    }
    if (diagnosticsDelayMs > 0 && diagnosticsAttempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, diagnosticsDelayMs));
    }
  }
  return originalPromisesWriteFile(filePath, ...args);
};

fs.writeFileSync = function injectedWriteFileSync(filePath, ...args) {
  const resolved = path.resolve(String(filePath));
  const dismissedPrefix = dismissedHostsPath
    ? `${path.resolve(dismissedHostsPath)}.`
    : '';
  if (
    !dismissedWriteFailed
    && dismissedPrefix
    && resolved.startsWith(dismissedPrefix)
    && resolved.endsWith('.tmp')
    && dismissedFailureTrigger
    && fs.existsSync(dismissedFailureTrigger)
  ) {
    dismissedWriteFailed = true;
    const error = new Error('injected dismissed Host write failure');
    error.code = 'EIO';
    throw error;
  }
  return originalWriteFileSync(filePath, ...args);
};
