const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { chromium } = require('@playwright/test');
const { readUiStyles } = require('./ui-style-fixture');
const theme = require('../apps/mobile-web/public/ui/theme');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'apps/mobile-web/public');
const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const helperSource = fs.readFileSync(path.join(publicRoot, 'ui/theme.js'), 'utf8');
const app = fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8');
const output = path.join(root, 'tmp', 'ui-phase1-acceptance');
const sampleSettings = JSON.stringify({
  theme: 'dark-tech', locale: 'zh-CN', optimizeSpeedMode: false,
  apiProfiles: [{ profileId: 'fixture', apiKey: 'fake-test-key-only' }],
  hostApiProfiles: { 'fixture-host': 'fixture' }, selectedApiProfileId: 'fixture',
});
for (const value of [null, undefined, {}, ['dark-tech'], '__proto__', 'unknown', 'minimal-light']) {
  assert.strictEqual(theme.normalize(value), 'minimal-light');
}
assert.strictEqual(theme.normalize('dark-tech'), 'dark-tech');

function checkBootstrap(getItem) {
  const dom = new JSDOM('<meta name="theme-color" content="old"><textarea id="draft">keep me</textarea>');
  let writes = 0;
  const context = vm.createContext({
    document: dom.window.document,
    localStorage: { getItem, setItem() { writes++; throw new Error('UI helper must never write shared settings'); } },
  });
  vm.runInContext(helperSource, context);
  assert.strictEqual(writes, 0);
  assert.strictEqual(dom.window.document.querySelector('#draft').value, 'keep me');
  return dom.window.document;
}
assert.strictEqual(checkBootstrap(() => sampleSettings).documentElement.dataset.theme, 'dark-tech');
assert.strictEqual(checkBootstrap(() => { throw new Error('blocked storage'); }).documentElement.dataset.theme, 'minimal-light');
assert.strictEqual(checkBootstrap(() => '{bad').documentElement.dataset.theme, 'minimal-light');
// Exercise the ACTUAL app preview handler with the real helper. Do not save profiles.
const previewStart = app.indexOf("el('settings-theme-select').addEventListener('change'");
const previewEnd = app.indexOf('\n});', previewStart);
assert(previewStart > 0 && previewEnd > previewStart);
const previewDom = new JSDOM('<meta name="theme-color"><select id="settings-theme-select"><option>dark-tech</option></select>');
const state = { ui: JSON.parse(sampleSettings) };
const runtimeState = { activeTurnId: 'fixture-turn', queue: ['keep'], runId: 'fixture-run' };
let handler;
const themeContext = vm.createContext({
  state, document: previewDom.window.document, window: { RemoteCodexTheme: theme },
  el: () => ({ addEventListener: (_name, callback) => { handler = callback; } }),
});
const themeStart = app.indexOf('function currentTheme()');
const themeEnd = app.indexOf('\nfunction t(', themeStart);
vm.runInContext(app.slice(themeStart, themeEnd) + '\n' + app.slice(previewStart, previewEnd + 4), themeContext);
handler({ target: { value: 'minimal-light' } });
assert.strictEqual(state.ui.theme, 'minimal-light');
assert.strictEqual(state.ui.apiProfiles[0].apiKey, 'fake-test-key-only');
assert.strictEqual(state.ui.hostApiProfiles['fixture-host'], 'fixture');
assert.strictEqual(runtimeState.activeTurnId, 'fixture-turn');

function executable() {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find(p => p && fs.existsSync(p));
}
async function seed(page) {
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
  await page.addStyleTag({ content: readUiStyles() });
  await page.addScriptTag({ content: helperSource });
  await page.evaluate(() => {
    const el = id => document.getElementById(id);
    document.querySelector('.shell').classList.remove('navigator-collapsed');
    el('session-title').textContent = 'A clearer workspace for your next idea';
    el('session-meta').textContent = 'illuin-dev-8897  /  D:\\workspace\\materials';
    el('selected-host-title').textContent = 'Development';
    el('selected-host-meta').textContent = 'Isolated host · 8897';
    el('host-switcher').innerHTML = '<option>illuin-dev-8897</option>';
    el('session-collection-select').innerHTML = '<option>All conversations</option>';
    el('new-session-cwd').value = 'D:\\workspace\\materials';
    el('session-api-rebind-select').innerHTML = '<option>Development API</option>';
    el('codex-model-select').innerHTML = '<option>gpt-6-astra</option>';
    el('codex-effort-select').innerHTML = '<option>Medium</option>';
    el('composer-session-selection-status').textContent = 'Current Session · Ready for the next turn';
    el('runtime-chip-row').innerHTML = '<span class="runtime-chip info">Connected</span><span class="runtime-chip info">Idle</span><span class="runtime-chip info">gpt-6-astra</span>';
    el('session-list').innerHTML = [
      ['Materials research', 'live-idle active', 'Collect observations and compare structures', '14:20'],
      ['Refine the experiment', 'runtime-active', 'Preparing a reproducible validation plan', '13:48'],
      ['Review results', 'history', 'An earlier run needs attention', 'Yesterday'],
    ].map(([title, state, text, time], i) => '<div class="conversation-card ' + state + '"><div class="conversation-card-top"><div><div class="title">' + title + '</div><div class="sub">illuin-dev-8897 · 1 variant</div></div></div><div class="path">D:\\workspace\\materials</div><div class="preview">' + text + '</div><div class="conversation-summary"><span>' + time + '</span></div><span class="conversation-runtime-dot ' + state.split(' ')[0] + '"></span>' + (i === 2 ? '<span class="conversation-error-badge">!</span>' : '') + (i === 1 ? '<button class="conversation-unread-button" aria-label="Open unread reply"></button>' : '') + '</div>').join('');
    el('session-log').innerHTML = '<article class="message user"><div class="message-meta">YOU · 14:18</div><div class="bubble">Can you compare the two structures and summarize what changed?</div></article>' +
      '<article class="message thinking"><details class="thinking-card" id="fixture-thinking" open><summary class="thinking-summary">Reasoning · Completed</summary><div class="thinking-content" style="padding:14px">Compared lattice dimensions, checked the atomic coordinates, and validated periodic boundaries.</div></details></article>' +
      '<article class="message agent"><div class="message-meta">CODEX · 14:20</div><div class="bubble markdown-body"><h3>The structure is consistent.</h3><p>The updated coordinates preserve the original symmetry. The main difference is a small relaxation along the c axis.</p><ul><li>Atomic ordering is unchanged.</li><li>The unit cell remains periodic.</li><li>Ready for the next validation run.</li></ul><div class="markdown-code-card"><pre><code>python validate.py relaxed.vasp</code></pre></div></div></article>';
    el('input-text').value = 'Keep this draft while switching themes.';
  });
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(executable() ? { executablePath: executable() } : {}) });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      await page.route('**/*', route => route.abort()); // No API requests or remote fonts.
      await seed(page);
      for (const id of ['minimal-light', 'dark-tech']) {
        await page.evaluate(id => window.RemoteCodexTheme.apply(document, id), id);
        const check = await page.evaluate(() => {
          const el = id => document.getElementById(id);
          const style = (node, pseudo) => getComputedStyle(node, pseudo);
          return {
            theme: document.documentElement.dataset.theme,
            text: style(document.body).color,
            background: style(document.body).backgroundColor,
            hiddenAuth: style(el('auth-gate')).display,
            hiddenPanel: style(el('message-notification-panel')).display,
            nativeHidden: style(el('toggle-status-button')).display,
            unread: style(document.querySelector('.conversation-unread-button'), '::before').backgroundColor,
            warning: style(document.querySelector('.conversation-runtime-dot.runtime-active')).backgroundColor,
            error: style(document.querySelector('.conversation-error-badge')).backgroundColor,
            draft: el('input-text').value,
            open: el('fixture-thinking').open,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            primary: style(el('codex-send-button')).backgroundImage,
            bodyHeight: document.body.scrollHeight,
          };
        });
        assert.strictEqual(check.theme, id);
        assert.strictEqual(check.hiddenAuth, 'none');
        assert.strictEqual(check.hiddenPanel, 'none');
        assert.strictEqual(check.nativeHidden, 'none');
        assert.strictEqual(check.draft, 'Keep this draft while switching themes.');
        assert.strictEqual(check.open, true);
        assert.strictEqual(check.overflow, false, JSON.stringify({ viewport, id, check }));
        assert.strictEqual(check.primary, 'none', 'no gradient on primary controls');
        assert.strictEqual(check.warning, 'rgb(250, 204, 21)');
        assert.strictEqual(check.error, 'rgb(180, 35, 24)');
        assert.strictEqual(check.unread, 'rgb(239, 68, 68)');
        if (viewport.width > 980) {
          await page.locator('#input-text').focus();
          assert.notStrictEqual(await page.locator('#input-text').evaluate(n => getComputedStyle(n).outlineStyle), 'none');
        }
        await page.screenshot({ path: path.join(output, id + '-' + viewport.width + '.png'), fullPage: true });
        if (viewport.width === 390) {
          await page.screenshot({
            path: path.join(output, id + '-mobile-navigation.png'),
            clip: { x: 0, y: 0, width: 390, height: 800 },
          });
          await page.setViewportSize({ width: 390, height: 1180 });
          await page.evaluate(() => {
            document.querySelector('.shell').classList.add('navigator-collapsed');
            document.querySelector('.transcript-scroll-controls').style.setProperty('display', 'none', 'important');
          });
          await page.screenshot({
            path: path.join(output, id + '-mobile-chat.png'),
            clip: { x: 0, y: 0, width: 390, height: 800 },
          });
          await page.evaluate(() => {
            document.querySelector('.shell').classList.remove('navigator-collapsed');
            document.querySelector('.transcript-scroll-controls').style.removeProperty('display');
          });
          await page.setViewportSize(viewport);
        }
        // Modal and hidden controls must remain governed by the original state.
        await page.evaluate(() => {
          document.body.classList.add('modal-open');
          document.getElementById('settings-dialog').classList.remove('hidden');
        });
        assert.notStrictEqual(await page.locator('#settings-dialog').evaluate(n => getComputedStyle(n).display), 'none');
        await page.screenshot({ path: path.join(output, id + '-settings-' + viewport.width + '.png'), fullPage: false });
        await page.evaluate(() => {
          document.body.classList.remove('modal-open');
          document.getElementById('settings-dialog').classList.add('hidden');
        });
      }
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('UI theme unit, storage safety, desktop/mobile visual fixtures passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
