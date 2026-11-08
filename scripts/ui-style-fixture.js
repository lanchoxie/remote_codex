const fs = require('fs');
const path = require('path');
const publicRoot = path.resolve(__dirname, '..', 'apps/mobile-web/public');
function readUiStyles() {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  return [...html.matchAll(/<link\b[^>]*href="([^"]+\.css(?:\?[^"]*)?)"[^>]*>/g)]
    .map(([, url]) => fs.readFileSync(path.join(publicRoot, url.split('?')[0].replace(/^\//, '')), 'utf8'))
    .join('\n');
}
module.exports = { readUiStyles };
