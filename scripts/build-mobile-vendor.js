const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'apps', 'mobile-web', 'public', 'vendor');
const assets = [
  ['node_modules/markdown-it/dist/markdown-it.min.js', 'markdown-it-14.1.0.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'dompurify-3.2.6.min.js'],
  ['node_modules/ngl/dist/ngl.js', 'ngl-2.5.0.js'],
  ['node_modules/ngl/LICENSE', 'LICENSE.ngl'],
  ['node_modules/three/build/three.module.js', 'three/three.module.js'],
  ['node_modules/three/examples/jsm/geometries/ConvexGeometry.js', 'three/geometries/ConvexGeometry.js'],
  ['node_modules/three/examples/jsm/math/ConvexHull.js', 'three/math/ConvexHull.js'],
  ['node_modules/three/examples/jsm/controls/OrbitControls.js', 'three/OrbitControls.js'],
  ['node_modules/three/LICENSE', 'three/LICENSE'],
];

fs.mkdirSync(vendorDir, { recursive: true });
for (const [sourceRelative, targetName] of assets) {
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing locked browser dependency: ${sourceRelative}`);
  }
  const target = path.join(vendorDir, targetName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

console.log(`Copied ${assets.length} locked browser assets to ${path.relative(root, vendorDir)}`);
