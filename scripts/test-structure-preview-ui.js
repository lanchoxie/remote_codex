const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps', 'mobile-web', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps', 'mobile-web', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apps', 'mobile-web', 'public', 'structure-preview.css'), 'utf8');
const moduleSource = fs.readFileSync(path.join(root, 'apps', 'mobile-web', 'public', 'structure-preview.js'), 'utf8');

assert(html.includes('/structure-preview.css'));
assert(/<script src="\/structure-preview\.js\?v=20260827-structure-2"><\/script>/.test(html), 'structure-preview.js cache-buster should match the current parser');
assert(/<script src="\/app\.js\?v=[a-zA-Z0-9-]+"><\/script>/.test(html), 'app.js should have a versioned script URL');
assert(moduleSource.includes('SUPPORTED_EXTENSIONS'));
for (const extension of ['xsf', 'pdb', 'pbd', 'xyz', 'cif', 'vasp', 'poscar']) {
  assert(moduleSource.includes("'" + extension + "'"), 'viewer should support .' + extension);
}
assert(app.includes('function isStructureFileRef'));
assert(app.includes('function openStructurePreviewForFile'));
assert(app.includes('View structure'));
assert(css.includes('.structure-preview-canvas-wrap'));
assert(css.includes('touch-action: none'));
console.log('structure preview UI wiring checks passed');
