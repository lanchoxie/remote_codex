const fs = require('fs');

function readJsonLines(filePath, maxEntries = Infinity) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const entries = [];

  for (const line of lines) {
    if (entries.length >= maxEntries) {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      // Skip malformed lines.
    }
  }

  return entries;
}

module.exports = {
  readJsonLines,
};
