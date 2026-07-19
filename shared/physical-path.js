const fs = require('fs');
const path = require('path');

function realpathSync(value) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(value)
    : fs.realpathSync(value);
}

function canonicalPhysicalPath(value) {
  const resolved = path.resolve(value);
  const missingSegments = [];
  let cursor = resolved;

  for (;;) {
    try {
      const existingAncestor = realpathSync(cursor);
      return path.normalize(path.join(existingAncestor, ...missingSegments.reverse()));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function comparablePhysicalPath(value) {
  const canonical = canonicalPhysicalPath(value);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function physicalPathIsInside(parent, child) {
  const canonicalParent = comparablePhysicalPath(parent);
  const canonicalChild = comparablePhysicalPath(child);
  const relative = path.relative(canonicalParent, canonicalChild);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function physicalPathsOverlap(left, right) {
  return physicalPathIsInside(left, right) || physicalPathIsInside(right, left);
}

module.exports = {
  canonicalPhysicalPath,
  comparablePhysicalPath,
  physicalPathIsInside,
  physicalPathsOverlap,
};
