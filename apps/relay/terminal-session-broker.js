const crypto = require('crypto');

const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_SESSIONS_PER_HOST = 8;
const DEFAULT_BUFFER_BYTES = 512 * 1024;
const DEFAULT_NO_SUBSCRIBER_GRACE_MS = 30 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function brokerError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function boundedText(value, limit = 512) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function normalizeIdentity(value, name, limit = 512) {
  const result = boundedText(value, limit);
  if (!result) throw brokerError(`terminal_${name}_required`, `${name} is required.`, 400);
  return result;
}

function normalizeTerminalId(value) {
  const terminalId = boundedText(value, 160);
  if (!terminalId || !/^[A-Za-z0-9._:-]+$/.test(terminalId)) {
    throw brokerError('terminal_id_invalid', 'A valid terminalId is required.', 400);
  }
  return terminalId;
}

function normalizeDimension(value, fallback, minimum, maximum) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, number))
    : fallback;
}

class TerminalSessionBroker {
  constructor(options = {}) {
    this.maxSessions = Math.max(1, Number(options.maxSessions || DEFAULT_MAX_SESSIONS) || DEFAULT_MAX_SESSIONS);
    this.maxSessionsPerHost = Math.max(
      1,
      Number(options.maxSessionsPerHost || DEFAULT_MAX_SESSIONS_PER_HOST) || DEFAULT_MAX_SESSIONS_PER_HOST
    );
    this.bufferBytes = Math.max(32 * 1024, Number(options.bufferBytes || DEFAULT_BUFFER_BYTES) || DEFAULT_BUFFER_BYTES);
    this.noSubscriberGraceMs = Math.max(
      1000,
      Number(options.noSubscriberGraceMs || DEFAULT_NO_SUBSCRIBER_GRACE_MS) || DEFAULT_NO_SUBSCRIBER_GRACE_MS
    );
    this.idleTimeoutMs = Math.max(
      60 * 1000,
      Number(options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS) || DEFAULT_IDLE_TIMEOUT_MS
    );
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.makeId = typeof options.makeId === 'function'
      ? options.makeId
      : () => crypto.randomBytes(18).toString('base64url');
    this.requestHostClose = typeof options.requestHostClose === 'function'
      ? options.requestHostClose
      : () => {};
    this.sessions = new Map();
  }

  countForHost(hostId) {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.hostId === hostId && record.status !== 'closed') count += 1;
    }
    return count;
  }

  create(input = {}) {
    const hostId = normalizeIdentity(input.hostId, 'hostId', 160);
    const sessionId = normalizeIdentity(input.sessionId, 'sessionId');
    const cwd = normalizeIdentity(input.cwd, 'cwd', 32 * 1024);
    if (this.sessions.size >= this.maxSessions) {
      throw brokerError('terminal_global_limit', `The Relay already has ${this.maxSessions} active terminals.`, 429);
    }
    if (this.countForHost(hostId) >= this.maxSessionsPerHost) {
      throw brokerError('terminal_host_limit', `This Host already has ${this.maxSessionsPerHost} active terminals.`, 429);
    }
    let terminalId;
    do {
      terminalId = normalizeTerminalId(input.terminalId || this.makeId());
    } while (this.sessions.has(terminalId) && !input.terminalId);
    if (this.sessions.has(terminalId)) {
      throw brokerError('terminal_id_conflict', 'terminalId is already active.');
    }
    const nowMs = this.now();
    const record = {
      terminalId,
      hostId,
      sessionId,
      cwd,
      cols: normalizeDimension(input.cols, 100, 20, 500),
      rows: normalizeDimension(input.rows, 30, 5, 300),
      status: 'opening',
      platform: null,
      shell: null,
      pid: null,
      error: null,
      createdAtMs: nowMs,
      lastActivityAtMs: nowMs,
      lastSubscriberAtMs: nowMs,
      lastHostSequence: 0,
      eventSequence: 0,
      bufferedBytes: 0,
      events: [],
      subscribers: new Set(),
      closeRequested: false,
    };
    this.sessions.set(terminalId, record);
    this.appendEvent(record, 'opening', this.publicRecord(record));
    return this.publicRecord(record);
  }

  get(terminalId) {
    return this.sessions.get(String(terminalId || '')) || null;
  }

  requireBound(input = {}) {
    const terminalId = normalizeTerminalId(input.terminalId);
    const record = this.sessions.get(terminalId);
    if (!record) throw brokerError('terminal_not_found', 'The terminal is no longer active.', 404);
    if (input.hostId && record.hostId !== String(input.hostId)) {
      throw brokerError('terminal_host_mismatch', 'The terminal does not belong to this Host.', 404);
    }
    if (input.sessionId && record.sessionId !== String(input.sessionId)) {
      throw brokerError('terminal_session_mismatch', 'The terminal does not belong to this Session.', 404);
    }
    return record;
  }

  publicRecord(record) {
    return {
      terminalId: record.terminalId,
      hostId: record.hostId,
      sessionId: record.sessionId,
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      status: record.status,
      platform: record.platform,
      shell: record.shell,
      pid: record.pid,
      error: record.error,
      createdAt: new Date(record.createdAtMs).toISOString(),
    };
  }

  appendEvent(record, type, payload) {
    record.eventSequence += 1;
    const event = {
      id: record.eventSequence,
      type,
      payload,
      bytes: Buffer.byteLength(JSON.stringify(payload || {}), 'utf8'),
    };
    record.events.push(event);
    record.bufferedBytes += event.bytes;
    while (record.events.length > 1 && record.bufferedBytes > this.bufferBytes) {
      const removed = record.events.shift();
      record.bufferedBytes = Math.max(0, record.bufferedBytes - removed.bytes);
    }
    for (const listener of Array.from(record.subscribers)) {
      try {
        listener(event);
      } catch (_) {
        record.subscribers.delete(listener);
      }
    }
    return event;
  }

  subscribe(input = {}, listener) {
    if (typeof listener !== 'function') {
      throw brokerError('terminal_listener_required', 'A terminal event listener is required.', 500);
    }
    const record = this.requireBound(input);
    const after = Math.max(0, Math.trunc(Number(input.after || 0)) || 0);
    record.subscribers.add(listener);
    record.lastSubscriberAtMs = this.now();
    record.lastActivityAtMs = this.now();
    const replay = record.events.filter((event) => event.id > after);
    let active = true;
    return {
      record: this.publicRecord(record),
      replay,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        record.subscribers.delete(listener);
        record.lastSubscriberAtMs = this.now();
      },
    };
  }

  touch(input = {}) {
    const record = this.requireBound(input);
    record.lastActivityAtMs = this.now();
    return record;
  }

  resize(input = {}) {
    const record = this.touch(input);
    record.cols = normalizeDimension(input.cols, record.cols, 20, 500);
    record.rows = normalizeDimension(input.rows, record.rows, 5, 300);
    return this.publicRecord(record);
  }

  requestClose(input = {}) {
    const record = this.requireBound(input);
    if (!record.closeRequested && record.status !== 'closed') {
      record.closeRequested = true;
      record.status = 'closing';
      record.lastActivityAtMs = this.now();
      this.appendEvent(record, 'closing', {
        ...this.publicRecord(record),
        reason: boundedText(input.reason || 'client-close', 160),
      });
      this.requestHostClose(this.publicRecord(record), input.reason || 'client-close');
    }
    return this.publicRecord(record);
  }

  acceptHostEvent(event = {}) {
    const terminalId = normalizeTerminalId(event.terminalId);
    const record = this.sessions.get(terminalId);
    if (!record) return { accepted: false, reason: 'missing' };
    if (
      record.hostId !== boundedText(event.hostId, 160)
      || record.sessionId !== boundedText(event.sessionId)
    ) {
      return { accepted: false, reason: 'identity_mismatch' };
    }
    record.lastActivityAtMs = this.now();
    const type = String(event.type || '');
    if (type === 'host.terminal.opened') {
      if (record.status === 'closed') return { accepted: false, reason: 'closed' };
      record.status = 'open';
      record.platform = boundedText(event.platform, 32) || null;
      record.shell = boundedText(event.shell, 160) || null;
      record.pid = Number(event.pid || 0) || null;
      record.cols = normalizeDimension(event.cols, record.cols, 20, 500);
      record.rows = normalizeDimension(event.rows, record.rows, 5, 300);
      this.appendEvent(record, 'opened', this.publicRecord(record));
      return { accepted: true, record: this.publicRecord(record) };
    }
    if (type === 'host.terminal.output') {
      const hostSequence = Math.max(0, Math.trunc(Number(event.sequence || 0)) || 0);
      if (hostSequence && hostSequence <= record.lastHostSequence) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (hostSequence) record.lastHostSequence = hostSequence;
      const data = String(event.data == null ? '' : event.data);
      if (!data) return { accepted: false, reason: 'empty' };
      this.appendEvent(record, 'output', {
        terminalId,
        sequence: hostSequence || null,
        data,
      });
      return { accepted: true, record: this.publicRecord(record) };
    }
    if (type === 'host.terminal.error') {
      record.status = 'error';
      record.error = {
        code: boundedText(event.code || 'terminal_failed', 160),
        message: boundedText(event.error || event.message || 'The terminal failed.', 4096),
      };
      this.appendEvent(record, 'error', {
        ...this.publicRecord(record),
        error: record.error,
      });
      return { accepted: true, record: this.publicRecord(record) };
    }
    if (type === 'host.terminal.closed') {
      return { accepted: true, record: this.finalize(record, event.reason || 'host-close', event) };
    }
    return { accepted: false, reason: 'unsupported_type' };
  }

  finalize(record, reason = 'closed', extra = {}) {
    if (!record || record.status === 'closed') return record ? this.publicRecord(record) : null;
    record.status = 'closed';
    record.closeRequested = true;
    this.appendEvent(record, 'closed', {
      ...this.publicRecord(record),
      reason: boundedText(reason, 160),
      exitCode: Number.isFinite(Number(extra.exitCode)) ? Number(extra.exitCode) : null,
      signal: Number.isFinite(Number(extra.signal)) ? Number(extra.signal) : null,
    });
    const publicRecord = this.publicRecord(record);
    const retention = setTimeout(() => {
      if (this.sessions.get(record.terminalId) === record) this.sessions.delete(record.terminalId);
    }, Math.min(this.noSubscriberGraceMs, 10_000));
    retention.unref?.();
    return publicRecord;
  }

  sweep(options = {}) {
    const nowMs = this.now();
    const isHostOnline = typeof options.isHostOnline === 'function' ? options.isHostOnline : () => true;
    let requested = 0;
    for (const record of this.sessions.values()) {
      if (record.status === 'closed') continue;
      let reason = '';
      if (!isHostOnline(record.hostId)) reason = 'host-offline';
      else if (nowMs - record.lastActivityAtMs >= this.idleTimeoutMs) reason = 'idle-timeout';
      else if (!record.subscribers.size && nowMs - record.lastSubscriberAtMs >= this.noSubscriberGraceMs) {
        reason = 'client-disconnected';
      }
      if (reason && !record.closeRequested) {
        this.requestClose({ terminalId: record.terminalId, reason });
        requested += 1;
      }
    }
    return requested;
  }

  closeAll(reason = 'relay-shutdown') {
    for (const record of Array.from(this.sessions.values())) {
      if (record.status !== 'closed') {
        this.requestClose({ terminalId: record.terminalId, reason });
      }
    }
  }
}

module.exports = {
  TerminalSessionBroker,
  brokerError,
  normalizeTerminalId,
};
