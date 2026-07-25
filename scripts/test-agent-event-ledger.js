const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentEventLedger } = require('../apps/relay/agent-event-ledger');

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-event-ledger-'));
  const filePath = path.join(root, 'ledger.jsonl');
  let clock = 1000;
  try {
    const first = new AgentEventLedger({ filePath, limit: 4, now: () => ++clock });
    assert.strictEqual(first.recordPartial('host-a|batch-a', 'digest-a', 1), true);
    assert.strictEqual(first.recordPartial('host-a|batch-a', 'digest-a', 1), false);
    assert.strictEqual(first.recordPartial('host-a|batch-a', 'digest-a', 2), true);
    assert.strictEqual(first.partial.get('host-a|batch-a')?.appliedCount, 2);
    assert.strictEqual(first.recordApplied('host-b|batch-b', 'digest-b'), true);

    const restarted = new AgentEventLedger({ filePath, limit: 4, now: () => ++clock });
    assert.strictEqual(
      restarted.partial.get('host-a|batch-a')?.appliedCount,
      2,
      'partial batch progress must survive Relay restart'
    );
    assert.strictEqual(
      restarted.applied.get('host-b|batch-b')?.digest,
      'digest-b',
      'applied batch dedupe must survive Relay restart'
    );
    const interruptedCompactionBackup = `${filePath}.interrupted-compaction.tmp.bak`;
    fs.renameSync(filePath, interruptedCompactionBackup);
    const recoveredMissingCanonical = new AgentEventLedger({ filePath, limit: 4, now: () => ++clock });
    assert.strictEqual(
      recoveredMissingCanonical.applied.get('host-b|batch-b')?.digest,
      'digest-b',
      'a restart must restore the old ledger when compaction left only its backup'
    );
    assert.strictEqual(fs.existsSync(interruptedCompactionBackup), false);
    assert.strictEqual(recoveredMissingCanonical.recordApplied('host-a|batch-a', 'digest-a'), true);
    assert.strictEqual(recoveredMissingCanonical.partial.has('host-a|batch-a'), false);
    assert.strictEqual(recoveredMissingCanonical.applied.has('host-a|batch-a'), true);
    assert.throws(
      () => recoveredMissingCanonical.recordApplied('host-a|batch-a', 'different-digest'),
      (error) => error?.code === 'agent_event_batch_id_conflict'
    );

    fs.appendFileSync(filePath, '{"version":1,"op":"partial"', 'utf8');
    const recoveredTail = new AgentEventLedger({ filePath, limit: 4, now: () => ++clock });
    assert.strictEqual(recoveredTail.applied.has('host-a|batch-a'), true);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).at(-1)));

    for (let index = 0; index < 8; index += 1) {
      recoveredTail.recordApplied(`host-a|bounded-${index}`, `digest-${index}`);
    }
    const bounded = new AgentEventLedger({ filePath, limit: 4, now: () => ++clock });
    assert(bounded.applied.size <= 4, 'ledger replay must remain bounded');
    console.log('agent event ledger assertions passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
