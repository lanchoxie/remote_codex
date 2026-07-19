const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { makeCodexRowEvents } = require('./codex-discovery');

const DEFAULT_MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_BATCH = 64;

class CodexSessionTailer {
  constructor(options = {}) {
    this.codexHome = options.codexHome;
    this.hostId = options.hostId;
    this.postEvent = options.postEvent;
    this.postEvents = typeof options.postEvents === 'function' ? options.postEvents : null;
    this.maxBytesPerPoll = Number(options.maxBytesPerPoll || DEFAULT_MAX_BYTES_PER_POLL);
    this.maxEventsPerBatch = Math.max(1, Number(options.maxEventsPerBatch || DEFAULT_MAX_EVENTS_PER_BATCH));
    this.assistantCursorIndex = options.assistantCursorIndex || null;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.files = new Map();
    this.watchedSessions = new Map();
    this.pendingEvents = [];
    this.pendingBatch = null;
    this.batchSequence = 0;
    this.batchIdPrefix = options.batchIdPrefix || `${this.hostId || 'host'}:${process.pid}:${randomUUID()}`;
  }

  prime() {
    const sessions = this.getActiveTailSessions();
    for (const session of sessions) {
      const stats = safeStat(session.rolloutPath);
      if (!stats) {
        continue;
      }
      this.files.set(session.rolloutPath, {
        session,
        offset: stats.size,
        partialBytes: Buffer.alloc(0),
        partialStartOffset: stats.size,
        sourceOrdinal: 0,
        sourceOrdinalKnown: stats.size === 0,
        fileIdentity: tailFileIdentity(session.rolloutPath, stats),
        lastStatSize: stats.size,
        lastMtimeMs: Number(stats.mtimeMs),
        primed: true,
      });
    }
    return { sessionCount: sessions.length };
  }

  setWatchedSessions(sessions = []) {
    const next = new Map();
    for (const session of sessions || []) {
      const normalized = normalizeTailSession(session);
      if (!normalized) {
        continue;
      }
      next.set(normalized.rolloutPath, normalized);
      if (!this.files.has(normalized.rolloutPath)) {
        const stats = safeStat(normalized.rolloutPath);
        this.files.set(normalized.rolloutPath, {
          session: normalized,
          offset: stats?.size || 0,
          partialBytes: Buffer.alloc(0),
          partialStartOffset: stats?.size || 0,
          sourceOrdinal: 0,
          sourceOrdinalKnown: !stats || stats.size === 0,
          fileIdentity: stats ? tailFileIdentity(normalized.rolloutPath, stats) : null,
          lastStatSize: stats?.size || 0,
          lastMtimeMs: stats ? Number(stats.mtimeMs) : null,
          primed: true,
        });
      }
    }
    this.watchedSessions = next;

    for (const filePath of Array.from(this.files.keys())) {
      if (!next.has(filePath)) {
        this.files.delete(filePath);
      }
    }
    return this.watchedSessions.size;
  }

  async poll() {
    const sessions = this.getActiveTailSessions();
    const seenPaths = new Set();
    let newSessionCount = 0;
    let emittedEvents = 0;
    let postedBatchCount = 0;
    let truncated = false;
    let replaced = false;
    postedBatchCount += await this.flushPendingEvents({ flushPartial: true });

    for (const session of sessions) {
      if (!session.rolloutPath) {
        continue;
      }
      seenPaths.add(session.rolloutPath);
      let state = this.files.get(session.rolloutPath);
      if (!state) {
        const stats = safeStat(session.rolloutPath);
        state = {
          session,
          offset: stats?.size || 0,
          partialBytes: Buffer.alloc(0),
          partialStartOffset: stats?.size || 0,
          sourceOrdinal: 0,
          sourceOrdinalKnown: !stats || stats.size === 0,
          fileIdentity: stats ? tailFileIdentity(session.rolloutPath, stats) : null,
          lastStatSize: stats?.size || 0,
          lastMtimeMs: stats ? Number(stats.mtimeMs) : null,
          primed: true,
        };
        this.files.set(session.rolloutPath, state);
        newSessionCount += 1;
        continue;
      } else {
        state.session = {
          ...state.session,
          ...session,
        };
      }

      const stats = safeStat(session.rolloutPath);
      if (!stats) {
        continue;
      }
      const nextFileIdentity = tailFileIdentity(session.rolloutPath, stats);
      if (!state.fileIdentity) {
        state.fileIdentity = nextFileIdentity;
      }
      const identityChanged = Boolean(state.fileIdentity && state.fileIdentity !== nextFileIdentity);
      const fileTruncated = stats.size < state.offset;
      const sameSizeRewrite = Boolean(
        !identityChanged
        && !fileTruncated
        && state.offset > 0
        && stats.size === state.offset
        && state.lastStatSize === stats.size
        && state.lastMtimeMs !== null
        && Number(stats.mtimeMs) !== Number(state.lastMtimeMs)
      );
      if (identityChanged || sameSizeRewrite || fileTruncated) {
        resetTailState(state, nextFileIdentity);
        replaced = replaced || identityChanged || sameSizeRewrite;
        truncated = truncated || fileTruncated;
      }
      if (stats.size === state.offset) {
        state.lastStatSize = stats.size;
        state.lastMtimeMs = Number(stats.mtimeMs);
        continue;
      }

      const readResult = readFileDelta(session.rolloutPath, state.offset, Math.min(stats.size - state.offset, this.maxBytesPerPoll));
      const lines = consumeJsonlLines(state, readResult.buffer, state.offset);
      const fileEvents = [];

      for (const lineEntry of lines) {
        const trimmed = lineEntry.text.trim();
        if (!trimmed) {
          continue;
        }
        let row = null;
        try {
          row = JSON.parse(trimmed);
        } catch (_) {
          continue;
        }
        const events = makeCodexRowEvents(row, {
          nativeThreadId: session.nativeThreadId || session.sessionId,
          rolloutPath: session.rolloutPath,
          sourceOffset: lineEntry.sourceOffset,
          sourceOrdinal: lineEntry.sourceOrdinal,
          observedAt: new Date().toISOString(),
        });
        for (const event of events) {
          if (event.type === 'session.transcript' && event.entry?.assistantObservation) {
            this.assistantCursorIndex?.recordObservation(
              session,
              event.entry.assistantObservation
            );
          }
          const payload = this.makeSessionEvent(session, event, row);
          if (!payload) {
            continue;
          }
          fileEvents.push(payload);
          emittedEvents += 1;
        }
      }
      state.offset = readResult.nextOffset;
      state.lastStatSize = stats.size;
      state.lastMtimeMs = Number(stats.mtimeMs);
      for (const event of fileEvents) {
        this.pendingEvents.push(event);
      }
      postedBatchCount += await this.flushPendingEvents();
    }

    postedBatchCount += await this.flushPendingEvents({ flushPartial: true });

    for (const filePath of Array.from(this.files.keys())) {
      if (!seenPaths.has(filePath)) {
        this.files.delete(filePath);
      }
    }

    return {
      newSessionCount,
      emittedEvents,
      postedBatchCount,
      activeSessionCount: sessions.length,
      truncated,
      replaced,
    };
  }

  getActiveTailSessions() {
    return Array.from(this.watchedSessions.values());
  }

  discoverTailSessions() {
    const sessionsRoot = path.join(this.codexHome, 'sessions');
    const sessions = [];
    walkJsonlFiles(sessionsRoot, (filePath) => {
      const sessionId = parseSessionIdFromFilePath(filePath);
      if (!sessionId) {
        return;
      }
      sessions.push({
        sessionId,
        nativeThreadId: sessionId,
        rolloutPath: filePath,
      });
    });
    return sessions;
  }

  makeSessionEvent(session, event, row) {
    const base = {
      hostId: this.hostId,
      sessionId: session.sessionId,
      nativeThreadId: session.nativeThreadId || session.sessionId,
      source: 'codex-jsonl',
      rolloutPath: session.rolloutPath,
      timestamp: row.timestamp || new Date().toISOString(),
    };

    if (event.type === 'session.transcript') {
      return {
        ...base,
        type: 'session.transcript',
        ...(event.entry || {}),
      };
    }

    if (event.type === 'session.runtime_updated') {
      return {
        ...base,
        type: 'session.runtime_updated',
        patch: event.patch || {},
      };
    }

    if (event.type === 'session.diagnostic') {
      return {
        ...base,
        type: 'session.diagnostic',
        ...(event.entry || {}),
      };
    }
    return null;
  }

  nextBatchId() {
    this.batchSequence += 1;
    return `${this.batchIdPrefix}:${this.batchSequence}`;
  }

  async flushPendingEvents(options = {}) {
    let postedBatchCount = 0;
    while (
      this.pendingBatch
      || this.pendingEvents.length >= this.maxEventsPerBatch
      || (options.flushPartial && this.pendingEvents.length)
    ) {
      if (!this.pendingBatch) {
        const batchSize = Math.min(this.maxEventsPerBatch, this.pendingEvents.length);
        this.pendingBatch = {
          batchId: this.nextBatchId(),
          events: this.pendingEvents.slice(0, batchSize),
        };
      }
      await this.postSessionEvents(this.pendingBatch.events, {
        batchId: this.pendingBatch.batchId,
      });
      this.pendingEvents.splice(0, this.pendingBatch.events.length);
      this.pendingBatch = null;
      postedBatchCount += 1;
    }
    return postedBatchCount;
  }

  async postSessionEvents(events, options = {}) {
    if (!events.length) {
      return;
    }
    if (this.postEvents) {
      await this.postEvents(events, {
        retryOnTransient: true,
        batchId: options.batchId || null,
      });
      return;
    }
    if (typeof this.postEvent !== 'function') {
      return;
    }
    for (const event of events) {
      await this.postEvent(event, { retryOnTransient: true });
    }
  }

  async emitSessionEvent(session, event, row) {
    const payload = this.makeSessionEvent(session, event, row);
    if (payload) {
      await this.postSessionEvents([payload], { batchId: this.nextBatchId() });
    }
  }
}

function normalizeTailSession(session) {
  if (!session || !session.rolloutPath) {
    return null;
  }
  const sessionId = String(session.sessionId || session.nativeThreadId || parseSessionIdFromFilePath(session.rolloutPath) || '').trim();
  if (!sessionId) {
    return null;
  }
  return {
    ...session,
    sessionId,
    nativeThreadId: session.nativeThreadId || sessionId,
    rolloutPath: session.rolloutPath,
  };
}

function readFileDelta(filePath, offset, byteLength) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const bytesRead = fs.readSync(fd, buffer, 0, byteLength, offset);
    return {
      buffer: buffer.subarray(0, bytesRead),
      nextOffset: offset + bytesRead,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function tailFileIdentity(filePath, stats) {
  return [
    String(stats?.dev ?? ''),
    String(stats?.ino ?? ''),
    String(stats?.birthtimeMs ?? ''),
    process.platform === 'win32'
      ? path.resolve(filePath).toLowerCase()
      : path.resolve(filePath),
  ].join(':');
}

function resetTailState(state, fileIdentity) {
  state.offset = 0;
  state.partialBytes = Buffer.alloc(0);
  state.partialStartOffset = 0;
  state.sourceOrdinal = 0;
  state.sourceOrdinalKnown = true;
  state.fileIdentity = fileIdentity;
  state.lastStatSize = 0;
  state.lastMtimeMs = null;
}

function decodeCompleteLine(buffer) {
  const decoder = new StringDecoder('utf8');
  return decoder.write(buffer) + decoder.end();
}

function consumeJsonlLines(state, chunk, baseOffset) {
  const previous = Buffer.isBuffer(state.partialBytes)
    ? state.partialBytes
    : Buffer.from(String(state.partial || ''), 'utf8');
  const combined = previous.length ? Buffer.concat([previous, chunk]) : chunk;
  const combinedStart = previous.length
    ? Number(state.partialStartOffset ?? (baseOffset - previous.length))
    : baseOffset;
  const lines = [];
  let lineStart = 0;
  for (let index = 0; index < combined.length; index += 1) {
    if (combined[index] !== 0x0a) {
      continue;
    }
    let lineEnd = index;
    if (lineEnd > lineStart && combined[lineEnd - 1] === 0x0d) {
      lineEnd -= 1;
    }
    const text = decodeCompleteLine(combined.subarray(lineStart, lineEnd));
    const sourceOffset = combinedStart + lineStart;
    lineStart = index + 1;
    if (!text.trim()) {
      continue;
    }
    state.sourceOrdinal = Math.max(0, Number(state.sourceOrdinal || 0)) + 1;
    lines.push({
      text,
      sourceOffset,
      sourceOrdinal: state.sourceOrdinalKnown ? state.sourceOrdinal : null,
    });
  }
  state.partialBytes = Buffer.from(combined.subarray(lineStart));
  state.partialStartOffset = combinedStart + lineStart;
  delete state.partial;
  return lines;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function walkJsonlFiles(rootDir, visit) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(fullPath, visit);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      visit(fullPath);
    }
  }
}

function parseSessionIdFromFilePath(filePath) {
  const matches = String(path.basename(filePath)).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
  return matches && matches.length ? matches[matches.length - 1] : null;
}

module.exports = {
  CodexSessionTailer,
};
