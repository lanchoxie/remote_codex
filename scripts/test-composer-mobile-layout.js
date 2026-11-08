const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { chromium } = require('@playwright/test');
const { createComposerMobileLayout } = require('../apps/mobile-web/public/ui/composer-mobile-layout');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'apps/mobile-web/public');
const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
const dom = new JSDOM(html);
const composer = dom.window.document.getElementById('input-form');
const settings = dom.window.document.getElementById('composer-next-turn-settings');
assert(composer && settings, 'composer and advanced settings disclosure must exist');
assert(settings.contains(dom.window.document.getElementById('session-api-rebind-select')),
  'API selection belongs inside the collapsible run settings');
assert(settings.contains(dom.window.document.getElementById('session-api-rebind-button')),
  'API restart belongs beside the selector in run settings');
assert(!settings.contains(dom.window.document.getElementById('settings-api-key')),
  'API key remains exclusively in the main Settings editor');
for (const id of [
  'codex-model-select',
  'codex-model-refresh-button',
  'codex-effort-select',
  'codex-effort-manual-input',
  'codex-effort-unverified-checkbox',
  'composer-permissions',
]) {
  assert(settings.contains(dom.window.document.getElementById(id)), `${id} remains available in advanced settings`);
}
assert.strictEqual(dom.window.document.getElementById('input-text').rows, 2);

let mobile = true;
let mediaListener = null;
dom.window.innerWidth = 390;
dom.window.innerHeight = 844;
dom.window.matchMedia = (query) => ({
  media: query,
  get matches() { return mobile; },
  addEventListener(_name, listener) { mediaListener = listener; },
  removeEventListener() {},
});
const mobileLayout = createComposerMobileLayout({ document: dom.window.document, window: dom.window });
assert.strictEqual(settings.open, false, 'advanced settings start collapsed on mobile');
const input = dom.window.document.getElementById('input-text');
Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 480 });
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
assert.strictEqual(input.style.height, '192px', 'long mobile drafts are capped at the compact composer limit');
assert.strictEqual(input.style.overflowY, 'auto');
mobile = false;
mediaListener({ matches: false });
assert.strictEqual(settings.open, false, 'run settings stay collapsed when switching to desktop');
assert.strictEqual(input.style.height, '', 'desktop textareas retain their desktop sizing');
settings.open = true;
mobile = true;
mediaListener({ matches: true });
assert.strictEqual(settings.open, true, 'viewport changes preserve a user-expanded run settings panel');
mobileLayout.destroy();
dom.window.close();

async function verifyBrowserLayout() {
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find((file) => file && fs.existsSync(file));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const form = composer.outerHTML;
    const styleFiles = [
      'styles.css',
      'ui/tokens.css',
      'ui/controls.css',
      'ui/workbench.css',
      'ui/composer-permissions.css',
      'ui/composer-mobile.css',
    ];
    const styles = styleFiles.map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n');
    await page.setContent(`<!doctype html><html lang="en" data-theme="minimal-light"><head><meta name="viewport" content="width=device-width, initial-scale=1"/><style>${styles}</style></head><body><main class="main"><section class="panel transcript-panel"><div id="session-log" class="log"><div class="message agent"><div class="bubble">${'A wide transcript line with content. '.repeat(50)}</div></div></div>${form}</section></main></body></html>`);
    await page.evaluate(() => {
      const grid = document.querySelector('.composer-attachment-grid');
      const clear = document.getElementById('codex-clear-attachments-button');
      for (const [id, label] of [['import-current-history-button', 'Current'], ['import-other-history-button', 'Others']]) {
        const button = document.createElement('button');
        button.id = id;
        button.type = 'button';
        button.className = 'secondary-button attachment-import-button';
        button.textContent = label;
        grid.insertBefore(button, clear);
      }
      const alerts = document.createElement('button');
      alerts.id = 'alerts-fab';
      alerts.className = 'alerts-fab';
      alerts.textContent = 'Alerts';
      document.body.appendChild(alerts);
    });
    await page.addScriptTag({ path: path.join(publicRoot, 'ui/composer-mobile-layout.js') });
    const mobileHeight = await page.locator('#input-form').evaluate((node) => node.getBoundingClientRect().height);
    console.log(`mobile composer ${mobileHeight}px`);
    await page.screenshot({ path: path.join(require('os').tmpdir(), 'remote-codex-composer-mobile-390.png') });
    assert(mobileHeight < 260, `compact mobile composer should stay below 260px (got ${mobileHeight}px)`);
    assert.strictEqual(await page.locator('#composer-next-turn-settings').evaluate((node) => node.open), false);
    assert.strictEqual(await page.locator('#session-api-rebind-select').isVisible(), false);
    assert.strictEqual(await page.locator('#codex-model-select').isVisible(), false);
    assert.strictEqual(await page.locator('#import-current-history-button').isVisible(), true);
    assert.strictEqual(await page.locator('#import-other-history-button').isVisible(), true);
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--mobile-composer-height'));
    const dock = await page.locator('#input-form').evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      bottom: Math.round(window.innerHeight - node.getBoundingClientRect().bottom),
      position: getComputedStyle(node).position,
    }));
    assert.strictEqual(dock.position, 'fixed', 'mobile composer is pinned to the viewport');
    assert(dock.bottom <= 10, `composer sits at the mobile viewport bottom (gap ${dock.bottom}px)`);
    assert(dock.height < 260, `compact mobile composer should stay below 260px (got ${dock.height}px)`);
    const alertsBottom = await page.locator('#alerts-fab').evaluate((node) => node.getBoundingClientRect().bottom);
    const composerTop = await page.locator('#input-form').evaluate((node) => node.getBoundingClientRect().top);
    assert(alertsBottom <= composerTop, 'alerts button stays above the fixed composer');
    const input = page.locator('#input-text');
    await input.fill('A long draft that should grow in the mobile composer. '.repeat(30));
    const longDraftHeight = await input.evaluate((node) => node.getBoundingClientRect().height);
    assert(longDraftHeight <= 192, `mobile textarea must stop growing at 192px (got ${longDraftHeight}px)`);
    await page.waitForFunction(() => {
      const composer = document.getElementById('input-form').getBoundingClientRect();
      const alerts = document.getElementById('alerts-fab').getBoundingClientRect();
      return alerts.bottom <= composer.top;
    });
    await input.fill('');
    const clearedInputGeometry = await input.evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      scrollHeight: node.scrollHeight,
      inlineHeight: node.style.height,
    }));
    assert(clearedInputGeometry.height <= 72,
      'clearing a mobile draft returns the composer to its compact input height');
    await page.locator('#composer-next-turn-settings > summary').click();
    assert.strictEqual(await page.locator('#codex-model-select').isVisible(), true);
    assert.strictEqual(await page.locator('#session-api-rebind-select').isVisible(), true);
    const apiControl = await page.locator('.composer-api-control').evaluate((node) => ({
      right: node.getBoundingClientRect().right,
      viewport: window.innerWidth,
    }));
    assert(apiControl.right <= apiControl.viewport, 'expanded API selector stays inside the mobile viewport');
    await page.locator('#composer-next-turn-settings > summary').click();

    for (const viewport of [{ width: 360, height: 740 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => ({
        composer: document.getElementById('input-form').getBoundingClientRect().height,
        bottom: Math.round(window.innerHeight - document.getElementById('input-form').getBoundingClientRect().bottom),
        position: getComputedStyle(document.getElementById('input-form')).position,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      assert(geometry.composer < 260, `composer stays compact at ${viewport.width}px (got ${geometry.composer}px)`);
      assert.strictEqual(geometry.position, 'fixed');
      assert(geometry.bottom <= 10, `composer stays bottom-pinned at ${viewport.width}px`);
      assert(geometry.documentWidth <= geometry.viewportWidth, `no horizontal overflow at ${viewport.width}px`);
      await page.locator('#composer-next-turn-settings > summary').click();
      const expandedApiControl = await page.locator('.composer-api-control').evaluate((node) => ({
        left: node.getBoundingClientRect().left,
        right: node.getBoundingClientRect().right,
        viewport: window.innerWidth,
      }));
      assert(expandedApiControl.left >= 0 && expandedApiControl.right <= expandedApiControl.viewport,
        `expanded API selector fits at ${viewport.width}px`);
      await page.locator('#composer-next-turn-settings > summary').click();
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    assert.strictEqual(await page.locator('#composer-next-turn-settings').evaluate((node) => node.open), false);
    assert.strictEqual(await page.locator('#codex-model-select').isVisible(), false);
    assert.strictEqual(await page.locator('#composer-next-turn-settings > summary').isVisible(), true);
    assert.strictEqual(await page.locator('#input-form').evaluate((node) => getComputedStyle(node).position), 'relative');
    const collapsedDesktopHeight = await page.locator('#input-form').evaluate((node) => node.getBoundingClientRect().height);
    await page.locator('#composer-next-turn-settings > summary').click();
    assert.strictEqual(await page.locator('#codex-model-select').isVisible(), true);
    assert.strictEqual(await page.locator('#session-api-rebind-select').isVisible(), true);
    const expandedDesktopHeight = await page.locator('#input-form').evaluate((node) => node.getBoundingClientRect().height);
    assert(expandedDesktopHeight > collapsedDesktopHeight, 'desktop run settings expand only on request');
    const desktopWidth = async () => page.evaluate(() => {
      const log = document.getElementById('session-log');
      const style = getComputedStyle(log);
      return {
        content: log.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        message: document.querySelector('.message.agent').getBoundingClientRect().width,
        composer: document.getElementById('input-form').getBoundingClientRect().width,
      };
    });
    await page.setViewportSize({ width: 1024, height: 900 });
    const mediumDesktop = await desktopWidth();
    await page.setViewportSize({ width: 1920, height: 900 });
    const wideDesktop = await desktopWidth();
    assert.strictEqual(await page.locator('#composer-next-turn-settings').evaluate((node) => node.open), true,
      'resizing a desktop viewport preserves the user-expanded settings');
    assert(wideDesktop.content > mediumDesktop.content + 100,
      'transcript content grows with available desktop width');
    assert(wideDesktop.content <= 1122, 'ultrawide transcript retains a readable width limit');
    assert(wideDesktop.message > mediumDesktop.message + 100,
      'assistant messages can use the wider transcript lane');
    assert(wideDesktop.composer > mediumDesktop.composer,
      'desktop composer grows with the transcript lane');
    await page.locator('#composer-next-turn-settings > summary').click();
    await page.screenshot({ path: path.join(require('os').tmpdir(), 'remote-codex-composer-desktop-1920.png') });
  } finally {
    await browser.close();
  }
}

verifyBrowserLayout()
  .then(() => console.log('mobile composer compact layout and responsive control assertions passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
