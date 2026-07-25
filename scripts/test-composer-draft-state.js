const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const appPath = path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.reduce((found, marker) => {
    const index = source.indexOf(marker);
    return index >= 0 && (found < 0 || index < found) ? index : found;
  }, -1);
  assert(start >= 0, `${name} was not found in app.js`);
  const candidates = [
    source.indexOf('\nfunction ', start + 1),
    source.indexOf('\nasync function ', start + 1),
  ].filter((index) => index >= 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  const block = source.slice(start, end).trim();
  assert(block.endsWith('}'), `${name} did not have a complete body`);
  return block;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const dom = new JSDOM(`<!doctype html><body>
  <form id="input-form">
    <textarea id="input-text"></textarea>
    <input id="codex-local-image-path" />
    <input id="codex-image-files" type="file" />
    <div id="codex-attachment-chips"></div>
  </form>
</body>`);

const sessionA = { hostId: 'host-a', sessionId: 'session-a', live: true };
const sessionB = { hostId: 'host-b', sessionId: 'session-b', live: true };
const keyA = 'host-a::session-a';
const keyB = 'host-b::session-b';
const state = {
  sessions: [sessionA, sessionB],
  sessionApiRebindBusyKeys: new Set(),
  sessionTranscriptFallbackBusyKeys: new Set(),
  sessionRebindFailures: new Map(),
  codexControls: {
    attachments: [],
    composerDraftsBySession: new Map(),
    composerSessionKeyAliases: new Map(),
    mountedComposerSessionKey: '',
    mountingComposerDraft: false,
    activeDraftsBySession: new Map(),
    pendingComposerDraftsBySession: new Map(),
    composerSubmissionsBySession: new Map(),
    recentSubmissions: new Map(),
    sessionOptionsByKey: new Map(),
    persistedSessionOptionKeys: new Set(),
    apiSwitchNoticesBySession: new Map(),
  },
};

const context = {
  window: dom.window,
  document: dom.window.document,
  Event: dom.window.Event,
  File: dom.window.File,
  Blob: dom.window.Blob,
  state,
  selectedSession: sessionA,
  COMPOSER_DRAFT_SESSION_LIMIT: 32,
  MAX_COMPOSER_IMAGES: 4,
  MAX_COMPOSER_IMAGE_BYTES: 8 * 1024 * 1024,
  el: (id) => dom.window.document.getElementById(id),
  getSessionKey: (session) => session ? `${session.hostId}::${session.sessionId}` : null,
  getComposerOptions: () => ({ model: 'model-a', effortMode: 'auto' }),
  updateSlashMenuFromInput: () => {},
  revokeComposerAttachmentPreview: () => {},
  composerAttachmentKey: (attachment) => attachment?.fileId || `${attachment?.type}|${attachment?.name || ''}`,
  isImageFileRef: (attachment) => Boolean(attachment?.isImage || String(attachment?.mime || '').startsWith('image/')),
  makeObjectPreviewUrl: () => 'blob:restored-preview',
  renderSessionDetails: () => {},
  renderComposerModeBanner: () => {},
  renderComposerTurnNotice: () => {},
  persistComposerSessionOptions: () => {},
};
context.getSelectedSession = () => context.selectedSession;
context.renderAttachmentChips = () => {
  if (!state.codexControls.mountingComposerDraft && context.rememberMountedComposerDraft) {
    context.rememberMountedComposerDraft();
  }
};
vm.createContext(context);

for (const name of [
  'resolveComposerSessionKey',
  'findSessionForResolvedComposerKey',
  'getMountedComposerSessionKey',
  'cloneComposerAttachment',
  'cloneComposerDraft',
  'composerDraftHasTemporaryContent',
  'releaseComposerDraftResources',
  'pruneComposerDrafts',
  'setComposerDraftForSessionKey',
  'snapshotComposerDraft',
  'getComposerDraftForSessionKey',
  'appendComposerAttachmentsForSessionKey',
  'patchComposerAttachmentForSessionKey',
  'clearComposerDraftForSessionKey',
  'rememberMountedComposerDraft',
  'applyMountedComposerDraft',
  'syncMountedComposerDraftSession',
  'moveComposerDraftSessionKey',
  'setActiveDraftForSessionKey',
  'stashPendingComposerDraftForSession',
  'restoreComposerDraft',
]) {
  vm.runInContext(extractFunction(name), context, { filename: `${name}.js` });
}

function resetComposer(session = sessionA) {
  for (const map of [
    state.codexControls.composerDraftsBySession,
    state.codexControls.composerSessionKeyAliases,
    state.codexControls.activeDraftsBySession,
    state.codexControls.pendingComposerDraftsBySession,
    state.codexControls.composerSubmissionsBySession,
    state.codexControls.recentSubmissions,
    state.codexControls.sessionOptionsByKey,
    state.codexControls.apiSwitchNoticesBySession,
    state.sessionRebindFailures,
  ]) map.clear();
  for (const set of [
    state.codexControls.persistedSessionOptionKeys,
    state.sessionApiRebindBusyKeys,
    state.sessionTranscriptFallbackBusyKeys,
  ]) set.clear();
  state.codexControls.attachments = [];
  state.codexControls.mountedComposerSessionKey = '';
  state.codexControls.mountingComposerDraft = false;
  context.selectedSession = session;
  context.applyMountedComposerDraft(context.getSessionKey(session), null);
  const input = context.el('input-text');
  input.disabled = false;
  context.el('codex-local-image-path').value = '';
  return input;
}

function mountDraft(session, draft) {
  context.selectedSession = session;
  context.applyMountedComposerDraft(context.getSessionKey(session), draft);
  context.setComposerDraftForSessionKey(context.getSessionKey(session), draft);
}

async function run() {
  const fileA = new dom.window.File(['alpha'], 'alpha.txt', { type: 'text/plain' });
  let input = resetComposer();
  input.value = 'alpha draft';
  input.selectionStart = 2;
  input.selectionEnd = 7;
  state.codexControls.attachments = [{
    type: 'uploadFile',
    fileId: 'file-a',
    fileObject: fileA,
    name: fileA.name,
    mime: fileA.type,
    size: fileA.size,
  }];
  context.el('codex-local-image-path').value = 'D:/images/a.png';
  context.rememberMountedComposerDraft();

  context.selectedSession = sessionB;
  context.syncMountedComposerDraftSession(sessionB);
  assert.strictEqual(input.value, '', 'a new Session should mount an empty composer');
  input.value = 'beta draft';
  input.selectionStart = 4;
  input.selectionEnd = 4;
  context.rememberMountedComposerDraft();

  context.selectedSession = sessionA;
  context.syncMountedComposerDraftSession(sessionA);
  assert.strictEqual(input.value, 'alpha draft');
  assert.strictEqual(input.selectionStart, 2);
  assert.strictEqual(input.selectionEnd, 7);
  assert.strictEqual(context.el('codex-local-image-path').value, 'D:/images/a.png');
  assert.strictEqual(state.codexControls.attachments[0].fileObject, fileA, 'File references must survive an A/B round trip');

  const canonicalKey = 'host-a::canonical-a';
  const inFlight = { id: 'submission-a', sessionKey: keyA };
  state.codexControls.composerSubmissionsBySession.set(keyA, inFlight);
  state.codexControls.sessionOptionsByKey.set(keyA, { model: 'provider-model', effort: '' });
  state.codexControls.persistedSessionOptionKeys.add(keyA);
  state.codexControls.apiSwitchNoticesBySession.set(keyA, { message: 'switching' });
  state.sessionApiRebindBusyKeys.add(keyA);
  state.sessionTranscriptFallbackBusyKeys.add(keyA);
  state.sessionRebindFailures.set(keyA, { code: 'previous-failure' });
  assert.strictEqual(context.moveComposerDraftSessionKey(keyA, canonicalKey), true);
  assert.strictEqual(context.resolveComposerSessionKey(keyA), canonicalKey);
  assert.strictEqual(inFlight.sessionKey, canonicalKey, 'canonical migration must update the live submission object');
  assert.strictEqual(state.codexControls.composerSubmissionsBySession.get(canonicalKey), inFlight);
  assert(state.codexControls.composerDraftsBySession.has(canonicalKey));
  assert.strictEqual(state.codexControls.sessionOptionsByKey.get(canonicalKey).model, 'provider-model');
  assert(state.codexControls.persistedSessionOptionKeys.has(canonicalKey));
  assert.strictEqual(state.codexControls.apiSwitchNoticesBySession.get(canonicalKey).message, 'switching');
  assert(state.sessionApiRebindBusyKeys.has(canonicalKey));
  assert(state.sessionTranscriptFallbackBusyKeys.has(canonicalKey));
  assert.strictEqual(state.sessionRebindFailures.get(canonicalKey).code, 'previous-failure');
  const canonicalSession = { ...sessionA, sessionId: 'canonical-a' };
  state.sessions.push(canonicalSession);
  assert.strictEqual(
    context.findSessionForResolvedComposerKey(keyA, sessionA),
    canonicalSession,
    'resolved lookup must prefer the canonical raw Session key over an aliased stale projection'
  );
  state.sessions.pop();

  context.isComposerSubmitting = () => false;
  context.composerSubmissionSignature = (session, draft) => `${context.getSessionKey(session)}|${draft.text}`;
  context.getOrCreateComposerSubmissionId = () => 'submission-test';
  context.setComposerSubmission = (submission) => {
    const key = context.resolveComposerSessionKey(submission.sessionKey);
    submission.sessionKey = key;
    state.codexControls.composerSubmissionsBySession.set(key, submission);
  };
  context.clearComposerSubmissionForSession = (sessionKey, submissionId) => {
    const key = context.resolveComposerSessionKey(sessionKey);
    const current = state.codexControls.composerSubmissionsBySession.get(key);
    if (!submissionId || current?.id === submissionId) state.codexControls.composerSubmissionsBySession.delete(key);
  };
  context.buildComposerPayload = async (_session, rawText, _overrides, draft) => ({
    text: rawText.trim(),
    displayText: rawText,
    inputItems: draft.attachments.length ? [{ type: 'localFile' }] : [],
    composerDraft: context.cloneComposerDraft(draft),
  });
  context.submitComposerPayload = async () => ({ accepted: true, trackActiveDraft: true });
  vm.runInContext(extractFunction('submitComposerInput'), context, { filename: 'submitComposerInput.js' });

  input = resetComposer();
  const sendFile = new dom.window.File(['send'], 'send.txt', { type: 'text/plain' });
  mountDraft(sessionA, {
    text: 'send this',
    selectionStart: 3,
    selectionEnd: 6,
    localImagePath: 'D:/images/send.png',
    attachments: [{ type: 'uploadFile', fileId: 'send-file', fileObject: sendFile, name: sendFile.name }],
  });
  state.codexControls.composerDraftsBySession.set(keyB, { text: 'keep beta', attachments: [], localImagePath: '' });
  await context.submitComposerInput(input);
  assert.strictEqual(input.value, '', 'accepted send should clear text');
  assert.strictEqual(context.el('codex-local-image-path').value, '', 'accepted send should clear the local image path');
  assert.strictEqual(state.codexControls.attachments.length, 0, 'accepted send should clear attachments');
  assert(!state.codexControls.composerDraftsBySession.has(keyA), 'accepted draft must be removed from its Session');
  assert.strictEqual(state.codexControls.composerDraftsBySession.get(keyB).text, 'keep beta', 'accepted A send must not clear B');
  assert.strictEqual(state.codexControls.activeDraftsBySession.get(keyA).attachments[0].fileObject, sendFile);

  input = resetComposer();
  const failedFile = new dom.window.File(['failed'], 'failed.txt', { type: 'text/plain' });
  mountDraft(sessionA, {
    text: 'restore exactly',
    selectionStart: 1,
    selectionEnd: 8,
    localImagePath: 'D:/images/failed.png',
    attachments: [{ type: 'uploadFile', fileId: 'failed-file', fileObject: failedFile, name: failedFile.name }],
  });
  context.submitComposerPayload = async () => { throw new Error('send failed'); };
  await assert.rejects(context.submitComposerInput(input), /send failed/);
  assert.strictEqual(input.value, 'restore exactly');
  assert.strictEqual(input.selectionStart, 1);
  assert.strictEqual(input.selectionEnd, 8);
  assert.strictEqual(context.el('codex-local-image-path').value, 'D:/images/failed.png');
  assert.strictEqual(state.codexControls.attachments[0].fileObject, failedFile);

  input = resetComposer();
  mountDraft(sessionA, { text: '   ', selectionStart: 2, selectionEnd: 2, attachments: [], localImagePath: '' });
  let noOpSubmitted = false;
  context.submitComposerPayload = async () => {
    noOpSubmitted = true;
    return { accepted: true, trackActiveDraft: false };
  };
  await context.submitComposerInput(input);
  assert.strictEqual(noOpSubmitted, false, 'empty normalized payload must not be submitted');
  assert.strictEqual(input.value, '   ', 'no-op submission must retain text');
  assert.strictEqual(input.selectionStart, 2);

  input = resetComposer();
  mountDraft(sessionA, { text: 'deferred A', selectionStart: 5, selectionEnd: 5, attachments: [], localImagePath: 'A:/image.png' });
  const sendGate = deferred();
  context.submitComposerPayload = () => sendGate.promise;
  const pendingSend = context.submitComposerInput(input);
  await Promise.resolve();
  context.selectedSession = sessionB;
  context.syncMountedComposerDraftSession(sessionB);
  input.value = 'live B draft';
  context.el('codex-local-image-path').value = 'B:/image.png';
  context.rememberMountedComposerDraft();
  sendGate.resolve({ accepted: true, trackActiveDraft: false });
  await pendingSend;
  assert.strictEqual(input.value, 'live B draft', 'completion of A must not clear mounted B text');
  assert.strictEqual(context.el('codex-local-image-path').value, 'B:/image.png');
  assert.strictEqual(state.codexControls.composerDraftsBySession.get(keyB).text, 'live B draft');
  assert(!state.codexControls.composerDraftsBySession.has(keyA));

  input = resetComposer();
  mountDraft(sessionA, { text: 'migrate while sending', selectionStart: 4, selectionEnd: 9, attachments: [], localImagePath: '' });
  const migrationGate = deferred();
  context.submitComposerPayload = () => migrationGate.promise;
  const migratingSend = context.submitComposerInput(input);
  await Promise.resolve();
  const migratedSession = { ...sessionA, sessionId: 'canonical-send' };
  const migratedKey = context.getSessionKey(migratedSession);
  context.moveComposerDraftSessionKey(keyA, migratedKey);
  context.selectedSession = migratedSession;
  migrationGate.reject(new Error('canonical send failed'));
  await assert.rejects(migratingSend, /canonical send failed/);
  assert.strictEqual(state.codexControls.mountedComposerSessionKey, migratedKey);
  assert.strictEqual(input.value, 'migrate while sending');
  assert.strictEqual(input.selectionStart, 4);
  assert.strictEqual(input.selectionEnd, 9);
  assert(state.codexControls.composerDraftsBySession.has(migratedKey));
  assert(!state.codexControls.composerSubmissionsBySession.has(migratedKey));

  input = resetComposer();
  const imageRead = deferred();
  context.readFileAsDataUrl = () => imageRead.promise;
  vm.runInContext(extractFunction('addComposerImageFiles'), context, { filename: 'addComposerImageFiles.js' });
  const pastedFile = new dom.window.File(['image'], 'paste.png', { type: 'image/png' });
  const addingImage = context.addComposerImageFiles([pastedFile], keyA);
  context.selectedSession = sessionB;
  context.syncMountedComposerDraftSession(sessionB);
  input.value = 'B remains isolated';
  context.rememberMountedComposerDraft();
  imageRead.resolve('data:image/png;base64,aW1hZ2U=');
  await addingImage;
  assert.strictEqual(state.codexControls.attachments.length, 0, 'late A image read must not attach to mounted B');
  assert.strictEqual(state.codexControls.composerDraftsBySession.get(keyA).attachments[0].name, 'paste.png');
  assert.strictEqual(state.codexControls.composerDraftsBySession.get(keyB).text, 'B remains isolated');

  const buildContext = {
    cloneComposerAttachment: (attachment) => ({ ...attachment }),
    cloneComposerDraft: (draft = {}) => ({
      ...draft,
      text: String(draft.text || ''),
      attachments: (draft.attachments || []).map((attachment) => ({ ...attachment })),
    }),
    snapshotComposerDraft: () => { throw new Error('explicit draft should be used'); },
    getComposerOptionsForSession: () => ({ model: 'wrong-current-model' }),
    getComposerInputItems: (_uploaded, draft) => draft.attachments.map((attachment) => ({ type: attachment.type, name: attachment.name })),
    getComposerPromptCardSections: () => [],
    getComposerTextFileSections: () => [],
    getComposerInlineFiles: (_draft) => [],
    getComposerUploadedFileSections: () => [],
    getDefaultTextForInputItems: () => 'inspect',
    buildComposerDisplayText: (text) => text,
    uploadComposerFiles: async (_session, draft) => {
      assert.strictEqual(draft.attachments[0].name, 'A-only.txt');
      await Promise.resolve();
      return [];
    },
  };
  vm.createContext(buildContext);
  vm.runInContext(extractFunction('buildComposerPayload'), buildContext, { filename: 'buildComposerPayload.js' });
  const immutablePayload = await buildContext.buildComposerPayload(
    sessionA,
    'immutable',
    {},
    { text: 'immutable', options: { model: 'model-from-A' }, attachments: [{ type: 'textFile', name: 'A-only.txt' }] }
  );
  assert.strictEqual(immutablePayload.model, 'model-from-A');
  assert.strictEqual(immutablePayload.inputItems[0].name, 'A-only.txt');

  assert(source.includes('attachHistoryMarkdown(session, exportOptions, composerSessionKey)'));
  assert(source.includes('addComposerFiles([fileFromBlob(blob, name, \'text/markdown\')], composerSessionKey)'));
  console.log('composer draft state tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
