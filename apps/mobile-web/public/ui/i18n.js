(function initNavigationI18n(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RemoteCodexNavigationI18n = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  // Pure presentation helpers: no DOM, storage, requests, or application state.
  const TEXT = {
    en: {
      'navSearch.keyword': 'Keyword',
      'navSearch.path': 'Path',
      'navSearch.title': 'Title',
      'navSearch.updatedAt': 'Recently updated',
      'navSearch.createdAt': 'Created time',
      'navSearch.messageCount': 'Message count',
      'navSearch.asc': 'Asc',
      'navSearch.desc': 'Desc',
      'navSearch.ascHint': 'Oldest or smallest first',
      'navSearch.descHint': 'Newest or largest first',
      'navSearch.clear': 'Clear search',
      'navSearch.placeholder': 'Search conversations...',
      'navSearch.previous': 'Previous match',
      'navSearch.next': 'Next match',
      'navSearch.searchMode': 'Search mode',
      'navSearch.sortMode': 'Sort conversations',
      'navSearch.toggleDirection': 'Toggle sort direction',
      'navSearch.online': 'online',
      'navSearch.offline': 'offline',
      'navSearch.noHosts': 'No hosts available',
      'navSearch.selectHost': 'Select host',
      'navSearch.checkingHost': 'Checking host...',
      'navSearch.selectedHost': 'selected host',
      'navSearch.defaultCollection': 'Default',
      'navSearch.trashCollection': 'Trash',
      'navSearch.collection': 'Collection',
      'navSearch.scopeDefault': 'Default on {host}',
      'navSearch.summary': '{visible} of {total} in {scope} match "{query}"',
      'navSearch.count': '{total} conversations in {scope}',
      'navSearch.waiting': 'Preparing search...',
      'navSearch.loading': 'Searching full history...',
      'navSearch.slow': 'Still searching; large remote histories may take longer...',
      'navSearch.error': 'Search failed: {error}',
      'navSearch.localOnly': 'Enter at least 2 characters to search full history',
      'navSearch.partial': 'Remote search is incomplete; showing cached results only',
      'navSearch.fullHits': '{count} full-history hits',
      'navSearch.noMatches': 'No conversations match this search.',
      'navSearch.noSessions': 'Import a host or start a managed session to see conversations here.',
      'navSearch.emptyTrash': 'Trash is empty.',
      'navSearch.emptyCollection': 'This collection is empty. Save a conversation into it from Default.',
    },
    'zh-CN': {
      'navSearch.keyword': '关键词',
      'navSearch.path': '路径',
      'navSearch.title': '标题',
      'navSearch.updatedAt': '最近更新',
      'navSearch.createdAt': '创建时间',
      'navSearch.messageCount': '消息数量',
      'navSearch.asc': '升序',
      'navSearch.desc': '降序',
      'navSearch.ascHint': '时间较早或数量较少的优先',
      'navSearch.descHint': '时间较近或数量较多的优先',
      'navSearch.clear': '清除搜索',
      'navSearch.placeholder': '搜索对话…',
      'navSearch.previous': '上一个匹配',
      'navSearch.next': '下一个匹配',
      'navSearch.searchMode': '搜索模式',
      'navSearch.sortMode': '对话排序',
      'navSearch.toggleDirection': '切换排序方向',
      'navSearch.online': '在线',
      'navSearch.offline': '离线',
      'navSearch.noHosts': '暂无可用主机',
      'navSearch.selectHost': '选择主机',
      'navSearch.checkingHost': '正在检查主机…',
      'navSearch.selectedHost': '所选主机',
      'navSearch.defaultCollection': '默认收藏夹',
      'navSearch.trashCollection': '回收站',
      'navSearch.collection': '收藏夹',
      'navSearch.scopeDefault': '{host} 的默认收藏夹',
      'navSearch.summary': '{scope} 中有 {visible} / {total} 个对话匹配“{query}”',
      'navSearch.count': '{scope} 中有 {total} 个对话',
      'navSearch.waiting': '正在准备搜索…',
      'navSearch.loading': '正在搜索完整历史…',
      'navSearch.slow': '仍在搜索，远端历史较多时可能需要更久…',
      'navSearch.error': '搜索失败：{error}',
      'navSearch.localOnly': '至少输入 2 个字符搜索完整历史',
      'navSearch.partial': '远端搜索未完成，当前仅显示缓存结果',
      'navSearch.fullHits': '{count} 个完整历史匹配',
      'navSearch.noMatches': '没有匹配的对话。',
      'navSearch.noSessions': '导入主机或新建托管会话后，对话会显示在这里。',
      'navSearch.emptyTrash': '回收站为空。',
      'navSearch.emptyCollection': '此收藏夹为空。可以从默认收藏夹中添加对话。',
    },
  };

  const SEARCH_MODES = Object.freeze(['keyword', 'path', 'title']);
  const SORT_MODES = Object.freeze(['updatedAt', 'createdAt', 'messageCount']);
  const SPEAKERS = {
    en: { user: 'You', assistant: 'Codex', codex: 'Codex', system: 'System', developer: 'Developer', tool: 'Tool', function: 'Tool', match: 'Match' },
    'zh-CN': { user: '你', assistant: 'Codex', codex: 'Codex', system: '系统', developer: '开发者', tool: '工具', function: '工具', match: '匹配' },
  };

  function localeId(locale) { return locale === 'en' ? 'en' : 'zh-CN'; }
  function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

  // Values are plain text, not HTML. Renderers must use textContent or escapeHtml.
  // Missing parameters stay visible to expose incomplete renderer wiring.
  function translate(locale, key, values = {}) {
    const dictionary = TEXT[localeId(locale)];
    if (!hasOwn(dictionary, key)) return undefined;
    return dictionary[key].replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
      values && hasOwn(values, name) ? String(values[name]) : match
    ));
  }

  function searchModeLabel(locale, mode) {
    return translate(locale, `navSearch.${SEARCH_MODES.includes(mode) ? mode : 'keyword'}`);
  }

  function sortLabel(locale, mode) {
    return translate(locale, `navSearch.${SORT_MODES.includes(mode) ? mode : 'updatedAt'}`);
  }

  function collectionDisplayName(locale, collection) {
    if (collection?.collectionId === 'default') return translate(locale, 'navSearch.defaultCollection');
    if (collection?.collectionId === 'trash') return translate(locale, 'navSearch.trashCollection');
    return typeof collection?.name === 'string' && collection.name
      ? collection.name
      : translate(locale, 'navSearch.collection');
  }

  function hostStatusLabel(locale, online) {
    return translate(locale, online ? 'navSearch.online' : 'navSearch.offline');
  }

  function speakerLabel(locale, speaker) {
    const raw = speaker == null ? '' : String(speaker);
    const key = raw.trim().toLowerCase();
    const dictionary = SPEAKERS[localeId(locale)];
    if (!key) return dictionary.match;
    return hasOwn(dictionary, key) ? dictionary[key] : raw;
  }

  return Object.freeze({ translate, searchModeLabel, sortLabel, collectionDisplayName, hostStatusLabel, speakerLabel });
}));
