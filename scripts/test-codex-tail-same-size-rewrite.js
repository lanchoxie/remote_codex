const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexSessionTailer } = require('../shared/codex-tail');

function assistantRow(id, text, timestamp) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      id,
      type: 'message',
      role: 'assistant',
      phase: 'final',
      content: [{ type: 'output_text', text }],
    },
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-rewrite-'));
  try {
    const rolloutPath = path.join(root, 'rollout-11111111-1111-4111-8111-111111111111.jsonl');
    fs.writeFileSync(rolloutPath, '', 'utf8');
    const posted = [];
    const tailer = new CodexSessionTailer({
      codexHome: root,
      hostId: 'rewrite-test-host',
      assistantMirrorGraceMs: 0,
      postEvents: async (events) => posted.push(...events),
    });
    tailer.setWatchedSessions([{
      sessionId: '11111111-1111-4111-8111-111111111111',
      nativeThreadId: '11111111-1111-4111-8111-111111111111',
      rolloutPath,
      selected: true,
    }]);

    const serialized = `${JSON.stringify(assistantRow(
      'assistant-one',
      'one answer',
      '2026-08-30T00:00:00.000Z'
    ))}\n`;
    fs.appendFileSync(rolloutPath, serialized, 'utf8');
    const appended = await tailer.poll();
    assert.strictEqual(appended.emittedEvents, 1);
    assert.strictEqual(posted.length, 1);

    fs.writeFileSync(rolloutPath, serialized, 'utf8');
    const rewrittenAt = new Date(Date.now() + 5000);
    fs.utimesSync(rolloutPath, rewrittenAt, rewrittenAt);
    const rewritten = await tailer.poll();
    assert.strictEqual(rewritten.replaced, true, 'same-size mtime changes should remain observable');
    assert.strictEqual(rewritten.emittedEvents, 0, 'same-size rewrites must not replay the complete rollout');
    assert.strictEqual(posted.length, 1, 'same-size rewrites must not rebroadcast prior transcript events');

    fs.appendFileSync(rolloutPath, `${JSON.stringify(assistantRow(
      'assistant-two',
      'next answer',
      '2026-08-30T00:00:01.000Z'
    ))}\n`, 'utf8');
    const afterRewriteAppend = await tailer.poll();
    assert.strictEqual(afterRewriteAppend.emittedEvents, 1);
    assert.strictEqual(posted.length, 2, 'tailing must continue from EOF after the rewrite');
    assert(posted.some((event) => event.text === 'next answer'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('Codex tail same-size rewrite assertions passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
