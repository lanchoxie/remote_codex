const fs = require('fs');
const path = require('path');
const { readJsonLines, readJsonLinesTail } = require('../shared/jsonl');

const ROOT = path.join(__dirname, '..');
const tmpDir = path.join(ROOT, 'tmp', 'jsonl-tests');
const jsonlPath = path.join(tmpDir, `limited-read-${process.pid}.jsonl`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

fs.mkdirSync(tmpDir, { recursive: true });
fs.writeFileSync(jsonlPath, Array.from({ length: 2000 }, (_, index) => JSON.stringify({
  index,
  text: `line ${index}`,
})).join('\n'), 'utf8');

const originalReadFileSync = fs.readFileSync;
let readFileSyncCalls = 0;
fs.readFileSync = function patchedReadFileSync(...args) {
  readFileSyncCalls += 1;
  return originalReadFileSync.apply(this, args);
};

try {
  const head = readJsonLines(jsonlPath, 3);
  assert(head.length === 3, `limited head read should return 3 rows, got ${head.length}`);
  assert(head[0].index === 0 && head[2].index === 2, `limited head read returned wrong rows: ${JSON.stringify(head)}`);

  const tail = readJsonLinesTail(jsonlPath, 4);
  assert(tail.length === 4, `limited tail read should return 4 rows, got ${tail.length}`);
  assert(tail[0].index === 1996 && tail[3].index === 1999, `limited tail read returned wrong rows: ${JSON.stringify(tail)}`);

  assert(readFileSyncCalls === 0, `limited JSONL reads should not use fs.readFileSync, got ${readFileSyncCalls} calls`);
} finally {
  fs.readFileSync = originalReadFileSync;
  try {
    fs.unlinkSync(jsonlPath);
  } catch (_) {
    // Best-effort cleanup.
  }
}

console.log('jsonl limited read assertions passed');
