const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const {
  describeRolloutAssistantRow,
  isRolloutAssistantMirrorPair,
  normalizeAssistantObservation,
} = require('./assistant-message-identity');

const DEFAULT_MAX_BYTES_PER_SCAN = 256 * 1024;
const DEFAULT_ASSISTANT_MIRROR_GRACE_MS = 250;
const DEFAULT_MAX_OBSERVED_IDS_PER_FILE = 512;

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizedFileKey(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function statFileIdentity(fileKey, stat) {
  return [
    String(stat?.dev ?? ''),
    String(stat?.ino ?? ''),
    String(stat?.birthtimeMs ?? ''),
    normalizedFileKey(fileKey),
  ].join(':');
}

function safeStat(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath, { bigint: false });
  } catch (_) {
    return null;
  }
}

function decodeCompleteLine(buffer) {
  const decoder = new StringDecoder('utf8');
  return decoder.write(buffer) + decoder.end();
}

function createCursor(fileKey, fileIdentity, previous = null, maxObservedIds = DEFAULT_MAX_OBSERVED_IDS_PER_FILE) {
  return {
    fileKey,
    fileIdentity,
    offset: 0,
    partialBytes: Buffer.alloc(0),
    partialStartOffset: 0,
    sourceOrdinal: 0,
    observedIds: new Set(),
    maxObservedIds,
    pendingObservations: previous?.pendingObservations || new Map(),
    pendingAssistantMirror: null,
    projectionRevision: Math.max(0, Number(previous?.projectionRevision || 0)) + 1,
    lastStatSize: 0,
    lastMtimeMs: null,
    unavailable: false,
    parseError: false,
  };
}

function rememberObservedId(cursor, assistantMessageId) {
  if (!assistantMessageId || cursor.observedIds.has(assistantMessageId)) {
    return false;
  }
  cursor.observedIds.add(assistantMessageId);
  while (cursor.observedIds.size > cursor.maxObservedIds) {
    cursor.observedIds.delete(cursor.observedIds.values().next().value);
  }
  return true;
}

function observationTimeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function retainObservation(cursor, observation) {
  if (
    !observation
    || cursor.observedIds.has(observation.assistantMessageId)
    || cursor.pendingObservations.has(observation.assistantMessageId)
  ) {
    return false;
  }
  rememberObservedId(cursor, observation.assistantMessageId);
  cursor.pendingObservations.set(observation.assistantMessageId, observation);
  return true;
}

function flushPendingAssistantMirror(cursor) {
  const pending = cursor.pendingAssistantMirror;
  if (!pending) return false;
  cursor.pendingAssistantMirror = null;
  return retainObservation(cursor, pending.observation);
}

function wireIdentity(session = {}, fileKey = '') {
  return {
    sessionId: String(session.sessionId || session.nativeThreadId || '').trim() || null,
    nativeThreadId: String(session.nativeThreadId || session.sessionId || '').trim() || null,
    rolloutPath: fileKey || null,
  };
}

function projectCursor(cursor, session, options = {}) {
  const observations = Array.from(cursor?.pendingObservations?.values?.() || []);
  return {
    ...wireIdentity(session, cursor?.fileKey || options.fileKey || ''),
    observations,
    cursorOffset: Math.max(0, Number(cursor?.offset || 0)),
    cursorUnknown: options.cursorUnknown === true,
    fileIdentity: cursor?.fileIdentity || null,
    replaced: options.replaced === true,
    truncated: options.truncated === true,
    projectionRevision: Math.max(0, Number(cursor?.projectionRevision || 0)),
    bytesRead: Math.max(0, Number(options.bytesRead || 0)),
    observedIdCount: cursor?.observedIds?.size || 0,
  };
}

class CodexAssistantCursorIndex {
  constructor(options = {}) {
    this.fs = options.fsImpl || fs;
    this.maxBytesPerScan = positiveInteger(
      options.maxBytesPerScan,
      DEFAULT_MAX_BYTES_PER_SCAN
    );
    this.maxBytesPerScanMany = positiveInteger(
      options.maxBytesPerScanMany,
      this.maxBytesPerScan * 16
    );
    this.now = typeof options.now === 'function'
      ? options.now
      : () => new Date().toISOString();
    this.assistantMirrorGraceMs = Math.max(
      0,
      Number(options.assistantMirrorGraceMs ?? DEFAULT_ASSISTANT_MIRROR_GRACE_MS) || 0
    );
    this.maxObservedIdsPerFile = positiveInteger(
      options.maxObservedIdsPerFile,
      DEFAULT_MAX_OBSERVED_IDS_PER_FILE
    );
    this.files = new Map();
    this.scanManyStart = 0;
    this.metrics = {
      bytesRead: 0,
      readCalls: 0,
      statCalls: 0,
    };
  }

  scan(session = {}, options = {}) {
    if (!session.rolloutPath) {
      return projectCursor(null, session, { cursorUnknown: true });
    }

    const fileKey = normalizedFileKey(session.rolloutPath);
    this.metrics.statCalls += 1;
    const stat = safeStat(this.fs, fileKey);
    let cursor = this.files.get(fileKey) || null;
    if (!stat || !stat.isFile()) {
      if (cursor && !cursor.unavailable) {
        cursor.unavailable = true;
        cursor.projectionRevision += 1;
      }
      return projectCursor(cursor, session, {
        fileKey,
        cursorUnknown: true,
      });
    }

    const identity = statFileIdentity(fileKey, stat);
    const identityChanged = Boolean(cursor && cursor.fileIdentity !== identity);
    const truncated = Boolean(cursor && stat.size < cursor.offset);
    const sameSizeRewrite = Boolean(
      cursor
      && !identityChanged
      && !truncated
      && cursor.offset > 0
      && stat.size === cursor.offset
      && cursor.lastStatSize === stat.size
      && cursor.lastMtimeMs !== null
      && Number(stat.mtimeMs) !== Number(cursor.lastMtimeMs)
    );
    const replaced = identityChanged || sameSizeRewrite;

    if (!cursor || replaced || truncated) {
      cursor = createCursor(fileKey, identity, cursor, this.maxObservedIdsPerFile);
      this.files.set(fileKey, cursor);
    }
    cursor.unavailable = false;

    if (options.stopAtPending === true && cursor.pendingObservations.size > 0) {
      return projectCursor(cursor, session, {
        replaced,
        truncated,
        cursorUnknown: stat.size !== cursor.offset
          || cursor.partialBytes.length > 0
          || cursor.parseError
          || Boolean(cursor.pendingAssistantMirror),
      });
    }

    if (stat.size === cursor.offset) {
      const pendingAgeMs = cursor.pendingAssistantMirror
        ? observationTimeMs(this.now()) - cursor.pendingAssistantMirror.queuedAtMs
        : 0;
      const mirrorFlushed = Boolean(
        cursor.pendingAssistantMirror
        && pendingAgeMs >= this.assistantMirrorGraceMs
        && flushPendingAssistantMirror(cursor)
      );
      if (mirrorFlushed) cursor.projectionRevision += 1;
      cursor.lastStatSize = stat.size;
      cursor.lastMtimeMs = Number(stat.mtimeMs);
      return projectCursor(cursor, session, {
        bytesRead: 0,
        replaced,
        truncated,
        cursorUnknown: cursor.partialBytes.length > 0
          || cursor.parseError
          || Boolean(cursor.pendingAssistantMirror),
      });
    }

    const requestedBudget = Object.prototype.hasOwnProperty.call(options, 'maxBytes')
      ? Math.max(0, Math.trunc(Number(options.maxBytes) || 0))
      : this.maxBytesPerScan;
    const scanBudget = Math.min(this.maxBytesPerScan, requestedBudget);
    if (scanBudget <= 0) {
      return projectCursor(cursor, session, {
        replaced,
        truncated,
        cursorUnknown: true,
      });
    }
    const byteLength = Math.min(scanBudget, stat.size - cursor.offset);
    const buffer = Buffer.allocUnsafe(byteLength);
    let bytesRead = 0;
    let fd = null;
    try {
      fd = this.fs.openSync(fileKey, 'r');
      bytesRead = this.fs.readSync(fd, buffer, 0, byteLength, cursor.offset);
    } catch (_) {
      return projectCursor(cursor, session, {
        replaced,
        truncated,
        cursorUnknown: true,
      });
    } finally {
      if (fd !== null) {
        try {
          this.fs.closeSync(fd);
        } catch (_) {
          // A failed close cannot make the in-memory cursor authoritative.
        }
      }
    }

    this.metrics.readCalls += 1;
    this.metrics.bytesRead += bytesRead;
    const baseOffset = cursor.offset;
    const chunk = buffer.subarray(0, bytesRead);
    const combined = cursor.partialBytes.length
      ? Buffer.concat([cursor.partialBytes, chunk])
      : chunk;
    const combinedStart = cursor.partialBytes.length
      ? cursor.partialStartOffset
      : baseOffset;
    let lineStart = 0;

    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) {
        continue;
      }
      let lineEnd = index;
      if (lineEnd > lineStart && combined[lineEnd - 1] === 0x0d) {
        lineEnd -= 1;
      }
      const line = decodeCompleteLine(combined.subarray(lineStart, lineEnd));
      const sourceOffset = combinedStart + lineStart;
      lineStart = index + 1;
      if (!line.trim()) {
        continue;
      }

      cursor.sourceOrdinal += 1;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch (_) {
        flushPendingAssistantMirror(cursor);
        cursor.parseError = true;
        continue;
      }
      if (cursor.pendingAssistantMirror) {
        if (isRolloutAssistantMirrorPair(cursor.pendingAssistantMirror.row, row)) {
          cursor.pendingAssistantMirror = null;
        } else {
          flushPendingAssistantMirror(cursor);
        }
      }
      const observation = normalizeAssistantObservation({
        representation: 'rollout',
        row,
        nativeThreadId: session.nativeThreadId || session.sessionId,
        rolloutPath: fileKey,
        sourceOffset,
        sourceOrdinal: cursor.sourceOrdinal,
        sourceTimestamp: row?.timestamp,
        observedAt: this.now(),
        finalized: true,
      });
      if (!observation) {
        continue;
      }
      if (describeRolloutAssistantRow(row)?.kind === 'event') {
        cursor.pendingAssistantMirror = {
          row,
          observation,
          queuedAtMs: observationTimeMs(this.now()),
        };
        continue;
      }
      retainObservation(cursor, observation);
    }

    cursor.partialBytes = Buffer.from(combined.subarray(lineStart));
    cursor.partialStartOffset = combinedStart + lineStart;
    cursor.offset = baseOffset + bytesRead;
    cursor.lastStatSize = stat.size;
    cursor.lastMtimeMs = Number(stat.mtimeMs);
    if (bytesRead > 0) {
      cursor.projectionRevision += 1;
    }

    this.metrics.statCalls += 1;
    const latestStat = safeStat(this.fs, fileKey);
    const changedDuringRead = Boolean(
      !latestStat
      || !latestStat.isFile()
      || statFileIdentity(fileKey, latestStat) !== cursor.fileIdentity
    );
    const unreadBytes = latestStat && latestStat.isFile()
      ? cursor.offset < latestStat.size
      : true;
    if (
      cursor.pendingAssistantMirror
      && !unreadBytes
      && cursor.partialBytes.length === 0
      && observationTimeMs(this.now()) - cursor.pendingAssistantMirror.queuedAtMs >= this.assistantMirrorGraceMs
    ) {
      flushPendingAssistantMirror(cursor);
    }
    return projectCursor(cursor, session, {
      bytesRead,
      replaced,
      truncated,
      cursorUnknown: changedDuringRead
        || unreadBytes
        || cursor.partialBytes.length > 0
        || cursor.parseError
        || Boolean(cursor.pendingAssistantMirror),
    });
  }

  scanMany(sessions = []) {
    const values = (Array.isArray(sessions) ? sessions : [])
      .filter((session) => session?.rolloutPath);
    if (!values.length) {
      this.files.clear();
      return [];
    }
    const activeFileKeys = new Set(values.map((session) => normalizedFileKey(session.rolloutPath)));
    for (const fileKey of this.files.keys()) {
      if (!activeFileKeys.has(fileKey)) this.files.delete(fileKey);
    }
    const start = this.scanManyStart % values.length;
    const ordered = values.slice(start).concat(values.slice(0, start));
    const resultsBySession = new Map();
    let remaining = this.maxBytesPerScanMany;
    let lastReaderIndex = -1;
    for (let index = 0; index < ordered.length; index += 1) {
      const result = this.scan(ordered[index], {
        maxBytes: Math.min(this.maxBytesPerScan, remaining),
        stopAtPending: true,
      });
      resultsBySession.set(ordered[index], result);
      remaining = Math.max(0, remaining - result.bytesRead);
      if (result.bytesRead > 0) {
        lastReaderIndex = index;
      }
    }
    const advance = lastReaderIndex >= 0 ? lastReaderIndex + 1 : 1;
    this.scanManyStart = (start + advance) % values.length;
    return values.map((session) => resultsBySession.get(session));
  }

  recordObservation(session = {}, observation = null) {
    const assistantMessageId = String(observation?.assistantMessageId || '').trim();
    if (!session.rolloutPath || !assistantMessageId) {
      return false;
    }
    const fileKey = normalizedFileKey(session.rolloutPath);
    let cursor = this.files.get(fileKey) || null;
    if (!cursor) {
      this.metrics.statCalls += 1;
      const stat = safeStat(this.fs, fileKey);
      cursor = createCursor(
        fileKey,
        stat && stat.isFile() ? statFileIdentity(fileKey, stat) : null,
        null,
        this.maxObservedIdsPerFile
      );
      this.files.set(fileKey, cursor);
    }
    if (cursor.observedIds.has(assistantMessageId) || cursor.pendingObservations.has(assistantMessageId)) {
      return false;
    }
    rememberObservedId(cursor, assistantMessageId);
    cursor.projectionRevision += 1;
    return true;
  }

  acknowledge(result = null) {
    if (!result?.rolloutPath) {
      return 0;
    }
    const cursor = this.files.get(normalizedFileKey(result.rolloutPath));
    if (!cursor) {
      return 0;
    }
    let removed = 0;
    for (const observation of result.observations || []) {
      const id = String(observation?.assistantMessageId || '').trim();
      if (id && cursor.pendingObservations.delete(id)) {
        removed += 1;
      }
    }
    return removed;
  }

  acknowledgeMany(results = []) {
    return (Array.isArray(results) ? results : [])
      .reduce((count, result) => count + this.acknowledge(result), 0);
  }

  getMetrics() {
    return {
      ...this.metrics,
      retainedObservationIds: Array.from(this.files.values())
        .reduce((count, cursor) => count + cursor.observedIds.size, 0),
      pendingObservations: Array.from(this.files.values())
        .reduce((count, cursor) => count + cursor.pendingObservations.size, 0),
    };
  }
}

module.exports = {
  CodexAssistantCursorIndex,
  DEFAULT_MAX_BYTES_PER_SCAN,
  normalizedFileKey,
  statFileIdentity,
};
