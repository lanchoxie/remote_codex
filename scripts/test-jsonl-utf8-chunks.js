const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEX_JSONL_READ_CHUNK_BYTES = '5';
const { readJsonLines, readJsonLinesTail } = require('../shared/jsonl');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-jsonl-utf8-'));
const filePath = path.join(root, 'multibyte.jsonl');
const rows = [
  { id: 1, text: 'ASCII then 中文 boundary' },
  { id: 2, text: 'emoji boundary: 🚀🔧' },
  { id: 3, text: '尾部字符跨分块' },
];
fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

assert.deepStrictEqual(readJsonLines(filePath, 10), rows, 'finite head reads must preserve split UTF-8 sequences');
assert.deepStrictEqual(readJsonLines(filePath, Infinity), rows, 'finite and whole-file head reads must agree');
assert.deepStrictEqual(readJsonLinesTail(filePath, 2), rows.slice(-2), 'finite tail reads must preserve split UTF-8 sequences');
assert.deepStrictEqual(readJsonLinesTail(filePath, Infinity), rows, 'finite and whole-file tail reads must agree');

fs.rmSync(root, { recursive: true, force: true });
console.log('JSONL UTF-8 chunk boundary assertions passed');
