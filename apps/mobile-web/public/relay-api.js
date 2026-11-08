(function initRelayApi(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemoteCodexRelayApi = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  function text(value) {
    return String(value == null ? '' : value);
  }

  function createRequestError(response, body, url) {
    const payload = body && typeof body === 'object' ? body : {};
    const error = new Error(
      text(payload.error || payload.message) || `request failed: ${response?.status || 'network error'}`
    );
    error.status = Number(response?.status || 0);
    error.body = body;
    error.url = url;
    error.code = payload.code || null;
    error.stage = payload.stage || null;
    error.sessionBinding = payload.sessionBinding || null;
    error.submittedBinding = payload.submittedBinding || null;
    error.canRebind = Boolean(payload.canRebind);
    error.canTranscriptFallback = Boolean(payload.canTranscriptFallback);
    error.requiresExplicitTranscriptFallback = Boolean(payload.requiresExplicitTranscriptFallback);
    return error;
  }

  function createRelayApi(options = {}) {
    const fetchImpl = options.fetch || root.fetch?.bind(root);
    const setTimeoutImpl = options.setTimeout || root.setTimeout?.bind(root) || setTimeout;
    const clearTimeoutImpl = options.clearTimeout || root.clearTimeout?.bind(root) || clearTimeout;
    const AbortControllerImpl = options.AbortController || root.AbortController;
    const onUnauthorized = typeof options.onUnauthorized === 'function'
      ? options.onUnauthorized
      : () => {};

    async function requestJson(url, requestOptions = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('Relay API fetch is not available.');
      }
      const { timeoutMs: requestedTimeoutMs, ...rest } = requestOptions;
      const timeoutMs = Math.max(0, Number(requestedTimeoutMs || 0) || 0);
      const controller = timeoutMs > 0 && !rest.signal && typeof AbortControllerImpl === 'function'
        ? new AbortControllerImpl()
        : null;
      let timedOut = false;
      let timeout = null;
      if (controller) {
        rest.signal = controller.signal;
        timeout = setTimeoutImpl(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }

      let response;
      let body;
      try {
        response = await fetchImpl(url, {
          headers: {
            'Content-Type': 'application/json',
            ...(rest.headers || {}),
          },
          ...rest,
        });
        body = await response.json();
      } catch (error) {
        if (timedOut) {
          const timeoutError = new Error(`Request timed out after ${timeoutMs}ms.`);
          timeoutError.code = 'request_timeout';
          timeoutError.url = url;
          throw timeoutError;
        }
        throw error;
      } finally {
        if (timeout !== null) clearTimeoutImpl(timeout);
      }

      if (!response.ok) {
        const error = createRequestError(response, body, url);
        if (error.status === 401 && body?.authRequired && !requestOptions.skipAuthHandling) {
          onUnauthorized(error.message);
        }
        throw error;
      }
      return body;
    }

    return Object.freeze({ requestJson });
  }

  return Object.freeze({
    createRelayApi,
    createRequestError,
  });
}));
