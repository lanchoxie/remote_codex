const fs = require('fs');
const path = require('path');
const {
  recoverMissingFileFromBackup,
  replaceFileWithBackup,
} = require('./atomic-file-replace');

function normalizedText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function ledgerConflict(message) {
  const error = new Error(message);
  error.code = 'agent_event_batch_id_conflict';
  return error;
}

class AgentEventLedger {
  constructor(options = {}) {
    this.filePath = path.resolve(String(options.filePath || ''));
    if (!options.filePath) {
      throw new TypeError('AgentEventLedger filePath is required');
    }
    this.limit = Math.max(1, Math.trunc(Number(options.limit || 10_000)) || 10_000);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.applied = new Map();
    this.partial = new Map();
    this.operationCount = 0;
    if (options.autoLoad !== false) {
      this.load();
    }
  }

  validateIdentity(batchKeyInput, digestInput) {
    const batchKey = normalizedText(batchKeyInput, 1024);
    const digest = normalizedText(digestInput, 128);
    if (!batchKey || !digest) {
      throw new TypeError('Agent event batch key and digest are required');
    }
    return { batchKey, digest };
  }

  touch(map, key, value) {
    map.delete(key);
    map.set(key, value);
  }

  applyRecord(record) {
    if (Number(record?.version) !== 1) {
      throw new Error('unsupported Agent event ledger record version');
    }
    const { batchKey, digest } = this.validateIdentity(record.batchKey, record.digest);
    if (record.op === 'applied') {
      const existing = this.applied.get(batchKey) || this.partial.get(batchKey);
      if (existing && existing.digest !== digest) {
        throw ledgerConflict(`Agent event ledger digest conflict for ${batchKey}`);
      }
      this.partial.delete(batchKey);
      this.touch(this.applied, batchKey, {
        digest,
        appliedAt: Number(record.at || this.now()),
      });
      return;
    }
    if (record.op === 'partial') {
      const appliedCount = Math.max(0, Math.trunc(Number(record.appliedCount || 0)));
      if (appliedCount <= 0) {
        throw new Error('invalid Agent event ledger partial count');
      }
      const applied = this.applied.get(batchKey);
      if (applied) {
        if (applied.digest !== digest) {
          throw ledgerConflict(`Agent event ledger digest conflict for ${batchKey}`);
        }
        return;
      }
      const existing = this.partial.get(batchKey);
      if (existing && existing.digest !== digest) {
        throw ledgerConflict(`Agent event ledger digest conflict for ${batchKey}`);
      }
      if (!existing || appliedCount > existing.appliedCount) {
        this.touch(this.partial, batchKey, {
          digest,
          appliedCount,
          updatedAt: Number(record.at || this.now()),
        });
      }
      return;
    }
    throw new Error(`unsupported Agent event ledger operation: ${record?.op || '(missing)'}`);
  }

  load() {
    this.applied.clear();
    this.partial.clear();
    this.operationCount = 0;
    let raw = '';
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const recovered = recoverMissingFileFromBackup(this.filePath);
        if (!recovered.recovered) return;
        raw = fs.readFileSync(this.filePath, 'utf8');
      } else {
        throw error;
      }
    }
    const terminated = /\r?\n$/.test(raw);
    const lines = raw.split(/\r?\n/);
    let truncatedTail = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        this.applyRecord(JSON.parse(line));
        this.operationCount += 1;
      } catch (error) {
        const isTruncatedTail = index === lines.length - 1 && !terminated;
        if (isTruncatedTail) {
          truncatedTail = true;
          break;
        }
        throw new Error(`invalid Agent event ledger line ${index + 1}: ${error.message || error}`);
      }
    }
    const pruned = this.enforceBounds();
    if (truncatedTail || pruned || this.operationCount > this.limit * 2) {
      this.compact();
    }
  }

  enforceBounds() {
    let pruned = false;
    while (this.applied.size > this.limit) {
      this.applied.delete(this.applied.keys().next().value);
      pruned = true;
    }
    while (this.partial.size > this.limit) {
      this.partial.delete(this.partial.keys().next().value);
      pruned = true;
    }
    return pruned;
  }

  append(record) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.operationCount += 1;
  }

  recordApplied(batchKeyInput, digestInput) {
    const { batchKey, digest } = this.validateIdentity(batchKeyInput, digestInput);
    const existing = this.applied.get(batchKey);
    if (existing) {
      if (existing.digest !== digest) {
        throw ledgerConflict(`Agent event batch ID ${batchKey} has a different digest`);
      }
      return false;
    }
    const partial = this.partial.get(batchKey);
    if (partial && partial.digest !== digest) {
      throw ledgerConflict(`Agent event batch ID ${batchKey} has a different digest`);
    }
    const record = {
      version: 1,
      op: 'applied',
      batchKey,
      digest,
      at: this.now(),
    };
    this.append(record);
    this.applyRecord(record);
    this.compactIfNeeded();
    return true;
  }

  recordPartial(batchKeyInput, digestInput, appliedCountInput) {
    const { batchKey, digest } = this.validateIdentity(batchKeyInput, digestInput);
    const appliedCount = Math.max(0, Math.trunc(Number(appliedCountInput || 0)));
    if (appliedCount <= 0) return false;
    const applied = this.applied.get(batchKey);
    if (applied) {
      if (applied.digest !== digest) {
        throw ledgerConflict(`Agent event batch ID ${batchKey} has a different digest`);
      }
      return false;
    }
    const current = this.partial.get(batchKey);
    if (current?.digest && current.digest !== digest) {
      throw ledgerConflict(`Agent event batch ID ${batchKey} has a different digest`);
    }
    if (current && current.appliedCount >= appliedCount) return false;
    const record = {
      version: 1,
      op: 'partial',
      batchKey,
      digest,
      appliedCount,
      at: this.now(),
    };
    this.append(record);
    this.applyRecord(record);
    this.compactIfNeeded();
    return true;
  }

  compactIfNeeded() {
    this.enforceBounds();
    if (this.operationCount > this.limit * 2) {
      this.compact();
    }
  }

  compact() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const records = [
      ...Array.from(this.partial, ([batchKey, entry]) => ({
        version: 1,
        op: 'partial',
        batchKey,
        digest: entry.digest,
        appliedCount: entry.appliedCount,
        at: entry.updatedAt,
      })),
      ...Array.from(this.applied, ([batchKey, entry]) => ({
        version: 1,
        op: 'applied',
        batchKey,
        digest: entry.digest,
        at: entry.appliedAt,
      })),
    ];
    let fd = null;
    try {
      fd = fs.openSync(tempPath, 'wx');
      fs.writeFileSync(fd, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      replaceFileWithBackup(tempPath, this.filePath);
      this.operationCount = records.length;
    } finally {
      if (fd != null) fs.closeSync(fd);
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

module.exports = {
  AgentEventLedger,
};
