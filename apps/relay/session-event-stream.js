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
    this.streams = new Map();
  }

  ensure(canonicalKey) {
    const key = String(canonicalKey || '');
    if (!key) throw new TypeError('canonical conversation key is required');
    if (!this.streams.has(key)) {
      this.streams.set(key, { counter: 0, ring: [], subscribers: new Set() });
    }
    return this.streams.get(key);
  }

  publish(canonicalKey, eventName, payload) {
    const key = String(canonicalKey || '');
    const stream = this.ensure(key);
    stream.counter += 1;
    const entry = {
      id: `${this.epoch}:${stream.counter}`,
      streamEpoch: this.epoch,
      streamCounter: stream.counter,
      canonicalConversationKey: key,
      eventName: String(eventName || 'message'),
      payload: clone(payload),
    };
    stream.ring.push(entry);
    if (stream.ring.length > this.ringSize) {
      stream.ring.splice(0, stream.ring.length - this.ringSize);
    }
    for (const subscriber of [...stream.subscribers]) {
      if (subscriber.send(clone(entry)) === false) {
        stream.subscribers.delete(subscriber);
      }
    }
    return clone(entry);
  }

  replay(canonicalKey, rawCursor) {
    const key = String(canonicalKey || '');
    const stream = this.ensure(key);
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
    if (cursor.epoch !== this.epoch) {
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
    const stream = this.ensure(key);
    const assistantProjection = projection.assistantProjection || projection.assistant || null;
    return clone({
      streamEpoch: this.epoch,
      streamCounter: stream.counter,
      canonicalConversationKey: key,
      assistantProjection,
      assistant: assistantProjection,
      activities: Array.isArray(projection.activities) ? projection.activities : [],
      session: projection.session || null,
    });
  }

  resetEvent(canonicalKey, reason, projection = {}) {
    const key = String(canonicalKey || '');
    const stream = this.ensure(key);
    return {
      id: `${this.epoch}:${stream.counter}`,
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
    const subscriber = {
      send: options.send,
      makeReset: typeof options.makeReset === 'function' ? options.makeReset : () => ({}),
      stream,
    };
    stream.subscribers.add(subscriber);

    const replay = this.replay(canonicalKey, options.cursor);
    if (replay.reset) {
      subscriber.send(this.resetEvent(
        canonicalKey,
        replay.reason,
        subscriber.makeReset(canonicalKey)
      ));
    } else {
      for (const event of replay.events) {
        subscriber.send(event);
      }
    }

    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      return subscriber.stream.subscribers.delete(subscriber);
    };
  }

  mergeCanonicalKey(loserKeyValue, winnerKeyValue) {
    const loserKey = String(loserKeyValue || '');
    const winnerKey = String(winnerKeyValue || '');
    if (!loserKey || !winnerKey || loserKey === winnerKey) {
      return { merged: false, canonicalConversationKey: winnerKey || loserKey };
    }
    const loser = this.streams.get(loserKey);
    if (!loser) {
      return { merged: false, canonicalConversationKey: winnerKey };
    }
    const winner = this.ensure(winnerKey);
    const moved = [...loser.subscribers];
    for (const subscriber of moved) {
      winner.subscribers.add(subscriber);
      subscriber.stream = winner;
      subscriber.send(this.resetEvent(
        winnerKey,
        'canonical_key_changed',
        subscriber.makeReset(winnerKey)
      ));
    }
    loser.subscribers.clear();
    this.streams.delete(loserKey);
    return {
      merged: true,
      canonicalConversationKey: winnerKey,
      movedSubscribers: moved.length,
    };
  }

  clear(canonicalKey) {
    this.streams.delete(String(canonicalKey || ''));
  }
}

module.exports = {
  SessionEventStream,
  parseCursor,
};
