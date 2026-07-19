const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stripSecrets } = require('../../shared/secret-redaction');

const AUDIT_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function eventHash(record) {
  const { hash, ...unsigned } = record;
  return digest(JSON.stringify(unsigned));
}

function normalizeLimit(value, fallback = 100) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 1000) : fallback;
}

class SkillAuditLog {
  constructor(options = {}) {
    if (!options.auditPath) throw new TypeError('auditPath is required');
    this.auditPath = path.resolve(options.auditPath);
    this.now = options.now || (() => new Date().toISOString());
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.events = this.load();
  }

  load() {
    let source;
    try {
      source = fs.readFileSync(this.auditPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`failed to read Skill audit log: ${error.message}`);
    }
    const events = [];
    let previousHash = '';
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid Skill audit JSON at line ${index + 1}: ${error.message}`);
      }
      const expectedSequence = events.length + 1;
      if (
        record?.version !== AUDIT_VERSION
        || record.sequence !== expectedSequence
        || String(record.previousHash || '') !== previousHash
        || eventHash(record) !== record.hash
      ) {
        throw new Error(`invalid Skill audit chain at line ${index + 1}`);
      }
      events.push(record);
      previousHash = record.hash;
    }
    return events;
  }

  append(type, data = {}, options = {}) {
    const eventType = String(type || '').trim().slice(0, 160);
    if (!eventType) throw new TypeError('audit event type is required');
    const previous = this.events[this.events.length - 1] || null;
    const record = {
      version: AUDIT_VERSION,
      sequence: this.events.length + 1,
      eventId: String(options.eventId || this.idFactory()).slice(0, 240),
      timestamp: String(options.timestamp || this.now()),
      type: eventType,
      actor: String(options.actor || 'relay').slice(0, 160),
      subject: options.subject == null ? null : String(options.subject).slice(0, 512),
      data: stripSecrets(clone(data) || {}),
      previousHash: previous?.hash || '',
    };
    record.hash = eventHash(record);
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    const fd = fs.openSync(this.auditPath, 'a', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.events.push(record);
    return clone(record);
  }

  query(options = {}) {
    const afterSequence = Math.max(0, Number(options.afterSequence || 0) || 0);
    const limit = normalizeLimit(options.limit);
    const type = String(options.type || '').trim();
    const matches = this.events.filter((event) => (
      event.sequence > afterSequence && (!type || event.type === type)
    ));
    const events = matches.slice(0, limit).map(clone);
    return {
      events,
      hasMore: matches.length > events.length,
      nextAfterSequence: events.at(-1)?.sequence || afterSequence,
      latestSequence: this.events.at(-1)?.sequence || 0,
      latestHash: this.events.at(-1)?.hash || '',
    };
  }
}

module.exports = {
  AUDIT_VERSION,
  SkillAuditLog,
  eventHash,
};
