const DEFAULT_MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;

function payloadBytes(batchId, event) {
  return Buffer.byteLength(JSON.stringify({ batchId, events: [event] }), 'utf8');
}

function discoveryPayloadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function planSessionDiscoveryPayloads(options = {}) {
  const sessions = Array.isArray(options.sessions) ? options.sessions : [];
  const hostId = String(options.hostId || '').trim();
  const discoveryId = String(options.discoveryId || '').trim();
  const discoveredAt = options.discoveredAt || new Date().toISOString();
  const configuredMaxBytes = Number(options.maxBytes || DEFAULT_MAX_PAYLOAD_BYTES);
  const maxBytes = Number.isFinite(configuredMaxBytes)
    ? Math.max(1024, Math.trunc(configuredMaxBytes))
    : DEFAULT_MAX_PAYLOAD_BYTES;
  const fullEvent = { type: 'session.discovery', hostId, discoveryId, discoveredAt, sessions };
  const fullBatchId = `session.discovery:${discoveryId}`;
  if (payloadBytes(fullBatchId, fullEvent) <= maxBytes) {
    return [{ batchId: fullBatchId, event: fullEvent }];
  }

  const metadataSessions = sessions.map(({ transcriptPreview, assistantCursor, ...session }) => ({
    ...session,
    transcriptPreview: [],
  }));
  const metadataEvent = { ...fullEvent, sessions: metadataSessions };
  const metadataBatchId = `${fullBatchId}:metadata`;
  const metadataBytes = payloadBytes(metadataBatchId, metadataEvent);
  if (metadataBytes > maxBytes) {
    throw discoveryPayloadError(
      'discovery_metadata_too_large',
      `Session discovery metadata is ${metadataBytes} bytes; limit is ${maxBytes} bytes.`
    );
  }

  const payloads = [{ batchId: metadataBatchId, event: metadataEvent }];
  let previewSessions = [];
  let previewBytes = 0;
  const previewBaseBytes = () => payloadBytes(`${fullBatchId}:preview:${payloads.length}`, {
    type: 'session.discovery.preview',
    hostId,
    discoveryId,
    discoveredAt,
    sessions: [],
  });
  previewBytes = previewBaseBytes();
  const flushPreview = () => {
    if (!previewSessions.length) return;
    const batchId = `${fullBatchId}:preview:${payloads.length}`;
    payloads.push({
      batchId,
      event: {
        type: 'session.discovery.preview',
        hostId,
        discoveryId,
        discoveredAt,
        sessions: previewSessions,
      },
    });
    previewSessions = [];
    previewBytes = previewBaseBytes();
  };

  for (const session of sessions) {
    if (!session?.transcriptPreview?.length && !session?.assistantCursor) continue;
    const sessionBytes = Buffer.byteLength(JSON.stringify(session), 'utf8');
    if (previewBytes + sessionBytes + (previewSessions.length ? 1 : 0) > maxBytes && previewSessions.length) {
      flushPreview();
    }
    if (previewBytes + sessionBytes > maxBytes) {
      throw discoveryPayloadError(
        'discovery_preview_too_large',
        `Session ${session.sessionId || '(unknown)'} discovery preview exceeds ${maxBytes} bytes.`
      );
    }
    previewBytes += sessionBytes + (previewSessions.length ? 1 : 0);
    previewSessions.push(session);
  }
  flushPreview();
  return payloads;
}

module.exports = { DEFAULT_MAX_PAYLOAD_BYTES, payloadBytes, planSessionDiscoveryPayloads };
