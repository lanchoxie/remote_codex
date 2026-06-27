const fs = require('fs');

const JSONL_READ_CHUNK_BYTES = Number(process.env.CODEX_JSONL_READ_CHUNK_BYTES || 64 * 1024);

function readJsonLines(filePath, maxEntries = Infinity) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  if (Number.isFinite(maxEntries)) {
    return readJsonLinesHeadLimited(filePath, Math.max(0, Number(maxEntries) || 0));
  }

  const text = fs.readFileSync(filePath, 'utf8');
  return parseJsonLines(text.split(/\r?\n/), maxEntries);
}

function readJsonLinesHeadLimited(filePath, maxEntries) {
  if (maxEntries <= 0) {
    return [];
  }

  const entries = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(JSONL_READ_CHUNK_BYTES);
    let offset = 0;
    let pending = '';
    while (entries.length < maxEntries) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) {
        parseJsonLineIntoEntries(pending, entries, maxEntries);
        break;
      }
      offset += bytesRead;
      const text = pending + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split(/\r?\n/);
      pending = lines.pop() || '';
      parseJsonLinesIntoEntries(lines, entries, maxEntries);
    }
  } finally {
    fs.closeSync(fd);
  }
  return entries;
}

function readJsonLinesTail(filePath, maxEntries = Infinity) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  if (Number.isFinite(maxEntries)) {
    return readJsonLinesTailLimited(filePath, Math.max(0, Number(maxEntries) || 0));
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  return parseJsonLinesFromTail(lines, maxEntries);
}

function readJsonLinesTailLimited(filePath, maxEntries) {
  if (maxEntries <= 0) {
    return [];
  }

  const stats = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks = [];
    let offset = stats.size;
    let newlineCount = 0;
    while (offset > 0 && newlineCount <= maxEntries) {
      const length = Math.min(JSONL_READ_CHUNK_BYTES, offset);
      offset -= length;
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      if (bytesRead <= 0) {
        break;
      }
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      chunks.unshift(text);
      newlineCount += (text.match(/\n/g) || []).length;
    }
    return parseJsonLinesFromTail(chunks.join('').split(/\r?\n/), maxEntries);
  } finally {
    fs.closeSync(fd);
  }
}

function parseJsonLines(lines, maxEntries = Infinity) {
  const entries = [];
  parseJsonLinesIntoEntries(lines, entries, maxEntries);
  return entries;
}

function parseJsonLinesFromTail(lines, maxEntries = Infinity) {
  const entries = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (entries.length >= maxEntries) {
      break;
    }

    parseJsonLineIntoEntries(lines[index], entries, maxEntries);
  }

  return entries.reverse();
}

function parseJsonLinesIntoEntries(lines, entries, maxEntries = Infinity) {
  for (const line of lines) {
    if (entries.length >= maxEntries) {
      break;
    }
    parseJsonLineIntoEntries(line, entries, maxEntries);
  }
}

function parseJsonLineIntoEntries(line, entries, maxEntries = Infinity) {
  if (entries.length >= maxEntries) {
    return;
  }

  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return;
  }

  try {
    entries.push(JSON.parse(trimmed));
  } catch (_) {
    // Skip malformed lines.
  }
}

module.exports = {
  readJsonLines,
  readJsonLinesTail,
};
