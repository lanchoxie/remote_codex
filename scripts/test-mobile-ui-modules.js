const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const imagePreview = require('../apps/mobile-web/public/image-preview.js');
const directoryPicker = require('../apps/mobile-web/public/directory-picker.js');
const relayApi = require('../apps/mobile-web/public/relay-api.js');
const sessionStream = require('../apps/mobile-web/public/session-stream-client.js');
const sessionModal = require('../apps/mobile-web/public/session-modal-controller.js');

const indexSource = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'index.html'),
  'utf8'
);
const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js'),
  'utf8'
);

function elementGetter(document) {
  return (id) => document.getElementById(id);
}

function imageDom() {
  return new JSDOM(`<!doctype html><body>
    <div id="image-preview-overlay" class="hidden"><div id="image-preview">
      <img id="image-preview-img"><div id="image-preview-title"></div>
      <div id="image-preview-subtitle"></div><a id="image-preview-open-link"></a>
      <a id="image-preview-save-link"></a><button id="image-preview-close-button"></button>
    </div></div>
  </body>`, { url: 'http://localhost/' });
}

async function testImagePreview() {
  const dom = imageDom();
  const document = dom.window.document;
  let state = { ...imagePreview.CLOSED_STATE };
  let syncs = 0;
  const controller = imagePreview.createImagePreviewController({
    document,
    getElement: elementGetter(document),
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; },
    syncModalBodyState: () => { syncs += 1; },
  });
  assert.strictEqual(controller.open({ src: '/image.png', title: 'A & B', subtitle: 'detail' }), true);
  assert.strictEqual(document.getElementById('image-preview-overlay').classList.contains('hidden'), false);
  assert.strictEqual(document.getElementById('image-preview-img').src, 'http://localhost/image.png');
  assert.strictEqual(document.getElementById('image-preview-title').textContent, 'A & B');
  assert.strictEqual(document.getElementById('image-preview-save-link').download, 'A & B');
  assert(syncs > 0);

  controller.bind();
  controller.bind();
  document.getElementById('image-preview-close-button').click();
  assert.strictEqual(state.open, false, 'binding twice must not duplicate close handlers');
  controller.open({ src: '/second.png' });
  const overlay = document.getElementById('image-preview-overlay');
  overlay.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.strictEqual(state.open, false, 'clicking the backdrop closes the preview');
}

function directoryDom() {
  return new JSDOM(`<!doctype html><body>
    <button id="browse-directory-button"></button><div id="directory-picker-overlay" class="hidden"></div>
    <section id="directory-picker" class="hidden"><div id="picker-host"></div><div id="picker-status"></div>
      <div id="picker-current-path"></div><button id="picker-up-button"></button>
      <button id="picker-refresh-button"></button><button id="picker-select-button"></button>
      <div id="picker-roots"></div><div id="picker-recents"></div><div id="picker-directories"></div>
    </section>
  </body>`, { url: 'http://localhost/' });
}

async function testDirectoryPicker() {
  const dom = directoryDom();
  const document = dom.window.document;
  let state = {
    open: false, hostId: null, currentPath: '', parentPath: null,
    roots: [], directories: [], loading: false, error: null,
  };
  const requests = [];
  const callbacks = [];
  let applied = '';
  const host = { hostId: 'host-a', label: 'Host A' };
  const controller = directoryPicker.createDirectoryPickerController({
    document,
    getElement: elementGetter(document),
    getState: () => state,
    setState: (next) => { state = { ...state, ...next }; },
    getSelectedHost: () => host,
    getRecentDirectories: () => [{ path: '/recent', title: 'Recent' }],
    getOpenSeedPath: () => '/workspace',
    fetchJson: (url) => {
      requests.push(url);
      return new Promise((resolve) => callbacks.push(resolve));
    },
    onApply: (path) => { applied = path; },
    onError: (error) => { throw error; },
    syncModalBodyState: () => {},
  });

  controller.bind();
  controller.bind();
  document.getElementById('browse-directory-button').click();
  await Promise.resolve();
  assert.deepStrictEqual(requests, ['/api/hosts/host-a/directories?path=%2Fworkspace']);
  callbacks.shift()({
    currentPath: '/workspace', parentPath: '/', roots: [{ name: 'Root', path: '/' }],
    directories: [{ name: '<unsafe>', path: '/workspace/sub' }],
  });
  await Promise.resolve();
  assert.strictEqual(state.loading, false);
  assert.strictEqual(document.getElementById('picker-host').textContent, 'Host A');
  assert.strictEqual(document.querySelector('#picker-directories .name').textContent, '<unsafe>');
  assert.strictEqual(document.querySelector('#picker-directories .name script'), null);

  document.getElementById('picker-select-button').click();
  assert.strictEqual(applied, '/workspace');
  assert.strictEqual(state.open, false);

  // A slower response from an older path must not overwrite the newer one.
  controller.open();
  await Promise.resolve();
  controller.browse('/newer');
  await Promise.resolve();
  assert.strictEqual(requests.length, 3);
  callbacks[1]({ currentPath: '/newer', parentPath: '/', roots: [], directories: [] });
  callbacks[0]({ currentPath: '/workspace', parentPath: '/', roots: [], directories: [] });
  await Promise.resolve();
  assert.strictEqual(state.currentPath, '/newer');
}

async function testRelayApi() {
  const calls = [];
  const unauthorized = [];
  const api = relayApi.createRelayApi({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: false,
        status: 401,
        json: async () => ({
          authRequired: true,
          error: 'login required',
          code: 'auth_required',
        }),
      };
    },
    onUnauthorized: (message) => unauthorized.push(message),
  });
  await assert.rejects(api.requestJson('/api/private'), (error) => {
    assert.strictEqual(error.status, 401);
    assert.strictEqual(error.code, 'auth_required');
    return true;
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(unauthorized, ['login required']);

  let aborted = false;
  const timeoutApi = relayApi.createRelayApi({
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        aborted = true;
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(timeoutApi.requestJson('/slow', { timeoutMs: 5 }), /timed out/i);
  assert.strictEqual(aborted, true);
}

async function main() {
  assert.strictEqual(typeof imagePreview.createImagePreviewController, 'function');
  assert.strictEqual(typeof directoryPicker.createDirectoryPickerController, 'function');
  assert.strictEqual(typeof relayApi.createRelayApi, 'function');
  assert.strictEqual(typeof sessionStream.createSessionStreamClient, 'function');
  assert.strictEqual(typeof sessionModal.createSessionModalController, 'function');
  assert(indexSource.indexOf('/relay-api.js') < indexSource.indexOf('/app.js'));
  assert(indexSource.indexOf('/image-preview.js') < indexSource.indexOf('/app.js'));
  assert(indexSource.indexOf('/directory-picker.js') < indexSource.indexOf('/app.js'));
  assert(indexSource.indexOf('/session-stream-client.js') < indexSource.indexOf('/app.js'));
  assert(indexSource.indexOf('/session-modal-controller.js') < indexSource.indexOf('/app.js'));
  assert(!/state\.(?:sessionDetailsOpen|statusWindowOpen|alertWindowOpen)\s*=/.test(appSource));
  assert(appSource.includes("throw new Error('Session modal controller is not loaded')"));
  await testImagePreview();
  await testDirectoryPicker();
  await testRelayApi();
  console.log('mobile UI module checks passed');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
