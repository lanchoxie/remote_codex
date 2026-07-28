const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const unknownPid = Math.trunc(Number(process.env.RELAY_TEST_OWNERSHIP_UNKNOWN_PID || 0));
const raceMarkerPath = String(process.env.RELAY_TEST_OWNERSHIP_RACE_MARKER_PATH || '').trim();
const raceReplacementPath = String(process.env.RELAY_TEST_OWNERSHIP_RACE_REPLACEMENT_PATH || '').trim();
const raceTriggerPath = String(process.env.RELAY_TEST_OWNERSHIP_RACE_TRIGGER_PATH || '').trim();
const raceInjectionPoint = String(process.env.RELAY_TEST_OWNERSHIP_RACE_INJECTION_POINT || 'read').trim();
const writerMarkerPath = String(process.env.RELAY_TEST_OWNERSHIP_WRITER_MARKER_PATH || '').trim();
const writerReplacementPath = String(process.env.RELAY_TEST_OWNERSHIP_WRITER_REPLACEMENT_PATH || '').trim();
const writerAgentEntrypoint = String(process.env.RELAY_TEST_OWNERSHIP_WRITER_AGENT_ENTRYPOINT || '').trim();

const originalReadFileSync = fs.readFileSync.bind(fs);
const originalReadlinkSync = fs.readlinkSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);
const originalSpawn = childProcess.spawn.bind(childProcess);
const originalSpawnSync = childProcess.spawnSync.bind(childProcess);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
let raceInjected = false;
let writerMarkerInjected = false;

function samePath(left, right) {
  return Boolean(left && right && path.resolve(String(left)) === path.resolve(String(right)));
}

function waitForRelayWriterToPublishSpawnedAgentMarker() {
  const publishedMarkerPath = String(process.env.RELAY_MANAGED_MARKER_PATH || writerMarkerPath).trim();
  if (!publishedMarkerPath || !writerAgentEntrypoint || !samePath(process.argv[1], writerAgentEntrypoint)) return;
  const deadline = Date.now() + 30000;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try {
      const marker = JSON.parse(originalReadFileSync(publishedMarkerPath, 'utf8'));
      if (Number(marker?.pid || 0) === process.pid) return;
    } catch (_) {
      // The Relay writer is still assessing/removing the injected marker.
    }
    Atomics.wait(waitCell, 0, 0, 50);
  }
}

waitForRelayWriterToPublishSpawnedAgentMarker();

function accessDenied(target) {
  const error = new Error(`injected process identity access denial for ${target}`);
  error.code = 'EACCES';
  return error;
}

function unknownProcPath(filePath) {
  if (unknownPid <= 0) return false;
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized === `/proc/${unknownPid}/stat`
    || normalized === `/proc/${unknownPid}/cmdline`
    || normalized === `/proc/${unknownPid}/exe`;
}

fs.readFileSync = function injectedReadFileSync(filePath, ...args) {
  if (unknownProcPath(filePath)) {
    throw accessDenied(filePath);
  }

  if (
    !raceInjected
    && raceInjectionPoint === 'read'
    && samePath(filePath, raceMarkerPath)
    && raceReplacementPath
    && (!raceTriggerPath || fs.existsSync(raceTriggerPath))
  ) {
    const original = originalReadFileSync(filePath, ...args);
    const replacement = originalReadFileSync(raceReplacementPath);
    const tempPath = `${raceMarkerPath}.${process.pid}.replacement.tmp`;
    originalWriteFileSync(tempPath, replacement);
    originalRenameSync(tempPath, raceMarkerPath);
    raceInjected = true;
    return original;
  }

  return originalReadFileSync(filePath, ...args);
};

fs.readlinkSync = function injectedReadlinkSync(filePath, ...args) {
  if (unknownProcPath(filePath)) {
    throw accessDenied(filePath);
  }
  return originalReadlinkSync(filePath, ...args);
};

fs.renameSync = function injectedRenameSync(sourcePath, destinationPath, ...args) {
  if (
    !raceInjected
    && raceInjectionPoint === 'rename'
    && samePath(sourcePath, raceMarkerPath)
    && String(destinationPath || '').includes('.stale-claim')
    && raceReplacementPath
    && (!raceTriggerPath || fs.existsSync(raceTriggerPath))
  ) {
    const replacement = originalReadFileSync(raceReplacementPath);
    const tempPath = `${raceMarkerPath}.${process.pid}.replacement.tmp`;
    originalWriteFileSync(tempPath, replacement);
    originalRenameSync(tempPath, raceMarkerPath);
    raceInjected = true;
  }
  return originalRenameSync(sourcePath, destinationPath, ...args);
};

childProcess.spawn = function injectedSpawn(command, args = [], options = {}) {
  const child = originalSpawn(command, args, options);
  const publishedMarkerPath = String(options?.env?.RELAY_MANAGED_MARKER_PATH || writerMarkerPath).trim();
  if (
    !writerMarkerInjected
    && publishedMarkerPath
    && writerReplacementPath
    && writerAgentEntrypoint
    && Array.isArray(args)
    && samePath(args[0], writerAgentEntrypoint)
  ) {
    const replacement = originalReadFileSync(writerReplacementPath);
    originalWriteFileSync(publishedMarkerPath, replacement);
    writerMarkerInjected = true;
  }
  return child;
};

childProcess.spawnSync = function injectedSpawnSync(command, args = [], options = {}) {
  const commandText = [command, ...(Array.isArray(args) ? args : [])].join(' ');
  if (
    unknownPid > 0
    && /powershell(?:\.exe)?/i.test(String(command || ''))
    && commandText.includes(`$targetPid = ${unknownPid}`)
  ) {
    return {
      pid: 0,
      output: [null, '', 'injected access denied'],
      stdout: '',
      stderr: 'injected access denied',
      status: 1,
      signal: null,
      error: accessDenied(command),
    };
  }
  return originalSpawnSync(command, args, options);
};
