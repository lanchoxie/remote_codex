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
    source.indexOf('\nconst TRANSCRIPT_TOMBSTONE_TTL_MS', start + 1),
    source.indexOf('\nconst SLASH_COMMANDS', start + 1),
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
    sentDraftSnapshotsBySession: new Map(),
    pendingComposerDraftsBySession: new Map(),
    composerSubmissionsBySession: new Map(),
    interruptOperationsBySession: new Map(),
    interruptBusyKeys: new Set(),
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
  SENT_DRAFT_SNAPSHOT_TTL_MS: 30 * 60 * 1000,
  SENT_DRAFT_SNAPSHOT_LIMIT: 32,
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
  appendAlertForSession: () => {},
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
  'pruneSentDraftSnapshots',
  'setSentDraftSnapshotForSessionKey',
  'getSentDraftSnapshotForSession',
  'markSentDraftSnapshotForInterrupt',
  'clearSentDraftSnapshotInterruptMarker',
  'clearSentDraftSnapshotForSessionRequest',
  'setActiveDraftForSessionKey',
  'clearActiveDraftForSessionRequest',
  'composerDraftContentIdentity',
  'clearComposerDraftIfMatching',
  'acknowledgeComposerSubmissionForSession',
  'stashPendingComposerDraftForSession',
  'restoreComposerDraft',
  'mergeComposerDraftsForRestore',
  'restoreSentDraftSnapshotForSession',
  'recoverComposerSubmissionForSession',
]) {
  vm.runInContext(extractFunction(name), context, { filename: `${name}.js` });
}

function resetComposer(session = sessionA) {
  for (const map of [
    state.codexControls.composerDraftsBySession,
    state.codexControls.composerSessionKeyAliases,
    state.codexControls.activeDraftsBySession,
    state.codexControls.sentDraftSnapshotsBySession,
    state.codexControls.pendingComposerDraftsBySession,
    state.codexControls.composerSubmissionsBySession,
    state.codexControls.interruptOperationsBySession,
    state.codexControls.recentSubmissions,
    state.codexControls.sessionOptionsByKey,
    state.codexControls.apiSwitchNoticesBySession,
    state.sessionRebindFailures,
  ]) map.clear();
  for (const set of [
    state.codexControls.persistedSessionOptionKeys,
    state.sessionApiRebindBusyKeys,
    state.sessionTranscriptFallbackBusyKeys,
    state.codexControls.interruptBusyKeys,
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
  const recentSignature = JSON.stringify({ sessionKey: keyA, text: 'pending canonical intent' });
  const inFlight = { id: 'submission-a', sessionKey: keyA, signature: recentSignature };
  state.codexControls.composerSubmissionsBySession.set(keyA, inFlight);
  state.codexControls.recentSubmissions.set(recentSignature, {
    id: inFlight.id,
    createdAtMs: Date.now(),
  });
  state.codexControls.sessionOptionsByKey.set(keyA, { model: 'provider-model', effort: '' });
  state.codexControls.persistedSessionOptionKeys.add(keyA);
  state.codexControls.apiSwitchNoticesBySession.set(keyA, { message: 'switching' });
  state.sessionApiRebindBusyKeys.add(keyA);
  state.sessionTranscriptFallbackBusyKeys.add(keyA);
  state.sessionRebindFailures.set(keyA, { code: 'previous-failure' });
  assert.strictEqual(context.moveComposerDraftSessionKey(keyA, canonicalKey), true);
  assert.strictEqual(context.resolveComposerSessionKey(keyA), canonicalKey);
  assert.strictEqual(inFlight.sessionKey, canonicalKey, 'canonical migration must update the live submission object');
  const migratedSignature = JSON.stringify({ sessionKey: canonicalKey, text: 'pending canonical intent' });
  assert.strictEqual(inFlight.signature, migratedSignature, 'canonical migration must update the in-flight intent signature');
  assert.strictEqual(
    state.codexControls.recentSubmissions.get(migratedSignature)?.id,
    inFlight.id,
    'a retry after bridge-to-native migration must reuse the original client request id'
  );
  assert.strictEqual(state.codexControls.recentSubmissions.has(recentSignature), false);
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
  context.completeComposerSubmissionForSession = (sessionKey, submissionId) => {
    context.clearComposerSubmissionForSession(sessionKey, submissionId);
    return true;
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
  assert.strictEqual(
    state.codexControls.composerSubmissionsBySession.get(keyA)?.stage,
    'queued',
    'an accepted direct send must remain locked until the Host acknowledges the turn'
  );
  assert.strictEqual(
    context.recoverComposerSubmissionForSession(sessionA, { clientRequestId: 'different-request' }),
    false,
    'an unrelated async failure must not restore another submission'
  );
  assert.strictEqual(
    context.recoverComposerSubmissionForSession(sessionA, { clientRequestId: 'submission-test' }),
    true,
    'the matching async input failure must restore its retained draft'
  );
  assert.strictEqual(input.value, 'send this');
  assert.strictEqual(context.el('codex-local-image-path').value, 'D:/images/send.png');
  assert.strictEqual(state.codexControls.attachments[0].fileObject, sendFile);
  assert(!state.codexControls.activeDraftsBySession.has(keyA));
  assert(!state.codexControls.composerSubmissionsBySession.has(keyA));

  input = resetComposer();
  mountDraft(sessionA, {
    text: 'host ack races http',
    selectionStart: 4,
    selectionEnd: 4,
    attachments: [],
    localImagePath: '',
  });
  context.submitComposerPayload = async () => {
    context.acknowledgeComposerSubmissionForSession(sessionA, 'submission-test', {
      stage: 'starting',
      turnActive: true,
    });
    return { accepted: true, trackActiveDraft: true };
  };
  await context.submitComposerInput(input);
  assert.strictEqual(
    state.codexControls.composerSubmissionsBySession.has(keyA),
    false,
    'an SSE Host acknowledgement received before HTTP completion must not be reinserted as queued'
  );
  assert.strictEqual(
    state.codexControls.activeDraftsBySession.has(keyA),
    false,
    'an already acknowledged submission must not retain a false pending draft'
  );
  assert.strictEqual(
    state.codexControls.sentDraftSnapshotsBySession.get(keyA)?.text,
    'host ack races http',
    'turn acknowledgement must retain an isolated sent-draft snapshot for Interrupt recovery'
  );
  input.value = 'new local draft';
  context.rememberMountedComposerDraft();
  assert.strictEqual(
    context.restoreSentDraftSnapshotForSession(sessionA, 'submission-test'),
    true
  );
  assert.strictEqual(
    input.value,
    'new local draft\n\nhost ack races http',
    'Interrupt recovery must append without overwriting a newer per-Session draft'
  );
  assert.strictEqual(state.codexControls.sentDraftSnapshotsBySession.has(keyA), false);

  input = resetComposer();
  mountDraft(sessionA, {
    text: 'restore before late http',
    selectionStart: 7,
    selectionEnd: 7,
    attachments: [],
    localImagePath: '',
  });
  context.submitComposerPayload = async () => {
    assert.strictEqual(
      context.recoverComposerSubmissionForSession(sessionA, { clientRequestId: 'submission-test' }),
      true,
      'a matching Host rejection should restore the retained request draft'
    );
    return { accepted: true, trackActiveDraft: true };
  };
  await context.submitComposerInput(input);
  assert.strictEqual(
    input.value,
    'restore before late http',
    'a late HTTP success must not clear a draft already restored by command_failed'
  );
  assert(!state.codexControls.composerSubmissionsBySession.has(keyA));
  assert(!state.codexControls.activeDraftsBySession.has(keyA));

  input = resetComposer();
  mountDraft(sessionA, {
    text: 'uncertain delivery',
    selectionStart: 5,
    selectionEnd: 5,
    attachments: [],
    localImagePath: '',
  });
  context.submitComposerPayload = async () => {
    const error = new Error('response was lost');
    error.inputAcceptanceUnknown = true;
    throw error;
  };
  await context.submitComposerInput(input);
  assert.strictEqual(input.value, '', 'an uncertain delivery should not duplicate the prompt in the visible composer');
  assert.strictEqual(
    state.codexControls.composerSubmissionsBySession.get(keyA)?.stage,
    'confirming',
    'an uncertain delivery must stay locked while matching Relay or Host confirmation is pending'
  );
  assert.strictEqual(state.codexControls.activeDraftsBySession.get(keyA)?.text, 'uncertain delivery');
  assert.strictEqual(
    context.recoverComposerSubmissionForSession(sessionA, { clientRequestId: 'submission-test' }),
    true,
    'only an explicit matching failure should restore an uncertain prompt'
  );
  assert.strictEqual(input.value, 'uncertain delivery');

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
  const rejectedFile = new dom.window.File(['rejected'], 'rejected.txt', { type: 'text/plain' });
  mountDraft(sessionA, {
    text: 'restore rejected submission',
    selectionStart: 4,
    selectionEnd: 19,
    localImagePath: 'D:/images/rejected.png',
    attachments: [{
      type: 'uploadFile',
      fileId: 'rejected-file',
      fileObject: rejectedFile,
      name: rejectedFile.name,
      mime: rejectedFile.type,
      size: rejectedFile.size,
    }],
  });
  context.submitComposerPayload = async () => ({ accepted: false, trackActiveDraft: false });
  await context.submitComposerInput(input);
  assert.strictEqual(input.value, 'restore rejected submission', 'an explicit non-acceptance must restore the text');
  assert.strictEqual(input.selectionStart, 4, 'an explicit non-acceptance must restore the selection start');
  assert.strictEqual(input.selectionEnd, 19, 'an explicit non-acceptance must restore the selection end');
  assert.strictEqual(
    context.el('codex-local-image-path').value,
    'D:/images/rejected.png',
    'an explicit non-acceptance must restore the local image path'
  );
  assert.strictEqual(state.codexControls.attachments.length, 1);
  assert.strictEqual(
    state.codexControls.attachments[0].fileObject,
    rejectedFile,
    'an explicit non-acceptance must retain the original local File reference'
  );
  assert.strictEqual(
    state.codexControls.attachments[0].fileId,
    'rejected-file',
    'an explicit non-acceptance must retain attachment identity'
  );
  assert.strictEqual(
    state.codexControls.composerSubmissionsBySession.has(keyA),
    false,
    'an explicitly rejected submission must release its request lock'
  );
  assert.strictEqual(state.codexControls.activeDraftsBySession.has(keyA), false);
  assert.strictEqual(state.codexControls.sentDraftSnapshotsBySession.has(keyA), false);

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

  let requestSequence = 0;
  const requestIdContext = vm.createContext({
    state: { codexControls: { recentSubmissions: new Map() } },
    COMPOSER_RECENT_SUBMISSION_TTL_MS: 2 * 60 * 1000,
    makeClientId: () => `request-${++requestSequence}`,
  });
  vm.runInContext(extractFunction('pruneRecentComposerSubmissions'), requestIdContext);
  vm.runInContext(extractFunction('getOrCreateComposerSubmissionId'), requestIdContext);
  const firstRequestId = requestIdContext.getOrCreateComposerSubmissionId('same-content');
  const secondRequestId = requestIdContext.getOrCreateComposerSubmissionId('same-content');
  assert.notStrictEqual(
    firstRequestId,
    secondRequestId,
    'two independent clicks with identical text must receive different client request IDs'
  );

  const postedBodies = [];
  let postAttempt = 0;
  const retryContext = vm.createContext({
    getActiveTurnBlocker: () => null,
    openStatusForActiveTurnBlocker: () => {},
    assertModelSelectionIsSelectable: () => {},
    assertEffortSelectionIsValid: () => {},
    delay: async () => {},
    fetchJson: async (_url, options) => {
      postedBodies.push(options.body);
      postAttempt += 1;
      if (postAttempt === 1) {
        const error = new Error('timed out');
        error.code = 'request_timeout';
        throw error;
      }
      return { ok: true };
    },
  });
  vm.runInContext(extractFunction('sendInputToSession'), retryContext);
  await retryContext.sendInputToSession(sessionA, 'retry exactly once', {
    clientRequestId: 'stable-request-id',
  });
  assert.strictEqual(postedBodies.length, 2, 'an ambiguous POST should be retried once');
  assert.strictEqual(postedBodies[0], postedBodies[1], 'the retry must reuse the exact request body and clientRequestId');
  assert.strictEqual(JSON.parse(postedBodies[1]).clientRequestId, 'stable-request-id');

  const transcriptContext = vm.createContext({
    state: {
      transcripts: new Map(),
      transcriptTombstones: new Map(),
      codexControls: {
        composerSubmissionsBySession: new Map(),
        activeDraftsBySession: new Map(),
        sentDraftSnapshotsBySession: new Map(),
      },
    },
    Map,
    Date,
    TRANSCRIPT_TOMBSTONE_TTL_MS: 10 * 60 * 1000,
    TRANSCRIPT_TOMBSTONE_LIMIT: 64,
    OPTIMISTIC_TRANSCRIPT_GRACE_MS: 30 * 1000,
    makeSessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
    resolveComposerSessionKey: (sessionOrKey) => typeof sessionOrKey === 'string'
      ? sessionOrKey
      : `${sessionOrKey.hostId}::${sessionOrKey.sessionId}`,
    runtimeIsActive: (runtime) => Boolean(runtime?.activeTurnId || runtime?.busy || runtime?.phase === 'queued-turn'),
    dedupeTranscript: (entries) => entries.map((entry) => ({ ...entry })),
  });
  for (const name of [
    'pruneTranscriptTombstones',
    'transcriptEntryIsTombstoned',
    'removeTranscriptEntry',
    'setTranscriptForSession',
    'appendTranscriptEntry',
    'composerTracksTranscriptRequest',
    'reconcileDetailTranscriptForSession',
  ]) {
    vm.runInContext(extractFunction(name), transcriptContext, { filename: `${name}.js` });
  }
  const rejectedEcho = {
    speaker: 'user',
    text: 'identical prompt',
    clientRequestId: 'request-rejected',
  };
  const acceptedEcho = {
    speaker: 'user',
    text: 'identical prompt',
    clientRequestId: 'request-accepted',
  };
  transcriptContext.setTranscriptForSession('host-a', 'session-a', [rejectedEcho, acceptedEcho]);
  assert.strictEqual(
    transcriptContext.removeTranscriptEntry('host-a', 'session-a', rejectedEcho),
    true
  );
  assert.deepStrictEqual(
    Array.from(transcriptContext.state.transcripts.get(keyA), (entry) => entry.clientRequestId),
    ['request-accepted'],
    'transcript removal must target request identity, not equal text'
  );
  transcriptContext.setTranscriptForSession('host-a', 'session-a', [rejectedEcho, acceptedEcho]);
  assert.deepStrictEqual(
    Array.from(transcriptContext.state.transcripts.get(keyA), (entry) => entry.clientRequestId),
    ['request-accepted'],
    'an in-flight detail response must not resurrect a tombstoned prompt'
  );
  assert.strictEqual(
    transcriptContext.appendTranscriptEntry('host-a', 'session-a', rejectedEcho),
    false,
    'a late transcript event must respect the same tombstone'
  );

  const pendingTimestamp = '2026-07-27T12:00:00.000Z';
  const optimisticPending = {
    speaker: 'user',
    text: 'pending prompt',
    clientRequestId: 'request-pending',
    deliveryStatus: 'pending',
    timestamp: pendingTimestamp,
  };
  transcriptContext.state.codexControls.composerSubmissionsBySession.set(keyA, {
    id: optimisticPending.clientRequestId,
  });
  const retainedPending = transcriptContext.reconcileDetailTranscriptForSession(
    'host-a',
    'session-a',
    [],
    [optimisticPending],
    {
      authoritative: true,
      runtime: { phase: 'queued-turn', busy: true, clientRequestId: optimisticPending.clientRequestId },
      nowMs: Date.parse(pendingTimestamp) + 1000,
    }
  );
  assert.strictEqual(retainedPending.length, 1, 'a fresh locally tracked prompt must survive a racing full detail');
  const removedRejectedPending = transcriptContext.reconcileDetailTranscriptForSession(
    'host-a',
    'session-a',
    [],
    [optimisticPending],
    {
      authoritative: true,
      runtime: { phase: 'thinking', busy: true, clientRequestId: 'different-request' },
      nowMs: Date.parse(pendingTimestamp) + 1000,
    }
  );
  assert.strictEqual(removedRejectedPending.length, 0, 'authoritative detail must remove an untracked rejected echo');
  const acceptedServerEntry = { ...optimisticPending, deliveryStatus: 'accepted' };
  const serverWins = transcriptContext.reconcileDetailTranscriptForSession(
    'host-a',
    'session-a',
    [acceptedServerEntry],
    [optimisticPending],
    { authoritative: true, runtime: {} }
  );
  assert.strictEqual(serverWins.length, 1);
  assert.strictEqual(serverWins[0].deliveryStatus, 'accepted', 'server delivery status must beat the local optimistic copy');

  const interruptRuntime = new Map([[keyA, {
    phase: 'interrupting',
    busy: true,
    activeTurnId: 'turn-a',
  }]]);
  let interruptCleanupCount = 0;
  const interruptContext = vm.createContext({
    state: {
      sessions: [sessionA],
      codexControls: {
        interruptOperationsBySession: new Map([[keyA, {
          interruptRequestId: 'interrupt-a',
          status: 'queued',
          pending: true,
          restoreDraft: false,
        }]]),
        interruptBusyKeys: new Set([keyA]),
      },
    },
    Date,
    resolveComposerSessionKey: (sessionOrKey) => typeof sessionOrKey === 'string'
      ? sessionOrKey
      : `${sessionOrKey.hostId}::${sessionOrKey.sessionId}`,
    findSessionForResolvedComposerKey: () => sessionA,
    getRuntimeForSession: () => interruptRuntime.get(keyA),
    runtimeIsActive: (runtime) => Boolean(runtime?.activeTurnId || runtime?.busy),
    clearSentDraftSnapshotInterruptMarker: () => true,
    restoreSentDraftSnapshotForSession: () => false,
    restoreSentDraftAfterInterrupt: async () => {},
    scheduleInterruptOperationCleanup: () => { interruptCleanupCount += 1; },
    renderComposerControls: () => {},
    renderComposerTurnNotice: () => {},
  });
  vm.runInContext(extractFunction('getInterruptOperation'), interruptContext);
  vm.runInContext(extractFunction('applySessionInterruptResult'), interruptContext);
  vm.runInContext(extractFunction('settlePendingInterruptFromInactiveRuntime'), interruptContext);
  assert.strictEqual(interruptContext.applySessionInterruptResult(sessionA, {
    interruptRequestId: 'interrupt-a',
    status: 'accepted',
  }), true);
  assert.strictEqual(
    interruptContext.state.codexControls.interruptOperationsBySession.get(keyA).pending,
    true,
    'Host accepted must remain locked while the matching runtime is active'
  );
  assert.strictEqual(interruptContext.state.codexControls.interruptBusyKeys.has(keyA), true);
  interruptRuntime.set(keyA, { phase: 'idle', busy: false, activeTurnId: null });
  assert.strictEqual(
    interruptContext.settlePendingInterruptFromInactiveRuntime(sessionA, interruptRuntime.get(keyA)),
    true
  );
  assert.strictEqual(interruptContext.state.codexControls.interruptBusyKeys.has(keyA), false);
  assert.strictEqual(interruptCleanupCount, 1, 'inactive runtime must settle and schedule cleanup exactly once');

  assert(source.includes('attachHistoryMarkdown(session, exportOptions, composerSessionKey)'));
  assert(source.includes('addComposerFiles([fileFromBlob(blob, name, \'text/markdown\')], composerSessionKey)'));
  console.log('composer draft state tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
