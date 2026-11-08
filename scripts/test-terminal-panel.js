const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const panelPath = path.join(ROOT, 'apps', 'mobile-web', 'public', 'terminal-panel.js');
const stylePath = path.join(ROOT, 'apps', 'mobile-web', 'public', 'terminal-panel.css');
const vendorRoot = path.join(ROOT, 'apps', 'mobile-web', 'public', 'vendor', 'xterm');
const source = fs.readFileSync(panelPath, 'utf8');
const css = fs.readFileSync(stylePath, 'utf8');
const api = require(panelPath);

class FakeTerminal {
  constructor() { this.cols = 80; this.rows = 24; this.writes = []; }
  loadAddon(addon) { addon.activate(this); }
  open(node) { this.node = node; }
  onData(callback) {
    this.onDataCallback = callback;
    return { dispose: () => { this.onDataCallback = null; } };
  }
  write(value) { this.writes.push(value); }
  focus() { this.focused = true; }
  dispose() { this.disposed = true; }
}
class FakeFitAddon {
  activate(terminal) { this.terminal = terminal; }
  fit() { this.terminal.cols = 100; this.terminal.rows = 32; }
}
class FakeEventSource {
  static instances = [];
  constructor(url, options) {
    this.url = url; this.options = options; this.listeners = {}; this.readyState = 1;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  emit(type, payload) {
    const event = { data: JSON.stringify(payload) };
    if (type === 'message') this.onmessage?.(event); else this.listeners[type]?.(event);
  }
  close() { this.closed = true; this.readyState = 2; }
}
class FakeResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe(node) { this.node = node; }
  disconnect() { this.disconnected = true; }
}
function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

async function verifyLifecycle() {
  FakeEventSource.instances = [];
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:8897/' });
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/create')) return response(200, { terminalId: 'term-1', output: 'ready\r\n' });
    return response(200, { ok: true });
  };
  const panel = api.createTerminalPanel({
    document: dom.window.document,
    fetch,
    EventSource: FakeEventSource,
    ResizeObserver: FakeResizeObserver,
    Terminal: FakeTerminal,
    FitAddon: FakeFitAddon,
    hostId: 'host-a',
    sessionId: 'session-a',
    title: 'Project terminal',
    endpoints: {
      create: '/api/terminal/create',
      input: ({ terminalId }) => `/api/terminal/${terminalId}/input`,
      resize: ({ terminalId }) => `/api/terminal/${terminalId}/resize`,
      close: ({ terminalId }) => `/api/terminal/${terminalId}/close`,
      output: ({ terminalId }) => `/api/terminal/${terminalId}/output`,
    },
  });
  assert(panel.panel.classList.contains('remote-terminal-panel-hidden'));
  const firstOpen = panel.open();
  const secondOpen = panel.open();
  assert.strictEqual(firstOpen, secondOpen, 'concurrent opens should share one create request');
  await firstOpen;
  assert.strictEqual(requests.filter((item) => item.url.endsWith('/create')).length, 1);
  assert.deepStrictEqual(requests[0].body, {
    hostId: 'host-a', sessionId: 'session-a', cols: 100, rows: 32,
  });
  assert.strictEqual(requests[0].body.cwd, undefined, 'component must not accept or submit cwd');
  assert.strictEqual(panel.terminal.writes.join(''), 'ready\r\n');
  assert.strictEqual(FakeEventSource.instances.length, 1);
  assert(FakeEventSource.instances[0].url.includes('/api/terminal/term-1/output'));
  assert(FakeEventSource.instances[0].url.includes('terminalId=term-1'));
  FakeEventSource.instances[0].emit('output', { type: 'output', data: 'hello' });
  assert.strictEqual(panel.terminal.writes.join(''), 'ready\r\nhello');
  panel.terminal.onDataCallback('dir\r');
  await panel.inputChain;
  assert.deepStrictEqual(requests.find((item) => item.url.endsWith('/term-1/input')).body, {
    terminalId: 'term-1', data: 'dir\r',
  });
  assert.strictEqual(await panel.sendResize(), true);
  assert.deepStrictEqual(requests.find((item) => item.url.endsWith('/term-1/resize')).body, {
    terminalId: 'term-1', cols: 100, rows: 32,
  });
  panel.minimize();
  assert(panel.panel.classList.contains('remote-terminal-panel-minimized'));
  panel.minimize();
  panel.maximize();
  assert(panel.panel.classList.contains('remote-terminal-panel-maximized'));
  panel.maximize();
  assert.strictEqual(await panel.close(), true);
  assert(requests.some((item) => item.url.endsWith('/term-1/close')));
  assert.strictEqual(FakeEventSource.instances[0].closed, true);
  assert.strictEqual(dom.window.document.querySelector('.remote-terminal-panel'), null);
}

async function verifyErrorsStayLocal() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:8897/' });
  const errors = [];
  const panel = api.createTerminalPanel({
    document: dom.window.document,
    fetch: async () => response(409, { code: 'terminal_busy', error: 'Terminal is busy.' }),
    EventSource: FakeEventSource,
    ResizeObserver: FakeResizeObserver,
    Terminal: FakeTerminal,
    FitAddon: FakeFitAddon,
    endpoints: { create: '/create' },
    onError: (error) => errors.push(error),
  });
  await assert.rejects(panel.open(), /Terminal is busy/);
  assert.strictEqual(panel.status.textContent, 'Terminal is busy.');
  assert.strictEqual(panel.panel.dataset.terminalState, 'error');
  assert.strictEqual(errors[0].code, 'terminal_busy');
  panel.destroy();
}

async function main() {
  assert.strictEqual(typeof api.createTerminalPanel, 'function');
  assert.strictEqual(typeof api.TerminalPanel, 'function');
  assert(source.includes('root.RemoteCodexTerminalPanel = api'));
  assert(!source.includes('composer'));
  assert(!source.includes('selectedSession'));
  assert(!source.includes('sessionTerminalBusyKeys'));
  assert(css.includes('@media (max-width: 720px), (pointer: coarse)'));
  assert(/\.remote-terminal-panel\s*\{[\s\S]*?position:\s*fixed/.test(css));
  assert(/@media \(max-width: 720px\), \(pointer: coarse\)[\s\S]*?inset:\s*auto 0 0;[\s\S]*?width:\s*100%/.test(css));
  for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js', 'LICENSE.xterm']) {
    assert(fs.existsSync(path.join(vendorRoot, name)), `missing vendored ${name}`);
  }
  await verifyLifecycle();
  await verifyErrorsStayLocal();
  console.log('terminal panel component checks passed');
}
main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
