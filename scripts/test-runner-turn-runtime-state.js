const assert = require('assert');
const fs = require('fs');

const runner = fs.readFileSync('apps/host-agent/codex-app-server-runner.js', 'utf8');

function assertContains(source, needle, message) {
  assert(
    source.includes(needle),
    `${message}\nExpected to find: ${needle}`
  );
}

function extractBlock(startNeedle, endNeedle) {
  const start = runner.indexOf(startNeedle);
  const end = runner.indexOf(endNeedle, start);
  assert(start >= 0 && end > start, `expected to extract block from ${startNeedle}`);
  return runner.slice(start, end);
}

const reasoningBlock = extractBlock(
  "if (method === 'item/reasoning/summaryTextDelta')",
  "if (method === 'item/plan/delta' || method === 'turn/plan/updated')"
);
assertContains(
  reasoningBlock,
  'const isActiveTurn = turnId && turnId === this.activeTurnId;',
  'late reasoning deltas for a completed turn must not resurrect active runtime state'
);
assertContains(
  reasoningBlock,
  'if (isActiveTurn) {',
  'runner should only emit busy thinking runtime for the currently active turn'
);

const planBlock = extractBlock(
  "if (method === 'item/plan/delta' || method === 'turn/plan/updated')",
  "if (method === 'thread/tokenUsage/updated')"
);
assertContains(
  planBlock,
  'const isActiveTurn = turnId && turnId === this.activeTurnId;',
  'late plan deltas for a completed turn must not resurrect active runtime state'
);
assertContains(
  planBlock,
  'if (isActiveTurn) {',
  'runner should only emit busy planning runtime for the currently active turn'
);

const resolveRequestBlock = extractBlock(
  'async respondToRequest',
  'async resolvePendingRequestsForClosedTurn'
);
assertContains(
  resolveRequestBlock,
  'busy: Boolean(this.activeTurnId),',
  'resolving a Codex request after a turn closes must explicitly clear busy state'
);

console.log('runner turn runtime state assertions passed');
