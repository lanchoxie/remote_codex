const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const css = require('./ui-style-fixture').readUiStyles();

function browserLaunchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : '',
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

const fixture = `<!doctype html>
<html data-theme="minimal-light">
  <body>
    <main id="indicator-fixture">
      <article class="conversation-card history">
        <span class="conversation-runtime-dot history" role="img" aria-label="History or offline"></span>
      </article>
      <article class="conversation-card live-idle">
        <span class="conversation-runtime-dot live-idle" role="img" aria-label="Live session idle"></span>
        <span class="conversation-error-badge" role="img" aria-label="Session error">!</span>
      </article>
      <article class="conversation-card runtime-active message-unread">
        <span class="conversation-runtime-dot runtime-active" role="img" aria-label="Session running"></span>
        <button type="button" class="conversation-unread-button" aria-label="Open unread reply"></button>
      </article>
    </main>
  </body>
</html>`;

async function countTargetPixels(page, screenshot, targets) {
  return page.evaluate(async ({ source, colors }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = Object.fromEntries(Object.keys(colors).map((name) => [name, 0]));
    for (let offset = 0; offset < pixels.length; offset += 4) {
      for (const [name, target] of Object.entries(colors)) {
        if (
          Math.abs(pixels[offset] - target[0]) <= 8
          && Math.abs(pixels[offset + 1] - target[1]) <= 8
          && Math.abs(pixels[offset + 2] - target[2]) <= 8
          && pixels[offset + 3] >= 240
        ) {
          counts[name] += 1;
        }
      }
    }
    return counts;
  }, {
    source: `data:image/png;base64,${screenshot.toString('base64')}`,
    colors: targets,
  });
}

(async () => {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const context = await browser.newContext({
      viewport: { width: 760, height: 260 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.setContent(fixture);
    await page.addStyleTag({ content: css });
    await page.addStyleTag({ content: `
      body { margin: 18px; }
      #indicator-fixture { display: flex; gap: 16px; }
      #indicator-fixture .conversation-card {
        box-sizing: border-box;
        position: relative;
        display: block;
        width: 210px;
        height: 72px;
        min-height: 72px;
      }
    ` });

    const metrics = await page.evaluate(() => {
      const button = document.querySelector('.conversation-unread-button');
      const pseudo = getComputedStyle(button, '::before');
      const activeDot = getComputedStyle(document.querySelector('.conversation-runtime-dot.runtime-active'));
      const bounds = button.getBoundingClientRect();
      const errorBadge = document.querySelector('.conversation-error-badge');
      const errorBounds = errorBadge.getBoundingClientRect();
      return {
        errorText: errorBadge.textContent,
        errorWidth: errorBounds.width,
        errorHeight: errorBounds.height,
        buttonWidth: bounds.width,
        buttonHeight: bounds.height,
        pseudoDisplay: pseudo.display,
        pseudoWidth: pseudo.width,
        pseudoHeight: pseudo.height,
        pseudoColor: pseudo.backgroundColor,
        activeAnimation: activeDot.animationName,
      };
    });

    assert.strictEqual(metrics.buttonWidth, 28);
    assert.strictEqual(metrics.buttonHeight, 28);
    assert.strictEqual(metrics.pseudoDisplay, 'block');
    assert.strictEqual(metrics.pseudoWidth, '9px');
    assert.strictEqual(metrics.pseudoHeight, '9px');
    assert.strictEqual(metrics.pseudoColor, 'rgb(239, 68, 68)');
    assert.strictEqual(metrics.activeAnimation, 'none');
    assert.strictEqual(metrics.errorText, '!');
    assert.strictEqual(metrics.errorWidth, 18);
    assert.strictEqual(metrics.errorHeight, 18);

    const fixtureNode = page.locator('#indicator-fixture');
    const screenshot = await fixtureNode.screenshot();
    const pixelCounts = await countTargetPixels(page, screenshot, {
      red: [239, 68, 68],
      green: [34, 197, 94],
      yellow: [250, 204, 21],
      gray: [148, 163, 184],
      error: [180, 35, 24],
    });
    for (const [tone, count] of Object.entries(pixelCounts)) {
      assert(count >= 20, `${tone} indicator rendered only ${count} matching pixels`);
    }

    if (process.env.SESSION_INDICATOR_SCREENSHOT === '1') {
      const outputDir = path.join(root, 'tmp', 'session-indicator-visual');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, 'indicators.png'), screenshot);
    }
    await context.close();
  } finally {
    await browser.close();
  }
  console.log('session indicator visual assertions passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
