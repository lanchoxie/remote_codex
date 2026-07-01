const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const app = fs.readFileSync(appPath, 'utf8');

function extractFunctionSource(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(app);
  assert(match, `${name} was not found`);
  const start = match.index;
  let index = start + match[0].length - 1;
  let parenDepth = 0;
  let bodyStarted = false;
  for (; index < app.length; index += 1) {
    const char = app[index];
    if (char === '(') parenDepth += 1;
    if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (char === '{' && parenDepth === 0) {
      bodyStarted = true;
      break;
    }
  }
  assert(bodyStarted, `${name} body was not found`);
  let depth = 0;
  for (; index < app.length; index += 1) {
    const char = app[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return app.slice(start, index + 1);
      }
    }
  }
  throw new Error(`${name} body did not terminate`);
}

const sandbox = {
  TRANSCRIPT_RENDER_MIN_WINDOW: 32,
  TRANSCRIPT_RENDER_CHAR_BUDGET: 90000,
  TRANSCRIPT_RENDER_LINE_BUDGET: 3000,
  TRANSCRIPT_RENDER_CODE_FENCE_BUDGET: 180,
};
vm.createContext(sandbox);
vm.runInContext([
  extractFunctionSource('estimateTranscriptEntryRenderCost'),
  extractFunctionSource('selectTranscriptRenderWindow'),
].join('\n'), sandbox);

const heavyEntries = Array.from({ length: 220 }, (_, index) => ({
  speaker: index % 2 ? 'agent' : 'user',
  timestamp: new Date(2026, 5, 1, 0, index).toISOString(),
  text: [
    `entry ${index}`,
    '```text',
    'x'.repeat(3000),
    '```',
  ].join('\n'),
}));
const heavyWindow = sandbox.selectTranscriptRenderWindow(heavyEntries, 160, { enforceBudget: true });
assert(
  heavyWindow.renderedTranscript.length < 160,
  'heavy histories should not render the full 160-message default window'
);
assert(
  heavyWindow.renderedTranscript.length >= sandbox.TRANSCRIPT_RENDER_MIN_WINDOW,
  'heavy histories should preserve a minimum useful recent window'
);
assert.strictEqual(
  heavyWindow.renderedTranscript.at(-1),
  heavyEntries.at(-1),
  'budgeted windows must keep the latest transcript entry'
);

const lightEntries = Array.from({ length: 220 }, (_, index) => ({
  speaker: index % 2 ? 'agent' : 'user',
  timestamp: new Date(2026, 5, 1, 0, index).toISOString(),
  text: `short ${index}`,
}));
const lightWindow = sandbox.selectTranscriptRenderWindow(lightEntries, 160, { enforceBudget: true });
assert.strictEqual(
  lightWindow.renderedTranscript.length,
  160,
  'light histories should keep the normal 160-message default window'
);

const renderTranscriptSource = extractFunctionSource('renderTranscript');
assert(
  renderTranscriptSource.includes('selectTranscriptRenderWindow('),
  'renderTranscript should use the budgeted transcript window selector'
);
assert(
  renderTranscriptSource.includes('buildThinkingEntriesForSession(session, {')
    && renderTranscriptSource.includes('transcriptEntries: renderedTranscript'),
  'renderTranscript should build thinking entries only for the rendered transcript window'
);

const statusWindowSource = extractFunctionSource('renderStatusWindow');
assert(
  !statusWindowSource.includes('buildThinkingEntriesForSession(session)'),
  'status window should not run full transcript/diagnostic thinking pairing just to show a count'
);

console.log('transcript render performance budget checks passed');
