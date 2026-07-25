const crypto = require('crypto');

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function parseCursor(value) {
  const cursor = String(value || '').trim();
  const separator = cursor.lastIndexOf(':');
  if (separator <= 0 || separator === cursor.length - 1) return null;
  const counter = Number(cursor.slice(separator + 1));
  if (!Number.isSafeInteger(counter) || counter < 0) return null;
  return { epoch: cursor.slice(0, separator), counter };
}

class SessionEventStream {
  constructor(options = {}) {
    this.epoch = String(options.epoch || crypto.randomUUID());
    this.ringSize = Math.max(1, Math.min(4096, Number(options.ringSize || 256) || 256));
    this.tombstoneLimit = Math.max(1, Math.min(4096, Number(options.tombstoneLimit || 256) || 256));
    this.tombstoneTtlMs = Math.max(1000, Number(options.tombstoneTtlMs || 60_000) || 60_000);
    this.maxStreamBytes = Math.max(
      256,
      Math.min(64 * 1024 * 1024, Number(options.maxStreamBytes || 2 * 1024 * 1024) || 2 * 1024 * 1024)
    );
    this.maxTotalBytes = Math.max(
      this.maxStreamBytes,
      Math.min(256 * 1024 * 1024, Number(options.maxTotalBytes || 16 * 1024 * 1024) || 16 * 1024 * 1024)
    );
    this.streamGeneration = 0;
    this.eventOrder = 0;
    this.totalRingBytes = 0;
    this.streams = new Map();
    this.tombstones = new Map();
  }

  pruneTombstones(now = Date.now()) {
    for (const [key, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(key);
    }
    while (this.tombstones.size > this.tombstoneLimit) {
      this.tombstones.delete(this.tombstones.keys().next().value);
    }
  }

  saveTombstone(canonicalKey, stream, dirty = false) {
    const key = String(canonicalKey || '');
    if (!key || !stream?.cursorEpoch) return;
    this.tombstones.delete(key);
    this.tombstones.set(key, {
      cursorEpoch: stream.cursorEpoch,
      counter: stream.counter,
      dirty: Boolean(dirty),
      expiresAt: Date.now() + this.tombstoneTtlMs,
    });
    this.pruneTombstones();
  }

  markTombstoneDirty(canonicalKey) {
    const key = String(canonicalKey || '');
    const tombstone = this.tombstones.get(key);
    if (!tombstone) return false;
    tombstone.dirty = true;
    tombstone.expiresAt = Date.now() + this.tombstoneTtlMs;
    this.tombstones.delete(key);
    this.tombstones.set(key, tombstone);
    this.pruneTombstones();
    return true;
  }

  rotateCursor(stream) {
    this.clearRing(stream);
    this.streamGeneration += 1;
    stream.cursorEpoch = `${this.epoch}.${this.streamGeneration}`;
    stream.counter = 0;
  }

  removeRingHead(stream, count = 1) {
    const removeCount = Math.max(0, Math.min(stream?.ring?.length || 0, Number(count) || 0));
    if (!removeCount) return 0;
    const removedBytes = stream.ringEntryBytes
      .splice(0, removeCount)
      .reduce((sum, bytes) => sum + bytes, 0);
    stream.ring.splice(0, removeCount);
    stream.ringOrders.splice(0, removeCount);
    stream.ringBytes = Math.max(0, stream.ringBytes - removedBytes);
    this.totalRingBytes = Math.max(0, this.totalRingBytes - removedBytes);
    return removedBytes;
  }

  clearRing(stream) {
    if (!stream) return;
    this.totalRingBytes = Math.max(0, this.totalRingBytes - (stream.ringBytes || 0));
    stream.ring = [];
    stream.ringEntryBytes = [];
    stream.ringOrders = [];
    stream.ringBytes = 0;
  }

  trimRingBudgets(stream) {
    while (
      stream.ring.length
      && (stream.ring.length > this.ringSize || stream.ringBytes > this.maxStreamBytes)
    ) {
      this.removeRingHead(stream);
    }
    while (this.totalRingBytes > this.maxTotalBytes) {
      let oldestStream = null;
      let oldestOrder = Infinity;
      for (const candidate of this.streams.values()) {
        const order = candidate.ringOrders[0];
        if (Number.isFinite(order) && order < oldestOrder) {
          oldestOrder = order;
          oldestStream = candidate;
        }
      }
      if (!oldestStream) break;
      this.removeRingHead(oldestStream);
    }
  }

  ensure(canonicalKey) {
    const key = String(canonicalKey || '');
    if (!key) throw new TypeError('canonical conversation key is required');
    if (!this.streams.has(key)) {
      this.pruneTombstones();
      const tombstone = this.tombstones.get(key) || null;
      this.tombstones.delete(key);
      if (!tombstone || tombstone.dirty) this.streamGeneration += 1;
      this.streams.set(key, {
        cursorEpoch: tombstone && !tombstone.dirty
          ? tombstone.cursorEpoch
          : `${this.epoch}.${this.streamGeneration}`,
        counter: tombstone && !tombstone.dirty ? tombstone.counter : 0,
        ring: [],
        ringEntryBytes: [],
        ringOrders: [],
        ringBytes: 0,
        subscribers: new Set(),
      });
    }
    return this.streams.get(key);
  }

  has(canonicalKey) {
    const stream = this.streams.get(String(canonicalKey || ''));
    return Boolean(stream && stream.subscribers.size > 0);
  }

  deleteIfEmpty(canonicalKey, stream) {
    const key = String(canonicalKey || '');
    if (
      stream
      && stream.subscribers.size === 0
      && this.streams.get(key) === stream
    ) {
      this.streams.delete(key);
      this.clearRing(stream);
      this.saveTombstone(key, stream);
      return true;
    }
    return false;
  }

  deliver(subscriber, event) {
    let accepted = false;
    try {
      accepted = subscriber.send(event) !== false;
    } catch (_) {
      accepted = false;
    }
    if (!accepted) {
      subscriber.remove();
    }
    return accepted;
  }

  publish(canonicalKey, eventName, payload) {
    const key = String(canonicalKey || '');
    if (!key) throw new TypeError('canonical conversation key is required');
    const stream = this.streams.get(key);
    if (!stream) {
      this.markTombstoneDirty(key);
      return null;
    }
    if (stream.subscribers.size === 0) {
      this.streams.delete(key);
      this.clearRing(stream);
      this.saveTombstone(key, stream, true);
      return null;
    }
    stream.counter += 1;
    const entry = {
      id: `${stream.cursorEpoch}:${stream.counter}`,
      streamEpoch: this.epoch,
      streamCounter: stream.counter,
      canonicalConversationKey: key,
      eventName: String(eventName || 'message'),
      payload: clone(payload),
    };
    const retainedBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    stream.ring.push(entry);
    stream.ringEntryBytes.push(retainedBytes);
    stream.ringOrders.push(++this.eventOrder);
    stream.ringBytes += retainedBytes;
    this.totalRingBytes += retainedBytes;
    this.trimRingBudgets(stream);
    for (const subscriber of [...stream.subscribers]) {
      this.deliver(subscriber, clone(entry));
    }
    this.deleteIfEmpty(key, stream);
    return clone(entry);
  }

  replay(canonicalKey, rawCursor) {
    const key = String(canonicalKey || '');
    if (!key) throw new TypeError('canonical conversation key is required');
    const stream = this.streams.get(key) || { cursorEpoch: null, counter: 0, ring: [] };
    const cursor = parseCursor(rawCursor);
    if (!rawCursor) {
      return {
        reset: true,
        reason: 'cursor_missing',
        events: [],
        streamEpoch: this.epoch,
        streamCounter: stream.counter,
      };
    }
    if (!cursor) {
      return {
        reset: true,
        reason: 'cursor_invalid',
        events: [],
        streamEpoch: this.epoch,
        streamCounter: stream.counter,
      };
    }
    if (!stream.cursorEpoch || cursor.epoch !== stream.cursorEpoch) {
      return {
        reset: true,
        reason: 'epoch_mismatch',
        events: [],
        streamEpoch: this.epoch,
        streamCounter: stream.counter,
      };
    }
    if (cursor.counter > stream.counter) {
      return {
        reset: true,
        reason: 'cursor_expired',
        events: [],
        streamEpoch: this.epoch,
        streamCounter: stream.counter,
      };
    }
    const earliest = stream.ring[0]?.streamCounter ?? stream.counter + 1;
    if (cursor.counter < earliest - 1) {
      return {
        reset: true,
        reason: 'cursor_expired',
        events: [],
        streamEpoch: this.epoch,
        streamCounter: stream.counter,
      };
    }
    return {
      reset: false,
      reason: null,
      events: stream.ring
        .filter((entry) => entry.streamCounter > cursor.counter)
        .map(clone),
      streamEpoch: this.epoch,
      streamCounter: stream.counter,
    };
  }

  resetEnvelope(canonicalKey, projection = {}) {
    const key = String(canonicalKey || '');
    if (!key) throw new TypeError('canonical conversation key is required');
    const stream = this.streams.get(key) || { counter: 0 };
    const assistantProjection = projection.assistantProjection || projection.assistant || null;
    return clone({
      streamEpoch: this.epoch,
      streamCounter: stream.counter,
      canonicalConversationKey: key,
      assistantProjection,
      assistant: assistantProjection,
      activities: Array.isArray(projection.activities) ? projection.activities : [],
      activitiesTruncated: projection.activitiesTruncated === true,
      activityCount: Math.max(0, Number(projection.activityCount || 0)),
      detailRecoveryRequired: projection.detailRecoveryRequired === true,
      session: projection.session || null,
    });
  }

  resetEvent(canonicalKey, reason, projection = {}) {
    const key = String(canonicalKey || '');
    if (!key) throw new TypeError('canonical conversation key is required');
    const stream = this.streams.get(key) || { counter: 0 };
    return {
      id: `${stream.cursorEpoch || this.epoch}:${stream.counter}`,
      streamEpoch: this.epoch,
      streamCounter: stream.counter,
      canonicalConversationKey: key,
      eventName: 'stream.reset',
      payload: {
        ...this.resetEnvelope(key, projection),
        reason: String(reason || 'cursor_invalid'),
      },
    };
  }

  subscribe(options = {}) {
    const canonicalKey = String(options.canonicalKey || '');
    if (!canonicalKey || typeof options.send !== 'function') {
      throw new TypeError('canonicalKey and send are required');
    }
    const stream = this.ensure(canonicalKey);
    let active = true;
    const subscriber = {
      send: options.send,
      makeReset: typeof options.makeReset === 'function' ? options.makeReset : () => ({}),
      stream,
      canonicalKey,
      remove: () => {
        if (!active) return false;
        active = false;
        const currentStream = subscriber.stream;
        const currentKey = subscriber.canonicalKey;
        const removed = currentStream.subscribers.delete(subscriber);
        this.deleteIfEmpty(currentKey, currentStream);
        return removed;
      },
    };
    stream.subscribers.add(subscriber);

    try {
      const replay = this.replay(canonicalKey, options.cursor);
      if (replay.reset) {
        this.deliver(subscriber, this.resetEvent(
          canonicalKey,
          replay.reason,
          subscriber.makeReset(canonicalKey)
        ));
      } else {
        for (const event of replay.events) {
          if (!this.deliver(subscriber, event)) break;
        }
      }
    } catch (error) {
      subscriber.remove();
      throw error;
    }

    return subscriber.remove;
  }

  mergeCanonicalKey(loserKeyValue, winnerKeyValue) {
    const loserKey = String(loserKeyValue || '');
    const winnerKey = String(winnerKeyValue || '');
    if (!loserKey || !winnerKey || loserKey === winnerKey) {
      return { merged: false, canonicalConversationKey: winnerKey || loserKey };
    }
    const loser = this.streams.get(loserKey);
    const existingWinner = this.streams.get(winnerKey);
    if (!loser && !existingWinner) {
      this.tombstones.delete(loserKey);
      this.markTombstoneDirty(winnerKey);
      return { merged: false, canonicalConversationKey: winnerKey };
    }
    const winner = existingWinner || this.ensure(winnerKey);
    const moved = loser ? [...loser.subscribers] : [];
    const resetSubscribers = new Set(winner.subscribers);
    for (const subscriber of moved) {
      loser.subscribers.delete(subscriber);
      winner.subscribers.add(subscriber);
      resetSubscribers.add(subscriber);
      subscriber.stream = winner;
      subscriber.canonicalKey = winnerKey;
    }
    if (loser) {
      this.streams.delete(loserKey);
      this.clearRing(loser);
    }
    this.tombstones.delete(loserKey);
    this.rotateCursor(winner);
    let resetError = null;
    for (const subscriber of resetSubscribers) {
      try {
        this.deliver(subscriber, this.resetEvent(
          winnerKey,
          'canonical_key_changed',
          subscriber.makeReset(winnerKey)
        ));
      } catch (error) {
        subscriber.remove();
        resetError ||= error;
      }
    }
    this.deleteIfEmpty(winnerKey, winner);
    if (resetError) throw resetError;
    return {
      merged: Boolean(loser),
      canonicalConversationKey: winnerKey,
      movedSubscribers: moved.length,
      resetSubscribers: resetSubscribers.size,
    };
  }

  clear(canonicalKey) {
    const key = String(canonicalKey || '');
    this.clearRing(this.streams.get(key));
    this.streams.delete(key);
    this.tombstones.delete(key);
  }
}

module.exports = {
  SessionEventStream,
  parseCursor,
};
