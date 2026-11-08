const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { StringDecoder } = require('string_decoder');
const { makeCodexRowEvents } = require('./codex-discovery');
const {
  describeRolloutAssistantRow,
  isRolloutAssistantMirrorPair,
} = require('./assistant-message-identity');
const { safeStructuredJson } = require('./structured-text');

const DEFAULT_MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
// A seed is performed only when a Session first becomes watched (or its
// ownership revision changes), so it can afford a larger bounded context than
// the steady-state poll.  Files beyond this bound are treated as having an
// unknown prefix and are handled fail-closed below.
const DEFAULT_MAX_BYTES_PER_SEED = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENTS_PER_BATCH = 64;
const DEFAULT_ASSISTANT_MIRROR_GRACE_MS = 250;

class CodexSessionTailer {
  constructor(options = {}) {
    this.codexHome = options.codexHome;
    this.hostId = options.hostId;
    this.postEvent = options.postEvent;
    this.postEvents = typeof options.postEvents === 'function' ? options.postEvents : null;
    this.maxBytesPerPoll = Number(options.maxBytesPerPoll || DEFAULT_MAX_BYTES_PER_POLL);
    this.maxBytesPerSeed = Math.max(
      1,
      Number(options.maxBytesPerSeed ?? DEFAULT_MAX_BYTES_PER_SEED)
    );
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
        previousRolloutRow: null,
        rolloutActivityOwner: null,
        rolloutActivityTurnId: null,
        rolloutActivitySeedKey: null,
        rolloutReviewParentTurnId: null,
        rolloutReviewParentManaged: false,
        rolloutReviewChildTurnId: null,
        rolloutReviewChildTurnIds: [],
        rolloutReviewContexts: [],
        rolloutReviewExitObserved: false,
        rolloutReviewParentTerminalObserved: false,
        managedTurnOwnershipRevision: session.managedTurnOwnershipRevision || null,
        watchIdentity: sessionWatchIdentity(session),
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
          previousRolloutRow: null,
          rolloutActivityOwner: null,
          rolloutActivityTurnId: null,
          rolloutActivitySeedKey: null,
          rolloutReviewParentTurnId: null,
          rolloutReviewParentManaged: false,
          rolloutReviewChildTurnId: null,
          rolloutReviewChildTurnIds: [],
          rolloutReviewContexts: [],
          rolloutReviewExitObserved: false,
          rolloutReviewParentTerminalObserved: false,
          managedTurnOwnershipRevision: normalized.managedTurnOwnershipRevision || null,
          watchIdentity: sessionWatchIdentity(normalized),
          primed: true,
        };
        this.files.set(normalized.rolloutPath, state);
        this.seedWatchedActivity(state, normalized);
      } else {
        const previousSession = existing.session || null;
        const wasLiveManaged = existing.session?.live === true
          && existing.session?.transcriptOwner === 'managed-runner';
        const previousWatchIdentity = existing.watchIdentity
          || sessionWatchIdentity(previousSession);
        const nextWatchIdentity = sessionWatchIdentity(normalized);
        const watchIdentityChanged = previousWatchIdentity !== nextWatchIdentity;
        if (watchIdentityChanged) {
          this.reconcileSessionWatchChange(existing, previousSession, normalized);
        }
        existing.session = { ...existing.session, ...normalized };
        const nextOwnershipRevision = normalized.managedTurnOwnershipRevision || null;
        const ownershipRevisionChanged = existing.managedTurnOwnershipRevision
          !== nextOwnershipRevision;
        existing.managedTurnOwnershipRevision = nextOwnershipRevision;
        existing.watchIdentity = nextWatchIdentity;
        if (!wasLiveManaged && normalized.live === true && normalized.transcriptOwner === 'managed-runner') {
          this.seedWatchedActivity(existing, normalized);
        } else if (
          wasLiveManaged
          && normalized.live === true
          && normalized.transcriptOwner === 'managed-runner'
          && (ownershipRevisionChanged || watchIdentityChanged)
        ) {
          // Runner ownership maps are populated and retired asynchronously.
          // Re-seed only when their explicit revision changes so a new
          // callback closure does not rescan the rollout every poll.
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

  reconcileSessionWatchChange(state, previousSession, nextSession) {
    const previousTurnId = state?.rolloutActivityOwner === 'external-terminal'
      ? String(state.rolloutActivityTurnId || '').trim()
      : '';
    if (previousTurnId && previousSession) {
      // Close the projection under the old Run identity before replacing the
      // callback/runner.  Using the old Session metadata prevents a stale
      // terminal from accidentally clearing a newer Run at the Relay.
      const terminal = this.makeExternalActivityTerminalEvent(previousSession, {
        turnId: previousTurnId,
        terminalPhase: 'idle',
        row: { timestamp: new Date().toISOString() },
      });
      if (terminal) {
        this.pendingEvents.push(terminal);
      }
    }
    clearRolloutActivityState(state);
    state.watchIdentity = sessionWatchIdentity(nextSession);
  }

  seedWatchedActivity(state, session) {
    if (session?.live !== true || session?.transcriptOwner !== 'managed-runner') {
      return;
    }
    const activity = seedRolloutActivity(session.rolloutPath, session, this.maxBytesPerSeed);
    if (!activity) {
      const previousExternalTurnId = state.rolloutActivityOwner === 'external-terminal'
        ? String(state.rolloutActivityTurnId || '').trim()
        : '';
      if (previousExternalTurnId) {
        // The refreshed ownership map now proves that the previously seeded
        // Turn is not an external activity (or that it has already settled).
        // Retract that exact identity; the Relay performs a second CAS check
        // before accepting the correction.
        this.pendingEvents.push(this.makeExternalActivityTerminalEvent(session, {
          turnId: previousExternalTurnId,
          terminalPhase: 'idle',
          row: { timestamp: new Date().toISOString() },
        }));
      }
      clearRolloutActivityState(state);
      return;
    }
    const seedHasUnknownPrefix = activity.contextComplete === false;
    const reviewContextRecovered = Boolean(activity.reviewParentTurnId);
    if (activity.terminal === true && activity.owner === 'external-terminal') {
      if (seedHasUnknownPrefix && !reviewContextRecovered) {
        // The candidate started before the bounded seed window.  Without its
        // preceding lifecycle markers we cannot distinguish an external
        // terminal from a Review child, so do not manufacture a terminal
        // transition on a live managed Session.
        return;
      }
      const seedKey = `terminal:${activity.turnId || ''}:${activity.row?.timestamp || ''}`;
      if (state.rolloutActivitySeedKey === seedKey) {
        return;
      }
      state.rolloutActivitySeedKey = seedKey;
      this.pendingEvents.push(this.makeExternalActivityTerminalEvent(session, activity));
      clearRolloutActivityState(state, { clearSeed: false });
      return;
    }
    const previousExternalTurnId = state.rolloutActivityOwner === 'external-terminal'
      ? String(state.rolloutActivityTurnId || '').trim()
      : '';
    if (seedHasUnknownPrefix && !reviewContextRecovered) {
      // Do not retain a newly inferred external owner when the seed starts in
      // the middle of the rollout.  Otherwise a later task_complete row could
      // emit a lone `active=false` for an activity for which no `active=true`
      // event was ever published.
      if (!previousExternalTurnId) {
        clearRolloutActivityState(state, { clearSeed: false, clearReview: false });
      }
      return;
    }
    if (previousExternalTurnId && activity.owner !== 'external-terminal') {
      // A late ownership update can prove that an activity previously
      // projected as external was actually managed. Retract only that exact
      // old identity; Relay-side CAS protects a newer external Turn.
      this.pendingEvents.push(this.makeExternalActivityTerminalEvent(session, {
        turnId: previousExternalTurnId,
        terminalPhase: 'idle',
        row: activity.row || {},
      }));
    }
    state.rolloutActivityOwner = activity.owner;
    state.rolloutActivityTurnId = activity.turnId;
    state.rolloutReviewParentTurnId = activity.reviewParentTurnId || null;
    state.rolloutReviewParentManaged = activity.reviewParentManaged === true;
    state.rolloutReviewChildTurnId = activity.reviewChildTurnId || null;
    state.rolloutReviewChildTurnIds = Array.isArray(activity.reviewChildTurnIds)
      ? activity.reviewChildTurnIds.slice()
      : (activity.reviewChildTurnId ? [activity.reviewChildTurnId] : []);
    state.rolloutReviewExitObserved = activity.reviewExitObserved === true;
    state.rolloutReviewParentTerminalObserved = activity.reviewParentTerminalObserved === true;
    if (activity.owner !== 'external-terminal') {
      return;
    }
    const seedKey = `${activity.turnId || ''}:${activity.row?.timestamp || ''}`;
    if (state.rolloutActivitySeedKey === seedKey) {
      return;
    }
    state.rolloutActivitySeedKey = seedKey;
    for (const event of makeCodexRowEvents(activity.row)) {
      const payload = this.makeSessionEvent(session, event, activity.row, activity);
      if (payload) {
        this.pendingEvents.push(payload);
      }
    }
  }

  makeExternalActivityTerminalEvent(session, ownership, row = ownership?.row || {}) {
    const terminalPhase = ownership?.terminalPhase === 'interrupted' ? 'interrupted' : 'idle';
    const terminalStatus = terminalPhase === 'interrupted' ? 'interrupted' : 'completed';
    return this.makeSessionEvent(session, {
      type: 'session.runtime_updated',
      patch: {
        phase: terminalPhase,
        busy: false,
        activeTurnId: null,
        currentTurnStatus: terminalStatus,
      },
    }, row, {
      owner: 'external-terminal',
      turnId: ownership?.turnId || null,
      terminal: true,
    });
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
          previousRolloutRow: null,
          rolloutActivityOwner: null,
          rolloutActivityTurnId: null,
          rolloutActivitySeedKey: null,
          rolloutReviewParentTurnId: null,
          rolloutReviewParentManaged: false,
          rolloutReviewChildTurnId: null,
          rolloutReviewChildTurnIds: [],
          rolloutReviewContexts: [],
          rolloutReviewExitObserved: false,
          rolloutReviewParentTerminalObserved: false,
          managedTurnOwnershipRevision: session.managedTurnOwnershipRevision || null,
          watchIdentity: sessionWatchIdentity(session),
          primed: true,
        };
        this.files.set(session.rolloutPath, state);
        newSessionCount += 1;
        continue;
      } else {
        const previousSession = state.session || null;
        const nextWatchIdentity = sessionWatchIdentity(session);
        const watchIdentityChanged = (state.watchIdentity || sessionWatchIdentity(previousSession)) !== nextWatchIdentity;
        if (watchIdentityChanged) {
          this.reconcileSessionWatchChange(state, previousSession, session);
        }
        state.session = {
          ...state.session,
          ...session,
        };
        state.watchIdentity = nextWatchIdentity;
        if (watchIdentityChanged) {
          this.seedWatchedActivity(state, session);
        }
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
      if (sameSizeRewrite) {
        // Rollout files are append-only from the tailer's perspective. A
        // same-length mtime change cannot contain a new append, so rewinding
        // to byte zero would only rebroadcast history. Full-detail discovery
        // owns reconciliation when another process rewrites existing bytes.
        replaced = true;
      }
      if (identityChanged || fileTruncated) {
        resetTailState(state, nextFileIdentity);
        replaced = replaced || identityChanged;
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
          state.previousRolloutRow = null;
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
        if (ownership?.activityClosure?.turnId) {
          const terminalPayload = this.makeExternalActivityTerminalEvent(
            session,
            ownership.activityClosure,
            row
          );
          if (terminalPayload) {
            fileEvents.push(terminalPayload);
            emittedEvents += 1;
          }
        }
        const events = makeCodexRowEvents(row, {
          nativeThreadId: session.nativeThreadId || session.sessionId,
          rolloutPath: session.rolloutPath,
          sourceOffset: lineEntry.sourceOffset,
          sourceOrdinal: lineEntry.sourceOrdinal,
          observedAt: new Date().toISOString(),
        });
        const assistantRow = describeRolloutAssistantRow(row);
        const reverseAssistantMirror = Boolean(
          assistantRow?.kind === 'event'
          && state.previousRolloutRow
          && isRolloutAssistantMirrorPair(row, state.previousRolloutRow)
        );
        if (assistantRow?.kind === 'event' && !reverseAssistantMirror) {
          state.pendingAssistantMirror = {
            row,
            events,
            ownership,
            queuedAtMs: this.nowMs(),
          };
          finishRolloutRowOwnership(state, ownership);
          state.previousRolloutRow = row;
          continue;
        }
        if (!reverseAssistantMirror) {
          appendRowEvents(row, events, ownership);
        }
        finishRolloutRowOwnership(state, ownership);
        state.previousRolloutRow = row;
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
      if (!externalTerminalActivity || ownership?.suppressRuntime === true) {
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
        ...(externalTerminalActivity ? {
          activityOwner: 'external-terminal',
          turnId: ownership.turnId || event.entry?.turnId || null,
        } : {}),
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

function identityValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'object') {
    return safeStructuredJson(value) || null;
  }
  return String(value);
}

function sessionWatchIdentity(session) {
  if (!session) {
    return null;
  }
  const runner = session?.runner && typeof session.runner === 'object' ? session.runner : {};
  const ownerCallback = typeof session?.managedTurnOwnership === 'function'
    ? session.managedTurnOwnership
    : session?.managedTurnOwner;
  return JSON.stringify([
    identityValue(session?.sessionId),
    identityValue(session?.nativeThreadId),
    identityValue(session?.rolloutPath),
    identityValue(session?.runId ?? runner.runId),
    identityValue(
      session?.managedRunnerId
      ?? session?.runnerId
      ?? session?.runnerInstanceId
      ?? session?.agentInstanceId
      ?? session?.ownerInstanceId
      ?? runner.id
      ?? runner.runnerId
      ?? runner.instanceId
    ),
    identityValue(
      session?.managedTurnOwnershipRevision
      ?? session?.managedTurnOwnerRevision
      ?? session?.ownershipRevision
      ?? runner.managedTurnOwnershipRevision
      ?? runner.ownershipRevision
      ?? ownerCallback?.ownershipRevision
      ?? ownerCallback?.revision
    ),
    identityValue(
      session?.lifecycleGeneration
      ?? session?.managedLifecycleGeneration
      ?? runner.lifecycleGeneration
      ?? runner.turnLifecycleGeneration
    ),
  ]);
}

function clearRolloutActivityState(state, options = {}) {
  if (!state) {
    return;
  }
  state.rolloutActivityOwner = null;
  state.rolloutActivityTurnId = null;
  if (options.clearReview !== false) {
    state.rolloutReviewParentTurnId = null;
    state.rolloutReviewParentManaged = false;
    state.rolloutReviewChildTurnId = null;
    state.rolloutReviewChildTurnIds = [];
    state.rolloutReviewContexts = [];
    state.rolloutReviewExitObserved = false;
    state.rolloutReviewParentTerminalObserved = false;
  }
  if (options.clearSeed !== false) {
    state.rolloutActivitySeedKey = null;
  }
}

function rolloutRowLifecycle(row) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const type = row?.type === 'event_msg' ? String(payload.type || '').trim() : '';
  return {
    type,
    turnId: String(payload.turn_id || payload.turnId || '').trim() || null,
    started: type === 'task_started',
    terminal: type === 'task_complete' || type === 'turn_aborted',
    reviewEntered: type === 'entered_review_mode',
    reviewExited: type === 'exited_review_mode',
  };
}

function ensureReviewState(state) {
  if (!Array.isArray(state.rolloutReviewContexts)) {
    state.rolloutReviewContexts = [];
  }
  if (!Array.isArray(state.rolloutReviewChildTurnIds)) {
    state.rolloutReviewChildTurnIds = [];
  }
  return state.rolloutReviewContexts;
}

function reviewParentIdFromRow(row) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return String(
    payload.parent_turn_id
    || payload.parentTurnId
    || payload.review_parent_turn_id
    || payload.reviewParentTurnId
    || payload.source?.parent_turn_id
    || payload.source?.parentTurnId
    || ''
  ).trim() || null;
}

function activeReviewContext(state, parentTurnId = null) {
  const contexts = ensureReviewState(state);
  const requested = String(parentTurnId || '').trim();
  if (requested) {
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      if (contexts[index].parentTurnId === requested) {
        return contexts[index];
      }
    }
    return null;
  }
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    if (!contexts[index].exitObserved || !contexts[index].parentTerminalObserved) {
      return contexts[index];
    }
  }
  return null;
}

function reviewContextForChild(state, childTurnId) {
  const normalized = String(childTurnId || '').trim();
  if (!normalized) return null;
  const contexts = ensureReviewState(state);
  for (let index = contexts.length - 1; index >= 0; index -= 1) {
    if (contexts[index].childTurnIds.includes(normalized)) {
      return contexts[index];
    }
  }
  return null;
}

function syncLegacyReviewState(state, context) {
  if (!context) {
    state.rolloutReviewParentTurnId = null;
    state.rolloutReviewParentManaged = false;
    state.rolloutReviewChildTurnId = null;
    state.rolloutReviewChildTurnIds = [];
    state.rolloutReviewExitObserved = false;
    state.rolloutReviewParentTerminalObserved = false;
    return;
  }
  state.rolloutReviewParentTurnId = context.parentTurnId || null;
  state.rolloutReviewParentManaged = context.managed === true;
  state.rolloutReviewChildTurnIds = context.childTurnIds.slice();
  state.rolloutReviewChildTurnId = context.childTurnIds.length
    ? context.childTurnIds[context.childTurnIds.length - 1]
    : null;
  state.rolloutReviewExitObserved = context.exitObserved === true;
  state.rolloutReviewParentTerminalObserved = context.parentTerminalObserved === true;
}

function openReviewContext(state, parentTurnId, managed = true) {
  const contexts = ensureReviewState(state);
  const normalized = String(parentTurnId || '').trim();
  if (!normalized) return null;
  let context = activeReviewContext(state, normalized);
  if (!context) {
    context = {
      parentTurnId: normalized,
      managed: managed !== false,
      childTurnIds: [],
      terminalChildTurnIds: [],
      exitObserved: false,
      parentTerminalObserved: false,
    };
    contexts.push(context);
  } else {
    context.managed = context.managed || managed !== false;
  }
  syncLegacyReviewState(state, context);
  return context;
}

function removeReviewContext(state, context) {
  const contexts = ensureReviewState(state);
  const index = contexts.indexOf(context);
  if (index >= 0) contexts.splice(index, 1);
  const fallback = activeReviewContext(state);
  syncLegacyReviewState(state, fallback);
}

function seedRolloutActivity(filePath, session, maxBytes = DEFAULT_MAX_BYTES_PER_SEED) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const stats = safeStat(filePath);
  if (!stats || stats.size <= 0) {
    return null;
  }
  const length = Math.min(Number(maxBytes) || DEFAULT_MAX_BYTES_PER_SEED, stats.size);
  const contextComplete = stats.size <= length;
  const fd = fs.openSync(filePath, 'r');
  let buffer = Buffer.alloc(0);
  let startOffset = stats.size - length;
  try {
    buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, startOffset);
    buffer = buffer.subarray(0, bytesRead);

    // A bounded read may begin halfway through a JSONL record.  Only discard
    // a prefix when the preceding byte proves that the offset is not already
    // at a line boundary.  The old unconditional `lines.shift()` dropped a
    // valid first record whenever the boundary happened to align exactly.
    if (startOffset > 0) {
      let atLineBoundary = false;
      try {
        const previousByte = Buffer.alloc(1);
        const previousBytesRead = fs.readSync(fd, previousByte, 0, 1, startOffset - 1);
        atLineBoundary = previousBytesRead === 1 && previousByte[0] === 0x0a;
      } catch (_) {
        atLineBoundary = false;
      }
      if (!atLineBoundary) {
        const firstNewline = buffer.indexOf(0x0a);
        if (firstNewline < 0) {
          // There is no complete record in this bounded slice.  Returning an
          // explicit incomplete result keeps callers fail-closed.
          buffer = Buffer.alloc(0);
        } else {
          buffer = buffer.subarray(firstNewline + 1);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const state = {
    rolloutActivityOwner: null,
    rolloutActivityTurnId: null,
    rolloutReviewParentTurnId: null,
    rolloutReviewParentManaged: false,
    rolloutReviewChildTurnId: null,
    rolloutReviewChildTurnIds: [],
    rolloutReviewContexts: [],
    rolloutReviewExitObserved: false,
    rolloutReviewParentTerminalObserved: false,
  };
  let activeRow = null;
  let lastSettledExternal = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const lifecycle = rolloutRowLifecycle(row);
    const ownership = observeRolloutRowOwnership(state, session, row);
    if (
      lifecycle.started
      && ownership?.owner === 'external-terminal'
      && ownership.turnId === lifecycle.turnId
    ) {
      activeRow = row;
      lastSettledExternal = null;
    }
    if (ownership?.activityClosure?.turnId) {
      lastSettledExternal = {
        row,
        turnId: ownership.activityClosure.turnId,
        owner: 'external-terminal',
        terminal: true,
        terminalPhase: ownership.activityClosure.terminalPhase || 'idle',
        contextComplete,
      };
    } else if (
      ownership?.clearActivityTurnId
      && ownership.owner === 'external-terminal'
      && ownership.clearActivityTurnId === ownership.turnId
    ) {
      lastSettledExternal = {
        row,
        turnId: ownership.turnId,
        owner: 'external-terminal',
        terminal: true,
        terminalPhase: lifecycle.type === 'turn_aborted' ? 'interrupted' : 'idle',
        contextComplete,
      };
      activeRow = null;
    }
    if (ownership?.activityClosure?.turnId === state.rolloutActivityTurnId) {
      activeRow = null;
    }
    finishRolloutRowOwnership(state, ownership);
  }
  if (state.rolloutActivityOwner === 'external-terminal' && state.rolloutActivityTurnId) {
    return {
      row: activeRow,
      owner: state.rolloutActivityOwner,
      turnId: state.rolloutActivityTurnId,
      reviewParentTurnId: state.rolloutReviewParentTurnId,
      reviewParentManaged: state.rolloutReviewParentManaged,
      reviewChildTurnId: state.rolloutReviewChildTurnId,
      reviewChildTurnIds: state.rolloutReviewChildTurnIds,
      reviewContexts: state.rolloutReviewContexts,
      reviewExitObserved: state.rolloutReviewExitObserved,
      reviewParentTerminalObserved: state.rolloutReviewParentTerminalObserved,
      contextComplete,
    };
  }
  if (lastSettledExternal) {
    return { ...lastSettledExternal, contextComplete };
  }
  return null;
}

function normalizeTurnOwnership(value) {
  if (value === true) {
    return 'managed';
  }
  // `false` is retained as the legacy external signal.  New callers should
  // return `unknown` (or an object carrying that status) when a Runner map was
  // merely retired and external ownership cannot be proven.
  if (value === false) {
    return 'external';
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['managed', 'managed-runner', 'runner', 'internal'].includes(normalized)) {
      return 'managed';
    }
    if (['external', 'external-terminal', 'terminal'].includes(normalized)) {
      return 'external';
    }
    if (['unknown', 'unverified', 'indeterminate'].includes(normalized)) {
      return 'unknown';
    }
    return 'unknown';
  }
  if (value && typeof value === 'object') {
    if (value.managed === true || value.owner === 'managed' || value.owner === 'managed-runner') {
      return 'managed';
    }
    if (value.external === true || value.owner === 'external' || value.owner === 'external-terminal') {
      return 'external';
    }
    const status = value.status || value.ownership || value.state;
    if (status !== undefined) {
      return normalizeTurnOwnership(status);
    }
  }
  return 'unknown';
}

function managedRunnerTurnOwnership(session, turnId) {
  if (!turnId) {
    return 'unknown';
  }
  const callback = typeof session?.managedTurnOwnership === 'function'
    ? session.managedTurnOwnership
    : (typeof session?.managedTurnOwner === 'function' ? session.managedTurnOwner : null);
  if (!callback) {
    return 'unknown';
  }
  try {
    return normalizeTurnOwnership(callback.call(session, turnId));
  } catch (_) {
    return 'unknown';
  }
}

function managedRunnerOwnsTurn(session, turnId) {
  return managedRunnerTurnOwnership(session, turnId) === 'managed';
}

function observeRolloutRowOwnership(state, session, row) {
  if (session?.live !== true || session?.transcriptOwner !== 'managed-runner') {
    return null;
  }
  ensureReviewState(state);
  const lifecycle = rolloutRowLifecycle(row);
  const activeOwner = state.rolloutActivityOwner || null;
  const activeTurnId = String(state.rolloutActivityTurnId || '').trim() || null;
  const rowOwnership = lifecycle.turnId
    ? managedRunnerTurnOwnership(session, lifecycle.turnId)
    : 'unknown';
  const rowIsManaged = rowOwnership === 'managed';
  const rowIsExternal = rowOwnership === 'external';
  let owner = activeOwner;
  let turnId = activeTurnId || lifecycle.turnId || null;
  let activityClosure = null;
  let clearActivityTurnId = null;
  let clearReview = false;
  let reviewContextForCleanup = null;

  if (lifecycle.reviewEntered && lifecycle.turnId) {
    // `entered_review_mode` is emitted by the managed parent turn.  The
    // Runner's in-memory ownership map may already be gone when a Host
    // attaches after a restart, so the marker itself must remain sufficient
    // evidence for reconstructing the Review boundary.
    openReviewContext(state, lifecycle.turnId, true);
    owner = 'managed-runner';
    turnId = lifecycle.turnId;
  } else if (lifecycle.started) {
    const explicitReviewParentTurnId = reviewParentIdFromRow(row);
    // A Review child in current Codex JSONL normally carries parent_turn_id,
    // but older/native rollouts may omit it.  An open Review is not sufficient
    // provenance: an unrelated terminal can start concurrently in the same
    // rollout.  Only explicit lineage may enter childTurnIds; otherwise use
    // the Runner's direct ownership result and fail closed when it is unknown.
    const reviewContext = explicitReviewParentTurnId
      ? activeReviewContext(state, explicitReviewParentTurnId)
      : null;
    const openReview = activeReviewContext(state);
    const reviewOpenWithoutLineage = Boolean(
      lifecycle.turnId
      && !explicitReviewParentTurnId
      && openReview
      && openReview.exitObserved !== true
    );
    if (
      reviewOpenWithoutLineage
      && activeOwner === 'external-terminal'
      && activeTurnId
      && activeTurnId !== lifecycle.turnId
    ) {
      // A previously projected Review child and a new unlinked Turn are
      // indistinguishable in native JSONL. Retract the old projection before
      // entering the ambiguous Turn; this prevents the parent terminal from
      // leaving a yellow activity marker behind.
      activityClosure = {
        owner: 'external-terminal',
        turnId: activeTurnId,
        terminalPhase: 'idle',
      };
      clearActivityTurnId = activeTurnId;
    }
    const reviewParentTurnId = String(reviewContext?.parentTurnId || '').trim();
    const isManagedReviewChild = Boolean(
      lifecycle.turnId
      && explicitReviewParentTurnId
      && reviewParentTurnId
      && lifecycle.turnId !== reviewParentTurnId
      && reviewContext.exitObserved !== true
      && reviewContext?.managed === true
    );
    if (isManagedReviewChild) {
      if (!reviewContext.childTurnIds.includes(lifecycle.turnId)) {
        reviewContext.childTurnIds.push(lifecycle.turnId);
      }
      syncLegacyReviewState(state, reviewContext);
    }
    owner = isManagedReviewChild
      ? 'external-terminal'
      : reviewOpenWithoutLineage
        ? (activeTurnId === lifecycle.turnId ? activeOwner : 'unknown')
        : (rowIsManaged ? 'managed-runner' : (rowIsExternal ? 'external-terminal' : 'unknown'));
    turnId = lifecycle.turnId || null;
    state.rolloutActivityOwner = owner;
    state.rolloutActivityTurnId = turnId;
  } else if (lifecycle.reviewExited && lifecycle.turnId) {
    const reviewContext = activeReviewContext(state, lifecycle.turnId);
    const reviewParentManaged = reviewContext?.managed === true;
    if (reviewParentManaged) {
      reviewContext.exitObserved = true;
      syncLegacyReviewState(state, reviewContext);
      const reviewChildTurnId = String(
        reviewContext.childTurnIds[reviewContext.childTurnIds.length - 1] || ''
      ).trim();
      if (
        reviewContext.parentTerminalObserved === true
        && reviewChildTurnId
        && activeOwner === 'external-terminal'
        && activeTurnId === reviewChildTurnId
      ) {
        activityClosure = {
          owner: 'external-terminal',
          turnId: reviewChildTurnId,
          terminalPhase: 'idle',
        };
        clearActivityTurnId = reviewChildTurnId;
        clearReview = true;
        reviewContextForCleanup = reviewContext;
      }
    }
    owner = reviewParentManaged ? 'managed-runner' : (activeOwner || 'managed-runner');
    turnId = reviewParentManaged ? lifecycle.turnId : (activeTurnId || lifecycle.turnId);
  } else if (lifecycle.terminal && lifecycle.turnId) {
    const reviewParentContext = activeReviewContext(state, lifecycle.turnId);
    const reviewChildContext = reviewContextForChild(state, lifecycle.turnId);
    const reviewParentManaged = reviewParentContext?.managed === true;
    if (reviewParentManaged) {
      const reviewChildTurnId = String(
        reviewParentContext.childTurnIds[reviewParentContext.childTurnIds.length - 1] || ''
      ).trim();
      const mayCloseReviewChild = lifecycle.type === 'turn_aborted'
        || reviewParentContext.exitObserved === true;
      reviewParentContext.parentTerminalObserved = true;
      syncLegacyReviewState(state, reviewParentContext);
      if (
        mayCloseReviewChild
        && reviewChildTurnId
        && activeOwner === 'external-terminal'
        && activeTurnId === reviewChildTurnId
      ) {
        activityClosure = {
          owner: 'external-terminal',
          turnId: reviewChildTurnId,
          terminalPhase: lifecycle.type === 'turn_aborted' ? 'interrupted' : 'idle',
        };
        clearActivityTurnId = reviewChildTurnId;
        reviewContextForCleanup = reviewParentContext;
      }
      owner = 'managed-runner';
      turnId = lifecycle.turnId;
      clearReview = Boolean(
        !reviewChildTurnId
        || activityClosure
        || activeTurnId !== reviewChildTurnId
      );
      if (clearReview) {
        reviewContextForCleanup = reviewParentContext;
      }
    } else if (reviewChildContext && activeTurnId && lifecycle.turnId === activeTurnId) {
      owner = activeOwner || (rowIsManaged ? 'managed-runner' : (rowIsExternal ? 'external-terminal' : 'unknown'));
      turnId = activeTurnId;
      clearActivityTurnId = activeTurnId;
      reviewChildContext.terminalChildTurnIds = reviewChildContext.terminalChildTurnIds || [];
      if (!reviewChildContext.terminalChildTurnIds.includes(activeTurnId)) {
        reviewChildContext.terminalChildTurnIds.push(activeTurnId);
      }
      if (reviewChildContext.parentTerminalObserved === true) {
        clearReview = true;
        reviewContextForCleanup = reviewChildContext;
      }
    } else if (activeTurnId && lifecycle.turnId === activeTurnId) {
      owner = activeOwner || (rowIsManaged ? 'managed-runner' : (rowIsExternal ? 'external-terminal' : 'unknown'));
      turnId = activeTurnId;
      clearActivityTurnId = activeTurnId;
    } else {
      owner = rowIsManaged ? 'managed-runner' : (rowIsExternal ? 'external-terminal' : 'unknown');
      turnId = lifecycle.turnId;
    }
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
    activityClosure,
    clearActivityTurnId,
    clearReview,
    reviewContext: reviewContextForCleanup,
    suppressRuntime: Boolean(lifecycle.terminal && !clearActivityTurnId),
  };
}

function finishRolloutRowOwnership(state, ownership) {
  const clearActivityTurnId = String(ownership?.clearActivityTurnId || '').trim();
  if (
    clearActivityTurnId
    && clearActivityTurnId === String(state.rolloutActivityTurnId || '').trim()
  ) {
    state.rolloutActivityOwner = null;
    state.rolloutActivityTurnId = null;
    const childContext = reviewContextForChild(state, clearActivityTurnId);
    if (childContext) {
      childContext.terminalChildTurnIds = childContext.terminalChildTurnIds || [];
      if (!childContext.terminalChildTurnIds.includes(clearActivityTurnId)) {
        childContext.terminalChildTurnIds.push(clearActivityTurnId);
      }
      childContext.childTurnIds = childContext.childTurnIds.filter((id) => id !== clearActivityTurnId);
    }
    if (clearActivityTurnId === state.rolloutReviewChildTurnId) {
      state.rolloutReviewChildTurnId = null;
    }
  }
  if (ownership?.clearReview) {
    const contexts = ensureReviewState(state);
    const explicitContext = ownership.reviewContext;
    const parentId = String(state.rolloutReviewParentTurnId || '').trim();
    const context = explicitContext && contexts.includes(explicitContext)
      ? explicitContext
      : contexts.find((candidate) => candidate.parentTurnId === parentId);
    if (context) {
      removeReviewContext(state, context);
    } else {
      syncLegacyReviewState(state, null);
    }
  }
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
  state.previousRolloutRow = null;
  clearRolloutActivityState(state);
  state.managedTurnOwnershipRevision = null;
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
