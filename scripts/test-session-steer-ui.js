'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const steer = require('../apps/mobile-web/public/ui/session-steer');
const source = fs.readFileSync(path.join(__dirname, '../apps/mobile-web/public/app.js'), 'utf8');
function extract(name) {
  const starts = [`async function ${name}(`, `function ${name}(`].map((s) => source.indexOf(s)).filter((i) => i >= 0);
  const start = Math.min(...starts);
  assert(Number.isFinite(start));
  const ends = ['\nfunction ', '\nasync function '].map((s) => source.indexOf(s, start + 1)).filter((i) => i >= 0);
  return source.slice(start, Math.min(...ends));
}
const target = { hostId: 'h', sessionId: 's', runId: 'r', expectedTurnId: 't', text: 'keep context' };
function harness(request) {
  const timers = new Map(); let timer = 0; let id = 0;
  const client = steer.createClient({ request, makeId: () => `guide-${++id}`, pollLimit: 1,
    schedule: (callback) => { timers.set(++timer, callback); return timer; }, cancel: (key) => timers.delete(key) });
  return { client, timers, op: client.create(target) };
}
function receipt(op, status = 'accepted') { return { ...op.target, status, commandId: 42, turnId: op.target.expectedTurnId }; }
async function main() {
  let posts = 0;
  const one = harness(async (_url, options) => { if (options.method === 'POST') posts++; return receipt(one.op, 'queued'); });
  await one.client.submit(one.op);
  assert.equal(one.op.status, 'queued', 'HTTP success is not native acceptance');
  for (const field of ['hostId', 'sessionId', 'runId', 'expectedTurnId', 'requestId', 'commandId', 'turnId']) {
    assert.equal(one.client.apply({ ...receipt(one.op), [field]: field === 'commandId' ? 99 : 'wrong' }), false, field);
  }
  assert.equal(one.client.apply(receipt(one.op)), true);
  assert.equal(one.op.status, 'accepted');
  one.client.apply(receipt(one.op, 'rejected'));
  assert.equal(one.op.status, 'accepted');
  await one.client.submit(one.op);
  assert.equal(posts, 1, 'rechecking an operation never repeats POST');

  let lostPosts = 0;
  const lost = harness(async (_url, options) => { if (options.method === 'POST') lostPosts++; throw new Error('connection lost'); });
  await lost.client.submit(lost.op);
  const scheduled = [...lost.timers.values()][0];
  lost.timers.clear(); scheduled();
  await lost.client.check(lost.op);
  await Promise.resolve();
  assert.equal(lost.op.status, 'acceptance_unknown');
  assert.equal(lost.op.target.text, target.text);
  await lost.client.submit(lost.op);
  assert.equal(lostPosts, 1);
  assert.equal(lost.client.apply(receipt(lost.op)), true, 'late correlated receipt repairs a lost response');
  assert.equal(lost.op.status, 'accepted');

  const restored = harness(async () => receipt(restored.op, 'accepted'));
  const restoredOp = restored.client.restore({ ...restored.op, status: 'acceptance_unknown', commandId: 42 });
  assert(restoredOp, 'persisted Guide operations can be restored');
  assert.equal(restoredOp.target.requestId, restored.op.target.requestId);
  await restored.client.check(restoredOp);
  assert.equal(restoredOp.status, 'accepted', 'restored Guide operations can query the original receipt');

  const early = harness(async () => { early.client.apply(receipt(early.op)); throw new Error('POST response lost after SSE accepted'); });
  await early.client.submit(early.op);
  assert.equal(early.op.status, 'accepted');
  const rejected = harness(async () => { throw Object.assign(new Error('turn changed'), { status: 409 }); });
  await rejected.client.submit(rejected.op);
  assert.equal(rejected.op.status, 'rejected');
  assert.equal(rejected.timers.size, 0);
  const nativeUnknown = harness(async () => receipt(nativeUnknown.op, 'acceptance_unknown'));
  await nativeUnknown.client.submit(nativeUnknown.op);
  assert.equal(nativeUnknown.op.status, 'acceptance_unknown');
  const alias = harness(async () => ({ ...receipt(alias.op, 'queued'), sessionId: 'canonical-session' }));
  await alias.client.submit(alias.op);
  assert.equal(alias.op.status, 'queued');
  assert(!alias.client.apply({ ...receipt(alias.op), sessionId: 'unrelated-session' }));
  assert(alias.client.apply({ ...receipt(alias.op), sessionId: 'canonical-session' }));
  assert.equal(alias.op.status, 'accepted', 'only the exact HTTP lookup may establish a canonical alias');

  assert(steer.textOnly({ text: 'plain', displayText: 'plain' }));
  for (const payload of [{ inputItems: [{}] }, { inlineFiles: [{}] }, { uploadedFiles: [{}] },
    { composerDraft: { attachments: [{ type: 'textFile' }] } }, { text: 'prompt plus history', displayText: 'prompt' }]) assert(!steer.textOnly(payload));
  assert.notEqual(steer.words('en').queued, steer.words('zh-CN').queued);

  // Exercise the real application handlers with an HTTP promise held open.
  let selected = { hostId: 'h', sessionId: 's', runId: 'r', live: true };
  const state = { ui: { locale: 'en' }, codexControls: { steerQueue: [], steerClient: null } };
  let wire; let finish; let counter = 0;
  const context = vm.createContext({ state, window: { RemoteCodexSessionSteer: steer }, Date,
    getSelectedSession: () => selected, getSessionKey: (s) => s ? `${s.hostId}::${s.sessionId}` : '',
    getRuntimeForSession: () => ({ runId: 'r', activeTurnId: 't', busy: true }), runtimeIsActive: (r) => r.busy,
    makeClientId: () => `app-${++counter}`, renderComposerTurnNotice: () => {},
    fetchJson: async (_url, options) => { wire = JSON.parse(options.body); return new Promise((r) => { finish = r; }); },
    getComposerDraftAttachments: (draft) => draft?.attachments || [],
    basename: (s) => s, formatBytes: (n) => `${n} bytes`,
  });
  for (const name of ['getSteerQueueText', 'setSteerQueueItemText', 'addSteerQueueItem', 'findSteerQueueItem',
    'steerCopy', 'getSteerClient', 'queuedPromptDeliveryLocked', 'steerActiveTurn', 'guideQueuedPrompt',
    'getComposerTextFileSections', 'getComposerPromptCardSections', 'getComposerUploadedFileSections', 'buildComposerDisplayText']) {
    vm.runInContext(extract(name), context);
  }
  const item = context.addSteerQueueItem(selected, { text: 'hello', displayText: 'hello' }, 'hello');
  const pending = context.guideQueuedPrompt(item.id);
  assert.equal(item.status, 'guide_pending');
  await context.guideQueuedPrompt(item.id);
  selected = { hostId: 'other', sessionId: 'other', runId: 'other', live: true };
  assert.equal(wire.hostId, 'h'); assert.equal(wire.expectedRunId, 'r'); assert.equal(wire.expectedTurnId, 't');
  finish(receipt(item.steerOperation)); await pending;
  assert.equal(item.status, 'guided');
  assert.equal(item.text, 'hello');

  const file = { name: 'data.txt', type: 'textFile', text: 'scientific data' };
  const payload = { text: 'old\n\nattached content', displayText: 'old\n\nAttached text: data.txt',
    inlineFiles: [{ name: file.name, text: file.text }], inputItems: [{ type: 'skill', name: 'test' }],
    composerDraft: { text: 'old', attachments: [file] } };
  const editable = context.addSteerQueueItem(selected, payload, payload.displayText);
  assert.equal(editable.text, 'old', 'queue editor must show user text, not attachment summaries');
  context.setSteerQueueItemText(editable, 'new');
  assert.match(editable.payload.text, /^new\n\nAttached text file contents:/);
  assert.match(editable.payload.text, /scientific data/);
  assert(!editable.payload.text.includes('old'));
  assert.equal(editable.payload.inlineFiles, payload.inlineFiles);
  assert.equal(editable.payload.inputItems, payload.inputItems);
  editable.status = 'steer_unknown';
  context.setSteerQueueItemText(editable, 'do not edit');
  assert.equal(editable.text, 'new');

  // Real DOM submit handlers: repeated Enter before HTTP returns is one action.
  for (const id of ['steer-form', 'inline-steer-form']) {
    let calls = 0; let release; let handler;
    const input = { value: 'same prompt', dataset: {} };
    const event = { preventDefault() {} };
    const handlerContext = vm.createContext({ el: (key) => key === id ? { addEventListener: (_event, fn) => { handler = fn; } } : input,
      getSelectedSession: () => selected, getSessionKey: (s) => `${s.hostId}::${s.sessionId}`,
      steerActiveTurn: () => { calls++; return new Promise((r) => { release = r; }); }, reportError: assert.fail });
    const start = source.indexOf(`el('${id}').addEventListener`);
    vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), handlerContext);
    const a = handler(event); const b = handler(event);
    assert.equal(calls, 1); release(); await Promise.all([a, b]); assert.equal(input.value, '');
    input.value = 'same prompt';
    const switching = handler(event);
    selected = { hostId: 'changed-host', sessionId: `changed-${id}` };
    release(); await switching;
    assert.equal(input.value, 'same prompt', 'do not clear another Session input after a selection change');
  }
  const inputCalls = [];
  const queued = { id: 'queue-input', sessionKey: 'h::s', payload: { text: 'original with attachments', clientRequestId: 'input-stable' }, status: 'input_unknown' };
  const inputContext = vm.createContext({
    makeClientId: () => 'generated-input-id', getActiveTurnBlocker: () => null,
    assertModelSelectionIsSelectable: () => {}, assertEffortSelectionIsValid: () => {},
    fetchJson: async (url, options) => { inputCalls.push({ url, body: options.body }); throw Object.assign(new Error('timed out'), { code: 'request_timeout' }); },
    findSteerQueueItem: () => queued, renderComposerTurnNotice: () => {},
    findSessionForResolvedComposerKey: () => ({ hostId: 'h', sessionId: 's' }), resolveComposerSessionKey: (s) => s,
    setActiveDraftForSession: () => {}, removeSteerQueueItem: () => { queued.removed = true; },
    steerCopy: () => steer.words('en'),
  });
  vm.runInContext(extract('sendInputToSession'), inputContext);
  vm.runInContext(extract('retryUnknownQueuedInput'), inputContext);
  try { await inputContext.sendInputToSession({ hostId: 'h', sessionId: 's' }, queued.payload.text, queued.payload); assert.fail(); }
  catch (e) { assert(e.inputAcceptanceUnknown); queued.inputRequest = e.inputRequest; }
  queued.payload.text = 'changed display must not alter retry';
  inputContext.fetchJson = async (url, options) => { inputCalls.push({ url, body: options.body }); return { ok: true }; };
  await inputContext.retryUnknownQueuedInput(queued.id);
  assert.deepEqual(inputCalls[1], inputCalls[0], 'explicit input retry preserves exact original body and stable ID');
  assert(queued.removed);
  console.log('Steer UI acknowledgement, lost-response recovery, target fencing, attachments, double-submit and input retry tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
