(function initTerminalPanel(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexTerminalPanel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  const DEFAULT_TIMEOUT_MS = 20000;
  const MIN_WIDTH = 420;
  const MIN_HEIGHT = 260;

  function text(value) { return String(value == null ? '' : value).trim(); }
  function integer(value, fallback, minimum = 1) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
  }
  function endpointValue(endpoint, context) {
    return typeof endpoint === 'function' ? endpoint(context) : endpoint;
  }
  function configuredUrl(endpoint, context, name) {
    const value = text(endpointValue(endpoint, context));
    if (!value) throw new Error(`Terminal ${name} endpoint is not configured.`);
    return value;
  }
  function appendQuery(url, values) {
    const resolved = new URL(url, root.location?.href || 'http://localhost/');
    for (const [key, value] of Object.entries(values || {})) {
      if (value != null && String(value) !== '') resolved.searchParams.set(key, String(value));
    }
    return resolved.href;
  }
  function parseSsePayload(event) {
    if (!event) return null;
    if (typeof event.data !== 'string') return event.data ?? null;
    try { return JSON.parse(event.data); } catch { return { data: event.data }; }
  }
  function outputText(payload) {
    if (typeof payload === 'string') return payload;
    if (!payload || typeof payload !== 'object') return '';
    for (const key of ['data', 'output', 'text', 'chunk']) {
      if (typeof payload[key] === 'string') return payload[key];
    }
    return '';
  }
  function requestError(response, payload) {
    const error = new Error(text(payload?.error || payload?.message)
      || `Terminal request failed (${response.status || 'network error'}).`);
    error.code = text(payload?.code) || 'terminal_request_failed';
    error.status = Number(response.status || 0);
    error.payload = payload;
    return error;
  }
  async function requestJson(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = root.AbortController ? new root.AbortController() : null;
    const timer = controller && timeoutMs > 0
      ? root.setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const response = await fetchImpl(url, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        ...options,
        signal: options.signal || controller?.signal,
      });
      const raw = await response.text();
      let payload = {};
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = { message: raw }; }
      }
      if (!response.ok) throw requestError(response, payload);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeout = new Error('Terminal request timed out.');
        timeout.code = 'terminal_request_timeout';
        throw timeout;
      }
      throw error;
    } finally {
      if (timer) root.clearTimeout(timer);
    }
  }
  function createButton(document, action, label, symbol) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'remote-terminal-control';
    button.dataset.terminalAction = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = symbol;
    return button;
  }
  function createMarkup(document, title) {
    const panel = document.createElement('section');
    panel.className = 'remote-terminal-panel remote-terminal-panel-hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', title);
    panel.setAttribute('aria-hidden', 'true');
    panel.tabIndex = -1;
    const header = document.createElement('header');
    header.className = 'remote-terminal-header';
    const identity = document.createElement('div');
    identity.className = 'remote-terminal-identity';
    const indicator = document.createElement('span');
    indicator.className = 'remote-terminal-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const heading = document.createElement('strong');
    heading.className = 'remote-terminal-title';
    heading.textContent = title;
    const status = document.createElement('span');
    status.className = 'remote-terminal-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Closed';
    identity.append(indicator, heading, status);
    const controls = document.createElement('div');
    controls.className = 'remote-terminal-controls';
    controls.append(
      createButton(document, 'minimize', 'Minimize terminal', '\u2212'),
      createButton(document, 'maximize', 'Maximize terminal', '\u25a1'),
      createButton(document, 'close', 'Close terminal', '\u00d7')
    );
    header.append(identity, controls);
    const viewport = document.createElement('div');
    viewport.className = 'remote-terminal-viewport';
    const mount = document.createElement('div');
    mount.className = 'remote-terminal-xterm';
    viewport.appendChild(mount);
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'remote-terminal-resize-handle';
    resizeHandle.setAttribute('aria-hidden', 'true');
    panel.append(header, viewport, resizeHandle);
    return { panel, header, heading, status, mount, controls, resizeHandle };
  }

  class TerminalPanel {
    constructor(options = {}) {
      this.options = options;
      this.document = options.document || root.document;
      if (!this.document?.createElement) throw new Error('TerminalPanel requires a document.');
      this.fetchImpl = options.fetch || root.fetch?.bind(root);
      this.EventSourceImpl = options.EventSource || root.EventSource;
      this.TerminalCtor = options.Terminal || root.Terminal;
      this.FitAddonCtor = options.FitAddon || root.FitAddon?.FitAddon || root.FitAddon;
      if (!this.fetchImpl) throw new Error('TerminalPanel requires fetch.');
      if (typeof this.TerminalCtor !== 'function') throw new Error('xterm Terminal is not available.');
      if (typeof this.FitAddonCtor !== 'function') throw new Error('xterm FitAddon is not available.');
      this.hostId = text(options.hostId);
      this.sessionId = text(options.sessionId);
      this.title = text(options.title) || 'Terminal';
      this.endpoints = options.endpoints || {};
      this.timeoutMs = integer(options.timeoutMs, DEFAULT_TIMEOUT_MS, 0);
      this.terminalId = '';
      this.disposables = [];
      this.eventSource = null;
      this.resizeTimer = null;
      this.createPromise = null;
      this.inputChain = Promise.resolve();
      this.closePromise = null;
      this.closed = false;
      this.opened = false;
      this.maximized = false;
      this.minimized = false;
      this.pointerOperation = null;
      this.previousRect = null;
      Object.assign(this, createMarkup(this.document, this.title));
      const container = options.container || this.document.body;
      if (!container?.appendChild) throw new Error('TerminalPanel requires a DOM container.');
      container.appendChild(this.panel);
      this.terminal = new this.TerminalCtor({
        cursorBlink: true,
        fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.18,
        scrollback: 10000,
        theme: {
          background: '#080d18', foreground: '#e8efff', cursor: '#7de7cb',
          cursorAccent: '#080d18', selectionBackground: '#355d78aa',
        },
        ...(options.terminalOptions || {}),
      });
      this.fitAddon = new this.FitAddonCtor();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.open(this.mount);
      this.bindEvents();
    }
    context(extra = {}) {
      return {
        hostId: this.hostId, sessionId: this.sessionId, terminalId: this.terminalId,
        cols: this.terminal.cols, rows: this.terminal.rows, ...extra,
      };
    }
    endpoint(name) { return configuredUrl(this.endpoints[name], this.context(), name); }
    setStatus(label, state = '') {
      this.status.textContent = label;
      this.panel.dataset.terminalState = state;
    }
    show() {
      if (this.closed) throw new Error('This terminal panel has been disposed.');
      this.panel.classList.remove('remote-terminal-panel-hidden');
      this.panel.classList.remove('remote-terminal-panel-minimized');
      this.panel.setAttribute('aria-hidden', 'false');
      this.minimized = false;
      this.scheduleFit();
      return this;
    }
    open() {
      if (this.closed) return Promise.reject(new Error('This terminal panel has been disposed.'));
      this.show();
      if (this.opened) {
        this.terminal.focus();
        return Promise.resolve(this);
      }
      if (!this.createPromise) {
        this.createPromise = this.create().finally(() => { this.createPromise = null; });
      }
      return this.createPromise;
    }
    async create() {
      this.fit();
      this.setStatus('Connecting...', 'connecting');
      try {
        const payload = await requestJson(this.fetchImpl, this.endpoint('create'), {
          method: 'POST',
          body: JSON.stringify({
            hostId: this.hostId || undefined, sessionId: this.sessionId || undefined,
            cols: this.terminal.cols, rows: this.terminal.rows,
          }),
        }, this.timeoutMs);
        this.terminalId = text(payload.terminalId || payload.id || payload.ptyId);
        if (!this.terminalId) throw new Error('Terminal create response did not include terminalId.');
        this.opened = true;
        if (text(payload.title)) this.heading.textContent = text(payload.title);
        if (typeof payload.output === 'string') this.terminal.write(payload.output);
        this.connectOutput();
        this.setStatus('Connected', 'connected');
        this.scheduleFit(true);
        this.terminal.focus();
        this.options.onOpen?.(payload, this);
        return this;
      } catch (error) {
        this.setStatus(text(error?.message) || 'Connection failed', 'error');
        this.options.onError?.(error, this);
        throw error;
      }
    }
    connectOutput() {
      this.disconnectOutput();
      if (!this.EventSourceImpl) throw new Error('Terminal output requires EventSource.');
      const url = appendQuery(this.endpoint('output'), {
        terminalId: this.terminalId, hostId: this.hostId || undefined,
        sessionId: this.sessionId || undefined,
      });
      const stream = new this.EventSourceImpl(url, { withCredentials: true });
      this.eventSource = stream;
      stream.onopen = () => this.setStatus('Connected', 'connected');
      stream.onmessage = (event) => this.handleOutputEvent(event);
      stream.onerror = (event) => {
        if (this.closed || stream.readyState === 2) return;
        this.setStatus('Reconnecting...', 'reconnecting');
        this.options.onStreamError?.(event, this);
      };
      for (const type of ['output', 'data', 'exit', 'closed', 'error']) {
        stream.addEventListener?.(type, (event) => this.handleOutputEvent(event, type));
      }
    }
    handleOutputEvent(event, eventType = '') {
      const payload = parseSsePayload(event);
      const type = text(payload?.type || eventType).toLowerCase();
      const data = outputText(payload);
      if (data) this.terminal.write(data);
      if (type === 'exit' || type === 'closed' || payload?.closed === true) {
        this.setStatus(payload?.exitCode == null ? 'Exited' : `Exited (${payload.exitCode})`, 'exited');
        this.opened = false;
        this.disconnectOutput();
        this.options.onExit?.(payload, this);
      } else if (type === 'error') {
        this.setStatus(text(payload?.error || payload?.message) || 'Terminal error', 'error');
        this.options.onError?.(requestError({ status: 0 }, payload), this);
      }
    }
    sendInput(data) {
      if (!this.opened || this.closed || !this.terminalId || data == null || data === '') {
        return Promise.resolve(false);
      }
      this.inputChain = this.inputChain.catch(() => {}).then(() => requestJson(
        this.fetchImpl, this.endpoint('input'), {
          method: 'POST', body: JSON.stringify({ terminalId: this.terminalId, data: String(data) }),
        }, this.timeoutMs
      )).then(() => true).catch((error) => {
        this.setStatus(text(error?.message) || 'Input failed', 'error');
        this.options.onError?.(error, this);
        return false;
      });
      return this.inputChain;
    }
    sendResize() {
      if (!this.opened || this.closed || !this.terminalId) return Promise.resolve(false);
      return requestJson(this.fetchImpl, this.endpoint('resize'), {
        method: 'POST',
        body: JSON.stringify({ terminalId: this.terminalId, cols: this.terminal.cols, rows: this.terminal.rows }),
      }, this.timeoutMs).then(() => true).catch((error) => {
        this.options.onError?.(error, this);
        return false;
      });
    }
    fit(notify = false) {
      if (this.closed || this.minimized || this.panel.classList.contains('remote-terminal-panel-hidden')) return;
      const before = `${this.terminal.cols}x${this.terminal.rows}`;
      try { this.fitAddon.fit(); } catch (error) { this.options.onError?.(error, this); return; }
      if (notify && before !== `${this.terminal.cols}x${this.terminal.rows}`) this.sendResize();
    }
    scheduleFit(notify = false) {
      if (this.resizeTimer) root.clearTimeout(this.resizeTimer);
      this.resizeTimer = root.setTimeout(() => {
        this.resizeTimer = null;
        this.fit(notify);
      }, 40);
    }
    minimize() {
      if (this.closed) return;
      this.minimized = !this.minimized;
      this.panel.classList.toggle('remote-terminal-panel-minimized', this.minimized);
      const button = this.controls.querySelector('[data-terminal-action="minimize"]');
      if (button) {
        button.textContent = this.minimized ? '\u25b2' : '\u2212';
        button.title = this.minimized ? 'Restore terminal' : 'Minimize terminal';
        button.setAttribute('aria-label', button.title);
      }
      if (!this.minimized) { this.scheduleFit(true); this.terminal.focus(); }
      this.options.onDisplayChange?.({ minimized: this.minimized, maximized: this.maximized }, this);
    }
    maximize() {
      if (this.closed) return;
      if (!this.maximized) {
        const rect = this.panel.getBoundingClientRect();
        this.previousRect = {
          left: this.panel.style.left, top: this.panel.style.top,
          width: this.panel.style.width || `${rect.width}px`, height: this.panel.style.height || `${rect.height}px`,
        };
      }
      this.maximized = !this.maximized;
      this.panel.classList.toggle('remote-terminal-panel-maximized', this.maximized);
      if (this.maximized) {
        for (const property of ['left', 'top', 'width', 'height']) this.panel.style.removeProperty(property);
      } else if (this.previousRect) Object.assign(this.panel.style, this.previousRect);
      this.minimized = false;
      this.panel.classList.remove('remote-terminal-panel-minimized');
      const button = this.controls.querySelector('[data-terminal-action="maximize"]');
      if (button) {
        button.textContent = this.maximized ? '\u2750' : '\u25a1';
        button.title = this.maximized ? 'Restore terminal' : 'Maximize terminal';
        button.setAttribute('aria-label', button.title);
      }
      this.scheduleFit(true);
      this.options.onDisplayChange?.({ minimized: false, maximized: this.maximized }, this);
    }
    startPointer(event, mode) {
      if (this.closed || this.maximized || event.button !== 0) return;
      if (mode === 'move' && event.target.closest?.('.remote-terminal-controls')) return;
      const rect = this.panel.getBoundingClientRect();
      this.pointerOperation = {
        mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      };
      event.target.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    }
    movePointer(event) {
      const operation = this.pointerOperation;
      if (!operation || operation.pointerId !== event.pointerId) return;
      const dx = event.clientX - operation.startX;
      const dy = event.clientY - operation.startY;
      if (operation.mode === 'move') {
        const maxLeft = Math.max(0, (root.innerWidth || this.document.documentElement.clientWidth) - 120);
        const maxTop = Math.max(0, (root.innerHeight || this.document.documentElement.clientHeight) - 48);
        this.panel.style.left = `${Math.min(Math.max(0, operation.left + dx), maxLeft)}px`;
        this.panel.style.top = `${Math.min(Math.max(0, operation.top + dy), maxTop)}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
      } else {
        const maxWidth = Math.max(MIN_WIDTH, (root.innerWidth || 1280) - operation.left);
        const maxHeight = Math.max(MIN_HEIGHT, (root.innerHeight || 720) - operation.top);
        this.panel.style.width = `${Math.min(Math.max(MIN_WIDTH, operation.width + dx), maxWidth)}px`;
        this.panel.style.height = `${Math.min(Math.max(MIN_HEIGHT, operation.height + dy), maxHeight)}px`;
      }
      this.scheduleFit();
    }
    endPointer(event) {
      if (!this.pointerOperation || this.pointerOperation.pointerId !== event.pointerId) return;
      const resized = this.pointerOperation.mode === 'resize';
      this.pointerOperation = null;
      event.target.releasePointerCapture?.(event.pointerId);
      if (resized) this.scheduleFit(true);
    }
    bindEvents() {
      const onClick = (event) => {
        const action = event.target.closest?.('[data-terminal-action]')?.dataset?.terminalAction;
        if (action === 'minimize') this.minimize();
        else if (action === 'maximize') this.maximize();
        else if (action === 'close') this.close();
      };
      this.panel.addEventListener('click', onClick);
      this.disposables.push(() => this.panel.removeEventListener('click', onClick));
      const inputDisposable = this.terminal.onData((data) => this.sendInput(data));
      this.disposables.push(() => inputDisposable?.dispose?.());
      const onHeaderDown = (event) => this.startPointer(event, 'move');
      const onResizeDown = (event) => this.startPointer(event, 'resize');
      const onPointerMove = (event) => this.movePointer(event);
      const onPointerUp = (event) => this.endPointer(event);
      this.header.addEventListener('pointerdown', onHeaderDown);
      this.resizeHandle.addEventListener('pointerdown', onResizeDown);
      root.addEventListener?.('pointermove', onPointerMove);
      root.addEventListener?.('pointerup', onPointerUp);
      root.addEventListener?.('pointercancel', onPointerUp);
      this.disposables.push(() => {
        this.header.removeEventListener('pointerdown', onHeaderDown);
        this.resizeHandle.removeEventListener('pointerdown', onResizeDown);
        root.removeEventListener?.('pointermove', onPointerMove);
        root.removeEventListener?.('pointerup', onPointerUp);
        root.removeEventListener?.('pointercancel', onPointerUp);
      });
      const ResizeObserverImpl = this.options.ResizeObserver || root.ResizeObserver;
      if (ResizeObserverImpl) {
        this.resizeObserver = new ResizeObserverImpl(() => this.scheduleFit(true));
        this.resizeObserver.observe(this.panel);
        this.disposables.push(() => this.resizeObserver?.disconnect());
      } else {
        const onWindowResize = () => this.scheduleFit(true);
        root.addEventListener?.('resize', onWindowResize);
        this.disposables.push(() => root.removeEventListener?.('resize', onWindowResize));
      }
    }
    disconnectOutput() {
      this.eventSource?.close?.();
      this.eventSource = null;
    }
    close(options = {}) {
      if (this.closed) return Promise.resolve(true);
      if (this.closePromise) return this.closePromise;
      this.closed = true;
      this.opened = false;
      this.disconnectOutput();
      this.setStatus('Closing...', 'closing');
      this.closePromise = (async () => {
        let closeError = null;
        if (this.terminalId && options.remote !== false) {
          try {
            await requestJson(this.fetchImpl, this.endpoint('close'), {
              method: 'POST', body: JSON.stringify({ terminalId: this.terminalId }), keepalive: true,
            }, this.timeoutMs);
          } catch (error) { closeError = error; this.options.onError?.(error, this); }
        }
        this.destroy();
        this.options.onClose?.({ terminalId: this.terminalId, error: closeError }, this);
        return !closeError;
      })();
      return this.closePromise;
    }
    destroy() {
      this.closed = true;
      this.opened = false;
      this.disconnectOutput();
      if (this.resizeTimer) root.clearTimeout(this.resizeTimer);
      for (const dispose of this.disposables.splice(0)) {
        try { dispose(); } catch { /* best effort cleanup */ }
      }
      this.terminal.dispose?.();
      this.panel.remove();
    }
  }
  return {
    TerminalPanel,
    createTerminalPanel: (options) => new TerminalPanel(options),
    parseSsePayload,
    outputText,
  };
}));
