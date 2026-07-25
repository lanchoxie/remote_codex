const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_PATH = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'thinking-entry-model.js');
const {
  aggregateThinkingEntries,
  buildThinkingRenderEntries,
  makeThinkingGroupKey,
  normalizeThinkingActivityEntry,
  thinkingEntryIdentity,
} = require(MODULE_PATH);

function event(overrides = {}) {
  return {
    canonicalConversationKey: 'host-a::conversation-a',
    runId: 'run-1',
    turnId: 'turn-1',
    timestamp: '2026-07-21T10:00:00.000Z',
    ...overrides,
  };
}

function verifyBrowserGlobal() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: MODULE_PATH });
  assert(context.RemoteCodexThinkingEntryModel, 'browser build should publish a global API');
  assert.strictEqual(
    typeof context.RemoteCodexThinkingEntryModel.aggregateThinkingEntries,
    'function'
  );
}

function verifyStableIdentity() {
  const first = event({
    kind: 'reasoning',
    method: 'item/reasoning/summaryTextDelta',
    itemId: 'reasoning-1',
    summaryIndex: 2,
    text: 'First ',
  });
  const later = { ...first, timestamp: '2026-07-21T10:00:01.000Z', text: 'step.' };
  assert.strictEqual(makeThinkingGroupKey(first), makeThinkingGroupKey(later));
  const identity = thinkingEntryIdentity(first);
  assert.strictEqual(identity.itemId, 'reasoning-1');
  assert.strictEqual(identity.summaryIndex, 2);
  assert.strictEqual(identity.category, 'reasoning');

  const upstream = normalizeThinkingActivityEntry(event({
    groupKey: 'upstream-stable-group',
    activityKeys: ['activity-a', 'activity-b', 'activity-a'],
    kind: 'reasoning',
    text: 'upstream snapshot',
  }));
  assert.strictEqual(upstream.groupKey, 'upstream-stable-group');
  assert.deepStrictEqual(upstream.activityKeys, ['activity-a', 'activity-b']);
  assert.strictEqual(makeThinkingGroupKey(upstream), 'upstream-stable-group');
}

function verifyTextAggregation() {
  const reasoning = aggregateThinkingEntries([
    event({
      kind: 'reasoning',
      method: 'item/reasoning/summaryTextDelta',
      itemId: 'reasoning-1',
      text: 'Inspecting ',
    }),
    event({
      kind: 'reasoning',
      method: 'item/reasoning/summaryTextDelta',
      itemId: 'reasoning-1',
      text: 'the runtime.',
    }),
  ]);
  assert.strictEqual(reasoning.length, 1);
  assert.strictEqual(reasoning[0].text, 'Inspecting the runtime.');

  const snapshots = aggregateThinkingEntries([
    event({
      kind: 'reasoning',
      activityKey: 'activity-reasoning-1',
      activityRevision: 1,
      itemId: 'reasoning-2',
      text: 'Partial',
    }),
    event({
      kind: 'reasoning',
      activityKey: 'activity-reasoning-1',
      activityRevision: 2,
      itemId: 'reasoning-2',
      text: 'Complete summary',
      final: true,
    }),
  ]);
  assert.strictEqual(snapshots.length, 1);
  assert.strictEqual(snapshots[0].text, 'Complete summary');
  assert.strictEqual(snapshots[0].final, true);
  assert.strictEqual(snapshots[0].terminal, true);
  assert.deepStrictEqual(snapshots[0].activityKeys, ['activity-reasoning-1']);

  const plan = aggregateThinkingEntries([
    event({
      kind: 'plan',
      method: 'item/plan/delta',
      itemId: 'plan-1',
      text: '1. Inspect',
    }),
    event({
      kind: 'plan',
      method: 'item/plan/delta',
      itemId: 'plan-1',
      text: '\n2. Test',
    }),
    event({
      kind: 'plan',
      method: 'turn/plan/updated',
      itemId: 'plan-1',
      text: 'ignored delta',
      data: { rawPlan: '1. Inspect\n2. Test\n3. Report' },
    }),
  ]);
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].text, '1. Inspect\n2. Test\n3. Report');

  const commentary = aggregateThinkingEntries([
    event({
      kind: 'commentary',
      method: 'item/agentMessage/delta',
      itemId: 'commentary-1',
      text: 'Checking ',
    }),
    event({
      kind: 'commentary',
      method: 'item/agentMessage/delta',
      itemId: 'commentary-1',
      text: 'files.',
    }),
  ]);
  assert.strictEqual(commentary[0].text, 'Checking files.');
}

function verifyStructuredGrouping() {
  const entries = aggregateThinkingEntries([
    event({
      kind: 'tool-call',
      method: 'response_item/function_call/read_file',
      itemId: 'tool-item-1',
      callId: 'call-1',
      name: 'read_file',
      server: 'workspace',
      arguments: { path: '<unsafe>.txt' },
      commandActions: [{ type: 'read', path: '<unsafe>.txt' }],
      text: 'read_file: <unsafe>.txt',
    }),
    event({
      kind: 'command-output',
      method: 'response_item/function_call_output',
      callId: 'call-1',
      text: '<b>literal result</b>',
      resultText: '<b>literal result</b>',
    }),
    event({
      kind: 'tool-call',
      method: 'item/completed',
      itemId: 'tool-item-1',
      callId: 'call-1',
      activityKey: 'tool-activity-start',
      status: 'completed',
      durationMs: 42,
      progress: 'done',
      final: true,
    }),
    event({
      kind: 'tool-call',
      method: 'item/completed',
      itemId: 'tool-item-1',
      callId: 'call-1',
      activityKey: 'tool-activity-final',
      status: 'completed',
      final: true,
    }),
  ]);
  assert.strictEqual(entries.length, 1, 'callId and itemId aliases should join tool lifecycle rows');
  const entry = entries[0];
  assert.strictEqual(entry.identity.callId, 'call-1');
  assert.strictEqual(entry.identity.itemId, 'tool-item-1');
  assert.strictEqual(entry.callId, 'call-1');
  assert.strictEqual(entry.itemId, 'tool-item-1');
  assert.strictEqual(entry.type, entry.category);
  assert.strictEqual(entry.tool, 'read_file');
  assert.strictEqual(entry.server, 'workspace');
  assert.strictEqual(entry.resultText, '<b>literal result</b>');
  assert.strictEqual(entry.durationMs, 42);
  assert.strictEqual(entry.progress, 'done');
  assert.strictEqual(entry.status, 'completed');
  assert.strictEqual(entry.terminal, true);
  assert.deepStrictEqual(entry.activityKeys, ['tool-activity-start', 'tool-activity-final']);
  assert(!Object.prototype.hasOwnProperty.call(entry, 'html'), 'render entries must not expose HTML');
  assert(entry.argumentsText.includes('<unsafe>.txt'), 'structured arguments should remain literal text');
  assert(entry.commandActionsText.includes('read'), 'structured command actions should survive aggregation');
}

function verifyCommandBoundsAndTerminalPrecedence() {
  const longOutput = Array.from({ length: 30 }, (_, index) => `${index}:output;`).join('');
  const entries = aggregateThinkingEntries([
    event({
      kind: 'command-output',
      method: 'item/commandExecution/outputDelta',
      itemId: 'command-1',
      processId: 'process-1',
      command: 'npm test',
      cwd: 'D:/workspace',
      text: longOutput.slice(0, 140),
    }),
    event({
      kind: 'command-output',
      method: 'process/outputDelta',
      processId: 'process-1',
      text: longOutput.slice(140),
    }),
    event({
      kind: 'command-output',
      method: 'item/completed',
      itemId: 'command-1',
      processId: 'process-1',
      status: 'failed',
      exitCode: 1,
      error: '<script>failure</script>',
      durationMs: 99,
      final: true,
    }),
    event({
      kind: 'command-output',
      method: 'item/commandExecution/outputDelta',
      itemId: 'command-1',
      processId: 'process-1',
      status: 'running',
      progress: 'late non-terminal update',
      text: 'late output',
    }),
  ], { maxOutputChars: 64 });
  assert.strictEqual(entries.length, 1);
  const entry = entries[0];
  assert.strictEqual(entry.processId, 'process-1');
  assert.strictEqual(entry.status, 'failed', 'late non-terminal data must not roll back terminal status');
  assert.strictEqual(entry.exitCode, 1);
  assert.strictEqual(entry.durationMs, 99);
  assert.strictEqual(entry.error, '<script>failure</script>');
  assert(entry.text.length <= 64, 'output fallback text must remain bounded');
  assert(entry.outputTruncated, 'bounded output should report truncation');
  assert(entry.text.includes('late output'), 'bounded output should retain its newest tail');
}

function verifyFileAndSearchGrouping() {
  const files = aggregateThinkingEntries([
    event({
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      requestId: 'request-1',
      status: 'pending',
      data: {
        fileChanges: {
          'src/app.js': { type: 'update', unified_diff: '-old\n+new' },
        },
      },
      text: 'File change approval requested',
    }),
    event({
      kind: 'file-change',
      method: 'event_msg/patch_apply_end',
      requestId: 'request-1',
      status: 'applied',
      success: true,
      data: {
        changes: [{ path: 'src/app.js', status: 'modified', additions: 1, deletions: 1 }],
      },
      text: 'Patch applied',
    }),
  ]);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].identity.requestId, 'request-1');
  assert.strictEqual(files[0].fileChanges.length, 1);
  assert.strictEqual(files[0].fileChanges[0].path, 'src/app.js');
  assert.strictEqual(files[0].status, 'applied');

  const searches = aggregateThinkingEntries([
    event({
      kind: 'web-search',
      method: 'item/webSearch/started',
      callId: 'search-call-1',
      query: '<query>',
      action: 'search',
      status: 'running',
      text: 'Searching',
    }),
    event({
      kind: 'web-search',
      method: 'event_msg/web_search_end',
      callId: 'search-call-1',
      query: '<query>',
      status: 'completed',
      resultText: '2 results',
      final: true,
      text: 'Search completed',
    }),
  ]);
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(searches[0].query, '<query>');
  assert.strictEqual(searches[0].resultText, '2 results');
  assert.strictEqual(searches[0].terminal, true);
}

function verifyEntryAndTotalBounds() {
  const entries = buildThinkingRenderEntries(Array.from({ length: 8 }, (_, index) => event({
    kind: 'commentary',
    method: 'commentary/message',
    itemId: `commentary-${index}`,
    text: `message-${index}`,
  })), { maxEntries: 3, maxTotalChars: 1024 });
  assert.deepStrictEqual(entries.map((entry) => entry.text), ['message-5', 'message-6', 'message-7']);
}

function verifyNormalizedInputsUseCurrentOrder() {
  const early = normalizeThinkingActivityEntry(event({
    kind: 'commentary',
    itemId: 'ordered-early',
    text: 'early',
  }), 99);
  const later = normalizeThinkingActivityEntry(event({
    kind: 'commentary',
    itemId: 'ordered-later',
    text: 'later',
  }), 0);
  assert.deepStrictEqual(
    aggregateThinkingEntries([early, later]).map((entry) => entry.text),
    ['early', 'later'],
    'aggregation must reindex normalized entries in their current input order'
  );
}

function verifyStructuredOnlyEntriesSurvive() {
  const entries = aggregateThinkingEntries([
    event({
      kind: 'activity',
      itemType: 'mcpToolCall',
      source: 'codex',
      callId: 'structured-only-call',
      tool: 'read_file',
      namespace: 'workspace',
      resourceUri: 'file:///workspace/README.md',
      senderThreadId: 'thread-parent',
      receiverThreadIds: ['thread-child-a', 'thread-child-b'],
      prompt: 'Inspect the project readme',
      agentsStates: { 'thread-child-a': 'running' },
      actionData: { action: 'read' },
      model: 'gpt-5.2-codex',
      reasoningEffort: 'high',
      arguments: { path: 'README.md' },
      commandActions: [{ type: 'read', path: 'README.md' }],
    }),
  ]);
  assert.strictEqual(entries.length, 1, 'structured-only operations must remain visible');
  assert(entries[0].argumentsText.includes('README.md'));
  assert(entries[0].commandActionsText.includes('read'));
  assert.strictEqual(entries[0].category, 'tool');
  assert.strictEqual(entries[0].itemType, 'mcpToolCall');
  assert.strictEqual(entries[0].source, 'codex');
  assert.strictEqual(entries[0].identity.itemType, 'mcpToolCall');
  assert.strictEqual(entries[0].identity.source, 'codex');
  assert.strictEqual(entries[0].namespace, 'workspace');
  assert.strictEqual(entries[0].resourceUri, 'file:///workspace/README.md');
  assert.strictEqual(entries[0].senderThreadId, 'thread-parent');
  assert(entries[0].receiverThreadIdsText.includes('thread-child-b'));
  assert.strictEqual(entries[0].prompt, 'Inspect the project readme');
  assert(entries[0].agentsStatesText.includes('running'));
  assert(entries[0].actionDataText.includes('read'));
  assert.strictEqual(entries[0].model, 'gpt-5.2-codex');
  assert.strictEqual(entries[0].reasoningEffort, 'high');
}

function verifyGroupKeyIsOrderIndependent() {
  const diagnostic = event({
    kind: 'tool-call',
    itemId: 'semantic-item',
    callId: 'semantic-call',
    text: 'diagnostic',
  });
  const activity = event({
    kind: 'tool-call',
    itemId: 'semantic-item',
    callId: 'semantic-call',
    activityKey: 'transport-activity',
    text: 'activity',
  });
  const forward = aggregateThinkingEntries([diagnostic, activity]);
  const reverse = aggregateThinkingEntries([activity, diagnostic]);
  assert.strictEqual(forward.length, 1);
  assert.strictEqual(reverse.length, 1);
  assert.strictEqual(forward[0].groupKey, reverse[0].groupKey);
  assert(forward[0].groupKey.includes('semantic-call'), 'callId should outrank transport activityKey');

  const generic = event({
    kind: 'activity',
    callId: 'cross-category-call',
    text: 'generic lifecycle event',
  });
  const tool = event({
    kind: 'tool-call',
    callId: 'cross-category-call',
    itemType: 'mcpToolCall',
    source: 'codex',
    text: 'tool lifecycle event',
  });
  const genericFirst = aggregateThinkingEntries([generic, tool]);
  const toolFirst = aggregateThinkingEntries([tool, generic]);
  assert.strictEqual(genericFirst[0].groupKey, toolFirst[0].groupKey);
  assert.strictEqual(genericFirst[0].category, 'tool');
  assert.strictEqual(toolFirst[0].category, 'tool');
  assert.strictEqual(genericFirst[0].identity.itemType, 'mcpToolCall');
  assert.strictEqual(genericFirst[0].identity.source, 'codex');
}

function verifyStaleTerminalRevisionCannotRegressState() {
  const entries = aggregateThinkingEntries([
    event({
      kind: 'command-output',
      itemId: 'terminal-command',
      activityRevision: 2,
      text: 'new output',
      status: 'failed',
      error: 'new failure',
      final: true,
    }),
    event({
      kind: 'command-output',
      itemId: 'terminal-command',
      activityRevision: 1,
      text: 'old output',
      status: 'completed',
      final: true,
    }),
  ]);
  assert.strictEqual(entries[0].text, 'new output');
  assert.strictEqual(entries[0].status, 'failed');
  assert.strictEqual(entries[0].error, 'new failure');
}

function renderedContentCost(entry) {
  return [
    entry.name,
    entry.text,
    entry.output,
    entry.stdout,
    entry.stderr,
    entry.command,
    entry.cwd,
    entry.argumentsText,
    entry.commandActionsText,
    entry.server,
    entry.tool,
    entry.namespace,
    entry.resourceUri,
    entry.senderThreadId,
    entry.receiverThreadIdsText,
    entry.prompt,
    entry.agentsStatesText,
    entry.actionDataText,
    entry.model,
    entry.reasoningEffort,
    entry.resultText,
    entry.progress,
    entry.query,
    entry.action,
    entry.status,
    entry.completedAt,
    entry.error,
    ...(entry.fileChanges || []).flatMap((change) => [change.path, change.status, change.diff]),
  ].reduce((sum, value) => sum + String(value || '').length, 0);
}

function verifySingleEntryTotalBound() {
  const long = 'x'.repeat(200);
  const entries = aggregateThinkingEntries([
    event({
      kind: 'tool-call',
      callId: 'bounded-call',
      name: long,
      text: long,
      output: long,
      stdout: long,
      stderr: long,
      command: long,
      cwd: long,
      arguments: { value: long },
      commandActions: [{ value: long }],
      server: long,
      tool: long,
      namespace: long,
      resourceUri: long,
      senderThreadId: long,
      receiverThreadIdsText: long,
      prompt: long,
      agentsStatesText: long,
      actionDataText: long,
      model: long,
      reasoningEffort: long,
      resultText: long,
      progress: long,
      query: long,
      action: long,
      status: 'running',
      error: long,
      fileChanges: [{ path: long, status: long, diff: long }],
    }),
  ], {
    maxTextChars: 256,
    maxOutputChars: 256,
    maxDiffChars: 256,
    maxTotalChars: 128,
  });
  assert.strictEqual(entries.length, 1);
  assert(
    renderedContentCost(entries[0]) <= 128,
    `single-entry rendered content exceeded the total bound: ${renderedContentCost(entries[0])}`
  );
}

verifyBrowserGlobal();
verifyStableIdentity();
verifyTextAggregation();
verifyStructuredGrouping();
verifyCommandBoundsAndTerminalPrecedence();
verifyFileAndSearchGrouping();
verifyEntryAndTotalBounds();
verifyNormalizedInputsUseCurrentOrder();
verifyStructuredOnlyEntriesSurvive();
verifyGroupKeyIsOrderIndependent();
verifyStaleTerminalRevisionCannotRegressState();
verifySingleEntryTotalBound();

const normalized = normalizeThinkingActivityEntry({
  kind: 'reasoning',
  turnId: 'turn-normalized',
  itemId: 'item-normalized',
  text: '<em>plain text</em>',
});
assert.strictEqual(normalized.text, '<em>plain text</em>');

console.log('thinking entry model assertions passed');
