const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { readUiStyles } = require('./ui-style-fixture');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/mobile-web/public/index.html'), 'utf8');
const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(file => file && fs.existsSync(file));
const overlays = ['settings-dialog', 'api-profile-backup-dialog', 'account-dialog',
  'session-details-overlay', 'directory-picker-overlay', 'skills-manager-overlay',
  'session-action-dialog', 'export-dialog', 'image-preview-overlay', 'connector-manager-overlay'];

async function inspect(page, theme, viewport, navigatorOpen) {
  await page.setContent(html);
  await page.addStyleTag({ content: readUiStyles() });
  await page.evaluate(({ theme, navigatorOpen }) => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('.shell').classList.toggle('navigator-collapsed', !navigatorOpen);
    document.getElementById('session-title').textContent = 'Overlay stacking fixture';
    document.getElementById('input-text').value = 'Draft must survive opening and closing settings';
    document.getElementById('session-log').innerHTML = '<article class="message agent"><div class="bubble">Test transcript</div></article>';
    window.fixtureDraftNode = document.getElementById('input-text');
    window.fixtureUnderlyingClicks = 0;
    document.querySelector('.composer').addEventListener('click', () => window.fixtureUnderlyingClicks++);
    // The live app portals mobile jump controls to body. Reproduce that ownership.
    if (matchMedia('(max-width: 980px), (pointer: coarse), (hover: none)').matches) {
      document.body.appendChild(document.querySelector('.transcript-scroll-controls'));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, { theme, navigatorOpen });
  for (const overlayId of overlays) {
    await page.evaluate(id => {
      const overlay = document.getElementById(id);
      if (!overlay) throw new Error('Missing real overlay: ' + id);
      document.body.classList.add('modal-open');
      overlay.classList.remove('hidden');
      overlay.setAttribute('aria-hidden', 'false');
      if (id === 'settings-dialog') document.getElementById('settings-form').scrollTop = 100000;
    }, overlayId);
    const result = await page.evaluate(id => {
      const overlay = document.getElementById(id);
      const composer = document.querySelector('.composer');
      const rect = composer.getBoundingClientRect();
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      const points = [];
      for (const xFraction of [.1, .5, .9]) for (const yFraction of [.1, .5, .9]) {
        const x = left + (right - left) * xFraction, y = top + (bottom - top) * yFraction;
        const hit = document.elementFromPoint(x, y);
        points.push({ x, y, covered: overlay.contains(hit), hit: hit?.id || hit?.className });
      }
      if (!document.querySelector('.shell').classList.contains('navigator-collapsed')) {
        const rail = document.querySelector('.sidebar').getBoundingClientRect();
        const x = Math.max(1, Math.min(innerWidth - 1, rail.left + rail.width / 2));
        const y = Math.max(1, Math.min(innerHeight - 1, rail.top + 50));
        const hit = document.elementFromPoint(x, y);
        points.push({ x, y, covered: overlay.contains(hit), hit: hit?.id || hit?.className });
      }
      return { points, visibleIntersection: right > left && bottom > top,
        scrollLocked: getComputedStyle(document.body).overflowY === 'hidden',
        jumpHidden: getComputedStyle(document.querySelector('.transcript-scroll-controls')).display === 'none' };
    }, overlayId);
    assert(result.visibleIntersection, 'fixture must exercise a visible composer');
    assert(result.scrollLocked, 'modal locks page scroll');
    assert(result.jumpHidden, 'body-portaled jump controls stay hidden during modal');
    const uncovered = result.points.filter(point => !point.covered);
    assert.strictEqual(uncovered.length, 0, JSON.stringify({ theme, viewport, navigatorOpen, overlayId, uncovered }));
    // Exercise a real pointer hit, not merely computed z-index or display.
    await page.mouse.click(result.points[0].x, result.points[0].y);
    assert.strictEqual(await page.evaluate(() => window.fixtureUnderlyingClicks), 0, 'no click through to composer');
    if (overlayId === 'settings-dialog' && process.env.UI_OVERLAY_SCREENSHOTS === '1') {
      const output = path.join(root, 'tmp/ui-overlay-stacking');
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, theme + '-' + viewport.width + '-' + (navigatorOpen ? 'nav-open' : 'nav-closed') + '.png') });
    }
    await page.evaluate(id => {
      document.getElementById(id).classList.add('hidden');
      document.getElementById(id).setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
    }, overlayId);
  }
  assert.deepStrictEqual(await page.evaluate(() => ({
    sameNode: window.fixtureDraftNode === document.getElementById('input-text'),
    draft: document.getElementById('input-text').value,
  })), { sameNode: true, draft: 'Draft must survive opening and closing settings' });
  // Close the navigator before testing restored composer interaction.
  await page.evaluate(() => document.querySelector('.shell').classList.add('navigator-collapsed'));
  await page.locator('#input-text').click();
  assert.strictEqual(await page.locator('#input-text').evaluate(node => document.activeElement === node), true);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 884, height: 817 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 980 });
      await page.route('**/*', route => route.abort());
      for (const theme of ['minimal-light', 'dark-tech']) {
        for (const navigatorOpen of [false, true]) await inspect(page, theme, viewport, navigatorOpen);
      }
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('UI overlay stacking: 10 overlays x 3 viewports x 2 themes x 2 navigation states passed; hit-testing, draft and scroll guards passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
