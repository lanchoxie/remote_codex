const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const origin = process.env.STRUCTURE_PREVIEW_TEST_URL || 'http://127.0.0.1:8897';
const output = path.resolve(__dirname, '..', 'tmp', 'structure-preview-browser');
const protein = fs.readFileSync(path.join(__dirname, 'fixtures', 'structure-preview-1crn.pdb'), 'utf8');
const proteinWithDistantCell = protein.replace(
  /^CRYST1[^\r\n]*/m,
  'CRYST1  900.000 900.000 900.000  90.00  90.00  90.00 P 1           1'
);

const water = [
  'CRYST1  200.000 200.000 200.000  90.00  90.00  90.00 P 1           1',
  'ATOM      1  O   HOH A   1      50.000  60.000  70.000  1.00 20.00           O',
  'ATOM      2  H1  HOH A   1      50.960  60.000  70.000  1.00 20.00           H',
  'CONECT    1    2',
].join('\n');
const crystal = [
  'CRYSTAL', 'PRIMVEC', '5 0 0', '0 5 0', '0 0 5', 'PRIMCOORD', '7 1',
  'Ti 0.1 2.5 2.5', 'O 2.0 2.5 2.5', 'O 3.2 2.5 2.5',
  'O 0.1 4.4 2.5', 'O 0.1 0.6 2.5', 'O 0.1 2.5 4.4', 'O 0.1 2.5 0.6',
].join('\n');
const symmetricCif = [
  'data_symmetric', '_cell_length_a 5', '_cell_length_b 5', '_cell_length_c 5',
  'loop_', '_space_group_symop_operation_xyz', "'x,y,z'", "'-x+1/2,y+1/2,-z'",
  'loop_', '_atom_site_label', '_atom_site_type_symbol', '_atom_site_fract_x',
  '_atom_site_fract_y', '_atom_site_fract_z', 'Ti1 Ti 0.1 0.2 0.3',
].join('\n');

async function open(page, name, structure) {
  const accepted = await page.evaluate(({ name, structure }) =>
    window.RemoteCodexStructurePreview.open({ name, structure, source: 'isolated test fixture' }), { name, structure });
  assert.strictEqual(accepted, true);
}

async function atomPixelBounds(page) {
  return page.locator('#structure-preview-canvas').evaluate((canvas) => {
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let minX = width, maxX = 0, minY = height, maxY = 0, count = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = 4 * (y * width + x);
      if (Math.abs(data[offset] - 8) + Math.abs(data[offset + 1] - 16) + Math.abs(data[offset + 2] - 31) < 60) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
    }
    return { width, height, minX, maxX, minY, maxY, count };
  });
}

async function screenshotVisiblePixels(page, selector) {
  const dataUrl = 'data:image/png;base64,' + (await page.locator(selector).screenshot()).toString('base64');
  return page.evaluate(async (source) => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 180) visible++;
    }
    return visible;
  }, dataUrl);
}

async function crystalPixelBounds(page) {
  const box = await page.locator('#structure-preview-crystal').boundingBox();
  const dataUrl = 'data:image/png;base64,' + (await page.screenshot({ clip: box })).toString('base64');
  return page.evaluate(async (source) => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const background = [pixels[4 * (12 * canvas.width + 12)],
      pixels[4 * (12 * canvas.width + 12) + 1], pixels[4 * (12 * canvas.width + 12) + 2]];
    let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0, count = 0;
    for (let y = 8; y < canvas.height - 8; y++) for (let x = 8; x < canvas.width - 8; x++) {
      const offset = 4 * (y * canvas.width + x);
      if (Math.abs(pixels[offset] - background[0]) + Math.abs(pixels[offset + 1] - background[1])
        + Math.abs(pixels[offset + 2] - background[2]) < 75) continue;
      if (pixels[offset] > 245 && pixels[offset + 1] > 245 && pixels[offset + 2] > 245) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      count++;
    }
    return { width: canvas.width, height: canvas.height, minX, maxX, minY, maxY, count };
  }, dataUrl);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync(edgePath) ? edgePath : undefined),
    args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      const pageErrors = [], resourceErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 400 && /\/(?:vendor|crystal-|structure-preview|protein-structure)/.test(new URL(response.url()).pathname)) {
          resourceErrors.push(`${response.status()} ${response.url()}`);
        }
      });
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) {
          console.error('[structure browser console]', message.text(), message.location().url);
        }
      });
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.RemoteCodexStructurePreview));
      await page.evaluate(() => { document.getElementById('auth-gate')?.style.setProperty('display', 'none', 'important'); });
      await open(page, 'water.pbd', water);
      assert.match(await page.locator('#structure-preview-subtitle').innerText(), /^PBD \(PDB-compatible\)/);
      assert.strictEqual(await page.locator('#structure-preview-mode').isVisible(), true);
      assert.strictEqual(await page.locator('#structure-preview-mode-cartoon').isVisible(), false);
      let pixels = await atomPixelBounds(page);
      assert(pixels.count > 100, 'PBD atoms should render');
      assert(Math.abs((pixels.minX + pixels.maxX) / 2 - pixels.width / 2) < pixels.width * 0.08, 'PBD should fit around atoms, not CRYST1');
      const box = await page.locator('#structure-preview-canvas').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 35); await page.mouse.up();
      pixels = await atomPixelBounds(page);
      assert(Math.abs((pixels.minX + pixels.maxX) / 2 - pixels.width / 2) < pixels.width * 0.08, 'rotation must retain the atom-centered pivot');
      await page.screenshot({ path: path.join(output, `pbd-atoms-${viewport.width}.png`) });
      await page.locator('#structure-preview-mode-wire').click();
      assert.strictEqual(await page.locator('#structure-preview-mode-wire').getAttribute('aria-pressed'), 'true');
      await page.locator('#structure-preview-close-button').click();

      await open(page, '1crn.pdb', proteinWithDistantCell);
      assert.strictEqual(await page.locator('#structure-preview-mode-cartoon').getAttribute('aria-pressed'), 'true');
      await page.locator('#structure-preview-mode-atoms').click();
      await page.locator('#structure-preview-mode-cartoon').click();
      await page.waitForFunction(() => Boolean(document.querySelector('#structure-preview-protein canvas')));
      await page.waitForTimeout(600);
      const proteinPixels = await screenshotVisiblePixels(page, '#structure-preview-protein');
      assert(proteinPixels > 2000, `NGL cartoon canvas should show structure pixels, got ${proteinPixels}`);
      const beforeDrag = await page.locator('#structure-preview-protein').screenshot();
      const proteinBox = await page.locator('#structure-preview-protein').boundingBox();
      await page.mouse.move(proteinBox.x + proteinBox.width / 2, proteinBox.y + proteinBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(proteinBox.x + proteinBox.width / 2 + 85, proteinBox.y + proteinBox.height / 2 + 40);
      await page.mouse.up();
      await page.waitForTimeout(200);
      const afterDrag = await page.locator('#structure-preview-protein').screenshot();
      assert(!beforeDrag.equals(afterDrag), 'protein drag must change the rendered view');
      assert(await screenshotVisiblePixels(page, '#structure-preview-protein') > 2000, 'protein must stay visible after rotation');
      await page.screenshot({ path: path.join(output, `pdb-cartoon-${viewport.width}.png`) });
      await page.locator('#structure-preview-mode-atoms').click();
      assert.strictEqual(await page.locator('#structure-preview-mode-atoms').getAttribute('aria-pressed'), 'true');
      await page.waitForTimeout(300);
      assert(await screenshotVisiblePixels(page, '#structure-preview-protein') > 2000, 'PDB atom mode should render with molecular bonds');
      await page.screenshot({ path: path.join(output, `pdb-atoms-${viewport.width}.png`) });
      await page.locator('#structure-preview-mode-wire').click();
      assert(await screenshotVisiblePixels(page, '#structure-preview-protein') > 300, 'PDB wireframe should render');
      await page.locator('#structure-preview-close-button').click();

      await open(page, 'cell.xsf', crystal);
      assert.match(await page.locator('#structure-preview-subtitle').innerText(), /^XSF /);
      await page.waitForFunction(() => Boolean(document.querySelector('#structure-preview-crystal canvas'))
        || !document.querySelector('#structure-preview-error').classList.contains('hidden'));
      assert.strictEqual(await page.locator('#structure-preview-error').isVisible(), false,
        await page.locator('#structure-preview-error').innerText());
      assert((await crystalPixelBounds(page)).count > 300,
        'periodic ball-stick scene should contain visible geometry');
      assert(await page.locator('#structure-preview-crystal').evaluate((node) =>
        node.parentElement.querySelector('#structure-preview-canvas').__remoteCodexStructureViewer.crystal.model.bonds.some((bond) =>
          bond.shift.some((value) => value !== 0))), 'periodic bonds should include translated neighbor images');
      await page.screenshot({ path: path.join(output, `xsf-ball-stick-${viewport.width}.png`) });
      await page.locator('#structure-preview-mode-wire').click();
      assert((await crystalPixelBounds(page)).count > 300, 'periodic wireframe should render');
      await page.screenshot({ path: path.join(output, `xsf-wire-${viewport.width}.png`) });
      await page.locator('#structure-preview-mode-polyhedra').click();
      assert(await page.locator('#structure-preview-crystal').evaluate((node) =>
        node.parentElement.querySelector('#structure-preview-canvas').__remoteCodexStructureViewer.crystal.model.polyhedra[0]?.vertices.length) === 6,
      'the Ti-O coordination shell should form a six-vertex octahedron');
      assert((await crystalPixelBounds(page)).count > 300, 'polyhedral scene should render');
      const beforeCrystalDrag = await page.locator('#structure-preview-crystal').screenshot();
      const crystalBox = await page.locator('#structure-preview-crystal').boundingBox();
      await page.mouse.move(crystalBox.x + crystalBox.width / 2, crystalBox.y + crystalBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(crystalBox.x + crystalBox.width / 2 + 75, crystalBox.y + crystalBox.height / 2 + 30);
      await page.mouse.up();
      assert(!(await page.locator('#structure-preview-crystal').screenshot()).equals(beforeCrystalDrag),
        'crystal drag should rotate the structure');
      const crystalBounds = await crystalPixelBounds(page);
      assert(crystalBounds.minX > 6 && crystalBounds.maxX < crystalBounds.width - 7
        && crystalBounds.minY > 6 && crystalBounds.maxY < crystalBounds.height - 7,
      `rotated crystal and cell should remain in frame: ${JSON.stringify(crystalBounds)}`);
      await page.screenshot({ path: path.join(output, `xsf-polyhedra-${viewport.width}.png`) });
      await page.locator('#structure-preview-cutoff').evaluate((input) => {
        input.value = '1.2'; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.locator('#structure-preview-error').getByText(/No closed coordination polyhedra/).waitFor();
      await page.locator('#structure-preview-cutoff').evaluate((input) => {
        input.value = '2.8'; input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.locator('#structure-preview-close-button').click();

      await open(page, 'symmetric.cif', symmetricCif);
      await page.waitForFunction(() => Boolean(document.querySelector('#structure-preview-crystal canvas')));
      assert.match(await page.locator('#structure-preview-status').innerText(), /^2 atoms/,
        'CIF symmetry should expand the atom site before rendering');
      assert((await crystalPixelBounds(page)).count > 300);
      await page.locator('#structure-preview-close-button').click();

      const large = '5001\nsynthetic\n' + Array.from({ length: 5001 }, (_, i) => `C ${i % 100} ${Math.floor(i / 100)} 0`).join('\n');
      await open(page, 'large.xyz', large);
      assert.strictEqual(await page.locator('#structure-preview-confirm').isVisible(), true);
      assert.strictEqual(await page.locator('#structure-preview-canvas').evaluate((canvas) => canvas.__remoteCodexStructureViewer.protein), null);
      await page.screenshot({ path: path.join(output, `large-confirm-${viewport.width}.png`) });
      await page.locator('#structure-preview-confirm-render').click();
      assert.strictEqual(await page.locator('#structure-preview-confirm').isVisible(), false);
      assert((await atomPixelBounds(page)).count > 100, 'confirmed large structure should render');
      await page.locator('#structure-preview-close-button').click();
      assert.deepStrictEqual(pageErrors, [], 'the viewer must not throw uncaught browser errors');
      assert.deepStrictEqual(resourceErrors, [], 'all viewer assets must load');
      await page.close();
    }
    console.log('Structure viewer desktop/mobile periodic ball-stick, wireframe, polyhedra, PBD pivot, protein cartoon, and large-file confirmation passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
