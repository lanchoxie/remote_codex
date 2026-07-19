const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'apps', 'mobile-web', 'public', 'vendor');
const assets = [
  ['node_modules/markdown-it/dist/markdown-it.min.js', 'markdown-it-14.1.0.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'dompurify-3.2.6.min.js'],
];

fs.mkdirSync(vendorDir, { recursive: true });
for (const [sourceRelative, targetName] of assets) {
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing locked browser dependency: ${sourceRelative}`);
  }
  fs.copyFileSync(source, path.join(vendorDir, targetName));
}

console.log(`Copied ${assets.length} locked browser assets to ${path.relative(root, vendorDir)}`);
