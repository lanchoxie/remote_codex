const fs = require('fs');
const path = require('path');
const { makeCodexRowEvents } = require('./codex-discovery');

const DEFAULT_MAX_BYTES_PER_POLL = 4 * 1024 * 1024;

class CodexSessionTailer {
  constructor(options = {}) {
    this.codexHome = options.codexHome;
    this.hostId = options.hostId;
    this.postEvent = options.postEvent;
    this.maxBytesPerPoll = Number(options.maxBytesPerPoll || DEFAULT_MAX_BYTES_PER_POLL);
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.files = new Map();
  }

  prime() {
    const sessions = this.discoverTailSessions();
    for (const session of sessions) {
      const stats = safeStat(session.rolloutPath);
      if (!stats) {
        continue;
      }
      this.files.set(session.rolloutPath, {
        session,
        offset: stats.size,
        partial: '',
        primed: true,
      });
    }
    return { sessionCount: sessions.length };
  }

  async poll() {
    const sessions = this.discoverTailSessions();
    const seenPaths = new Set();
    let newSessionCount = 0;
    let emittedEvents = 0;

    for (const session of sessions) {
      if (!session.rolloutPath) {
        continue;
      }
      seenPaths.add(session.rolloutPath);
      let state = this.files.get(session.rolloutPath);
      if (!state) {
        state = {
          session,
          offset: 0,
          partial: '',
          primed: false,
        };
        this.files.set(session.rolloutPath, state);
        newSessionCount += 1;
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
      if (stats.size < state.offset) {
        state.offset = 0;
        state.partial = '';
      }
      if (stats.size === state.offset) {
        continue;
      }

      const readResult = readFileDelta(session.rolloutPath, state.offset, Math.min(stats.size - state.offset, this.maxBytesPerPoll));
      state.offset = readResult.nextOffset;
      const text = `${state.partial || ''}${readResult.text || ''}`;
      const complete = text.endsWith('\n') || text.endsWith('\r');
      const lines = text.split(/\r?\n/);
      state.partial = complete ? '' : (lines.pop() || '');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let row = null;
        try {
          row = JSON.parse(trimmed);
        } catch (_) {
          continue;
        }
        const events = makeCodexRowEvents(row);
        for (const event of events) {
          await this.emitSessionEvent(session, event, row);
          emittedEvents += 1;
        }
      }
    }

    for (const filePath of Array.from(this.files.keys())) {
      if (!seenPaths.has(filePath)) {
        this.files.delete(filePath);
      }
    }

    return {
      newSessionCount,
      emittedEvents,
      truncated: false,
    };
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

  async emitSessionEvent(session, event, row) {
    if (typeof this.postEvent !== 'function') {
      return;
    }

    const base = {
      hostId: this.hostId,
      sessionId: session.sessionId,
      nativeThreadId: session.nativeThreadId || session.sessionId,
      source: 'codex-jsonl',
      rolloutPath: session.rolloutPath,
      timestamp: row.timestamp || new Date().toISOString(),
    };

    if (event.type === 'session.transcript') {
      await this.postEvent({
        ...base,
        type: 'session.transcript',
        ...(event.entry || {}),
      }, { retryOnTransient: true });
      return;
    }

    if (event.type === 'session.runtime_updated') {
      await this.postEvent({
        ...base,
        type: 'session.runtime_updated',
        patch: event.patch || {},
      }, { retryOnTransient: true });
      return;
    }

    if (event.type === 'session.diagnostic') {
      await this.postEvent({
        ...base,
        type: 'session.diagnostic',
        ...(event.entry || {}),
      }, { retryOnTransient: true });
    }
  }
}

function readFileDelta(filePath, offset, byteLength) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const bytesRead = fs.readSync(fd, buffer, 0, byteLength, offset);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      nextOffset: offset + bytesRead,
    };
  } finally {
    fs.closeSync(fd);
  }
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
