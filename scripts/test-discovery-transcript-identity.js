const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractSessionTranscript } = require('../shared/codex-discovery');

function assistantRow(id, timestamp, text) {
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-discovery-identity-'));
try {
  const rolloutPath = path.join(
    root,
    'rollout-2026-08-30T00-00-00-11111111-1111-4111-8111-111111111111.jsonl'
  );
  const repeatedText = 'A valid answer may be repeated in a later turn.';
  fs.writeFileSync(rolloutPath, [
    assistantRow('assistant-turn-a', '2026-08-30T00:00:00.000Z', repeatedText),
    assistantRow('assistant-turn-b', '2026-08-30T00:01:00.000Z', repeatedText),
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  const transcript = extractSessionTranscript(rolloutPath, { maxChars: Infinity });
  assert.strictEqual(
    transcript.filter((entry) => entry.text === repeatedText).length,
    2,
    'different assistant identities must survive even when their text is identical'
  );
  assert.notStrictEqual(
    transcript[0].assistantMessageId,
    transcript[1].assistantMessageId,
    'the two retained messages must keep distinct durable identities'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('discovery transcript identity assertions passed');
