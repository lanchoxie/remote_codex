const LEGACY_BATCH_UNSUPPORTED_STATUS_CODES = new Set([404, 405, 415]);
const LEGACY_BATCH_UNSUPPORTED_ERROR_CODES = new Set([
  'agent_event_batch_envelope_unsupported',
]);

function isLegacyBatchUnsupported(error) {
  const statusCode = Number(error?.statusCode || 0);
  if (LEGACY_BATCH_UNSUPPORTED_STATUS_CODES.has(statusCode)) return true;
  if (statusCode !== 400 && statusCode !== 422) return false;
  return LEGACY_BATCH_UNSUPPORTED_ERROR_CODES.has(String(error?.body?.code || '').trim());
}

async function deliverAgentEventBatch(events, options = {}) {
  const batch = (Array.isArray(events) ? events : []).filter(Boolean);
  if (!batch.length) {
    return null;
  }
  if (typeof options.sendSingle !== 'function') {
    throw new TypeError('sendSingle is required');
  }
  const stableBatchId = String(options.batchId || '').trim();
  if (
    batch.length === 1
    && (!stableBatchId || typeof options.sendBatch !== 'function')
  ) {
    return options.sendSingle(batch[0]);
  }
  if (typeof options.sendBatch !== 'function') {
    for (const event of batch) {
      await options.sendSingle(event);
    }
    return null;
  }

  let result = null;
  let legacyFallbackRequired = false;
  try {
    result = await options.sendBatch(batch, stableBatchId || null);
  } catch (error) {
    if (!isLegacyBatchUnsupported(error)) {
      throw error;
    }
    legacyFallbackRequired = true;
  }

  if (result && Number(result.body?.count) === batch.length) {
    return result;
  }
  if (legacyFallbackRequired) {
    for (const event of batch) {
      await options.sendSingle(event);
    }
    return result;
  }
  if (!result && options.bestEffort) {
    return null;
  }
  const error = new Error('Relay returned an invalid Agent event batch response.');
  error.code = 'agent_event_batch_response_invalid';
  error.body = result?.body || null;
  throw error;
}

module.exports = {
  deliverAgentEventBatch,
  isLegacyBatchUnsupported,
};
