const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { makeCodexRowEvents } = require('./codex-discovery');
const {
  describeRolloutAssistantRow,
  isRolloutAssistantMirrorPair,
} = require('./assistant-message-identity');

const DEFAULT_MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_BATCH = 64;
const DEFAULT_ASSISTANT_MIRROR_GRACE_MS = 250;

class CodexSessionTailer {
  constructor(options = {}) {
    this.codexHome = options.codexHome;
    this.hostId = options.hostId;
    this.postEvent = options.postEvent;
    this.postEvents = typeof options.postEvents === 'function' ? options.postEvents : null;
    this.maxBytesPerPoll = Number(options.maxBytesPerPoll || DEFAULT_MAX_BYTES_PER_POLL);
    this.maxEventsPerBatch = Math.max(1, Number(options.maxEventsPerBatch || DEFAULT_MAX_EVENTS_PER_BATCH));
    this.assistantCursorIndex = options.assistantCursorIndex || null;
    this.assistantMirrorGraceMs = Math.max(
      0,
      Number(options.assistantMirrorGraceMs ?? DEFAULT_ASSISTANT_MIRROR_GRACE_MS) || 0
    );
    this.nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
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
        pendingAssistantMirror: null,
        rolloutActivityOwner: null,
        rolloutActivityTurnId: null,
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
      const existing = this.files.get(normalized.rolloutPath);
      if (!existing) {
        const stats = safeStat(normalized.rolloutPath);
        const state = {
          session: normalized,
          offset: stats?.size || 0,
          partialBytes: Buffer.alloc(0),
          partialStartOffset: stats?.size || 0,
          sourceOrdinal: 0,
          sourceOrdinalKnown: !stats || stats.size === 0,
          fileIdentity: stats ? tailFileIdentity(normalized.rolloutPath, stats) : null,
          lastStatSize: stats?.size || 0,
          lastMtimeMs: stats ? Number(stats.mtimeMs) : null,
          pendingAssistantMirror: null,
          rolloutActivityOwner: null,
          rolloutActivityTurnId: null,
          primed: true,
        };
        this.files.set(normalized.rolloutPath, state);
        this.seedWatchedActivity(state, normalized);
      } else {
        const wasLiveManaged = existing.session?.live === true
          && existing.session?.transcriptOwner === 'managed-runner';
        existing.session = { ...existing.session, ...normalized };
        if (!wasLiveManaged && normalized.live === true && normalized.transcriptOwner === 'managed-runner') {
          this.seedWatchedActivity(existing, normalized);
        }
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

  seedWatchedActivity(state, session) {
    if (session?.live !== true || session?.transcriptOwner !== 'managed-runner') return;
    const activity = seedRolloutActivity(session.rolloutPath, session);
    if (!activity) return;
    state.rolloutActivityOwner = activity.owner;
    state.rolloutActivityTurnId = activity.turnId;
    if (activity.owner !== 'external-terminal') return;
    const seedKey = `${activity.turnId || ''}:${activity.row?.timestamp || ''}`;
    if (state.rolloutActivitySeedKey === seedKey) return;
    state.rolloutActivitySeedKey = seedKey;
    for (const event of makeCodexRowEvents(activity.row)) {
      const payload = this.makeSessionEvent(session, event, activity.row, activity);
      if (payload) this.pendingEvents.push(payload);
    }
  }

  async poll() {
    const sessions = this.getActiveTailSessions();
    let newSessionCount = 0;
    let emittedEvents = 0;
    let postedBatchCount = 0;
    let truncated = false;
    let replaced = false;
    postedBatchCount += await this.flushPendingEvents({ flushPartial: true });

    for (const session of sessions) {
      if (!session.rolloutPath || !this.watchedSessions.has(session.rolloutPath)) {
        continue;
      }
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
          pendingAssistantMirror: null,
          rolloutActivityOwner: null,
          rolloutActivityTurnId: null,
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
      const fileEvents = [];
      const appendRowEvents = (row, events, ownership = null) => {
        for (const event of events || []) {
          if (event.type === 'session.transcript' && event.entry?.assistantObservation) {
            this.assistantCursorIndex?.recordObservation(
              session,
              event.entry.assistantObservation
            );
          }
          const payload = this.makeSessionEvent(session, event, row, ownership);
          if (!payload) continue;
          fileEvents.push(payload);
          emittedEvents += 1;
        }
      };
      const flushPendingAssistantMirror = () => {
        const pending = state.pendingAssistantMirror;
        if (!pending) return false;
        state.pendingAssistantMirror = null;
        appendRowEvents(pending.row, pending.events, pending.ownership);
        return true;
      };
      if (identityChanged || sameSizeRewrite || fileTruncated) {
        resetTailState(state, nextFileIdentity);
        replaced = replaced || identityChanged || sameSizeRewrite;
        truncated = truncated || fileTruncated;
      }
      if (stats.size === state.offset) {
        if (
          state.pendingAssistantMirror
          && this.nowMs() - state.pendingAssistantMirror.queuedAtMs >= this.assistantMirrorGraceMs
        ) {
          flushPendingAssistantMirror();
        }
        state.lastStatSize = stats.size;
        state.lastMtimeMs = Number(stats.mtimeMs);
        for (const event of fileEvents) this.pendingEvents.push(event);
        postedBatchCount += await this.flushPendingEvents();
        continue;
      }

      const readResult = readFileDelta(session.rolloutPath, state.offset, Math.min(stats.size - state.offset, this.maxBytesPerPoll));
      const lines = consumeJsonlLines(state, readResult.buffer, state.offset);

      for (const lineEntry of lines) {
        const trimmed = lineEntry.text.trim();
        if (!trimmed) {
          continue;
        }
        let row = null;
        try {
          row = JSON.parse(trimmed);
        } catch (_) {
          flushPendingAssistantMirror();
          continue;
        }
        if (state.pendingAssistantMirror) {
          if (isRolloutAssistantMirrorPair(state.pendingAssistantMirror.row, row)) {
            state.pendingAssistantMirror = null;
          } else {
            flushPendingAssistantMirror();
          }
        }
        const ownership = observeRolloutRowOwnership(state, session, row);
        const events = makeCodexRowEvents(row, {
          nativeThreadId: session.nativeThreadId || session.sessionId,
          rolloutPath: session.rolloutPath,
          sourceOffset: lineEntry.sourceOffset,
          sourceOrdinal: lineEntry.sourceOrdinal,
          observedAt: new Date().toISOString(),
        });
        if (describeRolloutAssistantRow(row)?.kind === 'event') {
          state.pendingAssistantMirror = {
            row,
            events,
            ownership,
            queuedAtMs: this.nowMs(),
          };
          finishRolloutRowOwnership(state, ownership);
          continue;
        }
        appendRowEvents(row, events, ownership);
        finishRolloutRowOwnership(state, ownership);
      }
      state.offset = readResult.nextOffset;
      state.lastStatSize = stats.size;
      state.lastMtimeMs = Number(stats.mtimeMs);
      if (
        state.pendingAssistantMirror
        && state.offset >= stats.size
        && state.partialBytes.length === 0
        && this.nowMs() - state.pendingAssistantMirror.queuedAtMs >= this.assistantMirrorGraceMs
      ) {
        flushPendingAssistantMirror();
      }
      for (const event of fileEvents) {
        this.pendingEvents.push(event);
      }
      postedBatchCount += await this.flushPendingEvents();
    }

    postedBatchCount += await this.flushPendingEvents({ flushPartial: true });

    const currentlyWatchedPaths = new Set(this.watchedSessions.keys());
    for (const filePath of Array.from(this.files.keys())) {
      if (!currentlyWatchedPaths.has(filePath)) {
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

  makeSessionEvent(session, event, row, ownership = null) {
    const base = {
      hostId: this.hostId,
      sessionId: session.sessionId,
      nativeThreadId: session.nativeThreadId || session.sessionId,
      source: 'codex-jsonl',
      ...(session.runId ? { runId: session.runId } : {}),
      rolloutPath: session.rolloutPath,
      timestamp: row.timestamp || new Date().toISOString(),
    };

    const externalTerminalActivity = ownership?.owner === 'external-terminal';
    if (session.live === true && event.type === 'session.runtime_updated') {
      if (!externalTerminalActivity) {
        return null;
      }
      const phase = String(event.patch?.phase || '').trim() || null;
      const hasActivitySignal = Object.prototype.hasOwnProperty.call(event.patch || {}, 'busy')
        || Object.prototype.hasOwnProperty.call(event.patch || {}, 'activeTurnId')
        || ['thinking', 'planning', 'reviewing', 'waiting-approval', 'waiting-user-input', 'interrupting', 'retrying', 'reconnecting', 'running-shell-command', 'compacting', 'idle', 'interrupted', 'error', 'closed', 'completed']
          .includes(String(phase || '').toLowerCase());
      if (!hasActivitySignal) {
        return null;
      }
      const active = event.patch?.busy !== false
        && !['idle', 'interrupted', 'error', 'closed', 'completed'].includes(String(phase || '').toLowerCase());
      return {
        ...base,
        type: 'session.runtime_updated',
        patch: {
          externalActivity: {
            owner: 'external-terminal',
            active,
            turnId: ownership.turnId || event.patch?.activeTurnId || null,
            phase,
            status: event.patch?.currentTurnStatus || (active ? 'inProgress' : 'completed'),
            updatedAt: base.timestamp,
          },
        },
      };
    }

    if (session.live === true && event.type === 'session.diagnostic' && !externalTerminalActivity) {
      return null;
    }

    if (
      event.type === 'session.transcript'
      && session.transcriptOwner === 'managed-runner'
      && !externalTerminalActivity
    ) {
      return null;
    }

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
      const entry = event.entry || {};
      return {
        ...base,
        type: 'session.diagnostic',
        ...entry,
        ...(externalTerminalActivity ? {
          activityOwner: 'external-terminal',
          data: {
            ...(entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data) ? entry.data : {}),
            activityOwner: 'external-terminal',
          },
        } : {}),
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
    transcriptOwner: String(session.transcriptOwner || '').trim() || null,
  };
}

function rolloutRowLifecycle(row) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const type = row?.type === 'event_msg' ? String(payload.type || '').trim() : '';
  return {
    turnId: String(payload.turn_id || payload.turnId || '').trim() || null,
    started: type === 'task_started',
    terminal: type === 'task_complete' || type === 'turn_aborted',
  };
}

function seedRolloutActivity(filePath, session, maxBytes = DEFAULT_MAX_BYTES_PER_POLL) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stats = safeStat(filePath);
  if (!stats || stats.size <= 0) return null;
  const length = Math.min(Number(maxBytes) || DEFAULT_MAX_BYTES_PER_POLL, stats.size);
  const fd = fs.openSync(filePath, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, stats.size - length);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split(/\r?\n/);
  if (stats.size > length) lines.shift();
  let active = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const lifecycle = rolloutRowLifecycle(row);
    if (lifecycle.started) active = { row, turnId: lifecycle.turnId };
    else if (lifecycle.terminal && (!lifecycle.turnId || !active?.turnId || lifecycle.turnId === active.turnId)) active = null;
  }
  if (!active?.turnId) return null;
  return {
    ...active,
    owner: managedRunnerOwnsTurn(session, active.turnId) ? 'managed-runner' : 'external-terminal',
  };
}

function managedRunnerOwnsTurn(session, turnId) {
  if (!turnId || typeof session?.managedTurnOwner !== 'function') {
    return false;
  }
  try {
    return session.managedTurnOwner(turnId) === true;
  } catch (_) {
    return false;
  }
}

function observeRolloutRowOwnership(state, session, row) {
  if (session?.live !== true || session?.transcriptOwner !== 'managed-runner') {
    return null;
  }
  const lifecycle = rolloutRowLifecycle(row);
  let owner = state.rolloutActivityOwner || null;
  let turnId = lifecycle.turnId || state.rolloutActivityTurnId || null;

  if (lifecycle.started || (lifecycle.turnId && managedRunnerOwnsTurn(session, lifecycle.turnId))) {
    owner = managedRunnerOwnsTurn(session, lifecycle.turnId)
      ? 'managed-runner'
      : 'external-terminal';
    turnId = lifecycle.turnId || null;
    state.rolloutActivityOwner = owner;
    state.rolloutActivityTurnId = turnId;
  } else if (!owner) {
    // Without an explicit task_started row there is no safe evidence that a
    // live managed rollout belongs to another terminal. Keep it managed until
    // a turn-specific external start is observed.
    owner = 'managed-runner';
    state.rolloutActivityOwner = owner;
    state.rolloutActivityTurnId = turnId;
  }

  return {
    owner,
    turnId,
    terminal: lifecycle.terminal,
  };
}

function finishRolloutRowOwnership(state, ownership) {
  if (!ownership?.terminal) return;
  state.rolloutActivityOwner = null;
  state.rolloutActivityTurnId = null;
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
  state.pendingAssistantMirror = null;
  state.rolloutActivityOwner = null;
  state.rolloutActivityTurnId = null;
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
