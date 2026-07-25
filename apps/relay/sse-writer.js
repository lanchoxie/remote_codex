const BACKPRESSURE_CLOSE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.SSE_BACKPRESSURE_CLOSE_TIMEOUT_MS || 10_000) || 10_000
);
const BACKPRESSURE_MAX_PENDING_BYTES = Math.max(
  1024,
  Math.min(
    8 * 1024 * 1024,
    Number(process.env.SSE_BACKPRESSURE_MAX_PENDING_BYTES || 512 * 1024) || 512 * 1024
  )
);
const BACKPRESSURE_MAX_PENDING_EVENTS = Math.max(
  1,
  Math.min(1024, Number(process.env.SSE_BACKPRESSURE_MAX_PENDING_EVENTS || 64) || 64)
);
const BACKPRESSURE_MAX_TOTAL_PENDING_BYTES = Math.max(
  1024,
  Math.min(
    64 * 1024 * 1024,
    Number(process.env.SSE_BACKPRESSURE_MAX_TOTAL_PENDING_BYTES || 16 * 1024 * 1024)
      || 16 * 1024 * 1024
  )
);
const BACKPRESSURE_MAX_CONNECTIONS = Math.max(
  1,
  Math.min(4096, Number(process.env.SSE_BACKPRESSURE_MAX_CONNECTIONS || 256) || 256)
);
const backpressureStates = new WeakMap();
let totalPendingBytes = 0;
let activeBackpressureConnections = 0;

function cleanField(value, fallback = '') {
  return String(value == null ? fallback : value).replace(/[\r\n]+/g, ' ');
}

function removeListener(res, eventName, listener) {
  if (typeof res?.off === 'function') {
    res.off(eventName, listener);
  } else {
    res?.removeListener?.(eventName, listener);
  }
}

function releaseTrackedBytes(state) {
  if (!state) return;
  totalPendingBytes = Math.max(
    0,
    totalPendingBytes - state.pendingBytes - state.bufferedBytes
  );
  state.pendingFrames.length = 0;
  state.pendingBytes = 0;
  state.bufferedBytes = 0;
}

function releaseBufferedFrame(state) {
  if (!state?.bufferedBytes) return;
  totalPendingBytes = Math.max(0, totalPendingBytes - state.bufferedBytes);
  state.bufferedBytes = 0;
}

function clearBackpressure(res) {
  const state = backpressureStates.get(res);
  if (!state) return;
  clearTimeout(state.timer);
  releaseTrackedBytes(state);
  backpressureStates.delete(res);
  activeBackpressureConnections = Math.max(0, activeBackpressureConnections - 1);
  removeListener(res, 'drain', state.onDrain);
  removeListener(res, 'close', state.onClose);
  removeListener(res, 'finish', state.onFinish);
}

function beginBackpressure(res, initialFrameBytes) {
  if (!res || res.destroyed || res.writableEnded) return false;
  if (backpressureStates.has(res)) return true;
  if (
    activeBackpressureConnections >= BACKPRESSURE_MAX_CONNECTIONS
    || totalPendingBytes + initialFrameBytes > BACKPRESSURE_MAX_TOTAL_PENDING_BYTES
  ) {
    closeBackpressuredResponse(res);
    return false;
  }

  const state = {
    closing: false,
    timer: null,
    onDrain: null,
    onClose: null,
    onFinish: null,
    pendingFrames: [],
    pendingBytes: 0,
    bufferedBytes: initialFrameBytes,
  };
  state.onDrain = () => {
    releaseBufferedFrame(state);
    flushPendingFrames(res, state);
  };
  state.onClose = () => clearBackpressure(res);
  state.onFinish = () => clearBackpressure(res);
  state.timer = setTimeout(() => {
    if (backpressureStates.get(res) !== state) return;
    clearBackpressure(res);
    if (!res.destroyed && typeof res.destroy === 'function') {
      res.destroy();
    }
  }, BACKPRESSURE_CLOSE_TIMEOUT_MS);
  state.timer.unref?.();
  backpressureStates.set(res, state);
  totalPendingBytes += initialFrameBytes;
  activeBackpressureConnections += 1;
  res.once?.('drain', state.onDrain);
  res.once?.('close', state.onClose);
  res.once?.('finish', state.onFinish);
  return true;
}

function flushPendingFrames(res, state) {
  if (backpressureStates.get(res) !== state || state.closing) return;
  try {
    while (state.pendingFrames.length) {
      const pending = state.pendingFrames.shift();
      state.pendingBytes = Math.max(0, state.pendingBytes - pending.bytes);
      totalPendingBytes = Math.max(0, totalPendingBytes - pending.bytes);
      if (res.write(pending.frame) === false) {
        state.bufferedBytes = pending.bytes;
        totalPendingBytes += pending.bytes;
        res.once?.('drain', state.onDrain);
        return;
      }
    }
    clearBackpressure(res);
  } catch (_) {
    clearBackpressure(res);
    try {
      res.destroy?.();
    } catch (_) {
      // The socket is already unusable.
    }
  }
}

function enqueueBackpressuredFrame(res, frame) {
  const state = backpressureStates.get(res);
  if (!state || state.closing) return false;
  const bytes = Buffer.byteLength(frame, 'utf8');
  if (
    state.pendingFrames.length >= BACKPRESSURE_MAX_PENDING_EVENTS
    || state.pendingBytes + state.bufferedBytes + bytes > BACKPRESSURE_MAX_PENDING_BYTES
    || totalPendingBytes + bytes > BACKPRESSURE_MAX_TOTAL_PENDING_BYTES
  ) {
    closeBackpressuredResponse(res);
    return false;
  }
  state.pendingFrames.push({ frame, bytes });
  state.pendingBytes += bytes;
  totalPendingBytes += bytes;
  return true;
}

function closeBackpressuredResponse(res) {
  if (!res || res.destroyed || res.writableEnded) return;
  const state = backpressureStates.get(res);
  if (state?.closing) return;
  if (state) state.closing = true;

  try {
    clearBackpressure(res);
    if (typeof res.destroy === 'function') {
      res.destroy();
    } else if (typeof res.end === 'function') {
      res.end();
    }
  } catch (_) {
    clearBackpressure(res);
    try {
      res.destroy?.();
    } catch (_) {
      // The socket is already unusable.
    }
  }
}

function writeSseEvent(res, eventName, payload, options = {}) {
  if (!res || res.destroyed || res.writableEnded) return false;
  try {
    const id = options.id == null || options.id === ''
      ? ''
      : `id: ${cleanField(options.id)}\n`;
    const frame = `${id}event: ${cleanField(eventName, 'message')}\ndata: ${JSON.stringify(payload)}\n\n`;
    const frameBytes = Buffer.byteLength(frame, 'utf8');
    if (
      frameBytes > BACKPRESSURE_MAX_PENDING_BYTES
      || (
        !backpressureStates.has(res)
        && (
          activeBackpressureConnections >= BACKPRESSURE_MAX_CONNECTIONS
          || totalPendingBytes + frameBytes > BACKPRESSURE_MAX_TOTAL_PENDING_BYTES
        )
      )
    ) {
      closeBackpressuredResponse(res);
      return false;
    }
    if (backpressureStates.has(res)) {
      return enqueueBackpressuredFrame(res, frame);
    }
    if (res.write(frame) === false) {
      return beginBackpressure(res, frameBytes);
    }
    return true;
  } catch (_) {
    try {
      res.destroy?.();
    } catch (_) {
      // The socket is already unusable.
    }
    return false;
  }
}

module.exports = {
  writeSseEvent,
};
