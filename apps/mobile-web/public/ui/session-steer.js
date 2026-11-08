(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexSessionSteer = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const copy = {
    en: {
      target: 'Guide needs the current live run and active turn. Refresh the Session and try again.',
      textOnly: 'Guide accepts text only. Keep attachments in the queue or use Interrupt & Send.',
      queued: 'Waiting for the Host acknowledgement', accepted: 'Guided', rejected: 'Guide rejected',
      acceptance_unknown: 'Guide result unknown. The text is retained; check the result before sending it again.',
      check: 'Check result', guide: 'Guide', queue: 'Pending queue', waiting: 'Waiting', sending: 'Sending',
      failed: 'Failed', interrupting: 'Interrupting', force: 'Interrupt & Send', first: 'Interrupt & Send First',
      remove: 'Remove', edit: 'Edit this waiting prompt…',
      hint: 'Queued prompts send in order. Guide adds text to the active turn; only a matching Host acknowledgement confirms it.',
      capacity: 'Too many Guide operations in this page. No new Guide was sent.',
      inputUnknown: 'Delivery is unconfirmed. The original request and text are retained.',
      retryInput: 'Retry same request',
      restored: 'Some queued messages were restored after reload. Local browser attachments need to be selected again.',
      restoreWarning: 'The saved queue could not be read. Messages created in this page remain available.',
      persistWarning: 'The queue could not be saved in this browser. It remains in memory for this page.',
    },
    'zh-CN': {
      target: '引导需要当前运行和活动轮次。请刷新会话后重试。',
      textOnly: '引导只支持纯文本。附件请保留在队列，或使用“打断并发送”。',
      queued: '等待 Host 确认引导', accepted: '已引导', rejected: '引导被拒绝',
      acceptance_unknown: '引导结果尚不确定。文字已保留，请先查询结果，不要重复发送。',
      check: '查询结果', guide: '引导', queue: '待发送队列', waiting: '等待发送', sending: '发送中',
      failed: '失败', interrupting: '打断中', force: '打断并发送', first: '打断并发送第一条',
      remove: '移除', edit: '编辑待发送的消息…',
      hint: '消息按顺序排队。引导将文字加入当前轮次，收到匹配的 Host 回执后才显示已引导。',
      capacity: '本页面的引导操作已达上限，未发送新的引导。',
      inputUnknown: '发送结果待确认，原始请求和文字已保留。',
      retryInput: '重试原请求',
      restored: '刷新后已恢复部分排队消息；浏览器本地附件需要重新选择。',
      restoreWarning: '已保存的队列无法读取，本页面新建的消息仍会保留。',
      persistWarning: '队列无法保存到当前浏览器，但仍会保留在本页面内存中。',
    },
  };
  const words = (locale) => copy[locale === 'en' ? 'en' : 'zh-CN'];
  function textOnly(payload = {}) {
    return !['inputItems', 'uploadedFiles', 'inlineFiles'].some((key) => payload[key]?.length)
      && !payload.composerDraft?.attachments?.length
      && !payload.composerDraft?.localImagePath
      && (!payload.text || payload.text.trim() === String(payload.composerDraft?.text ?? payload.displayText ?? payload.text).trim());
  }
  function createClient({ request, makeId, onChange = () => {}, schedule = setTimeout, cancel = clearTimeout, pollLimit = 30 }) {
    const operations = new Map();
    function create(target) {
      if (operations.size >= 4096) throw new Error('Guide operation capacity reached.');
      if (!['hostId', 'sessionId', 'runId', 'expectedTurnId', 'text'].every((key) => typeof target[key] === 'string' && target[key].trim())) {
        throw new Error('A complete Guide target and text are required.');
      }
      const op = { target: Object.freeze({ ...target, requestId: makeId() }), status: 'queued', commandId: null, posted: false, checks: 0, timer: null };
      operations.set(op.target.requestId, op);
      return op;
    }
    function restore(value) {
      const target = value?.target || value;
      if (!target || !['hostId', 'sessionId', 'runId', 'expectedTurnId', 'requestId', 'text'].every((key) => typeof target[key] === 'string' && target[key].trim())) {
        return null;
      }
      if (operations.has(target.requestId)) return operations.get(target.requestId);
      const op = {
        target: Object.freeze({
          hostId: target.hostId, sessionId: target.sessionId, runId: target.runId,
          expectedTurnId: target.expectedTurnId, requestId: target.requestId, text: target.text,
        }),
        status: ['queued', 'acceptance_unknown'].includes(value.status) ? value.status : 'acceptance_unknown',
        commandId: Number.isSafeInteger(value.commandId) ? value.commandId : null,
        posted: true, checks: Number.isSafeInteger(value.checks) ? value.checks : 0,
        timer: null, checking: false, nativeUnknown: value.nativeUnknown === true,
        error: value.error || '', canonicalSessionId: value.canonicalSessionId || null,
      };
      operations.set(op.target.requestId, op);
      return op;
    }
    function matches(op, value, fromLookup) {
      return ['hostId', 'runId', 'expectedTurnId', 'requestId'].every((key) => op.target[key] === value?.[key])
        && typeof value.sessionId === 'string' && Boolean(value.sessionId)
        && (fromLookup || (op.canonicalSessionId || op.target.sessionId) === value.sessionId)
        && Number.isSafeInteger(value?.commandId) && value.commandId > 0
        && (op.commandId == null || op.commandId === value.commandId);
    }
    function stop(op) { if (op.timer != null) cancel(op.timer); op.timer = null; }
    function apply(value, fromLookup = false) {
      const op = operations.get(value?.requestId);
      if (!op || !matches(op, value, fromLookup) || !['queued', 'accepted', 'rejected', 'acceptance_unknown'].includes(value.status)) return false;
      if (value.status === 'accepted' && value.turnId !== op.target.expectedTurnId) return false;
      if (['accepted', 'rejected'].includes(op.status) || op.nativeUnknown) return true;
      op.commandId = value.commandId;
      // Only the response to this operation's exact HTTP URL can resolve a
      // Session alias. Unsolicited SSE cannot change the accepted Session ID.
      if (fromLookup) op.canonicalSessionId = value.sessionId;
      if (value.status === 'queued' && op.status === 'acceptance_unknown') return true;
      op.status = value.status;
      op.error = value.error || '';
      op.nativeUnknown = value.status === 'acceptance_unknown';
      if (op.status !== 'queued') stop(op);
      onChange(op);
      return true;
    }
    function unknown(op) {
      if (op.status !== 'queued') return;
      op.status = 'acceptance_unknown';
      stop(op);
      onChange(op);
    }
    function plan(op) {
      if (op.timer != null || op.status !== 'queued') return;
      if (op.checks >= pollLimit) { unknown(op); return; }
      op.timer = schedule(() => { op.timer = null; void check(op); }, 1000);
    }
    async function check(op) {
      if (op.checking) return op;
      op.checking = true;
      op.checks += 1;
      try {
        const t = op.target;
        const result = await request(`/api/sessions/${encodeURIComponent(t.sessionId)}/steer/${encodeURIComponent(t.requestId)}?hostId=${encodeURIComponent(t.hostId)}`, { timeoutMs: 5000 });
        apply(result, true);
      } catch (_) {
        // A missing record after Relay restart cannot establish non-delivery.
        // Query only; never POST again or create a replacement turn.
      } finally {
        op.checking = false;
        plan(op);
      }
      return op;
    }
    async function submit(op) {
      if (op.posted) return check(op);
      op.posted = true;
      onChange(op);
      const t = op.target;
      try {
        const result = await request(`/api/sessions/${encodeURIComponent(t.sessionId)}/steer`, {
          method: 'POST', timeoutMs: 10000,
          body: JSON.stringify({ hostId: t.hostId, requestId: t.requestId, expectedRunId: t.runId, expectedTurnId: t.expectedTurnId, text: t.text }),
        });
        if (!apply(result, true)) unknown(op);
      } catch (error) {
        if (op.status === 'queued' && [400, 401, 403, 404, 409, 422, 429].includes(error?.status)) {
          op.status = 'rejected'; op.error = error.message || ''; onChange(op);
        }
        // Transport/5xx errors can follow dispatch: keep the same operation.
      }
      plan(op);
      return op;
    }
    return Object.freeze({ create, restore, submit, check, apply });
  }
  return Object.freeze({ createClient, textOnly, words });
}));
