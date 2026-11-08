(function initSessionStreamClient(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexSessionStream = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  function parseCursor(value) {
    const cursor = String(value || '').trim();
    const separator = cursor.lastIndexOf(':');
    if (separator <= 0 || separator === cursor.length - 1) return null;
    const counter = Number(cursor.slice(separator + 1));
    if (!Number.isSafeInteger(counter) || counter < 0) return null;
    return { epoch: cursor.slice(0, separator), counter };
  }

  function isObjectLike(value) {
    return Boolean(value) && (typeof value === 'object' || typeof value === 'function');
  }

  function normalizeGeneration(value) {
    const generation = Number(value);
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
  }

  function readStore(store, key) {
    return store && typeof store.get === 'function' ? store.get(key) : undefined;
  }

  function writeStore(store, key, value) {
    if (store && typeof store.set === 'function') {
      store.set(key, value);
    }
  }

  function createSessionStreamClient(options = {}) {
    const getCurrent = typeof options.getCurrent === 'function'
      ? options.getCurrent
      : () => ({});
    const resolveCanonicalKey = typeof options.resolveCanonicalKey === 'function'
      ? options.resolveCanonicalKey
      : () => '';
    const cursorStore = options.cursorStore || new Map();
    const cursorGenerationStore = options.cursorGenerationStore || new Map();
    const onError = typeof options.onError === 'function' ? options.onError : () => {};

    // Event objects are short lived. Keeping this outside the gate closures
    // lets late callbacks remain rejected after a source has been replaced,
    // without retaining source objects in application state.
    const eventContexts = new WeakMap();

    function currentIdentity() {
      try {
        return getCurrent() || {};
      } catch (error) {
        onError(error);
        return {};
      }
    }

    function isCurrent(source, streamKey, generation) {
      const current = currentIdentity();
      const expectedGeneration = normalizeGeneration(generation);
      const actualGeneration = normalizeGeneration(current.generation);
      return current.source === source
        && current.streamKey === streamKey
        && expectedGeneration !== null
        && actualGeneration !== null
        && expectedGeneration === actualGeneration;
    }

    function guardCallback(source, streamKey, generation, callback) {
      const handler = typeof callback === 'function' ? callback : () => {};
      return function guardedSessionStreamCallback(...args) {
        if (!isCurrent(source, streamKey, generation)) return false;
        return handler.apply(this, args);
      };
    }

    function commitDirect(
      session,
      event,
      payload = null,
      canonicalKey = '',
      streamGeneration = null,
      identity = null
    ) {
      const resolvedCanonicalKey = canonicalKey || resolveCanonicalKey(session, event, payload);
      const cursor = String(event?.lastEventId || '').trim();
      if (!resolvedCanonicalKey || !cursor) {
        return resolvedCanonicalKey;
      }

      const generation = normalizeGeneration(
        streamGeneration && typeof streamGeneration === 'object'
          ? streamGeneration.generation
          : streamGeneration
      );
      if (identity && !isCurrent(identity.source, identity.streamKey, identity.generation)) {
        return false;
      }

      // A completion from an older source must not move the cursor belonging
      // to a replacement source. Check both the live identity and the
      // per-conversation generation fence because recovery callbacks may no
      // longer have the original EventSource available.
      const current = currentIdentity();
      const currentGeneration = normalizeGeneration(current.generation);
      const storedGeneration = normalizeGeneration(readStore(
        cursorGenerationStore,
        resolvedCanonicalKey
      ));
      if (
        generation !== null
        && (
          (currentGeneration !== null && generation < currentGeneration)
          || (storedGeneration !== null && generation < storedGeneration)
        )
      ) {
        return false;
      }

      const previousCursor = String(readStore(cursorStore, resolvedCanonicalKey) || '').trim();
      const previous = parseCursor(previousCursor);
      const next = parseCursor(cursor);
      // Event IDs are ordered by counter inside one Relay stream epoch. An
      // out-of-order async completion may not move the resume point backward.
      if (previous && next && previous.epoch === next.epoch && next.counter < previous.counter) {
        return resolvedCanonicalKey;
      }

      writeStore(cursorStore, resolvedCanonicalKey, cursor);
      if (generation !== null) {
        writeStore(cursorGenerationStore, resolvedCanonicalKey, generation);
      }
      return resolvedCanonicalKey;
    }

    function createGate(session, source, streamKey, streamGeneration, gateOptions = {}) {
      let nextSequence = 1;
      let nextCommitSequence = 1;
      let blocked = false;
      let failureNotified = false;
      const records = new Map();
      const onFailure = typeof gateOptions.onFailure === 'function'
        ? gateOptions.onFailure
        : () => {};

      const gateIsCurrent = () => isCurrent(source, streamKey, streamGeneration);

      const drain = () => {
        while (records.has(nextCommitSequence)) {
          const record = records.get(nextCommitSequence);
          if (record.status === 'pending') return;
          if (record.status === 'failed') {
            blocked = true;
            return;
          }
          records.delete(nextCommitSequence);
          // Successful events no longer need a dispatch context. Stale
          // records intentionally retain theirs so a late commit returns
          // false instead of falling through to a direct cursor write.
          eventContexts.delete(record.event);
          nextCommitSequence += 1;
          if (record.payload !== undefined) {
            commitDirect(
              record.session,
              record.event,
              record.payload,
              record.canonicalKey,
              streamGeneration
            );
          }
        }
      };

      const abandon = (record) => {
        if (!record || record.status !== 'pending') return false;
        record.status = 'stale';
        records.delete(record.sequence);
        return true;
      };

      const begin = (event) => {
        const record = {
          sequence: nextSequence++,
          session,
          event,
          status: 'pending',
          deferred: false,
          payload: undefined,
          canonicalKey: '',
        };
        records.set(record.sequence, record);
        if (isObjectLike(event)) {
          eventContexts.set(event, { gate, record });
        }
        return record;
      };

      const complete = (record, payload = null, canonicalKey = '') => {
        if (!record || record.status !== 'pending') return false;
        if (blocked || !gateIsCurrent()) {
          abandon(record);
          return false;
        }
        record.status = 'success';
        record.payload = payload;
        record.canonicalKey = canonicalKey || resolveCanonicalKey(record.session, record.event, payload);
        drain();
        return true;
      };

      const fail = (record, error = new Error('Session stream event could not be applied.')) => {
        if (!record || record.status !== 'pending') return false;
        if (!gateIsCurrent()) {
          abandon(record);
          return false;
        }
        record.status = 'failed';
        record.error = error instanceof Error
          ? error
          : new Error(String(error || 'Session stream event failed.'));
        blocked = true;
        drain();
        if (!failureNotified) {
          failureNotified = true;
          onFailure(record.error, record);
        }
        return false;
      };

      const defer = (record) => {
        if (!record || record.status !== 'pending') return false;
        if (blocked || !gateIsCurrent()) {
          abandon(record);
          return false;
        }
        record.deferred = true;
        return true;
      };

      const listen = (eventName, handler) => {
        const listener = (event) => {
          if (!gateIsCurrent() || blocked) return;
          const record = begin(event);
          let result;
          try {
            result = handler(event);
          } catch (error) {
            fail(record, error);
            onError(error);
            return;
          }

          const settle = (value) => {
            if (record.status !== 'pending') return;
            if (value === false) {
              fail(record, new Error(`Session stream event ${eventName} was rejected.`));
              return;
            }
            // A handler must commit after applying its payload, or defer
            // while an authoritative recovery is in flight.
            if (!record.deferred) {
              fail(record, new Error(`Session stream event ${eventName} was not committed.`));
            }
          };

          try {
            // Reading .then is deliberately inside the try block. A custom
            // thenable getter can throw and must enter the same failure path.
            const then = result && result.then;
            if (typeof then === 'function') {
              then.call(result, settle, (error) => {
                fail(record, error);
                onError(error);
              });
            } else {
              settle(result);
            }
          } catch (error) {
            fail(record, error);
            onError(error);
          }
        };
        source.addEventListener(eventName, listener);
        return listener;
      };

      const gate = {
        begin,
        complete,
        fail,
        defer,
        abandon,
        listen,
        isCurrent: gateIsCurrent,
        guard: (callback) => guardCallback(source, streamKey, streamGeneration, callback),
        get blocked() { return blocked; },
        get pendingCount() { return records.size; },
      };
      return gate;
    }

    function contextFor(event) {
      return isObjectLike(event) ? eventContexts.get(event) : null;
    }

    function defer(event) {
      const context = contextFor(event);
      return context ? context.gate.defer(context.record) : false;
    }

    function fail(event, error) {
      const context = contextFor(event);
      return context ? context.gate.fail(context.record, error) : false;
    }

    function commit(session, event, payload = null, canonicalKey = '') {
      const context = contextFor(event);
      if (context) {
        return context.gate.complete(
          context.record,
          payload,
          canonicalKey || resolveCanonicalKey(session, event, payload)
        );
      }
      return commitDirect(session, event, payload, canonicalKey);
    }

    return Object.freeze({
      createGate,
      createSessionStreamCursorGate: createGate,
      commit,
      commitDirect,
      defer,
      fail,
      guardCallback,
      guardedCallback: guardCallback,
      isCurrent,
      parseCursor,
    });
  }

  return Object.freeze({
    createSessionStreamClient,
    createClient: createSessionStreamClient,
    parseCursor,
  });
}));
