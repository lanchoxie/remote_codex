const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'apps/mobile-web/public/styles.css'), 'utf8');
const fullSessionId = '019f35ea-7d58-7fc0-905d-5cb971de1184';
const longPath = '/dm_data/home/spst/xiety/GNN_li-lib/grid_sample_concen7_diff_temp/long_workspace_name_without_breaks';
const hostGroups = ['dm', 'hkl'].map((hostId, hostIndex) => {
  const rows = Array.from({ length: 5 }, (_, rowIndex) => {
    const sessionId = hostIndex === 0 && rowIndex === 0
      ? fullSessionId
      : `019f35ea-7d58-7fc0-905d-${hostIndex}${rowIndex}b971de1184`;
    return `
      <label class="choice-session-row">
        <input type="checkbox" checked />
        <div class="choice-session-copy">
          <strong>Model evaluation ${hostId}-${rowIndex} with a deliberately_long_unbroken_session_title_that_must_wrap</strong>
          <span title="${sessionId}">${hostId} | linux | ${sessionId}</span>
          <span title="${longPath}">${longPath}/${hostId}/${rowIndex}</span>
          <span>live</span>
        </div>
      </label>`;
  }).join('');
  return `
    <section class="choice-host-group">
      <div class="choice-host-heading">
        <label>
          <input type="checkbox" checked />
          <span title="${hostId}">${hostId}</span>
        </label>
        <small>5/5</small>
      </div>
      ${rows}
    </section>`;
}).join('');

function browserLaunchOptions() {
  const options = { headless: true };
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : '',
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  return executablePath ? { ...options, executablePath } : options;
}

const fixture = `<!doctype html>
<html data-theme="minimal-light">
  <body>
    <div id="session-action-dialog" class="choice-dialog-overlay" aria-hidden="false">
      <section class="choice-dialog-modal">
        <div class="choice-dialog-header">
          <div>
            <div class="eyebrow">Session Selection</div>
            <h2>Apply current Session settings to live Sessions</h2>
            <p>Choose other live Sessions, verify the target API, then Rebind and restart them.</p>
          </div>
          <button type="button" class="secondary-button">Cancel</button>
        </div>
        <label class="choice-select-all">
          <input type="checkbox" checked />
          <span>Select all visible sessions</span>
        </label>
        <div class="choice-summary">Minemine | Current Session: gpt-5 | High | Default summary</div>
        <div class="choice-session-list">
          ${hostGroups}
        </div>
        <div class="choice-dialog-actions">
          <button type="button" class="secondary-button">Cancel</button>
          <button type="button" class="secondary-button">Preflight selected</button>
          <button type="button" class="danger-button">Apply and restart (1)</button>
        </div>
      </section>
    </div>
  </body>
</html>`;

async function inspectViewport(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(fixture);
  await page.addStyleTag({ content: css });

  const metrics = await page.evaluate(() => {
    const modal = document.querySelector('.choice-dialog-modal');
    const hostCheckbox = document.querySelector('.choice-host-heading input');
    const hostLabel = document.querySelector('.choice-host-heading span');
    const selectAllCheckbox = document.querySelector('.choice-select-all input');
    const row = document.querySelector('.choice-session-row');
    const list = document.querySelector('.choice-session-list');
    const identity = document.querySelector('.choice-session-copy span');
    const actions = document.querySelector('.choice-dialog-actions');
    const bounds = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        clientWidth: node.clientWidth,
        scrollWidth: node.scrollWidth,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
    };
    return {
      modal: bounds(modal),
      hostCheckbox: bounds(hostCheckbox),
      hostLabel: bounds(hostLabel),
      selectAllCheckbox: bounds(selectAllCheckbox),
      row: bounds(row),
      list: bounds(list),
      actions: bounds(actions),
      identityText: identity.textContent,
      identityWhiteSpace: getComputedStyle(identity).whiteSpace,
    };
  });

  assert(metrics.hostCheckbox.width <= 24, `${width}px Host checkbox expanded to ${metrics.hostCheckbox.width}px`);
  assert(metrics.selectAllCheckbox.width <= 24, `${width}px Select-all checkbox expanded to ${metrics.selectAllCheckbox.width}px`);
  assert(metrics.hostLabel.scrollWidth <= metrics.hostLabel.clientWidth + 1, `${width}px Host label is clipped`);
  assert(metrics.modal.scrollWidth <= metrics.modal.clientWidth + 1, `${width}px modal overflows horizontally`);
  assert(metrics.row.scrollWidth <= metrics.row.clientWidth + 1, `${width}px Session row overflows horizontally`);
  assert(metrics.actions.right <= metrics.modal.right + 1, `${width}px actions escape the modal`);
  assert(metrics.actions.bottom <= metrics.modal.bottom + 1, `${width}px actions are hidden below the modal viewport`);
  assert(metrics.list.scrollHeight > metrics.list.clientHeight, `${width}px Session list did not become independently scrollable`);
  assert(metrics.modal.bottom <= height + 1, `${width}px modal escapes the viewport`);
  assert(metrics.identityText.includes(fullSessionId), `${width}px full Session id is unavailable`);
  assert.notStrictEqual(metrics.identityWhiteSpace, 'nowrap', `${width}px Session identity cannot wrap`);

  if (process.env.SESSION_ACTION_LAYOUT_SCREENSHOTS === '1') {
    const outputDir = path.join(root, 'tmp', 'session-action-layout');
    fs.mkdirSync(outputDir, { recursive: true });
    await page.screenshot({ path: path.join(outputDir, `${width}x${height}.png`), fullPage: true });
  }
  await page.close();
}

(async () => {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    await inspectViewport(browser, 591, 720);
    await inspectViewport(browser, 390, 720);
    await inspectViewport(browser, 320, 640);
  } finally {
    await browser.close();
  }
  console.log('session action dialog layout assertions passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
