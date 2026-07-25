function normalizeLinuxArchitecture(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['x86_64', 'amd64', 'x64'].includes(normalized)) return 'x64';
  if (['aarch64', 'arm64'].includes(normalized)) return 'arm64';
  return '';
}

function linuxRuntimeNames(value, options = {}) {
  const architecture = normalizeLinuxArchitecture(value);
  if (!architecture) return null;
  const nodeVersion = String(options.nodeVersion || '16.20.2').trim() || '16.20.2';
  const platformArchitecture = architecture === 'arm64' ? 'arm64' : 'x64';
  const codexArchitecture = architecture === 'arm64' ? 'arm64' : 'x86_64';
  return {
    architecture,
    nodeArchiveName: `node-v${nodeVersion}-linux-${platformArchitecture}.tar.xz`,
    codexDirectoryName: `codex-linux-${codexArchitecture}`,
    bundledCodexDirectory: architecture === 'arm64' ? 'linux-arm64' : 'linux-x86_64',
    cursorPlatformDirectory: architecture === 'arm64' ? 'linux-arm64' : 'linux-x64',
  };
}

module.exports = {
  linuxRuntimeNames,
  normalizeLinuxArchitecture,
};
