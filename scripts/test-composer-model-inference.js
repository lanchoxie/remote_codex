const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'apps/mobile-web/public/app.js'), 'utf8');

function functionBody(name) {
  const marker = `function ${name}`;
  const start = app.indexOf(marker);
  assert(start >= 0, `${name} should exist`);
  const next = app.indexOf('\nfunction ', start + marker.length);
  return app.slice(start, next >= 0 ? next : app.length);
}

const inferText = functionBody('inferComposerOptionsFromText');
const inferSession = functionBody('inferComposerOptionsFromSession');

assert(
  !inferText.includes('modelMatch'),
  'Composer option inference must not parse bare `model:` text from transcripts'
);

assert(
  !inferSession.includes('textInferred.model'),
  'Transcript text should not be used as a Codex model source'
);

assert(
  inferSession.includes("model: runtime.model || latestTurnControl?.data?.model || session.codexOptions?.model || ''"),
  'Codex model inference should only use structured runtime, turn/start, or session codexOptions'
);

assert(
  inferText.includes('effortMatch') && inferText.includes('reviewerMatch'),
  'Safe text inference for effort/reviewer hints should remain available'
);

console.log('composer model inference contract ok');
