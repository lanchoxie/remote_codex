const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'mobile-web', 'public', 'app.js'),
  'utf8'
);
const transcriptState = require('../apps/mobile-web/public/transcript-state.js');

function functionSource(name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const match = pattern.exec(app);
  assert(match, `${name} missing from app.js`);
  const start = match.index;
  const signatureEnd = app.indexOf(') {', start);
  assert(signatureEnd >= 0, `${name} signature is missing its body`);
  const open = signatureEnd + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < app.length; index += 1) {
    const char = app[index];
    const next = app[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body is unbalanced`);
}

function loadFunctions(names, globals = {}) {
  const context = vm.createContext({
    console,
    Map,
    Set,
    URLSearchParams,
    ...globals,
  });
  const source = names.map(functionSource).join('\n');
  const exports = names.map((name) => `${name}: ${name}`).join(',');
  return vm.runInContext(`${source}\n({ ${exports} })`, context);
}

function sessionKey(session) {
  return session?.hostId && session?.sessionId
    ? `${session.hostId}::${session.sessionId}`
    : '';
}

function testSessionAsyncFenceIdentity() {
  const oldSource = {};
  const replacementSource = {};
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  let selected = session;
  const state = {
    eventSource: oldSource,
    sessionStreamGeneration: 4,
  };
  const helpers = loadFunctions([
    'createSessionAsyncFence',
    'assertSessionAsyncFenceCurrent',
  ], {
    state,
    getSessionKey: sessionKey,
    getSelectedSession: () => selected,
  });

  const fence = helpers.createSessionAsyncFence(session, {
    source: oldSource,
    streamGeneration: 4,
  });
  assert.strictEqual(fence.isCurrent(), true);
  selected = { hostId: 'host-a', sessionId: 'session-b' };
  assert.strictEqual(fence.isCurrent(), false, 'selection replacement must invalidate detail work');
  fence.allowSession(selected);
  assert.strictEqual(fence.isCurrent(), true, 'an explicitly adopted bridge Session key stays valid');
  state.eventSource = replacementSource;
  state.sessionStreamGeneration = 5;
  assert.strictEqual(fence.isCurrent(), false, 'source/generation replacement must invalidate the fence');
  assert.throws(
    () => helpers.assertSessionAsyncFenceCurrent(fence),
    (error) => error?.code === 'stream_recovery_stale'
  );

  state.eventSource = replacementSource;
  state.sessionStreamGeneration = 9;
  selected = session;
  const normalSelectionFence = helpers.createSessionAsyncFence(session);
  assert.strictEqual(normalSelectionFence.isCurrent(), true);
  selected = { hostId: 'host-a', sessionId: 'session-c' };
  assert.strictEqual(
    normalSelectionFence.isCurrent(),
    false,
    'a normal selection fence must reject work after the user selects another Session'
  );
  selected = session;
  state.sessionStreamGeneration = 10;
  assert.strictEqual(
    normalSelectionFence.isCurrent(),
    false,
    'a normal selection fence must reject work after the stream generation changes'
  );
}

async function testStaleAssistantProjectionCannotApply() {
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  const oldSource = {};
  let resolvePage;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const state = {
    eventSource: oldSource,
    sessionStreamGeneration: 7,
    messageProjectionRequests: new Map(),
  };
  const writes = {
    seed: 0,
    authoritative: 0,
    coverage: 0,
    receipt: 0,
  };
  const normalizeProjection = (value = {}) => ({
    canonicalConversationKey: value.canonicalConversationKey || 'host-a::conversation-a',
    projectionRevision: Number(value.projectionRevision || 1),
    latestAssistantSeq: Number(value.latestAssistantSeq || 0),
    messages: Array.isArray(value.messages) ? value.messages : [],
    cursorUnknown: value.cursorUnknown === true,
    hasMore: value.hasMore === true,
    nextAfterSeq: Number(value.nextAfterSeq || 0),
  });
  const helpers = loadFunctions([
    'createSessionAsyncFence',
    'assertSessionAsyncFenceCurrent',
    'isStaleStreamRecoveryError',
    'catchUpAssistantProjection',
  ], {
    state,
    getSessionKey: sessionKey,
    getSelectedSession: () => session,
    ASSISTANT_PROJECTION_MAX_RESTARTS: 3,
    ASSISTANT_PROJECTION_PAGE_LIMIT: 100,
    normalizeAssistantProjection: normalizeProjection,
    rememberAssistantProjection: (_session, projection) => {
      writes.seed += 1;
      return normalizeProjection(projection);
    },
    rememberAuthoritativeAssistantProjection: (_session, projection) => {
      writes.authoritative += 1;
      return normalizeProjection(projection);
    },
    rememberAssistantProjectionCoverage: () => { writes.coverage += 1; },
    assistantProjectionCoverageFor: () => null,
    assistantProjectionUnreadReconciliationAfter: () => null,
    assistantProjectionFetchStart: () => 0,
    getAssistantProjectionForSession: () => null,
    mergeAssistantProjection: (_current, incoming) => normalizeProjection(incoming),
    finishAssistantProjectionCatchUp: () => { throw new Error('unexpected no-fetch path'); },
    applyAssistantProjectionForSession: () => {
      writes.receipt += 1;
      return { projection: null };
    },
    fetchJson: () => {
      markFetchStarted();
      return new Promise((resolve) => { resolvePage = resolve; });
    },
  });

  const isCurrent = () => (
    state.eventSource === oldSource
    && state.sessionStreamGeneration === 7
  );
  const request = helpers.catchUpAssistantProjection(session, {
    canonicalConversationKey: 'host-a::conversation-a',
    projectionRevision: 1,
    latestAssistantSeq: 1,
    messages: [],
    hasMore: true,
  }, { force: true, isCurrent });
  await fetchStarted;
  assert.strictEqual(writes.seed, 1, 'the current event may seed its projection before awaiting');
  state.eventSource = {};
  state.sessionStreamGeneration = 8;
  resolvePage({
    canonicalConversationKey: 'host-a::conversation-a',
    projectionRevision: 1,
    latestAssistantSeq: 1,
    messages: [{ assistantMessageId: 'assistant-old', assistantSeq: 1 }],
    hasMore: false,
  });
  await assert.rejects(request, (error) => error?.code === 'stream_recovery_stale');
  assert.deepStrictEqual(
    writes,
    { seed: 1, authoritative: 0, coverage: 0, receipt: 0 },
    'a replaced source must not apply a late projection page or receipt state'
  );
}

async function testStaleReceivedFilesCannotApply() {
  const session = { hostId: 'host-a', sessionId: 'session-files' };
  const state = {
    receivedFiles: new Map(),
    receivedFilesLoadingKeys: new Set(),
    receivedFilesLoadingTokens: new Map(),
    receivedFilesLoadingPromises: new Map(),
  };
  const writes = [];
  let oldRequestCurrent = true;
  const fetchResolvers = [];
  let markFirstFetchStarted;
  let markSecondFetchStarted;
  const firstFetchStarted = new Promise((resolve) => { markFirstFetchStarted = resolve; });
  const secondFetchStarted = new Promise((resolve) => { markSecondFetchStarted = resolve; });
  const helpers = loadFunctions([
    'assertStreamRecoveryCurrent',
    'isStaleStreamRecoveryError',
    'loadReceivedFilesForSession',
  ], {
    state,
    getSessionKey: sessionKey,
    fetchJson: () => {
      const requestNumber = fetchResolvers.length + 1;
      if (requestNumber === 1) markFirstFetchStarted();
      if (requestNumber === 2) markSecondFetchStarted();
      return new Promise((resolve) => { fetchResolvers.push(resolve); });
    },
    setReceivedFilesForSession: (hostId, sessionId, files) => {
      writes.push({ hostId, sessionId, files });
      state.receivedFiles.set(`${hostId}::${sessionId}`, files);
    },
    getReceivedFilesForSession: (value) => state.receivedFiles.get(sessionKey(value)) || [],
    renderStatusWindow: () => {},
  });
  const staleRequest = helpers.loadReceivedFilesForSession(session, {
    isCurrent: () => oldRequestCurrent,
  });
  await firstFetchStarted;
  oldRequestCurrent = false;

  // A new selection of the same Session must wait for the stale request and
  // retry after its guarded write is rejected. It must not return an empty
  // cache just because the old request still owns the loading marker.
  const currentRequest = helpers.loadReceivedFilesForSession(session, {
    isCurrent: () => true,
  });
  fetchResolvers[0]({ files: [{ id: 'late-file' }] });
  await assert.rejects(staleRequest, (error) => error?.code === 'stream_recovery_stale');
  await secondFetchStarted;
  assert.deepStrictEqual(writes, [], 'a stale received-files response must not write the cache');
  fetchResolvers[1]({ files: [{ id: 'current-file' }] });
  assert.deepStrictEqual(await currentRequest, [{ id: 'current-file' }]);
  assert.deepStrictEqual(writes, [{
    hostId: 'host-a',
    sessionId: 'session-files',
    files: [{ id: 'current-file' }],
  }]);
  assert.strictEqual(state.receivedFilesLoadingKeys.size, 0);
  assert.strictEqual(state.receivedFilesLoadingPromises.size, 0);
}

function testRequestGenerationAndDetailCas() {
  const state = {
    requests: new Map(),
    requestApplyGenerations: new Map(),
    codexControls: {
      inputAnswersByRequest: new Map(),
      respondingRequestKeys: new Set(),
    },
  };
  const helpers = loadFunctions([
    'getRequestApplyGeneration',
    'advanceRequestApplyGeneration',
    'setRequestsForSession',
    'upsertRequestForSession',
  ], {
    state,
    makeSessionKey: (hostId, sessionId) => `${hostId}::${sessionId}`,
    sessionRequestResponseKey: (_session, request) => request?.requestId || '',
  });
  helpers.setRequestsForSession('host-a', 'session-a', [{
    requestId: 'approval-a',
    status: 'pending',
  }]);
  const detailBaseline = helpers.getRequestApplyGeneration('host-a', 'session-a');
  helpers.upsertRequestForSession('host-a', 'session-a', {
    requestId: 'approval-a',
    status: 'resolved',
  });
  assert(
    helpers.getRequestApplyGeneration('host-a', 'session-a') > detailBaseline,
    'resolving a request must advance the detail replacement generation'
  );

  const showSession = functionSource('showSession');
  const detailAwait = showSession.indexOf('const detail = await fetchSharedSessionDetail');
  const fenceAfterAwait = showSession.indexOf(
    'assertSessionAsyncFenceCurrent(asyncFence);',
    detailAwait
  );
  const firstDetailWrite = showSession.indexOf('mergeSession(detail.session)', detailAwait);
  assert(detailAwait >= 0 && fenceAfterAwait > detailAwait && firstDetailWrite > fenceAfterAwait);
  assert(
    showSession.includes('getRequestApplyGeneration(detailHostId, detailSessionId) === detailRequestApplyGeneration')
      && showSession.includes('if (detailRequestsCanApply) {'),
    'detail requests must be replaced only when no newer request event was applied'
  );

  const subscribeIndex = showSession.indexOf('subscribeSession(session);');
  const normalFenceIndex = showSession.indexOf(
    'asyncFence = createSessionAsyncFence(session, {',
    subscribeIndex
  );
  assert(
    subscribeIndex >= 0 && normalFenceIndex > subscribeIndex,
    'normal selection work must capture its stream generation after subscribeSession advances it'
  );
  const filesLoadIndex = showSession.indexOf('loadReceivedFilesForSession(detailSession, { isCurrent: asyncFence?.isCurrent }).then');
  const filesFenceIndex = showSession.indexOf(
    'assertSessionAsyncFenceCurrent(asyncFence);',
    filesLoadIndex
  );
  const filesRenderIndex = showSession.indexOf('renderTranscript(selected', filesLoadIndex);
  assert(
    filesLoadIndex >= 0 && filesFenceIndex > filesLoadIndex && filesRenderIndex > filesFenceIndex,
    'received-file completion must recheck the Session fence before rendering'
  );
  assert(
    showSession.includes('if (!isStaleStreamRecoveryError(error)) reportError(error);'),
    'stale received-file completions must not create a UI error'
  );
  const filesHelper = functionSource('loadReceivedFilesForSession');
  assert(
    filesHelper.includes('assertStreamRecoveryCurrent(isCurrent);')
      && filesHelper.includes('setReceivedFilesForSession(session.hostId, session.sessionId, response.files || []);'),
    'received-file cache writes must be fenced after the fetch settles'
  );
}

function testDuplicateActivityIsSuccessfulNoop() {
  const canonicalKey = 'host-a::conversation-a';
  const projection = transcriptState.createTranscriptActivityProjection();
  projection.applyActivity(canonicalKey, {
    streamEpoch: 'epoch-a',
    activityKey: 'activity-a',
    activityRevision: 2,
    kind: 'reasoning',
    text: 'newer',
  });
  let commits = 0;
  const helpers = loadFunctions(['applyActivityEvent'], {
    state: { activityProjection: projection },
    sessionStreamEventCanonicalKey: () => canonicalKey,
    rememberActivityClientRequestIds: () => {},
    commitSessionStreamEvent: () => { commits += 1; return canonicalKey; },
    patchProjectedThinkingActivity: () => true,
    getSelectedSession: () => null,
    getActivityCanonicalKeyForSession: () => canonicalKey,
    scheduleTranscriptRender: () => {},
  });
  const session = { hostId: 'host-a', sessionId: 'session-a' };
  assert.strictEqual(helpers.applyActivityEvent(session, {}, {
    streamEpoch: 'epoch-a',
    activityKey: 'activity-a',
    activityRevision: 1,
    kind: 'reasoning',
    text: 'older duplicate',
  }), true, 'an older revision in the current epoch is a valid consumed event');
  assert.strictEqual(commits, 1);
  assert.strictEqual(projection.activitiesFor(canonicalKey)[0].text, 'newer');

  assert.strictEqual(helpers.applyActivityEvent(session, {}, {
    streamEpoch: 'epoch-b',
    activityKey: 'activity-a',
    activityRevision: 1,
    kind: 'reasoning',
    text: 'wrong epoch',
  }), false, 'an epoch mismatch remains a stream application failure');
  assert.strictEqual(commits, 1);
}

async function main() {
  testSessionAsyncFenceIdentity();
  await testStaleAssistantProjectionCannotApply();
  await testStaleReceivedFilesCannotApply();
  testRequestGenerationAndDetailCas();
  testDuplicateActivityIsSuccessfulNoop();
  console.log('session async fencing assertions passed');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
