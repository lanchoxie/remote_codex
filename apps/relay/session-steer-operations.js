'use strict';
const { createHash } = require('crypto');

// Process-lifetime result registry, not an exactly-once durable outbox. Never
// evict an ID and re-execute it in the same process. Capacity fails before enqueue.
function createSessionSteerOperations({ limit = 4096 } = {}) {
  const operations = new Map();
  const keyOf = (hostId, requestId) => JSON.stringify([hostId, requestId]);
  const publicValue = (operation) => operation ? { ...operation.result } : null;
  function get(hostId, requestId) { return publicValue(operations.get(keyOf(hostId, requestId))); }
  function begin(target, enqueue) {
    const key = keyOf(target.hostId, target.requestId);
    const fingerprint = createHash('sha256').update(JSON.stringify([
      target.sessionId, target.runId, target.expectedTurnId, target.text,
    ])).digest('hex');
    const existing = operations.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw Object.assign(new Error('This Guide request ID already belongs to different text or a different turn.'), {
          code: 'steer_request_id_conflict', statusCode: 409,
        });
      }
      return publicValue(existing);
    }
    if (operations.size >= limit) {
      throw Object.assign(new Error('Guide operation capacity reached. No new Guide was sent.'), { code: 'steer_capacity', statusCode: 503 });
    }
    const operation = {
      fingerprint,
      result: {
        hostId: target.hostId, sessionId: target.sessionId, requestId: target.requestId,
        runId: target.runId, expectedTurnId: target.expectedTurnId,
        status: 'queued', commandId: null, timestamp: new Date().toISOString(),
      },
    };
    operations.set(key, operation);
    try {
      const command = enqueue();
      if (command) operation.result.commandId = command.commandId ?? command.id;
    } catch (error) {
      operations.delete(key);
      throw error;
    }
    return publicValue(operation);
  }
  function replay(target) {
    const key = keyOf(target.hostId, target.requestId);
    const operation = operations.get(key);
    if (!operation) return null;
    const fingerprint = createHash('sha256').update(JSON.stringify([
      target.sessionId, target.runId, target.expectedTurnId, target.text,
    ])).digest('hex');
    if (operation.fingerprint !== fingerprint) {
      throw Object.assign(new Error('This Guide request ID already belongs to different text or a different turn.'), {
        code: 'steer_request_id_conflict', statusCode: 409,
      });
    }
    return publicValue(operation);
  }
  function resolve(event) {
    const operation = operations.get(keyOf(event.hostId, event.requestId));
    if (!operation) return null;
    const previous = operation.result;
    if (['sessionId', 'runId', 'expectedTurnId', 'commandId'].some((field) => previous[field] !== event[field])) return null;
    if (!['accepted', 'rejected', 'acceptance_unknown'].includes(event.status)) return null;
    if (event.status === 'accepted' && event.turnId !== previous.expectedTurnId) return null;
    if (previous.status !== 'queued') return publicValue(operation);
    operation.result = {
      ...previous, status: event.status, turnId: event.turnId || null,
      code: event.code || null, error: event.error ? String(event.error).slice(0, 2000) : null,
      timestamp: event.timestamp || new Date().toISOString(),
    };
    return publicValue(operation);
  }
  return Object.freeze({ get, begin, replay, resolve });
}
module.exports = { createSessionSteerOperations };
